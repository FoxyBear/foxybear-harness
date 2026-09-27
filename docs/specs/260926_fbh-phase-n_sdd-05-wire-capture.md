# SDD-05: Phase N — Wire Into Capture

**Date:** 2026-09-26
**Project:** FoxyBear Harness Phase N (`development/foxybear`)
**Status:** Draft (pending independent audit + human gate)
**Master:** `260926_fbh-phase-n_sdd-00-master.md` — inherits SC-1, SC-2, SC-3, SC-4, SC-5, CC-1 through CC-10
**Workstream:** `fbh-phase-n` (`tools/sdd/workstreams/fbh-phase-n.json`)
**Depends on:** SDD-04 (gate-extract-classify pipeline — must expose `classify(input: ClassifyInput): Promise<ClassifyResult>` at `src/memory/classify/pipeline.ts` per SC-1; transitive: SDD-01 Jev provider, SDD-02 Gemini provider, SDD-03 circular buffer)
**Blocks:** SDD-06 (re-backfill — needs the capture hook calling the real pipeline so live turns classify the same way backfilled turns do)

SDD-05 replaces the stub extractor calls in the post-turn capture hook with the real 4-stage pipeline from SDD-04. The hook today calls `EntityExtractor.extract` and `MemoryExtractor.extract` (Phase M stubs that return regex results labeled `source_path: "llm"`, producing 138k noise ENTITY nodes and 4 MEMORY nodes). After SDD-05, the hook calls `classify` instead. The pipeline owns gate → extract → classify → store, and the buffer update (per SC-1 — the pipeline owns the store and the buffer). The hook owns only the deterministic TraceIngestor path.

**Stub replacement, not addition (CC-2).** The stub `extractViaLLM` calls in entity.ts and memory.ts are no longer reachable from the capture hook after this spec. The stub modules themselves are deleted in SDD-06 (the backfill rewires its own path); SDD-05 only removes the call sites in prompt.ts.

**Deterministic path preserved (CC-1).** `TraceIngestor.ingest` (ACTION/ERROR/MESSAGE + COLLABORATION/ERROR_CORRECTION/EVIDENCE hyperedges) is unchanged. The 65k ACTION, 2k ERROR, 18k MESSAGE nodes already in the hypergraph keep their producer. SDD-05 does not touch `src/memory/capture/trace.ts`.

**Async, non-blocking (CC-3).** The hook keeps the existing `run.fork(capture(...))` at `prompt.ts:1645`. The LLM stream returns to the user before capture completes. Exceptions are logged at `warn` and swallowed.

**Pipeline owns the store and the buffer (SC-1).** The capture hook calls `classify(input)` only — NOT Jev, Gemini, Buffer, or SurrealHypergraphBackend directly. The pipeline internally gets buffer context via `Buffer.getContext`, gates via `Jev.noul`, extracts via `Gemini.extract`, classifies via `Jev.choice`, stores via `SurrealHypergraphBackend.store`, and updates the buffer via `Buffer.add`. sdd-05 does NOT import or call the buffer.

## Scope

In scope (SDD-05 only):

- Edit `src/session/prompt.ts` capture body (`:166-237`): remove `EntityExtractor.extract`, `MemoryExtractor.extract`, `persistEntities`, `persistMemories`, the `score` import, and the `resolveExtractionConfig` import. Add `classify({ sessionID, text, project_id, persona })` (current user turn text + project_id + persona — NO buffer calls, NO `context`, NO `messageID`; the pipeline owns the buffer per SC-1).
- The circular buffer is created by SDD-03 and owned by the pipeline (SDD-04) per SC-1. SDD-05 does NOT touch the buffer — no `Buffer.add`, no `Buffer.getContext`, no buffer import.
- The pipeline is created by SDD-04. SDD-05 calls `classify({ sessionID, text, project_id, persona })` (per SC-1 `ClassifyInput`) and discards the return (fire-and-forget — the pipeline owns Stage 4 store + the buffer update).
- The `isMemoryEnabled` gate at `prompt.ts:172` is unchanged.
- The `run.fork(capture(...))` call site at `prompt.ts:1645` is unchanged.
- The `Consolidation.extractTurn` call at `prompt.ts:182-188` is unchanged (the regex path still runs alongside TraceIngestor — it is the deterministic fallback the pipeline's circuit breaker falls back to, per CC-9).

Out of scope:

- The pipeline itself (SDD-04).
- The Jev provider adapter (SDD-01), Gemini provider adapter (SDD-02), circular buffer implementation (SDD-03).
- Any buffer calls from the capture hook (`Buffer.add`, `Buffer.getContext`) — owned by the pipeline (SDD-04) per SC-1.
- Re-backfill against historical sessions (SDD-06).
- Deleting the stub `extractViaLLM` functions in entity.ts/memory.ts (SDD-06 — the backfill rewires its own path first, then the stubs become dead code and are removed).
- Any change to `TraceIngestor`, `score`, `Consolidation.extractTurn`, or the persist helpers (SDD-06 owns persist.ts removal).

## WHAT

**W-1** WHEN the post-turn hook fires `capture({ sessionID, messages, persona })` via `run.fork` at `prompt.ts:1645` AND `isMemoryEnabled()` returns `false`, `capture` SHALL return immediately. The hook SHALL NOT call `TraceIngestor.ingest`, `Consolidation.extractTurn`, or `classify`. The `run.fork` still happens; the body is a no-op.

**W-2** WHEN `isMemoryEnabled()` returns `true`, `capture` SHALL call `TraceIngestor.ingest(turn)` exactly once per turn with the `SessionTurn` shape (`sessionID`, `messageID`, `withParts`, `persona`, `project_id`). The call is unchanged from Phase M (SDD-05 M-2). ACTION/ERROR/MESSAGE nodes and COLLABORATION/ERROR_CORRECTION/EVIDENCE hyperedges are emitted deterministically. No stub extractor is invoked by `TraceIngestor`.

**W-3** WHEN `isMemoryEnabled()` returns `true`, `capture` SHALL NOT call `EntityExtractor.extract` or `MemoryExtractor.extract` (the Phase M stubs). `capture` SHALL NOT call `persistEntities` or `persistMemories`. The imports of `EntityExtractor`, `MemoryExtractor`, and the persist helpers SHALL be removed from `prompt.ts`. After SDD-05, the stub extraction path is unreachable from the live capture hook.

**W-4** WHEN `isMemoryEnabled()` returns `true` AND after `TraceIngestor.ingest` (W-2), `capture` SHALL call `classify({ sessionID, text, project_id, persona })` exactly once per turn. `sessionID` SHALL be `input.sessionID`. `text` SHALL be the current turn's text content (the concatenated `TextPart.text` of the last user message — text-only, no embeddings). `project_id` SHALL be `Instance.project.id`. `persona` SHALL be `input.persona`. The call matches `ClassifyInput` per SC-1 — NO `context` field (the pipeline gets buffer context itself via `Buffer.getContext`), NO `messageID` field, NO `current` field. The `classify` function is imported from `src/memory/classify/pipeline.ts` (per SC-1).

**W-5** WHEN `classify` returns, `capture` SHALL discard the return value (`ClassifyResult` — `{ stored, skipped, errors }`). The pipeline owns Stage 4 (store: embed → SurrealDB → ContextPacker retrieves) AND the buffer update (per SC-1 — the pipeline calls `Buffer.add(input.sessionID, { text: input.text, role: "user" })` and `Buffer.getContext(input.sessionID)` internally). The hook does not persist fragments, does not call `persistEntities`/`persistMemories`, does not update the buffer, and does not re-store anything the pipeline already stored. The hook's only post-`classify` action is the `catch` log.

**W-6** The `capture` body SHALL run via `run.fork` at `prompt.ts:1645` (unchanged). The LLM response SHALL return to the user before capture completes. The pipeline's Jev gate + Gemini extract + Jev classify + store stages run in the forked fiber. The hook SHALL NOT `await` `classify` before returning to the prompt loop.

**W-7** WHEN any step in `capture` throws (`TraceIngestor.ingest` throws, `classify` throws, dynamic import fails), `capture` SHALL log the error at `warn` level with `{ sessionID, error: String(err) }` and swallow the exception. The session SHALL continue. No exception escapes `capture` into the prompt loop.

**W-8** WHEN the circuit breaker (per SDD-04 / CC-9) has tripped (Jev or Gemini latency > 3s for 5 consecutive calls, or error rate > 5%), `classify` SHALL internally fall back to regex-only extraction. `capture` SHALL NOT gate on circuit breaker state. The hook calls `classify` exactly once per turn regardless of breaker state; the pipeline owns the fallback decision.

**W-9** `capture` SHALL NOT send embeddings (`Float32Array`), `auth.json` contents, API keys, or vector data to `classify`. The hook passes text content only (`text` is the concatenated `TextPart.text`). Secrets redaction (per SDD-04 / CC-6) runs inside the pipeline, BEFORE any content is sent to Jev or Gemini. The hook does not redact.

**W-10** `capture` SHALL read the extraction config via the SDD-04 pipeline's own config path on each `classify` invocation. The hook SHALL NOT cache config. The hook SHALL NOT call `resolveExtractionConfig` itself — that was the Phase M path. Config changes (model swap, threshold change, `external_opt_in` toggle, circuit breaker reset) apply on the next turn.

**W-11** WHEN `memory.extraction.external_opt_in` is `false` (opt-out; the default is `true` per SC-2), `classify` SHALL NOT make any external LLM call (no Jev, no Gemini). The pipeline runs regex-only. `capture` SHALL NOT gate on `external_opt_in` directly — the pipeline does. The hook calls `classify` exactly once per turn regardless of opt-in state.

**W-12** WHEN the post-turn hook fires (the `finished && !handle.message.error` branch at `prompt.ts:1643-1644`), `run.fork(capture({ sessionID, messages: msgs, persona: personaName }))` SHALL be the only capture invocation. The call site at `prompt.ts:1645` is unchanged. The hook fires once per turn (after the step loop exits on `finished`), not once per step.

## HOW

### Anchors (verified)

| Anchor | File:Line | Verified | Note |
|---|---|---|---|
| `capture` body | `src/session/prompt.ts:166` | ✅ | `const capture = Effect.fnUntraced(function* (input) { ... })`. The body SDD-05 edits. |
| `isMemoryEnabled` gate | `src/session/prompt.ts:172` | ✅ | `const enabled = yield* Effect.promise(() => isMemoryEnabled()); if (!enabled) return`. Stays unchanged (W-1). |
| `Consolidation.extractTurn` call | `src/session/prompt.ts:182-188` | ✅ | Regex path. Stays unchanged (W-2 — deterministic fallback). |
| `TraceIngestor` import | `src/session/prompt.ts:193` | ✅ | Dynamic import. Stays (W-2). |
| `resolveExtractionConfig` import | `src/session/prompt.ts:194-196` | ✅ | REMOVED by SDD-05 (W-10 — pipeline owns config). |
| `EntityExtractor` import | `src/session/prompt.ts:197` | ✅ | REMOVED by SDD-05 (W-3). |
| `MemoryExtractor` import | `src/session/prompt.ts:198` | ✅ | REMOVED by SDD-05 (W-3). |
| `score` import | `src/session/prompt.ts:199` | ✅ | REMOVED by SDD-05 (the pipeline owns the gate threshold; the hook no longer needs the score). |
| `TraceIngestor.ingest(turn)` call | `src/session/prompt.ts:208` | ✅ | Stays unchanged (W-2). |
| `score(turn)` call | `src/session/prompt.ts:209` | ✅ | REMOVED by SDD-05 (pipeline owns threshold). |
| `opts` object | `src/session/prompt.ts:210-219` | ✅ | REMOVED by SDD-05 (was only consumed by the stub extractors). |
| `text` computation | `src/session/prompt.ts:220-224` | ✅ | Stays — the concatenated `TextPart.text` is passed to `classify` as `text` (W-4, W-9). |
| `EntityExtractor.extract` call | `src/session/prompt.ts:226` | ✅ | REMOVED by SDD-05 (W-3). |
| `MemoryExtractor.extract` call | `src/session/prompt.ts:227` | ✅ | REMOVED by SDD-05 (W-3). |
| `persistEntities`/`persistMemories` import | `src/session/prompt.ts:228-230` | ✅ | REMOVED by SDD-05 (W-5 — pipeline owns store). |
| `persistEntities`/`persistMemories` calls | `src/session/prompt.ts:231-232` | ✅ | REMOVED by SDD-05 (W-5). |
| `run.fork(capture(...))` call site | `src/session/prompt.ts:1645` | ✅ | Stays unchanged (W-6, W-12). Fires once per turn on `finished && !handle.message.error`. |
| `Instance.project.id` | `src/session/prompt.ts:206` | ✅ | `project_id` source. Stays — passed to `classify` (W-4). |
| `SessionTurn` type | `src/memory/capture/session-turn.ts:12` | ✅ | `{ sessionID, messageID, withParts, persona, project_id }`. Consumed by `TraceIngestor.ingest` (W-2). Unchanged. |
| `classify` (SDD-04) | `src/memory/classify/pipeline.ts` | ✅ | SC-1 interface: `classify({ sessionID, text, project_id, persona }): Promise<ClassifyResult>`. SDD-05 calls it and discards the return (W-4, W-5). |

### Reuse map

| Existing | Reuse | New |
|---|---|---|
| `capture` Effect.fnUntraced (`prompt.ts:166`) | The body SDD-05 edits in place. Same signature: `{ sessionID, messages, persona }`. | None. |
| `isMemoryEnabled` (`prompt.ts:172`) | Unchanged gate. | None. |
| `TraceIngestor.ingest` (`prompt.ts:208`) | Unchanged deterministic path. Called with the same `SessionTurn`. | None. |
| `Consolidation.extractTurn` (`prompt.ts:182-188`) | Unchanged regex path. Stays as the deterministic fallback alongside the pipeline. | None. |
| `run.fork` (`prompt.ts:114-119`) | Unchanged async dispatch. | None. |
| `Instance.project.id` (`prompt.ts:206`) | Unchanged `project_id` source. | None. |
| `classify` (SDD-04) | Imported dynamically from `../memory/classify/pipeline`. Called once per turn with `{ sessionID, text, project_id, persona }`. Return discarded. | None. SDD-04 creates the pipeline. |

### New modules

None. SDD-05 edits `src/session/prompt.ts` only. The buffer (SDD-03) and pipeline (SDD-04) are created by their own specs. SDD-05 does NOT import the buffer (the pipeline owns the buffer per SC-1).

### Wiring

1. **Capture body** (`src/session/prompt.ts:166-237`): in the `try` block, after the `isMemoryEnabled` gate:
   - Keep `Consolidation.extractTurn` (lines 175-188) — the regex path stays.
   - Compute `text` (the concatenated `TextPart.text` of the turn). Keep the existing `text` computation at lines 220-224 — `text` is passed to `classify` as `text`.
   - Keep: dynamically import `TraceIngestor` and call `TraceIngestor.ingest(turn)` with the existing `turn` object (lines 201-207). Unchanged.
   - Add: dynamically import `classify` from `../memory/classify/pipeline` (per SC-1), call `classify({ sessionID: input.sessionID, text, project_id: turn.project_id, persona: input.persona })`. Discard the return.
   - Remove: the `resolveExtractionConfig` import and `cfg` local, the `score` import and `s` local, the `opts` object, the `EntityExtractor.extract` call, the `MemoryExtractor.extract` call, the `persistEntities`/`persistMemories` import and calls.
   - Do NOT add: any `Buffer.add`, `Buffer.getContext`, `CircularBuffer` import, or buffer registry call. The pipeline owns the buffer (per SC-1 — the pipeline calls `Buffer.add(input.sessionID, { text: input.text, role: "user" })` and `Buffer.getContext(input.sessionID)` internally).

2. **Call site** (`prompt.ts:1645`): `run.fork(capture({ sessionID, messages: msgs, persona: personaName }))` stays unchanged. The fire condition (`finished && !handle.message.error` at `:1643-1644`) stays unchanged.

3. **No service composition change.** The `capture` body is a closure inside the `SessionPrompt` layer. It does not need a new Effect service. The pipeline is a plain async function (per SC-1 — `classify` is an exported async function at `src/memory/classify/pipeline.ts`, not an Effect service). sdd-05 calls it via dynamic import, matching the existing pattern for memory modules.

### Naming

Per the project AGENTS.md style guide and CC-9:

- Single-word locals: `text`, `turn`, `err`.
- `classify` is already a single word — no compound needed for the import.
- `const` over `let`. Early returns over `else`. Type inference over explicit annotations. No `any`.
- Dynamic imports for memory modules (matches the existing pattern at `prompt.ts:172, 175, 193, 197-199`): `const { classify } = yield* Effect.promise(() => import("../memory/classify/pipeline"))`.
- `Bun.file()` for any test fixtures (per the test AGENTS.md). Tests do NOT mock `classify`, `TraceIngestor`, or `Provider`. Real pipeline, real SurrealDB. Per C-6, tests do NOT rely on an SDD-04 test-side stub — verification is via import verification + call site grep, plus runtime tests that exercise the real pipeline without stubbing.

## VERIFY

Each test maps 1:1 to a WHAT statement. All tests run from `packages/fbh` (per the `do-not-run-tests-from-root` guard). No mocks of the implementation under test (per CC-7 — the test AGENTS.md). The pipeline is the SDD-04 implementation; tests use it as-is. Per C-6, tests do NOT rely on an "SDD-04 test-side stub." Verification is via import verification (the `classify` import path is correct) + call site grep (the `classify(...)` call site has the right args), plus runtime tests that exercise the real pipeline without stubbing.

Tests live at `packages/fbh/test/fbh-phase-n/sdd-05.test.ts` (matching the `test/fbh-phase-m/sdd-XX.test.ts` pattern).

### Static tests (grep on `src/session/prompt.ts` source — read via `Bun.file`)

| Test | WHAT | Assertion |
|---|---|---|
| `sdd-05.test.ts::stubs_removed` | W-3 | `grep -n "EntityExtractor\|MemoryExtractor\|persistEntities\|persistMemories" src/session/prompt.ts` returns no matches. The stub calls and imports are gone. |
| `sdd-05.test.ts::resolve_extraction_config_removed` | W-10 | `grep -n "resolveExtractionConfig" src/session/prompt.ts` returns no matches. The Phase M config path is gone from the hook. |
| `sdd-05.test.ts::score_import_removed` | W-3 | `grep -n "import.*score\|score(turn)" src/session/prompt.ts` returns no matches (the `score` import and `score(turn)` call are gone; `score.ts` itself stays — used by `TraceIngestor`). |
| `sdd-05.test.ts::trace_ingestor_preserved` | W-2 | `grep -n "TraceIngestor.ingest" src/session/prompt.ts` returns exactly one match. The deterministic path is preserved. |
| `sdd-05.test.ts::classify_imported` | W-4 | `grep -n "import.*classify.*from.*memory/classify/pipeline" src/session/prompt.ts` (or the dynamic-import equivalent `import("../memory/classify/pipeline")`) returns at least one match. The import path matches SC-1. |
| `sdd-05.test.ts::classify_called_once` | W-4 | `grep -n "classify(" src/session/prompt.ts` returns exactly one match (the call site). The call's args are `{ sessionID, text, project_id, persona }` — no `context`, no `current`, no `messageID`, no embedding field. Verified by parsing the call site's args. |
| `sdd-05.test.ts::classify_args_shape` | W-4, W-9 | The `classify(...)` call site's args contain exactly `sessionID`, `text`, `project_id`, `persona`. No `context`, no `current`, no `messageID`, no `embedding`, no `Float32Array`. Verified by parsing the call site. |
| `sdd-05.test.ts::no_buffer_calls` | C-2, C-4 | `grep -n "buffer\.add\|buffer\.getContext\|CircularBuffer\|BufferRegistry" src/session/prompt.ts` returns no matches. The hook does not touch the buffer. |
| `sdd-05.test.ts::no_circuit_breaker_gate` | W-8 | `grep -n "circuit_breaker\|circuitBreaker\|breaker" src/session/prompt.ts` (within the capture body) returns no matches. The hook does not gate on breaker state. |
| `sdd-05.test.ts::no_external_opt_in_gate` | W-11 | `grep -n "external_opt_in\|externalOptIn" src/session/prompt.ts` (within the capture body) returns no matches. The hook does not gate on opt-in. |
| `sdd-05.test.ts::try_catch_wraps_classify` | W-7 | The `classify(...)` call site is inside a `try`/`catch` that logs at `warn` with `{ sessionID, error: String(err) }`. Verified by parsing the capture body's structure (grep for the surrounding `try`/`catch` + `Effect.logWarn` or equivalent). |
| `sdd-05.test.ts::run_fork_preserved` | W-6, W-12 | `grep -n "run.fork(capture" src/session/prompt.ts` returns exactly one match. The async dispatch is preserved. |
| `sdd-05.test.ts::is_memory_enabled_preserved` | W-1 | `grep -n "isMemoryEnabled" src/session/prompt.ts` returns at least one match. The gate is preserved. |

### Runtime tests (real pipeline, real buffer, real SurrealDB — no stubs)

| Test | WHAT | Assertion |
|---|---|---|
| `sdd-05.test.ts::disabled_no_op` | W-1 | With `memory.enabled = false`, `capture` returns immediately (within 5ms). No hypergraph writes (verified by querying SurrealDB post-turn — no new nodes). The `classify` call site is not reached at runtime (the gate returns before it). |
| `sdd-05.test.ts::non_blocking` | W-6 | A real LLM session (small model, 1 turn) returns the response to the user within 50ms of `handle.process` completing, even when the real pipeline takes > 1s (real Jev/Gemini latency — no stub, no simulated slow fixture). Verified by timing the user-visible response, not the capture. The `run.fork` at `prompt.ts:1645` is unchanged. |
| `sdd-05.test.ts::fires_once_per_turn` | W-12 | A real LLM session (small model, 1 turn) triggers `capture` exactly once after the step loop exits (not once per step). A multi-step turn (tool calls) also triggers `capture` exactly once. Verified via a `Capture.occurred` counter incremented in the test layer (the counter wraps the real `run.fork`, not the pipeline). |
| `sdd-05.test.ts::trace_ingestor_emits` | W-2 | After a real turn through `capture` with `memory.enabled = true`, the hypergraph contains the expected ACTION/ERROR/MESSAGE nodes and COLLABORATION/ERROR_CORRECTION/EVIDENCE hyperedges for that turn. `TraceIngestor.ingest` is the producer. Verified by querying SurrealDB post-turn. |
| `sdd-05.test.ts::swallows_exceptions` | W-7 | When `classify` throws (induced by pointing `layer1.model` at an invalid model id in the test config — real network failure, no stub), `capture` logs at `warn` with `{ sessionID, error: String(err) }` and the session continues. No exception escapes `capture` into the prompt loop. Verified by asserting the prompt loop completes and the warn log line is present. |
| `sdd-05.test.ts::classify_real_round_trip` | W-4, W-5 | A real turn through `capture` with `memory.enabled = true` and `external_opt_in = true` (the default per SC-2) results in `classify` being called (the pipeline stores MEMORY nodes — verified by querying SurrealDB post-turn for new MEMORY nodes from this session). The hook does NOT persist fragments itself (no new nodes with `producer = "prompt.ts"` — the producer is the pipeline). |

### Typecheck and green suite (per CC-7)

After implementation, `bun run typecheck` SHALL be green and `bun test --timeout 30000` SHALL be green from `packages/fbh`. Known-baseline failures are tolerated via the workstream's `baselineFile`. The SDD-05 tests SHALL be added to `packages/fbh/test/fbh-phase-n/sdd-05.test.ts`.

### Static verification (anchors)

In addition to the runtime tests, SDD-05 SHALL verify the anchors statically:

- `grep -n "EntityExtractor\|MemoryExtractor\|persistEntities\|persistMemories\|resolveExtractionConfig\|score(turn)" src/session/prompt.ts` SHALL return no matches (the stub calls are removed).
- `grep -n "TraceIngestor.ingest" src/session/prompt.ts` SHALL return exactly one match (the deterministic path is preserved).
- `grep -n "classify(" src/session/prompt.ts` SHALL return exactly one match (the pipeline is wired).
- `grep -n "import.*classify.*from.*memory/classify/pipeline\|import(\"../memory/classify/pipeline\")" src/session/prompt.ts` SHALL return at least one match (the import path matches SC-1).
- `grep -n "buffer\.add\|buffer\.getContext\|CircularBuffer\|BufferRegistry" src/session/prompt.ts` SHALL return no matches (the buffer is owned by the pipeline, not the hook).
- `grep -n "isMemoryEnabled" src/session/prompt.ts` SHALL return at least one match (the gate is preserved).
- `grep -n "run.fork(capture" src/session/prompt.ts` SHALL return exactly one match (the async dispatch is preserved).
- `grep -n "circuit_breaker\|circuitBreaker\|external_opt_in\|externalOptIn" src/session/prompt.ts` SHALL return no matches within the capture body (the hook does not gate on breaker or opt-in state).

## Seams

1. **`persist.ts` becomes dead code from the live path.** After SDD-05, `src/memory/extraction/persist.ts` is no longer reachable from `prompt.ts`. It is still imported by the backfill script. SDD-06 rewires the backfill to use `classify` and then deletes `persist.ts`. SDD-05 does not delete `persist.ts` — the backfill still uses it until SDD-06 ships.

2. **`score` import removal.** `src/memory/capture/score.ts` is still imported by `TraceIngestor.ingest` (via `trace.ts:34`) for the `IngestResult.score` field. SDD-05 only removes the `score` import from `prompt.ts` (the hook no longer needs the score — the pipeline owns the gate threshold). `score.ts` itself stays.

3. **`resolveExtractionConfig` removal.** The hook stops calling `resolveExtractionConfig` (the Phase M config path). The pipeline (SDD-04) reads config via its own path (per CC-4 — `memory.extraction.layer1` / `layer2`). The Phase M `ExtractionConfig` shape (mode/model/threshold) is superseded by the Phase N config (SC-2). `mode.ts` stays for backward compatibility with the backfill script until SDD-06; the live hook does not use it.

4. **`Consolidation.extractTurn` redundancy.** The regex path (`Consolidation.extractTurn` at `prompt.ts:182-188`) still runs alongside the pipeline. This is intentional: it is the deterministic fallback the pipeline's circuit breaker falls back to (CC-9), and it produces the regex MEMORY nodes that have `source_path = "tool"` (confidence 0.7) per W-25 of Phase M. SDD-05 does not remove it. A follow-on spec may consolidate the two regex paths (the hook's `Consolidation.extractTurn` and the pipeline's internal regex fallback) once the pipeline's fallback is verified to produce the same records.

5. **`classify` import path.** SDD-05 imports `classify` via dynamic import inside the `try` block, matching the existing pattern: `const { classify } = yield* Effect.promise(() => import("../memory/classify/pipeline"))`. The path `src/memory/classify/pipeline.ts` is fixed by SC-1. SDD-05's tests verify the import path statically; if the path differs, the tests fail (the anchor is the interface, not the path).

6. **Buffer ownership.** Per SC-1, the pipeline (SDD-04) owns the buffer: `Buffer.add` and `Buffer.getContext` are called inside `classify`, not inside `capture`. SDD-05 does NOT import or call the buffer. The buffer's session-scoped lifecycle is owned by SDD-03; the buffer's per-turn update is owned by SDD-04. SDD-05 verifies the hook does not touch the buffer (static grep — `buffer.add\|buffer.getContext\|CircularBuffer` returns no matches in `prompt.ts`).
