# Re-Audit Report: SDD-05 Auto-Capture (council-amended with data governance)
**Auditor:** Fresh-context adversarial agent (re-audit)
**Date:** 2026-09-21
**Spec:** `docs/specs/260921_fbh-phase-m_sdd-05-auto-capture.md` (335 lines)
**Prior audit:** `audit/sdd-03-auto-capture.md` (pre-resequence, pre-governance)

## Scope

Nine criteria checked against the council-amended spec and against `packages/fbh/src/`.

## 1. Data governance (CC-12, B4) — PASS

| Sub-criterion | WHERE | Evidence |
|---|---|---|
| Secrets redaction, 5-seeded fixture, zero leakage | W-21; `governance.test.ts::secrets_redaction`; fixture `test/fixture/governance/secrets-fixture.json` | W-21 enumerates patterns (sk-/AIza/ghp_/AKIA/xoxb-, JWT eyJ, `auth.json` contents, bearer, password/secret/token JSON fields). Test loads 5 representative secrets (AWS `AKIA...`, OpenAI `sk-...`, GitHub `ghp_...`, JWT `eyJ...`, `auth.json` content), runs filter, asserts zero of 5 in redacted payload (substring match). On leak, test fails AND LLM path gated off. Filter runs BEFORE LLM call (Wiring #5). |
| Explicit opt-in, default FALSE | W-22; Config `"external_opt_in": false` (line 66); `governance.test.ts::opt_in`, `extract.test.ts::opt_in_default_off` | Config default is `false` (NOT default-on per CC-12). W-22: when `false`, no external LLM call regardless of `mode` or `threshold`. Tests mutate to `true` and assert LLM call occurs; with `false`, LLM call counter = 0. |
| Data classes doc | W-23; `governance.test.ts::data_classes_doc`; doc `docs/specs/data-flow-extraction.md` | W-23 requires four sections: (a) classes that leave (turn text, ACTION input/output summaries, prior-turn MESSAGE content), (b) classes that do NOT leave (embeddings/Float32Array, `auth.json`, API keys, vector data), (c) provider retention policy, (d) logging policy (info = metadata only, debug = full payloads). Plus ASCII data flow diagram: session content → redaction → LLM payload → provider → response → hypergraph store. Test verifies via `Bun.file`. |
| Self-hosted fallback pre-named | W-24; Config `"self_hosted_fallback_model": "ollama://qwen2.5:7b-instruct"` (line 65); `governance.test.ts::self_hosted_fallback` | Fallback is local Qwen2.5-7B-Instruct via Ollama or vLLM, accessed through existing `Provider.Service` (no new HTTP client). When `self_hosted = true` AND `external_opt_in = false`, extraction routes to self-hosted model; redaction W-21 still applies (defense in depth). Test asserts `providerID = "ollama"` and DeepInfra call counter = 0. |

Net-new per council (Seam #9): prior version had no governance WHEN/SHALL. W-21–W-24, W-26, and the data flow doc are all net-new. All four sub-criteria met with 1:1 VERIFY tests.

## 2. Entity hallucination rate metric in spike — PASS

- Spike section (lines 43–53): "measure entity hallucination rate separately from precision (precision on existing entities vs. hallucination of new entities are different failure modes per council 'Part X' gap)."
- W-19: "AND measure entity hallucination rate separately from precision (the count of new entities extracted by the LLM that do not appear in the trace's manually-labeled ground-truth entity set, divided by the total extracted entity count)."
- Spike pass criterion remains latency + cost (`< 2_000` ms AND `< $0.001`/turn per SC-7). Hallucination rate is informational at spike stage; reported in test output, not gating.
- `spike.test.ts::qwen_latency_cost` loads `test/fixture/spike-extraction/ground-truth-entities.json`, computes hallucination rate, reports in test output.
- Hallucination rate feeds abort A4's decision log at W-27 (raw results include `entity hallucination rate from W-19`).
- Seam #11 explicitly documents this as net-new per council.

Metric is in the spike, separate from precision, with a ground-truth fixture. ✅

## 3. Initial-confidence policy (tool outputs 0.7, LLM-inferred 0.5) — PASS

- W-25: "(a) `0.7` for nodes derived from deterministic paths — `PROCEDURE` from action chain detection (W-17), `MEMORY` from `Consolidation.extractTurn` (regex); (b) `0.5` for nodes inferred by the extraction LLM — `ENTITY` from `EntityExtractor.extract`, `MEMORY` from `MemoryExtractor.extract`."
- Provenance recorded on `source_path` field: `"tool"` for deterministic, `"llm"` for LLM-inferred.
- W-17 references W-25 for `PROCEDURE` confidence (0.7, `source_path = "tool"`).
- `confidence.test.ts::provenance_policy` asserts all four cases: PROCEDURE → 0.7/tool, MEMORY regex → 0.7/tool, ENTITY LLM → 0.5/llm, MEMORY LLM → 0.5/llm.
- Seam #10 documents this as net-new per council ("Part X" gap). Prior version had `confidence = 0.5` for PROCEDURE with no policy.

Policy is explicit, provenance-tagged, and 1:1 tested. ✅

## 4. User-facing disclosure (CLI startup message) — PASS

- W-26: "the CLI SHALL display a startup message at session start indicating that background LLM extraction is enabled and that session content is sent to the configured external provider."
- Message shown once per session startup (not per turn).
- Message includes parsed provider name (e.g., `"DeepInfra"` from `Provider.parseModel`) and reference to `docs/specs/data-flow-extraction.md`.
- Example: `"Memory extraction enabled: session content is sent to DeepInfra for LLM-driven extraction. See docs/specs/data-flow-extraction.md for data classes."`
- Suppression conditions: `mode = "regex"` OR `external_opt_in = false` OR `self_hosted = true` with no external provider call.
- Wiring #6: printed to stderr (so stdout stays clean for tooling) at `src/cli/index.ts` entry after config load.
- `disclosure.test.ts::startup_message` asserts presence when enabled vs external provider, absence in three disabled cases (regex mode, opt_in false, self_hosted true).

Disclosure is wired, conditional, and 1:1 tested. ✅

## 5. Schema subsetting (only 6 active node types in TraceIngestor) — PASS

- Line 12: "emits the 6 active node types (MESSAGE, ACTION, ERROR, MEMORY, PROCEDURE, ENTITY per CC-13)."
- Line 16: "TraceIngestor only emits the 6 active node types. The 7 reserved node types (Task, Agent, Insight, Modality, Community, Archetype, MetaProcedure) are enum-only — NO tables, NO extraction paths."
- W-4: "Per CC-13, the hyperedge SHALL NOT link to an `AGENT` node (AGENT is reserved, enum-only, no table); the `agent_id` is carried as a field on `role_assignments`, not as a node reference."
- Out of scope (lines 40–41): all 7 reserved node types listed as enum-only; `INSIGHT` is no longer "deferred to M-3" — it is reserved enum-only. Activation requires a new spec.
- `trace.test.ts::collaboration` explicitly asserts `COLLABORATION` links `MESSAGE` + `ACTION` (NOT `AGENT`), with `role_assignments = {agent_id: agent_name}` as field, not node ref.
- Seam #7 documents the AGENT removal per CC-13.

Six active, seven reserved, AGENT-as-field not node. ✅

## 6. Abort A4 (precision<60% OR recall<40% OR secrets leakage = regex-only fallback) — PASS

- Abort A4 (SC-11) summary at line 18: "precision < 60%, recall < 40%, or secrets leakage → regex-only fallback; re-probe. Pre-committed in SC-11; SHALL NOT be re-tuned after results arrive."
- W-27: "After one prompt-iteration round of M-2 extraction (the first production deployment, measured against a labeled evaluation set of ≥ 50 turns from real sessions with manually-labeled ground-truth entities and memories), IF precision < 60% OR recall < 40% OR secrets leakage to DeepInfra is detected (W-21 filter fails), the system SHALL switch to regex-only extraction fallback (`memory.extraction.mode` forced to `"regex"` in config) and re-probe the extraction quality on the next iteration."
- Decision log per CC-11: raw results (precision, recall, entity hallucination rate from W-19, leakage count) written to `docs/decisions/`.
- Pre-committed criterion; SHALL NOT be re-tuned after results arrive.
- Floor preserved: regex path (W-10, W-12) is the guaranteed-success path and remains available even if A4 fires.
- Three tests: `abort.test.ts::a4_precision` (precision<60%), `::a4_recall` (recall<40%), `::a4_secrets_leakage` (W-21 filter bypass). Each asserts `mode` forced to `"regex"` + decision log entry.

Three-trigger abort, pre-committed, regex floor preserved, 1:1 tested (three tests for three triggers). ✅

## 7. Dependency on SDD-04 (probe must pass) — PASS

- Header line 9: "Depends on: SDD-04 (pre-registered retrieval-quality probe — relational stratum MUST PASS per SC-12 before M-2 starts; transitive: SDD-03 M-1 hypergraph schema, SDD-02 M-0 wire-up, SDD-01 P-0 dormant-code audit)."
- Seam #8: "Per the council re-sequencing, the pre-registered probe (SDD-04) gates M-2: the relational stratum MUST PASS (SC-12) before M-2 starts. SDD-05 now depends on SDD-04... IF the probe fails the relational stratum, terminal fallback A3 fires and M-2 is re-scoped to baseline retrieval (no hypergraph traversal); the extraction pipeline still runs, but the consumed `@foxybear/Hypergraph` service is the baseline-retrieval variant."
- SDD-04 spec exists at `docs/specs/260921_fbh-phase-m_sdd-04-retrieval-probe.md` (verified).
- Re-sequence documented: prior version (sdd-03) depended on SDD-02 (M-1 schema); council re-sequence puts SDD-04 as the gate.
- Terminal fallback A3 path documented (extraction runs against baseline-retrieval Hypergraph variant).

Probe gate, transitive deps, A3 fallback all explicit. ✅

## 8. W-7 wiring fix preserved (post-loop :1541, not :1538) — PASS

- W-7: "WHEN the session prompt loop exits the step loop (`src/session/prompt.ts:1541`, after `if (outcome === "break") break`) for a user message — the turn is complete — and the turn's final step result (the last `handle.process` return at `src/session/prompt.ts:1493`) is not `"compact"`, the post-turn hook SHALL invoke `MemoryCapture.capture(turn)` exactly once per turn."
- Wiring #1: "after the step loop exits (after `if (outcome === "break") break` at `:1537`), alongside `compaction.prune`, call `MemoryCapture.capture({...})` via `Effect.forkIn(scope)` (the same `scope` used by `compaction.prune` at line 1541). Track the final step `result` from `handle.process` (`src/session/prompt.ts:1493`) across loop iterations in a closure variable (e.g., `let lastResult` declared before the `while (true)` loop at `:1316`, updated inside the loop after `handle.process` returns). Guard: only fire if `lastResult !== "compact"`. Wiring inside the loop at `:1538` would miss `"stop"` turns (the loop breaks at `:1537` before reaching `:1538`) and would fire per-step for `"continue"`/`"compact"` turns."
- Seam #2 preserves the same anchor narrative.
- `hook.test.ts::fires_once` asserts: 1-step session triggers capture exactly once; multi-step turn triggers capture exactly once; `"stop"` captured; `"compact"` NOT captured (via `handle.process` test double returning `"compact"` on last call).

Source re-verified at `packages/fbh/src/session/prompt.ts`:

| Line | Content (verified) | Spec claim |
|---|---|---|
| `:1316` | `while (true) {` | ✅ Step loop start |
| `:1493` | `const result = yield* handle.process({` | ✅ LLM call |
| `:1525` | `if (result === "stop") return "break" as const` | ✅ Stop branch |
| `:1526-1534` | `if (result === "compact") { yield* compaction.create({...}) }` | ✅ Compact branch |
| `:1535` | `return "continue" as const` | ✅ Covers compact+continue |
| `:1536` | `}).pipe(Effect.ensuring(instruction.clear(handle.message.id)))` | ✅ |
| `:1537` | `if (outcome === "break") break` | ✅ Loop exit |
| `:1538` | `continue` | ✅ Loop continue |
| `:1539` | `}` | ✅ End of step loop |
| `:1541` | `yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))` | ✅ Post-turn anchor |
| `:1542` | `return yield* lastAssistant(sessionID)` | ✅ |

The fix is preserved: hook wired at `:1541` (post-loop, alongside `compaction.prune`), not `:1538` (inside loop). The three first-audit contradictions (stop missed, compact captured, per-step fire) are all resolved by the `lastResult !== "compact"` guard tracked across iterations. ✅

## 9. WHAT ↔ VERIFY 1:1 — PASS

All 27 WHAT statements (W-1 through W-27) have at least one VERIFY test. Every VERIFY test row maps to a WHAT. No orphan tests, no orphan WHATs.

| WHAT | VERIFY test(s) | Status |
|---|---|---|
| W-1 | `trace.test.ts::action` | ✅ |
| W-2 | `trace.test.ts::error` | ✅ |
| W-3 | `trace.test.ts::message` | ✅ |
| W-4 | `trace.test.ts::collaboration` | ✅ |
| W-5 | `trace.test.ts::correction` | ✅ |
| W-6 | `trace.test.ts::evidence` | ✅ |
| W-7 | `hook.test.ts::fires_once` | ✅ |
| W-8 | `hook.test.ts::does_not_block` | ✅ |
| W-9 | `extract.test.ts::llm_mode` | ✅ |
| W-10 | `extract.test.ts::regex_mode`, `::hybrid_below` | ✅ |
| W-11 | `extract.test.ts::scoring` | ✅ |
| W-12 | `extract.test.ts::fallback` | ✅ |
| W-13 | `extract.test.ts::batch` | ✅ |
| W-14 | `extract.test.ts::no_leak` | ✅ |
| W-15 | `extract.test.ts::provider_path` | ✅ |
| W-16 | `dependency.test.ts::chain` | ✅ |
| W-17 | `dependency.test.ts::procedure` | ✅ |
| W-18 | `scheduler.test.ts::real_ids` | ✅ |
| W-19 | `spike.test.ts::qwen_latency_cost` | ✅ |
| W-20 | `config.test.ts::mode`, `::threshold`, `::batch_size`, `::async`, `::external_opt_in`, `::self_hosted` | ✅ |
| W-21 | `governance.test.ts::secrets_redaction` | ✅ |
| W-22 | `extract.test.ts::opt_in_default_off`, `governance.test.ts::opt_in` | ✅ |
| W-23 | `governance.test.ts::data_classes_doc` | ✅ |
| W-24 | `governance.test.ts::self_hosted_fallback` | ✅ |
| W-25 | `confidence.test.ts::provenance_policy` | ✅ |
| W-26 | `disclosure.test.ts::startup_message` | ✅ |
| W-27 | `abort.test.ts::a4_precision`, `::a4_recall`, `::a4_secrets_leakage` | ✅ |

Coverage complete. The W-22/W-20 overlap on `external_opt_in` is intentional (W-22 establishes the default-false policy and LLM-gating semantics; W-20 covers config-mutation behavior). Both WHATs are independently tested.

## Anchor regression check

| Anchor | File:Line | Re-verified |
|---|---|---|
| `handle.process` call | `prompt.ts:1493` | ✅ `const result = yield* handle.process({` |
| Post-turn outcome branch | `prompt.ts:1525-1541` | ✅ `:1525` stop, `:1537` break, `:1538` continue, `:1541` post-turn anchor |
| Scheduler `memory-consolidation` task | `scheduler.ts:365-382` | ✅ Stub `recentSessionIds: []` still at `:380` (fix unshipped — W-18 or SDD-02 will replace) |

No drift. Scheduler stub confirmed still present (so W-18 is genuinely needed, defensive against SDD-02 shipping first).

## Non-blocking observations

- **N-1 (carryover):** `extractFacts` not exported (`consolidation.ts:67`). Spec Seam #6 proposes option (a) one-line `export` (preferred, wire-up per CC-2) or option (b) duplicate pattern list in `score.ts`. Implementation-time decision.
- **N-2 (carryover):** W-12 `extract.test.ts::fallback` remains partial — tests primary-failure→fallback and both-failure→regex, but does not exhaustively test the re-queue cap (`batch_size` retries across session). Non-blocking.
- **N-3 (new, minor):** `extract.test.ts::opt_in_default_off` (W-22) and `config.test.ts::external_opt_in` (W-20) overlap heavily — both mutate `external_opt_in` from `false` to `true` and assert LLM-call-counter change. Spec author may consolidate at implementation time. Non-blocking.
- **N-4 (new, minor):** Hallucination rate is informational at spike (W-19) and recorded in A4 decision log (W-27) but is NOT in the A4 abort trigger (only precision < 60%, recall < 40%, secrets leakage). Council's "Part X" gap is closed for measurement; whether hallucination rate should eventually gate an abort is a future-spec decision. Non-blocking.

## Blocking issues

None.

VERDICT: PASS

All nine audit criteria pass:

1. **Data governance (CC-12, B4)** — secrets redaction with 5-seeded fixture asserting zero leakage (W-21, `governance.test.ts::secrets_redaction`), explicit opt-in default FALSE (W-22, config line 66, two tests), data classes doc with four sections + ASCII diagram (W-23, `governance.test.ts::data_classes_doc`), self-hosted fallback pre-named `ollama://qwen2.5:7b-instruct` (W-24, `governance.test.ts::self_hosted_fallback`).
2. **Entity hallucination rate in spike** — W-19 measures it separately from precision with a manually-labeled ground-truth fixture; reported as informational, feeds A4 decision log.
3. **Initial-confidence policy** — W-25: tool-output provenance → 0.7 (`source_path = "tool"`), LLM-inferred → 0.5 (`source_path = "llm"`); `confidence.test.ts::provenance_policy` asserts all four cases.
4. **User-facing disclosure** — W-26: CLI startup message once per session, conditional on `mode ∈ {hybrid,llm}` AND `external_opt_in = true` AND `self_hosted = false`, includes provider name + doc reference, printed to stderr; `disclosure.test.ts::startup_message` covers all four cases.
5. **Schema subsetting** — 6 active node types only (MESSAGE, ACTION, ERROR, MEMORY, PROCEDURE, ENTITY); 7 reserved types enum-only, no tables, no extraction paths; AGENT carried as `role_assignments` field, not node ref (W-4).
6. **Abort A4** — W-27: precision<60% OR recall<40% OR secrets leakage → regex-only fallback + re-probe; pre-committed in SC-11, SHALL NOT be re-tuned; decision log records raw results; regex floor preserved; three 1:1 tests for three triggers.
7. **SDD-04 dependency** — header line 9 + Seam #8: relational stratum MUST PASS per SC-12 before M-2 starts; transitive deps SDD-03/SDD-02/SDD-01; A3 fallback path documented; SDD-04 spec file exists.
8. **W-7 wiring fix preserved** — hook at `prompt.ts:1541` (post-loop, alongside `compaction.prune`), not `:1538` (inside loop); `lastResult !== "compact"` guard tracked across iterations; source re-verified line-by-line; `hook.test.ts::fires_once` covers stop-captured, compact-not-captured, exactly-once-per-turn.
9. **WHAT ↔ VERIFY 1:1** — all 27 WHATs (W-1 through W-27) have at least one VERIFY test; every VERIFY row maps to a WHAT; no orphans in either direction.

Source anchors (`prompt.ts:1493/1525/1537/1538/1541`, `scheduler.ts:380`) re-verified against `packages/fbh/src/`. No drift. Scheduler stub confirmed still present (W-18 is genuinely needed).

The spec is ready for the human gate and `implement`.
