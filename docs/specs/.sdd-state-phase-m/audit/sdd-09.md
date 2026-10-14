# Re-Audit Report: SDD-09 Conflict Detection (council-amended, DEFERRED)
**Auditor:** Fresh-context adversarial agent (re-audit of council deferral)
**Date:** 2026-09-21
**Spec:** `260921_fbh-phase-m_sdd-09-conflict-detection.md` (revised 2026-09-22 per council deferral)
**Prior audit:** `sdd-06-conflict-detection.md` (2026-09-21, PASS — technical content)
**Scope:** Verify the council deferral amendments (M-5 deferred to post-M-6, activation gate G1-G4, abort A8) are correctly integrated with prior re-audit-passed technical content (ConflictDetector interface, ADD/UPDATE/DELETE, delete_threshold, llm_verify fallback, Effect.runPromise, cross-project isolation, bi-temporal soft-delete, spike FP<10%), dependency on sdd-08 + sdd-05 + sdd-03, and WHAT↔VERIFY 1:1.

## Cross-references verified

| Source | Claim | Verified |
|---|---|---|
| Master spec `sdd-00-master.md:140` | A8 = "M-5 activation lacks evidence — No contradiction evidence after 2 weeks production — M-5 deferred indefinitely" | ✓ |
| Master spec `sdd-00-master.md:186` | "sdd-09 (M-5 conflict)   [DEFERRED post-M-6; ABORT A8 if no contradiction evidence]" | ✓ |
| Master spec `sdd-00-master.md:22,63,168` | A0-A8 pre-committed abort criteria; floor = M-0 + baseline-retrieval injection ships regardless | ✓ |
| SDD-08 `sdd-08-verification.md` req 16 | "if the contradiction rate is below 5%, abort A8 fires and M-5 is deferred indefinitely per SC-11. If the contradiction rate is ≥ 5%, sdd-09 (M-5) has evidence to activate." | ✓ |
| SDD-08 `sdd-08-verification.md` V12 | "If the contradiction rate is below 5% (pre-registered threshold per CC-11), flag `M5_DEFERRED_A8` ... If the contradiction rate is ≥ 5%, the spec SHALL record that sdd-09 (M-5) has evidence to activate." | ✓ |
| SDD-08 `sdd-08-verification.md` line 9 | "Per council re-sequencing, M-6 runs BEFORE M-5 (sdd-09). If the contradiction rate is below the pre-registered threshold (req 16), abort A8 fires and M-5 is deferred indefinitely." | ✓ |

The 5% activation threshold is owned by sdd-08 (req 16, V12), not by sdd-09. SDD-09 references it (`G2`: "the threshold value is defined in sdd-08's spec; referenced here as the M-5 activation gate"). This is the correct council-amended model — M-6 produces the evidence and owns the threshold; M-5 consumes the evidence to decide whether to activate. SDD-09 does not redefine the 5% value, avoiding threshold drift between the two specs.

---

## (1) M-5 DEFERRED to post-M-6 — PASS

- Title (line 1): "Phase M-5 — Conflict Detection (Deferred to post-M-6, conditional activation)" ✓
- Status (line 5): "Draft (technical content re-audit passed; deferral + activation gate + abort A8 added per council, pending human gate)" ✓
- Council deferral block (line 12): "Council deferral (2026-09-22): M-5 is deferred to post-M-6. Building conflict detection before measuring whether contradictions occur is 'infrastructure for an unmeasured problem.' M-6 (sdd-08) produces the contradiction-rate evidence M-5 consumes to decide whether to activate. The sdd-09 `implement` stage SHALL NOT proceed until sdd-08's `tests` stage has passed AND sdd-08 has measured a contradiction rate at or above the activation threshold (threshold defined in sdd-08, referenced here). If the contradiction rate is below threshold, M-5 remains deferred. If no contradiction evidence is produced after 2 weeks of production telemetry, abort A8 fires and M-5 is deferred indefinitely (per master SC-11)." ✓
- Activation gate section (lines 18-26): G1, G2, G3, G4 all present and correctly scoped as process gates (not runtime gates). ✓
- "What is explicitly NOT built" (line 165): "M-5 activation before M-6 evidence exists — the activation gate (G1-G4) is a hard process gate. No `implement` work on sdd-09 (not even a tracer bullet) is permitted until sdd-08's `tests` has passed AND the contradiction-rate evidence is in the decision log. A tracer bullet for the wiring point (req 1) is permissible only inside sdd-03's or sdd-05's own tracers, not as a sdd-09 activity." ✓ — this is a strong formulation that closes the "tracer bullet loophole" where implement work could sneak in before evidence.

The deferral is structural (gates `implement`, not just `design`) and explicit (council rationale cited, master SC-11 referenced, abort A8 wired).

---

## (2) Activation gate — SHALL NOT proceed unless sdd-08 produced contradiction-rate evidence above threshold (5%) — PASS

| Gate | Spec text (line) | Behavior |
|---|---|---|
| G1 (line 20) | "WHEN sdd-08 (M-6 verification) has not produced contradiction-rate evidence, sdd-09 (M-5) SHALL remain deferred. The sdd-09 `implement` stage SHALL refuse to run until sdd-08's `tests` stage has passed AND sdd-08 has published a measured contradiction rate to the decision log. The workstream's dependency chain (sdd-08 before sdd-09) SHALL be enforced by the `tools/sdd` pipeline's stage-gate check — sdd-09's `implement` task SHALL declare sdd-08 as a hard dependency, not a soft ordering hint." | Refusal when no evidence; hard dependency enforced by pipeline |
| G2 (line 22) | "WHEN sdd-08 (M-6) measured a contradiction rate at or above the activation threshold (the threshold value is defined in sdd-08's spec; referenced here as the M-5 activation gate), sdd-09 (M-5) SHALL be eligible to proceed to `implement`. The contradiction-rate evidence (raw measurement, threshold value, pass/fail decision) SHALL be recorded in the decision log before sdd-09 `implement` begins. The decision-log entry SHALL cite sdd-08's measurement run id so a future audit can trace M-5 activation back to the evidence that authorized it." | Eligible to proceed; decision log entry with citable run id |
| G3 (line 24) | "WHEN sdd-08 (M-6) measured a contradiction rate below the activation threshold, sdd-09 (M-5) SHALL remain deferred. The workstream SHALL mark sdd-09 as `deferred` and the human gate SHALL re-convene to decide whether to re-baseline the threshold, descope M-5, or wait for more production telemetry. The system SHALL NOT auto-promote M-5 to `implement` on a below-threshold measurement — a below-threshold result is evidence against activation, not a trigger for it." | Remains deferred; no auto-promotion; human gate re-convenes |

G1 makes the dependency hard (enforced by `tools/sdd` stage-gate check, not a soft ordering hint). G2 requires a citable measurement run id in the decision log — making the activation auditable. G3 explicitly forbids auto-promotion on below-threshold results (closing the failure-mode where "we measured, so we proceed" overrides the threshold). The threshold value itself is owned by sdd-08 (5%, verified at sdd-08 req 16 and V12) — sdd-09 references it, does not redefine it.

V13 (lines 185-191) tests all four gates as process-level tests against the `tools/sdd` stage-gate check:
- V13(a): refuse sdd-09 `implement` before sdd-08 `tests` passed → refusal
- V13(b): refuse sdd-09 `implement` after sdd-08 `tests` passed but no contradiction-rate evidence in decision log → refusal (G1 not satisfied — evidence publication required, not just `tests` passing)
- V13(c): proceed with sdd-09 `implement` after sdd-08 `tests` passed AND contradiction rate ≥ threshold recorded with citable measurement run id → proceeds (G2 satisfied)
- V13(d): refuse sdd-09 `implement` after sdd-08 `tests` passed AND contradiction rate < threshold recorded → refusal (G3 not satisfied), sdd-09 marked `deferred`
- V13(e): abort A8 simulation (see §3 below)
- V13 final sentence: "The activation threshold value is defined in sdd-08's spec (sdd-08 owns the contradiction-rate metric and threshold); V13 references it, does not redefine it. The workstream's `tools/sdd/workstreams/fbh-phase-m.json` SHALL list sdd-09's `implement` dependency as `["sdd-08"]` (hard), not as a soft ordering hint — verified by reading the workstream file."

V13(b) is the crucial test — it distinguishes "tests passed" from "evidence published" and requires both. This closes the loophole where sdd-09 could proceed on the basis of sdd-08's tests being green without the actual contradiction-rate measurement being recorded. ✓

---

## (3) Abort A8 (no contradiction evidence after 2 weeks production = deferred indefinitely) — PASS

G4 (line 26): "WHEN no contradiction evidence has been produced after 2 weeks of production telemetry following sdd-08's `tests` completion (abort A8 per master SC-11), sdd-09 (M-5) SHALL be deferred indefinitely. The workstream SHALL mark sdd-09 as `deferred-indefinitely`, the human gate SHALL re-convene to confirm the deferral, and the floor (M-0 + baseline-retrieval injection behind flag + telemetry per master SC-11) SHALL ship regardless. Abort A8 is a pre-committed terminal state — the program SHALL NOT continue to fund M-5 implementation effort once A8 fires without a re-baselined activation threshold approved by the human gate."

V13(e) (line 190): "Simulate abort A8: 2 weeks elapse since sdd-08 `tests` completion with no contradiction evidence recorded — expected: sdd-09 marked `deferred-indefinitely`, human-gate re-convene logged, floor (M-0 + baseline-retrieval injection) confirmed still shipping."

Cross-checked against master SC-11 (line 140: "A8 | M-5 activation lacks evidence | No contradiction evidence after 2 weeks production | M-5 deferred indefinitely") and master architecture diagram (line 186: "sdd-09 (M-5 conflict)   [DEFERRED post-M-6; ABORT A8 if no contradiction evidence]"). Both match.

Three strengths of G4's formulation:
1. **Clock start anchored to sdd-08's `tests` completion** — seam 5 (line 157) makes this explicit: "The 2-week production telemetry window for abort A8 is measured from sdd-08's `tests` completion timestamp, not from sdd-09's spec acceptance date — sdd-09 can sit deferred indefinitely without the clock starting; the clock starts when M-6 evidence begins accumulating." This prevents the clock from starting prematurely.
2. **Floor ships regardless** — even on abort, the M-0 baseline-retrieval injection + telemetry ships. This matches master SC-11 line 22 ("Floor: M-0 + baseline-retrieval injection ships regardless") and ensures M-5 deferral does not block M-0.
3. **No continued funding without re-baselined threshold** — "the program SHALL NOT continue to fund M-5 implementation effort once A8 fires without a re-baselined activation threshold approved by the human gate." This prevents sunk-cost continuation (the explicit purpose of SC-11's pre-committed aborts per master line 22).

---

## (4) Dependency on sdd-08 (M-6) + sdd-05 (M-2) + sdd-03 (M-1) — PASS

Line 7 "Depends on:" lists all three with specific reuse rationale:

| Dependency | What M-5 consumes from it | Spec text |
|---|---|---|
| SDD-08 (M-6 verification) | Contradiction-rate evidence M-5 consumes to decide whether to activate; activation threshold (5%) defined in sdd-08, referenced in sdd-09 | "produces the contradiction-rate evidence M-5 consumes to decide whether to activate; the activation threshold is defined in sdd-08 and referenced here" |
| SDD-05 (M-2 auto-capture) | `ActionNode`/`ErrorNode`/hyperedges for path localization (req 13); extraction LLM client reused for `llm_verify` (req 12, seam 4) | "`ActionNode`/`ErrorNode`/hyperedges for path localization, extraction LLM client reused for `llm_verify`" |
| SDD-03 (M-1 hypergraph schema) | `node`/`hyperedge`/`event` tables, bi-temporal `BaseNode` with `invalidated_by` + `prev_version_id`, `INVALIDATE` event_type | "`node`/`hyperedge`/`event` tables, bi-temporal `BaseNode` with `invalidated_by` + `prev_version_id`, `INVALIDATE` event_type" |

Each dependency is concretely traced to a spec requirement (not a vague "depends on" hint):
- SDD-08 → activation gate G1-G4, V13
- SDD-05 → req 13 (`localize` queries `ActionNode`/`ErrorNode`/`MessageNode` via `COLLABORATION`/`EVIDENCE`/`ERROR_CORRECTION` hyperedges), req 12 (`llm_verify` reuses extraction LLM `memory.extraction.model` per SDD-05), seam 4 (two failure modes for the LLM client)
- SDD-03 → reqs 17-21 (bi-temporal fields `version`, `prev_version_id`, `valid_from`, `valid_to`, `tx_from`, `tx_to`, `status`, `invalidated_by`), req 21 (`INVALIDATE` event_type), req 5 (neighbor lookup on `node` table), req 13 (`SurrealHypergraphBackend.queryHyperedges`), seam 2 (interpretation of `INVALIDATES` edge as `invalidated_by` field + `INVALIDATE` event, not a new hyperedge type)

The hard dependency on sdd-08 is enforced by the workstream's stage-gate check (G1, V13), not a soft ordering hint — V13's final sentence requires `tools/sdd/workstreams/fbh-phase-m.json` to list `["sdd-08"]` as a hard dependency, verified by reading the workstream file. ✓

---

## (5) Re-audit-passed content preserved — PASS

Each item from the prior re-audit (`sdd-06-conflict-detection.md`, 2026-09-21, PASS) is preserved in the council-amended spec:

### ConflictDetector interface
- Header line 8: "Owns: SC-5 `ConflictDetector` service interface (`check(content, project_id) → ADD/UPDATE/DELETE`)" ✓
- HOW line 113: "`conflict.ts` — `ConflictDetector` Effect service (per SC-5). Built as `Layer.effect` in the daemon runtime, composed alongside `@foxybear/Memory`. Exposes `check(content: string, project_id: string): Effect<{ verdict: 'ADD' | 'UPDATE' | 'DELETE', target?: string }>`." ✓
- Interface signature unchanged from prior audit. ✓

### ADD/UPDATE/DELETE verdicts
- Req 2 (line 32): ADD proceeds with existing `storeImpl` flow (SurrealBackend or SQLite path, including dedup) ✓
- Req 3 (line 34): UPDATE triggers rewrite path (new node, `prev_version_id = old.node_id`, `version = old.version + 1`, `old.tx_to = now`, emit `UPDATE` event; no dedup) ✓
- Req 4 (line 36): DELETE triggers retract path (store new node, bi-temporal soft-delete old, emit `INVALIDATE` event; no dedup; no hard-delete) ✓
- Reqs 9/10/11 (lines 50, 52, 54): ADD/UPDATE/DELETE threshold semantics preserved ✓
- Reqs 16/17-19/20-21 (lines 70, 74-78, 82-84): full ADD/UPDATE/DELETE decision flows preserved ✓
- V1-V8 cover all three verdicts. ✓

### delete_threshold config
- Req 10 (line 52): "`>= memory.conflict.delete_threshold` (default 0.1, per SC-6 — consumed from config, NOT hardcoded; semantically distinct from `memory.decay.archived_threshold`, see req 27)" ✓
- Req 11 (line 54): "`< memory.conflict.delete_threshold` (default 0.1)" ✓
- Req 27 (line 102): explicit semantic distinction from `memory.decay.archived_threshold`; requires master SC-6 update to include `delete_threshold` ✓
- Req 28 (line 104): tests `delete_threshold = 0.05` behavior change ✓
- HOW zod schema (lines 131-135): includes all three keys (`cosine_threshold`, `delete_threshold`, `llm_verify`) ✓
- V10 (line 182): tests `delete_threshold = 0.05` behavior change ✓

### llm_verify ADD fallback
- Req 12 first WHEN clause (line 56): LLM verification between req 10/11 classification and verdict return; LLM overrides toward ADD only, never toward UPDATE/DELETE; cosine remains authority for UPDATE/DELETE ✓
- Req 12 second WHEN clause (line 58): LLM-unavailable fallback — falls back to ADD, logs warning ("conflict: llm_verify requested but LLM unavailable, defaulting to ADD"), store call does not crash; rationale ("no destructive UPDATE or DELETE without verification — the operator opted into LLM verification, so cosine alone is not trusted to take destructive action"); cost acknowledged ("at the cost of a duplicate ADD that a future store call (with LLM available) can reconcile") ✓
- Req 26 (line 98): spike fallback gates `llm_verify = true` on SDD-05 LLM client availability; degraded fallback (`cosine_threshold = 0.2`, `llm_verify = false`) when LLM unavailable, documented in SC-6 ✓
- Seam 4 (lines 153-156): two failure modes distinguished — (a) SDD-05 regex-only with LLM client still wired, (b) LLM client unavailable ✓
- V10 (line 182): explicit LLM-unavailable tests for both UPDATE-band and DELETE-band cases ✓

### Effect.runPromise
- HOW line 123: wiring snippet `const verdict = await Effect.runPromise(ConflictDetector.check(content, input.project_id ?? "global"))` ✓
- HOW line 128: detailed explanation with four codebase precedent citations (`memory.ts:636`, `session/prompt.ts:115`, `mcp/oauth-provider.ts:66`, `mcp/index.ts:473`); explicit warning about awaiting `Effect<T>` directly ("returns the unevaluated `Effect` runtime object, not the `T` it would produce") ✓
- All four citations verified accurate in prior re-audit; spec unchanged in council amendment. ✓

### Cross-project isolation
- Req 22 (line 88): non-empty `project_id` → scope to `attributes.project_id == project_id` OR `"global"` (with explicit reference to surreal-backend.ts:208-212 including `OR project_id = ""`) ✓
- Req 23 (line 90): empty/undefined `project_id` → scope to `"global"` OR empty ✓
- Req 24 (line 92): isolation violation → log warning with both project_ids, exclude node, continue, no crash; verdict ADD if no valid candidates remain ✓
- V8 (line 180): three setups — proj-a vs proj-b isolation, global sharing, isolation violation injection ✓

### Bi-temporal soft-delete via invalidated_by + INVALIDATE event
- Req 4 (line 36): "bi-temporal soft-delete the old node (set `tx_to = now`, `status = DELETED`, `invalidated_by = new.node_id`), emit an `INVALIDATE` event (`event_type=INVALIDATE`, `target_id=old.node_id`, `target_type=node`)" ✓
- Req 20 (line 82): DELETE stores new node (same fields as UPDATE except `prev_version_id = null` — DELETE is not a version chain), then bi-temporal soft-delete old (`old.tx_to = now`, `old.status = DELETED`, `old.invalidated_by = new.node_id`; `old.valid_to` left unchanged — old fact was believed true until new arrived) ✓
- Req 21 (line 84): emit `INVALIDATE` event (`event_type = INVALIDATE`, `target_id = old.node_id`, `target_type = node`, `payload = { new_node_id, subgraph_node_ids, subgraph_hyperedge_ids }`); `Memory.store` returns new node's `MemoryEntry`; SHALL NOT emit `DELETE` event (DELETE event_type is GC-only per SC-9; soft-deletes emit INVALIDATE) ✓
- Seam 2 (line 151): interpretation of "INVALIDATES edge" as `invalidated_by` back-pointer field + `INVALIDATE` event, NOT a new hyperedge type — preserves the prior re-audit's resolution ✓
- V6 (line 178): verifies all fields — new node `version=1`, `prev_version_id=null`, old `tx_to=now`, `status=DELETED`, `invalidated_by=new.node_id`, `valid_to` unchanged; `INVALIDATE` event emitted; no `DELETE` event; `is_live(now)` returns B not A ✓

### Spike FP<10%
- Req 25 (line 96): spike loads 100 real session turns from existing session transcript fixtures, runs `ConflictDetector.check` with `cosine_threshold = 0.3` and `llm_verify = false`, manual-labels each verdict as TP/FP, computes `FP_rate = false_positives / total_contradictions` ✓
- Req 26 (line 98): `FP_rate < 10%` → pass, proceed with `cosine_threshold = 0.3`, `llm_verify = false`; `FP_rate >= 10%` → fail, revise HOW to fallback (`cosine_threshold = 0.2`, conditionally `llm_verify = true` if SDD-05 LLM available; degraded fallback `cosine_threshold = 0.2` only if unavailable) ✓
- V9 (line 181): spike test gated behind `FBH_SPIKE_M5` env var; manual labels committed as `test/memory/conflict-spike-labels.json`; exit 0 on pass / non-zero on fail; fallback revision before `implement` proceeds ✓

All eight re-audit-passed items are preserved verbatim or with the prior re-audit's fixes intact. The council amendment added G1-G4 + V13 at the top of WHAT and at the end of VERIFY, respectively; it did not modify the technical content (reqs 1-28, V1-V12).

---

## (6) WHAT ↔ VERIFY 1:1 — PASS

Re-walked the mapping with the council-amended content:

| WHAT req | VERIFY test | Coverage |
|---|---|---|
| G1 (no evidence → remain deferred; hard dep enforced by stage-gate) | V13(a) (refusal before sdd-08 tests), V13(b) (refusal after sdd-08 tests but no evidence in decision log) | Full — V13(b) is the critical test that distinguishes "tests passed" from "evidence published" |
| G2 (≥ threshold → eligible to proceed; decision log entry with run id) | V13(c) (proceeds when sdd-08 tests passed AND contradiction rate ≥ threshold recorded with citable measurement run id) | Full |
| G3 (< threshold → remain deferred; no auto-promotion; human gate re-convenes) | V13(d) (refusal when contradiction rate < threshold recorded; sdd-09 marked `deferred`) | Full |
| G4 (no evidence after 2 weeks → deferred indefinitely; floor ships regardless) | V13(e) (simulate abort A8: 2 weeks elapse since sdd-08 tests completion, no evidence → sdd-09 marked `deferred-indefinitely`, human-gate re-convene logged, floor confirmed still shipping) | Full |
| 1 (wiring at top of storeImpl after getEmbedding, before backend dispatch) | V1 | Full |
| 2 (ADD preserves existing dedup) | V1, V4 | Full |
| 3 (UPDATE rewrite path, no dedup) | V5 | Full |
| 4 (DELETE retract path, no hard-delete, no dedup) | V6 | Full |
| 5 (neighbor lookup reuses hybrid semantic leg) | V2 | Full |
| 6 (zero neighbors → ADD) | V2 | Full |
| 7 (top neighbor candidate) | V2 | Full |
| 8 (cosine comparison via `cosineSimilarity`) | V3 | Full |
| 9 (cosine ≥ threshold → ADD) | V3, V10 | Full |
| 10 (cosine < threshold, ≥ delete_threshold → UPDATE) | V3, V10 (delete_threshold change tested) | Full |
| 11 (cosine < delete_threshold → DELETE) | V3, V10 (delete_threshold change tested) | Full |
| 12 (LLM verify override toward ADD + LLM-unavailable fallback) | V10 (happy path + LLM-unavailable UPDATE and DELETE cases) | Full |
| 13 (path localization via `queryHyperedges`) | V7 | Full |
| 14 (subgraph recorded in event payload) | V7 | Full |
| 15 (empty subgraph still proceeds) | V7 (orphan case) | Full |
| 16 (ADD decision full fields) | V4 | Full |
| 17 (UPDATE new node fields) | V5 | Full |
| 18 (UPDATE closes old `tx_to`, status stays ACTIVE) | V5 | Full |
| 19 (UPDATE event emitted) | V5 | Full |
| 20 (DELETE new node + soft-delete old) | V6 | Full |
| 21 (INVALIDATE event, no DELETE event) | V6 | Full |
| 22 (non-empty project_id scoping) | V8 | Full |
| 23 (empty/undefined project_id → global+empty scope) | — | Gap (unchanged from prior re-audit — non-blocking N4: req 23 is unreachable from the spec's wiring which converts undefined → "global" before calling check) |
| 24 (isolation violation → log, exclude, continue) | V8 (violation case) | Full |
| 25 (spike setup, 100 turns, manual labels) | V9 | Full |
| 26 (spike pass/fail criterion + gated fallback) | V9 (now includes degraded fallback) | Full |
| 27 (config keys consumed — 3 keys) | V10 (cosine_threshold + delete_threshold + llm_verify) | Full |
| 28 (config behavior changes — 3 keys) | V10 (all three behavior changes tested) | Full |

Plus three process tests: V11 (CC-4 green suite), V12 (CC-9 style), V13 (activation gate G1-G4 process-level).

Coverage: 31/32 with one non-blocking gap (req 23, unchanged from prior re-audit, non-blocking N4 — req 23 unreachable from wiring). The council amendment added 5 new tests (V13(a)-(e)) covering G1-G4, all mapped 1:1 to the new WHAT requirements. No WHAT requirement lost coverage; the prior re-audit's coverage matrix is preserved exactly.

---

## Regression check — seam 5 (activation gate is a process gate, not a runtime gate)

Seam 5 (line 157) is the new seam added by the council amendment: "Activation gate is a process gate, not a runtime gate (council deferral). G1-G4 govern when the sdd-09 spec is *allowed to proceed to `implement`*, not what `ConflictDetector` does at runtime. The `tools/sdd` workstream's stage-gate check enforces G1 (sdd-08 before sdd-09). The activation threshold value lives in sdd-08's spec (sdd-08 defines the contradiction-rate metric and the threshold); sdd-09 only references it. A future change to the threshold is a sdd-08 change, not a sdd-09 change. The 2-week production telemetry window for abort A8 is measured from sdd-08's `tests` completion timestamp, not from sdd-09's spec acceptance date — sdd-09 can sit deferred indefinitely without the clock starting; the clock starts when M-6 evidence begins accumulating."

This seam correctly distinguishes:
- **Process gate (G1-G4, V13)** — enforced by `tools/sdd` stage-gate check; governs when `implement` may run
- **Runtime behavior (reqs 1-28, V1-V12)** — what `ConflictDetector` does when called; unchanged by the council deferral

The distinction matters because it prevents a future reader from misinterpreting G1-G4 as runtime conditions that `ConflictDetector.check` must evaluate at store time. The gate is at the workstream level, not the call site. ✓

---

## Regression check — "What is explicitly NOT built" (line 159-165)

The "NOT built" list was extended to include the council deferral:

- Line 161: Subgraph-wide coordinated rewrite — fast-follow (unchanged) ✓
- Line 162: Conflict detection across non-MEMORY nodes — only MEMORY checked in M-5 (unchanged) ✓
- Line 163: LLM-driven contradiction classification (MemGraphRAG multi-agent) — out of scope (unchanged) ✓
- Line 164: Conflict detection in recall path — save-time only; recall-time is fast-follow (unchanged) ✓
- Line 165 (new): "M-5 activation before M-6 evidence exists — the activation gate (G1-G4) is a hard process gate. No `implement` work on sdd-09 (not even a tracer bullet) is permitted until sdd-08's `tests` has passed AND the contradiction-rate evidence is in the decision log. A tracer bullet for the wiring point (req 1) is permissible only inside sdd-03's or sdd-05's own tracers, not as a sdd-09 activity." ✓

Line 165 closes the "tracer bullet loophole" — without it, an implementer could argue that a tracer bullet for the wiring point is permissible before the gate fires. The spec explicitly forbids this for sdd-09 activities and only permits it inside sdd-03's or sdd-05's own tracers. ✓

---

## New blocking issues

None. The council amendment is correctly integrated:
- Deferral is structural (gates `implement`, not just `design`)
- Activation gate G1-G4 is a hard process gate enforced by `tools/sdd` stage-gate check, not a soft ordering hint
- 5% threshold is owned by sdd-08, referenced by sdd-09 (no threshold drift)
- Abort A8 is wired (G4 + V13(e)) with the clock anchored to sdd-08's `tests` completion
- All eight re-audit-passed technical items are preserved verbatim or with prior fixes intact
- WHAT ↔ VERIFY 1:1 mapping is 31/32 (same non-blocking gap as prior re-audit, req 23 unreachable from wiring)
- V13 adds 5 new tests mapped 1:1 to G1-G4
- Seam 5 explicitly distinguishes process gate from runtime behavior
- "NOT built" list extended to close the tracer-bullet loophole

---

## Non-blocking observations (unchanged from prior re-audits)

- **N4 (req 23 unreachable from wiring).** Req 23 (empty/undefined `project_id` → "global" OR empty scope) is unreachable from the spec's own wiring (line 123: `ConflictDetector.check(content, input.project_id ?? "global")`), which converts undefined to `"global"` before calling `check`. The `empty` case (where `project_id` is an empty string, not undefined) is the only reachable sub-case, and even then the wiring's `?? "global"` does not fire (empty string is not nullish). V8 does not test the empty-string case. Non-blocking — req 23 documents a defensive scope that the wiring does not expose, but the scope is correct if a future caller passes empty/undefined directly to `check`. Unchanged from prior re-audit.
- **N2 (req 18 prose).** Req 18 line 64 says "queryable via `tx_to > now` filters" — should be `tx_to >= now` or `tx_to = Infinity` for live nodes. V5 (which correctly asserts `is_live(now)` returns B not A) is authoritative, not the prose. Unchanged from prior re-audit.

These are unchanged from the prior re-audit and do not block the council amendment.

---

VERDICT: PASS

The council deferral is correctly integrated into SDD-09:

1. **M-5 DEFERRED to post-M-6** — title, status, council deferral block, G1-G4, and "NOT built" line 165 all explicitly defer `implement` to post-M-6. ✓
2. **Activation gate requires sdd-08 contradiction-rate evidence above 5% threshold** — G1 refuses `implement` without evidence; G2 permits `implement` only with ≥ threshold evidence recorded in the decision log with a citable run id; G3 forbids auto-promotion on below-threshold; 5% threshold owned by sdd-08 (req 16, V12) and referenced by sdd-09 (no threshold drift). V13(a)-(d) test the gate behavior. ✓
3. **Abort A8 (no evidence after 2 weeks production = deferred indefinitely)** — G4 + V13(e); clock anchored to sdd-08's `tests` completion (seam 5); floor (M-0 + baseline-retrieval injection) ships regardless; no continued funding without re-baselined threshold approved by human gate. Cross-checked against master SC-11 line 140 and line 186. ✓
4. **Dependency on sdd-08 + sdd-05 + sdd-03** — all three listed in line 7 "Depends on:" with concrete reuse rationale traced to specific requirements; hard dependency on sdd-08 enforced by `tools/sdd` stage-gate check (G1, V13 final sentence). ✓
5. **All re-audit-passed content preserved** — ConflictDetector interface (line 8, 113), ADD/UPDATE/DELETE verdicts (reqs 2-4, 9-11, 16-21, V1-V8), delete_threshold config (reqs 10-11, 27-28, HOW zod schema, V10), llm_verify ADD fallback (req 12 both WHEN clauses, req 26, seam 4, V10), Effect.runPromise (HOW line 123 with four codebase precedent citations at line 128), cross-project isolation (reqs 22-24, V8), bi-temporal soft-delete via invalidated_by + INVALIDATE event (reqs 4, 20-21, seam 2, V6), spike FP<10% (reqs 25-26, V9). ✓
6. **WHAT ↔ VERIFY 1:1** — 31/32 mapped (req 23 gap unchanged from prior re-audit, non-blocking N4); V13(a)-(e) added 1:1 for G1-G4; no WHAT requirement lost coverage. ✓

No new blocking issues. No regressions in technical content, anchors, or WHAT↔VERIFY mapping. The council amendment is additive (G1-G4 + V13 + seam 5 + "NOT built" line 165) and does not modify the prior re-audit's passed technical content. The 5% threshold ownership is correctly placed in sdd-08 (not sdd-09), preventing threshold drift between the two specs.

SDD-09 is ready for the human gate. The human gate should confirm: (a) the council deferral is acceptable (M-5 implementation blocked until M-6 produces ≥5% contradiction evidence), (b) the 2-week abort A8 clock anchored to sdd-08's `tests` completion is acceptable, (c) the floor (M-0 + baseline-retrieval injection) shipping regardless of A8 is acceptable.
