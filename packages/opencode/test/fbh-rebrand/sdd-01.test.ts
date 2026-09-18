import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const SCRIPT = join(REPO_ROOT, "scripts", "fbh-rebrand", "01-preserve-and-rename.sh")

function run(args: string[], env: Record<string, string> = {}, cwd: string = REPO_ROOT) {
  const gitEnv = {
    GIT_AUTHOR_EMAIL: "test@foxybear.local",
    GIT_AUTHOR_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@foxybear.local",
    GIT_COMMITTER_NAME: "Test",
  }
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd,
    env: { ...process.env, ...gitEnv, ...env },
    encoding: "utf-8",
    timeout: 60_000,
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

function git(args: string[], cwd: string) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "test@foxybear.local",
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@foxybear.local",
      GIT_COMMITTER_NAME: "Test",
    },
  })
}

describe("SDD-01: Preserve & Rename", () => {
  let tmpHome: string
  let tmpClone: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "fbh-sdd01-home-"))
    tmpClone = mkdtempSync(join(tmpdir(), "fbh-sdd01-clone-"))
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(tmpClone, { recursive: true, force: true })
  })

  it("V1 — dirty tree committed: a test file is committed as the pre-fork snapshot", () => {
    spawnSync("git", ["init", "-b", "port/foxybear-v2", tmpClone], { encoding: "utf-8" })
    writeFileSync(join(tmpClone, "README.md"), "# test\n")
    git(["add", "README.md"], tmpClone)
    git(["commit", "-m", "init"], tmpClone)
    writeFileSync(join(tmpClone, "untracked.txt"), "in-flight\n")
    const r = run(["--phase", "commit", "--repo", tmpClone], { HOME: tmpHome })
    expect(r.status).toBe(0)
    const status = git(["status", "--porcelain"], tmpClone)
    expect(status.stdout.trim()).toBe("")
    const log = git(["log", "--oneline"], tmpClone)
    expect(log.stdout).toContain("chore(pre-fork): snapshot in-flight customizations")
  })

  it("V5 — backup archive excludes API keys and includes .git", () => {
    // Setup: create fixture paths matching the inventory
    const backupDir = mkdtempSync(join(tmpdir(), "fbh-backup-src-"))
    mkdirSync(join(backupDir, ".git"), { recursive: true })
    writeFileSync(join(backupDir, ".git", "HEAD"), "ref: refs/heads/main\n")
    mkdirSync(join(backupDir, "config"), { recursive: true })
    writeFileSync(join(backupDir, "config", "council.json"), "{}")
    mkdirSync(join(backupDir, "..", "..", "Development"), { recursive: true })
    const devDir = join(backupDir, "..", "Development")
    mkdirSync(devDir, { recursive: true })
    writeFileSync(join(devDir, ".openai_api.key"), "sk-fake")
    // Run backup phase with --repo bounded to the fixture
    const r = run(["--phase", "backup", "--repo", backupDir, "--home", tmpHome], { HOME: tmpHome })
    expect(r.status).toBe(0)
    // Find the archive
    const shareDir = join(tmpHome, ".local", "share")
    const archives = spawnSync("bash", ["-c", `ls ${shareDir}/foxybear-pre-fork-backup-*.tar.zst 2>/dev/null`], { encoding: "utf-8" })
    expect(archives.stdout.trim()).not.toBe("")
    const archive = archives.stdout.trim().split("\n")[0]
    // Archive exists and is non-empty
    const stat = spawnSync("stat", ["-f%z", archive], { encoding: "utf-8" })
    expect(Number(stat.stdout.trim())).toBeGreaterThan(0)
    // Archive contents: .git present, API keys ABSENT
    const contents = spawnSync("bash", ["-c", `tar -tf ${archive}`], { encoding: "utf-8" })
    expect(contents.stdout).toContain(".git/HEAD")
    expect(contents.stdout).not.toContain("openai_api.key")
    // Manifest exists
    const manifests = spawnSync("bash", ["-c", `ls ${shareDir}/foxybear-pre-fork-backup-*.manifest.txt 2>/dev/null`], { encoding: "utf-8" })
    expect(manifests.stdout.trim()).not.toBe("")
  })

  it("V6 — abort on failure: simulated push failure stops before tagging", () => {
    spawnSync("git", ["init", "-b", "port/foxybear-v2", tmpClone], { encoding: "utf-8" })
    writeFileSync(join(tmpClone, "README.md"), "# test\n")
    git(["add", "."], tmpClone)
    git(["commit", "-m", "init"], tmpClone)
    spawnSync("git", ["-C", tmpClone, "remote", "add", "origin", "https://github.invalid/nonexistent.git"], { encoding: "utf-8" })
    const r = run(["--phase", "push", "--repo", tmpClone], { HOME: tmpHome })
    expect(r.status).not.toBe(0)
    const tags = git(["tag", "-l"], tmpClone)
    expect(tags.stdout).not.toContain("pre-fork-")
  })

  it("V8 — idempotent re-run: second run is a no-op for the commit step", () => {
    spawnSync("git", ["init", "-b", "port/foxybear-v2", tmpClone], { encoding: "utf-8" })
    writeFileSync(join(tmpClone, "README.md"), "# test\n")
    git(["add", "."], tmpClone)
    git(["commit", "-m", "init"], tmpClone)
    const r1 = run(["--phase", "commit", "--repo", tmpClone], { HOME: tmpHome })
    expect(r1.status).toBe(0)
    const r2 = run(["--phase", "commit", "--repo", tmpClone], { HOME: tmpHome })
    expect(r2.status).toBe(0)
    expect(r2.stderr.toLowerCase()).toContain("already")
  })

  it("V9 — no original text lost: HEAD advances by exactly the dirty-tree commit", () => {
    spawnSync("git", ["init", "-b", "port/foxybear-v2", tmpClone], { encoding: "utf-8" })
    writeFileSync(join(tmpClone, "README.md"), "# test\n")
    git(["add", "."], tmpClone)
    git(["commit", "-m", "init"], tmpClone)
    const headBefore = git(["rev-parse", "HEAD"], tmpClone).stdout.trim()
    writeFileSync(join(tmpClone, "untracked.txt"), "in-flight\n")
    const r = run(["--phase", "commit", "--repo", tmpClone], { HOME: tmpHome })
    expect(r.status).toBe(0)
    const headAfter = git(["rev-parse", "HEAD"], tmpClone).stdout.trim()
    expect(headAfter).not.toBe(headBefore)
    const count = git(["rev-list", "--count", `${headBefore}..HEAD`], tmpClone)
    expect(Number(count.stdout.trim())).toBe(1)
  })
})
