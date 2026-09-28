import { Effect } from "effect"
import { getGlobalHypergraphBackend } from "../backend-registry"
import type { Packed } from "./schema"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.packing.tracker" })

/**
 * SDD-07 / Phase M-4 — Provenance tracking.
 *
 * track(sessionID, items): records the injected item IDs keyed by sessionID
 * in a session-scoped Map (CP-15). Precedent: sessionMemoryStore at
 * compaction.ts:69.
 *
 * feedback(sessionID, ok, project_id): if ok, increments usage_count and
 * updates last_used on each tracked node directly via the hypergraph
 * backend's incrementUsage helper (CP-16). The SDD-06 decay formula reads
 * usage_count (as access(t)) on its next hourly tick — the rehearsal boost
 * happens naturally in decay. NO standalone rehearse method exists or is
 * needed (B1 fix — all lifecycle rehearsal calls were removed). When
 * the turn fails, feedback does NOT increment anything.
 *
 * After feedback (success or failure), the store entry for the session is
 * cleared so the next turn starts fresh.
 */

export namespace ProvenanceTracker {
  // CP-15: session-scoped Map<sessionID, Packed[]>.
  const store = new Map<string, Packed[]>()

  export function track(sessionID: string, items: Packed[]): void {
    store.set(sessionID, items)
  }

  // CP-16: feedback increments usage_count + last_used directly on the node
  // via the hypergraph backend. NO rehearse method (B1 fix).
  export const feedback = Effect.fn("ProvenanceTracker.feedback")(function* (
    sessionID: string,
    ok: boolean,
    project_id: string,
  ) {
    void project_id
    if (!ok) {
      // CP-16: turn failed — do NOT increment anything. Still clear the store
      // so the next turn starts fresh.
      store.delete(sessionID)
      return
    }
    const items = store.get(sessionID) ?? []
    const now = Math.floor(Date.now() / 1000)
    const backend = getGlobalHypergraphBackend()
    if (!backend) {
      store.delete(sessionID)
      return
    }
    for (const item of items) {
      try {
        // Fetch node, increment usage_count, set last_used = now, write back.
        // The backend's incrementUsage helper does the fetch + increment in
        // two SurrealDB UPDATEs (MERGE for last_used, SET for usage_count).
        yield* Effect.promise(() => backend.incrementUsage(item.id, now))
      } catch (err) {
        log.warn("feedback: usage_count increment failed", { id: item.id, error: String(err) })
      }
    }
    // CP-16: clear the store for this session after feedback.
    store.delete(sessionID)
  })

  /** Test-only: peek at the tracked items for a session. */
  export function _peek(sessionID: string): Packed[] | null {
    return store.get(sessionID) ?? null
  }
}
