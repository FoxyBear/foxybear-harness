# SDD-04: Phase N — Gate-Extract-Classify Pipeline

**Date:** 2026-09-26
**Project:** FoxyBear Harness Phase N (`development/foxybear`)
**Status:** Draft (pending independent audit + human gate)
**Master:** `260926_fbh-phase-n_sdd-00-master.md` — inherits SC-1, SC-3, SC-4, SC-5, CC-2, CC-3, CC-4, CC-5, CC-6, CC-7, CC-8, CC-9, CC-10
**Research:** `docs/research/260926_fbh-phase-n_salience-classification-spike.md` — all 4 stages empirically validated
**Workstream:** `fbh-phase-n` (`tools/sdd/workstreams/fbh-phase-n.json`)
**Depends on:** SDD-01 (Jev provider — `Jev.noul`/`choice`), SDD-02 (Gemini provider — `Gemini.extract`), SDD-03 (Circular buffer — `Buffer.getContext`)
**Blocks:** SDD-05 (Wire into capture — replaces the stub `MemoryExtractor.extract` call at `src/session/prompt.ts:227`)

Phase N replaces the stub `extractViaLLM` in `src/memory/extraction/entity.ts:82` and `src/memory/extraction/memory.ts:63` (which return regex results labeled `source_path: "llm"`) with a real 4-stage classification pipeline. The pipeline orchestrates the three Phase N primitives: `Jev` (gate + classify), `Gemini` (extract), and `Buffer` (context arc). It runs post-turn via `run.fork`, never blocks the LLM response (CC-3), and writes `MEMORY` nodes through the existing `SurrealHypergraphBackend.store` path (Phase M) — the pipeline owns the store step (SC-1). The capture hook (SDD-05) and the re-backfill (SDD-06) call `classify(input)` and never call `SurrealHypergraphBackend.store` directly for extracted memories. The 7-type classification (SC-4) gates storage: `type = "none"` is skipped, all other types are stored. Initial confidence is 0.7 for all extracted memories per the master spec (Gemini extraction is deterministic-quality — the gate+extract+classify chain is empirically reliable: 100% recall, 0 false positives in the 150-turn spike).

**Stub replacement, not addition (CC-2):** the old `EntityExtractor.extract` and `MemoryExtractor.extract` calls in the post-turn hook (`src/session/prompt.ts:226-227`) are removed by SDD-05. This spec defines the replacement pipeline; SDD-05 wires it. No parallel code paths.

## Scope

In scope (Phase N SDD-04 only):

- `src/memory/classify/` — new directory housing the 4-stage pipeline orchestrator. Imports `Jev` (SDD-01, `src/provider/jev.ts`), `Gemini` (SDD-02, `src/provider/gemini.ts`), `Buffer` (SDD-03, `src/memory/capture/buffer.ts`). Writes via `SurrealHypergraphBackend.store` (Phase M) and `Embedding.embed` (Phase M). The pipeline owns the store step (SC-1).
- The 4 stages: gate (`Jev.noul` on buffer context + current turn), extract (`Gemini.extract` JSON on full context), classify (`Jev.choice` per fragment over 7 types), store (embed + `SurrealHypergraphBackend.store` as `MEMORY` node).
- Secrets redaction (reuse Phase M `redact`) runs BEFORE the gate and BEFORE extraction. No un-redacted content reaches Jev or Gemini.
- Initial confidence 0.7 for all stored memories; `attributes.source_path = "llm"`.
- Async non-blocking execution via `run.fork` (CC-3). Exceptions logged at `warn` and swallowed.
- Config-driven: `memory.extraction.layer1` (Jev), `memory.extraction.layer2` (Gemini), `memory.extraction.gate_threshold` (default 0.5), `memory.extraction.circuit_breaker` (CC-9), `memory.extraction.external_opt_in` (default `true` per SC-2).

Out of scope:

- Jev provider adapter, Gemini provider adapter, circular buffer implementation (SDD-01, SDD-02, SDD-03 — parallel specs).
- Wiring the pipeline into the post-turn hook (SDD-05 — removes the stub call at `src/session/prompt.ts:227`, replaces with `classify(input)`).
- Re-backfill of the 1,269-session repository (SDD-06 — calls `classify(input)` against historical tapes; does not call `SurrealHypergraphBackend.store` directly).
- Goal relevance, Memory Worth, domain mapping, Phase 4 distillation (deferred per master spec).
- `ENTITY` / `PROCEDURE` / `HYPEREDGE` extraction — Phase N stores `MEMORY` nodes only. The stub `EntityExtractor.extract` is removed by SDD-05; the 138k noise `ENTITY` nodes are deleted by SDD-06.

## Config (from master SC-2)

Consumed from `~/.config/foxybear/fbh.json` under `memory.extraction`. Additive to the Phase M shape:

```json
"memory": {
  "extraction": {
    "layer1": { "provider": "openrouter", "model": "typesafe/jev-1.13", "api_key": "{file:~/Development/.openrouter.key}" },
    "layer2": { "provider": "openrouter", "model": "google/gemini-2.5-flash", "api_key": "{file:~/Development/.openrouter.key}" },
    "gate_threshold": 0.5,
    "external_opt_in": true,
    "circuit_breaker": { "max_latency_ms": 3000, "max_consecutive_failures": 5, "max_error_rate_pct": 5, "fallback": "regex" }
  }
}
```

`gate_threshold` defaults to 0.5 (master spec). `external_opt_in` defaults to `true` for Phase N (SC-2 — the Phase M default of `false` is superseded; the spike validated the pipeline, and opt-in is retained as the self-hosted / air-gapped kill switch). The circuit breaker (CC-9) falls back to regex-only extraction (the old stub behavior) on sustained Jev/Gemini failure.

## WHAT

### Stage 1 — Gate (Jev Noul)

**W-1** WHEN a user turn completes (the post-turn hook fires `classify(input)` after the step loop exits at `src/session/prompt.ts:1645`), the pipeline SHALL build the Jev gate state from the circular buffer context (last 5 user turns per SC-3, retrieved via `Buffer.getContext(input.sessionID)`) concatenated with the current turn's text content (`input.text`). The state SHALL be the redacted (W-17) buffer context + current turn, formatted as a single string.

**W-2** WHEN the gate state is built, the pipeline SHALL invoke `Jev.noul(state, instructions, criteria)` with `instructions = "Would this context, if recalled later, positively enrich a future LLM query?"` and `criteria = { true: "The context contains a memory-worthy signal — a preference, correction, decision, constraint, pattern, or useful working context that a future query would benefit from recalling.", false: "The context is routine — a mechanical tool call, an acknowledgment, or content with no durable value for future queries." }`. The call SHALL be dispatched via the OpenRouter decisions API (SC-5) using the `memory.extraction.layer1` config.

**W-3** WHEN `Jev.noul` returns `enriches_future > memory.extraction.gate_threshold` (default 0.5), the pipeline SHALL proceed to Stage 2 (extract). The probability SHALL be logged at `debug` level with the gate decision (`pass`/`skip`) and the numeric value.

**W-4** WHEN `Jev.noul` returns `enriches_future <= memory.extraction.gate_threshold`, the pipeline SHALL skip Stage 2 and Stage 3 for this turn, SHALL NOT invoke Gemini extraction, SHALL NOT store any `MEMORY` node for this turn, and SHALL return `ClassifyResult { stored: 0, skipped: 1, errors: 0 }`. The skip SHALL be logged at `debug` level.

**W-5** WHEN the gate Jev call fails (network error, 4xx, 5xx, JSON parse error, or latency > `circuit_breaker.max_latency_ms` for `circuit_breaker.max_consecutive_failures` consecutive calls per CC-9), the pipeline SHALL fall back to the Phase M regex extractor (`MemoryExtractor.extractRegex` at `src/memory/extraction/memory.ts:41`) for this turn, SHALL log the fallback at `warn` level with the error and the circuit-breaker state, and SHALL continue processing subsequent turns through the gate (the circuit breaker is per-call, not per-session — a single failure does not permanently disable the pipeline).

### Stage 2 — Extract (Gemini JSON)

**W-6** WHEN the gate passes (W-3), the pipeline SHALL build the extraction payload from the full turn context: the current turn's user message (`input.text`), the assistant message text, and any tool-call input/output summaries (the same text-only payload shape as Phase M W-14 — no embeddings, no `auth.json` contents, no API keys). The payload SHALL be redacted (W-18) BEFORE the Gemini call.

**W-7** WHEN the extraction payload is built, the pipeline SHALL invoke `Gemini.extract(systemPrompt, userContent)` with `systemPrompt = "Extract specific memories from this conversation context. Each memory has a content (the memory text), a type (one of: preference, correction, decision, constraint, pattern, context, none), and a source (user or assistant). Return JSON: { memories: [{ content, type, source }], skipped_reason?: string }. Use 'none' for content with no durable value. Use 'context' for useful working context that isn't a durable fact (hypotheses, intermediate states, what was tried)."` and `userContent` = the redacted full context. The call SHALL use the `memory.extraction.layer2` config (Gemini 2.5 Flash via OpenRouter chat API, JSON mode, temperature 0 per SC-5).

**W-8** WHEN `Gemini.extract` returns `{ memories: [...] }` with one or more fragments, the pipeline SHALL proceed to Stage 3 (classify) for each fragment. WHEN it returns `{ memories: [] }` or `{ skipped_reason: "..." }`, the pipeline SHALL skip Stage 3 and Stage 4 for this turn, SHALL log the `skipped_reason` at `debug` level, and SHALL return `ClassifyResult { stored: 0, skipped: 1, errors: 0 }`.

**W-9** WHEN the Gemini extraction call fails (network error, 4xx, 5xx, JSON parse failure — Gemini is selected for 100% JSON reliability per the spike, but malformed JSON is still possible on truncation), the pipeline SHALL fall back to the Phase M regex extractor (`MemoryExtractor.extractRegex`) for this turn, SHALL log the fallback at `warn` level, and SHALL NOT abort the pipeline (subsequent turns continue through the gate).

### Stage 3 — Classify (Jev Choice per fragment)

**W-10** WHEN the pipeline has one or more memory fragments from Stage 2, the pipeline SHALL invoke `Jev.choice(state, instructions, criteria)` once per fragment. The `state` SHALL be the fragment's `content`. The `instructions` SHALL be `"What type of memory is this?"`. The `criteria` SHALL be the 7-type map (SC-4): `{ preference: "User expresses a preference or liking.", correction: "User corrects a previous statement, approach, or belief.", decision: "User makes a decision or choice that persists.", constraint: "User states a constraint, limitation, or boundary.", pattern: "User describes a recurring behavior or workflow.", context: "Useful working context — intermediate state, hypothesis, what was tried (not a durable fact but would help future queries).", none: "No useful context for future queries." }`. The call SHALL use the `memory.extraction.layer1` config (Jev via OpenRouter decisions API).

**W-11** WHEN `Jev.choice` returns `choice = "none"`, the pipeline SHALL skip that fragment, SHALL NOT store it, and SHALL log the skip at `debug` level with the fragment content hash (not the content — CC-6 / no session content at info level).

**W-12** WHEN `Jev.choice` returns `choice` in `{ "preference", "correction", "decision", "constraint", "pattern", "context" }`, the pipeline SHALL proceed to Stage 4 (store) for that fragment with `memory_type = choice`. The Gemini-returned `type` from Stage 2 (the Gemini extraction's `type` field) SHALL be overridden by the Jev Choice `choice` from Stage 3 — the classify stage is authoritative for `memory_type`.

**W-13** WHEN the classify call fails for a single fragment (network error, 4xx, 5xx, parse error), the pipeline SHALL skip that fragment, SHALL log the skip at `warn` level with the fragment content hash, and SHALL continue processing the remaining fragments. A single fragment's classify failure SHALL NOT abort the batch.

### Stage 4 — Store (embed + SurrealHypergraphBackend.store) — the pipeline owns the store

**W-14** WHEN a fragment passes the classify gate (W-12), the pipeline SHALL embed the fragment's `content` via `Embedding.embed(content, config)` using the configured embedding provider (DeepInfra BAAI/bge-base-en-v1.5, 768 dimensions per `src/memory/surreal-hypergraph-backend.ts:217` HNSW index). The embedding SHALL be a `Float32Array` (never sent to Jev or Gemini — Phase M W-14, retained).

**W-15** WHEN the embedding succeeds, the pipeline SHALL invoke `SurrealHypergraphBackend.store(node)` with a `NodeRecord` where `node_type = "MEMORY"`, `attributes.memory_type = <Jev choice>`, `attributes.content = <fragment content>`, `attributes.source_nodes = []`, `attributes.usage_count = 0`, `attributes.last_used = <epoch seconds>`, `attributes.contradiction_count = 0`, `attributes.downstream_gain = 0`, `attributes.project_id = input.project_id`, `attributes.session_id = input.sessionID`, `attributes.confidence = 0.7` (W-20), `attributes.source_path = "llm"` (W-21), `embedding = <Float32Array>`, `status = "ACTIVE"`, `version = 1`, `valid_from = <epoch seconds>`, `valid_to = Infinity`, `tx_from = <epoch seconds>`, `tx_to = Infinity`, `prev_version_id = null`, `invalidated_by = null`. The `node_id` SHALL be a fresh `ulid()`. The backend SHALL be resolved via `getGlobalHypergraphBackend()` (`src/memory/backend-registry.ts:45`). The `confidence` and `source_path` fields SHALL be placed in `attributes` — they are NOT top-level fields on the real `NodeRecord` interface (the `NodeRecord` interface at `src/memory/surreal-hypergraph-backend.ts:43` does not have `confidence` or `source_path` as top-level fields; they live in `attributes`).

**W-16** WHEN the embedding call fails (DeepInfra unavailable, 429, 503 per `src/memory/embedding.ts:166` retry policy), the pipeline SHALL store the `MEMORY` node with `embedding = null`, SHALL log the embedding failure at `warn` level with the fragment content hash, and SHALL NOT abort the batch. The node is still stored (retrieval falls back to keyword search when the embedding is absent — Phase M behavior).

### Secrets redaction

**W-17** WHEN the pipeline builds the Jev gate state (W-1), the redaction filter (`redact` at `src/memory/extraction/redact.ts:37`) SHALL run on the buffer context + current turn text BEFORE the state is sent to `Jev.noul`. The redacted content SHALL be what's passed to Jev; the original un-redacted content SHALL NOT be sent to Jev. Redactions SHALL be logged at `debug` level (counts per label, never the original secret values).

**W-18** WHEN the pipeline builds the Gemini extraction payload (W-6), the redaction filter SHALL run on the full context BEFORE the payload is sent to `Gemini.extract`. The redacted content SHALL be what's passed to Gemini; the original un-redacted content SHALL NOT be sent to Gemini.

**W-19** No secrets (API keys, JWT tokens, bearer tokens, `auth.json` contents, JSON `password`/`secret`/`token` field values) SHALL appear in any content sent to Jev or Gemini. The Phase M `redact` filter's catch rate (measured by `test/fbh-phase-m/sdd-05.test.ts::secrets_redaction` against the 5-secret fixture) is the floor; Phase N adds no new redaction patterns but applies the existing filter at both LLM call sites. A test SHALL assert zero leakage in both the gate state and the extraction payload.

### Initial confidence

**W-20** WHEN a `MEMORY` node is created by this pipeline, its initial `attributes.confidence` SHALL be 0.7 for all extracted memories (master spec: Gemini extraction is deterministic-quality). The 0.7 value reflects the spike-validated reliability of the gate+extract+classify chain (100% recall, 0 false positives across 150 turns). This is a deliberate departure from the Phase M W-25 rule (LLM-inferred = 0.5); the Phase N pipeline is treated as deterministic given the LLM classifications because the gate (`Jev.noul` > 0.5) and the classify (`Jev.choice` != "none") are calibrated, validated decisions.

**W-21** The `MEMORY` node's `attributes.source_path` SHALL be `"llm"` (the existing `Provenance` enum at `src/memory/capture/confidence.ts:18` — Jev and Gemini are LLMs that produced the content + type). The `confidenceFor("llm")` helper SHALL NOT be used (it returns 0.5, the Phase M LLM-inferred value); the pipeline SHALL set `attributes.confidence = 0.7` directly. The `capture/confidence.ts` module SHALL be extended with a `CLASSIFY_CONFIDENCE = 0.7` constant (named for the Phase N pipeline) to make the policy explicit and distinguish it from `TOOL_CONFIDENCE` (which coincidentally equals 0.7 but means "deterministic regex extraction").

### Async non-blocking (CC-3)

**W-22** WHEN the post-turn hook fires the pipeline, the pipeline SHALL run via `run.fork` (the same `run.fork(capture(...))` pattern at `src/session/prompt.ts:1645` — SDD-05 wires `classify(input)` into the existing `capture` closure). The LLM response SHALL return to the user BEFORE the gate, extract, classify, or store runs. The pipeline SHALL NEVER block the LLM stream.

**W-23** WHEN any stage of the pipeline throws (Jev error, Gemini error, embedding error, SurrealDB write error), the exception SHALL be logged at `warn` level with the stage name, turn ID, and error message (no session content at `info` level per CC-6), and SHALL be swallowed. The session SHALL continue. The existing `capture` closure's `try/catch` at `src/session/prompt.ts:171-236` is the outer guard; the pipeline adds per-stage guards so a single stage failure doesn't abort the batch.

### Config-driven (CC-4)

**W-24** WHEN `memory.extraction.gate_threshold` changes from `0.5` to `0.8`, a turn that the gate scored at `0.6` SHALL skip extraction (was: pass). WHEN `memory.extraction.layer1.model` changes from `typesafe/jev-1.13` to a different Jev model ID, the gate and classify calls SHALL use the new model. WHEN `memory.extraction.layer2.model` changes from `google/gemini-2.5-flash` to a different Gemini model ID, the extraction call SHALL use the new model. WHEN `memory.extraction.external_opt_in` is `false` (default is `true` per SC-2), the pipeline SHALL NOT invoke any external LLM (Jev or Gemini) and SHALL fall back to the regex path (Phase M W-22 — retained). A test SHALL mutate each field and assert the behavior change (per CC-6).

## HOW

### Anchors (verified)

| Anchor | File:Line | Verified | Note |
|---|---|---|---|
| `MemoryExtractor.extract` stub call | `src/session/prompt.ts:227` | ✅ | The Phase M stub call site. Removed by SDD-05; replaced by `classify(input)`. |
| `EntityExtractor.extract` stub call | `src/session/prompt.ts:226` | ✅ | Phase M stub. Removed by SDD-05 (Phase N stores `MEMORY` only — no `ENTITY`). |
| `capture` closure (post-turn hook) | `src/session/prompt.ts:166-237` | ✅ | `Effect.fnUntraced` closure fired via `run.fork` at `:1645`. SDD-05 edits this closure to call `classify(input)` instead of the two stub extractors. |
| `run.fork(capture(...))` | `src/session/prompt.ts:1645` | ✅ | The non-blocking dispatch site. CC-3 anchor. |
| `redact(content, opts)` | `src/memory/extraction/redact.ts:37` | ✅ | Phase M secrets-redaction filter. Reused verbatim — no new patterns. Returns `{ content, redactions }`. |
| `SurrealHypergraphBackend.store(node)` | `src/memory/surreal-hypergraph-backend.ts:245` | ✅ | Phase M hypergraph store. Accepts `NodeRecord` (interface at `:43`), rejects reserved node types at `:247`. `MEMORY` is active (`src/memory/schema/enums.ts:17`). Called by the pipeline only — the pipeline owns the store (SC-1). |
| `NodeRecord` interface | `src/memory/surreal-hypergraph-backend.ts:43` | ✅ | The store input shape. `embedding: Float32Array \| null` at `:50`. `confidence` and `source_path` are NOT top-level fields — they go in `attributes`. |
| `Embedding.embed(text, config)` | `src/memory/embedding.ts:211` | ✅ | Phase M embedding. DeepInfra BAAI/bge-base-en-v1.5, 768 dims. Retries 429/503 at `:166`. |
| `EmbeddingService.Service` | `src/memory/embedding.ts:19` | ✅ | Effect Service wrapper. Pattern to mirror if the classify pipeline is effectified. |
| `getGlobalHypergraphBackend()` | `src/memory/backend-registry.ts:45` | ✅ | Returns the singleton `SurrealHypergraphBackend \| null`. Null / not healthy → pipeline skips store (returns 0). |
| `confidenceFor` / `TOOL_CONFIDENCE = 0.7` | `src/memory/capture/confidence.ts:20,23` | ✅ | Phase M confidence policy. Extended with `CLASSIFY_CONFIDENCE = 0.7` for Phase N (W-21). |
| `Provenance` type (`"tool" \| "llm"`) | `src/memory/capture/confidence.ts:18` | ✅ | Existing enum. Phase N uses `"llm"` (Jev + Gemini are LLMs). No new enum value. |
| `MemoryExtractor.extractRegex` | `src/memory/extraction/memory.ts:41` | ✅ | The regex fallback. Used by W-5 (gate failure) and W-9 (extraction failure). |
| `persistMemories` | `src/memory/extraction/persist.ts:59` | ✅ | Phase M persist helper. The classify pipeline writes directly via `SurrealHypergraphBackend.store` (W-15) — `persistMemories` is reused for the regex fallback path only. |
| `MEMORY` active node type | `src/memory/schema/enums.ts:17` | ✅ | `ACTIVE_NODE_TYPES[0]`. `isActiveNodeType("MEMORY")` returns true. |
| `Jev` namespace | (SDD-01) `src/provider/jev.ts` | ⏳ | Defined by SDD-01 per SC-1. `noul(state, instructions, criteria): Promise<number>`, `choice(state, instructions, criteria): Promise<{ choice, probabilities }>`, `score(state, instructions, criteria): Promise<number>`. |
| `Gemini` namespace | (SDD-02) `src/provider/gemini.ts` | ⏳ | Defined by SDD-02 per SC-1. `extract(systemPrompt, userContent): Promise<{ memories: ExtractedMemory[]; skipped_reason?: string }>`. |
| `ExtractedMemory` interface | (SDD-02) `src/provider/gemini.ts` | ⏳ | Defined by SDD-02 per SC-1. `{ content: string; type: "preference"\|"correction"\|"decision"\|"constraint"\|"pattern"\|"context"\|"none"; source: "user"\|"assistant" }`. |
| `Buffer` namespace | (SDD-03) `src/memory/capture/buffer.ts` | ⏳ | Defined by SDD-03 per SC-1. `add(sessionID, turn)`, `getContext(sessionID): string`, `get(sessionID)`, `clear(sessionID)`, `size()`. Session-scoped (Map<sessionID, Turn[]>). |
| Circuit breaker config | `memory.extraction.circuit_breaker` (SC-2) | ⏳ | `max_latency_ms: 3000`, `max_consecutive_failures: 5`, `max_error_rate_pct: 5`, `fallback: "regex"`. Read via `resolveExtractionConfig()` (`src/memory/extraction/mode.ts:44`) — extended by SDD-01/02/03 to surface `layer1`/`layer2`/`gate_threshold`/`circuit_breaker`/`external_opt_in`. |

### Reuse map

| Existing | Reuse | New |
|---|---|---|
| `redact` (`src/memory/extraction/redact.ts:37`) | Called at W-1 (gate state) and W-6 (extraction payload). Verbatim — no new patterns. | None. |
| `SurrealHypergraphBackend.store` (`src/memory/surreal-hypergraph-backend.ts:245`) | Called at W-15. `NodeRecord` shape unchanged from Phase M (with `confidence`/`source_path` in `attributes`). The pipeline owns the store (SC-1). | None. |
| `Embedding.embed` (`src/memory/embedding.ts:211`) | Called at W-14. DeepInfra BAAI/bge-base-en-v1.5, 768 dims, retry policy at `:166`. | None. |
| `getGlobalHypergraphBackend` (`src/memory/backend-registry.ts:45`) | Called at W-15 to resolve the backend. Null/ unhealthy → pipeline returns 0. | None. |
| `MemoryExtractor.extractRegex` (`src/memory/extraction/memory.ts:41`) | Called at W-5 (gate failure) and W-9 (extraction failure) as the regex fallback. | None. |
| `confidenceFor` / `Provenance` (`src/memory/capture/confidence.ts:18,23`) | Reused. `attributes.source_path = "llm"` per W-21. | `CLASSIFY_CONFIDENCE = 0.7` constant added to `confidence.ts` (named for the Phase N pipeline). |
| `resolveExtractionConfig` (`src/memory/extraction/mode.ts:44`) | Extended by SDD-01/02/03 to surface `layer1`/`layer2`/`gate_threshold`/`circuit_breaker`/`external_opt_in`. Read by `classify` on each invocation (no caching — config changes apply on the next turn). | None. |
| `Jev` (SDD-01, `src/provider/jev.ts`) | Imported by `classify/gate.ts` and `classify/classify.ts`. | None. |
| `Gemini` (SDD-02, `src/provider/gemini.ts`) | Imported by `classify/extract.ts`. | None. |
| `Buffer` (SDD-03, `src/memory/capture/buffer.ts`) | Imported by `classify/pipeline.ts`. Session-scoped; pipeline calls `Buffer.getContext(input.sessionID)` and `Buffer.add(input.sessionID, turn)`. | None. |
| `ulid` (existing dep) | Used for `node_id` generation at W-15. | None. |

### New modules

```
src/memory/classify/
  pipeline.ts   — classify(input: ClassifyInput): Promise<ClassifyResult> — the 4-stage orchestrator (single entry point, SC-1). Imports Jev, Gemini, Buffer, Embedding, SurrealHypergraphBackend, redact. Invoked by the post-turn hook (SDD-05) and by re-backfill (SDD-06). The pipeline owns the store step.
  gate.ts        — gate(state, cfg): Promise<{ pass: boolean; score: number }> — wraps Jev.noul, applies gate_threshold, returns pass/skip decision. Logs the gate decision at debug.
  extract.ts     — extract(context, cfg): Promise<{ memories: ExtractedMemory[]; skipped_reason?: string }> — wraps Gemini.extract, redacts input, returns fragments. Logs skipped_reason at debug.
  classify.ts    — classify(frag, cfg): Promise<{ type: MemoryType; skip: boolean }> — wraps Jev.choice per fragment, returns the authoritative memory_type. Returns skip=true for "none".
  store.ts       — store(frag, type, input): Promise<string | null> — embeds content, builds NodeRecord (confidence + source_path in attributes), calls SurrealHypergraphBackend.store. Returns node_id or null on failure.
  result.ts      — ClassifyInput, ClassifyResult types (SC-1): ClassifyInput { sessionID, text, project_id, persona }; ClassifyResult { stored: number; skipped: number; errors: number }.
src/memory/capture/confidence.ts — extended with CLASSIFY_CONFIDENCE = 0.7 (W-21).
test/fbh-phase-n/
  sdd-04-gate.test.ts        — W-1 through W-5
  sdd-04-extract.test.ts     — W-6 through W-9
  sdd-04-classify.test.ts    — W-10 through W-13
  sdd-04-store.test.ts       — W-14 through W-16
  sdd-04-redact.test.ts      — W-17, W-18, W-19
  sdd-04-confidence.test.ts  — W-20, W-21
  sdd-04-async.test.ts       — W-22, W-23
  sdd-04-config.test.ts      — W-24
  sdd-04-pipeline.test.ts    — full round-trip (VERIFY: full pipeline produces MEMORY nodes)
test/fixture/fbh-phase-n/
  real-turns.json            — real user turns from the 150-turn spike (ground-truth gate decisions)
  secrets-fixture.json       — 5 representative secrets (reuse Phase M fixture at test/fixture/governance/secrets-fixture.json)
```

### Wiring

1. **Pipeline entry** (`src/memory/classify/pipeline.ts`): `classify(input: ClassifyInput): Promise<ClassifyResult>` is the single entry point (SC-1). It calls `Buffer.getContext(input.sessionID)` to build the gate state, then runs `gate` → `extract` → `classify` → `store` in sequence, then calls `Buffer.add(input.sessionID, { text: input.text, role: "user" })` to record the current turn (step 6 per SC-1). It catches per-stage exceptions and returns `ClassifyResult`. The function is `async` (not Effect — it orchestrates plain Promises from the provider adapters, which are Promise-based per SC-1). The post-turn hook wraps it in `Effect.promise(() => classify(input))` (SDD-05). Re-backfill (SDD-06) calls `classify(input)` directly (no `run.fork` — batch context).

2. **Provider resolution** (`src/memory/classify/pipeline.ts`): `Jev` and `Gemini` are resolved via the `Provider.Service` path (the same path Phase M uses for the extraction LLM). No new HTTP client, no new auth path (Phase M W-15 — retained). The model IDs are parsed from `memory.extraction.layer1.model` and `memory.extraction.layer2.model` via `Provider.parseModel`.

3. **Buffer resolution** (`src/memory/classify/pipeline.ts`): the `Buffer` namespace is session-scoped (one entry per session, SDD-03). The pipeline resolves the buffer for `input.sessionID`, calls `Buffer.getContext(input.sessionID)` to build the gate state, and calls `Buffer.add(input.sessionID, { text: input.text, role: "user" })` to record the current turn. The buffer is cleared on session end (SDD-03). The pipeline does NOT call `buffer.getContext()` or `buffer.add(turn)` — it uses the namespace form `Buffer.getContext(input.sessionID)` / `Buffer.add(input.sessionID, turn)` per SC-1.

4. **Redaction** (`src/memory/classify/gate.ts`, `src/memory/classify/extract.ts`): `redact(content, { authKeys })` is called at both LLM call sites. The `authKeys` are loaded from `~/.config/foxybear/auth.json` (Phase M W-21 — retained). The redacted content is what's passed to Jev/Gemini; the original is never sent.

5. **Store path** (`src/memory/classify/store.ts`): `SurrealHypergraphBackend.store(node)` is called directly (not via `persistMemories` — the Phase M helper writes batches; Phase N writes one node per classified fragment with the embedding attached). The pipeline owns the store step (SC-1) — neither the capture hook (SDD-05) nor re-backfill (SDD-06) call `SurrealHypergraphBackend.store` for extracted memories; both call `classify(input)`, and the pipeline handles the store. The `node_id` is a fresh `ulid()`. The backend is resolved via `getGlobalHypergraphBackend()`; if null or unhealthy, the pipeline skips the store and logs at `warn`.

6. **Circuit breaker** (`src/memory/classify/pipeline.ts`): a module-level counter tracks consecutive Jev/Gemini failures. When the counter exceeds `circuit_breaker.max_consecutive_failures` (default 5), the pipeline falls back to `MemoryExtractor.extractRegex` for the next N turns (N = `circuit_breaker.max_consecutive_failures` * 2 — backoff). The breaker resets on the first successful Jev call. The fallback is logged at `warn` per CC-9.

7. **Config resolution** (`src/memory/extraction/mode.ts:44`): `resolveExtractionConfig()` is extended (by SDD-01/02/03) to surface `layer1`, `layer2`, `gate_threshold`, `circuit_breaker`, `external_opt_in`. The classify pipeline reads config on each invocation (no caching — config changes apply on the next turn per Phase M W-20).

### Naming

Per the project AGENTS.md style guide and CC-9:

- Single-word function names: `classify` (the entry point in `pipeline.ts`, `classify(input: ClassifyInput): Promise<ClassifyResult>` per SC-1), `gate`, `extract`, `classify` (per-fragment in `classify.ts` — disambiguated by file), `store`.
- Single-word locals: `input`, `state`, `frag`, `type`, `node`, `cfg`, `out`, `err`, `score`, `turn` (for buffer turn objects `{ text, role }`).
- Multi-word allowed for types (`ClassifyInput`, `ClassifyResult`, `MemoryType`) and the pipeline directory (`classify/`) where a single word would be ambiguous.
- `Bun.file()` for fixtures (e.g., `Bun.file("test/fixture/fbh-phase-n/real-turns.json").json()`), not `fs.readFileSync`.
- `const` over `let`; early returns over `else`; type inference over explicit annotations; no `any`.
- Tests do NOT mock `Jev`, `Gemini`, `Buffer`, `Embedding`, `SurrealHypergraphBackend`, or `redact`. Real OpenRouter (Jev + Gemini), real DeepInfra (embedding), real SurrealDB (store), real `Bun.file` fixtures.

## VERIFY

Each test maps 1:1 to a WHAT statement. All tests run from `packages/fbh` (per the `do-not-run-tests-from-root` guard, per workstream `cwd`). No mocks of the implementation under test (per CC-5). Real provider calls (OpenRouter Jev + Gemini, DeepInfra embedding, SurrealDB store).

| Test | WHAT | Assertion |
|---|---|---|
| `sdd-04-gate.test.ts::fires_on_real_memories` | W-1, W-3 | A real user turn from `test/fixture/fbh-phase-n/real-turns.json` (a turn the spike classified as memory-worthy — e.g., "Kotlin Multiplatform for the data layer. Native code for the app harness") produces a gate state containing the buffer context + current turn. `Jev.noul` returns `enriches_future > 0.5` and the pipeline proceeds to Stage 2. The gate decision (`pass`, score) is logged at `debug`. |
| `sdd-04-gate.test.ts::skips_routine_turn` | W-4 | A routine user turn (e.g., "ok, continue" or "what's next?") with no memory-worthy signal produces a gate state where `Jev.noul` returns `enriches_future <= 0.5`. The pipeline skips Stage 2 and Stage 3, stores no `MEMORY` node, and returns `ClassifyResult { stored: 0, skipped: 1, errors: 0 }`. The skip is logged at `debug`. |
| `sdd-04-gate.test.ts::fallback_on_jev_failure` | W-5 | With `memory.extraction.layer1.model` set to an invalid model ID (forces Jev 4xx), the gate fails. The pipeline falls back to `MemoryExtractor.extractRegex` for this turn, logs the fallback at `warn`, and returns `ClassifyResult { stored: <n>, skipped: 0, errors: 0 }` where `<n>` is the count of regex-extracted nodes. The pipeline does NOT abort — a subsequent turn with a valid model ID proceeds through the gate normally. |
| `sdd-04-gate.test.ts::circuit_breaker` | W-5, CC-9 | After 5 consecutive Jev failures (simulated via an invalid model ID for `layer1.model`), the circuit breaker opens. The pipeline falls back to regex for the next 10 turns (5 * 2 backoff) without invoking Jev. On the 11th turn (with a valid model ID restored), the breaker resets and the gate runs. The fallback count is logged. |
| `sdd-04-extract.test.ts::produces_valid_json` | W-6, W-7 | A gate-passing turn (W-3) invokes `Gemini.extract` with a redacted full-context payload. Gemini returns `{ memories: [{ content, type, source }, ...] }` with valid JSON. The pipeline proceeds to Stage 3 for each fragment. The extraction call uses `memory.extraction.layer2.model` (Gemini 2.5 Flash) via OpenRouter chat API (JSON mode, temperature 0). |
| `sdd-04-extract.test.ts::skips_empty` | W-8 | A gate-passing turn where Gemini returns `{ memories: [] }` or `{ skipped_reason: "no memory-worthy content" }` produces no fragments. The pipeline skips Stage 3 and Stage 4, logs the `skipped_reason` at `debug`, and returns `ClassifyResult { stored: 0, skipped: 1, errors: 0 }`. |
| `sdd-04-extract.test.ts::fallback_on_gemini_failure` | W-9 | With `memory.extraction.layer2.model` set to an invalid model ID (forces Gemini 4xx), the extraction fails. The pipeline falls back to `MemoryExtractor.extractRegex`, logs the fallback at `warn`, and continues. The fallback path stores regex-extracted `MEMORY` nodes (Phase M behavior) — the gate's pass decision is honored even when extraction fails. |
| `sdd-04-classify.test.ts::assigns_types` | W-10, W-12 | For each fragment from Stage 2, `Jev.choice` returns a `choice` in `{ "preference", "correction", "decision", "constraint", "pattern", "context" }`. The pipeline proceeds to Stage 4 with `memory_type = choice`. The Gemini-returned `type` (Stage 2) is overridden by the Jev `choice` (Stage 3) — e.g., Gemini says `type = "context"`, Jev says `choice = "decision"`, the stored `attributes.memory_type = "decision"`. |
| `sdd-04-classify.test.ts::skips_none` | W-11 | A fragment where `Jev.choice` returns `choice = "none"` is skipped. No `MEMORY` node is stored for that fragment. The skip is logged at `debug` with the fragment content hash (SHA-256, first 8 chars — never the content). Other fragments in the same batch continue to Stage 4. |
| `sdd-04-classify.test.ts::per_fragment_failure` | W-13 | A batch of 3 fragments where the second fragment's `Jev.choice` call fails (simulated via a transient network error — invalid `layer1.model` for one call, valid for the others) produces: fragment 1 stored, fragment 2 skipped (logged at `warn`), fragment 3 stored. The batch does NOT abort on the single failure. `ClassifyResult { stored: 2, skipped: 0, errors: 1 }`. |
| `sdd-04-store.test.ts::embeds_and_stores` | W-14, W-15 | A classified fragment (W-12) is embedded via `Embedding.embed` (DeepInfra BAAI/bge-base-en-v1.5, 768 dims). The resulting `Float32Array` is passed to `SurrealHypergraphBackend.store` as the `embedding` field of a `MEMORY` `NodeRecord`. `attributes.confidence = 0.7` (W-20), `attributes.source_path = "llm"` (W-21), `attributes.memory_type = <Jev choice>`. The node is queryable via HNSW KNN (Phase M retrieval path) — verified by a follow-up `SurrealHypergraphBackend.query([node_id], project_id)` returning the node. `status = "ACTIVE"`, `version = 1`. |
| `sdd-04-store.test.ts::null_embedding_on_failure` | W-16 | With the embedding provider unavailable (simulated via an invalid `DEEPINFRA_API_KEY` env var or a network block), `Embedding.embed` throws `EmbeddingUnavailableError`. The pipeline stores the `MEMORY` node with `embedding = null`, logs the embedding failure at `warn`, and continues. The node is stored (retrieval falls back to keyword search — Phase M behavior). |
| `sdd-04-store.test.ts::backend_unhealthy` | W-15 | With `getGlobalHypergraphBackend()` returning `null` (backend not initialized) or `backend.healthy()` returning `false`, the pipeline skips the store, logs at `warn`, and returns `ClassifyResult { stored: 0, skipped: 0, errors: 1 }`. No exception escapes the pipeline. |
| `sdd-04-redact.test.ts::gate_state_redacted` | W-17, W-19 | A user turn containing an AWS key (`AKIA...`), an OpenAI key (`sk-...`), and a JWT (`eyJ...`) is built into a gate state. The redaction filter runs BEFORE the state is sent to `Jev.noul`. The redacted state (captured via a test-side provider wrapper that records the request body) contains `[REDACTED:AWS_KEY]`, `[REDACTED:OPENAI_KEY]`, `[REDACTED:JWT]` and zero of the original secret substrings. |
| `sdd-04-redact.test.ts::extract_payload_redacted` | W-18, W-19 | A full-context extraction payload containing a GitHub token (`ghp_...`), a Slack token (`xoxb-...`), and a `password` JSON field is redacted BEFORE the payload is sent to `Gemini.extract`. The redacted payload (captured via test-side wrapper) contains `[REDACTED:GITHUB_TOKEN]`, `[REDACTED:SLACK_TOKEN]`, `[REDACTED:JSON_SECRET_FIELD]` and zero of the original secrets. |
| `sdd-04-redact.test.ts::no_leak_either_llm` | W-19 | The 5-secret fixture (reuse `test/fixture/governance/secrets-fixture.json` from Phase M) is loaded. The pipeline runs on a turn containing all 5 secrets. Both the gate state (sent to Jev) and the extraction payload (sent to Gemini) contain zero of the 5 secrets (substring match). On any leak, the test fails. |
| `sdd-04-confidence.test.ts::initial_confidence_0_7` | W-20 | A `MEMORY` node stored by the pipeline has `attributes.confidence = 0.7`. Verified by reading the stored node from SurrealDB via `SurrealHypergraphBackend.query` (or a direct `SELECT` on the `node` table) and asserting `attributes.confidence = 0.7`. A node from the regex fallback path (`MemoryExtractor.extractRegex` → `persistMemories`) has `attributes.confidence = 0.7` (Phase M W-25, unchanged). The two paths produce the same confidence value but different `source_path` values (`"llm"` for the pipeline, `"tool"` for the regex fallback). |
| `sdd-04-confidence.test.ts::source_path_llm` | W-21 | A `MEMORY` node stored by the pipeline has `attributes.source_path = "llm"`. A `MEMORY` node from the regex fallback has `source_path = "tool"`. The `CLASSIFY_CONFIDENCE = 0.7` constant exists in `src/memory/capture/confidence.ts` (asserted via `Bun.file` read or import). |
| `sdd-04-async.test.ts::non_blocking` | W-22 | A real LLM session (small model, 1 turn) triggers `classify(input)` via `run.fork` at `src/session/prompt.ts:1645` (SDD-05 wires this). The LLM response returns to the user within `50ms` of `handle.process` completing, even when `classify` takes `3s` (simulated via a slow fixture — a turn that requires Gemini extraction + Jev classify + DeepInfra embed + SurrealDB store). Verified by timing the user-visible response, not the classify pipeline. |
| `sdd-04-async.test.ts::exceptions_swallowed` | W-23 | A pipeline run where every stage throws (simulated via invalid `layer1.model` + invalid `layer2.model` + invalid embedding config + SurrealDB down) does NOT propagate any exception to the session. Each stage's failure is logged at `warn` with the stage name and turn ID (no session content at `info` level per CC-6 — asserted by capturing the log output and checking that the turn text does not appear in `info` lines). The session continues to the next turn. Returns `ClassifyResult { stored: 0, skipped: 0, errors: <n> }`. |
| `sdd-04-config.test.ts::gate_threshold` | W-24 | With `gate_threshold = 0.5` (default), a turn scored at `0.6` passes the gate and proceeds to extraction. With `gate_threshold = 0.8` (mutated at runtime), the same turn (same gate state, same Jev response) skips extraction. Verified by a test that mutates the config and asserts the gate decision changes. |
| `sdd-04-config.test.ts::layer1_model` | W-24 | With `layer1.model = "typesafe/jev-1.13"` (default), the gate and classify calls use Jev. With `layer1.model` mutated to a different Jev model ID, the gate and classify calls use the new model (verified via the test-side provider wrapper recording the model ID in the request body). |
| `sdd-04-config.test.ts::layer2_model` | W-24 | With `layer2.model = "google/gemini-2.5-flash"` (default), the extraction call uses Gemini Flash. With `layer2.model` mutated to a different Gemini model ID, the extraction uses the new model. |
| `sdd-04-config.test.ts::external_opt_in_false` | W-24 | With `external_opt_in = false` (default is `true` per SC-2), the pipeline does NOT invoke any external LLM (Jev or Gemini). The gate is skipped (or always passes — implementation choice, but no Jev call is made), extraction falls back to regex, classify is skipped (regex path doesn't classify — Phase M behavior). No external HTTP calls to OpenRouter. Verified via a provider call counter. |
| `sdd-04-pipeline.test.ts::full_round_trip` | VERIFY | A real user turn from the spike fixture (e.g., the Phoenix outreach pipeline turn — "the reply process is: target replies → Instantly detects and pauses lead → reply classified → Mirena reviews") is processed through the full 4-stage pipeline. Stage 1 (gate) passes (`enriches_future > 0.5`). Stage 2 (extract) produces ≥ 1 `ExtractedMemory` with `content` matching the reply process. Stage 3 (classify) assigns `type = "pattern"` or `type = "context"` (Jev's choice). Stage 4 (store) writes a `MEMORY` node to SurrealDB with the embedding and `attributes.confidence = 0.7`, `attributes.source_path = "llm"`. The node is retrievable via `SurrealHypergraphBackend.query` HNSW KNN with a relevant query (e.g., "what's the reply handling process?") returning the stored node in the top results. `ClassifyResult { stored: >= 1, skipped: 0, errors: 0 }`. This is the across-session recall proof (spike Stage 4, Case 3) re-validated through the production pipeline. |

### Typecheck and green suite (per CC-7)

After implementation, `bun run typecheck` SHALL be green and `bun test --timeout 30000` SHALL be green from `packages/fbh` (workstream `cwd`). Known-baseline failures are tolerated via the workstream's `baselineFile` at `development/foxybear/docs/specs/.sdd-state-phase-n/baseline-failures.txt`.

## Seams

1. **SDD-01/02/03 file paths are planned, not verified.** The anchors table cites `src/provider/jev.ts`, `src/provider/gemini.ts`, and `src/memory/capture/buffer.ts` as the locations of `Jev`, `Gemini`, and `Buffer` per SC-1. SDD-01, SDD-02, and SDD-03 are parallel specs (no deps between them) but the file paths are fixed by SC-1 (the master's shared contract is authoritative). If the actual paths differ at implementation time, this spec's `import` statements (in `classify/gate.ts`, `classify/extract.ts`, `classify/pipeline.ts`) SHALL be updated to the actual paths. The interfaces (SC-1) are the contract; SC-1 fixes both the interfaces and the file paths.

2. **Confidence policy drift from Phase M.** Phase M W-25 sets `confidence = 0.5` for LLM-inferred `MEMORY` nodes. Phase N W-20 sets `attributes.confidence = 0.7` for all extracted memories (Gemini extraction is deterministic-quality). The two policies coexist: the regex fallback path (W-5, W-9) uses `confidenceFor("tool") = 0.7` with `source_path = "tool"` (Phase M, unchanged); the pipeline path uses `CLASSIFY_CONFIDENCE = 0.7` with `attributes.source_path = "llm"` (Phase N, new). Both produce 0.7 but for different reasons — the constant names make the distinction explicit. A future spec that consolidates the confidence policy SHOULD reconcile the two paths.

3. **Circuit breaker scope.** CC-9 specifies `max_consecutive_failures = 5` and `fallback = "regex"`. This spec implements the breaker as a module-level counter in `classify/pipeline.ts` with a 2x backoff (10 turns of regex fallback after 5 consecutive failures). The backoff multiplier is a Phase N addition — CC-9 does not specify it. If the breaker proves too aggressive (e.g., a transient OpenRouter outage causes 10 turns of regex fallback when 5 would suffice), the multiplier SHOULD be tuned down. The breaker resets on the first successful Jev call (not Gemini — a Gemini failure does not reset the Jev breaker, and vice versa; the breakers are independent per provider).

4. **`EntityExtractor` removal.** Phase N stores `MEMORY` nodes only. The stub `EntityExtractor.extract` call at `src/session/prompt.ts:226` is removed by SDD-05. The 138k noise `ENTITY` nodes ("The", file paths) are deleted by SDD-06. This spec does not touch `EntityExtractor` — SDD-05 removes the call, SDD-06 deletes the historical nodes. The `EntityExtractor` namespace in `src/memory/extraction/entity.ts` MAY be deleted in a follow-on cleanup spec; it is not in scope here.

5. **`persistMemories` reuse.** The Phase M `persistMemories` helper (`src/memory/extraction/persist.ts:59`) is reused for the regex fallback path (W-5, W-9). The pipeline's primary store path (W-15) calls `SurrealHypergraphBackend.store` directly (one node per fragment, with the embedding attached; `confidence` and `source_path` in `attributes`). The two paths produce the same `MEMORY` node shape but different provenance — `persistMemories` writes via the Phase M helper (`confidenceFor`), the pipeline writes directly (`CLASSIFY_CONFIDENCE`). A future spec SHOULD consolidate the two store paths.

6. **Store ownership (SC-1).** The pipeline owns the store step. Neither SDD-05 (capture hook) nor SDD-06 (re-backfill) call `SurrealHypergraphBackend.store` for extracted memories — both call `classify(input)`, and the pipeline handles gate → extract → classify → store → buffer update. This consolidates the write path in one place and prevents the capture hook from diverging from re-backfill on provenance (`attributes.confidence`, `attributes.source_path`).
