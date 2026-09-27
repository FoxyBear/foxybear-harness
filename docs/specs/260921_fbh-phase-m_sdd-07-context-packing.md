# SDD-07: Phase M-4 — Context Packing & Injection

**Date:** 2026-09-21 (revised 2026-09-22 per council findings)
**Project:** FoxyBear Harness Phase M (`development/foxybear`)
**Status:** Draft (pending independent re-audit + human gate)
**Master:** `260921_fbh-phase-m_sdd-00-master.md` (SC-1 subsetted node types, SC-5 ContextPacker interface, SC-6 config, SC-7 spike, SC-11 abort A6, SC-12 probe, CC-13 subsetting enforcement)
**Research:** `docs/research/260921_fbh-phase-m_research.md` (Build plan → Phase M-4; TencentDB L0-L3)
**Depends:** SDD-06 (M-3 lifecycle — composite scorer + decay formula), SDD-04 (pre-registered probe — must PASS before implementation; gates the hypergraph expansion path), SDD-03 (M-1 hypergraph schema — `Hypergraph.query`, `Hypergraph.store`, `Node` type), SDD-02 (M-0 wire-up — autoRecall block to remove)
**Workstream:** `fbh-phase-m`

Phase M-4 implements budget-bounded typed context packing and injects it into the session prompt builder. It replaces the M-0 wire-up of `AutoRecall` with a `ContextPacker` service that delegates to `AutoRecall` for seeding and MEMORY-block formatting, then adds typed blocks for messages, actions, errors, and procedures. A `ProvenanceTracker` closes the feedback loop: memories that were injected and led to a successful turn get `usage_count` and `last_used` increments directly on the node, which the SDD-06 decay formula reads on its next hourly tick (the rehearsal term is `access(t)` in the decay formula — no standalone `rehearse` method exists or is needed).

**Probe-gated (council, 2026-09-22):** M-4 builds on the hypergraph premise, which is unverified. M-4 SHALL NOT proceed to implementation until SDD-04 (the pre-registered retrieval-quality probe) has PASSED. If the probe triggers terminal fallback A3 (hypergraph retrieval abandoned), M-4 is re-scoped over baseline retrieval — the packer uses Arm 2 (vector + 1-hop, existing `SurrealBackend.query`) instead of Arm 3 (vector + hypergraph, `Hypergraph.query`). Per master SC-11 A6: `pack()` P95 > 300ms unfixable → degrade to top-k baseline packing (no expansion, just vector seeds).

**Schema subsetting (council, CC-13):** The packer operates on the 6 active node types only (MESSAGE, ACTION, ERROR, MEMORY, PROCEDURE, ENTITY per master SC-1). The 7 reserved node types (TASK, AGENT, INSIGHT, MODALITY, COMMUNITY, ARCHETYPE, META_PROCEDURE) are enum values only — no tables, no packing paths. ENTITY is expansion-input only: it seeds `Hypergraph.query` but is filtered out before formatting and never appears in `PackedContext.items` (enforced by packer type-filter + conformance test). TypedFormatter produces blocks for the 5 packable active types only (MEMORY, MESSAGE, ACTION, ERROR, PROCEDURE).

## Audit fixes (blocking issues resolved)

- **B1 (rehearse invented):** Removed all `MemoryLifecycle.rehearse()` calls. `ProvenanceTracker.feedback` now increments `usage_count` and `last_used` directly on the `MemoryNode` via `Hypergraph.store` update. The SDD-06 decay formula reads `usage_count` (as `access(t)`) during its hourly tick — rehearsal happens naturally in the next decay tick. No standalone `rehearse` method exists in SC-5.
- **B2 (pack signature conflicts):** Aligned with master SC-5: `pack(query: string, project_id: string, budget: number): Effect<PackedContext>`. Session context (sessionID, persona) is provided via a `Session` service (`Context.Tag<SessionContext>`), provided by the wire-up via `Effect.provideService`. Budget is a parameter (caller reads from config); `project_id` is a parameter (caller reads from session).
- **B3 (spike test conditional):** Spike test now includes a fixture that populates multiple node types (MEMORY + ACTION + ERROR) before asserting `types.size > 1`. The fixture makes the assertion unconditional on the fixture's graph, matching the WHAT's "(when available)" by constructing availability.

## Council findings (2026-09-22, additive)

The re-audit PASSED on the B1/B2/B3 fixes. The council deliberation (2026-09-22) identified four additive changes to M-4 that incorporate findings from the master spec (SC-1 subsetting, SC-11 abort A6, SC-12 probe, CC-13 subsetting enforcement):

1. **Probe-gating (CP-00, modified CP-04):** M-4 SHALL NOT proceed to implementation until SDD-04 (probe) has PASSED. If A3 fires (probe fails relational stratum), M-4 is re-scoped over baseline retrieval (Arm 2: vector + 1-hop via existing `SurrealBackend.query`, replacing `Hypergraph.query`). The `tools/sdd` pipeline refuses to advance sdd-07 from `spec` to `implement` until sdd-04's `tests` stage is green.
2. **Schema subsetting (CP-04a, CP-04b, CP-12a, modified CP-14):** Packer operates on 6 active node types only; 7 reserved types have no packing path. ENTITY is expansion-input only (never packed). TypedFormatter produces blocks for the 5 packable active types (added MESSAGE block, CP-12a). CP-14 L3 bootstrap subsetted to remove reserved AGENT/INSIGHT and expansion-only ENTITY.
3. **Abort A6 (CP-20, modified CP-04):** `pack()` P95 > 300ms unfixable → degrade to top-k baseline packing (no expansion, just vector seeds via `AutoRecall.autoRecall`). Controlled by `memory.packing.expansion_mode = "hypergraph" | "one_hop" | "top_k"` (default `"hypergraph"`).
4. **Dependency update (header + Dependencies):** SDD-07 depends on SDD-06 (M-3 lifecycle — composite scorer + decay formula) AND SDD-04 (probe must PASS). SDD-04 in the new numbering is the probe; the composite scorer / decay formula moved to SDD-06. References throughout this spec updated: old SDD-04 (composite scorer / decay) → SDD-06; old SDD-02 (Hypergraph) → SDD-03 (M-1 hypergraph schema); old SDD-01 (M-0 wire-up) → SDD-02 (M-0 wire-up).

## Probe findings (2026-09-23 — PRODUCTION REQUIREMENTS, non-negotiable)

The SDD-04 probe ran 6 iterations and PASSED on the sixth run. The probe surfaced critical SurrealDB 3.x performance characteristics that the seed + expand path in `BudgetAwarePacker` MUST follow. These are not suggestions — the probe empirically proved that alternative approaches fail the 100ms latency budget by 4-10x. Decision log: `docs/decisions/260921_fbh-phase-m_probe-results.md`.

**[PF-1] HNSW KNN operator is MANDATORY for the seed query (CP-04, CP-07).**

The vector seed query MUST use the `<|K,COSINE|>` KNN operator with an AND clause on `project_id`:

```sql
SELECT id, embedding FROM node
WHERE embedding <|20,COSINE|> $qvec
  AND attributes.project_id = $project_id
  AND array::len(embedding) = 768
```

The `<|K,COSINE|>` operator uses the HNSW index. The AND clause on `project_id` PUSHES the filter INTO the HNSW scan, reducing the scan set from ~10k to ~2.5k. Probe result: **70ms P95**.

The following query is FORBIDDEN — it is brute-force and does NOT use the HNSW index (probe result: 349ms P95, 5x slower):

```sql
-- FORBIDDEN: ORDER BY vector::similarity::cosine does not use HNSW
SELECT id, embedding FROM node
WHERE attributes.project_id = $project_id
ORDER BY vector::similarity::cosine(embedding, $qvec) DESC
LIMIT 20
```

Without any pre-filter (scanning all 10k nodes), P95 is 401ms (probe run 5). The `<|K,COSINE|>` + AND pattern is the ONLY approach that passes the 100ms budget on SurrealDB 3.0.5.

**[PF-2] In-memory adjacency map for expand() (CP-04, modified CP-04).**

The `expand()` call SHALL use an in-memory adjacency map (built from `hyperedge_members` at init time or after writes), NOT live SurrealDB queries per hop. Probe result: in-memory adjacency brought the hypergraph operations from ~1400ms (live DB queries per hop, run 4) to ~60ms (hash lookup, run 5). The remaining latency in run 5 was the vector seed, not the expand.

The adjacency map: `Map<node_id, {hyperedge_id: string, other_node_ids: string[]}[]>`. Built by `SELECT hyperedge_id, node_id FROM hyperedge_members` → grouped by `node_id`. For 10k hyperedges × ~3 nodes = ~30k entries, ~2-5MB memory. Trivial.

**[PF-3] expand depth=1 (CP-04).**

The `expand()` call SHALL use `depth: 1`, NOT `depth: 2`. Probe finding: depth=2 doubles the BFS frontier with minimal quality gain (the adjacency map makes depth=1 fast; depth=2 adds a second hop that the probe showed does not meaningfully improve recall). One hop connects seed → collaborator → action, which covers the relational queries the probe validated.

**[PF-4] Fanout cap at 10 (CP-04).**

The junction table lookup in `expand()` SHALL cap the number of hyperedges per seed node at 10: `LIMIT 10` on the `hyperedge_members` query. Probe finding: bounds the frontier (20 seeds × 10 hyperedges = 200 expand results max). Rare for a coding-agent corpus to have >10 hyperedges per node; the cap has negligible recall impact.

**[PF-5] Junction table pattern validated (links to SDD-03).**

The probe validated the junction table (`hyperedge_members`) pattern — the sdd-03 spike's fallback option that was never tested as a throwaway. The junction table with an index on `node_id` is the production approach for hyperedge storage. The `array<record> CONTAINSANY` approach (the original sdd-03 default) was 4x slower and is NOT recommended. SDD-03 has been updated to use the junction table.

**[PF-6] Session-scoped LRU cache for seed queries (CP-04, optimization).**

The seed query results SHALL be cached per session+query (like `AutoRecall.autoRecall`'s turnCache at recall.ts:201-207). Cache hit = 0ms. The first query in a session hits the HNSW index (~70ms); subsequent queries with the same text are instant. Cache invalidation on writes (new node stored → clear cache for that session). Stale results are acceptable (the bi-temporal `is_live` filter at read time catches deleted nodes).

**[PF-7] Quality metrics (validated, for reference).**

The probe's sixth run validated the hypergraph premise with 100 relational queries:
- ΔMRR = +0.0858 (threshold ≥ +0.05) — hypergraph beats baseline by 1.7x
- ΔRecall@5 = +0.0700 (threshold ≥ +0.05) — hypergraph beats baseline by 1.4x
- Both bootstrap 95% CIs exclude 0
- Per-arm Recall@5 (relational): vector=0.085, hybrid=0.010, **hypergraph=0.085**, pure-hypergraph=0.000

The pure-hypergraph arm (Arm 4, exact entity-match seeds only) scored 0 — confirming that vector seeding is required. The hypergraph adds value ONLY when paired with vector seeding (Arm 3). This is why the packer seeds from embeddings (CP-03) before expanding through the hypergraph (CP-04).

## Scope

In scope:
- `BudgetAwarePacker` in `src/memory/packing/` (new directory) — `ContextPacker.pack(query, project_id, budget)`
- `TypedFormatter` (extends `AutoRecall.formatForInjection` at recall.ts:279, does not replace it) — produces blocks for MEMORY, MESSAGE, ACTION, ERROR, PROCEDURE (5 packable active types)
- `ProvenanceTracker` — tracks injected IDs, feeds back to lifecycle on turn success (increments `usage_count` + `last_used` directly on the node via `Hypergraph.store`)
- `Session` service (`Context.Tag<SessionContext>`) — provides `sessionID` + `persona` to `pack` via `Effect.provideService`
- Wire `ContextPacker.pack` into `src/session/prompt.ts:1485` (system array assembly), push `packed.text` before `handle.process` at prompt.ts:1493
- Remove the M-0 autoRecall wire-up at `harness.ts:138-145` (keep tool-pattern prefetch at :147-174 and mesh check at :187-200)
- Config: `memory.packing.budget_tokens` (default 1024), `memory.packing.type_diversity` (default true), `memory.packing.expansion_mode` (default `"hypergraph"`) — SC-6
- Probe-gate: `tools/sdd` refuses to advance sdd-07 to `implement` until sdd-04 `tests` stage PASSED
- Spike: 1024-token budget cap against a real query — SC-7
- Conformance tests: no reserved node type and no ENTITY appears in `PackedContext.items`

Out of scope:
- Composite value scorer implementation (SDD-06) — consumed, not redefined
- `Hypergraph.query` implementation (SDD-03) — consumed
- Lifecycle decay mechanics (SDD-06) — `ProvenanceTracker.feedback` increments `usage_count` directly; decay reads it
- Verification benchmark (SDD-08)

## WHAT

### Probe-gating (council)

**[CP-00]** WHEN SDD-04 (the pre-registered retrieval-quality probe) has not PASSED, SDD-07 (M-4) SHALL NOT proceed to implementation — the `tools/sdd` pipeline SHALL refuse to advance sdd-07 from `spec` to `implement` until sdd-04's `tests` stage is green. WHEN the probe triggers terminal fallback A3 (hypergraph retrieval abandoned per master SC-11), SDD-07 SHALL be re-scoped over baseline retrieval by setting `memory.packing.expansion_mode = "one_hop"` — the packer uses Arm 2 (vector + 1-hop via existing `SurrealBackend.query` at surreal-backend.ts:203-292) instead of Arm 3 (vector + hypergraph via `Hypergraph.query`).

### ContextPacker service interface

**[CP-01]** WHEN `ContextPacker.pack(query, project_id, budget)` is called, it SHALL return a `PackedContext` of shape `{ text: string, items: Packed[], tokens: number }` where `text` is the formatted block ready to inject, `items` are the packed nodes (for provenance tracking), and `tokens` is `Token.estimate(text)`. The signature SHALL match master SC-5 exactly: `pack(query: string, project_id: string, budget: number): Effect<PackedContext>`.

**[CP-02]** WHEN `query` starts with `/` (slash command), `pack` SHALL return an empty `PackedContext` (`{ text: "", items: [], tokens: 0 }`) — delegating to the existing skip rule at recall.ts:187.

### Session context service

**[CP-02a]** WHEN `pack` needs `sessionID` and `persona` (for `AutoRecall.autoRecall`'s per-turn cache and persona-scoped recall), it SHALL resolve them from the `Session` service (`Context.Tag<SessionContext>`), provided by the wire-up via `Effect.provideService(Session, { sessionID, persona })`. The `Session` service SHALL be required (no default) — `pack` fails with a clear error if `Session` is not provided.

### Seeding

**[CP-03]** WHEN packing, the packer SHALL seed from embeddings by calling `AutoRecall.autoRecall` (recall.ts:185) — reusing the existing embed + `Memory.searchLocalWithEmbedding` + per-turn cache logic at recall.ts:200-261. The call SHALL pass `project_id` for project-scoped recall. Seeds are coerced to `Packed` items with `node_type = "memory"`.

### Schema subsetting (council CC-13)

**[CP-04a]** WHEN expanding and packing, the packer SHALL operate on the 6 active node types only (MESSAGE, ACTION, ERROR, MEMORY, PROCEDURE, ENTITY per master SC-1). The 7 reserved node types (TASK, AGENT, INSIGHT, MODALITY, COMMUNITY, ARCHETYPE, META_PROCEDURE) SHALL NOT be packed — no tables, no extraction paths, no packing paths per CC-13. A conformance test SHALL assert that no reserved `node_type` appears in `PackedContext.items` for any input.

**[CP-04b]** WHEN the packer expands via `Hypergraph.query`, ENTITY nodes SHALL be permitted as expansion seeds (query inputs that seed further traversal), but ENTITY nodes SHALL NOT appear in the final `PackedContext.items` — enforced by a type-filter in the packer (filter out `node_type === "entity"` after expansion, before formatting) and a conformance test that asserts no `entity` item appears in the packed output. ENTITY is expansion-input only per master SC-1.

### Expansion

**[CP-04]** WHEN seeds are found AND `memory.packing.expansion_mode === "hypergraph"` (default, requires probe PASSED per CP-00), the packer SHALL expand through hyperedges via `Hypergraph.query` (SDD-03 SC-5) with `depth >= 2`, passing the seed node IDs AND `project_id` for cross-project isolation. WHEN `expansion_mode === "one_hop"` (A3 re-scope), the packer SHALL expand via existing `SurrealBackend.query` (surreal-backend.ts:203-292) with 1-hop depth, passing `project_id`. WHEN `expansion_mode === "top_k"` (A6 degrade), the packer SHALL NOT expand — seeds alone are packed.

**[CP-05]** WHEN fusing seed results with expansion results, the packer SHALL apply Reciprocal Rank Fusion — reusing the existing RRF pattern from `SurrealBackend.query` (surreal-backend.ts:203-292) — and dedup by node ID.

**[CP-06]** WHEN expanding, the packer SHALL filter to live nodes via `is_live(now)` (master SC-2): both `tx_to` and `valid_to` windows open AND `status !== "deleted"`.

### Scoring

**[CP-07]** WHEN scoring, the packer SHALL apply the composite value scorer from SDD-06: `score = w_semantic * semantic + w_role * role + w_confidence * confidence + w_provenance * provenance + w_recency * recency + w_usage * usage + w_lifecycle * lifecycle`. Items are sorted by descending score.

### Packing

**[CP-08]** WHEN packing, the packer SHALL pack greedily by score: iterate items in descending score, add each item if `running_tokens + Token.estimate(item_text) <= budget`, stop otherwise.

**[CP-09]** WHEN `memory.packing.type_diversity` is `true` (default), the packer SHALL enforce type diversity: the packed set SHALL include at least one item per available `node_type` (subject to budget, over the 5 packable active types) before filling remaining budget with the highest-scored items.

**[CP-10]** WHEN `memory.packing.budget_tokens` is set, the packer SHALL use that value as the budget. WHEN unset, the packer SHALL default to `1024`. (CC-6: config consumed proven by test.)

### Formatting

**[CP-11]** WHEN `TypedFormatter.format(items)` is called, it SHALL produce the existing `## Relevant Memories` block for `MEMORY` items by delegating to `AutoRecall.formatForInjection` (recall.ts:279) — preserving the `[date, source] content (memory from N days ago — verify before acting)` format byte-for-byte.

**[CP-12]** WHEN `TypedFormatter.format(items)` is called, it SHALL add typed blocks for non-MEMORY active types, each preserving the `[date, source]` prefix and staleness suffix:
- `## Relevant Actions` for `ACTION` items — content: `tool name, input/output summary, success, step`
- `## Relevant Errors` for `ERROR` items — content: `error type, description, severity, corrected`
- `## Relevant Procedures` for `PROCEDURE` items — content: `name, steps count, success_rate, used_by_roles`

**[CP-12a]** WHEN `TypedFormatter.format(items)` is called, it SHALL produce a `## Relevant Messages` block for `MESSAGE` items — content: `content, step, modality, agent_id, task_id` — preserving the `[date, source]` prefix and staleness suffix. TypedFormatter SHALL produce blocks for the 5 packable active types only (MEMORY, MESSAGE, ACTION, ERROR, PROCEDURE); ENTITY and the 7 reserved types SHALL NOT produce a block (ENTITY is filtered out by CP-04b before formatting; reserved types are enum-only per CC-13).

**[CP-13]** WHEN formatting, each typed block SHALL preserve dates, sources, and staleness warnings — extending the existing format at recall.ts:300 (`memory from N days ago — verify before acting`) to all typed blocks, not just MEMORY.

### L0-L3 retrieval hierarchy

**[CP-14]** WHEN packing, the packer SHALL apply the TencentDB L0-L3 retrieval hierarchy (research §9, lines 266-272), subsetted to the 6 active node types per CC-13:
- L3 bootstrap: `PROCEDURE` nodes with `confidence >= 0.7` — packed first, regardless of recency, to bootstrap stable patterns. (`AGENT` and `INSIGHT` were removed from L3 — both are reserved types with no packing path per CC-13. `COMMUNITY`/`ARCHETYPE`/`META_PROCEDURE` L3/L4 multi-resolution is out of scope per master.)
- L1/L0 specific facts: `MEMORY`, `ACTION`, `ERROR`, `MESSAGE` nodes — packed by descending score to fill remaining budget. (`ENTITY` is expansion-input only, never packed per CP-04b.)

### Provenance tracking

**[CP-15]** WHEN `ProvenanceTracker.track(sessionID, items)` is called, it SHALL record the injected item IDs keyed by `sessionID`, in a session-scoped `Map<string, Packed[]>` (precedent: `sessionMemoryStore` at compaction.ts:69).

**[CP-16]** WHEN a turn succeeds, `ProvenanceTracker.feedback(sessionID, true, project_id)` SHALL increment `usage_count` and update `last_used` on each injected memory node directly via `Hypergraph.store` (fetch node, increment `usage_count`, set `last_used = now`, write back). The SDD-06 decay formula reads `usage_count` (as `access(t)`) on its next hourly tick — the rehearsal boost happens naturally in decay. WHEN the turn fails, `feedback(sessionID, false, project_id)` SHALL NOT increment anything.

### Injection

**[CP-17]** WHEN the session prompt is assembled (prompt.ts:1485), the `system` array SHALL include `packed.text`: `ContextPacker.pack(query, project_id, budget)` is called before line 1485 (with `Session` service provided), and `packed.text` is pushed into the `system` array (after `instructions`, before `handle.process` at prompt.ts:1493).

**[CP-18]** WHEN M-4 completes, the M-0 autoRecall wire-up at `harness.ts:138-145` (the `deps.autoRecall` + `deps.formatForInjection` block) SHALL be removed. The tool-pattern prefetch at `harness.ts:147-174` and mesh check at `harness.ts:187-200` SHALL remain. `getRecallInjection()` at harness.ts:205 SHALL return `null` (no longer set by the removed block).

### Abort A6 (council, master SC-11)

**[CP-20]** WHEN `pack()` P95 latency exceeds 300ms and is unfixable after one tuning round (abort A6 per master SC-11), the system SHALL degrade to top-k baseline packing by setting `memory.packing.expansion_mode = "top_k"` — the packer skips expansion and packs seeds from `AutoRecall.autoRecall` only, ranked by the SDD-06 composite scorer via greedy top-k within budget. A conformance test SHALL verify the `top_k` path produces a valid `PackedContext` (`text`, `items`, `tokens`) with `items` drawn only from `AutoRecall.autoRecall` seeds (no `Hypergraph.query` call, no `SurrealBackend.query` expansion call) and `Token.estimate(text) <= budget` under 300ms P95.

### Spike (SC-7)

**[CP-19]** WHEN the spike test runs, the packer SHALL produce a `PackedContext` with `Token.estimate(text) <= budget_tokens` for a 1024-token budget against a real query. The spike test SHALL populate a fixture graph with at least 3 node types (MEMORY + ACTION + ERROR) before running, so the type-diversity assertion is unconditional on the fixture: the packed set SHALL contain items of more than one `node_type`. IF the spike fails (greedy overshoots budget), the packer SHALL fall back to hard token cap + truncate: `text = text.slice(0, budget * 4)`.

## HOW

### New files

```
src/memory/packing/
  schema.ts      — Packed, PackedContext, NodeType, SessionContext, ExpansionMode types
  packer.ts      — ContextPacker namespace (pack, seed, expand, fuse, score, greedy)
  formatter.ts   — TypedFormatter namespace (format, formatMessages, formatActions, formatErrors, formatProcedures)
  tracker.ts     — ProvenanceTracker namespace (track, feedback)
```

### Reuse map

| Component | Reused from | Anchor |
|---|---|---|
| Seed: embed + search + turn cache | `AutoRecall.autoRecall` | recall.ts:185 |
| MEMORY block formatting | `AutoRecall.formatForInjection` | recall.ts:279 |
| Staleness warning format | `formatForInjection` line builder | recall.ts:300 |
| Embedding service | `@foxybear/Embedding` (called transitively by `autoRecall`) | embedding.ts:19 |
| Token estimation | `Token.estimate` (chars/4) | util/token.ts:1 |
| RRF fusion pattern | `SurrealBackend.query` hybrid retrieval | surreal-backend.ts:203-292 |
| 1-hop expansion (A3 fallback, Arm 2) | `SurrealBackend.query` hybrid retrieval | surreal-backend.ts:203-292 |
| Hypergraph expansion (Arm 3, default) | `Hypergraph.query(seeds, project_id, opts)` | SDD-03 SC-5 |
| Hypergraph store (for feedback updates) | `Hypergraph.store(node)` | SDD-03 SC-5 |
| Composite scoring | composite value scorer | SDD-06 |
| Bi-temporal live filter | `is_live(now)` | master SC-2 |
| Session-scoped store precedent | `sessionMemoryStore` (Map by sessionID) | compaction.ts:69 |
| Config reader | `getConfig()` | config/bridge.ts |

### Types (`schema.ts`)

```typescript
// 6 active node types per master SC-1/CC-13. 7 reserved types (TASK, AGENT, INSIGHT,
// MODALITY, COMMUNITY, ARCHETYPE, META_PROCEDURE) are enum-only — not in this union's
// packing path. ENTITY is expansion-input only (CP-04b) — never appears in PackedContext.items.
export type NodeType = "memory" | "action" | "error" | "message" | "procedure" | "entity"

// Reserved (enum-only, no packing path) — defined here for the conformance test's exclusion set:
export type ReservedNodeType = "task" | "agent" | "insight" | "modality" | "community" | "archetype" | "meta_procedure"

export interface Packed {
  id: string
  node_type: NodeType
  content: string
  source: string
  created_at: string
  score: number
  attributes: Record<string, unknown>
}

export interface PackedContext {
  text: string
  items: Packed[]
  tokens: number
}

export interface SessionContext {
  sessionID: string
  persona: string
}

// Session service — required (no default). Provided by the wire-up via Effect.provideService.
export const Session = Context.Tag<SessionContext>("@foxybear/ContextPacker/Session")

// Expansion mode — default "hypergraph" (requires probe PASSED per CP-00).
// "one_hop" = A3 fallback (Arm 2, vector + 1-hop via SurrealBackend.query).
// "top_k" = A6 fallback (Arm 1, vector seeds only, no expansion).
export type ExpansionMode = "hypergraph" | "one_hop" | "top_k"
```

### `ContextPacker.pack` (`packer.ts`)

```typescript
export namespace ContextPacker {
  export const Service = Context.Service<Service, Interface>()("@foxybear/ContextPacker")

  export const pack = Effect.fn("ContextPacker.pack")(function* (query: string, project_id: string, budget: number) {
    if (query.startsWith("/")) return { text: "", items: [], tokens: 0 }

    const session = yield* Session                                    // provided by wire-up
    const cfg = yield* config.get()
    const mode = cfg.memory?.packing?.expansion_mode ?? "hypergraph"  // CP-00, CP-04, CP-20

    const seeds = yield* Effect.promise(() =>
      AutoRecall.autoRecall({ query, sessionID: session.sessionID, persona: session.persona, project_id })
    )
    const seedItems = seeds.map(toPacked)                             // node_type = "memory"

    // CP-04: expansion path selected by mode (default hypergraph, A3 → one_hop, A6 → top_k).
    let expandedItems: Packed[] = []
    if (mode === "hypergraph") {
      const expanded = yield* Hypergraph.query(seedItems.map(s => s.id), project_id, { depth: 2 })
      expandedItems = expanded.nodes.map(toPacked)
    } else if (mode === "one_hop") {
      // A3 fallback: existing 1-hop hybrid retrieval (surreal-backend.ts:203-292).
      const expanded = yield* Effect.promise(() =>
        SurrealBackend.query({ seeds: seedItems.map(s => s.id), project_id, depth: 1 })
      )
      expandedItems = expanded.nodes.map(toPacked)
    }
    // mode === "top_k": no expansion (A6 degrade).

    // CP-04a, CP-04b: filter to 6 active types, drop ENTITY (expansion-input only).
    const fused = rrfFuse(seedItems, expandedItems)
      .filter(isActiveType)
      .filter(n => n.node_type !== "entity")
    const scored = fused.map(score)                                   // SDD-06 composite scorer
    const bootstrapped = bootstrapL3(scored)                          // L3 first (CP-14)
    const packed = greedy(bootstrapped, budget, typeDiversity)         // CP-08, CP-09
    const text = TypedFormatter.format(packed)                        // CP-11, CP-12, CP-12a, CP-13
    const tokens = Token.estimate(text)
    yield* ProvenanceTracker.track(session.sessionID, packed)         // CP-15
    return { text, items: packed, tokens }
  })

  // CP-04a: 6 active types only. Reserved types never enter this union's packing path.
  function isActiveType(n: Packed): boolean {
    return ["memory", "action", "error", "message", "procedure", "entity"].includes(n.node_type)
  }
}
```

### `TypedFormatter.format` (`formatter.ts`)

```typescript
export namespace TypedFormatter {
  export function format(items: Packed[]): string {
    if (items.length === 0) return ""

    const memories = items.filter(i => i.node_type === "memory")
    const memoryBlock = AutoRecall.formatForInjection(memories.map(toMemoryResult))  // CP-11: delegate, don't replace

    const blocks = [memoryBlock]
    const messages = items.filter(i => i.node_type === "message")
    const actions = items.filter(i => i.node_type === "action")
    const errors = items.filter(i => i.node_type === "error")
    const procedures = items.filter(i => i.node_type === "procedure")
    if (messages.length) blocks.push(formatMessages(messages))        // CP-12a
    if (actions.length) blocks.push(formatActions(actions))
    if (errors.length) blocks.push(formatErrors(errors))
    if (procedures.length) blocks.push(formatProcedures(procedures))

    return blocks.filter(Boolean).join("\n\n")
  }

  function formatMessages(items: Packed[]): string {
    const lines = ["## Relevant Messages"]
    items.forEach((item, i) => {
      const days = getDaysAgo(item.created_at)
      const a = item.attributes
      let line = `${i + 1}. [${formatDate(item.created_at)}, ${item.source}] ${item.content} (step ${a.step}, ${a.modality}, agent ${a.agent_id}, task ${a.task_id})`
      if (days > staleDays()) line += ` (memory from ${days} days ago — verify before acting)`
      lines.push(line)
    })
    return lines.join("\n")
  }

  function formatActions(items: Packed[]): string {
    const lines = ["## Relevant Actions"]
    items.forEach((item, i) => {
      const days = getDaysAgo(item.created_at)
      const a = item.attributes
      let line = `${i + 1}. [${formatDate(item.created_at)}, ${item.source}] ${a.tool}: ${a.input} → ${a.output} (${a.success ? "ok" : "fail"}, step ${a.step})`
      if (days > staleDays()) line += ` (memory from ${days} days ago — verify before acting)`
      lines.push(line)
    })
    return lines.join("\n")
  }
}
```

### `ProvenanceTracker` (`tracker.ts`)

```typescript
export namespace ProvenanceTracker {
  const store = new Map<string, Packed[]>()                           // sessionID -> last injected items

  export function track(sessionID: string, items: Packed[]): void {
    store.set(sessionID, items)
  }

  // B1 fix: increment usage_count + last_used directly on the node via Hypergraph.store.
  // SDD-06's decay formula reads usage_count (as access(t)) on its next hourly tick —
  // the rehearsal boost happens naturally in decay. No standalone rehearse() method.
  export const feedback = Effect.fn("ProvenanceTracker.feedback")(function* (sessionID: string, ok: boolean, project_id: string) {
    if (!ok) return
    const items = store.get(sessionID) ?? []
    const now = Math.floor(Date.now() / 1000)                         // epoch seconds (SC-2)
    for (const item of items) {
      // Fetch the node, increment usage_count, update last_used, write back.
      const nodes = yield* Hypergraph.neighbors(item.id, project_id)  // fetch the node (neighbors returns the node itself when depth=0)
      const node = nodes.find(n => n.node_id === item.id)
      if (!node) continue
      const updated = {
        ...node,
        attributes: {
          ...node.attributes,
          usage_count: (node.attributes.usage_count as number ?? 0) + 1,
          last_used: now,
        },
        updated_at: now,
      }
      yield* Hypergraph.store(updated)                                // write back the increment
    }
    store.delete(sessionID)
  })
}
```

### Wire-up (`src/session/prompt.ts:1485`)

Before the `system` array assembly at prompt.ts:1485, insert the packer call and push the result. The wire-up provides the `Session` service via `Effect.provideService`:

```typescript
// Existing line 1483-1484:
const personaSession = PersonaSession.get(sessionID) ?? PersonaSession.getDefault()
const personaPrompt = personaSession?.systemPrompt
const persona = personaSession?.name ?? "default"
const project_id = session.project_id                                  // from session context
const cfg = yield* config.get()
const budget = cfg.memory?.packing?.budget_tokens ?? 1024

// NEW — call pack with project_id + budget, provide Session service:
const packed = yield* ContextPacker.pack(query, project_id, budget).pipe(
  Effect.provideService(Session, { sessionID, persona })
)

// Existing line 1485 (modified):
const system = [
  ...(personaPrompt ? [personaPrompt] : []),
  ...env,
  ...(skills ? [skills] : []),
  ...instructions,
  ...(packed.text ? [packed.text] : []),                              // NEW
]
```

`query` is the current user input; `budget` is read from `memory.packing.budget_tokens` via `config.get()`; `project_id` is read from the session context; `sessionID` + `persona` are provided to `pack` via the `Session` service. `expansion_mode` is read inside `pack` from `config.get()` to select the expansion path (CP-04, CP-00, CP-20).

### Removal of M-0 wire-up (`harness.ts:138-145`)

Remove the block:
```typescript
const results = await deps.autoRecall({ query: userInput, persona, sessionID, workforceUrl })
const formatted = deps.formatForInjection(results)
_recallInjection = formatted || null
```

Keep:
- Tool-pattern prefetch at harness.ts:147-174 (still writes to `_recallInjection` for the prefetch note — this becomes the only writer)
- Mesh check at harness.ts:187-200
- `getRecallInjection()` at harness.ts:205 (now returns the prefetch note only, or null)

### Config (SC-6)

```json
"memory": {
  "packing": {
    "budget_tokens": 1024,
    "type_diversity": true,
    "expansion_mode": "hypergraph"
  }
}
```

Read via `config.get()` at the wire-up (prompt.ts) and inside `pack` (for `expansion_mode`). Default `budget_tokens = 1024` when absent. Default `expansion_mode = "hypergraph"` when absent (requires probe PASSED per CP-00). `expansion_mode = "one_hop"` is set by the human gate when A3 fires. `expansion_mode = "top_k"` is set by the human gate when A6 fires. `budget` is passed as a parameter to `pack`; `expansion_mode` is read inside `pack` to select the expansion path.

### Style

- Single-word names: `pack`, `format`, `track`, `seed`, `expand`, `fuse`, `score`, `greedy` — NOT `packContext`, `formatBlocks`, `trackProvenance`.
- `Bun.file()` over `fs`, `const` over `let`, early returns over `else`, no `any`.
- Effect services: `Layer.effect`, `Effect.fn("ContextPacker.pack")`, `Effect.gen` composition, `Context.Tag` for value services.
- Tests run from `development/foxybear/packages/fbh` (guard: `do-not-run-tests-from-root`).
- Tests SHALL NOT mock the implementation under test (CC-9). Spies on `AutoRecall.autoRecall` and `Hypergraph.query` are allowed (observation, not substitution).

## VERIFY

Tests run from `development/foxybear/packages/fbh` via `bun test --timeout 30000`. Each test maps 1:1 to a WHEN/SHALL.

| Test | WHEN/SHALL | Asserts |
|---|---|---|
| `pack.test.ts: returns PackedContext shape` | CP-01 | `pack(query, project_id, 1024)` returns `{ text, items, tokens }` with correct types |
| `pack.test.ts: skips slash commands` | CP-02 | `pack("/help", project_id, 1024)` returns `{ text: "", items: [], tokens: 0 }` |
| `pack.test.ts: resolves session from Session service` | CP-02a | `pack` without `Session` provided fails; with `Session` provided, resolves `sessionID` + `persona` |
| `pack.test.ts: seeds from AutoRecall` | CP-03 | spy confirms `AutoRecall.autoRecall` called with `project_id` |
| `pack.test.ts: active types only` | CP-04a | fixture inserts a `task` (reserved) node; packed `items` contains no `task` (or any reserved `node_type`) |
| `pack.test.ts: ENTITY filtered from output` | CP-04b | fixture inserts an `entity` seed; `entity` appears in `Hypergraph.query` input seeds but NOT in `packed.items` |
| `pack.test.ts: expands via Hypergraph.query` | CP-04 | with `expansion_mode = "hypergraph"`, spy confirms `Hypergraph.query` called with seed IDs, `project_id`, `depth >= 2` |
| `pack.test.ts: one_hop fallback uses SurrealBackend.query` | CP-00, CP-04 | with `expansion_mode = "one_hop"`, spy confirms `SurrealBackend.query` called; `Hypergraph.query` NOT called |
| `pack.test.ts: top_k fallback skips expansion` | CP-04, CP-20 | with `expansion_mode = "top_k"`, neither `Hypergraph.query` nor `SurrealBackend.query` is called; packed items are seeds only |
| `pack.test.ts: fuses via RRF` | CP-05 | fused items contain seeds + expansion, deduped by ID |
| `pack.test.ts: filters dead nodes` | CP-06 | a node with `status = "deleted"` or `tx_to < now` is excluded |
| `pack.test.ts: scores via composite scorer` | CP-07 | items sorted by composite score descending (fixture scorer returns known scores) |
| `pack.test.ts: respects budget` | CP-08, CP-19 | `Token.estimate(packed.text) <= 1024` |
| `pack.test.ts: type diversity` | CP-09 | with `type_diversity = true` and a fixture graph containing 3 node types, packed set has >= 1 of each (subject to budget) |
| `pack.test.ts: budget from config` | CP-10, CC-6 | change `memory.packing.budget_tokens` to 512, assert `tokens <= 512` |
| `pack.test.ts: type diversity disabled` | CP-09 | with `type_diversity = false`, packed set is pure greedy by score (no type floor) |
| `formatter.test.ts: MEMORY block delegates` | CP-11 | MEMORY items produce output byte-identical to `AutoRecall.formatForInjection` on the same `MemoryResult[]` |
| `formatter.test.ts: typed blocks` | CP-12 | ACTION items produce `## Relevant Actions`; ERROR → `## Relevant Errors`; PROCEDURE → `## Relevant Procedures` |
| `formatter.test.ts: MESSAGE block` | CP-12a | MESSAGE items produce `## Relevant Messages` with `content, step, modality, agent_id, task_id` |
| `formatter.test.ts: no ENTITY or reserved block` | CP-12a | ENTITY items (if any reach formatter) and reserved types produce no block (empty output for those items) |
| `formatter.test.ts: staleness preserved` | CP-13 | items older than `stale_warning_days` carry `verify before acting` across all typed blocks |
| `pack.test.ts: L3 bootstrap first` | CP-14 | a high-confidence `PROCEDURE` (confidence 0.9) is packed before a higher-score `MEMORY` |
| `tracker.test.ts: track records IDs` | CP-15 | after `track("s1", items)`, internal store returns the item IDs for `"s1"` |
| `tracker.test.ts: feedback on success increments usage_count` | CP-16 | `feedback("s1", true, project_id)` increments `usage_count` on each tracked node via `Hypergraph.store`; `last_used` set to now |
| `tracker.test.ts: no feedback on failure` | CP-16 | `feedback("s1", false, project_id)` does NOT call `Hypergraph.store` |
| `tracker.test.ts: feedback clears store` | CP-16 | after `feedback("s1", true, project_id)`, store no longer holds `"s1"` |
| `prompt.test.ts: packed injected` | CP-17 | after running `prompt()`, the `system` array passed to `handle.process` contains `packed.text` |
| `harness.test.ts: autoRecall removed` | CP-18 | `harness.ts` no longer references `deps.autoRecall`; tool-pattern prefetch at :147-174 remains |
| `spike.test.ts: budget cap with multi-type fixture` | CP-19 | fixture populates MEMORY + ACTION + ERROR; real query, 1024 budget: `Token.estimate(packed.text) <= 1024` AND `items.length > 0` AND `new Set(items.map(i => i.node_type)).size > 1` |
| `conformance.test.ts: no reserved types in output` | CP-04a | fixture inserts all 7 reserved types + 6 active types; packed `items` contains only active `node_type` values; no `task`, `agent`, `insight`, `modality`, `community`, `archetype`, `meta_procedure` appears |
| `conformance.test.ts: no ENTITY in output` | CP-04b | fixture inserts `entity` nodes as seeds; packed `items` contains no `entity` (entity appears in `Hypergraph.query` call args but not in packed output) |
| `conformance.test.ts: top_k path under 300ms P95` | CP-20 | with `expansion_mode = "top_k"`, 100-iteration P95 of `pack()` is < 300ms; `items` are seeds only (no `Hypergraph.query` call) |

### Probe-gate enforcement (CP-00)

The `tools/sdd` pipeline SHALL refuse to advance sdd-07 from `spec` to `implement` until sdd-04's `tests` stage is green. This is enforced in the workstream state machine (`tools/sdd/workstreams/fbh-phase-m.json`), not in test code — it's a process gate, not a runtime check.

### Spike test (SC-7)

```typescript
// packages/fbh/src/memory/packing/spike.test.ts
import { Hypergraph } from "../schema/hypergraph"   // SDD-03
import { ContextPacker, Session } from "./schema"
import { Token } from "../../util/token"

test("spike: 1024-token budget cap against real query with multi-type fixture", async () => {
  // B3 fix: fixture populates 3 node types so the type-diversity assertion is unconditional on the fixture.
  const project_id = "spike-test"
  await runPromise(() => Hypergraph.store({ node_id: "m1", node_type: "memory", content: "SurrealDB config for fbh", ... }))
  await runPromise(() => Hypergraph.store({ node_id: "a1", node_type: "action", content: "configure SurrealDB", attributes: { tool: "edit", ... } }))
  await runPromise(() => Hypergraph.store({ node_id: "e1", node_type: "error", content: "connection refused", ... }))

  const packed = await runPromise(ContextPacker.pack("how do I configure SurrealDB for fbh?", project_id, 1024).pipe(
    Effect.provideService(Session, { sessionID: "spike", persona: "default" })
  ))
  expect(Token.estimate(packed.text)).toBeLessThanOrEqual(1024)
  expect(packed.items.length).toBeGreaterThan(0)
  const types = new Set(packed.items.map(i => i.node_type))
  expect(types.size).toBeGreaterThan(1)
})
```

**Pass criterion:** `Token.estimate(packed.text) <= 1024` AND `types.size > 1` (fixture guarantees multi-type availability).
**Fallback (if spike fails):** hard token cap + truncate — `text = text.slice(0, budget * 4)` in `ContextPacker.pack` before returning. The spike test stays green under the fallback.

## Dependencies

- **SDD-06** (M-3 lifecycle — composite scorer + decay formula) — `pack` uses the scorer to rank items; `feedback` increments `usage_count` which SDD-06's decay formula reads as `access(t)` on its hourly tick. Blocked until SDD-06 `implement` passes. (Note: `MemoryLifecycle.rehearse` does NOT exist — SDD-06's decay formula reads `usage_count` directly during its hourly tick; `feedback` increments `usage_count` via `Hypergraph.store`.)
- **SDD-04** (pre-registered probe) — M-4 SHALL NOT proceed to implementation until SDD-04's `tests` stage PASSED (CP-00). If A3 fires (probe fails relational stratum), M-4 is re-scoped to `expansion_mode = "one_hop"` (Arm 2 via `SurrealBackend.query`).
- **SDD-03** (M-1 hypergraph schema — `Hypergraph.query`, `Hypergraph.store`, `Node` type) — `pack` calls `Hypergraph.query(seeds, project_id, { depth: 2 })` when `expansion_mode = "hypergraph"`; `feedback` calls `Hypergraph.store` to update `usage_count`. Blocked until SDD-03 `implement` passes.
- **SDD-02** (M-0 wire-up) — M-4 removes the M-0 `autoRecall` block at harness.ts:138-145. Requires M-0 to have landed first so the removal is well-defined.
