/**
 * SDD-05 / Phase M-2 W-16 — ContextWeaver-style dependency chain detector.
 *
 * When TraceIngestor.ingest emits an ACTION whose input references a prior
 * ACTION's output (substring match of the prior output's first 200 chars in
 * the new input, or an explicit PartID reference), it emits a NARY_FACT
 * hyperedge linking the two ACTION nodes. The hyperedge's description is
 * "action <step N> relied on action <step M> output".
 *
 * Note: NARY_FACT is a RESERVED hyperedge type per CC-13 — it is enum-only,
 * with no SurrealDB table. The dependency chain is recorded as an in-memory
 * map on the TraceIngestor (consumed by procedure.ts for PROCEDURE detection
 * and surfaced to M-4 context packing via the capture API). The map is NOT
 * written to the hyperedge table (which would be rejected by
 * SurrealHypergraphBackend.edge per CC-13 enforcement).
 */
import type { MessageV2 } from "../../session/message-v2"

export interface DependencyLink {
  from: string
  to: string
  description: string
}

export interface ActionRecord {
  node_id: string
  step: number
  action_type: string
  input: string
  output: string
  success: boolean
}

const PREFIX_LEN = 200

export function detect(actions: ActionRecord[]): DependencyLink[] {
  const links: DependencyLink[] = []
  for (let i = 0; i < actions.length; i++) {
    const cur = actions[i]!
    if (!cur.input) continue
    for (let j = 0; j < i; j++) {
      const prev = actions[j]!
      if (!prev.output) continue
      const prefix = prev.output.slice(0, PREFIX_LEN)
      if (prefix && cur.input.includes(prefix)) {
        links.push({
          from: cur.node_id,
          to: prev.node_id,
          description: `action step ${cur.step} relied on action step ${prev.step} output`,
        })
      }
    }
  }
  return links
}

export function fromParts(parts: MessageV2.Part[]): string[] {
  const refs: string[] = []
  for (const p of parts) {
    if (p.type === "tool" && p.state.status === "completed") {
      const meta = p.state.metadata as Record<string, unknown> | undefined
      const ref = meta?.part_ref
      if (typeof ref === "string") refs.push(ref)
    }
  }
  return refs
}
