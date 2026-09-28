/**
 * SDD-03 / Phase M-1 — Hypergraph node + hyperedge type enums (CC-13 subsetting).
 *
 * 6 ACTIVE node types and 4 ACTIVE hyperedge types have producers, consumers,
 * Schema.Class definitions, and SurrealDB tables. The 7 + 3 RESERVED types are
 * union members only — forward-compat surface for future activation. A reserved
 * type activates only when a complete producer + consumer + metric row is
 * audited to the same standard as the active set (CC-13).
 *
 * Time units are epoch *seconds* (SC-2). Infinity is serialized as the sentinel
 * 99999999999 in SurrealDB; the TS-side schema keeps JS Infinity.
 */

// ── Node types ──

export const ACTIVE_NODE_TYPES = [
  "MEMORY",
  "ACTION",
  "ERROR",
  "MESSAGE",
  "ENTITY",
  "PROCEDURE",
] as const

export const RESERVED_NODE_TYPES = [
  "AGENT",
  "INSIGHT",
  "TASK",
  "MODALITY",
  "COMMUNITY",
  "ARCHETYPE",
  "META_PROCEDURE",
] as const

export const NodeTypeEnum = [...ACTIVE_NODE_TYPES, ...RESERVED_NODE_TYPES] as const

export type NodeType = (typeof NodeTypeEnum)[number]

export function isActiveNodeType(t: NodeType): boolean {
  return (ACTIVE_NODE_TYPES as readonly string[]).includes(t)
}

// ── Hyperedge types ──

export const ACTIVE_HYPEREDGE_TYPES = [
  "COLLABORATION",
  "ERROR_CORRECTION",
  "EVIDENCE",
  "PROCEDURE",
] as const

export const RESERVED_HYPEREDGE_TYPES = [
  "NARY_FACT",
  "COMMUNITY_REPORT",
  "GENERALIZES",
] as const

export const HyperedgeTypeEnum = [...ACTIVE_HYPEREDGE_TYPES, ...RESERVED_HYPEREDGE_TYPES] as const

export type HyperedgeType = (typeof HyperedgeTypeEnum)[number]

export function isActiveHyperedgeType(t: HyperedgeType): boolean {
  return (ACTIVE_HYPEREDGE_TYPES as readonly string[]).includes(t)
}

// ── Lifecycle ──

export const LifecycleStatusEnum = ["ACTIVE", "DEPRECATED", "ARCHIVED", "DELETED"] as const

export type LifecycleStatus = (typeof LifecycleStatusEnum)[number]

// ── Event types ──

export const EventTypeEnum = [
  "STORE",
  "UPDATE",
  "DELETE",
  "INVALIDATE",
  "GC_DELETED",
  "STATUS_TRANSITION",
  "SHADOW_METRIC",
] as const

export type EventType = (typeof EventTypeEnum)[number]

export const TargetTypeEnum = ["node", "hyperedge"] as const

export type TargetType = (typeof TargetTypeEnum)[number]
