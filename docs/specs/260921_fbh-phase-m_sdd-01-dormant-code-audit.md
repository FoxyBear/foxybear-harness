# SDD-01: P-0 — Dormant-Code Audit

**Date:** 2026-09-21
**Project:** FoxyBear Harness Phase M (`development/foxybear`)
**Status:** Draft (pending independent audit + human gate)
**Source plan:** `docs/specs/260921_fbh-phase-m_sdd-00-master.md` (§Scope SDD-01, §CC-14, §SC-11 A0, §Glossary "P-0 Audit")
**Research:** `docs/research/260921_fbh-phase-m_research.md` (§"Current state of the harness memory system" → "Built but dormant", §"Environmental drift")
**Workstream:** `fbh-phase-m` (`tools/sdd/workstreams/fbh-phase-m.json`)
**Depends on:** nothing — this is the first spec in the workstream

This is the P-0 dormant-code audit. Before any wire-up (SDD-02), two engineers who did NOT author the code SHALL execute every dormant component against ≥10 sample inputs each, validate every output against its declared TS interface, and file every defect in one of four pre-named buckets. The "60% built" claim in the research doc is a static survey. This spec tests it at runtime. It is the cheapest mitigation in the suite (~2 engineer-days) and tests the suite's only empirical premise. Where this spec conflicts with the master, the master wins.

## Scope

In scope (P-0 only):

- Isolated execution audit of 11 dormant components in `packages/fbh/src/memory/`:
  - `Consolidation.extractTurn` (consolidation.ts:594) — per-turn regex extractor
  - `Consolidation.run` (consolidation.ts:533) — orient→gather→consolidate→prune orchestrator
  - `Consolidation.prune` (consolidation.ts:445) — TTL + near-dup (cosine > 0.95) + 200-entry index cap
  - `AutoRecall.autoRecall` (recall.ts:185) — embed + local search + optional workforce + dedup + turn cache
  - `AutoRecall.formatForInjection` (recall.ts:279) — `## Relevant Memories` block formatter
  - `SurrealBackend.query` (surreal-backend.ts:203) — hybrid retrieval: vector + BM25 + 1-hop graph, RRF
  - `SurrealGraphBackend` (graph/surreal-backend.ts:47) — bi-temporal `graph_entity`/`graph_edge` backend
  - `graduateMemories` (graph/graduation.ts:19) — `access_count >= 2` instance→project promotion
  - `Memory` stale penalty (memory.ts:458) — `score *= 0.5` when `ageDays > stalePenaltyDays && accessCount < 2`
  - `Memory.getPrunable` (memory.ts:756) — TTL by `accessed_at`
  - `SurrealBackend.migrateFromSqlite` (surreal-backend.ts:378) — one-shot SQLite→Surreal, idempotent via marker file
- For each component: ≥10 sample inputs, schema-validated outputs, behavior documented against SDD-00 claims.
- Defect log categorized into 4 buckets: (a) broken, (b) schema-violating, (c) semantically-wrong, (d) spec-divergent.
- Go/no-go verdict for M-0 (SDD-02), signed by two engineers who did NOT author the code (CC-14).
- Abort A0 if a core component is non-functional AND estimated repair > 2 engineer-days.

Out of scope (tracked for later phases):

- Any fix to dormant code — P-0 audits, it does not repair. Defects become inputs to M-0 (wire-up), M-1 (schema), or M-3 (lifecycle) depending on bucket and component.
- Any new schema, service, or lifecycle logic — that is M-1 through M-6.
- Any re-implementation of the regex extractor or the hybrid retrieval query — M-2 may swap regex for LLM extraction, but that is a separate spec.
- The `Harness.run` orchestrator at harness.ts:54 (zero call sites) — flagged in research as dormant but out of scope for P-0 because M-0 explicitly does NOT wire `Harness.run` wholesale (master key decision: extract memory bits only). Its dormancy is a non-issue for M-0.
- `Memory.recallWithWorkforce` (memory.ts:783) — flagged dormant in research, but the workforce URL is a config-controlled no-op (`memory.workforce.url` unset). Not a defect; just unused. Excluded.

No spike for this phase. P-0 is an audit of already-built code, not new code.

## WHAT

### Component coverage (11 components)

1. WHEN `Consolidation.extractTurn` (consolidation.ts:594) is executed with ≥10 sample inputs spanning: (a) a preference statement, (b) a correction, (c) a decision, (d) a constraint, (e) a pattern, (f) a slash-command first message (CN-04 skip), (g) an `auto_capture: false` config (CN-06 skip), (h) an empty messages array, (i) a messages array with no user role, (j) a messages array where user parts have `text` not `content` (the MessageV2 shape — verifies the wire-up adapter SDD-02 §HOW D is required), (k) a timeout forcing `timeoutMs: 1` on a slow-match input, the audit SHALL record observed behavior for each input: returned `void`, whether `Memory.store` was called, and the `metadata.source` value on any stored row (CN-03 at consolidation.ts:589 — SHALL be `"extraction"`).
2. WHEN `Consolidation.run` (consolidation.ts:533) is executed with ≥10 sample inputs spanning: (a) empty `recentSessionIds`, (b) a single session ID, (c) 50 session IDs, (d) a `lockDir` already locked (verifies CN-14 lock contention behavior), (e) `persona: "default"`, (f) a custom persona, (g) a config missing `memory.ttl_days` (verifies fallback to 90), (h) a config with `ttl_days: 0`, (i) a config with `ttl_days: 365`, (j) a gather phase that returns zero candidates, the audit SHALL record observed behavior for each input: returned `ConsolidationResult` (consolidation.ts:731-737), lock creation at start, lock removal in `finally`, and `durationMs` > 0.
3. WHEN `Consolidation.prune` (consolidation.ts:445) is executed with ≥10 sample inputs spanning: (a) an empty `MemoryTopicsTable`, (b) a single row younger than TTL, (c) a single row older than TTL with `access_count < 3`, (d) a single row older than TTL with `access_count >= 3` (verifies the keep condition at consolidation.ts:462), (e) two rows with cosine > 0.95 (verifies near-dup merge — the more recently accessed survives), (f) two rows with cosine < 0.95 (both survive), (g) a `MemoryIndexTable` with 201 entries (verifies the 200-entry cap at consolidation.ts:504 — the lowest-`access_count` entry is removed), (h) a `MemoryIndexTable` with 200 entries (no removal), (i) a `MemoryIndexTable` with 200 entries where multiple entries share the lowest `access_count` (verifies the `time_created` tiebreaker at consolidation.ts:513), (j) a config with `ttl_days: 1` against rows 2 days old, the audit SHALL record observed behavior for each input: returned `PruneResult` (consolidation.ts:763-767) with `pruned`, `nearDupsMerged`, `indexRemoved` counts matching the table state after execution.
4. WHEN `AutoRecall.autoRecall` (recall.ts:185) is executed with ≥10 sample inputs spanning: (a) a query matching a stored memory, (b) a query with no match, (c) a slash-command query `/help` (AR-02 skip — returns `[]`), (d) the same query twice in the same turn (AR-03/08 cache hit — second call returns cached results without re-embedding), (e) an embedding provider failure (AR-07 graceful degradation — returns `[]` and logs error), (f) a `workforceUrl` set against an unreachable endpoint (AR-11 graceful degradation — returns local results only, logs warn), (g) a `workforceUrl` set against a reachable endpoint returning results (AR-10/12 — local + workforce merged and deduped), (h) a `project_id` set with no project-scoped memories (verifies global scope fallback), (i) a `project_id` set with project-scoped memories, (j) a `requestor_elevated: true` input (verifies the forward-compat log line at recall.ts:194 — no behavioral effect), the audit SHALL record observed behavior for each input: returned `MemoryResult[]` (memory.ts:33 + backend.ts:68), turn cache state (recall.ts:201) after each call, and whether the embedding provider was actually called (verifies cache hit).
5. WHEN `AutoRecall.formatForInjection` (recall.ts:279) is executed with ≥10 sample inputs spanning: (a) an empty results array (AR-14 — returns `""`), (b) a single result with `created_at` 1 day ago (no staleness warning), (c) a single result with `created_at` older than `stale_warning_days` (AR-13 — appends `(memory from N days ago — verify before acting)`), (d) five results of mixed age, (e) a `degraded: true` opt (verifies the `> Note: Project/global memories unavailable...` line at recall.ts:290), (f) a result with `source: "local"`, (g) a result with `source: "workforce"`, (h) a result with `created_at: "0"` (verifies `formatDate` returns `"unknown"` at recall.ts:329), (i) a result with `created_at: ""` (same path), (j) a result with `created_at` of a valid timestamp, the audit SHALL record observed behavior for each input: returned `string`, presence of `## Relevant Memories` header, numbered entry format `${i+1}. [${createdDate}, ${source}] ${content}`, and the staleness suffix when applicable.
6. WHEN `SurrealBackend.query` (surreal-backend.ts:203) is executed with ≥10 sample inputs spanning: (a) a vector-only hit (semantic leg returns matches, keyword and graph empty), (b) a keyword-only hit (keyword leg matches, semantic and graph empty), (c) a graph-leg hit (1-hop co-mention via `mentions` — requires seeded `entity` + `mentions` relations), (d) a fused three-leg result (verifies RRF at surreal-backend.ts:261 combines ranks with `RRF_K = 60`), (e) `scope: "instance"`, (f) `scope: "project"` with `project_id` set, (g) `scope: "global"`, (h) `scope: "all"`, (i) `as_of` ISO timestamp set (verifies the temporal filter at surreal-backend.ts:242 — only edges valid at that point contribute), (j) `limit: 5` against 50 matching rows (verifies the limit is applied after RRF, not before), the audit SHALL record observed behavior for each input: returned `MemoryResult[]` (backend.ts:68-79), the three leg rankings (`semanticRanking`, `keywordRanking`, `graphRanking` at surreal-backend.ts:226/234/258), and the final fused order. The graph leg may return empty when no entities are seeded — the audit SHALL record this as expected (comment at surreal-backend.ts:256), NOT as a defect.
7. WHEN `SurrealGraphBackend` (graph/surreal-backend.ts:47) is executed with ≥10 sample inputs spanning across its `GraphBackend` interface (backend.ts:23-64): (a) `upsertEntity` for a new entity, (b) `upsertEntity` for an existing entity by name (verifies in-place update preserves `valid_from` per SG-01 at surreal-backend.ts:113-115), (c) `findEntitiesByName` with a match, (d) `findEntitiesByName` with no match, (e) `searchEntities` with an embedding query (verifies cosine ranking), (f) `addEdge` between two existing entities, (g) `invalidateEdge` setting `invalid_from` (verifies bi-temporal soft-delete), (h) `getEdgesFrom` with `valid_only: true` (verifies invalidated edges are excluded), (i) `traverse` with `max_hops: 2` over a seeded 3-entity chain, (j) `query` with both embedding and keyword, the audit SHALL record observed behavior for each input: returned `GraphEntity` / `GraphEdge` / `TraversalResult[]` / `GraphQueryResult` (graph/types.ts:5-42), bi-temporal fields (`valid_from`, `invalid_from`) populated correctly, and `healthy()` returning true after `init()`.
8. WHEN `graduateMemories` (graph/graduation.ts:19) is executed with ≥10 sample inputs spanning: (a) no eligible memories (`access_count < 2` for all — returns `{ promoted: 0, ... }` and logs `graduation: no eligible memories`), (b) a single eligible memory with one entity (verifies the new entity is created in the project graph), (c) an eligible memory with an entity that already exists in the project graph (verifies the upsert path at graduation.ts:84), (d) an eligible memory with a contradiction (cosine < 0.3 against the existing entity embedding — verifies `contradictions_handled++` and old edge invalidation at graduation.ts:74-82), (e) an eligible memory with a `SUPERSEDES` relationship (verifies `supersessions_handled++` at graduation.ts:120), (f) an eligible memory whose embedding fails (verifies the `try {} catch {}` at graduation.ts:88-90 — entity created without embedding), (g) two eligible memories in the same project, (h) an eligible memory with `extractEntitiesAndRelations` returning zero entities (verifies the `continue` at graduation.ts:59), (i) an eligible memory whose `Memory.store` throws (verifies the per-candidate try/catch at graduation.ts:124-129 — other candidates still process), (j) two eligible memories across two `project_id`s (verifies project isolation), the audit SHALL record observed behavior for each input: returned `GraduationResult` (graduation.ts:11-17) with `promoted`, `entities_created`, `edges_created`, `contradictions_handled`, `supersessions_handled` counts matching the resulting graph state.
9. WHEN the `Memory` stale penalty (memory.ts:458) is executed via `Memory.recall` (the score-modification path containing the `score *= 0.5` branch) with ≥10 sample inputs spanning: (a) a memory older than `stalePenaltyDays` with `access_count < 2` (verifies `score *= 0.5` fires), (b) a memory older than `stalePenaltyDays` with `access_count = 2` (verifies the penalty does NOT fire — condition is `accessCount < 2`), (c) a memory older than `stalePenaltyDays` with `access_count = 5` (no penalty), (d) a memory younger than `stalePenaltyDays` with `access_count < 2` (no penalty), (e) a memory exactly at `stalePenaltyDays` boundary (verifies `>` strict — no penalty at equality), (f) a memory 1ms past the `stalePenaltyDays` boundary (penalty fires), (g) a config with `stale_penalty_days: 0` against a 1-day-old memory (penalty fires), (h) a config with `stale_penalty_days: 365` against a 30-day-old memory (no penalty), (i) two memories, one stale and one fresh, in the same recall call (verifies the ranking reorders — stale memory sinks), (j) a memory with `access_count: 0` (verifies `row.access_count ?? 0` fallback at memory.ts:456 — penalty fires if stale), the audit SHALL record observed behavior for each input: the `score` value before and after the penalty branch, and whether the branch fired (confirmed by `score_after / score_before === 0.5` for the stale-low-access case).
10. WHEN `Memory.getPrunable` (memory.ts:756) is executed with ≥10 sample inputs spanning: (a) `ttl_days: 90` against rows all younger than 90 days (returns `[]`), (b) `ttl_days: 90` against one row 91 days old by `accessed_at` (returns that row), (c) `ttl_days: 0` (verifies all rows are prunable — `cutoff = now`), (d) `ttl_days: 36500` (100 years — no rows are prunable), (e) a config with no `ttl_days` set (verifies the `cfg.ttlDays` fallback at memory.ts:758), (f) a row with `accessed_at: 0` (verifies the `Number(0) < cutoff` comparison at memory.ts:774 — returns the row), (g) a row with `accessed_at: null` (verifies the comparison against null — null coerces to 0, row is prunable), (h) the SurrealBackend registered as the global backend (verifies the dispatch at memory.ts:761-765 calls `backend.getPrunable(ttl)` and maps via `backendResultToEntry`), (i) no global backend registered (verifies the legacy SQLite path at memory.ts:767-778), (j) `ttl_days: 7` against rows 8 days old, the audit SHALL record observed behavior for each input: returned `MemoryEntry[]` (memory.ts:22-31) and whether the dispatch hit the SurrealBackend or SQLite path.
11. WHEN `SurrealBackend.migrateFromSqlite` (surreal-backend.ts:378) is executed with ≥10 sample inputs spanning: (a) a fresh state with marker absent and 0 SQLite rows (returns `{ ran: true, memories: 0, entities: 0, edges: 0, ... }` — creates marker), (b) marker present (returns `{ ran: false, memories: 0, ... }` at surreal-backend.ts:386 — idempotent), (c) marker absent with 1 SQLite memory row (the Phase A rebrand memory — verifies it migrates to Surreal `memory` table), (d) marker absent with 1 memory row whose `embedding` is a Buffer (verifies `bufferToFloat32` at surreal-backend.ts:407), (e) marker absent with 1 memory row whose `embedding` is null (verifies the fallback `new Float32Array(0)` at surreal-backend.ts:407), (f) marker absent with a `project_id: "global"` memory row (verifies `scope: "global"` mapping at surreal-backend.ts:411), (g) marker absent with a project-scoped memory row (verifies `scope: "project"` mapping), (h) marker absent with 1 entity row (verifies `entity:⟨id⟩` creation with angle-bracket ULID escape at surreal-backend.ts:451), (i) marker absent with 1 edge row (verifies the `RELATE` query at surreal-backend.ts:463), (j) marker absent with a memory row whose `time_created` is null (verifies the `new Date().toISOString()` fallback at surreal-backend.ts:425), the audit SHALL record observed behavior for each input: returned `MigrationReport` (backend.ts:88-95) with `memories`, `entities`, `edges`, `duration_ms`, `ran` fields matching the actual rows migrated, the marker file presence after execution, and the resulting Surreal `memory`/`entity`/`relates` table row counts.

### Schema validation (cross-cutting)

12. WHEN each component returns, the audit SHALL validate the output against the component's declared TS interface: `ConsolidationResult` (consolidation.ts:731), `PruneResult` (consolidation.ts:763), `MemoryResult[]` (memory.ts:33 + backend.ts:68), `string` with the documented `## Relevant Memories` format (recall.ts:272-277), `GraphEntity`/`GraphEdge`/`TraversalResult[]`/`GraphQueryResult` (graph/types.ts:5-42), `GraduationResult` (graduation.ts:11), `MemoryEntry[]` (memory.ts:22), `MigrationReport` (backend.ts:88). Validation SHALL use `Schema.is` from `@effect/schema` against a schema derived from the declared interface, or a hand-written type guard that exercises every field. A returned value that matches the TS interface at compile time but fails at runtime (e.g., `created_at: number` where the interface says `string`) SHALL be filed in bucket (b) schema-violating.

### Defect categorization (cross-cutting)

13. WHEN a component's observed behavior diverges from its declared schema or the spec claim in SDD-00, the audit SHALL file a defect entry in exactly one of four buckets:
    - (a) **broken** — the component throws, crashes, hangs past its documented timeout, or returns no value at all.
    - (b) **schema-violating** — the component returns a value that does not match its declared TS interface (runtime shape mismatch, missing field, wrong type).
    - (c) **semantically-wrong** — the component returns the right shape but wrong content (e.g., `prune` returns `pruned: 0` when there were prunable rows; `autoRecall` returns cached results for a different query).
    - (d) **spec-divergent** — the component's behavior matches its schema but diverges from the spec claim in SDD-00 (e.g., the master says hybrid retrieval does RRF fusion of three legs; the code actually drops the graph leg when empty in a way that changes the ranking).
    Each defect entry SHALL record: component, anchor (file:line), sample input index, observed output, expected output (citing the spec clause or schema field), bucket, and the auditor's name.

### Two-engineer sign-off (CC-14)

14. WHEN the audit begins, two engineers who did NOT author the dormant code SHALL be assigned. The audit SHALL verify non-authorship by checking the git blame log for each component's anchor line — if either engineer appears as the author of any of the 11 anchor lines (consolidation.ts:445/533/594, recall.ts:185/279, surreal-backend.ts:42/203/378, graph/surreal-backend.ts:47, graph/graduation.ts:19, memory.ts:458/756), that engineer SHALL be recused from that component and a third engineer SHALL audit it instead. The author's assertion is not verification.
15. WHEN both engineers have completed their independent audits of all 11 components, they SHALL cross-review each other's defect logs. Any disagreement about bucket assignment or defect severity SHALL be escalated to a third engineer (the tiebreaker) whose decision is final. Both engineers SHALL sign the final defect log. The signature block SHALL record: engineer name, recused components (if any), date, and verdict (go / no-go / A0-abort).

### Decision log (CC-11)

16. WHEN the audit completes, the raw results SHALL be written to `docs/decisions/260921_fbh-phase-m_p0-dormant-code-audit.md` per the AGENTS.md naming convention. The decision log SHALL contain: (a) the full defect log with every sample input, every observed output, every defect entry (failures included — no sanitization), (b) the schema validation results per component, (c) the two-engineer signature block, (d) the go/no-go verdict, (e) any A0-abort firing with justification. The decision log SHALL NOT be edited after signature — any post-signature correction SHALL be filed as a separate errata entry appended below the signature block.

### Go/no-go verdict

17. WHEN all 11 components have been audited and the defect log is complete, the audit SHALL issue one of three verdicts:
    - **GO** — zero defects in bucket (a) broken for any core component (see WHAT #18 for the core list), AND ≤ 5 defects total across buckets (b)+(c)+(d) for core components. M-0 (SDD-02) may proceed; defects flow to their respective downstream phases (M-0 wire-up, M-1 schema, M-3 lifecycle) as fix-list items.
    - **GO-WITH-CAVEATS** — defects in bucket (a) for one or more non-core components (lifecycle scaffold: prune, getPrunable, graduateMemories, stale penalty), AND zero defects in bucket (a) for core components. M-0 may proceed; the lifecycle defects flow to M-3 as fix-list items and M-3 SHALL address them before its wire-up.
    - **NO-GO** — defects in bucket (a) for one or more core components AND total estimated repair ≤ 2 engineer-days. M-0 SHALL NOT proceed. The defects SHALL be repaired in P-0 follow-up (a separate workstream entry, not M-0), re-audited by two new engineers, and the verdict re-issued.

### Abort A0 (SC-11)

18. WHEN a core component — `SurrealBackend` (surreal-backend.ts:42), `SurrealGraphBackend` (graph/surreal-backend.ts:47), `AutoRecall.autoRecall` (recall.ts:185), `AutoRecall.formatForInjection` (recall.ts:279), `Consolidation.extractTurn` (consolidation.ts:594), `Consolidation.run` (consolidation.ts:533), or `SurrealBackend.migrateFromSqlite` (surreal-backend.ts:378) — is non-functional (bucket (a) broken for ≥ 50% of its ≥10 sample inputs) AND the repair estimate, produced independently by both audited engineers and averaged, exceeds 2 engineer-days, abort **A0** SHALL fire. The audit SHALL halt, the human gate SHALL re-convene, and the program SHALL be re-baselined before M-0. The floor (M-0 + baseline-retrieval injection behind flag) is not at risk unless A0 fires — A0 is the only abort that blocks the floor, and it only fires when a core component is structurally broken beyond a 2-day repair.

### Workstream ordering

19. WHEN SDD-01 completes, the workstream pipeline SHALL refuse to advance to SDD-02 (M-0 wire-up) unless the verdict is GO or GO-WITH-CAVEATS. A NO-GO verdict SHALL block SDD-02 until the defects are repaired and re-audited. An A0-abort SHALL halt the workstream entirely and require a human-gate restart with a re-baselined program.
20. WHEN the audit runs, it SHALL NOT modify any source file under `packages/fbh/src/`. The audit reads code, executes it against sample inputs, and writes results to `docs/decisions/`. Any source modification during P-0 is a process violation — P-0 audits, it does not repair.

### Audit harness gates (CC-4)

21. WHEN the audit harness files are added under `packages/fbh/test/p0_audit/` (the test files, fixture loaders, and any helper utilities), the audit SHALL run `bun run typecheck` from `packages/fbh` and the harness SHALL pass with exit 0 (CC-4). No new type errors SHALL be introduced by the audit harness. A typecheck failure in the harness files SHALL be filed as a process defect and SHALL block the verdict until the harness is corrected.

22. WHEN the audit harness files are added, the audit SHALL run `bun test test/p0_audit/ --timeout 60000` from `packages/fbh` and the harness SHALL exit 0 (CC-4). The harness records observed behavior for every input — it does NOT assert spec correctness (that's the audit's job in the decision log). All 11 component audit files SHALL execute; every component's ≥10 inputs SHALL run (some may be documented skips — those still execute and record the skip behavior). A harness-level test failure (e.g., a fixture fails to load, a component import resolves to `undefined`) SHALL block the verdict until the harness is corrected; component-level behavioral defects are recorded in the decision log, not as test failures.

## HOW

### Audit team

Two engineers, neither of whom authored any of the 11 dormant components. Non-authorship SHALL be verified by `git blame -L <anchor>,<anchor> <file>` for each anchor line. If the audit team is short-staffed (only one eligible engineer available), the audit SHALL be deferred until a second engineer is available — single-engineer audit is not verification (CC-14).

### Sample input strategy

For each component, the audit SHALL construct ≥10 sample inputs. Inputs SHALL cover:

1. **The happy path** — at least 2 inputs that exercise the documented success behavior.
2. **Each documented skip/guard** — at least 1 input per documented guard (CN-04 slash skip, CN-06 config skip, AR-02 slash skip, AR-07/11 graceful degradation, etc.). Cite the spec clause each guard implements.
3. **Boundary conditions** — at least 2 inputs at the boundary of a threshold (`> stalePenaltyDays` vs `=`, `> 0.95` cosine vs `=`, `> MAX_INDEX_ENTRIES` vs `=`, `> ttl_days` vs `=`).
4. **Empty / null / malformed** — at least 2 inputs with empty arrays, null fields, or wrong shapes (the MessageV2 shape in WHAT #1(j) is the canonical example).
5. **Cross-configurations** — at least 2 inputs that combine multiple variables (e.g., `scope: "all"` + `project_id` set + `as_of` set for `SurrealBackend.query`).

The full input fixtures SHALL be committed to `packages/fbh/test/p0_audit/fixtures/` before the audit runs, so the same inputs can be re-used by the re-audit if A0 fires or by the M-0 regression suite.

### Schema validation

For each component, the audit SHALL validate the runtime output against the declared TS interface. Validation SHALL use one of:

- **`Schema.is`** from `@effect/schema` — derive a `Schema.Struct` from the declared interface, then `Schema.is(DeclaredSchema)(output)` returns a runtime type guard. This is the preferred path because Effect/Schema is already a dependency.
- **A hand-written type guard** that exercises every field of the interface — required when the interface includes `Record<string, unknown>` (e.g., `MemoryResult.metadata`) where `Schema.is` cannot enforce inner shape.

A returned value that passes the type guard SHALL be marked schema-valid. A returned value that fails SHALL be filed in bucket (b) schema-violating, with the failing field and expected type recorded in the defect entry.

### Defect bucket assignment

Each defect SHALL be assigned to exactly one bucket. The audit SHALL use this decision tree:

1. Did the component throw, crash, hang past its documented timeout, or return no value? → **(a) broken**.
2. Did the component return a value that fails the runtime type guard? → **(b) schema-violating**.
3. Did the component return a schema-valid value but with wrong content (the value contradicts what the spec or the input says it should contain)? → **(c) semantically-wrong**.
4. Did the component return a schema-valid, content-correct value but its overall behavior diverges from the spec claim in SDD-00 (e.g., the spec says RRF, the code actually does a weighted sum; the spec says `access_count >= 2`, the code actually uses `> 2`)? → **(d) spec-divergent**.
5. None of the above? → No defect filed.

When two engineers disagree on bucket assignment, the tiebreaker engineer SHALL decide. The disagreement SHALL be recorded in the decision log under a "Disputes" section, with the two engineers' reasoning and the tiebreaker's ruling.

### Two-engineer sign-off (CC-14)

Both engineers SHALL:

1. Independently execute all 11 component audits using the shared input fixtures. The audits SHALL run in parallel — engineers SHALL NOT share observed outputs until both have completed their independent runs.
2. Cross-review each other's defect logs. Each engineer SHALL read the other's defect entries and either concur or file a dispute.
3. Resolve disputes via the tiebreaker engineer. The tiebreaker SHALL be a third engineer who also did not author the dormant code (verified by the same `git blame` check). The tiebreaker's ruling is final.
4. Sign the final defect log. The signature block SHALL record: engineer name, recused components, date, verdict.

The audit SHALL NOT be considered complete until both signatures are recorded in the decision log. A single-engineer audit is a process violation — it is not verification (CC-14).

### Decision log (CC-11)

The audit SHALL write its raw results to `docs/decisions/260921_fbh-phase-m_p0-dormant-code-audit.md` per the AGENTS.md naming convention (`yymmdd_<project_name>_<descriptive_name>.md`). The decision log SHALL contain, in order:

1. **Header** — date, project, auditors, recused components, tiebreaker (if any).
2. **Per-component findings** — for each of the 11 components: the anchor, the schema validated against, the ≥10 sample inputs (with fixtures file paths), the observed outputs (full, unsanitized), the schema validation results, and any defect entries.
3. **Defect log** — every defect filed, with component, anchor, sample input index, observed output, expected output (citing the spec clause or schema field), bucket, auditor name.
4. **Disputes** — any bucket-assignment or severity disagreement, with both engineers' reasoning and the tiebreaker's ruling.
5. **Verdict** — GO / GO-WITH-CAVEATS / NO-GO, with justification citing the defect counts and the verdict rule from WHAT #17.
6. **A0-abort** — if fired, the trigger component, the failure rate, the two engineers' repair estimates, and the averaged estimate > 2 engineer-days.
7. **Signatures** — both engineers' names, recused components, dates, and verdict. The tiebreaker's signature (if any disputes were resolved) appended below.
8. **Errata** — appended only if a post-signature correction is needed; never edits the signed content above.

The decision log SHALL be committed to git with the message `docs(decisions): P-0 dormant-code audit — <verdict>`. Failures SHALL NOT be sanitized — CC-11 requires raw results, including every broken-component output and every schema-violating field.

### Core vs non-core classification

For the abort A0 rule (WHAT #18) and the verdict rule (WHAT #17), the 11 components SHALL be classified:

- **Core (7)** — required for M-0 wire-up. A0-eligible:
  - `SurrealBackend` (surreal-backend.ts:42) — the storage backend M-0 wires.
  - `SurrealBackend.migrateFromSqlite` (surreal-backend.ts:378) — the data bridge M-0 runs.
  - `SurrealGraphBackend` (graph/surreal-backend.ts:47) — the graph backend M-0 keeps.
  - `AutoRecall.autoRecall` (recall.ts:185) — the pre-prompt path M-0 wires.
  - `AutoRecall.formatForInjection` (recall.ts:279) — the injection formatter M-0 wires.
  - `Consolidation.extractTurn` (consolidation.ts:594) — the post-turn path M-0 wires.
  - `Consolidation.run` (consolidation.ts:533) — the scheduler-driven pipeline M-0 re-enables.

- **Non-core (4)** — lifecycle scaffold. M-0 wires these but their failure does not block M-0; defects flow to M-3 (lifecycle):
  - `Consolidation.prune` (consolidation.ts:445) — TTL + near-dup + index cap.
  - `graduateMemories` (graph/graduation.ts:19) — access_count >= 2 promotion.
  - `Memory` stale penalty (memory.ts:458) — score *= 0.5.
  - `Memory.getPrunable` (memory.ts:756) — TTL by accessed_at.

### Execution environment

The audit SHALL run against a live SurrealDB instance at `~/.local/share/foxybear/memory-server` (the foxybear path, not the opencode drift path — the audit SHALL verify the path before running, per research §"Environmental drift"). The audit SHALL use a real DeepInfra embedding provider key (the existing `~/.config/foxybear/fbh.json` embedding config) — no mocks (CC-5: real verification, no mocks). The audit SHALL seed the SQLite `MemoryTopicsTable` with the existing 1 row (the Phase A rebrand memory) plus any audit-specific fixtures, and SHALL snapshot the database before and after each component execution to verify side effects.

### Test location

The audit's test fixtures and execution harness SHALL live in `packages/fbh/test/p0_audit/` (run from `packages/fbh` per AGENTS.md: "Tests cannot run from repo root"). The harness SHALL be a single `bun test` file (`p0_audit.test.ts`) that imports the dormant components directly from `src/memory/` and executes them against the fixtures. No mocks of our code (CC-5) — the audit tests the real implementation.

### Time budget

The audit is budgeted at ~2 engineer-days (per SDD-00 §Scope). The budget SHALL be tracked:

- 0.5 engineer-day: fixture construction (shared between both engineers).
- 1.0 engineer-day: parallel execution of all 11 component audits (0.5 engineer-day per engineer, parallel).
- 0.25 engineer-day: cross-review and dispute resolution.
- 0.25 engineer-day: decision log write-up and signature.

If the audit exceeds 3 engineer-days (50% over budget), the audit SHALL halt and the human gate SHALL be convened — the over-budget signal is itself a finding about the dormant code's complexity.

## VERIFY

Acceptance criteria mapped 1:1 to WHAT. All tests run from `packages/fbh` (CC-4 / AGENTS.md). No mocks of implementation under test (CC-5).

| # | WHAT | Setup | Action | Expected |
|---|---|---|---|---|
| V1 | #1 (extractTurn) | Fixtures at `test/p0_audit/fixtures/extract_turn/` covering 11 inputs (a-k). Both engineers have run `git blame -L 594,594 src/memory/consolidation.ts` and confirmed neither appears as author. | Each engineer independently runs `bun test test/p0_audit/extract_turn.test.ts` from `packages/fbh`. | For each of 11 inputs: observed behavior recorded. Inputs (f), (g), (h), (i), (k) SHALL be documented as skips/degradations (not defects). Inputs (a-e) SHALL store memories with `metadata.source === "extraction"`. Input (j) SHALL extract zero facts (silent — verifies SDD-02 §HOW D adapter is required). |
| V2 | #2 (Consolidation.run) | Fixtures at `test/p0_audit/fixtures/run/` covering 10 inputs (a-j). A live SurrealDB at the foxybear path. SQLite seeded with at least 1 memory row. | Each engineer independently runs `bun test test/p0_audit/run.test.ts`. | For each of 10 inputs: returned `ConsolidationResult` matches the declared interface (consolidation.ts:731). Lock file created at start, removed in `finally`. `durationMs` > 0. Input (a) (empty `recentSessionIds`) SHALL produce `merged: 0, created: 0` — the gather phase has no candidates. Input (d) (lock contention) SHALL be documented — the lock semantics are not explicitly specced, so behavior is recorded, not filed as defect unless broken. |
| V3 | #3 (prune) | Fixtures at `test/p0_audit/fixtures/prune/` covering 10 inputs (a-j). SQLite seeded per input. | Each engineer independently runs `bun test test/p0_audit/prune.test.ts`. | For each of 10 inputs: returned `PruneResult` matches the declared interface (consolidation.ts:763). Inputs (c), (g), (j) SHALL produce `pruned > 0`. Input (d) SHALL produce `pruned: 0` (keep condition met). Input (e) SHALL produce `nearDupsMerged: 1` and the more recently accessed row survives. Input (g) SHALL produce `indexRemoved: 1`. |
| V4 | #4 (autoRecall) | Fixtures at `test/p0_audit/fixtures/auto_recall/` covering 10 inputs (a-j). Real DeepInfra key. SurrealDB seeded per input. | Each engineer independently runs `bun test test/p0_audit/auto_recall.test.ts`. | For each of 10 inputs: returned `MemoryResult[]` matches the declared interface (memory.ts:33 + backend.ts:68). Input (c) returns `[]`. Input (d) (cache hit) — second call SHALL NOT invoke the embedding provider (verified by a provider call counter). Input (e) (embedding failure) returns `[]` and logs error. Input (f) (workforce unreachable) returns local results only. Input (g) (workforce reachable) returns merged results. |
| V5 | #5 (formatForInjection) | Fixtures at `test/p0_audit/fixtures/format/` covering 10 inputs (a-j). Pure function — no DB. | Each engineer independently runs `bun test test/p0_audit/format.test.ts`. | For each of 10 inputs: returned `string`. Input (a) returns `""`. Input (c) appends the staleness suffix. Input (e) prepends the degraded note. Input (h)/(i) — `created_at: "0"` or `""` — `formatDate` returns `"unknown"`. Schema validation: output is a `string`, possibly empty. |
| V6 | #6 (SurrealBackend.query) | Fixtures at `test/p0_audit/fixtures/surreal_query/` covering 10 inputs (a-j). SurrealDB seeded with `memory` + `entity` + `mentions` rows per input. | Each engineer independently runs `bun test test/p0_audit/surreal_query.test.ts`. | For each of 10 inputs: returned `MemoryResult[]` matches the declared interface. Inputs (a-c) exercise each leg in isolation. Input (d) — fused result — verifies RRF combines the three leg rankings. Inputs (e-h) — scope permutations — verify the `scopeClause` at surreal-backend.ts:208-211. Input (i) — `as_of` — verifies the temporal filter. Input (j) — `limit: 5` — verifies the limit is applied after RRF. |
| V7 | #7 (SurrealGraphBackend) | Fixtures at `test/p0_audit/fixtures/graph/` covering 10 inputs (a-j). SurrealDB at the foxybear path. | Each engineer independently runs `bun test test/p0_audit/graph.test.ts`. | For each of 10 inputs: returned `GraphEntity` / `GraphEdge` / `TraversalResult[]` / `GraphQueryResult` matches the declared interfaces (graph/types.ts:5-42). Bi-temporal fields populated. `healthy()` returns true after `init()`. Input (b) — upsert existing — preserves `valid_from`. Input (g) — `invalidateEdge` — sets `invalid_from`. Input (h) — `valid_only: true` — excludes invalidated edges. Input (i) — `traverse max_hops: 2` — returns the 3-entity chain. |
| V8 | #8 (graduateMemories) | Fixtures at `test/p0_audit/fixtures/graduation/` covering 10 inputs (a-j). SQLite + graph backend seeded per input. | Each engineer independently runs `bun test test/p0_audit/graduation.test.ts`. | For each of 10 inputs: returned `GraduationResult` matches the declared interface (graduation.ts:11). Input (a) returns `promoted: 0` and logs `graduation: no eligible memories`. Input (d) — contradiction — `contradictions_handled: 1` and old edges invalidated. Input (e) — SUPERSEDES — `supersessions_handled: 1`. Input (f) — embedding failure — entity created without embedding. Input (i) — `Memory.store` throws — other candidates still process (per-candidate try/catch). |
| V9 | #9 (stale penalty) | Fixtures at `test/p0_audit/fixtures/stale/` covering 10 inputs (a-j). SQLite seeded with rows of varying age and access_count. | Each engineer independently runs `bun test test/p0_audit/stale.test.ts`. | For each of 10 inputs: the `score` before and after the penalty branch recorded. Input (a) — `score_after / score_before === 0.5`. Input (b) — penalty does NOT fire (`score_after === score_before`). Input (e) — boundary `=` — penalty does NOT fire (`>` strict). Input (f) — 1ms past boundary — penalty fires. Input (i) — stale + fresh in same recall — stale memory sinks in ranking. |
| V10 | #10 (getPrunable) | Fixtures at `test/p0_audit/fixtures/prunable/` covering 10 inputs (a-j). SQLite seeded per input. SurrealBackend registered as global backend for inputs (h); not registered for inputs (i). | Each engineer independently runs `bun test test/p0_audit/prunable.test.ts`. | For each of 10 inputs: returned `MemoryEntry[]` matches the declared interface (memory.ts:22). Input (a) returns `[]`. Input (b) returns the 91-day-old row. Input (c) returns all rows. Input (d) returns `[]`. Input (h) — dispatch hits SurrealBackend — `backend.getPrunable(ttl)` called. Input (i) — legacy SQLite path — direct query against `MemoryTopicsTable`. |
| V11 | #11 (migrateFromSqlite) | Fixtures at `test/p0_audit/fixtures/migrate/` covering 10 states (a-j). Marker file managed per input (delete between runs). SQLite seeded per input. | Each engineer independently runs `bun test test/p0_audit/migrate.test.ts`. | For each of 10 inputs: returned `MigrationReport` matches the declared interface (backend.ts:88). Input (a) — `ran: true`, marker created. Input (b) — `ran: false` at surreal-backend.ts:386. Input (c) — the Phase A rebrand memory migrates. Input (d) — Buffer embedding roundtrips via `bufferToFloat32`. Input (h) — entity row migrates with angle-bracket ULID escape. Input (i) — edge row migrates via `RELATE`. |
| V12 | #12 (schema validation) | All 11 component test files complete. | Aggregate the schema validation results across all components. | For each component, every output that passed the runtime type guard is marked schema-valid. Every output that failed is filed in bucket (b) schema-violating with the failing field and expected type. Schema validation results recorded in the decision log per component. |
| V13 | #13 (defect categorization) | All 11 component test files complete. Schema validation complete. | Aggregate defects across all components and assign each to exactly one bucket using the decision tree in HOW. | Every defect entry records: component, anchor, sample input index, observed output, expected output (citing spec clause or schema field), bucket, auditor name. No defect is uncategorized. No defect is in two buckets. |
| V14 | #14 (non-authorship) | Both engineers assigned. | Run `git blame -L <anchor>,<anchor> <file>` for each of the 11 anchor lines. | Neither engineer appears as the author of any anchor line. If either does, that engineer is recused from that component and a third engineer audits it. Recusals recorded in the decision log. |
| V15 | #15 (sign-off) | Both engineers complete independent audits. Cross-review complete. Disputes resolved by tiebreaker. | Both engineers sign the final defect log. | Signature block records: engineer name, recused components, date, verdict. Both signatures present. Tiebreaker signature present if any disputes. Single-engineer signature is a process violation — V15 fails. |
| V16 | #16 (decision log) | Audit complete. Signatures recorded. | Write the decision log to `docs/decisions/260921_fbh-phase-m_p0-dormant-code-audit.md`. | The decision log contains all 8 sections (header, per-component findings, defect log, disputes, verdict, A0-abort if any, signatures, errata if any). Failures are NOT sanitized. The decision log is committed to git with the message `docs(decisions): P-0 dormant-code audit — <verdict>`. |
| V17 | #17 (verdict) | All defects filed and bucketed. Both engineers' verdicts recorded. | Issue the verdict per the rule in WHAT #17. | Verdict is one of GO / GO-WITH-CAVEATS / NO-GO. Verdict rule applied correctly: GO requires zero bucket (a) defects in core components AND ≤ 5 defects in buckets (b)+(c)+(d) for core components. GO-WITH-CAVEATS requires zero bucket (a) in core AND bucket (a) in one or more non-core. NO-GO requires bucket (a) in one or more core components AND total repair ≤ 2 engineer-days. |
| V18 | #18 (A0-abort) | A core component is broken for ≥ 50% of its ≥10 sample inputs. | Both engineers independently estimate the repair in engineer-days. Estimates averaged. | If averaged estimate > 2 engineer-days, A0 fires. The audit halts. The human gate re-convenes. The program is re-baselined before M-0. The floor (M-0 + baseline-retrieval injection behind flag) is not at risk unless A0 fires. A0 firing recorded in the decision log with trigger component, failure rate, both estimates, and averaged estimate. |
| V19 | #19 (workstream ordering) | Audit complete. Verdict issued. | The workstream pipeline checks the verdict. | If GO or GO-WITH-CAVEATS, SDD-02 (M-0 wire-up) may proceed. If NO-GO, SDD-02 is blocked until defects repaired and re-audited. If A0-abort, the workstream halts and requires a human-gate restart. |
| V20 | #20 (no source modification) | Audit begins. | The audit runs. | `git diff --stat packages/fbh/src/` after the audit SHALL show no modifications. Any source modification during P-0 is a process violation — V20 fails. The audit reads code and writes to `docs/decisions/` only. |
| V21 | #21 (typecheck gate) | Audit harness files added under `packages/fbh/test/p0_audit/`. | Run `bun run typecheck` from `packages/fbh`. | Exit 0. The audit harness files pass typecheck. No new type errors. |
| V22 | #22 (test suite gate) | Audit harness files added. | Run `bun test test/p0_audit/ --timeout 60000` from `packages/fbh`. | All 11 component audit files run. Every component's ≥10 inputs execute (some may be documented skips — those still execute and record the skip behavior). Exit 0 for the audit harness itself; component-level defects are recorded in the decision log, not as test failures (the harness records observed behavior, it does not assert spec correctness — that's the audit's job, not the test suite's). |

### Build / regression gate

After the audit completes, run from `development/foxybear/packages/fbh`:

```bash
bun run typecheck
bun test test/p0_audit/ --timeout 60000
```

Both must exit 0 (CC-4). The audit harness itself must be green — it does not assert spec correctness (that's the audit's job in the decision log), it asserts that the audit ran and recorded observed behavior for every input.

## Seams noticed

- **`Consolidation.run` anchor in the master spec**: SDD-00 (line 39, §Scope) and the research doc (line 46) both cite `Consolidation.run` at `consolidation.ts:362`. Verified actual: `run` is at `consolidation.ts:533`. Line 362 is inside the `consolidate` helper (the third phase called from inside `run` at `:555`). This spec uses the verified anchor 533. SDD-02 §Seams flagged the same error. Recommend master errata.
- **`extractTurn` message shape**: `Consolidation.extractTurn` (consolidation.ts:594) accepts `messages: any[]` and uses `getLastUserMessage` (consolidation.ts:102) which expects `{ role, parts: [{ type: "text", content }] }` — returns `part.content`, NOT `part.text`. The session's `MessageV2.WithParts[]` at `prompt.ts:1481` differs: role lives at `info.role` and `TextPart.text` is the field, not `content`. P-0 audit input (j) explicitly tests this — `extractTurn` SHALL extract zero facts from the unadapted MessageV2 shape, confirming SDD-02 §HOW D's adapter is required. The `any[]` signature is also a style-guide violation (AGENTS.md: "Avoid `any`"). P-0 records this as bucket (d) spec-divergent — the input type contract is undocumented and the wire-up adapter is forced. M-0 wires with the adapter; a follow-up cleanup spec should tighten the `extractTurn` input type to `MessageV2.WithParts[]` directly.
- **`lockDir: "/tmp/opencode-consolidation"`** at `scheduler.ts:379` is a rebrand straggler that `Consolidation.run` uses (consolidation.ts:541). P-0 audit input (d) for `Consolidation.run` tests lock contention against this path — the path itself is a rebrand straggler but the lock semantics are the audit subject. M-0 fast-follow: rename to `~/.local/share/foxybear/consolidation-lock` or `/tmp/foxybear-consolidation`.
- **Graph leg silent empty in `SurrealBackend.query`**: The graph leg at surreal-backend.ts:243-255 has a `.catch(() => [] as any[])` — failures are silent. P-0 audit input (c) for `SurrealBackend.query` tests the graph leg with seeded entities; if the leg silently fails (e.g., SurrealQL syntax error on the `->mentions->entity<-mentions<-memory` path), the audit records empty graph ranking. Whether this is bucket (a) broken or expected behavior (comment at surreal-backend.ts:256: "The graph leg may return empty in v1 if no entities have been written yet — empty is fine") depends on whether the `.catch()` swallows a real error. The audit SHALL distinguish: if the catch fires due to a query syntax error, that's bucket (a) broken; if it fires due to no seeded entities, that's expected. The decision log SHALL record which.
- **`Memory.getPrunable` null `accessed_at`**: `MemoryTopicsTable.time_accessed` is nullable. The SQLite path at memory.ts:774 compares `${MemoryTopicsTable.time_accessed} < ${cutoff.getTime()}` — a null `time_accessed` coerces to 0 in JS, which is < cutoff, so the row is prunable. P-0 audit input (g) for `getPrunable` tests this — a null `accessed_at` row is prunable. This may be bucket (c) semantically-wrong (a row never accessed should probably NOT be auto-pruned) or expected (null = epoch = very old = prunable). The audit SHALL record and let the verdict rule decide.
- **`Memory` stale penalty boundary**: The condition at memory.ts:458 is `ageDays > stalePenaltyDays && accessCount < 2` — strict `>`. A memory exactly at `stalePenaltyDays` is NOT penalized. P-0 audit input (e) tests this boundary. If the spec (SDD-00 §Decision 3) implies `>=`, this is bucket (d) spec-divergent. The audit SHALL record and let the verdict rule decide.
- **`migrateFromSqlite` entity/edge migration paths are untested in the existing suite**: The 1 SQLite row is a memory, not an entity or edge. P-0 audit inputs (h) and (i) for `migrateFromSqlite` SHALL seed SQLite with synthetic entity and edge rows to exercise those paths for the first time. If they fail, that's bucket (a) broken — and a candidate for A0 if repair > 2 engineer-days (M-0 runs `migrateFromSqlite` as a core wire-up step).
- **`recentSessionIds: []` stub in scheduler**: The research doc flags `scheduler.ts:377-381` as passing `[]` to `Consolidation.run`. P-0 audit input (a) for `Consolidation.run` tests the `[]` case directly — the gather phase (consolidation.ts:301) iterates `input.recentSessionIds` and, with `[]`, produces zero candidates. The behavior is documented as a no-op, not a defect. The defect is that the scheduler STUB passes `[]` (a scheduler bug, not a `Consolidation.run` bug) — that's tracked in SDD-02 §HOW B, not P-0.
- **`Memory.recallWithWorkforce`**: Flagged dormant in research (memory.ts:783). The workforce URL is config-controlled (`memory.workforce.url` unset). P-0 excludes this from the audit — it's not dormant code, it's an unused config path. The `AutoRecall.autoRecall` audit input (f)/(g) tests the workforce path through `AutoRecall`, which is the intended surface; `recallWithWorkforce` is a lower-level helper that `AutoRecall` does not call.

## Anchors verified against real source

All anchors in this spec were verified by reading the actual source files on 2026-09-21:

- `src/memory/consolidation.ts:445` — `export async function prune(input: { persona: string }): Promise<PruneResult>` ✓
- `src/memory/consolidation.ts:533` — `export async function run(input: { persona, lockDir, recentSessionIds: string[] }): Promise<ConsolidationResult>` ✓ (master spec says :362 — that is `consolidate`; see Seams)
- `src/memory/consolidation.ts:594` — `export async function extractTurn(input: {...}): Promise<void>` ✓
- `src/memory/consolidation.ts:731-737` — `export interface ConsolidationResult { merged, pruned, created, indexUpdated, durationMs }` ✓
- `src/memory/consolidation.ts:763-767` — `export interface PruneResult { pruned, nearDupsMerged, indexRemoved }` ✓
- `src/memory/recall.ts:185` — `export async function autoRecall(input: AutoRecallInput): Promise<MemoryResult[]>` ✓
- `src/memory/recall.ts:279` — `export function formatForInjection(results: MemoryResult[], opts?: { degraded?: boolean }): string` ✓
- `src/memory/recall.ts:201-207` — turn cache check (AR-03/08) ✓
- `src/memory/recall.ts:290` — degraded mode `> Note:` line ✓
- `src/memory/surreal-backend.ts:42` — `export class SurrealBackend implements MemoryBackend` ✓
- `src/memory/surreal-backend.ts:203-292` — `async query(input: QueryInput): Promise<MemoryResult[]>` — hybrid retrieval: semantic leg (215-225), keyword leg (228-235), graph leg (237-258), RRF (260-262), hydrate (264-291) ✓
- `src/memory/surreal-backend.ts:378` — `async migrateFromSqlite(): Promise<MigrationReport>` ✓
- `src/memory/surreal-backend.ts:384` — marker file idempotency check ✓
- `src/memory/surreal-backend.ts:451` — `entity:⟨${e.id}⟩` angle-bracket ULID escape ✓
- `src/memory/surreal-backend.ts:463` — `RELATE entity:⟨${e.source_id}⟩->relates->entity:⟨${e.target_id}⟩` ✓
- `src/memory/graph/surreal-backend.ts:47` — `export class SurrealGraphBackend implements GraphBackend` ✓
- `src/memory/graph/surreal-backend.ts:79-87` — `graph_entity` + `graph_edge` table defs ✓
- `src/memory/graph/surreal-backend.ts:113-115` — `findEntitiesByName` + `live` filter preserving `valid_from` on upsert ✓
- `src/memory/graph/graduation.ts:19` — `export async function graduateMemories(input: {...}): Promise<GraduationResult>` ✓
- `src/memory/graph/graduation.ts:11-17` — `export interface GraduationResult { promoted, entities_created, edges_created, contradictions_handled, supersessions_handled }` ✓
- `src/memory/graph/graduation.ts:43` — `gte(MemoryTopicsTable.access_count, 2)` — the `access_count >= 2` trigger ✓
- `src/memory/graph/graduation.ts:74-82` — contradiction branch (cosine < 0.3) invalidates old edges ✓
- `src/memory/graph/graduation.ts:120` — `SUPERSEDES` increments `supersessions_handled` ✓
- `src/memory/graph/graduation.ts:124-129` — per-candidate try/catch ✓
- `src/memory/memory.ts:22-31` — `export interface MemoryEntry { id, content, persona, scope, access_count, created_at, accessed_at, metadata }` ✓
- `src/memory/memory.ts:33-36` — `export interface MemoryResult extends MemoryEntry { score, source }` ✓
- `src/memory/memory.ts:456-460` — `if (ageDays > stalePenaltyDays && accessCount < 2) { score *= 0.5 }` ✓
- `src/memory/memory.ts:756-779` — `export async function getPrunable(opts?: { ttl_days?: number }): Promise<MemoryEntry[]>` — SurrealBackend dispatch at :761-765, legacy SQLite path at :767-778 ✓
- `src/memory/backend.ts:9-36` — `MemoryBackend` interface ✓
- `src/memory/backend.ts:68-79` — `MemoryResult` interface ✓
- `src/memory/backend.ts:88-95` — `MigrationReport` interface ✓
- `src/memory/graph/backend.ts:23-64` — `GraphBackend` interface ✓
- `src/memory/graph/types.ts:5-42` — `GraphEntity`, `GraphEdge`, `TraversalResult`, `GraphQueryResult` interfaces ✓
- `src/scheduler/scheduler.ts:377-381` — `Consolidation.run({ persona: "default", lockDir: "/tmp/opencode-consolidation", recentSessionIds: [] })` stub ✓ (the `[]` is the scheduler bug, not a `Consolidation.run` bug — tracked in SDD-02)
- `~/.local/share/foxybear/memory-server/` — exists ✓ (the audit SHALL verify the daemon points here, not at the opencode drift path)
- `~/.local/share/foxybear/memory-migration-surreal.json` — does NOT exist ✓ (verifies `migrateFromSqlite` has never run — the audit input (a) exercises the marker-absent path for the first time)

## Anchors not verified

None. Every path:line in this spec was checked against real source.
