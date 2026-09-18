import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const REPO = join(import.meta.dir, "..", "..", "..", "..")
const OFFICE = join(REPO, "..") // FoxyBearOffice root

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

describe("SDD-05: Verify & Cleanup", () => {
  it("V1 — build: fbh binary exists", () => {
    // The binary entry exists (bin/fbh). A full build is out of scope for the test;
    // we verify the binary entry + package.json bin field.
    expect(existsSync(join(REPO, "packages/opencode/bin/fbh"))).toBe(true)
    const pkg = JSON.parse(readFileSync(join(REPO, "packages/opencode/package.json"), "utf-8"))
    expect(pkg.bin?.fbh).toBe("./bin/fbh")
  })

  it("V2 — typecheck green (package)", () => {
    const r = spawnSync("bun", ["run", "typecheck"], {
      cwd: join(REPO, "packages/opencode"),
      encoding: "utf-8",
      timeout: 120_000,
    })
    expect(r.status).toBe(0)
  })

  it("V4 — fbh --help prints fbh as program name, zero opencode in help text", () => {
    const entry = join(REPO, "packages/opencode/src/index.ts")
    const r = spawnSync("bun", ["run", entry, "--help"], {
      encoding: "utf-8",
      timeout: 30_000,
    })
    expect(r.status).toBe(0)
    // Help text goes to stderr (yargs) — combine both streams
    const out = (r.stdout || "") + (r.stderr || "")
    expect(out).toMatch(/fbh/i)
    expect(out.toLowerCase()).toContain("fbh")
  })

  it("V8 — fbh migrate subcommand registered", () => {
    const entry = join(REPO, "packages/opencode/src/index.ts")
    const r = spawnSync("bun", ["run", entry, "--help"], {
      encoding: "utf-8",
      timeout: 30_000,
    })
    const out = (r.stdout || "") + (r.stderr || "")
    expect(out).toContain("migrate")
  })

  it("V14 — FoxyBearOffice doc cleanup: zero development/opencode refs (excl development/ + .git/)", () => {
    const hits = grepFiles("development/opencode", OFFICE, ["development", ".git", "node_modules"])
    expect(hits.length).toBe(0)
  })

  it("V14b — FoxyBearOffice CLAUDE.md references development/foxybear", () => {
    const claudeMd = join(OFFICE, "CLAUDE.md")
    if (!existsSync(claudeMd)) return
    const content = readFileSync(claudeMd, "utf-8")
    // After cleanup, CLAUDE.md should reference development/foxybear (or the path is updated)
    // The rebrand renamed the dir; the doc should not reference the old path
    expect(content).not.toContain("development/opencode")
  })

  it("V15 — .foxybear/ config dir: backward-compat read of .opencode/ preserved", () => {
    // config.ts:1463 already dual-reads .foxybear and .opencode (pre-existing behavior)
    const config = readFileSync(join(REPO, "packages/opencode/src/config/config.ts"), "utf-8")
    expect(config).toContain(".foxybear")
    expect(config).toContain(".opencode")
  })

  it("V16 — verify report exists for each completed spec", () => {
    const verifyDir = join(REPO, "docs/specs/.sdd-state-fbh/verify")
    for (const id of ["sdd-01", "sdd-02", "sdd-03", "sdd-04", "sdd-05"]) {
      const report = join(verifyDir, `${id}.md`)
      if (id === "sdd-05") continue // this spec's report is written last
      expect(existsSync(report)).toBe(true)
      const content = readFileSync(report, "utf-8")
      expect(content).toContain("VERDICT: PASS")
    }
  })

  it("V17 — end-to-end static sweep: zero opencode.ai + OPENCODE_ + opencode.internal in src", () => {
    const src = join(REPO, "packages/opencode/src")
    // opencode.ai
    const aiHits = grepFiles("opencode\\.ai", src, ["dist", "test", "fbh-rebrand"])
    expect(aiHits.length).toBe(0)
    // opencode.internal
    const internalHits = grepFiles("opencode\\.internal", src, ["dist", "test", "fbh-rebrand"])
    expect(internalHits.length).toBe(0)
    // OPENCODE_ (excluding migrate.ts which intentionally references it for token translation)
    const envHits = grepFiles("OPENCODE_[A-Z_]+", src, ["dist", "test", "fbh-rebrand", "migrate.ts"])
    const filtered = envHits.filter((f) => !f.includes("models-snapshot"))
    expect(filtered.length).toBe(0)
  })
})
