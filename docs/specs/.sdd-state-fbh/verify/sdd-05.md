# SDD-05 Verification Report

**Date:** 2026-09-18
**Verifier:** Katya
**Spec:** `260918_fbh-rebrand_sdd-05-verify-and-cleanup.md`

## Live state verification

| Req | Verification | Result |
|---|---|---|
| 1 (build) | `packages/opencode/bin/fbh` exists; `package.json` `bin: { "fbh": "./bin/fbh" }` | ✓ |
| 2 (typecheck) | `tsgo --noEmit` exits 0 (package + root) | ✓ |
| 3 (tests) | `bun test` green (3 pre-existing baseline failures tolerated) | ✓ |
| 4 (fbh --help) | `fbh --help` exits 0; prints `fbh` as program name; banner shows "Fbh" ASCII art | ✓ |
| 5 (config load) | `fbh.json` primary (SC-4); legacy `opencode.json` read via config.ts:1274-1278 | ✓ |
| 6 (TUI) | TUI launches (banner + commands rebranded) | ✓ |
| 7 (LLM session) | Deferred — requires real provider key + running session (fast-follow; the harness is still running as `opencode` global, cutover is the manual step) | ✓ (deferred) |
| 8 (provider auth) | `fbh providers` registered; auth reads from `~/.local/share/foxybear/auth.json` after migration | ✓ |
| 9 (memory) | `fbh.db` at new path (SDD-03); SurrealDB migrated (SDD-04) | ✓ |
| 10 (plugins) | Plugin loading intact (removed external Gitlab/Poe auth plugins per SDD-02; built-in plugins preserved) | ✓ |
| 11 (server) | `fbh serve` registered | ✓ |
| 12 (scheduler) | Scheduler intact (no rebrand needed; Phase Y patch-monitor is fast-follow) | ✓ |
| 13 (doc cleanup) | Zero `development/opencode` refs in FoxyBearOffice (excl development/ + .git/) | ✓ |
| 14 (.foxybear/ dir) | config.ts dual-reads `.foxybear`/`.opencode` (pre-existing, preserved) | ✓ |
| 15 (verify report) | This report | ✓ |
| 16 (R11 post-build binary scan) | Source-level: zero `opencode` identity strings in src (static sweep V17). Binary-level scan is a fast-follow (requires full build with bundled TS) | ✓ (source-level; binary-level deferred) |
| 17 (B7 consumer integration) | `fbh migrate` works from clean tmp HOME (SDD-04 tests); `fbh --help` works | ✓ |

## Additional changes

- TUI banner ASCII art: "OpenCode" → "Fbh" in `logo.ts` + `ui.ts`
- Yargs `scriptName("opencode")` → `scriptName("fbh")`
- All yargs command descriptions: `opencode` → `fbh` (attach, tui, run, uninstall, upgrade, web, providers, pr, etc.)
- FoxyBearOffice docs: all `development/opencode` → `development/foxybear` (CLAUDE.md, SESSION.md, docs/, .claude/skills/, tools/sdd/, .gitignore)
- Removed stale `.swp` file

## End-to-end static sweep (V17)

- `opencode.ai` in src (excl dist + test): 0 ✓
- `opencode.internal` in src: 0 ✓
- `OPENCODE_` in src (excl dist + test + models-snapshot + migrate.ts): 0 ✓

## Deferred to fast-follows (not blocking)

- **FBH-FF-007:** Real LLM session smoke (V7) — requires cutover from `opencode` global to `fbh` binary + `fbh migrate` run. Manual step when Todd is ready.
- **FBH-FF-008:** Post-build binary string scan (V16 binary-level) — requires full build with bundled TS to scan the compiled binary for inlined `opencode` strings. The source-level sweep is green.
- **FBH-FF-009:** openapi.json regeneration — SDD-02 sed-renamed it; proper regeneration via `./packages/sdk/js/script/build.ts` (requires running harness server) is a fast-follow.

## Acceptance tests

- `test/fbh-rebrand/sdd-05.test.ts` — 9 pass, 0 fail ✓
- typecheck — green ✓
- full suite — 3 pre-existing baseline failures tolerated ✓

VERDICT: PASS
