# SDD-03: Phase M-1 — Hypergraph Schema

**Date:** 2026-09-21 (revised 2026-09-22 per council deliberation, rewritten from scratch)
**Project:** FoxyBear Harness Phase M (`development/foxybear`)
**Status:** Draft (pending independent re-audit + human gate)
**Master:** `260921_fbh-phase-m_sdd-00-master.md` (authoritative; where this spec conflicts, the master wins)
**Research:** `docs/research/260921_fbh-phase-m_research.md` (§"Build plan → Phase M-1", §"Graph backend recommendation")
**Workstream:** `fbh-phase-m` (`tools/sdd/workstreams/fbh-phase-m.json`)
**Depends on:** `sdd-02` (M-0 wire-up) — needs scheduler re-enabled + SurrealDB drift fixed + `memory-migration-surreal.json` marker present so the hypergraph backfill runs against the foxybear Surreal path.
**Depended on by:** `sdd-04` (pre-registered probe — needs `node`/`hyperedge`/`event` tables, `SurrealHypergraphBackend.query`/`expand`/`neighbors`, and the backfill).

## Council findings incorporated (2026-09-22)

- **Schema subsetting (CC-13):** 13 MAGE node types → 6 ACTIVE (MESSAGE, ACTION, ERROR, MEMORY, PROCEDURE, ENTITY) + 7 RESERVED (Task, Agent, Insight, Modality, Community, Archetype, MetaProcedure) enum-only — NO tables, NO Schema.Class, NO extraction paths. 7 hyperedge types → 4 ACTIVE (COLLABORATION, ERROR_CORRECTION, EVIDENCE, PROCEDURE) + 3 RESERVED (NaryFact, CommunityReport, Generalizes) enum-only. "A type with a table but no producer is the next recentSessionIds:[]"
- **Strengthened spike (SC-11 A2):** 1k/10k/50k scale sweep, composite 6-predicate query, referential integrity, write-path, junction-table head-to-head comparison, concurrent load. Terminal fallback A2 if both models miss P95 < 50ms at 10k.
- **SurrealDB version pin:** pin the version + add a migration test on upgrade.
- **Abort A2:** both array<record> and junction table miss P95 < 50ms at 10k hyperedges on composite query → abandon hypergraph retrieval; continue as memory-lite over baseline retrieval.
- **Backfill maps to ACTIVE types only:** `graph_edge` rows are mapped to their bi-temporal equivalents (prev_version_id / invalidated_by fields on nodes) or to the closest ACTIVE hyperedge type (EVIDENCE). NO reserved-type hyperedges are created by backfill.

## Probe findings (2026-09-23 — junction table validated)

The SDD-04 probe (6 runs, PASSED on run 6) validated the junction table (`hyperedge_members`) pattern for hyperedge storage — the sdd-03 spike's fallback option that was never tested as a throwaway. Key findings:

- **Junction table is the production approach.** The `array<record> CONTAINSANY` approach (the original sdd-03 default) is 4x slower than the junction table with an index on `node_id`. The junction table was added to `SurrealHypergraphBackend` during the probe's 4th run and is the current implementation.
- **HNSW vector index required on `node.embedding`.** The `DEFINE INDEX ... ON node FIELDS embedding MTREE` syntax is NOT supported in SurrealDB 3.0.5 (MTREE was removed in 3.x). Use `DEFINE INDEX ... ON node FIELDS embedding HNSW DIMENSION 768 DIST COSINE` (the 3.x standard). The HNSW index is required for sub-100ms KNN queries.
- **In-memory adjacency map.** The `expand()` path uses an in-memory `Map<node_id, {hyperedge_id, other_node_ids}[]>` built from `hyperedge_members` at init time. This brought expand from ~1400ms (live DB queries per hop) to ~60ms (hash lookup). The adjacency map is built by `SELECT hyperedge_id, node_id FROM hyperedge_members` → grouped by `node_id`.
- **The spike (SC-7) was never run as a throwaway.** The probe served as the spike. The junction table + HNSW + adjacency map findings flow from the probe to this spec's implementation. The implementation already uses the junction table (added during the probe's 4th run).

Decision log: `docs/decisions/260921_fbh-phase-m_probe-results.md`.

Implements Phase M-1: translates MAGE's schema (SUBSETTED to 6 active node + 4 active hyperedge types per CC-13) to Effect/Schema types, adds `node`/`hyperedge`/`event` tables to SurrealDB, implements `SurrealHypergraphBackend` (composes `SurrealGraphBackend` — holds a reference, does NOT extend), backfills existing rows into `node`/`hyperedge` records, and updates `Memory.store`/`Memory.recall` for dual-write/dual-read backward compat.

## Background

The existing memory layer has `SurrealBackend` (memory KV + entity + mentions + relates + supersedes tables at surreal-backend.ts:76-82) and `SurrealGraphBackend` (graph_entity + graph_edge tables at graph/surreal-backend.ts:79-87, bi-temporal with `valid_from`/`invalid_from` in epoch milliseconds). Neither supports n-ary hyperedges; the graph leg is 1-hop dyadic only (surreal-backend.ts:237-258). MAGE's schema (research §1, arXiv:2608.29678) defines 13 node types and 7 hyperedge types with a Zep/Graphiti-style bi-temporal model. Per council ruling (CC-13), this spec implements only the 6 active node types + 4 active hyperedge types that have producers and consumers in Phase M. The remaining 7+3 types are reserved enum values for forward compat — no tables, no extraction paths.

Two seams against the existing code:
1. **Time units.** SC-2 mandates epoch *seconds*. The existing `SurrealGraphBackend` uses `Date.now()` (epoch *milliseconds*) at graph/surreal-backend.ts:109,125,127. New tables use epoch seconds; backfill converts ms→seconds.
2. **Infinity representation.** SC-2 uses JS `Infinity`. `JSON.stringify(Infinity)` returns `null`. Schema serializes `Infinity` as sentinel `99999999999` (epoch seconds ≈ year 5138) in SurrealDB, deserializes back to `Infinity` in TypeScript.

A naming seam resolved in favor of the master: SC-4/SC-9 name the field `node_ids`; SC-7's spike description called it `members`. The master wins. The field is `node_ids`; the spike tests the `array<record<node>>` storage approach for that field.

---

## WHAT

### Spike (SC-7, SC-11 A2, CC-3) — gates implementation

1. **WHEN** SDD-03 begins, the system **SHALL** run a throwaway spike (script at `tmp/spike-hyperedge-perf.ts`, not committed to production code) that tests BOTH `array<record<node>>` and `hyperedge_members` junction table approaches head-to-head across the full test matrix:
   - **Scale sweep:** 1k, 10k, 50k hyperedges (10k and 50k are the data that matter — 1k misses scaling failures). Create N `node` records of type MEMORY with random 768-dim embeddings in a throwaway SurrealDB namespace `foxybear_spike`; create N `hyperedge` records each linking 2-5 of those nodes.
   - **Composite query:** run 100 iterations of the exact 6-predicate query `SELECT * FROM hyperedge WHERE hyperedge_type = $type AND node_ids CONTAINS ANY $seeds AND valid_from <= $t AND valid_to >= $t AND tx_from <= $t AND tx_to >= $t` (array branch) or the junction-table equivalent, with 5 seed node IDs per query. Measure P95 latency.
   - **Referential integrity:** delete a node referenced by 3 hyperedges; verify hyperedge state handled per spec.
   - **Write path:** INSERT 100 hyperedges in a single transaction; measure P95 write latency.
   - **Concurrent load:** run pack-read queries during decay-write ticks (concurrent reads + writes); measure P95 under contention.
   - The spike produces a COMPARISON between the two approaches, recording all metrics for both.

2. **WHEN** the spike's P95 for the composite query is < 50ms at 10k hyperedges for `array<record<node>>`, the system **SHALL** adopt `array<record<node>>` for `hyperedge.node_ids` and **SHALL** proceed with reqs 9-15.

3. **WHEN** the spike's P95 for the composite query is >= 50ms at 10k for `array<record<node>>` BUT < 50ms for the junction table, the system **SHALL** use the junction table (`hyperedge_members` with `hyperedge_id: record<hyperedge>` + `node_id: record<node>` columns, index on `node_id`) and **SHALL** proceed with reqs 9-15 using the junction branch.

3a. **WHEN** the spike's P95 is >= 50ms at 10k for BOTH approaches on the composite query, the system **SHALL** trigger abort A2 (SC-11): abandon hypergraph retrieval; continue as memory-lite over baseline retrieval. sdd-04 (probe) is skipped; sdd-05/sdd-06/sdd-07 use Arm 2 (vector + 1-hop) instead of Arm 3 (vector + hypergraph). Terminal fallback — no re-runs.

### Schema creation (SC-1 SUBSETTED, SC-2, SC-3, SC-4 SUBSETTED, CC-13)

4. **WHEN** SDD-03 implementation begins, the system **SHALL** create `packages/fbh/src/memory/schema/` and **SHALL** define Effect/Schema types for:
   - `NodeType` enum: 6 ACTIVE values (MEMORY, ACTION, ERROR, MESSAGE, ENTITY, PROCEDURE) + 7 RESERVED values (AGENT, INSIGHT, TASK, MODALITY, COMMUNITY, ARCHETYPE, META_PROCEDURE) as union members only — RESERVED types have NO Schema.Class, NO tables, NO extraction paths (CC-13).
   - `HyperedgeType` enum: 4 ACTIVE values (COLLABORATION, ERROR_CORRECTION, EVIDENCE, PROCEDURE) + 3 RESERVED values (NARY_FACT, COMMUNITY_REPORT, GENERALIZES) as union members only — RESERVED types have NO Schema.Class, NO tables (CC-13).
   - `LifecycleStatus` enum (SC-3: ACTIVE, DEPRECATED, ARCHIVED, DELETED).
   - `BaseNode` struct (SC-2) and `BaseHyperedge` struct (SC-4).
   - 6 ACTIVE node-type Schema.Class exports (`MemoryNode`, `ActionNode`, `ErrorNode`, `MessageNode`, `EntityNode`, `ProcedureNode`) extending `BaseNode` with type-specific `attributes`.
   - 4 ACTIVE hyperedge-type Schema.Class exports (`CollaborationHyperedge`, `ErrorCorrectionHyperedge`, `EvidenceHyperedge`, `ProcedureHyperedge`) extending `BaseHyperedge` with type-specific fields.
   - The RESERVED types are NOT Schema.Class exports — union members only, for forward compat. Activation of a reserved type requires a complete producer+consumer+metric row audited to the same standard (CC-13).

5. **WHEN** the schema types are defined, `BaseNode` **SHALL** carry: `node_id: string`, `node_type: NodeType`, `created_at: number` (epoch seconds), `updated_at: number`, `version: number` (starts at 1), `status: LifecycleStatus`, `embedding: Float32Array | null`, `attributes: Record<string, unknown>`, `valid_from: number`, `valid_to: number` (Infinity = currently believed), `tx_from: number`, `tx_to: number` (Infinity = not retracted), `prev_version_id: string | null`, `invalidated_by: string | null` (SC-2). `BaseHyperedge` **SHALL** carry: `hyperedge_id: string`, `hyperedge_type: HyperedgeType`, `description: string`, `node_ids: string[]` (N >= 2), `confidence: number` (0.0-1.0), `source_nodes: string[]`, `embedding: Float32Array | null`, plus the same bi-temporal fields as `BaseNode` (SC-4).

6. **WHEN** the schema types are defined, `is_live(node_or_edge, now)` **SHALL** be defined in `src/memory/schema/lifecycle.ts` and **SHALL** return `true` iff `(tx_to === Infinity || tx_to > now) && (valid_to === Infinity || valid_to > now) && status !== LifecycleStatus.DELETED` (SC-2). Works for both nodes and hyperedges.

### SurrealDB schema (SC-9, SurrealDB version pin)

7. **WHEN** `SurrealHypergraphBackend.init()` runs, it **SHALL** define (idempotent `DEFINE TABLE IF NOT EXISTS`) the `node`, `hyperedge`, and `event` tables in the existing SurrealDB namespace/database (`foxybear`/`memory`, matching SurrealBackend at surreal-backend.ts:57-58), alongside the existing `memory`/`entity`/`mentions`/`relates`/`supersedes`/`graph_entity`/`graph_edge` tables (which remain untouched per SC-8 backward compat). Indexes: `node_type`, `status`, `attributes.project_id` on `node`; `hyperedge_type`, `node_ids` on `hyperedge`. The system **SHALL** pin the SurrealDB version (record the version in the schema migration marker; on daemon startup, **SHALL** log a warning if the running SurrealDB version differs from the pinned version; a migration test **SHALL** verify the bi-temporal schema works on upgrade).

8. **WHEN** the `node` table is defined, `embedding` **SHALL** store Float32Array as a JSON number array (matching surreal-backend.ts:108: `Array.from(input.embedding)`), `attributes` **SHALL** be SCHEMALESS flex for type-specific non-indexed fields, bi-temporal fields **SHALL** be epoch seconds (SC-2), with `Infinity` serialized as sentinel `99999999999`.

9. **WHEN** the `hyperedge` table is defined, `node_ids` **SHALL** store `array<record<node>>` IF the spike passed (req 2), OR the `hyperedge_members` junction table **SHALL** be defined with `hyperedge_id: record<hyperedge>` and `node_id: record<node>` columns and an index on `node_id` IF the spike fell back (req 3). The `embedding`, `attributes`, and bi-temporal fields follow the same conventions as `node` (req 8). Only the 4 ACTIVE `hyperedge_type` values are valid for storage — RESERVED types are rejected by the schema validation (CC-13 enforcement).

10. **WHEN** the `event` table is defined, it **SHALL** be append-only (no `UPDATE` or `DELETE` statements) with fields `event_id: string`, `event_type` (enum: STORE, UPDATE, DELETE, INVALIDATE, GC_DELETED), `target_id: string`, `target_type` (enum: node, hyperedge), `agent_id: string | null`, `timestamp: number` (epoch seconds), `payload: Record<string, unknown>` (flex), per SC-9. Every `store`, `edge`, soft-delete, and GC operation on `node`/`hyperedge` **SHALL** emit a corresponding event record (security: bi-temporal soft-deletes preserve audit trail).

### SurrealHypergraphBackend implementation (SC-5)

11. **WHEN** the schema is defined, the system **SHALL** implement `SurrealHypergraphBackend` in `packages/fbh/src/memory/surreal-hypergraph-backend.ts` that **composes** (holds a reference to) `SurrealGraphBackend` (graph/surreal-backend.ts:47) and reuses its SurrealDB connection — it does NOT `extends SurrealGraphBackend`, because `SurrealGraphBackend.query(input: { project_id, embedding?, keyword?, limit?, include_global? }): Promise<GraphQueryResult>` (graph/surreal-backend.ts:317, graph/backend.ts:54-60, graph/types.ts:39-42) has an incompatible signature with SC-5's `query(seeds, project_id, opts?): Promise<Hyperedge[]>`, and TypeScript rejects the override (violating CC-4). The constructor accepts `SurrealGraphBackendOptions` (graph/surreal-backend.ts:39-45), constructs `this.graph = new SurrealGraphBackend(opts)`, calls `await this.graph.init()`, then defines the new tables on the same connection via `this.graph.run()`. Module-level helpers `escapeStr`/`escapeId` (graph/surreal-backend.ts:399-408), `entityFromRow` (graph/surreal-backend.ts:430-444), `edgeFromRow` (graph/surreal-backend.ts:446-461) imported directly from the module.

12. **WHEN** `SurrealHypergraphBackend.store(node)` is called, it **SHALL** serialize to `CREATE node:⟨${node_id}⟩ CONTENT ${JSON.stringify(fields)}` (matching surreal-backend.ts:124-126), with `embedding` as `Array.from(node.embedding)` and `Infinity` as sentinel `99999999999`. It **SHALL** emit a `STORE` event to the `event` table. It **SHALL** return the stored node. It **SHALL** reject RESERVED `node_type` values (CC-13 enforcement — only the 6 ACTIVE types are valid for storage).

13. **WHEN** `SurrealHypergraphBackend.edge(edge)` is called, it **SHALL** serialize to `CREATE hyperedge:⟨${hyperedge_id}⟩ CONTENT ${JSON.stringify(fields)}` with `node_ids` as `array<record<node>>` (or junction rows if spike fell back). It **SHALL** emit a `STORE` event. It **SHALL** return the stored hyperedge. It **SHALL** reject RESERVED `hyperedge_type` values (CC-13 — only the 4 ACTIVE types are valid).

14. **WHEN** `SurrealHypergraphBackend.query(seeds, project_id, opts?)` is called with seed node IDs, a `project_id` (per SC-5 — scopes the query; no cross-project contamination per the master's Security section), and optional `opts` (`depth?`, `types?: NodeType[]`, `limit?`), it **SHALL** run `SELECT * FROM hyperedge WHERE node_ids CONTAINS ANY $seeds AND attributes.project_id = $project_id AND tx_to = 99999999999 AND status != 'deleted'` (or junction-table equivalent), optionally capped by `opts.limit` (default 10). `opts.types` filters by connected node type. `opts.depth > 1` delegates to `expand`. It **SHALL** return matching hyperedges filtered by `is_live(now)` (SC-2). Return type `Promise<Hyperedge[]>` at the backend layer; sdd-04 (probe) and sdd-07 (packing) wrap this into SC-5's Effect shapes.

15. **WHEN** `SurrealHypergraphBackend.expand(ids, project_id, depth)` is called, it **SHALL** BFS-expand from seed node IDs through hyperedges up to `depth` hops (capped at 3, matching `SurrealGraphBackend.traverse` at graph/surreal-backend.ts:283), scoped to `project_id` (per SC-5 — no cross-project contamination), returning the connected subgraph (nodes + hyperedges) filtered by `is_live(now)`. It **SHALL** reuse the BFS pattern from `SurrealGraphBackend.traverse` (graph/surreal-backend.ts:291-312). Return type `Promise<{ nodes: Node[]; hyperedges: Hyperedge[] }>`.

16. **WHEN** `SurrealHypergraphBackend.neighbors(id, project_id)` is called (SC-5 interface, for sdd-09 conflict detection), it **SHALL** return live nodes connected to `id` via any live hyperedge, scoped to `project_id` (per SC-5 — no cross-project contamination). It **SHALL** be a thin wrapper over `expand([id], project_id, 1)` returning the unique connected nodes (excluding `id`), filtered by `is_live(now)`. The ADD/UPDATE/DELETE verdict logic is owned by sdd-09; this spec only provides the backend query. Return type `Promise<Node[]>`.

### Backend registry (SC-5)

17. **WHEN** the `SurrealHypergraphBackend` is implemented, the system **SHALL** extend `packages/fbh/src/memory/backend-registry.ts` (currently `MemoryBackend`-only at backend-registry.ts:15-28) with `setGlobalHypergraphBackend(backend)` / `getGlobalHypergraphBackend()` following the existing singleton pattern. It **SHALL** register a `SurrealHypergraphBackend` instance during daemon startup alongside the existing graph backend wiring at `src/cli/cmd/serve.ts:56-98`.

### Backfill migration (SC-8, CC-1, CC-13 — ACTIVE types only)

18. **WHEN** the `SurrealHypergraphBackend` is registered, the system **SHALL** implement a one-time idempotent `backfill()` method that migrates existing rows from `memory_topics` (SQLite), `memory` (Surreal), `graph_entity` (Surreal), and `graph_edge` (Surreal) into the `node` and `hyperedge` tables per the SC-8 field mapping. It **SHALL** be callable from a CLI command and from daemon startup (run once, idempotently).

19. **WHEN** `backfill()` runs, it **SHALL** check for the marker file `~/.local/share/foxybear/memory-migration-hypergraph.json` (matching the `migrateFromSqlite` pattern at surreal-backend.ts:383) using `Bun.file()`. If the marker exists, **SHALL** skip and return `{ ran: false }`. If absent, **SHALL** proceed and write the marker on completion.

20. **WHEN** `backfill()` migrates `memory_topics` rows (SQLite), it **SHALL** map each to a `node` record of type MEMORY (ACTIVE) with: `node_id = source.id`; `attributes.content = source.content`; `embedding = Float32Array` from `bufferToFloat32(source.embedding)` (memory.ts:54); `attributes.persona = source.persona`; `attributes.project_id = source.project_id`; `attributes.scope = source.scope`; `attributes.confidence = 0.5` (per SC-8 row 1 — prevents NaN in sdd-06's decay formula); `attributes.usage_count = source.access_count`; `attributes.last_used = source.time_accessed` (ms → seconds); `valid_from = source.time_created` (ms → seconds); `valid_to = Infinity`; `tx_from = now()`; `tx_to = Infinity`; `status = ACTIVE`; `version = 1`; `prev_version_id = null`; `invalidated_by = null` (per SC-8 row 1, field-for-field).

21. **WHEN** `backfill()` migrates `memory` rows (Surreal), it **SHALL** apply the same field mapping as `memory_topics` (per SC-8 row 2, including `attributes.confidence = 0.5`), with `valid_from = Date.parse(source.created_at) / 1000`.

22. **WHEN** `backfill()` migrates `graph_entity` rows (Surreal), it **SHALL** map each to a `node` record of type ENTITY (ACTIVE) with: `node_id = source.id`; `attributes.name = source.name`; `attributes.entity_type = source.entity_type`; `attributes.content = source.content`; `embedding = source.embedding`; `valid_from = source.valid_from` (ms → seconds); `valid_to = source.invalid_from != null ? source.invalid_from / 1000 : Infinity`; `tx_from = source.time_created / 1000`; `tx_to = source.invalid_from != null ? source.invalid_from / 1000 : Infinity`; `status = source.invalid_from != null ? DELETED : ACTIVE`; `version = 1`; `prev_version_id = null`; `invalidated_by = null` (per SC-8 row 3). ENTITY is ACTIVE (CC-13) — this is a valid backfill target.

23. **WHEN** `backfill()` migrates `graph_edge` rows (Surreal), it **SHALL** map each to ACTIVE hyperedge types or bi-temporal node fields — NOT to RESERVED hyperedge types (CC-13 enforcement):
   - `SUPERSEDES` edges (memory→memory version chain): **SHALL NOT** create a hyperedge. Instead, the supersession is modeled by the bi-temporal `prev_version_id` field on the successor MEMORY node (set `prev_version_id = source.source_id` on the MEMORY node created from the `target_id` row). This is the bi-temporal version-chain mechanism (SC-2) — no hyperedge needed.
   - `CONTRADICTS` edges (memory→memory): **SHALL NOT** create a hyperedge. The contradiction is modeled by the bi-temporal `invalidated_by` field on the invalidated MEMORY node (set `invalidated_by = source.source_id` on the MEMORY node created from the `target_id` row, and close its `tx_to`). This is the bi-temporal soft-delete mechanism (SC-2/SC-3) — no hyperedge needed. (Full conflict detection is sdd-09, deferred.)
   - `MENTIONS` edges (memory→entity): **SHALL** create an EVIDENCE hyperedge (ACTIVE) linking the MEMORY node and the ENTITY node, with `description = "mentions"`, `confidence = source.weight`, `query_or_task_id = null`. EVIDENCE is the closest ACTIVE semantic match for a mention relationship.
   - `RELATES` edges (entity→entity): **SHALL** create an EVIDENCE hyperedge (ACTIVE) linking the two ENTITY nodes, with `description = source.edge_type`, `confidence = source.weight`. EVIDENCE is the closest ACTIVE semantic match.
   - All other `edge_type` values: **SHALL** create an EVIDENCE hyperedge (ACTIVE) with `description = source.edge_type`, `confidence = source.weight`. If the edge_type is unknown, log a warning and still create the EVIDENCE hyperedge (no data loss, CC-1).
   - The backfill **SHALL NOT** create any `NARY_FACT`, `COMMUNITY_REPORT`, or `GENERALIZES` hyperedges — these are RESERVED (CC-13).

24. **WHEN** `backfill()` completes, it **SHALL** compute a pre-migration count (rows in `memory_topics` + `memory` + `graph_entity` + `graph_edge`) and a post-migration count (rows in `node` + `hyperedge`) and a content hash (SHA-256 over `node_id` + `content`/`description` concatenated, sorted) and **SHALL** write both to the marker file proving no data was dropped (CC-1: no data loss). The post-migration `node` count **SHALL** equal `memory_topics` + `memory` + `graph_entity` rows; the `hyperedge` count **SHALL** equal the number of `graph_edge` rows mapped to hyperedges (excluding SUPERSEDES and CONTRADICTS edges, which are mapped to node fields, not hyperedges — the marker **SHALL** record this count separately for transparency). If any count mismatches, the marker **SHALL NOT** be written and `backfill()` **SHALL** throw `BACKFILL_COUNT_MISMATCH`.

### Backward compat (SC-8)

25. **WHEN** `Memory.store` (memory.ts:253-294) is called after SDD-03 completes, it **SHALL** dual-write: first call `backend.write()` (existing path at memory.ts:274, writes to `memory` table via `SurrealBackend`), then call `getGlobalHypergraphBackend().store(node)` (new, writes to `node` table via `SurrealHypergraphBackend`) with the same `content`/`embedding`/`persona`/`project_id`/`scope` mapped to a MEMORY node per SC-8 (req 20, including `attributes.confidence = 0.5`). The dual-write **SHALL NOT** change the existing `MemoryEntry` return shape (memory.ts:284-293). If the hypergraph backend is absent, **SHALL** fall back to single-write (no throw).

26. **WHEN** `Memory.recall` (memory.ts:499-535) is called after SDD-03 completes, it **SHALL** dual-read: call `backend.query()` (existing, reads `memory` table) AND query the `node` table via `getGlobalHypergraphBackend().query()` for MEMORY-type nodes matching the query embedding, merge by `id` (preferring `node` records), dedupe, return the merged set. The dual-read **SHALL NOT** change the existing `MemoryResult[]` return shape. If the hypergraph backend is absent, **SHALL** fall back to single-read.

27. **WHEN** the existing `memory`/`entity`/`mentions`/`relates`/`supersedes`/`graph_entity`/`graph_edge` tables are present, the system **SHALL NOT** drop or alter them (per SC-8 backward compat). They remain for rollback safety until a future deprecation. Only `graph_entity` and `graph_edge` stop receiving new writes (backfilled into `node`/`hyperedge`); `memory` continues to receive dual-writes from `Memory.store`.

### Style & quality (CC-9, CC-4)

28. **WHEN** the implementation completes, the system **SHALL** follow the AGENTS.md style guide: single-word names where unambiguous (`store`, `edge`, `query`, `expand`, `neighbors`, `backfill`); `snake_case` for SurrealDB fields; `Bun.file()` over `fs`; `const` over `let`; no `any` type; early returns; functional array methods over for loops (CC-9).

29. **WHEN** SDD-03 implementation completes, `bun run typecheck` and `bun test --timeout 30000` (run from `packages/fbh`, per SC-10) **SHALL** both be green (CC-4). No red tests left.

---

## HOW

### Step 1: Spike (throwaway, gates implementation, SC-7/SC-11 A2/CC-3)

Write `tmp/spike-hyperedge-perf.ts` (disposable). The spike tests BOTH approaches head-to-head:
- Connects to the running SurrealDB at `ws://127.0.0.1:8000` (foxybear path, post-sdd-02 drift fix).
- Throwaway namespace `foxybear_spike` / database `spike`.
- **For each scale (1k, 10k, 50k):** create N `node` records (MEMORY type, 768-dim random embeddings) + N `hyperedge` records (each with 2-5 random node IDs).
- **Array branch:** insert hyperedges with `node_ids: array<record<node>>`. Run 100 iterations of the 6-predicate composite query. Measure P95.
- **Junction branch:** create `hyperedge_members` table, insert hyperedges + junction rows. Run 100 iterations of the junction-table equivalent 6-predicate query. Measure P95.
- **Referential integrity:** delete a node referenced by 3 hyperedges in each branch; verify hyperedge state.
- **Write path:** INSERT 100 hyperedges in a single transaction in each branch; measure P95.
- **Concurrent load:** run pack-read queries during decay-write ticks (concurrent reads + writes) in each branch; measure P95 under contention.
- Prints a comparison table (all metrics for both approaches at all scales) and a verdict.
- Cleans up: `REMOVE DATABASE IF EXISTS spike`.

If array<record> P95 < 50ms at 10k: proceed with array<record> (req 2). If junction P95 < 50ms at 10k but array >= 50ms: proceed with junction (req 3). If both >= 50ms at 10k: abort A2 (req 3a — abandon hypergraph retrieval, terminal fallback).

### Step 2: Schema types (reqs 4-6, SC-1 SUBSETTED/SC-2/SC-3/SC-4 SUBSETTED/CC-13)

Create `packages/fbh/src/memory/schema/`:
- `schema/enums.ts` — `NodeType` (6 ACTIVE + 7 RESERVED as union members), `HyperedgeType` (4 ACTIVE + 3 RESERVED as union members), `LifecycleStatus` (4 values). The RESERVED types are union members only — NO Schema.Class, NO tables.
- `schema/base.ts` — `BaseNode` and `BaseHyperedge` as `Schema.Class` (matching the pattern at `src/account/schema.ts:22`, `src/v2/session-entry.ts:26`).
- `schema/nodes.ts` — 6 ACTIVE `Schema.Class` exports (`MemoryNode`, `ActionNode`, `ErrorNode`, `MessageNode`, `EntityNode`, `ProcedureNode`) extending `BaseNode` with type-specific `attributes` fields per SC-1. The 7 RESERVED types are NOT exported as Schema.Class — they are union members in `enums.ts` only.
- `schema/hyperedges.ts` — 4 ACTIVE `Schema.Class` exports (`CollaborationHyperedge`, `ErrorCorrectionHyperedge`, `EvidenceHyperedge`, `ProcedureHyperedge`) extending `BaseHyperedge` per SC-4. The 3 RESERVED types are NOT exported.
- `schema/lifecycle.ts` — `is_live(node_or_edge, now)` per SC-2.

### Step 3: SurrealDB schema + SurrealHypergraphBackend (reqs 7-17, SC-5/SC-9)

Create `packages/fbh/src/memory/surreal-hypergraph-backend.ts`:
- `class SurrealHypergraphBackend` — **composes** (holds `private graph: SurrealGraphBackend`) rather than extends. Constructor accepts `SurrealGraphBackendOptions` (graph/surreal-backend.ts:39-45), constructs `this.graph = new SurrealGraphBackend(opts)`. Module-level helpers `escapeStr`/`escapeId`/`entityFromRow`/`edgeFromRow` imported directly.
- `async init()` — calls `await this.graph.init()`, then `DEFINE TABLE IF NOT EXISTS node/hyperedge/event SCHEMALESS;` via `this.graph.run()`. Plus indexes. Records the SurrealDB version in the marker (version pin).
- `async store(node)` — `CREATE node:⟨id⟩ CONTENT {...}` via `this.graph.run()`, emit `STORE` event. Rejects RESERVED `node_type` values (CC-13).
- `async edge(e)` — `CREATE hyperedge:⟨id⟩ CONTENT {...}` (array branch) or junction rows (junction branch). Emit `STORE` event. Rejects RESERVED `hyperedge_type` values (CC-13).
- `async query(seeds, project_id, opts?)` — array branch or junction branch, scoped to `project_id`, filtered by `is_live(now)`.
- `async expand(ids, project_id, depth)` — BFS, capped at 3, scoped to `project_id`, filtered by `is_live(now)`. Reuses `SurrealGraphBackend.traverse` pattern.
- `async neighbors(id, project_id)` — thin wrapper over `expand([id], project_id, 1)`.
- `async backfill()` — see Step 4.

### Step 4: Backfill migration (reqs 18-24, SC-8/CC-1/CC-13)

- Marker check: `Bun.file(path.join(Global.Path.data, "memory-migration-hypergraph.json"))`. Skip if exists.
- Pre-count: query all source tables.
- Migrate `memory_topics` → MEMORY nodes (req 20, including `confidence = 0.5`).
- Migrate `memory` → MEMORY nodes (req 21, same mapping).
- Migrate `graph_entity` → ENTITY nodes (req 22).
- Migrate `graph_edge` → ACTIVE hyperedges or bi-temporal node fields (req 23):
  - SUPERSEDES → set `prev_version_id` on the successor MEMORY node (no hyperedge).
  - CONTRADICTS → set `invalidated_by` + close `tx_to` on the invalidated MEMORY node (no hyperedge).
  - MENTIONS/RELATES/other → EVIDENCE hyperedge (ACTIVE).
- Post-count: verify node count = memory_topics + memory + graph_entity; hyperedge count = graph_edge rows mapped to hyperedges (excluding SUPERSEDES/CONTRADICTS).
- Content hash: SHA-256 over sorted node_id + content/description.
- Write marker with pre_count, post_count, content_hash, SurrealDB version, completed_at.

### Step 5: Backend registry extension (req 17)

Edit `backend-registry.ts` — add `setGlobalHypergraphBackend`/`getGlobalHypergraphBackend`. Edit `src/cli/cmd/serve.ts:56-98` — construct, init, backfill (idempotent), register.

### Step 6: Memory.store/recall dual-write/dual-read (reqs 25-26)

Edit `memory.ts` — `storeImpl` adds dual-write to hypergraph after existing `backend.write()`. `recallImpl` adds dual-read from hypergraph, merge by id. Both graceful-degrade if hypergraph backend absent.

### Step 7: Existing tables preserved (req 27)

No code change — existing tables untouched. `DEFINE TABLE IF NOT EXISTS` is additive.

### Reuse map

| Existing asset | Anchor | Reuse |
|---|---|---|
| `SurrealGraphBackend` | graph/surreal-backend.ts:47 | **Composed** (held by reference). NOT extended (LSP violation). |
| `SurrealBackend` | surreal-backend.ts:42 | NOT extended. Dual-write at `Memory` facade. |
| `MemoryBackend` interface | backend.ts:9 | Unchanged. Hypergraph backend is separate interface. |
| `backend-registry.ts` singleton | backend-registry.ts:15-28 | Extended with hypergraph singleton. |
| `MemoryTopicsTable` | memory.sql.ts:21-40 | Read by backfill. |
| `bufferToFloat32` | memory.ts:54 | Reused by backfill. |
| `Schema.Class` pattern | account/schema.ts:22, v2/session-entry.ts:26 | Template for BaseNode/BaseHyperedge. |
| `SurrealGraphBackend.traverse` BFS pattern | graph/surreal-backend.ts:291-312 | Reused by `expand`. |
| Module helpers `escapeStr`/`escapeId`/`entityFromRow`/`edgeFromRow` | graph/surreal-backend.ts:399-461 | Imported directly. |

### What is explicitly NOT built

- No `@foxybear/Hypergraph` Effect service layer (SC-5 defines the interface; the Effect service composition is consumed by sdd-04/sdd-07; this spec wires the backend via the registry singleton).
- No lifecycle transitions (sdd-06 owns `MemoryLifecycle`).
- No auto-capture (sdd-05 owns `TraceIngestor`).
- No conflict detection (sdd-09 owns `ConflictDetector`).
- No RESERVED-type tables, Schema.Class, extraction paths, or packing paths (CC-13).
- No dropping of existing tables (SC-8 backward compat).
- No multi-user ACL (out of scope).

---

## VERIFY

Tests at `packages/fbh/test/memory/sdd-03-hypergraph-schema.test.ts` (run from `packages/fbh` per SC-10). No mocks of `SurrealHypergraphBackend` (CC-5).

- **V1 — spike comparison (reqs 1-3a, SC-7/SC-11 A2/CC-3).** Setup: running SurrealDB, throwaway namespace. Action: run spike. Expected: spike inserts at 1k/10k/50k for BOTH array<record> and junction; runs 6-predicate composite query; measures P95 at each scale; tests referential integrity, write-path, concurrent load. Records comparison in `tmp/spike-hyperedge-result.json`. If array<record> P95 < 50ms at 10k: assert array branch selected. If junction P95 < 50ms at 10k but array >= 50ms: assert junction branch selected. If both >= 50ms at 10k: assert abort A2 triggered (terminal fallback). Gates V2-V9 — if V1 fires A2, V2-V9 are skipped.

- **V2 — schema types defined, subsetting enforced (reqs 4-6, SC-1/SC-4/CC-13).** Action: import schema types. Expected: `NodeType` is union of 6 ACTIVE + 7 RESERVED (13 total); `HyperedgeType` is union of 4 ACTIVE + 3 RESERVED (7 total); 6 ACTIVE `Schema.Class` node exports exist; 4 ACTIVE `Schema.Class` hyperedge exports exist; RESERVED types are NOT exported as `Schema.Class` (negative assertion — `import { TaskNode } from ...` fails). `is_live` tests: active+open=true, deleted=false, tx closed=false, valid closed=false.

- **V3 — SurrealDB node/hyperedge/event tables defined (reqs 7-10, SC-9).** Setup: boot `init()`. Action: `INFO FOR TABLE node/hyperedge/event`. Expected: all 3 tables exist with correct fields + indexes. `event` rejects UPDATE/DELETE. SurrealDB version recorded in marker. Existing tables still present.

- **V4 — store + edge + query + expand + neighbors (reqs 11-16, SC-5/SC-2).** Setup: 5 nodes (mix of 6 ACTIVE types, all `project_id = "test"`), 3 hyperedges (mix of 4 ACTIVE types, all scoped to `"test"`). Action: (a) store each, assert fields + Infinity round-trip; (b) edge each, assert `node_ids` as array<record> or junction; (c) query with seed, assert returns matching hyperedges; (c') query with `"other-project"`, assert no results (cross-project isolation); (d) expand depth 2, assert BFS subgraph all `is_live`; (e) assert STORE events emitted; (f) neighbors, assert co-members excluding self. (g) **CC-13 enforcement:** `store({ node_type: "TASK", ... })` rejects (RESERVED type); `edge({ hyperedge_type: "NARY_FACT", ... })` rejects (RESERVED type). Soft-delete a node, assert query/expand/neighbors filter it out.

- **V5 — backfill idempotency + field mapping + ACTIVE types only (reqs 18-24, SC-8/CC-1/CC-13).** Setup: populate `memory_topics` (5), `memory` (3), `graph_entity` (4), `graph_edge` (2 SUPERSEDES + 2 CONTRADICTS + 2 MENTIONS + 2 RELATES). Action: run backfill. Expected: (a) marker exists with pre/post counts; (b) `node` has 12 rows (5+3+4) all ACTIVE types (MEMORY + ENTITY — no RESERVED types); (c) `hyperedge` has 4 rows (2 MENTIONS + 2 RELATES → EVIDENCE type — no NARY_FACT/GENERALIZES/COMMUNITY_REPORT); (d) SUPERSEDES edges mapped to `prev_version_id` on successor MEMORY nodes; (e) CONTRADICTS edges mapped to `invalidated_by` + closed `tx_to` on invalidated MEMORY nodes; (f) `attributes.confidence = 0.5` on MEMORY nodes; (g) run backfill again → `{ ran: false }` (idempotent); (h) content hash pre == post.

- **V6 — backfill count mismatch safety (req 24, CC-1).** Setup: same as V5, delete one `memory_topics` row mid-migration. Action: run backfill. Expected: post-count mismatch, marker NOT written, throws `BACKFILL_COUNT_MISMATCH`, re-run attempts again.

- **V7 — bi-temporal is_live filter (req 6, SC-2).** Setup: 4 nodes (live, retracted, expired, soft-deleted). Action: query with each as seed. Expected: only live node returned; others filtered by `is_live`.

- **V8 — Memory.store dual-write (req 25, SC-8).** Setup: daemon with both backends. Action: `Memory.store(...)`. Expected: (a) `memory` table has new row; (b) `node` table has new MEMORY row with `confidence = 0.5`, correct fields; (c) `MemoryEntry` shape unchanged. Kill hypergraph backend → `Memory.store` falls back to single-write (no throw).

- **V9 — Memory.recall dual-read (req 26, SC-8).** Setup: same as V8 + hypergraph-only MEMORY node. Action: `Memory.recall(...)`. Expected: (a) results include hypergraph-only memory; (b) results include dual-written memory; (c) no duplicate IDs; (d) no cross-project results; (e) `MemoryResult[]` shape unchanged. Kill hypergraph backend → falls back to single-read.

- **V10 — typecheck + test green (CC-4).** `bun run typecheck` and `bun test --timeout 30000` both green.

- **V11 — backend registry extension (req 17, SC-5).** Action: import `backend-registry.ts`. Expected: `setGlobalHypergraphBackend` and `getGlobalHypergraphBackend` exist and follow the existing singleton pattern. Boot the daemon (or call `serve.ts` init path) and assert a `SurrealHypergraphBackend` instance is registered via `getGlobalHypergraphBackend()` returning non-null. Assert `setGlobalHypergraphBackend(null)` clears it and `Memory.store` falls back to single-write (graceful degradation).

- **V12 — existing tables preserved (req 27, SC-8).** Setup: boot `SurrealHypergraphBackend.init()` against a SurrealDB instance that has existing `memory`/`entity`/`mentions`/`relates`/`supersedes`/`graph_entity`/`graph_edge` tables. Action: query `INFO FOR DB`. Expected: all existing tables still present (unmodified). Assert no `DROP TABLE` or `REMOVE TABLE` statements are issued by `init()` (grep the SurrealQL logs or inspect the `this.graph.run()` calls). Assert `graph_entity`/`graph_edge` are no longer written to by new code paths (only backfill reads them).

- **V13 — style guide compliance (req 28, CC-9).** Action: inspect the new code in `src/memory/schema/` and `src/memory/surreal-hypergraph-backend.ts`. Expected: (a) method names are single-word where unambiguous (`store`, `edge`, `query`, `expand`, `neighbors`, `backfill`); (b) SurrealDB field names are snake_case (`valid_from`, `valid_to`, `tx_from`, `tx_to`, `prev_version_id`, `invalidated_by`, `node_type`, `hyperedge_type`, `node_ids`, `event_type`, `target_id`, `target_type`, `agent_id`, `timestamp`); (c) marker file uses `Bun.file()` not `fs`; (d) no `any` type in any new file; (e) `const` over `let`; (f) early returns over `else` blocks. Run `bun run typecheck` to verify (d) programmatically (tsc with `noImplicitAny` catches `any`).

## Dependencies

- **sdd-02** (M-0 wire-up) — needs scheduler re-enabled + SurrealDB drift fixed + `memory-migration-surreal.json` marker present. Blocked until sdd-02 `implement` passes.
- **sdd-04** (pre-registered probe) — depends on this spec's `node`/`hyperedge`/`event` tables, `SurrealHypergraphBackend.query`/`expand`/`neighbors`, and the backfill.
- **sdd-05** (M-2 auto-capture) — depends on this spec's schema types + backend.
- **sdd-06** (M-3 lifecycle) — depends on this spec's `LifecycleStatus` enum + `is_live` + `node`/`hyperedge` tables.
- **sdd-07** (M-4 packing) — depends on this spec's `Hypergraph.query`/`expand`.
- **sdd-09** (M-5 conflict, deferred) — depends on this spec's `Hypergraph.neighbors` + bi-temporal `invalidated_by`/`prev_version_id` + `INVALIDATE` event.
