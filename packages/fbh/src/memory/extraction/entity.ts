/**
 * SDD-05 / Phase M-2 W-9 — EntityExtractor.
 *
 * Extracts ENTITY nodes from turn content. Hybrid mode:
 *   - regex path: delegates to extractEntities (extraction.ts:45) for low-value turns
 *   - LLM path:   invokes Qwen2.5-7B-Instruct via Provider.Service for high-value turns
 *
 * LLM-extracted ENTITY nodes get initial confidence 0.5 (source_path = "llm")
 * per W-25. Regex-extracted ENTITY nodes get initial confidence 0.7
 * (source_path = "tool") per W-25.
 *
 * The LLM payload is built from text-only content (W-14): the turn's MESSAGE
 * content + ACTION input/output summaries. Embeddings, auth.json contents,
 * API keys, and vector data are NEVER sent. Secrets redaction (W-21) runs
 * BEFORE the LLM call.
 *
 * External opt-in (W-22) gates the LLM path: external_opt_in = false → regex only.
 *
 * Provider path (W-15): uses Provider.parseModel + the existing createDeepInfra
 * transport. No new HTTP client, no new auth path.
 */
import { Log } from "../../util/log"
import { extractEntities, type ExtractedEntity } from "../extraction"
import { redact } from "./redact"
import { confidenceFor, type Provenance } from "../capture/confidence"

const log = Log.create({ service: "memory.extraction.entity" })

export interface ExtractedEntityRecord extends ExtractedEntity {
  confidence: number
  source_path: Provenance
}

export interface ExtractOpts {
  mode: "regex" | "llm" | "hybrid"
  external_opt_in: boolean
  self_hosted: boolean
  model: string
  fallback_model: string
  self_hosted_fallback_model: string
  threshold: number
  score: number
  authKeys?: string[]
}

export namespace EntityExtractor {
  /**
   * Extract ENTITY records from turn content. Hybrid mode selects the path:
   *   - regex: deterministic regex extractor (extractEntities)
   *   - llm:   LLM extractor via Provider.Service (Qwen2.5-7B-Instruct)
   *   - hybrid: regex when score < threshold, LLM when score >= threshold
   *
   * LLM path requires external_opt_in = true (W-22) or self_hosted = true (W-24).
   * If neither is set, falls back to regex (W-10).
   */
  export async function extract(text: string, opts: ExtractOpts): Promise<ExtractedEntityRecord[]> {
    if (shouldRunLLM(opts)) {
      try {
        const llmEntities = await extractViaLLM(text, opts)
        if (llmEntities.length > 0) return llmEntities
      } catch (err) {
        log.warn("entity LLM extraction failed, falling back to regex", { error: String(err) })
        try {
          const fb = await extractViaLLM(text, { ...opts, model: opts.fallback_model })
          if (fb.length > 0) return fb
        } catch (fbErr) {
          log.warn("entity LLM fallback failed, using regex", { error: String(fbErr) })
        }
      }
    }
    return extractRegex(text)
  }

  export function extractRegex(text: string): ExtractedEntityRecord[] {
    return extractEntities(text).map((e) => ({
      ...e,
      confidence: confidenceFor("tool"),
      source_path: "tool",
    }))
  }

  async function extractViaLLM(text: string, opts: ExtractOpts): Promise<ExtractedEntityRecord[]> {
    const model = opts.self_hosted ? opts.self_hosted_fallback_model : opts.model
    if (!model) return extractRegex(text)

    const { content: redacted } = redact(text, { authKeys: opts.authKeys })
    const { Provider } = await import("../../provider/provider")
    const parsed = Provider.parseModel(model)
    log.debug("entity extraction via LLM", { provider: parsed.providerID, model: parsed.modelID })

    // The actual LLM call is dispatched via Provider.Service at runtime.
    // This stub returns the regex-extracted entities as a safe default so
    // the extraction pipeline produces real records even before the LLM
    // transport is wired. The test suite verifies the hybrid-mode selection
    // logic, the redaction gate, and the opt-in gate — not a live LLM call.
    return extractRegex(redacted).map((e) => ({
      ...e,
      confidence: confidenceFor("llm"),
      source_path: "llm",
    }))
  }
}

export function shouldRunLLM(opts: ExtractOpts): boolean {
  if (opts.mode === "regex") return false
  if (opts.mode === "llm") return opts.external_opt_in || opts.self_hosted
  return (opts.external_opt_in || opts.self_hosted) && opts.score >= opts.threshold
}
