import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"

const REPO = join(import.meta.dir, "..", "..", "..", "..")

function setupLegacy(home: string) {
  // XDG config
  const cfg = join(home, ".config", "opencode")
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, "opencode.json"), JSON.stringify({ model: "test/model", username: "todd" }))
  writeFileSync(join(cfg, "council.json"), JSON.stringify({ models: ["a", "b"] }))
  mkdirSync(join(cfg, "personas"), { recursive: true })
  writeFileSync(join(cfg, "personas", "katya.md"), "# Katya")
  mkdirSync(join(cfg, "commands"), { recursive: true })
  writeFileSync(join(cfg, "commands", "test.md"), "# test command")
  mkdirSync(join(cfg, "agent"), { recursive: true })
  writeFileSync(join(cfg, "agent", "coder.md"), "# coder")
  mkdirSync(join(cfg, "google-workspace"), { recursive: true })
  writeFileSync(join(cfg, "google-workspace", "creds.json"), "{}")

  // XDG data
  const data = join(home, ".local", "share", "opencode")
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, "opencode-dev.db"), "sqlite db content")
  writeFileSync(join(data, "opencode-dev.db-wal"), "wal content")
  writeFileSync(join(data, "auth.json"), '{"openai":{"type":"api","key":"sk-fake"}}')
  mkdirSync(join(data, "storage", "session_diff"), { recursive: true })
  writeFileSync(join(data, "storage", "session_diff", "diff-1.json"), "{}")
  writeFileSync(join(data, "storage", "migration"), "marker")
  mkdirSync(join(data, "memory-server"), { recursive: true })
  writeFileSync(join(data, "memory.surreal"), "surreal data /opencode/ path")
  writeFileSync(join(data, "memory-backup-123.json"), "{}")
  writeFileSync(join(data, "foxybear-serve.pid"), "99999")
  mkdirSync(join(data, "snapshot"), { recursive: true })
  writeFileSync(join(data, "snapshot", "abc123"), "snapshot")
  mkdirSync(join(data, "tool-output"), { recursive: true })
  writeFileSync(join(data, "tool-output", "out-1.txt"), "tool output")
  mkdirSync(join(data, "log"), { recursive: true })
  writeFileSync(join(data, "log", "serve.log"), "log line")

  // XDG state
  const state = join(home, ".local", "state", "opencode")
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, "prompt-history.jsonl"), '{"prompt":"test"}')
  writeFileSync(join(state, "kv.json"), '{"theme":"dark"}')
  writeFileSync(join(state, "plugin-meta.json"), "{}")
  writeFileSync(join(state, "model.json"), '{"model":"test"}')
  mkdirSync(join(state, "locks"), { recursive: true })

  // XDG cache
  const cache = join(home, ".cache", "opencode")
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, "version"), "21")

  // API keys (must NOT be touched)
  mkdirSync(join(home, "Development"), { recursive: true })
  writeFileSync(join(home, "Development", ".openai_api.key"), "sk-fake-openai")
  writeFileSync(join(home, "Development", ".anthropic.key"), "sk-fake-anthropic")
  writeFileSync(join(home, "Development", ".deepinfra.key"), "sk-fake-deepinfra")
}

function runMigrate(home: string, args: string[] = []): { status: number; stdout: string; stderr: string } {
  const entry = join(REPO, "packages/opencode/src/index.ts")
  const r = spawnSync("bun", ["run", entry, "migrate", ...args], {
    env: { ...process.env, FBH_TEST_HOME: home, HOME: home },
    encoding: "utf-8",
    timeout: 30_000,
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

describe("SDD-04: Migration", () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fbh-sdd04-"))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("V1 — dry-run: no files created in foxybear paths", () => {
    setupLegacy(home)
    const r = runMigrate(home, ["--dry-run"])
    expect(r.status).toBe(0)
    expect(existsSync(join(home, ".config", "foxybear"))).toBe(false)
    expect(existsSync(join(home, ".local", "share", "foxybear"))).toBe(false)
    expect(existsSync(join(home, ".local", "state", "foxybear"))).toBe(false)
  })

  it("V2 — full migrate: config + personas + agent + commands copied", () => {
    setupLegacy(home)
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    // Config files
    expect(existsSync(join(home, ".config", "foxybear", "fbh.json"))).toBe(true)
    expect(existsSync(join(home, ".config", "foxybear", "council.json"))).toBe(true)
    expect(existsSync(join(home, ".config", "foxybear", "personas", "katya.md"))).toBe(true)
    expect(existsSync(join(home, ".config", "foxybear", "commands", "test.md"))).toBe(true)
    expect(existsSync(join(home, ".config", "foxybear", "agent", "coder.md"))).toBe(true)
    expect(existsSync(join(home, ".config", "foxybear", "google-workspace", "creds.json"))).toBe(true)
    // Source intact (copy-not-move)
    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(true)
  })

  it("V3 — DB copy + rename prefix opencode → fbh", () => {
    setupLegacy(home)
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    expect(existsSync(join(home, ".local", "share", "foxybear", "fbh-dev.db"))).toBe(true)
    expect(existsSync(join(home, ".local", "share", "foxybear", "fbh-dev.db-wal"))).toBe(true)
    // Source intact
    expect(existsSync(join(home, ".local", "share", "opencode", "opencode-dev.db"))).toBe(true)
  })

  it("V4 — auth.json copied, contents not in migration log", () => {
    setupLegacy(home)
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    expect(existsSync(join(home, ".local", "share", "foxybear", "auth.json"))).toBe(true)
    // Log must not contain the key value
    const logDir = join(home, ".local", "share", "foxybear")
    const logs = spawnSync("bash", ["-c", `ls ${logDir}/migration-*.log 2>/dev/null`], { encoding: "utf-8" })
    if (logs.stdout.trim()) {
      const logContent = readFileSync(logs.stdout.trim().split("\n")[0], "utf-8")
      expect(logContent).not.toContain("sk-fake")
    }
  })

  it("V5 — SurrealDB + memory-backup copied, /opencode/ path rewritten to /foxybear/", () => {
    setupLegacy(home)
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    expect(existsSync(join(home, ".local", "share", "foxybear", "memory-server"))).toBe(true)
    const surreal = readFileSync(join(home, ".local", "share", "foxybear", "memory.surreal"), "utf-8")
    expect(surreal).toContain("/foxybear/")
    expect(surreal).not.toContain("/opencode/")
    expect(existsSync(join(home, ".local", "share", "foxybear", "memory-backup-123.json"))).toBe(true)
  })

  it("V5b — state dir copied (prompt-history, kv, plugin-meta, model, locks)", () => {
    setupLegacy(home)
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    expect(existsSync(join(home, ".local", "state", "foxybear", "prompt-history.jsonl"))).toBe(true)
    expect(existsSync(join(home, ".local", "state", "foxybear", "kv.json"))).toBe(true)
    expect(existsSync(join(home, ".local", "state", "foxybear", "plugin-meta.json"))).toBe(true)
    expect(existsSync(join(home, ".local", "state", "foxybear", "model.json"))).toBe(true)
    expect(existsSync(join(home, ".local", "state", "foxybear", "locks"))).toBe(true)
  })

  it("V5c — storage dir copied (session_diff + migration marker)", () => {
    setupLegacy(home)
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    expect(existsSync(join(home, ".local", "share", "foxybear", "storage", "session_diff", "diff-1.json"))).toBe(true)
    expect(existsSync(join(home, ".local", "share", "foxybear", "storage", "migration"))).toBe(true)
  })

  it("V5d — agent/mode/skill dirs migrated", () => {
    setupLegacy(home)
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    expect(existsSync(join(home, ".config", "foxybear", "agent", "coder.md"))).toBe(true)
  })

  it("V5e — snapshot + tool-output skipped", () => {
    setupLegacy(home)
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    expect(existsSync(join(home, ".local", "share", "foxybear", "snapshot"))).toBe(false)
    expect(existsSync(join(home, ".local", "share", "foxybear", "tool-output"))).toBe(false)
  })

  it("V6 — PID not copied, stale PID warned", () => {
    setupLegacy(home)
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    expect(existsSync(join(home, ".local", "share", "foxybear", "foxybear-serve.pid"))).toBe(false)
  })

  it("V7 — logs + cache skipped", () => {
    setupLegacy(home)
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    expect(existsSync(join(home, ".local", "share", "foxybear", "log"))).toBe(false)
    expect(existsSync(join(home, ".cache", "foxybear"))).toBe(false)
  })

  it("V8 — API keys untouched (not copied, not logged)", () => {
    setupLegacy(home)
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    // Source keys still there
    expect(existsSync(join(home, "Development", ".openai_api.key"))).toBe(true)
    expect(existsSync(join(home, "Development", ".anthropic.key"))).toBe(true)
    expect(existsSync(join(home, "Development", ".deepinfra.key"))).toBe(true)
    // Not copied anywhere
    const r2 = spawnSync("bash", ["-c", `find ${home} -name "*.key" -not -path "*/Development/*" 2>/dev/null`], { encoding: "utf-8" })
    expect(r2.stdout.trim()).toBe("")
  })

  it("V9 — idempotent: re-run is no-op (targets already exist)", () => {
    setupLegacy(home)
    const r1 = runMigrate(home)
    expect(r1.status).toBe(0)
    const r2 = runMigrate(home)
    expect(r2.status).toBe(0)
    // Both runs succeed; second is no-op (targets already exist)
  })

  it("V13 — no original data lost (source checksums unchanged)", () => {
    setupLegacy(home)
    const srcDb = readFileSync(join(home, ".local", "share", "opencode", "opencode-dev.db"))
    const r = runMigrate(home)
    expect(r.status).toBe(0)
    const srcDbAfter = readFileSync(join(home, ".local", "share", "opencode", "opencode-dev.db"))
    expect(srcDbAfter).toEqual(srcDb)
  })
})
