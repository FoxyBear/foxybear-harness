/**
 * SDD-05 / Phase M-2 W-25 — Initial-confidence policy.
 *
 * Initial confidence is set by extraction-path provenance class:
 *   - 0.7 for nodes derived from deterministic paths
 *     (PROCEDURE from action chain detection, MEMORY from regex extractTurn)
 *   - 0.5 for nodes inferred by the extraction LLM
 *     (ENTITY from EntityExtractor, MEMORY from MemoryExtractor)
 *
 * The provenance class is recorded on the node's `source_path` field:
 *   - "tool" for deterministic
 *   - "llm"   for LLM-inferred
 *
 * Subsequent access events (M-3 lifecycle) and conflict evidence (M-5)
 * MAY adjust the confidence. This module only sets the initial value.
 */

export type Provenance = "tool" | "llm"

export const TOOL_CONFIDENCE = 0.7
export const LLM_CONFIDENCE = 0.5

// SDD-04 / Phase N W-21: initial confidence for the gate-extract-classify
// pipeline. Gemini extraction is deterministic-quality; the gate+classify
// chain is calibrated (100% recall, 0 false positives in the 150-turn
// spike). Distinct from TOOL_CONFIDENCE (which coincidentally equals 0.7
// but means "deterministic regex extraction"). Used with source_path = "llm".
export const CLASSIFY_CONFIDENCE = 0.7

export function confidenceFor(provenance: Provenance): number {
  return provenance === "tool" ? TOOL_CONFIDENCE : LLM_CONFIDENCE
}
