# Re-Audit — SDD-04 (Gate-Extract-Classify Pipeline), Phase N

**Date:** 2026-09-27
**Auditor:** Independent (re-audit after SC-1/SC-2 tightening)
**Spec:** `docs/specs/260926_fbh-phase-n_sdd-04-gate-extract-classify.md`
**Master:** `docs/specs/260926_fbh-phase-n_sdd-00-master.md`
**Source root:** `packages/fbh/src/`

## Cross-spec seams checked

1. **`classify` interface (SC-1):** sdd-04 owns `classify(input: ClassifyInput): Promise<ClassifyResult>` at `src/memory/classify/pipeline.ts`. Interface matches SC-1 exactly: `ClassifyInput { sessionID, text, project_id, persona }`, `ClassifyResult { stored, skipped, errors }`. ✓
2. **Provider namespaces (SC-1):** Imports `Jev` (sdd-01, `src/provider/jev.ts`), `Gemini` (sdd-02, `src/provider/gemini.ts`), `Buffer` (sdd-03, `src/memory/capture/buffer.ts`). All cited correctly per SC-1. ✓
3. **Store ownership (SC-1):** Pipeline owns the store — W-15 calls `SurrealHypergraphBackend.store(node)` directly. "The pipeline owns the store step (SC-1) — neither the capture hook (SDD-05) nor re-backfill (SDD-06) call `SurrealHypergraphBackend.store` for extracted memories; both call `classify(input)`, and the pipeline handles the store." ✓
4. **`external_opt_in` default (SC-2):** W-24 says "default is `true` per SC-2." Config section says "`external_opt_in` defaults to `true` for Phase N (SC-2 — the Phase M default of `false` is superseded)." ✓
5. **sdd-05 does NOT call Buffer (SC-1):** sdd-04's pipeline calls `Buffer.getContext(input.sessionID)` and `Buffer.add(input.sessionID, { text, role: "user" })` internally. sdd-05 does not touch the buffer. ✓
6. **3 stubs listed consistently (SC-1):** Intro mentions only `entity.ts:82` and `memory.ts:63` (2 of 3). `hyperedge.ts:60` is NOT mentioned in sdd-04's text. However, sdd-04 inherits the master's SC-1 stub table (which lists all 3), and `HyperedgeExtractor` is dead code (never called from the capture hook — verified via grep). sdd-04 stores `MEMORY` nodes only, so the hyperedge stub is not in its scope. This is a minor documentation gap, not a blocking inconsistency.

## Anchor verification

| Anchor | Real source | Status |
|---|---|---|
| `src/session/prompt.ts:226-227` stub calls | `EntityExtractor.extract` at 226, `MemoryExtractor.extract` at 227 | ✓ exact |
| `src/session/prompt.ts:166-237` capture closure | `Effect.fnUntraced` at 166, catch at 234 | ✓ exact |
| `src/session/prompt.ts:1645` `run.fork(capture(...))` | at 1645 | ✓ exact |
| `src/memory/extraction/redact.ts:37` `redact` | `export function redact(content, opts?)` at 37 | ✓ exact |
| `src/memory/surreal-hypergraph-backend.ts:245` `store` | `async store(node: NodeRecord)` at 245 | ✓ exact |
| `src/memory/surreal-hypergraph-backend.ts:43` `NodeRecord` | `export interface NodeRecord` at 43 | ✓ exact |
| `src/memory/embedding.ts:211` `Embedding.embed` | `export async function embed(text, config)` at 211 | ✓ exact |
| `src/memory/backend-registry.ts:45` `getGlobalHypergraphBackend` | at 45 | ✓ exact |
| `src/memory/capture/confidence.ts:18,20,23` | `Provenance` at 18, `TOOL_CONFIDENCE = 0.7` at 20, `confidenceFor` at 23 | ✓ exact |
| `src/memory/extraction/memory.ts:41` `extractRegex` | at 41 | ✓ exact |
| `src/memory/extraction/persist.ts:59` `persistMemories` | `export async function persistMemories` at 59 | ✓ exact |
| `src/memory/schema/enums.ts:17` `MEMORY` active type | `"MEMORY"` at line 17 (`ACTIVE_NODE_TYPES[0]`) | ✓ exact |

## Notes

- **Store ownership:** Pipeline owns the store (W-15 calls `SurrealHypergraphBackend.store` directly). sdd-05 and sdd-06 call `classify(input)` only. Consistent with SC-1. ✓
- **Buffer ownership:** Pipeline calls `Buffer.getContext` (gate state) and `Buffer.add` (record turn) internally per SC-1 step 6. sdd-05 does not touch the buffer. ✓
- **`external_opt_in` default `true`:** Correctly references SC-2. ✓
- **`CLASSIFY_CONFIDENCE = 0.7`:** New constant in `confidence.ts` (W-21). Distinguishes from `TOOL_CONFIDENCE = 0.7` (same value, different reason). ✓
- **Minor: intro mentions 2 of 3 stubs.** The master SC-1 stub table lists all 3 (entity.ts:82, memory.ts:63, hyperedge.ts:60). sdd-04's intro mentions only entity.ts:82 and memory.ts:63. `hyperedge.ts:60` is dead code (HyperedgeExtractor never called from capture hook — verified). The master SC-1 is authoritative, so sdd-04 inherits the full stub table. Not blocking.
- **Circuit breaker:** Module-level counter in `classify/pipeline.ts` with 2x backoff. CC-9 specifies `max_consecutive_failures = 5`; the 2x backoff (10 turns) is a Phase N addition not in CC-9 — noted as a seam, not a contradiction. ✓

VERDICT: PASS
