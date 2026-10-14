/**
 * Spec 16 §D — Global memory backend registry.
 *
 * Mirrors the graph backend singleton pattern in src/memory/graph/index.ts.
 * When a SurrealBackend (or any MemoryBackend) is registered here, the
 * Memory namespace in memory.ts dispatches reads/writes through it instead
 * of falling back to the legacy SQLite/Drizzle path.
 */

import type { MemoryBackend } from "./backend"
import type { HypergraphBackend } from "./hypergraph-backend"
import { Log } from "../util/log"

const log = Log.create({ service: "memory.backend-registry" })

// Store on the process object so all bundled chunks share the same singleton.
// Module-level variables and globalThis get duplicated/isolated when the
// bundler splits this file into separate chunks. process is always shared.
const g: any = process
const BACKEND_KEY = "__fbh_memory_backend__"
const HYPERGRAPH_KEY = "__fbh_hypergraph_backend__"

export function setGlobalMemoryBackend(backend: MemoryBackend | null): void {
  g[BACKEND_KEY] = backend
  if (backend) {
    log.info("global memory backend registered", { type: backend.constructor.name })
  } else {
    log.info("global memory backend cleared")
  }
}

export function getGlobalMemoryBackend(): MemoryBackend | null {
  return (g[BACKEND_KEY] as MemoryBackend | null) ?? null
}

export function setGlobalHypergraphBackend(backend: HypergraphBackend | null): void {
  g[HYPERGRAPH_KEY] = backend
  if (backend) {
    log.info("global hypergraph backend registered", { type: backend.constructor.name })
  } else {
    log.info("global hypergraph backend cleared")
  }
}

export function getGlobalHypergraphBackend(): HypergraphBackend | null {
  return (g[HYPERGRAPH_KEY] as HypergraphBackend | null) ?? null
}

export type MemoryBackendType = "sqlite" | "surreal" | "remote"

export async function createMemoryBackend(
  type: MemoryBackendType,
  opts?: { db?: any; daemonUrl?: string; surreal?: { url?: string; username?: string; password?: string; namespace?: string; database?: string } },
): Promise<MemoryBackend | null> {
  if (type === "surreal") {
    const { SurrealBackend } = await import("./surreal-backend")
    return new SurrealBackend(opts?.db ? { db: opts.db, ...opts.surreal } : opts?.surreal ?? {})
  }
  if (type === "remote") {
    if (!opts?.daemonUrl) throw new Error("remote backend requires daemonUrl")
    const { RemoteMemoryBackend } = await import("./remote-backend")
    return new RemoteMemoryBackend(opts.daemonUrl)
  }
  return null
}
