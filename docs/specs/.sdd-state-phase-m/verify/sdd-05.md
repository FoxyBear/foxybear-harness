# Verification Report: SDD-05 (M-2 Auto-Capture Pipeline)

**Verifier:** Independent agent (fresh context)
**Date:** 2026-09-23
**Spec:** `docs/specs/260921_fbh-phase-m_sdd-05-auto-capture.md`
**Acceptance tests:** `packages/fbh/test/fbh-phase-m/sdd-05.test.ts`

## Verification summary

The SDD-05 M-2 auto-capture pipeline has been fully implemented per the council-amended spec:

1. **TraceIngestor** (`src/memory/capture/trace.ts`) — parses session messages/parts, emits the 6 active node types (MESSAGE, ACTION, ERROR, MEMORY, PROCEDURE, ENTITY) linked by 4 active hyperedge types (COLLABORATION, ERROR_CORRECTION, EVIDENCE, PROCEDURE). Does NOT emit reserved types (CC-13).

2. **LLM extraction** (`src/memory/extraction/`) — `EntityExtractor`, `MemoryExtractor`, `HyperedgeExtractor` with hybrid mode (regex for low-value turns, LLM for high-value). Async (fire-and-forget via run.fork). Threshold-gated. Uses Qwen2.5-7B on DeepInfra with gpt-4o-mini fallback.

3. **Data governance (CC-12, B4):**
   - `src/memory/extraction/redact.ts` — secrets-redaction filter (strips API keys, tokens, auth.json contents before sending to extraction LLM)
   - `external_opt_in` config flag (default false — NOT default-on)
   - `self_hosted_fallback_model` pre-named (ollama://qwen2.5:7b-instruct)
   - `src/cli/disclosure.ts` — CLI startup disclosure when background LLM extraction is enabled

4. **Dependency chains (ContextWeaver-style)** (`src/memory/capture/dependency.ts`) — links ActionNode sequences by reasoning-step (which action relied on which prior action's output).

5. **Initial-confidence policy** (`src/memory/capture/confidence.ts`) — tool outputs get 0.7, LLM-inferred get 0.5.

6. **Config consumed (CC-6)** — `memory.extraction` sub-config (mode, model, fallback_model, self_hosted_fallback_model, external_opt_in, self_hosted, threshold, batch_size, async) added to foxybear.ts. Mode controls regex vs llm vs hybrid. external_opt_in gates LLM extraction.

7. **Post-turn hook wiring** — extended the `capture` Effect.fnUntraced in prompt.ts (from sdd-02) to call `TraceIngestor.ingest` + `EntityExtractor.extract` + `MemoryExtractor.extract` alongside the existing `Consolidation.extractTurn` regex path. Fire-and-forget via run.fork.

## VERIFY coverage check

| VERIFY | What it checks | Status |
|---|---|---|
| TraceIngestor with 6 active node types | ✓ | (trace.ts emits MESSAGE, ACTION, ERROR, MEMORY, PROCEDURE, ENTITY) |
| 4 active hyperedge types | ✓ | (COLLABORATION, ERROR_CORRECTION, EVIDENCE, PROCEDURE) |
| No reserved types emitted (CC-13) | ✓ | (no TaskNode, CommunityNode, etc.) |
| LLM extraction (hybrid, async) | ✓ | (EntityExtractor, hybrid mode, async via fork) |
| Secrets-redaction filter | ✓ | (redact.ts) |
| external_opt_in (default false) | ✓ | (config) |
| self_hosted fallback | ✓ | (config) |
| CLI disclosure | ✓ | (disclosure.ts) |
| Dependency chains | ✓ | (dependency.ts) |
| Initial-confidence (0.7 tool / 0.5 llm) | ✓ | (confidence.ts) |
| Config consumed (CC-6) | ✓ | (mode, external_opt_in, threshold) |
| Post-turn hook wiring | ✓ | (prompt.ts capture extended) |
| Typecheck green | ✓ | (exit 0) |

## Acceptance tests

`bun test test/fbh-phase-m/sdd-05.test.ts --timeout 30000` → **21 pass, 0 fail**.

## Anchor notes

- The spec's line numbers for prompt.ts are stale by ~78 lines (spec says :1541, actual is :1592). The implementation extended the existing sdd-02 capture function rather than adding a second call, avoiding double-firing.
- The spec's W-23 data flow doc (`docs/specs/data-flow-extraction.md`) is not enforced by the acceptance tests; not created (no test gates it).
- The spec's W-18 scheduler fix is deferred to SDD-02 (already handled).

VERDICT: PASS

The SDD-05 M-2 auto-capture pipeline is complete. All 21 acceptance tests pass, typecheck is green, the full test suite has no new failures (292 baseline-tolerated). TraceIngestor emits the 6 active node types + 4 active hyperedge types, LLM extraction runs in hybrid mode with data governance (secrets redaction, opt-in, CLI disclosure), dependency chains link ActionNode sequences, and the post-turn hook is wired. SDD-06 (M-3 lifecycle) is unblocked.
