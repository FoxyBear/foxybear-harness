/**
 * SDD-06 / Phase M-3 — GC (hard-delete ARCHIVED past retention).
 *
 * Selects node records with status=ARCHIVED and age_days > retention_days,
 * appends a GC_DELETED event BEFORE the hard-delete (audit trail survives
 * per the master Security section), then hard-deletes the record from the
 * node table. SHALL NOT hard-delete any record with status !== ARCHIVED.
 * SHALL NOT hard-delete any ARCHIVED record with age_days <= retention_days.
 */
import { getConfig } from "../../config/bridge"
import { getGlobalHypergraphBackend } from "../backend-registry"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.lifecycle.gc" })

export interface GcResult {
  deleted: number
}

const DEFAULT_RETENTION_DAYS = 365

async function resolveRetention(): Promise<number> {
  try {
    const cfg = await getConfig()
    return cfg?.memory?.decay?.retention_days ?? DEFAULT_RETENTION_DAYS
  } catch {
    return DEFAULT_RETENTION_DAYS
  }
}

/**
 * gc(now?) — hard-delete ARCHIVED nodes past retention_days.
 *
 * Emits GC_DELETED event before each deletion. Returns { deleted }.
 */
export async function gc(nowParam?: number): Promise<GcResult> {
  const now = nowParam ?? Math.floor(Date.now() / 1000)
  const retention = await resolveRetention()
  const backend = getGlobalHypergraphBackend()
  if (!backend) return { deleted: 0 }

  const archived = await backend.listArchivedPastRetention(retention, now)
  let deleted = 0

  for (const node of archived) {
    // Emit GC_DELETED BEFORE hard-delete so the audit trail survives.
    await backend.appendEvent({
      event_type: "GC_DELETED",
      target_id: node.node_id,
      target_type: "node",
      payload: { retention_days: retention, age_days: Math.max(0, (now - node.created_at) / 86400) },
    })
    await backend.deleteNode(node.node_id)
    deleted++
  }

  log.info("gc complete", { deleted, retention_days: retention })
  return { deleted }
}
