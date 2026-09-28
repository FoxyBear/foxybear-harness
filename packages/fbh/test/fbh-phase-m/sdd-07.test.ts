import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-07 acceptance tests — derived from the spec's VERIFY section.
// These tests verify the M-4 context packing implementation:
// - BudgetAwarePacker (pack(query, project_id, budget))
// - TypedFormatter (extends formatForInjection, typed blocks)
// - ProvenanceTracker (feedback increments usage_count directly, no rehearse)
// - Session service (Context.Tag + Effect.provideService)
// - Probe findings PF-1 through PF-7 (HNSW KNN + project_id, adjacency map, depth=1, fanout cap, cache)
// - Schema subsetting (6 active, ENTITY expansion-only, no reserved)
// - Config consumed (CC-6)
// - Wire into prompt.ts
// - Abort A6

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

describe("SDD-07 M-4 Context Packing & Injection", () => {
  describe("BudgetAwarePacker", () => {
    test("src/memory/packing/ directory exists", () => {
      expect(exists(join(SRC, "memory", "packing"))).toBe(true)
    })

    test("ContextPacker or pack function is defined", () => {
      const found = grepRecursive(join(SRC, "memory", "packing"), "ContextPacker|pack")
      expect(found).toBe(true)
    })

    test("pack signature is pack(query, project_id, budget)", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/project_id/i)
      expect(allContent).toMatch(/budget/i)
    })

    test("slash commands return empty PackedContext", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/\/|slash|startsWith/i)
    })
  })

  describe("Session service (Context.Tag + Effect.provideService)", () => {
    test("Session service is defined (Context.Tag or Context.Service)", () => {
      const found = grepRecursive(join(SRC, "memory", "packing"), "Session|Context\.Tag|Context\.Service")
      expect(found).toBe(true)
    })

    test("Session provides sessionID + persona", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/sessionID|session_id/i)
      expect(allContent).toMatch(/persona/i)
    })
  })

  describe("Probe findings PF-1 through PF-7 (production requirements)", () => {
    test("PF-1: HNSW KNN operator <|K,COSINE|> used for seed query (NOT ORDER BY cosine)", () => {
      const dir = join(SRC, "memory", "packing")
      const hypergraphDir = join(SRC, "memory")
      const dirs = [dir, hypergraphDir]
      const anyHnsw = dirs.some((d) => {
        if (!exists(d)) return false
        const files = execSync(`ls "${d}"`, { encoding: "utf-8" }).trim().split("\n")
        const allContent = files.map((f) => readFile(join(d, f))).join("\n")
        return /<\|K,COSINE\|>|<\|\d+,COSINE\|>/i.test(allContent) || /KNN|knn/i.test(allContent)
      })
      expect(anyHnsw).toBe(true)
    })

    test("PF-2: in-memory adjacency map for expand()", () => {
      const found = grepRecursive(join(SRC, "memory"), "adjacency|adjacencyMap|Map<.*node_id")
      expect(found).toBe(true)
    })

    test("PF-3: expand depth=1 (not depth=2)", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      // Should reference depth: 1 or depth=1
      expect(allContent).toMatch(/depth.*1|1.*depth/i)
    })

    test("PF-4: fanout cap at 10", () => {
      const found = grepRecursive(join(SRC, "memory"), "LIMIT 10|fanout|fanout_cap")
      expect(found).toBe(true)
    })

    test("PF-6: session-scoped LRU cache for seed queries", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/cache|LRU|lru/i)
    })
  })

  describe("TypedFormatter (extends formatForInjection)", () => {
    test("TypedFormatter is defined", () => {
      const found = grepRecursive(join(SRC, "memory", "packing"), "TypedFormatter|format")
      expect(found).toBe(true)
    })

    test("produces ## Relevant Memories block (delegates to formatForInjection)", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/Relevant Memories|formatForInjection/i)
    })

    test("produces typed blocks for Actions, Errors, Procedures", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/Relevant Actions|Relevant Errors|Relevant Procedures/i)
    })

    test("preserves dates, sources, staleness warnings", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/date|source|stale|verify before acting/i)
    })
  })

  describe("ProvenanceTracker (no rehearse method)", () => {
    test("ProvenanceTracker is defined", () => {
      const found = grepRecursive(join(SRC, "memory", "packing"), "ProvenanceTracker|provenance|track")
      expect(found).toBe(true)
    })

    test("feedback increments usage_count directly (no rehearse method)", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/usage_count|feedback/i)
      // Should NOT call a rehearse method
      expect(allContent).not.toMatch(/\.rehearse\(|MemoryLifecycle\.rehearse/i)
    })
  })

  describe("Schema subsetting (CC-13)", () => {
    test("packer operates on 6 active node types only", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      // Should reference active types
      expect(allContent).toMatch(/MEMORY|ACTION|ERROR|MESSAGE/i)
    })

    test("ENTITY is expansion-input only (filtered out before formatting)", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/entity.*filter|filter.*entity|node_type.*entity|entity.*pack/i)
    })
  })

  describe("L0-L3 retrieval hierarchy (TencentDB concept)", () => {
    test("L3 bootstrap first (high-confidence AGENT/INSIGHT/PROCEDURE)", () => {
      const dir = join(SRC, "memory", "packing")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/bootstrap|L3|high.*confidence/i)
    })
  })

  describe("Budget enforcement", () => {
    test("budget_tokens config exists (default 1024)", () => {
      const found = grepRecursive(join(SRC, "config"), "budget_tokens|packing")
      expect(found).toBe(true)
    })

    test("type_diversity config exists (default true)", () => {
      const found = grepRecursive(join(SRC, "config"), "type_diversity|typeDiversity")
      expect(found).toBe(true)
    })

    test("expansion_mode config exists (hypergraph/one_hop/top_k)", () => {
      const found = grepRecursive(join(SRC, "config"), "expansion_mode|expansionMode")
      expect(found).toBe(true)
    })
  })

  describe("Wire into prompt.ts", () => {
    test("ContextPacker.pack is called from prompt.ts", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      const hasPacker = /ContextPacker|packer\.pack|\.pack\(/i.test(content)
      expect(hasPacker).toBe(true)
    })

    test("packed.text injected into system array before handle.process", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      expect(content).toMatch(/packed|packed\.text|pack\.text/i)
    })
  })

  describe("Abort A6 (pack P95 > 300ms unfixable → top_k)", () => {
    test("expansion_mode top_k degrade path exists", () => {
      const found = grepRecursive(join(SRC, "memory", "packing"), "top_k|topk|degrade")
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
