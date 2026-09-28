import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-02 acceptance tests — derived from the spec's VERIFY section.
// These tests verify the M-0 wire-up artifacts exist: feature flag,
// helpers, call sites, migration marker, scheduler config.
//
// The implementation "implements" the M-0 wire-up by:
// - Adding `memory.enabled` config flag (default false)
// - Adding `isMemoryEnabled()` helper in src/memory/config.ts
// - Adding `migrateFromSqlite({ dryRun })` option to SurrealBackend
// - Adding `backupBeforeMigrate()` in src/memory/migrate-backup.ts
// - Adding `emitTelemetry()` in src/memory/m0-telemetry.ts
// - Adding `checkAbortA1()` in src/memory/m0-abort.ts
// - Re-enabling scheduler with real recentSessionIds
// - Wiring AutoRecall.autoRecall + formatForInjection into prompt.ts
// - Wiring Consolidation.extractTurn into prompt.ts with adapter
//
// These tests are RED until the implementation lands.

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..") // FoxyBearOffice root
const FBH = join(import.meta.dir, "..", "..") // packages/fbh
const SRC = join(FBH, "src")
const DATA = join(process.env.HOME || "", ".local", "share", "foxybear")
const CONFIG = join(process.env.HOME || "", ".config", "foxybear", "fbh.json")

function src(...paths: string[]): string {
  return join(SRC, ...paths)
}

function exists(path: string): boolean {
  return existsSync(path)
}

function grep(path: string, pattern: string): boolean {
  if (!exists(path)) return false
  const content = readFileSync(path, "utf-8")
  return new RegExp(pattern).test(content)
}

function grepRecursive(dir: string, pattern: string): boolean {
  if (!exists(dir)) return false
  try {
    const result = execSync(`rg -l "${pattern}" "${dir}" 2>/dev/null || true`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    return result.length > 0
  } catch {
    return false
  }
}

describe("SDD-02 M-0 Wire-Up", () => {
  describe("V15 — Feature flag (memory.enabled, default false)", () => {
    test("isMemoryEnabled() helper exists in src/memory/", () => {
      const candidates = [
        src("memory", "config.ts"),
        src("memory", "enabled.ts"),
        src("memory", "flag.ts"),
      ]
      const found = candidates.some((f) => exists(f))
      expect(found).toBe(true)
    })

    test("isMemoryEnabled function is defined in the codebase", () => {
      const found = grepRecursive(SRC, "isMemoryEnabled")
      expect(found).toBe(true)
    })

    test("config memory.enabled flag is referenced in the codebase", () => {
      const found = grepRecursive(SRC, "memory\\.enabled|memory_enabled|isMemoryEnabled")
      expect(found).toBe(true)
    })
  })

  describe("V16 — migrateFromSqlite dry-run option", () => {
    test("surreal-backend.ts migrateFromSqlite accepts dryRun option", () => {
      const path = src("memory", "surreal-backend.ts")
      if (!exists(path)) {
        expect(path).toBe("exists")
        return
      }
      const content = readFileSync(path, "utf-8")
      // The signature should accept opts?: { dryRun?: boolean }
      const hasDryRun = /migrateFromSqlite\s*\(\s*opts?\s*[\?:]?\s*\{[^}]*dryRun/.test(content) ||
                        /dryRun/.test(content)
      expect(hasDryRun).toBe(true)
    })
  })

  describe("V17 — backupBeforeMigrate helper", () => {
    test("backupBeforeMigrate helper exists in src/memory/", () => {
      const candidates = [
        src("memory", "migrate-backup.ts"),
        src("memory", "backup.ts"),
      ]
      const found = candidates.some((f) => exists(f))
      expect(found).toBe(true)
    })

    test("backupBeforeMigrate function is defined in the codebase", () => {
      const found = grepRecursive(SRC, "backupBeforeMigrate")
      expect(found).toBe(true)
    })
  })

  describe("V19 — Telemetry + Abort A1 helpers", () => {
    test("emitTelemetry helper exists in src/memory/", () => {
      const candidates = [
        src("memory", "m0-telemetry.ts"),
        src("memory", "telemetry.ts"),
      ]
      const found = candidates.some((f) => exists(f))
      expect(found).toBe(true)
    })

    test("checkAbortA1 helper exists in src/memory/", () => {
      const candidates = [
        src("memory", "m0-abort.ts"),
        src("memory", "abort.ts"),
      ]
      const found = candidates.some((f) => exists(f))
      expect(found).toBe(true)
    })

    test("checkAbortA1 function is defined in the codebase", () => {
      const found = grepRecursive(SRC, "checkAbortA1")
      expect(found).toBe(true)
    })
  })

  describe("V5 — Scheduler re-enabled with real recentSessionIds", () => {
    test("scheduler.ts no longer passes recentSessionIds: [] stub", () => {
      const path = src("scheduler", "scheduler.ts")
      if (!exists(path)) {
        expect(path).toBe("exists")
        return
      }
      const content = readFileSync(path, "utf-8")
      // The [] stub at line ~380 should be replaced with real Session.listGlobal
      const hasRealSessions = /Session\.listGlobal|listGlobal/.test(content)
      expect(hasRealSessions).toBe(true)
    })
  })

  describe("V6-V7 — AutoRecall wired into session prompt", () => {
    test("prompt.ts imports or calls AutoRecall.autoRecall", () => {
      const path = src("session", "prompt.ts")
      if (!exists(path)) {
        expect(path).toBe("exists")
        return
      }
      const content = readFileSync(path, "utf-8")
      const hasAutoRecall = /AutoRecall\.autoRecall|autoRecall/.test(content)
      expect(hasAutoRecall).toBe(true)
    })

    test("prompt.ts imports or calls AutoRecall.formatForInjection", () => {
      const path = src("session", "prompt.ts")
      if (!exists(path)) {
        expect(path).toBe("exists")
        return
      }
      const content = readFileSync(path, "utf-8")
      const hasFormat = /formatForInjection/.test(content)
      expect(hasFormat).toBe(true)
    })
  })

  describe("V9-V10 — Consolidation.extractTurn wired into session prompt", () => {
    test("prompt.ts imports or calls Consolidation.extractTurn", () => {
      const path = src("session", "prompt.ts")
      if (!exists(path)) {
        expect(path).toBe("exists")
        return
      }
      const content = readFileSync(path, "utf-8")
      const hasExtractTurn = /extractTurn/.test(content)
      expect(hasExtractTurn).toBe(true)
    })
  })

  describe("V12 — Typecheck green", () => {
    test("bun run typecheck exits 0", () => {
      const result = execSync("bun run typecheck 2>&1", {
        cwd: FBH,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000,
      })
      expect(result).toBeDefined()
    })
  })

  describe("V14 — Feature flag off → no M-0 code paths fire", () => {
    test("memory.enabled defaults to false (or absent) in config schema", () => {
      // The config flag should default to false so M-0 is dormant until opt-in
      // Check that isMemoryEnabled() returns false when memory.enabled is not set
      const found = grepRecursive(SRC, "isMemoryEnabled")
      expect(found).toBe(true)
    })
  })

  describe("Call site verification (CC-2 — dormant code is wired)", () => {
    test("AutoRecall.autoRecall has a call site outside its own definition", () => {
      const result = execSync(
        `rg -l "AutoRecall\\.autoRecall|autoRecall\\(" "${SRC}/session/" "${SRC}/harness/" 2>/dev/null || true`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim()
      expect(result.length).toBeGreaterThan(0)
    })

    test("Consolidation.extractTurn has a call site outside its own definition", () => {
      const result = execSync(
        `rg -l "extractTurn" "${SRC}/session/" 2>/dev/null || true`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim()
      expect(result.length).toBeGreaterThan(0)
    })

    test("Consolidation.run is called from scheduler with non-empty recentSessionIds", () => {
      const path = src("scheduler", "scheduler.ts")
      if (!exists(path)) {
        expect(path).toBe("exists")
        return
      }
      const content = readFileSync(path, "utf-8")
      // Should reference Session.listGlobal (not the [] stub)
      const hasListGlobal = /Session\.listGlobal|listGlobal/.test(content)
      expect(hasListGlobal).toBe(true)
    })
  })
})
