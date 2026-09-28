import { describe, test, beforeAll } from "bun:test"
import { record, clearResults, daysAgo } from "./helpers"
import { clearMemoryTables, seedMemory, unitEmb } from "./db"
import { AutoRecall } from "../../src/memory/recall"
import { Embedding } from "../../src/memory/embedding"
import { setGlobalMemoryBackend } from "../../src/memory/backend-registry"

const COMP = "auto_recall"

const DEEPINFRA: Embedding.Config = {
  provider: "deepinfra",
  model: "BAAI/bge-base-en-v1.5",
  dimensions: 768,
}

const OLLAMA_BAD: Embedding.Config = {
  provider: "ollama",
  model: "nonexistent-model-xyz",
  dimensions: 768,
}

describe("P-0 audit: AutoRecall.autoRecall", () => {
  beforeAll(() => {
    clearResults(COMP)
    AutoRecall.invalidateRecallConfigCache()
    setGlobalMemoryBackend(null)
  })

  test("records observed behavior for all 10 inputs (a-j)", async () => {
    // (a) query matching a stored memory
    await clearMemoryTables()
    seedMemory({ id: "ar-a", content: "The user prefers TypeScript for backend development", persona: "audit", embedding: await embed("TypeScript backend preference") })
    await record(COMP, "a", "query matching a stored memory", {
      query: "TypeScript backend", persona: "audit", sessionID: "ar-a",
    }, () => AutoRecall.autoRecall({ query: "TypeScript backend", persona: "audit", sessionID: "ar-a" }))
    AutoRecall.invalidateCache()

    // (b) query with no match
    await clearMemoryTables()
    seedMemory({ id: "ar-b", content: "The user prefers TypeScript for backend development", persona: "audit", embedding: await embed("TypeScript backend preference") })
    await record(COMP, "b", "query with no match", {
      query: "rust frontend wasm", persona: "audit", sessionID: "ar-b",
    }, () => AutoRecall.autoRecall({ query: "rust frontend wasm", persona: "audit", sessionID: "ar-b" }))
    AutoRecall.invalidateCache()

    // (c) slash-command query /help — AR-02 skip returns []
    await clearMemoryTables()
    seedMemory({ id: "ar-c", content: "some memory", persona: "audit", embedding: unitEmb(768, 1) })
    await record(COMP, "c", "slash-command query '/help' — AR-02 skip returns []", {
      query: "/help", persona: "audit", sessionID: "ar-c",
    }, () => AutoRecall.autoRecall({ query: "/help", persona: "audit", sessionID: "ar-c" }))
    AutoRecall.invalidateCache()

    // (d) same query twice in same turn — AR-03/08 cache hit (second call no re-embed)
    await clearMemoryTables()
    seedMemory({ id: "ar-d", content: "The user prefers Bun for runtime", persona: "audit", embedding: await embed("Bun runtime preference") })
    await record(COMP, "d", "same query twice in same turn — AR-03/08 cache hit (compare durations: 2nd should be faster)", {
      query: "Bun runtime", persona: "audit", sessionID: "ar-d",
    }, async () => {
      const t1 = Date.now()
      const r1 = await AutoRecall.autoRecall({ query: "Bun runtime", persona: "audit", sessionID: "ar-d" })
      const d1 = Date.now() - t1
      const t2 = Date.now()
      const r2 = await AutoRecall.autoRecall({ query: "Bun runtime", persona: "audit", sessionID: "ar-d" })
      const d2 = Date.now() - t2
      return { first: { count: r1.length, durationMs: d1 }, second: { count: r2.length, durationMs: d2 }, cacheHit: d2 < d1 / 5 }
    })
    AutoRecall.invalidateCache()

    // (e) embedding provider failure — AR-07 graceful degradation returns []
    await clearMemoryTables()
    seedMemory({ id: "ar-e", content: "some memory", persona: "audit", embedding: unitEmb(768, 1) })
    await record(COMP, "e", "embedding provider failure (ollama with bad model) — AR-07 graceful degradation returns []", {
      query: "test query", persona: "audit", sessionID: "ar-e", embeddingConfig: OLLAMA_BAD,
    }, () => AutoRecall.autoRecall({ query: "test query", persona: "audit", sessionID: "ar-e", embeddingConfig: OLLAMA_BAD }))
    AutoRecall.invalidateCache()

    // (f) workforceUrl set against unreachable endpoint — AR-11 graceful degradation returns local only
    await clearMemoryTables()
    seedMemory({ id: "ar-f", content: "local memory for workforce test", persona: "audit", embedding: await embed("local memory content") })
    await record(COMP, "f", "workforceUrl set against unreachable endpoint (http://localhost:1) — AR-11 returns local only", {
      query: "local memory", persona: "audit", sessionID: "ar-f", workforceUrl: "http://localhost:1",
    }, () => AutoRecall.autoRecall({ query: "local memory", persona: "audit", sessionID: "ar-f", workforceUrl: "http://localhost:1" }))
    AutoRecall.invalidateCache()

    // (g) workforceUrl set against a reachable endpoint returning results — AR-10/12 merged + deduped
    // Start a minimal local workforce mock server (real HTTP, not a code mock)
    const server = startWorkforceServer()
    await clearMemoryTables()
    seedMemory({ id: "ar-g", content: "local memory for merge test", persona: "audit", embedding: await embed("local memory content") })
    await record(COMP, "g", "workforceUrl set against reachable endpoint returning results — AR-10/12 merged + deduped", {
      query: "memory content", persona: "audit", sessionID: "ar-g", workforceUrl: `http://localhost:${server.port}`,
    }, () => AutoRecall.autoRecall({ query: "memory content", persona: "audit", sessionID: "ar-g", workforceUrl: `http://localhost:${server.port}` }))
    AutoRecall.invalidateCache()
    server.close()

    // (h) project_id set with no project-scoped memories — global scope fallback
    await clearMemoryTables()
    seedMemory({ id: "ar-h", content: "global scoped memory", persona: "audit", project_id: "global", embedding: await embed("global memory") })
    await record(COMP, "h", "project_id set with no project-scoped memories — global scope fallback", {
      query: "global memory", persona: "audit", sessionID: "ar-h", project_id: "no-such-project",
    }, () => AutoRecall.autoRecall({ query: "global memory", persona: "audit", sessionID: "ar-h", project_id: "no-such-project" }))
    AutoRecall.invalidateCache()

    // (i) project_id set with project-scoped memories
    await clearMemoryTables()
    seedMemory({ id: "ar-i", content: "project scoped memory", persona: "audit", project_id: "proj-i", embedding: await embed("project memory content") })
    await record(COMP, "i", "project_id set with project-scoped memories", {
      query: "project memory", persona: "audit", sessionID: "ar-i", project_id: "proj-i",
    }, () => AutoRecall.autoRecall({ query: "project memory", persona: "audit", sessionID: "ar-i", project_id: "proj-i" }))
    AutoRecall.invalidateCache()

    // (j) requestor_elevated: true — forward-compat log line, no behavioral effect
    await clearMemoryTables()
    seedMemory({ id: "ar-j", content: "memory for elevated test", persona: "audit", embedding: await embed("elevated memory content") })
    await record(COMP, "j", "requestor_elevated: true — forward-compat log line at recall.ts:194, no behavioral effect", {
      query: "elevated memory", persona: "audit", sessionID: "ar-j", requestor_elevated: true,
    }, () => AutoRecall.autoRecall({ query: "elevated memory", persona: "audit", sessionID: "ar-j", requestor_elevated: true }))
    AutoRecall.invalidateCache()
  }, 180000)
})

async function embed(text: string): Promise<Float32Array> {
  const r = await Embedding.embedSafe(text, DEEPINFRA)
  return r.ok ? r.value : unitEmb(768, 1)
}

function startWorkforceServer(): { port: number; close: () => void } {
  // Real HTTP server returning canned results — not a code mock of the implementation under test
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { query: string; persona: string; limit?: number }
      return Response.json({
        results: [
          { content: "workforce memory: " + body.query, score: 0.85, metadata: { source: "workforce" } },
        ],
      })
    },
  })
  return { port: server.port ?? 0, close: () => server.stop(true) }
}
