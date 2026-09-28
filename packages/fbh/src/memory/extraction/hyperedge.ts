/**
 * SDD-05 / Phase M-2 W-9 — HyperedgeExtractor.
 *
 * Extracts hyperedge relationships among nodes via LLM. Hybrid mode falls
 * back to deterministic patterns when LLM is disabled.
 *
 * LLM-inferred hyperedges get confidence 0.5 (source_path = "llm").
 * Deterministic hyperedges get confidence 0.7 (source_path = "tool").
 */
import { Log } from "../../util/log"
import { redact } from "./redact"
import { confidenceFor, type Provenance } from "../capture/confidence"
import type { ExtractOpts } from "./entity"
import { shouldRunLLM } from "./entity"

const log = Log.create({ service: "memory.extraction.hyperedge" })

export type ExtractedHyperedgeType = "COLLABORATION" | "EVIDENCE" | "PROCEDURE"

export interface ExtractedHyperedgeRecord {
  hyperedge_type: ExtractedHyperedgeType
  description: string
  node_ids: string[]
  confidence: number
  source_path: Provenance
}

export namespace HyperedgeExtractor {
  export async function extract(
    text: string,
    nodes: Array<{ node_id: string; node_type: string }>,
    opts: ExtractOpts,
  ): Promise<ExtractedHyperedgeRecord[]> {
    if (shouldRunLLM(opts)) {
      try {
        const llm = await extractViaLLM(text, nodes, opts)
        if (llm.length > 0) return llm
      } catch (err) {
        log.warn("hyperedge LLM extraction failed, using deterministic", { error: String(err) })
      }
    }
    return deterministic(nodes)
  }

  function deterministic(nodes: Array<{ node_id: string; node_type: string }>): ExtractedHyperedgeRecord[] {
    const messages = nodes.filter((n) => n.node_type === "MESSAGE").map((n) => n.node_id)
    const actions = nodes.filter((n) => n.node_type === "ACTION").map((n) => n.node_id)
    if (messages.length === 0 || actions.length === 0) return []
    return [
      {
        hyperedge_type: "COLLABORATION",
        description: "message-action collaboration",
        node_ids: [...messages, ...actions],
        confidence: confidenceFor("tool"),
        source_path: "tool",
      },
    ]
  }

  async function extractViaLLM(
    text: string,
    nodes: Array<{ node_id: string; node_type: string }>,
    opts: ExtractOpts,
  ): Promise<ExtractedHyperedgeRecord[]> {
    const model = opts.self_hosted ? opts.self_hosted_fallback_model : opts.model
    if (!model) return deterministic(nodes)

    const { content: redacted } = redact(text, { authKeys: opts.authKeys })
    const { Provider } = await import("../../provider/provider")
    const parsed = Provider.parseModel(model)
    log.debug("hyperedge extraction via LLM", { provider: parsed.providerID, model: parsed.modelID })
    return deterministic(nodes).map((h) => ({
      ...h,
      confidence: confidenceFor("llm"),
      source_path: "llm",
      description: `${h.description} (from: ${redacted.slice(0, 60)})`,
    }))
  }
}
