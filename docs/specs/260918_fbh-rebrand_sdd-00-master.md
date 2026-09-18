# SDD-00 Master: FoxyBear Harness Fork & Rebrand (Phase A)

**Date:** 2026-09-18
**Project:** FoxyBear Harness (`development/opencode` → `development/foxybear`)
**Status:** Draft (pending independent audit + council + human gate)
**Source plan:** `docs/260916_foxybear_fork-rebrand-plan.md` (Phase A only)
**Research:** `docs/research/260918_fbh-rebrand_research.md`
**Workstream:** `fbh-rebrand` (`tools/sdd/workstreams/fbh-rebrand.json`)

This is the master spec for Phase A of the fork-and-rebrand: preserve Todd's in-flight work, rename the GitHub repo, rebrand every package and the core binary/env/paths, migrate existing user data, and verify the result. It defines the architecture, the cross-cutting requirements every feature spec inherits, the shared contract (identity map, keystone files, rename surface, verification, migration sources), and the dependency order. Where a feature spec conflicts with this master, the master wins. Where this master conflicts with the source plan, the research report's verified findings win and the plan is corrected.

Phase A does NOT rebase onto upstream `v2.0.7`. It brands the current `port/foxybear-v2` branch as-is. The rebase decision (plan Follow-On item 4) is a separate post-fork workstream.

## Architecture

### Problem being solved

The source plan describes a rebrand but was authored without verifying the live repo state. Research (`docs/research/260918_fbh-rebrand_research.md`) found six material corrections: the repo is already FoxyBear-owned (not an anomalyco rename), the working branch is `port/foxybear-v2` (not `dev`), the working tree is dirty with uncommitted customizations, 7 commits are unpushed, the "3 commits to re-apply" framing is stale (dozens of customizations exist), and the codebase already has partial foxybear branding that must be reconciled. The development pipeline — the numbered, implementation-sized WHEN/SHALL specs that code is written and tested against — did not exist. This suite is that pipeline for Phase A.

### Scope

In scope (Phase A only):

- **SDD-01 Preserve & Rename** — commit/stash dirty tree, push unpushed commits, tag pre-fork, `gh repo rename FoxyBear/opencode → FoxyBear/foxybear-harness`, rename local directory `development/opencode/` → `development/foxybear/`, update git remote.
- **SDD-02 Package Rebrand** — npm scope `@opencode-ai/*` → `@foxybear/*` across all kept packages, `createOpencodeClient` → `createFbhClient`, drop `desktop-electron`/`web`/`docs`/`identity`/`script` (merge script into core), `ghcr.io/anomalyco` → `ghcr.io/foxybear`, Tauri identifiers.
- **SDD-03 Core Deep Rebrand** — binary `opencode` → `fbh`, env `OPENCODE_*` → `FBH_*`, `Global.Path` app `"opencode"` → `"foxybear"`, schema URLs `opencode.ai` → `foxybear.ai` (conditional on domain ownership), system prompts, internal host consistency, DB filename `opencode.db` → `fbh.db`, brew tap.
- **SDD-04 Migration** — `fbh migrate` command with `--dry-run`, idempotent, merge-strategy per source; backward-compat read of `.opencode/` project dirs and `opencode.*` config files with deprecation warnings.
- **SDD-05 Verify & Cleanup** — build/typecheck/test green, `fbh --help`, config load from new paths, TUI launch, real LLM session, provider auth, memory DB at new path, plugins load, server, scheduler; update FoxyBearOffice doc paths.

Out of scope (tracked as fast-follows):

- Rebase onto upstream `v2.0.7` (separate workstream; plan Follow-On item 4).
- Phase M (MAGE-style memory overhaul), Phase S (recursive self-improvement), Phase C (competitive analysis), Phase T (Telegram remote session control), Phase Y (patch monitoring) — not tonight.
- Brew tap repo creation (`foxybear/homebrew-tap`) — code references it but the repo is created out-of-band (plan Follow-On item 2).
- `foxybear.ai` domain acquisition — Open Question 1; blocks schema URL rebrand only.

### Target shape

A renamed fork: same codebase, same git history, same `port/foxybear-v2` branch (becomes the new repo's working branch), with every `opencode`-branded identifier changed to `fbh`/`foxybear`, existing user data migrated to the new XDG paths, and the verification suite green end-to-end.

```
GitHub:  FoxyBear/opencode  ──rename──►  FoxyBear/foxybear-harness
Local:   development/opencode/  ──rename──►  development/foxybear/
Remote:  origin → https://github.com/FoxyBear/foxybear-harness.git
XDG:     ~/.local/share/opencode/  ──migrate──►  ~/.local/share/foxybear/
         ~/.config/opencode/      ──migrate──►  ~/.config/foxybear/
Binary:  ~/.bun/bin/opencode  ──re-link──►  ~/.bun/bin/fbh
```

### Key decisions (from research + plan)

- **No upstream rebase in Phase A.** `port/foxybear-v2` carries all customizations forward as-is. The rebase is a post-fork decision.
- **Same-owner GitHub rename, not a cross-org transfer.** `FoxyBear/opencode` → `FoxyBear/foxybear-harness` via `gh repo rename` (run from a clone). Redirects, stars, issues, CI all follow.
- **Config filename: `fbh.json` primary, `foxybear.json` + `opencode.json` backward-compat.** The code already reads `foxybear.json`; the rebrand adds `fbh.json` as the new primary and keeps the existing reads as deprecation-path backward compat.
- **`createOpencodeClient` → `createFbhClient` is a breaking SDK rename.** The SDK is `workspace:*` internal (no known external consumer). Flagged as a semver-major break; Open Question 2.
- **Partial foxybear branding is reconciled, not re-introduced.** The existing `"foxybear"` default username, `foxybear.internal` host, `.foxybear` dir read, and `foxybear.json` config read stay; the spec reconciles the inconsistent `opencode.internal` host in `run.ts:729`.
- **Verification uses the real binary.** SDD-05's smoke tests boot `fbh` from the rebuilt binary, not a mock.

## Cross-Cutting Requirements

These apply to all feature specs. Each is independently testable.

- **CC-1 No original text is lost.** WHEN any rename or migration operation completes, the system SHALL preserve every byte of Todd's committed work and every byte of uncommitted-in-flight work identified in research C-3. A pre/post checksum of the git tree (committed) and a stash-or-commit of the dirty tree SHALL prove nothing was dropped.
- **CC-2 Idempotent rename.** WHEN any rebrand step is re-run after success, the system SHALL be a no-op (or report "already done") and SHALL NOT corrupt state. Package scope rename, env var rename, path rename, and migration are all idempotent.
- **CC-3 Backward-compat reads with deprecation.** WHEN the rebranded binary loads config, it SHALL read `.opencode/` project dirs and `opencode.*`/`opencode.jsonc` XDG config files with a deprecation warning logged to stderr. `.foxybear/` dirs and `fbh.json`/`foxybear.json` take priority. The warning SHALL name the old path and the removal version (`fbh v2.0`).
- **CC-4 One source of truth per identifier.** WHEN the rebrand defines a new name, there SHALL be exactly one canonical location (keystone file) and all other references derive from it. The keystones are SC-1's identity map and SC-2's `Global.Path` definition.
- **CC-5 Green suite.** After each spec's implementation, `bun run typecheck` and the full `bun test` suite SHALL be green. A spec is not done if it leaves red tests. Known-baseline failures are tolerated via the workstream's `baselineFile`.
- **CC-6 Real verification, no mocks of our code.** SDD-05 acceptance tests boot the real `fbh` binary against real XDG paths in a tmp HOME, run a real LLM session against a real provider, and assert end-to-end behavior. No request mocking, no in-process substitution.
- **CC-7 Migration is opt-in and dry-runnable.** `fbh migrate --dry-run` SHALL report every action it WOULD take without taking it. `fbh migrate` (no flag) SHALL perform the migration, log every action, and be safe to re-run. Migration SHALL NOT delete the old paths (copy-then-verify; old paths remain until the user removes them).
- **CC-8 Schema URL conditionality.** IF Todd confirms `foxybear.ai` domain ownership, schema URLs SHALL rebrand to `foxybear.ai`. IF NOT confirmed, schema URLs SHALL self-host local schemas (bundled in the binary) and the `opencode.ai` URLs SHALL be removed only for the self-hostable subset (config/tui/theme schemas); docs links and API hosts that point to OpenCode's SaaS SHALL be removed or stubbed, not redirected to a domain FoxyBear doesn't own. Open Question 1.
- **CC-9 Partial-brand reconciliation.** The rebrand SHALL reconcile the inconsistent internal host (`opencode.internal` in `run.ts:729` → `foxybear.internal`) and SHALL NOT re-introduce the `"foxybear"` default username, `.foxybear` dir read, or `foxybear.json` config read that already exist.
- **CC-10 Drop packages are not imported.** After the drop, no kept package SHALL import `@opencode-ai/desktop-electron`, `@opencode-ai/web`, `@opencode-ai/docs`, `@opencode-ai/identity`, or `@opencode-ai/script` (script is merged into core, so core owns its function). A static assertion SHALL verify zero imports of dropped packages.

## Security

- **API keys are not opencode-branded.** The provider keys at `~/Development/.{openai_api,anthropic,deepinfra}.key` are unchanged by the rebrand. Migration SHALL NOT move, copy, or log these files.
- **`auth.json` is copied, not logged.** `~/.local/share/opencode/auth.json` (provider auth tokens) is copied to the new path during migration. Its contents SHALL NOT appear in migration logs or dry-run output.
- **Server username default stays `"foxybear"`.** Already set; no security regression. The `OPENCODE_SERVER_USERNAME` env var renames to `FBH_SERVER_USERNAME`; the default remains `"foxybear"`.
- **PID file rename is stale-safe.** `foxybear-serve.pid` → `fbh-serve.pid`. Migration SHALL NOT kill a running daemon based on a stale PID; it SHALL warn if the PID file points to a live process.
- **No secrets in spec artifacts.** Specs, tests, and audit reports SHALL NOT embed API keys, tokens, or `auth.json` contents. Test fixtures use dummy tokens only.
- **Schema URL downgrade is safe.** IF `foxybear.ai` is not owned, self-hosted schemas SHALL be bundled (no remote fetch of config schemas), eliminating a supply-chain vector the `opencode.ai` fetch introduced.

## Shared Contract

This section resolves every cross-spec seam. The master wins on any conflict. Feature specs reference these by `SC-N`.

### SC-1: Identity Map (the rebrand contract)

Owned by: master. Referenced by: all specs. This is the single source of truth for old → new names.

| Concept | Old | New | Keystone file |
|---|---|---|---|
| Binary name | `opencode` | `fbh` | `packages/opencode/package.json` `bin` field + `packages/opencode/bin/opencode` → `bin/fbh` |
| Env prefix | `OPENCODE_` | `FBH_` | `packages/opencode/src/flag/flag.ts:13` (Flag namespace) |
| npm scope | `@opencode-ai/*` | `@foxybear/*` | each package `package.json` `name` + workspace deps |
| Repo | `FoxyBear/opencode` | `FoxyBear/foxybear-harness` | GitHub (`gh repo rename`) |
| Local dir | `development/opencode/` | `development/foxybear/` | filesystem |
| Config dirs (project) | `.opencode/` | `.foxybear/` | `packages/opencode/src/config/config.ts:1463` (already dual-read) |
| XDG app name | `opencode` | `foxybear` | `packages/opencode/src/global/index.ts:7` (`const app`) |
| XDG data | `~/.local/share/opencode/` | `~/.local/share/foxybear/` | derives from SC-1 XDG app |
| XDG cache | `~/.cache/opencode/` | `~/.cache/foxybear/` | derives |
| XDG config | `~/.config/opencode/` | `~/.config/foxybear/` | derives |
| XDG state | `~/.local/state/opencode/` | `~/.local/state/foxybear/` | derives |
| Config file (primary) | `opencode.json`/`.jsonc` | `fbh.json`/`.jsonc` | `config.ts:1274-1278` (add `fbh.*`; keep `opencode.*` + `foxybear.*` as backward-compat) |
| DB filename | `opencode.db` / `opencode-<channel>.db` | `fbh.db` / `fbh-<channel>.db` | `packages/opencode/src/storage/db.ts:33,35` + `index.ts:112` |
| PID file | `foxybear-serve.pid` | `fbh-serve.pid` | `packages/opencode/src/daemon/pid.ts` |
| Schema URLs | `https://opencode.ai/{config,tui,theme}.json` | `https://foxybear.ai/...` (if owned) or local bundle | `config.ts`, `tui-migrate.ts`, `theme/*.json` |
| Internal host | `opencode.internal` (run.ts:729) | `foxybear.internal` (reconcile to existing) | `cli/cmd/run.ts:729` |
| Server username default | `"foxybear"` (already) | `"foxybear"` (unchanged) | middleware.ts:45, worker.ts:113, run.ts:716 |
| Brew tap | `anomalyco/tap/opencode` | `foxybear/tap/fbh` | install script (out-of-band repo creation) |
| Container registry | `ghcr.io/anomalyco` | `ghcr.io/foxybear` | `packages/containers/**` (8 files) |
| SDK client factory | `createOpencodeClient` | `createFbhClient` | `packages/sdk/js/src/v2/client.ts:46` + re-export `packages/plugin/src/index.ts:3` |
| Test home env | `OPENCODE_TEST_HOME` | `FBH_TEST_HOME` | `global/index.ts:18` |
| User agent | `opencode/<channel>/<version>` | `fbh/<channel>/<version>` | `session/llm.ts` `x-opencode-client` header |
| Managed config dir (macOS) | `/Library/Application Support/opencode` | `/Library/Application Support/foxybear` | `config/config.ts:64` |
| Managed config dir (Linux) | `/etc/opencode` | `/etc/foxybear` | `config/config.ts:68` |
| Managed config env | `OPENCODE_TEST_MANAGED_CONFIG_DIR` | `FBH_TEST_MANAGED_CONFIG_DIR` | `config/config.ts:73` |
| MDM plist domain | `ai.opencode.managed` | `ai.foxybear.managed` | `config/config.ts:78` |
| Well-known endpoint | `.well-known/opencode` | `.well-known/fbh` | `config/config.ts:1416,1417,1424`, `cli/cmd/providers.ts:302` (runtime-fetched) |
| Provider "opencode" (SaaS) | `opencode` provider (Zen/Go/share, `api.opencode.ai`, `OPENCODE_API_KEY`) | TBD (Open Question 6) | `provider/provider.ts:191,426,436,534,803,901,1702`, `models-snapshot.js` |
| Tauri config (desktop) | `packages/desktop/src-tauri/{tauri.conf,tauri.beta.conf,tauri.prod.conf}.json` | foxybear/fbh identifiers | SDD-02 (all 3 conf files + `Cargo.toml` + `entitlements.plist`) |

### SC-2: Global.Path keystone

Owned by: SDD-03. Referenced by: all specs.

```typescript
// packages/opencode/src/global/index.ts:7
const app = "opencode"  // → "foxybear"
```

This single line sets `data`, `cache`, `config`, `state`, `bin` (= `cache/bin`), `log` (= `data/log`). SDD-03 changes it; SDD-04 migrates existing data to the resulting paths. The `OPENCODE_TEST_HOME` env var at line 18 renames to `FBH_TEST_HOME` in the same edit.

### SC-3: Flag namespace (env var surface)

Owned by: SDD-03. Referenced by: all specs.

```typescript
// packages/opencode/src/flag/flag.ts:13
export namespace Flag { /* OPENCODE_* members → FBH_* */ }
```

The `OPENCODE_*` env vars (research §Stage 3; fresh-context re-audit found ~71 distinct in `packages/opencode/src`, ~54 in the Flag namespace at `flag/flag.ts`) rename to `FBH_*` in the Flag namespace. Direct `process.env.OPENCODE_*` reads outside Flag (config.ts, share-next.ts, pty/index.ts, thread.ts, worker-persona-hook.ts, run.ts) rename in the same pass. The complete list is NOT normative in this spec — SDD-03 req 5's grep is the normative complete-set source (the list in SDD-03 req 3 is illustrative; the grep catches any var the list misses).

### SC-4: Config file name resolution

Owned by: SDD-03. Referenced by: SDD-04.

```typescript
// packages/opencode/src/config/config.ts:1274-1278 (today)
// reads: config.json, opencode.json, opencode.jsonc, foxybear.json, foxybear.jsonc
// SDD-03 adds: fbh.json, fbh.jsonc (primary)
// SDD-03 keeps: foxybear.json, foxybear.jsonc (backward-compat, no warning — already foxybear)
// SDD-03 keeps: opencode.json, opencode.jsonc (backward-compat, DEPRECATION WARNING per CC-3)
// SDD-03 keeps: config.json (legacy, DEPRECATION WARNING)
```

Priority order (highest first): `fbh.jsonc`, `fbh.json`, `foxybear.jsonc`, `foxybear.json`, `opencode.jsonc`, `opencode.json`, `config.json`. Later merges do not override earlier keys on collision; the first file to define a key wins (mergeDeep semantics preserved).

### SC-5: Package scope map

Owned by: SDD-02. Referenced by: SDD-02, SDD-05.

| Package | Action | Scope rename | `createOpencodeClient` | Drop? |
|---|---|---|---|---|
| `opencode` (core) | Rebrand + rename dir to `fbh` | `@opencode-ai/*` deps → `@foxybear/*` | update call sites | keep |
| `sdk/js` | Rebrand | `@opencode-ai/sdk` → `@foxybear/sdk` | rename export `createFbhClient` | keep |
| `plugin` | Rebrand | `@opencode-ai/plugin` → `@foxybear/plugin` | re-export `createFbhClient` | keep |
| `util` | Rebrand | `@opencode-ai/util` → `@foxybear/util` | — | keep |
| `ui` | Rebrand | `@opencode-ai/ui` → `@foxybear/ui` | — | keep |
| `app` | Rebrand | `@opencode-ai/app` → `@foxybear/app` | — | keep |
| `desktop` | Rebrand + Tauri ids | `@opencode-ai/desktop` → `@foxybear/desktop` | — | keep |
| `storybook` | Rebrand | `@opencode-ai/storybook` → `@foxybear/storybook` | — | keep |
| `slack` | Rebrand | `@opencode-ai/slack` → `@foxybear/slack` | — | keep |
| `extensions` | Rebrand | binary URL + name | — | keep |
| `script` | Merge into core | `@opencode-ai/script` → `@foxybear/script` (or inline) | — | merge |
| `containers` | Rebrand registry | `ghcr.io/anomalyco` → `ghcr.io/foxybear` | — | keep |
| `console/*` (5) | Reference only (don't ship) | scope rename for consistency | — | reference |
| `enterprise` | Reference only | scope rename | — | reference |
| `function` | Reference only | scope rename | — | reference |
| `desktop-electron` | DROP | — | — | drop |
| `web` | DROP | — | — | drop |
| `docs` | DROP | — | — | drop |
| `identity` | DROP | — | — | drop |

Rename order (leaf packages first to keep workspace resolution valid at every step): `util` → `sdk/js` → `plugin` → `script` → `ui` → `storybook` → `app` → `slack` → `desktop` → `extensions` → `containers` → `console/*` → `enterprise` → `function` → core `opencode` (last, depends on all). Drops happen after scope renames are green to avoid breaking intermediate imports.

### SC-6: Verification commands

Owned by: master. Referenced by: SDD-05.

```
typecheck:  cd packages/opencode && bun run typecheck      # tsgo --noEmit
test:       cd packages/opencode && bun test --timeout 30000
build:      cd packages/opencode && bun run script/build.ts
root typecheck: bun turbo typecheck
smoke:      fbh --help  &&  fbh (TUI launch)  &&  fbh serve (server + WS)  &&  real LLM session
```

### SC-7: Migration sources & merge strategy

Owned by: SDD-04. Referenced by: SDD-04, SDD-05. See research §Phase A.5 for the full inventory table. **The inventory below is normative and exhaustive as of the fresh-context re-audit (2026-09-18); SDD-04 SHALL migrate every source listed.** Merge rules: JSON files merge (later files do not override earlier keys; first-definition wins); `*.md` dirs merge (new wins on name collision); single files copy; SQLite DBs copy then run migrations; `auth.json` copies; logs and cache skip (regenerated); API keys untouched.

| Source | Target | Strategy |
|---|---|---|
| `~/.config/opencode/*.json(c)` (fbh/foxybear/opencode/config) | `~/.config/foxybear/*.json(c)` | Merge per SC-4 priority; translate `{env:OPENCODE_*}` tokens → `{env:FBH_*}` |
| `~/.config/opencode/council.json` | `~/.config/foxybear/council.json` | Copy (single file; target wins on conflict) |
| `~/.config/opencode/package.json`, `bun.lock`, `package-lock.json`, `node_modules` | `~/.config/foxybear/...` | Copy (node project in config dir) |
| `~/.config/opencode/personas/*.md` | `~/.config/foxybear/personas/*.md` | Merge (new wins on collision) |
| `~/.config/opencode/commands/**/*.md` | `~/.config/foxybear/commands/**/*.md` | Merge (preserve nested dirs) |
| `~/.config/opencode/agent/**/*.md` | `~/.config/foxybear/agent/**/*.md` | Merge (per plan line 382) |
| `~/.config/opencode/mode/**/*.md` | `~/.config/foxybear/mode/**/*.md` | Merge (per plan line 384) |
| `~/.config/opencode/skill/**` | `~/.config/foxybear/skill/**` | Merge (per plan line 385) |
| `~/.config/opencode/google-workspace/` | `~/.config/foxybear/google-workspace/` | Copy (target wins on conflict) |
| `~/.local/share/opencode/opencode*.db` + `-wal` + `-shm` | `~/.local/share/foxybear/fbh*.db` | Copy (rename prefix) + run migrations |
| `~/.local/share/opencode/auth.json` | `~/.local/share/foxybear/auth.json` | Copy (never log contents) |
| `~/.local/share/opencode/storage/` (session_diff/ + migration marker) | `~/.local/share/foxybear/storage/` | Copy (per plan line 388; 1083+ session diffs — user data) |
| `~/.local/share/opencode/memory.surreal` + `memory-server/` | `~/.local/share/foxybear/...` | Copy (path-rewrite if `/opencode/` embedded) |
| `~/.local/share/opencode/memory-migration-surreal.json` | `~/.local/share/foxybear/...` | Copy (migration marker) |
| `~/.local/share/opencode/memory-backup-*.json` | `~/.local/share/foxybear/...` | Copy (memory backups) |
| `~/.local/share/opencode/snapshot/` | — | Skip (git snapshots, regenerable from worktrees) |
| `~/.local/share/opencode/tool-output/` | — | Skip (tool output cache, regenerable) |
| `~/.local/share/opencode/plans/`, `repos/` | — | Skip (empty on this machine; verify during implementation) |
| `~/.local/share/opencode/foxybear-serve.pid` | — | Skip (stale PID; fresh `fbh-serve.pid` created on next daemon start; warn if PID live) |
| `~/.local/share/opencode/log/` | — | Skip (regenerated) |
| `~/.cache/opencode/` | — | Skip (regenerated; cache version bump nukes on first boot) |
| `~/.local/state/opencode/` (prompt-history.jsonl, kv.json, plugin-meta.json, model.json, locks/) | `~/.local/state/foxybear/` | Copy (user state: prompt history, KV store, plugin metadata, model state, locks) |
| API keys `~/Development/.{openai_api,anthropic,deepinfra}.key` | — | Untouched (not opencode-branded) |

**Exhaustiveness note:** The fresh-context re-audit (2026-09-18) enumerated the actual filesystem locations on the target machine and reconciled against this table. No orphaned sources remain. If implementation discovers a new opencode state location not listed here, SDD-04 SHALL be amended before that location is migrated.

## Dependency Order

Strictly sequential; each spec's acceptance suite depends on the prior spec's implementation.

1. **SDD-01 Preserve & Rename** — git hygiene + GitHub rename + local dir rename + remote update. No code rebrand; preserves the work to be rebranded. Depends on nothing.
2. **SDD-02 Package Rebrand** — scope rename + SDK rename + drops + registry + Tauri. Depends on SDD-01 (the repo is renamed and the local dir is `development/foxybear/`).
3. **SDD-03 Core Deep Rebrand** — binary + env + XDG keystone + schema URLs + prompts + DB filename + internal host. Depends on SDD-02 (workspace resolution uses new scope).
4. **SDD-04 Migration** — `fbh migrate` + backward-compat reads + data inventory. Depends on SDD-03 (migration targets the new paths SDD-03 defines).
5. **SDD-05 Verify & Cleanup** — full verification + FoxyBearOffice doc paths. Depends on all; verifies the whole.

**Tracked fast-follow tickets** (not tonight):

| Ticket | Description | Trigger |
|---|---|---|
| FBH-FF-001 | Rebase onto upstream `v2.0.7` and re-apply customizations | Phase A verified; Todd decides |
| FBH-FF-002 | Brew tap repo `foxybear/homebrew-tap` creation + install script | Phase A verified |
| FBH-FF-003 | `foxybear.ai` domain acquisition + schema URL flip (if not owned pre-gate) | Todd confirms domain status |
| FBH-FF-004 | Phase Y patch-monitor sprint (scheduler + upstream diff) | Phase A verified |
| FBH-FF-005 | Phase M (MAGE memory), Phase S (self-improvement), Phase C (competitive), Phase T (Telegram remote) | separate workstreams |
| FBH-FF-006 | Final license decision for Foxy Bear Inc. modifications (proprietary vs BSD-3 vs MIT vs Apache) | Publish/distribution time (after OQ9 flips to publish); deferred per OQ7 interim |

## Glossary

- **Rebrand.** Changing every `opencode`-branded identifier to `fbh`/`foxybear` per SC-1, without changing behavior.
- **Fork.** The GitHub repo `FoxyBear/opencode`, already independent of `anomalyco/opencode` (which is `upstream`). Phase A renames it, it does not create a new fork.
- **Keystone.** The single canonical source for an identifier (SC-1 names the keystone file per row).
- **Backward-compat read.** The rebranded binary reads old paths/filenames with a deprecation warning (CC-3), so users with existing `opencode` data are not broken on first launch.
- **Migration.** `fbh migrate` — the command that copies existing XDG data to the new paths (SC-7). Opt-in, dry-runnable, idempotent (CC-7).
- **Dirty tree.** The 14 modified + 5 untracked files on `port/foxybear-v2` identified in research C-3. SDD-01 commits or stashes these before tagging.

## Open Questions (Gate Decisions)

**RESOLVED by Todd (2026-09-18 morning gate review):**

1. **`foxybear.ai` domain ownership — RESOLVED: YES, Todd owns it.** Schema URLs rebrand to `https://foxybear.ai/...`. SDD-03 OQ1=YES branch applies (req 8). No self-host bundle needed. Docs links, API hosts, OAuth client URI, provider referer all go to `foxybear.ai` where applicable. The `opencode.ai` SaaS hosts (`api.opencode.ai`, `app.opencode.ai`) are removed per OQ6 (the opencode provider is removed entirely).
2. **`createOpencodeClient` → `createFbhClient` breaking rename — RESOLVED: clean break, no shim.** (Todd, 2026-09-18.) The SDK is internal (`workspace:*`); rename the export and update the ~10 in-repo call sites. No deprecation shim.
3. **Dirty tree disposition — RESOLVED: commit as one "pre-fork: in-flight customizations" commit.** (Todd, 2026-09-18.) The 15 modified + 12 untracked files (council fault-tolerance, context/compaction graduated thresholds, TUI dialog-context, tests) are committed as a single commit on `port/foxybear-v2` before the pre-fork tag.
4. **Branch disposition — RESOLVED: rename `port/foxybear-v2` → `main`.**
5. **Console/enterprise/function packages — RESOLVED: keep dormant** (rename scope for consistency, don't delete).
6. **Opencode SaaS provider — RESOLVED: REMOVE.** Delete the `opencode` provider from `models-snapshot.js`, remove `ProviderID.opencode` and the `providerID.startsWith("opencode")` branch, remove the Zen/Go UI surfaces, remove the share feature's dependence on `api.opencode.ai`, remove the GitHub app integration's `api.opencode.ai` calls, remove the `installation/index.ts:148` fetch to `opencode.ai/install`, and remove the `.well-known/opencode` fetch. The `OPENCODE_API_KEY` env var is removed with the provider.
7. **License & attribution — DEFERRED (interim default).** `development/opencode/LICENSE` is MIT, "Copyright (c) 2025 opencode". Per Todd (2026-09-18): the final license choice (proprietary vs BSD-3 vs MIT vs Apache for the Foxy Bear Inc. modifications) is deferred to publish/distribution time. Rationale: OQ9 = keep internal (no publish in Phase A), and substantial rebranding will change much of the codebase, so the "what's opencode-authored vs Foxy Bear-authored" question may resolve itself through the work. **Interim (legally-safe minimum):** preserve the MIT block on opencode-authored portions (legally required — cannot strip), add `Copyright (c) 2026 Foxy Bear Inc.` as a second copyright line. SDD-01 req 12b applies this interim. The final license decision is tracked as fast-follow FBH-FF-006 (decide at publish time, after the rebrand settles the authorship split).
8. **(merged into OQ6 above)**
9. **Distribution surface — RESOLVED: keep internal for now** (workspace-only, no npm publish in Phase A; the `@foxybear/*` scope rename is for code consistency, not public publishing). Brew tap, Docker, GitHub releases deferred until Todd directs.

**All 8 OQs resolved or deferred by Todd (2026-09-18 morning gate review).** No pending questions.

## Process honesty note

The subagent fan-out for parallel research stalled twice (empty task results, tool aborted). Per the caliper overnight lesson (memory: "subagent task infra stalled repeatedly overnight"), research was executed directly by the authoring agent, not by independent fresh-context subagents. This compromises the "independent auditor" guarantee the SDD process relies on. Mitigation: the adversarial audit and council stages lean harder than usual, and the compromise is disclosed here so Todd can factor it into the gate decision. The audit stage will still run (self-audited, disclosed), and council will deliberate the spec suite as the independent check.
