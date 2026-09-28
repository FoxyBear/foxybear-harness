import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-01 acceptance tests — derived from the spec's VERIFY section.
// Phase N Jev provider adapter: wires OpenRouter's alpha/decisions API
// (model typesafe/jev-1.13) into fbh as a typed-decision adapter
// exposing `noul`, `choice`, `score` on a `Jev` namespace.
//
// Tests verify: file exists, namespace + functions exist with correct
// shapes, config (memory.extraction.layer1) is consumed, external_opt_in
// default is true (SC-2), circuit breaker + rate limiter config present,
// typecheck green. No mocks of the implementation under test (CC-5).
//
// RED until implementation lands.

const FBH = join(import.meta.dir, "..", "..") // packages/fbh
const SRC = join(FBH, "src")
const JEV = join(SRC, "provider", "jev.ts")
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

function grepDir(dir: string, pattern: string): boolean {
  if (!exists(dir)) return false
  try {
    const out = execSync(`rg -l "${pattern}" "${dir}" 2>/dev/null || true`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    return out.length > 0
  } catch {
    return false
  }
}

describe("SDD-01 Phase N — Jev Provider Adapter", () => {
  describe("V1 — file + namespace exist (SC-1, req 1)", () => {
    test("src/provider/jev.ts exists", () => {
      expect(exists(JEV)).toBe(true)
    })

    test("jev.ts exports `Jev` namespace", () => {
      expect(grep(JEV, /export\s+namespace\s+Jev\b/)).toBe(true)
    })

    test("Jev does NOT extend LanguageModelV3 (Jev is not a chat model)", () => {
      expect(grep(JEV, /extends\s+LanguageModelV3|implements\s+LanguageModelV3/)).toBe(false)
    })
  })

  describe("V2 — noul/choice/score function shapes (SC-1, reqs 2-4)", () => {
    test("Jev.noul is exported", () => {
      expect(grep(JEV, /export\s+async\s+function\s+noul\b/)).toBe(true)
    })

    test("Jev.choice is exported", () => {
      expect(grep(JEV, /export\s+async\s+function\s+choice\b/)).toBe(true)
    })

    test("Jev.score is exported", () => {
      expect(grep(JEV, /export\s+async\s+function\s+score\b/)).toBe(true)
    })

    test("noul signature: (state, instructions, criteria) returns Promise<number>", () => {
      expect(grep(JEV, /noul\s*\(\s*state\s*:\s*string\s*,\s*instructions\s*:\s*string\s*,\s*criteria\s*:\s*\{[^}]*true[^}]*false[^}]*\}/)).toBe(true)
      expect(grep(JEV, /noul[^)]*\)\s*:\s*Promise<number>/)).toBe(true)
    })

    test("choice signature returns { choice, probabilities }", () => {
      expect(grep(JEV, /choice\s*\(\s*state\s*:\s*string\s*,\s*instructions\s*:\s*string\s*,\s*criteria\s*:\s*Record<string,\s*string>/)).toBe(true)
      expect(grep(JEV, /Promise<\s*\{\s*choice\s*:\s*string\s*;\s*probabilities\s*:\s*Record<string,\s*number>\s*\}\s*>/)).toBe(true)
    })

    test("score signature returns Promise<number>", () => {
      expect(grep(JEV, /score\s*\(\s*state\s*:\s*string\s*,\s*instructions\s*:\s*string\s*,\s*criteria\s*:\s*string\[\]/)).toBe(true)
      expect(grep(JEV, /score[^)]*\)\s*:\s*Promise<number>/)).toBe(true)
    })
  })

  describe("V3 — OpenRouter decisions endpoint (SC-5, CC-10, req 2)", () => {
    test("jev.ts references the OpenRouter alpha/decisions endpoint", () => {
      expect(grep(JEV, /openrouter\.ai\/api\/alpha\/decisions/)).toBe(true)
    })

    test("jev.ts uses model typesafe/jev-1.13 (default)", () => {
      expect(grep(JEV, /typesafe\/jev-1\.13/)).toBe(true)
    })

    test("jev.ts supports FBH_JEV_ENDPOINT env override (test seam)", () => {
      expect(grep(JEV, /FBH_JEV_ENDPOINT/)).toBe(true)
    })
  })

  describe("V4 — config consumed (CC-4, reqs 7-8)", () => {
    test("foxybear.ts has memory.extraction.layer1 config field", () => {
      expect(grep(CFG, /layer1\b/)).toBe(true)
    })

    test("layer1 config has provider, model, api_key fields", () => {
      const c = read(CFG)
      expect(c).toMatch(/provider/)
      expect(c).toMatch(/model/)
      expect(c).toMatch(/api_key/)
    })

    test("layer1.model defaults to typesafe/jev-1.13", () => {
      expect(grep(CFG, /typesafe\/jev-1\.13/)).toBe(true)
    })

    test("layer1.provider defaults to openrouter", () => {
      expect(grep(CFG, /["']openrouter["']/)).toBe(true)
    })

    test("jev.ts reads config via getConfig() bridge", () => {
      expect(grep(JEV, /getConfig/)).toBe(true)
    })

    test("jev.ts reads layer1 from cfg.memory.extraction", () => {
      expect(grep(JEV, /memory\.extraction\.layer1|extraction\.layer1|layer1/)).toBe(true)
    })
  })

  describe("V5 — external_opt_in default true (SC-2, req 7)", () => {
    test("foxybear.ts external_opt_in default is true (Phase N supersedes Phase M)", () => {
      const c = read(CFG)
      // Find the external_opt_in line and check it defaults to true
      const m = c.match(/external_opt_in[\s\S]{0,200}?\.default\((true|false)\)/)
      expect(m).not.toBeNull()
      expect(m?.[1]).toBe("true")
    })
  })

  describe("V6 — circuit breaker config (CC-9, req 7)", () => {
    test("foxybear.ts has circuit_breaker config under memory.extraction", () => {
      expect(grep(CFG, /circuit_breaker/)).toBe(true)
    })

    test("circuit_breaker has max_latency_ms (default 3000)", () => {
      const c = read(CFG)
      expect(c).toMatch(/max_latency_ms/)
      expect(c).toMatch(/3000/)
    })

    test("circuit_breaker has max_consecutive_failures (default 5)", () => {
      const c = read(CFG)
      expect(c).toMatch(/max_consecutive_failures/)
      expect(c).toMatch(/5/)
    })

    test("circuit_breaker has max_error_rate_pct (default 5)", () => {
      expect(grep(CFG, /max_error_rate_pct/)).toBe(true)
    })

    test("circuit_breaker has fallback (default regex)", () => {
      const c = read(CFG)
      expect(c).toMatch(/fallback/)
      expect(c).toMatch(/["']regex["']/)
    })

    test("jev.ts implements circuit breaker (state machine)", () => {
      const c = read(JEV)
      expect(c).toMatch(/circuit|breaker/i)
      expect(c).toMatch(/open|half_open|closed/i)
    })
  })

  describe("V7 — rate limiter config (CC-5, reqs 20-22)", () => {
    test("jev.ts implements a client-side rate limiter (token bucket)", () => {
      const c = read(JEV)
      expect(c).toMatch(/rate|limit|token|bucket/i)
    })

    test("rate limiter is capped at 10 tokens/sec (CC-5 Jev limit)", () => {
      const c = read(JEV)
      // 10 tokens, 10/sec refill, or RATE_PER_SEC = 10
      expect(c).toMatch(/\b10\b/)
    })

    test("jev.ts exposes saturation throw (JevRateLimitedError or equivalent)", () => {
      expect(grep(JEV, /RateLimited|rate_limited|rateLimited/i)).toBe(true)
    })
  })

  describe("V8 — cost logging (CC-8, reqs 12-14)", () => {
    test("jev.ts logs jev.call info events with token count + cost", () => {
      expect(grep(JEV, /jev\.call|tokens_in|tokens_out|cost_usd/)).toBe(true)
    })

    test("jev.ts exposes Jev.metrics() for /memory/metrics aggregate", () => {
      expect(grep(JEV, /export\s+function\s+metrics\b/)).toBe(true)
    })
  })

  describe("V9 — error types (reqs 5-6, 9-11)", () => {
    test("jev.ts defines JevHttpError via NamedError.create", () => {
      expect(grep(JEV, /JevHttpError|NamedError\.create/)).toBe(true)
    })

    test("jev.ts defines JevSchemaError (no silent default on parse failure)", () => {
      expect(grep(JEV, /JevSchemaError|SchemaError/)).toBe(true)
    })

    test("jev.ts defines JevConfigError (provider guard + missing key)", () => {
      expect(grep(JEV, /JevConfigError|ConfigError/)).toBe(true)
    })

    test("jev.ts defines JevCircuitOpenError", () => {
      expect(grep(JEV, /CircuitOpen|circuit_open/)).toBe(true)
    })
  })

  describe("V10 — style compliance (req 23, AGENTS.md)", () => {
    test("no `any` type in jev.ts", () => {
      const c = read(JEV)
      const bad = c.split("\n").some((line) => {
        const t = line.trim()
        if (t.startsWith("//") || t.startsWith("*")) return false
        return /:\s*any\b/.test(line) || /\bas\s+any\b/.test(line)
      })
      expect(bad).toBe(false)
    })

    test("no `Bun.file()` call in jev.ts (config substitution is upstream)", () => {
      expect(grep(JEV, /Bun\.file/)).toBe(false)
    })
  })

  describe("V11 — config additive (req 7, CC-4 backward compat)", () => {
    test("layer2 config present (sdd-02 consumes; this spec only reads layer1)", () => {
      expect(grep(CFG, /layer2\b/)).toBe(true)
    })

    test("layer2.model defaults to google/gemini-2.5-flash", () => {
      expect(grep(CFG, /google\/gemini-2\.5-flash/)).toBe(true)
    })

    test("existing memory.extraction keys preserved (mode, model, threshold)", () => {
      const c = read(CFG)
      expect(c).toMatch(/mode/)
      expect(c).toMatch(/model/)
      expect(c).toMatch(/threshold/)
    })
  })

  describe("V12 — typecheck green (CC-7)", () => {
    test("bun run typecheck exits 0", () => {
      if (!exists(JEV)) {
        expect(JEV).toBe("exists") // force fail with context
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
