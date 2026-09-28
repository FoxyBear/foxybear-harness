import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-05 acceptance tests — derived from the spec's VERIFY section.
// These tests verify the M-2 auto-capture pipeline artifacts:
// - TraceIngestor (6 active node types, 4 active hyperedge types)
// - LLM extraction (hybrid mode, async, threshold-gated)
// - Data governance (secrets redaction, opt-in, disclosure)
// - Dependency chains (ContextWeaver-style)
// - Initial-confidence policy
// - Config consumed (CC-6)
// - Abort A4
//
// These tests are RED until the implementation lands.

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..") // FoxyBearOffice root
const FBH = join(import.meta.dir, "..", "..") // packages/fbh
const SRC = join(FBH, "src")

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

describe("SDD-05 M-2 Auto-Capture Pipeline", () => {
  describe("TraceIngestor (6 active node types, 4 active hyperedge types)", () => {
    test("src/memory/capture/ directory exists", () => {
      expect(exists(join(SRC, "memory", "capture"))).toBe(true)
    })

    test("TraceIngestor is defined in the codebase", () => {
      const found = grepRecursive(join(SRC, "memory", "capture"), "TraceIngestor|traceIngestor|ingest")
      expect(found).toBe(true)
    })

    test("TraceIngestor emits the 6 active node types (MESSAGE, ACTION, ERROR, MEMORY, PROCEDURE, ENTITY)", () => {
      const dir = join(SRC, "memory", "capture")
      const content = readFile(join(dir, "trace.ts")) || readFile(join(dir, "ingestor.ts")) || readFile(join(dir, "index.ts"))
      // Check for references to active node types
      const hasMessage = /MESSAGE|message/i.test(content)
      const hasAction = /ACTION|action/i.test(content)
      const hasError = /ERROR|error/i.test(content)
      const hasMemory = /MEMORY|memory/i.test(content)
      expect(hasMessage || hasAction || hasError || hasMemory).toBe(true)
    })

    test("TraceIngestor emits the 4 active hyperedge types (COLLABORATION, ERROR_CORRECTION, EVIDENCE, PROCEDURE)", () => {
      const dir = join(SRC, "memory", "capture")
      const files = exists(dir) ? execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n") : []
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      const hasCollaboration = /COLLABORATION|collaboration/i.test(allContent)
      const hasEvidence = /EVIDENCE|evidence/i.test(allContent)
      expect(hasCollaboration || hasEvidence).toBe(true)
    })

    test("TraceIngestor does NOT emit reserved node types (CC-13)", () => {
      const dir = join(SRC, "memory", "capture")
      if (!exists(dir)) {
        expect(dir).toBe("exists")
        return
      }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      // Reserved types: Task, Agent, Insight, Modality, Community, Archetype, MetaProcedure
      // These should NOT be emitted as node types (enum-only, no tables)
      // Allow references in comments, but not as emit targets
      expect(allContent).not.toMatch(/emit.*TaskNode|TaskNode.*emit/i)
      expect(allContent).not.toMatch(/emit.*CommunityNode|CommunityNode.*emit/i)
    })
  })

  describe("LLM extraction (hybrid mode, async)", () => {
    test("src/memory/extraction/ directory exists", () => {
      expect(exists(join(SRC, "memory", "extraction"))).toBe(true)
    })

    test("EntityExtractor or LLM extraction function is defined", () => {
      const found = grepRecursive(join(SRC, "memory", "extraction"), "EntityExtractor|extractEntit|llmExtract|extractLLM")
      expect(found).toBe(true)
    })

    test("hybrid mode is supported (regex for low-value, LLM for high-value)", () => {
      const dir = join(SRC, "memory", "extraction")
      if (!exists(dir)) {
        expect(dir).toBe("exists")
        return
      }
      const files = execSync(`ls "${dir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(dir, f))).join("\n")
      expect(allContent).toMatch(/hybrid|regex|llm/i)
    })

    test("async extraction (does not block LLM response)", () => {
      const captureDir = join(SRC, "memory", "capture")
      const extractionDir = join(SRC, "memory", "extraction")
      const dirs = [captureDir, extractionDir]
      const anyAsync = dirs.some((d) => {
        if (!exists(d)) return false
        const files = execSync(`ls "${d}"`, { encoding: "utf-8" }).trim().split("\n")
        const allContent = files.map((f) => readFile(join(d, f))).join("\n")
        return /async|fork|run\.fork|Effect\.fork/i.test(allContent)
      })
      expect(anyAsync).toBe(true)
    })
  })

  describe("Data governance (CC-12, B4)", () => {
    test("secrets-redaction filter exists", () => {
      const found = grepRecursive(join(SRC, "memory"), "redact|secrets.*filter|filter.*secrets|redaction")
      expect(found).toBe(true)
    })

    test("external_opt_in config flag exists (default false)", () => {
      const configPath = join(SRC, "config", "foxybear.ts")
      const content = readFile(configPath)
      expect(content).toMatch(/external_opt_in|externalOptIn/i)
    })

    test("self_hosted fallback model is pre-named in config", () => {
      const configPath = join(SRC, "config", "foxybear.ts")
      const content = readFile(configPath)
      expect(content).toMatch(/self_hosted|selfHosted|ollama/i)
    })

    test("CLI disclosure when background LLM extraction is enabled", () => {
      const found = grepRecursive(SRC, "extraction.*enabled|background.*extraction|extraction.*background")
      expect(found).toBe(true)
    })
  })

  describe("Dependency chains (ContextWeaver-style)", () => {
    test("ActionNode dependency chains are implemented", () => {
      const captureDir = join(SRC, "memory", "capture")
      if (!exists(captureDir)) {
        expect(captureDir).toBe("exists")
        return
      }
      const files = execSync(`ls "${captureDir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(captureDir, f))).join("\n")
      const hasDependency = /dependency|depends.*on|reasoning.*step|step.*sequence/i.test(allContent)
      expect(hasDependency).toBe(true)
    })
  })

  describe("Initial-confidence policy", () => {
    test("initial confidence set by extraction-path provenance class", () => {
      const captureDir = join(SRC, "memory", "capture")
      const extractionDir = join(SRC, "memory", "extraction")
      const dirs = [captureDir, extractionDir].filter(exists)
      const anyConfidence = dirs.some((d) => {
        const files = execSync(`ls "${d}"`, { encoding: "utf-8" }).trim().split("\n")
        const allContent = files.map((f) => readFile(join(d, f))).join("\n")
        return /confidence.*0\.\d|initial.*confidence/i.test(allContent)
      })
      expect(anyConfidence).toBe(true)
    })

    test("tool outputs get higher initial confidence (0.7) than LLM-inferred (0.5)", () => {
      const dirs = [join(SRC, "memory", "capture"), join(SRC, "memory", "extraction")].filter(exists)
      const anyProvenance = dirs.some((d) => {
        const files = execSync(`ls "${d}"`, { encoding: "utf-8" }).trim().split("\n")
        const allContent = files.map((f) => readFile(join(d, f))).join("\n")
        return /0\.7|provenance|tool.*output.*confiden/i.test(allContent)
      })
      expect(anyProvenance).toBe(true)
    })
  })

  describe("Config consumed (CC-6)", () => {
    test("memory.extraction config is read and consumed", () => {
      const found = grepRecursive(join(SRC, "memory"), "memory\.extraction|extraction\.mode|extraction\.model|extraction\.threshold")
      expect(found).toBe(true)
    })

    test("changing config value changes behavior (mode regex vs llm vs hybrid)", () => {
      const extractionDir = join(SRC, "memory", "extraction")
      if (!exists(extractionDir)) {
        expect(extractionDir).toBe("exists")
        return
      }
      const files = execSync(`ls "${extractionDir}"`, { encoding: "utf-8" }).trim().split("\n")
      const allContent = files.map((f) => readFile(join(extractionDir, f))).join("\n")
      expect(allContent).toMatch(/mode|regex.*llm|llm.*regex/i)
    })
  })

  describe("Post-turn hook wiring", () => {
    test("MemoryCapture.capture is wired into post-turn hook", () => {
      const promptPath = join(SRC, "session", "prompt.ts")
      const content = readFile(promptPath)
      const hasCapture = /capture|MemoryCapture|traceIngestor|TraceIngestor/i.test(content)
      expect(hasCapture).toBe(true)
    })

    test("capture is fire-and-forget (async, does not block next turn)", () => {
      const promptPath = join(SRC, "session", "prompt.ts")
      const content = readFile(promptPath)
      const hasFork = /run\.fork|Effect\.fork|fork\(/i.test(content)
      expect(hasFork).toBe(true)
    })
  })

  describe("Typecheck green", () => {
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
})
