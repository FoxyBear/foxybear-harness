/**
 * SDD-06 / Phase M-3 — Prune (wraps Consolidation.prune).
 *
 * Delegates to the existing Consolidation.prune at consolidation.ts:445.
 * This gives Consolidation.prune its first real call site (CC-2 — the
 * memory-ttl-pruning scheduler task previously inlined Memory.getPrunable
 * + Memory.forget and did NOT call Consolidation.prune).
 *
 * The 200-entry cap (MAX_INDEX_ENTRIES), near-dup merge (cosine > 0.95),
 * and TTL prune (Memory.getPrunable) all stay as-is — wrapped, not
 * rewritten (CC-2).
 */
import { Consolidation } from "../consolidation"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.lifecycle.prune" })

export interface PruneResult {
  pruned: number
  nearDupsMerged: number
  indexRemoved: number
}

/**
 * prune(persona?) — delegate to Consolidation.prune.
 *
 * Returns the { pruned, nearDupsMerged, indexRemoved } shape from
 * Consolidation.prune.
 */
export async function prune(persona = "default"): Promise<PruneResult> {
  const result = await Consolidation.prune({ persona })
  log.info("prune complete", result)
  return result
}
