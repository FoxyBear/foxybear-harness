# SDD: Injection Fix — Hybrid Seed from `memory` + `node` Tables

**Date:** 2026-09-27
**Project:** FoxyBear Harness Phase N (injection fix)
**Status:** Draft → immediate implementation (focused fix, not full workstream)
**Context:** Phase N captures quality memories into the `node` table via `classify`. But `AutoRecall.autoRecall` (the seed source for `ContextPacker.pack`) only queries the `memory` table via `SurrealBackend.query`. Phase N memories are invisible to injection.

## WHAT

1. **WHEN** `AutoRecall.autoRecall` runs, it **SHALL** query BOTH the `memory` table (existing, via `SurrealBackend.query`) AND the `node` table (new, via `SurrealHypergraphBackend.query` with HNSW KNN + project_id), then RRF-fuse the results.

2. **WHEN** the `node` table query returns results, they **SHALL** be mapped to `MemoryResult` shape (node_id → id, attributes.content → content, attributes.memory_type → type, etc.) for compatibility with the existing formatting pipeline.

3. **WHEN** both queries return results, RRF fusion **SHALL** combine them with equal weight (k=60 constant, standard RRF). The `memory` table results are not weighted higher than `node` table results — both contribute equally.

4. **WHEN** the `SurrealHypergraphBackend` is not registered (e.g. memory.enabled=false or graph_backend=sqlite), the `node` query **SHALL** be skipped gracefully (only `memory` results returned).

5. **WHEN** the `node` query returns 0 results (no Phase N memories yet for this project), the behavior **SHALL** be identical to the current behavior (only `memory` results returned).

6. **WHEN** the embedding fails (both providers down), both queries **SHALL** be skipped (existing behavior — return []).

7. **WHEN** the `node` query returns results, the `MemoryResult` **SHALL** include `attributes.memory_type` as the `type` field (for typed block formatting in `TypedFormatter`).

8. **WHEN** the query to the `node` table errors or times out, it **SHALL** be caught and logged — the `memory` table results **SHALL** still be returned (graceful degradation).

## HOW

### File: `src/memory/recall.ts`

In `AutoRecall.autoRecall`, after the existing `Memory.searchLocalWithEmbedding` call (line 231):

1. Call `SurrealHypergraphBackend.query` (via `getGlobalHypergraphBackend`) with:
   - HNSW KNN seed: `SELECT id, attributes.content, attributes.memory_type, embedding FROM node WHERE embedding <|20,COSINE|> $qvec AND node_type = "MEMORY" AND attributes.project_id = $project_id AND status = "ACTIVE" LIMIT 20`
   - The query embedding from the existing `embedResult.value`
   - The project_id from the input

2. Map the `node` results to `MemoryResult`:
   - `id` = node_id
   - `content` = attributes.content
   - `type` = attributes.memory_type
   - `score` = cosine similarity (from the query)
   - `source` = "hypergraph"
   - `metadata` = attributes (for TypedFormatter to access memory_type)

3. RRF-fuse the `memory` results and `node` results:
   - `score(rrf) = 1 / (k + rank_in_memory) + 1 / (k + rank_in_node)` where k=60
   - Sort by RRF score descending
   - Deduplicate by content (if the same memory exists in both tables)

4. Return the fused results (same `MemoryResult[]` shape)

### What NOT to change

- `ContextPacker.pack` — unchanged. It already calls `AutoRecall.autoRecall` and formats the results. No changes needed.
- `TypedFormatter` — unchanged. It already formats by type. The `node` results now carry `type` via the `MemoryResult` mapping.
- `SurrealBackend.query` — unchanged. The `memory` table query stays as-is.
- `SurrealHypergraphBackend` — unchanged. Its `query` method already does HNSW KNN.

## VERIFY

1. `bun run typecheck` exits 0
2. After implementing, the "## Relevant Memories" block in a live session **SHALL** include memories stored by the Phase N `classify` pipeline (not just the old `memory` table rows)
3. The `node` table query uses `<|K,COSINE|>` HNSW KNN (not `ORDER BY cosine`) — the probe-validated pattern
4. The `node` query is scoped to `project_id` (cross-project isolation)
5. Graceful degradation when hypergraph backend is absent or errors
