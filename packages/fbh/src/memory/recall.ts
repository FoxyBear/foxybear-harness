import { Embedding } from "./embedding"
import { type MemoryResult, Memory, cosineSimilarity } from "./memory"
import { getConfig } from "../config/bridge"
import { getGlobalHypergraphBackend } from "./backend-registry"
import { Log } from "../util/log"
import { ulid } from "ulid"

export { type MemoryResult }

/**
 * Spec 16 §F-04 / EP-07 — AutoRecall input contract.
 *
 * `requestor_elevated` is a forward-compat marker reserved for future
 * scope-restriction specs. Today, behavior is identical regardless of
 * the flag's value. When a future spec restricts non-elevated processes
 * from querying certain scopes, that guard will honor this flag to
 * keep the elevated path open. See:
 *   - docs/260421_foxybear_spec16-finish.md §F-04
 *   - docs/260427_foxybear_spec-elevated-privileges.md EP-07
 */
export interface AutoRecallInput {
  query: string
  persona: string
  sessionID: string
  project_id?: string
  workforceUrl?: string
  workforceTimeoutMs?: number
  embeddingConfig?: Embedding.Config
  /**
   * Spec 16 §F-04 / EP-07 — forward-compat: signals the caller is an
   * elevated process. Default false. No behavioral effect today; logged
   * for future scope-restriction enforcement.
   */
  requestor_elevated?: boolean
}

const log = Log.create({ service: "memory.recall" })

const DEFAULT_STALE_WARNING_DAYS = 1
const WORKFORCE_TIMEOUT = 5000

// ── Config resolution (FIX 2) ──

const FALLBACK_EMBEDDING_CONFIG: Embedding.Config = {
  provider: "deepinfra",
  model: "BAAI/bge-base-en-v1.5",
  dimensions: 768,
  fallback: {
    provider: "ollama",
    model: "nomic-embed-text",
  },
}

interface RecallConfig {
  embeddingConfig: Embedding.Config
  staleWarningDays: number
}

let _cachedRecallConfig: RecallConfig | null = null

async function resolveRecallConfig(): Promise<RecallConfig> {
  if (_cachedRecallConfig) return _cachedRecallConfig

  try {
    const cfg = await getConfig()
    const mem = cfg.memory
    const embeddingConfig: Embedding.Config = mem?.embedding
      ? {
          provider: mem.embedding.provider as "ollama" | "deepinfra" | "openai",
          model: mem.embedding.model,
          dimensions: mem.embedding.dimensions,
          fallback: mem.embedding.fallback ?? FALLBACK_EMBEDDING_CONFIG.fallback,
        }
      : FALLBACK_EMBEDDING_CONFIG

    _cachedRecallConfig = {
      embeddingConfig,
      staleWarningDays: mem?.consolidation?.stale_warning_days ?? DEFAULT_STALE_WARNING_DAYS,
    }
  } catch {
    log.warn("recall: config unavailable, using defaults")
    _cachedRecallConfig = {
      embeddingConfig: FALLBACK_EMBEDDING_CONFIG,
      staleWarningDays: DEFAULT_STALE_WARNING_DAYS,
    }
  }

  return _cachedRecallConfig
}

/** Resolve just the embedding config (for backward compat with callers) */
async function resolveEmbeddingConfig(): Promise<Embedding.Config> {
  const config = await resolveRecallConfig()
  return config.embeddingConfig
}

/** Get stale_warning_days from config (sync, uses cached value or default) */
function getStaleWarningDays(): number {
  return _cachedRecallConfig?.staleWarningDays ?? DEFAULT_STALE_WARNING_DAYS
}

// ── Turn cache state ──

interface TurnCache {
  sessionID: string
  query: string
  embedding: Float32Array
  results: MemoryResult[]
}

let turnCache: TurnCache | null = null

// ── Local search delegated to shared function (FIX 4) ──

// ── Workforce query (Layer 4) ──

async function queryWorkforce(input: {
  query: string
  persona: string
  queryEmbedding: Float32Array
  workforceUrl: string
  limit?: number
  timeoutMs?: number
}): Promise<MemoryResult[]> {
  const limit = input.limit ?? 3
  const timeoutMs = input.timeoutMs ?? WORKFORCE_TIMEOUT

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(`${input.workforceUrl}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: input.query,
        persona: input.persona,
        limit,
        embedding: Array.from(input.queryEmbedding),
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      log.warn("workforce endpoint returned error", { status: response.status })
      return []
    }

    const data = (await response.json()) as {
      results: { content: string; score: number; metadata?: Record<string, unknown> }[]
    }

    return data.results.map((r) => ({
      id: `workforce-${ulid()}`,
      content: r.content,
      persona: input.persona,
      scope: "workforce",
      access_count: 0,
      created_at: String(Date.now()),
      accessed_at: String(Date.now()),
      metadata: r.metadata ?? {},
      score: r.score,
      source: "workforce" as const,
    }))
  } catch (error) {
    log.warn("workforce endpoint unavailable or timed out", { error: String(error) })
    return []
  }
}

// ── Merge and dedup — delegates to shared function (FIX 3 + FIX 4) ──

// ── Injection Fix — hypergraph node table dual-read + RRF fusion ──

/**
 * SDD: Injection Fix — fuse `memory` table results with `node` table results.
 *
 * Phase N memories live in the `node` table; the legacy `memory` table query
 * misses them. Query the node table via the hypergraph backend's HNSW KNN
 * (searchMemoryNodes) and RRF-fuse the two rankings.
 *
 * Graceful-degrades: if the hypergraph backend is absent, not healthy, or
 * the query errors, returns the `memory` results unchanged.
 */
async function fuseHypergraphNodes(
  memory: MemoryResult[],
  queryEmbedding: Float32Array,
  project_id: string | undefined,
): Promise<MemoryResult[]> {
  const hypergraph = getGlobalHypergraphBackend()
  if (!hypergraph || !hypergraph.healthy()) return memory

  let nodes: MemoryResult[] = []
  try {
    const rows = await hypergraph.searchMemoryNodes(
      queryEmbedding,
      project_id ?? "global",
      20,
    )
    nodes = rows.map((n) => ({
      id: n.node_id,
      content: n.content,
      persona: String(n.attributes.persona ?? ""),
      scope: String(n.attributes.scope ?? "project"),
      access_count: Number(n.attributes.usage_count ?? 0),
      created_at: n.created_at > 0
        ? String(n.created_at * 1000)
        : String(Date.now()),
      accessed_at: n.attributes.last_used != null
        ? String(Number(n.attributes.last_used) * 1000)
        : n.created_at > 0
          ? String(n.created_at * 1000)
          : String(Date.now()),
      metadata: { ...n.attributes, memory_type: n.memory_type },
      score: n.score,
      source: "local" as const,
    }))
  } catch (err) {
    log.warn("auto-recall: hypergraph node query failed, using memory results only", {
      error: String(err),
    })
    return memory
  }

  if (nodes.length === 0) return memory
  return rrfFuse(memory, nodes)
}

/**
 * Reciprocal Rank Fusion of two MemoryResult rankings. k=60 (standard RRF
 * constant, matching surreal-backend.ts:665 and packer.ts:146). Items
 * appearing in both rankings (matched by exact content) get combined
 * scores. Then fuzzy dedup by content cosine similarity > 0.9 keeps the
 * higher-ranked item. Sort by RRF score descending.
 */
async function rrfFuse(
  memory: MemoryResult[],
  nodes: MemoryResult[],
): Promise<MemoryResult[]> {
  const K = 60
  const DEDUP_THRESHOLD = 0.9

  // Phase 1: combine RRF scores, dedup by exact content match.
  type Scored = { item: MemoryResult; rrf: number }
  const byContent = new Map<string, Scored>()
  const add = (item: MemoryResult, rank: number) => {
    const rrf = 1 / (K + rank + 1)
    const existing = byContent.get(item.content)
    if (existing) existing.rrf += rrf
    else byContent.set(item.content, { item, rrf })
  }
  memory.forEach((item, rank) => add(item, rank))
  nodes.forEach((item, rank) => add(item, rank))

  const scored = [...byContent.values()]
  if (scored.length <= 1) {
    return scored
      .sort((a, b) => b.rrf - a.rrf)
      .map((s) => ({ ...s.item, score: s.rrf }))
  }

  // Phase 2: fuzzy dedup by content cosine similarity > 0.9.
  const cfg = await resolveEmbeddingConfig()
  const embeddings: (Float32Array | null)[] = []
  for (const s of scored) {
    const r = await Embedding.embedSafe(s.item.content, cfg)
    embeddings.push(r.ok ? r.value : null)
  }

  const drop = new Set<number>()
  for (let i = 0; i < scored.length; i++) {
    if (drop.has(i)) continue
    for (let j = i + 1; j < scored.length; j++) {
      if (drop.has(j)) continue
      const a = embeddings[i]
      const b = embeddings[j]
      if (a && b && cosineSimilarity(a, b) > DEDUP_THRESHOLD) {
        if (scored[i]!.rrf >= scored[j]!.rrf) drop.add(j)
        else { drop.add(i); break }
      }
    }
  }

  return scored
    .filter((_, i) => !drop.has(i))
    .sort((a, b) => b.rrf - a.rrf)
    .map((s) => ({ ...s.item, score: s.rrf }))
}

// ── AutoRecall namespace ──

export namespace AutoRecall {
  /**
   * Auto-recall: embed query once, search local + optional workforce memory,
   * merge results, and return them for system prompt injection.
   *
   * - Skips if query starts with `/` (slash command) [AR-02]
   * - Caches embedding + results within a turn (same sessionID + query) [AR-03, AR-08]
   * - Gracefully degrades: embedding failure -> empty results [AR-07], workforce timeout -> local only [AR-11]
   */
  export async function autoRecall(input: AutoRecallInput): Promise<MemoryResult[]> {
    // AR-02: Skip slash commands
    if (input.query.startsWith("/")) {
      return []
    }

    // Spec 16 §F-04 / EP-07 — record forward-compat elevation marker
    // for future scope-restriction enforcement. No behavioral effect.
    if (input.requestor_elevated) {
      log.info("auto-recall: requestor is elevated", {
        sessionID: input.sessionID,
        persona: input.persona,
      })
    }

    // AR-03, AR-08: Return cached results if same turn (same sessionID + query)
    if (
      turnCache &&
      turnCache.sessionID === input.sessionID &&
      turnCache.query === input.query
    ) {
      return turnCache.results
    }

    const config = input.embeddingConfig ?? await resolveEmbeddingConfig()

    // AR-05, AR-06, AR-07: Embed query with fallback and graceful degradation
    const embedResult = await Embedding.embedSafe(input.query, config)

    if (!embedResult.ok) {
      // AR-07: Both providers down — log and skip
      log.error("auto-recall: embedding unavailable, skipping recall", {
        error: embedResult.error.message,
      })
      turnCache = {
        sessionID: input.sessionID,
        query: input.query,
        embedding: new Float32Array(0),
        results: [],
      }
      return []
    }

    const queryEmbedding = embedResult.value

    // AR-09: Layer 2 — local cosine similarity, persona + project filtered (shared function)
    const localResults = await Memory.searchLocalWithEmbedding({
      queryEmbedding,
      persona: input.persona,
      project_id: input.project_id,
    })

    // SDD: Injection Fix — Hybrid Seed from `memory` + `node` tables.
    // Phase N captures quality memories into `node` via classify, but the
    // `memory` table query above misses them. Query the node table via
    // the hypergraph backend's HNSW KNN and RRF-fuse with the memory
    // results. Graceful-degrades if the backend is absent or errors.
    const fused = await fuseHypergraphNodes(localResults, queryEmbedding, input.project_id)

    let results: MemoryResult[]

    if (input.workforceUrl) {
      // AR-10, AR-11: Layer 4 — workforce query (with timeout)
      const workforceResults = await queryWorkforce({
        query: input.query,
        persona: input.persona,
        queryEmbedding,
        workforceUrl: input.workforceUrl,
        timeoutMs: input.workforceTimeoutMs,
      })

      // AR-12: Merge and dedup using cosine similarity, fused preferred
      results = await Memory.mergeAndDedup(fused, workforceResults)
    } else {
      results = fused
    }

    // Cache results for this turn
    turnCache = {
      sessionID: input.sessionID,
      query: input.query,
      embedding: queryEmbedding,
      results,
    }

    return results
  }

  /**
   * AR-13, AR-14: Format recall results for system prompt injection.
   *
   * Returns empty string when results are empty (AR-14).
   * Adds staleness warning for memories older than 3 days (AR-13).
   *
   * Format:
   * ```
   * ## Relevant Memories
   * 1. [2026-04-10, local] Memory content here
   * 2. [2026-04-08, workforce] Another memory (memory from 5 days ago — verify before acting)
   * ```
   */
  export function formatForInjection(results: MemoryResult[], opts?: { degraded?: boolean }): string {
    if (results.length === 0) {
      return ""
    }

    // CN-15: Use stale_warning_days from config (resolved at config load time)
    const staleWarningDays = getStaleWarningDays()

    const lines: string[] = ["## Relevant Memories"]

    if (opts?.degraded) {
      lines.push("> Note: Project/global memories unavailable (daemon offline). Showing instance memories only.")
    }

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!
      const createdDate = formatDate(r.created_at)
      const daysAgo = getDaysAgo(r.created_at)

      let line = `${i + 1}. [${createdDate}, ${r.source}] ${r.content}`

      if (daysAgo > staleWarningDays) {
        line += ` (memory from ${daysAgo} days ago — verify before acting)`
      }

      lines.push(line)
    }

    return lines.join("\n")
  }

  /**
   * AR-04: Invalidate the turn cache (called when a new user message arrives).
   */
  export function invalidateCache(): void {
    turnCache = null
  }

  /**
   * Invalidate the recall config cache — exposed for testing.
   */
  export function invalidateRecallConfigCache(): void {
    _cachedRecallConfig = null
  }
}

// ── Helpers ──

function formatDate(timestampStr: string): string {
  const ts = Number(timestampStr)
  if (isNaN(ts) || ts === 0) {
    return "unknown"
  }
  const d = new Date(ts)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function getDaysAgo(timestampStr: string): number {
  const ts = Number(timestampStr)
  if (isNaN(ts) || ts === 0) {
    return 0
  }
  const diffMs = Date.now() - ts
  return Math.floor(diffMs / (24 * 60 * 60 * 1000))
}
