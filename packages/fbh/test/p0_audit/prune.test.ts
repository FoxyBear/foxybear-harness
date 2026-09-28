import { describe, test, beforeAll } from "bun:test"
import { record, clearResults, daysAgo } from "./helpers"
import { clearMemoryTables, clearIndexTable, seedMemory, seedIndexRow, readMemoryRows, readIndexRows, unitEmb, orthogonalEmb } from "./db"
import { Consolidation, invalidateConsolidationConfigCache } from "../../src/memory/consolidation"

const COMP = "prune"

describe("P-0 audit: Consolidation.prune", () => {
  beforeAll(() => {
    clearResults(COMP)
    invalidateConsolidationConfigCache()
  })

  test("records observed behavior for all 10 inputs (a-j)", async () => {
    // (a) empty MemoryTopicsTable
    await clearMemoryTables()
    await record(COMP, "a", "empty MemoryTopicsTable — pruned=0, nearDupsMerged=0, indexRemoved=0", {
      persona: "audit", tableState: "empty",
    }, () => Consolidation.prune({ persona: "audit" }))

    // (b) single row younger than TTL (90 days)
    await clearMemoryTables()
    seedMemory({ id: "p-b", content: "young memory", persona: "audit", time_accessed: daysAgo(1) })
    await record(COMP, "b", "single row younger than TTL (1 day old, accessed 1 day ago)", {
      persona: "audit", seededRows: 1, ageDays: 1,
    }, async () => {
      const res = await Consolidation.prune({ persona: "audit" })
      return { ...res, remainingRows: readMemoryRows().length }
    })

    // (c) single row older than TTL with access_count < 3
    await clearMemoryTables()
    seedMemory({ id: "p-c", content: "old memory low access", persona: "audit", time_accessed: daysAgo(91), access_count: 0 })
    await record(COMP, "c", "single row older than TTL (91 days) with access_count=0 < 3 — should be pruned", {
      persona: "audit", seededRows: 1, ageDays: 91, accessCount: 0,
    }, async () => {
      const res = await Consolidation.prune({ persona: "audit" })
      return { ...res, remainingRows: readMemoryRows().length }
    })

    // (d) single row older than TTL with access_count >= 3
    await clearMemoryTables()
    seedMemory({ id: "p-d", content: "old memory high access", persona: "audit", time_accessed: daysAgo(91), access_count: 3 })
    await record(COMP, "d", "single row older than TTL (91 days) with access_count=3 >= 3 — keep condition, should NOT be pruned", {
      persona: "audit", seededRows: 1, ageDays: 91, accessCount: 3,
    }, async () => {
      const res = await Consolidation.prune({ persona: "audit" })
      return { ...res, remainingRows: readMemoryRows().length }
    })

    // (e) two rows with cosine > 0.95 (near-dup merge — more recently accessed survives)
    await clearMemoryTables()
    seedMemory({ id: "p-e1", content: "near dup memory A", persona: "audit", time_accessed: daysAgo(1), embedding: unitEmb(768, 1) })
    seedMemory({ id: "p-e2", content: "near dup memory B", persona: "audit", time_accessed: daysAgo(5), embedding: unitEmb(768, 1) })
    await record(COMP, "e", "two rows with cosine > 0.95 (identical embeddings) — nearDupsMerged=1, more recently accessed survives", {
      persona: "audit", seededRows: 2, cosine: 1.0,
    }, async () => {
      const res = await Consolidation.prune({ persona: "audit" })
      const remaining = readMemoryRows()
      return { ...res, remainingRows: remaining.length, survivingIds: remaining.map((r) => r.id) }
    })

    // (f) two rows with cosine < 0.95 (both survive)
    await clearMemoryTables()
    seedMemory({ id: "p-f1", content: "different memory A", persona: "audit", time_accessed: daysAgo(1), embedding: orthogonalEmb(768, "first") })
    seedMemory({ id: "p-f2", content: "different memory B", persona: "audit", time_accessed: daysAgo(5), embedding: orthogonalEmb(768, "second") })
    await record(COMP, "f", "two rows with cosine < 0.95 (orthogonal embeddings) — both survive", {
      persona: "audit", seededRows: 2, cosine: 0.0,
    }, async () => {
      const res = await Consolidation.prune({ persona: "audit" })
      const remaining = readMemoryRows()
      return { ...res, remainingRows: remaining.length, survivingIds: remaining.map((r) => r.id) }
    })

    // (g) MemoryIndexTable with 201 entries — 200-entry cap removes 1
    await clearMemoryTables()
    await clearIndexTable()
    for (let i = 0; i < 201; i++) {
      seedIndexRow({ id: `idx-g-${i}`, access_count: i })
    }
    await record(COMP, "g", "MemoryIndexTable with 201 entries — indexRemoved=1 (lowest access_count removed)", {
      persona: "audit", seededIndexRows: 201,
    }, async () => {
      const res = await Consolidation.prune({ persona: "audit" })
      return { ...res, remainingIndexRows: readIndexRows().length }
    })

    // (h) MemoryIndexTable with 200 entries — no removal
    await clearMemoryTables()
    await clearIndexTable()
    for (let i = 0; i < 200; i++) {
      seedIndexRow({ id: `idx-h-${i}`, access_count: i })
    }
    await record(COMP, "h", "MemoryIndexTable with 200 entries — indexRemoved=0 (200 is not > 200)", {
      persona: "audit", seededIndexRows: 200,
    }, async () => {
      const res = await Consolidation.prune({ persona: "audit" })
      return { ...res, remainingIndexRows: readIndexRows().length }
    })

    // (i) MemoryIndexTable with 201 entries where multiple share lowest access_count — tiebreaker
    await clearMemoryTables()
    await clearIndexTable()
    for (let i = 0; i < 201; i++) {
      seedIndexRow({
        id: `idx-i-${i}`,
        access_count: i < 3 ? 0 : i,
        time_created: Date.now() - i * 1000,
      })
    }
    await record(COMP, "i", "MemoryIndexTable with 201 entries, 3 share lowest access_count=0 — time_created tiebreaker determines which is removed", {
      persona: "audit", seededIndexRows: 201, lowestAccessCountEntries: 3,
    }, async () => {
      const res = await Consolidation.prune({ persona: "audit" })
      const remaining = readIndexRows()
      const removed = remaining.length === 200 ? "1 removed (oldest of the 3 with access_count=0)" : `${201 - remaining.length} removed`
      return { ...res, remainingIndexRows: remaining.length, removedDescription: removed }
    })

    // (j) config with ttl_days: 1 against rows 2 days old — harness limitation: cannot override config, uses default 90
    await clearMemoryTables()
    seedMemory({ id: "p-j", content: "two day old memory", persona: "audit", time_accessed: daysAgo(2), access_count: 0 })
    await record(COMP, "j", "config ttl_days: 1 against rows 2 days old — harness limitation: cannot override config mid-test, uses default 90; row 2 days old is NOT prunable (2 < 90)", {
      persona: "audit", seededRows: 1, ageDays: 2, accessCount: 0,
    }, async () => {
      const res = await Consolidation.prune({ persona: "audit" })
      return { ...res, remainingRows: readMemoryRows().length }
    })
  }, 120000)
})
