import { Schema } from "effect"
import { BaseNode } from "./base"

/**
 * SDD-03 / Phase M-1 — 6 ACTIVE node Schema.Class exports (CC-13).
 *
 * Each active node type extends BaseNode with a type-specific `attributes`
 * struct. The 7 RESERVED types (Task, Agent, Insight, Modality, Community,
 * Archetype, MetaProcedure) are NOT exported as Schema.Class here — they are
 * union members in enums.ts only. Activating a reserved type requires a
 * complete producer + consumer + metric row audited to the same standard.
 *
 * The `node_type` field is locked per-class via Schema.Literal so the
 * SurrealHypergraphBackend.store() can rely on the schema to reject a
 * mismatched type without an extra runtime check.
 */

const Attributes = Schema.Record(Schema.String, Schema.Unknown)

export class MemoryNode extends Schema.Class<MemoryNode>("Hypergraph.Node.Memory")({
  ...BaseNode.fields,
  node_type: Schema.Literal("MEMORY"),
  attributes: Attributes,
}) {}

export class ActionNode extends Schema.Class<ActionNode>("Hypergraph.Node.Action")({
  ...BaseNode.fields,
  node_type: Schema.Literal("ACTION"),
  attributes: Attributes,
}) {}

export class ErrorNode extends Schema.Class<ErrorNode>("Hypergraph.Node.Error")({
  ...BaseNode.fields,
  node_type: Schema.Literal("ERROR"),
  attributes: Attributes,
}) {}

export class MessageNode extends Schema.Class<MessageNode>("Hypergraph.Node.Message")({
  ...BaseNode.fields,
  node_type: Schema.Literal("MESSAGE"),
  attributes: Attributes,
}) {}

export class EntityNode extends Schema.Class<EntityNode>("Hypergraph.Node.Entity")({
  ...BaseNode.fields,
  node_type: Schema.Literal("ENTITY"),
  attributes: Attributes,
}) {}

export class ProcedureNode extends Schema.Class<ProcedureNode>("Hypergraph.Node.Procedure")({
  ...BaseNode.fields,
  node_type: Schema.Literal("PROCEDURE"),
  attributes: Attributes,
}) {}

// Union of the 6 active node classes for type narrowing.
export const ActiveNode = Schema.Union([
  MemoryNode,
  ActionNode,
  ErrorNode,
  MessageNode,
  EntityNode,
  ProcedureNode,
])

export type ActiveNode = Schema.Schema.Type<typeof ActiveNode>
