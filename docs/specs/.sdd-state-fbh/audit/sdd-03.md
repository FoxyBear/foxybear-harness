# SDD Audit Report — sdd-03 (core-deep-rebrand)

**Date:** 2026-09-18
**Auditor:** Katya (self-audit — disclosed)
**Spec:** `260918_fbh-rebrand_sdd-03-core-deep-rebrand.md`

## Fresh-context re-audit (2026-09-18) — corrections applied

### Seam 1: Env var completeness — FIXED
- **Blocker:** SDD-03 req 3's "complete set" listed ~42 vars; codebase has ~71 distinct `OPENCODE_*` vars (~54 in `flag/flag.ts`). 28 vars missing.
- **Fix:** Req 3 list expanded with the 28 re-audit-found vars + an explicit statement that the list is illustrative and req 5's grep is the normative complete-set source. SC-3's "~35" count corrected to "~71". FIXED.

### Seam 3: OAuth dead-end — FIXED
- **Blocker:** SDD-03 req 10 said OAuth client URI and provider referer "follow the same OQ1 decision" but for OQ1=NO, "remove or stub to neutral placeholder" is not valid for an OAuth redirect URI (breaks OAuth login silently).
- **Fix:** Req 10 rewritten to specify the OQ1=NO branch: referer headers removed (or neutral `foxybear.local`); OAuth client URI set to loopback/`foxybear.local` + MCP OAuth flow DISABLED with a clear error (not silently stubbed). FIXED.

## Verdict

VERDICT: PASS

## Blockers found and fixed

### B1 — Managed config + MDM + well-known MISSING (shared with sdd-00)
- **Anchor:** `config/config.ts:64,68,73,78,1416,1417,1424`; `cli/cmd/providers.ts:302`.
- **Fix:** Added SDD-03 reqs 17 (managed config + MDM) and 18 (well-known, runtime-fetched) + V13, V14. FIXED.

### B2 — `models-snapshot.js` exclusion wrong; opencode provider gap
- **Anchor:** `models-snapshot.js:3` (`OPENCODE_API_KEY`); `provider/provider.ts:191,426,436,534,803,901,1702`.
- **Fix:** Req 5 corrected — no blanket exclusion; `OPENCODE_API_KEY` governed by OQ6. Added reqs 19–21 (opencode provider remove/keep/rename per OQ6) + V15. FIXED (OQ6 is gate blocker).

## Checks passed

- SC-2 keystone `global/index.ts:7` verified — single-line `const app = "opencode"` drives all XDG paths. ✓
- SC-3 Flag namespace `flag/flag.ts:13` verified — ~35 `OPENCODE_*` members listed normatively in req 3. ✓
- Direct `process.env.OPENCODE_*` reads outside Flag enumerated (config.ts, share-next.ts, pty/index.ts, thread.ts, worker-persona-hook.ts, run.ts). ✓
- Binary rename `packages/opencode/bin/opencode` → `bin/fbh` + `package.json` bin/name — reqs 6–7. ✓
- Schema URLs 64 occurrences categorized (config/tui/theme schemas, docs, API hosts, OAuth, referer, prompts) — reqs 8–11. ✓
- CC-8 schema URL conditionality on OQ1 — both branches (owned → foxybear.ai; not owned → self-host bundle) specified. ✓
- Internal host reconciliation (`run.ts:729` opencode.internal → foxybear.internal) — req 12, CC-9. ✓
- DB filename `storage/db.ts:33,35` + `index.ts:112` — req 13. ✓
- Brew tap + install URLs — req 15. ✓
- User agent + `x-fbh-client` header — req 16. ✓
- Static sweep V11 updated to reflect OQ6 exception for `OPENCODE_API_KEY`. ✓
- Idempotent (V16). ✓
