# Re-Audit — SDD-03 (Circular Buffer), Phase N

**Date:** 2026-09-27
**Auditor:** Independent (re-audit after SC-1/SC-2 tightening)
**Spec:** `docs/specs/260926_fbh-phase-n_sdd-03-circular-buffer.md`
**Master:** `docs/specs/260926_fbh-phase-n_sdd-00-master.md`
**Source root:** `packages/fbh/src/`

## Cross-spec seams checked

1. **`classify` interface (SC-1):** sdd-03 is a leaf spec — does not call `classify`. Owns `Buffer.add`/`getContext`/`get`/`clear`/`size` which sdd-04's `classify` calls. ✓
2. **`Buffer` namespace at `src/memory/capture/buffer.ts` (SC-1):** req 1 creates `src/memory/capture/buffer.ts` with `Buffer` namespace. Interface matches SC-1 exactly: `add(sessionID, turn)`, `getContext(sessionID): string`, `get(sessionID)`, `clear(sessionID)`, `size()`. ✓
3. **Store ownership (SC-1):** sdd-03 is a leaf — does not call store. ✓
4. **`external_opt_in` default (SC-2):** Not directly relevant to sdd-03 (buffer does not make LLM calls). Config field `buffer_size` is additive to `memory.extraction`. ✓
5. **sdd-05 does NOT call Buffer (SC-1):** sdd-03's `Buffer` is owned by the pipeline (sdd-04). sdd-05 does not import or call Buffer — verified in sdd-05 audit. ✓
6. **3 stubs listed consistently (SC-1):** sdd-03 does not list the stubs (not its scope). ✓

## Anchor verification

| Anchor | Real source | Status |
|---|---|---|
| `src/session/compaction.ts:69` `sessionMemoryStore` | `const sessionMemoryStore = new Map<string, SessionMemory>()` at 69 | ✓ exact |
| `src/session/compaction.ts:85` `MICROCOMPACT_PRESERVE` | `export const MICROCOMPACT_PRESERVE = 5` at 85 | ✓ exact |
| `src/memory/packing/tracker.ts:29` `ProvenanceTracker.store` | `const store = new Map<string, Packed[]>()` at 29 | ✓ exact |
| `src/memory/packing/tracker.ts:46,67` `store.delete` | `store.delete(sessionID)` at 46, 53, 67 | ✓ exact |
| `src/session/index.ts:208-216` `Session.Event.Deleted` | `Deleted: SyncEvent.define({ type: "session.deleted", ... })` at 208-216 | ✓ exact |
| `src/share/share-next.ts:161-176,199` `watch` pattern | `const watch = <D>(...)` at 161, used for `Session.Event.Deleted` at 199 | ✓ exact |
| `src/memory/extraction/mode.ts:44` `resolveExtractionConfig` | at 44 | ✓ exact |
| `src/session/prompt.ts:1645` `run.fork(capture(...))` | at 1645 | ✓ exact |
| `src/cli/cmd/serve.ts:132-138` `SurrealHypergraphBackend` init | `const { SurrealHypergraphBackend } = await import(...)` at 132, `new SurrealHypergraphBackend(...)` at 133, `await hyper.init()` at 134 | ✓ exact |

## Notes

- `Buffer` namespace interface matches SC-1 exactly. The `init()` Effect is additive (not in SC-1) for session-lifecycle subscription — explicitly noted as extra, not a conflict. ✓
- Session-scoped `Map<sessionID, { turns, size }>` — matches `sessionMemoryStore` and `ProvenanceTracker.store` precedents. ✓
- `size === 0` edge case handled with explicit `entry.turns = []` (not `slice(-0)`) — correct JS guard. ✓
- Clear on `Session.Event.Deleted` via `bus.subscribe` + `Effect.forkScoped` — matches `share-next.ts:161-176` pattern. ✓
- Does NOT call `classify`, Jev, Gemini, or `SurrealHypergraphBackend.store`. ✓

VERDICT: PASS
