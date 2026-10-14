# FINAL Re-Audit: SDD-01 (P-0 Dormant-Code Audit)

**Date:** 2026-09-21
**Auditor:** fbh (independent re-audit pass, post-fix)
**Spec under audit:** `260921_fbh-phase-m_sdd-01-dormant-code-audit.md`
**Fix scope:** Add WHAT #21 (typecheck gate) + WHAT #22 (test suite gate); V21 references #21, V22 references #22; WHAT↔VERIFY mapping 1:1.
**Prior audit:** Replaced by this FINAL re-audit.

---

VERDICT: PASS

All 4 fix elements verified. No regressions detected in the WHAT, HOW, VERIFY, or anchor-verification sections.

---

## Fix verification

### 1. WHAT #21 (typecheck gate) — added — PASS

**Location:** lines 98–100, under new subsection `### Audit harness gates (CC-4)`.

**Text:** "WHEN the audit harness files are added under `packages/fbh/test/p0_audit/` (the test files, fixture loaders, and any helper utilities), the audit SHALL run `bun run typecheck` from `packages/fbh` and the harness SHALL pass with exit 0 (CC-4). No new type errors SHALL be introduced by the audit harness. A typecheck failure in the harness files SHALL be filed as a process defect and SHALL block the verdict until the harness is corrected."

**Check:** Present, correctly numbered #21, gates on `bun run typecheck` from `packages/fbh`, cites CC-4. ✓

### 2. WHAT #22 (test suite gate) — added — PASS

**Location:** line 102, same subsection.

**Text:** "WHEN the audit harness files are added, the audit SHALL run `bun test test/p0_audit/ --timeout 60000` from `packages/fbh` and the harness SHALL exit 0 (CC-4). The harness records observed behavior for every input — it does NOT assert spec correctness (that's the audit's job in the decision log). All 11 component audit files SHALL execute; every component's ≥10 inputs SHALL run (some may be documented skips — those still execute and record the skip behavior). A harness-level test failure (e.g., a fixture fails to load, a component import resolves to `undefined`) SHALL block the verdict until the harness is corrected; component-level behavioral defects are recorded in the decision log, not as test failures."

**Check:** Present, correctly numbered #22, gates on `bun test test/p0_audit/ --timeout 60000` from `packages/fbh`, cites CC-4, correctly distinguishes harness-level failures (block verdict) from component-level defects (decision log). ✓

### 3. V21 references #21 — PASS

**Location:** VERIFY table row at line 233.

**Row:** `| V21 | #21 (typecheck gate) | Audit harness files added under packages/fbh/test/p0_audit/. | Run bun run typecheck from packages/fbh. | Exit 0. The audit harness files pass typecheck. No new type errors. |`

**Check:** V21 explicitly references `#21 (typecheck gate)`, setup/action/expected align with WHAT #21. ✓

### 4. V22 references #22 — PASS

**Location:** VERIFY table row at line 234.

**Row:** `| V22 | #22 (test suite gate) | Audit harness files added. | Run bun test test/p0_audit/ --timeout 60000 from packages/fbh. | All 11 component audit files run. Every component's ≥10 inputs execute (some may be documented skips — those still execute and record the skip behavior). Exit 0 for the audit harness itself; component-level defects are recorded in the decision log, not as test failures (the harness records observed behavior, it does not assert spec correctness — that's the audit's job, not the test suite's). |`

**Check:** V22 explicitly references `#22 (test suite gate)`, setup/action/expected align with WHAT #22, including the harness-vs-component-defect distinction. ✓

### 5. WHAT↔VERIFY 1:1 mapping — PASS

**WHAT count:** 22 items (#1–#22). Verified by enumerating the 11 component-coverage reqs (#1–#11), schema validation (#12), defect categorization (#13), two-engineer sign-off (#14, #15), decision log (#16), go/no-go verdict (#17), abort A0 (#18), workstream ordering (#19), no source modification (#20), typecheck gate (#21), test suite gate (#22).

**VERIFY count:** 22 items (V1–V22). Verified by enumerating the VERIFY table rows.

**Mapping (1:1 bijection):**

| V | WHAT | Topic |
|---|---|---|
| V1 | #1 | extractTurn |
| V2 | #2 | Consolidation.run |
| V3 | #3 | prune |
| V4 | #4 | autoRecall |
| V5 | #5 | formatForInjection |
| V6 | #6 | SurrealBackend.query |
| V7 | #7 | SurrealGraphBackend |
| V8 | #8 | graduateMemories |
| V9 | #9 | stale penalty |
| V10 | #10 | getPrunable |
| V11 | #11 | migrateFromSqlite |
| V12 | #12 | schema validation |
| V13 | #13 | defect categorization |
| V14 | #14 | non-authorship |
| V15 | #15 | sign-off |
| V16 | #16 | decision log |
| V17 | #17 | verdict |
| V18 | #18 | A0-abort |
| V19 | #19 | workstream ordering |
| V20 | #20 | no source modification |
| V21 | #21 | typecheck gate |
| V22 | #22 | test suite gate |

**Check:** Strict 1:1 bijection. No orphan WHATs, no orphan VERIFYs. ✓

---

## Regression check

### WHAT section (lines 44–102)

- #1–#20 unchanged from prior structure (component coverage, schema validation, defect categorization, two-engineer sign-off, decision log, verdict, A0-abort, workstream ordering, no-source-modification).
- New `### Audit harness gates (CC-4)` subsection (line 98) cleanly groups #21 + #22 under a labeled heading, matching the existing pattern (e.g., `### Workstream ordering` groups #19 + #20).
- No renumbering of #1–#20. No disturbance to existing cross-references (e.g., WHAT #17 references "WHAT #18 for the core list" — #18 is still abort A0; WHAT #18 lists the 7 core components — unchanged).

### HOW section (lines 104–205)

- No changes detected. Audit team, sample input strategy, schema validation, defect bucket assignment, two-engineer sign-off, decision log, core vs non-core classification, execution environment, test location, time budget — all unchanged.

### VERIFY section (lines 207–234)

- V1–V20 unchanged. V21 + V22 appended cleanly after V20.
- The "Acceptance criteria mapped 1:1 to WHAT" preamble (line 209) now holds true — the prior state had 20 WHATs and 20 VERIFYs (1:1), and the fix preserves 1:1 by adding #21/#22 alongside V21/V22.

### Build / regression gate (lines 236–245)

- The post-audit gate (`bun run typecheck` + `bun test test/p0_audit/ --timeout 60000`) now has corresponding WHAT + VERIFY entries (#21/V21, #22/V22). Prior state had the gate commands mentioned only in the trailing "Build / regression gate" section without corresponding WHAT/VERIFY rows; the fix closes that gap.

### Seams noticed (lines 247–257)

- No changes. The 8 seams (Consolidation.run anchor, extractTurn message shape, lockDir rebrand straggler, graph leg silent empty, getPrunable null accessed_at, stale penalty boundary, migrateFromSqlite entity/edge paths, recentSessionIds stub) are unchanged.

### Anchors verified (lines 259–298)

- No changes. The 29 verified anchors (consolidation.ts, recall.ts, surreal-backend.ts, graph/surreal-backend.ts, graduation.ts, memory.ts, backend.ts, graph/backend.ts, graph/types.ts, scheduler.ts) and 2 path checks (foxybear memory-server, absence of memory-migration-surreal.json marker) are unchanged.

---

## Blocking issues

None.

---

## Non-blocking observations

- The "Build / regression gate" section (lines 238–245) duplicates the V21/V22 commands. This is intentional — the section serves as a quick-reference for the auditor, while V21/V22 serve as the formal acceptance rows. No action needed.
- WHAT #22's wording ("the harness records observed behavior, it does not assert spec correctness — that's the audit's job in the decision log") is slightly verbose but correctly distinguishes the harness's role from the audit's role. No action needed.

---

## Final verdict

**PASS.** All 4 fix elements verified. WHAT↔VERIFY is strict 1:1 (22:22). No regressions in WHAT, HOW, VERIFY, seams, or anchors.
