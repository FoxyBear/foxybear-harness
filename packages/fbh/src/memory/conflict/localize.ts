/**
 * SDD-09 / Phase M-5 — HiGram-style path localization (reqs 13-15).
 *
 * Given a target MEMORY node id, identify the minimal subgraph that
 * supports it:
 *   - hyperedges referencing target_id (via SurrealHypergraphBackend.expand,
 *     SDD-03's BFS over the hyperedge_members junction table)
 *   - ActionNode/ErrorNode/MessageNode that produced or referenced it
 *     (via the COLLABORATION/EVIDENCE/ERROR_CORRECTION hyperedges' node_ids)
 *   - other MEMORY nodes citing it as source_nodes
 *
 * Returns { node_ids, hyperedge_ids } for the audit trail recorded in the
 * UPDATE or INVALIDATE event's payload (req 14). An orphan old memory
 * (no hyperedges reference it) returns empty arrays — still a valid target
 * for rewrite or retract (req 15).
 *
 * The subgraph's other nodes are NOT rewritten or soft-deleted in Phase
 * M-5 — only the old memory itself is (req 14). Subgraph-wide coordinated
 * rewrite is a fast-follow.
 */
import { getGlobalHypergraphBackend } from "../backend-registry"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.conflict.localize" })

export interface Subgraph {
  node_ids: string[]
  hyperedge_ids: string[]
}

/**
 * localize(target_id, project_id) — identify the evidence path supporting
 * the target MEMORY node. Uses SurrealHypergraphBackend.expand with
 * depth=1 to collect the 1-hop neighborhood (seed node + hyperedges
 * connected to it + nodes connected to those hyperedges). The seed node
 * itself is excluded from node_ids (it's the target, recorded separately
 * in the event payload as old_node_id).
 */
export async function localize(
  target_id: string,
  project_id: string,
): Promise<Subgraph> {
  const backend = getGlobalHypergraphBackend()
  if (!backend) return { node_ids: [], hyperedge_ids: [] }

  try {
    const expanded = await backend.expand([target_id], project_id, 1)
    const node_ids: string[] = []
    const hyperedge_ids: string[] = []

    for (const he of expanded.hyperedges) {
      hyperedge_ids.push(he.hyperedge_id)
      for (const nid of he.node_ids) {
        if (nid !== target_id && !node_ids.includes(nid)) {
          node_ids.push(nid)
        }
      }
    }

    // Also include nodes from the expanded set (ActionNode/ErrorNode/
    // MessageNode and other MEMORY nodes) that aren't the target.
    for (const n of expanded.nodes) {
      if (n.node_id !== target_id && !node_ids.includes(n.node_id)) {
        node_ids.push(n.node_id)
      }
    }

    log.debug("localize complete", { target_id, nodes: node_ids.length, edges: hyperedge_ids.length })
    return { node_ids, hyperedge_ids }
  } catch (err) {
    log.warn("localize failed, returning empty subgraph", { target_id, error: String(err) })
    return { node_ids: [], hyperedge_ids: [] }
  }
}
