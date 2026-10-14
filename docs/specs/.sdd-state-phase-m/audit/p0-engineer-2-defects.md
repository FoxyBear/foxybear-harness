# P-0 Audit — Engineer 2 Defect Log

**Auditor:** Engineer 2 (fresh-context agent)
**Date:** 2026-09-22
**Components reviewed:** 11
**Total inputs reviewed:** 111 (extract_turn: 11 a-k; run/prune/auto_recall/format/surreal_query/graph/graduation/stale/prunable/migrate: 10 each a-j; plus 3 post-state/healthy/final-state entries recorded by the harness but not counted as inputs)

**Method:** Read the SDD-01 spec (WHAT #12 schema validation, WHAT #13 defect categorization, WHAT #17 verdict, WHAT #18 A0), then read every JSON results file in `test/p0_audit/results/`, then read the source for each component (`consolidation.ts`, `recall.ts`, `surreal-backend.ts`, `graph/surreal-backend.ts`, `graduation.ts`, `memory.ts`, plus the declared interfaces `backend.ts`, `graph/types.ts`, `memory.sql.ts`, and the harness files `extract_turn.test.ts`, `run.test.ts`, `prune.test.ts`, `auto_recall.test.ts`, `format.test.ts`, `surreal_query.test.ts`, `graph.test.ts`, `graduation.test.ts`, `stale.test.ts`, `prunable.test.ts`, `migrate.test.ts`, `db.ts`, `helpers.ts`). Each input's observed output was compared against the declared TS interface and the spec claim in SDD-01.

## Per-component findings

### 1. Consolidation.extractTurn (consolidation.ts:594) — CORE

**Inputs reviewed:** 11 (a-k)
**Observed behavior summary:** Inputs (a, c, d, e, k) stored a single memory row with object metadata and `metadata.source === "extraction"` ✓. Input (b) stored a single memory row but with metadata as a JSON STRING, not an object. Inputs (f, g, h, i, j) produced no stored rows (skips/degradations) ✓. Input (k) with `timeoutMs: 1` still stored a memory (the `Promise.race` timeout returns control to the caller but does not cancel the in-flight `performExtraction` background promise; the harness's 600 ms settle window allowed the background store to complete) — recorded as a degradation per V1's "not defects" clause, not filed.
**Schema validation:** Return type `Promise<void>` — all 11 inputs returned void (no error). Pass. The stored-row side effect is validated against `MemoryEntry` (memory.ts:22-31): input (b) fails (metadata runtime type is string, not `Record<string, unknown>`).
**Defects filed:** 1

- **input_id: b** — correction: "No, actually we use Bun not Node."
  - **Observed:** Stored row `{ id: "01M33NJXRN9FFWS33SS0NKMDYC", content: "No, actually we use Bun not Node.", metadata: "{\"source\":\"extraction\",\"type\":\"correction\",\"session_id\":\"s-b\"}" }` — `metadata` is a JSON string.
  - **Expected:** Per V1, "Inputs (a-e) SHALL store memories with `metadata.source === \"extraction\"`." Per `MemoryEntry.metadata: Record<string, unknown>` (memory.ts:30), the runtime value must be an object. Input (a) by contrast stored `metadata` as an object — the two outputs are inconsistent.
  - **Root cause:** `extractFacts` (consolidation.ts:67) matches TWO correction patterns for "No, actually we use Bun not Node." — pattern 0 `/\bno[,.]?\s+actually\s+(.+?)(?:\.|$)/i` (full match) and pattern 3 `/\bactually[,.]?\s+(?:the|it'?s?|we)\s+(.+?)(?:\.|$)/i` (substring match) — producing two facts with near-identical content. The first `Memory.store` inserts a row; the second `Memory.store`'s embedding lands above the 0.95 `dedupThreshold` (memory.ts:213), triggering the duplicate-merge path (memory.ts:320-331). That path stores `metadata: input.metadata ? JSON.stringify(input.metadata) : row.metadata` (memory.ts:327) — passing an already-stringified string into a Drizzle `text({mode: "json"})` column (memory.sql.ts:31), which double-stringifies on write and parses back to a string on read.
  - **Bucket:** (b) schema-violating — `MemoryEntry.metadata` is declared `Record<string, unknown>`; runtime value is `string`.
  - **Auditor:** Engineer 2

### 2. Consolidation.run (consolidation.ts:533) — CORE

**Inputs reviewed:** 10 (a-j) plus one d-post lock-state entry
**Observed behavior summary:** All 10 inputs returned a `ConsolidationResult` (consolidation.ts:731-737) with fields `merged, pruned, created, indexUpdated, durationMs` of the right shape and types. All produced `merged: 0, pruned: 0, created: 0, indexUpdated: 0` because the gather phase had no candidates (no messages in `MessageTable`). Input (a) `recentSessionIds: []` produced the no-op result per V2. Input (d) lock contention: the pre-existing lock file was overwritten (run does not call `isLockedOut`) and then removed by the `finally` block (d-post: `lockExists: false`) — behavior recorded, not filed (V2: "the lock semantics are not explicitly specced").
**Schema validation:** Pass — all 10 return values match `ConsolidationResult`.
**Defects filed:** 0
**Note (not a defect):** Inputs (d), (g), (h) returned `durationMs: 0`, which technically diverges from V2's "`durationMs` > 0" expectation. This is a timing artifact (the runs completed within the same millisecond as `startTime`), not a behavioral defect — `durationMs` is recorded as `Date.now() - startTime` (consolidation.ts:575) and is structurally a `number`.

### 3. Consolidation.prune (consolidation.ts:445) — NON-CORE

**Inputs reviewed:** 10 (a-j)
**Observed behavior summary:** All 10 inputs returned a `PruneResult` (consolidation.ts:763-767) with `pruned, nearDupsMerged, indexRemoved` of the right shape and types. (a) empty table → all 0 ✓. (b) young row → `pruned: 0` ✓. (c) old row, access_count=0 → `pruned: 1` ✓ (matches V3). (d) old row, access_count=3 → `pruned: 0` (keep condition `access_count < 3` at consolidation.ts:462 is false) ✓. (e) two identical-embedding rows → `nearDupsMerged: 1`, `survivingIds: ["p-e1"]` (more recently accessed survives, matching V3) ✓. (f) orthogonal embeddings → both survive ✓. (g) 201 index entries → `indexRemoved: 1` ✓ (V3). (h) 200 entries → `indexRemoved: 0` (200 is NOT `> 200`) ✓. (i) 201 entries with 3-way tie at access_count=0 → `indexRemoved: 1`, tiebreaker by `time_created` ✓. (j) ttl_days=1 against 2-day row — harness limitation (cannot override config mid-test, default 90 used): `pruned: 0`.
**Schema validation:** Pass — all 10 return values match `PruneResult`.
**Defects filed:** 0
**Note (not a defect):** Input (j) recorded `pruned: 0`, diverging from V3's "Inputs (c), (g), (j) SHALL produce `pruned > 0`." The harness explicitly documented this as a limitation ("cannot override config mid-test, uses default 90; row 2 days old is NOT prunable (2 < 90)"). The component behaved correctly given the default `ttl_days=90`; the V3 expectation for (j) is unverified, not violated.

### 4. AutoRecall.autoRecall (recall.ts:185) — CORE

**Inputs reviewed:** 10 (a-j)
**Observed behavior summary:** All 10 inputs returned `MemoryResult[]` (memory.ts:33-36 + backend.ts:68-79). (a) match → 1 result with `source: "local"`, `score: 0.86` ✓. (b) "no match" query → 1 result with `score: 0.61` (the legacy SQLite path always returns top-N by cosine, no threshold; recorded, not filed — V4 does not specify "no match → []"). (c) `/help` → `[]` (AR-02 skip) ✓. (d) same query twice → `cacheHit: true`, second call `durationMs: 0` (AR-03/08 cache) ✓. (e) embedding failure (ollama bad model) → `[]` (AR-07 graceful degradation) ✓. (f) workforce unreachable → local result only (AR-11) ✓. (g) workforce reachable → merged local + workforce results with `source: "workforce"` for the workforce row (AR-10/12) ✓. (h) project_id="no-such-project" with global memory → global fallback returns the global row ✓. (i) project_id="proj-i" → returns the project row ✓. (j) `requestor_elevated: true` → returns result (forward-compat log line, no behavioral effect) ✓.
**Schema validation:** Pass — all 10 return values match `MemoryResult[]` with `source` in `"local" | "workforce"` (memory.ts:35).
**Defects filed:** 0

### 5. AutoRecall.formatForInjection (recall.ts:279) — CORE

**Inputs reviewed:** 10 (a-j)
**Observed behavior summary:** All 10 inputs returned a `string`. (a) empty → `""` (AR-14) ✓. (b) 1 day ago → `## Relevant Memories\n1. [2026-09-21, local] test memory content` (no staleness suffix; `daysAgo=1`, `staleWarningDays=1`, `1 > 1` is false) ✓. (c) 5 days ago → staleness suffix `(memory from 5 days ago — verify before acting)` (AR-13) ✓. (d) five mixed-age results → fresh/today no suffix, stale/very stale suffix ✓. (e) `degraded: true` → `> Note: Project/global memories unavailable (daemon offline). Showing instance memories only.` prepended ✓. (f) `source: "local"` ✓. (g) `source: "workforce"` ✓. (h) `created_at: "0"` → `[unknown, local]` ✓. (i) `created_at: ""` → `[unknown, local]` ✓ (formatDate at recall.ts:327-337 returns "unknown" for `isNaN(ts) || ts === 0`). (j) 2 days ago → `[2026-09-20, local] ... (memory from 2 days ago — verify before acting)` ✓.
**Schema validation:** Pass — all 10 return values are `string`.
**Defects filed:** 0

### 6. SurrealBackend.query (surreal-backend.ts:203) — CORE

**Inputs reviewed:** 10 (a-j)
**Observed behavior summary:** All 10 inputs returned `MemoryResult[]` (backend.ts:68-79) with `source: "surreal"`, ISO-string `created_at`/`accessed_at`, and RRF-fused scores. (a) vector hit → 3 results ✓. (b) keyword hit → 3 results ✓. (c) graph-leg hit → 3 results; scores `0.0164, 0.0161, 0.0159` are consistent with single-leg RRF (`1/61, 1/62, 1/63`), suggesting the graph leg returned empty even though the harness seeded `Bun` + `TypeScript` entities via `backend.write` auto-extraction. (d) fused three-leg → top scores `0.0328, 0.0323` are consistent with two-leg RRF (semantic + keyword), not three-leg — again suggesting the graph leg returned empty. (e-h) scope permutations `instance/project/global/all` — each returns the expected scoped rows ✓. (i) `as_of` 1 year ago → 3 results (temporal filter only constrains the graph leg, which is already empty) ✓. (j) `limit: 5` → 5 results ✓.
**Schema validation:** Pass — all 10 return values match `MemoryResult[]` (backend.ts:68-79) with `source` in `"surreal" | "sqlite" | "workforce"` (backend.ts:75).
**Defects filed:** 0
**Note (not a defect):** For inputs (c) and (d), the RRF scores suggest the graph leg (surreal-backend.ts:243-255) returned empty even with seeded entities. V6 explicitly says "The graph leg may return empty when no entities are seeded — the audit SHALL record this as expected (comment at surreal-backend.ts:256), NOT as a defect." The Seams section adds "if the catch fires due to a query syntax error, that's bucket (a) broken; if it fires due to no seeded entities, that's expected." Without direct evidence of whether the `.catch(() => [] as any[])` at surreal-backend.ts:255 fired (syntax error vs. empty result), and given V6's explicit "NOT as a defect" clause, this audit records the observation but does not file a defect. The graph leg's `.catch()` swallows errors silently, which makes this indeterminate from the JSON output alone; a follow-up instrumentation pass is recommended.

### 7. SurrealGraphBackend (graph/surreal-backend.ts:47) — CORE

**Inputs reviewed:** 10 (a-j) plus one `healthy` entry
**Observed behavior summary:** All 10 inputs returned the declared interface shapes (`GraphEntity`, `GraphEdge`, `TraversalResult[]`, `GraphQueryResult` per graph/types.ts:5-42). (a) upsertEntity new → returns `GraphEntity` with `valid_from`, `created_at`, `updated_at` as numbers ✓. (b) upsertEntity existing 'Bun' → `valid_from: 1790050915551` matches `firstValidFrom` (SG-01 preserved) ✓, `updated_at` advanced to 1790050915568. (c) findEntitiesByName 'TypeScript' → match returned ✓. (d) findEntitiesByName 'NonExistent' → `[]` ✓. (e) searchEntities with embedding → ranked entities with `score` ✓. (f) addEdge → returns `GraphEdge` with `weight: 1`, `valid_from`, `source_project: null`, `metadata: null` ✓. (g) invalidateEdge → `invalidated: true`, `edgesAfterValidOnly: 0` ✓. (h) getEdgesFrom `valid_only: true` → `[]` (invalidated edge excluded) ✓. (i) traverse `max_hops: 2` over A->B->C → `[{entity: ChainB, depth: 1}, {entity: ChainC, depth: 2}]` ✓. (j) query with embedding + keyword → `{entities: [...], edges: []}` ✓. `healthy` → `true` after `init()` ✓.
**Schema validation:** Pass — all 10 return values match the declared interfaces. Bi-temporal fields (`valid_from`, `invalid_from`) populated as numbers (graph/types.ts:13-14).
**Defects filed:** 0

### 8. graduateMemories (graph/graduation.ts:19) — NON-CORE

**Inputs reviewed:** 10 (a-j)
**Observed behavior summary:** All 10 inputs returned a `GraduationResult` (graduation.ts:11-17) with `promoted, entities_created, edges_created, contradictions_handled, supersessions_handled` of the right shape and types. (a) no eligible memories → all 0 ✓. (b) single eligible TypeScript memory → `promoted: 1, entities_created: 1` ✓. (c) upsert path → `promoted: 0, entities_created: 0` ✗ (expected `promoted: 1` or `2`, exercising upsert path at graduation.ts:84). (d) contradiction → `contradictions_handled: 0` ✗ (expected `1`). (e) SUPERSEDES → `promoted: 1, entities_created: 2, edges_created: 1, supersessions_handled: 1` ✓. (f) embedding failure → `promoted: 1, entities_created: 1` (entity created without embedding via try/catch at graduation.ts:88-90) ✓. (g) two eligible memories → `promoted: 1, entities_created: 1` ✗ (expected `promoted: 2, entities_created: 2`). (h) zero extractable entities → `promoted: 0` (continue at graduation.ts:59) ✓. (i) two eligible memories → `promoted: 1, entities_created: 1` (both attempted; one promoted, one skipped via continue) ✓. (j) two projects → `proj1.promoted: 1, proj2.promoted: 0` ✗ (expected `proj2.promoted: 1`).
**Schema validation:** Pass — all 10 return values match `GraduationResult`.
**Defects filed:** 4

- **input_id: c** — eligible memory with entity already in project graph — upsert path at graduation.ts:84
  - **Observed:** `{ promoted: 0, entities_created: 0, edges_created: 0, contradictions_handled: 0, supersessions_handled: 0 }`.
  - **Expected:** Per V8, "an eligible memory with an entity that already exists in the project graph (verifies the upsert path at graduation.ts:84)." The upsert path at graduation.ts:84 (`entityIdMap.set(extracted.name.toLowerCase(), existingEntity.id)`) requires `extractEntitiesAndRelations(candidate.content).entities.length > 0` (else the `continue` at graduation.ts:59 fires). The harness seeded g-c1 and g-c2 with content `"We use \`Bun\` for the runtime."` (and "again" variant). The candidate was eligible (`access_count >= 2`), so `promoted` should have incremented to 1 (or 2 for both g-c1 and g-c2).
  - **Root cause:** `extractEntitiesAndRelations` (graph/extraction.ts:56-71) splits content on `[\s,;:()[\]{}'"]+]` — backticks are NOT in this character class. So `"`Bun`"` is treated as a single token, lowercased to `"`bun`"`, which does NOT match `"bun"` in `KNOWN_TOOLS`. PascalCase match `\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b` (graph/extraction.ts:66) requires at least 2 capital groups, so single-word `"Bun"` does not match either. Result: 0 entities extracted, candidate skipped via `continue`, `promoted` stays 0. (Contrast: input (b) `"We use \`TypeScript\` for the backend."` DID extract TypeScript because pascalMatch hits "TypeScript" = "Type" + "Script".)
  - **Bucket:** (c) semantically-wrong — right shape, wrong content (candidate not promoted despite being eligible).
  - **Auditor:** Engineer 2

- **input_id: d** — eligible memory with contradiction (different DB) — contradictions_handled, old edges invalidated
  - **Observed:** `{ promoted: 0, entities_created: 0, edges_created: 0, contradictions_handled: 0, supersessions_handled: 0 }`.
  - **Expected:** Per V8, "an eligible memory with a contradiction ... `contradictions_handled: 1` and old edges invalidated." The harness seeded g-d1 `"We use \`Postgres\` for the database."` (access_count=2) and g-d2 `"We use \`MySQL\` for the database."` (access_count=2). The contradiction branch at graduation.ts:74-82 requires the existing entity to have an embedding AND the candidate embedding cosine < 0.3.
  - **Root cause:** Same backtick issue — "Postgres" and "MySQL" are not PascalCase multi-word and not extractable from backtick-wrapped tokens via `KNOWN_TOOLS`. Neither g-d1 nor g-d2 produced extracted entities, so no entity was created in the first call, no comparison was possible in the second call, and `contradictions_handled` stayed 0.
  - **Bucket:** (c) semantically-wrong — `contradictions_handled` should be 1, observed 0.
  - **Auditor:** Engineer 2

- **input_id: g** — two eligible memories in the same project
  - **Observed:** `{ promoted: 1, entities_created: 1, edges_created: 0, contradictions_handled: 0, supersessions_handled: 0 }`.
  - **Expected:** Per V8 (and the harness description "two eligible memories in the same project"), both eligible memories should be processed. g-g1 `"We use \`TypeScript\` for the backend."` extracts TypeScript (pascalMatch) → promoted, entity created. g-g2 `"We use \`Bun\` for the runtime."` should also be processed → promoted. Expected `promoted: 2, entities_created: 2`.
  - **Root cause:** g-g2's "Bun" is not extracted (backtick issue, same as input c). Candidate skipped via `continue` at graduation.ts:59, `promoted` stays at 1.
  - **Bucket:** (c) semantically-wrong — `promoted` should be 2, observed 1.
  - **Auditor:** Engineer 2

- **input_id: j** — two eligible memories across two project_ids — project isolation
  - **Observed:** `{ proj1: { promoted: 1, entities_created: 1, ... }, proj2: { promoted: 0, entities_created: 0, ... } }`.
  - **Expected:** Per V8, "two eligible memories across two `project_id`s (verifies project isolation)." g-j1 in proj-j1 with `"We use \`TypeScript\` for the backend."` → promoted (TypeScript extracted). g-j2 in proj-j2 with `"We use \`Bun\` for the runtime."` → should be promoted. Expected `proj1.promoted: 1, proj2.promoted: 1`.
  - **Root cause:** Same backtick issue — g-j2's "Bun" is not extracted. Candidate skipped via `continue`, `proj2.promoted` stays at 0.
  - **Bucket:** (c) semantically-wrong — `proj2.promoted` should be 1, observed 0.
  - **Auditor:** Engineer 2

### 9. Memory stale penalty (memory.ts:458) — NON-CORE

**Inputs reviewed:** 10 (a-j)
**Observed behavior summary:** All 10 inputs recorded `score_before`, `score_after`, `penalty_fired`. (a) 8d old, access_count=0, penalty=7 → `score_after: 0.4999...`, `penalty_fired: true` ✓ (`score_after / score_before ≈ 0.5`). (b) 8d old, access_count=2 → `penalty_fired: false` (2 NOT < 2) ✓. (c) 8d old, access_count=5 → `penalty_fired: false` ✓. (d) 3d old, access_count=0 → `penalty_fired: false` (3 NOT > 7) ✓. (e) exactly 7d, access_count=0 → `penalty_fired: false` (7 NOT > 7, strict `>` at memory.ts:458) ✓ (V9 boundary). (f) 7d+1ms, access_count=0 → `penalty_fired: true` ✓ (V9 1ms past boundary). (g) stale_penalty_days:0 vs 1d old — harness limitation (default 7 used): `penalty_fired: false`. (h) stale_penalty_days:365 vs 30d old — harness limitation (default 7 used): `penalty_fired: true`. (i) stale 10d + fresh 1d → ranking `[fresh (0.999...), stale (0.499...)]`, `staleFirst: true` (the harness field name is misleading — `staleFirst` is set to `results[0]!.id === "s-i-fresh"`, so `true` means fresh is first, i.e., stale sank) ✓ (V9: stale sinks). (j) access_count=0 fallback `?? 0` + 10d old → `penalty_fired: true` ✓.
**Schema validation:** The stale penalty is a branch inside `Memory.searchLocalWithEmbeddingSqlite` (memory.ts:447-467), not a standalone function. The recorded `score_before`/`score_after` are harness-computed values, not the component's return. Pass for behavioral observation.
**Defects filed:** 0
**Note (not a defect):** Inputs (g) and (h) recorded opposite-of-spec behavior because the harness cannot override `stale_penalty_days` mid-test (default 7 used). V9 expects (g) `penalty fires` and (h) `no penalty`; observed (g) `no penalty` (1 < 7) and (h) `penalty fires` (30 > 7). The component behaved correctly given the default config; the V9 expectation for these two inputs is unverified, not violated. The boundary inputs (e) and (f) confirm the strict `>` semantics at memory.ts:458.

### 10. Memory.getPrunable (memory.ts:756) — NON-CORE

**Inputs reviewed:** 10 (a-j) plus one final-state entry
**Observed behavior summary:** All 10 inputs returned `MemoryEntry[]` (memory.ts:22-31) directly or via the harness's `{count, ids}` summary. (a) ttl=90, all young → `[]` ✓ (V10). (b) ttl=90, one 91d row → 1 row ✓. (c) ttl=0 → 2 rows (cutoff=now) ✓. (d) ttl=36500 → `[]` ✓. (e) no ttl_days → fallback to cfg.ttlDays (default 90), 1 old row ✓. (f) accessed_at=0 (epoch) → `count: 1` (0 < cutoff) ✓. (g) accessed_at=null → `count: 0` ✗ (spec claim: "null coerces to 0 in JS, row is prunable"). (h) SurrealBackend registered → dispatch hits `backend.getPrunable(ttl)` and maps via `backendResultToEntry` (memory.ts:761-765), 1 row returned ✓. (i) no global backend → legacy SQLite path (memory.ts:767-778), 1 row ✓. (j) ttl=7, 8d row → 1 row ✓.
**Schema validation:** Pass for the component's return — `MemoryEntry[]`. (Note: `backendResultToEntry` at memory.ts:116-127 hardcodes `access_count: 0` because `BackendMemoryResult` (backend.ts:68-79) lacks an `access_count` field; the resulting `MemoryEntry` has `access_count: 0` regardless of the backend's actual count. This is a schema-shape loss but the runtime value still satisfies `MemoryEntry.access_count: number`. Not filed — the interface is satisfied, and the spec does not claim access_count is preserved across the backend boundary.)
**Defects filed:** 1

- **input_id: g** — row with accessed_at: null — SQL NULL < cutoff is NULL → NOT prunable
  - **Observed:** `{ count: 0, ids: [] }` — the row is NOT prunable.
  - **Expected:** Per spec input (g) (WHAT #10): "a row with `accessed_at: null` (verifies the comparison against null — null coerces to 0 in JS, row is prunable)." Expected `count: 1` (row IS prunable).
  - **Root cause:** The legacy SQLite path compares `${MemoryTopicsTable.time_accessed} < ${cutoff.getTime()}` (memory.ts:774) in SQL, not JS. In SQL, `NULL < N` evaluates to `NULL` (not `TRUE`), so the row is excluded. The spec's claim that "null coerces to 0 in JS" is correct for JS but inapplicable to the SQL comparison the code actually performs. The Seams section flags this ambiguity: "This may be bucket (c) semantically-wrong ... or expected ... The audit SHALL record and let the verdict rule decide."
  - **Bucket:** (d) spec-divergent — the code's behavior (SQL NULL comparison → not prunable) diverges from the spec claim (JS null coercion → prunable). The output shape is valid (`MemoryEntry[]`), the content is correct for the SQL semantics, but the behavior diverges from SDD-01 §WHAT #10 (g)'s explicit claim.
  - **Auditor:** Engineer 2

### 11. SurrealBackend.migrateFromSqlite (surreal-backend.ts:378) — CORE

**Inputs reviewed:** 10 (a-j)
**Observed behavior summary:** All 10 inputs returned a `MigrationReport` (backend.ts:88-95) with `memories, entities, edges, duration_ms, ran` of the right shape and types. (a) fresh state, 0 rows → `ran: true`, marker created ✓ (V11). (b) marker present → `ran: false` (idempotent at surreal-backend.ts:386) ✓. (c) 1 SQLite memory row → `memories: 1, ran: true`, marker created ✓; `surrealCounts.entities: 18` reflects auto-extraction via `extractAndLinkEntities` (surreal-backend.ts:148) — the rebrand memory content yields 18 entities, which is consistent with the concept+tool+pattern extractor (extraction.ts:45-81) applied to a content-rich row. (d) Buffer embedding → `memories: 1, ran: true` (bufferToFloat32 roundtrips) ✓. (e) empty Buffer embedding (column NOT NULL; spec 'null' approximated by empty Buffer) → `memories: 1, ran: true` ✓. (f) project_id='global' → `scope: "global"` mapping ✓. (g) project-scoped → `scope: "project"` mapping ✓. (h) 1 entity row → `entities: 1, ran: true` (angle-bracket ULID escape) ✓. (i) 1 edge row (2 entities) → `entities: 2, edges: 1, ran: true` (RELATE query) ✓. (j) time_created=0 (column NOT NULL; spec 'null' approximated by 0) → `created_at: "1970-01-01T00:00:00.000Z"` (new Date(0).toISOString() fallback at surreal-backend.ts:425) ✓.
**Schema validation:** Pass — all 10 return values match `MigrationReport`.
**Defects filed:** 0
**Note (not a defect):** Inputs (e) and (j) substitute `empty Buffer` and `0` respectively for the spec's `null` because the `embedding` and `time_created` columns are `NOT NULL` (memory.sql.ts:26, 32). The harness documents this substitution explicitly. The component handled the substitutions correctly (bufferToFloat32(Buffer.alloc(0)) = empty Float32Array; new Date(0).toISOString() = epoch). The spec's null-case paths are unverified, not violated.

## Defect summary

| Component | Core? | (a) broken | (b) schema | (c) semantic | (d) spec-div | Total |
|---|---|---|---|---|---|---|
| Consolidation.extractTurn | YES | 0 | 1 | 0 | 0 | 1 |
| Consolidation.run | YES | 0 | 0 | 0 | 0 | 0 |
| Consolidation.prune | NO | 0 | 0 | 0 | 0 | 0 |
| AutoRecall.autoRecall | YES | 0 | 0 | 0 | 0 | 0 |
| AutoRecall.formatForInjection | YES | 0 | 0 | 0 | 0 | 0 |
| SurrealBackend.query | YES | 0 | 0 | 0 | 0 | 0 |
| SurrealGraphBackend | YES | 0 | 0 | 0 | 0 | 0 |
| graduateMemories | NO | 0 | 0 | 4 | 0 | 4 |
| Memory stale penalty | NO | 0 | 0 | 0 | 0 | 0 |
| Memory.getPrunable | NO | 0 | 0 | 0 | 1 | 1 |
| SurrealBackend.migrateFromSqlite | YES | 0 | 0 | 0 | 0 | 0 |
| **Core subtotal (7)** | | **0** | **1** | **0** | **0** | **1** |
| **Non-core subtotal (4)** | | **0** | **0** | **4** | **1** | **5** |
| **Grand total** | | **0** | **1** | **4** | **1** | **6** |

## Verdict: GO

**Justification:** Per WHAT #17, GO requires "zero defects in bucket (a) broken for any core component, AND ≤ 5 defects total across buckets (b)+(c)+(d) for core components."

- Bucket (a) broken in core components: **0** ✓ (no core component threw, crashed, hung, or returned no value across any of the 10-11 inputs)
- Bucket (b)+(c)+(d) in core components: **1** (extractTurn input (b), bucket (b) schema-violating) ≤ 5 ✓
- Bucket (a) in non-core: **0** (no non-core component was broken either)

The single core defect (extractTurn b) is a metadata-stringification bug in `Memory.store`'s duplicate-merge path (memory.ts:327), observed through `extractTurn`'s stored row. Root cause is well-localized (one line: `JSON.stringify(input.metadata)` should be `input.metadata` to match the insert path at memory.ts:361). Estimated repair: < 0.25 engineer-day (one-line fix + regression test that asserts `metadata` round-trips as an object through both insert and merge paths).

The four `graduateMemories` defects share a single root cause: `extractEntitiesAndRelations` (graph/extraction.ts:56-71) does not strip backticks before `KNOWN_TOOLS` lookup, so backtick-wrapped non-PascalCase tech names (Bun, Postgres, MySQL) are not extracted. Estimated repair: < 0.5 engineer-day (add backtick to the split regex `[\s,;:()[\]{}'"`]+` at graph/extraction.ts:58, plus a regression test that asserts `Bun` is extracted from `"`Bun`"`).

The `getPrunable` defect is a spec-vs-code divergence on NULL comparison semantics. The code's SQL behavior (`NULL < N` → NULL → row excluded) is correct SQL; the spec's claim ("null coerces to 0 in JS, row is prunable") is incorrect for the SQL path the code uses. Estimated repair: < 0.25 engineer-day to either (a) fix the spec claim in SDD-01 §WHAT #10 (g) to match SQL semantics, or (b) add an explicit `OR time_accessed IS NULL` clause to memory.ts:774 if the desired behavior is "null = prunable". This is a documentation or one-clause fix.

Total estimated repair across all 6 defects: < 1 engineer-day. Well within the 2 engineer-day ceiling for the NO-GO rule (which does not apply because there are zero bucket (a) defects in core).

## A0-abort: not fired

Per WHAT #18, A0 fires when a core component is broken (bucket (a) for ≥ 50% of its ≥10 sample inputs) AND averaged repair estimate > 2 engineer-days.

- No core component has any bucket (a) defect. The closest to "broken" is the graph leg silent `.catch()` in `SurrealBackend.query` (surreal-backend.ts:255), but the component returns valid results (the graph leg's empty contribution is a degradation, not a crash); V6 explicitly classifies this as "NOT as a defect". The component is not broken.
- No core component exceeds the 50% broken threshold.
- A0 does not fire.

The floor (M-0 wire-up + baseline-retrieval injection behind flag) is not at risk. The defects flow to their respective downstream phases:
- extractTurn (b) metadata bug → M-0 wire-up fix-list (the duplicate-merge path is exercised by `Memory.store`, which M-0 wires).
- `graduateMemories` backtick extractor bug → M-3 lifecycle fix-list (graduation is a lifecycle component).
- `getPrunable` NULL comparison → M-3 lifecycle fix-list (pruning is a lifecycle component).

## Observations recorded but NOT filed as defects

Per the spec's explicit "not defects" clauses and harness-limitation notes:

1. **extractTurn input (k)** — `timeoutMs: 1` still stored a memory (603 ms duration). The `Promise.race` at consolidation.ts:621 returns control to the caller after 1 ms but does not cancel the in-flight `performExtraction` background promise; the harness's 600 ms settle window allowed the background `Memory.store` to complete. V1 explicitly classifies input (k) as a skip/degradation ("not defects"). Recorded as a degradation, not filed.

2. **Consolidation.run inputs (d), (g), (h)** — `durationMs: 0`, diverging from V2's "`durationMs` > 0". Timing artifact (run completed within the same ms as `startTime`). The `durationMs` field is structurally a `number` and is recorded; the value 0 is a measurement-resolution issue, not a behavioral defect.

3. **Consolidation.prune input (j)** — `pruned: 0`, diverging from V3's "`pruned > 0`". Harness limitation: cannot override `ttl_days` config mid-test, default 90 used. The component behaved correctly given the default config; V3's expectation for (j) is unverified.

4. **Memory stale penalty inputs (g), (h)** — opposite-of-V9 behavior. Harness limitation: cannot override `stale_penalty_days` mid-test, default 7 used. The component behaved correctly given the default config; V9's expectations for (g) and (h) are unverified.

5. **SurrealBackend.query inputs (c), (d)** — RRF scores suggest the graph leg returned empty even with seeded entities. V6 explicitly says "NOT as a defect" for graph leg empty. The `.catch(() => [] as any[])` at surreal-backend.ts:255 swallows errors silently, making the root cause indeterminate from the JSON output. A follow-up instrumentation pass is recommended to distinguish "syntax error swallowed" from "query returned empty despite seeded entities" — if the former, that would be bucket (a) broken on re-audit.

6. **`backendResultToEntry` access_count hardcoded to 0** (memory.ts:122) — `BackendMemoryResult` (backend.ts:68-79) lacks `access_count`, so the conversion loses it. The resulting `MemoryEntry` satisfies the interface (`access_count: number`), so no schema violation, but the value is semantically wrong when the backend's actual count is non-zero. Not filed because the spec does not claim access_count is preserved across the backend boundary, and the audit is for `getPrunable` (which only uses the id/scope for pruning decisions, not access_count).

## Auditor signature

**Engineer 2** — fresh-context agent, did NOT author the dormant code or the audit harness.
- Recused components: none (non-authorship verified by reviewing the harness's `git blame` log for the 11 anchor lines — Engineer 2 does not appear as the author of any anchor line).
- Date: 2026-09-22
- Verdict: GO
