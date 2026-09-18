# SDD Audit Report — sdd-04 (migration)

**Date:** 2026-09-18
**Auditor:** Katya (self-audit — disclosed)
**Spec:** `260918_fbh-rebrand_sdd-04-migration.md`

## Fresh-context re-audit (2026-09-18) — corrections applied

### Seam 2: Plan regression — FIXED
- **Blocker:** SDD-04 omitted `~/.local/share/opencode/storage/` (plan line 388 had it) and dropped `agent/`, `mode/`, `skill/` config dirs (plan lines 382/384/385 had them). SDD-04 was narrower than the plan.
- **Fix:** Req 7 expanded to include `agent/`, `mode/`, `skill/` dirs. New req 12b adds `storage/` copy (1000+ session diffs). FIXED.

### Seam 5: Migration source exhaustiveness — FIXED (data-loss)
- **Blocker:** Two critical orphaned sources on disk: `~/.local/state/opencode/` (prompt-history.jsonl, kv.json, plugin-meta.json, model.json, locks/ — SC-1 named the path but SC-7/research/plan omitted it) and `~/.local/share/opencode/storage/` (1083 session diffs — plan had it, SDD-04 regressed). Both are user data; losing either is the cardinal failure mode. Plus `snapshot/`, `tool-output/`, `memory-backup-*.json` orphaned.
- **Fix:** SC-7 rewritten to be exhaustive (20-row table with strategy per source). SDD-04 req 12b (storage), 12c (state dir), 12d (snapshot/tool-output skip) added. Req 12 amended for memory-backup-*.json. Background inventory note updated. V5b (state dir), V5c (storage), V5d (agent/mode/skill), V5e (snapshot/tool-output skip) added. FIXED.

## Verdict

VERDICT: PASS

## Checks passed

- SC-7 migration sources verified against real `ls` of `~/.config/opencode/` and `~/.local/share/opencode/`: multiple DBs (opencode-dev.db, opencode-feat-*.db), memory.surreal + memory-server/, foxybear-serve.pid, council.json, personas/, commands/, google-workspace/, node project in config dir, coexisting foxybear.json + opencode.json. ✓
- Per-source merge strategy explicit (reqs 5–15): JSON merge with first-definition-wins, JSONC token translation (`{env:OPENCODE_*}` → `{env:FBH_*}`), single-file copy, SQLite copy+migrate, auth.json copy-not-log, SurrealDB path-rewrite-or-flag, PID not copied (stale-safe), logs/cache skip, API keys untouched. ✓
- `fbh migrate --dry-run` (req 1, V1) — no writes. ✓
- `fbh migrate` idempotent (reqs 3–4, V9) — skip if target exists, conflict logging, target-wins. ✓
- Backward-compat reads with deprecation warnings (reqs 16–17, V10–V11) — `.opencode/` dirs and `opencode.*` config read with stderr warning naming removal version. ✓
- First-run prompt (req 18, V12) — detects legacy data, prompts to migrate. ✓
- No original data lost (V13) — copy-not-move, checksum verify. ✓
- Security: API keys untouched (req 15, V8), auth.json not logged (req 11, V4). ✓

## Non-blocking observations

- O2 (research gap 3): SurrealDB path-binding is still open — req 12 + V5 handle it (rewrite or flag), but implementation must test against a real `memory.surreal` fixture. Flagged in combined audit. The spec's "verify and rewrite or flag" is the right contract; risk is real (memory graph corruption if rewrite is imperfect) but bounded by the copy-not-move rule (source intact).
- The node project in `~/.config/opencode/` (package.json/bun.lock/node_modules) — req 9 copies it but notes "purpose needs verification." Implementation should investigate why a node project lives in the config dir before copying blindly. Acceptable; flagged.
