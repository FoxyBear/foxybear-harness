import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-05 acceptance tests — Wire Into Capture.
// Tests verify the prompt.ts capture hook calls classify() (the pipeline)
// instead of the old stub extractors.

const FBH = join(import.meta.dir, "..", "..")
const SRC = join(FBH, "src")

function exists(path: string): boolean { return existsSync(path) }
function readFile(path: string): string { return exists(path) ? readFileSync(path, "utf-8") : "" }

describe("SDD-05 Phase N — Wire Into Capture", () => {
  describe("V1 — Capture hook calls classify (SC-1)", () => {
    test("prompt.ts imports or references classify from pipeline", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      const hasClassify = /classify/.test(content) && /pipeline/.test(content)
      expect(hasClassify).toBe(true)
    })

    test("prompt.ts constructs ClassifyInput with sessionID, text, project_id, persona", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      expect(content).toMatch(/sessionID/i)
      expect(content).toMatch(/project_id|project\.id/i)
      expect(content).toMatch(/persona/i)
    })
  })

  describe("V2 — Stubs no longer called (CC-2)", () => {
    test("prompt.ts does NOT call EntityExtractor.extract", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      expect(content).not.toMatch(/EntityExtractor\.extract\s*\(/)
    })

    test("prompt.ts does NOT call MemoryExtractor.extract", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      expect(content).not.toMatch(/MemoryExtractor\.extract\s*\(/)
    })

    test("prompt.ts does NOT call persistEntities", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      expect(content).not.toMatch(/persistEntities\s*\(/)
    })

    test("prompt.ts does NOT call persistMemories", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      expect(content).not.toMatch(/persistMemories\s*\(/)
    })
  })

  describe("V3 — TraceIngestor preserved (CC-1)", () => {
    test("prompt.ts still calls TraceIngestor.ingest", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      expect(content).toMatch(/TraceIngestor\.ingest|TraceIngestor\b/)
    })
  })

  describe("V4 — Buffer NOT called directly by capture hook (SC-1)", () => {
    test("prompt.ts does NOT call Buffer.add", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      expect(content).not.toMatch(/Buffer\.add\s*\(/)
    })

    test("prompt.ts does NOT call Buffer.getContext", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      expect(content).not.toMatch(/Buffer\.getContext\s*\(/)
    })
  })

  describe("V5 — isMemoryEnabled gate preserved", () => {
    test("prompt.ts still checks isMemoryEnabled", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      expect(content).toMatch(/isMemoryEnabled/)
    })
  })

  describe("V6 — Async non-blocking (CC-3)", () => {
    test("prompt.ts still uses run.fork for capture", () => {
      const content = readFile(join(SRC, "session", "prompt.ts"))
      expect(content).toMatch(/run\.fork|Effect\.fork|fork\s*\(/)
    })
  })

  describe("V7 — external_opt_in default true (SC-2)", () => {
    test("foxybear.ts has external_opt_in default true", () => {
      const content = readFile(join(SRC, "config", "foxybear.ts"))
      // The default should be true now (Phase N supersedes Phase M)
      expect(content).toMatch(/external_opt_in.*true|external_opt_in.*\.default\(true\)/)
    })
  })

  describe("V8 — Typecheck green (CC-7)", () => {
    test("bun run typecheck exits 0", () => {
      const result = execSync("bun run typecheck 2>&1", {
        cwd: FBH, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000,
      })
      expect(result).toBeDefined()
    })
  })
})
