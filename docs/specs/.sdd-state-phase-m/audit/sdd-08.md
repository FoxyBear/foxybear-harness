# Re-Audit Report: SDD-08 Verification (M-6, council-amended)
**Auditor:** Fresh-context adversarial agent (re-audit post council re-sequencing)
**Date:** 2026-09-21
**Spec:** `260921_fbh-phase-m_sdd-08-verification.md` (revised 2026-09-22 per council)
**Master:** `260921_fbh-phase-m_sdd-00-master.md` (SC-11 aborts A7/A8, SC-12 corpus, CC-11 pre-registration)

## Method

Read the revised SDD-08 spec end-to-end, cross-checked the 8 audit criteria against the spec body, and reconciled each against the master spec (SC-11 abort table lines 139-140, dependency diagram lines 178-187, CC-11 line 70, council summary lines 13-27). Verified the prior audit (`sdd-07-verification.md` in this directory) carried forward cleanly under re-sequencing (sdd-07 → sdd-08, M-6 now before M-5, sdd-09 deferred).

## Criterion-by-criterion verification

### (1) M-6 runs BEFORE M-5 (re-sequenced) — PASS

Re-sequencing is stated five times in the spec, each consistent with the master:

- **Line 3:** "Date: 2026-09-21 (revised 2026-09-22 per council re-sequencing)"
- **Line 7 (header):** "NOT sdd-09 (M-5 conflict) — sdd-09 depends on this spec (re-sequenced per council: M-6 runs before M-5). Owns the verification of the workstream and produces the contradiction-rate evidence that sdd-09 consumes to decide whether to activate."
- **Line 9 (body):** "Per council re-sequencing, M-6 runs BEFORE M-5 (sdd-09). If the contradiction rate is below the pre-registered threshold (req 16), abort A8 fires and M-5 is deferred indefinitely."
- **Line 65 (section heading):** "Contradiction-rate measurement (re-sequenced per council — M-6 produces evidence for M-5)"
- **Line 115 (VERIFY):** "sdd-09 / M-5 is deferred to post-M-6 per council re-sequencing — sdd-09 depends on this spec, not the other way around"

Master confirms at line 189: "M-6 (sdd-08) runs before M-5 (sdd-09) — M-6 produces the evidence M-5 consumes." Master dependency diagram (lines 185-186) shows `sdd-08 → sdd-09`, not the reverse. PASS.

### (2) Contradiction-rate measurement WHEN/SHALL — PASS

Req 16 (line 67) is in proper WHEN/SHALL form and measures exactly what criterion 2 requires:

> **WHEN** M-6 measures the contradiction rate in the corpus, the benchmark **SHALL** ingest the corpus through the M-2 auto-capture pipeline (sdd-05) and, for each new memory written, check whether it contradicts an existing memory via cosine-similarity candidate retrieval (threshold 0.30, the midpoint of the sweep in req 8) followed by an LLM-judge confirmation (same provider, greedy decoding, prompt: "Does this new memory contradict the existing memory? Reply YES/NO with severity minor/moderate/severe."). The benchmark **SHALL** compute: (a) the contradiction rate (fraction of new memories that contradict an existing memory); (b) the contradiction severity distribution (minor / moderate / severe counts); (c) the per-project breakdown.

- **WHEN clause:** "M-6 measures the contradiction rate in the corpus" — clear trigger.
- **SHALL clauses:** three concrete measurements (rate, severity distribution, per-project breakdown) plus output file requirement.
- **Measures how often new content contradicts existing:** "fraction of new memories that contradict an existing memory" — exact.
- **Produces evidence for M-5:** "This evidence is consumed by sdd-09 (M-5) to decide whether to activate conflict detection." (line 67, final sentence).

V12 (line 128) verifies this with a concrete action: "run the benchmark's contradiction-rate mode against the corpus" and asserts the JSON exists with (a) rate, (b) severity, (c) per-project breakdown. PASS.

### (3) Activation threshold for M-5 (5% per CC-11 pre-registration) — PASS

The 5% threshold is pre-registered in both WHAT and VERIFY, with explicit CC-11 anchor:

- **Req 16 (line 67):** "The pre-registered activation threshold (per CC-11): if the contradiction rate is below 5%, abort A8 fires and M-5 is deferred indefinitely per SC-11. If the contradiction rate is ≥ 5%, sdd-09 (M-5) has evidence to activate."
- **V12 (line 128):** "If the contradiction rate is below 5% (pre-registered threshold per CC-11), flag `M5_DEFERRED_A8` and the spec SHALL record that sdd-09 (M-5) is deferred indefinitely per SC-11 A8. If the contradiction rate is ≥ 5%, the spec SHALL record that sdd-09 (M-5) has evidence to activate."

Master CC-11 (line 70): "Every spike, probe, and abort criterion SHALL have its thresholds pre-registered in this spec suite BEFORE results exist." The 5% threshold is written into the spec now, not after measurement — satisfies CC-11. PASS.

### (4) Abort A7 (schedule slip >45 days without provisional evidence = descope review) — PASS

Req 17 (line 71) is in proper WHEN/SHALL form with all required elements:

> **WHEN** the schedule slips beyond ~45 elapsed days from the M-6 implement stage start without provisional M-6 value evidence — defined as at least one results JSON from reqs 4–6 or 16 showing a non-trivial signal (injection A/B positive delta on Faithfulness, relational A/B hypergraph Recall@5 ≥ KV Recall@5, or contradiction-rate measurement completed with a written result) — the spec **SHALL** fire abort A7 (mandatory descope review, default stop) per SC-11.

- **Trigger:** "> ~45 elapsed days" — matches master SC-11 A7 (line 139).
- **Provisional evidence definition:** three concrete signals enumerated (injection A/B positive Faithfulness delta, relational A/B hypergraph Recall@5 ≥ KV Recall@5, contradiction-rate measurement completed with a written result) — operationally measurable, not vague.
- **Fallback:** "mandatory descope review, default stop" — matches master SC-11 A7 fallback.
- **Audit trail:** "Provisional value evidence SHALL be logged to the decision log as it arrives so the A7 clock is auditable." (line 71, final sentence).

V12 (line 128) explicitly handles the A7 clock: "The A7 clock (req 17) SHALL be considered satisfied by completion of this measurement, regardless of the A8 decision." V10 (line 126) requires the results doc to record "the A7 schedule-slip status (elapsed days since M-6 implement start, provisional value evidence log)". Both VERIFYs cover req 17. PASS.

### (5) Dependency on sdd-01-07 (NOT sdd-09) — PASS

- **Line 7 (header):** "Depends on: sdd-01, sdd-02, sdd-03, sdd-04, sdd-05, sdd-06, sdd-07 (all prior phases). NOT sdd-09 (M-5 conflict) — sdd-09 depends on this spec..."
- **Line 115 (VERIFY):** "This VERIFY is meta: it is the verification of the workstream, gated on sdd-01 through sdd-07 having shipped (sdd-09 / M-5 is deferred to post-M-6 per council re-sequencing — sdd-09 depends on this spec, not the other way around)."

The pre-calibration of sdd-09's conflict cosine threshold (req 8, line 45) does NOT create a dependency on sdd-09 shipping — it's a spike that produces a recommended value for sdd-09 to consume if it activates. Spec explicitly handles this: "If sdd-09 is deferred (abort A8, per req 16), the selected threshold is recorded as a recommended value for future use." (line 45).

Master dependency diagram (lines 178-187) shows sdd-08 as a child of sdd-04 with sdd-09 as a child of sdd-08 — direction is `sdd-08 → sdd-09`, not reverse. PASS.

### (6) AgentMemBench caveat addressed (relational vs long-range verified independently) — PASS

- **Line 13 (Background):** "M-6 MUST verify both axes independently: relational queries where the hypergraph should win, AND long-range recall where KV should win (verifying the hypergraph does not regress it). The benchmark is not 'does the hypergraph beat KV on everything' — it is 'does the hypergraph add relational value without regressing long-range recall.'"
- **Req 5 (line 35, relational A/B):** Hypergraph MUST outperform KV on Recall@5 for relational queries by ≥ 0.10. Failure flag: `RELATIONAL_REGRESSION`.
- **Req 6 (line 39, long-range regression guard):** Hypergraph MUST NOT regress KV on long-range Recall@5 by more than 0.05. Failure flag: `LONG_RANGE_REGRESSION`. Explicit caveat enforcement: "This enforces the AgentMemBench caveat: graph is for relational reasoning, not bulk recall."
- **V3 (line 119):** Verifies relational A/B with `RELATIONAL_REGRESSION` flag.
- **V4 (line 120):** Verifies long-range regression guard with `LONG_RANGE_REGRESSION` flag.

Two axes verified independently with opposite failure modes (one requires hypergraph to WIN, the other requires hypergraph to NOT REGRESS). The spec does NOT naively expect the hypergraph to beat KV on everything. Matches master line 61: "AgentMemBench caveat: graph is for relational reasoning, not long-range recall. M-6 verifies both axes independently." PASS.

### (7) Live smoke test (real fbh binary, real provider) — PASS

- **Req 11 (line 53):** "the system **SHALL** boot the real `fbh` binary (via `bun link` + the `fbh` CLI command, per SC-10) against real XDG paths (`~/.local/share/foxybear/`, `~/.config/foxybear/`), with SurrealDB serving `~/.local/share/foxybear/memory-server` (CC-10), the scheduler enabled (CC-8), and a real LLM provider configured in `fbh.json`. No request mocking. No in-process substitution (CC-5)."
- **Req 12 (line 55):** "the smoke test **SHALL** drive a real LLM session through `HeadlessSession.run` at `src/daemon/headless.ts:42`" — 4-turn session with assertions 12a-12d.
- **Req 13 (line 57):** Smoke checklist at `~/.local/share/foxybear/bench/<timestamp>-smoke.md` with PASS/FAIL/SKIP per row, evidence, and duration. A SKIPPED row (12d when M-5 deferred per A8) does not fail the spec.
- **V9 (line 125):** Concrete action: `bun link` + `fbh serve --background`; wait on `/health` (200); run 4-turn session; query `node`, `hyperedge`, `event` tables post-session. Expected: smoke checklist shows PASS for 12a-12c, with 12d PASS or SKIP per M-5 status.

Real binary (via `bun link`), real XDG paths, real SurrealDB, real scheduler, real LLM provider, no mocks, no in-process substitution. The 12d SKIP handling for the A8-deferred case is correctly specced — the smoke test must not fail just because M-5 was deferred. PASS.

### (8) WHAT↔VERIFY 1:1 — PASS

Every WHAT has a corresponding VERIFY test. Mapping:

| WHAT | VERIFY | Coverage |
|---|---|---|
| 1 — bench harness, 7 metrics | V1 | Full |
| 2 — real provider, deterministic, records metadata | V1 | Full |
| 3 — results JSON, ±1% reproducibility | V1 | Full |
| 4 — injection A/B, ≥30 queries, Wilcoxon, `INJECTION_NO_GAIN` | V2 | Full |
| 5 — relational A/B, hypergraph beats KV by ≥0.10, `RELATIONAL_REGRESSION` | V3 | Full |
| 6 — long-range guard, hypergraph within 0.05 of KV, `LONG_RANGE_REGRESSION` | V4 | Full |
| 7 — decay tune (4 params) | V5 | Full |
| 8 — conflict cosine tune, grid `[0.20,0.25,0.30,0.35,0.40]`, FP<10% + TP≥0.60 | V6 | Full |
| 9 — packing budget tune, grid `[512,1024,2048,4096]`, F1 minus footprint penalty | V7 | Full |
| 10 — semantic-shift tune, grid `[0.10,0.15,0.20,0.25,0.30]`, precision ≥0.80 + recall ≥0.80 | V8 | Full |
| 11 — live smoke: real binary, real XDG, SurrealDB, scheduler, real provider, no mocks | V9 | Full |
| 12 — 4-turn session, asserts 12a-12d | V9 | Full |
| 13 — smoke checklist at `~/.local/share/foxybear/bench/<ts>-smoke.md`, PASS/FAIL/SKIP per row | V9 | Full |
| 14 — results doc at `docs/research/260922_fbh-phase-m_benchmark.md`, all sections (a-i) | V10 | Full |
| 15 — green suite: `bun run typecheck` + `bun test --timeout 30000` from `packages/fbh`, no mocks | V11 | Full |
| 16 — contradiction-rate measurement, 5% A8 threshold | V12 | Full |
| 17 — A7 abort, >45 days without provisional evidence | V10 (A7 status in results doc) + V12 (A7 clock satisfied by contradiction-rate completion) | Full |

17 WHATs covered by 12 VERIFYs. V1 covers reqs 1-3 (three facets of the harness contract — single coherent testable unit), V9 covers reqs 11-13 (three facets of the smoke test — single coherent testable unit), V12 covers reqs 16-17 (contradiction-rate measurement completes the A7 clock per req 17's own definition of provisional value evidence). The mapping is many-to-one in three cases but every WHAT is covered by at least one VERIFY with concrete action and expected outcome. This matches the prior audit's interpretation of "1:1" as "every WHAT has a corresponding VERIFY test" (prior sdd-07 audit, line 98: "All 15 WHATs map to V1–V11. PASS."). PASS.

## Blocking issues

None. All 8 audit criteria pass.

## Non-blocking observations

1. **SC-12 corpus wording imprecision in V12.** V12 (line 128) says "minimum 50 sessions or 4 weeks of M-0 telemetry, whichever is larger". Master SC-12 (line 148) says "Minimum 50 sessions OR 4 weeks of M-0 telemetry, whichever produces more turns." V12's "whichever is larger" is ambiguous (larger in sessions? turns? time?) where the master is precise ("whichever produces more turns"). Intent is clear — use the corpus that produces more turns — but an implementer reading V12 alone might pick by session count or by time rather than by turn count. Recommend aligning V12 to "whichever produces more turns" to match SC-12 verbatim.

2. **A8 trigger operationalization vs master SC-11 wording.** Master SC-11 A8 (line 140) trigger: "No contradiction evidence after 2 weeks production". SDD-08 req 16 operationalizes this as "contradiction rate below 5%". These are compatible — SDD-08 is more precise (a 5% threshold is pre-registered per CC-11, where the master's "no contradiction evidence" is vague) and uses a longer corpus window (V12's "4 weeks of M-0 telemetry" vs master's "2 weeks production"). The 5% threshold IS the operationalization of "no contradiction evidence" and is pre-registered, satisfying CC-11. Noting the wording divergence for the record; not blocking because the SDD-08 formulation is stricter than the master (longer window, quantitative threshold).

3. **V12's "A7 clock satisfied by completion" is generous to the spec.** V12 (line 128) says "The A7 clock (req 17) SHALL be considered satisfied by completion of this measurement, regardless of the A8 decision." Req 17 lists "contradiction-rate measurement completed with a written result" as one of three provisional-value-evidence signals, so completing V12 does satisfy the A7 clock per req 17's own definition. But this means the A7 clock can be satisfied by merely completing the measurement even if the rate is 0% (no contradictions found, A8 fires, M-5 deferred). That's correct per the spec's logic (the measurement itself is value evidence — it answers the M-5 question, even if the answer is "don't build M-5"), but an implementer might expect A7 satisfaction to require a positive result. Recommend a one-line comment in V12 clarifying that the measurement's completion — not its outcome — is the A7 satisfaction signal, because the M-5 decision itself is the value.

4. **V1, V9, V12 each cover multiple WHATs.** As noted in criterion 8, V1 covers reqs 1-3, V9 covers reqs 11-13, V12 covers reqs 16-17. This is acceptable because each group is a single coherent testable unit (harness contract, smoke test, contradiction measurement), but a strict "one VERIFY per WHAT" reading would split V1 into V1a/V1b/V1c, etc. The prior audit accepted the grouped mapping; this re-audit does too. Noting for future audit convention consistency.

5. **12d SKIP semantics correctly handled.** Req 12d (line 55) and V9 (line 125) both correctly handle the A8-deferred case: if sdd-09 is deferred, 12d is SKIPPED, not FAILED. Req 13 (line 57) and V9 (line 125) both state "A SKIPPED row does not fail the spec." This is internally consistent and correctly implements the M-5-deferred post-M-6 path. No issue, noting as a positive consistency check.

6. **Pre-calibration of sdd-09 threshold (req 8) is consistent with "sdd-09 depends on sdd-08".** Req 8 (line 45) tunes `memory.conflict.cosine_threshold` even though sdd-09 hasn't shipped. The spec frames this as "pre-calibration" producing a "recommended value for sdd-09 to consume if it activates." This does NOT create a dependency on sdd-09 shipping (the threshold is a config value, not a service) and correctly inverts the dependency direction: sdd-09 consumes sdd-08's pre-calibrated value when it activates. The "recommended value for future use" fallback (line 45) handles the A8-deferred case cleanly. No issue.

VERDICT: PASS

All 8 audit criteria pass:

1. M-6 before M-5 re-sequencing stated 5 times in spec, consistent with master.
2. Contradiction-rate measurement (req 16) in proper WHEN/SHALL form, measures rate of new content contradicting existing, explicitly produces evidence for M-5.
3. 5% activation threshold pre-registered per CC-11 in both req 16 (WHAT) and V12 (VERIFY).
4. Abort A7 (req 17) correctly fires at >45 days schedule slip without provisional evidence, with mandatory descope review fallback matching master SC-11 A7.
5. Dependency on sdd-01 through sdd-07 explicit in header and VERIFY; NOT sdd-09; sdd-09 depends on this spec (pre-calibration does not invert the direction).
6. AgentMemBench caveat addressed: relational A/B (req 5 / V3, hypergraph must WIN by ≥0.10) and long-range regression guard (req 6 / V4, hypergraph must NOT REGRESS by >0.05) verified independently with opposite failure modes.
7. Live smoke test (reqs 11-13 / V9) uses real `fbh` binary via `bun link`, real XDG paths, real SurrealDB, real scheduler, real LLM provider, no mocks, no in-process substitution (CC-5). 12d SKIP for A8-deferred case correctly handled.
8. WHAT↔VERIFY mapping: all 17 WHATs covered by V1-V12 with concrete actions and expected outcomes.

No blocking issues. Six non-blocking observations are minor spec-clarity improvements (SC-12 corpus wording, A8 wording divergence, A7 clock satisfaction comment, V1/V9/V12 grouping, 12d SKIP semantics, pre-calibration framing) that the implementer can address during the `implement` stage without re-audit. The spec is ready for the human gate.
