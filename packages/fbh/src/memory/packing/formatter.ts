import { Effect } from "effect"
import type { Packed } from "./schema"
import { AutoRecall, type MemoryResult } from "../recall"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.packing.formatter" })

// CN-15: stale_warning_days default. Matches AutoRecall.formatForInjection's
// default at recall.ts:38 so the MEMORY block stays byte-identical when
// delegated. Typed blocks (MESSAGE/ACTION/ERROR/PROCEDURE) reuse the same
// threshold so staleness warnings are consistent across all blocks (CP-13).
const STALE_DAYS = 1

function formatDate(ts: string): string {
  const n = Number(ts)
  if (isNaN(n) || n === 0) return "unknown"
  const d = new Date(n)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function daysAgo(ts: string): number {
  const n = Number(ts)
  if (isNaN(n) || n === 0) return 0
  return Math.floor((Date.now() - n) / 86400000)
}

function stale(days: number): boolean {
  return days > STALE_DAYS
}

function toMemoryResult(p: Packed): MemoryResult {
  return {
    id: p.id,
    content: p.content,
    persona: String(p.attributes.persona ?? ""),
    scope: String(p.attributes.scope ?? "general"),
    access_count: Number(p.attributes.access_count ?? 0),
    created_at: p.created_at,
    accessed_at: String(p.attributes.accessed_at ?? p.created_at),
    metadata: (p.attributes.metadata as Record<string, unknown>) ?? {},
    score: p.score,
    source: (p.source === "workforce" ? "workforce" : "local") as "local" | "workforce",
  }
}

/**
 * SDD-07 / Phase M-4 — TypedFormatter.
 *
 * format(items) produces typed blocks for the 5 packable active node types
 * (MEMORY, MESSAGE, ACTION, ERROR, PROCEDURE). ENTITY and the 7 reserved
 * types produce no block — ENTITY is filtered out by the packer before
 * formatting (CP-04b); reserved types are enum-only per CC-13.
 *
 * CP-11: MEMORY block delegates to AutoRecall.formatForInjection byte-for-byte.
 * CP-12: ACTION/ERROR/PROCEDURE blocks preserve [date, source] prefix +
 *   staleness suffix.
 * CP-12a: MESSAGE block — content, step, modality, agent_id, task_id.
 * CP-13: staleness warnings extend to all typed blocks, not just MEMORY.
 */
export namespace TypedFormatter {
  export function format(items: Packed[]): string {
    if (items.length === 0) return ""

    const memories = items.filter(i => i.node_type === "MEMORY")
    const messages = items.filter(i => i.node_type === "MESSAGE")
    const actions = items.filter(i => i.node_type === "ACTION")
    const errors = items.filter(i => i.node_type === "ERROR")
    const procedures = items.filter(i => i.node_type === "PROCEDURE")

    const blocks: string[] = []
    // CP-11: delegate MEMORY block to AutoRecall.formatForInjection.
    if (memories.length) blocks.push(AutoRecall.formatForInjection(memories.map(toMemoryResult)))
    // CP-12a: MESSAGE block.
    if (messages.length) blocks.push(formatMessages(messages))
    // CP-12: ACTION block.
    if (actions.length) blocks.push(formatActions(actions))
    // CP-12: ERROR block.
    if (errors.length) blocks.push(formatErrors(errors))
    // CP-12: PROCEDURE block.
    if (procedures.length) blocks.push(formatProcedures(procedures))

    return blocks.filter(Boolean).join("\n\n")
  }

  // CP-12a: MESSAGE block — content, step, modality, agent_id, task_id.
  function formatMessages(items: Packed[]): string {
    const lines = ["## Relevant Messages"]
    items.forEach((item, i) => {
      const days = daysAgo(item.created_at)
      const a = item.attributes
      let line = `${i + 1}. [${formatDate(item.created_at)}, ${item.source}] ${item.content} (step ${a.step}, ${a.modality}, agent ${a.agent_id}, task ${a.task_id})`
      // CP-13: staleness warning preserved across all typed blocks.
      if (stale(days)) line += ` (memory from ${days} days ago — verify before acting)`
      lines.push(line)
    })
    return lines.join("\n")
  }

  // CP-12: ACTION block — tool name, input/output summary, success, step.
  function formatActions(items: Packed[]): string {
    const lines = ["## Relevant Actions"]
    items.forEach((item, i) => {
      const days = daysAgo(item.created_at)
      const a = item.attributes
      let line = `${i + 1}. [${formatDate(item.created_at)}, ${item.source}] ${a.tool}: ${a.input} → ${a.output} (${a.success ? "ok" : "fail"}, step ${a.step})`
      if (stale(days)) line += ` (memory from ${days} days ago — verify before acting)`
      lines.push(line)
    })
    return lines.join("\n")
  }

  // CP-12: ERROR block — error type, description, severity, corrected.
  function formatErrors(items: Packed[]): string {
    const lines = ["## Relevant Errors"]
    items.forEach((item, i) => {
      const days = daysAgo(item.created_at)
      const a = item.attributes
      let line = `${i + 1}. [${formatDate(item.created_at)}, ${item.source}] ${a.error_type}: ${a.description} (severity ${a.severity}, ${a.corrected ? "corrected" : "uncorrected"})`
      if (stale(days)) line += ` (memory from ${days} days ago — verify before acting)`
      lines.push(line)
    })
    return lines.join("\n")
  }

  // CP-12: PROCEDURE block — name, steps count, success_rate, used_by_roles.
  function formatProcedures(items: Packed[]): string {
    const lines = ["## Relevant Procedures"]
    items.forEach((item, i) => {
      const days = daysAgo(item.created_at)
      const a = item.attributes
      let line = `${i + 1}. [${formatDate(item.created_at)}, ${item.source}] ${a.name}: ${a.steps_count} steps, success_rate ${a.success_rate}, used_by ${a.used_by_roles}`
      if (stale(days)) line += ` (memory from ${days} days ago — verify before acting)`
      lines.push(line)
    })
    return lines.join("\n")
  }
}
