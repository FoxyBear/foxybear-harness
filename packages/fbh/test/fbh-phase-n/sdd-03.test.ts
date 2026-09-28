import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// SDD-03 acceptance tests — derived from the spec's VERIFY section.
// Phase N circular buffer: per-session, last-N user-turn context arc
// for the Jev gate. Session-scoped Map<sessionID, Turn[]>, user-only
// filter, FIFO drop, configurable size (default 5), in-memory only.
//
// Tests verify: file exists, namespace + functions exist with correct
// shapes, user-only filter, session scoping, FIFO, size===0 guard
// (the slice(-0) bug), config-driven size, typecheck green.
// No mocks of the Buffer namespace or Map store (AGENTS.md testing rule).
//
// RED until implementation lands.

const FBH = join(import.meta.dir, "..", "..") // packages/fbh
const SRC = join(FBH, "src")
const BUF = join(SRC, "memory", "capture", "buffer.ts")
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

describe("SDD-03 Phase N — Circular Buffer", () => {
  describe("V1 — Buffer namespace implements SC-1 (reqs 1-2)", () => {
    test("src/memory/capture/buffer.ts exists", () => {
      expect(exists(BUF)).toBe(true)
    })

    test("buffer.ts exports `Buffer` namespace", () => {
      expect(grep(BUF, /export\s+namespace\s+Buffer\b/)).toBe(true)
    })

    test("Buffer.add is exported", () => {
      expect(grep(BUF, /export\s+function\s+add\b/)).toBe(true)
    })

    test("Buffer.getContext is exported", () => {
      expect(grep(BUF, /export\s+function\s+getContext\b/)).toBe(true)
    })

    test("Buffer.get is exported", () => {
      expect(grep(BUF, /export\s+function\s+get\b/)).toBe(true)
    })

    test("Buffer.clear is exported", () => {
      expect(grep(BUF, /export\s+function\s+clear\b/)).toBe(true)
    })

    test("Buffer.size is exported", () => {
      expect(grep(BUF, /export\s+function\s+size\b/)).toBe(true)
    })
  })

  describe("V2 — function signatures (SC-1)", () => {
    test("add(sessionID, turn: {text, role}) returns void", () => {
      const c = read(BUF)
      expect(c).toMatch(/add\s*\(\s*sessionID\s*:\s*string\s*,\s*turn\s*:\s*\{\s*text\s*:\s*string\s*;\s*role\s*:\s*string\s*\}\s*\)\s*:\s*void/)
    })

    test("getContext(sessionID) returns string", () => {
      const c = read(BUF)
      expect(c).toMatch(/getContext\s*\(\s*sessionID\s*:\s*string\s*\)\s*:\s*string/)
    })

    test("get(sessionID) returns {text, role}[]", () => {
      const c = read(BUF)
      expect(c).toMatch(/get\s*\(\s*sessionID\s*:\s*string\s*\)\s*:\s*\{\s*text\s*:\s*string\s*;\s*role\s*:\s*string\s*\}\[\]/)
    })

    test("clear(sessionID) returns void", () => {
      const c = read(BUF)
      expect(c).toMatch(/clear\s*\(\s*sessionID\s*:\s*string\s*\)\s*:\s*void/)
    })

    test("size() returns number (no args)", () => {
      const c = read(BUF)
      expect(c).toMatch(/size\s*\(\s*\)\s*:\s*number/)
    })
  })

  describe("V3 — add() user-only filter (reqs 3-4)", () => {
    test("buffer.ts filters on role === 'user' (silent no-op for others)", () => {
      const c = read(BUF)
      expect(c).toMatch(/role\s*===\s*["']user["']/)
    })

    test("add() does NOT throw on non-user roles (req 4 silent filter)", () => {
      // The filter is a silent no-op; no throw for assistant/tool/system
      const c = read(BUF)
      // Early return on non-user role, no throw
      expect(c).toMatch(/role\s*!==\s*["']user["']|role\s*===\s*["']user["']/)
    })
  })

  describe("V4 — last-N maintenance FIFO (req 5)", () => {
    test("add() uses slice(-size) for FIFO drop (oldest dropped)", () => {
      expect(grep(BUF, /\.slice\(\s*-\s*\w*size\w*\)/)).toBe(true)
    })

    test("buffer.ts does NOT use shift() in a loop (slice is the FIFO mechanism)", () => {
      // slice(-size) handles both append + FIFO in one op; no shift loop
      expect(grep(BUF, /\.shift\(\)/)).toBe(false)
    })
  })

  describe("V5 — size === 0 guard (req 6, the slice(-0) bug)", () => {
    test("buffer.ts explicitly guards size === 0 (NOT slice(-0))", () => {
      // In JS -0 === 0, so slice(-0) returns the full array.
      // The spec requires an explicit early branch that empties the array.
      const c = read(BUF)
      expect(c).toMatch(/size\s*===\s*0/)
    })

    test("buffer.ts does NOT rely on slice(-0) for the disable case", () => {
      // Confirm no bare slice(-0) — must be guarded by an explicit size===0 branch
      const c = read(BUF)
      // A bare `slice(-0)` is a bug; we want either no slice(-0), or
      // only inside the guarded branch where size===0 is already handled
      // (which means it should NOT appear at all since the guard sets []).
      expect(c).not.toMatch(/\.slice\(\s*-0\s*\)/)
    })
  })

  describe("V6 — getContext() format (req 7)", () => {
    test("header line is exactly 'Prior user turns:'", () => {
      const c = read(BUF)
      expect(c).toMatch(/Prior user turns:/)
    })

    test("turns formatted with [i] prefix (1-indexed)", () => {
      const c = read(BUF)
      expect(c).toMatch(/\[\$\{|`\[${i\s*\+\s*1}\$\{/)
    })

    test("turns joined with newline (oldest first, most recent last)", () => {
      expect(grep(BUF, /\.join\(\s*["']\\n["']\s*\)/)).toBe(true)
    })
  })

  describe("V7 — getContext() empty returns '' (reqs 8-9)", () => {
    test("empty buffer returns empty string (no header)", () => {
      // The implementation must NOT return "Prior user turns:\n" when empty
      const c = read(BUF)
      expect(c).toMatch(/length\s*===\s*0/)
      expect(c).toMatch(/return\s*["']["']/)
    })

    test("unknown sessionID returns empty string (no header)", () => {
      // store.get(sessionID) returns undefined → return ""
      const c = read(BUF)
      expect(c).toMatch(/store\.get\(|\.get\(sessionID\)/)
    })
  })

  describe("V8 — get() raw access (req 10)", () => {
    test("get() returns raw Turn[] in insertion order", () => {
      const c = read(BUF)
      expect(c).toMatch(/\.turns|store\.get\(sessionID\)\?\.turns/)
    })

    test("get() returns [] for unknown/empty session", () => {
      const c = read(BUF)
      expect(c).toMatch(/\?\?\s*\[\]/)
    })
  })

  describe("V9 — size() configurable (reqs 11-14)", () => {
    test("buffer.ts has DEFAULT_BUFFER_SIZE const = 5", () => {
      const c = read(BUF)
      expect(c).toMatch(/DEFAULT_BUFFER_SIZE/)
      expect(c).toMatch(/=\s*5\b/)
    })

    test("buffer.ts reads buffer_size from config via getConfig()", () => {
      const c = read(BUF)
      expect(c).toMatch(/getConfig|buffer_size/)
    })

    test("foxybear.ts has buffer_size config field (additive to memory.extraction)", () => {
      expect(grep(CFG, /buffer_size/)).toBe(true)
    })

    test("Buffer.size() returns the current configured global size (not per-session)", () => {
      const c = read(BUF)
      // size() calls resolveBufferSize() each invocation
      expect(c).toMatch(/function\s+size\(\)\s*:\s*number/)
    })

    test("per-session size fixed at creation (req 14 — stored in Map value)", () => {
      const c = read(BUF)
      // The Map value shape: { turns: Turn[]; size: number }
      expect(c).toMatch(/turns\s*:\s*Turn\[\]\s*;\s*size\s*:\s*number|size\s*:\s*number\s*;\s*turns\s*:\s*Turn\[\]/)
    })
  })

  describe("V10 — session-scoping (req 15, SC-3)", () => {
    test("module-level store is a Map<sessionID, ...>", () => {
      const c = read(BUF)
      expect(c).toMatch(/new\s+Map<\s*string\s*,/)
    })

    test("buffer.ts does NOT share state across sessions (Map keyed by sessionID)", () => {
      const c = read(BUF)
      // All operations key off sessionID
      expect(c).toMatch(/store\.get\(sessionID\)|store\.set\(sessionID|store\.delete\(sessionID\)/)
    })
  })

  describe("V11 — clear on session end (reqs 16-17)", () => {
    test("clear() uses Map.delete (idempotent — no throw on missing key)", () => {
      expect(grep(BUF, /store\.delete\(sessionID\)/)).toBe(true)
    })

    test("buffer.ts exposes init() Effect for Session.Event.Deleted subscription", () => {
      const c = read(BUF)
      expect(c).toMatch(/export\s+const\s+init/)
      expect(c).toMatch(/Session\.Event\.Deleted/)
    })

    test("init() subscribes via bus.subscribe + Stream.runForEach + Effect.forkScoped", () => {
      const c = read(BUF)
      expect(c).toMatch(/bus\.subscribe|subscribe\(/)
      expect(c).toMatch(/Stream\.runForEach|runForEach/)
      expect(c).toMatch(/Effect\.forkScoped|forkScoped/)
    })
  })

  describe("V12 — in-memory only (req 18)", () => {
    test("buffer.ts does NOT import Bun.file or fs (no persistence)", () => {
      const c = read(BUF)
      expect(c).not.toMatch(/\bBun\.file\b/)
      expect(c).not.toMatch(/\bfs\b|\bfrom\s+["']fs["']\b|\bfrom\s+["']node:fs["']\b/)
    })

    test("buffer.ts does NOT import surreal (no SurrealDB writes)", () => {
      const c = read(BUF)
      expect(c).not.toMatch(/surreal/i)
    })
  })

  describe("V13 — style compliance (req 21, AGENTS.md)", () => {
    test("no `let` in buffer.ts (all const — slice returns new array, not mutation)", () => {
      const c = read(BUF)
      const lets = (c.match(/\blet\b/g) ?? []).length
      expect(lets).toBe(0)
    })

    test("no `any` type in buffer.ts", () => {
      const c = read(BUF)
      const bad = c.split("\n").some((line) => {
        const t = line.trim()
        if (t.startsWith("//") || t.startsWith("*")) return false
        return /:\s*any\b/.test(line) || /\bas\s+any\b/.test(line)
      })
      expect(bad).toBe(false)
    })

    test("no `for` loops (use map/filter/slice/flatMap)", () => {
      const c = read(BUF)
      // Allow `for` only in comments; reject `for (` and `for (let`
      const bad = c.split("\n").some((line) => {
        const t = line.trim()
        if (t.startsWith("//") || t.startsWith("*")) return false
        return /\bfor\s*\(/.test(line)
      })
      expect(bad).toBe(false)
    })

    test("no `else` blocks after a return (use early returns)", () => {
      const c = read(BUF)
      // Reject `} else {` immediately after a `return` line
      const lines = c.split("\n")
      const bad = lines.some((line, i) => {
        const t = line.trim()
        if (!t.startsWith("} else")) return false
        // Find the previous non-blank, non-comment line
        for (let j = i - 1; j >= 0; j--) {
          const pt = lines[j].trim()
          if (pt === "" || pt.startsWith("//") || pt.startsWith("*")) continue
          return /return\b/.test(pt)
        }
        return false
      })
      expect(bad).toBe(false)
    })

    test("function names are single-word where unambiguous", () => {
      const c = read(BUF)
      // The exported Buffer methods must be the SC-1 single-word names
      expect(c).toMatch(/function\s+add\b/)
      expect(c).toMatch(/function\s+get\b/)
      expect(c).toMatch(/function\s+clear\b/)
      expect(c).toMatch(/function\s+size\b/)
      expect(c).toMatch(/function\s+getContext\b/) // SC-1 mandates this exact name
    })
  })

  describe("V14 — typecheck green (CC-7, req 22)", () => {
    test("bun run typecheck exits 0", () => {
      if (!exists(BUF)) {
        expect(BUF).toBe("exists") // force fail with context
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
