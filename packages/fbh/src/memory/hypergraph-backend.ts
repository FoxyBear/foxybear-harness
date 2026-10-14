import type { NodeRecord, HyperedgeRecord, QueryOpts, ExpandResult } from "./surreal-hypergraph-backend"
import type { LifecycleStatus } from "./schema/enums"

export interface HypergraphBackend {
  init(): Promise<void>
  close(): Promise<void>
  healthy(): boolean
  store(node: NodeRecord): Promise<NodeRecord>
  edge(e: HyperedgeRecord): Promise<HyperedgeRecord>
  query(seeds: string[], project_id: string, opts?: QueryOpts): Promise<HyperedgeRecord[]>
  expand(ids: string[], project_id: string, depth: number): Promise<ExpandResult>
  searchMemoryNodes(
    embedding: Float32Array,
    project_id: string,
    limit?: number,
  ): Promise<Array<{
    node_id: string
    content: string
    memory_type: string | null
    score: number
    created_at: number
    attributes: Record<string, unknown>
  }>>
  buildAdjacency(): Promise<{ node_count: number; edge_count: number }>
  closeVersion(node_id: string, now: number): Promise<void>
  getNode(node_id: string): Promise<NodeRecord | null>
  appendEvent(input: {
    event_type: string
    target_id: string
    target_type: "node" | "hyperedge"
    agent_id?: string | null
    payload?: Record<string, unknown>
  }): Promise<void>
  softDelete(node_id: string, invalidated_by: string | null, now: number): Promise<void>
  findMemoryNeighbor(
    embedding: Float32Array,
    project_id: string,
  ): Promise<{ node_id: string; cosine: number; content: string; project_id: string; version: number } | null>
  listLiveNodes(statuses: LifecycleStatus[], now: number): Promise<NodeRecord[]>
  updateNodeFields(
    node_id: string,
    fields: { status?: LifecycleStatus; confidence?: number; attributes?: Record<string, unknown>; updated_at?: number },
  ): Promise<void>
  listArchivedPastRetention(retention_days: number, now: number): Promise<NodeRecord[]>
  deleteNode(node_id: string): Promise<void>
  incrementUsage(node_id: string, now: number): Promise<void>
}
