/**
 * SDD-05 / Phase M-2 — Extraction config + mode orchestration.
 *
 * Reads `memory.extraction` from the resolved global config (CC-6).
 * Per W-22, `external_opt_in` defaults to `false` — NOT default-on per CC-12.
 * Extraction only proceeds against an external provider (DeepInfra) if
 * explicitly opted in. `self_hosted_fallback_model` is pre-named for the
 * self-hosted fallback (W-24); `self_hosted = true` routes extraction to
 * the local model instead of the external provider.
 *
 * `mode` controls regex vs llm vs hybrid extraction (W-20).
 * `threshold` gates which turns get LLM extraction (W-11).
 * `model` / `fallback_model` / `self_hosted_fallback_model` are used for
 * the extraction LLM calls.
 */
import { getConfig } from "../../config/bridge"

export type ExtractionMode = "regex" | "llm" | "hybrid"

export interface ExtractionConfig {
  mode: ExtractionMode
  model: string
  fallback_model: string
  self_hosted_fallback_model: string
  external_opt_in: boolean
  self_hosted: boolean
  threshold: number
  batch_size: number
  async: boolean
}

export const DEFAULT_EXTRACTION: ExtractionConfig = {
  mode: "hybrid",
  model: "deepinfra/Qwen/Qwen2.5-7B-Instruct",
  fallback_model: "openai/gpt-4o-mini",
  self_hosted_fallback_model: "ollama://qwen2.5:7b-instruct",
  external_opt_in: false,
  self_hosted: false,
  threshold: 0.7,
  batch_size: 5,
  async: true,
}

export async function resolveExtractionConfig(): Promise<ExtractionConfig> {
  try {
    const cfg = await getConfig()
    const e = cfg?.memory?.extraction
    return {
      mode: e?.mode ?? DEFAULT_EXTRACTION.mode,
      model: e?.model ?? DEFAULT_EXTRACTION.model,
      fallback_model: e?.fallback_model ?? DEFAULT_EXTRACTION.fallback_model,
      self_hosted_fallback_model:
        e?.self_hosted_fallback_model ?? DEFAULT_EXTRACTION.self_hosted_fallback_model,
      external_opt_in: e?.external_opt_in ?? DEFAULT_EXTRACTION.external_opt_in,
      self_hosted: e?.self_hosted ?? DEFAULT_EXTRACTION.self_hosted,
      threshold: e?.threshold ?? DEFAULT_EXTRACTION.threshold,
      batch_size: e?.batch_size ?? DEFAULT_EXTRACTION.batch_size,
      async: e?.async ?? DEFAULT_EXTRACTION.async,
    }
  } catch {
    return DEFAULT_EXTRACTION
  }
}

export function externalLLMEnabled(cfg: ExtractionConfig): boolean {
  if (cfg.mode === "regex") return false
  if (cfg.self_hosted) return false
  return cfg.external_opt_in
}
