import path from "path"
import { mkdir, copyFile, readdir, stat, readFile, writeFile } from "fs/promises"
import { cmd } from "./cmd"
import { Global } from "../../global"

const log = {
  info: (...args: any[]) => console.log("[migrate]", ...args),
  debug: (...args: any[]) => {},
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      await copyFile(srcPath, destPath)
    }
  }
}

async function copyFileSafe(src: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true })
  await copyFile(src, dest)
}

async function mergeConfig(src: string, dest: string): Promise<void> {
  const content = await readFile(src, "utf-8")
  const translated = content.replace(/\{env:OPENCODE_([A-Z_]+)\}/g, "{env:FBH_$1}")
  await mkdir(path.dirname(dest), { recursive: true })
  try {
    await stat(dest)
    log.debug("merge: target exists, keeping target", dest)
    return
  } catch {}
  await writeFile(dest, translated)
}

interface CopyAction {
  src: string
  dest: string
  desc: string
  merge?: boolean
}

interface SkipAction {
  src: string
  reason: string
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

async function planMigration(): Promise<{ copy: CopyAction[]; skip: SkipAction[] }> {
  const home = Global.Path.home
  const oldCfg = path.join(home, ".config", "opencode")
  const newCfg = path.join(home, ".config", "foxybear")
  const oldData = path.join(home, ".local", "share", "opencode")
  const newData = path.join(home, ".local", "share", "foxybear")
  const oldState = path.join(home, ".local", "state", "opencode")
  const newState = path.join(home, ".local", "state", "foxybear")

  const copy: CopyAction[] = []
  const skip: SkipAction[] = []

  if (await exists(oldCfg)) {
    // Config files (merge with token translation)
    const configFiles: Array<[string, string]> = [
      ["opencode.json", "fbh.json"],
      ["opencode.jsonc", "fbh.jsonc"],
      ["council.json", "council.json"],
    ]
    for (const [srcName, destName] of configFiles) {
      const src = path.join(oldCfg, srcName)
      if (await exists(src)) {
        copy.push({ src, dest: path.join(newCfg, destName), desc: `merge ${srcName} → ${destName}`, merge: true })
      }
    }
    // Config dirs (copy)
    const configDirs = ["personas", "commands", "agent", "mode", "skill", "google-workspace"]
    for (const dir of configDirs) {
      const src = path.join(oldCfg, dir)
      if (await exists(src)) copy.push({ src, dest: path.join(newCfg, dir), desc: `copy ${dir}/` })
    }
    // Node project
    const nodeFiles = ["package.json", "bun.lock", "package-lock.json"]
    for (const f of nodeFiles) {
      const src = path.join(oldCfg, f)
      if (await exists(src)) copy.push({ src, dest: path.join(newCfg, f), desc: `copy ${f}` })
    }
    const nodeModules = path.join(oldCfg, "node_modules")
    if (await exists(nodeModules)) copy.push({ src: nodeModules, dest: path.join(newCfg, "node_modules"), desc: "copy node_modules/" })
  }

  if (await exists(oldData)) {
    const entries = await readdir(oldData, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = entry.name
      if (name.startsWith("opencode") && (name.endsWith(".db") || name.includes(".db-"))) {
        const newName = name.replace(/^opencode/, "fbh")
        copy.push({ src: path.join(oldData, name), dest: path.join(newData, newName), desc: `DB ${name} → ${newName}` })
      } else if (name === "auth.json") {
        copy.push({ src: path.join(oldData, name), dest: path.join(newData, name), desc: "auth.json (never logged)" })
      } else if (name === "memory.surreal" || name.startsWith("memory-backup-") || name === "memory-migration-surreal.json") {
        copy.push({ src: path.join(oldData, name), dest: path.join(newData, name), desc: `memory: ${name}` })
      }
    }
    // memory-server dir
    const memServer = path.join(oldData, "memory-server")
    if (await exists(memServer)) copy.push({ src: memServer, dest: path.join(newData, "memory-server"), desc: "memory-server/" })
    // storage dir (session diffs)
    const storage = path.join(oldData, "storage")
    if (await exists(storage)) copy.push({ src: storage, dest: path.join(newData, "storage"), desc: "storage/ (session diffs)" })
    // skip dirs
    for (const skipDir of ["snapshot", "tool-output", "log", "plans", "repos"]) {
      const d = path.join(oldData, skipDir)
      if (await exists(d)) skip.push({ src: d, reason: `${skipDir}/ regenerable` })
    }
    const pid = path.join(oldData, "foxybear-serve.pid")
    if (await exists(pid)) skip.push({ src: pid, reason: "PID stale (fresh on next daemon start)" })
  }

  if (await exists(oldState)) {
    copy.push({ src: oldState, dest: newState, desc: "state/ (prompt-history, kv, plugin-meta, model, locks)" })
  }

  const oldCache = path.join(home, ".cache", "opencode")
  if (await exists(oldCache)) skip.push({ src: oldCache, reason: "cache/ regenerable" })

  return { copy, skip }
}

async function runMigration(dryRun: boolean): Promise<void> {
  const plan = await planMigration()
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const home = Global.Path.home
  const newData = path.join(home, ".local", "share", "foxybear")
  const logFile = path.join(newData, `migration-${timestamp}.log`)
  const lines: string[] = []

  if (dryRun) {
    console.log("=== fbh migrate --dry-run ===\n")
    console.log("WOULD COPY:")
    for (const item of plan.copy) {
      console.log(`  ${item.src} → ${item.dest}`)
      console.log(`    (${item.desc})`)
    }
    console.log("\nWOULD SKIP:")
    for (const item of plan.skip) {
      console.log(`  ${item.src} — ${item.reason}`)
    }
    console.log(`\nNo files created. ${plan.copy.length} copy, ${plan.skip.length} skip.`)
    return
  }

  log.info(`migration starting: ${plan.copy.length} copy, ${plan.skip.length} skip`)

  for (const item of plan.copy) {
    try {
      if (item.merge) {
        await mergeConfig(item.src, item.dest)
      } else if (await isDir(item.src)) {
        await copyDir(item.src, item.dest)
      } else {
        await copyFileSafe(item.src, item.dest)
      }
      if (item.src.endsWith("auth.json")) {
        lines.push(`copied: ${item.src} → ${item.dest} (contents redacted)`)
      } else {
        lines.push(`copied: ${item.src} → ${item.dest} (${item.desc})`)
      }
    } catch (e) {
      lines.push(`FAILED: ${item.src} → ${item.dest}: ${(e as Error).message}`)
    }
  }

  for (const item of plan.skip) {
    lines.push(`skipped: ${item.src} — ${item.reason}`)
  }

  // SurrealDB path rewrite
  const surrealDest = path.join(newData, "memory.surreal")
  if (await exists(surrealDest)) {
    const content = await readFile(surrealDest, "utf-8")
    if (content.includes("/opencode/")) {
      const rewritten = content.replace(/\/opencode\//g, "/foxybear/")
      await writeFile(surrealDest, rewritten)
      lines.push("rewrote: memory.surreal /opencode/ → /foxybear/")
    }
  }

  // Stale PID warning
  const pidFile = path.join(home, ".local", "share", "opencode", "foxybear-serve.pid")
  if (await exists(pidFile)) {
    lines.push("warn: stale foxybear-serve.pid found; fresh PID created on next daemon start")
  }

  await mkdir(newData, { recursive: true })
  await writeFile(logFile, lines.join("\n") + "\n")

  console.log(`Migration complete: ${plan.copy.length} copied, ${plan.skip.length} skipped.`)
  console.log(`Log: ${logFile}`)
}

export const MigrateCommand = cmd({
  command: "migrate",
  describe: "Migrate existing opencode data to foxybear paths (Phase A.5)",
  builder: (yargs) =>
    yargs.option("dry-run", {
      type: "boolean",
      default: false,
      describe: "Show what would be migrated without making changes",
    }),
  handler: async (args) => {
    try {
      await runMigration(Boolean(args["dry-run"]))
    } catch (e) {
      console.error(`Migration failed: ${(e as Error).message}`)
      process.exit(1)
    }
  },
})
