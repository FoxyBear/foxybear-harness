/**
 * SDD-06 / Phase M-3 — Lifecycle decay (simple exponential + rehearsal default).
 *
 * Default decay model per council Decision 3:
 *   confidence(t+1) = min(1.0, max(0.0, confidence(t) * (1 - rate(status))
 *                       + rehearsal_boost * access(t)))
 *
 * where rate(status) ∈ {active_rate, deprecated_rate, archived_rate} and
 * access(t) = 1 iff the node was accessed since the last decay tick (tracked
 * via attributes.last_used). Clamped to [0, 1] per SC-4.
 *
 * Lifecycle transitions follow SC-3's staged model — no direct
 * ACTIVE → ARCHIVED transitions:
 *   (a) ACTIVE → DEPRECATED  : confidence < deprecated_threshold
 *   (b) DEPRECATED → ARCHIVED: confidence < archived_threshold
 *   (c) DEPRECATED → ARCHIVED: age_days > archive_age_days AND usage_count < 2
 *   (d) ARCHIVED → DELETED   : only via gc() (age_days > retention_days)
 *   (e) any → DELETED        : soft-delete (invalidated_by + INVALIDATE event)
 *
 * Each transition emits a STATUS_TRANSITION event to the event table.
 * Dispatches to prism_decay.ts ONLY when memory.decay_model=prism. No-op
 * when memory.decay_model=none (abort A5 state per req 25).
 */
import { getConfig } from "../../config/bridge"
import { getGlobalHypergraphBackend } from "../backend-registry"
import type { NodeRecord } from "../surreal-hypergraph-backend"
import { is_live } from "../schema/lifecycle"
import type { LifecycleStatus } from "../schema/enums"
import { Log } from "../../util/log"
import { prism_decay } from "./prism_decay"

const log = Log.create({ service: "memory.lifecycle.decay" })

export interface DecayResult {
  decayed: number
  transitioned: number
}

interface DecayConfig {
  active_rate: number
  deprecated_rate: number
  archived_rate: number
  rehearsal_boost: number
  deprecated_threshold: number
  archived_threshold: number
  archive_age_days: number
  retention_days: number
}

const DEFAULTS: DecayConfig = {
  active_rate: 0.01,
  deprecated_rate: 0.05,
  archived_rate: 0.1,
  rehearsal_boost: 0.1,
  archived_threshold: 0.1,
  deprecated_threshold: 0.3,
  archive_age_days: 90,
  retention_days: 365,
}

async function resolve(): Promise<DecayConfig> {
  try {
    const cfg = await getConfig()
    const d = cfg?.memory?.decay
    return {
      active_rate: d?.active_rate ?? DEFAULTS.active_rate,
      deprecated_rate: d?.deprecated_rate ?? DEFAULTS.deprecated_rate,
      archived_rate: d?.archived_rate ?? DEFAULTS.archived_rate,
      rehearsal_boost: d?.rehearsal_boost ?? DEFAULTS.rehearsal_boost,
      deprecated_threshold: d?.deprecated_threshold ?? DEFAULTS.deprecated_threshold,
      archived_threshold: d?.archived_threshold ?? DEFAULTS.archived_threshold,
      archive_age_days: d?.archive_age_days ?? DEFAULTS.archive_age_days,
      retention_days: d?.retention_days ?? DEFAULTS.retention_days,
    }
  } catch {
    return DEFAULTS
  }
}

async function resolveModel(): Promise<"simple" | "prism" | "none"> {
  try {
    const cfg = await getConfig()
    const m = cfg?.memory?.decay_model
    if (m === "prism" || m === "none") return m
    return "simple"
  } catch {
    return "simple"
  }
}

function rate(status: LifecycleStatus, cfg: DecayConfig): number {
  if (status === "ACTIVE") return cfg.active_rate
  if (status === "DEPRECATED") return cfg.deprecated_rate
  if (status === "ARCHIVED") return cfg.archived_rate
  return cfg.archived_rate
}

function clamp01(x: number): number {
  return Math.min(1.0, Math.max(0.0, x))
}

function ageDays(node: NodeRecord, now: number): number {
  return Math.max(0, (now - node.created_at) / 86400)
}

function accessedSinceLastTick(node: NodeRecord, lastTick: number): boolean {
  const lastUsed = Number(node.attributes.last_used ?? 0)
  return lastUsed > lastTick
}

/**
 * Staged transition evaluator (SC-3 — no direct ACTIVE → ARCHIVED).
 * Returns the new status or null if no transition fires.
 */
function nextStatus(node: NodeRecord, confidence: number, cfg: DecayConfig, now: number): LifecycleStatus | null {
  const status = node.status
  const age = ageDays(node, now)
  const usage = Number(node.attributes.usage_count ?? 0)

  // (a) ACTIVE → DEPRECATED by confidence
  if (status === "ACTIVE" && confidence < cfg.deprecated_threshold) return "DEPRECATED"

  // (b) DEPRECATED → ARCHIVED by confidence
  // (c) DEPRECATED → ARCHIVED by age + low usage
  // No direct ACTIVE → ARCHIVED — SC-3.
  if (status === "DEPRECATED") {
    if (confidence < cfg.archived_threshold) return "ARCHIVED"
    if (age > cfg.archive_age_days && usage < 2) return "ARCHIVED"
  }
  return null
}

async function emitTransition(node: NodeRecord, from: LifecycleStatus, to: LifecycleStatus, now: number): Promise<void> {
  const backend = getGlobalHypergraphBackend()
  if (!backend) return
  await backend.appendEvent({
    event_type: "STATUS_TRANSITION",
    target_id: node.node_id,
    target_type: "node",
    payload: { from, to, at: now },
  })
}

/**
 * decay(now?) — single decay tick over all live nodes.
 *
 * Returns { decayed, transitioned }. No-op when decay_model=none.
 * Dispatches to prism_decay when decay_model=prism.
 */
export async function decay(nowParam?: number): Promise<DecayResult> {
  const now = nowParam ?? Math.floor(Date.now() / 1000)
  const model = await resolveModel()

  if (model === "none") {
    log.info("decay engine disabled (decay_model=none / abort A5)")
    return { decayed: 0, transitioned: 0 }
  }

  if (model === "prism") {
    log.info("decay: dispatching to prism_decay (experimental)")
    return prism_decay(now)
  }

  const cfg = await resolve()
  const backend = getGlobalHypergraphBackend()
  if (!backend) return { decayed: 0, transitioned: 0 }

  const nodes = await backend.listLiveNodes(["ACTIVE", "DEPRECATED", "ARCHIVED"], now)
  const live = nodes.filter((n) => is_live(n, now))
  let decayed = 0
  let transitioned = 0

  for (const node of live) {
    const lastTick = Number(node.attributes.last_decay_tick ?? node.created_at)
    const accessed = accessedSinceLastTick(node, lastTick) ? 1 : 0
    const current = Number(node.attributes.confidence ?? 0.5)
    const r = rate(node.status, cfg)
    // simple exponential + rehearsal formula, clamped to [0, 1]
    const next = clamp01(current * (1 - r) + cfg.rehearsal_boost * accessed)

    const newStatus = nextStatus(node, next, cfg, now)
    const statusChanged = newStatus !== null

    if (Math.abs(next - current) > 1e-9 || statusChanged) {
      await backend.updateNodeFields(node.node_id, {
        status: newStatus ?? node.status,
        confidence: next,
        attributes: { last_decay_tick: now, last_used: accessed ? Number(node.attributes.last_used ?? now) : node.attributes.last_used },
        updated_at: now,
      })
      decayed++
    }
    if (statusChanged && newStatus) {
      await emitTransition(node, node.status, newStatus, now)
      transitioned++
    }
  }

  log.info("decay tick complete", { decayed, transitioned, nodes: live.length })
  return { decayed, transitioned }
}
