/**
 * SDD-09 / Phase M-5 — Decision-driven write loop (reqs 16-21).
 *
 * Applies the verdict from ConflictDetector.check:
 *
 *   ADD    — handled by storeImpl's existing flow (including the
 *            cosine > 0.95 dedup at memory.ts:302-345). applyVerdict
 *            does NOT handle ADD; the caller falls through.
 *
 *   UPDATE — rewrite the old memory (reqs 17-19):
 *            - store new content as a new node (new node_id)
 *            - version = old.version + 1, prev_version_id = old.node_id
 *            - close old.tx_to = now (old stays ACTIVE — historical)
 *            - emit UPDATE event with localized subgraph in payload
 *
 *   DELETE — bi-temporal soft-delete the old memory (reqs 20-21):
 *            - store new content as a new node (version = 1,
 *              prev_version_id = null — DELETE is not a version chain)
 *            - soft-delete old (tx_to=now, status=DELETED,
 *              invalidated_by=new.node_id)
 *            - emit INVALIDATE event with localized subgraph in payload
 *            - NO hard-delete (GC-only on ARCHIVED past retention, CC-7)
 *
 * Uses Effect.runPromise for Effect-returning operations (the check
 * service's layer). The store call SHALL NOT hard-delete on conflict —
 * only soft-delete (req 4, CC-7).
 */
import { Effect } from "effect"
import { ulid } from "ulid"
import type { MemoryEntry } from "../memory"
import { getGlobalMemoryBackend, getGlobalHypergraphBackend } from "../backend-registry"
import { Log } from "../../util/log"
import type { CheckResult } from "./check"

const log = Log.create({ service: "memory.conflict.apply" })

export interface StoreInput {
  content: string
  persona: string
  project_id?: string
  scope?: string
  metadata?: Record<string, unknown>
}

// Store the new content as a new node via the SurrealBackend + hypergraph
// dual-write (reuses memory.ts storeImpl's dispatch pattern). Returns the
// new MemoryEntry. The hypergraph node is stored with custom version +
// prev_version_id fields for UPDATE; version=1, prev_version_id=null for
// DELETE.
async function storeNew(
  content: string,
  input: StoreInput,
  embedding: Float32Array | null,
  version: number,
  prev_version_id: string | null,
): Promise<MemoryEntry> {
  const backend = getGlobalMemoryBackend()
  const projectId = input.project_id ?? "global"
  const scope: "instance" | "project" | "global" =
    (input.scope === "instance" || input.scope === "project" || input.scope === "global")
      ? input.scope
      : projectId === "global" ? "global" : "project"

  let newId: string
  if (backend) {
    const result = await backend.write({
      content,
      embedding,
      scope,
      project_id: projectId,
      persona: input.persona,
      metadata: input.metadata,
    })
    newId = result.id
  } else {
    newId = ulid()
  }

  // Hypergraph dual-write with custom version + prev_version_id.
  const hyper = getGlobalHypergraphBackend()
  if (hyper) {
    try {
      const now = Math.floor(Date.now() / 1000)
      await hyper.store({
        node_id: newId,
        node_type: "MEMORY",
        created_at: now,
        updated_at: now,
        version,
        status: "ACTIVE",
        embedding,
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
        prev_version_id,
        invalidated_by: null,
      })
    } catch (err) {
      log.warn("apply: hypergraph dual-write failed", { error: String(err) })
    }
  }

  const now = new Date().toISOString()
  return {
    id: newId,
    content,
    persona: input.persona,
    scope,
    access_count: 0,
    created_at: now,
    accessed_at: now,
    metadata: input.metadata ?? {},
  }
}

// Compute embedding for the new content (reuses memory.ts:238 getEmbedding
// pattern). Returns null when unavailable — storeNew proceeds without it
// (the existing storeImpl behavior).
async function embed(content: string): Promise<Float32Array | null> {
  try {
    const { Embedding } = await import("../embedding")
    const { getConfig } = await import("../../config/bridge")
    const cfg = await getConfig()
    const mem = cfg.memory
    const embeddingConfig = mem?.embedding
      ? {
          provider: mem.embedding.provider as "ollama" | "deepinfra" | "openai",
          model: mem.embedding.model,
          dimensions: mem.embedding.dimensions,
          fallback: mem.embedding.fallback,
        }
      : {
          provider: "deepinfra" as const,
          model: "BAAI/bge-base-en-v1.5",
          dimensions: 768,
        }
    const result = await Embedding.embedSafe(content, embeddingConfig)
    if (!result.ok) return null
    return result.value
  } catch {
    return null
  }
}

/**
 * rewrite(target, content, input, subgraph) — UPDATE decision's coordinated
 * rewrite (reqs 17-19). Stores the new content as a new node with version =
 * old.version + 1 and prev_version_id = old.node_id, closes the old node's
 * tx_to = now (preserving it as a historical version — status stays ACTIVE),
 * and emits an UPDATE event with the localized subgraph in the payload.
 */
export async function rewrite(
  target: string,
  content: string,
  input: StoreInput,
  subgraph: { node_ids: string[]; hyperedge_ids: string[] },
): Promise<MemoryEntry> {
  const hyper = getGlobalHypergraphBackend()
  const now = Math.floor(Date.now() / 1000)

  // Read the old node to get its version (req 17: version = old.version + 1).
  let oldVersion = 1
  if (hyper) {
    const old = await hyper.getNode(target)
    if (old) oldVersion = old.version
  }

  const embedding = await embed(content)
  const entry = await storeNew(content, input, embedding, oldVersion + 1, target)

  // Close the old node's bi-temporal window (req 18): tx_to = now, status
  // stays ACTIVE (historical version). NO hard-delete.
  if (hyper) {
    try {
      await hyper.closeVersion(target, now)
    } catch (err) {
      log.warn("rewrite: closeVersion failed", { target, error: String(err) })
    }

    // Emit the UPDATE event (req 19) with the localized subgraph in payload.
    try {
      await hyper.appendEvent({
        event_type: "UPDATE",
        target_id: entry.id,
        target_type: "node",
        agent_id: null,
        payload: {
          old_node_id: target,
          subgraph_node_ids: subgraph.node_ids,
          subgraph_hyperedge_ids: subgraph.hyperedge_ids,
        },
      })
    } catch (err) {
      log.warn("rewrite: UPDATE event emit failed", { error: String(err) })
    }
  }

  log.info("rewrite complete", { old: target, new: entry.id, version: oldVersion + 1 })
  return entry
}

/**
 * retract(target, content, input, subgraph) — DELETE decision's bi-temporal
 * soft-delete (reqs 20-21). Stores the new content as a new node (version =
 * 1, prev_version_id = null — DELETE is not a version chain), bi-temporal
 * soft-deletes the old node (tx_to=now, status=DELETED, invalidated_by=
 * new.node_id), and emits an INVALIDATE event with the localized subgraph
 * in the payload. NO DELETE event — DELETE event_type is GC-only (SC-9).
 * NO hard-delete — GC-only on ARCHIVED past retention (CC-7).
 */
export async function retract(
  target: string,
  content: string,
  input: StoreInput,
  subgraph: { node_ids: string[]; hyperedge_ids: string[] },
): Promise<MemoryEntry> {
  const hyper = getGlobalHypergraphBackend()
  const now = Math.floor(Date.now() / 1000)

  const embedding = await embed(content)
  // DELETE: version = 1, prev_version_id = null (not a version chain, req 20).
  const entry = await storeNew(content, input, embedding, 1, null)

  // Bi-temporal soft-delete the old node (req 20): tx_to=now,
  // status=DELETED, invalidated_by=new.node_id. valid_to unchanged.
  if (hyper) {
    try {
      await hyper.softDelete(target, entry.id, now)
    } catch (err) {
      log.warn("retract: softDelete failed", { target, error: String(err) })
    }

    // Emit the INVALIDATE event (req 21) with the localized subgraph in
    // payload. NO DELETE event (SC-9: DELETE is GC-only).
    try {
      await hyper.appendEvent({
        event_type: "INVALIDATE",
        target_id: target,
        target_type: "node",
        agent_id: entry.id,
        payload: {
          new_node_id: entry.id,
          subgraph_node_ids: subgraph.node_ids,
          subgraph_hyperedge_ids: subgraph.hyperedge_ids,
        },
      })
    } catch (err) {
      log.warn("retract: INVALIDATE event emit failed", { error: String(err) })
    }
  }

  log.info("retract complete", { old: target, new: entry.id })
  return entry
}

/**
 * applyVerdict(verdict, content, input) — dispatch the verdict to the
 * appropriate path. ADD is handled by the caller (storeImpl's existing
 * flow); UPDATE → rewrite, DELETE → retract. Uses Effect.runPromise for
 * Effect-returning operations when needed.
 */
export async function applyVerdict(
  verdict: CheckResult,
  content: string,
  input: StoreInput,
): Promise<MemoryEntry> {
  if (verdict.verdict === "UPDATE" && verdict.target) {
    const subgraph = verdict.subgraph ?? { node_ids: [], hyperedge_ids: [] }
    return await rewrite(verdict.target, content, input, subgraph)
  }
  if (verdict.verdict === "DELETE" && verdict.target) {
    const subgraph = verdict.subgraph ?? { node_ids: [], hyperedge_ids: [] }
    return await retract(verdict.target, content, input, subgraph)
  }
  // ADD or missing target — should not reach here (caller handles ADD).
  // Fall back to storeNew with version=1, prev_version_id=null.
  const embedding = await embed(content)
  return await storeNew(content, input, embedding, 1, null)
}

// Effect.runPromise is the canonical Effect-to-Promise bridge for callers
// that need to invoke the check service from a non-Effect context (e.g.
// memory.ts storeImpl). Exported here for convenience.
export { Effect }
