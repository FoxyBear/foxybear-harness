/**
 * SDD-05 / Phase M-2 W-26 — CLI startup disclosure.
 *
 * When `memory.extraction.mode` is "hybrid" or "llm" AND
 * `memory.extraction.external_opt_in = true`, the CLI SHALL display a
 * startup message at session start indicating that background LLM
 * extraction is enabled and that session content is sent to the configured
 * external provider. The message SHALL be shown once per session startup
 * (not per turn) and SHALL include:
 *   - the provider name (parsed from memory.extraction.model via Provider.parseModel)
 *   - a reference to the data flow documentation
 *     (docs/specs/data-flow-extraction.md)
 *
 * When extraction is disabled (mode = "regex" OR external_opt_in = false
 * OR self_hosted = true with no external provider call), no
 * external-processing startup message SHALL be shown.
 *
 * The message is written to stderr so it does not pollute stdout for tooling.
 */
import { Provider } from "../provider/provider"
import type { ExtractionConfig } from "../memory/extraction/mode"
import { externalLLMEnabled } from "../memory/extraction/mode"

export const DATA_FLOW_DOC = "docs/specs/data-flow-extraction.md"

export function buildDisclosureMessage(cfg: ExtractionConfig): string | null {
  if (!externalLLMEnabled(cfg)) return null
  if (cfg.mode !== "hybrid" && cfg.mode !== "llm") return null
  const parsed = Provider.parseModel(cfg.model)
  const providerName = String(parsed.providerID).replace(/^./, (c) => c.toUpperCase())
  return `Memory extraction enabled: session content is sent to ${providerName} for LLM-driven extraction. See ${DATA_FLOW_DOC} for data classes.`
}

export function printDisclosure(cfg: ExtractionConfig): void {
  const msg = buildDisclosureMessage(cfg)
  if (msg) console.error(msg)
}
