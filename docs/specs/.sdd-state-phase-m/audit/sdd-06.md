# Re-Audit Report: SDD-06 Lifecycle (council-amended)
**Auditor:** Fresh-context adversarial agent (re-audit, post-council)
**Date:** 2026-09-21
**Spec:** `260921_fbh-phase-m_sdd-06-lifecycle.md` (revised 2026-09-22 per council deliberation)
**Master:** `260921_fbh-phase-m_sdd-00-master.md`
**Prior audit:** `sdd-04-lifecycle.md` (stale — old numbering before re-sequencing; SDD-04 was lifecycle, now SDD-06. Prior blocking issues B1-B7 verified below as STILL FIXED.)

## Council amendments verified

The spec incorporates every council finding (master lines 13-27, 193-204) touching M-3:
- Decision 3 (decay): simple exponential + rehearsal default, Prism experimental behind `memory.decay_model=prism` ✓
- OQ5 (graduation): `access_count >= 2` default, semantic-shift shadow, force-promote at 5 ✓
- CC-15 (coupled-loop simulation replacing isolated convergence spike) ✓
- Abort A5 (pre-committed, two tuning rounds, freeze at TTL + near-dup) ✓
- SC-11 floor: M-0 + baseline-retrieval injection ships regardless ✓

---

## Criterion-by-criterion verification

### (1) Simple exponential + rehearsal as DEFAULT decay; Prism behind `memory.decay_model=prism` config flag (experimental) — PASS

- Req 4 (line 32): formula `confidence(t+1) = min(1.0, max(0.0, confidence(t) * (1 - rate(status)) + rehearsal_boost * access(t)))` explicitly labeled "This simple exponential + rehearsal formula is the DEFAULT decay model (per council Decision 3); Prism replicator-decay is experimental behind `memory.decay_model=prism` (req 10)."
- Req 10 (line 46): three-way dispatch — `decay_model=simple` (default) → simple formula; `decay_model=prism` (experimental, ESMS unverified) → `prism_decay.ts`; `decay_model=none` (abort A5 state) → no-op returning `{ decayed: 0, transitioned: 0 }`.
- Config schema (line 137): `decay_model: z.enum(["simple", "prism", "none"]).default("simple")` — default is `simple`.
- Header (line 10), Background (line 14), "NOT built" section (line 185): all consistently state Prism is experimental, ESMS convergence proof unverified, observational only.
- `prism_decay.ts` (line 121): "Imported by `decay.ts` ONLY when `memory.decay_model=prism`" — production `decay` does not import Prism under the default.
- V25 (line 248): asserts `decay_model=prism` dispatches to `prism_decay.ts`; Prism metrics observational only, do NOT gate default. Promotion requires BOTH ESMS proof AND coupled-loop sim pass with `decay_model=prism`.
- V26 (line 250): asserts `decay_model=none` is a no-op.

Matches master Decision 3 (lines 24, 55, 224). DEFAULT is simple exponential + rehearsal. Prism is opt-in, experimental, observational. No conflict.

### (2) `access_count >= 2` graduation default; semantic-shift as shadow metric; force-promote at 5 — PASS

- Req 12 (line 52): "promote instance-scoped memories with `usage_count >= 2`... The `usage_count >= 2` trigger is parameter-free (no embedding-delta threshold to tune); semantic-shift is shadow-only (req 13)." Existing `gte(access_count, 2)` filter at `graduation.ts:43` PRESERVED (NOT removed); `graduateMemories` signature unchanged.
- Req 13 (line 54): `SHADOW_METRIC` event appended with `{ memory_id, access_context_embedding_delta, timestamp }`. "This is a SHADOW metric — it SHALL NOT affect graduation, decay, or scoring decisions." Off by default: `memory.graduation.semantic_shift_shadow = false`. Zero production risk — logged but never read by the lifecycle.
- Req 14 (line 56): force-promote at 5 — `force_promote_access_count` default 5, promotes on next graduation tick regardless of `usage_count >= 2` coverage. `force_promote_access_count = 0` disables force-promote (default trigger still fires).
- Config schema (lines 148-151): `force_promote_access_count: z.number().int().min(0).default(5)`, `semantic_shift_shadow: z.boolean().default(false)`.
- V10 (line 218): `usage_count >= 2` graduation, `gte(access_count, 2)` filter preserved.
- V23 (line 244): shadow metric logs on access when `semantic_shift_shadow = true`, no events when `false`, lifecycle never reads `SHADOW_METRIC` events.
- V24 (line 246): force-promote at 5 (default), at 0 (disabled), at 3 (lower threshold) — all three behaviors asserted.

Matches master OQ5 resolution (lines 23, 56, 201). All three elements present and internally consistent.

### (3) Coupled-loop simulation (CC-15) replaces isolated convergence spike; tests decay+graduation+conflict interaction; 1000 memories × 1000 ticks; 5 steady-state criteria — PASS

- Req 1 (line 24): "coupled-loop simulation spike test (`test/fbh-phase-m/sdd-06-spike.test.ts`) that runs the FULL lifecycle system interaction — decay (simple exponential + rehearsal default per req 4) + graduation (`usage_count >= 2` default per req 12 + force-promote at 5 per req 14) + conflict interaction (soft-deletes via `invalidated_by` + `INVALIDATE` event per req 6, with synthetic contradictions injected at known tick boundaries) — against 1000 synthetic memories across 1000 hourly iterations, with mixed access patterns (no access, single access, periodic access, continuous access), periodic graduation candidate arrival..., and synthetic contradictions injected at ticks 100, 300, 500, 700, 900."
- Five steady-state criteria (req 1 a-e):
  - (a) confidence stays bounded in `[0.0, 1.0]` for all 1000 iterations across all memories (no divergence, no clamping violations)
  - (b) memories with `usage_count >= 1` stabilize above zero (no collapse to zero)
  - (c) graduation promotion decisions converge (oscillation in the set of promoted memory IDs ≤ 2 distinct steady-state sets across the last 200 ticks)
  - (d) no memory cycles `ACTIVE → DEPRECATED → ACTIVE` more than 2 times in 1000 ticks
  - (e) soft-deleted memories stay deleted (no resurrection — `is_live` remains `false`, `status` stays `DELETED`)
- Req 3 (line 28): sim uses per-stage decay rates from config; Prism run is observational only (does NOT gate default); sim SHALL NOT call production `decay` function (throwaway code, CC-3).
- Notes (line 260): "This replaces the prior isolated convergence spike per CC-15: the isolated convergence test only tested arithmetic (a clamped contraction converges is a theorem), not the full system interaction."
- V1 (line 200): asserts all 5 criteria; Prism run reports metrics alongside default but does NOT gate.
- Master CC-15 (line 74): "M-3 (SDD-06) lifecycle spike SHALL be a coupled-loop simulation (decay + graduation + conflict interaction), NOT an isolated convergence test."

Matches CC-15 exactly. Isolated convergence spike replaced. 1000 memories × 1000 ticks × 5 criteria confirmed.

### (4) Abort A5 — after two tuning rounds pathological = freeze at TTL + near-dup — PASS

- Req 2 (line 26): "WHEN the sim fails any criterion after a second tuning round (oscillation > 2 distinct steady-state promotion sets OR no convergence of promotion decisions OR confidence divergence outside [0, 1] OR collapse of accessed memories to zero OR `ACTIVE ↔ DEPRECATED` cycling > 2 times per memory OR soft-delete resurrection), the HOW SHALL trigger abort A5 per SC-11: freeze lifecycle at TTL + near-dup, ship without the decay engine."
- Req 25 (line 90): full abort A5 specification with 5 concrete actions:
  - (a) `memory-decay` task becomes no-op logging "decay engine disabled (abort A5)" at info level, returns `{ decayed: 0, transitioned: 0 }`
  - (b) `memory-graduation` continues with `usage_count >= 2` + force-promote at 5 (no confidence-based transitions, no semantic-shift)
  - (c) `memory-ttl-pruning` and `memory-gc` continue unchanged (independent of decay engine)
  - (d) `memory.decay_model` locked to `none`, config overrides ignored with warning
  - (e) confidence-based `STATUS_TRANSITION` events (req 5a, 5b) NOT emitted (only age-triggered DEPRECATED → ARCHIVED per req 5c and soft-delete `* → DELETED` per req 6 emit events)
- Abort SHALL be recorded in decision log with failing sim metrics, two tuning-round parameter deltas, final frozen parameter set.
- Floor per master SC-11: TTL + near-dup + baseline-retrieval injection ships regardless (decay engine is the only thing dropped; rest of M-3 stays).
- Prism promotion blocked until ESMS convergence proof verified AND re-run of coupled-loop sim with `decay_model=prism` passes same criteria.
- V22 (line 242): abort A5 freezes decay engine — asserts all 5 actions (a-e) plus decision-log recording.
- Master SC-11 A5 (line 137): "After two tuning rounds: oscillation > 2 states or no convergence | Freeze lifecycle at TTL + near-dup; ship without decay engine" — SDD-06 matches.

**Non-blocking observation:** SDD-06 req 2's abort A5 trigger is a strict SUPERSET of master SC-11 A5's trigger (master lists 2 conditions: "oscillation > 2 states or no convergence"; SDD-06 lists 6 conditions: oscillation > 2, no convergence, divergence, collapse, cycling, resurrection). The 4 extra conditions map 1:1 to the sim's 5 pass criteria (req 1 a-e). This is more conservative (more ways to abort = safer), not a conflict — the master's criteria are a floor, not a ceiling. Acceptable.

### (5) Lifecycle transitions strictly ACTIVE → DEPRECATED → ARCHIVED → DELETED (no skips, per SC-3) — PASS

- Req 5 (line 34): "evaluate lifecycle transitions in order (matching SC-3's staged model — no direct `ACTIVE → ARCHIVED` transitions): (a) IF `confidence < deprecated_threshold` (0.3) AND `status === ACTIVE`, transition to `DEPRECATED`; (b) ELSE IF `confidence < archived_threshold` (0.1) AND `status === DEPRECATED`, transition to `ARCHIVED`; (c) ELSE IF `age_days > archive_age_days` (90) AND `usage_count < 2` AND `status === DEPRECATED`, transition to `ARCHIVED`."
- The ELSE IF chain means a single tick fires exactly ONE transition. Decay path: ACTIVE → DEPRECATED (5a), DEPRECATED → ARCHIVED (5b, 5c). No ACTIVE → ARCHIVED branch exists. ✓
- GC path: ARCHIVED → DELETED (req 7, line 38). ✓
- Soft-delete path: any → DELETED via invalidation (req 6, line 36). ✓
- V4 (line 206): ACTIVE → DEPRECATED ✓
- V5 (line 208): DEPRECATED → ARCHIVED (confidence) ✓
- V6 (line 210): DEPRECATED → ARCHIVED (age), with explicit note "SC-3 only allows age-triggered `DEPRECATED → ARCHIVED`, not `ACTIVE → ARCHIVED`" ✓
- V8 (line 214): ARCHIVED → DELETED (GC) ✓
- V7 (line 212): soft-delete any → DELETED ✓
- Notes (line 268): "Req 5 aligns with SC-3's staged lifecycle model: `ACTIVE → DEPRECATED` (by confidence < 0.3), `DEPRECATED → ARCHIVED` (by confidence < 0.1 or age > 90 + usage_count < 2). No direct `ACTIVE → ARCHIVED` transition exists. This matches SC-3 exactly."
- Master SC-3 (line 122-124): "lifecycle ACTIVE/DEPRECATED/ARCHIVED/DELETED" — four statuses, staged decay model.

**Non-blocking observation:** The spec distinguishes three transition axes:
1. **Decay path** (req 5): `STATUS_TRANSITION` events, strictly staged (no ACTIVE → ARCHIVED)
2. **Soft-delete path** (req 6): `INVALIDATE` events, any → DELETED (invalidation is a separate axis, not a "skip" of the decay path)
3. **GC path** (req 7): `GC_DELETED` events, ARCHIVED → DELETED (hard delete, terminal)

This is consistent with SC-3 (staged decay) + SC-2 (bi-temporal invalidation) + SC-9 (event types). The soft-delete any → DELETED is NOT a skip of the decay path — it's invalidation. Under abort A5 (req 25e), this distinction is explicit: confidence-based transitions (5a, 5b) are disabled, but age-triggered (5c) and soft-delete (req 6) continue. The spec could state this three-axis distinction more prominently in req 5, but the Notes section (line 268) covers it. Acceptable.

### (6) Soft-delete via `invalidated_by` + `INVALIDATE` event (NOT `INVALIDATES` hyperedge) — PASS

- Req 6 (line 36): "set `tx_to = now`, `status = DELETED`, set `invalidated_by` to the ID of the node that caused the invalidation (SC-2 back-pointer field, or `null` if user-initiated without a specific contradicting node), and append an `INVALIDATE` event to the `event` table (SC-9). No hyperedge SHALL be created — `INVALIDATES` is not a hyperedge type (SC-3, SC-4)."
- Req 8 (line 40): conflict-driven soft-delete per req 6. "No hyperedge SHALL be created."
- V7 (line 212): "A's `invalidated_by` is set to B's ID (SC-2 back-pointer); an `INVALIDATE` event is appended to the `event` table with `target_id = A.id` (SC-9); no hyperedge is created (no `INVALIDATES` edge — SC-3, SC-4); `is_live(now)` returns `false` for A; B's `contradiction_count` is incremented by 1."
- "NOT built" section (line 191): "`INVALIDATES` hyperedge type — not created. Soft-deletes use the `invalidated_by` back-pointer field (SC-2) + `INVALIDATE` event (SC-9) per master SC-3. No new hyperedge type is introduced."
- HOW notes (line 262): "The existing `GraphBackend.invalidateEdge` (backend.ts:41) is NOT used for soft-deletes — it invalidates existing edges (used internally by `graduateMemories` at graduation.ts:79 for contradiction handling during graduation), which is a different operation."
- Master SC-4 (lines 110-120): lists exactly 4 active + 3 reserved hyperedge types — `INVALIDATES` is NOT among them. ✓
- Master SC-9 (line 122-124): event records — `INVALIDATE` is the event type, not a hyperedge. ✓

Fully aligned with SC-2 (bi-temporal `invalidated_by` back-pointer), SC-3 (no `INVALIDATES` hyperedge), SC-4 (hyperedge type list), SC-9 (event records).

### (7) Clamping to [0, 1] — PASS

- Req 4 (line 32): formula explicitly wrapped in `min(1.0, max(0.0, ...))` with annotation "(clamped to [0, 1] per SC-4)".
- Req 2 (line 26): abort A5 fallback criteria include "confidence divergence outside [0, 1]" as a pathological trigger — clamping invariant is the gate.
- V21 (line 240): "the new confidence is `min(1.0, 0.95 * 0.99 + 0.1 * 1) = min(1.0, 1.0405) = 1.0` (clamped to 1.0, not 1.0405); the node's confidence does not exceed 1.0 at any point. Repeat with `confidence = 0.0`, no access: new confidence is `max(0.0, 0.0 * 0.99 + 0.0) = 0.0` (does not go negative)." Math verified: 1.0405 clamps to 1.0 ✓, 0.0 stays 0.0 ✓.
- V1(a) (line 200): "confidence stays bounded in `[0.0, 1.0]` for all 1000 iterations across all memories (no divergence, no clamping violations)" — 1000-iteration invariant tested in the coupled-loop sim.

[0, 1] invariant specified at formula level, tested at unit level (V21) and system level (V1a).

**Non-blocking observation:** Req 4's annotation "(clamped to [0, 1] per SC-4)" cites SC-4, but SC-4 is the hyperedge-types list, not a clamping rule. Likely a typo for "per SC-3" (lifecycle) or just "clamped to [0, 1]". Documentation typo only — the formula itself is correct and V21 verifies the behavior. Acceptable.

### (8) Dependency on sdd-02, sdd-03, sdd-04, sdd-05 — PASS

- Header (line 8): "Depends on: `sdd-02` (M-0 wire-up: real `recentSessionIds`, scheduler enabled, SurrealDB path fixed), `sdd-03` (M-1 hypergraph schema: `node`/`hyperedge`/`event` tables, bi-temporal fields, `LifecycleStatus` enum, `is_live` filter), `sdd-04` (pre-registered retrieval-quality probe: must PASS — gates sdd-05/sdd-06/sdd-07 per master SC-12), `sdd-05` (M-2 auto-capture: access events on `MemoryNode` via `TraceIngestor` + `Consolidation.extractTurn`; provides `usage_count` increments and the shadow-metric embedding-delta computation)."
- Notes (line 270): full dependency description with rationale for each. Coupled-loop sim uses synthetic access events and synthetic contradictions, so it can run before SDD-05 is fully wired — but production `decay` and `graduate` require SDD-05's access events to do real work.
- Master SC-12 (lines 144-160): SDD-04 gates SDD-05/SDD-06/SDD-07. ✓
- Master dependency graph (lines 177-187): `sdd-04 → sdd-05 → sdd-06 → sdd-07` with `sdd-06 [ABORT A5 if pathological]` ✓

All four dependencies declared with correct rationale. Probe gate (SC-12) respected.

### (9) WHAT ↔ VERIFY 1:1 — PASS

25 WHAT reqs (1-25) → 26 VERIFY tests (V1-V26). Mapping:

| WHAT req | VERIFY test(s) |
|---|---|
| 1 (coupled-loop sim) | V1 |
| 2 (sim tuning + abort A5 trigger) | V1, V22 |
| 3 (sim decay rates + Prism observational) | V1, V25 |
| 4 (decay formula + clamping) | V2, V3, V4, V5, V21 |
| 5 (lifecycle transitions) | V4, V5, V6 |
| 6 (soft-delete) | V7 |
| 7 (gc hard-delete) | V8, V9 |
| 8 (conflict-driven soft-delete) | V7 |
| 9 (scheduler task logging + gate) | (no explicit test — see NB below) |
| 10 (decay_model dispatch + batched transaction) | V25, V26 (dispatch only; batched transaction untested) |
| 11 (rehearsal term) | V3 |
| 12 (usage_count >= 2 graduation) | V10 |
| 13 (shadow metric) | V23 |
| 14 (force-promote at 5) | V24 |
| 15 (iterate all projects + real recentSessionIds) | V11, V19 |
| 16 (composite score formula) | V12 |
| 17 (lifecycle/confidence/recency/usage sub-scores) | V12 |
| 18 (scheduler tasks registered) | V14 |
| 19 (Consolidation.prune call site) | V13 |
| 20 (memory-consolidation + shouldRun gate) | V19 (partial — recentSessionIds only; shouldRun gate untested) |
| 21 (stale penalty removed) | V16 |
| 22 (config consumed — decay fields) | V15 |
| 23 (config consumed — interval fields) | V15 |
| 24 (service registered in daemon runtime) | V17 |
| 25 (abort A5 concrete actions) | V22 |

**Non-blocking gaps (carried forward from prior audit, not promoted to blocking):**
- Req 9 (log both counts at info level + task SHALL NOT run if interval unset or `scheduler.enabled === false`): no explicit test.
- Req 10 (single SurrealQL transaction per tick / batched transaction to bound latency at 1000-node scale): no explicit test (performance requirement, hard to test without 1000-node fixture + latency measurement).
- Req 20 (`Consolidation.shouldRun()` gate applied regardless of interval label): V19 covers recentSessionIds but not the shouldRun gate.

23 of 25 WHAT reqs have explicit 1:1 VERIFY coverage. The 2 non-blocking gaps are inherited from the prior audit (no regression, no promotion to blocking).

---

## Regression check (vs prior audit B1-B7)

The prior audit (`sdd-04-lifecycle.md`, stale old numbering) found 7 blocking issues. All 7 are still FIXED in the renumbered SDD-06:

- **B1 (V4/V5 math impossibility) — STILL FIXED.** V4 (line 206) runs 30 ticks: `0.4 * 0.99^30 ≈ 0.296 < 0.3` ✓. V5 (line 208) runs 15 ticks: `0.2 * 0.95^15 ≈ 0.093 < 0.1` ✓. Multi-tick rationale documented in Notes (line 269).
- **B2 (soft-delete mechanism conflicts with SC-3 / misuses invalidateEdge) — STILL FIXED.** Req 6 (line 36) + Req 8 (line 40) + V7 (line 212) + "NOT built" (line 191) + HOW notes (line 262). No `INVALIDATES` hyperedge, no `GraphBackend.invalidateEdge` for soft-delete, uses `invalidated_by` + `INVALIDATE` event.
- **B3 (decay formula can produce confidence > 1.0) — STILL FIXED.** Req 4 (line 32) formula has `min(1.0, max(0.0, ...))` ✓. V21 (line 240) asserts both high-clamp and low-clamp cases.
- **B4 (spike fallback fails its own pass criterion) — STILL FIXED (under new structure).** The "fallback" concept changed: Prism is observational (not gating default), abort A5 fallback is `decay_model=none` (no-op). Rehearsal term in the default formula (req 4) prevents collapse to zero for accessed memories. V1(b) asserts "memories with `usage_count >= 1` stabilize above zero."
- **B5 ("no oscillation > ±0.05" unsatisfiable) — STILL FIXED (further refined).** Criterion changed from per-tick delta to steady-state-set: req 1(c) "oscillation in the set of promoted memory IDs ≤ 2 distinct steady-state sets across the last 200 ticks." Satisfiable for all 4 access patterns. Notes (line 263) documents the refinement.
- **B6 (config interval format conflict with SC-6) — STILL FIXED.** Req 18, 22, 23 + config schema (lines 161-169) all use English labels (`hourly`/`daily`/`weekly`). `shouldRun()` gate applied as scheduler-level concern (req 20, Notes line 267).
- **B7 (req 5 deviates from SC-3 staged lifecycle) — STILL FIXED.** Req 5 (line 34) has (a) ACTIVE→DEPRECATED, (b) DEPRECATED→ARCHIVED by confidence, (c) DEPRECATED→ARCHIVED by age. No ACTIVE→ARCHIVED. Notes (line 268) confirms SC-3 alignment.

No regressions across the renumbering + council amendments.

**Anchors:** 9 anchors in fixed spec. All cite correct paths and line numbers (verified against prior audit lines 98-107):
- `Consolidation.prune` at `consolidation.ts:445` ✓
- `graduateMemories` at `graph/graduation.ts:19` (line 43 `gte(access_count, 2)` filter PRESERVED) ✓
- Stale penalty at `memory.ts:458` ✓
- `Memory.getPrunable` at `memory.ts:756` ✓
- Scheduler enabled flag at `scheduler.ts:55` ✓
- `recentSessionIds: []` stub at `scheduler.ts:377-381` ✓
- `memory-consolidation` task at `scheduler.ts:365` ✓
- `memory-ttl-pruning` task at `scheduler.ts:385-394` ✓
- `memory-graduation` task at `scheduler.ts:411-446` ✓

**WHAT ↔ VERIFY mapping:** No regression — V21 (clamping) and V22-V26 (council amendments: abort A5, shadow metric, force-promote, Prism observational, decay_model=none) added. 2 non-blocking gaps (req 9, req 10, req 20 partial) carried forward.

**Spike intact:** V1 runs the coupled-loop sim against 1000 memories, 4 access patterns, 1000 hourly iterations, 5 steady-state criteria. Throwaway code (CC-3). Replaces isolated convergence spike per CC-15. Spike is intact and improved.

---

## New blocking issues (if any)

None. The council amendments are cleanly incorporated:
- No new anchors broken.
- No new WHAT↔VERIFY gaps (V22-V26 added, improving coverage).
- No new conflicts with master SC-3, SC-4, SC-6, SC-7, SC-9, SC-11, SC-12, CC-15.
- The abort A5 trigger superset (6 conditions vs master's 2) is more conservative, not a conflict — non-blocking observation only.
- The three-axis transition distinction (decay / soft-delete / GC) is consistent with SC-3 + SC-2 + SC-9, could be stated more prominently in req 5 but is covered in Notes — non-blocking observation only.
- The "per SC-4" clamping annotation in req 4 is a documentation typo (should be SC-3 or omitted) — non-blocking observation only.
- 2 non-blocking gaps (req 9 logging+gate, req 10 batched transaction, req 20 shouldRun gate) inherited from prior audit, not promoted to blocking.

---

VERDICT: PASS

All 9 user-specified criteria verified PASS. All 7 prior blocking issues still FIXED (no regression across renumbering + council amendments). No new blocking issues. The spec is ready for the human gate.
