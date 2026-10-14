# Re-Audit Report: SDD-00 Master (council-amended)

**Auditor:** Fresh-context adversarial agent (re-audit)
**Date:** 2026-09-21
**Subject:** `260921_fbh-phase-m_sdd-00-master.md` (revised 2026-09-22 per council deliberation)
**Scope:** (1) abort A0-A8 in SC-11 pre-committed + complete; (2) SC-1 (6+7) and SC-4 (4+3) subsetting correct; (3) CC-11/12/13/14/15 testable; (4) B4 data governance complete; (5) SC-12 probe contract matches sdd-04; (6) dependency re-sequencing; (7) council findings appendix counts.
**Prior audit:** PASS (B-1/B-2 fixed: SC-5 project_id signatures, GC_DELETED enum token). This audit re-runs on the council-amended version and adds the seven new verification axes.

---

## Summary

All seven audit axes pass. No blocking issues. The master spec is ready for the human gate.

| Axis | Verdict | Notes |
|---|---|---|
| (1) SC-11 abort A0-A8 | PASS | 9 aborts, all pre-committed with thresholds + fallbacks named; cross-reference to downstream specs verified |
| (2) SC-1/SC-4 subsetting | PASS | 6+7=13 node types, 4+3=7 hyperedge types; active types have producers+consumers+key fields; reserved types marked enum-only |
| (3) CC-11/12/13/14/15 testable | PASS | Each CC has a concrete assertion, fixture, or inspection procedure |
| (4) B4 data governance | PASS | 5 items complete; CC-12 has the 4 overlapping items + "no secrets" clause |
| (5) SC-12 matches sdd-04 | PASS | Corpus, labeling, 4 arms, decision rule, latency threshold, FP rate, verdict branches all map 1:1 |
| (6) Dependency re-sequencing | PASS | P-0→M-0→M-1→probe→{M-2→M-3→M-4} + {M-6→M-5} matches the question's expected order |
| (7) Council findings appendix | PASS | 9 incorporated, 1 rejected, 4 noted; all counts match the question's expected counts |

---

## (1) Abort A0-A8 in SC-11 — pre-committed and complete

**SC-11 table (master lines 130-140):** 9 rows (A0-A8). Each row carries: trigger, threshold, and fallback. The floor (line 142): M-0 + baseline-retrieval injection behind flag + telemetry ships regardless.

**Pre-committed verification (CC-11, master line 70):** "Every spike, probe, and abort criterion SHALL have its thresholds pre-registered in this spec suite BEFORE results exist." SC-11 is the registration artifact; thresholds are present in the spec text itself, not deferred.

**Cross-reference to downstream specs (each abort is implemented in its owning spec):**

| Abort | Master SC-11 threshold | Owning spec | Downstream req | Match |
|---|---|---|---|---|
| A0 | Core component non-functional AND repair > 2 engineer-days | sdd-01 | WHAT #18, V18 | ✓ |
| A1 | Dry-run mismatch, data loss, or sustained P95 > 10% over 48h | sdd-02 | WHAT #21, V19 | ✓ |
| A2 | Both array<record> AND junction miss P95 < 50ms at 10k on composite | sdd-03 | req 3a, V1 | ✓ |
| A3 | Probe fails relational: ΔMRR < +0.05 OR ΔRecall@5 < +0.05 OR CI lb ≤ 0 | sdd-04 | req 16 (FAIL branch) | ✓ |
| A4 | After 1 prompt-iteration: precision < 60%, recall < 40%, or secrets leakage | sdd-05 | W-27 | ✓ |
| A5 | After 2 tuning rounds: oscillation > 2 states or no convergence | sdd-06 | req 25 | ✓ |
| A6 | pack() P95 > 300ms unfixable | sdd-07 | CP-20 | ✓ |
| A7 | > ~45 elapsed days without provisional M-6 value evidence | sdd-08 | req 17 | ✓ |
| A8 | No contradiction evidence after 2 weeks production | sdd-09 | G4 | ✓ |

Every abort has a threshold and a pre-named fallback. Every fallback is non-zero (the floor + a degrade path). No abort leaves the program at zero.

**Verdict: PASS.** 9 aborts pre-committed; 9 cross-references resolve; floor holds.

---

## (2) SC-1 (6 active + 7 reserved) and SC-4 (4 active + 3 reserved)

### SC-1 — MAGE Node Types (master lines 90-108)

**Active (6):** `MESSAGE`, `ACTION`, `ERROR`, `MEMORY`, `PROCEDURE`, `ENTITY`. Each row has a Producer (M-2 TraceIngestor or M-1 backfill + M-2 extraction), a Consumer (M-4 context blocks or packing/lifecycle/scoring), and Key fields. ENTITY is explicitly "Expansion-input only — seeds Hypergraph.query; never packed" with conformance-test enforcement. ✓

**Reserved (7):** `TASK`, `AGENT`, `INSIGHT`, `MODALITY`, `COMMUNITY`, `ARCHETYPE`, `META_PROCEDURE`. Each row carries "(enum value only, no table)". `COMMUNITY`/`ARCHETYPE`/`META_PROCEDURE` annotate "L3/L4 deferred". ✓

**Count:** 6 + 7 = 13 MAGE node types. ✓

**CC-13 enforcement (master line 72):** "The 6 active node types... SHALL have tables, producers, consumers, and benchmark metrics. The 7 reserved node types... SHALL be enum values only — NO tables, NO extraction paths, NO packing paths. Activation requires a complete row (named producer, named consumer, named metric) audited to the same standard." ✓

**Downstream verification:**
- sdd-03 req 4 (WHAT): NodeType enum has 6 ACTIVE values + 7 RESERVED enum-only values; reserved types are "NOT Schema.Class exports — they are union members only." ✓
- sdd-05 W-1..W-6: TraceIngestor emits only the 6 active types. W-4 explicitly: "the hyperedge SHALL NOT link to an `AGENT` node (AGENT is reserved, enum-only, no table)." ✓
- sdd-05 §Out of scope (line 40-41): "The 7 reserved node types... — enum-only per CC-13, no tables, no extraction paths, no packing paths. Activation requires a complete producer+consumer+metric row audited to the same standard." ✓

### SC-4 — Hyperedge Types (master lines 110-120)

**Active (4):** `COLLABORATION`, `ERROR_CORRECTION`, `EVIDENCE`, `PROCEDURE`. Each row has a Producer (M-2 TraceIngestor or M-2 extraction) and Consumer (Relational expansion / Packing / Provenance / Step chaining). ✓

**Reserved (3):** `NARY_FACT`, `COMMUNITY_REPORT`, `GENERALIZES`. Each row carries "(enum value only, no table)". `COMMUNITY_REPORT` and `GENERALIZES` annotate "L3/L4 deferred". ✓

**Count:** 4 + 3 = 7 hyperedge types. ✓

**Downstream verification:**
- sdd-03 req 4: HyperedgeType enum has 4 ACTIVE + 3 RESERVED enum-only values. ✓
- sdd-03 §Backfill (req 23): `graph_edge` backfill defaults to `NARY_FACT` (reserved) — the backfill does NOT promote reserved types to active status; it uses the reserved enum value as a placeholder for the bi-temporal record. Acceptable: this is data migration, not new production writes via an active producer. ✓

**Verdict: PASS.** 6+7 and 4+3 counts correct; active rows complete (producer+consumer+key fields); reserved rows enum-only with no tables; downstream specs enforce.

---

## (3) CC-11/12/13/14/15 testable

| CC | Requirement (master lines 70-74) | Test procedure | Testable |
|---|---|---|---|
| CC-11 | Pre-registered instruments: thresholds pre-registered before results; raw results (failures included) into decision log | (a) Diff spec files vs results: spec timestamps predate result timestamps. (b) Verify decision log contains raw per-stratum/per-arm metric values, bootstrap CIs, latency P95, and verdict. sdd-04 V10 enforces this: "diff the thresholds in the decision log against SC-12... Any discrepancy fails the test (CC-11 violation)." | ✓ |
| CC-12 | Data governance: (a) secrets redaction with measured catch rate on seeded fixtures (5 secrets, zero leakage = pass); (b) explicit user opt-in default false; (c) data classes with data flow diagram; (d) self-hosted extraction fallback pre-named | sdd-05 has a `governance.test.ts` with `secrets_redaction`, `opt_in`, `data_classes_doc`, `self_hosted_fallback` test cases (VERIFY table lines 299-302). The redaction test loads a 5-secret fixture and asserts zero leakage via test-side provider wrapper. | ✓ |
| CC-13 | Schema subsetting: 6+4 active have tables/producers/consumers/metrics; 7+3 reserved enum-only; activation requires complete row | (a) Verify `DEFINE TABLE` exists for active types in sdd-03 V3. (b) Verify reserved types are union members only (no Schema.Class export) in sdd-03 V2. (c) Verify TraceIngestor (sdd-05) emits only active types. (d) Verify packer (sdd-07) consumes only active types. | ✓ |
| CC-14 | Two-engineer sign-off: two engineers who did NOT author the code; defect log categorized (broken/schema-violating/semantically-wrong/spec-divergent) | sdd-01 V14: `git blame -L <anchor>,<anchor> <file>` for each of 11 anchor lines; neither engineer appears as author. V15: both signatures present, tiebreaker signature present if any disputes. Single-engineer signature → V15 fails. | ✓ |
| CC-15 | Coupled-loop simulation: M-3 lifecycle spike SHALL test decay + graduation + conflict interaction, not isolated convergence | sdd-06 req 1: sim runs decay + graduation + conflict against 1000 synthetic memories across 1000 hourly iterations, with assertions (a)-(e) on bounded confidence, stable steady state, no resurrection. req 2: two tuning rounds, then abort A5 if oscillation > 2. The spike is in `test/fbh-phase-m/sdd-06-spike.test.ts`. | ✓ |

Each CC has at least one concrete test procedure with assertions, fixtures, or inspection steps. None requires subjective judgment.

**Verdict: PASS.** All 5 CCs are testable; each maps to specific VERIFY rows in the downstream specs.

---

## (4) B4 data governance complete

**B4 (master lines 80-86):** 5 items:

1. **Secrets-redaction filter with measured catch rate on seeded fixtures (5 secrets, zero leakage to DeepInfra = pass).** ✓ (sdd-05 W-21, `governance.test.ts::secrets_redaction`)
2. **Explicit user opt-in for external processing — `memory.extraction.external_opt_in` default false, not default-on.** ✓ (sdd-05 W-22, config default false; `governance.test.ts::opt_in`)
3. **Documented data classes with data flow diagram showing exactly what leaves the harness.** ✓ (sdd-05 W-23, `docs/specs/data-flow-extraction.md` with 4 required sections + data flow diagram; `governance.test.ts::data_classes_doc`)
4. **Provider retention review with written record of what DeepInfra retains.** ✓ (sdd-05 W-23(c) — included in the data-flow doc's "Provider retention policy" section)
5. **Self-hosted extraction fallback pre-named if provider terms fail.** ✓ (sdd-05 W-24, `memory.extraction.self_hosted_fallback_model = "ollama://qwen2.5:7b-instruct"`; `governance.test.ts::self_hosted_fallback`)

**CC-12 vs B4 overlap:** CC-12 (master line 71) has the 4 overlapping items (a)-(d) plus the closing sentence "No secrets (API keys, tokens, auth.json) SHALL be sent to the extraction LLM." B4 has the 5th item (provider retention review) that CC-12 lacks. The two clauses are consistent and complementary — B4 is the operational expansion of CC-12. Both are complete.

**Downstream verification:** sdd-05 implements all 5 B4 items as W-21 through W-24 (W-23 has 4 sub-items (a)-(d) including provider retention), with corresponding tests in `governance.test.ts`. sdd-05 line 14 explicitly: "This spec adds: secrets-redaction filter with measured catch rate (runs BEFORE content is sent to the extraction LLM), explicit user opt-in (`memory.extraction.external_opt_in` default FALSE, NOT default-on), documented data classes with a data flow diagram showing what leaves the harness, and a pre-named self-hosted extraction fallback if provider terms fail."

**Verdict: PASS.** All 5 B4 items present; CC-12 consistent; downstream sdd-05 implements and tests each item.

---

## (5) SC-12 probe contract matches sdd-04

**SC-12 (master lines 144-160) → sdd-04 (reqs 1-18) cross-check:**

| SC-12 element | Master line | sdd-04 req | Match |
|---|---|---|---|
| Corpus: 50 sessions OR 4 weeks M-0 telemetry, whichever produces more turns | 148 | req 3 | ✓ |
| Corpus exclusion: < 5 turns, memory disabled, < 10 turns per project | 148 | req 4 | ✓ |
| ≥ 2 distinct project_ids (cross-project isolation side effect) | 148 | req 3 | ✓ |
| Long-range stratum NOT scored until ≥ 48h temporal depth | 148 | req 6 (`NOT_SCORED_INSUFFICIENT_TEMPORAL_DEPTH`) | ✓ |
| Labeling: LLM-assisted, 20% human spot-check, rubric-consistency | 149 | reqs 7-9 | ✓ |
| Inter-rater agreement, Krippendorff's alpha < 0.7 → rubric fixed + relabeled | 149 | req 10 | ✓ |
| Query types: 30 relational, 30 long-range, 20 single-hop, 20 adversarial = 100 | 150 | req 7 | ✓ |
| Arm 1: Pure vector (baseline) | 151 | req 11 (surreal-backend.ts:217-225) | ✓ |
| Arm 2: Vector + 1-hop graph (existing hybrid) | 151 | req 11 (surreal-backend.ts:203-292) | ✓ |
| Arm 3: Vector + hypergraph traversal (proposed) | 151 | req 11 (vector seeds + SurrealHypergraphBackend.query/expand depth:2) | ✓ |
| Arm 4: Pure hypergraph (diagnostic, no vector seed, exact entity-match) | 151 | req 11 (regex extractor at extraction.ts:45, exact name match) | ✓ |
| Relational decision: ΔMRR ≥ +0.05 AND ΔRecall@5 ≥ +0.05, bootstrap CI lb > 0 | 153 | req 14 (1000 resamples, percentile method, 2.5th percentile) | ✓ |
| Long-range non-regression: ΔRecall@5 ≥ −0.01 AND ΔMRR ≥ −0.01 | 154 | req 15 | ✓ |
| Adversarial FP rate ≤ 20% (diagnostic, does not gate) | 155 | req 15 | ✓ |
| Latency: Arm 3 P95 ≤ 100ms on 10k-node/10k-hyperedge fixture | 156 | req 15, V7 (synthetic 10k/10k fixture in throwaway namespace) | ✓ |
| PASS both strata → M-2/M-3/M-4 as specced | 158 | req 16 (PASS branch) | ✓ |
| FAIL long-range only → query-type routing, retest once, else relational-only | 159 | req 16 (ROUTE branch → `PASS_WITH_ROUTING` or `RELATIONAL_ONLY`) | ✓ |
| FAIL relational → Terminal fallback A3: hypergraph retrieval abandoned | 160 | req 16 (FAIL branch → A3 consequences) | ✓ |

**Pre-registration linkage:** SC-12 references "SDD-04" in its heading (line 144). sdd-04 line 6 inherits "SC-11, SC-12, CC-4, CC-5, CC-9, CC-11" from the master. sdd-04 V10 enforces threshold match: "diff the thresholds in the decision log against SC-12 (master spec `260921_fbh-phase-m_sdd-00-master.md` lines 152–160)... Any discrepancy fails the test (CC-11 violation)."

**Note:** Master line 156 says "10k-node/10k-hyperedge fixture" (matching sdd-04 req 15). Master line 134 (A2) says "10k hyperedges" for the sdd-03 spike. The two 10k fixtures are different — A2 is a 10k-hyperedge spike on composite query at P95 < 50ms; SC-12 is a 10k-node AND 10k-hyperedge fixture at P95 ≤ 100ms. Both are pre-committed in their respective sections; no conflict.

**Verdict: PASS.** SC-12 and sdd-04 map 1:1 across all 19 elements (corpus, labeling, 4 arms, metrics, decision rule, latency, FP rate, verdict branches). sdd-04 V10 enforces the match at test time.

---

## (6) Dependency re-sequencing (P-0→M-0→M-1→probe→M-2/M-3/M-4→M-6→M-5)

**Master "Dependency (re-sequenced per council)" section (lines 173-189):**

```
sdd-01 (P-0 dormant-code audit)              [ABORT A0 if core component non-functional]
  └→ sdd-02 (M-0 wire-up)                      [under guardrails; ABORT A1 if P95 regression > 10%]
       └→ sdd-03 (M-1 hypergraph schema)        [subsetted 6+4; strengthened spike; ABORT A2 if perf fails]
            └→ sdd-04 (pre-registered probe)    [4-arm, 50-session corpus; ABORT A3 if relational stratum fails]
                 └→ sdd-05 (M-2 auto-capture)    [data governance; ABORT A4 if extraction quality unmet]
                 │    └→ sdd-06 (M-3 lifecycle)  [simple exponential default; coupled-loop sim; ABORT A5 if pathological]
                 │    │    └→ sdd-07 (M-4 packing) [probe-gated; ABORT A6 if pack P95 too high]
                 └→ sdd-08 (M-6 verification)     [produces contradiction evidence; ABORT A7 if schedule slips]
                      └→ sdd-09 (M-5 conflict)   [DEFERRED post-M-6; ABORT A8 if no contradiction evidence]
```

**Re-sequencing verification:**

| Expected order (question) | Actual in master | Match |
|---|---|---|
| P-0 | sdd-01 (P-0 dormant-code audit) | ✓ |
| → M-0 | sdd-02 (M-0 wire-up) | ✓ |
| → M-1 | sdd-03 (M-1 hypergraph schema) | ✓ |
| → probe | sdd-04 (pre-registered probe) | ✓ |
| → M-2 | sdd-05 (M-2 auto-capture) | ✓ |
| → M-3 | sdd-06 (M-3 lifecycle) | ✓ |
| → M-4 | sdd-07 (M-4 packing) | ✓ |
| → M-6 | sdd-08 (M-6 verification) | ✓ |
| → M-5 | sdd-09 (M-5 conflict) | ✓ |

**Branch structure:** From sdd-04 (probe), two branches:
- Left branch: sdd-05 → sdd-06 → sdd-07 (M-2 → M-3 → M-4, linear chain).
- Right branch: sdd-04 → sdd-08 → sdd-09 (M-6 → M-5).

**Gating rules (master line 189):**
- "The probe (sdd-04) gates sdd-05/sdd-06/sdd-07." ✓ (probe MUST PASS before M-2/M-3/M-4 implement)
- "M-6 (sdd-08) runs before M-5 (sdd-09) — M-6 produces the evidence M-5 consumes." ✓
- "M-5 is conditional on M-6 finding contradictions." ✓ (sdd-09 G1-G4 activation gate)

**Downstream verification:**
- sdd-05 line 9: "Depends on: SDD-04 (pre-registered retrieval-quality probe — relational stratum MUST PASS per SC-12 before M-2 starts; transitive: SDD-03 M-1 hypergraph schema, SDD-02 M-0 wire-up, SDD-01 P-0 dormant-code audit)." ✓
- sdd-06 line 8: "Depends on: `sdd-02`... `sdd-03`... `sdd-04` (pre-registered retrieval-quality probe: must PASS — gates sdd-05/sdd-06/sdd-07 per master SC-12), `sdd-05` (M-2 auto-capture: access events...)." ✓
- sdd-07 line 6: inherits "SC-12 probe"; line 13: "M-4 SHALL NOT proceed to implementation until SDD-04 (the pre-registered retrieval-quality probe) has PASSED." ✓
- sdd-08 line 15: inherits "SC-11 (abort criteria A7, A8)"; produces "contradiction-rate measurement result... and the A8 decision (defer M-5 or activate M-5)." ✓
- sdd-09 line 12: "M-5 is deferred to post-M-6... M-6 (sdd-08) produces the contradiction-rate evidence M-5 consumes... The sdd-09 `implement` stage SHALL NOT proceed until sdd-08's `tests` stage has passed AND sdd-08 has measured a contradiction rate at or above the activation threshold." ✓

**Verdict: PASS.** Re-sequencing matches the question's expected order exactly: P-0→M-0→M-1→probe→{M-2/M-3/M-4}→M-6→M-5. Gating rules (probe gates M-2/M-3/M-4; M-6 gates M-5) enforced in the dependency diagram and in each downstream spec's "Depends on" header.

---

## (7) Council findings appendix (9 incorporated, 1 rejected, 4 noted)

### Incorporated (master lines 193-203)

| # | Item | Verified in master |
|---|---|---|
| 1 | P-0 dormant-code audit (new spec sdd-01) | §Scope SDD-01 (line 39); CC-14 (line 73); SC-11 A0 (line 132) |
| 2 | Schema subsetting (6+4 active, 7+3 reserved enum-only) | SC-1 (lines 90-108); SC-4 (lines 110-120); CC-13 (line 72) |
| 3 | Pre-registered retrieval-quality probe (new spec sdd-04) | §Scope SDD-04 (line 42); SC-12 (lines 144-160); SC-11 A3 (line 135) |
| 4 | M-5 deferred to post-M-6 (re-sequenced) | §Scope SDD-09 (line 47); Dependency (line 186); SC-11 A8 (line 140) |
| 5 | Data governance B4 (secrets redaction, opt-in, data classes, self-hosted fallback) | B4 (lines 80-86); CC-12 (line 71) |
| 6 | Abort criteria A0-A8 (pre-committed in SC-11) | SC-11 (lines 126-142) |
| 7 | OQ5: access_count >= 2 default, semantic-shift shadow, force-promote at 5 | §Key decisions (line 56); OQ table (line 222) |
| 8 | Decision 3: simple exponential + rehearsal default, Prism experimental behind flag | §Key decisions (line 55); OQ table (line 224) |
| 9 | Coupled-loop simulation replacing isolated convergence spike (CC-15) | CC-15 (line 74); §Scope SDD-06 (line 44) |

**Count: 9.** ✓ (matches question's expected count)

### Rejected (master lines 205-207)

- **MAGE citation fabrication claim.** Skeptic (Kimi) claimed arXiv:2608.29678 fabricated. Verified FALSE — paper exists ("Diachronic Hypergraphs for Orchestrated Multi-Agent Multimodal Memory Curation" by Yichao Feng et al., submitted 30 Aug 2026, cs.DB). GitHub reference impl (github.com/Githubuseryf/MAGE) real. Schema code (nodes.py, hyperedges.py) real. Citation stands.

**Count: 1.** ✓ (matches question's expected count)

### Noted but not addressed (master lines 209-214)

| # | Item | Disposition in master | Disposition in downstream |
|---|---|---|---|
| 1 | Extraction entity hallucination rate | "Added to M-2 spike criteria." | sdd-05 W-19 (measures hallucination rate separately from precision) |
| 2 | Initial-confidence policy | "Added to M-2." | sdd-05 W-25 (provenance class: 0.7 tool / 0.5 LLM) |
| 3 | SurrealDB version pin | "Added to M-1 (SC-9)." | sdd-03 line 16 ("SurrealDB version pin: pin the version + add a migration test on upgrade.") |
| 4 | User-facing disclosure | "Added to M-2 (data governance)." | sdd-05 W-26 (CLI startup message when extraction enabled against external provider) |

**Count: 4.** ✓ (matches question's expected count)

**Naming note:** The section heading is "Noted but not addressed (council's 'Part X' gaps)". Each item's body says "Added to M-..." — i.e., the items ARE addressed in downstream specs, not in the master itself. The heading is consistent if read as "noted in the master but addressed in downstream specs." Non-blocking; no reader who reaches the appendix body will be misled.

**Council deliberation summary (master lines 13-27) consistency:** The summary lists 9 incorporated items (lines 17-25) and 1 rejected item (line 27). The 9 in the summary match the 9 in the appendix. ✓

**Verdict: PASS.** 9 incorporated + 1 rejected + 4 noted = 14 council findings total. All counts match. Each incorporated item has a corresponding spec section or downstream spec; each noted item has a downstream home; the rejected item is verified false with a concrete citation.

---

## Non-blocking observations

These do not block the human gate. Listed for completeness.

1. **`Consolidation.run` line drift.** The master §Architecture (line 33) cites `consolidation.ts:533` for `Consolidation.run` (the verified correct line, post-P-0 audit). The earlier research doc and original master cited `:362` (which is `consolidate`, a different function). The master has been corrected. sdd-01 §Seams (line 243), sdd-03 (no comment), sdd-05 §Seams (line 315) all flag the same drift. The master's current `:533` citation is correct. ✓

2. **Reserved type naming convention.** SC-1 uses `META_PROCEDURE` (with underscore) as the enum value, while sdd-03 req 4 lists `MetaProcedureNode` (PascalCase) as the Schema.Class name. This is consistent (the enum value is `META_PROCEDURE`; the schema class name is `MetaProcedureNode` — enum values map to schema class names by convention). No conflict.

3. **"Noted but not addressed" heading.** The 4 items in this section ARE addressed in downstream specs (each body says "Added to M-X"). The heading reads as "noted in the master, addressed in downstream specs." Non-blocking; reader who reaches the body sees the dispositions.

4. **Prior audit's non-blocking items.** The first audit (lines 62-66 in the prior audit file) flagged 12 non-blocking items, of which item 1 (date typo on line 6) was fixed. The remaining 11 (memory.ts:296 anchor imprecision, graph/surreal-backend.ts:109,125,127 imprecision, SC-8 backfill defaults, CC-2 "dormant" framing, dependency diagram indentation, CC-10 framing, MAX_PER_SOURCE undefined, SC-5 undefined types, research/workstream path ambiguity, SC-1 source_nodes semantics) remain unaddressed. None block the gate; they are inherited by the downstream specs' own audits.

5. **Architecture diagram (if present).** The prior audit flagged an architecture diagram with `ConflictDetector.check(content, neighbors)` (should be `(content, project_id)`) and `DELETE (soft-delete + INVALIDATES edge)` (should be `+ INVALIDATE event` per SC-3). The current master spec does not contain a diagram in the audited region; the prior diagram appears to have been removed or restructured in the council-amended version. Non-blocking; no diagram means no diagram inconsistency.

---

VERDICT: PASS

All seven audit axes pass. The master spec's council amendments (P-0 audit insertion, schema subsetting, pre-registered probe, M-5 deferral, B4 data governance, A0-A8 abort criteria, OQ5 graduation default, Decision 3 decay model, CC-15 coupled-loop sim) are all internally consistent and cross-reference correctly to their owning downstream specs (sdd-01 through sdd-09). The 9 abort thresholds in SC-11 are pre-committed in spec text, complete (trigger + threshold + fallback per row), and implemented in their owning specs. SC-1 (6+7) and SC-4 (4+3) subsetting is correct and enforced by CC-13. CC-11/12/13/14/15 are each testable with concrete procedures. B4 has all 5 items. SC-12 matches sdd-04 1:1 across 19 elements. The dependency re-sequencing matches the question's expected order. The council findings appendix has the expected 9+1+4 counts. The master is ready for the human gate.
