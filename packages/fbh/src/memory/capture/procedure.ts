/**
 * SDD-05 / Phase M-2 W-17 — Procedure node emitter.
 *
 * When TraceIngestor.ingest detects a chain of 3+ ACTION nodes linked by
 * W-16 dependency edges with the same action_type and all success = true,
 * it emits one PROCEDURE node + one PROCEDURE hyperedge linking the
 * PROCEDURE node to all ACTION nodes in the chain.
 *
 * PROCEDURE.confidence = 0.7 (tool-output provenance per W-25),
 * source_path = "tool", success_rate = 1.0 (initially), used_by_roles =
 * [agent_id], name = action_type, steps = [action_id, ...].
 */
import type { ActionRecord, DependencyLink } from "./dependency"
import type { Provenance } from "./confidence"
import { TOOL_CONFIDENCE } from "./confidence"

export interface ProcedureRecord {
  name: string
  steps: string[]
  success_rate: number
  used_by_roles: string[]
  confidence: number
  source_path: Provenance
}

const MIN_CHAIN = 3

export function detect(
  actions: ActionRecord[],
  deps: DependencyLink[],
): ProcedureRecord[] {
  const byType = new Map<string, ActionRecord[]>()
  for (const a of actions) {
    if (!a.success) continue
    const arr = byType.get(a.action_type) ?? []
    arr.push(a)
    byType.set(a.action_type, arr)
  }

  const adj = new Map<string, Set<string>>()
  for (const d of deps) {
    const s = adj.get(d.from) ?? new Set<string>()
    s.add(d.to)
    adj.set(d.from, s)
  }

  const procedures: ProcedureRecord[] = []
  for (const [actionType, acts] of byType) {
    if (acts.length < MIN_CHAIN) continue
    const sorted = [...acts].sort((a, b) => a.step - b.step)
    const linked = sorted.filter((a) => adj.has(a.node_id) || [...adj.values()].some((s) => s.has(a.node_id)))
    if (linked.length < MIN_CHAIN) continue
    const roles = Array.from(new Set(acts.map((a) => a.action_type)))
    procedures.push({
      name: actionType,
      steps: linked.map((a) => a.node_id),
      success_rate: 1.0,
      used_by_roles: roles,
      confidence: TOOL_CONFIDENCE,
      source_path: "tool",
    })
  }
  return procedures
}
