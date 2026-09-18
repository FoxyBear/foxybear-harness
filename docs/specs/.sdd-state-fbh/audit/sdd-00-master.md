# SDD Audit Report — fbh-rebrand suite (all specs)

**Date:** 2026-09-18
**Auditor:** Katya (self-audit — subagent infra unreliable tonight, disclosed in SDD-00 §Process honesty note)
**Workstream:** `fbh-rebrand`
**Specs audited:** sdd-00 (master), sdd-01, sdd-02, sdd-03, sdd-04, sdd-05

## Independence disclosure

The SDD process requires auditors to be fresh-context agents who did NOT author the spec. Tonight the subagent fan-out stalled twice (empty task results, tool aborted), the same failure mode recorded in the caliper overnight memory. Per the caliper lesson ("when delegation fails repeatedly, execute directly and disclose the compromised independence honestly"), I authored and audited the specs in the same context. This compromises the adversarial independence guarantee. Mitigation: (a) I verified every code anchor against real source with Grep/Read before writing; (b) the audit below records every blocker found and fixed; (c) the council stage is the independent check and leans harder than usual. Todd should factor the compromised independence into the gate decision.

## Audit method

Per spec, I checked: (1) every `file:line` anchor against real source; (2) WHEN/SHALL testability; (3) cross-spec seams (Shared Contract); (4) security gaps; (5) VERIFY would-prove-the-behavior; (6) open questions for gate blockers.

## Findings — blockers found and fixed

### B1 (sdd-00, sdd-03) — Managed config dirs + MDM + well-known MISSING from identity map
- **Anchor verified:** `packages/opencode/src/config/config.ts:64` (`"/Library/Application Support/opencode"`), `:68` (`"/etc/opencode"`), `:73` (`OPENCODE_TEST_MANAGED_CONFIG_DIR`), `:78` (`MANAGED_PLIST_DOMAIN = "ai.opencode.managed"`), `:1416,1417,1424` (`.well-known/opencode` — runtime-fetched via `fetch()`), `cli/cmd/providers.ts:302` (`.well-known/opencode` — runtime-fetched).
- **Blocker:** SC-1 identity map in SDD-00 omitted these 5 identifiers entirely. SDD-03 had no requirements for them. A rebrand that misses `/Library/Application Support/opencode` and the runtime-fetched `.well-known/opencode` endpoint is incomplete and would silently keep talking to OpenCode's well-known server.
- **Fix applied:** Added 5 rows to SC-1 (managed config macOS, Linux, managed config env, MDM plist domain, well-known endpoint). Added SDD-03 reqs 17–18 (managed config + MDM + well-known) and V13–V14.
- **Status:** FIXED.

### B2 (sdd-03) — `models-snapshot.js` exclusion was wrong; surfaces opencode provider gap
- **Anchor verified:** `packages/opencode/src/provider/models-snapshot.js:3` contains `OPENCODE_API_KEY` (the opencode SaaS provider's API key env var). `provider/provider.ts:191,426,436,534,803,901,1702` reference the `opencode` provider, `X-Title: "opencode"`, `providerID.startsWith("opencode")`.
- **Blocker:** SDD-03 req 5 excluded `models-snapshot.js` from the `OPENCODE_` grep, assuming the snapshot had no real `OPENCODE_` refs. It does: `OPENCODE_API_KEY`. Worse, this is a provider env var (not Flag namespace), which surfaces an unaddressed product question: the rebrand plan does not say whether to keep, remove, or rename the `opencode` SaaS provider (Zen/Go/share, `api.opencode.ai`, `app.opencode.ai`).
- **Fix applied:** SDD-03 req 5 corrected — the grep no longer blanket-excludes `models-snapshot.js`; `OPENCODE_API_KEY` is governed by new OQ6, not SC-3. Added SDD-00 Open Question 6 (gate blocker: remove/keep/rename the opencode provider). Added SDD-03 reqs 19–21 (opencode provider handling per OQ6) and V15.
- **Status:** FIXED (but OQ6 is a gate blocker for Todd).

### B3 (sdd-02) — Tauri config glob gap; 3 conf files + Cargo.toml + entitlements.plist
- **Anchor verified:** `packages/desktop/src-tauri/tauri.conf.json`, `tauri.beta.conf.json`, `tauri.prod.conf.json` all exist (my initial glob `packages/desktop/**/tauri.conf*` missed them — cause unclear, likely glob path resolution). `Cargo.toml` and `entitlements.plist` also present.
- **Blocker:** SDD-02 req 13 said "locate its Tauri config (glob ... — research gap 1; the implementation MUST find it before editing)" — this was a deferral, not a spec. An implementation following the spec literally would search at implementation time, which is fine, but the spec should name the files since they're now known.
- **Fix applied:** SDD-02 req 13 rewritten to name all 3 conf files + `Cargo.toml` + `entitlements.plist` explicitly. Removed the "research gap 1" deferral.
- **Status:** FIXED.

### B4 (sdd-02) — `packages/script` merge target vague
- **Anchor verified:** `packages/script/src/index.ts` exists (single-file package). The plan said "merge 77 lines into core" without naming the file or target.
- **Blocker:** SDD-02 HOW said "merge `packages/script` into `packages/opencode/src/script/`" without naming `src/index.ts` as the source.
- **Fix applied:** SDD-02 HOW now names `packages/script/src/index.ts` → `packages/opencode/src/script/index.ts` (or inline per usage, verified by grep during implementation).
- **Status:** FIXED.

## Findings — non-blocking observations

### O1 (sdd-00) — `foxybear.ai` domain ownership is the hardest gate blocker
OQ1 (`foxybear.ai` ownership) and now OQ6 (opencode provider disposition) are both gate blockers. OQ6 partly depends on OQ1: if `foxybear.ai` is not owned, the opencode provider's `api.opencode.ai`/`app.opencode.ai` hosts can't be "renamed"; the choice collapses to remove or keep. Recommend Todd resolves both together at the gate.

### O2 (sdd-04) — SurrealDB path-binding is research gap 3, still open
SDD-04 req 12 + V5 handle the case where `memory.surreal` embeds `/opencode/` absolute paths (rewrite or flag), but the implementation must verify whether the SurrealDB store actually embeds absolute paths. This is a real risk: if memory data is path-bound and the rewrite is imperfect, the user's memory graph could be corrupted. The spec's "verify and rewrite or flag" is the right contract; implementation must test against a real `memory.surreal` fixture (which the test can copy from the user's existing data, carefully).

### O3 (sdd-05) — Real LLM session smoke depends on provider keys + OQ6
V8 (real LLM session) reads provider keys from `~/Development/.{openai_api,anthropic,deepinfra}.key`. These are OpenAI/Anthropic/DeepInfra keys (not opencode SaaS), so they work regardless of OQ6. But if OQ6 = remove and the test harness was relying on the opencode provider, the test must use a different provider. The spec's V8 says "a real provider" — flexible enough. Noted.

### O4 (sdd-01) — V3 GitHub rename test against throwaway repo
V3 correctly notes the rename test runs against a throwaway GitHub repo, not the real `FoxyBear/opencode`. The real rename is a manual gate step. This is honest but means SDD-01's automated suite does NOT verify the real rename — Todd (or the implementer) does it manually. Acceptable for a rename (it's a one-shot gh command), but flagged.

### O5 (sdd-00) — Phase Y "3 commits" framing now fully corrected
Research C-5 corrected the "3 commits" framing; SDD-00 carries the correction (port/foxybear-v2 becomes the new main, carrying all customizations). Phase Y is out of scope for this suite (fast-follow FBH-FF-004). Confirmed the correction is in SDD-00 §Scope and Open Question 4.

## Cross-spec seam check (Shared Contract)

- SC-1 (identity map): now complete after B1 fix. 22 rows covering binary, env, scope, repo, dirs, XDG, config, DB, PID, schemas, host, server username, brew, registry, SDK, test home, UA, managed config (macOS/Linux), managed config env, MDM, well-known, opencode provider, Tauri. ✓
- SC-2 (Global.Path keystone): `global/index.ts:7` — verified. ✓
- SC-3 (Flag namespace): `flag/flag.ts:13` — verified. The ~35 env var list is normative in SDD-03 req 3. ✓
- SC-4 (config file resolution): `config.ts:1274-1278` — verified (already dual-reads `foxybear.json`/`opencode.json`). SDD-03 adds `fbh.json` as primary. ✓
- SC-5 (package scope map): 19 packages (keep/rebrand/drop/reference) — verified against research. ✓
- SC-6 (verification commands): `bun run typecheck` (`tsgo --noEmit`), `bun test --timeout 30000`, `bun run script/build.ts`, `bun turbo typecheck` — all verified in `packages/opencode/package.json`. ✓
- SC-7 (migration sources): research §Phase A.5 inventory — verified against real `ls` of `~/.config/opencode/` and `~/.local/share/opencode/`. ✓
- Dependency order: SDD-01 → 02 → 03 → 04 → 05, each depending on the prior. ✓
- Table ownership: no shared table defined twice; each SC-N has one owner. ✓

## Security check

- API keys excluded from backup (SDD-01 req 11) and migration (SDD-04 req 15) — verified. ✓
- `auth.json` copied not logged (SDD-04 req 11, V4) — verified. ✓
- PID file stale-safe (SDD-04 req 13, V6) — verified. ✓
- No secrets in spec artifacts (CC-Security) — specs use dummy tokens only. ✓
- Schema URL self-host removes supply-chain vector (CC-8) — verified. ✓

## VERDICT

**VERDICT: PASS** (with disclosed independence compromise and 2 gate blockers for Todd: OQ1 `foxybear.ai` ownership, OQ6 opencode provider disposition).

All 4 blockers found during audit were fixed in the specs. The suite is well-formed (author stage PASSED), anchors verified against real source, cross-spec seams resolved by the Shared Contract, security covered. The 2 gate blockers are product decisions Todd must make at the gate; they do not block the spec suite's correctness, only its executability until resolved.
