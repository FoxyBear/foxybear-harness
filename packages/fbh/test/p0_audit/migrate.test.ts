import { describe, test, beforeAll, afterAll } from "bun:test"
import { record, clearResults, daysAgo } from "./helpers"
import { clearMemoryTables, seedMemory, seedGraphEntity, seedGraphEdge, readMainDbMemories, unitEmb } from "./db"
import { SurrealBackend } from "../../src/memory/surreal-backend"
import { Global } from "../../src/global"
import { existsSync, unlinkSync } from "fs"
import { join } from "path"
import { sql } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { MemoryTopicsTable } from "../../src/memory/memory.sql"
import { float32ToBuffer } from "../../src/memory/memory"

const COMP = "migrate"

const NS = "foxybear_audit"
const DB = "migrate"

function markerPath(): string {
  return join(Global.Path.data, "memory-migration-surreal.json")
}

function deleteMarker(): void {
  const p = markerPath()
  if (existsSync(p)) {
    try { unlinkSync(p) } catch {}
  }
}

function markerExists(): boolean {
  return existsSync(markerPath())
}

async function surrealCounts(backend: SurrealBackend): Promise<{ memories: number; entities: number; edges: number }> {
  const memRows = await backend.run(`SELECT count() AS c FROM memory GROUP ALL;`).catch(() => [] as unknown[])
  const entRows = await backend.run(`SELECT count() AS c FROM entity GROUP ALL;`).catch(() => [] as unknown[])
  const relRows = await backend.run(`SELECT count() AS c FROM relates GROUP ALL;`).catch(() => [] as unknown[])
  const num = (rows: unknown): number => {
    if (Array.isArray(rows) && rows.length > 0) {
      const first = rows[0] as { c?: number } | undefined
      return Number(first?.c ?? 0)
    }
    return 0
  }
  return { memories: num(memRows), entities: num(entRows), edges: num(relRows) }
}

async function cleanSurreal(backend: SurrealBackend): Promise<void> {
  await backend.run(`DELETE mentions;`).catch(() => {})
  await backend.run(`DELETE supersedes;`).catch(() => {})
  await backend.run(`DELETE relates;`).catch(() => {})
  await backend.run(`DELETE entity;`).catch(() => {})
  await backend.run(`DELETE memory;`).catch(() => {})
}

describe("P-0 audit: SurrealBackend.migrateFromSqlite", () => {
  let backend: SurrealBackend

  beforeAll(async () => {
    clearResults(COMP)
    deleteMarker()
    backend = new SurrealBackend({ namespace: NS, database: DB })
    await backend.init()
    await cleanSurreal(backend)
  })

  afterAll(async () => {
    deleteMarker()
    if (backend) await backend.close()
  })

  test("records observed behavior for all 10 inputs (a-j)", async () => {
    // (a) fresh state, marker absent, 0 SQLite rows — ran: true, memories: 0
    await clearMemoryTables()
    deleteMarker()
    await cleanSurreal(backend)
    await record(COMP, "a", "fresh state: marker absent, 0 SQLite rows — ran: true, creates marker", {
      markerAbsent: true, sqliteRows: 0,
    }, async () => {
      const report = await backend.migrateFromSqlite()
      return { report, markerCreated: markerExists(), surrealCounts: await surrealCounts(backend) }
    })

    // (b) marker present — ran: false (idempotent)
    await clearMemoryTables()
    seedMemory({ id: "m-b1", content: "memory that should not migrate", persona: "audit" })
    // Marker should exist from input (a); ensure it exists
    if (!markerExists()) {
      // Run migration to create marker, then re-seed
      await backend.migrateFromSqlite()
    }
    await record(COMP, "b", "marker present — ran: false at surreal-backend.ts:386 (idempotent)", {
      markerPresent: markerExists(),
    }, async () => {
      const report = await backend.migrateFromSqlite()
      return { report, markerExists: markerExists() }
    })

    // (c) marker absent with 1 SQLite memory row (Phase A rebrand memory)
    await clearMemoryTables()
    deleteMarker()
    await cleanSurreal(backend)
    const mainRows = readMainDbMemories()
    if (mainRows.length > 0) {
      const rebrand = mainRows[0]!
      Database.use((db) => {
        db.insert(MemoryTopicsTable).values({
          id: rebrand.id,
          content: rebrand.content,
          embedding: Buffer.from(rebrand.embedding ?? Buffer.alloc(0)),
          persona: rebrand.persona,
          scope: rebrand.scope ?? "general",
          project_id: rebrand.project_id,
          access_count: rebrand.access_count ?? 0,
          metadata: (rebrand.metadata as never) ?? null,
        }).run()
      })
    } else {
      seedMemory({ id: "m-c1", content: "Phase A rebrand memory (fallback seed)", persona: "audit" })
    }
    await record(COMP, "c", "marker absent with 1 SQLite memory row (Phase A rebrand memory) — migrates to Surreal memory table", {
      markerAbsent: true, sqliteMemories: 1,
    }, async () => {
      const report = await backend.migrateFromSqlite()
      return { report, markerCreated: markerExists(), surrealCounts: await surrealCounts(backend) }
    })

    // (d) marker absent with 1 memory row whose embedding is a Buffer — bufferToFloat32 at surreal-backend.ts:407
    await clearMemoryTables()
    deleteMarker()
    await cleanSurreal(backend)
    seedMemory({ id: "m-d1", content: "buffer embedding memory", persona: "audit", embedding: unitEmb(768, 1) })
    await record(COMP, "d", "marker absent, memory with Buffer embedding — bufferToFloat32 roundtrips", {
      embeddingType: "Buffer",
    }, async () => {
      const report = await backend.migrateFromSqlite()
      return { report, markerCreated: markerExists(), surrealCounts: await surrealCounts(backend) }
    })

    // (e) marker absent with 1 memory row whose embedding is empty Buffer (null case — column is NOT NULL)
    await clearMemoryTables()
    deleteMarker()
    await cleanSurreal(backend)
    Database.use((db) => {
      db.insert(MemoryTopicsTable).values({
        id: "m-e1",
        content: "empty buffer embedding memory",
        embedding: Buffer.alloc(0),
        persona: "audit",
        project_id: "global",
        access_count: 0,
      }).run()
    })
    await record(COMP, "e", "marker absent, memory with empty Buffer embedding (column NOT NULL; spec 'null' approximated by empty Buffer) — bufferToFloat32(Buffer.alloc(0))", {
      embeddingType: "empty-Buffer",
    }, async () => {
      const report = await backend.migrateFromSqlite()
      return { report, markerCreated: markerExists(), surrealCounts: await surrealCounts(backend) }
    })

    // (f) marker absent with project_id: "global" memory row — scope: "global" mapping
    await clearMemoryTables()
    deleteMarker()
    await cleanSurreal(backend)
    seedMemory({ id: "m-f1", content: "global scoped memory", persona: "audit", project_id: "global" })
    await record(COMP, "f", "marker absent, project_id='global' memory — scope: 'global' mapping at surreal-backend.ts:411", {
      project_id: "global",
    }, async () => {
      const report = await backend.migrateFromSqlite()
      const scopeRows = await backend.run(`SELECT scope FROM memory LIMIT 5;`).catch(() => [] as unknown[])
      return { report, markerCreated: markerExists(), surrealCounts: await surrealCounts(backend), scopes: scopeRows }
    })

    // (g) marker absent with project-scoped memory row — scope: "project" mapping
    await clearMemoryTables()
    deleteMarker()
    await cleanSurreal(backend)
    seedMemory({ id: "m-g1", content: "project scoped memory", persona: "audit", project_id: "my-project" })
    await record(COMP, "g", "marker absent, project-scoped memory — scope: 'project' mapping", {
      project_id: "my-project",
    }, async () => {
      const report = await backend.migrateFromSqlite()
      const scopeRows = await backend.run(`SELECT scope, project_id FROM memory LIMIT 5;`).catch(() => [] as unknown[])
      return { report, markerCreated: markerExists(), surrealCounts: await surrealCounts(backend), rows: scopeRows }
    })

    // (h) marker absent with 1 entity row — entity:⟨id⟩ creation with angle-bracket ULID escape
    await clearMemoryTables()
    deleteMarker()
    await cleanSurreal(backend)
    seedGraphEntity({
      id: "01ENTITY0TEST", name: "TestEntity", entity_type: "concept", content: "test entity content",
      valid_from: Date.now(),
    })
    await record(COMP, "h", "marker absent, 1 entity row — entity:⟨id⟩ creation with angle-bracket ULID escape at surreal-backend.ts:451", {
      entityRows: 1,
    }, async () => {
      const report = await backend.migrateFromSqlite()
      return { report, markerCreated: markerExists(), surrealCounts: await surrealCounts(backend) }
    })

    // (i) marker absent with 1 edge row — RELATE query at surreal-backend.ts:463
    await clearMemoryTables()
    deleteMarker()
    await cleanSurreal(backend)
    seedGraphEntity({ id: "01SRCENTITY0", name: "SrcEntity", entity_type: "concept", content: "source entity", valid_from: Date.now() })
    seedGraphEntity({ id: "01TGTENTITY0", name: "TgtEntity", entity_type: "concept", content: "target entity", valid_from: Date.now() })
    seedGraphEdge({ id: "01EDGE0TEST", source_id: "01SRCENTITY0", target_id: "01TGTENTITY0", edge_type: "RELATES_TO", valid_from: Date.now() })
    await record(COMP, "i", "marker absent, 1 edge row — RELATE query at surreal-backend.ts:463", {
      edgeRows: 1, entityRows: 2,
    }, async () => {
      const report = await backend.migrateFromSqlite()
      return { report, markerCreated: markerExists(), surrealCounts: await surrealCounts(backend) }
    })

    // (j) marker absent with memory row whose time_created is null — column is NOT NULL, cannot insert null
    // Use time_created = 0 (epoch) instead; (m as any).time_created != null → true → new Date(0).toISOString()
    await clearMemoryTables()
    deleteMarker()
    await cleanSurreal(backend)
    Database.use((db) => {
      db.insert(MemoryTopicsTable).values({
        id: "m-j1",
        content: "epoch time_created memory",
        embedding: float32ToBuffer(unitEmb(768, 1)),
        persona: "audit",
        project_id: "global",
        access_count: 0,
        time_accessed: daysAgo(1),
      }).run()
    })
    // Update time_created to 0 via raw SQL (drizzle default is Date.now())
    Database.use((db) => {
      db.update(MemoryTopicsTable).set({ time_created: 0 } as never).where(sql`${MemoryTopicsTable.id} = 'm-j1'`).run()
    })
    await record(COMP, "j", "marker absent, memory with time_created=0 (column NOT NULL; spec 'null' approximated by 0) — new Date(0).toISOString() fallback at surreal-backend.ts:425", {
      time_created: 0,
    }, async () => {
      const report = await backend.migrateFromSqlite()
      const createdRows = await backend.run(`SELECT created_at FROM memory WHERE content = 'epoch time_created memory' LIMIT 1;`).catch(() => [] as unknown[])
      return { report, markerCreated: markerExists(), surrealCounts: await surrealCounts(backend), created_at: createdRows }
    })
  }, 180000)
})
