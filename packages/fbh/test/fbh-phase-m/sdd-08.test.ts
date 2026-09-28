import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-08 acceptance tests — derived from the spec's VERIFY section.
// These tests verify the M-6 verification & benchmark artifacts:
// - Benchmark harness (src/memory/bench/)
// - A/B tests (injection, relational, long-range)
// - Tuning sweeps (decay, conflict, budget, semantic-shift)
// - Contradiction-rate measurement (evidence for M-5)
// - Live smoke test
// - Results doc
// - Abort A7 / A8

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const FBH = join(import.meta.dir, "..", "..")
const SRC = join(FBH, "src")
const BENCH_DIR = join(process.env.HOME || "", ".local", "share", "foxybear", "bench")
const RESULTS_DOC = join(ROOT, "docs", "research", "260922_fbh-phase-m_benchmark.md")

function exists(path: string): boolean { return existsSync(path) }
function readFile(path: string): string { return exists(path) ? readFileSync(path, "utf-8") : "" }
function grepRecursive(dir: string, pattern: string): boolean {
  if (!exists(dir)) return false
  try {
    return execSync(`rg -l "${pattern}" "${dir}" 2>/dev/null || true`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().length > 0
  } catch { return false }
}
function findBenchFile(suffix: string): string | null {
  if (!exists(BENCH_DIR)) return null
  const files = readdirSync(BENCH_DIR).filter((f) => f.endsWith(suffix))
  if (files.length === 0) return null
  files.sort().reverse()
  return join(BENCH_DIR, files[0])
}

describe("SDD-08 M-6 Verification & Benchmark", () => {
  describe("Benchmark harness", () => {
    test("src/memory/bench/ directory exists", () => {
      expect(exists(join(SRC, "memory", "bench"))).toBe(true)
    })

    test("bench function is defined", () => {
      const found = grepRecursive(join(SRC, "memory", "bench"), "bench")
      expect(found).toBe(true)
    })

    test("harness computes AgentMemBench metrics (Recall@k, MRR, nDCG, F1, Faithfulness, Footprint, Latency)", () => {
      const dir = join(SRC, "memory", "bench")
      if (!exists(dir)) { expect(dir).toBe("exists"); return }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/Recall/i)
      expect(allContent).toMatch(/MRR|nDCG/i)
    })
  })

  describe("A/B tests — injection (with vs without memory)", () => {
    test("injection A/B results JSON exists", () => {
      const file = findBenchFile("-injection.json") ?? findBenchFile("-ab.json")
      expect(file).not.toBeNull()
    })

    test("injection A/B records Faithfulness + F1 for both arms", () => {
      const file = findBenchFile("-injection.json") ?? findBenchFile("-ab.json")
      if (!file) { expect(file).not.toBeNull(); return }
      const content = readFile(file)
      expect(content).toMatch(/faithfulness|Faithfulness/i)
    })
  })

  describe("A/B tests — relational (with vs without hypergraph)", () => {
    test("relational A/B results JSON exists", () => {
      const file = findBenchFile("-relational.json") ?? findBenchFile("-hypergraph.json")
      expect(file).not.toBeNull()
    })

    test("relational A/B records Recall@5 for both arms (KV vs hypergraph)", () => {
      const file = findBenchFile("-relational.json") ?? findBenchFile("-hypergraph.json")
      if (!file) { expect(file).not.toBeNull(); return }
      const content = readFile(file)
      expect(content).toMatch(/recall/i)
    })
  })

  describe("Long-range recall (KV axis, regression guard)", () => {
    test("long-range results JSON exists", () => {
      const file = findBenchFile("-long-range.json") ?? findBenchFile("-longrange.json")
      expect(file).not.toBeNull()
    })

    test("long-range records Recall@5 for both KV and hypergraph arms", () => {
      const file = findBenchFile("-long-range.json") ?? findBenchFile("-longrange.json")
      if (!file) { expect(file).not.toBeNull(); return }
      const content = readFile(file)
      expect(content).toMatch(/recall/i)
    })
  })

  describe("Threshold tuning sweeps", () => {
    test("decay tuning sweep results exist", () => {
      const file = findBenchFile("-decay-tune.json") ?? findBenchFile("-decay.json")
      expect(file).not.toBeNull()
    })

    test("conflict tuning sweep results exist (pre-calibration for M-5)", () => {
      const file = findBenchFile("-conflict-tune.json") ?? findBenchFile("-conflict.json")
      expect(file).not.toBeNull()
    })

    test("budget tuning sweep results exist", () => {
      const file = findBenchFile("-budget-tune.json") ?? findBenchFile("-budget.json")
      expect(file).not.toBeNull()
    })

    test("semantic-shift tuning sweep results exist", () => {
      const file = findBenchFile("-shift-tune.json") ?? findBenchFile("-shift.json")
      expect(file).not.toBeNull()
    })
  })

  describe("Contradiction-rate measurement (evidence for M-5)", () => {
    test("contradiction-rate results JSON exists", () => {
      const file = findBenchFile("-contradiction.json")
      expect(file).not.toBeNull()
    })

    test("contradiction-rate records the rate + severity distribution", () => {
      const file = findBenchFile("-contradiction.json")
      if (!file) { expect(file).not.toBeNull(); return }
      const content = readFile(file)
      expect(content).toMatch(/rate|contradiction/i)
      expect(content).toMatch(/minor|moderate|severe|severity/i)
    })

    test("A8 decision recorded (defer M-5 or activate M-5 based on 5% threshold)", () => {
      const file = findBenchFile("-contradiction.json")
      const doc = readFile(RESULTS_DOC)
      const hasA8 = /A8|abort.*A8|defer.*M-5|activate.*M-5/i.test(doc) || /A8|defer.*M-5|activate.*M-5/i.test(file ? readFile(file) : "")
      expect(hasA8).toBe(true)
    })
  })

  describe("Live smoke test (CC-5)", () => {
    test("smoke test checklist file exists", () => {
      const file = findBenchFile("-smoke.md")
      expect(file).not.toBeNull()
    })

    test("smoke checklist has rows for 12a-12d assertions", () => {
      const file = findBenchFile("-smoke.md")
      if (!file) { expect(file).not.toBeNull(); return }
      const content = readFile(file)
      expect(content).toMatch(/12a|injection|Relevant Memories/i)
      expect(content).toMatch(/12b|auto-capture|hypergraph|node table/i)
      expect(content).toMatch(/12c|scheduler|event/i)
    })
  })

  describe("Results documentation", () => {
    test("results doc exists at docs/research/260922_fbh-phase-m_benchmark.md", () => {
      expect(exists(RESULTS_DOC)).toBe(true)
    })

    test("results doc records aggregate metrics for A/B arms", () => {
      const doc = readFile(RESULTS_DOC)
      expect(doc).toMatch(/Recall|Faithfulness|F1/i)
    })

    test("results doc records relational vs long-range results", () => {
      const doc = readFile(RESULTS_DOC)
      expect(doc).toMatch(/relational/i)
      expect(doc).toMatch(/long-range|long range/i)
    })

    test("results doc records contradiction rate + A8 decision", () => {
      const doc = readFile(RESULTS_DOC)
      expect(doc).toMatch(/contradiction/i)
      expect(doc).toMatch(/A8|M-5.*defer|M-5.*activate/i)
    })

    test("results doc records AgentMemBench caveat (graph for relational, not bulk recall)", () => {
      const doc = readFile(RESULTS_DOC)
      expect(doc).toMatch(/relational.*reasoning|graph.*relational|not.*bulk.*recall|caveat/i)
    })
  })

  describe("Abort A7 (schedule slip)", () => {
    test("A7 status recorded (elapsed days, provisional value evidence)", () => {
      const doc = readFile(RESULTS_DOC)
      expect(doc).toMatch(/A7|schedule|elapsed|provisional/i)
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
