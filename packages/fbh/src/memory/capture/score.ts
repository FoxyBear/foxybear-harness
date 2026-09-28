/**
 * SDD-05 / Phase M-2 W-11 — Turn extraction scoring.
 *
 * Deterministic per-turn score in [0.0, 1.0]:
 *   - 1.0 if the turn contains an ERROR or a MEMORY-worthy fact
 *         (matches DECISION/CONSTRAINT/PREFERENCE/CORRECTION patterns
 *         reused from extractFacts in consolidation.ts)
 *   - 0.5 if the turn contains a tool call with non-empty output > 200 chars
 *   - 0.0 otherwise
 *
 * Hybrid mode (W-10): turns scoring below threshold use the regex path;
 * turns at/above threshold use the LLM path (when external_opt_in = true).
 * The score is logged at debug level only.
 */
import type { MessageV2 } from "../../session/message-v2"

const DECISION_RE = /\blet'?s?\s+(?:go\s+with|use|pick|choose|stick\s+with)\s+/i
const CONSTRAINT_RE = /\b(.+?)\s+doesn'?t?\s+work\s+(?:because|since|due\s+to)\s+/i
const PREFERENCE_RE = /\bi\s+prefer\s+(.+?)(?:\s+over\s+(.+?))?(?:\.|$)/i
const CORRECTION_RE = /\bno[,.]?\s+actually\s+(.+?)(?:\.|$)/i

const FACT_RES = [DECISION_RE, CONSTRAINT_RE, PREFERENCE_RE, CORRECTION_RE]

export function score(turn: { withParts: MessageV2.WithParts[] }): number {
  let hasError = false
  let hasFact = false
  let hasLongToolOutput = false

  for (const msg of turn.withParts) {
    if (msg.info.role === "assistant" && msg.info.error) hasError = true
    for (const p of msg.parts) {
      if (p.type === "text") {
        for (const re of FACT_RES) {
          if (re.test(p.text)) {
            hasFact = true
            break
          }
        }
      }
      if (p.type === "tool") {
        if (p.state.status === "error") hasError = true
        if (p.state.status === "completed" && p.state.output.length > 200) {
          hasLongToolOutput = true
        }
      }
    }
  }

  if (hasError || hasFact) return 1.0
  if (hasLongToolOutput) return 0.5
  return 0.0
}
