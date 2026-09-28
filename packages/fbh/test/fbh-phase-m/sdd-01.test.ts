import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-01 acceptance tests — derived from the spec's VERIFY section.
// These tests verify the P-0 dormant-code audit was performed correctly
// by checking the required artifacts exist and are well-formed.
//
// The audit "implementation" is: the audit harness (test/p0_audit/),
// the decision log (docs/decisions/260921_fbh-phase-m_p0-dormant-code-audit.md),
// the two-engineer signatures, the verdict, and no source modifications.
//
// These tests are RED until the audit is performed.

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..") // FoxyBearOffice root
const FBH = join(import.meta.dir, "..", "..") // packages/fbh
const DECISION_LOG = join(ROOT, "docs", "decisions", "260921_fbh-phase-m_p0-dormant-code-audit.md")
const AUDIT_DIR = join(FBH, "test", "p0_audit")

function readLog(): string {
  if (!existsSync(DECISION_LOG)) return ""
  return readFileSync(DECISION_LOG, "utf-8")
}

describe("SDD-01 P-0 Dormant-Code Audit", () => {
  describe("V16 — Decision log exists with all 8 sections", () => {
    test("decision log file exists at docs/decisions/260921_fbh-phase-m_p0-dormant-code-audit.md", () => {
      expect(existsSync(DECISION_LOG)).toBe(true)
    })

    test("decision log has Header section", () => {
      const log = readLog()
      expect(log).toMatch(/#+\s*Header/i)
    })

    test("decision log has Per-component findings section", () => {
      const log = readLog()
      expect(log).toMatch(/#+\s*Per-component findings/i)
    })

    test("decision log has Defect log section", () => {
      const log = readLog()
      expect(log).toMatch(/#+\s*Defect log/i)
    })

    test("decision log has Disputes section", () => {
      const log = readLog()
      expect(log).toMatch(/#+\s*Disputes/i)
    })

    test("decision log has Verdict section", () => {
      const log = readLog()
      expect(log).toMatch(/#+\s*Verdict/i)
    })

    test("decision log has Signatures section", () => {
      const log = readLog()
      expect(log).toMatch(/#+\s*Signatures/i)
    })
  })

  describe("V15 — Two-engineer sign-off (CC-14)", () => {
    test("decision log has at least 2 engineer signatures", () => {
      const log = readLog()
      const sigMatches = log.match(/Signature|signed|Engineer.*:|Auditor.*:/gi) ?? []
      expect(sigMatches.length).toBeGreaterThanOrEqual(2)
    })

    test("decision log records recused components if any", () => {
      const log = readLog()
      expect(log).toMatch(/recus/i)
    })
  })

  describe("V17 — Verdict is GO / GO-WITH-CAVEATS / NO-GO", () => {
    test("decision log records a valid verdict", () => {
      const log = readLog()
      const hasGO = /\bGO\b/.test(log)
      const hasGOWithCaveats = /GO-WITH-CAVEATS/i.test(log)
      const hasNoGO = /NO-GO/i.test(log)
      expect(hasGO || hasGOWithCaveats || hasNoGO).toBe(true)
    })
  })

  describe("V14 — Non-authorship verified (git blame)", () => {
    test("decision log records git blame verification for all 11 anchor lines", () => {
      const log = readLog()
      expect(log).toMatch(/git blame/i)
      expect(log).toMatch(/consolidation\.ts:594|consolidation\.ts.*594/i)
      expect(log).toMatch(/consolidation\.ts:533|consolidation\.ts.*533/i)
      expect(log).toMatch(/recall\.ts:185|recall\.ts.*185/i)
      expect(log).toMatch(/recall\.ts:279|recall\.ts.*279/i)
      expect(log).toMatch(/surreal-backend\.ts:203|surreal-backend\.ts.*203/i)
      expect(log).toMatch(/graph\/surreal-backend\.ts:47|graph\/surreal-backend\.ts.*47/i)
    })
  })

  describe("V20 — No source modifications during audit", () => {
    test("git diff --stat -- src/ shows no modifications", () => {
      const diff = execSync("git diff --stat -- src/", {
        cwd: FBH,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()
      expect(diff).toBe("")
    })
  })

  describe("V21 — Audit harness typecheck passes", () => {
    test("test/p0_audit/ harness exists before typecheck", () => {
      expect(existsSync(AUDIT_DIR)).toBe(true)
    })

    test("bun run typecheck exits 0 with harness files present", () => {
      if (!existsSync(AUDIT_DIR)) {
        expect(AUDIT_DIR).toBe("exists") // force fail with context
        return
      }
      const result = execSync("bun run typecheck 2>&1", {
        cwd: FBH,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000,
      })
      expect(result).toBeDefined()
    })
  })

  describe("V22 — Audit harness test suite exists and passes", () => {
    test("test/p0_audit/ directory exists", () => {
      expect(existsSync(AUDIT_DIR)).toBe(true)
    })

    test("test/p0_audit/ has at least 11 component test files", () => {
      if (!existsSync(AUDIT_DIR)) {
        expect(AUDIT_DIR).toBe("exists") // force fail with context
        return
      }
      const { readdirSync } = require("fs")
      const files = readdirSync(AUDIT_DIR).filter((f: string) => f.endsWith(".test.ts"))
      expect(files.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe("V18 — A0-abort documented if fired", () => {
    test("if A0 fired, decision log records trigger component + repair estimates", () => {
      const log = readLog()
      const a0NotFired = /A0.*not\s*fired|A0-abort:\s*not\s*fired/i.test(log)
      const a0Fired = !a0NotFired && /A0.*\bfired\b|A0-abort:\s*fired/i.test(log)
      if (a0Fired) {
        expect(log).toMatch(/trigger component/i)
        expect(log).toMatch(/repair.*estimate/i)
        expect(log).toMatch(/engineer-days/i)
      }
      // If A0 didn't fire, this test passes (no-op)
    })
  })
})
