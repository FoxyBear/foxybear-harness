import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { Database } from "../storage/db"
import { MemoryTopicsTable } from "./memory.sql"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "memory.migrate-backup" })

/**
 * Phase M-0 guardrail (WHAT #17).
 *
 * Before the actual (non-dry-run) migration, copy:
 *   - `~/.local/share/foxybear/memory.db` (+ `-wal`, `-shm` sidecars if present)
 *   - `~/.local/share/foxybear/memory-server/` (SurrealDB data dir)
 * into `~/.local/share/foxybear/backups/pre-migration-<ISO8601>/`.
 *
 * Verify the backup by:
 *   - `SELECT COUNT(*) FROM memory` on the SQLite backup (must equal the live count)
 *   - `readdir` of the SurrealDB backup (must contain `manifest/`, `sstables/`, `vlog/`, `wal/`)
 *
 * Throws on verification failure. The caller (serve.ts) catches and aborts
 * the migration in place — leaving the marker file absent — without invoking
 * `migrateFromSqlite`. The backup dir is retained for inspection / rollback.
 *
 * Returns the backup directory path.
 */
export async function backupBeforeMigrate(): Promise<string> {
  const iso = new Date().toISOString().replace(/[:.]/g, "-")
  const backupDir = path.join(Global.Path.data, "backups", `pre-migration-${iso}`)
  await fs.mkdir(backupDir, { recursive: true })

  // SQLite DB + sidecars
  const sqliteSrc = path.join(Global.Path.data, "memory.db")
  if (existsSync(sqliteSrc)) {
    await fs.copyFile(sqliteSrc, path.join(backupDir, "memory.db"))
  }
  for (const sidecar of ["memory.db-wal", "memory.db-shm"]) {
    const src = path.join(Global.Path.data, sidecar)
    if (existsSync(src)) await fs.copyFile(src, path.join(backupDir, sidecar))
  }

  // SurrealDB data dir
  const surrealSrc = path.join(Global.Path.data, "memory-server")
  const surrealDst = path.join(backupDir, "memory-server")
  if (existsSync(surrealSrc)) {
    await fs.cp(surrealSrc, surrealDst, { recursive: true })
  }

  // Verify — SQLite row count
  const liveCount = Database.use((db) => db.select().from(MemoryTopicsTable).all().length)
  const sqliteBackupPath = path.join(backupDir, "memory.db")
  if (existsSync(sqliteBackupPath)) {
    const { Database: BunSqlite } = await import("bun:sqlite")
    const sqliteBackup = new BunSqlite(sqliteBackupPath, { readonly: true })
    try {
      const row = sqliteBackup.prepare("SELECT COUNT(*) as c FROM memory_topics").get() as
        | { c: number }
        | undefined
      const backupCount = row?.c ?? 0
      if (backupCount !== liveCount) {
        throw new Error(
          `backup verification failed: sqlite row count mismatch (live=${liveCount}, backup=${backupCount})`,
        )
      }
    } finally {
      sqliteBackup.close()
    }
  }

  // Verify — SurrealDB dir listing
  if (existsSync(surrealDst)) {
    const listing = await fs.readdir(surrealDst)
    for (const required of ["manifest", "sstables", "vlog", "wal"]) {
      if (!listing.includes(required)) {
        throw new Error(`backup verification failed: surreal dir missing ${required}`)
      }
    }
  }

  log.info("backup verified", { backupDir, liveCount })
  return backupDir
}
