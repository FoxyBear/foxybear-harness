import type { MemoryBackend, WriteInput, QueryInput, BackendMetrics } from "./backend"
import { Log } from "../util/log"

const log = Log.create({ service: "memory.noop" })

export class NoOpMemoryBackend implements MemoryBackend {
  private warned = false

  constructor(private readonly reason: string) {}

  private warnOnce() {
    if (this.warned) return
    this.warned = true
    log.warn("NoOpMemoryBackend active — memory operations are silently skipped", { reason: this.reason })
  }

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async write(_input: WriteInput): Promise<{ id: string }> {
    this.warnOnce()
    throw new Error("memory backend unavailable: " + this.reason)
  }

  async query(_input: QueryInput): Promise<[]> {
    this.warnOnce()
    return []
  }

  async forget(_id: string): Promise<void> {
    this.warnOnce()
  }

  async list(_persona: string, _limit?: number): Promise<[]> {
    this.warnOnce()
    return []
  }

  async getPrunable(_ttl_days: number): Promise<[]> {
    this.warnOnce()
    return []
  }

  async metrics(): Promise<BackendMetrics> {
    return { instance_count: 0, project_count: 0, global_count: 0, edge_count: 0 }
  }
}
