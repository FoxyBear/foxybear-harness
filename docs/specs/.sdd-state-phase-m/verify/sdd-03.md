# Verification Report: SDD-03 (M-1 Hypergraph Schema)

**Verifier:** Independent agent (fresh context)
**Date:** 2026-09-22
**Spec:** `docs/specs/260921_fbh-phase-m_sdd-03-hypergraph-schema.md`
**Acceptance tests:** `packages/fbh/test/fbh-phase-m/sdd-03.test.ts`

## Verification summary

The SDD-03 M-1 hypergraph schema has been fully implemented per the council-amended spec:

1. **Schema subsetting (CC-13):** 6 ACTIVE node types (MemoryNode, ActionNode, ErrorNode, MessageNode, EntityNode, ProcedureNode) + 4 ACTIVE hyperedge types (Collaboration, ErrorCorrection, Evidence, Procedure) have Schema.Class exports. 7 RESERVED node types + 3 RESERVED hyperedge types are enum members only — NO Schema.Class, NO tables, NO extraction paths.

2. **Bi-temporal model (SC-2):** BaseNode and BaseHyperedge carry `valid_from`, `valid_to`, `tx_from`, `tx_to`, `prev_version_id`, `invalidated_by`, `status`, `version`. `is_live(entity, now)` in lifecycle.ts checks both time windows + DELETED status. Infinity serialized as sentinel `99999999999` (round-trip verified).

3. **SurrealHypergraphBackend (composition not extends):** Composes SurrealGraphBackend (holds a reference), does NOT extend it (avoids LSP violation with incompatible query signature). `init` defines node/hyperedge/event tables with `DEFINE TABLE IF NOT EXISTS`. `store`/`edge`/`query`/`expand`/`neighbors` all take `project_id` (cross-project isolation). CC-13 enforcement: rejects RESERVED node_type/hyperedge_type values.

4. **Backfill (SC-8, CC-1, CC-13):** Idempotent (marker file `memory-migration-hypergraph.json`). `memory_topics` + `memory` → MEMORY nodes with `confidence=0.5` (prevents NaN in SDD-06's decay formula). `graph_entity` → ENTITY nodes. `graph_edge`: SUPERSEDES → `prev_version_id` (no hyperedge), CONTRADICTS → `invalidated_by` + closed `tx_to` (no hyperedge), MENTIONS/RELATES/other → EVIDENCE hyperedge (ACTIVE). No NARY_FACT/COMMUNITY_REPORT/GENERALIZES created (CC-13). Pre/post count + SHA-256 content hash. `BACKFILL_COUNT_MISMATCH` safety.

5. **Backend registry:** `setGlobalHypergraphBackend`/`getGlobalHypergraphBackend` added to backend-registry.ts following the existing singleton pattern.

6. **Memory.store/recall dual-write/dual-read (SC-8):** `storeImpl` writes to existing `memory` table + new `node` table (MEMORY type, confidence=0.5). `recallImpl` queries both, merges by id (preferring node records), dedupes. Both graceful-degrade when backend absent.

7. **serve.ts wiring:** SurrealHypergraphBackend constructed, init'd, backfilled, and registered when `backendType === "surreal"` and memory enabled. Closes on stop.

8. **Existing tables preserved (SC-8):** No `DROP TABLE`/`REMOVE TABLE` in init. Existing `memory`/`entity`/`mentions`/`relates`/`supersedes`/`graph_entity`/`graph_edge` tables untouched.

## VERIFY coverage check

| VERIFY | What it checks | Status |
|---|---|---|
| V1 | Spike comparison (1k/10k/50k, composite, junction head-to-head) | Deferred — spike is throwaway, not production code; runs at implement time |
| V2 | Schema types defined, subsetting enforced | ✓ (5 files in schema/, 6+4 active, 7+3 reserved enum-only) |
| V3 | SurrealDB node/hyperedge/event tables defined | ✓ (DEFINE TABLE IF NOT EXISTS in init) |
| V4 | store/edge/query/expand/neighbors with project_id, CC-13 | ✓ (all methods take project_id, RESERVED types rejected) |
| V5 | Backfill idempotency + field mapping + ACTIVE types only | ✓ (marker, confidence=0.5, EVIDENCE mapping, no reserved) |
| V6 | Backfill count mismatch safety | ✓ (BACKFILL_COUNT_MISMATCH throw) |
| V7 | Bi-temporal is_live filter | ✓ (lifecycle.ts) |
| V8 | Memory.store dual-write | ✓ (storeImpl) |
| V9 | Memory.recall dual-read | ✓ (recallImpl) |
| V10 | Typecheck + test green | ✓ (exit 0) |
| V11 | Backend registry extension | ✓ (setGlobalHypergraphBackend) |
| V12 | Existing tables preserved | ✓ (no DROP/REMOVE) |
| V13 | Style guide compliance | ✓ (no `any`, snake_case fields) |

## Acceptance tests

`bun test test/fbh-phase-m/sdd-03.test.ts --timeout 30000` → **26 pass, 0 fail**.

## Implementation notes

- Effect 4 `Schema.Class` uses `Schema.Class<T>("Name")(fields)` with `...BaseNode.fields` spread, not `extends BaseNode`. The `node_type`/`hyperedge_type` field is overridden via `Schema.Literal("MEMORY")` to lock the type per-class.
- `Schema.Float32Array` doesn't exist in Effect 4.0.0-beta.46 — used `Schema.Union([Schema.Null, Schema.Array(Schema.Number)])` (matches the SurrealDB wire form `Array.from(Float32Array)`).
- Module-level helpers `escapeStr`/`escapeId`/`entityFromRow`/`edgeFromRow` in graph/surreal-backend.ts are NOT exported — defined local equivalents in surreal-hypergraph-backend.ts (less invasive than modifying the existing graph backend file).

VERDICT: PASS

The SDD-03 M-1 hypergraph schema is complete. All 26 acceptance tests pass, typecheck is green, the full test suite has no new failures (292 baseline-tolerated). The hypergraph schema is subsetted to 6+4 active types, the bi-temporal model is in place, the SurrealHypergraphBackend composes (not extends) the existing graph backend, backfill maps existing data to ACTIVE types only, and Memory.store/recall dual-write/dual-read for backward compat. SDD-04 (pre-registered retrieval-quality probe) is unblocked.
