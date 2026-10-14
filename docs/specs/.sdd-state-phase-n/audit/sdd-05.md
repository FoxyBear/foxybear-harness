# Re-Audit — SDD-05 (Wire Into Capture), Phase N

**Date:** 2026-09-27
**Auditor:** Independent (re-audit after SC-1/SC-2 tightening)
**Spec:** `docs/specs/260926_fbh-phase-n_sdd-05-wire-capture.md`
**Master:** `docs/specs/260926_fbh-phase-n_sdd-00-master.md`
**Source root:** `packages/fbh/src/`

## Cross-spec seams checked

1. **`classify` interface (SC-1):** W-4 calls `classify({ sessionID, text, project_id, persona })` — matches `ClassifyInput` per SC-1 exactly (no `context`, no `current`, no `messageID`, no embedding). Import from `src/memory/classify/pipeline` per SC-1. ✓
2. **Provider namespaces (SC-1):** sdd-05 does NOT import or call `Jev`, `Gemini`, or `Buffer` directly. W-4/W-5 explicitly state the hook calls `classify(input)` only. ✓
3. **Store ownership (SC-1):** sdd-05 does NOT call `SurrealHypergraphBackend.store` or `persistEntities`/`persistMemories`. W-3/W-5 remove the stub calls and persist imports. "The pipeline owns Stage 4 (store) AND the buffer update (per SC-1)." ✓
4. **`external_opt_in` default (SC-2):** W-11 says "the default is `true` per SC-2." The hook does NOT gate on `external_opt_in` directly — the pipeline does. ✓
5. **sdd-05 does NOT call Buffer (SC-1):** ✓✓ — explicitly stated: "SDD-05 does NOT touch the buffer — no `Buffer.add`, no `Buffer.getContext`, no buffer import." Static grep tests enforce: `grep -n "buffer\.add\|buffer\.getContext\|CircularBuffer\|BufferRegistry" src/session/prompt.ts` returns no matches. This is the key SC-1 seam.
6. **3 stubs listed consistently (SC-1):** sdd-05 mentions `entity.ts` and `memory.ts` stubs (the ones called from the capture hook). `hyperedge.ts:60` is NOT called from the capture hook (verified — HyperedgeExtractor never imported in prompt.ts), so sdd-05 correctly does not address it. The master SC-1 is authoritative for the full stub table. ✓

## Anchor verification

| Anchor | Real source | Status |
|---|---|---|
| `src/session/prompt.ts:166` capture body | `const capture = Effect.fnUntraced(...)` at 166 | ✓ exact |
| `src/session/prompt.ts:172` `isMemoryEnabled` | at 172 | ✓ exact |
| `src/session/prompt.ts:182-188` `Consolidation.extractTurn` | at 182-188 | ✓ exact |
| `src/session/prompt.ts:193` `TraceIngestor` import | at 193 | ✓ exact |
| `src/session/prompt.ts:194-196` `resolveExtractionConfig` import | at 194-196 (REMOVED by sdd-05) | ✓ exact |
| `src/session/prompt.ts:197` `EntityExtractor` import | at 197 (REMOVED) | ✓ exact |
| `src/session/prompt.ts:198` `MemoryExtractor` import | at 198 (REMOVED) | ✓ exact |
| `src/session/prompt.ts:199` `score` import | at 199 (REMOVED) | ✓ exact |
| `src/session/prompt.ts:208` `TraceIngestor.ingest` | at 208 (preserved) | ✓ exact |
| `src/session/prompt.ts:209` `score(turn)` | at 209 (REMOVED) | ✓ exact |
| `src/session/prompt.ts:210-219` `opts` object | at 210-219 (REMOVED) | ✓ exact |
| `src/session/prompt.ts:220-224` `text` computation | at 220-224 (preserved) | ✓ exact |
| `src/session/prompt.ts:226` `EntityExtractor.extract` | at 226 (REMOVED) | ✓ exact |
| `src/session/prompt.ts:227` `MemoryExtractor.extract` | at 227 (REMOVED) | ✓ exact |
| `src/session/prompt.ts:228-230` persist import | at 228-230 (REMOVED) | ✓ exact |
| `src/session/prompt.ts:231-232` persist calls | at 231-232 (REMOVED) | ✓ exact |
| `src/session/prompt.ts:1645` `run.fork(capture(...))` | at 1645 (preserved) | ✓ exact |
| `src/session/prompt.ts:206` `Instance.project.id` | at 206 (preserved) | ✓ exact |
| `src/memory/capture/session-turn.ts:12` `SessionTurn` | `export interface SessionTurn` at 12 | ✓ exact |

## Notes

- **Buffer ownership (key SC-1 seam):** sdd-05 does NOT import or call the buffer. Static grep tests enforce this. The pipeline (sdd-04) owns `Buffer.add` and `Buffer.getContext`. ✓
- **Store ownership:** sdd-05 does NOT call `SurrealHypergraphBackend.store` or persist helpers. Calls `classify(input)` only; the pipeline handles store. ✓
- **`classify` call args:** `{ sessionID, text, project_id, persona }` — matches `ClassifyInput` per SC-1. No `context`, no `current`, no `messageID`, no embedding. ✓
- **`external_opt_in` default `true`:** Correctly references SC-2. Hook does not gate on opt-in — pipeline does. ✓
- **Deterministic path preserved (CC-1):** `TraceIngestor.ingest` and `Consolidation.extractTurn` are unchanged. ✓
- **Async non-blocking (CC-3):** `run.fork(capture(...))` at prompt.ts:1645 is preserved. ✓
- **All anchors verified against real source.** The line numbers for removed imports/calls (197-199, 209, 210-219, 226-232) match the current prompt.ts exactly, confirming the spec's edit map is accurate.

VERDICT: PASS
