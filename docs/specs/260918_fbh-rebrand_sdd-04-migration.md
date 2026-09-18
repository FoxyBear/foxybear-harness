# SDD-04: Migration (Phase A.5)

**Date:** 2026-09-18
**Project:** FoxyBear Harness
**Status:** Draft (pending audit + council + human gate)
**Master:** `260918_fbh-rebrand_sdd-00-master.md`
**Depends on:** SDD-03 (new XDG paths and config filenames defined).
**Owns:** SC-7 (migration sources & merge strategy), the `fbh migrate` command.

Implements Phase A.5: the `fbh migrate` command that moves existing user data from `opencode` paths to `foxybear` paths, the backward-compat reads that let users with old `.opencode/` dirs and `opencode.*` config keep working, and the first-run prompt. Research §Phase A.5 inventoried the existing data; this spec turns it into a merge-strategy-per-source pipeline.

## Background

Research found multiple DB files (`opencode-dev.db`, `opencode-feat-*.db`), a SurrealDB memory store (`memory.surreal` + `memory-server/` + `memory-backup-*.json`), a node project living in `~/.config/opencode/` (`package.json`/`bun.lock`/`node_modules`), coexisting `foxybear.json` and `opencode.json` config, and API keys that are NOT opencode-branded (must not be touched). The fresh-context re-audit (2026-09-18) found two additional critical sources the original research missed: `~/.local/state/opencode/` (XDG state: prompt history, KV store, plugin metadata, model state — SC-1 named the path but SC-7/research/plan omitted it) and `~/.local/share/opencode/storage/` (1000+ session diffs — the plan listed it for Copy at line 388 but the original SDD-04 regressed and dropped it). Both are user data; losing either is the cardinal failure mode this spec exists to prevent. The plan's migration table is accurate in structure; this spec makes the merge rules, the idempotency/dry-run contract, and the full source inventory (per SC-7, restored exhaustive) explicit.

---

## WHAT

### `fbh migrate` command (CC-7, SC-7)

1. **WHEN** the user runs `fbh migrate --dry-run`, the system **SHALL** walk every source in SC-7's inventory, determine the action it WOULD take, and print a plan to stdout listing each source → target → action, WITHOUT writing, copying, moving, or deleting anything. The plan **SHALL** note which sources already have a target (skip) vs. need migration.

2. **WHEN** the user runs `fbh migrate` (no flag), the system **SHALL** perform every migration action from SC-7, logging each action taken to a log file at `~/.local/share/foxybear/migration-<timestamp>.log` AND to stdout. The system **SHALL** copy (not move) source data to targets; old `opencode` paths **SHALL** remain untouched on disk (CC-7).

3. **WHEN** `fbh migrate` is re-run after success, the system **SHALL** be idempotent (CC-2): sources already migrated are detected (target exists and is non-empty) and skipped; the system reports "already migrated" for each. No duplicate copies, no overwrites of newer target data with older source data.

4. **WHEN** `fbh migrate` encounters a target that exists and differs from the source (conflict), the system **SHALL** preserve the target (target wins) and **SHALL** log the conflict to the migration log with both paths and a diff summary. The system **SHALL NOT** silently overwrite.

### Merge strategy per source (SC-7)

5. **WHEN** migrating `~/.config/opencode/*.json(c)`, the system **SHALL** merge each file into `~/.config/foxybear/*.json(c)` per SC-4's priority order: `fbh.jsonc` > `fbh.json` > `foxybear.jsonc` > `foxybear.json` > `opencode.jsonc` > `opencode.json` > `config.json`. For JSONC files, the system **SHALL** preserve `{env:VAR}` and `{file:path}` substitution tokens but **SHALL** translate any token referencing an `OPENCODE_*` env var to the `FBH_*` equivalent (plan Follow-On item 3). For key collisions during merge, the first file (highest priority) to define a key wins; lower-priority files do not override.

6. **WHEN** migrating `~/.config/opencode/council.json`, the system **SHALL** copy it to `~/.config/foxybear/council.json` (single file, no merge). If a target exists, target wins (Step 4).

7. **WHEN** migrating `~/.config/opencode/personas/*.md` and `~/.config/opencode/commands/**/*.md`, the system **SHALL** merge by filename: for each source file, copy to the target dir; if a target with the same name exists, target wins (Step 4). The system **SHALL** preserve directory structure under `commands/` (nested subdirs). The system **SHALL** also migrate `~/.config/opencode/agent/**/*.md` → `~/.config/foxybear/agent/**/*.md`, `~/.config/opencode/mode/**/*.md` → `~/.config/foxybear/mode/**/*.md`, and `~/.config/opencode/skill/**` → `~/.config/foxybear/skill/**` with the same merge semantics (per plan lines 382, 384, 385 — these were omitted from the original SDD-04 and restored per fresh-context re-audit).

8. **WHEN** migrating `~/.config/opencode/google-workspace/`, the system **SHALL** copy the directory recursively to `~/.config/foxybear/google-workspace/`. If a target exists, target wins.

9. **WHEN** migrating `~/.config/opencode/{package.json,bun.lock,node_modules}`, the system **SHALL** copy them to `~/.config/foxybear/` (the node project in the config dir; research notes its purpose needs verification — the migration copies faithfully and the purpose is investigated during implementation). If a target exists, target wins.

10. **WHEN** migrating SQLite DBs, the system **SHALL** copy every `~/.local/share/opencode/opencode*.db` (and `-wal`, `-shm` sidecars) to `~/.local/share/foxybear/fbh*.db` (renaming the prefix `opencode` → `fbh`): `opencode-dev.db` → `fbh-dev.db`, `opencode-feat-telegram-coordinator-overhaul.db` → `fbh-feat-telegram-coordinator-overhaul.db`, `opencode-feat-voice-tts-v2.db` → `fbh-feat-voice-tts-v2.db`, and any `opencode.db` → `fbh.db`. The system **SHALL** then run the DB migration step (`fbh db migrate` or the boot-time migration) against each copied file to bring its schema to the current version.

11. **WHEN** migrating `~/.local/share/opencode/auth.json`, the system **SHALL** copy it to `~/.local/share/foxybear/auth.json`. The system **SHALL NOT** log the file's contents (CC-Security). If a target exists, target wins.

12. **WHEN** migrating `~/.local/share/opencode/memory.surreal` and `memory-server/`, the system **SHALL** copy them to `~/.local/share/foxybear/`. The system **SHALL** verify the SurrealDB store does not embed absolute paths that break under the new location (research gap 3); if it does, the system **SHALL** run a path-rewrite step (or document the limitation and flag the user to re-index memory). The system **SHALL** copy `memory-migration-surreal.json` (the migration marker) AND `memory-backup-*.json` (memory backups — e.g. `memory-backup-1778057881365.json`) to the new path.

12b. **WHEN** migrating `~/.local/share/opencode/storage/` (the session-diff storage: `session_diff/` with 1000+ entries + `migration` marker), the system **SHALL** copy it to `~/.local/share/foxybear/storage/` (per plan line 388 — this was omitted from the original SDD-04 and restored per fresh-context re-audit). This is user session-diff data; losing it is the cardinal failure mode.

12c. **WHEN** migrating `~/.local/state/opencode/` (XDG state: `prompt-history.jsonl`, `kv.json`, `plugin-meta.json`, `model.json`, `locks/`), the system **SHALL** copy it to `~/.local/state/foxybear/` (per SC-1 line 103 — SC-1 names this path but SC-7/SDD-04 originally omitted it; restored per fresh-context re-audit). This is user state: prompt history, KV store (theme/sidebar/etc.), plugin metadata, model state. Losing it is the cardinal failure mode.

12d. **WHEN** migrating `~/.local/share/opencode/snapshot/` and `tool-output/`, the system **SHALL** skip both (git snapshots are regenerable from worktrees; tool-output is a regenerable cache). The system **SHALL** log the skip decision. If the implementation finds user-irreplaceable data in either during migration, it **SHALL** flag it for Todd rather than silently dropping.

13. **WHEN** migrating `~/.local/share/opencode/foxybear-serve.pid`, the system **SHALL** NOT copy it. The system **SHALL** warn if the PID file points to a live process (CC-Security) and **SHALL** create a fresh `fbh-serve.pid` only when the daemon next starts.

14. **WHEN** migrating `~/.local/share/opencode/log/` and `~/.cache/opencode/`, the system **SHALL** skip both (regenerated; cache version bump at `global/index.ts:37` will nuke the cache on first boot anyway).

15. **WHEN** migrating API keys (`~/Development/.{openai_api,anthropic,deepinfra}.key`), the system **SHALL NOT** touch, copy, move, or log them (CC-Security; they are not opencode-branded).

### Backward-compat reads (CC-3)

16. **WHEN** the rebranded binary loads project config, it **SHALL** read `.opencode/` project dirs if `.foxybear/` does not exist, with a deprecation warning to stderr: `Reading from .opencode/ is deprecated. Rename to .foxybear/. This fallback will be removed in fbh v2.0`. `.foxybear/` takes priority; if both exist, `.foxybear/` wins and `.opencode/` is ignored (no warning for the ignored one, but a one-time info log).

17. **WHEN** the rebranded binary loads XDG config, it **SHALL** read `opencode.json`/`opencode.jsonc`/`config.json` (legacy) in addition to `fbh.*`/`foxybear.*` per SC-4, with a deprecation warning per old file read: `Reading ~/.config/foxybear/opencode.json is deprecated. Rename to fbh.json. This fallback will be removed in fbh v2.0`. The legacy reads **SHALL** be logged once per file per process (not per access).

### First-run prompt (plan Phase A.5)

18. **WHEN** `fbh` boots and detects `~/.config/opencode/` or `~/.local/share/opencode/` exists but `~/.config/foxybear/` and `~/.local/share/foxybear/` do not (or are empty), the system **SHALL** prompt the user: `Found legacy opencode data at ~/.local/share/opencode/ and ~/.config/opencode/. Run 'fbh migrate' to move it to the new foxybear paths. Continue without migrating? [y/N]`. The system **SHALL** proceed if the user declines, but **SHALL** note that legacy data will not be visible at the new paths until migrated.

---

## HOW

- The SDD-04 implementation is a new CLI command `fbh migrate` in `packages/opencode/src/cli/cmd/migrate.ts` (and registered in the CLI command map), plus the backward-compat reads in `packages/opencode/src/config/config.ts` (already partially present per research) and `packages/opencode/src/session/instruction.ts`.
- **`fbh migrate`:** a `Bun.file`-based pipeline that walks the SC-7 inventory, applies the per-source strategy, and logs. Dry-run mode short-circuits before any write. Idempotency check: `Bun.file(target).exists()` and size > 0 → skip (or conflict-diff if differs).
- **Merge:** `loadConfig` (JSONC parser) reads source + target, merges with first-definition-wins, writes target. Token translation: a regex `\{env:OPENCODE_([A-Z_]+)\}` → `\{env:FBH_$1\}` and `\{file:.*OPENCODE_.*\}` handled case-by-case.
- **DB copy + migrate:** `fs.copyFile` for each `.db`/`.db-wal`/`.db-shm`; then boot the storage layer against the copied file to run migrations (the existing migration runner in `storage/db.ts`).
- **SurrealDB:** copy the files + memory-backup-*.json; verify absolute paths by grepping the surreal data file for `/opencode/`; if found, run a path rewrite or flag. This is the riskiest step — the VERIFY must cover it.
- **State dir + storage:** copy `~/.local/state/opencode/` → `~/.local/state/foxybear/` (prompt-history.jsonl, kv.json, plugin-meta.json, model.json, locks/); copy `~/.local/share/opencode/storage/` → `~/.local/share/foxybear/storage/` (session_diff/ + migration marker). Both are user data (re-audit found these orphaned from the original spec).
- **agent/mode/skill dirs:** merge `~/.config/opencode/{agent,mode,skill}/**` per plan lines 382/384/385 (original SDD-04 regressed; restored per re-audit).
- **Backward-compat reads:** edit `config.ts:1463` area (already dual-reads `.foxybear`/`.opencode`); add the deprecation warning when the `.opencode` path is taken. Add legacy XDG config reads (`opencode.json` etc.) with warnings — these may already be present (config.ts:1274-1278 reads `opencode.json`/`opencode.jsonc`); add the warning emission.
- **First-run prompt:** a boot-time check in the CLI entry (`packages/opencode/src/index.ts` or the CLI bootstrap) that detects the legacy/new path asymmetry and prompts via `@clack/prompts` (already a dependency).
- What is explicitly NOT built: no rebrand of code paths (SDD-03 done), no verification suite (SDD-05).

---

## VERIFY

Acceptance tests live at `test/fbh-rebrand/sdd-04.test.ts`. Real filesystem operations against a tmp HOME; no mocks of `fs`.

- **V1 — dry-run (req 1).** Setup: populate `tmp/.config/opencode/` and `tmp/.local/share/opencode/` with fixtures (council.json, opencode.json, personas/katya.md, opencode-dev.db, auth.json). Action: `fbh migrate --dry-run` with `HOME=tmp` and `FBH_TEST_HOME=tmp`. Expected: stdout lists every source → target → action; NO files created in `tmp/.config/foxybear/` or `tmp/.local/share/foxybear/`.
- **V2 — full migrate (reqs 2, 5–9).** Action: `fbh migrate` (no flag). Expected: `tmp/.config/foxybear/council.json` exists (copy); `tmp/.config/foxybear/fbh.json` (or merged target) contains merged config with `OPENCODE_*` tokens translated to `FBH_*`; `tmp/.config/foxybear/personas/katya.md` exists; old `tmp/.config/opencode/` still intact (CC-7 copy-not-move).
- **V3 — DB copy + migrate (req 10).** Action: run migrate. Expected: `tmp/.local/share/foxybear/fbh-dev.db` exists; open it with `bun:sqlite` and assert schema is current (run the migration check); `opencode-dev.db` source intact.
- **V4 — auth.json (req 11).** Action: run migrate. Expected: `tmp/.local/share/foxybear/auth.json` exists; migration log does NOT contain the file contents (grep log for a known token from the fixture — absent).
- **V5 — SurrealDB + backups (req 12).** Action: run migrate with a fixture `memory.surreal` containing `/opencode/` absolute paths + a `memory-backup-*.json` fixture. Expected: `tmp/.local/share/foxybear/memory.surreal` exists; if it contained `/opencode/` paths, assert they are rewritten to `/foxybear/` (or the limitation is logged with a user-visible warning); `memory-backup-*.json` copied.
- **V5b — state dir (req 12c, re-audit).** Setup: populate `tmp/.local/state/opencode/` with `prompt-history.jsonl`, `kv.json`, `plugin-meta.json`, `model.json`, `locks/`. Action: run migrate. Expected: `tmp/.local/state/foxybear/` contains all 5 files; source intact (copy-not-move).
- **V5c — storage dir (req 12b, re-audit).** Setup: populate `tmp/.local/share/opencode/storage/session_diff/` with 3 test entries + `storage/migration` marker. Action: run migrate. Expected: `tmp/.local/share/foxybear/storage/session_diff/` contains the 3 entries; `storage/migration` copied; source intact.
- **V5d — agent/mode/skill dirs (req 7, re-audit).** Setup: populate `tmp/.config/opencode/{agent,mode,skill}/` with test .md files. Action: run migrate. Expected: `tmp/.config/foxybear/{agent,mode,skill}/` contain the files (merged per plan lines 382/384/385).
- **V5e — snapshot/tool-output skipped (req 12d, re-audit).** Setup: populate `tmp/.local/share/opencode/snapshot/` + `tool-output/`. Action: run migrate. Expected: neither copied to `tmp/.local/share/foxybear/`; skip decision logged.
- **V6 — PID not copied (req 13).** Action: run migrate with a fixture `foxybear-serve.pid` pointing to the current PID (a live process). Expected: `fbh-serve.pid` NOT created in target; a warning printed naming the live PID.
- **V7 — logs/cache skipped (req 14).** Action: run migrate. Expected: `tmp/.local/share/foxybear/log/` does NOT exist (not copied); `tmp/.cache/foxybear/` does NOT exist (not copied).
- **V8 — API keys untouched (req 15).** Action: run migrate with fixture API key files in `tmp/Development/`. Expected: no file under `tmp/Development/` is read, copied, or logged. (Assert the migration log contains no `openai_api.key`/`anthropic.key`/`deepinfra.key` strings.)
- **V9 — idempotent (reqs 3–4, CC-2).** Action: run migrate twice. Expected: second run reports "already migrated" for every source; no overwrites. Action: modify a target file then re-run; expected: conflict logged, target preserved (not overwritten with older source).
- **V10 — backward-compat .opencode/ (req 16).** Setup: a project dir with `.opencode/` but no `.foxybear/`. Action: `fbh` boots and loads config. Expected: `.opencode/` read; deprecation warning to stderr naming the removal version. Setup: same project with both `.opencode/` and `.foxybear/`. Expected: `.foxybear/` read; `.opencode/` ignored.
- **V11 — backward-compat XDG config (req 17).** Setup: `tmp/.config/foxybear/opencode.json` (legacy, no `fbh.json`). Action: `fbh` boots. Expected: `opencode.json` read; deprecation warning once.
- **V12 — first-run prompt (req 18).** Setup: `tmp/.local/share/opencode/` exists, `tmp/.local/share/foxybear/` empty. Action: boot `fbh` non-interactively (pipe `n`). Expected: prompt printed; `fbh` proceeds; legacy data note logged. Action: pipe `y` with `fbh migrate` available; expected: migrate runs (or the prompt offers to run it).
- **V13 — no original data lost (CC-1).** Action: before/after migrate, checksum every source file. Expected: every source file's checksum unchanged (copy-not-move verified).
