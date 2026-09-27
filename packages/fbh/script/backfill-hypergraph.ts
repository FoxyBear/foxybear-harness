#!/usr/bin/env bun
/**
 * Retroactive Hypergraph Backfill — replays each session's message stream
 * through the same TraceIngestor.ingest + classify path the live capture
 * hook uses (SDD-05 / SDD-06).
 *
 * The M-0 wire-up (SDD-02) only captures NEW turns going forward. This
 * script backfills the hypergraph with past sessions' ACTION/ERROR/MESSAGE
 * nodes + COLLABORATION/ERROR_CORRECTION/EVIDENCE hyperedges by replaying
 * each message in order — per-turn, not per-session blob. The circular
 * Buffer builds naturally as user turns replay, giving Jev the conversation
 * arc the gate needs to distinguish routine turns from memory-worthy ones.
 *
 * Usage:
 *   bun run script/backfill-hypergraph.ts                # backfill current channel's DB
 *   bun run script/backfill-hypergraph.ts --all-dbs      # backfill EVERY fbh-*.db (spawns subprocesses)
 *   bun run script/backfill-hypergraph.ts --dry-run      # preview counts, no writes
 *   bun run script/backfill-hypergraph.ts --limit 10     # backfill first 10 sessions
 *   bun run script/backfill-hypergraph.ts --project <id> # one project only
 *   FBH_DB=~/.local/share/foxybear/fbh-main.db bun run script/backfill-hypergraph.ts  # target a specific DB
 *
 * Idempotent: per-DB marker at ~/.local/share/foxybear/backfill-hypergraph-<dbname>.json
 * prevents re-runs. Delete the marker to re-run.
 *
 * Requires:
 *   - SurrealDB running at ws://127.0.0.1:8000 (foxybear path)
 *   - memory.enabled = true in ~/.config/foxybear/fbh.json
 */

import { Instance } from "../src/project/instance"
import { Global } from "../src/global"
import { Database } from "../src/storage/db"
import { SessionTable } from "../src/session/session.sql"
import { Log } from "../src/util/log"
import path from "node:path"
import { readdirSync } from "node:fs"
import { spawn } from "node:child_process"

const log = Log.create({ service: "backfill-hypergraph" })

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const allDbs = args.includes("--all-dbs")
const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1]
const limit = limitArg ? Number(limitArg) : undefined
const projectArg = args.find((a) => a.startsWith("--project="))?.split("=")[1]

function markerPath(dbPath: string): string {
  const base = path.basename(dbPath).replace(/\.db$/, "")
  return path.join(Global.Path.data, `backfill-hypergraph-${base}.json`)
}

async function main() {
  if (allDbs) {
    await backfillAllDbs()
  } else {
    await backfillCurrent()
  }
}

async function backfillAllDbs() {
  const dataDir = Global.Path.data
  const dbs = readdirSync(dataDir).filter((f) => /^fbh.*\.db$/.test(f) && !f.includes("-wal") && !f.includes("-shm"))
  console.log(`Found ${dbs.length} DBs to backfill:`)
  for (const db of dbs) console.log(`  ${db}`)
  console.log()

  for (const db of dbs) {
    const dbPath = path.join(dataDir, db)
    console.log(`\n=== Backfilling ${db} ===`)
    const child = spawn(process.argv[0], [process.argv[1], "--limit=" + (limit ?? ""), projectArg ? `--project=${projectArg}` : ""].filter(Boolean), {
      env: { ...process.env, FBH_DB: dbPath },
      stdio: "inherit",
    })
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${db} exited ${code}`))))
    })
  }
}

async function backfillCurrent() {
  const dir = process.cwd()
  const dbPath = Database.Path
  console.log(`Backfill hypergraph from past sessions`)
  console.log(`  directory: ${dir}`)
  console.log(`  DB:        ${dbPath}`)
  console.log(`  dry-run:   ${dryRun}`)
  console.log(`  limit:     ${limit ?? "all"}`)
  console.log(`  project:   ${projectArg ?? "all"}`)
  console.log()

  const marker = markerPath(dbPath)
  if (!dryRun) {
    const markerFile = Bun.file(marker)
    if (await markerFile.exists()) {
      const m = await markerFile.json()
      if (m.ran) {
        console.log(`Marker exists (ran ${m.completed_at}). Delete ${marker} to re-run.`)
        console.log(`  sessions: ${m.sessions_processed}, nodes: ${m.nodes_emitted}, hyperedges: ${m.hyperedges_emitted}`)
        process.exit(0)
      }
    }
  }

  await Instance.provide({
    directory: dir,
    fn: async () => {
      await backfill(marker)
    },
  })
}

interface Marker {
  ran: boolean
  completed_at: string
  db: string
  sessions_processed: number
  sessions_skipped: number
  sessions_errored: number
  nodes_emitted: number
  hyperedges_emitted: number
  memories_classified: number
  by_project: Record<string, number>
  duration_ms: number
}

async function backfill(markerPath: string) {
  const start = Date.now()

  const { isMemoryEnabled } = await import("../src/memory/config")
  const enabled = await isMemoryEnabled()
  if (!enabled) {
    console.error("memory.enabled is false. Set it true in ~/.config/foxybear/fbh.json to backfill.")
    process.exit(1)
  }

  let backend = null
  if (!dryRun) {
    const { getGlobalHypergraphBackend, setGlobalHypergraphBackend } = await import("../src/memory/backend-registry")
    backend = getGlobalHypergraphBackend()
    if (!backend) {
      console.log("Booting SurrealHypergraphBackend...")
      const { SurrealHypergraphBackend } = await import("../src/memory/surreal-hypergraph-backend")
      backend = new SurrealHypergraphBackend({})
      await backend.init()
      setGlobalHypergraphBackend(backend)
      console.log("  hypergraph backend ready")
    } else {
      console.log("Hypergraph backend already registered (daemon running?)")
    }
  }

  const sessions = Database.use((db) =>
    db
      .select({
        id: SessionTable.id,
        project_id: SessionTable.project_id,
        time_created: SessionTable.time_created,
        title: SessionTable.title,
      })
      .from(SessionTable)
      .orderBy(SessionTable.time_updated)
      .all(),
  )

  const filtered = sessions.filter((s) => !projectArg || s.project_id === projectArg)
  const subset = limit ? filtered.slice(0, limit) : filtered

  console.log(`\nSessions: ${sessions.length} total, ${filtered.length} after filter, ${subset.length} to process`)
  console.log()

  const { MessageV2 } = await import("../src/session/message-v2")
  const { TraceIngestor } = await import("../src/memory/capture/trace")
  const { PersonaSession } = await import("../src/persona/session")
  // SC-1: classify is the single entry point. The pipeline owns gate → extract
  // → classify → store internally. The script does NOT call EntityExtractor,
  // MemoryExtractor, persistEntities, or persistMemories directly (CC-2).
  const { classify } = await import("../src/memory/classify/pipeline")
  const { Buffer } = await import("../src/memory/capture/buffer")

  // Delete stub-generated nodes before re-ingesting (CC-1: no data loss).
  // Hard-delete ENTITY/MEMORY/PROCEDURE nodes with source_path "regex" or "llm"
  // (the Phase M stub noise — 139k nodes labeled "llm" from the regex stub).
  // Preserve deterministic ACTION/ERROR/MESSAGE nodes from TraceIngestor.
  // Uses a direct SurrealDB query via SurrealGraphBackend for the bulk delete —
  // per-node round-trips would be too slow for 139k rows.
  if (!dryRun) {
    const { SurrealGraphBackend } = await import("../src/memory/graph/surreal-backend")
    const graph = new SurrealGraphBackend({})
    await graph.init()
    try {
      await graph.run(
        `DELETE FROM node WHERE node_type IN ["ENTITY", "MEMORY", "PROCEDURE"] AND (attributes.source_path = "regex" OR attributes.source_path = "llm");`,
      )
      await graph.run(
        `DELETE FROM hyperedge_members WHERE node_id NOT IN (SELECT node_id FROM node);`,
      )
      await graph.run(
        `DELETE FROM hyperedge WHERE id NOT IN (SELECT hyperedge_id FROM hyperedge_members);`,
      )
      console.log("Stub nodes deleted (ENTITY/MEMORY/PROCEDURE, source_path regex|llm)")
    } finally {
      await graph.close()
    }
  }

  let processed = 0, skipped = 0, errored = 0, totalNodes = 0, totalHyperedges = 0, totalClassified = 0
  const byProject: Record<string, number> = {}

  for (const s of subset) {
    try {
      const messages = Array.from(MessageV2.stream(s.id)).reverse()
      if (messages.length === 0) { skipped++; continue }

      let persona = "default"
      try { const ps = PersonaSession.get(s.id); if (ps?.name) persona = ps.name } catch {}

      if (dryRun) {
        for (const m of messages) totalNodes += m.parts.length
        byProject[s.project_id] = (byProject[s.project_id] ?? 0) + 1
        processed++
        continue
      }

      // Reset session-scoped circular buffer at session start (SC-3 session
      // isolation). The pipeline owns the per-turn buffer read/write inside
      // classify; clearing here gives each replayed session a fresh arc.
      try { Buffer.clear(s.id) } catch {}

      // Replay each message in order through the same TraceIngestor.ingest +
      // classify path the live capture hook uses. Per-turn, not per-session
      // blob: withParts holds a single message so ingest emits nodes for just
      // that turn, and the Buffer builds naturally as user turns replay.
      for (const m of messages) {
        const turn = {
          sessionID: s.id,
          messageID: m.info.id,
          withParts: [m],
          persona,
          project_id: s.project_id,
        }
        const result = await TraceIngestor.ingest(turn)
        totalNodes += result.nodes.length
        totalHyperedges += result.hyperedges.length

        if (m.info.role !== "user") continue

        const text = m.parts
          .filter((p) => p.type === "text")
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("\n")
          .slice(0, 2000)
        if (!text.trim()) continue

        const r = await classify({ sessionID: s.id, text, project_id: s.project_id, persona }).catch((err) => {
          log.warn("classify failed", { session: s.id, error: String(err) })
          return { stored: 0, skipped: 0, errors: 1 }
        })
        totalClassified += r.stored
      }

      byProject[s.project_id] = (byProject[s.project_id] ?? 0) + 1
      processed++

      if (processed % 10 === 0) {
        console.log(`  ${processed}/${subset.length} sessions | ${totalNodes} nodes | ${totalHyperedges} hyperedges | ${totalClassified} memories`)
      }
    } catch (err) {
      errored++
      log.warn("session ingest failed", { session: s.id, error: String(err) })
    }
  }

  const duration_ms = Date.now() - start
  console.log()
  console.log(`=== Backfill ${dryRun ? "(dry-run)" : "complete"} ===`)
  console.log(`  sessions processed: ${processed}`)
  console.log(`  sessions skipped:   ${skipped} (empty)`)
  console.log(`  sessions errored:   ${errored}`)
  if (!dryRun) {
    console.log(`  nodes emitted:      ${totalNodes}`)
    console.log(`  hyperedges emitted: ${totalHyperedges}`)
    console.log(`  memories classified: ${totalClassified}`)
  } else {
    console.log(`  est. parts (nodes): ${totalNodes}`)
  }
  console.log(`  by project:`)
  for (const [pid, n] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pid}: ${n} sessions`)
  }
  console.log(`  duration: ${(duration_ms / 1000).toFixed(1)}s`)

  if (!dryRun) {
    const marker: Marker = {
      ran: true,
      completed_at: new Date().toISOString(),
      db: Database.Path,
      sessions_processed: processed,
      sessions_skipped: skipped,
      sessions_errored: errored,
      nodes_emitted: totalNodes,
      hyperedges_emitted: totalHyperedges,
      memories_classified: totalClassified,
      by_project: byProject,
      duration_ms,
    }
    await Bun.write(markerPath, JSON.stringify(marker, null, 2))
    console.log(`\nMarker written: ${markerPath}`)
  }
}

main().then(() => {
  process.exit(0)
}).catch((err) => {
  console.error("backfill failed", err)
  process.exit(1)
})
