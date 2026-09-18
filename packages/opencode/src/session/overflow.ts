import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export type CompactionTier = "none" | "microcompact" | "compact" | "hard_stop"

export function utilization(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
}): number {
  if (input.cfg.compaction?.auto === false) return 0
  const context = input.model.limit.context
  if (context === 0) return 0

  const count =
    input.tokens.total ||
    input.tokens.input + input.tokens.output + input.tokens.reasoning + input.tokens.cache.read + input.tokens.cache.write

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  const usable = input.model.limit.input
    ? input.model.limit.input - reserved
    : context - ProviderTransform.maxOutputTokens(input.model)
  if (usable <= 0) return 0
  return count / usable
}

export function thresholds(cfg: Config.Info): { tier1: number; tier2: number; tier3: number } {
  return {
    tier1: cfg.compaction?.tier1_threshold ?? 0.8,
    tier2: cfg.compaction?.tier2_threshold ?? 0.9,
    tier3: cfg.compaction?.tier3_threshold ?? 0.95,
  }
}

export function tier(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
}): CompactionTier {
  const u = utilization(input)
  const { tier1, tier2, tier3 } = thresholds(input.cfg)
  if (u >= tier3) return "hard_stop"
  if (u >= tier2) return "compact"
  if (u >= tier1) return "microcompact"
  return "none"
}

export function isTieringEnabled(input: { cfg: Config.Info; model: Provider.Model }): boolean {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false
  const usable = input.model.limit.input
    ? input.model.limit.input - (input.cfg.compaction?.reserved ?? COMPACTION_BUFFER)
    : input.model.limit.context - ProviderTransform.maxOutputTokens(input.model)
  return usable > 0
}

export function needsImmediateCompaction(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
}): boolean {
  return tier(input) === "hard_stop"
}

/** @deprecated Use tier() for graduated response. Fires at tier3_threshold (default 0.95), not 100%. */
export function isOverflow(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
}): boolean {
  return tier(input) === "hard_stop"
}
