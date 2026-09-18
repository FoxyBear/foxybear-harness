# SDD-02: Council Fault Tolerance

**Date:** 2026-08-12
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (for TDD: tests first, then code)
**Supersedes:** T-2 partial (AbortError retry behavior) in `260722_council_sdd-01-deliberation.md`
**Depends on:** `260722_council_sdd-01-deliberation.md` (architecture), `260805_council_sdd-00-fix-provider-resolution.md` (config)

## Problem

The council dies on any single model failure. Reproduced live on 2026-08-12: a 1-round council with 4 models (GPT-5.4, Claude Opus 4.8, GLM-5.2, DeepSeek V4 Pro) hung indefinitely. Root cause: 11 of 12 critique-phase API calls completed, but one DeepInfra connection aborted (`AbortError: The operation was aborted`, DOM code 20). The entire council rejected because all phases use `Promise.all`.

Two blocking defects:

### Defect 1: `Promise.all` rejects the whole council on any model failure

**Files:** `deliberation.ts:106` (proposals), `:122` (critiques), `:191` (revisions)

Every phase uses `Promise.all()`. One failed HTTP call — transient network blip, single-model 500, intermittent DeepInfra abort — kills the entire deliberation. There is no survivor logic. A 4-model council where 3 models produce excellent proposals and 1 fails never reaches arbitration.

DeepInfra is the worst offender: GLM-5.2 takes 16–51s per call, DeepSeek V4 Pro takes 42–74s. Long-lived connections are fragile. Intermittent aborts are observed in production.

### Defect 2: 180s timeout produces unretryable `AbortError`

**Files:** `transport.ts:93,135` (timeout calls `controller.abort()`), `:54` (AbortError not retried)

The per-request 180s timeout fires `controller.abort()`, which produces an `AbortError` indistinguishable from a session-cancel abort. `retryFetch` skips retry on `AbortError` (per spec T-2: "WHEN an `AbortError` occurs, the system SHALL NOT retry and SHALL throw immediately" — the intent was session-cancel, not timeout). A timeout kills the model call permanently instead of retrying.

The two abort sources must be distinguishable:
- **Session cancel** (the harness scope closed): do NOT retry — the caller is gone.
- **Request timeout** (180s elapsed): retry up to 3 times — the model may just be slow.

## WHAT

### Fault Tolerance (F)

F-1. WHEN any model call in a phase (proposals, critiques, revisions, arbitration, synthesis) fails, the phase SHALL continue with the surviving results; the council SHALL NOT reject solely because one or more models failed.

F-2. WHEN a phase produces fewer than 2 successful results, the council SHALL fail with a clear error naming the phase and the models that failed. A council needs at least 2 proposals to arbitrate meaningfully.

F-3. WHEN a critique call fails, the surviving critiques SHALL be used; the failed critique SHALL be omitted from the arbitration prompt. The arbitrator works with whatever critiques succeeded.

F-4. WHEN a proposal call fails, the model SHALL be excluded from the rest of the council (no critiques of its missing proposal, no revision directive for it). The council continues with the surviving models.

F-5. WHEN the arbitrator call fails, the council SHALL fail with a clear error. The arbitrator is single-point — there is no fallback arbitrator in this spec.

F-6. WHEN the synthesis call fails, the council SHALL fail with a clear error. Synthesis is single-point.

F-7. WHEN a research call fails (Phase 0), the model SHALL proceed without a research brief. Research is optional enrichment; a failure there SHALL NOT block the council.

### Timeout vs Cancel (T)

T-1. WHEN the 180s per-request timeout fires, the system SHALL throw a `CouncilTimeoutError` (a typed error, NOT a bare `AbortError`) so the retry loop can distinguish it from a session cancel.

T-2. WHEN `retryFetch` catches a `CouncilTimeoutError`, it SHALL retry (up to `MAX_RETRIES` = 3, exponential backoff 1s/2s/4s) — the same as a 429/500/503. A slow model response is retryable.

T-3. WHEN `retryFetch` catches a bare `AbortError` (from the session abort signal, not the timeout), it SHALL NOT retry and SHALL throw immediately — unchanged from current behavior.

T-4. WHEN `callModel` is called with an external `signal` that fires (session cancel), the abort SHALL propagate as an `AbortError` (not `CouncilTimeoutError`) so `retryFetch` skips retry. This preserves T-2 of SDD-01.

T-5. `CouncilTimeoutError` SHALL carry the model name and the elapsed time for diagnostics.

### Error Surface (E)

E-1. WHEN the council fails (per F-2, F-5, F-6), the error message SHALL include: the phase that failed, the models that failed, and the underlying error messages (truncated to 200 chars each).

E-2. WHEN a phase completes with partial failures, the `DeliberationResult` SHALL include a `failures` array: `[{ phase, model, error }]` for each failed call. This is for diagnostics; the council still returns a successful result if ≥2 models survived.

## HOW

### 1. `CouncilTimeoutError` typed error (`transport.ts`)

```typescript
export class CouncilTimeoutError extends Error {
  constructor(public model: string, public elapsedMs: number) {
    super(`Council timeout: ${model} exceeded 180000ms (${elapsedMs}ms elapsed)`)
    this.name = "CouncilTimeoutError"
  }
}
```

### 2. Distinguish timeout from cancel in `callOpenAICompatible` and `callAnthropic`

Replace the timeout `controller.abort()` pattern with a custom abort that throws `CouncilTimeoutError`:

```typescript
async function callOpenAICompatible(model, apiKey, systemPrompt, userPrompt, signal?) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT_MS)
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true })

  const start = Date.now()
  try {
    const response = await fetch(baseUrl, { method: "POST", signal: controller.signal, headers: {...}, body: ... })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`${model.name} HTTP ${response.status}: ${body.slice(0, 300)}`)
    }
    const data = await response.json() as any
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error(`No content in response from ${model.name}`)
    return content
  } catch (error) {
    if (timedOut) throw new CouncilTimeoutError(model.name, Date.now() - start)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
```

The `timedOut` flag is the discriminator. A session-cancel abort (external `signal` fires) leaves `timedOut === false`, so the catch rethrows the bare `AbortError` — which `retryFetch` skips. A timeout abort sets `timedOut = true`, so the catch throws `CouncilTimeoutError` — which `retryFetch` retries.

### 3. `retryFetch` retries `CouncilTimeoutError`

```typescript
async function retryFetch<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt - 1)))
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (lastError.name === "AbortError" && !(lastError instanceof CouncilTimeoutError)) throw lastError
      const statusMatch = lastError.message.match(/HTTP\s+(\d+)/)
      const isRetryable =
        lastError instanceof CouncilTimeoutError ||
        lastError.message.includes("Network error") ||
        lastError.message.includes("timeout") ||
        (statusMatch && RETRYABLE_STATUSES.has(parseInt(statusMatch[1])))
      if (!isRetryable) throw lastError
    }
  }
  throw lastError!
}
```

Note: `CouncilTimeoutError.name` is `"CouncilTimeoutError"`, not `"AbortError"`, so the `name === "AbortError"` check is unchanged for session-cancel aborts. The `instanceof CouncilTimeoutError` check catches timeouts before the non-retryable AbortError check.

### 4. Phase fault tolerance in `deliberation.ts`

Replace `Promise.all` with `Promise.allSettled` + a `survive` helper:

```typescript
function survive<T extends { modelName?: string }>(
  settled: PromiseSettledResult<T>[],
  phase: string,
): T[] {
  const ok: T[] = []
  const fails: { phase: string; model: string; error: string }[] = []
  for (const r of settled) {
    if (r.status === "fulfilled") ok.push(r.value)
    else fails.push({ phase, model: "?", error: r.reason?.message?.slice(0, 200) ?? String(r.reason) })
  }
  if (ok.length < 2 && phase !== "research" && phase !== "arbitration" && phase !== "synthesis") {
    throw new Error(`Council phase "${phase}" failed: only ${ok.length} models succeeded. Failures: ${JSON.stringify(fails)}`)
  }
  return ok
}
```

For each phase, filter failures and continue with survivors. Track failures in a `failures` array on `DeliberationResult`.

### 5. `DeliberationResult.failures` field

```typescript
export interface DeliberationResult {
  prompt: string
  researchBriefs: Record<string, string>
  rounds: RoundResult[]
  finalSynthesis: string
  consensusReached: boolean
  totalRounds: number
  failures: { phase: string; model: string; error: string }[]
}
```

### 6. Phase-by-phase application

- **Phase 0 (Research):** `Promise.allSettled` per model. Failed research → no brief for that model. Continue.
- **Phase 1 (Proposals):** `Promise.allSettled`. Survive with ≥2 proposals. Failed models excluded from critiques and revisions.
- **Phase 2 (Critiques):** `Promise.allSettled`. Survive with whatever critiques succeeded (no minimum — even 0 critiques can be arbitrated).
- **Phase 3 (Arbitration):** Single call. Failure → council fails (F-5).
- **Phase 4 (Revisions):** Same as Phase 1/2 — `Promise.allSettled`, survive with ≥2.
- **Phase 5 (Synthesis):** Single call. Failure → council fails (F-6).

## VERIFY

### Unit Tests (`test/harness/council/transport.test.ts`)

1. **`CouncilTimeoutError` is a typed Error** — `instanceof Error` is true, `instanceof CouncilTimeoutError` is true, `name === "CouncilTimeoutError"`.
2. **`CouncilTimeoutError` carries model and elapsed** — `new CouncilTimeoutError("GPT-5.4", 180001).model === "GPT-5.4"`, `.elapsedMs === 180001`.
3. **`retryFetch` retries `CouncilTimeoutError`** — a function that throws `CouncilTimeoutError` twice then succeeds → called 3 times, returns success.
4. **`retryFetch` does NOT retry bare `AbortError`** — a function that throws `{ name: "AbortError" }` → called once, throws immediately.
5. **`retryFetch` retries HTTP 429** — function throws `Error("HTTP 429: ...")` twice then succeeds → 3 calls.
6. **`retryFetch` retries HTTP 503** — same pattern with 503.
7. **`retryFetch` does NOT retry HTTP 400** — function throws `Error("HTTP 400: ...")` → 1 call, throws.
8. **`retryFetch` exhausts retries and throws last error** — function always throws `CouncilTimeoutError` → 3 calls, throws `CouncilTimeoutError`.
9. **`callModel` throws `CouncilTimeoutError` on 180s timeout** — mock `fetch` to never resolve, advance fake timers past 180s → throws `CouncilTimeoutError`. (Use a short timeout in test config to avoid real waiting, or mock `setTimeout`.)
10. **`callModel` propagates bare `AbortError` on external signal** — pass an `AbortSignal`, abort it immediately → throws `AbortError` (not `CouncilTimeoutError`).
11. **`callModel` retries on timeout then succeeds** — mock `fetch` to hang on first call (timeout), succeed on second → returns content, 2 calls.

### Unit Tests (`test/harness/council/deliberation.test.ts`)

12. **`runCouncil` survives 1 of 4 proposal failures** — mock runner: model A throws, models B/C/D succeed → council completes, `result.rounds[0].proposals` has 3 proposals, `result.failures` includes model A.
13. **`runCouncil` fails when <2 proposals succeed** — mock runner: 3 of 4 proposals throw → throws error matching `/phase "proposals" failed/`.
14. **`runCouncil` survives critique failures** — mock runner: 2 of 12 critiques throw → council completes, `result.rounds[0].critiques` has 10 entries, `result.failures` has 2.
15. **`runCouncil` excludes failed proposal model from critiques** — model A's proposal fails → no critique targets model A, no critique from model A.
16. **`runCouncil` fails when arbitrator fails** — mock runner: arbitrator throws on arbitration call → throws error matching `/arbitrator/` or `/arbitration/`.
17. **`runCouncil` fails when synthesis fails** — mock runner: arbitrator throws on synthesis call → throws error matching `/synthesis/`.
18. **`runCouncil` survives research failures** — `enableResearch: true`, 1 of 4 research calls throws → council completes, `result.researchBriefs` has 3 entries, failed model has no brief.
19. **`runCouncil` survives revision failures** — maxRounds=2, 1 of 4 revision calls throws in round 2 → council completes with 3 revised proposals.
20. **`runCouncil` includes `failures` array in result** — any failure scenario → `result.failures` is an array of `{ phase, model, error }`.
21. **`runCouncil` completes with all models succeeding** — happy path: 4 models, 12 critiques, 1 round → completes, `result.failures` is empty.
22. **`runCouncil` completes with consensus in round 1** — mock arbitrator returns `convergenceScore: 5` → `result.totalRounds === 1`, `result.consensusReached === true`.

### Integration Tests (`test/harness/council/integration.test.ts`)

23. **Live council with 2 models completes** — call `runCouncil` with 2 real models (GPT-5.4, Claude Opus 4.8), `maxRounds: 1`, `enableResearch: false`, simple prompt "What is 2+2?" → completes in <120s, `result.finalSynthesis` is non-empty. (Marked `.slow()` or skipped in CI; runs locally.)
24. **Live council survives a bad model** — call `runCouncil` with 3 models where one is a bogus ID (e.g., `"openai/nonexistent-model"`) → council completes with 2 surviving models, `result.failures` includes the bogus model.

## Files Touched

| File | Change |
|------|--------|
| `harness/council/transport.ts` | Add `CouncilTimeoutError`. Distinguish timeout from cancel in both `call*` functions. Update `retryFetch` to retry `CouncilTimeoutError`. |
| `harness/council/deliberation.ts` | Replace `Promise.all` with `Promise.allSettled` + `survive()` helper in all phases. Add `failures` to `DeliberationResult`. Exclude failed proposal models from critiques. |
| `harness/council/tool.ts` | Pass `result.failures` through to output (include in verbose output). |

## Non-Goals

- No overall council timeout (Bug 6 from debug report) — separate spec if needed. Per-request timeout + retry is sufficient for now.
- No SDD-00 cleanup (Bug 4) — config.ts still has `ALL_MODELS`. Works because `council.json` overrides. Separate spec.
- No research phase tool support (Bug 3) — `enableResearch` is config-gated; current `council.json` has it `true` but tools are ignored. Recommended: set `enableResearch: false` in `council.json` until tool support is added. Separate spec.
- No fallback arbitrator (F-5 keeps single-point arbitrator).
- No circuit breaker per model (a model that fails 3 times in a row is not excluded from future councils). Separate spec if observed in production.

## Debug Evidence (2026-08-12)

Reproduced live: 4-model council (GPT-5.4, Claude Opus 4.8, GLM-5.2, DeepSeek V4 Pro), `maxRounds: 1`, `enableResearch: false`, prompt "What is 2+2?".

- Phase 1 (proposals): all 4 succeeded (5s, 12s, 16s, 42s).
- Phase 2 (critiques): 12 parallel calls. 11 succeeded. 1 (`zai-org/GLM-5.2 → DeepSeek V4 Pro`) hung past 150s, then aborted with `AbortError: The operation was aborted` (DOM code 20).
- `Promise.all` rejected on the 1 failure. Council died. No arbitration, no synthesis.
- Individual model calls succeed (GPT-5.4 0.8s, Claude 1.2s, GLM 5.1s, DeepSeek 3.2s for simple prompts).
- 6 parallel DeepInfra calls with long prompts succeed (32s total).
- The abort is intermittent — DeepInfra connection fragility under parallel load + long latency.

## Test Conventions

- Test runner: `bun test` (Bun's built-in).
- Run from `packages/opencode` directory (NOT repo root — `do-not-run-tests-from-root` guard).
- Command: `bun test test/harness/council/ --timeout 30000` (unit), `bun test test/harness/council/integration.test.ts --timeout 120000` (integration).
- Avoid mocks where possible. For `retryFetch` and `callModel` unit tests, mocking `fetch` is necessary (network is non-deterministic). For `runCouncil` unit tests, mock the `SubAgentRunner` (it's an interface — inject a fake).
- For integration tests (23, 24), use real API calls. Mark `.slow()` so they can be filtered. Read API keys from environment / key files via the existing `getApiKey()`.
- Style: follow `AGENTS.md` naming (single-word vars), no `try`/`catch` where possible, functional array methods, `const` over `let`.
