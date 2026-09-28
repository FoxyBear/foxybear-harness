import { Context } from "effect"
import type { NodeType } from "../schema/enums"

/**
 * SDD-07 / Phase M-4 — Context packing types (SC-5, CC-13).
 *
 * Packed: a single node packed into the context window. node_type is one of
 * the 6 active types (MEMORY, ACTION, ERROR, MESSAGE, PROCEDURE, ENTITY per
 * SC-1). ENTITY is expansion-input only (CP-04b) — it seeds Hypergraph.query
 * but is filtered out before formatting and never appears in
 * PackedContext.items. The 7 reserved types (TASK, AGENT, INSIGHT, MODALITY,
 * COMMUNITY, ARCHETYPE, META_PROCEDURE) are enum-only — no packing path.
 *
 * PackedContext: the result of pack() — formatted text + items + token count.
 *
 * SessionContext: the session context (sessionID + persona) provided to pack
 * via the Session service (Context.Tag) using Effect.provideService.
 */

export interface Packed {
  id: string
  node_type: NodeType
  content: string
  source: string
  created_at: string
  score: number
  attributes: Record<string, unknown>
}

export interface PackedContext {
  text: string
  items: Packed[]
  tokens: number
}

export interface SessionContext {
  sessionID: string
  persona: string
}

// Session service — required (no default). Provided by the wire-up via
// Effect.provideService(Session, { sessionID, persona }). pack fails with a
// clear error if Session is not provided (CP-02a). In Effect 4.0 the service
// key is created via Context.Service<Shape>(identifier); yielding the
// Service directly (yield* Session) resolves the SessionContext from the
// surrounding Effect context.
export const Session = Context.Service<SessionContext>("@foxybear/ContextPacker/Session")

// Expansion mode — default "hypergraph" (requires probe PASSED per CP-00).
// "one_hop" = A3 fallback (Arm 2, vector + 1-hop via SurrealBackend.query).
// "top_k" = A6 fallback (Arm 1, vector seeds only, no expansion).
export type ExpansionMode = "hypergraph" | "one_hop" | "top_k"
