# SDD Audit Report — sdd-00 (master)

**Date:** 2026-09-18
**Auditor:** Katya (self-audit — subagent infra unreliable tonight; disclosed in SDD-00 §Process honesty note and the combined audit at `sdd-00-master.md`)
**Spec:** `260918_fbh-rebrand_sdd-00-master.md`

## Fresh-context re-audit (2026-09-18) — corrections applied

### Seam 1: SC-3 env var count — FIXED
- **Blocker:** SC-3 claimed "~35 `OPENCODE_*` env vars"; codebase has ~71 distinct (~54 in flag.ts). Undercount propagated to SDD-03 req 3's "complete set" (missed 28 vars).
- **Fix:** SC-3 rewritten to cite the re-audit count (~71 distinct, ~54 in Flag) and point to SDD-03 req 5's grep as the normative complete-set source. FIXED.

### Seam 5: SC-7 exhaustiveness — FIXED (data-loss)
- **Blocker:** SC-7 was a one-paragraph deferral to research; the research inventory omitted `~/.local/state/opencode/` (SC-1 named it but SC-7 didn't) and `~/.local/share/opencode/storage/` (plan had it, research/SDD-04 dropped it). Both are user data.
- **Fix:** SC-7 rewritten as a 20-row exhaustive table with strategy per source, including the re-audit-found sources (state dir, storage, memory-backup, agent/mode/skill dirs). Exhaustiveness note added. FIXED.

## Verdict

VERDICT: PASS

## Blockers found and fixed

### B1 — Managed config dirs + MDM + well-known MISSING from SC-1 identity map
- **Anchor:** `packages/opencode/src/config/config.ts:64,68,73,78,1416,1417,1424`; `cli/cmd/providers.ts:302`.
- **Blocker:** SC-1 omitted `/Library/Application Support/opencode`, `/etc/opencode`, `OPENCODE_TEST_MANAGED_CONFIG_DIR`, `ai.opencode.managed`, `.well-known/opencode` (runtime-fetched).
- **Fix:** Added 5 rows to SC-1; SDD-03 reqs 17–18 added. FIXED.

### B2 — Opencode provider gap surfaced (new OQ6)
- **Anchor:** `models-snapshot.js:3` (`OPENCODE_API_KEY`); `provider/provider.ts:191,426,436,534,803,901,1702`.
- **Blocker:** The `opencode` SaaS provider (Zen/Go/share, `api.opencode.ai`) was unaddressed by the plan. New gate-blocker Open Question 6 added (remove/keep/rename). FIXED (OQ6 flagged for Todd).

## Checks passed

- Required master sections present: Architecture, Cross-Cutting, Security, Shared Contract (SC-1..SC-7), Glossary, Dependency. ✓
- Shared Contract resolves every cross-spec seam; master wins on conflict. ✓
- Open Questions flagged for gate (OQ1 foxybear.ai ownership, OQ2 SDK shim, OQ3 dirty tree, OQ4 branch name, OQ5 console pkgs, OQ6 opencode provider). ✓
- Process honesty note discloses self-audit compromise. ✓
