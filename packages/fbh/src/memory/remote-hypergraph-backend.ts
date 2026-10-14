import type { HypergraphBackend } from "./hypergraph-backend"
import type { NodeRecord, HyperedgeRecord, QueryOpts, ExpandResult } from "./surreal-hypergraph-backend"
import type { LifecycleStatus } from "./schema/enums"

const TIMEOUT_MS = 15_000

export class RemoteHypergraphBackend implements HypergraphBackend {
  private _healthy = false

  constructor(private readonly baseUrl: string) {}

  async init(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/memory/hypergraph/health`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      this._healthy = res.ok
    } catch {
      this._healthy = false
    }
  }

  async close(): Promise<void> {
    this._healthy = false
  }

  healthy(): boolean {
    return this._healthy
  }

  async store(node: NodeRecord): Promise<NodeRecord> {
    if (!this._healthy) throw new Error("remote hypergraph backend unhealthy")
    const body = {
      ...node,
      embedding: node.embedding ? Array.from(node.embedding) : null,
    }
    try {
      await this.post("/memory/hypergraph/store", body)
    } catch (err) {
      this._healthy = false
      throw err
    }
    return node
  }

  async edge(e: HyperedgeRecord): Promise<HyperedgeRecord> {
    if (!this._healthy) throw new Error("remote hypergraph backend unhealthy")
    const body = {
      ...e,
      embedding: e.embedding ? Array.from(e.embedding) : null,
    }
    try {
      await this.post("/memory/hypergraph/edge", body)
    } catch (err) {
      this._healthy = false
      throw err
    }
    return e
  }

  async searchMemoryNodes(
    embedding: Float32Array,
    project_id: string,
    limit?: number,
  ): Promise<Array<{ node_id: string; content: string; memory_type: string | null; score: number; created_at: number; attributes: Record<string, unknown> }>> {
    if (!this._healthy) return []
    try {
      return await this.post("/memory/hypergraph/search", {
        embedding: Array.from(embedding),
        project_id,
        limit: limit ?? 20,
      })
    } catch {
      this._healthy = false
      return []
    }
  }

  // Methods below are daemon-only (lifecycle, conflict, packing).
  // Session processes never reach these code paths; returning empty
  // results matches the degradation callers already handle.

  async query(_seeds: string[], _project_id: string, _opts?: QueryOpts): Promise<HyperedgeRecord[]> { return [] }
  async expand(_ids: string[], _project_id: string, _depth: number): Promise<ExpandResult> { return { nodes: [], hyperedges: [] } }
  async buildAdjacency(): Promise<{ node_count: number; edge_count: number }> { return { node_count: 0, edge_count: 0 } }
  async closeVersion(_node_id: string, _now: number): Promise<void> {}
  async getNode(_node_id: string): Promise<null> { return null }
  async appendEvent(_input: { event_type: string; target_id: string; target_type: "node" | "hyperedge"; agent_id?: string | null; payload?: Record<string, unknown> }): Promise<void> {}
  async softDelete(_node_id: string, _invalidated_by: string | null, _now: number): Promise<void> {}
  async findMemoryNeighbor(_embedding: Float32Array, _project_id: string): Promise<null> { return null }
  async listLiveNodes(_statuses: LifecycleStatus[], _now: number): Promise<NodeRecord[]> { return [] }
  async updateNodeFields(_node_id: string, _fields: { status?: LifecycleStatus; confidence?: number; attributes?: Record<string, unknown>; updated_at?: number }): Promise<void> {}
  async listArchivedPastRetention(_retention_days: number, _now: number): Promise<NodeRecord[]> { return [] }
  async deleteNode(_node_id: string): Promise<void> {}
  async incrementUsage(_node_id: string, _now: number): Promise<void> {}

  private async post(endpoint: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`RemoteHypergraphBackend POST ${endpoint} failed: ${res.status} ${text}`)
    }
    return res.json()
  }
}
