# SDD-02: Package Rebrand (Stage 2)

**Date:** 2026-09-18
**Project:** FoxyBear Harness
**Status:** Draft (pending audit + council + human gate)
**Master:** `260918_fbh-rebrand_sdd-00-master.md`
**Depends on:** SDD-01 (repo renamed to `FoxyBear/foxybear-harness`, local dir is `development/foxybear/`).
**Owns:** SC-5 (package scope map).

Implements Phase A Stage 2: npm scope rename `@opencode-ai/*` → `@foxybear/*` across all kept packages, the SDK client factory rename, dropped packages, container registry, and Tauri identifiers. Leaf packages first to keep workspace resolution valid at every step.

## Background

Research §Stage 2 found 13+ packages with `@opencode-ai/*` scope, the `createOpencodeClient` public SDK export at `packages/sdk/js/src/v2/client.ts:46` (re-exported from `packages/plugin/src/index.ts:3`, consumed in 10+ source files + 400+ generated openapi.json occurrences), `ghcr.io/anomalyco` in 8 container files, and a `desktop` Tauri package whose config path was not located by glob (research gap 1 — SDD-02's HOW must locate it before implementation). The plan's Stage 2 table is accurate in intent; this spec makes the rename order and the SDK break explicit.

---

## WHAT

### Scope rename — leaf packages first (SC-5)

1. **WHEN** SDD-02 begins, the system **SHALL** rename the npm scope of every kept package per SC-5 in dependency order: `util` → `sdk/js` → `plugin` → `script` → `ui` → `storybook` → `app` → `slack` → `desktop` → `extensions` → `containers` → `console/*` → `enterprise` → `function` → core `opencode` (last). For each package, the `name` field in its `package.json` **SHALL** change from `@opencode-ai/<pkg>` to `@foxybear/<pkg>`.

2. **WHEN** a package is renamed, every workspace dependency reference to it in every other package's `package.json` (`"@opencode-ai/<pkg>": "workspace:*"`) **SHALL** update to `"@foxybear/<pkg>": "workspace:*"` in the same pass. The root `package.json` workspace deps **SHALL** update too.

3. **WHEN** all packages are renamed, the system **SHALL** run `bun install` at the repo root to regenerate `bun.lock` with the new scope, and **SHALL** verify `bun.lock` contains zero `@opencode-ai` references.

4. **WHEN** the lockfile is regenerated, the system **SHALL** run `bun turbo typecheck` and **SHALL** verify zero typecheck errors caused by the scope rename (errors in dropped packages, if any, are ignored per the drop step).

### SDK client factory rename (Open Question 2)

5. **WHEN** the `sdk/js` package is renamed (Step 1), the system **SHALL** rename the exported function `createOpencodeClient` → `createFbhClient` at `packages/sdk/js/src/v2/client.ts:46` and **SHALL** update the re-export at `packages/plugin/src/index.ts:3` (`createOpencodeClient` → `createFbhClient` in both the import and the `client: ReturnType<typeof createOpencodeClient>` type at `plugin/src/index.ts:58`).

6. **WHEN** the SDK export is renamed, the system **SHALL** update every call site in the `opencode` package: `voice/plugin.ts:105,108`, `plugin/index.ts:11,128`, `telegram/bot.ts:673,687`, `daemon/runner.ts:105,127`, `cli/cmd/tui/component/dialog-workspace-list.tsx:6,14`, `cli/cmd/run.ts:10,720,729` (and the `OpencodeClient` type import at `run.ts:10` → `FbhClient`). The system **SHALL** regenerate `packages/sdk/openapi.json` (the 400+ `createOpencodeClient` doc references) via the SDK build script (`./packages/sdk/js/script/build.ts` per repo AGENTS.md), **SHALL NOT** hand-edit the openapi.json.

7. **WHEN** Open Question 2 resolves to "keep a deprecation shim," the system **SHALL** add to `packages/sdk/js/src/v2/client.ts` a re-export `export const createOpencodeClient = createFbhClient` with a `@deprecated` JSDoc tag, and **SHALL** log a one-time deprecation warning when the shim is imported. If OQ2 resolves to "clean break," this step is a no-op.

8. **WHEN** the SDK rename is complete, the system **SHALL** verify a static grep for `createOpencodeClient` across `packages/` (excluding `node_modules` and the regenerated openapi.json) returns zero matches, OR only the shim re-export if OQ2 chose the shim.

### Dropped packages (SC-5, CC-10)

9. **WHEN** the scope renames are green (Step 4), the system **SHALL** drop the packages `desktop-electron`, `web`, `docs`, `identity` by removing their directories. The `script` package **SHALL** be merged into the core `opencode` package (its 77 LOC moved to `packages/opencode/src/script/` or inlined per its usage) and then its directory removed.

10. **WHEN** the drops are complete, the system **SHALL** remove every dropped package from the root `package.json` `workspaces.packages` array and from any workspace dependency reference. The system **SHALL** run a static grep verifying no kept package imports `@opencode-ai/desktop-electron`, `@opencode-ai/web`, `@opencode-ai/docs`, `@opencode-ai/identity`, or `@opencode-ai/script` (CC-10). Zero matches required.

11. **WHEN** the drops are verified, the system **SHALL** run `bun install` + `bun turbo typecheck` and **SHALL** verify green (ignoring dropped-package errors, which no longer exist).

### Container registry (SC-5)

12. **WHEN** the `containers` package is reached in the rename order, the system **SHALL** replace `ghcr.io/anomalyco` with `ghcr.io/foxybear` in every file under `packages/containers/`: `tauri-linux/Dockerfile`, `rust/Dockerfile`, `publish/Dockerfile`, `bun-node/Dockerfile`, `script/build.ts:10`, `README.md:18,19,29`. The system **SHALL** verify a static grep for `ghcr.io/anomalyco` returns zero matches across the repo.

### Tauri identifiers (research gap 1)

13. **WHEN** the `desktop` package is reached, the system **SHALL** rebrand every `opencode`/`anomalyco` reference in all three Tauri config files: `packages/desktop/src-tauri/tauri.conf.json`, `tauri.beta.conf.json`, `tauri.prod.conf.json` (identifier, productName, window title, bundle name, any `opencode.ai` URLs), AND `packages/desktop/src-tauri/Cargo.toml` (package name, authors if anomalyco), AND `packages/desktop/src-tauri/entitlements.plist` (any opencode identifiers). The `package.json` `name` field updates per Step 1. The system **SHALL** verify a static grep for `opencode` and `anomalyco` across `packages/desktop/src-tauri/` (excluding `target/`) returns zero matches after the rebrand.

14. **WHEN** the Tauri config is rebranded, the system **SHALL** verify a static grep for `opencode` and `anomalyco` across `packages/desktop/` (excluding `node_modules` and `src-tauri/target`) returns only the backward-compat references explicitly allowed by the master (none, unless the desktop package embeds config-filename backward compat from SDD-03).

### `extensions` package

15. **WHEN** the `extensions` package is reached, the system **SHALL** update its binary URL (the install URL pointing to opencode.ai or anomalyco releases) and its display name per SC-5. The system **SHALL** verify the updated URL resolves (or is a local path) and the name is `fbh`-branded.

---

## HOW

- The SDD-02 implementation is a scripted rename pass plus a verification pass. Order is normative (SC-5): leaf packages first, core last, drops after scope renames are green.
- **Per-package rename:** for each package in order, edit `package.json` `name` field; then `grep -rl "@opencode-ai/<old-name>" packages/ --include package.json` and replace with `@foxybear/<new-name>` in every hit. The core `opencode` package's directory renames to `fbh` (per SC-1 binary), but that directory rename is SDD-03's concern (the package `name` field here; the directory in SDD-03). DECISION: the core package `name` stays `opencode`-internal? No — SC-1 says binary `opencode` → `fbh`; the package `name` in `packages/opencode/package.json` is `"opencode"` (unscoped). SDD-02 leaves the unscoped core `name` to SDD-03 (binary rename). SDD-02 only touches the `@opencode-ai/*` scoped deps in the core package's `package.json`.
- **SDK rename:** edit `client.ts:46` function name; edit `plugin/src/index.ts:3,58`; grep `createOpencodeClient` across `packages/opencode/src` and replace each call site; regenerate openapi.json via `./packages/sdk/js/script/build.ts`.
- **Drops:** `rm -rf packages/desktop-electron packages/web packages/docs packages/identity`; merge `packages/script/src/index.ts` (single-file package) into `packages/opencode/src/script/index.ts` (or inline per its usage — verify consumers via grep during implementation); `rm -rf packages/script`; edit root `package.json` workspaces array.
- **Containers:** `sed -i 's|ghcr.io/anomalyco|ghcr.io/foxybear|g'` across the 6 files (8 occurrences).
- **Tauri:** glob to find config; edit identifier/productName/title; verify grep.
- What is explicitly NOT built: no binary rename (SDD-03), no env var rename (SDD-03), no XDG path change (SDD-03), no migration (SDD-04).

---

## VERIFY

Acceptance tests live at `test/fbh-rebrand/sdd-02.test.ts`. Static-grep + build-level tests; no runtime LLM.

- **V1 — scope rename complete (reqs 1–3).** Action: run the rename pass. Expected: every kept package's `package.json` `name` is `@foxybear/*`; `bun.lock` has zero `@opencode-ai`; `bun install` succeeds.
- **V2 — typecheck green post-rename (req 4).** Action: `bun turbo typecheck`. Expected: zero errors (baseline failures tolerated per `baselineFile`).
- **V3 — SDK factory renamed (reqs 5–6).** Action: run the SDK rename. Expected: `packages/sdk/js/src/v2/client.ts` exports `createFbhClient`; `packages/plugin/src/index.ts` re-exports `createFbhClient`; every call site in `packages/opencode/src` uses `createFbhClient` (static grep zero `createOpencodeClient` in `src`); `openapi.json` regenerated (grep `createFbhClient` present, `createOpencodeClient` absent or only in shim).
- **V4 — shim if OQ2 (req 7).** If OQ2 = shim: assert `createOpencodeClient` re-export exists with `@deprecated` JSDoc; assert a test import logs a warning. If OQ2 = clean break: assert no shim.
- **V5 — SDK static check (req 8).** Action: `grep -r "createOpencodeClient" packages/ --exclude-dir=node_modules --exclude=openapi.json`. Expected: zero matches (or only the shim line).
- **V6 — dropped packages gone (reqs 9–10, CC-10).** Action: run drops. Expected: `packages/desktop-electron`, `packages/web`, `packages/docs`, `packages/identity`, `packages/script` do not exist; `grep -rE "@opencode-ai/(desktop-electron|web|docs|identity|script)" packages/ --exclude-dir=node_modules` returns zero; `bun turbo typecheck` green.
- **V7 — container registry (req 12).** Action: `grep -r "ghcr.io/anomalyco" packages/`. Expected: zero matches. `grep -r "ghcr.io/foxybear" packages/containers` expected: 8 matches.
- **V8 — Tauri identifiers (reqs 13–14).** Action: locate Tauri config (glob); read; assert identifier/productName/title are foxybear/fbh-branded; `grep -rE "opencode|anomalyco" packages/desktop/ --exclude-dir=node_modules --exclude-dir=target` returns zero (or only explicitly-allowed backward compat).
- **V9 — extensions (req 15).** Action: read extensions package; assert binary URL is fbh/foxybear-branded or local; assert name is `fbh`-branded.
- **V10 — idempotent (CC-2).** Action: run the full SDD-02 pass twice. Expected: second run is a no-op (all greps already zero, all names already `@foxybear/*`).
- **V11 — build green (CC-5).** Action: `cd packages/opencode && bun run build`. Expected: success.
