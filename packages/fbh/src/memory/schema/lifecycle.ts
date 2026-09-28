import type { LifecycleStatus } from "./enums"

/**
 * SDD-03 / Phase M-1 — Bi-temporal is_live filter (SC-2).
 *
 * A node or hyperedge is "live" at time `now` (epoch seconds) iff:
 *  - tx_to is open (Infinity sentinel or in the future), AND
 *  - valid_to is open (Infinity sentinel or in the future), AND
 *  - status is not DELETED.
 *
 * Works for both BaseNode and BaseHyperedge since they share the bi-temporal
 * fields. The 99999999999 sentinel is the SurrealDB serialization of Infinity
 * (SC-2: JSON.stringify(Infinity) returns null otherwise).
 */

export interface BiTemporalLike {
  tx_to: number
  valid_to: number
  status: LifecycleStatus
}

const SENTINEL = 99999999999

export function is_live<T extends BiTemporalLike>(entity: T, now: number): boolean {
  const txOpen = entity.tx_to === Infinity || entity.tx_to === SENTINEL || entity.tx_to > now
  const validOpen = entity.valid_to === Infinity || entity.valid_to === SENTINEL || entity.valid_to > now
  const notDeleted = entity.status !== "DELETED"
  return txOpen && validOpen && notDeleted
}
