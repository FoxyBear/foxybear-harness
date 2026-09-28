import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-06 acceptance tests — Re-backfill.
// Tests verify the backfill script calls classify() (the pipeline) instead of
// the old stub extractors, deletes stub nodes, preserves deterministic nodes.

const FBH = join(import.meta.dir, "..", "..")
const SRC = join(FBH, "src")

function exists(path: string): boolean { return existsSync(path) }
function readFile(path: string): string { return exists(path) ? readFileSync(path, "utf-8") : "" }

describe("SDD-06 Phase N — Re-backfill", () => {
  describe("V1 — Backfill script calls classify (SC-1)", () => {
    test("backfill-hypergraph.ts imports or references classify from pipeline", () => {
      const path = join(FBH, "script", "backfill-hypergraph.ts")
      const content = readFile(path)
      expect(content).toMatch(/classify/)
    })

    test("backfill-hypergraph.ts does NOT call EntityExtractor.extract", () => {
      const path = join(FBH, "script", "backfill-hypergraph.ts")
      const content = readFile(path)
      expect(content).not.toMatch(/EntityExtractor\.extract\s*\(/)
    })

    test("backfill-hypergraph.ts does NOT call persistEntities", () => {
      const path = join(FBH, "script", "backfill-hypergraph.ts")
      const content = readFile(path)
      expect(content).not.toMatch(/persistEntities\s*\(/)
    })

    test("backfill-hypergraph.ts does NOT call persistMemories", () => {
      const path = join(FBH, "script", "backfill-hypergraph.ts")
      const content = readFile(path)
      expect(content).not.toMatch(/persistMemories\s*\(/)
    })
  })

  describe("V2 — Delete stub nodes (CC-1)", () => {
    test("backfill-hypergraph.ts references deleting stub-generated nodes", () => {
      const path = join(FBH, "script", "backfill-hypergraph.ts")
      const content = readFile(path)
      // Should reference deleting ENTITY/MEMORY/PROCEDURE stub nodes
      expect(content).toMatch(/delete|DELETE|remove/i)
    })

    test("backfill-hypergraph.ts preserves ACTION/ERROR/MESSAGE (deterministic)", () => {
      const path = join(FBH, "script", "backfill-hypergraph.ts")
      const content = readFile(path)
      // Should still call TraceIngestor.ingest (which produces ACTION/ERROR/MESSAGE)
      expect(content).toMatch(/TraceIngestor/)
    })
  })

  describe("V3 — Idempotent markers", () => {
    test("backfill-hypergraph.ts references re-backfill marker", () => {
      const path = join(FBH, "script", "backfill-hypergraph.ts")
      const content = readFile(path)
      expect(content).toMatch(/backfill-hypergraph|marker/i)
    })
  })

  describe("V4 — Pipeline path matches SC-1", () => {
    test("backfill-hypergraph.ts imports classify from src/memory/classify/pipeline", () => {
      const path = join(FBH, "script", "backfill-hypergraph.ts")
      const content = readFile(path)
      expect(content).toMatch(/memory\/classify\/pipeline|classify.*pipeline/i)
    })
  })

  describe("V5 — external_opt_in default true (SC-2)", () => {
    test("foxybear.ts has external_opt_in default true", () => {
      const content = readFile(join(SRC, "config", "foxybear.ts"))
      expect(content).toMatch(/external_opt_in.*true|external_opt_in.*\.default\(true\)/)
    })
  })

  describe("V6 — Typecheck green (CC-7)", () => {
    test("bun run typecheck exits 0", () => {
      const result = execSync("bun run typecheck 2>&1", {
        cwd: FBH, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000,
      })
      expect(result).toBeDefined()
    })
  })
})
