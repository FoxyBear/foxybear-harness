import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const REPO = join(import.meta.dir, "..", "..", "..", "..")

function read(file: string): string {
  return readFileSync(file, "utf-8")
}

function grep(pattern: string, dir: string, opts: { exclude?: string[] } = {}): string[] {
  const excludeArgs = (opts.exclude ?? []).flatMap((e) => ["--exclude-dir", e])
  const r = spawnSync("grep", ["-rlE", pattern, dir, ...excludeArgs], {
    encoding: "utf-8",
    timeout: 30_000,
  })
  return (r.stdout ?? "").split("\n").filter(Boolean)
}

function grepCount(pattern: string, dir: string, opts: { exclude?: string[] } = {}): number {
  const excludeArgs = (opts.exclude ?? []).flatMap((e) => ["--exclude-dir", e])
  const r = spawnSync("bash", ["-c", `grep -rE '${pattern.replace(/'/g, "'\\''")}' ${dir} ${excludeArgs.map((e) => `--exclude-dir=${e[1]}`).join(" ")} 2>/dev/null | wc -l`], {
    encoding: "utf-8",
    timeout: 30_000,
  })
  return Number((r.stdout ?? "0").trim())
}

const PACKAGES = join(REPO, "packages")
const KEEP_PACKAGES = [
  "util", "sdk/js", "plugin", "ui", "storybook", "app",
  "slack", "desktop", "extensions", "containers", "opencode",
]
const DROP_PACKAGES = ["desktop-electron", "web", "docs", "identity"]

describe("SDD-02: Package Rebrand", () => {
  it("V1 — scope rename: every kept package name is @foxybear/*", () => {
    const checks: Array<[string, string]> = [
      ["packages/util/package.json", "@foxybear/util"],
      ["packages/sdk/js/package.json", "@foxybear/sdk"],
      ["packages/plugin/package.json", "@foxybear/plugin"],
      ["packages/ui/package.json", "@foxybear/ui"],
      ["packages/app/package.json", "@foxybear/app"],
      ["packages/desktop/package.json", "@foxybear/desktop"],
      ["packages/storybook/package.json", "@foxybear/storybook"],
      ["packages/slack/package.json", "@foxybear/slack"],
    ]
    for (const [file, name] of checks) {
      const pkg = JSON.parse(read(join(REPO, file)))
      expect(pkg.name).toBe(name)
    }
  })

  it("V1b — no @opencode-ai scope references in package.json files", () => {
    const hits = grep("@opencode-ai", PACKAGES, { exclude: ["node_modules", ".opencode"] })
    // Filter to package.json only
    const pkgJsonHits = hits.filter((f) => f.endsWith("package.json"))
    expect(pkgJsonHits.length).toBe(0)
  })

  it("V1c — bun.lock has no @opencode-ai workspace entries", () => {
    const lockfile = join(REPO, "bun.lock")
    if (!existsSync(lockfile)) return
    const content = read(lockfile)
    // External npm packages may reference upstream @opencode-ai/plugin (fine).
    // Our workspace packages must NOT be named @opencode-ai/*.
    const workspaceHits = content.match(/@opencode-ai\/\S*@workspace:/g)
    expect(workspaceHits).toBeNull()
  })

  it("V3 — SDK factory renamed createOpencodeClient → createFbhClient", () => {
    const client = read(join(PACKAGES, "sdk/js/src/v2/client.ts"))
    expect(client).toContain("createFbhClient")
    expect(client).not.toContain("export function createOpencodeClient")

    const plugin = read(join(PACKAGES, "plugin/src/index.ts"))
    expect(plugin).toContain("createFbhClient")
  })

  it("V4 — OQ2 clean break: no deprecation shim", () => {
    const client = read(join(PACKAGES, "sdk/js/src/v2/client.ts"))
    expect(client).not.toContain("createOpencodeClient = createFbhClient")
    expect(client).not.toContain("@deprecated")
  })

  it("V5 — no createOpencodeClient in source (excluding openapi.json + node_modules + dist)", () => {
    const hits = grep("createOpencodeClient", PACKAGES, {
      exclude: ["node_modules", ".opencode", "fbh-rebrand", "dist"],
    })
    const srcHits = hits.filter((f) => !f.includes("openapi.json"))
    expect(srcHits.length).toBe(0)
  })

  it("V6 — dropped packages gone", () => {
    for (const pkg of DROP_PACKAGES) {
      expect(existsSync(join(PACKAGES, pkg))).toBe(false)
    }
    // script merged into core, then dropped
    expect(existsSync(join(PACKAGES, "script"))).toBe(false)
  })

  it("V6b — CC-10: no kept package imports dropped packages", () => {
    const dropped = ["@foxybear/desktop-electron", "@foxybear/web", "@foxybear/docs", "@foxybear/identity", "@foxybear/script"]
    for (const dep of dropped) {
      const r = spawnSync("grep", ["-rlE", dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), PACKAGES, "--include=*.ts", "--include=*.tsx", "--include=*.json", "--exclude-dir=node_modules", "--exclude-dir=.opencode", "--exclude-dir=fbh-rebrand"], {
        encoding: "utf-8",
        timeout: 30_000,
      })
      const hits = (r.stdout ?? "").split("\n").filter(Boolean)
      expect(hits.length).toBe(0)
    }
  })

  it("V7 — container registry: ghcr.io/anomalyco → ghcr.io/foxybear", () => {
    const anomalycoHits = grep("ghcr.io/anomalyco", join(PACKAGES, "containers"), { exclude: ["node_modules"] })
    expect(anomalycoHits.length).toBe(0)
    const foxybearHits = grep("ghcr.io/foxybear", join(PACKAGES, "containers"), { exclude: ["node_modules"] })
    expect(foxybearHits.length).toBeGreaterThan(0)
  })

  it("V8 — Tauri identifiers rebranded", () => {
    const tauriConfigs = [
      "packages/desktop/src-tauri/tauri.conf.json",
      "packages/desktop/src-tauri/tauri.beta.conf.json",
      "packages/desktop/src-tauri/tauri.prod.conf.json",
    ]
    for (const conf of tauriConfigs) {
      const path = join(REPO, conf)
      if (!existsSync(path)) continue
      const content = read(path)
      expect(content).not.toContain("anomalyco")
      // identifier should be foxybear-branded
      const pkg = JSON.parse(content)
      if (pkg.productName) expect(pkg.productName.toLowerCase()).not.toContain("opencode")
      if (pkg.identifier) expect(pkg.identifier.toLowerCase()).not.toContain("opencode")
    }
  })

  it("V10 — idempotent: re-running scope rename is a no-op (static check)", () => {
    // If all @opencode-ai are already gone, a re-run would find nothing to rename.
    const hits = grep("@opencode-ai", PACKAGES, { exclude: ["node_modules", ".opencode"] })
    const pkgJsonHits = hits.filter((f) => f.endsWith("package.json"))
    expect(pkgJsonHits.length).toBe(0) // already done
  })
})
