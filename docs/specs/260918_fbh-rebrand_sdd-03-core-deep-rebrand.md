# SDD-03: Core Deep Rebrand (Stage 3)

**Date:** 2026-09-18
**Project:** FoxyBear Harness
**Status:** Draft (pending audit + council + human gate)
**Master:** `260918_fbh-rebrand_sdd-00-master.md`
**Depends on:** SDD-02 (workspace resolution uses `@foxybear/*` scope).
**Owns:** SC-2 (Global.Path keystone), SC-3 (Flag namespace), SC-4 (config file resolution).

Implements Phase A Stage 3: the core package's deep rebrand — binary name, env var prefix, XDG app name, schema URLs, system prompts, internal host consistency, DB filename, and brew tap reference. This is the keystone spec: SC-2's one-line change drives every XDG path, and SC-3's Flag namespace rename touches ~35 env vars.

## Background

Research §Stage 3 found: the XDG keystone at `packages/opencode/src/global/index.ts:7` (`const app = "opencode"`), the Flag namespace at `packages/opencode/src/flag/flag.ts:13` centralizing ~35 `OPENCODE_*` env vars, 246 `OPENCODE_` grep matches in `src`, 64 `opencode.ai` URL references (config schemas, docs links, API hosts, OAuth client URI, provider referer, system prompts), the DB filename at `packages/opencode/src/storage/db.ts:33,35` + `index.ts:112`, and an inconsistent internal host (`opencode.internal` at `run.ts:729` vs `foxybear.internal` elsewhere). The codebase already has partial foxybear branding (default username, `.foxybear` dir read, `foxybear.json` config read) that this spec reconciles per CC-9.

---

## WHAT

### XDG keystone (SC-2)

1. **WHEN** SDD-03 begins, the system **SHALL** change `packages/opencode/src/global/index.ts:7` from `const app = "opencode"` to `const app = "foxybear"`. The system **SHALL** change `packages/opencode/src/global/index.ts:18` from `process.env.OPENCODE_TEST_HOME` to `process.env.FBH_TEST_HOME`.

2. **WHEN** the keystone changes, the system **SHALL** verify that `Global.Path.data`, `Global.Path.config`, `Global.Path.cache`, `Global.Path.state`, `Global.Path.bin`, `Global.Path.log` all resolve to `foxybear` subpaths at runtime (a unit test booting the module in a tmp HOME asserts each path ends with `/foxybear`).

### Flag namespace — env var rename (SC-3)

3. **WHEN** SDD-03 renames the Flag namespace, the system **SHALL** rename every `OPENCODE_*` member to `FBH_*` in `packages/opencode/src/flag/flag.ts`. The following illustrative (NOT exhaustive) list covers the known members from research §Stage 3: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_TEST_MANAGED_CONFIG_DIR`, `OPENCODE_DB`, `OPENCODE_SKIP_MIGRATIONS`, `OPENCODE_DISABLE_CHANNEL_DB`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_CLIENT`, `OPENCODE_PURE`, `OPENCODE_PERSONA`, `OPENCODE_AUTO_SHARE`, `OPENCODE_DISABLE_SHARE`, `OPENCODE_DISABLE_EMBEDDED_WEB_UI`, `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_MOUSE`, `OPENCODE_DISABLE_TERMINAL_TITLE`, `OPENCODE_ENABLE_QUESTION_TOOL`, `OPENCODE_ENABLE_EXPERIMENTAL_MODELS`, `OPENCODE_ENABLE_EXA`, `OPENCODE_FAKE_VCS`, `OPENCODE_EXPERIMENTAL_MARKDOWN`, `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT`, `OPENCODE_EXPERIMENTAL_PLAN_MODE`, `OPENCODE_EXPERIMENTAL_WORKSPACES`, `OPENCODE_EXPERIMENTAL_LSP_TOOL`, `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS`, `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`, `OPENCODE_EXPERIMENTAL_LSP_TY`, `OPENCODE_EXPERIMENTAL_ICON_DISCOVERY`, `OPENCODE_WORKER_PATH`, `OPENCODE_RIPGREP_WORKER_PATH`, `OPENCODE_TERMINAL`, `OPENCODE_MIGRATIONS`, `OPENCODE_E2E_LLM_URL`, `OPENCODE_CONSOLE_TOKEN`, `OPENCODE_PERMISSION`, `OPENCODE_SHOW_TTFD`, plus (added per fresh-context re-audit) `OPENCODE_ALWAYS_NOTIFY_UPDATE`, `OPENCODE_AUTO_HEAP_SNAPSHOT`, `OPENCODE_DISABLE_AUTOCOMPACT`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_FILETIME_CHECK`, `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_PRUNE`, `OPENCODE_EXPERIMENTAL`, `OPENCODE_EXPERIMENTAL_FILEWATCHER`, `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER`, `OPENCODE_EXPERIMENTAL_EXA`, `OPENCODE_EXPERIMENTAL_OXFMT`, `OPENCODE_GIT_BASH_PATH`, `OPENCODE_MODELS_PATH`, `OPENCODE_MODELS_URL`, `OPENCODE_PLUGIN_META_FILE`, `OPENCODE_STRICT_CONFIG_DEPS`, `OPENCODE_TUI_CONFIG`, `OPENCODE_CALLER`, `OPENCODE_CHANNEL`, `OPENCODE_LIBC`, `OPENCODE_PID`, `OPENCODE_ROUTE`, `OPENCODE_SKILL_PATTERN`, `OPENCODE_VERSION`. (`OPENCODE_TEST_HOME` renamed at SC-2 Step 1.) **This list is complete as of this revision (fresh-context re-audit, 2026-09-18, found ~71 distinct `OPENCODE_*` vars in `packages/opencode/src`, ~54 in the Flag namespace). Req 5's grep is the cross-check mechanism — any `OPENCODE_*` the grep finds after the rename MUST be renamed, regardless of whether it appears in this list (the codebase is living; new env vars added to `flag.ts` after this revision should not require a spec amendment, but they MUST still be caught by req 5's grep).**

4. **WHEN** the Flag members are renamed, the system **SHALL** update every `Flag.OPENCODE_*` call site across `packages/opencode/src` to `Flag.FBH_*`. The system **SHALL** also rename every direct `process.env.OPENCODE_*` read outside Flag (in `config/config.ts`, `share/share-next.ts`, `pty/index.ts`, `cli/cmd/tui/thread.ts`, `cli/cmd/tui/worker-persona-hook.ts`, `cli/cmd/run.ts`, and any other found by grep) to `process.env.FBH_*`.

5. **WHEN** the Flag rename is complete, the system **SHALL** verify a static grep for `OPENCODE_` across `packages/opencode/src` returns zero matches, with ONE explicit exception: `packages/opencode/src/provider/models-snapshot.js` may contain `OPENCODE_API_KEY` (the opencode SaaS provider's API key env var) IF Open Question 6 resolves to "keep the opencode provider." If OQ6 resolves to "remove," the models-snapshot entry for the opencode provider **SHALL** be removed and the grep **SHALL** return zero. The `OPENCODE_API_KEY` env var is NOT a Flag namespace member; it is a provider catalog entry governed by OQ6, not by SC-3.

### Binary name (SC-1)

6. **WHEN** SDD-03 renames the binary, the system **SHALL** rename `packages/opencode/bin/opencode` → `packages/opencode/bin/fbh` and **SHALL** update `packages/opencode/package.json` `bin` field from `{ "opencode": "./bin/opencode" }` to `{ "fbh": "./bin/fbh" }`. The system **SHALL** update `packages/opencode/package.json` `name` from `"opencode"` to `"fbh"` (unscoped core package name).

7. **WHEN** the binary is renamed, the system **SHALL** update the `bun link`/install path so `~/.bun/bin/fbh` points to the new binary, and **SHALL** verify `which fbh` resolves and `fbh --help` prints the correct binary name. The old `~/.bun/bin/opencode` link **SHALL** be left in place (removed by `fbh uninstall` or manually) — SDD-03 does not delete it.

### Schema URLs (SC-1, CC-8, Open Question 1)

8. **WHEN** OQ1 resolves to "foxybear.ai owned," the system **SHALL** replace `https://opencode.ai/config.json` → `https://foxybear.ai/config.json`, `https://opencode.ai/tui.json` → `https://foxybear.ai/tui.json`, `https://opencode.ai/theme.json` → `https://foxybear.ai/theme.json` across `config/config.ts` (lines 1244, 1245, 1288, 1423), `config/tui-migrate.ts:15`, and every `packages/opencode/src/cli/cmd/tui/context/theme/*.json` `$schema` field.

9. **WHEN** OQ1 resolves to "foxybear.ai NOT owned," the system **SHALL** self-host the config/tui/theme schemas by bundling them in the binary (a `schemas/` dir with `config.json`, `tui.json`, `theme.json`) and pointing the `$schema` references at the bundled paths (`file://` or a resolved resource URL). Docs links (`opencode.ai/docs*`) and API hosts (`app.opencode.ai`, `api.opencode.ai`) **SHALL** be removed or stubbed to a neutral placeholder pending domain acquisition (FBH-FF-003); the system **SHALL NOT** redirect them to a domain FoxyBear doesn't own.

10. **WHEN** the schema URLs are handled either way, the system **SHALL** update the system prompts `packages/opencode/src/session/prompt/anthropic.txt:12` and `default.txt:9` to replace "OpenCode"/"opencode" with "FoxyBear Harness"/"fbh" and `https://opencode.ai/docs` with either `https://foxybear.ai/docs` (if owned) or a local docs path. The OAuth client URI (`mcp/oauth-provider.ts:48`) and provider `HTTP-Referer` (`provider.ts:425,435,533,900`) **SHALL** follow the OQ1 decision, with the OQ1=NO branch specified as: (a) for the provider `HTTP-Referer` headers — remove the header entirely (most providers do not require it; it is an attribution/routing hint, not auth), OR set to a neutral `https://foxybear.local/` if removal breaks a provider that requires it; (b) for the OAuth client URI (`mcp/oauth-provider.ts:48`) — this URI identifies the client in OAuth flows and is registered with OAuth providers; if `foxybear.ai` is not owned, the URI **SHALL** be set to a loopback or `foxybear.local` placeholder AND the MCP OAuth flow **SHALL** be disabled with a clear error message ("OAuth client URI not configured — set FBH_OAUTH_CLIENT_URI or acquire foxybear.ai") rather than silently stubbed, because a stubbed OAuth redirect URI breaks OAuth login silently. The system **SHALL NOT** leave the OAuth client URI as `https://opencode.ai` (that continues to identify FoxyBear as OpenCode to OAuth providers).

11. **WHEN** the schema URL step completes, the system **SHALL** verify a static grep for `opencode.ai` across `packages/opencode/src` returns only the references explicitly allowed (none if owned; none if self-hosted; both cases zero unless a backward-compat shim is added).

### Internal host consistency (CC-9)

12. **WHEN** SDD-03 reconciles the internal host, the system **SHALL** change `packages/opencode/src/cli/cmd/run.ts:729` from `baseUrl: "http://opencode.internal"` to `baseUrl: "http://foxybear.internal"`, matching `telegram/bot.ts:687` and `daemon/runner.ts:127`. The system **SHALL** verify a static grep for `opencode.internal` returns zero matches.

### DB filename (SC-1)

13. **WHEN** SDD-03 renames the DB filename, the system **SHALL** change `packages/opencode/src/storage/db.ts:33` from `path.join(Global.Path.data, "opencode.db")` to `path.join(Global.Path.data, "fbh.db")` and `db.ts:35` from `\`opencode-${safe}.db\`` to `\`fbh-${safe}.db\``. The system **SHALL** change `packages/opencode/src/index.ts:112` marker check from `"opencode.db"` to `"fbh.db"`.

14. **WHEN** the DB filename changes, the system **SHALL** verify a unit test booting the DB in a tmp dir creates `fbh.db` (default channel) and `fbh-dev.db` (dev channel) at the new `Global.Path.data` path, and **SHALL** verify a static grep for `opencode.db` across `packages/opencode/src` returns zero matches.

### Brew tap + install URLs (SC-1)

15. **WHEN** SDD-03 updates the install path, the system **SHALL** update the brew tap reference from `anomalyco/tap/opencode` to `foxybear/tap/fbh` in the install script(s) and any `opencode.ai/install` URL (`installation/index.ts:148`) per the OQ1 decision. The system **SHALL** verify a static grep for `anomalyco/tap` and `opencode.ai/install` returns zero matches (or only the self-hosted/local equivalent).

### User agent + client header (SC-1)

16. **WHEN** SDD-03 updates the client identity, the system **SHALL** change the `x-opencode-client` header (`session/llm.ts:353`) to `x-fbh-client` and **SHALL** update the user agent string from `opencode/<channel>/<version>` to `fbh/<channel>/<version>` wherever it is constructed. The system **SHALL** verify the user agent format via a unit test.

### Managed config dirs + MDM + well-known (SC-1)

17. **WHEN** SDD-03 rebrands managed config, the system **SHALL** change `packages/opencode/src/config/config.ts:64` from `"/Library/Application Support/opencode"` to `"/Library/Application Support/foxybear"` and `config.ts:68` from `"/etc/opencode"` to `"/etc/foxybear"`. The system **SHALL** change `config.ts:73` from `process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR` to `process.env.FBH_TEST_MANAGED_CONFIG_DIR`. The system **SHALL** change `config.ts:78` from `MANAGED_PLIST_DOMAIN = "ai.opencode.managed"` to `"ai.foxybear.managed"`.

18. **WHEN** SDD-03 rebrands the well-known endpoint, the system **SHALL** change `.well-known/opencode` to `.well-known/fbh` at `config/config.ts:1416,1417,1424` and `cli/cmd/providers.ts:302`. This endpoint is runtime-fetched (`fetch(\`${url}/.well-known/opencode\`)`), so the rename MUST be consistent with any remote well-known endpoints FoxyBear publishes (or the feature is disabled if no FoxyBear well-known server exists — flagged as part of OQ1/OQ6).

### Opencode provider (Open Question 6)

19. **WHEN** OQ6 resolves to "remove the opencode provider," the system **SHALL** remove the `opencode` provider entry from `packages/opencode/src/provider/models-snapshot.js`, remove the `ProviderID.opencode` references and the `providerID.startsWith("opencode")` branch at `provider/provider.ts:1702`, remove the Zen/Go UI surfaces (`dialog-provider.tsx` Zen/Go prompts, `dialog-go-upsell.tsx` GO_URL, `retry.ts` GO_UPSELL_MESSAGE), and remove or disable the share feature's dependence on `api.opencode.ai` (`share/`, `cli/cmd/github.ts` `api.opencode.ai` calls). The system **SHALL** verify the removal does not break the build (the provider is optional; users without an opencode API key are unaffected).

20. **WHEN** OQ6 resolves to "keep the opencode provider," the system **SHALL** leave the provider name `opencode`, the `OPENCODE_API_KEY` env var, and the `api.opencode.ai`/`app.opencode.ai` hosts unchanged (they are OpenCode's SaaS, not FoxyBear's to rename). The system **SHALL** document in the user-facing docs that the `opencode` provider connects to OpenCode's SaaS (a third-party dependency). The `X-Title: "opencode"` headers (`provider.ts:426,436,534,901`) and `X-Cerebras-3rd-Party-Integration: "opencode"` (`provider.ts:803`) **SHALL** stay (they identify the client to OpenCode's SaaS).

21. **WHEN** OQ6 resolves to "rename to foxybear provider," the system **SHALL** rename `ProviderID.opencode` → `ProviderID.foxybear`, `OPENCODE_API_KEY` → `FBH_API_KEY`, and the API hosts to `foxybear.ai` equivalents — but this option is only valid if FoxyBear stands up equivalent SaaS infrastructure, which is out of scope for Phase A. Default to option (a) remove unless Todd directs otherwise.

---

## HOW

- The SDD-03 implementation is a scripted rename pass with three keystones (global/index.ts, flag/flag.ts, storage/db.ts) plus the schema URL handling.
- **Keystone (SC-2):** single-line edit at `global/index.ts:7` and `:18`. Ripple is automatic (all `Global.Path.*` consumers get the new path).
- **Flag (SC-3):** edit `flag/flag.ts` to rename every member; then `grep -rl "Flag.OPENCODE_" packages/opencode/src` and replace each with `Flag.FBH_`; then grep `process.env.OPENCODE_` outside Flag and replace.
- **Binary:** `mv packages/opencode/bin/opencode packages/opencode/bin/fbh`; edit `package.json` `bin` and `name`; `bun link` to refresh `~/.bun/bin/fbh`.
- **Schema URLs:** branch on OQ1. If owned: `sed` replace `opencode.ai` → `foxybear.ai` in the schema URL files. If not: create `packages/opencode/src/schemas/{config,tui,theme}.json` (copy from opencode.ai fetches or the existing schema definitions), point `$schema` refs at the bundled paths, remove/stub docs/API-host links.
- **Prompts:** edit `anthropic.txt` and `default.txt` strings (identity prose, not code).
- **Internal host:** single `sed` at `run.ts:729`.
- **DB filename:** edit `db.ts:33,35` and `index.ts:112`.
- **Brew/install:** edit install scripts; branch on OQ1 for the install URL.
- **User agent:** edit `llm.ts:353` and find the UA construction site (grep `opencode/` in src).
- **Managed config + MDM + well-known:** edit `config.ts:64,68,73,78,1416,1417,1424` and `providers.ts:302`. The well-known endpoint is runtime-fetched, so verify the rename is consistent with any remote FoxyBear well-known (or disable if OQ1/OQ6 decide no remote).
- **Opencode provider:** branch on OQ6. Remove → edit `models-snapshot.js`, `provider.ts`, Zen/Go UI, share/github. Keep → no edit, document third-party. Rename → only if FoxyBear SaaS exists (out of scope).
- What is explicitly NOT built: no package scope rename (SDD-02 done), no migration (SDD-04), no verification suite (SDD-05).

---

## VERIFY

Acceptance tests live at `test/fbh-rebrand/sdd-03.test.ts`. Static-grep + unit tests + a real boot in tmp HOME.

- **V1 — XDG keystone (reqs 1–2).** Action: boot `global/index.ts` in a tmp HOME with `FBH_TEST_HOME` set. Expected: `Global.Path.{data,config,cache,state}` end with `/foxybear`; `Global.Path.bin` = `<cache>/bin`; `Global.Path.log` = `<data>/log`. `OPENCODE_TEST_HOME` no longer read (set it, confirm ignored).
- **V2 — Flag namespace renamed (reqs 3–4).** Action: static grep `OPENCODE_` in `packages/opencode/src` excluding `models-snapshot.js`. Expected: zero. Action: set `FBH_CONFIG=/tmp/x` and boot; confirm Flag reads it; set `OPENCODE_CONFIG=/tmp/y` and confirm Flag ignores it (backward-compat read is SDD-04's concern, not Flag).
- **V3 — binary (reqs 6–7).** Action: `cd packages/opencode && bun run build && bun link`. Expected: `which fbh` resolves; `fbh --help` prints `fbh` as the program name. `which opencode` may still resolve (old link left); not SDD-03's concern.
- **V4 — schema URLs owned (req 8, if OQ1=owned).** Action: static grep `opencode.ai` in `packages/opencode/src`. Expected: zero (or only allowed). Read `config.ts:1244` — assert `foxybear.ai/config.json`.
- **V5 — schema URLs self-hosted (req 9, if OQ1=not owned).** Action: read `config.ts` — assert `$schema` points at bundled path; assert `packages/opencode/src/schemas/{config,tui,theme}.json` exist; assert docs/API-host links removed or stubbed; assert NO redirect to `foxybear.ai`.
- **V6 — prompts + OAuth + referer (req 10).** Action: read `anthropic.txt`, `default.txt` — assert "FoxyBear Harness"/"fbh" present, "OpenCode"/"opencode" absent in identity prose; read `mcp/oauth-provider.ts:48` and `provider.ts:425` — assert OQ1 decision applied.
- **V7 — internal host (req 12).** Action: `grep "opencode.internal" packages/opencode/src`. Expected: zero.
- **V8 — DB filename (reqs 13–14).** Action: boot DB in tmp dir (default + dev channel). Expected: `fbh.db` and `fbh-dev.db` created; `grep "opencode.db" packages/opencode/src` zero.
- **V9 — brew + install (req 15).** Action: grep `anomalyco/tap` and `opencode.ai/install` in install scripts. Expected: zero (or local/self-hosted equivalent).
- **V10 — user agent (req 16).** Action: grep `x-opencode-client` — zero; read `llm.ts:353` — assert `x-fbh-client`. Unit test: construct UA, assert format `fbh/<channel>/<version>`.
- **V11 — static sweep (CC-4).** Action: `grep -rE "OPENCODE_|opencode\.ai|opencode\.internal|opencode\.db|anomalyco/tap" packages/opencode/src`. Expected: zero matches, except `OPENCODE_API_KEY` in `models-snapshot.js` IF OQ6 = keep (the one-source-of-truth guarantee holds for Flag namespace; the opencode provider is governed by OQ6).
- **V12 — typecheck + test green (CC-5).** Action: `bun run typecheck && bun test --timeout 30000`. Expected: green (baseline tolerated).
- **V13 — managed config + MDM (req 17).** Action: read `config.ts:64,68,73,78`. Expected: `foxybear` paths, `FBH_TEST_MANAGED_CONFIG_DIR`, `ai.foxybear.managed`.
- **V14 — well-known (req 18).** Action: `grep ".well-known/opencode" packages/opencode/src`. Expected: zero; `grep ".well-known/fbh"` expected: matches at `config.ts:1416,1417,1424` and `providers.ts:302`.
- **V15 — opencode provider (reqs 19–21).** Branch on OQ6. Remove: `grep "ProviderID.opencode|OPENCODE_API_KEY|api.opencode.ai" packages/opencode/src` → zero; Zen/Go UI removed. Keep: `models-snapshot.js` still has `OPENCODE_API_KEY`; `provider.ts:1702` still has the opencode branch; docs note third-party. Rename: `FBH_API_KEY` present, `OPENCODE_API_KEY` absent.
- **V16 — idempotent (CC-2).** Action: run the SDD-03 pass twice. Expected: second run no-op.
