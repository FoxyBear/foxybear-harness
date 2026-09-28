import { Schema } from "effect"
import { NodeTypeEnum, HyperedgeTypeEnum, LifecycleStatusEnum } from "./enums"

/**
 * SDD-03 / Phase M-1 — BaseNode + BaseHyperedge (SC-2 / SC-4).
 *
 * Bi-temporal model:
 *  - valid_from / valid_to bound when a fact is believed to be true in the
 *    world. valid_to = Infinity means "currently believed".
 *  - tx_from / tx_to Bound when the system asserts that fact. tx_to = Infinity
 *    means "not retracted".
 *  - prev_version_id Points at the prior node in the version chain (SUPERSEDES).
 *  - invalidated_by Records the agent/edge that contradicted this node.
 *
 * All fields are snake_case to match the SurrealDB column names (SC-9, CC-9).
 * Time fields are epoch *seconds*. Infinity is serialized as sentinel
 * 99999999999 in SurrealDB; the TS-side schema uses JS Infinity.
 */

// Embeddings are Float32Array in TS but serialize as number[] in SurrealDB.
// The schema accepts either null or a number array (the SurrealDB wire form).
const Embedding = Schema.Union([Schema.Null, Schema.Array(Schema.Number)])

const Attributes = Schema.Record(Schema.String, Schema.Unknown)

const NodeIdentifier = Schema.String

const HyperedgeIdentifier = Schema.String

const NodeIds = Schema.Array(Schema.String)

const SourceNodes = Schema.Array(Schema.String)

const OptionalString = Schema.Union([Schema.String, Schema.Null])

export class BaseNode extends Schema.Class<BaseNode>("Hypergraph.BaseNode")({
  node_id: NodeIdentifier,
  node_type: Schema.Literals(NodeTypeEnum),
  created_at: Schema.Number,
  updated_at: Schema.Number,
  version: Schema.Number,
  status: Schema.Literals(LifecycleStatusEnum),
  embedding: Embedding,
  attributes: Attributes,
  valid_from: Schema.Number,
  valid_to: Schema.Number,
  tx_from: Schema.Number,
  tx_to: Schema.Number,
  prev_version_id: OptionalString,
  invalidated_by: OptionalString,
}) {}

export class BaseHyperedge extends Schema.Class<BaseHyperedge>("Hypergraph.BaseHyperedge")({
  hyperedge_id: HyperedgeIdentifier,
  hyperedge_type: Schema.Literals(HyperedgeTypeEnum),
  description: Schema.String,
  node_ids: NodeIds,
  confidence: Schema.Number,
  source_nodes: SourceNodes,
  embedding: Embedding,
  attributes: Attributes,
  valid_from: Schema.Number,
  valid_to: Schema.Number,
  tx_from: Schema.Number,
  tx_to: Schema.Number,
  prev_version_id: OptionalString,
  invalidated_by: OptionalString,
  status: Schema.Literals(LifecycleStatusEnum),
}) {}

export type BiTemporal = Pick<
  BaseNode,
  "valid_from" | "valid_to" | "tx_from" | "tx_to" | "status"
>
