# FoxyBear Harness Configuration Reference

This document lists every configuration file, its location, and what the harness reads it for. It describes the post-rebrand state (no migration, no backward-compat) — only `foxybear`/`fbh` paths.

## XDG base paths

All paths derive from a single keystone: `const app = "foxybear"` in `src/global/index.ts`. The harness creates these directories on boot.

| Path | Location | What lives here |
|---|---|---|
| `Global.Path.config` | `~/.config/foxybear/` | User config files (fbh.json, council.json, personas/, commands/, agents/, modes/, skills/, themes/) |
| `Global.Path.data` | `~/.local/share/foxybear/` | Auth tokens, SQLite DBs, SurrealDB memory, session diffs, daemon PID |
| `Global.Path.state` | `~/.local/state/foxybear/` | Prompt history, KV store, plugin metadata, model state, locks |
| `Global.Path.cache` | `~/.cache/foxybear/` | Downloaded binaries, models cache, version marker (auto-nuked on version bump) |
| `Global.Path.bin` | `~/.cache/foxybear/bin/` | Cached downloaded binaries |
| `Global.Path.log` | `~/.local/share/foxybear/log/` | Daemon + server logs (regenerated) |
| `Global.Path.home` | `$HOME` (or `FBH_TEST_HOME`) | Used for project-dir upward scans |

## Global config files

Loaded by `loadGlobal()` in `src/config/config.ts`. Read in order, merged with first-definition-wins on key collision.

| File | Purpose |
|---|---|
| `~/.config/foxybear/fbh.json` | **Canonical user config.** Provider keys, model, agent defaults, MCP servers, permissions, persona, server settings, memory, mesh, telegram, voice, atlassian — everything in one file. |
| `~/.config/foxybear/fbh.jsonc` | JSONC variant (comments allowed). Same content as `fbh.json`. |
| `~/.config/foxybear/config.json` | Oldest legacy naming. Same schema. |

Merge priority (highest first): `fbh.jsonc` > `fbh.json` > `config.json`. A key defined in a higher-priority file is not overridden by a lower-priority file.

The `$schema` field in any config file should be `https://foxybear.ai/config.json`.

**Note:** `foxybear.json`/`foxybear.jsonc` are legacy filenames from the partial-rebrand era. They are still read (for backward-compat with pre-migrate state) but should be consolidated into `fbh.json`. The `fbh migrate` command consolidates them automatically.

## Managed config (enterprise / MDM)

Admin-controlled, highest priority — overrides all user and project settings.

| Platform | Path | Source |
|---|---|---|
| macOS | `/Library/Application Support/foxybear/` | filesystem |
| Linux | `/etc/foxybear/` | filesystem |
| Windows | `C:\ProgramData\opencode\` (TODO: rename to `foxybear`) | filesystem |
| macOS MDM plist | `ai.foxybear.managed` domain | `defaults` / plist |

Override path: `FBH_TEST_MANAGED_CONFIG_DIR` env var (test isolation).

## Project config files

Found by walking up from the project directory to the worktree root. Disabled with `FBH_DISABLE_PROJECT_CONFIG=1`.

| File pattern | Found by | Purpose |
|---|---|---|
| `opencode.json` / `opencode.jsonc` | `ConfigPaths.projectFiles("opencode", dir, worktree)` | Project-local config (legacy filename — still found) |
| `foxybear.json` / `foxybear.jsonc` | (same walk, found per-dir below) | Project-local config (new filename) |

The walk uses `Filesystem.findUp` with `rootFirst: true` — the project root is checked first.

## Per-directory config (inside `.foxybear/`)

When the config loader encounters a `.foxybear/` (or `FBH_CONFIG_DIR`) directory, it reads these files from inside it:

| File | Purpose |
|---|---|
| `.foxybear/foxybear.json` | Project config |
| `.foxybear/foxybear.jsonc` | Project config (JSONC) |
| `.foxybear/opencode.json` | Project config (legacy filename) |
| `.foxybear/opencode.jsonc` | Project config (legacy filename, JSONC) |

The directory walk (`ConfigPaths.directories`) looks for `.foxybear/` dirs from the project up to the worktree root, and also at `$HOME/.foxybear/` (global project-style config).

## TUI config

Optional. If no `tui.json` exists anywhere, the TUI uses built-in defaults. The harness looks for it (and merges in order) in:

| Location | Purpose |
|---|---|
| `~/.config/foxybear/tui.json(c)` | Global TUI overrides (keybindings, theme, sidebar state) |
| `<project>/tui.json(c)` (walked up to worktree root) | Project-local TUI overrides |
| `.foxybear/tui.json(c)` (project config dir) | Project-local TUI overrides |
| `$FBH_TUI_CONFIG` (env var) | Custom path to a single TUI config file |
| Managed config dir (`/Library/Application Support/foxybear/tui.json`) | Enterprise/MDM overrides (highest priority) |

Schema: `https://foxybear.ai/tui.json`. The TUI migrator (`src/config/tui-migrate.ts`) auto-moves legacy `tui` keys found in `fbh.json` into a dedicated `tui.json` per-directory (skips where `tui.json` already exists).

What it contains: keybindings, theme reference, sidebar state, display options. All optional — the TUI works fine without it.

## Themes

| File | Location | Purpose |
|---|---|---|
| `~/.config/foxybear/themes/*.json` | global | User-defined TUI themes |
| `.foxybear/themes/*.json` | project | Project-local themes |
| `packages/fbh/src/cli/cmd/tui/context/theme/*.json` | built-in | Bundled themes (ayu, catppuccin, dracula, etc.) |

Schema: `https://foxybear.ai/theme.json`. Each theme file defines colors, styles, and UI element styling.

## Council config

| File | Location | Purpose |
|---|---|---|
| `~/.config/foxybear/council.json` | global | Multi-model council deliberation config: provider models, arbitrator, max rounds, threshold, research toggle |

Loaded by the council harness (`src/harness/council/`). Not part of the standard config merge — read directly by the council subsystem.

## Personas

| Location | Pattern | Purpose |
|---|---|---|
| `~/.config/foxybear/personas/*.md` | global | User-defined personas (e.g., `katya.md`) |
| `.foxybear/personas/*.md` | project | Project-local personas |

Each `.md` file has YAML frontmatter (name, model, tools, permission) + markdown body (system prompt). Resolved by `src/persona/index.ts` — scans `Global.Path.config/personas/` + `ConfigPaths.directories()/personas/` for `<name>.md`.

## Commands

| Location | Pattern | Purpose |
|---|---|---|
| `~/.config/foxybear/commands/**/*.md` | global | User-defined slash commands |
| `.foxybear/commands/**/*.md` | project | Project-local commands |

Glob: `{command,commands}/**/*.md`. Loaded by `loadCommand()` in `src/config/config.ts`. Each `.md` file has frontmatter + template body. Slash commands appear in the TUI's `/` menu.

## Agents

| Location | Pattern | Purpose |
|---|---|---|
| `~/.config/foxybear/agents/**/*.md` | global | User-defined agents |
| `.foxybear/agents/**/*.md` | project | Project-local agents |

Glob: `{agent,agents}/**/*.md`. Loaded by `loadAgent()`. Each `.md` defines an agent (name, description, mode: subagent/primary/all, model, tools, prompt).

## Modes

| Location | Pattern | Purpose |
|---|---|---|
| `~/.config/foxybear/modes/*.md` | global | User-defined modes |
| `.foxybear/modes/*.md` | project | Project-local modes |

Glob: `{mode,modes}/*.md`. Loaded by `loadMode()`. Modes are agent presets applied to the primary agent.

## Skills

| Location | Scope | Pattern | Purpose |
|---|---|---|---|
| `~/.claude/skills/**/SKILL.md` | global (external) | `skills/**/SKILL.md` | Claude-format skills |
| `~/.agents/skills/**/SKILL.md` | global (external) | `skills/**/SKILL.md` | Agents-format skills |
| `<project>/.claude/skills/**/SKILL.md` | project (external) | `skills/**/SKILL.md` | Project Claude skills |
| `<project>/.agents/skills/**/SKILL.md` | project (external) | `skills/**/SKILL.md` | Project agents skills |
| `~/.config/foxybear/skills/**/SKILL.md` | global (native) | `skills/**/SKILL.md` | FoxyBear native skills |
| `.foxybear/skills/**/SKILL.md` | project (native) | `skills/**/SKILL.md` | Project native skills |

External skills (`~/.claude`, `~/.agents`) are scanned only if `FBH_DISABLE_EXTERNAL_SKILLS` is not set. Native skills live under the foxybear config dir.

## Plugins

| Location | Purpose |
|---|---|
| `<config-dir>/node_modules/@foxybear/plugin/` | Plugin SDK (installed per config dir) |
| `<config-dir>/plugins/**/*.ts` | User-defined plugins (event hooks, tools) |

Plugin discovery runs per config directory. The loader checks for `node_modules/@foxybear/plugin/package.json` to confirm the SDK is installed, then scans for `.ts` plugin files.

## Data files

| File | Location | Purpose |
|---|---|---|
| `auth.json` | `~/.local/share/foxybear/auth.json` | Provider auth tokens (OpenAI, Anthropic, etc.). Never logged. |
| `fbh.db` | `~/.local/share/foxybear/fbh.db` | Primary SQLite DB (latest channel) — sessions, messages, snapshots |
| `fbh-<channel>.db` | `~/.local/share/foxybear/fbh-dev.db` | Channel-specific DB (dev, beta, feat-*) |
| `fbh-serve.pid` | `~/.local/share/foxybear/fbh-serve.pid` | Daemon PID + port (JSON: `{pid, timestamp, port}`) |
| `memory.surreal/` | `~/.local/share/foxybear/memory.surreal/` | SurrealDB embedded store (graph memory) |
| `memory-server/` | `~/.local/share/foxybear/memory-server/` | SurrealDB server-mode store |
| `memory-backup-*.json` | `~/.local/share/foxybear/` | Memory graph backups |
| `memory-migration-surreal.json` | `~/.local/share/foxybear/` | Migration marker |
| `storage/session_diff/` | `~/.local/share/foxybear/storage/` | Session diff history (1000+ entries) |
| `storage/migration` | `~/.local/share/foxybear/storage/` | Storage migration marker |

DB path override: `FBH_DB=/path/to/custom.db`.

## State files

| File | Location | Purpose |
|---|---|---|
| `prompt-history.jsonl` | `~/.local/state/foxybear/` | Prompt history (up/down arrow recall) |
| `kv.json` | `~/.local/state/foxybear/` | Key-value store (theme, sidebar state, toggles) |
| `plugin-meta.json` | `~/.local/state/foxybear/` | Plugin load metadata |
| `model.json` | `~/.local/state/foxybear/` | Last-used model state |
| `locks/` | `~/.local/state/foxybear/locks/` | File locks (session, DB, etc.) |

## Cache files

| File | Location | Purpose |
|---|---|---|
| `version` | `~/.cache/foxybear/version` | Cache version marker (current: `21`). Mismatch nukes the cache. |
| `bin/` | `~/.cache/foxybear/bin/` | Downloaded binaries (LSP servers, ripgrep, etc.) |
| `models.json` | `~/.cache/foxybear/models.json` | Cached model catalog |
| `packages/` | `~/.cache/foxybear/packages/` | Cached package downloads |

Cache is regenerated; safe to delete. Version bump auto-clears it.

## Key env var overrides

All env vars use the `FBH_` prefix (renamed from `OPENCODE_`). The Flag namespace (`src/flag/flag.ts`) centralizes these.

| Env var | Purpose |
|---|---|
| `FBH_CONFIG` | Path to a single config file (overrides all file-based config) |
| `FBH_CONFIG_DIR` | Path to a config directory (added to the directory scan) |
| `FBH_CONFIG_CONTENT` | Inline config content (JSON string) |
| `FBH_DISABLE_PROJECT_CONFIG` | If set, skip project `.foxybear/` walk |
| `FBH_TEST_HOME` | Override `$HOME` (test isolation) |
| `FBH_TEST_MANAGED_CONFIG_DIR` | Override managed config dir (test isolation) |
| `FBH_DB` | Custom DB path |
| `FBH_SERVER_USERNAME` / `FBH_SERVER_PASSWORD` | Server auth credentials |
| `FBH_PERSONA` | Default persona name |
| `FBH_DISABLE_EXTERNAL_SKILLS` | Skip `~/.claude` / `~/.agents` skill scan |
| `FBH_DISABLE_DEFAULT_PLUGINS` | Skip built-in plugin loading |
| `FBH_MODELS_URL` | Custom models.dev endpoint (build-time snapshot fetch) |
| `FBH_BIN_PATH` | Override the binary the `fbh` shim launches |

## Config merge precedence

Highest to lowest:

1. `FBH_CONFIG_CONTENT` (inline env)
2. `FBH_CONFIG` (single file env)
3. Managed config (`/Library/Application Support/foxybear/` or `/etc/foxybear/`)
4. `FBH_CONFIG_DIR` (env-specified dir)
5. Project `.foxybear/foxybear.json(c)` (walking up from project dir)
6. `opencode.json(c)` found by `projectFiles` walk
7. `$HOME/.foxybear/foxybear.json(c)`
8. `~/.config/foxybear/fbh.jsonc` > `fbh.json` > `config.json`
9. Built-in defaults

Within each level, `mergeDeep` applies first-definition-wins on key collision.

## Schema URLs

| Schema | URL |
|---|---|
| Config | `https://foxybear.ai/config.json` |
| TUI | `https://foxybear.ai/tui.json` |
| Theme | `https://foxybear.ai/theme.json` |

These are fetched by editors (VS Code, Zed) for autocomplete + validation. The harness itself does not fetch them at runtime.
