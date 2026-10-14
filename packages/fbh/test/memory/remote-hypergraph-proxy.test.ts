import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const SRC = join(import.meta.dir, "..", "..", "src")

describe("boot gate (serve.ts)", () => {
  test("uses global config, not isMemoryEnabled(), for hypergraph registration", () => {
    const src = readFileSync(join(SRC, "cli", "cmd", "serve.ts"), "utf-8")
    expect(src).not.toMatch(/isMemoryEnabled/)
    expect(src).toMatch(/config\?\.memory\?\.enabled === true/)
  })

  test("does not contain migration or backfill code", () => {
    const src = readFileSync(join(SRC, "cli", "cmd", "serve.ts"), "utf-8")
    expect(src).not.toMatch(/migrateFromSqlite/)
    expect(src).not.toMatch(/backfill/)
    expect(src).not.toMatch(/backupBeforeMigrate/)
    expect(src).not.toMatch(/checkAbortA1/)
  })
})

describe("HypergraphBackend interface", () => {
  test("backend-registry returns HypergraphBackend type, not SurrealHypergraphBackend", () => {
    const src = readFileSync(join(SRC, "memory", "backend-registry.ts"), "utf-8")
    expect(src).toMatch(/import type \{ HypergraphBackend \}/)
    expect(src).not.toMatch(/import type \{ SurrealHypergraphBackend \}/)
    expect(src).toMatch(/HypergraphBackend \| null/)
  })
})

describe("RemoteHypergraphBackend", () => {
  test("implements store, edge, and searchMemoryNodes as POST calls", () => {
    const src = readFileSync(join(SRC, "memory", "remote-hypergraph-backend.ts"), "utf-8")
    expect(src).toMatch(/\/memory\/hypergraph\/store/)
    expect(src).toMatch(/\/memory\/hypergraph\/edge/)
    expect(src).toMatch(/\/memory\/hypergraph\/search/)
  })

  test("serializes Float32Array embedding to plain array for JSON transport", () => {
    const src = readFileSync(join(SRC, "memory", "remote-hypergraph-backend.ts"), "utf-8")
    expect(src).toMatch(/Array\.from\(node\.embedding\)/)
    expect(src).toMatch(/Array\.from\(e\.embedding\)/)
  })

  test("daemon-only methods return empty results without throwing", async () => {
    const { RemoteHypergraphBackend } = await import("../../src/memory/remote-hypergraph-backend")
    const proxy = new RemoteHypergraphBackend("http://127.0.0.1:99999")

    expect(await proxy.query([], "test")).toEqual([])
    expect(await proxy.expand([], "test", 1)).toEqual({ nodes: [], hyperedges: [] })
    // searchMemoryNodes is proxied (not stubbed), but will fail on unreachable host — tested via source assertions above
    expect(await proxy.buildAdjacency()).toEqual({ node_count: 0, edge_count: 0 })
    expect(await proxy.getNode("x")).toBeNull()
    expect(await proxy.findMemoryNeighbor(new Float32Array(0), "test")).toBeNull()
    expect(await proxy.listLiveNodes([], 0)).toEqual([])
    expect(await proxy.listArchivedPastRetention(30, 0)).toEqual([])

    // void methods — should not throw
    await proxy.closeVersion("x", 0)
    await proxy.appendEvent({ event_type: "test", target_id: "x", target_type: "node" })
    await proxy.softDelete("x", null, 0)
    await proxy.deleteNode("x")
    await proxy.incrementUsage("x", 0)
    await proxy.updateNodeFields("x", {})
  })

  test("healthy() returns false before init", () => {
    const { RemoteHypergraphBackend } = require("../../src/memory/remote-hypergraph-backend")
    const proxy = new RemoteHypergraphBackend("http://127.0.0.1:99999")
    expect(proxy.healthy()).toBe(false)
  })
})

describe("daemon routes", () => {
  test("routes.ts exposes hypergraph health, store, edge, and search endpoints", () => {
    const src = readFileSync(join(SRC, "daemon", "routes.ts"), "utf-8")
    expect(src).toMatch(/\/memory\/hypergraph\/health/)
    expect(src).toMatch(/\/memory\/hypergraph\/store/)
    expect(src).toMatch(/\/memory\/hypergraph\/edge/)
    expect(src).toMatch(/\/memory\/hypergraph\/search/)
  })

  test("store route deserializes embedding from number[] to Float32Array", () => {
    const src = readFileSync(join(SRC, "daemon", "routes.ts"), "utf-8")
    expect(src).toMatch(/new Float32Array\(body\.embedding\)/)
  })
})

describe("recall direct HNSW search", () => {
  test("recallImpl uses searchMemoryNodes directly, not seeded traversal", () => {
    const src = readFileSync(join(SRC, "memory", "memory.ts"), "utf-8")
    expect(src).toMatch(/hyper\.searchMemoryNodes\(queryEmbedding/)
    expect(src).not.toMatch(/seeds\.length > 0/)
    expect(src).not.toMatch(/hyper\.query\(seeds/)
  })
})

describe("session init wiring", () => {
  test("init.ts registers RemoteHypergraphBackend when daemon is reachable", () => {
    const src = readFileSync(join(SRC, "memory", "init.ts"), "utf-8")
    expect(src).toMatch(/RemoteHypergraphBackend/)
    expect(src).toMatch(/setGlobalHypergraphBackend/)
    expect(src).toMatch(/hyper\.init\(\)/)
  })
})
