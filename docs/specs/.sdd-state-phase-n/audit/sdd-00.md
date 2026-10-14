# Re-Audit — SDD-00 (Master), Phase N

**Date:** 2026-09-27
**Auditor:** Independent (re-audit after SC-1/SC-2 tightening)
**Spec:** `docs/specs/260926_fbh-phase-n_sdd-00-master.md`
**Source root:** `packages/fbh/src/`

## Cross-spec seams checked

1. **`classify` interface (SC-1):** Defined at `src/memory/classify/pipeline.ts` as `classify(input: ClassifyInput): Promise<ClassifyResult>` with `ClassifyInput { sessionID, text, project_id, persona }` and `ClassifyResult { stored, skipped, errors }`. Authoritative — feature specs MUST match. ✓
2. **Provider namespaces (SC-1):** `Jev` at `src/provider/jev.ts`, `Gemini` at `src/provider/gemini.ts`, `Buffer` at `src/memory/capture/buffer.ts`. All three are new files (not yet created — spec'd by Phase N). ✓
3. **Store ownership (SC-1):** Pipeline (sdd-04) owns the store. sdd-05 and sdd-06 call `classify(input)`, NOT `SurrealHypergraphBackend.store` directly. Stated explicitly: "The capture hook (sdd-05) does NOT call `SurrealHypergraphBackend.store` for extracted memories — only the pipeline does." ✓
4. **`external_opt_in` default (SC-2):** `true` — "All feature specs MUST use `true` as the default. The Phase M default of `false` is superseded." ✓ (Note: actual `foxybear.ts:58-60` still has `false` — the implementation must change this; sdd-01 owns the config schema edit.)
5. **sdd-05 does NOT call Buffer (SC-1):** Pipeline internally calls `Buffer.getContext` and `Buffer.add`; the capture hook does not touch the buffer. ✓
6. **3 stubs listed consistently (SC-1):** `entity.ts:82`, `memory.ts:63`, `hyperedge.ts:60` — all three in the SC-1 stub table.

## Anchor verification

| Anchor | Real source | Status |
|---|---|---|
| `src/memory/extraction/entity.ts:82` | `async function extractViaLLM(text, opts)` at line 82 | ✓ exact |
| `src/memory/extraction/memory.ts:63` | `async function extractViaLLM(text, opts)` at line 63 | ✓ exact |
| `src/memory/extraction/hyperedge.ts:60` | `async function extractViaLLM(...)` at line 60 | ✓ exact |
| `src/session/prompt.ts:226-227` | `EntityExtractor.extract` at 226, `MemoryExtractor.extract` at 227 | ✓ exact |
| `src/session/prompt.ts:1645` | `run.fork(capture(...))` at 1645 | ✓ exact |
| `src/session/prompt.ts:166` | `const capture = Effect.fnUntraced(...)` at 166 | ✓ exact |
| `src/config/foxybear.ts:41-93` | `extraction: z.object({...})` at 41, `.optional()` at 93 | ✓ exact |
| `external_opt_in` current default | `foxybear.ts:58-60` — default `false` (Phase M; SC-2 supersedes to `true`) | ✓ (superseded by SC-2) |
| `src/memory/capture/confidence.ts:18,20,23` | `Provenance` at 18, `TOOL_CONFIDENCE` at 20, `confidenceFor` at 23 | ✓ exact |

## Notes

- **Hyperedge stub (hyperedge.ts:60):** Listed in SC-1 stub table as "replaced by `classify` pipeline (sdd-04)." However, `HyperedgeExtractor` is never imported or called from `prompt.ts` or `backfill-hypergraph.ts` — verified via grep (`HyperedgeExtractor` appears only in its own file). The stub is effectively dead code. `classify` stores `MEMORY` nodes only (sdd-04 scope), not `HYPEREDGE` nodes, so "replaced by `classify`" is slightly misleading. This is a documentation imprecision in the SC-1 stub table, not a blocking inconsistency — the stub line number is correct, and the stub is not reachable from the live path.
- **SC-2 `external_opt_in` default:** The master says `true` and "Phase M default of `false` is superseded." The actual `foxybear.ts` has `false`. sdd-01 owns the config schema edit and must change the default. See sdd-01 audit for the blocking issue.

VERDICT: PASS
