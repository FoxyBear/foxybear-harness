import { Schema } from "effect"
import { BaseHyperedge } from "./base"

/**
 * SDD-03 / Phase M-1 — 4 ACTIVE hyperedge Schema.Class exports (CC-13).
 *
 * Each active hyperedge type extends BaseHyperedge with type-specific fields.
 * The 3 RESERVED hyperedge types (NaryFact, CommunityReport, Generalizes) are
 * NOT exported as Schema.Class — they are union members in enums.ts only.
 */

const Attributes = Schema.Record(Schema.String, Schema.Unknown)

export class CollaborationHyperedge extends Schema.Class<CollaborationHyperedge>(
  "Hypergraph.Edge.Collaboration",
)({
  ...BaseHyperedge.fields,
  hyperedge_type: Schema.Literal("COLLABORATION"),
  attributes: Attributes,
}) {}

export class ErrorCorrectionHyperedge extends Schema.Class<ErrorCorrectionHyperedge>(
  "Hypergraph.Edge.ErrorCorrection",
)({
  ...BaseHyperedge.fields,
  hyperedge_type: Schema.Literal("ERROR_CORRECTION"),
  attributes: Attributes,
}) {}

export class EvidenceHyperedge extends Schema.Class<EvidenceHyperedge>(
  "Hypergraph.Edge.Evidence",
)({
  ...BaseHyperedge.fields,
  hyperedge_type: Schema.Literal("EVIDENCE"),
  attributes: Attributes,
}) {}

export class ProcedureHyperedge extends Schema.Class<ProcedureHyperedge>(
  "Hypergraph.Edge.Procedure",
)({
  ...BaseHyperedge.fields,
  hyperedge_type: Schema.Literal("PROCEDURE"),
  attributes: Attributes,
}) {}

export const ActiveHyperedge = Schema.Union([
  CollaborationHyperedge,
  ErrorCorrectionHyperedge,
  EvidenceHyperedge,
  ProcedureHyperedge,
])

export type ActiveHyperedge = Schema.Schema.Type<typeof ActiveHyperedge>
