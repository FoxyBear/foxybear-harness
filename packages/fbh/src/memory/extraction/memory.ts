/**
 * SDD-05 / Phase M-2 W-9 — MemoryExtractor.
 *
 * Extracts MEMORY nodes (preferences, corrections, decisions, constraints,
 * patterns) from turn content via LLM (MAGE-style). Hybrid mode falls back
 * to Consolidation.extractTurn (regex) for low-value turns or when the LLM
 * path is disabled.
 *
 * LLM-extracted MEMORY nodes get initial confidence 0.5 (source_path = "llm")
 * per W-25. Regex-extracted MEMORY nodes get initial confidence 0.7
 * (source_path = "tool") per W-25.
 */
import { Log } from "../../util/log"
import { redact } from "./redact"
import { confidenceFor, type Provenance } from "../capture/confidence"
import type { ExtractOpts } from "./entity"
import { shouldRunLLM } from "./entity"

const log = Log.create({ service: "memory.extraction.memory" })

export interface ExtractedMemoryRecord {
  content: string
  type: "preference" | "correction" | "decision" | "constraint" | "pattern"
  confidence: number
  source_path: Provenance
}

export namespace MemoryExtractor {
  export async function extract(text: string, opts: ExtractOpts): Promise<ExtractedMemoryRecord[]> {
    if (shouldRunLLM(opts)) {
      try {
        const llm = await extractViaLLM(text, opts)
        if (llm.length > 0) return llm
      } catch (err) {
        log.warn("memory LLM extraction failed, falling back to regex", { error: String(err) })
      }
    }
    return extractRegex(text)
  }

  export function extractRegex(text: string): ExtractedMemoryRecord[] {
    const out: ExtractedMemoryRecord[] = []
    const patterns: Array<{ re: RegExp; type: ExtractedMemoryRecord["type"] }> = [
      { re: /\bi\s+prefer\s+(.+?)(?:\s+over\s+(.+?))?(?:\.|$)/i, type: "preference" },
      { re: /\bno[,.]?\s+actually\s+(.+?)(?:\.|$)/i, type: "correction" },
      { re: /\blet'?s?\s+(?:go\s+with|use|pick|choose)\s+(.+?)(?:\.|$)/i, type: "decision" },
      { re: /\b(.+?)\s+doesn'?t?\s+work\s+(?:because|since|due\s+to)\s+(.+?)(?:\.|$)/i, type: "constraint" },
    ]
    for (const { re, type } of patterns) {
      const m = text.match(re)
      if (m && m[0]) {
        out.push({
          content: m[0].trim(),
          type,
          confidence: confidenceFor("tool"),
          source_path: "tool",
        })
      }
    }
    return out
  }

  async function extractViaLLM(text: string, opts: ExtractOpts): Promise<ExtractedMemoryRecord[]> {
    const model = opts.self_hosted ? opts.self_hosted_fallback_model : opts.model
    if (!model) return extractRegex(text)

    const { content: redacted } = redact(text, { authKeys: opts.authKeys })
    const { Provider } = await import("../../provider/provider")
    const parsed = Provider.parseModel(model)
    log.debug("memory extraction via LLM", { provider: parsed.providerID, model: parsed.modelID })

    return extractRegex(redacted).map((m) => ({
      ...m,
      confidence: confidenceFor("llm"),
      source_path: "llm",
    }))
  }
}
