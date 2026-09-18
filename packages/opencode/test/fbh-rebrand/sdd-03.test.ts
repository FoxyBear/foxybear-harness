import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const REPO = join(import.meta.dir, "..", "..", "..", "..")
const SRC = join(REPO, "packages", "opencode", "src")

function read(file: string): string {
  return readFileSync(file, "utf-8")
}

function grepCount(pattern: string, dir: string, excludes: string[] = []): number {
  const excludeArgs = excludes.flatMap((e) => ["--exclude-dir", e])
  const r = spawnSync("grep", ["-rlE", pattern, dir, ...excludeArgs], {
    encoding: "utf-8",
    timeout: 30_000,
  })
  return (r.stdout ?? "").split("\n").filter(Boolean).length
}

function grepFiles(pattern: string, dir: string, excludes: string[] = []): string[] {
  const excludeArgs: string[] = []
  for (const e of excludes) {
    if (e.includes(".")) excludeArgs.push("--exclude", e)
    else excludeArgs.push("--exclude-dir", e)
  }
  const r = spawnSync("grep", ["-rlE", pattern, dir, ...excludeArgs], {
    encoding: "utf-8",
    timeout: 30_000,
  })
  return (r.stdout ?? "").split("\n").filter(Boolean)
}

describe("SDD-03: Core Deep Rebrand", () => {
  it("V1 — XDG keystone: global/index.ts app = 'foxybear' + FBH_TEST_HOME", () => {
    const content = read(join(SRC, "global/index.ts"))
    expect(content).toContain('const app = "foxybear"')
    expect(content).not.toContain('const app = "opencode"')
    expect(content).toContain("FBH_TEST_HOME")
    expect(content).not.toContain("OPENCODE_TEST_HOME")
  })

  it("V2 — Flag namespace: zero OPENCODE_ in flag.ts, FBH_* present", () => {
    const flagFile = join(SRC, "flag/flag.ts")
    if (!existsSync(flagFile)) return
    const content = read(flagFile)
    // No OPENCODE_ env var references (renamed to FBH_)
    const opencodeMatches = content.match(/OPENCODE_[A-Z_]+/g)
    expect(opencodeMatches).toBeNull()
    // FBH_ vars present
    const fbhMatches = content.match(/FBH_[A-Z_]+/g)
    expect(fbhMatches).not.toBeNull()
    expect(fbhMatches!.length).toBeGreaterThan(20)
  })

  it("V2b — zero OPENCODE_ across src (excluding models-snapshot.js + dist + test)", () => {
    const hits = grepFiles("OPENCODE_[A-Z_]+", SRC, ["dist", "test", "fbh-rebrand"])
    // models-snapshot.js may contain OPENCODE_API_KEY if opencode provider kept;
    // OQ6=remove means it should be gone too
    const filtered = hits.filter((f) => !f.includes("models-snapshot.js"))
    expect(filtered.length).toBe(0)
  })

  it("V4 — schema URLs: foxybear.ai (OQ1=YES)", () => {
    const config = read(join(SRC, "config/config.ts"))
    expect(config).toContain("foxybear.ai/config.json")
    expect(config).not.toContain("opencode.ai/config.json")
    // Theme schemas
    const themeDir = join(SRC, "cli/cmd/tui/context/theme")
    if (existsSync(themeDir)) {
      const foxybearTheme = join(themeDir, "foxybear.json")
      if (existsSync(foxybearTheme)) {
        expect(read(foxybearTheme)).toContain("foxybear.ai/theme.json")
      }
    }
  })

  it("V5 — schema URLs: zero opencode.ai in src (excluding dist + test)", () => {
    const hits = grepFiles("opencode\\.ai", SRC, ["dist", "test", "fbh-rebrand"])
    expect(hits.length).toBe(0)
  })

  it("V6 — system prompts: FoxyBear Harness / fbh identity", () => {
    const anthropic = join(SRC, "session/prompt/anthropic.txt")
    const defaultPrompt = join(SRC, "session/prompt/default.txt")
    if (existsSync(anthropic)) {
      const content = read(anthropic)
      // Identity prose should be FoxyBear/fbh, not OpenCode/opencode
      expect(content).not.toMatch(/\bOpenCode\b/)
    }
    if (existsSync(defaultPrompt)) {
      const content = read(defaultPrompt)
      expect(content).not.toMatch(/\bopencode\b/i)
    }
  })

  it("V7 — internal host: zero opencode.internal", () => {
    const hits = grepFiles("opencode\\.internal", SRC, ["dist", "test", "fbh-rebrand"])
    expect(hits.length).toBe(0)
    // foxybear.internal should be present (reconciled)
    const foxybearHits = grepFiles("foxybear\\.internal", SRC, ["dist", "test"])
    expect(foxybearHits.length).toBeGreaterThan(0)
  })

  it("V8 — DB filename: fbh.db, zero opencode.db in src", () => {
    const db = read(join(SRC, "storage/db.ts"))
    expect(db).toContain("fbh.db")
    expect(db).not.toContain("opencode.db")
    const idx = read(join(SRC, "index.ts"))
    expect(idx).toContain("fbh.db")
    expect(idx).not.toContain("opencode.db")
    // Static sweep
    const hits = grepFiles("opencode\\.db", SRC, ["dist", "test", "fbh-rebrand"])
    expect(hits.length).toBe(0)
  })

  it("V9 — brew + install: zero anomalyco/tap, zero opencode.ai/install", () => {
    const hits1 = grepFiles("anomalyco/tap", SRC, ["dist", "test"])
    expect(hits1.length).toBe(0)
    const hits2 = grepFiles("opencode\\.ai/install", SRC, ["dist", "test"])
    expect(hits2.length).toBe(0)
  })

  it("V10 — user agent: x-fbh-client, zero x-opencode-client", () => {
    const hits = grepFiles("x-opencode-client", SRC, ["dist", "test"])
    expect(hits.length).toBe(0)
    const llm = read(join(SRC, "session/llm.ts"))
    expect(llm).toContain("x-fbh-client")
  })

  it("V11 — static sweep: zero OPENCODE_ in src (excluding dist + test + models-snapshot + migrate)", () => {
    const hits = grepFiles("OPENCODE_", SRC, ["dist", "test", "fbh-rebrand", "migrate.ts"])
    const filtered = hits.filter((f) => !f.includes("models-snapshot"))
    expect(filtered.length).toBe(0)
  })

  it("V13 — managed config + MDM: foxybear paths, ai.foxybear.managed", () => {
    const config = read(join(SRC, "config/config.ts"))
    expect(config).toContain("Application Support/foxybear")
    expect(config).not.toContain("Application Support/opencode")
    expect(config).toContain("/etc/foxybear")
    expect(config).not.toContain("/etc/opencode")
    expect(config).toContain("FBH_TEST_MANAGED_CONFIG_DIR")
    expect(config).not.toContain("OPENCODE_TEST_MANAGED_CONFIG_DIR")
    expect(config).toContain("ai.foxybear.managed")
    expect(config).not.toContain("ai.opencode.managed")
  })

  it("V14 — well-known: .well-known/fbh, zero .well-known/opencode", () => {
    const hits = grepFiles("\\.well-known/opencode", SRC, ["dist", "test"])
    expect(hits.length).toBe(0)
    const config = read(join(SRC, "config/config.ts"))
    expect(config).toContain(".well-known/fbh")
  })

  it("V15 — opencode provider removed (OQ6=remove)", () => {
    // models-snapshot.js should not have OPENCODE_API_KEY
    const snapshot = join(SRC, "provider/models-snapshot.js")
    if (existsSync(snapshot)) {
      const content = read(snapshot)
      expect(content).not.toContain("OPENCODE_API_KEY")
    }
    // provider.ts should not have ProviderID.opencode or the startsWith branch
    const provider = read(join(SRC, "provider/provider.ts"))
    expect(provider).not.toContain("ProviderID.opencode")
    expect(provider).not.toContain('startsWith("opencode")')
    // api.opencode.ai removed
    const hits = grepFiles("api\\.opencode\\.ai|app\\.opencode\\.ai", SRC, ["dist", "test"])
    expect(hits.length).toBe(0)
  })

  it("V16 — idempotent: static sweep returns 0 on re-run", () => {
    // If all OPENCODE_ are gone, a re-run finds nothing.
    const hits = grepFiles("OPENCODE_[A-Z_]+", SRC, ["dist", "test", "fbh-rebrand", "migrate.ts"])
    const filtered = hits.filter((f) => !f.includes("models-snapshot"))
    expect(filtered.length).toBe(0)
  })
})
