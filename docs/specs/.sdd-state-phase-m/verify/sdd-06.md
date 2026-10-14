# Verification Report: SDD-06 (M-3 Lifecycle Engine)

**Verifier:** Independent agent (fresh context)
**Date:** 2026-09-23
**Spec:** `docs/specs/260921_fbh-phase-m_sdd-06-lifecycle.md`
**Acceptance tests:** `packages/fbh/test/fbh-phase-m/sdd-06.test.ts` + `packages/fbh/test/fbh-phase-m/sdd-06-spike.test.ts`

## Verification summary

The SDD-06 M-3 lifecycle engine has been fully implemented per the council-amended spec:

1. **Simple exponential + rehearsal decay (DEFAULT)** (`src/memory/lifecycle/decay.ts`) — `confidence(t+1) = min(1.0, max(0.0, confidence(t) * (1 - rate(status)) + rehearsal_boost * access(t)))`. Per-stage rates (active=0.01, deprecated=0.05, archived=0.1). Clamped to [0,1]. Reads memory.decay.* config. Dispatches to prism_decay.ts if decay_model=prism; no-op if decay_model=none.

2. **Prism replicator-decay (experimental)** (`src/memory/lifecycle/prism_decay.ts`) — separate function, NOT imported by default decay. Behind `memory.decay_model=prism` flag. ESMS convergence proof unverified.

3. **Lifecycle transitions (SC-3 staged model)** — ACTIVE→DEPRECATED (confidence < 0.3), DEPRECATED→ARCHIVED (confidence < 0.1 OR age > 90 + usage_count < 2), ARCHIVED→DELETED (GC only). NO direct ACTIVE→ARCHIVED. STATUS_TRANSITION events emitted.

4. **Soft-delete** (`src/memory/lifecycle/invalidate.ts`) — sets tx_to=now, status=DELETED, invalidated_by set, emits INVALIDATE event. NO INVALIDATES hyperedge (per master SC-3 correction).

5. **GC** (`src/memory/lifecycle/gc.ts`) — hard-deletes ARCHIVED past retention_days, emits GC_DELETED event before deletion. Does NOT hard-delete non-ARCHIVED or within-retention.

6. **Graduation** (`src/memory/lifecycle/graduate.ts`) — usage_count >= 2 default (existing graduateMemories preserved), force-promote at 5 (config: force_promote_access_count), semantic-shift shadow metric (SHADOW_METRIC events, doesn't gate).

7. **Composite scoring** (`src/memory/lifecycle/score.ts`) — semantic + role + confidence + provenance + recency + usage + lifecycle. Lifecycle sub-score: 1.0 ACTIVE, 0.5 DEPRECATED, 0.1 ARCHIVED, 0.0 DELETED.

8. **Scheduler tasks** — memory-decay (hourly), memory-gc (weekly) added. memory-ttl-pruning rewired to call Consolidation.prune (gives it a real call site, CC-2). memory-graduation rewired to MemoryLifecycle.graduate. English-label intervals.

9. **Stale penalty removed** — binary `score *= 0.5` at memory.ts:496 removed, config field marked @deprecated.

10. **Config consumed (CC-6)** — memory.decay.*, memory.decay_model, memory.graduation.*, memory.scheduler.tasks.*, memory.scoring.* all added and consumed.

11. **@foxybear/MemoryLifecycle Effect service** (`src/memory/lifecycle/service.ts`) — Layer.effect with { decay, consolidate, graduate, prune, gc }.

12. **Coupled-loop simulation (CC-15)** (`test/fbh-phase-m/sdd-06-spike.test.ts`) — 1000 memories × 1000 ticks, 5 stability criteria (bounded [0,1], no collapse, graduation convergence, no ACTIVE↔DEPRECATED cycling > 2, no resurrection). 3762 assertions — ALL PASS.

## Coupled-loop simulation result

The coupled-loop sim PASSED all 5 stability criteria on the first run:
- (a) confidence bounded [0,1] for all 1000 iterations ✓
- (b) accessed memories don't collapse to zero ✓
- (c) graduation decisions converge (oscillation ≤ 2 steady-state sets in last 200 ticks) ✓
- (d) no memory cycles ACTIVE→DEPRECATED→ACTIVE more than 2 times ✓
- (e) soft-deleted stay deleted ✓

**Abort A5 NOT triggered.** The decay engine ships as the default. No tuning rounds needed.

## VERIFY coverage check

| VERIFY | What it checks | Status |
|---|---|---|
| Lifecycle service + decay | ✓ | (decay.ts with simple exponential + rehearsal) |
| Prism experimental | ✓ | (prism_decay.ts, behind flag) |
| Clamped [0,1] | ✓ | (min/max) |
| STATUS_TRANSITION events | ✓ | (enums.ts + decay.ts) |
| Staged transitions (no skips) | ✓ | (no ACTIVE→ARCHIVED) |
| Soft-delete via invalidated_by + INVALIDATE event | ✓ | (invalidate.ts) |
| No INVALIDATES hyperedge | ✓ | (uses field + event) |
| GC with GC_DELETED event | ✓ | (gc.ts) |
| access_count >= 2 graduation | ✓ | (graduate.ts) |
| Force-promote at 5 | ✓ | (config + graduate.ts) |
| Semantic-shift shadow | ✓ | (shadow.ts) |
| Composite scoring | ✓ | (score.ts) |
| Scheduler tasks (decay, gc, pruning, English intervals) | ✓ | (scheduler.ts) |
| Stale penalty removed/deprecated | ✓ | (memory.ts) |
| Config consumed (CC-6) | ✓ | (foxybear.ts) |
| Coupled-loop sim (CC-15) | ✓ | (sdd-06-spike.test.ts, all 5 criteria pass) |
| Typecheck green | ✓ | (exit 0) |

## Acceptance tests

- `bun test test/fbh-phase-m/sdd-06.test.ts --timeout 30000` → **29 pass, 0 fail**
- `bun test test/fbh-phase-m/sdd-06-spike.test.ts --timeout 30000` → **2 pass, 0 fail** (3762 assertions)

VERDICT: PASS

The SDD-06 M-3 lifecycle engine is complete. All 29 acceptance tests + 2 spike tests pass, typecheck is green, the full test suite has no new failures (292 baseline-tolerated). The coupled-loop simulation passed all 5 stability criteria on the first run — abort A5 not triggered. Simple exponential + rehearsal is the default decay, Prism is experimental, graduation uses access_count >= 2 with force-promote at 5, composite scoring is in place, and the scheduler tasks are wired with English-label intervals. SDD-07 (M-4 context packing) is unblocked.
