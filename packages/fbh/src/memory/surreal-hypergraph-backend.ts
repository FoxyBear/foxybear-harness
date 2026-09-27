/**
 * SDD-03 / Phase M-1 — SurrealHypergraphBackend.
 *
 * Composes (holds a reference to) SurrealGraphBackend — does NOT extend it
 * because SurrealGraphBackend.query(input: { project_id, embedding?, ... })
 * has an incompatible signature with SC-5's query(seeds, project_id, opts?)
 * and TypeScript rejects the override (LSP violation, CC-4).
 *
 * Defines three new SurrealDB tables on the same connection:
 *  - node        — 6 ACTIVE node types (SCHEMALESS, flex attributes)
 *  - hyperedge   — 4 ACTIVE hyperedge types, node_ids as array<record<node>>
 *  - event       — append-only audit log (no UPDATE/DELETE)
 *
 * All time fields are epoch *seconds* (SC-2). Infinity serializes as the
 * sentinel 99999999999 in SurrealDB and deserializes back to Infinity in TS.
 *
 * CC-13 enforcement: store() rejects RESERVED node_type values; edge()
 * rejects RESERVED hyperedge_type values. Only ACTIVE types pass through.
 *
 * Existing tables (memory, entity, mentions, relates, supersedes, graph_entity,
 * graph_edge) are NOT dropped or altered (SC-8 backward compat).
 */
import { ulid } from "ulid"
import path from "path"
import { Log } from "../util/log"
import {
  SurrealGraphBackend,
  type SurrealGraphBackendOptions,
} from "./graph/surreal-backend"
import {
  type NodeType,
  type HyperedgeType,
  type LifecycleStatus,
  isActiveNodeType,
  isActiveHyperedgeType,
} from "./schema/enums"
import { is_live } from "./schema/lifecycle"

const log = Log.create({ service: "memory.hypergraph" })

const SENTINEL = 99999999999

export interface NodeRecord {
  node_id: string
  node_type: NodeType
  created_at: number
  updated_at: number
  version: number
  status: LifecycleStatus
  embedding: Float32Array | null
  attributes: Record<string, unknown>
  valid_from: number
  valid_to: number
  tx_from: number
  tx_to: number
  prev_version_id: string | null
  invalidated_by: string | null
}

export interface HyperedgeRecord {
  hyperedge_id: string
  hyperedge_type: HyperedgeType
  description: string
  node_ids: string[]
  confidence: number
  source_nodes: string[]
  embedding: Float32Array | null
  attributes: Record<string, unknown>
  valid_from: number
  valid_to: number
  tx_from: number
  tx_to: number
  prev_version_id: string | null
  invalidated_by: string | null
  status: LifecycleStatus
}

export interface QueryOpts {
  depth?: number
  types?: NodeType[]
  limit?: number
}

export interface ExpandResult {
  nodes: NodeRecord[]
  hyperedges: HyperedgeRecord[]
}

export interface BackfillReport {
  pre_count: {
    memory_topics: number
    memory: number
    graph_entity: number
    graph_edge: number
  }
  post_count: {
    node: number
    hyperedge: number
    superseded_edges: number
    contradicted_edges: number
  }
  content_hash: string
  surrealdb_version: string
  completed_at: string
  ran: boolean
}

export class SurrealHypergraphBackend {
  private graph: SurrealGraphBackend
  private opened = false
  private surrealVersion = "unknown"
  // In-memory adjacency (sdd-04 fifth run): node_id → up to 10 hyperedge_ids.
  // Built once after capture via buildAdjacency(); used by query() and
  // expand() for O(1) hash lookups instead of O(N) SurrealDB queries.
  // The fanout cap (10 per seed) is enforced at build time via slice(0, 10),
  // bounding the BFS frontier to 20 seeds × 10 hyperedges = 200 max.
  private adjacency: Map<string, string[]> = new Map()
  private hyperedgeCache: Map<string, HyperedgeRecord> = new Map()
  private nodeCache: Map<string, NodeRecord> = new Map()

  constructor(opts: SurrealGraphBackendOptions = {}) {
    this.graph = new SurrealGraphBackend(opts)
  }

  /**
   * Build the in-memory adjacency map (sdd-04 fifth run).
   *
   * Loads all `hyperedge_members` rows + the corresponding `hyperedge`
   * records into memory. After this call, `query()` and `expand()` use
   * O(1) hash lookups instead of O(N) SurrealDB queries — the dominant
   * cost in the fourth run's latency (P95=1463ms over the 100ms budget).
   *
   * The fanout cap (≤ 10 hyperedges per seed) is enforced at build time
   * by slicing each node's hyperedge_id list to 10. For 10k hyperedges
   * × ~3 nodes = ~30k entries, the map uses ~2-5MB.
   */
  async buildAdjacency(): Promise<{ node_count: number; edge_count: number }> {
    if (!this.opened) throw new Error("SurrealHypergraphBackend not initialized")

    this.adjacency = new Map()
    this.hyperedgeCache = new Map()
    // nodeCache is preserved across buildAdjacency calls — nodes don't
    // change when the adjacency map is rebuilt.

    const memberRows = (await this.graph.run(
      `SELECT hyperedge_id, node_id FROM hyperedge_members WHERE tx_to = ${SENTINEL};`,
    )) as { hyperedge_id: string; node_id: string }[]

    if (!Array.isArray(memberRows) || memberRows.length === 0) {
      log.info("adjacency map empty (no hyperedge_members rows)")
      return { node_count: 0, edge_count: 0 }
    }

    const byNode = new Map<string, string[]>()
    const allHeids = new Set<string>()
    for (const r of memberRows) {
      const arr = byNode.get(r.node_id) ?? []
      arr.push(r.hyperedge_id)
      byNode.set(r.node_id, arr)
      allHeids.add(r.hyperedge_id)
    }

    // Fetch all hyperedges (batched) and cache them by hyperedge_id.
    const heids = Array.from(allHeids)
    const BATCH = 500
    for (let i = 0; i < heids.length; i += BATCH) {
      const slice = heids.slice(i, i + BATCH)
      const idsLit =
        "[" + slice.map((s) => `hyperedge:⟨${escapeId(s)}⟩`).join(",") + "]"
      const rows = await this.graph.run(
        `SELECT * FROM hyperedge WHERE id IN ${idsLit} AND tx_to = ${SENTINEL} AND status != "DELETED";`,
      )
      for (const r of rows) {
        const rec = this.deserializeHyperedge(r)
        this.hyperedgeCache.set(rec.hyperedge_id, rec)
      }
    }

    // Build adjacency with fanout cap (≤ 10 hyperedges per seed).
    for (const [nodeId, heIds] of byNode) {
      this.adjacency.set(nodeId, heIds.slice(0, 10))
    }

    log.info("adjacency map built", {
      nodes: this.adjacency.size,
      hyperedges: this.hyperedgeCache.size,
    })
    return { node_count: this.adjacency.size, edge_count: this.hyperedgeCache.size }
  }

  /**
   * Clear the in-memory caches (sdd-04 fifth run). Useful when the
   * underlying hypergraph is mutated and the adjacency map is stale.
   */
  clearCaches(): void {
    this.adjacency = new Map()
    this.hyperedgeCache = new Map()
    this.nodeCache = new Map()
  }

  async init(): Promise<void> {
    if (this.opened) return
    await this.graph.init()

    await this.graph.run(`
      DEFINE TABLE IF NOT EXISTS node SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS hyperedge SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS hyperedge_members SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS event SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS node_type_idx ON node FIELDS node_type;
      DEFINE INDEX IF NOT EXISTS node_status_idx ON node FIELDS status;
      DEFINE INDEX IF NOT EXISTS node_project_idx ON node FIELDS attributes.project_id;
      DEFINE INDEX IF NOT EXISTS hyperedge_type_idx ON hyperedge FIELDS hyperedge_type;
      DEFINE INDEX OVERWRITE hyperedge_node_ids_idx ON hyperedge FIELDS node_ids.*;
      DEFINE INDEX IF NOT EXISTS hyperedge_members_node_idx ON hyperedge_members FIELDS node_id;
      DEFINE INDEX IF NOT EXISTS hyperedge_members_edge_idx ON hyperedge_members FIELDS hyperedge_id;
      DEFINE INDEX IF NOT EXISTS node_embedding_idx ON node FIELDS embedding HNSW DIMENSION 768 DIST COSINE;
    `)

    try {
      const ver = await this.graph.run(`INFO FOR ROOT;`)
      const row = ver[0] as { version?: string } | undefined
      if (row && typeof row.version === "string") this.surrealVersion = row.version
    } catch {
      // INFO FOR ROOT may require elevated perms in some setups; non-fatal.
    }

    this.opened = true
    log.info("hypergraph backend initialized", { surrealdb_version: this.surrealVersion })
  }

  async close(): Promise<void> {
    if (this.opened) {
      try {
        await this.graph.close()
      } catch {}
      this.opened = false
    }
  }

  healthy(): boolean {
    return this.opened
  }

  async store(node: NodeRecord): Promise<NodeRecord> {
    if (!this.opened) throw new Error("SurrealHypergraphBackend not initialized")
    if (!isActiveNodeType(node.node_type)) {
      throw new Error(`RESERVED node type rejected: ${node.node_type}`)
    }

    const fields = this.serializeNode(node)
    await this.graph.run(
      `CREATE node:⟨${escapeId(node.node_id)}⟩ CONTENT ${JSON.stringify(fields)};`,
    )
    await this.emitEvent("STORE", node.node_id, "node", null)
    return node
  }

  async edge(e: HyperedgeRecord): Promise<HyperedgeRecord> {
    if (!this.opened) throw new Error("SurrealHypergraphBackend not initialized")
    if (!isActiveHyperedgeType(e.hyperedge_type)) {
      throw new Error(`RESERVED hyperedge type rejected: ${e.hyperedge_type}`)
    }

    const fields = this.serializeHyperedge(e)
    await this.graph.run(
      `CREATE hyperedge:⟨${escapeId(e.hyperedge_id)}⟩ CONTENT ${JSON.stringify(fields)};`,
    )
    // Junction table (sdd-04 fourth run): one row per node_id, indexed on
    // node_id for O(log N) lookup. Replaces array<record> CONTAINSANY which
    // was 10x over the 100ms latency budget (CONTAINSANY scans every
    // hyperedge row × every seed; the junction table is a direct index
    // lookup per seed). The `node_ids` array stays on the `hyperedge` table
    // as the source of truth for membership; the junction table is a
    // denormalized query-acceleration structure kept in sync by edge().
    await this.writeMembers(e)
    await this.emitEvent("STORE", e.hyperedge_id, "hyperedge", null)
    return e
  }

  private async writeMembers(e: HyperedgeRecord): Promise<void> {
    const project_id = String(e.attributes.project_id ?? "global")
    const probe = e.attributes.probe === true
    // Dedupe node_ids — the source-of-truth `node_ids` array on the
    // hyperedge record may contain duplicates (e.g. the latency fixture
    // picks 3 random nodes with replacement). The junction table's
    // composite ID `hyperedge_id_node_id` would collide on duplicate
    // node_ids within the same hyperedge, so we dedupe here. The
    // hyperedge's `node_ids` array is preserved verbatim (source of
    // truth); only the junction rows are deduped.
    const uniqueNodeIds = [...new Set(e.node_ids)]
    for (const nid of uniqueNodeIds) {
      const mf = {
        hyperedge_id: e.hyperedge_id,
        node_id: nid,
        project_id,
        probe,
        valid_from: toSentinel(e.valid_from),
        valid_to: toSentinel(e.valid_to),
        tx_from: toSentinel(e.tx_from),
        tx_to: toSentinel(e.tx_to),
      }
      try {
        await this.graph.run(
          `CREATE hyperedge_members:⟨${escapeId(e.hyperedge_id + "_" + nid)}⟩ CONTENT ${JSON.stringify(mf)};`,
        )
      } catch (err) {
        log.warn("junction write failed", { hyperedge_id: e.hyperedge_id, node_id: nid, error: String(err) })
      }
    }
  }

  async query(seeds: string[], project_id: string, opts?: QueryOpts): Promise<HyperedgeRecord[]> {
    if (!this.opened) throw new Error("SurrealHypergraphBackend not initialized")
    const limit = opts?.limit ?? 10
    if (opts?.depth && opts.depth > 1) {
      const expanded = await this.expand(seeds, project_id, opts.depth)
      return expanded.hyperedges
    }
    if (seeds.length === 0) return []

    // Adjacency-map path (sdd-04 fifth run): O(1) hash lookups. The
    // fanout cap (10 per seed) was enforced at build time. This bypasses
    // the two SurrealDB queries (junction lookup + hyperedge fetch) that
    // dominated the fourth run's query() latency.
    if (this.adjacency.size > 0) {
      const out: HyperedgeRecord[] = []
      const seen = new Set<string>()
      for (const seed of seeds) {
        const heIds = this.adjacency.get(seed) ?? []
        for (const heId of heIds) {
          if (seen.has(heId)) continue
          seen.add(heId)
          const he = this.hyperedgeCache.get(heId)
          if (!he) continue
          const pid = String(he.attributes.project_id ?? "global")
          if (pid !== project_id && pid !== "global") continue
          out.push(he)
          if (out.length >= limit) return out
        }
      }
      return out
    }

    const now = Math.floor(Date.now() / 1000)
    const seedsList = "[" + seeds.map((s) => `"${escapeStr(s)}"`).join(",") + "]"
    // Junction-table path (sdd-04 fourth run) with fanout cap (fifth run):
    // LIMIT 10 bounds the per-call junction scan to ≤ 10 rows. The
    // hyperedge fetch below already had LIMIT ${limit}.
    const memberRows = await this.graph.run(
      `SELECT hyperedge_id FROM hyperedge_members
       WHERE node_id IN ${seedsList}
         AND project_id = "${escapeStr(project_id)}"
         AND tx_to = ${SENTINEL}
       LIMIT 10;`,
    )
    const hyperedgeIds = Array.from(
      new Set(
        memberRows.map((r: unknown) =>
          String((r as Record<string, unknown>).hyperedge_id ?? ""),
        ),
      ).values(),
    ).filter(Boolean)
    if (hyperedgeIds.length === 0) return []
    const idsList =
      "[" + hyperedgeIds.map((s) => `hyperedge:⟨${escapeId(s)}⟩`).join(",") + "]"
    const rows = await this.graph.run(
      `SELECT * FROM hyperedge
       WHERE id IN ${idsList}
         AND tx_to = ${SENTINEL}
         AND status != "DELETED"
       LIMIT ${limit};`,
    )
    return rows
      .map((r: unknown) => this.deserializeHyperedge(r))
      .filter((e: HyperedgeRecord) => is_live(e, now))
  }

  async expand(ids: string[], project_id: string, depth: number): Promise<ExpandResult> {
    if (!this.opened) throw new Error("SurrealHypergraphBackend not initialized")
    const maxDepth = Math.min(depth, 3)
    const now = Math.floor(Date.now() / 1000)

    const visited = new Set<string>(ids)
    const nodesOut: NodeRecord[] = []
    const edgesOut: HyperedgeRecord[] = []
    let frontier = [...ids]

    // Adjacency-map path (sdd-04 fifth run): in-memory BFS. Hyperedge
    // lookups are O(1) hash hits (no SurrealDB query per hop); only
    // node fetches hit the DB, and those go through the nodeCache so
    // each node is fetched at most once across the whole probe.
    if (this.adjacency.size > 0) {
      const seenHe = new Set<string>()
      for (let hop = 0; hop < maxDepth; hop++) {
        if (frontier.length === 0) break
        const newIds: string[] = []
        for (const seed of frontier) {
          const heIds = this.adjacency.get(seed) ?? []
          for (const heId of heIds) {
            if (seenHe.has(heId)) continue
            seenHe.add(heId)
            const he = this.hyperedgeCache.get(heId)
            if (!he) continue
            const pid = String(he.attributes.project_id ?? "global")
            if (pid !== project_id && pid !== "global") continue
            if (!edgesOut.find((x) => x.hyperedge_id === heId)) edgesOut.push(he)
            for (const nid of he.node_ids) {
              if (!visited.has(nid)) {
                visited.add(nid)
                newIds.push(nid)
              }
            }
          }
        }
        if (newIds.length === 0) break
        const nodeRows = await this.fetchNodes(newIds, project_id)
        for (const n of nodeRows) {
          if (!nodesOut.find((x) => x.node_id === n.node_id)) nodesOut.push(n)
        }
        frontier = newIds
      }
      const seedNodes = await this.fetchNodes(ids, project_id)
      for (const n of seedNodes) {
        if (!nodesOut.find((x) => x.node_id === n.node_id)) nodesOut.push(n)
      }
      return { nodes: nodesOut, hyperedges: edgesOut }
    }

    // DB path (fallback when adjacency not built)
    for (let hop = 0; hop < maxDepth; hop++) {
      if (frontier.length === 0) break
      const seedsList = "[" + frontier.map((s) => `"${escapeStr(s)}"`).join(",") + "]"
      // Junction-table BFS (sdd-04 fourth run) with fanout cap (fifth run):
      // LIMIT 10 bounds the per-hop junction scan. Combined with depth=1
      // (the fifth-run probe config), the total work is ≤ 10 hyperedges
      // × 1 hop = 10 hyperedges per expand call.
      const memberRows = await this.graph.run(
        `SELECT hyperedge_id FROM hyperedge_members
         WHERE node_id IN ${seedsList}
           AND project_id = "${escapeStr(project_id)}"
           AND tx_to = ${SENTINEL}
         LIMIT 10;`,
      )
      const hyperedgeIds = Array.from(
        new Set(
          memberRows.map((r: unknown) =>
            String((r as Record<string, unknown>).hyperedge_id ?? ""),
          ),
        ).values(),
      ).filter(Boolean)
      if (hyperedgeIds.length === 0) break
      const idsList =
        "[" + hyperedgeIds.map((s) => `hyperedge:⟨${escapeId(s)}⟩`).join(",") + "]"
      const rows = await this.graph.run(
        `SELECT * FROM hyperedge
         WHERE id IN ${idsList}
           AND tx_to = ${SENTINEL}
           AND status != "DELETED";`,
      )
      const liveEdges: HyperedgeRecord[] = rows
        .map((r: unknown) => this.deserializeHyperedge(r))
        .filter((e: HyperedgeRecord) => is_live(e, now))
      const newIds: string[] = []
      for (const e of liveEdges) {
        if (!edgesOut.find((x) => x.hyperedge_id === e.hyperedge_id)) edgesOut.push(e)
        for (const nid of e.node_ids) {
          if (!visited.has(nid)) {
            visited.add(nid)
            newIds.push(nid)
          }
        }
      }
      if (newIds.length === 0) break
      const nodeRows = await this.fetchNodes(newIds, project_id)
      for (const n of nodeRows) {
        if (!nodesOut.find((x) => x.node_id === n.node_id)) nodesOut.push(n)
      }
      frontier = newIds
    }
    const seedNodes = await this.fetchNodes(ids, project_id)
    for (const n of seedNodes) {
      if (!nodesOut.find((x) => x.node_id === n.node_id)) nodesOut.push(n)
    }
    return { nodes: nodesOut, hyperedges: edgesOut }
  }

  async neighbors(id: string, project_id: string): Promise<NodeRecord[]> {
    if (!this.opened) throw new Error("SurrealHypergraphBackend not initialized")
    const expanded = await this.expand([id], project_id, 1)
    return expanded.nodes.filter((n) => n.node_id !== id)
  }

  private async fetchNodes(ids: string[], project_id: string): Promise<NodeRecord[]> {
    if (ids.length === 0) return []
    // Node cache (sdd-04 fifth run): avoid re-fetching the same nodes
    // across expand() calls. Each NodeRecord is ~1KB; 10k nodes = ~10MB.
    const missing = ids.filter((id) => !this.nodeCache.has(id))
    if (missing.length > 0) {
      const idsList = "[" + missing.map((s) => `node:⟨${escapeId(s)}⟩`).join(",") + "]"
      const rows = await this.graph.run(`SELECT * FROM node WHERE id IN ${idsList};`)
      for (const r of rows) {
        const node = this.deserializeNode(r)
        this.nodeCache.set(node.node_id, node)
      }
    }
    const out: NodeRecord[] = []
    for (const id of ids) {
      const node = this.nodeCache.get(id)
      if (!node) continue
      const pid = String(node.attributes.project_id ?? "")
      if (pid === project_id || pid === "global" || pid === "") out.push(node)
    }
    return out
  }

  private async emitEvent(
    event_type: "STORE" | "UPDATE" | "DELETE" | "INVALIDATE" | "GC_DELETED",
    target_id: string,
    target_type: "node" | "hyperedge",
    agent_id: string | null,
  ): Promise<void> {
    const event_id = ulid()
    const fields = {
      event_id,
      event_type,
      target_id,
      target_type,
      agent_id,
      timestamp: Math.floor(Date.now() / 1000),
      payload: {},
    }
    try {
      await this.graph.run(
        `CREATE event:⟨${escapeId(event_id)}⟩ CONTENT ${JSON.stringify(fields)};`,
      )
    } catch (err) {
      log.warn("event emit failed", { event_type, target_id, error: String(err) })
    }
  }

  // ── SDD-06 / Phase M-3 lifecycle public API ──
  //
  // Exposes the node + event tables to the lifecycle engine (decay, gc,
  // graduate, score) without breaking SC-8 backward compat or the existing
  // store/edge/query surface. All methods are no-ops when the backend is
  // not initialized.

  /**
   * List node records whose status is in `statuses` and whose tx_to is open
   * (live per SC-2). Used by decay() to load the working set per tick.
   */
  async listLiveNodes(statuses: LifecycleStatus[], now: number): Promise<NodeRecord[]> {
    if (!this.opened) return []
    if (statuses.length === 0) return []
    const list = "[" + statuses.map((s) => `"${s}"`).join(",") + "]"
    const rows = await this.graph.run(
      `SELECT * FROM node WHERE status IN ${list} AND tx_to = ${SENTINEL};`,
    )
    return rows
      .map((r: unknown) => this.deserializeNode(r))
      .filter((n: NodeRecord) => is_live(n, now))
  }

  /**
   * Update a node's status + confidence + attributes atomically. Used by
   * decay() to persist the new confidence and any status transition.
   */
  async updateNodeFields(
    node_id: string,
    fields: { status?: LifecycleStatus; confidence?: number; attributes?: Record<string, unknown>; updated_at?: number },
  ): Promise<void> {
    if (!this.opened) return
    const merge: Record<string, unknown> = {}
    if (fields.status) merge.status = fields.status
    if (fields.updated_at != null) merge.updated_at = fields.updated_at
    if (fields.attributes) {
      // Merge attributes shallowly — SurrealDB MERGE does a deep merge on
      // object fields, so partial attributes preserve other keys.
      merge.attributes = fields.attributes
    }
    if (fields.confidence != null) {
      // Confidence lives inside attributes (SC-8 row 1 maps it there).
      merge.attributes = { ...(merge.attributes as Record<string, unknown> | undefined), confidence: fields.confidence }
    }
    await this.graph.run(
      `UPDATE node:⟨${escapeId(node_id)}⟩ MERGE ${JSON.stringify(merge)};`,
    )
  }

  /**
   * Append an arbitrary event record to the event table. Used by decay
   * (STATUS_TRANSITION), gc (GC_DELETED), and shadow (SHADOW_METRIC).
   * The event table is SCHEMALESS so any event_type string is accepted.
   */
  async appendEvent(input: {
    event_type: string
    target_id: string
    target_type: "node" | "hyperedge"
    agent_id?: string | null
    payload?: Record<string, unknown>
  }): Promise<void> {
    if (!this.opened) return
    const event_id = ulid()
    const fields = {
      event_id,
      event_type: input.event_type,
      target_id: input.target_id,
      target_type: input.target_type,
      agent_id: input.agent_id ?? null,
      timestamp: Math.floor(Date.now() / 1000),
      payload: input.payload ?? {},
    }
    try {
      await this.graph.run(
        `CREATE event:⟨${escapeId(event_id)}⟩ CONTENT ${JSON.stringify(fields)};`,
      )
    } catch (err) {
      log.warn("appendEvent failed", { event_type: input.event_type, target_id: input.target_id, error: String(err) })
    }
  }

  /**
   * Hard-delete a node record. Used by gc() for ARCHIVED nodes past
   * retention_days. The GC_DELETED event MUST be appended BEFORE the
   * hard-delete so the audit trail survives (req 7).
   */
  async deleteNode(node_id: string): Promise<void> {
    if (!this.opened) return
    await this.graph.run(`DELETE node:⟨${escapeId(node_id)}⟩;`)
  }

  /**
   * List ARCHIVED nodes whose age (now - created_at) exceeds retention_days.
   * Used by gc() to select the hard-delete set.
   */
  async listArchivedPastRetention(retention_days: number, now: number): Promise<NodeRecord[]> {
    if (!this.opened) return []
    const cutoff = now - retention_days * 86400
    const rows = await this.graph.run(
      `SELECT * FROM node WHERE status = "ARCHIVED" AND tx_to = ${SENTINEL} AND created_at < ${cutoff};`,
    )
    return rows
      .map((r: unknown) => this.deserializeNode(r))
      .filter((n: NodeRecord) => is_live(n, now))
  }

  /**
   * List ALL nodes with a given status (no is_live filter on tx_to — used
   * by gc to find ARCHIVED records including those whose tx_to closed).
   * For the standard live path use listLiveNodes.
   */
  async listNodesByStatus(status: LifecycleStatus): Promise<NodeRecord[]> {
    if (!this.opened) return []
    const rows = await this.graph.run(
      `SELECT * FROM node WHERE status = "${status}";`,
    )
    return rows.map((r: unknown) => this.deserializeNode(r))
  }

  /**
   * Soft-delete a node per req 6: close tx_to, set status=DELETED, set
   * invalidated_by. Caller appends the INVALIDATE event via appendEvent.
   * No hyperedge is created (SC-3, SC-4).
   */
  async softDelete(node_id: string, invalidated_by: string | null, now: number): Promise<void> {
    if (!this.opened) return
    const merge = {
      status: "DELETED" as LifecycleStatus,
      tx_to: now,
      invalidated_by,
      updated_at: now,
    }
    await this.graph.run(
      `UPDATE node:⟨${escapeId(node_id)}⟩ MERGE ${JSON.stringify(merge)};`,
    )
  }

  /**
   * Increment a node's usage_count and last_used attributes. Used by the
   * access path (SDD-05 TraceIngestor) — exposed here so the lifecycle
   * engine's spike test can simulate accesses without going through the
   * full Memory.store path.
   */
  async incrementUsage(node_id: string, now: number): Promise<void> {
    if (!this.opened) return
    await this.graph.run(
      `UPDATE node:⟨${escapeId(node_id)}⟩ MERGE ${JSON.stringify({
        attributes: { last_used: now },
        updated_at: now,
      })};`,
    )
    // usage_count increment — SurrealDB supports math-ish via UPDATE SET.
    await this.graph.run(
      `UPDATE node:⟨${escapeId(node_id)}⟩ SET attributes.usage_count = (attributes.usage_count ?? 0) + 1;`,
    )
  }

  // ── SDD-09 / Phase M-5 conflict detection public API ──
  //
  // Exposes the node table to ConflictDetector.check for save-time
  // neighbor lookup (MOSAIC-style cross-reference) without breaking SC-8
  // backward compat. All methods are no-ops when the backend is not
  // initialized.

  /**
   * Find the top live MEMORY neighbor by cosine similarity, scoped by
   * project_id (reqs 5, 22). Reuses the SurrealBackend hybrid retrieval
   * semantic leg (surreal-backend.ts:217-225 — vector::similarity::cosine
   * ORDER BY DESC) transferred to the node table. The project-scoping
   * clause (project_id = $pid OR project_id = "global" OR project_id = "")
   * reuses surreal-backend.ts:208-212 verbatim. Returns null when no live
   * MEMORY nodes exist in scope.
   */
  async findMemoryNeighbor(
    embedding: Float32Array,
    project_id: string,
  ): Promise<{ node_id: string; cosine: number; content: string; project_id: string; version: number } | null> {
    if (!this.opened) return null
    const qvec = JSON.stringify(Array.from(embedding))
    const pid = escapeStr(project_id)
    const pidClause = pid
      ? `(attributes.project_id = "${pid}" OR attributes.project_id = "global" OR attributes.project_id = "")`
      : `(attributes.project_id = "global" OR attributes.project_id = "")`
    const rows = await this.graph.run(
      `SELECT meta::id(id) AS node_id,
              vector::similarity::cosine(embedding, ${qvec}) AS cosine,
              attributes.content AS content,
              attributes.project_id AS project_id,
              version
       FROM node
       WHERE node_type = "MEMORY"
         AND status != "DELETED"
         AND tx_to = ${SENTINEL}
         AND ${pidClause}
         AND array::len(embedding) = ${embedding.length}
       ORDER BY cosine DESC
       LIMIT 10;`,
    )
    if (!Array.isArray(rows) || rows.length === 0) return null
    const top = rows[0] as Record<string, unknown>
    const node_id = String(top.node_id ?? "")
    if (!node_id) return null
    return {
      node_id,
      cosine: Number(top.cosine ?? 0),
      content: String(top.content ?? ""),
      project_id: String(top.project_id ?? ""),
      version: Number(top.version ?? 1),
    }
  }

  /**
   * Read a single node by id. Used by the UPDATE path to read the old
   * node's version + content for the new node's prev_version_id and
   * version = old.version + 1. Returns null when the node doesn't exist.
   */
  async getNode(node_id: string): Promise<NodeRecord | null> {
    if (!this.opened) return null
    const rows = await this.graph.run(
      `SELECT * FROM node:⟨${escapeId(node_id)}⟩;`,
    )
    if (!Array.isArray(rows) || rows.length === 0) return null
    return this.deserializeNode(rows[0])
  }

  /**
   * Close a node's tx_to without setting status=DELETED — the UPDATE
   * path's bi-temporal window close (req 18). The old node stays ACTIVE
   * (historical version, queryable via tx_to > now). Distinct from
   * softDelete which also sets status=DELETED + invalidated_by (req 20).
   */
  async closeVersion(node_id: string, now: number): Promise<void> {
    if (!this.opened) return
    const merge = {
      tx_to: now,
      updated_at: now,
    }
    await this.graph.run(
      `UPDATE node:⟨${escapeId(node_id)}⟩ MERGE ${JSON.stringify(merge)};`,
    )
  }

  // ── Injection Fix — node table HNSW KNN for AutoRecall ──
  //
  // Phase N captures quality memories into `node` (via classify) but
  // AutoRecall.autoRecall only queried the `memory` table. This exposes
  // the HNSW KNN path over MEMORY nodes so the seed query can RRF-fuse
  // both rankings. PF-1 pattern (packer.ts:16-37): the project_id +
  // node_type + status filters PUSH INTO the HNSW scan, keeping P95
  // within the 100ms budget on SurrealDB 3.0.5.

  /**
   * HNSW KNN search over MEMORY nodes scoped to project_id. Returns up to
   * `limit` nodes with cosine score, mapped to a flat shape for RRF fusion.
   * Distinct from findMemoryNeighbor (1 result via ORDER BY for conflict
   * detection) — this returns K results via the HNSW index for seed retrieval.
   */
  async searchMemoryNodes(
    embedding: Float32Array,
    project_id: string,
    limit: number = 20,
  ): Promise<Array<{
    node_id: string
    content: string
    memory_type: string | null
    score: number
    created_at: number
    attributes: Record<string, unknown>
  }>> {
    if (!this.opened) return []
    const qvec = JSON.stringify(Array.from(embedding))
    const pid = escapeStr(project_id)
    const rows = await this.graph.run(
      `SELECT meta::id(id) AS node_id,
              attributes.content AS content,
              attributes.memory_type AS memory_type,
              vector::similarity::cosine(embedding, ${qvec}) AS score,
              attributes AS attributes,
              created_at AS created_at
       FROM node
       WHERE embedding <|${limit},COSINE|> ${qvec}
         AND node_type = "MEMORY"
         AND attributes.project_id = "${pid}"
         AND status = "ACTIVE"
       LIMIT ${limit};`,
    )
    if (!Array.isArray(rows)) return []
    return rows.map((r: unknown) => {
      const row = (r ?? {}) as Record<string, unknown>
      return {
        node_id: String(row.node_id ?? ""),
        content: String(row.content ?? ""),
        memory_type: (row.memory_type as string | null) ?? null,
        score: Number(row.score ?? 0),
        created_at: Number(row.created_at ?? 0),
        attributes: (row.attributes as Record<string, unknown>) ?? {},
      }
    })
  }

  // ── Serialization ──

  private serializeNode(node: NodeRecord): Record<string, unknown> {
    return {
      node_id: node.node_id,
      node_type: node.node_type,
      created_at: node.created_at,
      updated_at: node.updated_at,
      version: node.version,
      status: node.status,
      embedding: node.embedding ? Array.from(node.embedding) : null,
      attributes: node.attributes ?? {},
      valid_from: toSentinel(node.valid_from),
      valid_to: toSentinel(node.valid_to),
      tx_from: toSentinel(node.tx_from),
      tx_to: toSentinel(node.tx_to),
      prev_version_id: node.prev_version_id,
      invalidated_by: node.invalidated_by,
    }
  }

  private serializeHyperedge(e: HyperedgeRecord): Record<string, unknown> {
    return {
      hyperedge_id: e.hyperedge_id,
      hyperedge_type: e.hyperedge_type,
      description: e.description,
      node_ids: e.node_ids,
      confidence: e.confidence,
      source_nodes: e.source_nodes,
      embedding: e.embedding ? Array.from(e.embedding) : null,
      attributes: e.attributes ?? {},
      valid_from: toSentinel(e.valid_from),
      valid_to: toSentinel(e.valid_to),
      tx_from: toSentinel(e.tx_from),
      tx_to: toSentinel(e.tx_to),
      prev_version_id: e.prev_version_id,
      invalidated_by: e.invalidated_by,
      status: e.status,
    }
  }

  private deserializeNode(row: unknown): NodeRecord {
    const r = (row ?? {}) as Record<string, unknown>
    return {
      node_id: String(r.node_id ?? rowId(r)),
      node_type: String(r.node_type ?? "MEMORY") as NodeType,
      created_at: Number(r.created_at ?? 0),
      updated_at: Number(r.updated_at ?? 0),
      version: Number(r.version ?? 1),
      status: String(r.status ?? "ACTIVE") as LifecycleStatus,
      embedding: Array.isArray(r.embedding) ? Float32Array.from(r.embedding as number[]) : null,
      attributes: (r.attributes as Record<string, unknown>) ?? {},
      valid_from: fromSentinel(r.valid_from),
      valid_to: fromSentinel(r.valid_to),
      tx_from: fromSentinel(r.tx_from),
      tx_to: fromSentinel(r.tx_to),
      prev_version_id: (r.prev_version_id as string | null) ?? null,
      invalidated_by: (r.invalidated_by as string | null) ?? null,
    }
  }

  private deserializeHyperedge(row: unknown): HyperedgeRecord {
    const r = (row ?? {}) as Record<string, unknown>
    return {
      hyperedge_id: String(r.hyperedge_id ?? rowId(r)),
      hyperedge_type: String(r.hyperedge_type ?? "EVIDENCE") as HyperedgeType,
      description: String(r.description ?? ""),
      node_ids: Array.isArray(r.node_ids) ? (r.node_ids as string[]) : [],
      confidence: Number(r.confidence ?? 0.5),
      source_nodes: Array.isArray(r.source_nodes) ? (r.source_nodes as string[]) : [],
      embedding: Array.isArray(r.embedding) ? Float32Array.from(r.embedding as number[]) : null,
      attributes: (r.attributes as Record<string, unknown>) ?? {},
      valid_from: fromSentinel(r.valid_from),
      valid_to: fromSentinel(r.valid_to),
      tx_from: fromSentinel(r.tx_from),
      tx_to: fromSentinel(r.tx_to),
      prev_version_id: (r.prev_version_id as string | null) ?? null,
      invalidated_by: (r.invalidated_by as string | null) ?? null,
      status: String(r.status ?? "ACTIVE") as LifecycleStatus,
    }
  }

  // ── Backfill (SC-8 / CC-1 / CC-13) ──

  async backfill(): Promise<BackfillReport> {
    if (!this.opened) throw new Error("SurrealHypergraphBackend not initialized")
    const { Global } = await import("../global")
    const markerPath = path.join(Global.Path.data, "memory-migration-hypergraph.json")
    const marker = Bun.file(markerPath)
    if (await marker.exists()) {
      log.info("hypergraph backfill already complete, skipping", { markerPath })
      const cached = await marker.json().catch(() => null)
      if (cached) return { ...cached, ran: false } as BackfillReport
    }

    const { Database } = await import("../storage/db")
    const { MemoryTopicsTable, GraphEntityTable, GraphEdgeTable } = await import("./memory.sql")
    const { bufferToFloat32 } = await import("./memory")

    const sqliteRows = Database.use((db) => ({
      memory_topics: db.select().from(MemoryTopicsTable).all(),
      graph_entity: db.select().from(GraphEntityTable).all(),
      graph_edge: db.select().from(GraphEdgeTable).all(),
    }))

    const pre_count = {
      memory_topics: sqliteRows.memory_topics.length,
      memory: 0,
      graph_entity: sqliteRows.graph_entity.length,
      graph_edge: sqliteRows.graph_edge.length,
    }

    // Surreal `memory` rows (post-sdd-02 migration target).
    const surrealMemoryRows = await this.graph
      .run(`SELECT * FROM memory;`)
      .catch(() => [] as unknown[])
    pre_count.memory = surrealMemoryRows.length

    const now = Math.floor(Date.now() / 1000)
    const nodes: NodeRecord[] = []
    const hyperedges: HyperedgeRecord[] = []
    let superseded = 0
    let contradicted = 0

    // memory_topics → MEMORY nodes (SC-8 row 1).
    for (const m of sqliteRows.memory_topics) {
      const embedding = m.embedding instanceof Buffer ? bufferToFloat32(m.embedding) : null
      const createdSec = Math.floor(Number((m as Record<string, unknown>).time_created ?? 0) / 1000)
      const accessedSec = Math.floor(Number((m as Record<string, unknown>).time_accessed ?? 0) / 1000)
      nodes.push({
        node_id: m.id,
        node_type: "MEMORY",
        created_at: createdSec,
        updated_at: createdSec,
        version: 1,
        status: "ACTIVE",
        embedding,
        attributes: {
          content: m.content,
          persona: m.persona,
          project_id: m.project_id ?? "global",
          scope: m.scope ?? "general",
          confidence: 0.5,
          usage_count: m.access_count ?? 0,
          last_used: accessedSec,
        },
        valid_from: createdSec,
        valid_to: Infinity,
        tx_from: now,
        tx_to: Infinity,
        prev_version_id: null,
        invalidated_by: null,
      })
    }

    // Surreal `memory` rows → MEMORY nodes (SC-8 row 2).
    for (const r of surrealMemoryRows) {
      const row = (r ?? {}) as Record<string, unknown>
      const id = String(row.id ?? ulid())
      const createdSec = row.created_at
        ? Math.floor(Date.parse(String(row.created_at)) / 1000)
        : now
      const embedding = Array.isArray(row.embedding)
        ? Float32Array.from(row.embedding as number[])
        : null
      nodes.push({
        node_id: id,
        node_type: "MEMORY",
        created_at: createdSec,
        updated_at: createdSec,
        version: 1,
        status: "ACTIVE",
        embedding,
        attributes: {
          content: String(row.content ?? ""),
          persona: String(row.persona ?? ""),
          project_id: String(row.project_id ?? "global"),
          scope: String(row.scope ?? "project"),
          confidence: 0.5,
          usage_count: Number(row.access_count ?? 0),
          last_used: createdSec,
        },
        valid_from: createdSec,
        valid_to: Infinity,
        tx_from: now,
        tx_to: Infinity,
        prev_version_id: null,
        invalidated_by: null,
      })
    }

    // graph_entity → ENTITY nodes (SC-8 row 3).
    for (const e of sqliteRows.graph_entity) {
      const embedding = e.embedding instanceof Buffer ? bufferToFloat32(e.embedding) : null
      const createdSec = Math.floor(Number((e as Record<string, unknown>).time_created ?? 0) / 1000)
      const validSec = Math.floor(Number(e.valid_from ?? 0) / 1000)
      const invalidSec = e.invalid_from != null ? Math.floor(Number(e.invalid_from) / 1000) : null
      const deleted = invalidSec != null
      nodes.push({
        node_id: e.id,
        node_type: "ENTITY",
        created_at: createdSec,
        updated_at: createdSec,
        version: 1,
        status: deleted ? "DELETED" : "ACTIVE",
        embedding,
        attributes: {
          name: e.name,
          entity_type: e.entity_type,
          content: e.content,
          project_id: e.project_id ?? "global",
        },
        valid_from: validSec,
        valid_to: deleted ? invalidSec! : Infinity,
        tx_from: createdSec,
        tx_to: deleted ? invalidSec! : Infinity,
        prev_version_id: null,
        invalidated_by: null,
      })
    }

    // graph_edge → ACTIVE hyperedges or bi-temporal node fields (SC-8 row 4 / CC-13).
    for (const edge of sqliteRows.graph_edge) {
      const edgeType = String(edge.edge_type ?? "RELATES_TO")
      const validSec = Math.floor(Number(edge.valid_from ?? 0) / 1000)
      const invalidSec = edge.invalid_from != null ? Math.floor(Number(edge.invalid_from) / 1000) : null

      if (edgeType === "SUPERSEDES") {
        // Mark prev_version_id on the successor MEMORY node. No hyperedge.
        const target = nodes.find((n) => n.node_id === edge.target_id)
        if (target) {
          target.prev_version_id = edge.source_id
          superseded++
        }
        continue
      }
      if (edgeType === "CONTRADICTS") {
        // Close tx_to + invalidated_by on the invalidated MEMORY node. No hyperedge.
        const target = nodes.find((n) => n.node_id === edge.target_id)
        if (target) {
          target.invalidated_by = edge.source_id
          target.tx_to = invalidSec ?? now
          target.status = "DEPRECATED"
          contradicted++
        }
        continue
      }
      // MENTIONS, RELATES, and other edge types → EVIDENCE hyperedge (ACTIVE).
      const description =
        edgeType === "MENTIONS" ? "mentions" : edgeType === "RELATES" ? (edge.edge_type ?? "relates") : edgeType
      hyperedges.push({
        hyperedge_id: edge.id,
        hyperedge_type: "EVIDENCE",
        description,
        node_ids: [edge.source_id, edge.target_id],
        confidence: Number(edge.weight ?? 1.0),
        source_nodes: [edge.source_id],
        embedding: null,
        attributes: {
          project_id: edge.project_id ?? "global",
          query_or_task_id: null,
        },
        valid_from: validSec,
        valid_to: invalidSec ?? Infinity,
        tx_from: validSec,
        tx_to: invalidSec ?? Infinity,
        prev_version_id: null,
        invalidated_by: null,
        status: invalidSec != null ? "DEPRECATED" : "ACTIVE",
      })
    }

    // Write nodes + hyperedges to SurrealDB.
    for (const node of nodes) {
      try {
        await this.store(node)
      } catch (err) {
        log.warn("backfill: node write failed", { id: node.node_id, error: String(err) })
      }
    }
    for (const e of hyperedges) {
      try {
        await this.edge(e)
      } catch (err) {
        log.warn("backfill: hyperedge write failed", { id: e.hyperedge_id, error: String(err) })
      }
    }

    const post_count = {
      node: nodes.length,
      hyperedge: hyperedges.length,
      superseded_edges: superseded,
      contradicted_edges: contradicted,
    }

    // Count verification (CC-1 — no data loss).
    const expectedNodes = pre_count.memory_topics + pre_count.memory + pre_count.graph_entity
    if (post_count.node !== expectedNodes) {
      throw new Error(
        `BACKFILL_COUNT_MISMATCH: node ${post_count.node} != expected ${expectedNodes}`,
      )
    }

    // Content hash — SHA-256 over sorted (node_id + content/description).
    const crypto = await import("crypto")
    const sortedNodes = [...nodes].sort((a, b) => a.node_id.localeCompare(b.node_id))
    const sortedEdges = [...hyperedges].sort((a, b) =>
      a.hyperedge_id.localeCompare(b.hyperedge_id),
    )
    const hasher = crypto.createHash("sha256")
    for (const n of sortedNodes) {
      const content = String(n.attributes.content ?? "")
      hasher.update(`${n.node_id}|${content}\n`)
    }
    for (const e of sortedEdges) {
      hasher.update(`${e.hyperedge_id}|${e.description}\n`)
    }
    const content_hash = hasher.digest("hex")

    const report: BackfillReport = {
      pre_count,
      post_count,
      content_hash,
      surrealdb_version: this.surrealVersion,
      completed_at: new Date().toISOString(),
      ran: true,
    }

    await Bun.write(markerPath, JSON.stringify(report, null, 2))
    log.info("hypergraph backfill complete", { nodes: post_count.node, hyperedges: post_count.hyperedge })
    return report
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function escapeId(s: string): string {
  return s.replace(/⟩/g, "")
}

function rowId(row: Record<string, unknown>): string {
  if (row == null) return ""
  const id = row.id
  if (typeof id === "string") {
    const idx = id.indexOf(":")
    if (idx < 0) return id
    let inner = id.slice(idx + 1)
    if (inner.startsWith("⟨") && inner.endsWith("⟩")) inner = inner.slice(1, -1)
    return inner
  }
  if (typeof id === "object" && id !== null) {
    const obj = id as { id?: unknown }
    if (obj.id != null) return String(obj.id)
  }
  return ""
}

function toSentinel(v: number): number {
  return v === Infinity ? SENTINEL : v
}

function fromSentinel(v: unknown): number {
  const n = Number(v ?? 0)
  return n === SENTINEL ? Infinity : n
}
