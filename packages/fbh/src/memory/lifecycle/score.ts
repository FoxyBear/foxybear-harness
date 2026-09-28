/**
 * SDD-06 / Phase M-3 — Composite value scoring.
 *
 * score(node, query, opts) returns a float in [0, 1] combining:
 *   semantic   — cosine similarity between query and node embedding
 *   role       — node-type match weight (e.g. MEMORY=1.0, ENTITY=0.8)
 *   confidence — the node's current decayed confidence
 *   provenance — attributes.provenance score (default 1.0)
 *   recency    — max(0, 1 - age_days / 30) from last_used
 *   usage      — min(1, usage_count / 10)
 *   lifecycle  — 1.0 ACTIVE, 0.5 DEPRECATED, 0.1 ARCHIVED, 0.0 DELETED
 *
 * The lifecycle sub-score subsumes the binary stale penalty at memory.ts:458
 * (DEPRECATED already gets 0.5×, ARCHIVED 0.1×). Weights read from
 * memory.scoring.* config (SC-6, CC-6).
 */
import { getConfig } from "../../config/bridge"
import type { NodeRecord } from "../surreal-hypergraph-backend"
import type { LifecycleStatus } from "../schema/enums"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.lifecycle.score" })

interface ScoringConfig {
  w_semantic: number
  w_role: number
  w_confidence: number
  w_provenance: number
  w_recency: number
  w_usage: number
  w_lifecycle: number
}

const DEFAULTS: ScoringConfig = {
  w_semantic: 0.3,
  w_role: 0.1,
  w_confidence: 0.2,
  w_provenance: 0.1,
  w_recency: 0.1,
  w_usage: 0.1,
  w_lifecycle: 0.1,
}

async function resolve(): Promise<ScoringConfig> {
  try {
    const cfg = await getConfig()
    const s = cfg?.memory?.scoring
    return {
      w_semantic: s?.w_semantic ?? DEFAULTS.w_semantic,
      w_role: s?.w_role ?? DEFAULTS.w_role,
      w_confidence: s?.w_confidence ?? DEFAULTS.w_confidence,
      w_provenance: s?.w_provenance ?? DEFAULTS.w_provenance,
      w_recency: s?.w_recency ?? DEFAULTS.w_recency,
      w_usage: s?.w_usage ?? DEFAULTS.w_usage,
      w_lifecycle: s?.w_lifecycle ?? DEFAULTS.w_lifecycle,
    }
  } catch {
    return DEFAULTS
  }
}

function lifecycleScore(status: LifecycleStatus): number {
  if (status === "ACTIVE") return 1.0
  if (status === "DEPRECATED") return 0.5
  if (status === "ARCHIVED") return 0.1
  return 0.0 // DELETED
}

function recencyScore(node: NodeRecord, now: number): number {
  const lastUsed = Number(node.attributes.last_used ?? node.created_at)
  const ageDays = Math.max(0, (now - lastUsed) / 86400)
  return Math.max(0, 1 - ageDays / 30)
}

function usageScore(node: NodeRecord): number {
  const count = Number(node.attributes.usage_count ?? 0)
  return Math.min(1, count / 10)
}

function roleScore(node: NodeRecord): number {
  // MEMORY nodes get full weight; other types get a small discount.
  const t = node.node_type
  if (t === "MEMORY") return 1.0
  if (t === "ENTITY") return 0.8
  if (t === "ACTION") return 0.7
  return 0.5
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

export interface ScoreOpts {
  queryEmbedding?: Float32Array | null
  now?: number
}

/**
 * score(node, query?, opts?) — composite value score in [0, 1].
 *
 * Combines semantic + role + confidence + provenance + recency + usage +
 * lifecycle sub-scores per the weights in memory.scoring.* config.
 */
export async function score(node: NodeRecord, query?: string, opts?: ScoreOpts): Promise<number> {
  const cfg = await resolve()
  const now = opts?.now ?? Math.floor(Date.now() / 1000)

  const semantic = opts?.queryEmbedding && node.embedding
    ? cosine(opts.queryEmbedding, node.embedding)
    : query
      ? 0.5 // default when no embedding available
      : 0.5
  const role = roleScore(node)
  const confidence = Number(node.attributes.confidence ?? 0.5)
  const provenance = Number(node.attributes.provenance ?? 1.0)
  const recency = recencyScore(node, now)
  const usage = usageScore(node)
  const lifecycle = lifecycleScore(node.status)

  const total =
    cfg.w_semantic * semantic +
    cfg.w_role * role +
    cfg.w_confidence * confidence +
    cfg.w_provenance * provenance +
    cfg.w_recency * recency +
    cfg.w_usage * usage +
    cfg.w_lifecycle * lifecycle

  const weightSum =
    cfg.w_semantic + cfg.w_role + cfg.w_confidence + cfg.w_provenance + cfg.w_recency + cfg.w_usage + cfg.w_lifecycle
  const normalized = weightSum > 0 ? total / weightSum : 0

  return Math.min(1.0, Math.max(0.0, normalized))
}

// Export lifecycle score helper for tests + the spike sim.
export { lifecycleScore }
