import { describe, test, beforeAll } from "bun:test"
import { record, clearResults, makeTmp, rmTmp } from "./helpers"
import { clearMemoryTables, seedMemory } from "./db"
import { Consolidation, invalidateConsolidationConfigCache, resetState } from "../../src/memory/consolidation"
import { writeFileSync, existsSync } from "fs"
import { join } from "path"

const COMP = "run"

describe("P-0 audit: Consolidation.run", () => {
  beforeAll(() => {
    clearResults(COMP)
    invalidateConsolidationConfigCache()
    resetState()
  })

  test("records observed behavior for all 10 inputs (a-j)", async () => {
    const lockDir = makeTmp()

    // (a) empty recentSessionIds
    await clearMemoryTables()
    seedMemory({ id: "r-a", content: "seed memory for run test a", persona: "audit" })
    await record(COMP, "a", "empty recentSessionIds — gather produces 0 candidates", {
      persona: "audit", lockDir, recentSessionIds: [],
    }, () => Consolidation.run({ persona: "audit", lockDir, recentSessionIds: [] }))

    // (b) single session ID
    await clearMemoryTables()
    seedMemory({ id: "r-b", content: "seed memory for run test b", persona: "audit" })
    await record(COMP, "b", "single session ID (no messages in DB → 0 candidates)", {
      persona: "audit", lockDir, recentSessionIds: ["sess-1"],
    }, () => Consolidation.run({ persona: "audit", lockDir, recentSessionIds: ["sess-1"] }))

    // (c) 50 session IDs
    await clearMemoryTables()
    seedMemory({ id: "r-c", content: "seed memory for run test c", persona: "audit" })
    const fifty = Array.from({ length: 50 }, (_, i) => `sess-${i}`)
    await record(COMP, "c", "50 session IDs (no messages in DB → 0 candidates)", {
      persona: "audit", lockDir, recentSessionIds: fifty,
    }, () => Consolidation.run({ persona: "audit", lockDir, recentSessionIds: fifty }))

    // (d) lockDir already locked
    await clearMemoryTables()
    seedMemory({ id: "r-d", content: "seed memory for run test d", persona: "audit" })
    writeFileSync(join(lockDir, ".consolidate-lock"), JSON.stringify({ pid: process.pid, timestamp: Date.now() }))
    await record(COMP, "d", "lockDir already locked — CN-14 contention (run overwrites lock, does not check isLockedOut)", {
      persona: "audit", lockDir, recentSessionIds: [],
      preLockExists: true,
    }, () => Consolidation.run({ persona: "audit", lockDir, recentSessionIds: [] }))
    await record(COMP, "d-post", "post-state: lock file after run (should be removed by finally)", {
      lockExists: existsSync(join(lockDir, ".consolidate-lock")),
    }, () => existsSync(join(lockDir, ".consolidate-lock")))

    // (e) persona: "default"
    await clearMemoryTables()
    seedMemory({ id: "r-e", content: "seed memory for run test e", persona: "default" })
    await record(COMP, "e", "persona: 'default'", {
      persona: "default", lockDir, recentSessionIds: [],
    }, () => Consolidation.run({ persona: "default", lockDir, recentSessionIds: [] }))

    // (f) custom persona
    await clearMemoryTables()
    seedMemory({ id: "r-f", content: "seed memory for run test f", persona: "custom-persona" })
    await record(COMP, "f", "custom persona: 'audit-custom'", {
      persona: "audit-custom", lockDir, recentSessionIds: [],
    }, () => Consolidation.run({ persona: "audit-custom", lockDir, recentSessionIds: [] }))

    // (g) config missing memory.ttl_days — fallback to 90 (default; test preload has no config)
    await clearMemoryTables()
    seedMemory({ id: "r-g", content: "seed memory for run test g", persona: "audit" })
    await record(COMP, "g", "config missing memory.ttl_days — fallback to 90 (no config file in test env)", {
      persona: "audit", lockDir, recentSessionIds: [],
    }, () => Consolidation.run({ persona: "audit", lockDir, recentSessionIds: [] }))

    // (h) config with ttl_days: 0 — cannot override config mid-test; record with default ttl
    await clearMemoryTables()
    seedMemory({ id: "r-h", content: "seed memory for run test h", persona: "audit" })
    await record(COMP, "h", "config with ttl_days: 0 — harness limitation: cannot override config mid-test, uses default 90", {
      persona: "audit", lockDir, recentSessionIds: [],
    }, () => Consolidation.run({ persona: "audit", lockDir, recentSessionIds: [] }))

    // (i) config with ttl_days: 365 — same limitation
    await clearMemoryTables()
    seedMemory({ id: "r-i", content: "seed memory for run test i", persona: "audit" })
    await record(COMP, "i", "config with ttl_days: 365 — harness limitation: cannot override config mid-test, uses default 90", {
      persona: "audit", lockDir, recentSessionIds: [],
    }, () => Consolidation.run({ persona: "audit", lockDir, recentSessionIds: [] }))

    // (j) gather phase returns zero candidates
    await clearMemoryTables()
    seedMemory({ id: "r-j", content: "seed memory for run test j", persona: "audit" })
    await record(COMP, "j", "gather returns 0 candidates (no messages in MessageTable)", {
      persona: "audit", lockDir, recentSessionIds: ["no-such-session"],
    }, () => Consolidation.run({ persona: "audit", lockDir, recentSessionIds: ["no-such-session"] }))

    rmTmp(lockDir)
  }, 120000)
})
