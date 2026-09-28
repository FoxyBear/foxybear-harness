import { describe, test, beforeAll, afterAll } from "bun:test"
import { record, clearResults, daysAgo } from "./helpers"
import { clearMemoryTables, seedMemory, readMemoryRows } from "./db"
import { Memory } from "../../src/memory/memory"
import { setGlobalMemoryBackend } from "../../src/memory/backend-registry"
import { SurrealBackend } from "../../src/memory/surreal-backend"
import { Embedding } from "../../src/memory/embedding"

const COMP = "prunable"

const NS = "foxybear_audit"
const DB = "prunable"

const DEEPINFRA: Embedding.Config = {
  provider: "deepinfra",
  model: "BAAI/bge-base-en-v1.5",
  dimensions: 768,
}

describe("P-0 audit: Memory.getPrunable", () => {
  let surrealBackend: SurrealBackend

  beforeAll(async () => {
    clearResults(COMP)
    Memory.invalidateConfigCache()
    setGlobalMemoryBackend(null)
    surrealBackend = new SurrealBackend({ namespace: NS, database: DB })
    await surrealBackend.init()
  })

  afterAll(async () => {
    setGlobalMemoryBackend(null)
    if (surrealBackend) await surrealBackend.close()
  })

  test("records observed behavior for all 10 inputs (a-j)", async () => {
    // (a) ttl_days: 90 against rows all younger than 90 days — returns []
    await clearMemoryTables()
    seedMemory({ id: "p-a1", content: "young memory 1", persona: "audit", time_accessed: daysAgo(1) })
    seedMemory({ id: "p-a2", content: "young memory 2", persona: "audit", time_accessed: daysAgo(10) })
    await record(COMP, "a", "ttl_days: 90 against rows all younger than 90 days — returns []", {
      ttl_days: 90,
    }, () => Memory.getPrunable({ ttl_days: 90 }))

    // (b) ttl_days: 90 against one row 91 days old by accessed_at — returns that row
    await clearMemoryTables()
    seedMemory({ id: "p-b1", content: "young memory", persona: "audit", time_accessed: daysAgo(1) })
    seedMemory({ id: "p-b2", content: "old memory 91 days", persona: "audit", time_accessed: daysAgo(91) })
    await record(COMP, "b", "ttl_days: 90 against one row 91 days old — returns that row", {
      ttl_days: 90,
    }, async () => {
      const res = await Memory.getPrunable({ ttl_days: 90 })
      return { count: res.length, ids: res.map((r) => r.id) }
    })

    // (c) ttl_days: 0 — all rows prunable (cutoff = now)
    await clearMemoryTables()
    seedMemory({ id: "p-c1", content: "memory 1", persona: "audit", time_accessed: daysAgo(1) })
    seedMemory({ id: "p-c2", content: "memory 2", persona: "audit", time_accessed: daysAgo(50) })
    await record(COMP, "c", "ttl_days: 0 — all rows prunable (cutoff = now)", {
      ttl_days: 0,
    }, async () => {
      const res = await Memory.getPrunable({ ttl_days: 0 })
      return { count: res.length, ids: res.map((r) => r.id) }
    })

    // (d) ttl_days: 36500 (100 years) — no rows prunable
    await clearMemoryTables()
    seedMemory({ id: "p-d1", content: "memory 1", persona: "audit", time_accessed: daysAgo(1) })
    await record(COMP, "d", "ttl_days: 36500 (100 years) — no rows prunable", {
      ttl_days: 36500,
    }, () => Memory.getPrunable({ ttl_days: 36500 }))

    // (e) config with no ttl_days set — falls back to cfg.ttlDays (default 90)
    await clearMemoryTables()
    seedMemory({ id: "p-e1", content: "young memory", persona: "audit", time_accessed: daysAgo(1) })
    seedMemory({ id: "p-e2", content: "old memory 91 days", persona: "audit", time_accessed: daysAgo(91) })
    await record(COMP, "e", "no ttl_days arg — falls back to cfg.ttlDays (default 90)", {
      ttl_days: undefined,
    }, async () => {
      const res = await Memory.getPrunable()
      return { count: res.length, ids: res.map((r) => r.id) }
    })

    // (f) row with accessed_at: 0 (Date epoch) — Number(0) < cutoff → prunable
    await clearMemoryTables()
    seedMemory({ id: "p-f1", content: "epoch zero accessed", persona: "audit", time_accessed: new Date(0) })
    await record(COMP, "f", "row with accessed_at: 0 (epoch) — 0 < cutoff → prunable", {
      ttl_days: 90, accessed_at: 0,
    }, async () => {
      const res = await Memory.getPrunable({ ttl_days: 90 })
      return { count: res.length, ids: res.map((r) => r.id) }
    })

    // (g) row with accessed_at: null — SQL NULL < cutoff is NULL (not true) → NOT prunable
    await clearMemoryTables()
    seedMemory({ id: "p-g1", content: "null accessed memory", persona: "audit", time_accessed: null })
    await record(COMP, "g", "row with accessed_at: null — SQL NULL < cutoff is NULL → NOT prunable (spec expected prunable via coercion to 0)", {
      ttl_days: 90, accessed_at: null,
    }, async () => {
      const res = await Memory.getPrunable({ ttl_days: 90 })
      return { count: res.length, ids: res.map((r) => r.id) }
    })

    // (h) SurrealBackend registered as global backend — dispatch at memory.ts:761-765
    setGlobalMemoryBackend(surrealBackend)
    await surrealBackend.write({ content: "surreal old memory", embedding: await embed("old memory"), scope: "instance", persona: "audit", created_at: daysAgo(91).toISOString() })
    await record(COMP, "h", "SurrealBackend registered — dispatch hits backend.getPrunable(ttl)", {
      ttl_days: 90, backend: "surreal",
    }, async () => {
      const res = await Memory.getPrunable({ ttl_days: 90 })
      return { count: res.length, ids: res.map((r) => ({ id: r.id, scope: r.scope })) }
    })
    setGlobalMemoryBackend(null)

    // (i) no global backend registered — legacy SQLite path at memory.ts:767-778
    await clearMemoryTables()
    seedMemory({ id: "p-i1", content: "sqlite old memory", persona: "audit", time_accessed: daysAgo(91) })
    await record(COMP, "i", "no global backend — legacy SQLite path at memory.ts:767-778", {
      ttl_days: 90, backend: "sqlite-legacy",
    }, async () => {
      const res = await Memory.getPrunable({ ttl_days: 90 })
      return { count: res.length, ids: res.map((r) => r.id) }
    })

    // (j) ttl_days: 7 against rows 8 days old
    await clearMemoryTables()
    seedMemory({ id: "p-j1", content: "8 day old memory", persona: "audit", time_accessed: daysAgo(8) })
    seedMemory({ id: "p-j2", content: "5 day old memory", persona: "audit", time_accessed: daysAgo(5) })
    await record(COMP, "j", "ttl_days: 7 against rows 8 days old — only 8-day row prunable", {
      ttl_days: 7,
    }, async () => {
      const res = await Memory.getPrunable({ ttl_days: 7 })
      return { count: res.length, ids: res.map((r) => r.id) }
    })

    // Record final SQLite row state for reference
    await record(COMP, "final-state", "final SQLite memory_topics state", {
      rows: readMemoryRows().length,
    }, () => readMemoryRows().length)
  }, 120000)
})

async function embed(text: string): Promise<Float32Array> {
  const r = await Embedding.embedSafe(text, DEEPINFRA)
  return r.ok ? r.value : new Float32Array(768)
}
