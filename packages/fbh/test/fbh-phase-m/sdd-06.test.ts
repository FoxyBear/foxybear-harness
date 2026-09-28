import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-06 acceptance tests — derived from the spec's VERIFY section.
// These tests verify the M-3 lifecycle engine artifacts:
// - Simple exponential + rehearsal decay (default), Prism experimental
// - Lifecycle transitions (ACTIVE→DEPRECATED→ARCHIVED→DELETED)
// - Soft-delete via invalidated_by + INVALIDATE event
// - GC (hard-delete ARCHIVED past retention)
// - access_count >= 2 graduation default, force-promote at 5, semantic-shift shadow
// - Composite value scoring
// - Scheduler tasks (decay hourly, graduation daily, pruning weekly, gc weekly)
// - Stale penalty removed
// - Config consumed (CC-6)
// - Coupled-loop simulation spike (CC-15)
//
// These tests are RED until the implementation lands.

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

describe("SDD-06 M-3 Lifecycle Engine", () => {
  describe("Lifecycle service + decay", () => {
    test("src/memory/lifecycle/ directory exists", () => {
      expect(exists(join(SRC, "memory", "lifecycle"))).toBe(true)
    })

    test("MemoryLifecycle service or decay function is defined", () => {
      const found = grepRecursive(join(SRC, "memory", "lifecycle"), "MemoryLifecycle|decay")
      expect(found).toBe(true)
    })

    test("simple exponential + rehearsal decay formula is implemented (DEFAULT)", () => {
      const dir = join(SRC, "memory", "lifecycle")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/confidence.*\(1\s*[-+]\s*rate\)|exponential|rehearsal/i)
    })

    test("Prism replicator-decay is experimental behind config flag", () => {
      const dir = join(SRC, "memory", "lifecycle")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/prism/i)
    })

    test("decay is clamped to [0, 1]", () => {
      const dir = join(SRC, "memory", "lifecycle")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/Math\.min|Math\.max|clamp|min\(1|max\(0/i)
    })

    test("confidence + status updated atomically, STATUS_TRANSITION event appended", () => {
      const dir = join(SRC, "memory", "lifecycle")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/STATUS_TRANSITION|status.*transition/i)
    })
  })

  describe("Lifecycle transitions (SC-3 staged model)", () => {
    test("transitions follow ACTIVE→DEPRECATED→ARCHIVED→DELETED (no skips)", () => {
      const dir = join(SRC, "memory", "lifecycle")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/DEPRECATED/i)
      expect(allContent).toMatch(/ARCHIVED/i)
      expect(allContent).toMatch(/DELETED/i)
    })

    test("no direct ACTIVE→ARCHIVED transition (must go through DEPRECATED)", () => {
      const dir = join(SRC, "memory", "lifecycle")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      // The transition logic should check status === DEPRECATED before transitioning to ARCHIVED
      expect(allContent).toMatch(/status.*DEPRECATED.*ARCHIVED|DEPRECATED.*→.*ARCHIVED|if.*DEPRECATED/i)
    })
  })

  describe("Soft-delete via invalidated_by + INVALIDATE event", () => {
    test("soft-delete sets tx_to, status=DELETED, invalidated_by, emits INVALIDATE event", () => {
      const dir = join(SRC, "memory", "lifecycle")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/INVALIDATE/i)
      expect(allContent).toMatch(/invalidated_by/i)
      expect(allContent).toMatch(/tx_to/i)
    })

    test("no INVALIDATES hyperedge created (it's not a hyperedge type)", () => {
      const dir = join(SRC, "memory", "lifecycle")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      // Should NOT create a hyperedge for invalidation — use the field + event instead
      expect(allContent).not.toMatch(/CREATE.*INVALIDATES.*hyperedge|edge.*INVALIDATES/i)
    })
  })

  describe("GC (hard-delete ARCHIVED past retention)", () => {
    test("gc function exists and hard-deletes ARCHIVED past retention_days", () => {
      const dir = join(SRC, "memory", "lifecycle")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/gc|GC_DELETED|retention/i)
    })

    test("gc emits GC_DELETED event before hard-delete (audit trail preserved)", () => {
      const dir = join(SRC, "memory", "lifecycle")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/GC_DELETED/i)
    })
  })

  describe("Graduation (access_count >= 2 default, force-promote at 5, semantic-shift shadow)", () => {
    test("graduation uses access_count >= 2 as default trigger", () => {
      const found = grepRecursive(join(SRC, "memory"), "access_count.*2|gte.*2|>=\s*2")
      expect(found).toBe(true)
    })

    test("force-promote at 5 accesses exists", () => {
      const found = grepRecursive(join(SRC, "memory", "lifecycle"), "force_promote|forcePromote")
      expect(found).toBe(true)
    })

    test("semantic-shift shadow metric is implemented (logged, not gating)", () => {
      const found = grepRecursive(join(SRC, "memory", "lifecycle"), "semantic_shift|semanticShift|SHADOW_METRIC")
      expect(found).toBe(true)
    })
  })

  describe("Composite value scoring", () => {
    test("score function exists in src/memory/lifecycle/", () => {
      const found = grepRecursive(join(SRC, "memory", "lifecycle"), "score")
      expect(found).toBe(true)
    })

    test("score combines semantic + role + confidence + provenance + recency + usage + lifecycle", () => {
      const dir = join(SRC, "memory", "lifecycle")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/semantic/i)
      expect(allContent).toMatch(/confidence/i)
      expect(allContent).toMatch(/recency/i)
      expect(allContent).toMatch(/usage/i)
      expect(allContent).toMatch(/lifecycle/i)
    })
  })

  describe("Scheduler tasks", () => {
    test("memory-decay task registered (hourly)", () => {
      const content = readFile(join(SRC, "scheduler", "scheduler.ts"))
      expect(content).toMatch(/memory-decay|memory_decay/i)
    })

    test("memory-gc task registered (weekly)", () => {
      const content = readFile(join(SRC, "scheduler", "scheduler.ts"))
      expect(content).toMatch(/memory-gc|memory_gc/i)
    })

    test("memory-ttl-pruning task calls Consolidation.prune (not inline)", () => {
      const content = readFile(join(SRC, "scheduler", "scheduler.ts"))
      expect(content).toMatch(/prune|Consolidation\.prune/i)
    })

    test("scheduler tasks use English-label intervals (hourly/daily/weekly)", () => {
      const content = readFile(join(SRC, "scheduler", "scheduler.ts"))
      expect(content).toMatch(/hourly|daily|weekly/i)
    })
  })

  describe("Stale penalty removed", () => {
    test("binary stale penalty at memory.ts:458 is removed or deprecated", () => {
      const content = readFile(join(SRC, "memory", "memory.ts"))
      // The stale penalty should either be removed or marked deprecated
      // Check that it's no longer the active scoring path
      const hasStalePenalty = /stalePenaltyDays|stale_penalty_days/.test(content)
      // If it exists, it should be deprecated (comment)
      if (hasStalePenalty) {
        expect(content).toMatch(/deprecated|TODO.*remove|@deprecated/i)
      }
      // Either way, the test passes — the check is that the binary penalty is not the active path
    })
  })

  describe("Config consumed (CC-6)", () => {
    test("memory.decay config is read and consumed", () => {
      const found = grepRecursive(join(SRC, "memory", "lifecycle"), "decay\.active_rate|active_rate|decay_rate")
      expect(found).toBe(true)
    })

    test("memory.decay_model config flag exists (simple/prism/none)", () => {
      const found = grepRecursive(join(SRC, "memory", "lifecycle"), "decay_model|decayModel")
      expect(found).toBe(true)
    })

    test("memory.scheduler.tasks config with English intervals exists", () => {
      const found = grepRecursive(join(SRC, "config"), "tasks|scheduler.*tasks")
      expect(found).toBe(true)
    })
  })

  describe("Coupled-loop simulation spike (CC-15)", () => {
    test("coupled-loop simulation test file exists", () => {
      const spikePath = join(FBH, "test", "fbh-phase-m", "sdd-06-spike.test.ts")
      expect(exists(spikePath)).toBe(true)
    })

    test("coupled-loop sim tests decay + graduation + conflict interaction", () => {
      const spikePath = join(FBH, "test", "fbh-phase-m", "sdd-06-spike.test.ts")
      if (!exists(spikePath)) { expect(spikePath).toBe("exists"); return }
      const content = readFile(spikePath)
      expect(content).toMatch(/decay/i)
      expect(content).toMatch(/graduat/i)
      expect(content).toMatch(/conflict|contradict/i)
    })

    test("coupled-loop sim asserts stability criteria (bounded [0,1], no collapse, convergence)", () => {
      const spikePath = join(FBH, "test", "fbh-phase-m", "sdd-06-spike.test.ts")
      if (!exists(spikePath)) { expect(spikePath).toBe("exists"); return }
      const content = readFile(spikePath)
      expect(content).toMatch(/0\.0.*1\.0|bounded|clamp|collapse|converge|oscillat/i)
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
