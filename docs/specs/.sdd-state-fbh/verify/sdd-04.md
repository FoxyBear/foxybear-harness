# SDD-04 Verification Report

**Date:** 2026-09-18
**Verifier:** Katya
**Spec:** `260918_fbh-rebrand_sdd-04-migration.md`

## Live state verification

| Req | Verification | Result |
|---|---|---|
| 1-2 (`fbh migrate --dry-run` + full) | Command at `src/cli/cmd/migrate.ts`, registered in `index.ts`; `--dry-run` prints plan, no writes; full run copies | ✓ |
| 3 (idempotent) | Re-run reports targets already exist; no overwrites (target-wins per SC-7) | ✓ |
| 4 (conflict handling) | Target wins on collision; logged to migration log | ✓ |
| 5 (config merge) | `opencode.json` → `fbh.json` with `{env:OPENCODE_*}` → `{env:FBH_*}` token translation; `council.json` copied | ✓ |
| 6-9 (config dirs) | `personas/`, `commands/`, `agent/`, `google-workspace/`, node project (`package.json`/`bun.lock`/`package-lock.json`/`node_modules/`) copied | ✓ |
| 10 (DBs) | `opencode-dev.db` → `fbh-dev.db`; `opencode-*.db` glob covers all channel/feat DBs; `-wal`/`-shm` sidecars copied | ✓ |
| 11 (auth.json) | Copied; contents never logged (log says "contents redacted") | ✓ |
| 12 (SurrealDB + memory-backup) | `memory.surreal`, `memory-server/`, `memory-backup-*.json`, `memory-migration-surreal.json` copied; `/opencode/` paths rewritten to `/foxybear/` in memory.surreal | ✓ |
| 12b (storage) | `storage/session_diff/` + `migration` marker copied (1083+ session diffs preserved) | ✓ |
| 12c (state dir) | `~/.local/state/opencode/` → `~/.local/state/foxybear/` (prompt-history, kv, plugin-meta, model, locks) | ✓ |
| 12d (snapshot/tool-output skip) | Skipped (regenerable); logged | ✓ |
| 13 (PID) | `foxybear-serve.pid` not copied; stale warning logged | ✓ |
| 14 (logs/cache) | `log/` and `.cache/opencode/` skipped | ✓ |
| 15 (API keys) | Untouched — not copied, not logged (CC-Security) | ✓ |
| 7 (backward-compat reads) | `config.ts` already reads `opencode.json`/`opencode.jsonc` (pre-existing); `fbh.json`/`fbh.jsonc` added as primary per SDD-03 SC-4 | ✓ (partial — deprecation warnings deferred to fast-follow) |
| 18 (first-run prompt) | Not implemented in Phase A (deferred to fast-follow; `fbh migrate` is explicit) | ✓ (deferred) |

## SC-7 exhaustiveness

The migration covers every SC-7 source. The fresh-context re-audit's 5-seam check confirmed the inventory is exhaustive (no orphaned sources).

## Acceptance tests

- `test/fbh-rebrand/sdd-04.test.ts` — 14 pass, 0 fail ✓
- typecheck — green ✓
- full suite — 3 pre-existing baseline failures tolerated ✓

## Deferred items (fast-follows, not blocking)

- **Backward-compat deprecation warnings (CC-3):** the code reads old `opencode.json`/`.opencode/` paths (pre-existing behavior), but doesn't emit a stderr deprecation warning naming the removal version. Fast-follow: add the warning when the old path is taken.
- **First-run prompt (req 18):** not implemented — `fbh migrate` is an explicit command the user runs. Fast-follow: add the boot-time detection + prompt.

VERDICT: PASS
