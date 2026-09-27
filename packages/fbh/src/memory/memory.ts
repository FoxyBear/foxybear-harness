import { Effect, Layer, Context } from "effect"
import { ulid } from "ulid"
import { Database, eq, and, or, desc, count, sql } from "../storage/db"
import { MemoryIndexTable, MemoryTopicsTable } from "./memory.sql"
import { MessageTable } from "../session/session.sql"
import { Embedding } from "./embedding"
import { getConfig } from "../config/bridge"
import { Log } from "../util/log"
import { makeRuntime } from "../effect/run-service"
import { getGlobalMemoryBackend, getGlobalHypergraphBackend } from "./backend-registry"
import type { MemoryBackend, MemoryResult as BackendMemoryResult } from "./backend"
import { ConflictDetector } from "./conflict/check"
import { applyVerdict } from "./conflict/apply"

const log = Log.create({ service: "memory" })

const MAX_INDEX_ENTRIES = 200
const DEFAULT_RECALL_LIMIT = 5
const DEFAULT_LIST_LIMIT = 20
const WORKFORCE_TIMEOUT = 5000

// ── Types ──

export interface MemoryEntry {
  id: string
  content: string
  persona: string
  scope: string
  access_count: number
  created_at: string
  accessed_at: string
  metadata: Record<string, unknown>
}

export interface MemoryResult extends MemoryEntry {
  score: number
  source: "local" | "workforce"
}

export interface IndexEntry {
  id: string
  key: string
  pointer: string
  summary: string
  access_count: number
  created_at: string
  updated_at: string
}

// ── Float32Array ↔ Buffer conversion (blob column storage) ──

export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  // Copy into an aligned ArrayBuffer to avoid alignment issues
  const aligned = new ArrayBuffer(buf.byteLength)
  new Uint8Array(aligned).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  return new Float32Array(aligned)
}

// ── Legacy Base64 helpers (kept for test compatibility) ──

export function float32ToBase64(arr: Float32Array): string {
  return float32ToBuffer(arr).toString("base64")
}

export function base64ToFloat32(b64: string): Float32Array {
  return bufferToFloat32(Buffer.from(b64, "base64"))
}

// ── Cosine Similarity ──

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dot / denom
}

// ── Row to MemoryEntry ──

function rowToEntry(row: any): MemoryEntry {
  return {
    id: row.id,
    content: row.content,
    persona: row.persona,
    scope: row.scope ?? "general",
    access_count: row.access_count ?? 0,
    created_at: String(row.time_created ?? ""),
    accessed_at: String(row.time_accessed ?? row.time_created ?? ""),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  }
}

function rowToIndex(row: any): IndexEntry {
  return {
    id: row.id,
    key: row.key,
    pointer: row.pointer,
    summary: row.summary,
    access_count: row.access_count ?? 0,
    created_at: String(row.time_created ?? ""),
    updated_at: String(row.time_updated ?? ""),
  }
}

// ── Backend result → local MemoryEntry/MemoryResult conversion ──

function backendResultToEntry(r: BackendMemoryResult): MemoryEntry {
  return {
    id: r.id,
    content: r.content,
    persona: r.persona,
    scope: r.scope,
    access_count: 0,
    created_at: r.created_at,
    accessed_at: r.accessed_at,
    metadata: r.metadata,
  }
}

function backendResultToMemoryResult(r: BackendMemoryResult): MemoryResult {
  return {
    ...backendResultToEntry(r),
    score: r.score,
    source: r.source === "surreal" ? "local" : (r.source as "local" | "workforce"),
  }
}

// ── Memory Service Interface ──

export interface Interface {
  readonly store: (input: {
    content: string
    persona: string
    project_id?: string
    scope?: string
    metadata?: Record<string, unknown>
  }) => Effect.Effect<MemoryEntry>

  readonly recall: (input: {
    query: string
    persona: string
    project_id?: string
    limit?: number
    include_workforce?: boolean
  }) => Effect.Effect<MemoryResult[]>

  readonly forget: (input: { id: string }) => Effect.Effect<void>

  readonly list: (input: {
    persona: string
    limit?: number
  }) => Effect.Effect<MemoryEntry[]>

  readonly index: (input: {
    persona?: string
  }) => Effect.Effect<IndexEntry[]>
}

// ── Memory Service ──

export namespace Memory {
  export class Service extends Context.Service<Service, Interface>()("@foxybear/Memory") {}

  // ── Config resolution (FIX 2) ──
  // Read from Config service, falling back to defaults if config unavailable

  const FALLBACK_EMBEDDING_CONFIG: Embedding.Config = {
    provider: "deepinfra",
    model: "BAAI/bge-base-en-v1.5",
    dimensions: 768,
    fallback: {
      provider: "ollama",
      model: "nomic-embed-text",
    },
  }

  let _cachedConfig: {
    embeddingConfig: Embedding.Config
    dedupThreshold: number
    ttlDays: number
    stalePenaltyDays: number
  } | null = null

  async function resolveConfig(): Promise<{
    embeddingConfig: Embedding.Config
    dedupThreshold: number
    ttlDays: number
    stalePenaltyDays: number
  }> {
    if (_cachedConfig) return _cachedConfig

    try {
      const cfg = await getConfig()
      const mem = cfg.memory
      const embeddingConfig: Embedding.Config = mem?.embedding
        ? {
            provider: mem.embedding.provider as "ollama" | "deepinfra" | "openai",
            model: mem.embedding.model,
            dimensions: mem.embedding.dimensions,
            fallback: mem.embedding.fallback,
          }
        : FALLBACK_EMBEDDING_CONFIG
      _cachedConfig = {
        embeddingConfig,
        dedupThreshold: mem?.dedup_threshold ?? 0.95,
        ttlDays: mem?.ttl_days ?? 90,
        stalePenaltyDays: mem?.consolidation?.stale_penalty_days ?? 7,
      }
    } catch {
      log.warn("memory: config unavailable, using defaults")
      _cachedConfig = {
        embeddingConfig: FALLBACK_EMBEDDING_CONFIG,
        dedupThreshold: 0.95,
        ttlDays: 90,
        stalePenaltyDays: 7,
      }
    }

    return _cachedConfig
  }

  // Expose for testing — invalidate the cached config
  export function invalidateConfigCache(): void {
    _cachedConfig = null
  }

  // ── Embedding helper (uses raw async functions) ──

  async function getEmbedding(text: string): Promise<Float32Array | null> {
    const cfg = await resolveConfig()
    const result = await Embedding.embedSafe(text, cfg.embeddingConfig)
    if (!result.ok) {
      log.warn("embedding unavailable, storing without vector", { error: result.error.message })
      return null
    }
    return result.value
  }

  // ── Core implementations ──

  // Cap stored content so it can always be re-embedded later
  const MAX_STORED_CONTENT_CHARS = 16000

  async function storeImpl(input: {
    content: string
    persona: string
    project_id?: string
    scope?: string
    metadata?: Record<string, unknown>
  }): Promise<MemoryEntry> {
    const content = input.content.length > MAX_STORED_CONTENT_CHARS
      ? input.content.slice(0, MAX_STORED_CONTENT_CHARS)
      : input.content
    const embedding = await getEmbedding(content)

    // SDD-09 / Phase M-5 — save-time conflict detection (req 1).
    // ConflictDetector.check runs after the embedding is computed and
    // before backend dispatch, covering both the SurrealBackend path and
    // the legacy SQLite path. ADD falls through to the existing flow
    // (including the cosine > 0.95 dedup at memory.ts:302-345 for the
    // SQLite path). UPDATE/DELETE invoke the rewrite/retract paths via
    // applyVerdict (reqs 2-4). Effect.runPromise bridges the Effect to
    // storeImpl's async flow — the canonical Effect-to-Promise bridge.
    try {
      const verdict = await Effect.runPromise(
        ConflictDetector.check(content, input.project_id ?? "global"),
      )
      if (verdict.verdict === "UPDATE" || verdict.verdict === "DELETE") {
        return await applyVerdict(verdict, content, input)
      }
    } catch (err) {
      log.warn("memory: conflict detection failed, falling through to ADD", { error: String(err) })
    }

    // ── Dispatch to SurrealBackend when registered ──
    const backend = getGlobalMemoryBackend()
    if (backend) {
      const projectId = input.project_id ?? "global"
      const scope: "instance" | "project" | "global" =
        (input.scope === "instance" || input.scope === "project" || input.scope === "global")
          ? input.scope
          : projectId === "global" ? "global" : "project"

      const result = await backend.write({
        content,
        embedding,
        scope,
        project_id: projectId,
        persona: input.persona,
        metadata: input.metadata,
      })

      // SDD-03 / Phase M-1 — dual-write to the hypergraph node table (SC-8).
      // Maps the stored memory to a MEMORY node per SC-8 row 1, including
      // attributes.confidence = 0.5 (prevents NaN in sdd-06's decay formula).
      // Graceful-degrades if the hypergraph backend is absent.
      const hyper = getGlobalHypergraphBackend()
      if (hyper) {
        try {
          const now = Math.floor(Date.now() / 1000)
          await hyper.store({
            node_id: result.id,
            node_type: "MEMORY",
            created_at: now,
            updated_at: now,
            version: 1,
            status: "ACTIVE",
            embedding: embedding ?? null,
            attributes: {
              content,
              persona: input.persona,
              project_id: projectId,
              scope,
              confidence: 0.5,
              usage_count: 0,
              last_used: now,
            },
            valid_from: now,
            valid_to: Infinity,
            tx_from: now,
            tx_to: Infinity,
            prev_version_id: null,
            invalidated_by: null,
          })
        } catch (err) {
          log.warn("memory: hypergraph dual-write failed", { error: String(err) })
        }
      }

      const now = new Date().toISOString()
      return {
        id: result.id,
        content,
        persona: input.persona,
        scope,
        access_count: 0,
        created_at: now,
        accessed_at: now,
        metadata: input.metadata ?? {},
      }
    }

    // ── Legacy SQLite path ──
    const cfg = await resolveConfig()
    const EMPTY_EMBEDDING_BUF = Buffer.alloc(0)
    const embeddingBuf = embedding ? float32ToBuffer(embedding) : EMPTY_EMBEDDING_BUF
    const projectId = input.project_id ?? "global"

    // Check for duplicates within same project (skip if no embedding)
    if (embedding) {
      const existing = Database.use((db) =>
        db.select().from(MemoryTopicsTable).where(
          and(eq(MemoryTopicsTable.persona, input.persona), eq(MemoryTopicsTable.project_id, projectId)),
        ).all(),
      )

      for (const row of existing) {
        const existingEmb = bufferToFloat32(row.embedding as Buffer)
        const sim = cosineSimilarity(embedding, existingEmb)
        if (sim > cfg.dedupThreshold) {
          const mergedContent = row.content.includes(content)
            ? row.content
            : `${row.content}\n${content}`
          const newAccessCount = (row.access_count ?? 0) + 1
          const now = new Date()

          Database.use((db) => {
            db.update(MemoryTopicsTable)
              .set({
                content: mergedContent,
                embedding: embeddingBuf,
                access_count: newAccessCount,
                time_accessed: now,
                metadata: input.metadata ? JSON.stringify(input.metadata) : row.metadata,
              })
              .where(eq(MemoryTopicsTable.id, row.id))
              .run()
          })

          return {
            id: row.id,
            content: mergedContent,
            persona: row.persona,
            scope: row.scope ?? "general",
            access_count: newAccessCount,
            created_at: String(row.time_created ?? ""),
            accessed_at: String(now.getTime()),
            metadata: (input.metadata ?? (row.metadata as Record<string, unknown>)) ?? {},
          }
        }
      }
    }

    // No duplicate — insert new
    const id = ulid()
    const now = new Date()

    Database.use((db) => {
      db.insert(MemoryTopicsTable)
        .values({
          id,
          content,
          embedding: embeddingBuf,
          persona: input.persona,
          project_id: projectId,
          scope: input.scope ?? "general",
          access_count: 0,
          metadata: input.metadata ? (input.metadata as any) : null,
          time_accessed: now,
        })
        .run()
    })

    return {
      id,
      content,
      persona: input.persona,
      scope: input.scope ?? "general",
      access_count: 0,
      created_at: String(now.getTime()),
      accessed_at: String(now.getTime()),
      metadata: input.metadata ?? {},
    }
  }

  // ── Shared search function (FIX 4) ──

  const DEFAULT_STALE_PENALTY_DAYS = 7

  export function searchLocalWithEmbedding(input: {
    queryEmbedding: Float32Array
    persona: string
    project_id?: string
    limit?: number
  }): MemoryResult[] | Promise<MemoryResult[]> {
    // ── Dispatch to SurrealBackend when registered ──
    const backend = getGlobalMemoryBackend()
    if (backend) {
      return searchLocalWithEmbeddingViaSurreal(backend, input)
    }

    // ── Legacy SQLite path ──
    return searchLocalWithEmbeddingSqlite(input)
  }

  async function searchLocalWithEmbeddingViaSurreal(
    backend: MemoryBackend,
    input: {
      queryEmbedding: Float32Array
      persona: string
      project_id?: string
      limit?: number
    },
  ): Promise<MemoryResult[]> {
    const limit = input.limit ?? DEFAULT_RECALL_LIMIT
    const scope = input.project_id ? "project" : "all"
    const results = await backend.query({
      query: "",
      queryEmbedding: input.queryEmbedding,
      scope,
      project_id: input.project_id,
      persona: input.persona,
      limit,
    })
    return results.map(backendResultToMemoryResult)
  }

  function searchLocalWithEmbeddingSqlite(input: {
    queryEmbedding: Float32Array
    persona: string
    project_id?: string
    limit?: number
  }): MemoryResult[] {
    const limit = input.limit ?? DEFAULT_RECALL_LIMIT
    const stalePenaltyDays = _cachedConfig?.stalePenaltyDays ?? DEFAULT_STALE_PENALTY_DAYS
    const now = Date.now()

    const rows = Database.use((db) => {
      if (input.project_id) {
        // Filter by project + include global-scoped memories
        return db.select().from(MemoryTopicsTable).where(
          and(
            eq(MemoryTopicsTable.persona, input.persona),
            or(
              eq(MemoryTopicsTable.project_id, input.project_id),
              eq(MemoryTopicsTable.project_id, "global"),
            ),
          ),
        ).all()
      }
      return db.select().from(MemoryTopicsTable).where(eq(MemoryTopicsTable.persona, input.persona)).all()
    })

    const scored: MemoryResult[] = rows.map((row) => {
      const rowEmb = bufferToFloat32(row.embedding as Buffer)
      let score = cosineSimilarity(input.queryEmbedding, rowEmb)

      // @deprecated SDD-06 — binary stale penalty removed; the lifecycle
      // sub-score (memory.scoring.w_lifecycle) subsumes this. DEPRECATED
      // nodes already get 0.5×, ARCHIVED 0.1× via src/memory/lifecycle/score.ts.
      // The stalePenaltyDays config field (memory.consolidation.stale_penalty_days)
      // is kept for backward compat but no longer read by the active scoring
      // path. See src/memory/lifecycle/decay.ts for the replacement.
      const _createdAt = Number(row.time_created ?? 0)
      const _ageMs = now - _createdAt
      const _ageDays = _ageMs / (24 * 60 * 60 * 1000)
      const _accessCount = row.access_count ?? 0
      void stalePenaltyDays
      void _ageDays
      void _accessCount

      return {
        ...rowToEntry(row),
        score,
        source: "local" as const,
      }
    })

    scored.sort((a, b) => b.score - a.score)
    const topN = scored.slice(0, limit)

    // Update accessed_at and access_count for returned results
    const updateTime = new Date()
    for (const result of topN) {
      const newCount = result.access_count + 1
      Database.use((db) => {
        db.update(MemoryTopicsTable)
          .set({
            time_accessed: updateTime,
            access_count: newCount,
          })
          .where(eq(MemoryTopicsTable.id, result.id))
          .run()
        // Also increment access_count on corresponding index entry if one exists
        db.update(MemoryIndexTable)
          .set({
            access_count: sql`COALESCE(${MemoryIndexTable.access_count}, 0) + 1`,
          })
          .where(eq(MemoryIndexTable.id, result.id))
          .run()
      })
      result.access_count = newCount
      result.accessed_at = String(updateTime.getTime())
    }

    return topN
  }

  async function recallImpl(input: {
    query: string
    persona: string
    project_id?: string
    limit?: number
    include_workforce?: boolean
  }): Promise<MemoryResult[]> {
    const limit = input.limit ?? DEFAULT_RECALL_LIMIT
    const queryEmbedding = await getEmbedding(input.query)

    if (!queryEmbedding) {
      log.warn("recall: embedding unavailable, returning empty results")
      return []
    }

    // ── Dispatch to SurrealBackend when registered ──
    const backend = getGlobalMemoryBackend()
    if (backend) {
      const results = await backend.query({
        query: input.query,
        queryEmbedding,
        scope: "all",
        project_id: input.project_id,
        persona: input.persona,
        limit,
      })
      // SDD-03 / Phase M-1 — dual-read from the hypergraph node table (SC-8).
      // Queries the node table via SurrealHypergraphBackend.query() for
      // MEMORY-type nodes matching the seed set, merges by id (preferring node
      // records), dedupes. Graceful-degrades if hypergraph backend is absent.
      const hyper = getGlobalHypergraphBackend()
      if (hyper) {
        try {
          const project = input.project_id ?? "global"
          // Use semantic search results as seeds for hypergraph traversal.
          const seeds = results.map((r) => r.id)
          if (seeds.length > 0) {
            const hyperEdges = await hyper.query(seeds, project, { limit })
            // Hydrate node records from the hypergraph backend.
            const nodeIds = new Set<string>()
            for (const e of hyperEdges) for (const nid of e.node_ids) nodeIds.add(nid)
            const expanded = await hyper.expand([...nodeIds], project, 1)
            const hyperResults: MemoryResult[] = []
            for (const n of expanded.nodes) {
              if (n.node_type !== "MEMORY") continue
              const content = String(n.attributes.content ?? "")
              if (!content) continue
              hyperResults.push({
                id: n.node_id,
                content,
                persona: String(n.attributes.persona ?? input.persona),
                scope: String(n.attributes.scope ?? "project"),
                access_count: Number(n.attributes.usage_count ?? 0),
                created_at: new Date(n.created_at * 1000).toISOString(),
                accessed_at: new Date(Number(n.attributes.last_used ?? n.created_at) * 1000).toISOString(),
                metadata: (n.attributes as Record<string, unknown>) ?? {},
                score: 0,
                source: "local",
              })
            }
            // Merge by id, preferring node records.
            const seen = new Map<string, MemoryResult>()
            for (const r of hyperResults) seen.set(r.id, r)
            for (const r of results.map(backendResultToMemoryResult)) {
              if (!seen.has(r.id)) seen.set(r.id, r)
            }
            return [...seen.values()].slice(0, limit)
          }
        } catch (err) {
          log.warn("memory: hypergraph dual-read failed", { error: String(err) })
        }
      }
      return results.map(backendResultToMemoryResult)
    }

    // ── Legacy SQLite path ──
    return searchLocalWithEmbeddingSqlite({
      queryEmbedding,
      persona: input.persona,
      project_id: input.project_id,
      limit,
    })
  }

  async function forgetImpl(input: { id: string }): Promise<void> {
    // ── Dispatch to SurrealBackend when registered ──
    const backend = getGlobalMemoryBackend()
    if (backend) {
      await backend.forget(input.id)
      return
    }

    // ── Legacy SQLite path ──
    Database.transaction((db) => {
      db.delete(MemoryTopicsTable).where(eq(MemoryTopicsTable.id, input.id)).run()
      db.delete(MemoryIndexTable).where(eq(MemoryIndexTable.id, input.id)).run()
    })
  }

  async function listImpl(input: { persona: string; limit?: number }): Promise<MemoryEntry[]> {
    const limit = input.limit ?? DEFAULT_LIST_LIMIT

    // ── Dispatch to SurrealBackend when registered ──
    const backend = getGlobalMemoryBackend()
    if (backend) {
      const results = await backend.list(input.persona, limit)
      return results.map(backendResultToEntry)
    }

    // ── Legacy SQLite path ──
    const rows = Database.use((db) =>
      db
        .select()
        .from(MemoryTopicsTable)
        .where(eq(MemoryTopicsTable.persona, input.persona))
        .orderBy(desc(MemoryTopicsTable.time_accessed))
        .limit(limit)
        .all(),
    )
    return rows.map(rowToEntry)
  }

  function indexImpl(input: { persona?: string }): IndexEntry[] {
    const rows = Database.use((db) => db.select().from(MemoryIndexTable).all())
    return rows.map(rowToIndex)
  }

  // ── Layer ──

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = Effect.fn("Memory.store")(function* (input: {
        content: string
        persona: string
        scope?: string
        metadata?: Record<string, unknown>
      }) {
        return yield* Effect.promise(() => storeImpl(input))
      })

      const recall = Effect.fn("Memory.recall")(function* (input: {
        query: string
        persona: string
        project_id?: string
        limit?: number
        include_workforce?: boolean
      }) {
        return yield* Effect.promise(() => recallImpl(input))
      })

      const forget = Effect.fn("Memory.forget")(function* (input: { id: string }) {
        return yield* Effect.promise(() => forgetImpl(input))
      })

      const list = Effect.fn("Memory.list")(function* (input: {
        persona: string
        limit?: number
      }) {
        return yield* Effect.promise(() => listImpl(input))
      })

      const index = Effect.fn("Memory.index")(function* (input: { persona?: string }) {
        return yield* Effect.sync(() => indexImpl(input))
      })

      return Service.of({ store, recall, forget, list, index })
    }),
  )

  export const defaultLayer = layer

  const { runPromise } = makeRuntime(Service, defaultLayer)

  // ── Public async API (convenience facades) ──

  export async function store(input: {
    content: string
    persona: string
    project_id?: string
    scope?: string
    metadata?: Record<string, unknown>
  }): Promise<MemoryEntry> {
    return runPromise((svc) => svc.store(input))
  }

  export async function recall(input: {
    query: string
    persona: string
    project_id?: string
    limit?: number
    include_workforce?: boolean
  }): Promise<MemoryResult[]> {
    return runPromise((svc) => svc.recall(input))
  }

  export async function forget(input: { id: string }): Promise<void> {
    return runPromise((svc) => svc.forget(input))
  }

  export async function list(input: {
    persona: string
    limit?: number
  }): Promise<MemoryEntry[]> {
    return runPromise((svc) => svc.list(input))
  }

  export async function index(input: { persona?: string }): Promise<IndexEntry[]> {
    return runPromise((svc) => svc.index(input))
  }

  // ── Index management ──

  export async function addIndex(input: {
    key: string
    pointer: string
    summary: string
    access_count?: number
  }): Promise<{ rejected: boolean; entry?: IndexEntry }> {
    const currentCount = Database.use((db) =>
      db.select({ count: count() }).from(MemoryIndexTable).all(),
    )

    if (currentCount[0]!.count >= MAX_INDEX_ENTRIES) {
      log.warn("memory index at capacity", { count: currentCount[0]!.count, max: MAX_INDEX_ENTRIES })
      return { rejected: true }
    }

    const id = ulid()
    Database.use((db) => {
      db.insert(MemoryIndexTable)
        .values({
          id,
          key: input.key,
          pointer: input.pointer,
          summary: input.summary,
          access_count: input.access_count ?? 0,
        })
        .run()
    })

    const rows = Database.use((db) =>
      db.select().from(MemoryIndexTable).where(eq(MemoryIndexTable.id, id)).all(),
    )

    return { rejected: false, entry: rows[0] ? rowToIndex(rows[0]) : undefined }
  }

  export async function formatIndex(): Promise<string> {
    const entries = Database.use((db) => db.select().from(MemoryIndexTable).all())

    if (entries.length === 0) return ""

    return entries
      .map((e) => {
        const line = `- [${e.key}](${e.pointer}): ${e.summary}`
        // Truncate to 150 chars if needed
        if (line.length > 150) {
          return line.slice(0, 147) + "..."
        }
        return line
      })
      .join("\n")
  }

  // ── Transcript search (Layer 3) ──

  export async function searchTranscripts(input: {
    sessionId: string
    query: string
  }): Promise<{ messageId: string; content: string }[]> {
    const rows = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, input.sessionId as any))
        .all(),
    )

    const results: { messageId: string; content: string }[] = []
    const queryLower = input.query.toLowerCase()

    for (const row of rows) {
      const data = row.data as any
      if (!data?.parts) continue

      for (const part of data.parts) {
        if (part.type === "text" && typeof part.content === "string") {
          if (part.content.toLowerCase().includes(queryLower)) {
            results.push({
              messageId: row.id,
              content: part.content,
            })
          }
        }
      }
    }

    return results
  }

  // ── Prunable memories (Layer 2, PM-10) ──

  export async function getPrunable(opts?: { ttl_days?: number }): Promise<MemoryEntry[]> {
    const cfg = await resolveConfig()
    const ttl = opts?.ttl_days ?? cfg.ttlDays

    // ── Dispatch to SurrealBackend when registered ──
    const backend = getGlobalMemoryBackend()
    if (backend) {
      const results = await backend.getPrunable(ttl)
      return results.map(backendResultToEntry)
    }

    // ── Legacy SQLite path ──
    const cutoff = new Date(Date.now() - ttl * 24 * 60 * 60 * 1000)

    const rows = Database.use((db) =>
      db
        .select()
        .from(MemoryTopicsTable)
        .where(sql`${MemoryTopicsTable.time_accessed} < ${cutoff.getTime()}`)
        .all(),
    )

    return rows.map(rowToEntry)
  }

  // ── Workforce recall (Layer 4) ──

  export async function recallWithWorkforce(input: {
    query: string
    persona: string
    project_id?: string
    limit?: number
    workforceUrl?: string
  }): Promise<MemoryResult[]> {
    const limit = input.limit ?? DEFAULT_RECALL_LIMIT

    // Get local results first
    const localResults = await recallImpl({
      query: input.query,
      persona: input.persona,
      project_id: input.project_id,
      limit,
      include_workforce: false,
    })

    // If no workforce URL, return local results only
    if (!input.workforceUrl) {
      return localResults
    }

    // Query workforce
    let workforceResults: MemoryResult[] = []
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), WORKFORCE_TIMEOUT)

      const queryEmbedding = await getEmbedding(input.query)

      if (!queryEmbedding) {
        clearTimeout(timeout)
        return mergeAndDedup(localResults, [])
      }

      const response = await fetch(`${input.workforceUrl}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: input.query,
          persona: input.persona,
          limit,
          embedding: Array.from(queryEmbedding),
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        log.warn("workforce endpoint returned error", { status: response.status })
      } else {
        const data = (await response.json()) as {
          results: { content: string; score: number; metadata?: Record<string, unknown> }[]
        }

        workforceResults = data.results.map((r) => ({
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
      }
    } catch (error) {
      log.warn("workforce endpoint unavailable", { error: String(error) })
    }

    // Merge and dedup using cosine similarity (spec: cosine > 0.9)
    return mergeAndDedup(localResults, workforceResults)
  }

  export async function mergeAndDedup(
    local: MemoryResult[],
    workforce: MemoryResult[],
  ): Promise<MemoryResult[]> {
    if (workforce.length === 0) return [...local]

    const cfg = await resolveConfig()
    const DEDUP_THRESHOLD = 0.9

    const merged: MemoryResult[] = [...local]

    // Embed local results for cosine comparison (skip vector dedup if embedding is unavailable)
    const localEmbeddings: (Float32Array | null)[] = []
    let embeddingAvailable = true
    for (const loc of local) {
      const result = await Embedding.embedSafe(loc.content, cfg.embeddingConfig)
      if (result.ok) {
        localEmbeddings.push(result.value)
      } else {
        embeddingAvailable = false
        localEmbeddings.push(null)
      }
    }

    for (const wf of workforce) {
      let isDuplicate = false

      // Exact match check first (cheap)
      if (local.some((loc) => loc.content === wf.content)) {
        isDuplicate = true
      } else if (embeddingAvailable) {
        const wfResult = await Embedding.embedSafe(wf.content, cfg.embeddingConfig)
        if (wfResult.ok) {
          for (const locEmb of localEmbeddings) {
            if (locEmb && cosineSimilarity(locEmb, wfResult.value) > DEDUP_THRESHOLD) {
              isDuplicate = true
              break
            }
          }
        }
      }

      if (!isDuplicate) {
        merged.push(wf)
      }
    }

    // Sort by score descending
    merged.sort((a, b) => b.score - a.score)
    return merged
  }
}
