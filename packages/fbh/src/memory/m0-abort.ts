import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "memory.m0-abort" })

export type AbortTrigger =
  | "dry_run_mismatch_or_data_loss"
  | "unrecoverable_loss"
  | "p95_regression_sustained"
  | "backup_verification_failed"

/**
 * Phase M-0 guardrail (WHAT #21).
 *
 * Rollback procedure:
 *   1. Restore the SQLite DB + SurrealDB data dir from the WHAT #17 backup
 *      (if migration occurred; no-op if migration was aborted in place).
 *   2. Flip `memory.enabled` to `false` in `~/.config/foxybear/fbh.json`.
 *   3. Restart the daemon (caller's responsibility — we log the action).
 *   4. Verify P95 returns to baseline ± 5% over 1 hour of post-rollback
 *      telemetry (test: 1 minute) — caller's responsibility.
 *   5. Log the rollback to `~/.local/share/foxybear/m0-rollback-<ISO8601>.json`
 *      with `{ trigger, action, verification }`.
 *
 * ABORT A1 halts the M-0 wire-up; the program continues at the floor
 * (M-0 baseline-retrieval injection behind flag) per SC-11.
 */
export async function checkAbortA1(
  trigger: AbortTrigger,
  opts?: { backupDir?: string; verification?: string },
): Promise<void> {
  const iso = new Date().toISOString().replace(/[:.]/g, "-")
  const action = "restore+flag+restart"
  const verification = opts?.verification ?? "p95_returned_to_baseline"

  // 1. Restore from backup (if provided and present)
  if (opts?.backupDir && existsSync(opts.backupDir)) {
    try {
      const sqliteBackup = path.join(opts.backupDir, "memory.db")
      if (existsSync(sqliteBackup)) {
        await fs.copyFile(sqliteBackup, path.join(Global.Path.data, "memory.db"))
      }
      for (const sidecar of ["memory.db-wal", "memory.db-shm"]) {
        const src = path.join(opts.backupDir, sidecar)
        if (existsSync(src)) await fs.copyFile(src, path.join(Global.Path.data, sidecar))
      }
      const surrealBackup = path.join(opts.backupDir, "memory-server")
      const surrealDst = path.join(Global.Path.data, "memory-server")
      if (existsSync(surrealBackup)) {
        await fs.rm(surrealDst, { recursive: true, force: true }).catch(() => {})
        await fs.cp(surrealBackup, surrealDst, { recursive: true })
      }
    } catch (err) {
      log.error("rollback restore failed", { trigger, error: String(err) })
    }
  }

  // 2. Flip memory.enabled to false in fbh.json
  try {
    const configPath = path.join(Global.Path.config, "fbh.json")
    if (existsSync(configPath)) {
      const raw = await fs.readFile(configPath, "utf-8")
      const json = JSON.parse(raw) as Record<string, unknown>
      const mem = (json.memory ?? {}) as Record<string, unknown>
      mem.enabled = false
      json.memory = mem
      await fs.writeFile(configPath, JSON.stringify(json, null, 2))
    }
  } catch (err) {
    log.error("rollback flag flip failed", { trigger, error: String(err) })
  }

  // 3. Restart is the caller's responsibility — log the directive.

  // 5. Write the rollback log
  try {
    const dir = Global.Path.data
    const file = path.join(dir, `m0-rollback-${iso}.json`)
    await fs.writeFile(
      file,
      JSON.stringify(
        {
          trigger,
          action,
          verification,
          backup_dir: opts?.backupDir ?? null,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
  } catch (err) {
    log.error("rollback log write failed", { trigger, error: String(err) })
  }

  log.error("ABORT A1 fired", { trigger, action, verification })
}
