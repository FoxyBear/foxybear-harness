# SDD-02: Gemini Extraction Provider

**Date:** 2026-09-26
**Project:** FoxyBear Harness Phase N (`development/foxybear`)
**Status:** Draft (pending independent audit + human gate)
**Master:** `260926_fbh-phase-n_sdd-00-master.md` (authoritative; where this spec conflicts, the master wins — inherits SC-1, SC-2, SC-5, CC-4, CC-5, CC-7, CC-8, CC-9, CC-10)
**Research:** `docs/research/260926_fbh-phase-n_salience-classification-spike.md` (§Stage 2 multi-model extraction comparison: Gemini 2.5 Flash 5/5 JSON reliability, 1.2s, $0.30/M — chosen; Llama 70B/Qwen 7B rejected at 40% JSON parse failure)
**Workstream:** `fbh-phase-n` (`tools/sdd/workstreams/fbh-phase-n.json`)
**Depends on:** none (parallel with `sdd-01` Jev provider and `sdd-03` circular buffer per master dependency graph)

Stage 2 of the 4-stage classification pipeline. The gate (SDD-01 Jev) decides whether a turn enriches a future query; **this spec wires the extractor** that pulls specific memory fragments from the full context. Jev cannot generate text (typed decisions only — spike OQ7 resolved), so extraction requires a chat LLM. The spike's 5-window × 6-model bake-off picked Gemini 2.5 Flash: 100% JSON reliability, 1.2s avg, $0.30/M tokens. Llama 70B and Qwen 7B were rejected (40% JSON parse failure from markdown code-fence wrapping) — that failure mode is why this spec has a parse-resilience requirement with retry and fence-stripping.

The provider is **config-driven** via `memory.extraction.layer2` (master SC-2, CC-4), accessed **only via OpenRouter** (CC-10 — single key, single billing), **rate-limited** at 5 req/sec (CC-5), **circuit-broken** to fall back to the regex extractor on repeated failure (CC-9 — the old stub behavior from `memory.ts:63`), and **cost-logged** to the existing `/memory/metrics` aggregate (CC-8). Secrets redaction (CC-6) runs BEFORE any content is sent; this spec consumes the already-redacted text from SDD-05 and does not re-implement redaction.

This spec ships the provider adapter only. The 4-stage pipeline orchestration (gate → extract → classify → store) is SDD-04. The wire-into-capture replacing the `extractViaLLM` stub at `memory.ts:63` and `entity.ts:82` is SDD-05. The re-backfill is SDD-06. No production capture path changes here.

---

## WHAT

### Interface (SC-1)

1. **WHEN** the Gemini provider module is imported, it **SHALL** export the `Gemini` namespace and the `ExtractedMemory` interface from master SC-1:
   ```typescript
   export interface ExtractedMemory {
     content: string
     type: "preference" | "correction" | "decision" | "constraint" | "pattern" | "context" | "none"
     source: "user" | "assistant"
   }

   export namespace Gemini {
     export async function extract(systemPrompt: string, userContent: string): Promise<{ memories: ExtractedMemory[]; skipped_reason?: string }>
   }
   ```
2. **WHEN** `extract` returns memories, each memory **SHALL** conform to `ExtractedMemory` from master SC-1 (fields: `content: string`, `type` in the 7-value enum, `source` in `["user", "assistant"]`).
3. **WHEN** `extract` produces no memories (gate not tripped, circuit open, parse exhausted, opt-in false, rate-limited, empty content), it **SHALL** return `{ memories: [], skipped_reason: "<reason>" }` with an explicit reason string from the closed set: `"external_opt_in false"`, `"circuit_open"`, `"rate_limited"`, `"json_parse_failed"`, `"empty_content"`. The reason **SHALL** be logged at info level for observability.

### Config (CC-4, SC-2, CC-10)

4. **WHEN** the provider is initialized, it **SHALL** read `memory.extraction.layer2` from the resolved global config via the existing `getConfig()` bridge (`src/config/bridge.ts`) used by `resolveExtractionConfig` at `src/memory/extraction/mode.ts:44`. The fields consumed **SHALL** be: `provider`, `model`, `api_key`.
5. **WHEN** `memory.extraction.layer2.model` is unset, the provider **SHALL** default to `"google/gemini-2.5-flash"` (master SC-2, spike §Stage 2 decision).
6. **WHEN** `memory.extraction.layer2.provider` is set and is not `"openrouter"`, the provider **SHALL** throw a config error at construction time with a message naming the offending value (CC-10: OpenRouter only — no direct Gemini API, no alternate routing).
7. **WHEN** `memory.extraction.layer2.api_key` uses the `{file:path}` form (master SC-2 shows `"{file:~/Development/.openrouter.key}"`), the provider **SHALL** resolve it via the existing config substitution at `src/config/paths.ts:77-129` (the `substitute` function), which already handles `~/` expansion to `os.homedir()` and absolute/relative path resolution. The provider **SHALL NOT** re-implement file expansion.
8. **WHEN** `memory.extraction.external_opt_in` is `false` (master SC-2 default is `true` — opt-out is explicit), the provider **SHALL NOT** make any external call and **SHALL** return `{ memories: [], skipped_reason: "external_opt_in false" }` immediately. No rate-limit slot is consumed, no circuit-breaker state is touched.
9. **WHEN** the circuit-breaker config is read, the provider **SHALL** consume `memory.extraction.circuit_breaker` from master SC-2: `max_latency_ms` (default 3000), `max_consecutive_failures` (default 5), `max_error_rate_pct` (default 5), `fallback` (default `"regex"`).

### JSON mode (SC-5)

10. **WHEN** `extract` builds the OpenRouter chat request, it **SHALL** set `response_format: { type: "json_object" }` and `temperature: 0` per master SC-5 and the spike's validated request shape.
11. **WHEN** `extract` builds the request, the `model` field **SHALL** be `memory.extraction.layer2.model` (default `"google/gemini-2.5-flash"`), parsed via `Provider.parseModel` at `src/provider/provider.ts:1771` to confirm it routes to the `openrouter` provider ID.
12. **WHEN** `extract` builds the request, the `messages` array **SHALL** contain the system prompt as a `{ role: "system" }` message and the user content as a `{ role: "user" }` message, in that order. No assistant prefill, no few-shot examples (the system prompt is the contract).

### Parse resilience

13. **WHEN** the OpenRouter response body cannot be parsed as JSON (first `JSON.parse` throws), the provider **SHALL** retry the request up to 2 additional times with exponential backoff (500ms, then 1500ms) before declaring a parse failure.
14. **WHEN** the response body parses as JSON but the `memories` field is missing or not an array, the provider **SHALL** treat it as a parse failure and apply the retry policy from req 13.
15. **WHEN** the response body contains JSON wrapped in markdown code fences (```` ```json ... ``` ```` or ```` ``` ... ``` ````), the provider **SHALL** strip the fences before parsing. This is the Llama/Qwen failure mode the spike documented (40% parse failure); Gemini did not exhibit it in the bake-off, but the strip is cheap insurance against model-side regression.
16. **WHEN** all retries are exhausted (initial + 2 retries = 3 attempts), the provider **SHALL** return `{ memories: [], skipped_reason: "json_parse_failed" }`, **SHALL** record a consecutive failure for the circuit breaker (req 18), and **SHALL NOT** throw — the pipeline (SDD-04) treats `skipped_reason` as a soft skip, not an exception.
17. **WHEN** a memory in the parsed `memories` array has a `type` outside the 7-value enum or a `source` outside `{ "user", "assistant" }`, the provider **SHALL** drop that single memory (not the whole array), **SHALL** log a warning with the invalid value, and **SHALL** keep the valid memories. A `content` field that is empty or non-string **SHALL** also drop that memory.

### Circuit breaker (CC-9)

18. **WHEN** a Gemini call's latency exceeds `memory.extraction.circuit_breaker.max_latency_ms` (default 3000), the provider **SHALL** record a consecutive failure. The call's result (if it eventually returns) **SHALL** still be returned to the caller — the breaker counts the latency breach, not the response.
19. **WHEN** a Gemini call errors (network failure, non-2xx HTTP, or parse failure per req 16), the provider **SHALL** record a consecutive failure.
20. **WHEN** consecutive failures reach `max_consecutive_failures` (default 5), the provider **SHALL** trip the circuit open. While the circuit is open, subsequent `extract` calls **SHALL** return `{ memories: [], skipped_reason: "circuit_open" }` immediately without making an external call, **SHALL** log the fallback at warn level, and **SHALL** emit a fallback signal that SDD-04's pipeline reads to route to the regex extractor (the old stub behavior at `memory.ts:41` `extractRegex` — master CC-9).
21. **WHEN** a Gemini call succeeds (2xx, valid JSON, latency within budget), the provider **SHALL** reset consecutive failures to 0 and close the circuit. The breaker pattern **SHALL** mirror the existing `SessionCompaction` circuit at `src/session/compaction.ts:384-401` (`consecutiveFailures` counter, `autoDisabled` flag, `recordCompactionFailure`/`recordCompactionSuccess` effect functions) — no new circuit-breaker abstraction, reuse the idiom.
22. **WHEN** the circuit has been open for ≥ 60 seconds, the provider **SHALL** permit one half-open probe call to test recovery. If the probe succeeds, the circuit closes (req 21). If the probe fails, the circuit stays open and the 60s timer restarts.

### Rate limit (CC-5)

23. **WHEN** the provider receives `extract` calls, it **SHALL** rate-limit outbound OpenRouter requests at 5 requests per second (master CC-5: Gemini 5 req/sec). The limiter **SHALL** be a token-bucket or sliding-window with 5 tokens/sec capacity. Calls that would exceed the rate **SHALL** be queued (awaited) — not dropped — until a token is available.
24. **WHEN** the rate limiter's pending queue exceeds a bounded depth of 50, the provider **SHALL** drop the oldest pending call and return `{ memories: [], skipped_reason: "rate_limited" }` to that caller. This is back-pressure, not unbounded queue growth. The queue depth (50) **SHALL** be a `const` at the top of the provider file.

### Cost logging (CC-8)

25. **WHEN** a Gemini call completes (success or failure), the provider **SHALL** log the token count (input + output, from the OpenRouter `usage` field) and the computed cost. Cost **SHALL** be computed using the model's cost info from `src/provider/models-snapshot.js` and the existing `Decimal`-based calculation idiom at `src/session/index.ts:287-303` (`new Decimal(tokens.input).mul(costInfo.input).div(1_000_000)` etc.).
26. **WHEN** cost is logged, the log entry **SHALL** contain only metadata: `model`, `provider`, `tokens.input`, `tokens.output`, `latency_ms`, `cost_usd`, `success` (boolean). The entry **SHALL NOT** contain the system prompt, the user content, the parsed memories, or any session text (master Security: no session content at info level). The log level **SHALL** be `info` for success and `warn` for failure.
27. **WHEN** the `/memory/metrics` endpoint is hit (`src/daemon/routes.ts:101`), the aggregate Gemini extraction cost (daily total + call count) **SHALL** be visible in the metrics response. The provider **SHALL** expose its running cost counter via an accessor that the existing memory backend (`getGlobalMemoryBackend().metrics()`) integrates — no new endpoint, extend the existing metrics aggregation.

### Style & suite (CC-7)

28. **WHEN** the provider is implemented, it **SHALL** follow the AGENTS.md style guide: single-word names for locals and helpers (`extract`, `parse`, `limit`, `breaker`, `probe` — NOT `extractMemories`, `parseResponse`, `rateLimiter`, `circuitBreaker`, `halfOpenProbe`); `Bun.file()` for any file I/O (not `fs`); `const` over `let` (use ternaries/early returns, not reassignment); no `any` type; early returns over `else`; functional array methods (`flatMap`/`filter`/`map` with type guards) over `for` loops. The provider file **SHALL** live at `src/provider/gemini.ts` and export the `Gemini` namespace with `extract` per master SC-1.
29. **WHEN** `bun run typecheck` runs from `packages/fbh`, it **SHALL** be green (master CC-7). No new `tsc` suppressions, no `@ts-expect-error` added.
30. **WHEN** `bun test --timeout 30000` runs from `packages/fbh`, the SDD-02 test suite at `packages/fbh/test/fbh-phase-n/sdd-02.test.ts` **SHALL** be green (master CC-7). Tests **SHALL NOT** mock the implementation under test (master CC-5 restate) — the provider hits the real OpenRouter endpoint or a recorded-response fixture, not a stubbed `fetch`. Tests run from `packages/fbh`, never repo root (master SC-10).

---

## HOW

### Step 1: Provider file (reqs 1-3, 28)

Create `src/provider/gemini.ts` exporting `Gemini` (namespace) and `ExtractedMemory` (interface) per master SC-1:

```typescript
import { Log } from "../util/log"
import { getConfig } from "../config/bridge"
import { Provider } from "./provider"
import { parseAPICallError } from "./error"

const log = Log.create({ service: "provider.gemini" })

const DEFAULT_MODEL = "google/gemini-2.5-flash"
const QUEUE_DEPTH = 50
const RATE_PER_SEC = 5
const RETRY_DELAYS_MS = [500, 1500]
const HALF_OPEN_MS = 60_000
const TYPES = ["preference", "correction", "decision", "constraint", "pattern", "context", "none"] as const
const SOURCES = ["user", "assistant"] as const

export interface ExtractedMemory {
  content: string
  type: "preference" | "correction" | "decision" | "constraint" | "pattern" | "context" | "none"
  source: "user" | "assistant"
}

// Module-level state (lazy-initialized on first extract call). `let` only for
// stateful counters/cache — the SessionCompaction idiom at compaction.ts:384-385.
let consecutive = 0
let openSince = 0  // 0 = closed; timestamp ms = open
let cfg: ResolvedConfig | null = null

export namespace Gemini {
  export async function extract(systemPrompt: string, userContent: string): Promise<{ memories: ExtractedMemory[]; skipped_reason?: string }> {
    // lazy config resolution on first call (reqs 4-9)
    // opt-in check → circuit check → rate limiter → network call (Step 6 ordering)
  }
  export function metrics(): { daily_cost: number; daily_calls: number; day: string } {
    // cost aggregate accessor (CC-8, req 27)
  }
}
```

No `make()` factory — `Gemini.extract` is a direct function per SC-1. The config is resolved lazily on the first `extract` call and cached in the module-level `cfg`. The breaker counters (`consecutive`, `openSince`) and config cache (`cfg`) are the only `let` variables — matching the `SessionCompaction` idiom at `compaction.ts:384-385`. `metrics()` is an extra export (not in SC-1) for CC-8 cost aggregation; SDD-04 reads `skipped_reason: "circuit_open"` from the `extract` return to detect the fallback (no separate `fallback()` accessor — the return value IS the signal).

Single-word helper names inside the module: `extract`, `parse`, `limit`, `breaker`, `probe`. No multi-word compounds.

### Step 2: Config resolution (reqs 4-9)

On the first `Gemini.extract` call, lazily resolve config via the existing `getConfig()` bridge (same path as `resolveExtractionConfig` at `mode.ts:44`) and cache it in the module-level `cfg`. Extract `memory.extraction.layer2` and `memory.extraction.external_opt_in` and `memory.extraction.circuit_breaker`. Apply defaults per reqs 5, 9. Validate `provider === "openrouter"` (req 6) — throw on mismatch. The `{file:path}` api_key is already substituted by `src/config/paths.ts:77-129` before the config reaches `getConfig()`, so the provider reads the resolved string directly (req 7) — no re-expansion. Subsequent `extract` calls reuse the cached `cfg` (no re-read on the hot path).

### Step 3: OpenRouter chat API call with JSON mode (reqs 10-12)

Build the request body per master SC-5:

```typescript
const body = {
  model: cfg.model ?? DEFAULT_MODEL,
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ],
  response_format: { type: "json_object" },
  temperature: 0,
}
```

POST to `https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer <key>`. Use the global `fetch` (Bun has it natively). Parse `Provider.parseModel(cfg.model ?? DEFAULT_MODEL)` at `provider.ts:1771` to confirm `providerID === "openrouter"` (req 11) — throw at construction if not.

### Step 4: Parse resilience (reqs 13-17)

Wrap the response parsing in a retry loop (initial + `RETRY_DELAYS_MS` = 3 attempts). For each attempt:

1. Read the response body as text.
2. Strip markdown code fences if present: match `^```(?:json)?\s*(.+?)\s*```$`s and take the inner group. This is the Llama/Qwen failure mode (req 15) — Gemini didn't hit it in the spike, but the strip is cheap.
3. `JSON.parse` the (possibly stripped) text. On throw, continue to next retry.
4. If parsed, check `Array.isArray(parsed.memories)`. If not, continue to next retry (req 14).
5. Filter memories: keep only those with `typeof content === "string" && content.length > 0`, `TYPES.includes(type)`, `SOURCES.includes(source)` (req 17). Log a warning per dropped memory with the invalid field.

If all attempts fail, return `{ memories: [], skipped_reason: "json_parse_failed" }` and record a breaker failure (req 16, req 19). Do not throw.

### Step 5: Circuit breaker (reqs 18-22)

Mirror the `SessionCompaction` circuit at `compaction.ts:384-401`. Two `let` variables in the closure:

```typescript
let consecutive = 0
let openSince = 0  // 0 = closed; timestamp ms = open
```

On every call, before hitting the network: if `openSince > 0 && Date.now() - openSince < HALF_OPEN_MS`, return `{ memories: [], skipped_reason: "circuit_open" }` (req 20). If `openSince > 0 && Date.now() - openSince >= HALF_OPEN_MS`, permit one half-open probe (req 22) — set a flag, make the call, on success reset (req 21), on failure restart the 60s timer.

Wrap the latency measurement: record `Date.now()` before the fetch, compute `latency = Date.now() - start` after. If `latency > cfg.max_latency_ms`, increment `consecutive` (req 18) but still return the result. On error (network/non-2xx/parse-failed), increment `consecutive` (req 19). On success within latency budget, reset `consecutive = 0` and `openSince = 0` (req 21). When `consecutive >= cfg.max_consecutive_failures`, set `openSince = Date.now()` and log the fallback at warn (req 20).

Emit the fallback signal via the return value: while the circuit is open, `extract` returns `{ memories: [], skipped_reason: "circuit_open" }`. SDD-04's pipeline reads this `skipped_reason` to route to `extractRegex` at `memory.ts:41` (no separate `fallback()` accessor — the return value IS the signal, per SC-1's `extract` signature).

### Step 6: Rate limiter (reqs 23-24)

Token bucket: 5 tokens, refill 1 token every 200ms (5/sec). A queue of pending callers (FIFO). On `extract`:

1. If a token is available, take it and proceed.
2. Else enqueue the caller's promise and start a 200ms timer to refill.
3. If `queue.length > QUEUE_DEPTH` (50), pop the oldest caller and resolve its promise with `{ memories: [], skipped_reason: "rate_limited" }` (req 24).

The opt-in check (req 8) runs FIRST, then the circuit check (req 20), then the rate limiter — opt-in false and circuit-open return immediately without consuming a token. Only calls that will actually hit the network (closed circuit or half-open probe, with opt-in true) take a token. This ordering means a closed or half-open circuit with opt-in true is the only path that rate-limits.

### Step 7: Cost logging (reqs 25-27)

On every call completion (success or failure), log via `log.info` (success) or `log.warn` (failure) with the metadata object from req 26. Compute cost using the model's `cost` field from the models snapshot (`src/provider/models-snapshot.js`) and the `Decimal` idiom at `session/index.ts:287-303`:

```typescript
import Decimal from "decimal.js"
const cost = new Decimal(tokens.input).mul(costInfo.input).div(1_000_000)
  .add(new Decimal(tokens.output).mul(costInfo.output).div(1_000_000))
  .toNumber()
```

Maintain a running aggregate in module-level state: `{ daily_cost: number, daily_calls: number, day: string }`. On each call, if `day !== new Date().toDateString()`, reset the daily counters. Expose via `Gemini.metrics()` (the extra export in Step 1). The existing memory backend at `src/daemon/routes.ts:101` (`/memory/metrics`) calls `getGlobalMemoryBackend().metrics()`; the provider's `metrics()` is composed into that response by SDD-04 (the pipeline) or SDD-05 (the wire-into-capture) — this spec exposes the accessor, integration is downstream.

### Step 8: Tests (req 30)

Create `packages/fbh/test/fbh-phase-n/sdd-02.test.ts`. Tests SHALL NOT mock the implementation under test (master CC-5 restate). Two modes:

- **Live mode** (gate `GEMINI_LIVE=1`): hits the real OpenRouter endpoint with the configured key. Used for manual verification, not CI.
- **Fixture mode** (default): replays recorded OpenRouter responses from `test/fbh-phase-n/fixtures/sdd-02/` via a `Bun.file()`-backed response loader. The fixture set includes: (a) a valid JSON response, (b) a markdown-fence-wrapped response, (c) a malformed JSON response (to exercise retry), (d) a 500 error response, (e) a slow response (>3s, to exercise latency breaker).

Tests cover each VERIFY case V1–V8 below. Run from `packages/fbh` (never repo root — master SC-10).

### Reuse map

- `src/provider/provider.ts:1771` `Provider.parseModel` — model string → `{ providerID, modelID }` parsing (req 11)
- `src/provider/provider.ts:123-147` `BUNDLED_PROVIDERS` (includes `@openrouter/ai-sdk-provider` → `createOpenRouter`) — confirms OpenRouter is a bundled transport (this spec uses raw `fetch`, not the SDK, because JSON-mode `response_format` is more direct via the chat API; the SDK is the fallback if `fetch` proves brittle)
- `src/provider/error.ts:173` `parseAPICallError` — non-2xx response handling (req 19)
- `src/config/bridge.ts` `getConfig` — config resolution (req 4), same path as `mode.ts:44`
- `src/config/paths.ts:77-129` `substitute` — `{file:path}` and `~/` expansion (req 7), already applied before config reaches the provider
- `src/memory/extraction/mode.ts:44` `resolveExtractionConfig` — the existing config reader this provider extends (the `layer2` field is additive to the same `memory.extraction` object, master SC-2)
- `src/memory/extraction/redact.ts` `redact` — secrets redaction (CC-6), runs upstream in SDD-05 before `extract` is called; this spec consumes redacted text
- `src/memory/extraction/memory.ts:41` `extractRegex` — the fallback target when the circuit opens (CC-9, req 20)
- `src/session/compaction.ts:384-401` — the circuit-breaker idiom to mirror (req 21): `consecutiveFailures` counter, `autoDisabled` flag, `recordCompactionFailure`/`recordCompactionSuccess` effect functions
- `src/session/index.ts:287-303` — the `Decimal`-based cost calculation idiom (req 25)
- `src/provider/models-snapshot.js` — per-model `cost.input`/`cost.output` rates (req 25)
- `src/daemon/routes.ts:101` `/memory/metrics` — the aggregate cost endpoint (req 27)
- `src/cli/cmd/stats.ts:277` `stats.modelUsage[model].cost += usage.cost` — the existing per-model cost aggregation pattern (req 27)

### What is explicitly NOT built

- **No new circuit-breaker abstraction.** Reuse the `SessionCompaction` idiom (req 21). No new `CircuitBreaker` class, no new `@foxybear/CircuitBreaker` service.
- **No new rate-limiter abstraction.** Inline token-bucket in module-level state. If a future spec needs a shared limiter, extract then.
- **No secrets redaction re-implementation.** CC-6 redaction runs upstream in SDD-05. This provider receives already-redacted text.
- **No new config section.** `memory.extraction.layer2` is additive to the existing `memory.extraction` object (master SC-2). No new top-level config key.
- **No production capture path changes.** The stub `extractViaLLM` at `memory.ts:63` and `entity.ts:82` is replaced by SDD-05, not this spec. This spec ships the provider; SDD-05 wires it.
- **No pipeline orchestration.** Gate → extract → classify → store is SDD-04. This spec is the extract stage adapter only.
- **No direct Gemini API.** CC-10: OpenRouter only. The provider posts to `openrouter.ai/api/v1/chat/completions`, never to `generativelanguage.googleapis.com`.

---

## VERIFY

Acceptance tests live at `packages/fbh/test/fbh-phase-n/sdd-02.test.ts`. Tests SHALL NOT mock the implementation under test (master CC-5). Tests use recorded fixtures at `test/fbh-phase-n/fixtures/sdd-02/` (default) or hit the real OpenRouter endpoint (env `GEMINI_LIVE=1`, manual only). Tests run from `packages/fbh` (never repo root — master SC-10).

- **V1 — config consumed (reqs 4-9).** Setup: a `foxybear.json` fixture with `memory.extraction.layer2 = { provider: "openrouter", model: "google/gemini-2.5-flash", api_key: "{file:~/Development/.openrouter.key}" }`, `external_opt_in: true`, `circuit_breaker: { max_latency_ms: 3000, max_consecutive_failures: 5, max_error_rate_pct: 5, fallback: "regex" }`. Action: call `Gemini.extract("system", "user")` (the provider resolves config lazily on first call). Expected: the provider reads `layer2.model` and applies the default when unset; the `{file:...}` key is already resolved by `paths.ts` substitution before reaching the provider (assert the provider received the raw key string, not the `{file:...}` token); `provider !== "openrouter"` throws on the first `extract` call; `external_opt_in: false` short-circuits `extract` to return `{ memories: [], skipped_reason: "external_opt_in false" }` without a network call.

- **V2 — JSON mode (reqs 10-12).** Setup: fixture `valid-json.json` with a well-formed OpenRouter chat response. Action: call `extract(systemPrompt, userContent)`. Expected: the outbound request body (captured by the fixture loader) contains `response_format: { type: "json_object" }`, `temperature: 0`, `model: "google/gemini-2.5-flash"`, and `messages` with the system prompt as role `system` and user content as role `user` in that order. `Provider.parseModel` confirms the model routes to `openrouter`.

- **V3 — JSON parse resilience (reqs 13-17).** Four sub-cases:
  - (a) **Malformed JSON, then valid:** fixture sequence `[malformed.json, valid-json.json]`. Action: call `extract`. Expected: the provider retries after 500ms, succeeds on attempt 2, returns the memories from the valid response. The retry delays match `RETRY_DELAYS_MS` (assert timing via a fake timer or a recorded timestamp).
  - (b) **Markdown-fence-wrapped:** fixture `fenced.json` with the JSON wrapped in ```` ```json ... ``` ````. Action: call `extract`. Expected: the provider strips the fence, parses, returns the memories — no retry needed.
  - (c) **All attempts malformed:** fixture sequence `[malformed.json, malformed.json, malformed.json]`. Action: call `extract`. Expected: returns `{ memories: [], skipped_reason: "json_parse_failed" }` after 3 attempts (initial + 2 retries); a consecutive failure is recorded for the breaker; no throw.
  - (d) **Invalid type/source dropped:** fixture `invalid-fields.json` with a memories array where one memory has `type: "opinion"` (invalid) and another has `source: "system"` (invalid). Action: call `extract`. Expected: the invalid memories are dropped, the valid ones are returned, a warning is logged per dropped memory with the invalid value.

- **V4 — circuit breaker fires (reqs 18-22).** Four sub-cases:
  - (a) **Latency trip:** fixture `slow.json` that records a 3100ms latency (> `max_latency_ms: 3000`). Action: call `extract` 5 times. Expected: each call increments `consecutive`; on the 5th, the circuit opens; the 6th call returns `{ memories: [], skipped_reason: "circuit_open" }` without a network call (the `skipped_reason` IS the fallback signal SDD-04 reads).
  - (b) **Error trip:** fixture sequence of 5 `[500.json, 500.json, 500.json, 500.json, 500.json]`. Action: call `extract` 5 times. Expected: each call records a failure; on the 5th, the circuit opens; the 6th call short-circuits with `skipped_reason: "circuit_open"`.
  - (c) **Closes on success:** after (a) or (b) opens the circuit, wait `HALF_OPEN_MS` (60s — use a fake timer), call `extract` with a valid fixture. Expected: the half-open probe succeeds, `consecutive` resets to 0, `openSince` resets to 0, subsequent calls return memories (not `skipped_reason: "circuit_open"`) and proceed normally.
  - (d) **Half-open probe fails:** after the circuit opens, wait 60s, call `extract` with a malformed fixture. Expected: the probe fails, the circuit stays open (the call returns `skipped_reason: "circuit_open"` or `"json_parse_failed"`), the 60s timer restarts (assert `openSince` is updated to the probe attempt time).

- **V5 — rate limit enforced (reqs 23-24).** Two sub-cases:
  - (a) **5 req/sec:** fire 10 concurrent `extract` calls. Expected: the first 5 proceed immediately (tokens available), the next 5 queue; after 200ms a token refills and the 6th proceeds; the total wall-clock time for all 10 is ≥ 1000ms (5 calls at 200ms spacing) and < 2000ms. Assert via recorded timestamps.
  - (b) **Queue overflow:** fire 60 concurrent `extract` calls (with a slow fixture so the limiter is the bottleneck). Expected: 5 proceed immediately (tokens available), 50 queue (queue depth 50), 5 are dropped (queue depth 50 → 5 over); the 5 dropped callers receive `{ memories: [], skipped_reason: "rate_limited" }`; the 55 non-dropped callers eventually complete. Assert the dropped count is exactly 5.

- **V6 — cost logged (reqs 25-27).** Setup: fixture `valid-json.json` with `usage: { prompt_tokens: 120, completion_tokens: 80 }`. Action: call `extract` and capture the log output. Expected: (a) an info log entry with `model: "google/gemini-2.5-flash"`, `provider: "openrouter"`, `tokens.input: 120`, `tokens.output: 80`, `latency_ms: <number>`, `cost_usd: <number computed from models-snapshot.js rates>`, `success: true`; (b) the log entry contains NO prompt content, NO user content, NO parsed memory text (grep the serialized log for a known prompt substring and assert absence); (c) `Gemini.metrics()` returns `{ daily_cost: <sum>, daily_calls: 1, day: <today> }`; (d) after midnight rollover (simulate by advancing the date), `Gemini.metrics()` resets the daily counters.

- **V7 — interface conformance (reqs 1-3).** Action: call `extract` with empty `userContent`. Expected: returns `{ memories: [], skipped_reason: "empty_content" }` (the system prompt alone produces no memories). Call `extract` with content that produces memories: returns `{ memories: ExtractedMemory[], skipped_reason: undefined }` where each memory has `content: string`, `type` in the 7-value enum, `source` in `["user", "assistant"]`. The return type matches `{ memories: ExtractedMemory[]; skipped_reason?: string }` exactly — no extra fields, no missing fields.

- **V8 — green suite (reqs 29-30, CC-7).** Action: from `packages/fbh`, run `bun run typecheck` and `bun test --timeout 30000`. Expected: both green; `sdd-02.test.ts` is part of the green suite; no `any` type introduced in `src/provider/gemini.ts`; no `@ts-expect-error` added; no `for` loops where `flatMap`/`filter`/`map` would do; all locals are `const` except the three module-level `let` state variables (`consecutive`, `openSince`, `cfg`) which match the `SessionCompaction` idiom.
