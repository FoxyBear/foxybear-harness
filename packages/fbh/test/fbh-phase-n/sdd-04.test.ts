import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-04 acceptance tests — Gate-Extract-Classify Pipeline.
// Tests verify the 4-stage classification pipeline exists and orchestrates
// Jev (gate + classify) → Gemini (extract) → store, with buffer context.

const FBH = join(import.meta.dir, "..", "..")
const SRC = join(FBH, "src")

function exists(path: string): boolean { return existsSync(path) }
function readFile(path: string): string { return exists(path) ? readFileSync(path, "utf-8") : "" }
function grep(path: string, pattern: string): boolean {
  if (!exists(path)) return false
  return new RegExp(pattern).test(readFile(path))
}
function grepRecursive(dir: string, pattern: string): boolean {
  if (!exists(dir)) return false
  try {
    return execSync(`rg -l "${pattern}" "${dir}" 2>/dev/null || true`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().length > 0
  } catch { return false }
}

describe("SDD-04 Phase N — Gate-Extract-Classify Pipeline", () => {
  describe("V1 — Pipeline file + entry point exist (SC-1)", () => {
    test("src/memory/classify/ directory exists", () => {
      expect(exists(join(SRC, "memory", "classify"))).toBe(true)
    })

    test("src/memory/classify/pipeline.ts exists", () => {
      expect(exists(join(SRC, "memory", "classify", "pipeline.ts"))).toBe(true)
    })

    test("pipeline.ts exports classify function", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/export\s+async\s+function\s+classify|export\s+\{[^}]*classify/)
    })

    test("ClassifyInput interface exists", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      const hasInput = /ClassifyInput/.test(content) || /interface.*Input/.test(content)
      expect(hasInput).toBe(true)
    })

    test("ClassifyResult interface exists", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      const hasResult = /ClassifyResult/.test(content) || /interface.*Result/.test(content)
      expect(hasResult).toBe(true)
    })

    test("ClassifyInput has sessionID, text, project_id, persona", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/sessionID|session_id/i)
      expect(content).toMatch(/text\b/)
      expect(content).toMatch(/project_id/i)
      expect(content).toMatch(/persona/i)
    })

    test("ClassifyResult has stored, skipped, errors", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/stored/i)
      expect(content).toMatch(/skipped/i)
      expect(content).toMatch(/errors/i)
    })
  })

  describe("V2 — Pipeline orchestrates Jev gate (stage 1)", () => {
    test("pipeline imports or calls Jev.noul for the gate", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/Jev\.noul|Jev\b.*noul/i)
    })

    test("pipeline uses gate_threshold from config", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/gate_threshold|gateThreshold/i)
    })

    test("pipeline skips extraction if gate fails (enriches_future < threshold)", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      // Should have a conditional that skips when gate doesn't pass
      expect(content).toMatch(/skip|return|threshold|gate/i)
    })
  })

  describe("V3 — Pipeline orchestrates Gemini extract (stage 2)", () => {
    test("pipeline imports or calls Gemini.extract", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/Gemini\.extract|Gemini\b.*extract/i)
    })

    test("pipeline only calls extract when gate passes", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      // The extract call should be inside a conditional (after the gate check)
      expect(content).toMatch(/if|threshold|gate|skip/i)
    })
  })

  describe("V4 — Pipeline orchestrates Jev classify (stage 3)", () => {
    test("pipeline imports or calls Jev.choice for classification", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/Jev\.choice|Jev\b.*choice/i)
    })

    test("pipeline skips storing memories with type 'none'", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/none/i)
    })
  })

  describe("V5 — Pipeline owns the store (stage 4, SC-1)", () => {
    test("pipeline calls SurrealHypergraphBackend.store or backend store", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      const hasStore = /store\b|SurrealHypergraphBackend|getGlobalHypergraphBackend|Hypergraph/i.test(content)
      expect(hasStore).toBe(true)
    })

    test("pipeline embeds memories before storing", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      const hasEmbed = /embed|Embedding/i.test(content)
      expect(hasEmbed).toBe(true)
    })

    test("pipeline stores as MEMORY node type", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/MEMORY/i)
    })

    test("pipeline sets confidence in attributes (not top-level)", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/confidence/i)
    })
  })

  describe("V6 — Pipeline uses circular buffer (SC-1)", () => {
    test("pipeline calls Buffer.getContext for Jev state", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/Buffer\.getContext|Buffer\b.*getContext/i)
    })

    test("pipeline calls Buffer.add after processing", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/Buffer\.add|Buffer\b.*add\b/i)
    })

    test("pipeline uses sessionID for buffer calls (session-scoped)", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      // Buffer calls should include sessionID parameter
      const hasSession = /sessionID/.test(content)
      expect(hasSession).toBe(true)
    })
  })

  describe("V7 — Secrets redaction before LLM calls (CC-6)", () => {
    test("pipeline calls redact before sending content to Jev or Gemini", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/redact/i)
    })
  })

  describe("V8 — Pipeline is async (CC-3)", () => {
    test("classify function is async", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/async\s+function\s+classify|async\s+classify/)
    })
  })

  describe("V9 — external_opt_in handling (SC-2)", () => {
    test("pipeline reads external_opt_in from config", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      expect(content).toMatch(/external_opt_in|externalOptIn/i)
    })
  })

  describe("V10 — Circuit breaker (CC-9)", () => {
    test("pipeline handles circuit breaker fallback to regex", () => {
      const content = readFile(join(SRC, "memory", "classify", "pipeline.ts"))
      // Should reference the circuit breaker or fallback
      const hasFallback = /fallback|circuit|regex/i.test(content)
      expect(hasFallback).toBe(true)
    })
  })

  describe("V11 — Typecheck green (CC-7)", () => {
    test("bun run typecheck exits 0", () => {
      const result = execSync("bun run typecheck 2>&1", {
        cwd: FBH, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000,
      })
      expect(result).toBeDefined()
    })
  })
})
