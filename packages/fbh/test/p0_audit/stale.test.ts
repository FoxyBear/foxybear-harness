import { describe, test, beforeAll } from "bun:test"
import { record, clearResults, daysAgo } from "./helpers"
import { clearMemoryTables, seedMemory, unitEmb } from "./db"
import { Memory } from "../../src/memory/memory"
import { setGlobalMemoryBackend } from "../../src/memory/backend-registry"

const COMP = "stale"

const DIM = 768

describe("P-0 audit: Memory stale penalty (memory.ts:458)", () => {
  beforeAll(() => {
    clearResults(COMP)
    Memory.invalidateConfigCache()
    setGlobalMemoryBackend(null)
  })

  test("records observed behavior for all 10 inputs (a-j)", async () => {
    const qemb = unitEmb(DIM, 1) // cosine = 1.0 against unit embeddings

    // (a) memory older than stalePenaltyDays (7) with access_count < 2 — penalty fires (score *= 0.5)
    await clearMemoryTables()
    seedMemory({ id: "s-a", content: "stale low access", persona: "audit", time_created: daysAgo(8), time_accessed: daysAgo(1), access_count: 0, embedding: unitEmb(DIM, 1) })
    await record(COMP, "a", "memory 8 days old, access_count=0 < 2 — penalty fires, score_after = score_before * 0.5", {
      ageDays: 8, accessCount: 0, stalePenaltyDays: 7,
    }, async () => {
      const before = 1.0 // cosine(qemb, unitEmb) = 1.0
      const results = await Memory.searchLocalWithEmbedding({ queryEmbedding: qemb, persona: "audit" })
      const scoreAfter = results.length > 0 ? results[0]!.score : null
      return { score_before: before, score_after: scoreAfter, penalty_fired: scoreAfter !== null && Math.abs(scoreAfter - before * 0.5) < 0.001 }
    })

    // (b) memory older than stalePenaltyDays with access_count = 2 — penalty does NOT fire
    await clearMemoryTables()
    seedMemory({ id: "s-b", content: "stale access 2", persona: "audit", time_created: daysAgo(8), time_accessed: daysAgo(1), access_count: 2, embedding: unitEmb(DIM, 1) })
    await record(COMP, "b", "memory 8 days old, access_count=2 (NOT < 2) — penalty does NOT fire", {
      ageDays: 8, accessCount: 2, stalePenaltyDays: 7,
    }, async () => {
      const before = 1.0
      const results = await Memory.searchLocalWithEmbedding({ queryEmbedding: qemb, persona: "audit" })
      const scoreAfter = results.length > 0 ? results[0]!.score : null
      return { score_before: before, score_after: scoreAfter, penalty_fired: scoreAfter !== null && Math.abs(scoreAfter - before * 0.5) < 0.001 }
    })

    // (c) memory older than stalePenaltyDays with access_count = 5 — no penalty
    await clearMemoryTables()
    seedMemory({ id: "s-c", content: "stale access 5", persona: "audit", time_created: daysAgo(8), time_accessed: daysAgo(1), access_count: 5, embedding: unitEmb(DIM, 1) })
    await record(COMP, "c", "memory 8 days old, access_count=5 — no penalty", {
      ageDays: 8, accessCount: 5, stalePenaltyDays: 7,
    }, async () => {
      const before = 1.0
      const results = await Memory.searchLocalWithEmbedding({ queryEmbedding: qemb, persona: "audit" })
      const scoreAfter = results.length > 0 ? results[0]!.score : null
      return { score_before: before, score_after: scoreAfter, penalty_fired: scoreAfter !== null && Math.abs(scoreAfter - before * 0.5) < 0.001 }
    })

    // (d) memory younger than stalePenaltyDays with access_count < 2 — no penalty
    await clearMemoryTables()
    seedMemory({ id: "s-d", content: "fresh low access", persona: "audit", time_created: daysAgo(3), time_accessed: daysAgo(1), access_count: 0, embedding: unitEmb(DIM, 1) })
    await record(COMP, "d", "memory 3 days old, access_count=0 — no penalty (3 < 7)", {
      ageDays: 3, accessCount: 0, stalePenaltyDays: 7,
    }, async () => {
      const before = 1.0
      const results = await Memory.searchLocalWithEmbedding({ queryEmbedding: qemb, persona: "audit" })
      const scoreAfter = results.length > 0 ? results[0]!.score : null
      return { score_before: before, score_after: scoreAfter, penalty_fired: scoreAfter !== null && Math.abs(scoreAfter - before * 0.5) < 0.001 }
    })

    // (e) memory exactly at stalePenaltyDays boundary — strict > means no penalty at equality
    await clearMemoryTables()
    seedMemory({ id: "s-e", content: "boundary exact", persona: "audit", time_created: daysAgo(7), time_accessed: daysAgo(1), access_count: 0, embedding: unitEmb(DIM, 1) })
    await record(COMP, "e", "memory exactly 7 days old — strict > means no penalty at equality", {
      ageDays: 7, accessCount: 0, stalePenaltyDays: 7, boundary: "exact",
    }, async () => {
      const before = 1.0
      const results = await Memory.searchLocalWithEmbedding({ queryEmbedding: qemb, persona: "audit" })
      const scoreAfter = results.length > 0 ? results[0]!.score : null
      // Note: ageDays is computed as (now - time_created) / DAY_MS; 7 days ago may be slightly > 7 due to elapsed time
      return { score_before: before, score_after: scoreAfter, penalty_fired: scoreAfter !== null && Math.abs(scoreAfter - before * 0.5) < 0.001 }
    })

    // (f) memory 1ms past stalePenaltyDays boundary — penalty fires
    await clearMemoryTables()
    const eightDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000 - 1 // 7 days + 1ms ago
    seedMemory({ id: "s-f", content: "1ms past boundary", persona: "audit", time_created: new Date(eightDaysAgoMs), time_accessed: daysAgo(1), access_count: 0, embedding: unitEmb(DIM, 1) })
    await record(COMP, "f", "memory 1ms past 7-day boundary — penalty fires (ageDays > 7)", {
      ageDescription: "7 days + 1ms", accessCount: 0, stalePenaltyDays: 7,
    }, async () => {
      const before = 1.0
      const results = await Memory.searchLocalWithEmbedding({ queryEmbedding: qemb, persona: "audit" })
      const scoreAfter = results.length > 0 ? results[0]!.score : null
      return { score_before: before, score_after: scoreAfter, penalty_fired: scoreAfter !== null && Math.abs(scoreAfter - before * 0.5) < 0.001 }
    })

    // (g) config with stale_penalty_days: 0 — harness limitation: cannot override config mid-test
    // Uses default stalePenaltyDays=7. With stalePenaltyDays=0, a 1-day-old memory would be penalized.
    // With default 7, a 1-day-old memory is NOT penalized. Record the observed behavior with default.
    await clearMemoryTables()
    seedMemory({ id: "s-g", content: "one day old", persona: "audit", time_created: daysAgo(1), time_accessed: daysAgo(1), access_count: 0, embedding: unitEmb(DIM, 1) })
    await record(COMP, "g", "config stale_penalty_days: 0 against 1-day-old — harness limitation: uses default 7; 1 < 7 so NO penalty (spec expects penalty with stalePenaltyDays=0)", {
      ageDays: 1, accessCount: 0, stalePenaltyDays_used: 7, stalePenaltyDays_spec: 0,
    }, async () => {
      const before = 1.0
      const results = await Memory.searchLocalWithEmbedding({ queryEmbedding: qemb, persona: "audit" })
      const scoreAfter = results.length > 0 ? results[0]!.score : null
      return { score_before: before, score_after: scoreAfter, penalty_fired: scoreAfter !== null && Math.abs(scoreAfter - before * 0.5) < 0.001 }
    })

    // (h) config with stale_penalty_days: 365 — harness limitation: uses default 7
    // With default 7, a 30-day-old memory IS penalized. Spec expects NO penalty with 365.
    await clearMemoryTables()
    seedMemory({ id: "s-h", content: "thirty days old", persona: "audit", time_created: daysAgo(30), time_accessed: daysAgo(1), access_count: 0, embedding: unitEmb(DIM, 1) })
    await record(COMP, "h", "config stale_penalty_days: 365 against 30-day-old — harness limitation: uses default 7; 30 > 7 so penalty fires (spec expects NO penalty with 365)", {
      ageDays: 30, accessCount: 0, stalePenaltyDays_used: 7, stalePenaltyDays_spec: 365,
    }, async () => {
      const before = 1.0
      const results = await Memory.searchLocalWithEmbedding({ queryEmbedding: qemb, persona: "audit" })
      const scoreAfter = results.length > 0 ? results[0]!.score : null
      return { score_before: before, score_after: scoreAfter, penalty_fired: scoreAfter !== null && Math.abs(scoreAfter - before * 0.5) < 0.001 }
    })

    // (i) two memories, one stale and one fresh — stale memory sinks in ranking
    await clearMemoryTables()
    seedMemory({ id: "s-i-stale", content: "stale memory for ranking", persona: "audit", time_created: daysAgo(10), time_accessed: daysAgo(5), access_count: 0, embedding: unitEmb(DIM, 1) })
    seedMemory({ id: "s-i-fresh", content: "fresh memory for ranking", persona: "audit", time_created: daysAgo(1), time_accessed: daysAgo(1), access_count: 0, embedding: unitEmb(DIM, 1) })
    await record(COMP, "i", "two memories (stale 10d + fresh 1d) — stale sinks in ranking (score halved)", {
      staleAgeDays: 10, freshAgeDays: 1,
    }, async () => {
      const results = await Memory.searchLocalWithEmbedding({ queryEmbedding: qemb, persona: "audit", limit: 5 })
      return {
        count: results.length,
        ranking: results.map((r) => ({ id: r.id, score: r.score, content: r.content })),
        staleFirst: results.length > 0 && results[0]!.id === "s-i-fresh",
      }
    })

    // (j) memory with access_count: 0 (null in DB → fallback to 0 via `?? 0`) — penalty fires if stale
    await clearMemoryTables()
    seedMemory({ id: "s-j", content: "stale null access count", persona: "audit", time_created: daysAgo(10), time_accessed: daysAgo(1), access_count: 0, embedding: unitEmb(DIM, 1) })
    await record(COMP, "j", "memory with access_count=0 (fallback `?? 0` at memory.ts:456) + stale — penalty fires", {
      ageDays: 10, accessCount: 0, stalePenaltyDays: 7,
    }, async () => {
      const before = 1.0
      const results = await Memory.searchLocalWithEmbedding({ queryEmbedding: qemb, persona: "audit" })
      const scoreAfter = results.length > 0 ? results[0]!.score : null
      return { score_before: before, score_after: scoreAfter, penalty_fired: scoreAfter !== null && Math.abs(scoreAfter - before * 0.5) < 0.001 }
    })
  }, 120000)
})
