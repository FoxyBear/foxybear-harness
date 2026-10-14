# Re-Audit — SDD-06 (Re-backfill with Real Classifier), Phase N

**Date:** 2026-09-27
**Auditor:** Independent (re-audit after SC-1/SC-2 tightening)
**Spec:** `docs/specs/260926_fbh-phase-n_sdd-06-re-backfill.md`
**Master:** `docs/specs/260926_fbh-phase-n_sdd-00-master.md`
**Source root:** `packages/fbh/src/`

## Cross-spec seams checked

1. **`classify` interface (SC-1):** req 7 calls `classify(input: ClassifyInput)` at `src/memory/classify/pipeline.ts` (SC-1 — the single entry point). `ClassifyInput { sessionID, text, project_id, persona }` per SC-1. ✓
2. **Provider namespaces (SC-1):** sdd-06 does NOT call `Jev.noul`, `Jev.choice`, `Gemini.extract` directly — only `classify(input)` (req 8). Does import `Buffer` for session-start clear only (does NOT call `Buffer.add`/`Buffer.getContext`). ✓
3. **Store ownership (SC-1):** sdd-06 does NOT call `persistMemories`/`persistEntities` or `SurrealHypergraphBackend.store` directly for extracted memories. req 9: "the pipeline owns the store per SC-1 — it persists internally via `SurrealHypergraphBackend.store`, step 5; the script does NOT call `persistMemories`/`persistEntities` or `SurrealHypergraphBackend.store` directly." ✓
4. **`external_opt_in` default (SC-2):** req 1d says "gated on `memory.extraction.external_opt_in = true` per SC-2 default." Config section says "The Phase M default of `false` is superseded; Phase N enables external extraction by default." ✓
5. **sdd-05 does NOT call Buffer (SC-1):** Not applicable to sdd-06. sdd-06 itself calls `Buffer.clear(sessionID)` at session start (for isolation), but does NOT call `Buffer.add`/`Buffer.getContext` — those are owned by the pipeline (classify) per SC-1. ✓
6. **3 stubs listed consistently (SC-1):** ✓✓ — sdd-06 explicitly lists all 3 stubs with correct line numbers: `entity.ts:82`, `memory.ts:63`, `hyperedge.ts:60`. Notes that the backfill script calls only `EntityExtractor.extract` and `MemoryExtractor.extract` (not HyperedgeExtractor), and that sdd-05 replaces the hyperedge stub in the production path per SC-1's stub table.

## Anchor verification

| Anchor | Real source | Status |
|---|---|---|
| `backfill-hypergraph.ts:36` log create | `const log = Log.create({ service: "backfill-hypergraph" })` at 36 | ✓ exact |
| `backfill-hypergraph.ts:45-48` `markerPath` | `function markerPath(dbPath)` at 45-48 | ✓ exact |
| `backfill-hypergraph.ts:58-76` `backfillAllDbs` | at 58-76 | ✓ exact |
| `backfill-hypergraph.ts:78-108` `backfillCurrent` | at 78-108 | ✓ exact |
| `backfill-hypergraph.ts:102-107` `Instance.provide` | at 102-107 | ✓ exact |
| `backfill-hypergraph.ts:110-123` `Marker` interface | `interface Marker {...}` at 110-123 | ✓ exact |
| `backfill-hypergraph.ts:170-178` dynamic imports | at 170-177 (imports span 170-177; spec says 170-178 — off by 1, trivial) | ✓ near-exact |
| `backfill-hypergraph.ts:185` `MessageV2.stream(s.id).reverse()` | `const messages = Array.from(MessageV2.stream(s.id)).reverse()` at 185 | ✓ exact |
| `backfill-hypergraph.ts:208` `TraceIngestor.ingest` | `const result = await TraceIngestor.ingest(turn)` at 208 | ✓ exact |
| `backfill-hypergraph.ts:213` `score(turn)` | `const turnScore = score(turn)` at 213 | ✓ exact |
| `backfill-hypergraph.ts:230-231` stub extractor calls | `EntityExtractor.extract` at 230, `MemoryExtractor.extract` at 231 | ✓ exact |
| `backfill-hypergraph.ts:240-242` progress logging | `if (processed % 10 === 0) console.log(...)` at 240-242 | ✓ exact |
| `backfill-hypergraph.ts:269-286` marker write | `await Bun.write(markerPath, ...)` at 284, block at 269-286 | ✓ exact |
| `backfill-hypergraph.ts:151-162` SessionTable query | `db.select({...}).from(SessionTable).orderBy(SessionTable.time_updated)` at 151-160 | ✓ exact (spec says 151-162; actual 151-160 — trivial) |
| `src/memory/extraction/entity.ts:82` stub | at 82 | ✓ exact |
| `src/memory/extraction/memory.ts:63` stub | at 63 | ✓ exact |
| `src/memory/extraction/hyperedge.ts:60` stub | at 60 | ✓ exact |
| `src/memory/extraction/persist.ts:19,59` | `persistEntities` at 19, `persistMemories` at 59 | ✓ exact |
| `src/memory/surreal-hypergraph-backend.ts:628` `deleteNode` | at 628 | ✓ exact |
| `src/memory/surreal-hypergraph-backend.ts:666` `softDelete` | at 666 | ✓ exact |
| `src/memory/surreal-hypergraph-backend.ts:553` `listLiveNodes` | at 553 | ✓ exact |
| `src/memory/m0-abort.ts:31-101` `checkAbortA1` | `export async function checkAbortA1(...)` at 31 | ✓ exact |
| `src/memory/graph/surreal-backend.ts:388` `run` | `async run(surql: string): Promise<any[]>` at 388 | ✓ exact |
| `src/memory/capture/score.ts:24` `score` | `export function score(turn)` at 24 | ✓ exact |

## Notes

- **Store ownership (key SC-1 seam):** sdd-06 calls `classify(input)` only. Does NOT call `persistMemories`/`persistEntities` or `SurrealHypergraphBackend.store` directly for extracted memories. The pipeline owns the store. ✓
- **Buffer ownership:** sdd-06 imports `Buffer` for session-start clear only (req 10: "the script SHALL clear the SDD-03 circular buffer at the start of each session"). Does NOT call `Buffer.add`/`Buffer.getContext` — those are owned by `classify` per SC-1. ✓
- **3 stubs listed consistently:** All 3 stubs cited with correct line numbers (entity.ts:82, memory.ts:63, hyperedge.ts:60). Notes that backfill script calls only 2 of 3; the third (hyperedge) is replaced by sdd-05 in the production path per SC-1. ✓
- **`external_opt_in` default `true`:** Correctly references SC-2. Pre-flight check (req 1d) asserts `external_opt_in = true` unless `--allow-regex-only`. ✓
- **CC-1 no data loss:** Deterministic nodes (ACTION/ERROR/MESSAGE) preserved — not re-ingested. `TraceIngestor.ingest` called only in pre-flight determinism check, not in main re-ingest loop. ✓
- **CC-2 stub replacement:** `classify(input)` replaces `EntityExtractor.extract` and `MemoryExtractor.extract` calls. No parallel re-backfill-only classifier path. ✓
- **Minor: `HyperedgeExtractor` is dead code** (never called from backfill script or capture hook — verified via grep). sdd-06 correctly notes the backfill script does not call it.

VERDICT: PASS
