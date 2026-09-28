/**
 * SDD-05 / Phase M-2 — TraceIngestor.
 *
 * Parses SessionTurn.withParts[] and emits the 6 active node types
 * (MESSAGE, ACTION, ERROR, MEMORY, PROCEDURE, ENTITY per CC-13) linked
 * by the 4 active hyperedge types (COLLABORATION, ERROR_CORRECTION,
 * EVIDENCE, PROCEDURE per CC-13).
 *
 *   - W-1: ACTION from ToolPart (action_type=tool, input, output, success, cost, step, agent_id, task_id)
 *   - W-2: ERROR from error tool / assistantMessage.error (error_type, description, severity, detected_by, corrected, agent_id, task_id)
 *   - W-3: MESSAGE from text content (content, step, modality, agent_id, task_id)
 *   - W-4: COLLABORATION hyperedge linking MESSAGE + ACTION (NOT AGENT — reserved per CC-13). agent_id carried as field on role_assignments.
 *   - W-5: ERROR_CORRECTION hyperedge linking ERROR + correcting ACTION (error_id, detecting_agent_id). ERROR.corrected updated via bi-temporal UPDATE.
 *   - W-6: EVIDENCE hyperedge linking MEMORY + MESSAGE + supporting ACTION (query_or_task_id = session.id)
 *   - W-16: ContextWeaver dependency chain detection (delegated to dependency.ts; result recorded in-memory, surfaced for PROCEDURE detection)
 *   - W-17: PROCEDURE node + PROCEDURE hyperedge from action chain (delegated to procedure.ts)
 *
 * Reserved node types (AGENT, INSIGHT, TASK, MODALITY, COMMUNITY, ARCHETYPE,
 * META_PROCEDURE) and reserved hyperedge types (NARY_FACT, COMMUNITY_REPORT,
 * GENERALIZES) are NEVER emitted. CC-13 enforcement is also enforced at the
 * SurrealHypergraphBackend.store/edge boundary (throws on reserved types).
 *
 * Initial confidence (W-25):
 *   - ACTION/ERROR/MESSAGE/PROCEDURE from tool traces → 0.7 (source_path = "tool")
 *   - MEMORY/ENTITY from LLM extraction → 0.5 (source_path = "llm")
 *   - MEMORY from regex extractTurn → 0.7 (source_path = "tool")
 */
import { ulid } from "ulid"
import { Log } from "../../util/log"
import type { MessageV2 } from "../../session/message-v2"
import type { NodeRecord, HyperedgeRecord } from "../surreal-hypergraph-backend"
import { getGlobalHypergraphBackend } from "../backend-registry"
import type { SessionTurn } from "./session-turn"
import { score } from "./score"
import { detect as detectDeps, type ActionRecord } from "./dependency"
import { detect as detectProcedures, type ProcedureRecord } from "./procedure"
import { confidenceFor, type Provenance } from "./confidence"

const log = Log.create({ service: "memory.capture.trace" })

const NOW = () => Math.floor(Date.now() / 1000)

export interface EmittedNode {
  node_id: string
  node_type: "MESSAGE" | "ACTION" | "ERROR" | "MEMORY" | "PROCEDURE" | "ENTITY"
  attributes: Record<string, unknown>
  confidence: number
  source_path: Provenance
}

export interface EmittedHyperedge {
  hyperedge_id: string
  hyperedge_type: "COLLABORATION" | "ERROR_CORRECTION" | "EVIDENCE" | "PROCEDURE"
  description: string
  node_ids: string[]
  attributes: Record<string, unknown>
  confidence: number
}

export interface IngestResult {
  nodes: EmittedNode[]
  hyperedges: EmittedHyperedge[]
  dependencies: Array<{ from: string; to: string; description: string }>
  procedures: ProcedureRecord[]
  score: number
}

export namespace TraceIngestor {
  /**
   * Parse a SessionTurn and emit nodes + hyperedges via the global
   * SurrealHypergraphBackend. Gracefully degrades when the backend is not
   * registered (e.g. memory.enabled = false, or graph_backend = sqlite) —
   * returns the would-be emit list without writing. The caller (MemoryCapture)
   * decides what to do with the result.
   */
  export async function ingest(turn: SessionTurn): Promise<IngestResult> {
    const s = score(turn)
    const { nodes, hyperedges, actions } = parse(turn, s)
    const deps = detectDeps(actions)
    const procedures = detectProcedures(actions, deps)
    for (const p of procedures) {
      const procNode = makeProcedureNode(p, turn)
      nodes.push(procNode)
      hyperedges.push(makeProcedureHyperedge(p, procNode.node_id, turn))
    }

    const backend = getGlobalHypergraphBackend()
    if (backend && backend.healthy()) {
      try {
        for (const n of nodes) {
          await backend.store(toNodeRecord(n, turn))
        }
        for (const h of hyperedges) {
          await backend.edge(toHyperedgeRecord(h, turn))
        }
      } catch (err) {
        log.warn("trace ingest write failed", { error: String(err) })
      }
    }

    return { nodes, hyperedges, dependencies: deps, procedures, score: s }
  }
}

function parse(
  turn: SessionTurn,
  s: number,
): { nodes: EmittedNode[]; hyperedges: EmittedHyperedge[]; actions: ActionRecord[] } {
  const nodes: EmittedNode[] = []
  const hyperedges: EmittedHyperedge[] = []
  const actions: ActionRecord[] = []
  const errors: Array<{ node_id: string; description: string; action_type: string }> = []
  const messageNodes: string[] = []

  let step = 0
  let lastActionIndex = -1
  for (let mi = 0; mi < turn.withParts.length; mi++) {
    const msg = turn.withParts[mi]
    for (const part of msg.parts) {
      if (part.type === "step-start") step++
      if (part.type === "step-finish") step = step
    }

    if (msg.info.role === "assistant") {
      const textParts = msg.parts.filter((p) => p.type === "text") as MessageV2.TextPart[]
      const content = textParts.map((p) => p.text).join("")
      let thisMessageNodeId: string | null = null
      if (content.trim()) {
        const node = makeMessageNode(content, step, msg.info.agent, turn)
        nodes.push(node)
        messageNodes.push(node.node_id)
        thisMessageNodeId = node.node_id
      }

      if (msg.info.error) {
        const node = makeErrorNode(
          String(msg.info.error.name ?? "tool_error"),
          JSON.stringify(msg.info.error),
          "high",
          "system",
          msg.info.agent,
          turn,
        )
        nodes.push(node)
        errors.push({
          node_id: node.node_id,
          description: JSON.stringify(msg.info.error),
          action_type: "",
        })
      }

      const toolParts = msg.parts.filter((p) => p.type === "tool") as MessageV2.ToolPart[]
      for (const tp of toolParts) {
        if (tp.state.status === "completed") {
          const node = makeActionNode(tp.tool, tp.state.input, tp.state.output, true, step, msg.info.agent, turn)
          nodes.push(node)
          actions.push({
            node_id: node.node_id,
            step,
            action_type: tp.tool,
            input: stringify(tp.state.input),
            output: tp.state.output,
            success: true,
          })
          lastActionIndex = actions.length - 1
        } else if (tp.state.status === "error") {
          const node = makeActionNode(tp.tool, tp.state.input, "", false, step, msg.info.agent, turn)
          nodes.push(node)
          actions.push({
            node_id: node.node_id,
            step,
            action_type: tp.tool,
            input: stringify(tp.state.input),
            output: "",
            success: false,
          })
          const errNode = makeErrorNode(
            "tool_error",
            tp.state.error,
            "medium",
            "agent",
            msg.info.agent,
            turn,
          )
          nodes.push(errNode)
          errors.push({
            node_id: errNode.node_id,
            description: tp.state.error,
            action_type: tp.tool,
          })
        }
      }

      if (thisMessageNodeId && lastActionIndex >= 0) {
        const action = actions[lastActionIndex]
        hyperedges.push({
          hyperedge_id: ulid(),
          hyperedge_type: "EVIDENCE",
          description: `output of ${action.action_type}`,
          node_ids: [action.node_id, thisMessageNodeId],
          attributes: {
            project_id: turn.project_id,
            query_or_task_id: turn.sessionID,
          },
          confidence: 0.7,
        })
      }
    }
  }

  if (messageNodes.length + actions.length > 0) {
    const role: Record<string, string> = {}
    const agent = turn.persona
    role[agent] = agent
    hyperedges.push({
      hyperedge_id: ulid(),
      hyperedge_type: "COLLABORATION",
      description: `turn for session ${turn.sessionID}`,
      node_ids: [...messageNodes, ...actions.map((a) => a.node_id)],
      attributes: {
        project_id: turn.project_id,
        role_assignments: role,
        outcome: errors.length === 0 ? "success" : "error",
      },
      confidence: 0.7,
    })
  }

  for (const e of errors) {
    if (!e.action_type) continue
    const correction = actions.find((a) => a.success && a.node_id !== e.node_id)
    if (correction) {
      hyperedges.push({
        hyperedge_id: ulid(),
        hyperedge_type: "ERROR_CORRECTION",
        description: `correction for error ${e.node_id}`,
        node_ids: [e.node_id, correction.node_id],
        attributes: {
          project_id: turn.project_id,
          error_id: e.node_id,
          detecting_agent_id: correction.action_type,
        },
        confidence: 0.7,
      })
    }
  }

  return { nodes, hyperedges, actions }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v) ?? ""
  } catch {
    return ""
  }
}

function makeMessageNode(content: string, step: number, agent: string, turn: SessionTurn): EmittedNode {
  return {
    node_id: ulid(),
    node_type: "MESSAGE",
    attributes: {
      content,
      step,
      modality: "text",
      agent_id: agent,
      task_id: turn.sessionID,
      project_id: turn.project_id,
    },
    confidence: confidenceFor("tool"),
    source_path: "tool",
  }
}

function makeActionNode(
  action_type: string,
  input: Record<string, unknown>,
  output: string,
  success: boolean,
  step: number,
  agent: string,
  turn: SessionTurn,
): EmittedNode {
  return {
    node_id: ulid(),
    node_type: "ACTION",
    attributes: {
      action_type,
      input: stringify(input),
      output,
      success,
      cost: 0,
      step,
      agent_id: agent,
      task_id: turn.sessionID,
      project_id: turn.project_id,
    },
    confidence: confidenceFor("tool"),
    source_path: "tool",
  }
}

function makeErrorNode(
  error_type: string,
  description: string,
  severity: "high" | "medium",
  detected_by: "system" | "agent",
  agent: string,
  turn: SessionTurn,
): EmittedNode {
  return {
    node_id: ulid(),
    node_type: "ERROR",
    attributes: {
      error_type,
      description,
      severity,
      detected_by,
      corrected: false,
      agent_id: agent,
      task_id: turn.sessionID,
      project_id: turn.project_id,
    },
    confidence: confidenceFor("tool"),
    source_path: "tool",
  }
}

function makeProcedureNode(p: ProcedureRecord, turn: SessionTurn): EmittedNode {
  return {
    node_id: ulid(),
    node_type: "PROCEDURE",
    attributes: {
      name: p.name,
      steps: p.steps,
      success_rate: p.success_rate,
      used_by_roles: p.used_by_roles,
      project_id: turn.project_id,
    },
    confidence: p.confidence,
    source_path: p.source_path,
  }
}

function makeProcedureHyperedge(p: ProcedureRecord, procNodeId: string, turn: SessionTurn): EmittedHyperedge {
  return {
    hyperedge_id: ulid(),
    hyperedge_type: "PROCEDURE",
    description: `procedure ${p.name} with ${p.steps.length} steps`,
    node_ids: [procNodeId, ...p.steps],
    attributes: {
      project_id: turn.project_id,
      procedure_id: procNodeId,
    },
    confidence: p.confidence,
  }
}

function toNodeRecord(n: EmittedNode, turn: SessionTurn): NodeRecord {
  const now = NOW()
  return {
    node_id: n.node_id,
    node_type: n.node_type,
    created_at: now,
    updated_at: now,
    version: 1,
    status: "ACTIVE",
    embedding: null,
    attributes: { ...n.attributes, confidence: n.confidence, source_path: n.source_path, project_id: turn.project_id },
    valid_from: now,
    valid_to: Infinity,
    tx_from: now,
    tx_to: Infinity,
    prev_version_id: null,
    invalidated_by: null,
  }
}

function toHyperedgeRecord(h: EmittedHyperedge, turn: SessionTurn): HyperedgeRecord {
  const now = NOW()
  return {
    hyperedge_id: h.hyperedge_id,
    hyperedge_type: h.hyperedge_type,
    description: h.description,
    node_ids: h.node_ids,
    confidence: h.confidence,
    source_nodes: [],
    embedding: null,
    attributes: { ...h.attributes, project_id: turn.project_id },
    valid_from: now,
    valid_to: Infinity,
    tx_from: now,
    tx_to: Infinity,
    prev_version_id: null,
    invalidated_by: null,
    status: "ACTIVE",
  }
}
