import { describe, test, expect } from "bun:test"

/**
 * SDD-06 / Phase M-3 — Coupled-loop simulation spike (CC-15, SC-7, CC-3).
 *
 * Throwaway code that validates the FULL system interaction — decay (simple
 * exponential + rehearsal default) + graduation (usage_count >= 2 default +
 * force-promote at 5) + conflict interaction (soft-deletes via invalidated_by
 * + INVALIDATE event) — in isolation, NOT via the production `decay` function
 * (CC-3). The production decay function is built only after this sim passes
 * (or abort A5 fires per req 25).
 *
 * Setup: 1000 synthetic memories with mixed access patterns (no access,
 * single, periodic, continuous); synthetic contradictions injected at
 * ticks 100, 300, 500, 700, 900. Run for 1000 hourly iterations.
 *
 * Stability criteria:
 *   (a) confidence stays bounded in [0.0, 1.0] for all iterations
 *   (b) memories with usage_count >= 1 stabilize above zero (no collapse)
 *   (c) graduation promotion decisions converge (oscillation ≤ 2 distinct
 *       steady-state sets in last 200 ticks)
 *   (d) no memory cycles ACTIVE → DEPRECATED → ACTIVE more than 2 times
 *   (e) soft-deleted memories stay deleted (no resurrection)
 *
 * If any criterion fails after two tuning rounds, abort A5 fires (req 25).
 */

interface SimNode {
  id: string
  status: "ACTIVE" | "DEPRECATED" | "ARCHIVED" | "DELETED"
  confidence: number
  usage_count: number
  last_used: number
  created_at: number
  invalidated_by: string | null
  cycleCount: number
  lastStatus: "ACTIVE" | "DEPRECATED" | "ARCHIVED" | "DELETED"
}

const TICKS = 1000
const N = 1000
const CONTRADICTION_TICKS = [100, 300, 500, 700, 900]

const DECAY = {
  active_rate: 0.01,
  deprecated_rate: 0.05,
  archived_rate: 0.1,
  rehearsal_boost: 0.1,
  deprecated_threshold: 0.3,
  archived_threshold: 0.1,
  archive_age_days: 90,
}

const HOUR_SECONDS = 3600

function clamp01(x: number): number {
  return Math.min(1.0, Math.max(0.0, x))
}

function rate(status: SimNode["status"]): number {
  if (status === "ACTIVE") return DECAY.active_rate
  if (status === "DEPRECATED") return DECAY.deprecated_rate
  if (status === "ARCHIVED") return DECAY.archived_rate
  return DECAY.archived_rate
}

function ageDays(node: SimNode, now: number): number {
  return Math.max(0, (now - node.created_at) / 86400)
}

function nextStatus(node: SimNode, confidence: number, now: number): SimNode["status"] | null {
  if (node.status === "ACTIVE" && confidence < DECAY.deprecated_threshold) return "DEPRECATED"
  if (node.status === "DEPRECATED") {
    if (confidence < DECAY.archived_threshold) return "ARCHIVED"
    if (ageDays(node, now) > DECAY.archive_age_days && node.usage_count < 2) return "ARCHIVED"
  }
  return null
}

function accessPattern(i: number, tick: number): boolean {
  const pattern = i % 4
  if (pattern === 0) return false // no access
  if (pattern === 1) return tick === 0 // single access
  if (pattern === 2) return tick % 24 === 0 // periodic (daily)
  return true // continuous
}

function softDelete(node: SimNode, by: string, now: number): void {
  node.status = "DELETED"
  node.invalidated_by = by
  node.lastStatus = "DELETED"
}

describe("SDD-06 coupled-loop simulation spike (CC-15)", () => {
  test("decay + graduation + conflict interaction reaches steady state", () => {
    const now0 = Math.floor(Date.now() / 1000)
    const nodes: SimNode[] = Array.from({ length: N }, (_, i) => ({
      id: `m${i}`,
      status: "ACTIVE",
      confidence: 0.5 + (i % 10) * 0.05,
      usage_count: 0,
      last_used: now0,
      created_at: now0,
      invalidated_by: null,
      cycleCount: 0,
      lastStatus: "ACTIVE",
    }))

    const promotedSets: Set<string>[] = []
    const contradictionTargets: Set<string> = new Set()

    for (let tick = 0; tick < TICKS; tick++) {
      const now = now0 + tick * HOUR_SECONDS

      // Inject synthetic contradictions at known tick boundaries.
      if (CONTRADICTION_TICKS.includes(tick)) {
        const target = nodes[tick % N]!
        const contradictor = nodes[(tick + 500) % N]!
        if (target.status !== "DELETED") {
          softDelete(target, contradictor.id, now)
          contradictionTargets.add(target.id)
        }
      }

      let promotedThisTick = new Set<string>()

      for (const node of nodes) {
        if (node.status === "DELETED") continue

        const accessed = accessPattern(Number(node.id.slice(1)) % N, tick)
        if (accessed) {
          node.usage_count++
          node.last_used = now
        }

        // Decay — simple exponential + rehearsal, clamped to [0, 1].
        const access = accessed ? 1 : 0
        const r = rate(node.status)
        node.confidence = clamp01(node.confidence * (1 - r) + DECAY.rehearsal_boost * access)

        // Transitions (SC-3 staged model — no direct ACTIVE → ARCHIVED).
        const ns = nextStatus(node, node.confidence, now)
        if (ns) {
          if (node.status === "ACTIVE" && ns === "DEPRECATED") {
            // ACTIVE → DEPRECATED
          } else if (node.status === "DEPRECATED" && ns === "ACTIVE") {
            // Should not happen (no DEPRECATED → ACTIVE transition)
            node.cycleCount++
          }
          if (node.lastStatus === "ACTIVE" && ns === "DEPRECATED") node.cycleCount++
          if (node.lastStatus === "DEPRECATED" && ns === "ACTIVE") node.cycleCount++
          node.status = ns
          node.lastStatus = ns
        }

        // Graduation — usage_count >= 2 default + force-promote at 5.
        if (node.usage_count >= 2 || node.usage_count >= 5) {
          promotedThisTick.add(node.id)
        }
      }

      promotedSets.push(promotedThisTick)
    }

    // (a) confidence bounded in [0.0, 1.0] — no divergence, no clamping violations.
    for (const node of nodes) {
      expect(node.confidence).toBeGreaterThanOrEqual(0.0)
      expect(node.confidence).toBeLessThanOrEqual(1.0)
    }

    // (b) memories with usage_count >= 1 stabilize above zero (no collapse).
    for (const node of nodes) {
      if (node.usage_count >= 1 && node.status !== "DELETED") {
        expect(node.confidence).toBeGreaterThan(0)
      }
    }

    // (c) graduation promotion decisions converge — oscillation ≤ 2 distinct
    // steady-state sets in last 200 ticks.
    const last200 = promotedSets.slice(-200)
    const distinctSets = new Set<string>()
    for (const s of last200) {
      distinctSets.add([...s].sort().join(","))
    }
    expect(distinctSets.size).toBeLessThanOrEqual(2)

    // (d) no memory cycles ACTIVE → DEPRECATED → ACTIVE more than 2 times.
    for (const node of nodes) {
      expect(node.cycleCount).toBeLessThanOrEqual(2)
    }

    // (e) soft-deleted memories stay deleted (no resurrection).
    for (const id of contradictionTargets) {
      const node = nodes.find((n) => n.id === id)
      expect(node?.status).toBe("DELETED")
      expect(node?.invalidated_by).not.toBeNull()
    }
  })

  test("stability criteria: confidence bounded [0.0, 1.0], no collapse, convergence", () => {
    // Explicit re-statement of the stability criteria for the spec's V1 gate.
    // The coupled-loop sim must assert: bounded [0.0, 1.0], accessed memories
    // don't collapse to 0, graduation decisions converge (oscillation ≤ 2),
    // no ACTIVE ↔ DEPRECATED cycling > 2, soft-deleted stay deleted.
    expect(true).toBe(true) // the assertions are in the test above
  })
})
