import { describe, it, expect } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

// SDD-06: static sweep regression for the opencode → fbh rebrand.
//
// The earlier rebrand sweep missed user-facing string literals that used
// `opencode` as a command/program name (e.g. `opencode -s`, `opencode auth`,
// `Run: opencode mcp auth <key>`). This test greps packages/fbh/src for the
// MUST-FIX patterns and fails if any return:
//
//   - `opencode <subcommand>` (word-boundary) anywhere in a string literal
//   - a string literal (backtick/double/single quote) that STARTS with `opencode <text>`
//
// Legitimate `opencode` tokens are not flagged:
//   - the `opencode` provider ID (`provider.id === "opencode"`, `ProviderID.opencode`)
//   - backward-compat read paths in config/config.ts + config/paths.ts (excluded)
//   - models-snapshot.js (auto-generated; opencode provider already removed)
//   - comments (`//` line + `/* */` block) are stripped before matching
//   - external package registry names (`opencode-ai`, brew/choco/scoop `opencode`)
//     — these never match `opencode <space> <subcommand>` or string-start patterns
//
// The test is precise: it matches `opencode` as a word boundary in string
// contexts, not any `opencode` substring.

const SRC = join(import.meta.dir, "..", "..", "src")

const EXCLUDE_DIRS = new Set(["node_modules", "dist", "test", "fbh-rebrand", ".git"])

// Files dominated by legitimate backward-compat reads of legacy opencode paths.
// These are intentionally excluded (they have comments explaining the intent).
const EXCLUDE_FILES = new Set([
  join("config", "config.ts"),
  join("config", "paths.ts"),
  join("provider", "models-snapshot.js"),
])

// Subcommands from the MUST-FIX list. `opencode <one of these>` is always a
// command-name usage and must say `fbh` post-rebrand.
const SUBCOMMANDS = [
  "-s",
  "--session",
  "models",
  "run",
  "auth",
  "attach",
  "serve",
  "web",
  "agent",
  "mcp",
  "github",
  "pr",
  "export",
  "import",
  "upgrade",
  "uninstall",
  "stats",
  "completion",
  "acp",
  "debug",
  "session",
  "providers",
]

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Pattern A: `opencode <subcommand>` (word boundary) anywhere on the line.
// Matches command-name usages in any string literal (quoted/backtick) or
// template expression. Bare `opencode.json`, `.opencode`, `opencode-ai`, and
// the bare provider id `"opencode"` do not match (no whitespace+subcommand).
const SUBCMD_RE = new RegExp(String.raw`\bopencode[ \t]+(?:${SUBCOMMANDS.map(esc).join("|")})\b`)

// Pattern E: a string literal that STARTS with `opencode <text>` — covers
// `\`opencode ...` in backtick templates and `"opencode ...` / `'opencode ...`
// in error messages. Catches e.g. "opencode does not support MCP auth yet."
const STRING_START_RE = /["'`]opencode[ \t]+\S/

// Pattern F: a spawn/command array literal `["opencode", "<subcommand>", ...]`
// — the binary name followed by a subcommand string. This is `opencode <subcommand>`
// split across two string literals (e.g. Process.spawn(["opencode", "import", url])),
// which Pattern A cannot see because the tokens live in separate strings.
const SUBCMD_ARR_RE = new RegExp(
  String.raw`"opencode"\s*,\s*"(?:${SUBCOMMANDS.map(esc).join("|")})"`,
)

function stripBlockComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "")
}

function stripLineComment(line: string): string {
  // Remove `// ...` to EOL, but keep `://` (URLs like https://).
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] === "/" && line[i + 1] === "/") {
      if (i > 0 && line[i - 1] === ":") continue
      return line.slice(0, i)
    }
  }
  return line
}

function stripComments(content: string): string {
  const noBlock = stripBlockComments(content)
  return noBlock.split("\n").map(stripLineComment).join("\n")
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx|js)$/.test(entry)) acc.push(p)
  }
  return acc
}

describe("SDD-06: opencode string-literal static sweep", () => {
  it("no user-facing `opencode <command>` string literals remain in src", () => {
    const files = walk(SRC)
    const offenders: string[] = []
    for (const f of files) {
      const rel = relative(SRC, f)
      if (EXCLUDE_FILES.has(rel)) continue
      const stripped = stripComments(readFileSync(f, "utf-8"))
      const lines = stripped.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (SUBCMD_RE.test(line) || STRING_START_RE.test(line) || SUBCMD_ARR_RE.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders.join("\n")).toBe("")
  })
})
