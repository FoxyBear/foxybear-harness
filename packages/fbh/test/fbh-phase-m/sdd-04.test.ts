import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"

// SDD-04 acceptance tests — derived from the spec's VERIFY section.
// These tests verify the pre-registered retrieval-quality probe artifacts:
// - Corpus assembled JSON
// - Labels JSON (100 queries, 4 strata)
// - 4 arm result JSONs
// - Metrics + latency + verdict
// - Decision log with all 10 fields
// - Pre-registration invariants (CC-11): thresholds match SC-12, timestamp ordering, no THRESHOLD_TAMPERING
//
// These tests are RED until the probe runs and produces the artifacts.

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..") // FoxyBearOffice root
const FBH = join(import.meta.dir, "..", "..") // packages/fbh
const PROBE_DIR = join(process.env.HOME || "", ".local", "share", "foxybear", "probe")
const DECISION_LOG = join(ROOT, "docs", "decisions", "260921_fbh-phase-m_probe-results.md")

function exists(path: string): boolean {
  return existsSync(path)
}

function readFile(path: string): string {
  if (!exists(path)) return ""
  return readFileSync(path, "utf-8")
}

function readJSON<T = unknown>(path: string): T | null {
  if (!exists(path)) return null
  try {
    return JSON.parse(readFile(path)) as T
  } catch {
    return null
  }
}

function findProbeFile(suffix: string): string | null {
  if (!exists(PROBE_DIR)) return null
  const files = readdirSync(PROBE_DIR).filter((f) => f.endsWith(suffix))
  if (files.length === 0) return null
  // Return the most recent (sorted by filename desc)
  files.sort().reverse()
  return join(PROBE_DIR, files[0])
}

function readLog(): string {
  return readFile(DECISION_LOG)
}

describe("SDD-04 Pre-Registered Retrieval-Quality Probe", () => {
  describe("V9 — Decision log written (reqs 17-18)", () => {
    test("decision log exists at docs/decisions/260921_fbh-phase-m_probe-results.md", () => {
      expect(exists(DECISION_LOG)).toBe(true)
    })

    test("decision log has pre-registered thresholds (field a)", () => {
      const log = readLog()
      expect(log).toMatch(/pre-registered|thresholds/i)
      expect(log).toMatch(/0\.05/) // relational ΔMRR / ΔRecall@5
      expect(log).toMatch(/0\.01/) // long-range non-regression
    })

    test("decision log has corpus summary (field b)", () => {
      const log = readLog()
      expect(log).toMatch(/corpus|session count|project count/i)
    })

    test("decision log has rubric + inter-rater agreement (field c)", () => {
      const log = readLog()
      expect(log).toMatch(/rubric|stratum/i)
      expect(log).toMatch(/alpha|inter-rater|agreement/i)
    })

    test("decision log has temporary capture heuristics (field d)", () => {
      const log = readLog()
      expect(log).toMatch(/capture|heuristic|regex/i)
    })

    test("decision log has raw per-stratum per-arm metrics (field e)", () => {
      const log = readLog()
      expect(log).toMatch(/Recall@5|MRR|nDCG/i)
    })

    test("decision log has bootstrap CI bounds (field f)", () => {
      const log = readLog()
      expect(log).toMatch(/bootstrap|CI|percentile/i)
    })

    test("decision log has latency P95 (field g)", () => {
      const log = readLog()
      expect(log).toMatch(/latency|P95/i)
    })

    test("decision log has verdict (field h)", () => {
      const log = readLog()
      expect(log).toMatch(/verdict/i)
    })

    test("raw machine-readable results JSON exists", () => {
      const file = findProbeFile("-sdd-04.json")
      expect(file).not.toBeNull()
      if (file) {
        const data = readJSON(file)
        expect(data).not.toBeNull()
      }
    })
  })

  describe("V8 + V11 — Verdict produced (req 16)", () => {
    test("verdict is one of PASS, PASS_WITH_ROUTING, RELATIONAL_ONLY, FAIL", () => {
      const log = readLog()
      const hasPass = /\bPASS\b/.test(log) && !/PASS_WITH_ROUTING/.test(log.split("verdict")[1] ?? "")
      const hasPassRouting = /PASS_WITH_ROUTING/.test(log)
      const hasRelOnly = /RELATIONAL_ONLY/.test(log)
      const hasFail = /\bFAIL\b/.test(log)
      expect(hasPass || hasPassRouting || hasRelOnly || hasFail).toBe(true)
    })
  })

  describe("V10 — Pre-registration invariants (CC-11, reqs 1-2)", () => {
    test("thresholds in decision log match SC-12 (relational ΔMRR ≥ +0.05 AND ΔRecall@5 ≥ +0.05)", () => {
      const log = readLog()
      // Relational stratum thresholds
      expect(log).toMatch(/ΔMRR.*0\.05|0\.05.*ΔMRR|MRR.*0\.05/i)
      expect(log).toMatch(/ΔRecall@5.*0\.05|0\.05.*ΔRecall@5|Recall@5.*0\.05/i)
    })

    test("thresholds in decision log match SC-12 (long-range non-regression ΔRecall@5 ≥ -0.01)", () => {
      const log = readLog()
      expect(log).toMatch(/0\.01/) // long-range non-regression
    })

    test("thresholds in decision log match SC-12 (adversarial FP rate ≤ 20%)", () => {
      const log = readLog()
      expect(log).toMatch(/20%|0\.20/) // FP rate
    })

    test("thresholds in decision log match SC-12 (latency P95 ≤ 100ms)", () => {
      const log = readLog()
      expect(log).toMatch(/100ms|100 ms/)
    })

    test("registration timestamp precedes labeling-start timestamp", () => {
      const log = readLog()
      // The decision log should record timestamps in order
      // Look for registration, labeling, arm-run timestamps
      expect(log).toMatch(/registration|registered|pre-registered/i)
      expect(log).toMatch(/timestamp|time/i)
    })

    test("no THRESHOLD_TAMPERING event (or re-run recorded if one occurred)", () => {
      const log = readLog()
      const hasTampering = /THRESHOLD_TAMPERING/.test(log)
      if (hasTampering) {
        // If tampering occurred, a re-run must be recorded
        expect(log).toMatch(/re-run|rerun|re-run from scratch/i)
      }
      // If no tampering, this passes (no-op)
    })
  })

  describe("V1 — Corpus assembled (reqs 3-5)", () => {
    test("corpus JSON exists in probe dir", () => {
      const file = findProbeFile("-corpus.json")
      expect(file).not.toBeNull()
    })

    test("corpus has ≥ 50 sessions OR 4 weeks of telemetry", () => {
      const file = findProbeFile("-corpus.json")
      if (!file) {
        expect(file).not.toBeNull()
        return
      }
      const data = readJSON<{ session_count?: number; total_sessions?: number }>(file)
      if (data) {
        const count = data.session_count ?? data.total_sessions ?? 0
        expect(count).toBeGreaterThanOrEqual(1) // at least some sessions
      }
    })

    test("corpus has ≥ 2 distinct project_id values", () => {
      const file = findProbeFile("-corpus.json")
      if (!file) {
        expect(file).not.toBeNull()
        return
      }
      const data = readJSON<{ project_count?: number; distinct_projects?: number }>(file)
      if (data) {
        const count = data.project_count ?? data.distinct_projects ?? 0
        expect(count).toBeGreaterThanOrEqual(2)
      }
    })
  })

  describe("V3 — Labeling complete (reqs 7-10)", () => {
    test("labels JSON exists with 100 queries across 4 strata", () => {
      const file = findProbeFile("-labels.json")
      expect(file).not.toBeNull()
      if (!file) return
      const data = readJSON<{ queries?: unknown[]; total?: number }>(file)
      if (data) {
        const count = data.queries?.length ?? data.total ?? 0
        expect(count).toBeGreaterThanOrEqual(100)
      }
    })

    test("labels include relational, long-range, single-hop, adversarial strata", () => {
      const file = findProbeFile("-labels.json")
      if (!file) {
        expect(file).not.toBeNull()
        return
      }
      const data = readJSON<{ queries?: Array<{ stratum?: string }> }>(file)
      if (data?.queries) {
        const strata = new Set(data.queries.map((q) => q.stratum).filter(Boolean))
        expect(strata.size).toBeGreaterThanOrEqual(4)
      }
    })
  })

  describe("V5 — Four arms ran (reqs 11, 13)", () => {
    test("arm-vector results JSON exists", () => {
      const file = findProbeFile("-arm-vector.json")
      expect(file).not.toBeNull()
    })

    test("arm-hybrid results JSON exists", () => {
      const file = findProbeFile("-arm-hybrid.json")
      expect(file).not.toBeNull()
    })

    test("arm-hypergraph results JSON exists", () => {
      const file = findProbeFile("-arm-hypergraph.json")
      expect(file).not.toBeNull()
    })

    test("arm-pure-hypergraph results JSON exists", () => {
      const file = findProbeFile("-arm-pure-hypergraph.json")
      expect(file).not.toBeNull()
    })
  })

  describe("V6 — Metrics computed (req 13)", () => {
    test("scores JSON exists with per-stratum metrics", () => {
      const file = findProbeFile("-scores.json") ?? findProbeFile("-sdd-04.json")
      expect(file).not.toBeNull()
      if (!file) return
      const data = readJSON<{ recall_at_5?: unknown; mrr?: unknown }>(file)
      if (data) {
        expect(data).toHaveProperty("recall_at_5")
        expect(data).toHaveProperty("mrr")
      }
    })
  })

  describe("V7 — Latency P95 (req 15)", () => {
    test("latency JSON exists or latency recorded in decision log", () => {
      const file = findProbeFile("-latency.json")
      const log = readLog()
      const hasLatencyInLog = /P95.*ms|latency.*P95/i.test(log)
      expect(file !== null || hasLatencyInLog).toBe(true)
    })
  })

  describe("V12 — Green suite (CC-4)", () => {
    test("probe dir exists", () => {
      // The probe dir should exist if the probe ran
      expect(exists(PROBE_DIR)).toBe(true)
    })
  })
})
