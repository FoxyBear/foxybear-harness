# Re-Audit — SDD-02 (Gemini Extraction Provider), Phase N

**Date:** 2026-09-27
**Auditor:** Independent (re-audit after SC-1/SC-2 tightening)
**Spec:** `docs/specs/260926_fbh-phase-n_sdd-02-gemini-provider.md`
**Master:** `docs/specs/260926_fbh-phase-n_sdd-00-master.md`
**Source root:** `packages/fbh/src/`

## Cross-spec seams checked

1. **`classify` interface (SC-1):** sdd-02 is a leaf spec — does not call `classify`. Owns `Gemini.extract` which sdd-04's `classify` calls. ✓
2. **`Gemini` namespace at `src/provider/gemini.ts` (SC-1):** req 1 creates `src/provider/gemini.ts` with `Gemini` namespace and `ExtractedMemory` interface. Matches SC-1 exactly: `extract(systemPrompt, userContent): Promise<{ memories: ExtractedMemory[]; skipped_reason?: string }>`. ✓
3. **Store ownership (SC-1):** sdd-02 is a leaf — does not call store. Returns memories to the pipeline; the pipeline stores. ✓
4. **`external_opt_in` default (SC-2):** req 8 says "master SC-2 default is `true` — opt-out is explicit." When `false`, returns `{ memories: [], skipped_reason: "external_opt_in false" }` immediately. ✓
5. **sdd-05 does NOT call Buffer (SC-1):** Not applicable to sdd-02. ✓
6. **3 stubs listed consistently (SC-1):** sdd-02 references the stub at `memory.ts:63` (regex fallback) and `memory.ts:41` (`extractRegex`) — correct. ✓

## Anchor verification

| Anchor | Real source | Status |
|---|---|---|
| `src/provider/provider.ts:1771` `Provider.parseModel` | `export function parseModel(model: string)` at 1771 | ✓ exact |
| `src/provider/provider.ts:123-147` `BUNDLED_PROVIDERS` | `const BUNDLED_PROVIDERS: Record<string, ...>` at 123 | ✓ exact |
| `src/provider/error.ts:173` `parseAPICallError` | referenced (exists in error.ts) | ✓ |
| `src/config/bridge.ts` `getConfig` | `export async function getConfig()` at 4 | ✓ exact |
| `src/config/paths.ts:77-129` `substitute` | `async function substitute(...)` at 78 | ✓ exact |
| `src/memory/extraction/mode.ts:44` `resolveExtractionConfig` | at 44 | ✓ exact |
| `src/memory/extraction/memory.ts:41` `extractRegex` | `export function extractRegex(text)` at 41 | ✓ exact |
| `src/session/compaction.ts:384-401` circuit idiom | `consecutiveFailures` at 384, `autoDisabled` at 385, `recordCompactionFailure` at 387, `recordCompactionSuccess` at 398 | ✓ exact |
| `src/session/index.ts:287-303` Decimal cost idiom | `Decimal` cost calc at 293-296 | ✓ exact (block spans 287-303) |
| `src/daemon/routes.ts:101` `/memory/metrics` | `.get("/memory/metrics", ...)` at 101 | ✓ exact |
| `src/cli/cmd/stats.ts:277` | `stats.modelUsage[model].cost += usage.cost` at 277 | ✓ exact |

## Notes

- `Gemini` namespace interface matches SC-1 exactly. The `metrics()` export is additive (not in SC-1) for CC-8 cost aggregation — explicitly noted as extra, not a conflict. ✓
- `ExtractedMemory` interface matches SC-1 exactly (7-type enum, user/assistant source). ✓
- Does NOT call `SurrealHypergraphBackend.store` directly — returns memories to the pipeline. ✓
- `external_opt_in` default `true` per SC-2 — correctly referenced. ✓
- Circuit breaker mirrors `SessionCompaction` idiom (compaction.ts:384-401) — reuse, not new abstraction. ✓

VERDICT: PASS
