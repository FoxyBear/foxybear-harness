/**
 * SDD-06 / Phase M-3 — Soft-delete (invalidated_by + INVALIDATE event).
 *
 * Per req 6: when a node is soft-deleted (via memory_forget tool, conflict
 * detection in SDD-09, or any explicit forget call), the system SHALL:
 *   - set tx_to = now (close the transaction interval)
 *   - set status = DELETED
 *   - set invalidated_by to the ID of the node that caused the invalidation
 *     (SC-2 back-pointer field, or null if user-initiated)
 *   - append an INVALIDATE event to the event table (SC-9)
 *
 * The type INVALIDATES is not defined per SC-3/SC-4 (the 4 active + 3
 * reserved types do not include it) — no hyperedge is created.
 * The node record SHALL be preserved (no hard-delete). A subsequent
 * is_live(now) query SHALL return false for the deleted node.
 *
 * When the deletion is caused by a contradicting node (req 8), the caller
 * SHALL also increment contradiction_count on the contradicting node.
 */
import { getGlobalHypergraphBackend } from "../backend-registry"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.lifecycle.invalidate" })

export interface InvalidateInput {
  node_id: string
  invalidated_by: string | null
  now?: number
}

export interface InvalidateResult {
  invalidated: boolean
}

/**
 * soft_delete(input) — soft-delete a node per req 6.
 *
 * Sets tx_to = now, status = DELETED, invalidated_by on the node record,
 * and appends an INVALIDATE event to the event table. The INVALIDATES
 * type is not a hyperedge (SC-3, SC-4) — no edge is created. The node
 * record is preserved (no hard-delete); is_live(now) returns false for
 * the deleted node thereafter.
 */
export async function soft_delete(input: InvalidateInput): Promise<InvalidateResult> {
  const backend = getGlobalHypergraphBackend()
  if (!backend) return { invalidated: false }

  const now = input.now ?? Math.floor(Date.now() / 1000)

  // Close tx_to + set status=DELETED + set invalidated_by. No edge created.
  await backend.softDelete(input.node_id, input.invalidated_by, now)

  // Append the INVALIDATE event (SC-9). The INVALIDATES type is not an edge.
  await backend.appendEvent({
    event_type: "INVALIDATE",
    target_id: input.node_id,
    target_type: "node",
    agent_id: input.invalidated_by,
    payload: { invalidated_by: input.invalidated_by, at: now },
  })

  log.info("soft-delete complete", { node_id: input.node_id, invalidated_by: input.invalidated_by })
  return { invalidated: true }
}
