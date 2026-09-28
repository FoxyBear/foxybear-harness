import { describe, test, beforeAll, afterAll } from "bun:test"
import { record, clearResults, daysAgo } from "./helpers"
import { SurrealBackend } from "../../src/memory/surreal-backend"
import { Embedding } from "../../src/memory/embedding"

const COMP = "surreal_query"

const NS = "foxybear_audit"
const DB = "query"

const DEEPINFRA: Embedding.Config = {
  provider: "deepinfra",
  model: "BAAI/bge-base-en-v1.5",
  dimensions: 768,
}

async function embed(text: string): Promise<Float32Array> {
  const r = await Embedding.embedSafe(text, DEEPINFRA)
  return r.ok ? r.value : new Float32Array(768)
}

describe("P-0 audit: SurrealBackend.query", () => {
  let backend: SurrealBackend
  let qemb: Float32Array
  let embBun: Float32Array
  let embBunTs: Float32Array
  let embTsBunBackend: Float32Array
  let embBackend: Float32Array
  let embSurrealGraph: Float32Array
  let embGraphDb: Float32Array
  let embMemory: Float32Array
  let embAll: Float32Array

  beforeAll(async () => {
    clearResults(COMP)
    // Pre-compute all embeddings to avoid async-in-sync issues
    qemb = await embed("TypeScript backend")
    embBun = await embed("Bun runtime")
    embBunTs = await embed("Bun TypeScript")
    embTsBunBackend = await embed("TypeScript Bun backend")
    embBackend = await embed("backend")
    embSurrealGraph = await embed("SurrealDB graph")
    embGraphDb = await embed("graph database")
    embMemory = await embed("memory")
    embAll = await embed("memory backend TypeScript Bun")

    backend = new SurrealBackend({ namespace: NS, database: DB })
    await backend.init()
    // Seed: memories with embeddings, entities, mentions edges
    const emb1 = await embed("TypeScript backend development preference")
    const emb2 = await embed("Bun runtime performance benchmarks")
    const emb3 = await embed("SurrealDB graph database query")
    await backend.write({ content: "User prefers TypeScript for backend development", embedding: emb1, scope: "instance", persona: "audit" })
    await backend.write({ content: "Bun runtime is faster than Node for I/O", embedding: emb2, scope: "instance", persona: "audit" })
    await backend.write({ content: "SurrealDB stores graph entities and edges", embedding: emb3, scope: "project", project_id: "proj-q", persona: "audit" })
    // Seed a global-scoped memory
    await backend.write({ content: "Global memory about graph databases", embedding: await embed("global graph database info"), scope: "global", project_id: "global", persona: "audit" })
    // Seed an entity + mentions edge by writing content with extractable entities
    // extractAndLinkEntities runs automatically inside write()
    await backend.write({ content: "We use `Bun` and `TypeScript` for the backend.", embedding: await embed("bun typescript backend"), scope: "instance", persona: "audit" })
  })

  afterAll(async () => {
    if (backend) await backend.close()
  })

  test("records observed behavior for all 10 inputs (a-j)", async () => {
    // (a) vector-only hit (semantic leg returns matches, keyword+graph empty)
    await record(COMP, "a", "vector-only hit: semantic leg matches 'TypeScript backend', keyword+graph may be empty", {
      query: "TypeScript backend", scope: "instance",
    }, () => backend.query({ query: "TypeScript backend", queryEmbedding: qemb, scope: "instance" }))

    // (b) keyword-only hit
    await record(COMP, "b", "keyword-only hit: keyword leg matches 'Bun runtime'", {
      query: "Bun runtime", scope: "instance",
    }, () => backend.query({ query: "Bun runtime", queryEmbedding: embBun, scope: "instance" }))

    // (c) graph-leg hit (1-hop co-mention via mentions)
    await record(COMP, "c", "graph-leg hit: 1-hop co-mention via mentions (entities seeded via write auto-extraction)", {
      query: "Bun TypeScript", scope: "instance",
    }, () => backend.query({ query: "Bun TypeScript", queryEmbedding: embBunTs, scope: "instance" }))

    // (d) fused three-leg result — RRF at surreal-backend.ts:261 with RRF_K=60
    await record(COMP, "d", "fused three-leg result — RRF combines ranks with RRF_K=60", {
      query: "TypeScript Bun backend", scope: "instance",
    }, () => backend.query({ query: "TypeScript Bun backend", queryEmbedding: embTsBunBackend, scope: "instance" }))

    // (e) scope: "instance"
    await record(COMP, "e", "scope: 'instance'", {
      query: "backend", scope: "instance",
    }, () => backend.query({ query: "backend", queryEmbedding: embBackend, scope: "instance" }))

    // (f) scope: "project" with project_id
    await record(COMP, "f", "scope: 'project' with project_id='proj-q'", {
      query: "SurrealDB graph", scope: "project", project_id: "proj-q",
    }, () => backend.query({ query: "SurrealDB graph", queryEmbedding: embSurrealGraph, scope: "project", project_id: "proj-q" }))

    // (g) scope: "global"
    await record(COMP, "g", "scope: 'global'", {
      query: "graph database", scope: "global",
    }, () => backend.query({ query: "graph database", queryEmbedding: embGraphDb, scope: "global" }))

    // (h) scope: "all"
    await record(COMP, "h", "scope: 'all'", {
      query: "memory", scope: "all",
    }, () => backend.query({ query: "memory", queryEmbedding: embMemory, scope: "all" }))

    // (i) as_of ISO timestamp set — temporal filter
    const asOf = daysAgo(365).toISOString()
    await record(COMP, "i", "as_of ISO timestamp set (1 year ago) — temporal filter on graph leg", {
      query: "backend", scope: "instance", as_of: asOf,
    }, () => backend.query({ query: "backend", queryEmbedding: embBackend, scope: "instance", as_of: asOf }))

    // (j) limit: 5 against matching rows — limit applied after RRF
    await record(COMP, "j", "limit: 5 against matching rows — limit applied after RRF, not before", {
      query: "memory backend TypeScript Bun", scope: "all", limit: 5,
    }, () => backend.query({ query: "memory backend TypeScript Bun", queryEmbedding: embAll, scope: "all", limit: 5 }))
  }, 180000)
})
