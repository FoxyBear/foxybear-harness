# FINAL Re-Audit: SDD-04 (Pre-Registered Retrieval-Quality Probe)

**Date:** 2026-09-21
**Auditor:** fbh (independent re-audit pass, post-fix)
**Spec under audit:** `260921_fbh-phase-m_sdd-04-retrieval-probe.md` (240 lines)
**Fix scope:** V10 now has 3 parts — (i) threshold-value diff against SC-12, (ii) timestamp ordering (registration timestamp precedes labeling/arms timestamps), (iii) no THRESHOLD_TAMPERING event. Verifies CC-11 pre-registration invariant.
**Prior audit:** Replaced by this FINAL re-audit.

---

VERDICT: PASS

All 3 parts of V10 are present and correctly verify the CC-11 pre-registration invariant. No regressions detected in WHAT, HOW, VERIFY, or other sections.

---

## Fix verification

### V10 location

**Line 238:** `- **V10 — pre-registration invariants (CC-11, reqs 1–2).**`

V10 is correctly labeled as verifying CC-11 and referencing reqs 1–2 (the pre-registration reqs).

### Part (i) — threshold-value diff against SC-12 — PASS

**V10 Action (i):** `diff the thresholds in the decision log against SC-12 (master spec 260921_fbh-phase-m_sdd-00-master.md lines 152–160)`

**V10 Expected (i):** `exact match — relational ΔMRR ≥ +0.05 AND ΔRecall@5 ≥ +0.05 with bootstrap CI lower bound > 0; long-range ΔRecall@5 ≥ −0.01 AND ΔMRR ≥ −0.01; adversarial FP rate ≤ 20%; latency P95 ≤ 100ms`

**Check:**
- Action explicitly references SC-12 and the master spec file with line numbers (152–160). ✓
- Expected enumerates all 5 thresholds that must match: relational ΔMRR ≥ +0.05, relational ΔRecall@5 ≥ +0.05, bootstrap CI lower bound > 0, long-range ΔRecall@5 ≥ −0.01, long-range ΔMRR ≥ −0.01, adversarial FP rate ≤ 20%, latency P95 ≤ 100ms. ✓
- These thresholds match WHAT #14 (relational stratum, lines 71–75), WHAT #15 (long-range stratum + adversarial + latency, lines 77–80), and WHAT #16 (decision rule, lines 84–88). ✓
- The diff is against the master spec (SC-12), not against this spec's WHAT section — this is the correct pre-registration invariant (thresholds must match the master, not be re-derived from this spec). ✓

**Part (i) PASS.** ✓

### Part (ii) — timestamp ordering (registration precedes labeling/arms) — PASS

**V10 Action (ii):** `read the decision log header's registration timestamp and compare it against the labeling-start timestamp and the first arm-run timestamp`

**V10 Expected (ii):** `the registration timestamp (when the rubric and thresholds were written into the decision log header per req 2) SHALL precede the labeling-start timestamp AND the first arm-run timestamp — proving the thresholds were pre-registered before any result existed`

**Check:**
- Action reads 3 timestamps: registration (from decision log header), labeling-start, first arm-run. ✓
- Expected asserts strict ordering: registration < labeling-start AND registration < first arm-run. ✓
- The ordering proves pre-registration: thresholds were written before any labeling or arm execution, so they could not have been adjusted based on observed results. ✓
- Cross-references req 2 (line 34): `WHEN the probe begins, the rubric and the thresholds SHALL be registered together — written into the decision log header BEFORE the corpus is labeled or any arm is run.` ✓
- Cross-references req 1 (line 32): thresholds `SHALL NOT be adjusted after any probe result exists.` ✓

**Part (ii) PASS.** ✓

### Part (iii) — no THRESHOLD_TAMPERING event — PASS

**V10 Action (iii):** `scan the decision log for any THRESHOLD_TAMPERING event`

**V10 Expected (iii):** `no THRESHOLD_TAMPERING event appears in the decision log — if one appears, the probe SHALL have been re-run from scratch with the original pre-registered thresholds (req 1), and the re-run's registration timestamp SHALL precede its labeling/arms timestamps`

**Check:**
- Action scans the decision log for `THRESHOLD_TAMPERING` events. ✓
- Expected asserts no such event appears (the happy path). ✓
- If a `THRESHOLD_TAMPERING` event DOES appear, the expected asserts the recovery path: re-run from scratch with original pre-registered thresholds (per req 1, line 32), AND the re-run's registration timestamp must precede its labeling/arms timestamps (i.e., the re-run is also pre-registered). ✓
- Cross-references req 1 (line 32): `Adjusting thresholds after results arrive SHALL be a spec violation, SHALL be recorded in the decision log as a THRESHOLD_TAMPERING event, and SHALL require the probe to be re-run from scratch with the original pre-registered thresholds.` ✓

**Part (iii) PASS.** ✓

### V10 failure condition

**V10 closing:** `Any discrepancy in (i), any timestamp ordering violation in (ii), or any un-re-run THRESHOLD_TAMPERING event in (iii) fails the test (CC-11 violation).`

**Check:** The failure condition is the disjunction of 3 sub-failures:
- (i) discrepancy in threshold values → fail
- (ii) timestamp ordering violation → fail
- (iii) un-re-run THRESHOLD_TAMPERING event → fail

This correctly implements CC-11 (pre-registration invariant): any of the 3 sub-failures is a CC-11 violation. ✓

### CC-11 pre-registration invariant verification

The 3 parts of V10 together verify the CC-11 pre-registration invariant:
- Part (i) verifies the thresholds are the pre-committed values (not adjusted).
- Part (ii) verifies the thresholds were committed BEFORE any results existed (temporal precedence).
- Part (iii) verifies no post-hoc threshold adjustment occurred (or if it did, the recovery path was followed).

**Check:** V10 fully verifies CC-11 pre-registration invariant. ✓

---

## Regression check

### WHAT section (lines 28–110)

- Reqs 1–20 unchanged. Pre-registration (1–2), corpus assembly (3–5), temporal depth (6), labeling (7–10), four arms (11–12), metrics (13–15), decision rule (16), decision log (17–18), style & quality (19–20) — all present and unchanged.
- Req 1 (line 32) still defines `THRESHOLD_TAMPERING` as the violation event and the re-run recovery. V10 part (iii) correctly references this.
- Req 2 (line 34) still defines the registration step (rubric + thresholds written to decision log header before labeling/arms). V10 part (ii) correctly references this.

### HOW section (lines 114–222)

- Steps 1–8 unchanged. Corpus assembly, labeling, temporary capture path, four arms, scoring, latency fixture, decision rule, decision log — all present and unchanged.
- Step 7 (decision rule, lines 179–189) still references the pre-committed decision rule from req 16. No change to the verdict logic (`PASS`, `PASS_WITH_ROUTING`, `RELATIONAL_ONLY`, `FAIL`).

### VERIFY section (lines 225–240)

- V1–V9 unchanged (lines 229–237).
- V10 (line 238) rewritten with the 3-part structure (i, ii, iii) as specified by the fix.
- V11 (line 239) — verdict produced — unchanged. Correctly blocks `sdd-05`/`sdd-06`/`sdd-07` until decision log exists with non-`FAIL` verdict.
- V12 (line 240) — green suite — unchanged. Correctly cites CC-4 and req 20.

### V10 cross-references

- V10 references `CC-11` (pre-registration invariant). ✓
- V10 references `reqs 1–2` (the pre-registration reqs). ✓
- V10 part (ii) references `req 2` (registration step). ✓
- V10 part (iii) references `req 1` (THRESHOLD_TAMPERING + re-run recovery). ✓
- V10 part (i) references `SC-12` and the master spec file `260921_fbh-phase-m_sdd-00-master.md` lines 152–160. ✓

All cross-references resolve correctly.

### Other sections

- Background (lines 15–24), Dependencies (line 9), What is explicitly NOT built (lines 204–209), Reuse map (lines 211–221) — all unchanged.

---

## Blocking issues

None.

---

## Non-blocking observations

- V10 is the longest VERIFY row in the spec due to the 3-part structure. This is appropriate — CC-11 is a critical invariant and the 3-part verification is thorough.
- The `THRESHOLD_TAMPERING` event is mentioned in V10 part (iii) and in WHAT req 1 (line 32). The decision log section (req 17, lines 92–103) does not explicitly list `THRESHOLD_TAMPERING` as a field in the decision log, but req 1 makes it clear that the event is recorded "in the decision log". This is consistent — the event is an entry in the decision log's narrative, not a separate field. No action needed.
- The 3-part structure of V10 is consistent with the audit's expectation that pre-registration invariants are verified at a granular level (value match, temporal precedence, no tampering). This is the strongest form of CC-11 verification.

---

## Final verdict

**PASS.** V10 has all 3 parts: (i) threshold-value diff against SC-12 with explicit line reference (152–160), (ii) timestamp ordering (registration precedes labeling-start AND first arm-run), (iii) no THRESHOLD_TAMPERING event (with re-run recovery path verified). The 3 parts together fully verify the CC-11 pre-registration invariant. No regressions in WHAT, HOW, VERIFY, or other sections.
