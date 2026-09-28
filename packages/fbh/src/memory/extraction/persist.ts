/**
 * SDD-05 M-2 — persist extracted ENTITY/MEMORY nodes to the hypergraph.
 *
 * The extractors (EntityExtractor, MemoryExtractor) return records but
 * don't write to the hypergraph. This helper persists them via the global
 * SurrealHypergraphBackend. Used by the post-turn capture hook (prompt.ts)
 * and the retroactive backfill script.
 */
import { ulid } from "ulid"
import { getGlobalHypergraphBackend } from "../backend-registry"
import { Log } from "../../util/log"
import type { ExtractedEntityRecord } from "./entity"
import type { ExtractedMemoryRecord } from "./memory"

const log = Log.create({ service: "memory.extraction.persist" })

const NOW = () => Math.floor(Date.now() / 1000)

export async function persistEntities(
  entities: ExtractedEntityRecord[],
  turn: { sessionID: string; project_id: string; persona: string },
): Promise<number> {
  const backend = getGlobalHypergraphBackend()
  if (!backend || !backend.healthy()) return 0
  let written = 0
  for (const e of entities) {
    try {
      await backend.store({
        node_id: ulid(),
        node_type: "ENTITY",
        attributes: {
          name: e.name,
          entity_type: e.entity_type,
          description: "",
          content: e.name,
          project_id: turn.project_id,
          session_id: turn.sessionID,
        },
        confidence: e.confidence,
        source_path: e.source_path,
        valid_from: NOW(),
        valid_to: Infinity,
        tx_from: NOW(),
        tx_to: Infinity,
        status: "ACTIVE",
        version: 1,
        prev_version_id: null,
        invalidated_by: null,
        embedding: null,
      } as any)
      written++
    } catch (err) {
      log.warn("entity persist failed", { error: String(err) })
    }
  }
  return written
}

export async function persistMemories(
  memories: ExtractedMemoryRecord[],
  turn: { sessionID: string; project_id: string; persona: string },
): Promise<number> {
  const backend = getGlobalHypergraphBackend()
  if (!backend || !backend.healthy()) return 0
  let written = 0
  for (const m of memories) {
    try {
      await backend.store({
        node_id: ulid(),
        node_type: "MEMORY",
        attributes: {
          memory_type: m.type,
          content: m.content,
          source_nodes: [],
          usage_count: 0,
          last_used: NOW(),
          contradiction_count: 0,
          downstream_gain: 0,
          project_id: turn.project_id,
          session_id: turn.sessionID,
        },
        confidence: m.confidence,
        source_path: m.source_path,
        valid_from: NOW(),
        valid_to: Infinity,
        tx_from: NOW(),
        tx_to: Infinity,
        status: "ACTIVE",
        version: 1,
        prev_version_id: null,
        invalidated_by: null,
        embedding: null,
      } as any)
      written++
    } catch (err) {
      log.warn("memory persist failed", { error: String(err) })
    }
  }
  return written
}
