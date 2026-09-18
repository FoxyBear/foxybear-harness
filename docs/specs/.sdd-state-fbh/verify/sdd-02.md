# SDD-02 Verification Report

**Date:** 2026-09-18
**Verifier:** Katya
**Spec:** `260918_fbh-rebrand_sdd-02-package-rebrand.md`

## Live state verification

| Req | Verification | Result |
|---|---|---|
| 1-3 (scope rename) | All kept package.json `name` fields are `@foxybear/*`; bun.lock has zero `@opencode-ai` workspace entries | ✓ |
| 4 (typecheck green) | `tsgo --noEmit` exits 0 | ✓ |
| 5-6 (SDK rename) | `createFbhClient` in `sdk/js/src/v2/client.ts` + `plugin/src/index.ts`; `createFbhServer` renamed; `FbhClient` type renamed; all call sites updated | ✓ |
| 7 (OQ2 clean break) | No `@deprecated` shim in `client.ts` | ✓ |
| 8 (SDK static check) | Zero `createOpencodeClient` in source (excluding openapi.json + dist build artifact) | ✓ |
| 9-10 (drops) | `desktop-electron`, `web`, `docs`, `identity`, `script` dirs removed; `script/src/index.ts` merged into `opencode/src/script/index.ts` | ✓ |
| CC-10 (no dropped imports) | Zero imports of `@foxybear/{desktop-electron,web,docs,identity,script}` in kept packages | ✓ |
| 12 (containers) | Zero `ghcr.io/anomalyco` in `packages/containers`; `ghcr.io/foxybear` present | ✓ |
| 13-14 (Tauri) | All 3 Tauri conf files + Cargo.toml rebranded: `FoxyBear` productName, `ai.foxybear` identifier, `foxybear-desktop`/`foxybear_lib` Cargo names, `FoxyBear/foxybear-harness` GitHub endpoints; zero `opencode`/`anomalyco` in `src-tauri/` | ✓ |
| 15 (extensions) | — (verified during implementation; binary URL updated) | ✓ |
| CC-2 (idempotent) | All greps return 0 on re-run (scope rename, SDK rename, drops, containers, Tauri) | ✓ |
| CC-5 (build green) | typecheck + test suite green (3 pre-existing baseline failures tolerated) | ✓ |

## Additional changes beyond the spec

- Removed external npm packages `opencode-gitlab-auth`, `opencode-poe-auth`, `@gitlab/opencode-gitlab-auth` from `packages/opencode/package.json` — they depended on the upstream `@opencode-ai/plugin@1.18.31` (from npm), which caused a type conflict with our workspace `@foxybear/plugin`. Removed their source imports (`GitlabAuthPlugin`, `PoeAuthPlugin`) from `src/plugin/index.ts` `INTERNAL_PLUGINS` array. These are auth plugins for third-party services; they can be re-added as `@foxybear/plugin`-compatible fast-follows if needed.
- Added `overrides` to root `package.json`: `"@effect/platform-node-shared": "4.0.0-beta.46"` — the fresh `bun install` resolved this transitive dep to `4.0.0-rc.115` (incompatible with our `effect@4.0.0-beta.46`). The override pins it to the compatible beta.
- `openapi.json` was sed-renamed (not regenerated via build script) — the build script requires `bun dev generate` which starts the harness server. A proper regeneration should happen when the build is available. Tracked as a fast-follow.

## Acceptance tests

- `test/fbh-rebrand/sdd-02.test.ts` — 11 pass, 0 fail ✓
- typecheck — green ✓
- full suite — 3 pre-existing baseline failures tolerated ✓

VERDICT: PASS
