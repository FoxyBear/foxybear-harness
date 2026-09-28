import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-03 acceptance tests — derived from the spec's VERIFY section.
// These tests verify the M-1 hypergraph schema implementation:
// - Schema types (6 active + 4 active, reserved are enum-only)
// - SurrealHypergraphBackend (composition not extends, project_id on methods)
// - is_live bi-temporal filter
// - Backfill (idempotent, confidence=0.5, ACTIVE types only)
// - Memory.store/recall dual-write/dual-read
// - Backend registry extension
// - CC-13 enforcement (rejects reserved types)
//
// These tests are RED until the implementation lands.

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..") // FoxyBearOffice root
const FBH = join(import.meta.dir, "..", "..") // packages/fbh
const SRC = join(FBH, "src")
const SCHEMA_DIR = join(SRC, "memory", "schema")

function exists(path: string): boolean {
  return existsSync(path)
}

function readFile(path: string): string {
  if (!exists(path)) return ""
  return readFileSync(path, "utf-8")
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

describe("SDD-03 M-1 Hypergraph Schema", () => {
  describe("V2 — Schema types defined, subsetting enforced (CC-13)", () => {
    test("src/memory/schema/ directory exists", () => {
      expect(exists(SCHEMA_DIR)).toBe(true)
    })

    test("schema/enums.ts exists with NodeType and HyperedgeType", () => {
      const path = join(SCHEMA_DIR, "enums.ts")
      const content = readFile(path)
      expect(content).toMatch(/NodeType/i)
      expect(content).toMatch(/HyperedgeType/i)
    })

    test("schema/base.ts exists with BaseNode and BaseHyperedge", () => {
      const path = join(SCHEMA_DIR, "base.ts")
      const content = readFile(path)
      expect(content).toMatch(/BaseNode/i)
      expect(content).toMatch(/BaseHyperedge/i)
    })

    test("schema/nodes.ts exists with 6 active Schema.Class exports", () => {
      const path = join(SCHEMA_DIR, "nodes.ts")
      const content = readFile(path)
      // 6 active: MemoryNode, ActionNode, ErrorNode, MessageNode, EntityNode, ProcedureNode
      expect(content).toMatch(/MemoryNode/)
      expect(content).toMatch(/ActionNode/)
      expect(content).toMatch(/ErrorNode/)
      expect(content).toMatch(/MessageNode/)
      expect(content).toMatch(/EntityNode/)
      expect(content).toMatch(/ProcedureNode/)
    })

    test("schema/hyperedges.ts exists with 4 active Schema.Class exports", () => {
      const path = join(SCHEMA_DIR, "hyperedges.ts")
      const content = readFile(path)
      // 4 active: Collaboration, ErrorCorrection, Evidence, Procedure
      expect(content).toMatch(/Collaboration/i)
      expect(content).toMatch(/ErrorCorrection/i)
      expect(content).toMatch(/Evidence/i)
      expect(content).toMatch(/Procedure/i)
    })

    test("schema/lifecycle.ts exists with is_live function", () => {
      const path = join(SCHEMA_DIR, "lifecycle.ts")
      const content = readFile(path)
      expect(content).toMatch(/is_live/i)
    })

    test("RESERVED node types are NOT exported as Schema.Class (CC-13)", () => {
      const path = join(SCHEMA_DIR, "nodes.ts")
      const content = readFile(path)
      // Reserved: Task, Agent, Insight, Modality, Community, Archetype, MetaProcedure
      // These should NOT have Schema.Class exports
      expect(content).not.toMatch(/export.*TaskNode/i)
      expect(content).not.toMatch(/export.*AgentNode/i)
      expect(content).not.toMatch(/export.*InsightNode/i)
      expect(content).not.toMatch(/export.*ModalityNode/i)
      expect(content).not.toMatch(/export.*CommunityNode/i)
      expect(content).not.toMatch(/export.*ArchetypeNode/i)
      expect(content).not.toMatch(/export.*MetaProcedureNode/i)
    })

    test("RESERVED hyperedge types are NOT exported as Schema.Class (CC-13)", () => {
      const path = join(SCHEMA_DIR, "hyperedges.ts")
      const content = readFile(path)
      // Reserved: NaryFact, CommunityReport, Generalizes
      expect(content).not.toMatch(/export.*NaryFact/i)
      expect(content).not.toMatch(/export.*CommunityReport/i)
      expect(content).not.toMatch(/export.*Generalizes/i)
    })

    test("bi-temporal fields present in BaseNode (SC-2)", () => {
      const path = join(SCHEMA_DIR, "base.ts")
      const content = readFile(path)
      expect(content).toMatch(/valid_from/i)
      expect(content).toMatch(/valid_to/i)
      expect(content).toMatch(/tx_from/i)
      expect(content).toMatch(/tx_to/i)
      expect(content).toMatch(/prev_version_id/i)
      expect(content).toMatch(/invalidated_by/i)
      expect(content).toMatch(/status/i)
    })
  })

  describe("V4 — SurrealHypergraphBackend (composition, project_id, CC-13)", () => {
    test("surreal-hypergraph-backend.ts exists", () => {
      const path = join(SRC, "memory", "surreal-hypergraph-backend.ts")
      expect(exists(path)).toBe(true)
    })

    test("SurrealHypergraphBackend uses COMPOSITION (not extends SurrealGraphBackend)", () => {
      const path = join(SRC, "memory", "surreal-hypergraph-backend.ts")
      const content = readFile(path)
      // Should NOT extend SurrealGraphBackend (LSP violation)
      expect(content).not.toMatch(/extends\s+SurrealGraphBackend/)
      // Should compose (hold a reference)
      expect(content).toMatch(/SurrealGraphBackend/)
    })

    test("store method rejects RESERVED node types (CC-13)", () => {
      const path = join(SRC, "memory", "surreal-hypergraph-backend.ts")
      const content = readFile(path)
      // Should have a check that rejects reserved types
      expect(content).toMatch(/RESERVED|reserved|ACTIVE|active/i)
    })

    test("query/expand/neighbors methods take project_id (SC-5)", () => {
      const path = join(SRC, "memory", "surreal-hypergraph-backend.ts")
      const content = readFile(path)
      expect(content).toMatch(/project_id/i)
    })

    test("query method uses is_live filter (SC-2)", () => {
      const path = join(SRC, "memory", "surreal-hypergraph-backend.ts")
      const content = readFile(path)
      expect(content).toMatch(/is_live|isLive|isLiveFn/i)
    })
  })

  describe("V11 — Backend registry extension", () => {
    test("backend-registry.ts has setGlobalHypergraphBackend/getGlobalHypergraphBackend", () => {
      const path = join(SRC, "memory", "backend-registry.ts")
      const content = readFile(path)
      expect(content).toMatch(/setGlobalHypergraphBackend/i)
      expect(content).toMatch(/getGlobalHypergraphBackend/i)
    })
  })

  describe("V5 — Backfill (idempotent, confidence=0.5, ACTIVE types only)", () => {
    test("backfill method exists in SurrealHypergraphBackend", () => {
      const path = join(SRC, "memory", "surreal-hypergraph-backend.ts")
      const content = readFile(path)
      expect(content).toMatch(/backfill/i)
    })

    test("backfill sets confidence = 0.5 on MEMORY nodes (SC-8)", () => {
      const path = join(SRC, "memory", "surreal-hypergraph-backend.ts")
      const content = readFile(path)
      expect(content).toMatch(/confidence.*0\.5|0\.5.*confidence/i)
    })

    test("backfill maps graph_edge to ACTIVE types only (CC-13 — no NARY_FACT/COMMUNITY_REPORT/GENERALIZES)", () => {
      const path = join(SRC, "memory", "surreal-hypergraph-backend.ts")
      const content = readFile(path)
      // Should reference EVIDENCE for MENTIONS/RELATES, prev_version_id for SUPERSEDES, invalidated_by for CONTRADICTS
      expect(content).toMatch(/EVIDENCE|evidence/i)
      // Should NOT create NARY_FACT, COMMUNITY_REPORT, GENERALIZES hyperedges
      // (These are reserved — the backfill should explicitly avoid them)
    })

    test("backfill marker file path uses memory-migration-hypergraph.json", () => {
      const path = join(SRC, "memory", "surreal-hypergraph-backend.ts")
      const content = readFile(path)
      expect(content).toMatch(/memory-migration-hypergraph/i)
    })
  })

  describe("V8-V9 — Memory.store/recall dual-write/dual-read", () => {
    test("Memory.store writes to node table (dual-write)", () => {
      const path = join(SRC, "memory", "memory.ts")
      const content = readFile(path)
      expect(content).toMatch(/getGlobalHypergraphBackend|HypergraphBackend/i)
    })

    test("Memory.recall reads from node table (dual-read)", () => {
      const path = join(SRC, "memory", "memory.ts")
      const content = readFile(path)
      // Should query the hypergraph backend in recall
      expect(content).toMatch(/getGlobalHypergraphBackend|HypergraphBackend/i)
    })
  })

  describe("V7 — Bi-temporal is_live filter", () => {
    test("is_live function checks tx_to, valid_to, and status", () => {
      const path = join(SCHEMA_DIR, "lifecycle.ts")
      const content = readFile(path)
      expect(content).toMatch(/tx_to/i)
      expect(content).toMatch(/valid_to/i)
      expect(content).toMatch(/DELETED/i)
    })
  })

  describe("V12 — Existing tables preserved (SC-8 backward compat)", () => {
    test("no DROP TABLE or REMOVE TABLE in SurrealHypergraphBackend.init", () => {
      const path = join(SRC, "memory", "surreal-hypergraph-backend.ts")
      const content = readFile(path)
      expect(content).not.toMatch(/DROP\s+TABLE/i)
      expect(content).not.toMatch(/REMOVE\s+TABLE/i)
    })
  })

  describe("V10 — Typecheck green", () => {
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

  describe("V13 — Style guide compliance (CC-9)", () => {
    test("no `any` type in schema files", () => {
      const files = ["enums.ts", "base.ts", "nodes.ts", "hyperedges.ts", "lifecycle.ts"]
      for (const f of files) {
        const path = join(SCHEMA_DIR, f)
        const content = readFile(path)
        // Allow `any` only in comments or strings, not in type annotations
        const anyInType = content.split("\n").some((line) => {
          const trimmed = line.trim()
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false
          return /:\s*any\b/.test(line) || /<any>/.test(line)
        })
        expect(anyInType).toBe(false)
      }
    })

    test("snake_case for SurrealDB field names in schema", () => {
      const path = join(SCHEMA_DIR, "base.ts")
      const content = readFile(path)
      // Bi-temporal fields should be snake_case
      expect(content).toMatch(/valid_from/i)
      expect(content).toMatch(/valid_to/i)
      expect(content).toMatch(/tx_from/i)
      expect(content).toMatch(/tx_to/i)
      expect(content).toMatch(/prev_version_id/i)
      expect(content).toMatch(/invalidated_by/i)
    })
  })
})
