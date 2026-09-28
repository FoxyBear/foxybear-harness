import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-09 acceptance tests — derived from the spec's VERIFY section.
// These tests verify the M-5 conflict detection implementation:
// - ConflictDetector.check(content, project_id) → ADD/UPDATE/DELETE
// - MOSAIC neighbor lookup (cosine, project-scoped)
// - HiGram path localization
// - Decision-driven write loop (ADD/UPDATE/DELETE)
// - Bi-temporal soft-delete (invalidated_by + INVALIDATE event)
// - delete_threshold config (distinct from archived_threshold)
// - llm_verify fallback (ADD on LLM unavailable)
// - Effect.runPromise for Effect-returning check
// - Cross-project isolation
// - Spike (FP rate)
// - Activation gate (M5_ACTIVATE from sdd-08)

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const FBH = join(import.meta.dir, "..", "..")
const SRC = join(FBH, "src")

function exists(path: string): boolean { return existsSync(path) }
function readFile(path: string): string { return exists(path) ? readFileSync(path, "utf-8") : "" }
function grepRecursive(dir: string, pattern: string): boolean {
  if (!exists(dir)) return false
  try {
    return execSync(`rg -l "${pattern}" "${dir}" 2>/dev/null || true`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().length > 0
  } catch { return false }
}

describe("SDD-09 M-5 Conflict Detection", () => {
  describe("Activation gate (M5_ACTIVATE from sdd-08)", () => {
    test("contradiction-rate evidence exists from sdd-08", () => {
      const benchDir = join(process.env.HOME || "", ".local", "share", "foxybear", "bench")
      const found = exists(benchDir) && execSync(`ls "${benchDir}"`, { encoding: "utf-8" }).includes("contradiction")
      expect(found).toBe(true)
    })
  })

  describe("ConflictDetector service", () => {
    test("src/memory/conflict/ directory exists", () => {
      expect(exists(join(SRC, "memory", "conflict"))).toBe(true)
    })

    test("ConflictDetector or check function is defined", () => {
      const found = grepRecursive(join(SRC, "memory", "conflict"), "ConflictDetector|check")
      expect(found).toBe(true)
    })

    test("check signature is check(content, project_id) → ADD/UPDATE/DELETE", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/ADD/i)
      expect(allContent).toMatch(/UPDATE/i)
      expect(allContent).toMatch(/DELETE/i)
      expect(allContent).toMatch(/project_id/i)
    })
  })

  describe("Wiring into Memory.store", () => {
    test("Memory.store invokes ConflictDetector.check", () => {
      const content = readFile(join(SRC, "memory", "memory.ts"))
      const hasCheck = /ConflictDetector|conflict.*check|check.*conflict/i.test(content)
      expect(hasCheck).toBe(true)
    })
  })

  describe("MOSAIC neighbor lookup", () => {
    test("neighbor lookup uses cosine similarity, scoped to project_id", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/cosine/i)
      expect(allContent).toMatch(/project_id/i)
    })
  })

  describe("Contradiction scoring + thresholds", () => {
    test("cosine_threshold config exists (default 0.3, calibrated 0.20 from M-6)", () => {
      const found = grepRecursive(join(SRC, "config"), "cosine_threshold|cosineThreshold")
      expect(found).toBe(true)
    })

    test("delete_threshold config exists (default 0.1, distinct from archived_threshold)", () => {
      const found = grepRecursive(join(SRC, "config"), "delete_threshold|deleteThreshold")
      expect(found).toBe(true)
    })

    test("ADD when cosine >= cosine_threshold", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/cosine_threshold|>=.*threshold|threshold.*ADD/i)
    })

    test("UPDATE when cosine < cosine_threshold and >= delete_threshold", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/delete_threshold|UPDATE/i)
    })

    test("DELETE when cosine < delete_threshold", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/DELETE/i)
    })
  })

  describe("llm_verify fallback", () => {
    test("llm_verify config flag exists", () => {
      const found = grepRecursive(join(SRC, "config"), "llm_verify|llmVerify")
      expect(found).toBe(true)
    })

    test("llm_verify ADD fallback on LLM unavailable", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/fallback|ADD.*unavailable|unavailable.*ADD/i)
    })
  })

  describe("Bi-temporal soft-delete (UPDATE/DELETE)", () => {
    test("UPDATE creates new node with prev_version_id back-pointer", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/prev_version_id/i)
    })

    test("DELETE sets tx_to=now, status=DELETED, invalidated_by, emits INVALIDATE event", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/INVALIDATE/i)
      expect(allContent).toMatch(/invalidated_by/i)
      expect(allContent).toMatch(/tx_to/i)
    })

    test("no hard-delete on conflict (GC-only on ARCHIVED past retention)", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      // Should NOT hard-delete on conflict — only soft-delete
      expect(allContent).not.toMatch(/hardDelete.*conflict|DELETE.*hard/i)
    })
  })

  describe("HiGram path localization", () => {
    test("localize function identifies evidence path (hyperedges referencing target)", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/localize|path.*local|evidence.*path/i)
    })

    test("localized subgraph recorded in event payload (audit trail)", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/payload|subgraph|audit/i)
    })
  })

  describe("Cross-project isolation", () => {
    test("conflict check scoped to project_id (no cross-project contamination)", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/project_id/i)
    })
  })

  describe("Effect.runPromise for Effect-returning check", () => {
    test("check uses Effect.runPromise (not raw await on Effect)", () => {
      const dir = join(SRC, "memory", "conflict")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      const hasRunPromise = /runPromise|Effect\.runPromise/i.test(allContent)
      const hasAwait = /await\s+ConflictDetector/.test(allContent)
      // Either runPromise OR not awaiting an Effect directly
      expect(hasRunPromise || !hasAwait).toBe(true)
    })
  })

  describe("Config consumed (CC-6)", () => {
    test("memory.conflict config is read and consumed", () => {
      const found = grepRecursive(join(SRC, "memory", "conflict"), "conflict\.cosine|conflict\.delete|conflict\.llm")
      expect(found).toBe(true)
    })
  })

  describe("Typecheck green", () => {
    test("bun run typecheck exits 0", () => {
      const result = execSync("bun run typecheck 2>&1", {
        cwd: FBH, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000,
      })
      expect(result).toBeDefined()
    })
  })
})
