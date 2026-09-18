# SDD-03 Verification Report

**Date:** 2026-09-18
**Verifier:** Katya
**Spec:** `260918_fbh-rebrand_sdd-03-core-deep-rebrand.md`

## Live state verification

| Req | Verification | Result |
|---|---|---|
| 1-2 (XDG keystone) | `global/index.ts:7` = `const app = "foxybear"`; `FBH_TEST_HOME` (not OPENCODE_TEST_HOME) | ✓ |
| 3-5 (Flag namespace) | `flag/flag.ts` has 54 `FBH_*` vars, zero `OPENCODE_`; zero `OPENCODE_` in src (excl models-snapshot + dist + test) | ✓ |
| 6-7 (binary) | `packages/opencode/bin/fbh` exists; `package.json` `name: "fbh"`, `bin: { "fbh": "./bin/fbh" }` | ✓ |
| 8 (schema URLs, OQ1=YES) | `foxybear.ai/config.json`, `foxybear.ai/tui.json`, `foxybear.ai/theme.json` in config.ts + theme files; zero `opencode.ai` in src | ✓ |
| 9 (schema URLs, OQ1=NO) | N/A — OQ1=YES | ✓ |
| 10 (prompts + OAuth + referer) | `anthropic.txt` + `default.txt` identity = "FoxyBear Harness"/"fbh"; zero opencode.ai; OAuth client_uri = foxybear.ai | ✓ |
| 11 (opencode.ai static) | Zero `opencode.ai` in src (excl dist + test) | ✓ |
| 12 (internal host) | Zero `opencode.internal` in src; `foxybear.internal` present | ✓ |
| 13-14 (DB filename) | `fbh.db` in db.ts + index.ts; zero `opencode.db` in src | ✓ |
| 15 (brew + install) | `foxybear/tap/fbh` in installation.ts; zero `anomalyco/tap`; zero `opencode.ai/install` | ✓ |
| 16 (user agent) | `x-fbh-client` in llm.ts; zero `x-opencode-client` | ✓ |
| 17 (managed config + MDM) | `Application Support/foxybear`, `/etc/foxybear`, `FBH_TEST_MANAGED_CONFIG_DIR`, `ai.foxybear.managed` | ✓ |
| 18 (well-known) | `.well-known/fbh` in config.ts + providers.ts; zero `.well-known/opencode` | ✓ |
| 19-21 (opencode provider, OQ6=remove) | `opencode` + `opencode-go` providers removed from models-snapshot (212→210); `OPENCODE_API_KEY` = 0; `startsWith("opencode")` branch removed; opencode provider handler removed; zero `api.opencode.ai`/`app.opencode.ai` in src | ✓ |
| CC-4 (one source of truth) | Static sweep: zero `OPENCODE_` in src (excl models-snapshot + dist + test) | ✓ |
| CC-5 (green suite) | typecheck + tests green (3 pre-existing baseline failures tolerated) | ✓ |
| CC-9 (partial brand reconciliation) | `opencode.internal` → `foxybear.internal` in all src; `"foxybear"` default username preserved | ✓ |

## Additional changes

- Context service identifiers `@opencode/` → `@foxybear/` across all src (Effect Context.Service strings, not npm scope)
- `"X-Title": "opencode"` → `"fbh"` and `"X-Cerebras-3rd-Party-Integration": "opencode"` → `"fbh"` in provider.ts
- `User-Agent: opencode/...` → `fbh/...` in provider.ts
- Tips-view.tsx: all `opencode` command references → `fbh`; config dir paths → `~/.config/foxybear/`, `.foxybear/command/`, etc.; `ghcr.io/anomalyco/opencode` → `ghcr.io/foxybear/fbh`
- thread.ts: `opencode.internal` → `foxybear.internal`; command descriptions `opencode tui` → `fbh tui`
- Test files: `.well-known/opencode` → `.well-known/fbh`, `opencode.db` → `fbh.db`, `anomalyco/tap/opencode` → `foxybear/tap/fbh`, `opencode.ai/config.json` → `foxybear.ai/config.json`
- Removed 2 opencode provider tests from `provider.test.ts` (testing deleted provider)
- `acp/README.md`: `OPENCODE_` → `FBH_`

## Acceptance tests

- `test/fbh-rebrand/sdd-03.test.ts` — 15 pass, 0 fail ✓
- typecheck — green ✓
- full suite — 3 pre-existing baseline failures tolerated ✓

VERDICT: PASS
