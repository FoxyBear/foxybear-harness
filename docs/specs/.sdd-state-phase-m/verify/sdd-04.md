# Verification Report: SDD-04 (Pre-Registered Retrieval-Quality Probe)

**Verifier:** Independent agent (fresh context)
**Date:** 2026-09-23
**Spec:** `docs/specs/260921_fbh-phase-m_sdd-04-retrieval-probe.md`
**Acceptance tests:** `packages/fbh/test/fbh-phase-m/sdd-04.test.ts`

## Verification summary

The SDD-04 probe has been run SIX times. The sixth run produced a **PASS** verdict — both the quality gate and the latency gate are met.

### Final verdict: PASS

**Quality gate (relational stratum):**
- ΔMRR = +0.0858 (≥ +0.05) ✓
- ΔRecall@5 = +0.0700 (≥ +0.05) ✓
- Bootstrap CI(ΔMRR) lower bound > 0 ✓
- Bootstrap CI(ΔRecall@5) lower bound > 0 ✓

**Latency gate:**
- Arm 3 P95 = 70.57ms (≤ 100ms) ✓ — achieved via HNSW KNN operator (`<|K,COSINE|>`) + AND clause on `project_id` (pre-filter pushes into the HNSW scan, reducing 10k → 2.5k scan set)

**Long-range stratum:** NOT_SCORED (documented deviation — no 48h temporal depth in pre-M-0 corpus; will be re-probed by M-6/SDD-08 with real M-0 telemetry)

**Adversarial FP rate:** 100% (diagnostic — does not gate the verdict; Arm 3 returns results for all queries including adversarial; a production score threshold would filter this, but that's sdd-07's responsibility)

### Run history

| Run | Verdict | Quality | Latency | Key change |
|---|---|---|---|---|
| 1 | FAIL | ΔMRR=+0.02 | 1360ms | Initial (regex-only capture, Qwen2.5-7B labels) |
| 2 | FAIL | ΔMRR=−0.08 | 1254ms | Methodology fixes (gpt-4o-mini, LLM extraction, graph leg fix) |
| 3 | FAIL | ΔMRR=+0.054, CI(ΔRecall@5)=−0.017 | 987ms | HNSW + array index on node_ids |
| 4 | FAIL | ΔMRR=+0.096, CIs exclude 0 | 1463ms | Junction table + 100 queries |
| 5 | FAIL | ΔMRR=+0.116, CIs exclude 0 | 463ms | depth=1 + in-memory adjacency + fanout cap |
| **6** | **PASS** | **ΔMRR=+0.086, CIs exclude 0** | **70ms** | **HNSW KNN operator + project_id pre-filter** |

### Key finding

The latency bottleneck was SurrealDB's HNSW vector index, not the hypergraph design. The `<|K,COSINE|>` KNN operator (required for HNSW index usage) combined with an AND clause on `project_id` (pushes the filter INTO the HNSW scan) reduced the scan set from 10k to ~2.5k, achieving 70ms P95. The `ORDER BY vector::similarity::cosine` approach (approach 2) is brute-force and doesn't use the HNSW index — a critical SurrealDB 3.x performance characteristic discovered through the probe.

### Production optimization for sdd-07

The pre-filter technique (HNSW KNN operator + project_id AND clause) is a production requirement for the ContextPacker. The seed query MUST use `WHERE embedding <|K,COSINE|> $qvec AND attributes.project_id = $project_id` — NOT `ORDER BY vector::similarity::cosine(...) DESC`. This is documented in the decision log and flows to sdd-07's HOW.

## VERIFY coverage check

| VERIFY | What it checks | Status |
|---|---|---|
| V1 | Corpus assembled | ✓ (74 sessions, 4 projects) |
| V2 | Temporal depth | NOT_SCORED (documented deviation) |
| V3 | Labels with 4 strata | ✓ (100 relational + 20 single-hop + 20 adversarial) |
| V4 | Temporary capture path | ✓ (LLM extraction, documented in decision log) |
| V5 | 4 arms ran | ✓ (all 4 arm result JSONs exist) |
| V6 | Metrics computed | ✓ (Recall@k, MRR, nDCG, FP rate, bootstrap CIs) |
| V7 | Latency P95 | ✓ (70.57ms ≤ 100ms) |
| V8 | Decision rule applied | ✓ (PASS verdict) |
| V9 | Decision log with 10 fields | ✓ (all fields a-j) |
| V10 | Pre-registration invariants | ✓ (thresholds match SC-12, no THRESHOLD_TAMPERING, 6 runs all same thresholds) |
| V11 | Verdict produced | ✓ (PASS — unblocks sdd-05/06/07) |
| V12 | Green suite | ✓ (29/29 acceptance tests pass, typecheck green) |

## Acceptance tests

`bun test test/fbh-phase-m/sdd-04.test.ts --timeout 30000` → **29 pass, 0 fail**.

VERDICT: PASS

The SDD-04 probe is complete with a PASS verdict. The hypergraph premise is validated (quality gate passes with CIs excluding 0) and the latency is under budget (70ms via HNSW KNN pre-filter). SDD-05 (M-2 auto-capture), SDD-06 (M-3 lifecycle), and SDD-07 (M-4 context packing) are unblocked. The pre-filter technique (HNSW KNN operator + project_id AND clause) is a production requirement documented in the decision log and flowing to sdd-07.
