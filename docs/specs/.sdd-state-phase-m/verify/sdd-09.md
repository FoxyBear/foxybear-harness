# Verification Report: SDD-09 (M-5 Conflict Detection)

**Verifier:** Independent agent (fresh context)
**Date:** 2026-09-23
**Spec:** `docs/specs/260921_fbh-phase-m_sdd-09-conflict-detection.md`
**Acceptance tests:** `packages/fbh/test/fbh-phase-m/sdd-09.test.ts`

## Verification summary

The SDD-09 M-5 conflict detection has been fully implemented per the council-amended spec. This is the FINAL spec in the Phase M suite.

1. **ConflictDetector service** (`src/memory/conflict/check.ts` + `service.ts`) — `check(content, project_id)` Effect.fn returning `{ verdict: "ADD"|"UPDATE"|"DELETE", target? }`. @foxybear/ConflictDetector Effect service (Layer.effect) with runPromise facade.

2. **MOSAIC neighbor lookup** — cosine similarity against live MEMORY nodes scoped to project_id. Reuses HNSW KNN pattern.

3. **Contradiction scoring + thresholds:**
   - ADD: cosine >= cosine_threshold (0.20, calibrated by M-6)
   - UPDATE: cosine < cosine_threshold AND >= delete_threshold (0.1)
   - DELETE: cosine < delete_threshold (0.1)
   - delete_threshold distinct from archived_threshold (semantically different)

4. **llm_verify fallback** — when llm_verify=true but LLM unavailable → ADD verdict + warning log. No destructive UPDATE/DELETE without verification. Store does NOT crash.

5. **HiGram path localization** (`src/memory/conflict/localize.ts`) — `localize(target_id, project_id)` queries hyperedges referencing target via SurrealHypergraphBackend.expand, returns subgraph { node_ids, hyperedge_ids } for audit trail in event payload.

6. **Decision-driven write loop** (`src/memory/conflict/apply.ts`):
   - ADD: existing storeImpl flow (including cosine > 0.95 dedup)
   - UPDATE: new node with prev_version_id back-pointer, close old tx_to, UPDATE event with localized subgraph
   - DELETE: new node, soft-delete old (tx_to=now, status=DELETED, invalidated_by set), INVALIDATE event with localized subgraph. NO hard-delete (GC-only on ARCHIVED past retention).

7. **Wiring into Memory.store** — ConflictDetector.check called via Effect.runPromise after getEmbedding, before backend dispatch. ADD → existing flow, UPDATE/DELETE → applyVerdict.

8. **Cross-project isolation** — neighbor lookup scoped to project_id. No cross-project contamination.

9. **Config (CC-6)** — `memory.conflict` sub-config: cosine_threshold (default 0.3, calibrated 0.20), delete_threshold (default 0.1), llm_verify (default false).

10. **Activation gate satisfied** — SDD-08 (M-6) measured contradiction rate 50% (≥ 5% threshold). A8 decision: M5_ACTIVATE. M-5 has evidence to proceed.

## VERIFY coverage check

| VERIFY | What it checks | Status |
|---|---|---|
| Activation gate (M5_ACTIVATE) | ✓ | (contradiction rate 50% from sdd-08) |
| ConflictDetector service | ✓ | (check.ts + service.ts) |
| check(content, project_id) → ADD/UPDATE/DELETE | ✓ | (all 3 verdicts) |
| Wired into Memory.store | ✓ | (Effect.runPromise after getEmbedding) |
| MOSAIC neighbor lookup (cosine, project-scoped) | ✓ | (findMemoryNeighbor) |
| cosine_threshold config (0.20 calibrated) | ✓ | (config + comment) |
| delete_threshold config (0.1, distinct) | ✓ | (config) |
| ADD/UPDATE/DELETE threshold logic | ✓ | (check.ts) |
| llm_verify + ADD fallback | ✓ | (check.ts) |
| UPDATE creates new node with prev_version_id | ✓ | (apply.ts rewrite) |
| DELETE soft-delete + INVALIDATE event | ✓ | (apply.ts retract) |
| No hard-delete on conflict | ✓ | (soft-delete only) |
| HiGram path localization | ✓ | (localize.ts) |
| Subgraph in event payload (audit trail) | ✓ | (apply.ts) |
| Cross-project isolation | ✓ | (project_id scoping) |
| Effect.runPromise (not raw await) | ✓ | (runPromise facade) |
| Config consumed (CC-6) | ✓ | (memory.conflict.*) |
| Typecheck green | ✓ | (exit 0) |

## Acceptance tests

`bun test test/fbh-phase-m/sdd-09.test.ts --timeout 30000` → **22 pass, 0 fail**.

VERDICT: PASS

The SDD-09 M-5 conflict detection is complete. All 22 acceptance tests pass, typecheck is green, the full test suite has no new failures (292 baseline-tolerated). ConflictDetector is wired into Memory.store with MOSAIC neighbor lookup, HiGram path localization, the decision-driven write loop (ADD/UPDATE/DELETE), bi-temporal soft-delete, llm_verify fallback, cross-project isolation, and the M-6-calibrated cosine threshold (0.20). The activation gate is satisfied (contradiction rate 50% from sdd-08). This is the FINAL spec — **Phase M is complete**.
