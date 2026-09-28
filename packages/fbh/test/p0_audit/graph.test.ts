import { describe, test, beforeAll, afterAll } from "bun:test"
import { record, clearResults } from "./helpers"
import { SurrealGraphBackend } from "../../src/memory/graph/surreal-backend"
import { Embedding } from "../../src/memory/embedding"

const COMP = "graph"

const NS = "foxybear_audit"
const DB = "graph"

const DEEPINFRA: Embedding.Config = {
  provider: "deepinfra",
  model: "BAAI/bge-base-en-v1.5",
  dimensions: 768,
}

describe("P-0 audit: SurrealGraphBackend", () => {
  let backend: SurrealGraphBackend

  beforeAll(async () => {
    clearResults(COMP)
    backend = new SurrealGraphBackend({ namespace: NS, database: DB })
    await backend.init()
    await backend._reset()
  })

  afterAll(async () => {
    if (backend) {
      await backend._reset()
      await backend.close()
    }
  })

  test("records observed behavior for all 10 inputs (a-j)", async () => {
    const emb = await embed("test entity content")

    // (a) upsertEntity for a new entity
    await record(COMP, "a", "upsertEntity for a new entity 'TypeScript'", {
      name: "TypeScript", entity_type: "tool", content: "TypeScript programming language", project_id: "audit",
    }, () => backend.upsertEntity({ name: "TypeScript", entity_type: "tool", content: "TypeScript programming language", project_id: "audit", embedding: emb }))

    // (b) upsertEntity for an existing entity by name — preserves valid_from
    const firstEntity = await backend.upsertEntity({ name: "Bun", entity_type: "tool", content: "Bun runtime v1", project_id: "audit", embedding: emb })
    const firstValidFrom = firstEntity.valid_from
    await new Promise((r) => setTimeout(r, 10))
    await record(COMP, "b", "upsertEntity for existing entity 'Bun' — preserves valid_from (SG-01)", {
      name: "Bun", entity_type: "tool", content: "Bun runtime v2 updated", project_id: "audit",
      firstValidFrom,
    }, async () => {
      const updated = await backend.upsertEntity({ name: "Bun", entity_type: "tool", content: "Bun runtime v2 updated", project_id: "audit", embedding: emb })
      return { ...updated, validFromPreserved: updated.valid_from === firstValidFrom, firstValidFrom, secondValidFrom: updated.valid_from }
    })

    // (c) findEntitiesByName with a match
    await record(COMP, "c", "findEntitiesByName 'TypeScript' with match", {
      name: "TypeScript", project_id: "audit",
    }, () => backend.findEntitiesByName("TypeScript", "audit"))

    // (d) findEntitiesByName with no match
    await record(COMP, "d", "findEntitiesByName 'NonExistent' with no match", {
      name: "NonExistent", project_id: "audit",
    }, () => backend.findEntitiesByName("NonExistent", "audit"))

    // (e) searchEntities with an embedding query — cosine ranking
    await record(COMP, "e", "searchEntities with embedding query — cosine ranking", {
      embedding: emb, project_id: "audit", limit: 10,
    }, () => backend.searchEntities({ embedding: emb, project_id: "audit", limit: 10 }))

    // (f) addEdge between two existing entities
    const tsEntity = await backend.findEntitiesByName("TypeScript", "audit")
    const bunEntity = await backend.findEntitiesByName("Bun", "audit")
    await record(COMP, "f", "addEdge between TypeScript and Bun (USED_WITH)", {
      source_id: tsEntity[0]?.id, target_id: bunEntity[0]?.id, edge_type: "USED_WITH", project_id: "audit",
    }, () => backend.addEdge({
      source_id: tsEntity[0]?.id ?? "", target_id: bunEntity[0]?.id ?? "",
      edge_type: "USED_WITH", project_id: "audit", valid_from: Date.now(),
    }))

    // (g) invalidateEdge setting invalid_from — bi-temporal soft-delete
    const edgesFromTs = await backend.getEdgesFrom(tsEntity[0]?.id ?? "")
    const edgeToInvalidate = edgesFromTs[0]
    await record(COMP, "g", "invalidateEdge — sets invalid_from (bi-temporal soft-delete)", {
      edge_id: edgeToInvalidate?.id, invalid_from: Date.now(),
    }, async () => {
      await backend.invalidateEdge(edgeToInvalidate?.id ?? "", Date.now())
      const after = await backend.getEdgesFrom(tsEntity[0]?.id ?? "")
      return { invalidated: true, edgesBefore: edgesFromTs.length, edgesAfterValidOnly: after.length }
    })

    // (h) getEdgesFrom with valid_only: true — excludes invalidated edges
    await record(COMP, "h", "getEdgesFrom with valid_only: true — excludes invalidated edges", {
      entity_id: tsEntity[0]?.id, valid_only: true,
    }, () => backend.getEdgesFrom(tsEntity[0]?.id ?? "", { valid_only: true }))

    // (i) traverse with max_hops: 2 over a seeded 3-entity chain
    // Seed a 3-entity chain: A -> B -> C
    const a = await backend.upsertEntity({ name: "ChainA", entity_type: "concept", content: "chain A", project_id: "trav" })
    const b = await backend.upsertEntity({ name: "ChainB", entity_type: "concept", content: "chain B", project_id: "trav" })
    const c = await backend.upsertEntity({ name: "ChainC", entity_type: "concept", content: "chain C", project_id: "trav" })
    await backend.addEdge({ source_id: a.id, target_id: b.id, edge_type: "RELATES_TO", project_id: "trav", valid_from: Date.now() })
    await backend.addEdge({ source_id: b.id, target_id: c.id, edge_type: "RELATES_TO", project_id: "trav", valid_from: Date.now() })
    await record(COMP, "i", "traverse max_hops: 2 over seeded 3-entity chain (A->B->C)", {
      start_id: a.id, max_hops: 2, project_id: "trav",
    }, () => backend.traverse({ start_id: a.id, max_hops: 2 }))

    // (j) query with both embedding and keyword
    await record(COMP, "j", "query with both embedding and keyword", {
      project_id: "audit", embedding: emb, keyword: "TypeScript", limit: 10,
    }, () => backend.query({ project_id: "audit", embedding: emb, keyword: "TypeScript", limit: 10 }))

    // Record healthy() after init
    await record(COMP, "healthy", "healthy() returns true after init()", {
      backend: "SurrealGraphBackend",
    }, () => backend.healthy())
  }, 120000)
})

async function embed(text: string): Promise<Float32Array> {
  const r = await Embedding.embedSafe(text, DEEPINFRA)
  return r.ok ? r.value : new Float32Array(768)
}
