import { join } from "path"
import { Database } from "../../src/storage/db"
import { MemoryTopicsTable, MemoryIndexTable, GraphEntityTable, GraphEdgeTable } from "../../src/memory/memory.sql"
import { float32ToBuffer } from "../../src/memory/memory"
import { sql } from "drizzle-orm"

export interface SeedMemory {
  id: string
  content: string
  persona?: string
  scope?: string
  project_id?: string
  access_count?: number
  time_created?: Date
  time_accessed?: Date | null
  embedding?: Float32Array
  metadata?: unknown
}

export function clearMemoryTables(): void {
  Database.use((db) => {
    db.delete(GraphEdgeTable).run()
    db.delete(GraphEntityTable).run()
    db.delete(MemoryIndexTable).run()
    db.delete(MemoryTopicsTable).run()
  })
}

export function clearIndexTable(): void {
  Database.use((db) => {
    db.delete(MemoryIndexTable).run()
  })
}

export function seedMemory(s: SeedMemory): void {
  const emb = s.embedding ?? unitEmb(768, 1)
  Database.use((db) => {
    db.insert(MemoryTopicsTable)
      .values({
        id: s.id,
        content: s.content,
        embedding: float32ToBuffer(emb),
        persona: s.persona ?? "default",
        scope: s.scope ?? "general",
        project_id: s.project_id ?? "global",
        access_count: s.access_count ?? 0,
        metadata: (s.metadata as never) ?? null,
        time_accessed: s.time_accessed === undefined ? new Date() : s.time_accessed,
      })
      .run()
  })
  if (s.time_created) {
    Database.use((db) => {
      db.update(MemoryTopicsTable)
        .set({ time_created: s.time_created!.getTime() } as never)
        .where(sql`${MemoryTopicsTable.id} = ${s.id}`)
        .run()
    })
  }
}

export function seedIndexRow(r: {
  id: string
  key?: string
  pointer?: string
  summary?: string
  access_count?: number
  time_created?: number
}): void {
  Database.use((db) => {
    db.insert(MemoryIndexTable)
      .values({
        id: r.id,
        key: r.key ?? `key-${r.id}`,
        pointer: r.pointer ?? `ptr-${r.id}`,
        summary: r.summary ?? `sum-${r.id}`,
        access_count: r.access_count ?? 0,
      })
      .run()
  })
  if (r.time_created !== undefined) {
    Database.use((db) => {
      db.update(MemoryIndexTable)
        .set({ time_created: r.time_created, time_updated: r.time_created } as never)
        .where(sql`${MemoryIndexTable.id} = ${r.id}`)
        .run()
    })
  }
}

export function seedGraphEntity(r: {
  id: string
  name: string
  entity_type: string
  content: string
  project_id?: string
  valid_from: number
  invalid_from?: number | null
  embedding?: Float32Array
  metadata?: unknown
}): void {
  const emb = r.embedding ? float32ToBuffer(r.embedding) : null
  Database.use((db) => {
    db.insert(GraphEntityTable)
      .values({
        id: r.id,
        name: r.name,
        entity_type: r.entity_type,
        content: r.content,
        project_id: r.project_id ?? "global",
        valid_from: r.valid_from,
        invalid_from: r.invalid_from ?? null,
        embedding: emb as never,
        metadata: (r.metadata as never) ?? null,
      })
      .run()
  })
}

export function seedGraphEdge(r: {
  id: string
  source_id: string
  target_id: string
  edge_type: string
  project_id?: string
  valid_from: number
  invalid_from?: number | null
  weight?: number
  source_project?: string | null
  metadata?: unknown
}): void {
  Database.use((db) => {
    db.insert(GraphEdgeTable)
      .values({
        id: r.id,
        source_id: r.source_id,
        target_id: r.target_id,
        edge_type: r.edge_type,
        project_id: r.project_id ?? "global",
        valid_from: r.valid_from,
        invalid_from: r.invalid_from ?? null,
        weight: r.weight ?? 1.0,
        source_project: r.source_project ?? null,
        metadata: (r.metadata as never) ?? null,
      })
      .run()
  })
}

export function countMemories(): number {
  return Database.use((db) => db.select().from(MemoryTopicsTable).all().length)
}

export function readMemoryRows(): Array<{ id: string; content: string; metadata: unknown; persona: string; project_id: string; scope: string | null; access_count: number | null; time_created: number | null; time_accessed: unknown }> {
  return Database.use((db) => db.select().from(MemoryTopicsTable).all()) as never
}

export function readIndexRows(): Array<{ id: string; access_count: number | null; time_created: number | null; time_updated: number | null }> {
  return Database.use((db) => db.select().from(MemoryIndexTable).all()) as never
}

export function readGraphEntityRows(): Array<{ id: string; name: string; entity_type: string; project_id: string; valid_from: number; invalid_from: number | null }> {
  return Database.use((db) => db.select().from(GraphEntityTable).all()) as never
}

export function readGraphEdgeRows(): Array<{ id: string; source_id: string; target_id: string; edge_type: string; valid_from: number; invalid_from: number | null }> {
  return Database.use((db) => db.select().from(GraphEdgeTable).all()) as never
}

export function unitEmb(dim: number, value: number): Float32Array {
  const arr = new Float32Array(dim)
  for (let i = 0; i < dim; i++) arr[i] = value
  const norm = Math.sqrt(dim * value * value)
  if (norm === 0) return arr
  for (let i = 0; i < dim; i++) arr[i] = arr[i]! / norm
  return arr
}

export function orthogonalEmb(dim: number, half: "first" | "second"): Float32Array {
  const arr = new Float32Array(dim)
  const halfN = Math.floor(dim / 2)
  const start = half === "first" ? 0 : halfN
  const end = half === "first" ? halfN : dim
  for (let i = start; i < end; i++) arr[i] = 1 / Math.sqrt(halfN)
  return arr
}

export function readMainDbMemories(): Array<{
  id: string
  content: string
  persona: string
  scope: string | null
  project_id: string
  access_count: number | null
  metadata: string | null
  embedding: Uint8Array
  time_created: number | null
  time_accessed: number | null
}> {
  const { Database: Sqlite } = require("bun:sqlite")
  const home = process.env.HOME || ""
  const dbPath = join(home, ".local", "share", "foxybear", "fbh-main.db")
  const sqlite = new Sqlite(dbPath, { readonly: true })
  const rows = sqlite
    .query("SELECT id, content, persona, scope, project_id, access_count, metadata, embedding, time_created, time_accessed FROM memory_topics")
    .all() as never
  sqlite.close()
  return rows
}
