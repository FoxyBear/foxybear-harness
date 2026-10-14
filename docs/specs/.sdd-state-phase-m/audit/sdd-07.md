# Re-Audit Report: SDD-07 Context Packing (council-amended)
**Auditor:** Fresh-context adversarial agent (re-audit)
**Date:** 2026-09-21
**Spec:** `260921_fbh-phase-m_sdd-07-context-packing.md` (revised 2026-09-22 per council findings)
**Master:** `260921_fbh-phase-m_sdd-00-master.md` (SC-1, SC-5, SC-6, SC-7, SC-11 A6, SC-12, CC-13)
**Prior audit:** `sdd-05-context-packing.md` (old numbering, pre-council — PASSED on B1/B2/B3; superseded by this re-audit under re-sequenced numbering)

VERDICT: PASS

No blocking issues. All 8 verification points hold. The council-amended spec correctly incorporates probe-gating (CP-00), schema subsetting (CP-04a/CP-04b/CP-12a), abort A6 (CP-20), and the SDD-06+SDD-04 dependency re-sequencing. The B1/B2/B3 fixes from the prior audit remain intact. Three non-blocking observations are noted at the end.

## Verification of the 8 required points

### (1) Probe-gated — PASS

- **Header (line 8):** "Depends: ... SDD-04 (pre-registered probe — must PASS before implementation; gates the hypergraph expansion path)".
- **Intro (line 13):** "M-4 SHALL NOT proceed to implementation until SDD-04 (the pre-registered retrieval-quality probe) has PASSED. If the probe triggers terminal fallback A3 (hypergraph retrieval abandoned), M-4 is re-scoped over baseline retrieval — the packer uses Arm 2 (vector + 1-hop, existing `SurrealBackend.query`) instead of Arm 3 (vector + hypergraph, `Hypergraph.query`)."
- **CP-00 (line 56):** "WHEN SDD-04 (the pre-registered retrieval-quality probe) has not PASSED, SDD-07 (M-4) SHALL NOT proceed to implementation — the `tools/sdd` pipeline SHALL refuse to advance sdd-07 from `spec` to `implement` until sdd-04's `tests` stage is green. WHEN the probe triggers terminal fallback A3 ... SDD-07 SHALL be re-scoped over baseline retrieval by setting `memory.packing.expansion_mode = "one_hop"` — the packer uses Arm 2 (vector + 1-hop via existing `SurrealBackend.query` at surreal-backend.ts:203-292) instead of Arm 3 (vector + hypergraph via `Hypergraph.query`)."
- **Council findings (line 27):** "The `tools/sdd` pipeline refuses to advance sdd-07 from `spec` to `implement` until sdd-04's `tests` stage is green."
- **Scope (line 42):** "Probe-gate: `tools/sdd` refuses to advance sdd-07 to `implement` until sdd-04 `tests` stage PASSED".
- **VERIFY (line 426):** `pack.test.ts: one_hop fallback uses SurrealBackend.query` | CP-00, CP-04 — spy confirms `SurrealBackend.query` called; `Hypergraph.query` NOT called.
- **Probe-gate enforcement (line 454):** "The `tools/sdd` pipeline SHALL refuse to advance sdd-07 from `spec` to `implement` until sdd-04's `tests` stage is green. This is enforced in the workstream state machine (`tools/sdd/workstreams/fbh-phase-m.json`), not in test code — it's a process gate, not a runtime check."

Both the SHALL NOT proceed and the A3 → `expansion_mode = "one_hop"` re-scope are explicit in WHAT (CP-00), in the scope, in the council findings, in the process-gate enforcement note, and in VERIFY. ✓

### (2) Schema subsetting — PASS

- **Intro (line 15):** "The packer operates on the 6 active node types only (MESSAGE, ACTION, ERROR, MEMORY, PROCEDURE, ENTITY per master SC-1). The 7 reserved node types (TASK, AGENT, INSIGHT, MODALITY, COMMUNITY, ARCHETYPE, META_PROCEDURE) are enum values only — no tables, no packing paths. ENTITY is expansion-input only: it seeds `Hypergraph.query` but is filtered out before formatting and never appears in `PackedContext.items` (enforced by packer type-filter + conformance test). TypedFormatter produces blocks for the 5 packable active types only (MEMORY, MESSAGE, ACTION, ERROR, PROCEDURE)."
- **CP-04a (line 74):** 6 active types only; 7 reserved types SHALL NOT be packed; conformance test asserts no reserved `node_type` appears in `PackedContext.items`.
- **CP-04b (line 76):** ENTITY permitted as expansion seeds, SHALL NOT appear in `PackedContext.items`; enforced by type-filter `n.node_type !== "entity"` after expansion, before formatting; conformance test asserts no `entity` in packed output.
- **CP-12a (line 107):** TypedFormatter produces blocks for the 5 packable active types only; ENTITY and 7 reserved types SHALL NOT produce a block.
- **schema.ts (lines 173-176):** `NodeType` = 6 active types; `ReservedNodeType` = 7 reserved types (for conformance test's exclusion set).
- **packer.ts (lines 240-243, 254-256):** `fused = rrfFuse(...).filter(isActiveType).filter(n => n.node_type !== "entity")`; `isActiveType` includes the 6 active types.
- **formatter.ts (lines 263-281):** `format` filters by `memory`/`message`/`action`/`error`/`procedure` only — no `entity` branch, no reserved-type branch.
- **VERIFY (lines 423-424, 438, 448-449):** `active types only` (CP-04a), `ENTITY filtered from output` (CP-04b), `no ENTITY or reserved block` (CP-12a), `conformance: no reserved types in output` (CP-04a), `conformance: no ENTITY in output` (CP-04b).

Cross-checks against master SC-1 (line 101): "ENTITY | Active | M-2 extraction (NER) | Expansion-input only — seeds Hypergraph.query; never packed (enforced by packer type-filter + conformance test)". The spec's CP-04b matches the master's framing verbatim, and the type-filter + conformance test enforcement is present in both WHAT and HOW. ✓

### (3) Abort A6 — PASS

- **Intro (line 13):** "Per master SC-11 A6: `pack()` P95 > 300ms unfixable → degrade to top-k baseline packing (no expansion, just vector seeds)."
- **CP-20 (line 131):** "WHEN `pack()` P95 latency exceeds 300ms and is unfixable after one tuning round (abort A6 per master SC-11), the system SHALL degrade to top-k baseline packing by setting `memory.packing.expansion_mode = "top_k"` — the packer skips expansion and packs seeds from `AutoRecall.autoRecall` only, ranked by the SDD-06 composite scorer via greedy top-k within budget. A conformance test SHALL verify the `top_k` path produces a valid `PackedContext` (`text`, `items`, `tokens`) with `items` drawn only from `AutoRecall.autoRecall` seeds (no `Hypergraph.query` call, no `SurrealBackend.query` expansion call) and `Token.estimate(text) <= budget` under 300ms P95."
- **CP-04 (line 80):** "WHEN `expansion_mode === "top_k"` (A6 degrade), the packer SHALL NOT expand — seeds alone are packed."
- **Config (line 403):** "`expansion_mode = "top_k"` is set by the human gate when A6 fires."
- **packer.ts (lines 219, 238):** `mode = cfg.memory?.packing?.expansion_mode ?? "hypergraph"`; `mode === "top_k"` branch skips expansion.
- **VERIFY (lines 427, 450):** `top_k fallback skips expansion` (CP-04, CP-20) — neither `Hypergraph.query` nor `SurrealBackend.query` is called; items are seeds only. `conformance: top_k path under 300ms P95` (CP-20) — 100-iteration P95 of `pack()` < 300ms; items are seeds only.

Master SC-11 A6 (line 138): "pack() P95 too high | P95 > 300ms unfixable | Degrade to top-k baseline packing". The spec's CP-20 matches the master's threshold (300ms), fallback (top-k baseline packing), and adds the conformance test with the P95 latency assertion. ✓

### (4) Dependency on sdd-06 + sdd-04 — PASS

- **Header (line 8):** "Depends: SDD-06 (M-3 lifecycle — composite scorer + decay formula), SDD-04 (pre-registered probe — must PASS before implementation; gates the hypergraph expansion path), SDD-03 (M-1 hypergraph schema — `Hypergraph.query`, `Hypergraph.store`, `Node` type), SDD-02 (M-0 wire-up — autoRecall block to remove)".
- **Dependencies (lines 484-489):**
  - "SDD-06 (M-3 lifecycle — composite scorer + decay formula) — `pack` uses the scorer to rank items; `feedback` increments `usage_count` which SDD-06's decay formula reads as `access(t)` on its hourly tick. Blocked until SDD-06 `implement` passes."
  - "SDD-04 (pre-registered probe) — M-4 SHALL NOT proceed to implementation until SDD-04's `tests` stage PASSED (CP-00). If A3 fires ... M-4 is re-scoped to `expansion_mode = "one_hop"`."
  - SDD-03 and SDD-02 dependencies also listed.
- **Council findings (line 30):** "SDD-07 depends on SDD-06 (M-3 lifecycle — composite scorer + decay formula) AND SDD-04 (probe must PASS). SDD-04 in the new numbering is the probe; the composite scorer / decay formula moved to SDD-06."

Cross-check against master dependency graph (line 184): "sdd-06 (M-3 lifecycle) ... └→ sdd-07 (M-4 packing) [probe-gated; ABORT A6 if pack P95 too high]" and (line 189): "The probe (sdd-04) gates sdd-05/sdd-06/sdd-07". Both dependencies are explicit and match the master's re-sequenced numbering. ✓

### (5) `pack(query, project_id, budget)` signature preserved — PASS

- **CP-01 (line 60):** "The signature SHALL match master SC-5 exactly: `pack(query: string, project_id: string, budget: number): Effect<PackedContext>`."
- **B2 fix (line 20):** "Aligned with master SC-5: `pack(query: string, project_id: string, budget: number): Effect<PackedContext>`."
- **Scope (line 35):** "`BudgetAwarePacker` in `src/memory/packing/` (new directory) — `ContextPacker.pack(query, project_id, budget)`".
- **packer.ts (line 214):** `export const pack = Effect.fn("ContextPacker.pack")(function* (query: string, project_id: string, budget: number) {`.
- **Wire-up (line 361):** `const packed = yield* ContextPacker.pack(query, project_id, budget).pipe(...)`.

All four sites (WHAT CP-01, B2 fix, scope, HOW signature, wire-up) agree on the signature. Master SC-5 confirmed via prior audit (`sdd-00-master.md` line 15 cited `pack(query: string, project_id: string, budget: number): Effect<PackedContext>` at master line 241). ✓

### (6) Session service via `Context.Tag` + `Effect.provideService` — PASS

- **B2 fix (line 20):** "Session context (sessionID, persona) is provided via a `Session` service (`Context.Tag<SessionContext>`), provided by the wire-up via `Effect.provideService`."
- **CP-02a (line 66):** "it SHALL resolve them from the `Session` service (`Context.Tag<SessionContext>`), provided by the wire-up via `Effect.provideService(Session, { sessionID, persona })`. The `Session` service SHALL be required (no default) — `pack` fails with a clear error if `Session` is not provided."
- **schema.ts (line 200):** `export const Session = Context.Tag<SessionContext>("@foxybear/ContextPacker/Session")`.
- **packer.ts (line 217):** `const session = yield* Session  // provided by wire-up`.
- **Wire-up (lines 361-363):** `const packed = yield* ContextPacker.pack(query, project_id, budget).pipe(Effect.provideService(Session, { sessionID, persona }))`.
- **Spike test (lines 471-473):** `ContextPacker.pack(...).pipe(Effect.provideService(Session, { sessionID: "spike", persona: "default" }))`.
- **VERIFY (line 421):** `pack.test.ts: resolves session from Session service` | CP-02a — `pack` without `Session` provided fails; with `Session` provided, resolves `sessionID` + `persona`.

The `Context.Tag<SessionContext>` declaration, the `Effect.provideService(Session, ...)` wire-up, the required-no-default semantics, and the VERIFY entry are all present and consistent. ✓

### (7) NO rehearse method — PASS

- **Intro (line 11):** "A `ProvenanceTracker` closes the feedback loop: memories that were injected and led to a successful turn get `usage_count` and `last_used` increments directly on the node, which the SDD-06 decay formula reads on its next hourly tick (the rehearsal term is `access(t)` in the decay formula — no standalone `rehearse` method exists or is needed)."
- **B1 fix (line 19):** "Removed all `MemoryLifecycle.rehearse()` calls. `ProvenanceTracker.feedback` now increments `usage_count` and `last_used` directly on the `MemoryNode` via `Hypergraph.store` update. The SDD-06 decay formula reads `usage_count` (as `access(t)`) during its hourly tick — rehearsal happens naturally in the next decay tick. No standalone `rehearse` method exists in SC-5."
- **CP-16 (line 121):** "`ProvenanceTracker.feedback(sessionID, true, project_id)` SHALL increment `usage_count` and update `last_used` on each injected memory node directly via `Hypergraph.store` (fetch node, increment `usage_count`, set `last_used = now`, write back). The SDD-06 decay formula reads `usage_count` (as `access(t)`) on its next hourly tick — the rehearsal boost happens naturally in decay. WHEN the turn fails, `feedback(sessionID, false, project_id)` SHALL NOT increment anything."
- **tracker.ts (lines 322-343):** `feedback = Effect.fn("ProvenanceTracker.feedback")(function* (sessionID, ok, project_id) { if (!ok) return; ... yield* Hypergraph.store(updated) })`. No `rehearse` method anywhere in the namespace.
- **Dependencies (line 486):** "Note: `MemoryLifecycle.rehearse` does NOT exist — SDD-06's decay formula reads `usage_count` directly during its hourly tick; `feedback` increments `usage_count` via `Hypergraph.store`."
- **VERIFY (lines 442-444):** `feedback on success increments usage_count` (CP-16), `no feedback on failure` (CP-16), `feedback clears store` (CP-16).

Grep for `rehearse` would return only explanatory mentions (all stating the method does NOT exist or referring to the decay formula's internal "rehearsal term"/"rehearsal boost" — which is SDD-06's `rehearsal_boost * access(t)` inside `decay`, not a standalone method). No method call remains. The feedback loop is `track` → `feedback(ok=true)` → `Hypergraph.store(updated with usage_count++)`. ✓

### (8) WHAT ↔ VERIFY 1:1 — PASS

25 WHAT clauses: CP-00, CP-01, CP-02, CP-02a, CP-03, CP-04, CP-04a, CP-04b, CP-05, CP-06, CP-07, CP-08, CP-09, CP-10, CP-11, CP-12, CP-12a, CP-13, CP-14, CP-15, CP-16, CP-17, CP-18, CP-19, CP-20.

VERIFY table (lines 419-450) — 32 test entries mapping to the 25 WHAT clauses:

| WHAT | VERIFY test(s) | Maps |
|---|---|---|
| CP-00 | `one_hop fallback uses SurrealBackend.query` (line 426) | PASS |
| CP-01 | `returns PackedContext shape` (line 419) | PASS |
| CP-02 | `skips slash commands` (line 420) | PASS |
| CP-02a | `resolves session from Session service` (line 421) | PASS |
| CP-03 | `seeds from AutoRecall` (line 422) | PASS |
| CP-04 | `expands via Hypergraph.query` (line 425), `one_hop fallback` (line 426), `top_k fallback` (line 427) | PASS (3 modes) |
| CP-04a | `active types only` (line 423), `conformance: no reserved types in output` (line 448) | PASS |
| CP-04b | `ENTITY filtered from output` (line 424), `conformance: no ENTITY in output` (line 449) | PASS |
| CP-05 | `fuses via RRF` (line 428) | PASS |
| CP-06 | `filters dead nodes` (line 429) | PASS |
| CP-07 | `scores via composite scorer` (line 430) | PASS |
| CP-08 | `respects budget` (line 431) | PASS |
| CP-09 | `type diversity` (line 432), `type diversity disabled` (line 434) | PASS (both branches) |
| CP-10 | `budget from config` (line 433) | PASS (CC-6) |
| CP-11 | `MEMORY block delegates` (line 435) | PASS |
| CP-12 | `typed blocks` (line 436) | PASS |
| CP-12a | `MESSAGE block` (line 437), `no ENTITY or reserved block` (line 438) | PASS |
| CP-13 | `staleness preserved` (line 439) | PASS |
| CP-14 | `L3 bootstrap first` (line 440) | PASS |
| CP-15 | `track records IDs` (line 441) | PASS |
| CP-16 | `feedback on success increments usage_count` (line 442), `no feedback on failure` (line 443), `feedback clears store` (line 444) | PASS (3 sub-cases) |
| CP-17 | `packed injected` (line 445) | PASS |
| CP-18 | `autoRecall removed` (line 446) | PASS |
| CP-19 | `respects budget` (line 431), `spike: budget cap with multi-type fixture` (line 447) | PASS |
| CP-20 | `top_k fallback skips expansion` (line 427), `conformance: top_k path under 300ms P95` (line 450) | PASS |

All 25 WHAT clauses have at least one VERIFY entry; every VERIFY entry maps to a WHAT clause. No orphan WHAT, no orphan VERIFY. The 1:1 mapping holds. ✓

## Non-blocking observations

These do not prevent the human gate or implementation; listing for completeness so the implementer can resolve them during coding.

### N-1: CP-04b "ENTITY permitted as expansion seeds" vs packer seed path

CP-04b (line 76) says "ENTITY nodes SHALL be permitted as expansion seeds (query inputs that seed further traversal)". The packer's seed path (packer.ts lines 221-224, CP-03 line 70) is `AutoRecall.autoRecall`, which returns MEMORY nodes (`Seeds are coerced to `Packed` items with `node_type = "memory"`). ENTITY nodes do not enter `Hypergraph.query` as seed inputs in the packer's flow; they appear in `Hypergraph.query` *results* (from traversal of MEMORY→ENTITY hyperedges), and the type-filter at line 243 removes them before formatting.

The conformance test description (line 449) says "entity appears in `Hypergraph.query` call args but not in packed output" — "call args" implies ENTITY is in the *input* to `Hypergraph.query`, but the packer passes `seedItems.map(s => s.id)` (MEMORY IDs) as the input. ENTITY would appear in `Hypergraph.query` *results*, not *call args*.

**Resolution:** The implementer should either (a) re-word the conformance test to "entity appears in `Hypergraph.query` results but not in packed output" or (b) test the type-filter directly (unit test the filter function with an ENTITY fixture). The WHAT (CP-04b: ENTITY filtered out, never packed) is correct; only the test description's "call args" wording is imprecise. CC-9 (no mocking) is not violated because the test can insert ENTITY nodes into the hypergraph fixture and let `Hypergraph.query` return them naturally.

### N-2: `Hypergraph.neighbors` as a node-fetch mechanism

tracker.ts (lines 328-330) fetches the node via `Hypergraph.neighbors(item.id, project_id)` with the comment "neighbors returns the node itself when depth=0", then finds the node by `nodes.find(n => n.node_id === item.id)`. The call does not pass `depth=0` explicitly, and master SC-5 `neighbors(id, project_id)` has no `depth` parameter (confirmed in prior audit `sdd-05-context-packing.md` N-2).

If `neighbors` returns only adjacent nodes (not the queried node itself), `find` returns undefined, `if (!node) continue` skips the increment, and the feedback loop silently breaks.

**Resolution:** The implementer should verify `neighbors` semantics during SDD-03 integration. If `neighbors` excludes the queried node, use `Hypergraph.query([item.id], project_id, { depth: 0 })` or add a dedicated `Hypergraph.get(id, project_id)` to SDD-03's contract. The WHAT (CP-16: fetch node, increment, write back) is clear; the fetch mechanism is an SDD-03 implementation detail. Carried forward from prior audit N-2.

### N-3: Audit directory numbering

The audit directory contains `sdd-05-context-packing.md` (prior audit, old pre-council numbering) and this re-audit is written as `sdd-07-context-packing.md` (re-sequenced numbering per master dependency graph line 184). The two files cover the same spec under different numbering; the old `sdd-05-context-packing.md` is superseded by this re-audit. No action required for the human gate — noting so a future maintainer knows the old file is stale and can be archived.

## Regression check

### B1/B2/B3 fixes from prior audit — intact

- **B1 (rehearse invented):** All `MemoryLifecycle.rehearse()` calls removed. `feedback` increments `usage_count` + `last_used` via `Hypergraph.store`. No `rehearse` method in the spec. (Verified above, point 7.)
- **B2 (pack signature conflicts):** Signature `pack(query, project_id, budget)` matches master SC-5 across CP-01, B2 fix, scope, HOW signature, wire-up. Session service via `Context.Tag` + `Effect.provideService` present. (Verified above, points 5 + 6.)
- **B3 (spike test conditionality):** Spike test (lines 464-479) populates 3 node types (MEMORY + ACTION + ERROR) via `Hypergraph.store` before the assertion. The `types.size > 1` assertion is unconditional on the fixture. (Verified in the spike test code at lines 464-479 and pass criterion at line 481.)

### Master SC-1/SC-5/SC-11/SC-12/CC-13 alignment

- **SC-1 (6 active + 7 reserved):** spec CP-04a lists the 6 active types matching master line 96-101; CP-04a lists the 7 reserved types matching master line 102-108. ✓
- **SC-5 (`pack(query, project_id, budget)`):** spec CP-01 matches master line 241 (via prior audit). ✓
- **SC-11 A6 (P95 > 300ms → top-k):** spec CP-20 matches master line 138. ✓
- **SC-12 (probe gates M-2/M-3/M-4):** spec CP-00 matches master line 144-160 and the dependency graph line 189 ("The probe (sdd-04) gates sdd-05/sdd-06/sdd-07"). ✓
- **CC-13 (subsetting enforcement):** spec CP-04a, CP-04b, CP-12a enforce 6 active types packed, 7 reserved enum-only, ENTITY expansion-input only. Matches master line 72. ✓

### Anchors

The council-amended spec retains all 17+ anchors verified in the prior audit (recall.ts:185, 187, 200-261, 279, 300; harness.ts:138-145, 147-174, 187-200, 205; prompt.ts:1485, 1493; compaction.ts:69; embedding.ts:19; util/token.ts:1; surreal-backend.ts:203-292; config/bridge.ts) and adds new anchors for the council additions (surreal-backend.ts:203-292 for the A3 one_hop fallback at line 56; SDD-03 SC-5 for `Hypergraph.query`/`Hypergraph.store` at lines 80, 161). No fabricated or removed anchors. The dependencies section (lines 484-489) correctly references SDD-02/03/04/06 by the re-sequenced numbering.

## Summary

The council-amended SDD-07 correctly incorporates all four additive changes from the 2026-09-22 deliberation:

1. **Probe-gating (CP-00, modified CP-04):** SHALL NOT proceed until sdd-04 PASSED; A3 → `expansion_mode = "one_hop"`; enforced in the `tools/sdd` workstream state machine.
2. **Schema subsetting (CP-04a, CP-04b, CP-12a, modified CP-14):** 6 active types packed, 7 reserved enum-only, ENTITY expansion-input only (filtered by packer type-filter, asserted by conformance test), TypedFormatter produces 5 packable active-type blocks, L3 bootstrap subsetted.
3. **Abort A6 (CP-20, modified CP-04):** P95 > 300ms unfixable → `expansion_mode = "top_k"`; conformance test asserts < 300ms P95 with seeds-only items.
4. **Dependency update:** SDD-06 (M-3 lifecycle — composite scorer + decay formula) and SDD-04 (probe) both explicit in header and Dependencies; old numbering corrected to re-sequenced numbering throughout.

All 8 verification points pass. The B1/B2/B3 fixes from the prior audit remain intact. No regressions. The three non-blocking observations (ENTITY "expansion seeds" wording, `neighbors` fetch semantics, audit-dir numbering) are noted but do not prevent the human gate or implementation.

**Ready for the human gate.**
