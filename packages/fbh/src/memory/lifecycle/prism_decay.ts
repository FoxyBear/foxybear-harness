/**
 * SDD-06 / Phase M-3 — Prism replicator-decay (EXPERIMENTAL, observational only).
 *
 * Imported by decay.ts ONLY when memory.decay_model=prism. The ESMS
 * convergence proof is unverified, so the Prism formula does NOT gate
 * the default simple-exponential decay. The coupled-loop sim (req 3)
 * runs this alongside the default and reports its metrics; promotion
 * to default requires both ESMS proof verification AND a coupled-loop
 * sim pass with decay_model=prism.
 *
 * The Prism replicator dynamics approximate memory activation as a
 * replicator equation where confidence competes with a decay baseline:
 *   confidence(t+1) = clamp(confidence(t) + alpha * confidence(t) *
 *                     (1 - confidence(t)) - lambda * (1 - access(t)))
 * where alpha controls growth toward 1.0, lambda controls decay toward
 * 0.0, and access(t) ∈ {0, 1} gates the decay term. This is a clamped
 * contraction on [0, 1] so it converges (the proof is the standard
 * replicator stability argument — but ESMS verification is still
 * pending, hence experimental).
 */
import { getConfig } from "../../config/bridge"
import { getGlobalHypergraphBackend } from "../backend-registry"
import type { NodeRecord } from "../surreal-hypergraph-backend"
import { is_live } from "../schema/lifecycle"
import type { LifecycleStatus } from "../schema/enums"
import { Log } from "../../util/log"
import type { DecayResult } from "./decay"

const log = Log.create({ service: "memory.lifecycle.prism_decay" })

interface PrismConfig {
  alpha: number
  lambda: number
  deprecated_threshold: number
  archived_threshold: number
  archive_age_days: number
}

const DEFAULTS: PrismConfig = {
  alpha: 0.05,
  lambda: 0.02,
  deprecated_threshold: 0.3,
  archived_threshold: 0.1,
  archive_age_days: 90,
}

async function resolve(): Promise<PrismConfig> {
  try {
    const cfg = await getConfig()
    const d = cfg?.memory?.decay
    return {
      alpha: d?.active_rate ? d.active_rate * 5 : DEFAULTS.alpha,
      lambda: d?.deprecated_rate ?? DEFAULTS.lambda,
      deprecated_threshold: d?.deprecated_threshold ?? DEFAULTS.deprecated_threshold,
      archived_threshold: d?.archived_threshold ?? DEFAULTS.archived_threshold,
      archive_age_days: d?.archive_age_days ?? DEFAULTS.archive_age_days,
    }
  } catch {
    return DEFAULTS
  }
}

function clamp01(x: number): number {
  return Math.min(1.0, Math.max(0.0, x))
}

function ageDays(node: NodeRecord, now: number): number {
  return Math.max(0, (now - node.created_at) / 86400)
}

function nextStatus(node: NodeRecord, confidence: number, cfg: PrismConfig, now: number): LifecycleStatus | null {
  const status = node.status
  const age = ageDays(node, now)
  const usage = Number(node.attributes.usage_count ?? 0)

  if (status === "ACTIVE" && confidence < cfg.deprecated_threshold) return "DEPRECATED"
  if (status === "DEPRECATED") {
    if (confidence < cfg.archived_threshold) return "ARCHIVED"
    if (age > cfg.archive_age_days && usage < 2) return "ARCHIVED"
  }
  return null
}

/**
 * prism_decay(now) — the experimental replicator-decay formula.
 *
 * Called by decay() only when memory.decay_model=prism. Returns the
 * same { decayed, transitioned } shape as the default so the scheduler
 * task handler is agnostic to the model.
 */
export async function prism_decay(nowParam?: number): Promise<DecayResult> {
  const now = nowParam ?? Math.floor(Date.now() / 1000)
  const cfg = await resolve()
  const backend = getGlobalHypergraphBackend()
  if (!backend) return { decayed: 0, transitioned: 0 }

  const nodes = await backend.listLiveNodes(["ACTIVE", "DEPRECATED", "ARCHIVED"], now)
  const live = nodes.filter((n) => is_live(n, now))
  let decayed = 0
  let transitioned = 0

  for (const node of live) {
    const lastTick = Number(node.attributes.last_decay_tick ?? node.created_at)
    const lastUsed = Number(node.attributes.last_used ?? 0)
    const access = lastUsed > lastTick ? 1 : 0
    const current = Number(node.attributes.confidence ?? 0.5)

    // Prism replicator dynamics — clamped contraction on [0, 1].
    const growth = cfg.alpha * current * (1 - current)
    const decayTerm = cfg.lambda * (1 - access)
    const next = clamp01(current + growth - decayTerm)

    const newStatus = nextStatus(node, next, cfg, now)
    const statusChanged = newStatus !== null

    if (Math.abs(next - current) > 1e-9 || statusChanged) {
      await backend.updateNodeFields(node.node_id, {
        status: newStatus ?? node.status,
        confidence: next,
        attributes: { last_decay_tick: now },
        updated_at: now,
      })
      decayed++
    }
    if (statusChanged && newStatus) {
      await backend.appendEvent({
        event_type: "STATUS_TRANSITION",
        target_id: node.node_id,
        target_type: "node",
        payload: { from: node.status, to: newStatus, at: now, model: "prism" },
      })
      transitioned++
    }
  }

  log.info("prism_decay tick complete", { decayed, transitioned, nodes: live.length })
  return { decayed, transitioned }
}
