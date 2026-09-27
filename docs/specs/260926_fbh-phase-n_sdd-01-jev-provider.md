# SDD-01: Phase N — Jev Provider Adapter

**Date:** 2026-09-26
**Project:** FoxyBear Harness Phase N (`development/foxybear`)
**Status:** Draft (pending independent audit + human gate)
**Master:** `260926_fbh-phase-n_sdd-00-master.md` (authoritative; where this spec conflicts, the master wins)
**Source research:** `docs/research/260926_fbh-phase-n_salience-classification-spike.md` (§"Stage 1: GATE — Jev", §"Architecture: circular buffer + Jev per user turn")
**Workstream:** `fbh-phase-n` (`tools/sdd/workstreams/fbh-phase-n.json`)
**Depends on:** none (sdd-01 is a leaf — parallel with sdd-02, sdd-03)
**Depended on by:** `sdd-04` (gate-extract-classify pipeline — needs `Jev.noul` for the gate and `Jev.choice` for the classifier)

Implements the Jev leg of Phase N: wires OpenRouter's `alpha/decisions` API (model `typesafe/jev-1.13`) into the fbh provider abstraction as a typed-decision adapter exposing `noul`, `choice`, and `score`. This spec owns the wire, the config plumbing, the rate limit, the circuit breaker, and the cost log. It does NOT own the gate logic, the classify logic, or the pipeline composition — those are sdd-04.

## Background

The spike (§"Stage 2: Extraction — Jev can't extract, chat LLMs can") established that Jev is a typed-decision model — it cannot generate text, but it returns calibrated probabilities over Noul (binary), Choice (multi-class), and Score (ordinal) questions. The spike's three-mode comparison (150 turns) proved Jev-only at ~$0.00008/turn catches 100% of real memories with 0 false positives. Phase N's gate (Stage 1) and classifier (Stage 3) both call Jev.

The fbh provider abstraction (`packages/fbh/src/provider/provider.ts:62`) is built around the AI SDK's `LanguageModelV3` interface — chat/completion models. Jev is not a chat model. It has its own endpoint (`POST https://openrouter.ai/api/alpha/decisions`), its own request shape (`state` + `questions`), and its own response shape (typed probabilities). It does not fit `Provider.getLanguage` (provider.ts:975). It needs a sibling adapter, not a slot in the existing registry.

Three seams against the existing code:

1. **Config shape (CC-4).** The master's SC-2 introduces `memory.extraction.layer1` (`{provider, model, api_key}`) and `memory.extraction.circuit_breaker` (`{max_latency_ms, max_consecutive_failures, max_error_rate_pct, fallback}`). The existing `memory.extraction` zod schema (foxybear.ts:41-93) has `model`/`fallback_model`/`external_opt_in` but no `layer1`/`layer2`/`circuit_breaker`. This spec adds them additively — existing keys stay valid (the Phase M regex/llm/hybrid mode keeps working until sdd-05 rewires the call sites).
2. **API key resolution.** `memory.extraction.layer1.api_key` uses the `{file:~/Development/.openrouter.key}` form. The existing `{file:...}` substitution lives in `config/paths.ts:78` and runs at config parse time — by the time `getConfig()` returns, the value is the file's contents (trimmed). The Jev adapter reads it as a plain string. No new substitution code.
3. **Rate limit + circuit breaker.** The existing provider stack has retry logic (`session/retry.ts:64`) for HTTP 429s but no client-side rate limiter and no circuit breaker. Jev's CC-5 limit (10 req/sec) and CC-9 breaker (5 consecutive > 3s OR > 5% error rate → regex fallback) are new infrastructure. This spec owns them.

---

## WHAT

### Provider interface (SC-1, CC-10)

1. **WHEN** SDD-01 implementation begins, the system **SHALL** create `packages/fbh/src/provider/jev.ts` exporting a `Jev` namespace with three async functions: `noul`, `choice`, `score` — matching the master's SC-1 `JevProvider` interface (master spec lines 110-114). The namespace **SHALL NOT** extend or implement `LanguageModelV3`; Jev is not a chat model and does not fit `Provider.getLanguage` (provider.ts:975).

2. **WHEN** `Jev.noul(state, instructions, criteria)` is called with `state: string`, `instructions: string`, `criteria: { true: string; false: string }`, it **SHALL** POST to `https://openrouter.ai/api/alpha/decisions` (master SC-5) with a body containing `model: "typesafe/jev-1.13"` (or the configured model), `state`, and `questions: { q: { type: "noul", instructions, criteria } }` where `q` is a generated question key. It **SHALL** return `Promise<number>` in `[0, 1]` — the calibrated probability that the noul resolves `true`.

3. **WHEN** `Jev.choice(state, instructions, criteria)` is called with `state: string`, `instructions: string`, `criteria: Record<string, string>` (one entry per class), it **SHALL** POST to the decisions endpoint with `questions: { q: { type: "choice", instructions, criteria } }`. It **SHALL** return `Promise<{ choice: string; probabilities: Record<string, number> }>` where `choice` is the highest-probability class and `probabilities` maps each criterion key to its calibrated probability. The sum of `probabilities` values **SHALL** be `1.0 ± 0.001` (Jev's calibration guarantee); the adapter **SHALL NOT** normalize — if the sum drifts, the adapter **SHALL** log a `jev.calibration_drift` warning with the raw sum and return the values unchanged.

4. **WHEN** `Jev.score(state, instructions, criteria)` is called with `state: string`, `instructions: string`, `criteria: string[]` (ordinal anchors), it **SHALL** POST to the decisions endpoint with `questions: { q: { type: "score", instructions, criteria } }`. It **SHALL** return `Promise<number>` — the calibrated score on the ordinal scale defined by `criteria`.

5. **WHEN** any Jev method is called and the OpenRouter response status is `>= 400`, the adapter **SHALL** throw a `JevHttpError` carrying `{ status, body, question }` (per the `NamedError.create` pattern at provider.ts:1779). The error message **SHALL NOT** include `state` content (CC-6 / security: no session content at info level — master Security section). The error **SHALL** be caught by the circuit breaker (reqs 14-16) and the cost logger (req 13) before propagating.

6. **WHEN** any Jev method is called and the OpenRouter response body fails to parse as the expected decision shape, the adapter **SHALL** throw a `JevSchemaError` carrying `{ question, body }` (no `state`). The adapter **SHALL NOT** return a default value (no silent 0.0, no silent `choice: ""`) — a schema failure is a real failure for circuit-breaker accounting.

### Config (CC-4)

7. **WHEN** SDD-01 implementation begins, the system **SHALL** extend the `memory.extraction` zod object in `packages/fbh/src/config/foxybear.ts` (lines 41-93) with three additive keys: `layer1` (object: `provider: z.string().default("openrouter")`, `model: z.string().default("typesafe/jev-1.13")`, `api_key: z.string().default("{file:~/Development/.openrouter.key}")`), `layer2` (object: `provider: z.string().default("openrouter")`, `model: z.string().default("google/gemini-2.5-flash")`, `api_key: z.string().default("{file:~/Development/.openrouter.key}")` — present for sdd-02 to consume, this spec only reads `layer1`), and `circuit_breaker` (object: `max_latency_ms: z.number().int().default(3000)`, `max_consecutive_failures: z.number().int().default(5)`, `max_error_rate_pct: z.number().min(0).max(100).default(5)`, `fallback: z.enum(["regex", "none"]).default("regex")`). The existing `model`/`fallback_model`/`self_hosted_fallback_model`/`self_hosted`/`threshold`/`batch_size`/`async`/`mode` keys **SHALL** remain unchanged. The `external_opt_in` key **SHALL** have its default changed from `false` to `true` per master SC-2 (Phase N supersedes the Phase M default — external extraction is enabled when `memory.enabled: true`).

8. **WHEN** the Jev adapter needs the layer1 config, it **SHALL** call `getConfig()` (the existing bridge at `config/bridge.ts`, used by `memory/extraction/mode.ts:46`) and read `cfg.memory.extraction.layer1`. The `{file:...}` substitution has already run by the time `getConfig()` returns (paths.ts:78) — the adapter reads `api_key` as the file's contents, not the `{file:...}` token. The adapter **SHALL NOT** re-implement file substitution.

9. **WHEN** `memory.extraction.layer1.api_key` is missing or empty after substitution, the adapter **SHALL** throw a `JevConfigError` carrying `{ field: "memory.extraction.layer1.api_key" }` on the first call. It **SHALL NOT** cache the failure — a subsequent call after the user adds the key file **SHALL** succeed (re-read config each call OR cache with a TTL short enough to pick up new config; this spec permits either, sdd-04 picks one).

10. **WHEN** `memory.extraction.external_opt_in` is `false`, the Jev adapter **SHALL** still expose `noul`/`choice`/`score` (the adapter does not gate on opt-in — that is the pipeline's job in sdd-04). The adapter **SHALL** log a `jev.external_opt_in_false` debug message on each call when opt-in is false, so a misconfigured pipeline that calls Jev with opt-in off shows up in the log.

### OpenRouter only (CC-10)

11. **WHEN** `memory.extraction.layer1.provider` is anything other than `"openrouter"` (case-sensitive), the adapter **SHALL** throw a `JevConfigError` carrying `{ field: "memory.extraction.layer1.provider", value }`. CC-10 is non-negotiable — no direct Jev API, no proxy, no alternate routing. The `provider` field exists in the schema for forward compatibility (a future `layer1.provider: "self_hosted"` would route to a local Jev), but this spec only implements the `"openrouter"` value; any other value is a config error.

### Cost logging (CC-8)

12. **WHEN** any Jev method completes successfully, the adapter **SHALL** log a `jev.call` info event with fields `{ model, question, latency_ms, tokens_in, tokens_out, cost_usd }`. `tokens_in` and `tokens_out` come from the OpenRouter response's usage metadata (the decisions API returns `usage: { prompt_tokens, completion_tokens }` — the adapter reads both). `cost_usd` **SHALL** be computed as `(tokens_in / 1_000_000) * 0.042 + (tokens_out / 1_000_000) * 0.042` (the spike's validated Jev pricing, $0.042/M for both directions). The adapter **SHALL NOT** log `state`, `instructions`, `criteria`, or `choice` content (CC-6 / security: no session content at info level).

13. **WHEN** a Jev call fails (HTTP error, schema error, or network error), the adapter **SHALL** log a `jev.call_failed` warn event with fields `{ model, question, latency_ms, error_kind, error_status }` where `error_kind` is one of `"http" | "schema" | "network" | "config"`. It **SHALL NOT** log the error body if the body could contain echoed `state` content — only `error_status` (the HTTP code) and `error_kind`. The cost for a failed call **SHALL** be logged as `cost_usd: 0` (no successful completion, no charge — OpenRouter does not bill failed calls).

14. **WHEN** the daemon is running, the adapter **SHALL** expose a `Jev.metrics()` function returning `{ calls_24h, tokens_in_24h, tokens_out_24h, cost_usd_24h, error_rate_pct, circuit_state }` computed from the in-memory call log (a ring buffer of the last 10,000 calls — sufficient for 24h at 50 turns/day × ~3 Jev calls/turn). The `/memory/metrics` endpoint (owned by sdd-05 — this spec only provides the data) **SHALL** read `Jev.metrics()` and include it under `memory.metrics.jev`. The adapter **SHALL NOT** persist the call log to disk — a daemon restart resets the 24h counters (acceptable per spike — cost is negligible, daily aggregate is for observation not billing).

### Circuit breaker (CC-9)

15. **WHEN** a Jev call is made, the adapter **SHALL** measure `latency_ms` from request start to response end (including the rate-limiter wait — req 18 — so the breaker sees the real user-visible latency). It **SHALL** record the call into a sliding window of the last 100 calls with `{ latency_ms, success: boolean, error_kind }`.

16. **WHEN** the last `N` consecutive calls (where `N` = `memory.extraction.circuit_breaker.max_consecutive_failures`, default 5) all have `latency_ms > max_latency_ms` (default 3000), the adapter **SHALL** transition the circuit to `OPEN`. The trigger is consecutive — a single fast call between slow calls resets the consecutive-slow counter. The adapter **SHALL** log a `jev.circuit_open` warn event with `{ reason: "latency", consecutive_slow, max_latency_ms }` when the transition fires.

17. **WHEN** the sliding window's error rate (failed calls / total calls) exceeds `max_error_rate_pct` (default 5) AND the window has at least 20 calls (avoid firing on a cold-start 1/1 failure), the adapter **SHALL** transition the circuit to `OPEN`. The adapter **SHALL** log a `jev.circuit_open` warn event with `{ reason: "error_rate", error_rate_pct, window_size }` when the transition fires.

18. **WHEN** the circuit is `OPEN`, the adapter **SHALL** reject all subsequent Jev calls by throwing `JevCircuitOpenError` carrying `{ state: "open", reason }` — it **SHALL NOT** send the request to OpenRouter. The pipeline (sdd-04) catches `JevCircuitOpenError` and falls back per `memory.extraction.circuit_breaker.fallback` (default `"regex"`). The adapter **SHALL** start a cooldown timer of 60 seconds; after the cooldown, the circuit transitions to `HALF_OPEN` and the next call is permitted (a "probe" call). If the probe succeeds (HTTP 2xx, schema valid, latency ≤ `max_latency_ms`), the circuit transitions to `CLOSED` and the consecutive/error counters reset. If the probe fails, the circuit transitions back to `OPEN` and the 60s cooldown restarts.

19. **WHEN** the circuit transitions (CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→CLOSED, HALF_OPEN→OPEN), the adapter **SHALL** log a `jev.circuit_transition` info event with `{ from, to, reason }`. The current circuit state **SHALL** be readable via `Jev.metrics().circuit_state` (req 14) so the user can see it in `/memory/metrics`.

### Rate limit (CC-5)

20. **WHEN** a Jev call is made, the adapter **SHALL** acquire a token from a client-side rate limiter capped at 10 tokens per second (CC-5). The limiter **SHALL** be a token bucket: capacity 10, refill rate 10/sec, initialized full. The adapter **SHALL** await the token before sending the request — the wait time counts toward the latency measured by the circuit breaker (req 15) so a rate-limited backlog shows up as latency, not as a silent queue.

21. **WHEN** the rate limiter is exhausted and the next call would wait more than 5 seconds for a token, the adapter **SHALL** throw `JevRateLimitedError` carrying `{ wait_ms }` rather than blocking indefinitely. 5 seconds is the saturation threshold — beyond it, the pipeline (sdd-04) should shed load (skip classification for this turn) rather than queue. The adapter **SHALL** log a `jev.rate_limited` warn event with `{ wait_ms }` when this fires.

22. **WHEN** the OpenRouter response is HTTP 429 (server-side rate limit, distinct from the client-side limiter), the adapter **SHALL** treat it as a failed call for circuit-breaker accounting (req 17), log a `jev.http_429` warn event, and re-throw as `JevHttpError` (req 5). The adapter **SHALL NOT** automatically retry — retry is the pipeline's concern (sdd-04 owns the post-turn `run.fork` loop). The client-side limiter (req 20) is the primary defense; a 429 means the client limiter is misconfigured or OpenRouter is enforcing a tighter limit than advertised.

### Style & quality (CC-7, AGENTS.md style guide)

23. **WHEN** the implementation completes, the code in `packages/fbh/src/provider/jev.ts` **SHALL** follow the AGENTS.md style guide: single-word names where unambiguous (`noul`, `choice`, `score`, `call`, `limit`, `breaker`); `const` over `let`; no `any` type (use `unknown` + zod parse for the OpenRouter response); early returns over `else` blocks; functional array methods (`filter`/`map`/`reduce`) over for-loops for the sliding-window accounting. The `Bun.file()` API is not directly used by this spec (the `{file:...}` substitution runs in `config/paths.ts` before the adapter sees the value), but if the adapter ever needs to read a file it **SHALL** use `Bun.file()` not `fs`.

24. **WHEN** SDD-01 implementation completes, `bun run typecheck` and `bun test --timeout 30000` (run from `packages/fbh`, per CC-7) **SHALL** both be green. No red tests left. The adapter's new tests live at `packages/fbh/test/provider/jev.test.ts` (a new test directory — `test/provider/` — matching the `src/provider/` layout).

---

## HOW

### Step 1: Config schema extension (req 7, CC-4)

Edit `packages/fbh/src/config/foxybear.ts` lines 41-93 — the `memory.extraction` zod object. Add `layer1`, `layer2`, `circuit_breaker` as sibling keys to the existing `mode`/`model`/`fallback_model`/etc. All three are optional with defaults (so existing configs that don't set them keep working). The `api_key` default uses the `{file:...}` form — the substitution runs in `paths.ts:78` before the adapter sees the value.

```typescript
layer1: z.object({
  provider: z.string().default("openrouter"),
  model: z.string().default("typesafe/jev-1.13"),
  api_key: z.string().default("{file:~/Development/.openrouter.key}"),
}).optional(),
layer2: z.object({
  provider: z.string().default("openrouter"),
  model: z.string().default("google/gemini-2.5-flash"),
  api_key: z.string().default("{file:~/Development/.openrouter.key}"),
}).optional(),
circuit_breaker: z.object({
  max_latency_ms: z.number().int().default(3000),
  max_consecutive_failures: z.number().int().default(5),
  max_error_rate_pct: z.number().min(0).max(100).default(5),
  fallback: z.enum(["regex", "none"]).default("regex"),
}).optional(),
```

### Step 2: The Jev adapter (reqs 1-6, 8-13, CC-10)

Create `packages/fbh/src/provider/jev.ts`:

- `export namespace Jev { ... }` — matches the existing `Provider`/`MemoryExtractor` namespace pattern.
- `const log = Log.create({ service: "provider.jev" })` — matches the existing pattern (memory.ts:19, provider.ts:63).
- A private `async function call(question, kind, state, instructions, criteria)` that:
  - Reads `memory.extraction.layer1` from `getConfig()`.
  - Validates `provider === "openrouter"` (req 11), `api_key` non-empty (req 9), throws `JevConfigError` otherwise.
  - Acquires a token from the rate limiter (req 20).
  - Measures `latency_ms` (start = `performance.now()` before the token acquire, end = after response parse — the token wait counts).
  - POSTs to `https://openrouter.ai/api/alpha/decisions` with `Authorization: Bearer ${api_key}`, body `{ model, state, questions: { q: { type: kind, instructions, criteria } } }`, `Content-Type: application/json`.
  - On HTTP >= 400: throws `JevHttpError` (req 5). On 429: logs `jev.http_429` first, then throws `JevHttpError` (req 22).
  - On parse failure: throws `JevSchemaError` (req 6).
  - On success: logs `jev.call` (req 12), records the call into the sliding window (req 15), updates the circuit breaker (reqs 16-19), returns the typed value.
- `export async function noul(state, instructions, criteria) { return (await call("q", "noul", state, instructions, criteria)).probability }` — thin wrapper.
- `export async function choice(state, instructions, criteria) { return (await call("q", "choice", state, instructions, criteria)).decision }` — returns `{ choice, probabilities }`.
- `export async function score(state, instructions, criteria) { return (await call("q", "score", state, instructions, criteria)).score }`.
- `export function metrics() { ... }` — returns the 24h aggregate + circuit state (req 14).
- Errors: `JevHttpError`, `JevSchemaError`, `JevConfigError`, `JevCircuitOpenError`, `JevRateLimitedError` — all via `NamedError.create` (the existing pattern at provider.ts:1779, auth.ts:70).

### Step 3: Rate limiter (reqs 20-22, CC-5)

Token bucket, in-memory, module-level singleton inside `jev.ts`:

- `capacity: 10`, `refill_rate: 10` per second (CC-5).
- `tokens` starts at `capacity`. `last_refill` starts at `Date.now()`.
- `async function acquire(timeout_ms)`: on each call, compute elapsed since `last_refill`, add `elapsed * refill_rate / 1000` tokens (capped at `capacity`), update `last_refill`. If `tokens >= 1`, decrement and return. Otherwise compute `wait_ms = (1 - tokens) / refill_rate * 1000`, if `wait_ms > timeout_ms` (5000) throw `JevRateLimitedError`, else `await new Promise(r => setTimeout(r, wait_ms))` and retry.
- The limiter is shared across all Jev calls (gate + classify) — the spike's cost model assumed ~3 calls/turn (1 gate + ~2 classify), well under 10/sec.

### Step 4: Circuit breaker (reqs 15-19, CC-9)

Sliding window + state machine, in-memory, module-level singleton inside `jev.ts`:

- `window: Array<{ latency_ms: number; success: boolean; error_kind?: string }>` capped at 100 entries (push + shift when full).
- `state: "closed" | "open" | "half_open"`, starts `"closed"`.
- `consecutive_slow: number`, starts 0.
- `cooldown_until: number`, starts 0.
- `function record(latency_ms, success, error_kind)`:
  - Push to `window`. If `state === "half_open"`: probe result — success + latency ≤ max → `state = "closed"`, reset counters, log transition; failure → `state = "open"`, set `cooldown_until = now + 60_000`, log transition.
  - If `state === "closed"`: update `consecutive_slow` (increment if `latency_ms > max_latency_ms`, reset to 0 otherwise). If `consecutive_slow >= max_consecutive_failures` → `state = "open"`, set `cooldown_until`, log `jev.circuit_open` with `reason: "latency"`. Compute error rate from `window` (if `window.length >= 20` and failed/total > `max_error_rate_pct / 100`) → `state = "open"`, set `cooldown_until`, log `jev.circuit_open` with `reason: "error_rate"`.
- `function check()` called at the start of each `call()`:
  - If `state === "open"` and `now < cooldown_until` → throw `JevCircuitOpenError`.
  - If `state === "open"` and `now >= cooldown_until` → `state = "half_open"`, log transition, allow the call through (the probe).
  - If `state === "closed"` → allow.

### Step 5: Cost log + metrics (reqs 12-14, CC-8)

- `call_log: Array<{ ts: number; model: string; question: string; latency_ms: number; tokens_in: number; tokens_out: number; cost_usd: number; success: boolean }>` capped at 10,000 (ring buffer).
- On each successful call: push to `call_log`, log `jev.call` info event.
- On each failed call: push to `call_log` with `cost_usd: 0`, log `jev.call_failed` warn event.
- `metrics()`:
  - `calls_24h` = `call_log.filter(c => c.ts > Date.now() - 86_400_000).length`.
  - `tokens_in_24h`, `tokens_out_24h`, `cost_usd_24h` = sums over the 24h filter.
  - `error_rate_pct` = `failed_calls_24h / calls_24h * 100` (or 0 if `calls_24h === 0`).
  - `circuit_state` = current breaker state.

### Step 6: Tests (req 24, CC-7)

Create `packages/fbh/test/provider/jev.test.ts`. No mocks of `Jev` itself (CC-5 from Phase M: real implementation, not duplicated logic). Tests use a local HTTP server (the existing `test/lib/` has a `testEffect` helper — see `test/AGENTS.md`) to stub the OpenRouter endpoint, since real OpenRouter calls cost money and depend on the network. The stub server:

- Returns canned `{ decisions: { q: { probability: 0.73 } } }` for noul.
- Returns canned `{ decisions: { q: { choice: "decision", probabilities: { preference: 0.1, correction: 0.05, decision: 0.7, constraint: 0.05, pattern: 0.05, context: 0.03, none: 0.02 } } } }` for choice.
- Returns canned `{ decisions: { q: { score: 4 } } }` for score.
- Returns HTTP 429 on demand (for the rate-limit test).
- Returns HTTP 500 on demand (for the circuit-breaker test).
- Returns a malformed body on demand (for the schema-error test).
- Returns a 6-second delayed response on demand (for the latency circuit-breaker test).

The adapter's endpoint URL **SHALL** be overridable via an env var `FBH_JEV_ENDPOINT` for tests — production reads the hardcoded `https://openrouter.ai/api/alpha/decisions`, tests point at the stub. This is the only test seam the adapter exposes; it is a single `const ENDPOINT = process.env.FBH_JEV_ENDPOINT ?? "https://openrouter.ai/api/alpha/decisions"` at the top of `jev.ts`.

### Reuse map

| Existing asset | Anchor | Reuse |
|---|---|---|
| `{file:...}` substitution | `config/paths.ts:78` | Already runs at config parse. Adapter reads the substituted value. No new code. |
| `getConfig()` bridge | `config/bridge.ts`, used at `memory/extraction/mode.ts:45` | Adapter calls `getConfig()` to read `layer1`. |
| `NamedError.create` | `provider.ts:1779`, `auth.ts:70` | Template for `JevHttpError`, `JevSchemaError`, `JevConfigError`, `JevCircuitOpenError`, `JevRateLimitedError`. |
| `Log.create` | `util/log.ts`, used everywhere | `Log.create({ service: "provider.jev" })`. |
| `extraction/mode.ts` pattern | `memory/extraction/mode.ts:44` | Template for the `resolveJevConfig()` helper (same shape: read config, fall back to defaults). |
| `test/lib/effect.ts` `testEffect` | `test/lib/effect.ts` | Test harness for the adapter tests. |
| Sliding window pattern (Phase M lifecycle) | `memory/lifecycle/decay.ts` | Template for the breaker's window accounting (functional array methods, capped length). |

### What is explicitly NOT built

- No gate logic (sdd-04 owns "would this enrich a future query?" — this spec only provides `Jev.noul`).
- No classify logic (sdd-04 owns "what type is this memory?" — this spec only provides `Jev.choice`).
- No pipeline composition (sdd-04 owns the post-turn `run.fork` orchestration).
- No `external_opt_in` gating (sdd-04 owns the opt-in check before calling Jev; this spec only logs a debug if opt-in is off — req 10).
- No Gemini adapter (sdd-02 owns `layer2`).
- No circular buffer (sdd-03 owns the 5-turn context arc).
- No secrets redaction inside the adapter (sdd-05 owns the redact filter; the adapter trusts its caller to redact `state` before passing it).
- No persistence of the call log (in-memory only — req 14).
- No retry logic (sdd-04 owns retry; the adapter throws on failure — req 5).

---

## VERIFY

Tests at `packages/fbh/test/provider/jev.test.ts` (run from `packages/fbh` per CC-7). The stub OpenRouter server is started in the test's `beforeAll` and `FBH_JEV_ENDPOINT` is set to its URL. No mocks of `Jev` itself — real adapter, fake server (CC-5 from Phase M: test actual implementation).

- **V1 — config schema extension (req 7, CC-4).** Setup: write a `foxybear.json` with `memory.extraction.layer1.model: "typesafe/jev-1.13"` and `circuit_breaker.max_latency_ms: 3000`. Action: call `getConfig()`. Expected: `cfg.memory.extraction.layer1.model === "typesafe/jev-1.13"`, `cfg.memory.extraction.layer1.provider === "openrouter"` (default), `cfg.memory.extraction.circuit_breaker.max_latency_ms === 3000`, `cfg.memory.extraction.circuit_breaker.fallback === "regex"` (default). Negative: a config with no `layer1` key still parses (defaults fill in). A config with `layer1.provider: "self_hosted"` parses (the schema accepts any string; the adapter rejects at call time — V11).

- **V2 — config consumed (req 8, CC-4).** Setup: stub server returning a valid noul response. Action: `Jev.noul("state", "instructions", { true: "t", false: "f" })`. Expected: the stub server received the request with `Authorization: Bearer <contents-of-.openrouter.key>`, `model: "typesafe/jev-1.13"`, `state: "state"`, `questions.q.type: "noul"`. The adapter did not re-implement `{file:...}` substitution (assert via the substituted value in the Authorization header — the stub sees the file contents, not the token).

- **V3 — noul returns calibrated probability (req 2).** Setup: stub returns `{ decisions: { q: { probability: 0.73 } } }`. Action: `const p = await Jev.noul(...)`. Expected: `p === 0.73`, `typeof p === "number"`, `0 <= p && p <= 1`.

- **V4 — choice returns class + probabilities (req 3).** Setup: stub returns the 7-class choice fixture. Action: `const r = await Jev.choice(...)`. Expected: `r.choice === "decision"` (highest probability), `Object.keys(r.probabilities).length === 7`, `sum(r.probabilities) === 1.0 ± 0.001`. Calibration drift: stub returns probabilities summing to 1.05; expected: `Jev.choice` returns the values unchanged AND logs a `jev.calibration_drift` warning (assert via the log spy or the log file).

- **V5 — score returns ordinal (req 4).** Setup: stub returns `{ decisions: { q: { score: 4 } } }`. Action: `const s = await Jev.score(...)`. Expected: `s === 4`, `typeof s === "number"`.

- **V6 — HTTP error throws JevHttpError, no state in message (req 5, CC-6).** Setup: stub returns HTTP 500. Action: `try { await Jev.noul("secret-state", ...) } catch (e)`. Expected: `e instanceof JevHttpError`, `e.fields.status === 500`, `e.message` does not contain `"secret-state"`, `e.fields.question === "q"`. The `jev.call_failed` warn event was logged with `error_kind: "http"`, `error_status: 500`, no `state` in the log fields.

- **V7 — schema error throws JevSchemaError, no silent default (req 6).** Setup: stub returns `{ not: "a decision" }`. Action: `await Jev.noul(...)`. Expected: throws `JevSchemaError`, does NOT return `0` or `null`. The failure is recorded in the breaker window (assert via `Jev.metrics().circuit_state` after enough failures).

- **V8 — rate limit enforced (req 20, CC-5).** Setup: stub responds instantly. Action: fire 15 concurrent `Jev.noul` calls. Expected: 10 complete within the first second (bucket drains), the remaining 5 wait for tokens. The 11th-15th calls' `latency_ms` (as measured by the adapter) includes the token-wait time. Assert: `max(latency_ms) >= 100` for the last 5 (they waited ~100ms for a token).

- **V9 — rate limit saturation throws (req 21).** Setup: stub responds with a 5-second delay, draining the bucket. Action: fire 100 concurrent calls. Expected: the first 10 acquire tokens and are in flight; the next batch waits; once the projected wait exceeds 5s, `JevRateLimitedError` is thrown with `wait_ms > 5000`. `jev.rate_limited` warn logged.

- **V10 — cost logged per call (req 12, CC-8).** Setup: stub returns a response with `usage: { prompt_tokens: 1000, completion_tokens: 50 }`. Action: `await Jev.noul(...)`. Expected: `jev.call` info event logged with `tokens_in: 1000`, `tokens_out: 50`, `cost_usd: (1000 + 50) / 1_000_000 * 0.042 ≈ 0.0000441`. `Jev.metrics().cost_usd_24h` reflects the sum. No `state`/`instructions`/`criteria`/`choice` in the log fields.

- **V11 — provider guard (req 11, CC-10).** Setup: write config with `layer1.provider: "direct"`. Action: `await Jev.noul(...)`. Expected: throws `JevConfigError` with `fields.field === "memory.extraction.layer1.provider"`, `fields.value === "direct"`. No HTTP request was sent (assert via the stub server's request counter at 0).

- **V12 — circuit breaker opens on consecutive slow calls (req 16, CC-9).** Setup: stub responds with 4-second delay for the first 5 calls, then fast. Action: call `Jev.noul` 6 times. Expected: calls 1-5 succeed (slow, but succeed); after call 5, `Jev.metrics().circuit_state === "open"` (5 consecutive > 3s). Call 6 throws `JevCircuitOpenError` without sending a request (stub server request counter at 5). `jev.circuit_open` warn logged with `reason: "latency"`, `consecutive_slow: 5`, `max_latency_ms: 3000`.

- **V13 — circuit breaker opens on error rate (req 17, CC-9).** Setup: stub returns HTTP 500 for 2 of 20 calls (10% error rate, threshold 5%). Action: fire 20 calls. Expected: after the 20th call, `circuit_state === "open"`, `jev.circuit_open` logged with `reason: "error_rate"`, `error_rate_pct: 10`, `window_size: 20`. Cold-start protection: fire 1 call that fails; circuit stays closed (window size 1 < 20 minimum).

- **V14 — circuit breaker HALF_OPEN probe (req 18, CC-9).** Setup: open the circuit (V12 or V13). Manually advance the cooldown (set `cooldown_until` to `Date.now() - 1` via the test seam, OR wait 60s in a live test). Action: call `Jev.noul` — the probe. Stub returns a fast valid response. Expected: the call succeeds, `circuit_state === "closed"` after the call, `jev.circuit_transition` logged with `from: "half_open"`, `to: "closed"`. Negative: stub returns a slow response during the probe — `circuit_state === "open"` again, cooldown reset.

- **V15 — circuit OPEN rejects without sending (req 18, CC-9).** Setup: open the circuit. Action: `Jev.noul(...)`. Expected: throws `JevCircuitOpenError` with `fields.state === "open"`, `fields.reason` set. The stub server received 0 requests during this call (assert via the request counter).

- **V16 — HTTP 429 treated as failure, not retried (req 22).** Setup: stub returns HTTP 429. Action: `await Jev.noul(...)`. Expected: throws `JevHttpError` with `fields.status === 429`. `jev.http_429` warn logged. The adapter did NOT retry (stub server request counter at 1, not 2+). The failure counts toward the breaker's error rate (after enough 429s, the breaker opens — V13 logic).

- **V17 — metrics aggregate (req 14, CC-8).** Setup: fire 5 successful + 1 failed call. Action: `Jev.metrics()`. Expected: `calls_24h === 6`, `error_rate_pct ≈ 16.67`, `tokens_in_24h` and `cost_usd_24h` reflect the 5 successful calls (the failed call contributed 0 cost), `circuit_state` current.

- **V18 — external_opt_in false does not block, logs debug (req 10).** Setup: config with `external_opt_in: false`. Action: `await Jev.noul(...)`. Expected: the call succeeds (the adapter does not gate on opt-in). `jev.external_opt_in_false` debug logged. The pipeline (sdd-04) is responsible for not calling Jev when opt-in is false; this test only verifies the adapter's behavior if called anyway.

- **V19 — missing api_key throws JevConfigError (req 9).** Setup: config with `layer1.api_key: ""` (or the file referenced does not exist — paths.ts throws `InvalidError` before the adapter sees it; for this test, set the key to empty string). Action: `await Jev.noul(...)`. Expected: throws `JevConfigError` with `fields.field === "memory.extraction.layer1.api_key"`. A subsequent call after fixing the config (set the key to a valid string) succeeds — assert by re-calling with a patched config.

- **V20 — typecheck green (CC-7).** Action: `bun run typecheck` from `packages/fbh`. Expected: exit 0. No `any` type in `jev.ts` (the OpenRouter response is parsed via zod into a typed shape; the sliding window is `Array<{ latency_ms: number; success: boolean; error_kind?: string }>`).

- **V21 — test suite green (CC-7).** Action: `bun test --timeout 30000` from `packages/fbh`, filtering to `test/provider/jev.test.ts`. Expected: all V1-V19 tests pass. The full suite (CC-7) is verified at sdd-05 (the wiring spec) — this spec only requires the new test file to be green.

- **V22 — style compliance (req 23, AGENTS.md).** Action: inspect `packages/fbh/src/provider/jev.ts`. Expected: (a) public functions are single-word (`noul`, `choice`, `score`, `call`, `limit`, `breaker`, `metrics`); (b) no `any` type (grep `: any` and `as any` — zero matches); (c) `const` over `let` (grep `let ` — only allowed in the rate-limiter's `tokens` math if a reassignment is truly needed; prefer a `const next = ...` pattern); (d) early returns over `else` blocks (no `else` after a `return`); (e) functional array methods for the sliding window (`window.filter`, `window.reduce` for the error rate — no `for (let i = 0; i < window.length; i++)` loops); (f) no `Bun.file()` call in `jev.ts` (the adapter does not read files — config substitution is upstream — so this is a negative assertion).

- **V23 — config additive (req 7, CC-4 backward compat).** Setup: a Phase M-era `foxybear.json` with `memory.extraction` containing only `mode: "hybrid"`, `model: "..."`, `external_opt_in: false` — no `layer1`/`layer2`/`circuit_breaker`. Action: `getConfig()`. Expected: parses without error; `cfg.memory.extraction.mode === "hybrid"` (existing field preserved); `cfg.memory.extraction.layer1.model === "typesafe/jev-1.13"` (default filled in); `cfg.memory.extraction.layer2.model === "google/gemini-2.5-flash"` (default); `cfg.memory.extraction.external_opt_in === false` (explicitly set — preserved, NOT overridden by the new default `true`). The existing Phase M extraction code (mode.ts, memory.ts, entity.ts) continues to read `cfg.memory.extraction.model` and sees the same value as before — no regression. A config that omits `external_opt_in` entirely gets the new default `true` per SC-2.

## Dependencies

- **sdd-02** (Gemini provider) — parallel, no dependency. Both read `memory.extraction.layerX`. The config schema extension (req 7) adds both `layer1` and `layer2` in one edit; sdd-02 implements the `layer2` consumer, this spec implements the `layer1` consumer.
- **sdd-03** (Circular buffer) — parallel, no dependency. The buffer provides `state` content; this spec consumes `state` as an opaque string.
- **sdd-04** (Gate-extract-classify pipeline) — depends on this spec's `Jev.noul`, `Jev.choice`, `Jev.metrics`, and the circuit-breaker error types (`JevCircuitOpenError`, `JevRateLimitedError`).
- **sdd-05** (Wire into capture) — depends on sdd-04; transitively depends on this spec's adapter being live and the config schema being extended.
- **sdd-06** (Re-backfill) — depends on sdd-05; transitively depends on this spec.

## Open questions

| OQ | Question | Resolution |
|---|---|---|
| OQ1 | Should the adapter cache the layer1 config or re-read each call? | Deferred to sdd-04 (the pipeline calls Jev at most ~3 times per turn, so re-reading is cheap; caching with a 60s TTL is also fine — sdd-04 picks one). |
| OQ2 | Should the cost log persist across daemon restarts? | Resolved NO (req 14 — in-memory only; cost is negligible, daily aggregate is for observation not billing). If sdd-05 wants persistence, it can read `Jev.metrics()` on a schedule and persist. |
| OQ3 | Should the rate limiter be shared across layer1 (Jev) and layer2 (Gemini)? | Resolved NO (CC-5 specifies separate limits: Jev 10/sec, Gemini 5/sec). sdd-02 implements its own limiter. |
| OQ4 | Should the circuit breaker be per-layer or shared? | Resolved per-layer (the master spec's `circuit_breaker` config lives under `memory.extraction` and applies to both layers, but the breaker state is per-adapter — a Jev failure should not trip the Gemini breaker and vice versa). sdd-02 implements its own breaker. |
| OQ5 | What happens if `state` content exceeds Jev's context window? | Out of scope for this spec. sdd-03 (circular buffer) is responsible for keeping `state` within bounds; sdd-04 (pipeline) is responsible for truncating if needed. The adapter passes `state` through verbatim — if OpenRouter returns a 400 for oversize, the adapter throws `JevHttpError` and the breaker counts it. |
