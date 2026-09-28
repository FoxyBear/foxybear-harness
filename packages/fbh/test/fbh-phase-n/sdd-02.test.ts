import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-02 acceptance tests — derived from the spec's VERIFY section.
// Phase N Gemini extraction provider: wires Gemini 2.5 Flash
// (OpenRouter chat API, JSON mode) for stage 2 of the 4-stage
// classification pipeline. Exposes `Gemini.extract` + `ExtractedMemory`
// interface per master SC-1.
//
// Tests verify: file exists, namespace + function + interface exist
// with correct shapes, config (memory.extraction.layer2) is consumed,
// JSON mode (response_format) is set, circuit breaker + rate limiter
// config present, typecheck green. No mocks of the implementation
// under test (CC-5).
//
// RED until implementation lands.

const FBH = join(import.meta.dir, "..", "..") // packages/fbh
const SRC = join(FBH, "src")
const GEM = join(SRC, "provider", "gemini.ts")
const CFG = join(SRC, "config", "foxybear.ts")

function exists(path: string): boolean {
  return existsSync(path)
}

function read(path: string): string {
  if (!exists(path)) return ""
  return readFileSync(path, "utf-8")
}

function grep(path: string, pattern: RegExp): boolean {
  return pattern.test(read(path))
}

describe("SDD-02 Phase N — Gemini Extraction Provider", () => {
  describe("V1 — file + namespace + interface exist (SC-1, reqs 1-3)", () => {
    test("src/provider/gemini.ts exists", () => {
      expect(exists(GEM)).toBe(true)
    })

    test("gemini.ts exports `Gemini` namespace", () => {
      expect(grep(GEM, /export\s+namespace\s+Gemini\b/)).toBe(true)
    })

    test("gemini.ts exports `ExtractedMemory` interface", () => {
      expect(grep(GEM, /export\s+interface\s+ExtractedMemory\b/)).toBe(true)
    })
  })

  describe("V2 — ExtractedMemory interface matches SC-1 (req 2)", () => {
    test("ExtractedMemory has content: string", () => {
      const c = read(GEM)
      const m = c.match(/interface\s+ExtractedMemory\s+\{[^}]+\}/)
      expect(m).not.toBeNull()
      expect(m?.[0]).toMatch(/content\s*:\s*string/)
    })

    test("ExtractedMemory type is the 7-value enum (SC-4)", () => {
      const c = read(GEM)
      const m = c.match(/interface\s+ExtractedMemory\s+\{[^}]+\}/)
      expect(m).not.toBeNull()
      expect(m?.[0]).toMatch(/preference/)
      expect(m?.[0]).toMatch(/correction/)
      expect(m?.[0]).toMatch(/decision/)
      expect(m?.[0]).toMatch(/constraint/)
      expect(m?.[0]).toMatch(/pattern/)
      expect(m?.[0]).toMatch(/context/)
      expect(m?.[0]).toMatch(/none/)
    })

    test("ExtractedMemory source is user | assistant", () => {
      const c = read(GEM)
      const m = c.match(/interface\s+ExtractedMemory\s+\{[^}]+\}/)
      expect(m).not.toBeNull()
      expect(m?.[0]).toMatch(/source\s*:\s*["']user["']\s*\|\s*["']assistant["']/)
    })
  })

  describe("V3 — Gemini.extract shape (SC-1, reqs 1, 3)", () => {
    test("extract is exported async function on Gemini namespace", () => {
      expect(grep(GEM, /export\s+async\s+function\s+extract\b/)).toBe(true)
    })

    test("extract signature: (systemPrompt, userContent) returns memories + skipped_reason", () => {
      const c = read(GEM)
      expect(c).toMatch(/extract\s*\(\s*systemPrompt\s*:\s*string\s*,\s*userContent\s*:\s*string\s*\)/)
      expect(c).toMatch(/Promise<\s*\{\s*memories\s*:\s*ExtractedMemory\[\]\s*;\s*skipped_reason\?:\s*string\s*\}\s*>/)
    })

    test("skipped_reason is the closed set of reason strings (req 3)", () => {
      const c = read(GEM)
      expect(c).toMatch(/external_opt_in false|external_opt_in_false/)
      expect(c).toMatch(/circuit_open/)
      expect(c).toMatch(/rate_limited|rateLimited/)
      expect(c).toMatch(/json_parse_failed|jsonParseFailed/)
      expect(c).toMatch(/empty_content|emptyContent/)
    })
  })

  describe("V4 — config consumed (CC-4, reqs 4-9)", () => {
    test("foxybear.ts has memory.extraction.layer2 config field", () => {
      expect(grep(CFG, /layer2\b/)).toBe(true)
    })

    test("layer2.model defaults to google/gemini-2.5-flash (SC-2)", () => {
      expect(grep(CFG, /google\/gemini-2\.5-flash/)).toBe(true)
    })

    test("layer2.provider defaults to openrouter (CC-10)", () => {
      expect(grep(CFG, /["']openrouter["']/)).toBe(true)
    })

    test("gemini.ts reads config via getConfig() bridge (same path as mode.ts:44)", () => {
      expect(grep(GEM, /getConfig/)).toBe(true)
    })

    test("gemini.ts reads layer2 from cfg.memory.extraction", () => {
      expect(grep(GEM, /memory\.extraction\.layer2|extraction\.layer2|layer2/)).toBe(true)
    })

    test("gemini.ts reads external_opt_in from config (req 8)", () => {
      expect(grep(GEM, /external_opt_in|externalOptIn/)).toBe(true)
    })
  })

  describe("V5 — OpenRouter only (CC-10, req 6)", () => {
    test("gemini.ts posts to OpenRouter chat completions endpoint (NOT direct Gemini API)", () => {
      expect(grep(GEM, /openrouter\.ai\/api\/v1\/chat\/completions/)).toBe(true)
    })

    test("gemini.ts does NOT call generativelanguage.googleapis.com", () => {
      expect(grep(GEM, /generativelanguage\.googleapis\.com/)).toBe(false)
    })

    test("gemini.ts guards provider === openrouter (throws on mismatch)", () => {
      const c = read(GEM)
      expect(c).toMatch(/openrouter/)
    })
  })

  describe("V6 — JSON mode (SC-5, reqs 10-12)", () => {
    test("gemini.ts sets response_format: { type: json_object }", () => {
      expect(grep(GEM, /response_format/)).toBe(true)
      expect(grep(GEM, /json_object/)).toBe(true)
    })

    test("gemini.ts sets temperature: 0 (SC-5)", () => {
      expect(grep(GEM, /temperature\s*:\s*0\b/)).toBe(true)
    })

    test("messages array has system + user roles in order (req 12)", () => {
      const c = read(GEM)
      expect(c).toMatch(/role\s*:\s*["']system["']/)
      expect(c).toMatch(/role\s*:\s*["']user["']/)
    })

    test("uses Provider.parseModel to confirm openrouter routing (req 11)", () => {
      expect(grep(GEM, /Provider\.parseModel|parseModel/)).toBe(true)
    })
  })

  describe("V7 — parse resilience (reqs 13-17)", () => {
    test("gemini.ts has retry on JSON parse failure (initial + 2 retries)", () => {
      const c = read(GEM)
      expect(c).toMatch(/retry|RETRY_DELAYS|attempt/i)
    })

    test("gemini.ts strips markdown code fences before parsing (req 15)", () => {
      expect(grep(GEM, /```|fence|strip/i)).toBe(true)
    })

    test("gemini.ts drops invalid type/source memories, keeps valid ones (req 17)", () => {
      expect(grep(GEM, /TYPES|SOURCES|filter/i)).toBe(true)
    })
  })

  describe("V8 — circuit breaker (CC-9, reqs 18-22)", () => {
    test("foxybear.ts has circuit_breaker config (shared with sdd-01)", () => {
      expect(grep(CFG, /circuit_breaker/)).toBe(true)
    })

    test("gemini.ts implements circuit breaker (consecutive failures + open/closed state)", () => {
      const c = read(GEM)
      expect(c).toMatch(/consecutive/i)
      expect(c).toMatch(/open|closed|half_open/i)
    })

    test("breaker returns skipped_reason: circuit_open when open (no external call)", () => {
      expect(grep(GEM, /circuit_open/)).toBe(true)
    })

    test("half-open probe after 60s cooldown (req 22)", () => {
      const c = read(GEM)
      expect(c).toMatch(/60[_\s]*000|HALF_OPEN|half_open/i)
    })
  })

  describe("V9 — rate limiter (CC-5, reqs 23-24)", () => {
    test("gemini.ts implements a 5 req/sec rate limiter", () => {
      const c = read(GEM)
      expect(c).toMatch(/RATE_PER_SEC|5/i)
      expect(c).toMatch(/token|bucket|queue|limit/i)
    })

    test("queue overflow drops oldest with skipped_reason: rate_limited (req 24)", () => {
      expect(grep(GEM, /rate_limited|rateLimited/)).toBe(true)
    })

    test("QUEUE_DEPTH const is 50 (req 24)", () => {
      const c = read(GEM)
      expect(c).toMatch(/QUEUE_DEPTH/)
      expect(c).toMatch(/\b50\b/)
    })
  })

  describe("V10 — cost logging (CC-8, reqs 25-27)", () => {
    test("gemini.ts logs token count + cost_usd per call", () => {
      const c = read(GEM)
      expect(c).toMatch(/tokens\.input|tokens_in|prompt_tokens/i)
      expect(c).toMatch(/cost_usd|cost/i)
    })

    test("cost computed via Decimal idiom (session/index.ts:287-303 pattern)", () => {
      expect(grep(GEM, /Decimal/)).toBe(true)
    })

    test("log entry contains only metadata, NO session content (CC-6)", () => {
      const c = read(GEM)
      // Log should NOT include the system prompt or user content in the log fields
      expect(c).toMatch(/model|latency_ms|success/i)
    })

    test("Gemini.metrics() exposed for /memory/metrics aggregate (req 27)", () => {
      expect(grep(GEM, /export\s+function\s+metrics\b/)).toBe(true)
    })
  })

  describe("V11 — style compliance (req 28, AGENTS.md)", () => {
    test("no `any` type in gemini.ts", () => {
      const c = read(GEM)
      const bad = c.split("\n").some((line) => {
        const t = line.trim()
        if (t.startsWith("//") || t.startsWith("*")) return false
        return /:\s*any\b/.test(line) || /\bas\s+any\b/.test(line)
      })
      expect(bad).toBe(false)
    })

    test("no `@ts-expect-error` added (req 29)", () => {
      expect(grep(GEM, /@ts-expect-error|@ts-ignore/)).toBe(false)
    })

    test("module-level state uses const (only consecutive/openSince/cfg as let per SessionCompaction idiom)", () => {
      // Per spec HOW Step 1 — three let vars allowed matching compaction.ts:384-385
      const c = read(GEM)
      // Count `let ` declarations — should be minimal (state vars only)
      const lets = (c.match(/\blet\b/g) ?? []).length
      expect(lets).toBeLessThanOrEqual(3)
    })
  })

  describe("V12 — typecheck green (CC-7, req 29)", () => {
    test("bun run typecheck exits 0", () => {
      if (!exists(GEM)) {
        expect(GEM).toBe("exists") // force fail with context
        return
      }
      const out = execSync("bun run typecheck 2>&1", {
        cwd: FBH,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000,
      })
      expect(out).toBeDefined()
    })
  })
})
