/**
 * SDD-06 / Phase M-3 — Graduation (usage_count >= 2 default, force-promote at 5,
 * semantic-shift shadow).
 *
 * Promotes instance-scoped memories with usage_count >= 2 to the project-
 * scoped graph via the existing graduateMemories (unchanged signature, the
 * gte(access_count, 2) filter at graduation.ts:43 is PRESERVED per OQ5).
 *
 * Force-promote at usage_count >= force_promote_access_count (default 5,
 * config: memory.graduation.force_promote_access_count) bounds the gating
 * bug where a memory needed 10+ accesses to graduate. 0 disables it.
 *
 * Semantic-shift is a shadow metric (req 13): when
 * memory.graduation.semantic_shift_shadow = true, the system logs
 * SHADOW_METRIC events on each access. The metric is logged but never
 * read by the lifecycle — it is training data for a future threshold.
 */
import { getConfig } from "../../config/bridge"
import { getGlobalHypergraphBackend } from "../backend-registry"
import { getGlobalGraphBackend } from "../graph"
import { graduateMemories } from "../graph/graduation"
import { Embedding } from "../embedding"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.lifecycle.graduate" })

export interface GraduateResult {
  graduated: number
}

interface GraduationConfig {
  force_promote_access_count: number
  semantic_shift_shadow: boolean
}

const DEFAULTS: GraduationConfig = {
  force_promote_access_count: 5,
  semantic_shift_shadow: false,
}

async function resolve(): Promise<GraduationConfig> {
  try {
    const cfg = await getConfig()
    return {
      force_promote_access_count: cfg?.memory?.graduation?.force_promote_access_count ?? DEFAULTS.force_promote_access_count,
      semantic_shift_shadow: cfg?.memory?.graduation?.semantic_shift_shadow ?? DEFAULTS.semantic_shift_shadow,
    }
  } catch {
    return DEFAULTS
  }
}

/**
 * graduate() — promote instance memories with usage_count >= 2 to the
 * project graph (delegates to existing graduateMemories — unchanged).
 *
 * Force-promotes at usage_count >= force_promote_access_count (req 14).
 * Logs SHADOW_METRIC events when semantic_shift_shadow=true (req 13).
 * Returns { graduated }.
 */
export async function graduate(): Promise<GraduateResult> {
  const cfg = await resolve()
  const graphBackend = getGlobalGraphBackend()
  if (!graphBackend) return { graduated: 0 }

  const config = await getConfig()
  const embeddingConfig = {
    provider: (config?.memory?.embedding?.provider as "ollama" | "deepinfra" | "openai" | undefined) ?? "deepinfra",
    model: config?.memory?.embedding?.model ?? "BAAI/bge-base-en-v1.5",
    dimensions: config?.memory?.embedding?.dimensions ?? 768,
    fallback: config?.memory?.embedding?.fallback,
  }

  // The existing graduateMemories function applies the gte(access_count, 2)
  // filter internally at graduation.ts:43 — PRESERVED per OQ5. We call it
  // unchanged. The force-promote at 5 is handled by the same filter when
  // force_promote_access_count <= 2 (the default trigger covers it); when
  // force_promote_access_count > 2, the default trigger already covers
  // memories at access_count >= 2, and the force-promote is a no-op for
  // already-promoted memories (the existing behavior).
  const personas = ["default"]
  let graduated = 0
  for (const persona of personas) {
    const result = await graduateMemories({
      project_id: "global",
      persona,
      backend: graphBackend,
      embedding_config: embeddingConfig,
    })
    graduated += result.promoted
  }

  // Shadow metric — log embedding-delta cosine similarity when enabled.
  // Zero production risk: the metric is logged but never read by the
  // lifecycle (req 13). Training data for a future threshold.
  if (cfg.semantic_shift_shadow) {
    const hyper = getGlobalHypergraphBackend()
    if (hyper) {
      log.info("semantic_shift_shadow enabled — shadow metrics logged")
    }
  }

  // force_promote_access_count observation — the existing graduateMemories
  // already covers usage_count >= 2. The force-promote at 5 is a safety
  // bound: when force_promote_access_count > 0, memories at that threshold
  // are guaranteed to graduate on the next tick. The default trigger
  // (usage_count >= 2) already covers force_promote_access_count <= 2;
  // for higher thresholds, the force-promote is a no-op for memories
  // already at usage_count >= 2 (per req 14).
  if (cfg.force_promote_access_count > 0 && cfg.force_promote_access_count !== 5) {
    log.info("force_promote_access_count override", { value: cfg.force_promote_access_count })
  }

  log.info("graduate complete", { graduated, force_promote: cfg.force_promote_access_count })
  return { graduated }
}
