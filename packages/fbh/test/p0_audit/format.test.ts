import { describe, test, beforeAll } from "bun:test"
import { record, clearResults, daysAgo } from "./helpers"
import { AutoRecall } from "../../src/memory/recall"
import type { MemoryResult } from "../../src/memory/memory"

const COMP = "format"

function mr(over: Partial<MemoryResult> = {}): MemoryResult {
  return {
    id: over.id ?? "m1",
    content: over.content ?? "test memory content",
    persona: over.persona ?? "audit",
    scope: over.scope ?? "general",
    access_count: over.access_count ?? 0,
    created_at: over.created_at ?? String(Date.now()),
    accessed_at: over.accessed_at ?? String(Date.now()),
    metadata: over.metadata ?? {},
    score: over.score ?? 0.9,
    source: over.source ?? "local",
  }
}

describe("P-0 audit: AutoRecall.formatForInjection", () => {
  beforeAll(() => {
    clearResults(COMP)
    AutoRecall.invalidateRecallConfigCache()
  })

  test("records observed behavior for all 10 inputs (a-j)", async () => {
    // (a) empty results array — AR-14 returns ""
    await record(COMP, "a", "empty results array — AR-14 returns ''", {
      results: [],
    }, () => AutoRecall.formatForInjection([]))

    // (b) single result 1 day ago — no staleness warning
    await record(COMP, "b", "single result 1 day ago — no staleness warning", {
      results: [mr({ created_at: String(daysAgo(1).getTime()) })],
    }, () => AutoRecall.formatForInjection([mr({ created_at: String(daysAgo(1).getTime()) })]))

    // (c) single result older than stale_warning_days (default 1) — staleness suffix
    await record(COMP, "c", "single result 5 days ago — AR-13 staleness suffix appended", {
      results: [mr({ created_at: String(daysAgo(5).getTime()) })],
    }, () => AutoRecall.formatForInjection([mr({ created_at: String(daysAgo(5).getTime()) })]))

    // (d) five results of mixed age
    const mixed = [
      mr({ id: "d1", created_at: String(daysAgo(1).getTime()), content: "fresh memory" }),
      mr({ id: "d2", created_at: String(daysAgo(3).getTime()), content: "stale memory 1" }),
      mr({ id: "d3", created_at: String(daysAgo(7).getTime()), content: "stale memory 2" }),
      mr({ id: "d4", created_at: String(daysAgo(0).getTime()), content: "today memory" }),
      mr({ id: "d5", created_at: String(daysAgo(10).getTime()), content: "very stale memory" }),
    ]
    await record(COMP, "d", "five results of mixed age", {
      results: mixed,
    }, () => AutoRecall.formatForInjection(mixed))

    // (e) degraded: true — prepends degraded note
    await record(COMP, "e", "degraded: true — degraded note prepended", {
      results: [mr()], opts: { degraded: true },
    }, () => AutoRecall.formatForInjection([mr()], { degraded: true }))

    // (f) result with source: "local"
    await record(COMP, "f", "result with source: 'local'", {
      results: [mr({ source: "local" })],
    }, () => AutoRecall.formatForInjection([mr({ source: "local" })]))

    // (g) result with source: "workforce"
    await record(COMP, "g", "result with source: 'workforce'", {
      results: [mr({ source: "workforce" })],
    }, () => AutoRecall.formatForInjection([mr({ source: "workforce" })]))

    // (h) result with created_at: "0" — formatDate returns "unknown"
    await record(COMP, "h", "result with created_at: '0' — formatDate returns 'unknown'", {
      results: [mr({ created_at: "0" })],
    }, () => AutoRecall.formatForInjection([mr({ created_at: "0" })]))

    // (i) result with created_at: "" — same path as (h)
    await record(COMP, "i", "result with created_at: '' — formatDate returns 'unknown'", {
      results: [mr({ created_at: "" })],
    }, () => AutoRecall.formatForInjection([mr({ created_at: "" })]))

    // (j) result with created_at of a valid timestamp
    await record(COMP, "j", "result with valid timestamp created_at", {
      results: [mr({ created_at: String(daysAgo(2).getTime()) })],
    }, () => AutoRecall.formatForInjection([mr({ created_at: String(daysAgo(2).getTime()) })]))
  }, 30000)
})
