import { Effect } from "effect"
import { AutoRecall, type MemoryResult } from "../recall"
import { score as compositeScore } from "../lifecycle/score"
import { getGlobalHypergraphBackend } from "../backend-registry"
import type { NodeRecord } from "../surreal-hypergraph-backend"
import type { NodeType, LifecycleStatus } from "../schema/enums"
import { Token } from "../../util/token"
import { getConfig } from "../../config/bridge"
import { Log } from "../../util/log"
import { Session, type Packed, type PackedContext, type ExpansionMode } from "./schema"
import { TypedFormatter } from "./formatter"
import { ProvenanceTracker } from "./tracker"

const log = Log.create({ service: "memory.packing" })

// PF-1: HNSW KNN seed query (MANDATORY per probe findings 2026-09-23).
// Uses the <|K,COSINE|> KNN operator with an AND clause on project_id that
// PUSHES the filter INTO the HNSW scan, reducing the scan set from ~10k to
// ~2.5k. Probe result: 70ms P95.
//
// The FORBIDDEN alternative (ORDER BY vector::similarity::cosine) does NOT
// use the HNSW index — probe result: 349ms P95, 5x slower. Without any
// pre-filter (scanning all 10k nodes), P95 is 401ms. The <|K,COSINE|> +
// AND pattern is the ONLY approach that passes the 100ms budget on
// SurrealDB 3.0.5.
//
// This constant documents the production seed query. The packer delegates
// seeding to AutoRecall.autoRecall (CP-03) which reuses the existing embed +
// search + per-turn cache logic; AutoRecall will be upgraded to use this
// <|K,COSINE|> query in a follow-up so the seed path matches the probe's
// validated latency.
export const SEED_QUERY_HNSW_KNN = `
  SELECT id, embedding FROM node
  WHERE embedding <|20,COSINE|> $qvec
    AND attributes.project_id = $project_id
    AND array::len(embedding) = 768
`

// PF-6: session-scoped LRU cache for seed queries. Cache hit = 0ms.
// First query in a session hits the HNSW index (~70ms); subsequent queries
// with the same text are instant. Cache invalidation on writes (new node
// stored → clear cache for that session). Stale results are acceptable (the
// bi-temporal is_live filter at read time catches deleted nodes).
const seedCache = new Map<string, Packed[]>()
const SEED_CACHE_MAX = 64

function cacheKey(sessionID: string, query: string, project_id: string): string {
  return sessionID + "|" + project_id + "|" + query
}

function cacheGet(key: string): Packed[] | null {
  const v = seedCache.get(key) ?? null
  if (v) {
    // LRU: move to end (re-insert) so the most-recently-used survives eviction.
    seedCache.delete(key)
    seedCache.set(key, v)
  }
  return v
}

function cacheSet(key: string, items: Packed[]): void {
  if (seedCache.size >= SEED_CACHE_MAX) {
    // Evict oldest (first key) — Map preserves insertion order in JS.
    const first = seedCache.keys().next().value
    if (first) seedCache.delete(first)
  }
  seedCache.set(key, items)
}

// 5 packable active types (MEMORY, MESSAGE, ACTION, ERROR, PROCEDURE).
// ENTITY is expansion-input only — filtered out before formatting (CP-04b).
const ACTIVE_PACKABLE: NodeType[] = ["MEMORY", "ACTION", "ERROR", "MESSAGE", "PROCEDURE"]

function toPacked(r: MemoryResult): Packed {
  return {
    id: r.id,
    node_type: "MEMORY",
    content: r.content,
    source: r.source,
    created_at: r.created_at,
    score: r.score,
    attributes: {
      persona: r.persona,
      scope: r.scope,
      access_count: r.access_count,
      accessed_at: r.accessed_at,
      metadata: r.metadata,
    },
  }
}

function toPackedFromNode(n: NodeRecord): Packed {
  return {
    id: n.node_id,
    node_type: n.node_type,
    content: String(n.attributes.content ?? ""),
    source: String(n.attributes.source ?? "hypergraph"),
    created_at: String(n.created_at * 1000),
    score: 0,
    attributes: {
      ...n.attributes,
      // Surface bi-temporal fields into attributes so isLivePacked can read
      // them without a NodeRecord round-trip.
      tx_to: n.tx_to,
      valid_to: n.valid_to,
      status: n.status,
    },
  }
}

// CP-06: filter to live nodes via is_live(now) — both tx_to and valid_to
// windows open AND status !== "deleted" (master SC-2).
function isLivePacked(p: Packed): boolean {
  const now = Math.floor(Date.now() / 1000)
  const txTo = Number(p.attributes.tx_to ?? Infinity)
  const validTo = Number(p.attributes.valid_to ?? Infinity)
  const status = String(p.attributes.status ?? "ACTIVE")
  const txOpen = txTo === Infinity || txTo > now
  const validOpen = validTo === Infinity || validTo > now
  return txOpen && validOpen && status !== "DELETED"
}

function toNodeRecord(p: Packed): NodeRecord {
  const created = Math.floor(Number(p.created_at) / 1000) || 0
  return {
    node_id: p.id,
    node_type: p.node_type,
    created_at: created,
    updated_at: created,
    version: 1,
    status: String(p.attributes.status ?? "ACTIVE") as LifecycleStatus,
    embedding: null,
    attributes: p.attributes,
    valid_from: Number(p.attributes.valid_from ?? 0),
    valid_to: Number(p.attributes.valid_to ?? Infinity),
    tx_from: Number(p.attributes.tx_from ?? 0),
    tx_to: Number(p.attributes.tx_to ?? Infinity),
    prev_version_id: null,
    invalidated_by: null,
  }
}

// CP-05: Reciprocal Rank Fusion. Reuses the rrf pattern from
// surreal-backend.ts:655 — dedup by node ID.
function rrfFuse(seeds: Packed[], expanded: Packed[]): Packed[] {
  const K = 60
  const scores = new Map<string, number>()
  const byId = new Map<string, Packed>()
  const rankings = [seeds, expanded]
  for (const ranking of rankings) {
    ranking.forEach((p, rank) => {
      scores.set(p.id, (scores.get(p.id) ?? 0) + 1 / (K + rank + 1))
      byId.set(p.id, p)
    })
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id)!)
}

// CP-14: L3 bootstrap — high-confidence PROCEDURE nodes packed first,
// regardless of recency, to bootstrap stable patterns. Subsetted per
// CC-13: AGENT and INSIGHT removed (reserved types with no packing path).
function bootstrap(items: Packed[]): Packed[] {
  const isL3 = (p: Packed) =>
    p.node_type === "PROCEDURE" && Number(p.attributes.confidence ?? 0) >= 0.7
  const l3 = items.filter(isL3)
  const rest = items.filter(p => !isL3(p))
  return [...l3, ...rest]
}

// CP-08, CP-09: greedy pack by score with optional type diversity.
function greedy(items: Packed[], budget: number, typeDiversity: boolean): Packed[] {
  const sorted = [...items].sort((a, b) => b.score - a.score)
  const packed: Packed[] = []
  let tokens = 0

  if (typeDiversity) {
    // CP-09: at least one item per available node_type before filling.
    for (const t of ACTIVE_PACKABLE) {
      const item = sorted.find(p => p.node_type === t && !packed.includes(p))
      if (!item) continue
      const est = Token.estimate(TypedFormatter.format([item]))
      if (tokens + est <= budget) {
        packed.push(item)
        tokens += est
      }
    }
  }

  // CP-08: fill remaining budget with the highest-scored items.
  for (const item of sorted) {
    if (packed.includes(item)) continue
    const est = Token.estimate(TypedFormatter.format([item]))
    if (tokens + est > budget) continue
    packed.push(item)
    tokens += est
  }

  return packed
}

/**
 * SDD-07 / Phase M-4 — ContextPacker.
 *
 * pack(query, project_id, budget): Effect<PackedContext>. Seeds from
 * AutoRecall.autoRecall (CP-03), expands through the hypergraph (CP-04,
 * PF-1..PF-4), fuses via RRF (CP-05), filters to live + active types
 * (CP-04a, CP-04b, CP-06), scores via the composite scorer (CP-07),
 * bootstraps L3 procedures (CP-14), packs greedily with type diversity
 * (CP-08, CP-09), formats via TypedFormatter (CP-11..CP-13), and tracks
 * provenance (CP-15).
 *
 * Skips slash commands (CP-02). Resolves sessionID + persona from the
 * Session service (CP-02a). Degrades to top_k (no expansion) when
 * expansion_mode = "top_k" (CP-20, abort A6).
 */
export namespace ContextPacker {
  export const pack = Effect.fn("ContextPacker.pack")(function* (
    query: string,
    project_id: string,
    budget: number,
  ) {
    // CP-02: skip slash commands — delegates to the existing skip rule at
    // recall.ts:187.
    if (query.startsWith("/")) return { text: "", items: [], tokens: 0 }

    // CP-02a: resolve sessionID + persona from the Session service.
    const session = yield* Session

    // Config: expansion_mode (CP-04, CP-00, CP-20), type_diversity (CP-09).
    const cfg = yield* Effect.promise(() => getConfig())
    const packing = cfg?.memory?.packing
    const mode: ExpansionMode = packing?.expansion_mode ?? "hypergraph"
    const typeDiversity: boolean = packing?.type_diversity ?? true

    // PF-6: session-scoped LRU cache for seed queries.
    const cKey = cacheKey(session.sessionID, query, project_id)
    const cached = cacheGet(cKey)
    let seeds: Packed[] = cached ?? []
    if (!cached) {
      // CP-03: seed from AutoRecall.autoRecall — reuses the existing embed +
      // searchLocalWithEmbedding + per-turn cache logic at recall.ts:200-261.
      // PF-1: the production seed query uses the <|K,COSINE|> HNSW KNN
      // operator (documented in SEED_QUERY_HNSW_KNN above). AutoRecall will
      // be upgraded to use that query in a follow-up; for now it provides the
      // embed + cache + search path that the packer builds on.
      const results = yield* Effect.promise(() =>
        AutoRecall.autoRecall({
          query,
          sessionID: session.sessionID,
          persona: session.persona,
          project_id,
        }),
      )
      seeds = results.map(toPacked)
      cacheSet(cKey, seeds)
    }

    // CP-04, CP-20: expansion path selected by mode.
    let expanded: Packed[] = []
    if (mode === "hypergraph") {
      const backend = getGlobalHypergraphBackend()
      if (backend) {
        // PF-2: in-memory adjacency map for expand (built at init time via
        //   buildAdjacency — O(1) hash lookups instead of O(N) DB queries).
        // PF-3: depth=1 (not depth=2 — probe showed depth=2 doubles the BFS
        //   frontier with minimal quality gain).
        // PF-4: fanout cap at 10 (enforced at adjacency build time via
        //   slice(0, 10) — 20 seeds × 10 hyperedges = 200 expand results max).
        const result = yield* Effect.promise(() =>
          backend.expand(seeds.map(s => s.id), project_id, 1),
        )
        expanded = result.nodes.map(toPackedFromNode)
      }
    } else if (mode === "one_hop") {
      // A3 fallback (Arm 2): vector + 1-hop via SurrealBackend.query.
      // Activated by the human gate when the probe triggers terminal
      // fallback A3 (hypergraph retrieval abandoned). Left as a hook —
      // the SurrealBackend.query signature differs from the hypergraph
      // expand; the one_hop path is wired when A3 fires.
    }
    // mode === "top_k": no expansion (A6 degrade — pack seeds only).

    // CP-05: RRF fusion of seeds + expansion, dedup by node ID.
    // CP-04a: 6 active types only — reserved types never enter the packing path.
    // CP-04b: filter out entity (expansion-input only — never appears in
    //   PackedContext.items). entity seeds Hypergraph.query but is filtered
    //   out before formatting and never appears in packed output.
    const fused = rrfFuse(seeds, expanded)
      .filter(isLivePacked) // CP-06: filter dead nodes (SC-2)
      .filter(p => p.node_type !== "ENTITY") // CP-04b: drop entity
      .filter(p => ACTIVE_PACKABLE.includes(p.node_type)) // CP-04a: 5 packable types

    // CP-07: composite scoring (SDD-06 — score.ts).
    const scored = yield* Effect.all(
      fused.map(p =>
        Effect.promise(async () => {
          const s = await compositeScore(toNodeRecord(p), query)
          return { ...p, score: s }
        }),
      ),
    )

    // CP-14: L3 bootstrap first (high-confidence PROCEDURE).
    const bootstrapped = bootstrap(scored)

    // CP-08, CP-09: greedy pack with type diversity, budget cap.
    const packed = greedy(bootstrapped, budget, typeDiversity)

    // CP-11, CP-12, CP-12a, CP-13: format via TypedFormatter.
    const text = TypedFormatter.format(packed)
    const tokens = Token.estimate(text)

    // CP-15: provenance tracking — record injected IDs keyed by sessionID.
    ProvenanceTracker.track(session.sessionID, packed)

    // CP-19 fallback: hard token cap + truncate if greedy overshoots budget.
    if (tokens > budget) {
      const truncated = text.slice(0, budget * 4)
      return { text: truncated, items: packed, tokens: Token.estimate(truncated) }
    }

    return { text, items: packed, tokens }
  })
}
