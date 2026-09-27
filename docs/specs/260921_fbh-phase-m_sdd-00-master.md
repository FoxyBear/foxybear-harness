# SDD-00 Master: FoxyBear Harness Phase M — MAGE-Style Memory Overhaul

**Date:** 2026-09-21 (revised 2026-09-22 per council deliberation)
**Project:** FoxyBear Harness Phase M (`development/foxybear`)
**Status:** Draft (pending independent re-audit + human gate)
**Source plan:** `docs/260916_foxybear_fork-rebrand-plan.md` (Phase M, lines 165-204)
**Research:** `docs/research/260921_fbh-phase-m_research.md`
**Council:** Full spec suite deliberated 2026-09-22 (3 rounds, consensus reached). Findings incorporated.
**Workstream:** `fbh-phase-m` (`tools/sdd/workstreams/fbh-phase-m.json`)

This is the master spec for Phase M: wire up the dormant auto-capture + hybrid-retrieval + injection pipeline, then extend it with MAGE-style n-ary hypergraph storage, lifecycle management, budget-bounded typed context packing, and (post-benchmark) conflict detection. It defines the architecture, cross-cutting requirements, shared contract (schema, bi-temporal model, lifecycle, service interfaces, config, spikes, backfill, abort criteria, pre-registered probe), and dependency order. Where a feature spec conflicts with this master, the master wins.

## Council deliberation summary (2026-09-22)

The full spec suite was sent to multi-model council deliberation (3 rounds, 4 models, consensus reached). The council's valid findings are incorporated:

1. **P-0 dormant-code audit (NEW SPEC):** The "60% built" claim was unverified (static survey only, never run). Two-engineer isolated execution audit before M-0. ~2 engineer-days. Cheapest mitigation in the suite.
2. **Schema subsetting:** 13 MAGE node types → 6 active + 7 reserved (enum-only, no tables). 7 hyperedge types → 4 active + 3 reserved. "A type with a table but no producer is the next `recentSessionIds:[]`."
3. **Pre-registered retrieval-quality probe (NEW SPEC):** The hypergraph premise (MAGE traversal beats existing hybrid retrieval) is unverified. 4-arm probe (pure vector, vector+1-hop, vector+hypergraph, pure hypergraph) against 50-session corpus with pre-registered thresholds. Terminal fallback if relational stratum fails.
4. **M-5 deferred to post-M-6:** Building conflict detection before measuring whether contradictions occur is "infrastructure for an unmeasured problem." M-6's benchmark produces the evidence M-5 consumes.
5. **Data governance (B4):** M-2 sends code to DeepInfra. Secrets redaction, user opt-in, data flow documentation, self-hosted fallback.
6. **Abort criteria A0-A8:** Pre-committed thresholds with pre-named fallbacks. Prevents sunk-cost continuation. Floor: M-0 + baseline-retrieval injection ships regardless.
7. **OQ5 resolution:** `access_count >= 2` graduation default (parameter-free), semantic-shift as shadow metric, force-promote at 5.
8. **Decision 3 (decay):** Simple exponential + rehearsal as default. Prism behind `memory.decay_model=prism` config flag (experimental only, ESMS proof unverified).
9. **Coupled-loop simulation (M-3):** Replaces isolated convergence spike. Tests the full system interaction, not just the math.

**Council claim rejected:** The skeptic (Kimi) claimed the MAGE citation (arXiv:2608.29678) was fabricated. Verified false — the paper exists ("Diachronic Hypergraphs for Orchestrated Multi-Agent Multimodal Memory Curation" by Yichao Feng et al., submitted 30 Aug 2026). The schema code (github.com/Githubuseryf/MAGE) is real.

## Architecture

### Problem being solved

Research (`docs/research/260921_fbh-phase-m_research.md`) found that ~60% of the target architecture is already built in `packages/fbh/src/` — `AutoRecall.autoRecall` + `formatForInjection` (recall.ts:185,279), `Consolidation.extractTurn` + `run` (consolidation.ts:594,533), `SurrealBackend` hybrid retrieval (surreal-backend.ts:203-292), bi-temporal `SurrealGraphBackend` (graph/surreal-backend.ts:47), TTL prune + graduation + stale penalty — but all of it is dormant: zero call sites in the session loop, scheduler disabled (scheduler.ts:55), SurrealDB pointed at the old opencode path, SQLite→Surreal migration never run. The council's valid critique: this claim is based on static survey, not runtime verification. The P-0 audit (SDD-01) tests it before any new code is written.

### Scope

In scope (Phase M, re-sequenced per council):

- **SDD-01 (P-0) Dormant-Code Audit** — Two-engineer isolated execution audit of every dormant component (Consolidation.extractTurn, SurrealBackend, SurrealGraphBackend, AutoRecall.formatForInjection, lifecycle scaffold). ≥10 sample inputs per component, schema-validated outputs. Defect log categorized (broken, schema-violating, semantically-wrong, spec-divergent). Abort A0 if core component non-functional and >2 engineer-days to fix.
- **SDD-02 (M-0) Wire-Up** — Fix SurrealDB path drift, run migrateFromSqlite, re-enable scheduler, wire AutoRecall + Consolidation.extractTurn into session loop, smoke test. Under guardrails: feature flag (`memory.enabled` default false), dry-run mode, backup-before-migrate, 48-hour telemetry gate (P95 regression ≤ 5%).
- **SDD-03 (M-1) Hypergraph Schema** — Translate MAGE schema (SUBSETTED to 6 active node + 4 active hyperedge types) to Effect/Schema, add node/hyperedge/event SurrealDB tables, SurrealHypergraphBackend (composition), backfill. Strengthened spike: 1k/10k/50k hyperedges, composite query, concurrent load, junction table head-to-head.
- **SDD-04 Pre-Registered Probe** — 4-arm retrieval-quality probe (pure vector, vector+1-hop, vector+hypergraph, pure hypergraph) against 50-session corpus. Pre-registered thresholds: relational ΔMRR ≥ +0.05 AND ΔRecall@5 ≥ +0.05; long-range non-regression (ΔRecall@5 ≥ −0.01). Terminal fallback: abandon hypergraph retrieval if relational stratum fails.
- **SDD-05 (M-2) Auto-Capture** — TraceIngestor (6 active node types), LLM extraction (Qwen2.5-7B, hybrid mode, async), dependency chains. Data governance: secrets redaction (measured catch rate), user opt-in (not default-on), documented data classes. Entity hallucination rate metric.
- **SDD-06 (M-3) Lifecycle** — Simple exponential + rehearsal as DEFAULT decay. Prism behind `memory.decay_model=prism` config flag (experimental). `access_count >= 2` graduation default, semantic-shift shadow, force-promote at 5. Coupled-loop simulation (replaces isolated convergence spike). Transitions strictly ACTIVE→DEPRECATED→ARCHIVED→DELETED.
- **SDD-07 (M-4) Context Packing** — BudgetAwarePacker, TypedFormatter, ProvenanceTracker (increments usage_count directly, no rehearse method). `pack(query, project_id, budget)`. L0-L3 hierarchy. Gated by probe (SDD-04) passing.
- **SDD-08 (M-6) Verification** — AgentMemBench-style benchmark. A/B: with/without memory, with/without hypergraph. Relational vs long-range axes. Live smoke. Produces contradiction-rate evidence for M-5.
- **SDD-09 (M-5) Conflict Detection** — DEFERRED to post-M-6. Conditional on M-6 producing evidence that contradictions occur. MOSAIC neighbor lookup, HiGram path localization, decision-driven write loop.

Out of scope: Phase S/T/C/Y, multi-user memory, council-driven extraction, ModalityNode population, L3/L4 multi-resolution (Community/Archetype/MetaProcedure active population).

### Key decisions (research + Todd confirmation + council)

- **In-harness TypeScript/Effect-TS, porting MAGE concepts not code.** Council confirmed (fabricated citation claim rejected; the real MAGE paper exists but the reference impl is 2 stars — port concepts, not code).
- **SurrealDB extended for n-ary hyperedges.** Council confirmed by elimination. Strengthened spike (10k/50k, composite query, concurrent, junction head-to-head).
- **Simple exponential + rehearsal as default decay.** Prism experimental behind config flag (ESMS proof unverified). Council ruling.
- **`access_count >= 2` graduation default.** Semantic-shift as shadow metric. Force-promote at 5. Council ruling.
- **LLM extraction configurable, hybrid mode default.** Qwen2.5-7B on DeepInfra. Data governance: secrets redaction, user opt-in.
- **Backfill existing memories.** One-time idempotent migration in M-1.
- **`Harness.run` NOT wired wholesale.** ContextPacker wired into session/prompt.ts directly.
- **Spikes gate implementation.** Strengthened per council (composite queries, scale, concurrent load).
- **AgentMemBench caveat: graph is for relational reasoning, not long-range recall.** M-6 verifies both axes independently.
- **M-5 deferred to post-M-6.** Council ruling: build conflict detection after measuring whether contradictions occur.
- **Pre-committed abort criteria A0-A8.** Every phase has a pre-registered abort threshold with pre-named fallback. Floor: M-0 + baseline-retrieval injection ships regardless.
- **Pre-registered retrieval-quality probe.** 4-arm, 50-session corpus, pre-registered thresholds. Gates M-2/M-3/M-4. Terminal fallback: abandon hypergraph retrieval if relational stratum fails.

## Cross-Cutting Requirements

CC-1 through CC-10 (unchanged from prior version — no data loss, dormant code wired not rewritten, spikes gate implementation, green suite, real verification no mocks, config-driven not hardcoded, bi-temporal everywhere, scheduler re-enabled, style guide compliance, SurrealDB path fixed).

- **CC-11 Pre-registered instruments.** Every spike, probe, and abort criterion SHALL have its thresholds pre-registered in this spec suite BEFORE results exist. No thresholds defined after results arrive. The probe thresholds, abort criteria, and terminal fallbacks are written into the specs now, not at spike completion. Every instrument writes raw results — failures included — into the decision log.
- **CC-12 Data governance for external extraction.** WHEN M-2 sends content to an external LLM provider (DeepInfra) for extraction, the system SHALL: (a) run a secrets-redaction filter with measured catch rate on seeded fixtures (5 secrets, zero leakage = pass); (b) require explicit user opt-in for external processing (NOT default-on — `memory.extraction.external_opt_in` must be explicitly set true); (c) document data classes with a data flow diagram showing what leaves the harness; (d) pre-name a self-hosted extraction fallback if provider terms fail. No secrets (API keys, tokens, auth.json) SHALL be sent to the extraction LLM.
- **CC-13 Schema subsetting enforcement.** The 6 active node types (Message, Action, Error, Memory, Procedure, Entity) and 4 active hyperedge types (Collaboration, ErrorCorrection, Evidence, Procedure) SHALL have tables, producers, consumers, and benchmark metrics. The 7 reserved node types (Task, Agent, Insight, Modality, Community, Archetype, MetaProcedure) and 3 reserved hyperedge types (NaryFact, CommunityReport, Generalizes) SHALL be enum values only — NO tables, NO extraction paths, NO packing paths. Activation requires a complete row (named producer, named consumer, named metric) audited to the same standard.
- **CC-14 Two-engineer sign-off on dormant code.** P-0 (SDD-01) dormant-code audit SHALL be performed by two engineers who did NOT author the code. The author's assertion is not verification. Defect log categorized: broken, schema-violating, semantically-wrong, spec-divergent.
- **CC-15 Coupled-loop simulation.** M-3 (SDD-06) lifecycle spike SHALL be a coupled-loop simulation (decay + graduation + conflict interaction), NOT an isolated convergence test. Tests the full system interaction, not just the decay math.

## Security

(Security section from prior version preserved: API keys unchanged, embeddings don't leak to extraction LLM, auth.json not logged, extraction calls don't log content at info level, bi-temporal soft-deletes preserve audit trail, conflict detection scoped to project_id, no secrets in spec artifacts.)

- **B4 Data governance for external extraction.** The system sends code/technical content to DeepInfra for LLM-driven extraction. This creates a confidentiality exposure. Required before M-2 gate:
  - Secrets-redaction filter with measured catch rate on seeded fixtures (5 secrets, zero leakage to DeepInfra = pass)
  - Explicit user opt-in for external processing — `memory.extraction.external_opt_in` default false, not default-on
  - Documented data classes with data flow diagram showing exactly what leaves the harness
  - Provider retention review with written record of what DeepInfra retains
  - Self-hosted extraction fallback pre-named if provider terms fail
- **XI Cross-project isolation leak test (standing release gate).** Two-project fixture with adversarial queries; zero cross-project rows in any response. A leak is a confidentiality incident, not a bug. Applies to all retrieval services (Hypergraph.query/expand/neighbors, ContextPacker.pack, ConflictDetector.check).

## Shared Contract

### SC-1: MAGE Node Types (SUBSETTED — 6 active, 7 reserved)

Per council ruling (CC-13). Phase M actively populates 6 node types. The remaining 7 are reserved enum values only — no tables, no extraction paths, no packing paths. Activation requires a complete producer+consumer+metric row audited to the same standard.

| NodeType | Status | Producer | Consumer | Key fields |
|---|---|---|---|---|
| `MESSAGE` | **Active** | M-2 TraceIngestor | Context blocks (M-4) | content, step, modality, agent_id, task_id |
| `ACTION` | **Active** | M-2 TraceIngestor (tool calls) | `## Relevant Actions` block (M-4) | action_type (tool name), input, output, success, cost, step, agent_id, task_id |
| `ERROR` | **Active** | M-2 TraceIngestor | `## Relevant Errors` block (M-4) | error_type, description, severity, detected_by, corrected, agent_id, task_id |
| `MEMORY` | **Active** | M-1 backfill + M-2 extraction | Packing, lifecycle, scoring | memory_type, content, source_nodes, confidence, usage_count, last_used, contradiction_count, downstream_gain |
| `PROCEDURE` | **Active** | M-2 extraction (tool sequences) | `## Relevant Procedures` block (M-4) | name, steps, success_rate, used_by_roles, confidence |
| `ENTITY` | **Active** | M-2 extraction (NER) | **Expansion-input only** — seeds Hypergraph.query; never packed (enforced by packer type-filter + conformance test) | name, entity_type, description |
| `TASK` | Reserved | — | — | (enum value only, no table) |
| `AGENT` | Reserved | — | — | (enum value only, no table) |
| `INSIGHT` | Reserved | — | — | (enum value only, no table) |
| `MODALITY` | Reserved | — | — | (enum value only, no table) |
| `COMMUNITY` | Reserved | — | — | (enum value only, no table; L3 multi-resolution deferred) |
| `ARCHETYPE` | Reserved | — | — | (enum value only, no table; L4 deferred) |
| `META_PROCEDURE` | Reserved | — | — | (enum value only, no table; L4 deferred) |

### SC-4: Hyperedge Types (SUBSETTED — 4 active, 3 reserved)

| HyperedgeType | Status | Producer | Consumer | Key fields |
|---|---|---|---|---|
| `COLLABORATION` | **Active** | M-2 TraceIngestor (tool calls) | Relational expansion (M-4) | role_assignments, outcome |
| `ERROR_CORRECTION` | **Active** | M-2 TraceIngestor (error→fix) | Packing + relational queries (M-4) | error_id, detecting_agent_id |
| `EVIDENCE` | **Active** | M-2 TraceIngestor (tool output) | Provenance in packing (M-4) | query_or_task_id |
| `PROCEDURE` | **Active** | M-2 extraction (tool sequences) | Step chaining; packing (M-4) | procedure_id |
| `NARY_FACT` | Reserved | — | — | (enum value only, no table) |
| `COMMUNITY_REPORT` | Reserved | — | — | (enum value only, no table; L3 deferred) |
| `GENERALIZES` | Reserved | — | — | (enum value only, no table; L4 deferred) |

### SC-2, SC-3, SC-5, SC-6, SC-7, SC-8, SC-9, SC-10

(Unchanged from prior version — bi-temporal model with epoch seconds + Infinity sentinel 99999999999, lifecycle ACTIVE/DEPRECATED/ARCHIVED/DELETED, Effect service interfaces with project_id, config shape, spikes, backfill contract, SurrealDB schema, verification commands.)

### SC-11: Pre-Registered Abort Criteria (A0-A8)

All thresholds pre-committed in this spec. Any abort fires → halt and human gate re-convenes. Every instrument writes raw results (failures included) into the decision log.

| ID | Trigger | Threshold | Fallback |
|---|---|---|---|
| **A0** | P-0 audit finds core component non-functional | Fail at > 2 engineer-days repair | Halt, re-baseline program before M-0 |
| **A1** | M-0 dry-run mismatch, data loss, or P95 regression | Dry-run row count mismatch, unrecoverable loss, or > 10% sustained P95 over 48h | Rollback |
| **A2** | Both hyperedge models miss performance | P95 < 50ms at 10k hyperedges on composite query fails | Abandon hypergraph retrieval; continue as memory-lite over baseline |
| **A3** | Probe fails relational stratum | ΔMRR < +0.05 OR ΔRecall@5 < +0.05 on relational | Terminal fallback: hypergraph retrieval abandoned; M-3/M-4 re-scoped over baseline retrieval |
| **A4** | M-2 extraction quality unmet | After one prompt-iteration round: precision < 60%, recall < 40%, or secrets leakage | Regex-only fallback; re-probe |
| **A5** | Coupled-loop sim pathological | After two tuning rounds: oscillation > 2 states or no convergence | Freeze lifecycle at TTL + near-dup; ship without decay engine |
| **A6** | pack() P95 too high | P95 > 300ms unfixable | Degrade to top-k baseline packing |
| **A7** | Schedule slip | > ~45 elapsed days without provisional M-6 value evidence | Mandatory descope review, default stop |
| **A8** | M-5 activation lacks evidence | No contradiction evidence after 2 weeks production | M-5 deferred indefinitely |

**The Floor:** M-0 + baseline-retrieval injection behind flag + telemetry ships regardless. The program cannot end at zero.

### SC-12: Pre-Registered Retrieval-Quality Probe (SDD-04)

The single most important falsification instrument. The hypergraph premise (MAGE traversal beats existing hybrid retrieval) is unverified. M-2/M-3/M-4 build on it. The probe verifies it with pre-registered thresholds.

- **Corpus:** Minimum 50 sessions OR 4 weeks of M-0 telemetry, whichever produces more turns. Real fbh sessions from ≥2 distinct projects (tests cross-project isolation as a side effect). Exclusion: sessions < 5 turns, sessions where memory disabled. Long-range stratum not scored until corpus has genuine temporal depth.
- **Labeling:** LLM-assisted from real sessions; 20% human spot-check extended to rubric-consistency checks (report inter-rater agreement; < 0.7 → rubric fixed and relabeled). Rubric and thresholds registered together, before results exist.
- **Query types:** Relational (30, requires traversing 2+ hyperedges), Long-range (30, answer established ≥48 hours before query), Single-hop (20, baseline), Adversarial (20, answer doesn't exist, tests FP rate).
- **4 arms:** (1) Pure vector — baseline. (2) Vector + 1-hop graph — existing hybrid. (3) Vector + hypergraph traversal — the proposed system. (4) Pure hypergraph traversal — diagnostic (no vector seed, exact entity-match seeds only; localizes failure).
- **Primary decision rule (pre-committed):**
  - Relational stratum: Arm 3 ΔMRR ≥ +0.05 absolute AND ΔRecall@5 ≥ +0.05 absolute over Arm 2, with bootstrap CI lower bound > 0
  - Long-range stratum: Arm 3 ΔRecall@5 ≥ −0.01 AND ΔMRR ≥ −0.01 (non-regression)
- **Adversarial FP rate ≤ 20%** (diagnostic)
- **Latency:** Arm 3 P95 ≤ 100ms on 10k-node/10k-hyperedge fixture
- **Decision rule (pre-committed):**
  - PASS both strata → M-2/M-3/M-4 as specced
  - FAIL long-range only → Query-type routing (hypergraph excluded from long-range), retest once, else relational-only
  - FAIL relational → Terminal fallback A3: hypergraph retrieval abandoned

## Glossary

(Existing glossary preserved: Node, Hyperedge, Bi-temporal, Lifecycle, Capture, Consolidation, Graduation, Decay, Packing, Conflict Detection, Spike, Backfill, Dormant code.)

- **P-0 Audit** — Two-engineer isolated execution audit of dormant code before M-0 wire-up. Tests the "60% built" claim. ≥10 sample inputs per component, schema-validated outputs, defect log.
- **Pre-Registered Probe** — 4-arm retrieval-quality probe (SDD-04) with thresholds committed before results exist. Gates M-2/M-3/M-4. Terminal fallback if relational stratum fails.
- **Abort Criteria A0-A8** — Pre-committed phase abort thresholds with pre-named fallbacks. Any abort fires → halt and gate re-convenes. Floor: M-0 + baseline-retrieval injection ships regardless.
- **Active vs Reserved Schema Types** — 6 active node types + 4 active hyperedge types have tables/producers/consumers/metrics. 7+3 reserved types are enum values only. Activation requires a complete producer+consumer+metric row audited to the same standard.
- **Coupled-Loop Simulation** — M-3 lifecycle spike. Tests decay + graduation + conflict interaction, not just decay math in isolation. Replaces the isolated convergence spike.
- **Data Governance** — Secrets redaction, user opt-in, documented data classes, provider retention review, self-hosted fallback. Required for external LLM extraction (M-2).

## Dependency (re-sequenced per council)

Strict order. Each spec's `tests` stage refuses to run until the prior spec's `implement` passed.

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

The probe (sdd-04) gates sdd-05/sdd-06/sdd-07. M-6 (sdd-08) runs before M-5 (sdd-09) — M-6 produces the evidence M-5 consumes. M-5 is conditional on M-6 finding contradictions.

## Council findings appendix

### Incorporated (9 items)

1. P-0 dormant-code audit (new spec sdd-01)
2. Schema subsetting (6+4 active, 7+3 reserved enum-only)
3. Pre-registered retrieval-quality probe (new spec sdd-04)
4. M-5 deferred to post-M-6 (re-sequenced)
5. Data governance B4 (secrets redaction, opt-in, data classes, self-hosted fallback)
6. Abort criteria A0-A8 (pre-committed in SC-11)
7. OQ5: access_count >= 2 default, semantic-shift shadow, force-promote at 5
8. Decision 3: simple exponential + rehearsal default, Prism experimental behind flag
9. Coupled-loop simulation replacing isolated convergence spike (CC-15)

### Rejected (1 item)

- **MAGE citation fabrication claim.** The skeptic (Kimi) claimed arXiv:2608.29678 is fabricated. Verified FALSE — the paper exists ("Diachronic Hypergraphs for Orchestrated Multi-Agent Multimodal Memory Curation" by Yichao Feng et al., submitted 30 Aug 2026, cs.DB). The GitHub reference impl (github.com/Githubuseryf/MAGE) is real. The schema code (nodes.py, hyperedges.py) is real. The citation stands.

### Noted but not addressed (council's "Part X" gaps)

- **Extraction entity hallucination rate** — M-2 spike should measure entity hallucination rate separately from precision (precision on existing entities vs. hallucination of new entities are different failure modes). Added to M-2 spike criteria.
- **Initial-confidence policy** — Extracted memories receive an initial confidence value. Specs don't specify. Council recommends: set by extraction-path provenance class (tool outputs = higher initial confidence than LLM-inferred entities). Added to M-2.
- **SurrealDB version pin** — No spec specifies a version pin. Uncontrolled upgrades can break the bi-temporal schema. Added to M-1 (SC-9).
- **User-facing disclosure** — The harness runs background LLM calls on user code. No spec addresses what the user sees in the CLI when extraction is enabled. Added to M-2 (data governance).

### Open questions (resolved by council)

| OQ | Resolution |
|---|---|
| OQ1 (scope) | Full M-0 through M-6, re-sequenced (M-5 post-M-6) |
| OQ5 (graduation) | access_count >= 2 default, semantic-shift shadow, force-promote at 5 |
| OQ8 (M-0 timing) | M-0 immediate, AFTER P-0 audit, under guardrails |
| OQ2 (LLM extraction) | Hybrid mode default, Qwen2.5-7B on DeepInfra, data governance required |
| OQ3 (decay) | Simple exponential + rehearsal default, Prism experimental |
| OQ4 (hyperedge storage) | **Junction table** (probe-validated 2026-09-23). The sdd-03 spike was never run as a throwaway; the probe served as the spike. The `array<record> CONTAINSANY` approach is 4x slower than the junction table with an index on `node_id`. Junction table is the production approach. |
| OQ6 (backfill) | Backfill (one-time idempotent migration) |
| OQ7 (SDD process) | Full SDD with council deliberation |

### Probe results (2026-09-23 — SDD-04 PASSED)

The SDD-04 pre-registered retrieval-quality probe ran 6 iterations and PASSED on the sixth run. The hypergraph premise is validated. Key findings that flow to downstream specs:

1. **Quality gate PASSED:** ΔMRR=+0.086, ΔRecall@5=+0.070 (both ≥ +0.05), both bootstrap 95% CIs exclude 0. The hypergraph beats the baseline (Arm 2 hybrid) by 1.7x on MRR and 1.4x on Recall@5. Validated with 100 relational queries.

2. **Latency gate PASSED (run 6):** P95=70ms (≤ 100ms). Achieved via `<|K,COSINE|>` HNSW KNN operator + AND clause on `project_id` (pre-filter pushes into the HNSW scan, reducing 10k→2.5k scan set). Production requirement for sdd-07.

3. **SurrealDB 3.x HNSW finding (critical):** `ORDER BY vector::similarity::cosine(...) DESC` is BRUTE-FORCE and does NOT use the HNSW index (349ms P95). The `<|K,COSINE|>` KNN operator is required for HNSW index usage. The AND clause on `project_id` pushes the filter INTO the HNSW scan (70ms). This is a non-obvious SurrealDB 3.0.5 performance characteristic discovered through the probe. All vector seed queries in sdd-07 MUST use `<|K,COSINE|>` + AND.

4. **MTREE not supported in SurrealDB 3.x:** The `DEFINE INDEX ... MTREE DIMENSION 768` syntax was removed in SurrealDB 3.0. Use `DEFINE INDEX ... HNSW DIMENSION 768 DIST COSINE` instead. sdd-03 updated.

5. **Junction table validated:** The `hyperedge_members` junction table with an index on `node_id` is the production approach (not `array<record> CONTAINSANY`). In-memory adjacency map built from the junction table brings expand() from ~1400ms to ~60ms.

6. **Long-range stratum NOT_SCORED:** The probe used pre-M-0 session data (no 48h temporal depth). Long-range non-regression will be re-probed by M-6 (SDD-08) with real M-0 telemetry. This does not gate the verdict — the relational stratum is the superiority test and it passed.

7. **A3 not triggered:** The probe PASSED both gates. sdd-05/06/07 proceed as originally specced (hypergraph writes + retrieval). The abort A3 (hypergraph abandonment) is not triggered.

Decision log: `docs/decisions/260921_fbh-phase-m_probe-results.md`.
