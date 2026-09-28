/**
 * SDD-06 / Phase M-3 — Shadow metric (semantic-shift, observational only).
 *
 * log_shadow(memory_id, access_context, opts?) computes the embedding-delta
 * cosine similarity between the access context and the memory's content,
 * and appends a SHADOW_METRIC event to the event table with
 * { memory_id, access_context_embedding_delta, timestamp } in the payload.
 *
 * This is a SHADOW metric — it does NOT affect graduation, decay, or
 * scoring decisions. The lifecycle never reads SHADOW_METRIC events.
 * It is training data for a future semantic-shift threshold (the council
 * ruled semantic-shift requires tuning an embedding-delta threshold with
 * no labeled data, so it is shadow-only until labeled data exists).
 *
 * Off by default (memory.graduation.semantic_shift_shadow = false).
 */
import { getGlobalHypergraphBackend } from "../backend-registry"
import { Embedding } from "../embedding"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.lifecycle.shadow" })

export interface ShadowInput {
  memory_id: string
  access_context: string
  memory_embedding?: Float32Array | null
  now?: number
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

/**
 * log_shadow(input) — append a SHADOW_METRIC event with the embedding-delta
 * cosine similarity between the access context and the memory's content.
 *
 * Called by SDD-05 TraceIngestor on each access when
 * memory.graduation.semantic_shift_shadow = true. Zero production risk —
 * the metric is logged but never read by the lifecycle.
 */
export async function log_shadow(input: ShadowInput): Promise<void> {
  const backend = getGlobalHypergraphBackend()
  if (!backend) return

  const now = input.now ?? Math.floor(Date.now() / 1000)

  // Compute the access-context embedding. If the memory's embedding is
  // available, the delta is the cosine similarity between the two;
  // otherwise we log null and let a downstream consumer compute it.
  let delta: number | null = null
  if (input.memory_embedding) {
    try {
      const ctx = await Embedding.embed(input.access_context, {
        provider: "deepinfra",
        model: "BAAI/bge-base-en-v1.5",
        dimensions: 768,
      })
      delta = cosine(ctx, input.memory_embedding)
    } catch {
      delta = null
    }
  }

  await backend.appendEvent({
    event_type: "SHADOW_METRIC",
    target_id: input.memory_id,
    target_type: "node",
    payload: {
      memory_id: input.memory_id,
      access_context_embedding_delta: delta,
      timestamp: now,
    },
  })

  log.info("shadow metric logged", { memory_id: input.memory_id, delta })
}
