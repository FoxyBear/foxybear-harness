# SDD-04: Pre-Registered Retrieval-Quality Probe

**Date:** 2026-09-21
**Project:** FoxyBear Harness Phase M (`development/foxybear`)
**Status:** Draft (pending independent audit + human gate)
**Master:** `260921_fbh-phase-m_sdd-00-master.md` (authoritative; where this spec conflicts, the master wins — inherits SC-11, SC-12, CC-4, CC-5, CC-9, CC-11)
**Research:** `docs/research/260921_fbh-phase-m_research.md` (§8 AgentMemBench — graph methods collapse at long-range recall: GEM Recall@5 ≤ 0.005 on LoCoMo vs EKV 0.573)
**Workstream:** `fbh-phase-m` (`tools/sdd/workstreams/fbh-phase-m.json`)
**Depends on:** `sdd-03` (M-1 hypergraph schema — needs the `node`/`hyperedge`/`event` tables, `SurrealHypergraphBackend.query`/`expand`/`neighbors`, and the backfill from `memory_topics`/`memory`/`graph_entity`/`graph_edge`)

The single most important falsification instrument in the Phase M suite. The hypergraph premise — that MAGE-style traversal beats existing hybrid retrieval on relational queries without regressing long-range recall — is **unverified**. M-2 (auto-capture), M-3 (lifecycle), and M-4 (context packing) all build on that premise. This probe verifies it with pre-registered thresholds BEFORE M-2/M-3/M-4 are built. If the probe fails the relational stratum, the terminal fallback (abort A3) abandons hypergraph retrieval and M-3/M-4 are re-scoped over baseline retrieval. Per CC-11, the rubric and thresholds are registered together, in this spec, BEFORE any results exist. Adjusting thresholds after results arrive is a spec violation.

The probe runs AFTER `sdd-03` ships (the `node`/`hyperedge` tables exist and the backfill has populated them) but BEFORE `sdd-05` ships (M-2 auto-capture does not yet populate the hypergraph from live session traces). The probe therefore uses a one-shot, fixture-based temporary capture path to populate the hypergraph from the 50-session corpus. This temporary path is NOT the production M-2 capture path. It is documented in the decision log and removed (or replaced by M-2) before M-2 ships. The verdict is interpretable only against this documented temporary path; the production M-2 capture path is re-probed by M-6 (SDD-08).

## Background

The existing retrieval layer has two arms already implemented:

- **Vector leg** (`surreal-backend.ts:217-225`): `SELECT ... vector::similarity::cosine(embedding, $qvec) AS score FROM memory ORDER BY score DESC LIMIT N`. Pure vector similarity over the `memory` table embeddings. This is Arm 1's basis.
- **Hybrid retrieval** (`surreal-backend.ts:203-292`): `SurrealBackend.query` runs three legs — vector (Leg 1, `:217-225`), BM25 keyword (Leg 2, `:228-235`), and 1-hop graph co-mention (Leg 3, `:237-258`) — then fuses them with Reciprocal Rank Fusion (`:261`, `:289-290`). This is Arm 2.

Arm 3 (vector + hypergraph traversal) and Arm 4 (pure hypergraph) do not exist yet — they require the `node`/`hyperedge` tables from `sdd-03`. The probe implements them as throwaway retrieval paths in `tmp/` (NOT production code), uses them to score against the labeled corpus, and produces the verdict. Production retrieval paths (the `@foxybear/Hypergraph` service integration into `Memory.recall` and `ContextPacker`) are owned by `sdd-05`/`sdd-07` and ship only if the probe passes.

AgentMemBench's critical caveat (research §8): graph methods collapse at long-range recall (GEM Recall@5 ≤ 0.005 on LoCoMo, vs EKV's 0.573). The hypergraph is for **relational/structured reasoning** — who did what with what tool, after what error, producing what evidence — NOT bulk recall. The probe's long-range stratum is therefore a **non-regression** test (Arm 3 must not be worse than Arm 2 by more than 0.01 on Recall@5 or MRR), not a superiority test. The relational stratum is the superiority test (Arm 3 must beat Arm 2 by ≥ 0.05 absolute on both MRR and Recall@5, with bootstrap CI lower bound > 0).

---

## WHAT

### Pre-registration (CC-11)

1. **WHEN** this spec is ratified (human gate signs off), the thresholds in reqs 13–15 and the decision rule in req 16 **SHALL** be the pre-committed values. They **SHALL NOT** be adjusted after any probe result exists. Adjusting thresholds after results arrive **SHALL** be a spec violation, **SHALL** be recorded in the decision log as a `THRESHOLD_TAMPERING` event, and **SHALL** require the probe to be re-run from scratch with the original pre-registered thresholds.

2. **WHEN** the probe begins, the rubric and the thresholds **SHALL** be registered together — written into the decision log header BEFORE the corpus is labeled or any arm is run. The decision log **SHALL** cite this spec by filename and git SHA as the registration artifact.

### Corpus assembly (SC-12)

3. **WHEN** the probe begins, the system **SHALL** assemble a corpus from real `fbh` sessions produced by M-0 (SDD-02) telemetry. The corpus **SHALL** be the larger of: (a) 50 sessions, OR (b) 4 weeks of M-0 telemetry — whichever produces more turns. The corpus **SHALL** include sessions from ≥ 2 distinct `project_id` values (tests cross-project isolation as a side effect, per the master's Security section).

4. **WHEN** the corpus is assembled, the system **SHALL** exclude: (a) sessions with < 5 turns; (b) sessions where `memory.enabled` was false; (c) sessions from projects with < 10 total turns (too sparse to label). The exclusion criteria **SHALL** be recorded in the decision log with the count of sessions excluded per criterion.

5. **WHEN** the corpus is assembled, the system **SHALL** record the corpus summary in the decision log: total session count, distinct `project_id` count, total turn count, temporal span (earliest `created_at` to latest `created_at`), and per-project breakdown.

6. **WHEN** the long-range stratum is scored, the system **SHALL** NOT score it until the corpus has genuine temporal depth: each long-range query's answer **SHALL** have been established ≥ 48 hours before the query. If the corpus's temporal span is < 48 hours, the long-range stratum **SHALL** be reported as `NOT_SCORED_INSUFFICIENT_TEMPORAL_DEPTH` and the probe **SHALL** wait (re-run nightly against accumulating M-0 telemetry) until the depth requirement is met.

### Labeling (SC-12)

7. **WHEN** the corpus is assembled, the system **SHALL** label 100 queries across 4 strata: 30 relational queries (each requires traversing ≥ 2 hyperedges to answer — e.g., "what did agent X do with tool Y after error Z?"), 30 long-range queries (answer established ≥ 48 hours before the query), 20 single-hop queries (one vector match suffices — baseline), and 20 adversarial queries (the answer does not exist in the corpus — tests false-positive rate).

8. **WHEN** the queries are labeled, the system **SHALL** use LLM-assisted labeling from the real session content (Qwen2.5-7B-Instruct on DeepInfra, matching the SDD-05 extraction LLM — no separate labeling model). Each query **SHALL** carry: `query` text, `expected_answer` text, `expected_node_ids` (the ground-truth node IDs the retrieval should return), `stratum` (relational|long-range|single-hop|adversarial), `provenance` (the session ID + turn index where the answer was established).

9. **WHEN** the LLM-assisted labels are produced, the system **SHALL** extend 20% of them (≥ 20 queries, stratified across the 4 strata) to human spot-check. The spot-check **SHALL** verify rubric-consistency (does the label match the rubric's definition of its stratum?) in addition to answer correctness. The system **SHALL** report inter-rater agreement (Krippendorff's alpha) between the LLM labeler and the human spot-checkers.

10. **WHEN** the inter-rater agreement is < 0.7, the system **SHALL** fix the rubric (clarify ambiguous definitions), **SHALL** relabel the full 100-query set with the fixed rubric, and **SHALL** re-run the spot-check. The fixed rubric and the relabel count **SHALL** be recorded in the decision log. If the second spot-check is still < 0.7, the probe **SHALL** halt with `RUBRIC_UNSTABLE` and the human gate **SHALL** re-convene.

### Four arms (SC-12)

11. **WHEN** the probe runs, it **SHALL** execute 4 retrieval arms against the same labeled corpus:

    - **Arm 1 — Pure vector (baseline).** The vector leg of `SurrealBackend.query` at `surreal-backend.ts:217-225`: `SELECT ... vector::similarity::cosine(embedding, $qvec) AS score FROM memory WHERE ... ORDER BY score DESC LIMIT $limit`. No graph leg, no keyword leg. Seeds from the query embedding only. Returns `memory` rows ranked by cosine.
    - **Arm 2 — Vector + 1-hop graph (existing hybrid).** The full `SurrealBackend.query` at `surreal-backend.ts:203-292`: vector leg (`:217-225`) + BM25 keyword leg (`:228-235`) + 1-hop graph co-mention leg (`:237-258`), fused via Reciprocal Rank Fusion (`:261`, `:289-290`). This is the production retrieval path as of M-0.
    - **Arm 3 — Vector + hypergraph traversal (proposed system).** Seeds from vector similarity on `node.embedding` (top-K MEMORY/ENTITY nodes by cosine), then expands through the M-1 hypergraph via `SurrealHypergraphBackend.query(seeds, project_id, { depth: 2 })` and `SurrealHypergraphBackend.expand(seeds, project_id, 2)` from `sdd-03`. The hypergraph expansion returns connected `ACTION`/`ERROR`/`MESSAGE`/`ENTITY` nodes via `COLLABORATION`/`ERROR_CORRECTION`/`EVIDENCE` hyperedges. The vector seeds and the hypergraph expansion **SHALL** be fused via RRF (same `rrf` helper at `surreal-backend.ts:261`, applied to two rankings instead of three).
    - **Arm 4 — Pure hypergraph traversal (diagnostic).** NO vector seed. Seeds from exact entity-match only: the query's named entities (extracted via the existing regex extractor at `extraction.ts:45` — no LLM) are matched against `node.attributes.name` in the `ENTITY` table. Those entity node IDs seed `SurrealHypergraphBackend.query` + `expand` with `depth: 2`. This localizes failure: if Arm 4 fails but Arm 3 passes, the hypergraph is useful when paired with vector seeding; if both fail, the hypergraph itself is the problem.

12. **WHEN** Arms 3 and 4 run, the hypergraph **SHALL** be populated by a one-shot temporary capture path (NOT the production M-2 `TraceIngestor` — `sdd-05` has not shipped). The temporary path **SHALL** parse the 50-session corpus's `message`/`part` tables, emit `ACTION`/`ERROR`/`MESSAGE`/`ENTITY` nodes and `COLLABORATION`/`ERROR_CORRECTION`/`EVIDENCE` hyperedges using the same node/hyperedge schemas from `sdd-03`, and write them via `SurrealHypergraphBackend.store`/`.edge`. The temporary path **SHALL** live at `tmp/probe-capture.ts` (disposable; `tmp/` is cleaned on session complete per AGENTS.md). The temporary path **SHALL** be documented in the decision log with the exact heuristics used (regex patterns, hyperedge construction rules). The temporary path **SHALL** be removed before `sdd-05` ships.

### Metrics (SC-12)

13. **WHEN** the probe scores each arm, it **SHALL** compute per-stratum: Recall@k for k=1,5,10 (fraction of `expected_node_ids` returned in the top-k); MRR (mean reciprocal rank of the first relevant result); nDCG@10 (discounted cumulative gain, with `expected_node_ids` as the relevant set). For the adversarial stratum, it **SHALL** compute the false-positive rate (fraction of adversarial queries where the arm returned any result with score > 0). For Arm 3, it **SHALL** also compute latency P95 on a synthetic 10k-node/10k-hyperedge fixture (described in req 15).

14. **WHEN** the probe computes the primary decision rule on the relational stratum, it **SHALL** compare Arm 3 to Arm 2. Arm 3 **SHALL** pass the relational stratum iff ALL of:
    - ΔMRR ≥ +0.05 absolute (Arm 3 MRR minus Arm 2 MRR, on the 30 relational queries)
    - ΔRecall@5 ≥ +0.05 absolute (Arm 3 Recall@5 minus Arm 2 Recall@5)
    - Bootstrap 95% CI lower bound on ΔMRR > 0 (1000 bootstrap resamples, percentile method, 2.5th percentile)
    - Bootstrap 95% CI lower bound on ΔRecall@5 > 0

15. **WHEN** the probe computes the primary decision rule on the long-range stratum, it **SHALL** compare Arm 3 to Arm 2. Arm 3 **SHALL** pass the long-range stratum iff BOTH of:
    - ΔRecall@5 ≥ −0.01 (Arm 3 Recall@5 minus Arm 2 Recall@5 — non-regression per AgentMemBench caveat)
    - ΔMRR ≥ −0.01 (non-regression)
    The adversarial FP rate (Arm 3) **SHALL** be ≤ 20% (diagnostic — does not gate the verdict but is reported). Arm 3 latency P95 on the 10k-node/10k-hyperedge fixture **SHALL** be ≤ 100ms (gates the verdict — a slow hypergraph is not shippable).

### Decision rule (pre-committed, SC-12 + SC-11 A3)

16. **WHEN** all four arms have run and the metrics are computed, the system **SHALL** apply this pre-committed decision rule to produce the verdict:

    - **PASS both strata** (relational AND long-range) AND Arm 3 latency P95 ≤ 100ms → verdict `PASS`. M-2 (`sdd-05`), M-3 (`sdd-06`), M-4 (`sdd-07`) proceed as specced.
    - **FAIL long-range only** (relational passes, long-range regresses by > 0.01) → verdict `ROUTE`. Hypergraph is excluded from long-range queries via query-type routing (the production `Memory.recall` path detects long-range queries and falls back to Arm 2). The probe **SHALL** retest once (re-run the long-range stratum after the routing rule is applied in the temporary path). If the retest passes, verdict `PASS_WITH_ROUTING` and M-2/M-3/M-4 proceed with the routing rule baked into `sdd-07`'s packer. If the retest still fails, verdict `RELATIONAL_ONLY` and M-3/M-4 are re-scoped to relational-only hypergraph use.
    - **FAIL relational** (ΔMRR < +0.05 OR ΔRecall@5 < +0.05 OR bootstrap CI lower bound ≤ 0) → verdict `FAIL` and terminal fallback **A3** fires: hypergraph retrieval is abandoned. M-3 (`sdd-06`) and M-4 (`sdd-07`) are re-scoped over baseline retrieval (Arm 2). M-2 (`sdd-05`) is re-scoped to capture for the existing `memory` table only (no hypergraph writes). The Floor (M-0 + baseline-retrieval injection) ships regardless.

### Decision log (CC-11)

17. **WHEN** the probe completes (verdict produced OR abort fires), the system **SHALL** write the decision log at `docs/decisions/260921_fbh-phase-m_probe-results.md` (sibling of the existing `docs/decisions/` files at the FoxyBearOffice root — the agent-coordination hub where Phase M decisions live). The decision log **SHALL** record, in order:
    - (a) The pre-registered thresholds (verbatim from reqs 13–16 of this spec) and the git SHA of this spec at registration time.
    - (b) The corpus summary (req 5) and exclusion counts (req 4).
    - (c) The rubric (the stratum definitions from req 7) and the inter-rater agreement (req 9) — including any rubric-fix iterations (req 10).
    - (d) The temporary capture path heuristics (req 12) — exact regex patterns and hyperedge construction rules.
    - (e) The raw per-stratum, per-arm metric values: a 4×4 table (4 arms × 4 strata) of Recall@5, plus MRR, nDCG@10, and FP rate (adversarial only). Raw, unrounded, failures included.
    - (f) The bootstrap CI bounds for ΔMRR and ΔRecall@5 on the relational stratum (1000 resamples, 2.5th and 97.5th percentiles).
    - (g) The latency P95 for Arm 3 on the 10k-node/10k-hyperedge fixture (req 15).
    - (h) The verdict (req 16) with the exact branch taken and the triggering conditions.
    - (i) If the verdict is `FAIL` or `ROUTE`, the abort A3 consequences (which specs are re-scoped, which proceed).
    - (j) The git SHA of the probe code, the LLM provider/model used for labeling, the harness config, and the fixture IDs (corpus session IDs) for reproducibility.

18. **WHEN** the decision log is written, the system **SHALL** also write the raw machine-readable results at `~/.local/share/foxybear/probe/<timestamp>-sdd-04.json` containing the same data as (e)–(g) above in JSON form, for re-analysis without re-running the probe.

### Style & quality (CC-9, CC-4)

19. **WHEN** the probe is implemented, the system **SHALL** follow the AGENTS.md style guide: single-word function names (`probe`, `label`, `run`, `score` — NOT `runProbe`, `labelQueries`, `runArms`, `scoreResults`); `Bun.file()` for file I/O (NOT `fs`); `const` over `let`; no `any` type; early returns over `else`; functional array methods (`flatMap`/`filter`/`map`) over `for` loops (CC-9). The probe entry point **SHALL** be `probe()` at `tmp/probe.ts`; the labeler **SHALL** be `label(corpus)`; the arm runner **SHALL** be `run(arm, queries)`; the scorer **SHALL** be `score(results, expected)`.

20. **WHEN** the probe implementation completes, `bun run typecheck` and `bun test --timeout 30000` (run from `packages/fbh`, per SC-10) **SHALL** both be green (CC-4). The probe tests live at `packages/fbh/test/fbh-phase-m/sdd-04.test.ts` and **SHALL** be part of the green suite. No mocks of the implementation under test (CC-5) — the probe hits the real `SurrealHypergraphBackend` from `sdd-03` and the real `SurrealBackend` at `surreal-backend.ts:203-292`.

---

## HOW

### Step 1: Corpus assembly (reqs 3–5)

Write `tmp/probe-corpus.ts` that:
- Queries the `session` and `message` tables (post-M-0 wire-up from `sdd-02`) via the daemon HTTP API at `/memory/list` (`src/daemon/routes.ts:57`) or directly via the SQLite/SurrealDB connection.
- Filters: `turn_count >= 5`, `memory.enabled === true` at the time of the session, `project_id` has ≥ 10 total turns across all its sessions.
- Samples 50 sessions from ≥ 2 distinct `project_id` values. If < 50 sessions exist with the required temporal depth, falls back to 4 weeks of M-0 telemetry (all sessions with `created_at >= now - 28d`).
- Records the corpus summary (session count, project count, turn count, temporal span, per-project breakdown) into `~/.local/share/foxybear/probe/<timestamp>-corpus.json` via `Bun.write`.
- The corpus is the input to Step 2 (labeling) and Step 3 (temporary capture).

### Step 2: Labeling (reqs 7–10)

Write `tmp/probe-label.ts` that:
- For each of the 4 strata, generates query candidates from the corpus session content using the LLM-assisted path:
  - **Relational:** queries of the form "what did agent X do with tool Y after error Z?" where the answer requires joining `ACTION` + `ERROR` + `MESSAGE` nodes via `COLLABORATION`/`ERROR_CORRECTION` hyperedges. The LLM is prompted with session content and asked to generate 30 such queries with the expected answer text and the expected node IDs (which the LLM extracts from the session trace).
  - **Long-range:** queries whose answers were established ≥ 48 hours before the query. The LLM is prompted with sessions that have `created_at` ≥ 48 hours before the labeling time, and asked to generate 30 queries whose answers live in those earlier sessions.
  - **Single-hop:** queries whose answers are a single vector match (no hyperedge traversal needed). The LLM is prompted to generate 20 such queries.
  - **Adversarial:** queries whose answers do NOT exist in the corpus. The LLM is prompted to generate 20 plausible-sounding queries about topics not covered in the corpus.
- Each query carries: `query` text, `expected_answer` text, `expected_node_ids` (ground-truth node IDs), `stratum`, `provenance` (session ID + turn index).
- Extends 20% (≥ 20 queries, stratified) to human spot-check. The spot-checker verifies rubric-consistency (does the label match the stratum's rubric definition?) in addition to answer correctness.
- Computes Krippendorff's alpha between the LLM labeler and the human spot-checkers. If < 0.7, fixes the rubric, relabels the full 100-query set, re-runs the spot-check. Records the rubric, the alpha, and any fix iterations in `~/.local/share/foxybear/probe/<timestamp>-labels.json`.
- The labeler entry point is `label(corpus)` — single-word, per AGENTS.md.

### Step 3: Temporary capture path (req 12)

Write `tmp/probe-capture.ts` that:
- Parses the 50-session corpus's `message`/`part` tables.
- Emits `ACTION` nodes (from tool calls), `ERROR` nodes (from error responses), `MESSAGE` nodes (from user/assistant turns), `ENTITY` nodes (via the existing regex extractor at `extraction.ts:45` — NO LLM, to keep the temporary path deterministic and isolate the hypergraph retrieval test from M-2's LLM extraction quality).
- Emits `COLLABORATION` hyperedges (linking `ACTION` + `MESSAGE` nodes within the same task), `ERROR_CORRECTION` hyperedges (linking `ERROR` + the `ACTION` that corrected it), `EVIDENCE` hyperedges (linking `ACTION` + its output `MESSAGE`).
- Writes via `SurrealHypergraphBackend.store` (nodes) and `.edge` (hyperedges) from `sdd-03`.
- Records the exact heuristics (regex patterns, hyperedge construction rules) in the decision log.
- The temporary path is NOT committed to `packages/fbh/src/` — it lives in `tmp/` and is removed on session complete (or when `sdd-05` ships, whichever is first).

### Step 4: Four arms (reqs 11, 13)

Write `tmp/probe-run.ts` that implements `run(arm, queries)` for each arm:

- **Arm 1 — `run("vector", queries)`:** for each query, embeds the query via `Embedding.embedSafe` (`recall.ts:185`'s helper), runs the vector leg of `SurrealBackend.query` at `surreal-backend.ts:217-225` (extracted into a standalone function or invoked via a flag that disables the keyword and graph legs — the implementer's choice, but the vector leg's SurrealQL is the authoritative source). Returns ranked `memory` rows.
- **Arm 2 — `run("hybrid", queries)`:** for each query, runs the full `SurrealBackend.query` at `surreal-backend.ts:203-292` unchanged. Returns RRF-fused `memory` rows.
- **Arm 3 — `run("hypergraph", queries)`:** for each query, embeds the query, runs vector similarity on `node.embedding` to get top-K seed node IDs (K=20), then calls `SurrealHypergraphBackend.query(seeds, project_id, { depth: 2 })` and `SurrealHypergraphBackend.expand(seeds, project_id, 2)` from `sdd-03`. Fuses the vector seeds and the hypergraph expansion via the existing `rrf` helper at `surreal-backend.ts:261` (applied to two rankings). Returns fused nodes.
- **Arm 4 — `run("pure-hypergraph", queries)`:** for each query, extracts named entities via the regex extractor at `extraction.ts:45`, matches them against `node.attributes.name` in the `ENTITY` table to get seed node IDs (NO vector — exact string match only), then calls `SurrealHypergraphBackend.query(seeds, project_id, { depth: 2 })` and `expand`. Returns hypergraph nodes.

Each arm runs against the same 100-query labeled corpus. The runner records per-query results (returned node IDs, scores, latency) to `~/.local/share/foxybear/probe/<timestamp>-arm-<name>.json`.

### Step 5: Scoring (reqs 13–15)

Write `tmp/probe-score.ts` that implements `score(results, expected)`:

- **Recall@k:** for each query, `|returned_ids ∩ expected_node_ids| / |expected_node_ids|` at k=1,5,10. Averaged per stratum.
- **MRR:** for each query, `1 / rank` of the first relevant result (0 if no relevant result in top-10). Averaged per stratum.
- **nDCG@10:** for each query, `DCG@10 / IDCG@10` where `DCG@k = sum(rel_i / log2(i+1))` and `rel_i = 1` if `returned_id_i ∈ expected_node_ids` else 0. Averaged per stratum.
- **FP rate (adversarial only):** fraction of adversarial queries where the arm returned any result with score > 0.
- **Bootstrap CI:** for the relational stratum, resamples the 30 query-level ΔMRR and ΔRecall@5 values with replacement 1000 times, computes the mean each time, takes the 2.5th and 97.5th percentiles as the 95% CI. The lower bound (2.5th percentile) is the gating value.
- **Latency P95:** separate fixture (Step 6) — not scored against the 50-session corpus.

### Step 6: Latency fixture (req 15)

Write `tmp/probe-latency.ts` that:
- Builds a synthetic 10k-node/10k-hyperedge fixture in a throwaway SurrealDB namespace `foxybear_probe_latency` (matches the `sdd-03` spike pattern at `tmp/spike-hyperedge-perf.ts`).
- Runs 100 iterations of Arm 3's full query path (vector seed + hypergraph expansion + RRF fusion) with random query embeddings.
- Computes P95 across the 100 samples.
- Cleans up: `REMOVE DATABASE IF EXISTS probe_latency`.
- The P95 is the gating value for req 15's `≤ 100ms` threshold.

### Step 7: Decision rule (req 16)

Write `tmp/probe-verdict.ts` that:
- Reads the per-arm scores (Step 5) and the latency P95 (Step 6).
- Applies the pre-committed decision rule from req 16:
  - Relational stratum: check ΔMRR ≥ +0.05 AND ΔRecall@5 ≥ +0.05 AND bootstrap CI lower bounds > 0.
  - Long-range stratum: check ΔRecall@5 ≥ −0.01 AND ΔMRR ≥ −0.01.
  - Latency: check Arm 3 P95 ≤ 100ms.
  - Adversarial FP rate: report (diagnostic, does not gate).
- Produces the verdict: `PASS`, `PASS_WITH_ROUTING`, `RELATIONAL_ONLY`, or `FAIL` (with A3 consequences).
- Writes the verdict to the decision log (req 17) and the raw JSON results (req 18).

### Step 8: Decision log (reqs 17–18)

Write `tmp/probe-report.ts` that:
- Assembles the decision log at `docs/decisions/260921_fbh-phase-m_probe-results.md` from the corpus summary (Step 1), labels (Step 2), temporary capture heuristics (Step 3), per-arm scores (Step 5), bootstrap CIs (Step 5), latency P95 (Step 6), and verdict (Step 7).
- Writes the raw JSON results at `~/.local/share/foxybear/probe/<timestamp>-sdd-04.json`.
- The decision log is the gate artifact for `sdd-05`/`sdd-06`/`sdd-07` — those specs **SHALL NOT** proceed until the decision log exists with a `PASS`, `PASS_WITH_ROUTING`, or `RELATIONAL_ONLY` verdict.

### Verification commands (SC-10, run from `packages/fbh`)

- Typecheck: `bun run typecheck` → `tsgo --noEmit` (`packages/fbh/package.json:10`)
- Test: `bun test --timeout 30000` (`packages/fbh/package.json:11`) — includes `test/fbh-phase-m/sdd-04.test.ts`
- Probe: `bun tmp/probe.ts` (orchestrates Steps 1–8) — run from `packages/fbh` so the daemon and SurrealDB connections resolve

### What is explicitly NOT built

- No production retrieval paths. Arm 3 and Arm 4 live in `tmp/` and are NOT wired into `Memory.recall` or `ContextPacker`. Production wiring is owned by `sdd-05`/`sdd-07` and ships only if the probe passes.
- No production capture path. The temporary capture path in `tmp/probe-capture.ts` is NOT the M-2 `TraceIngestor`. M-2 (`sdd-05`) owns the production capture path.
- No new schema. The probe uses the `node`/`hyperedge`/`event` tables from `sdd-03`. No new tables, no new node types, no new hyperedge types.
- No mocks (CC-5). The probe hits the real `SurrealBackend` at `surreal-backend.ts:203-292`, the real `SurrealHypergraphBackend` from `sdd-03`, and the real `Embedding.embedSafe` at `recall.ts:185`. The labeling LLM is real (Qwen2.5-7B-Instruct on DeepInfra).

### Reuse map

- `src/memory/surreal-backend.ts:203-292` `SurrealBackend.query` — Arm 2 (unchanged), Arm 1 (vector leg extracted)
- `src/memory/surreal-backend.ts:217-225` vector leg — Arm 1's basis
- `src/memory/surreal-backend.ts:261` `rrf` helper — Arm 3's fusion (applied to 2 rankings)
- `src/memory/recall.ts:185` `AutoRecall.autoRecall` — query embedding path (uses `Embedding.embedSafe`)
- `src/memory/extraction.ts:45` regex extractor — Arm 4's entity extraction (no LLM, deterministic)
- `packages/fbh/src/memory/surreal-hypergraph-backend.ts` (from `sdd-03`) — `store`/`edge`/`query`/`expand` for Arm 3 and Arm 4
- `packages/fbh/src/memory/schema/` (from `sdd-03`) — node/hyperedge Effect/Schema types for the temporary capture path
- `~/.local/share/foxybear/probe/` — results JSON files (per-arm, per-step)
- `docs/decisions/260921_fbh-phase-m_probe-results.md` — decision log (the gate artifact)

---

## VERIFY

Acceptance tests live at `packages/fbh/test/fbh-phase-m/sdd-04.test.ts`. Tests SHALL NOT mock the implementation under test (CC-5, CC-9). Tests SHALL boot the real daemon, hit the real `SurrealBackend` and `SurrealHypergraphBackend`, and use the real `Embedding.embedSafe`. Tests run from `packages/fbh` (never repo root — SC-10).

- **V1 — corpus assembled (reqs 3–5).** Setup: M-0 telemetry has ≥ 50 sessions across ≥ 2 projects (post-`sdd-02` wire-up). Action: run `tmp/probe-corpus.ts`. Expected: `~/.local/share/foxybear/probe/<timestamp>-corpus.json` exists with ≥ 50 sessions from ≥ 2 distinct `project_id` values, exclusions recorded, temporal span recorded. If < 50 sessions, falls back to 4 weeks of telemetry.
- **V2 — temporal depth (req 6).** Setup: corpus temporal span ≥ 48 hours. Action: read the corpus summary. Expected: the long-range stratum is scored (not `NOT_SCORED_INSUFFICIENT_TEMPORAL_DEPTH`). If the span is < 48 hours, the probe halts and re-runs nightly until the depth requirement is met.
- **V3 — labeling complete (reqs 7–10).** Action: run `tmp/probe-label.ts`. Expected: `~/.local/share/foxybear/probe/<timestamp>-labels.json` exists with 100 queries across 4 strata (30 relational, 30 long-range, 20 single-hop, 20 adversarial); each query has `query`/`expected_answer`/`expected_node_ids`/`stratum`/`provenance`; inter-rater agreement (Krippendorff's alpha) ≥ 0.7 OR a rubric-fix iteration is recorded with a relabel count.
- **V4 — temporary capture path (req 12).** Action: run `tmp/probe-capture.ts`. Expected: the `node` and `hyperedge` tables contain `ACTION`/`ERROR`/`MESSAGE`/`ENTITY` nodes and `COLLABORATION`/`ERROR_CORRECTION`/`EVIDENCE` hyperedges derived from the 50-session corpus; the capture heuristics are recorded in the decision log; no LLM was used for extraction (regex only).
- **V5 — four arms ran (reqs 11, 13).** Action: run `tmp/probe-run.ts` for each arm. Expected: `~/.local/share/foxybear/probe/<timestamp>-arm-vector.json`, `-arm-hybrid.json`, `-arm-hypergraph.json`, `-arm-pure-hypergraph.json` all exist with per-query results for all 100 queries; Arm 1 used only the vector leg; Arm 2 used the full hybrid; Arm 3 used vector seeds + hypergraph expansion; Arm 4 used exact entity-match seeds + hypergraph expansion.
- **V6 — metrics computed (req 13).** Action: run `tmp/probe-score.ts`. Expected: per-stratum Recall@1/5/10, MRR, nDCG@10 for all 4 arms; adversarial FP rate for all 4 arms; bootstrap 95% CI bounds for ΔMRR and ΔRecall@5 on the relational stratum (Arm 3 vs Arm 2).
- **V7 — latency P95 (req 15).** Action: run `tmp/probe-latency.ts`. Expected: Arm 3 P95 ≤ 100ms on the 10k-node/10k-hyperedge fixture. If P95 > 100ms, the verdict is `FAIL` with latency as the trigger (separate from the relational-stratum failure).
- **V8 — decision rule applied (req 16).** Action: run `tmp/probe-verdict.ts`. Expected: the verdict is one of `PASS`, `PASS_WITH_ROUTING`, `RELATIONAL_ONLY`, `FAIL`; the triggering conditions are recorded; if `FAIL`, the A3 consequences (which specs are re-scoped) are recorded.
- **V9 — decision log written (reqs 17–18).** Action: run `tmp/probe-report.ts`. Expected: `docs/decisions/260921_fbh-phase-m_probe-results.md` exists with all 10 fields (a–j) from req 17 populated; `~/.local/share/foxybear/probe/<timestamp>-sdd-04.json` exists with the raw machine-readable results.
- **V10 — pre-registration invariants (CC-11, reqs 1–2).** Action: (i) diff the thresholds in the decision log against SC-12 (master spec `260921_fbh-phase-m_sdd-00-master.md` lines 152–160); (ii) read the decision log header's registration timestamp and compare it against the labeling-start timestamp and the first arm-run timestamp; (iii) scan the decision log for any `THRESHOLD_TAMPERING` event. Expected: (i) exact match — relational ΔMRR ≥ +0.05 AND ΔRecall@5 ≥ +0.05 with bootstrap CI lower bound > 0; long-range ΔRecall@5 ≥ −0.01 AND ΔMRR ≥ −0.01; adversarial FP rate ≤ 20%; latency P95 ≤ 100ms; (ii) the registration timestamp (when the rubric and thresholds were written into the decision log header per req 2) SHALL precede the labeling-start timestamp AND the first arm-run timestamp — proving the thresholds were pre-registered before any result existed; (iii) no `THRESHOLD_TAMPERING` event appears in the decision log — if one appears, the probe SHALL have been re-run from scratch with the original pre-registered thresholds (req 1), and the re-run's registration timestamp SHALL precede its labeling/arms timestamps. Any discrepancy in (i), any timestamp ordering violation in (ii), or any un-re-run `THRESHOLD_TAMPERING` event in (iii) fails the test (CC-11 violation).
- **V11 — verdict produced (req 16).** Action: read the decision log. Expected: a `PASS`, `PASS_WITH_ROUTING`, `RELATIONAL_ONLY`, or `FAIL` verdict is recorded; `sdd-05`/`sdd-06`/`sdd-07` are blocked (in the workstream state) until the decision log exists with a non-`FAIL` verdict.
- **V12 — green suite (req 20, CC-4).** Action: from `packages/fbh`, run `bun run typecheck` and `bun test --timeout 30000`. Expected: both green; the `sdd-04.test.ts` tests are part of the green suite; no mocks of the implementation under test in any new test file (CC-9).
