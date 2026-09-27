# SDD-05: Phase M-2 — Auto-Capture Pipeline

**Date:** 2026-09-21 (revised 2026-09-22 per council deliberation)
**Project:** FoxyBear Harness Phase M (`development/foxybear`)
**Status:** Draft (pending independent re-audit + human gate)
**Master:** `260921_fbh-phase-m_sdd-00-master.md` — inherits SC-1, SC-4, SC-5, SC-6, SC-7, SC-11 (A4), CC-2, CC-3, CC-4, CC-5, CC-6, CC-7, CC-9, CC-12, CC-13, B4
**Research:** `docs/research/260921_fbh-phase-m_research.md` — MAGE, ContextWeaver, MOSAIC
**Workstream:** `fbh-phase-m` (`tools/sdd/workstreams/fbh-phase-m.json`)
**Depends on:** SDD-04 (pre-registered retrieval-quality probe — relational stratum MUST PASS per SC-12 before M-2 starts; transitive: SDD-03 M-1 hypergraph schema, SDD-02 M-0 wire-up, SDD-01 P-0 dormant-code audit)
**Blocks:** SDD-06 (M-3 lifecycle — needs access events from captured memories), SDD-09 (M-5 conflict — needs hypergraph neighbors)

Phase M-2 implements the auto-capture pipeline that ingests session traces into the MAGE hypergraph without agent intervention. `TraceIngestor` parses session `message`/`part` tables and emits the 6 active node types (MESSAGE, ACTION, ERROR, MEMORY, PROCEDURE, ENTITY per CC-13) linked by `COLLABORATION`/`ERROR_CORRECTION`/`EVIDENCE`/`PROCEDURE` hyperedges. LLM-driven extraction (MAGE-style, hybrid mode, async) pulls `ENTITY`/`MEMORY` records from high-value turns, falling back to the existing regex extractor for the rest. `ContextWeaver`-style dependency chains link `ActionNode` sequences by reasoning-step. The scheduler is wired to feed real `recentSessionIds` to `Consolidation.run`.

**Data governance (CC-12, B4):** M-2 sends code/technical content to DeepInfra for LLM-driven extraction — a confidentiality exposure. This spec adds: secrets-redaction filter with measured catch rate (runs BEFORE content is sent to the extraction LLM), explicit user opt-in (`memory.extraction.external_opt_in` default FALSE, NOT default-on), documented data classes with a data flow diagram showing what leaves the harness, and a pre-named self-hosted extraction fallback if provider terms fail. The CLI SHALL disclose when background LLM extraction is enabled.

**Schema subsetting (CC-13):** TraceIngestor only emits the 6 active node types. The 7 reserved node types (Task, Agent, Insight, Modality, Community, Archetype, MetaProcedure) are enum-only — NO tables, NO extraction paths. This spec does NOT redefine the hypergraph schema (SDD-03), lifecycle (SDD-06), or packing (SDD-07); it consumes the `@foxybear/Hypergraph` service interface (SC-5) and writes to the tables SDD-03 created.

**Abort A4 (SC-11):** Pre-committed extraction-quality abort. After one prompt-iteration round: precision < 60%, recall < 40%, or secrets leakage → regex-only fallback; re-probe. Pre-committed in SC-11; SHALL NOT be re-tuned after results arrive.

## Scope

In scope (M-2 only):

- `TraceIngestor` in `src/memory/capture/` — parses `Session.messages` output, emits the 6 active node types (ACTION, ERROR, MESSAGE from tool/text traces; MEMORY, PROCEDURE, ENTITY from extraction), links via `COLLABORATION`/`ERROR_CORRECTION`/`EVIDENCE`/`PROCEDURE` hyperedges. Per CC-13, TraceIngestor SHALL NOT emit any reserved node type.
- LLM-driven extraction in `src/memory/extraction/` — `EntityExtractor`, `HyperedgeExtractor`, `MemoryExtractor` (MAGE-style), hybrid mode, async, threshold-gated.
- `ContextWeaver`-style dependency chains — link `ActionNode` sequences by reasoning-step (which action relied on which prior action's output).
- Wire `MemoryCapture.capture` into the post-turn hook (alongside `Consolidation.extractTurn`).
- Wire `Consolidation.run` from the scheduler with real `recentSessionIds` (fix `scheduler.ts:377-381` stub — coordinate with SDD-02 if already fixed).
- Data governance (CC-12, B4): secrets-redaction filter with measured catch rate, explicit user opt-in (default false), documented data classes with data flow diagram, self-hosted extraction fallback pre-named.
- Initial-confidence policy: extracted memories receive initial `confidence` set by extraction-path provenance class (tool outputs = 0.7, LLM-inferred = 0.5).
- User-facing CLI disclosure: startup message when background LLM extraction is enabled.
- Spike: Qwen2.5-7B extraction on a 50-turn real session trace, per-turn latency + cost + entity hallucination rate (measured separately from precision).

Out of scope:

- Hypergraph schema, `SurrealHypergraphBackend`, backfill migration (SDD-03).
- Lifecycle: decay, consolidation, graduation, pruning, GC (SDD-06).
- Context packing, budget-aware formatter, provenance tracker (SDD-07).
- Save-time conflict detection, HiGram path localization (SDD-09).
- The 7 reserved node types (Task, Agent, Insight, Modality, Community, Archetype, MetaProcedure) — enum-only per CC-13, no tables, no extraction paths, no packing paths. Activation requires a complete producer+consumer+metric row audited to the same standard.
- `INSIGHT` is no longer "deferred to M-3" — it is reserved enum-only. Activation would require a new spec.

## Spike (from master SC-7)

**Goal:** Decide whether LLM-driven extraction is viable per turn, AND measure entity hallucination rate separately from precision (precision on existing entities vs. hallucination of new entities are different failure modes per council "Part X" gap).

**Method:** Run Qwen2.5-7B-Instruct extraction on a 50-turn real session trace (real provider, real session content, no mocks). Measure per-turn wall-clock latency, per-turn cost, AND entity hallucination rate. The hallucination rate is the count of new entities extracted by the LLM that do not appear in the trace's ground-truth entity set (manually labeled), divided by the total extracted entity count. Precision (existing entities correctly extracted) and hallucination (new entities fabricated by the LLM) SHALL be reported as separate metrics.

**Pass criterion:** < 2s/turn AND < $0.001/turn → LLM extraction is the default for high-value turns. Entity hallucination rate is reported as a separate informational metric (precision/recall thresholds are enforced at abort A4, not at spike). The spike SHALL record the hallucination rate in the test output for later comparison against A4's recall threshold.

**Fallback:** regex-only extraction; LLM extraction deferred to a follow-on. The spike's `extract` function is throwaway — not production code.

**Gating:** Per CC-3, the spec's `tests` stage SHALL include a spike-specific test that validates the spike's decision criterion. IF the spike fails, the HOW SHALL be revised to the fallback approach before `implement` proceeds. The spike code lives in `tmp/spike-extraction/` and is not shipped.

## Config (from master SC-6)

Consumed from `~/.config/foxybear/fbh.json` under `memory.extraction`:

```json
"memory": {
  "extraction": {
    "mode": "hybrid",
    "model": "deepinfra/Qwen/Qwen2.5-7B-Instruct",
    "fallback_model": "openai/gpt-4o-mini",
    "self_hosted_fallback_model": "ollama://qwen2.5:7b-instruct",
    "external_opt_in": false,
    "self_hosted": false,
    "threshold": 0.7,
    "batch_size": 5,
    "async": true
  }
}
```

`external_opt_in` defaults to `false` (NOT default-on per CC-12). Extraction only proceeds against an external provider (DeepInfra) if explicitly opted in. `self_hosted_fallback_model` is pre-named for the self-hosted fallback (W-24); `self_hosted = true` routes extraction to the local model instead of the external provider.

Per CC-6, config consumed SHALL be proven by a test that changes the value and asserts the behavior changes. Schema without wiring is false-done.

## WHAT

### TraceIngestor

**W-1** WHEN a turn completes with one or more `MessageV2.ToolPart` records in the `PartTable`, `TraceIngestor.ingest` SHALL emit one `ACTION` node per tool part. The node's `action_type` SHALL be the `ToolPart.tool` field, `input` SHALL be `ToolStateCompleted.input` or `ToolStateError.input`, `output` SHALL be `ToolStateCompleted.output` or the empty string for errors, `success` SHALL be `true` for `status = "completed"` and `false` for `status = "error"`, `cost` SHALL be the pro-rated `StepFinishPart.cost` divided across the step's tool calls, `step` SHALL be the step index derived from the nearest preceding `StepStartPart`, and `agent_id`/`task_id` SHALL be the assistant message's `agent` and the session's `id`.

**W-2** WHEN a turn completes with one or more `MessageV2.ToolPart` records in `status = "error"`, OR with an `assistantMessage.error` set on the message, `TraceIngestor.ingest` SHALL emit one `ERROR` node per error. The node's `error_type` SHALL be the `NamedError` code or the literal `"tool_error"` for tool failures, `description` SHALL be `ToolStateError.error` or the serialized `assistantMessage.error`, `severity` SHALL be `"high"` for message-level errors and `"medium"` for tool errors, `detected_by` SHALL be `"system"` for runtime errors and `"agent"` for tool-call errors surfaced by the model, `corrected` SHALL be `false` initially, and `agent_id`/`task_id` SHALL match W-1.

**W-3** WHEN a turn completes, `TraceIngestor.ingest` SHALL emit one `MESSAGE` node per assistant message with `content` derived from the concatenated `TextPart` text of the message, `step` matching the step index of the last `StepFinishPart`, `modality` `"text"` (image/file parts extend this in a follow-on), `agent_id` from `assistantMessage.agent`, and `task_id` from the session's `id`.

**W-4** WHEN `TraceIngestor.ingest` emits nodes for a turn, it SHALL also emit one `COLLABORATION` hyperedge linking the turn's `MESSAGE` and `ACTION` nodes. Per CC-13, the hyperedge SHALL NOT link to an `AGENT` node (AGENT is reserved, enum-only, no table); the `agent_id` is carried as a field on `role_assignments`, not as a node reference. The hyperedge's `role_assignments` SHALL be `Record<agent_id, Role>` where `Role` is the assistant message's agent name, and `outcome` SHALL be `"success"` when no `ERROR` nodes are present, `"error"` when any `ERROR` is present and no subsequent `ACTION` corrected it, and `"recovered"` when an `ERROR_CORRECTION` hyperedge (W-5) references this turn.

**W-5** WHEN an `ERROR` node is followed by an `ACTION` node in a subsequent turn whose `action_type` differs from the failing action's `action_type` AND the subsequent turn's `MESSAGE` content references the error (substring match on `error.description` or the failing tool name), `TraceIngestor.ingest` SHALL emit one `ERROR_CORRECTION` hyperedge linking the `ERROR` node and the correcting `ACTION` node. The hyperedge's `error_id` SHALL be the `ERROR` node's `node_id`, and `detecting_agent_id` SHALL be the correcting action's `agent_id`. The `ERROR` node's `corrected` field SHALL be updated to `true` via a bi-temporal UPDATE (close `tx_to`, write a new version with `corrected = true`, `prev_version_id` pointing at the prior version).

**W-6** WHEN a `MEMORY` node is created by `Consolidation.extractTurn` (regex) or `MemoryExtractor.extract` (LLM) for content that originated in this turn, `TraceIngestor.ingest` SHALL emit one `EVIDENCE` hyperedge linking the new `MEMORY` node to the turn's `MESSAGE` and supporting `ACTION` nodes. The hyperedge's `query_or_task_id` SHALL be the session's `id`. The hyperedge's `description` SHALL be a one-line summary of the supporting evidence (e.g., `"action bash produced output supporting memory: '...'""`).

### Post-turn hook

**W-7** WHEN the session prompt loop exits the step loop (`src/session/prompt.ts:1541`, after `if (outcome === "break") break`) for a user message — the turn is complete — and the turn's final step result (the last `handle.process` return at `src/session/prompt.ts:1493`) is not `"compact"`, the post-turn hook SHALL invoke `MemoryCapture.capture(turn)` exactly once per turn. The hook SHALL fire once per turn (after all steps complete), not once per step. `turn` SHALL be a `SessionTurn` carrying the session ID, the assistant message ID, the list of `MessageV2.WithParts` for the turn (user + assistant messages and their parts), and the persona name. The hook SHALL be wired alongside `Consolidation.extractTurn` (which it calls internally for the regex path) so the existing regex extractor is not bypassed.

**W-8** WHEN `MemoryCapture.capture` is invoked, it SHALL NOT block the LLM response. The call SHALL be forked via `Effect.forkIn(scope)` (or equivalent) so the LLM stream completes and returns to the user before capture runs. Exceptions in the capture path SHALL be logged at `warn` level and swallowed; the session SHALL continue.

### LLM-driven extraction

**W-9** WHEN `memory.extraction.mode = "llm"` OR `memory.extraction.mode = "hybrid"` AND the turn's extraction score is at or above `memory.extraction.threshold` AND `memory.extraction.external_opt_in = true` (W-22) AND secrets redaction (W-21) passes, `MemoryCapture.capture` SHALL run `EntityExtractor.extract`, `HyperedgeExtractor.extract`, and `MemoryExtractor.extract` against the turn's content. Each extractor SHALL return zero or more records (entities, hyperedges, memories) which SHALL be stored via `@foxybear/Hypergraph.store` and `@foxybear/Hypergraph.edge`.

**W-10** WHEN `memory.extraction.mode = "regex"`, OR `memory.extraction.mode = "hybrid"` AND the turn's extraction score is below `memory.extraction.threshold`, OR `memory.extraction.external_opt_in = false` (W-22), `MemoryCapture.capture` SHALL fall back to `Consolidation.extractTurn` (the existing regex extractor at `consolidation.ts:594`). The regex path SHALL NOT call the LLM.

**W-11** The turn's extraction score SHALL be computed deterministically from the turn's content: 1.0 if the turn contains an `ERROR` or a `MEMORY`-worthy fact (matches a `DECISION`/`CONSTRAINT`/`PREFERENCE`/`CORRECTION` regex pattern from `extractFacts`), 0.5 if the turn contains a tool call with non-empty `output` longer than 200 chars, and 0.0 otherwise. The score is a float in `[0.0, 1.0]` and is logged at `debug` level only.

**W-12** WHEN the primary extraction LLM call (`memory.extraction.model`) fails (network error, 4xx, 5xx, or parse error), `MemoryCapture.capture` SHALL retry once with `memory.extraction.fallback_model`. IF the fallback also fails, the turn SHALL be re-queued for the next batch (up to `memory.extraction.batch_size` retries across the session) and the regex extractor SHALL run for this turn as a guaranteed-success path.

**W-13** WHEN `memory.extraction.async = true`, the LLM extraction SHALL be batched across turns up to `memory.extraction.batch_size` and dispatched as a single LLM call per batch. The batch SHALL be processed in the background (`Effect.forkIn`) and SHALL NOT delay subsequent turns. The batch results SHALL be written to the hypergraph when the batch completes, with each result tagged with its source turn's `MESSAGE` node ID for `EVIDENCE` hyperedge construction (W-6).

**W-14** The extraction LLM call payload SHALL contain only text content (the turn's `MESSAGE` content, the `ACTION` input/output summaries, the prior turns' `MESSAGE` content for context). The payload SHALL NOT contain embeddings (`Float32Array`), `auth.json` contents, API keys, or any vector data. The extraction LLM's request and response SHALL be logged at `debug` level only and SHALL NOT be logged at `info` level. Extraction logs at `info` level SHALL contain only metadata (turn count, extraction duration, model used, success/failure).

**W-15** The extraction LLM call SHALL use the existing `src/provider/` path (`Provider.Service` + `createDeepInfra`/`createOpenAI`). No new HTTP client, no new auth path. The model ID SHALL be parsed via `Provider.parseModel` from the `memory.extraction.model` config string (e.g., `"deepinfra/Qwen/Qwen2.5-7B-Instruct"` → `providerID = "deepinfra"`, `modelID = "Qwen/Qwen2.5-7B-Instruct"`).

### Dependency chains

**W-16** WHEN `TraceIngestor.ingest` emits an `ACTION` node whose `input` references a prior `ACTION` node's `output` (substring match of the prior output's first 200 chars in the new input, or an explicit `PartID` reference), `TraceIngestor.ingest` SHALL emit a `NARY_FACT` hyperedge linking the two `ACTION` nodes. The hyperedge's `description` SHALL be `"action <step N> relied on action <step M> output"`. This is the `ContextWeaver`-style dependency graph.

**W-17** WHEN `TraceIngestor.ingest` detects a chain of three or more `ACTION` nodes linked by W-16 dependency edges with the same `action_type` and all `success = true`, it SHALL emit one `PROCEDURE` node with `name = action_type`, `steps = [action_id, ...]`, `success_rate = 1.0` (initially), `used_by_roles = [agent_id]`, and `confidence` per W-25 (tool-output provenance, 0.7). The `PROCEDURE` hyperedge SHALL link the `PROCEDURE` node to all `ACTION` nodes in the chain.

### Scheduler wiring

**W-18** WHEN the scheduler's `memory-consolidation` maintenance task fires (scheduler.ts:365-382), the handler SHALL pass real `recentSessionIds` derived from the session store (the IDs of sessions that completed since the last consolidation run), not the `[]` stub at scheduler.ts:380. The list SHALL be sourced from `Session.list` filtered by `time_updated` since the last consolidation timestamp. IF SDD-02 has already replaced this stub, this WHEN/SHALL is satisfied by SDD-02 and this spec does not duplicate the fix; the spike test SHALL verify the scheduler receives a non-empty list when at least one session has completed since the last run.

### Spike

**W-19** WHEN the spike test runs, it SHALL load a real 50-turn session trace from the test fixture (a captured real session, not synthesized), invoke `extract` (the throwaway spike extractor) on each turn against the real Qwen2.5-7B-Instruct provider via `Provider.parseModel("deepinfra/Qwen/Qwen2.5-7B-Instruct")`, measure wall-clock latency per turn, compute cost per turn from the provider's reported `usage` tokens and the model's `cost` table, AND measure entity hallucination rate separately from precision (the count of new entities extracted by the LLM that do not appear in the trace's manually-labeled ground-truth entity set, divided by the total extracted entity count). The test SHALL assert that the median per-turn latency is `< 2_000` ms AND the median per-turn cost is `< 0.001` USD. The entity hallucination rate SHALL be reported in the test output as a separate metric (informational at spike stage; precision/recall thresholds are enforced at abort A4). IF the assertion fails, the spike SHALL record the actual median latency, cost, and hallucination rate in the test output and the spec's HOW SHALL be revised to the regex-only fallback before `implement` proceeds (per CC-3).

### Config consumed

**W-20** WHEN `memory.extraction.mode` changes from `"hybrid"` to `"regex"`, `MemoryCapture.capture` SHALL NOT invoke any LLM extractor for any turn. WHEN the mode changes from `"hybrid"` to `"llm"`, `MemoryCapture.capture` SHALL NOT invoke `Consolidation.extractTurn` for any turn with score `>= threshold`. WHEN `memory.extraction.threshold` changes from `0.7` to `0.0`, every turn SHALL be eligible for LLM extraction in hybrid mode. WHEN `memory.extraction.batch_size` changes from `5` to `1`, batching SHALL be disabled (one LLM call per turn). WHEN `memory.extraction.async` changes from `true` to `false`, the extraction SHALL run synchronously before the LLM response returns to the user (use only in tests). WHEN `memory.extraction.external_opt_in` changes from `false` to `true` (and `mode != "regex"`), the LLM path SHALL be enabled (subject to W-21 secrets redaction). WHEN `memory.extraction.self_hosted` changes from `false` to `true` (and `external_opt_in = false`), the LLM path SHALL run against `self_hosted_fallback_model` instead of `model`. A test SHALL mutate each field and assert the behavior change (per CC-6).

### Data governance (CC-12, B4)

**W-21** WHEN `MemoryCapture.capture` invokes an extraction LLM (per W-9), the system SHALL run a secrets-redaction filter on the LLM payload BEFORE the content is sent to the provider. The filter SHALL redact patterns matching: API keys (regex for common key formats: `sk-...`, `AIza...`, `ghp_...`, `AKIA...`, `xoxb-...`), JWT tokens (`eyJ...`), `auth.json` contents (matched against the user's actual `~/.config/foxybear/auth.json` keys), bearer tokens, and `password`/`secret`/`token` field values in JSON. The filter's catch rate SHALL be measured on a seeded fixture containing 5 representative secrets; the test SHALL assert zero leakage (no secret substring appears in the redacted payload sent to the LLM). IF the filter misses any secret, the test SHALL fail and the LLM path SHALL NOT be enabled until the filter is fixed. No secrets (API keys, tokens, `auth.json` contents) SHALL be sent to the extraction LLM.

**W-22** WHEN `memory.extraction.external_opt_in` is `false` (the default), `MemoryCapture.capture` SHALL NOT invoke any external extraction LLM for any turn; only the regex path (`Consolidation.extractTurn` per W-10) SHALL run. WHEN the user explicitly sets `memory.extraction.external_opt_in = true` in config, the LLM path SHALL be enabled (subject to W-21 secrets redaction). The default SHALL be `false` (NOT default-on per CC-12). A test SHALL mutate `external_opt_in` from `false` to `true` and assert the LLM call is made only when `true`; with `false`, no LLM call SHALL be made regardless of `mode` or `threshold`.

**W-23** The spec SHALL document data classes and a data flow diagram showing exactly what content leaves the harness during extraction. The documentation SHALL live in `docs/specs/data-flow-extraction.md` (created by this spec's implementation) and SHALL enumerate: (a) data classes that leave the harness (turn text content, ACTION input/output summaries, prior turns' MESSAGE content for context); (b) data classes that do NOT leave (embeddings/Float32Array, `auth.json` contents, API keys, vector data); (c) provider retention policy (DeepInfra's documented retention, written record of what is retained); (d) logging policy (info-level logs contain only metadata, debug-level logs contain full payloads for debugging). The documentation SHALL include a data flow diagram (textual or ASCII) showing the path from session content → secrets-redaction filter (W-21) → extraction LLM payload → provider → response → hypergraph store. The documentation SHALL be reviewed before the M-2 gate.

**W-24** The spec SHALL pre-name a self-hosted extraction fallback if the DeepInfra provider terms fail or the user opts out of external processing. The fallback SHALL be a local Qwen2.5-7B-Instruct model served via Ollama (`ollama://qwen2.5:7b-instruct`) or vLLM, accessed through the existing `Provider.Service` path (no new HTTP client). The config field `memory.extraction.self_hosted_fallback_model` SHALL default to `"ollama://qwen2.5:7b-instruct"`. WHEN the user sets `memory.extraction.external_opt_in = false` AND `memory.extraction.self_hosted = true`, the LLM extraction path SHALL run against the self-hosted model instead of DeepInfra (secrets redaction W-21 still applies — local model, but the redaction discipline is retained for defense in depth). A test SHALL assert the self-hosted path is invoked when configured and that no call to the external provider is made.

### Initial-confidence policy (council "Part X" gap)

**W-25** WHEN a `MEMORY`, `ENTITY`, or `PROCEDURE` node is created by extraction, its initial `confidence` SHALL be set by extraction-path provenance class: (a) `0.7` for nodes derived from deterministic paths — `PROCEDURE` from action chain detection (W-17), `MEMORY` from `Consolidation.extractTurn` (regex); (b) `0.5` for nodes inferred by the extraction LLM — `ENTITY` from `EntityExtractor.extract`, `MEMORY` from `MemoryExtractor.extract`. The provenance class SHALL be recorded on the node's `source_path` field (`"tool"` for deterministic, `"llm"` for LLM-inferred). The initial confidence is the starting value; subsequent access events (M-3 lifecycle) and conflict evidence (M-5) MAY adjust it. A test SHALL assert that a `PROCEDURE` node from an action chain has `confidence = 0.7`, a `MEMORY` from the regex path has `confidence = 0.7`, an `ENTITY` from `EntityExtractor.extract` has `confidence = 0.5`, and a `MEMORY` from `MemoryExtractor.extract` has `confidence = 0.5`.

### User-facing disclosure (council "Part X" gap)

**W-26** WHEN `memory.extraction.mode` is `"hybrid"` or `"llm"` AND `memory.extraction.external_opt_in = true`, the CLI SHALL display a startup message at session start indicating that background LLM extraction is enabled and that session content is sent to the configured external provider. The message SHALL be shown once per session startup (not per turn) and SHALL include the provider name (parsed from `memory.extraction.model` via `Provider.parseModel`, e.g., `"DeepInfra"`) and a reference to the data flow documentation (W-23, `docs/specs/data-flow-extraction.md`). Example message: `"Memory extraction enabled: session content is sent to DeepInfra for LLM-driven extraction. See docs/specs/data-flow-extraction.md for data classes."`. WHEN extraction is disabled (`mode = "regex"` OR `external_opt_in = false` OR `self_hosted = true` with no external provider call), no external-processing startup message SHALL be shown. A test SHALL assert the message appears when extraction is enabled against an external provider and does not appear when disabled or self-hosted.

### Abort A4 (SC-11)

**W-27** After one prompt-iteration round of M-2 extraction (the first production deployment, measured against a labeled evaluation set of ≥ 50 turns from real sessions with manually-labeled ground-truth entities and memories), IF precision < 60% OR recall < 40% OR secrets leakage to DeepInfra is detected (W-21 filter fails), the system SHALL switch to regex-only extraction fallback (`memory.extraction.mode` forced to `"regex"` in config) and re-probe the extraction quality on the next iteration. The abort SHALL be recorded in the decision log per CC-11, with raw results (precision, recall, entity hallucination rate from W-19, leakage count) written to `docs/decisions/` per the documentation rules. The abort criterion is pre-committed in SC-11 (A4) and SHALL NOT be re-tuned after results arrive. The floor: M-0 wire-up + baseline-retrieval injection (regex-only extraction) ships regardless — the regex path is the guaranteed-success path (W-10, W-12) and remains available even if A4 fires.

## HOW

### Anchors (verified)

| Anchor | File:Line | Verified | Note |
|---|---|---|---|
| `Consolidation.extractTurn` | `src/memory/consolidation.ts:594` | ✅ | Per-turn regex extractor. Zero call sites in `src/`. Wired by this spec. |
| `Consolidation.run` | `src/memory/consolidation.ts:533` | ✅ | Full pipeline (orient→gather→consolidate→prune). Master spec cites line 362 — see Seams. |
| `Consolidation.consolidate` | `src/memory/consolidation.ts:362` | ✅ | Phase called by `run`. |
| `extractEntities` (regex) | `src/memory/extraction.ts:45` | ✅ | Extracts concepts (CamelCase), tools (backticks), patterns (file paths). Called from `surreal-backend.ts:155`. Reused as the regex fallback. |
| `Harness.run` | `src/harness/harness.ts:54` | ✅ | Has `AutoRecall` call at lines 138-145. Zero call sites in `src/session/`. NOT wired by this spec (M-4 packs context; M-2 only captures). |
| `Session.messages` | `src/session/index.ts:601` | ✅ | Returns `MessageV2.WithParts[]` — the trace source for `TraceIngestor`. |
| `SessionTable`/`MessageTable`/`PartTable` | `src/session/session.sql.ts:15/47/61` | ✅ | Drizzle tables. `PartTable.data` is the JSON-encoded `PartData` union. |
| `MessageV2.ToolPart` | `src/session/message-v2.ts:344` | ✅ | `type: "tool"`, `callID`, `tool`, `state: ToolState`. Source of `ACTION` nodes. |
| `MessageV2.ToolStateCompleted` | `src/session/message-v2.ts:303` | ✅ | `status`, `input`, `output`, `title`, `metadata`, `time.start/end`. |
| `MessageV2.ToolStateError` | `src/session/message-v2.ts:322` | ✅ | `status`, `input`, `error`, `metadata`, `time.start/end`. Source of `ERROR` nodes. |
| `MessageV2.StepFinishPart` | `src/session/message-v2.ts:256` | ✅ | `cost`, `tokens`. Source of `ACTION.cost` pro-rating. |
| `MessageV2.TextPart` | `src/session/message-v2.ts:113` | ✅ | Source of `MESSAGE.content`. |
| `SessionProcessor.process` | `src/session/processor.ts:538` | ✅ | The LLM stream runner. Returns `"compact"|"stop"|"continue"` (line 28). |
| `SessionProcessor` `finish-step` event | `src/session/processor.ts:357` | ✅ | Per-step completion. The step-finish PartTable record is written here (lines 366-375). |
| `handle.process` call | `src/session/prompt.ts:1493` | ✅ | The actual LLM call invocation in the prompt loop. |
| Post-turn outcome branch | `src/session/prompt.ts:1525-1541` | ✅ | After `handle.process` returns. `if (result === "stop") return "break"` at :1525 (inside the `while (true)` step loop starting at :1316); step loop exits at :1537 (`if (outcome === "break") break`); post-turn hook wired at :1541 (after the loop, alongside `compaction.prune`), so it fires once per turn (not once per step). |
| Scheduler `memory-consolidation` task | `src/scheduler/scheduler.ts:365-382` | ✅ | Stub at line 380: `recentSessionIds: []`. Wired by this spec (or SDD-02). |
| `@foxybear/Embedding` service | `src/memory/embedding.ts:19` | ✅ | Effect Service. Pattern to mirror for `@foxybear/MemoryCapture`. |
| `Provider.parseModel` | `src/provider/provider.ts` | ✅ | Parses `"deepinfra/Qwen/Qwen2.5-7B-Instruct"` into providerID + modelID. |
| `createDeepInfra` | `src/provider/provider.ts:41` | ✅ | Extraction LLM transport. |
| `extractFacts` (regex patterns) | `src/memory/consolidation.ts:67` | ✅ | `DECISION`/`CONSTRAINT`/`PREFERENCE`/`CORRECTION` patterns. Reused by W-11 scoring. |
| `surreal-backend.ts:extractAndLinkEntities` | `src/memory/surreal-backend.ts:148` | ✅ | Existing regex entity extraction at store-time. Reference for the LLM `EntityExtractor` interface. |
| `Memory.store` | `src/memory/memory.ts:585` | ✅ | Existing store. `MemoryExtractor.extract` writes via `Hypergraph.store` (SDD-03), not `Memory.store`, to land in the `node` table. |
| CLI startup banner | `src/cli/index.ts` (entry) | ✅ | CLI entry point. Startup message (W-26) is wired here. |

### Reuse map

| Existing | Reuse | New |
|---|---|---|
| `Consolidation.extractTurn` (consolidation.ts:594) | Wired as the regex path in `MemoryCapture.capture`. Called for turns below threshold OR when `external_opt_in = false` (W-22). | None. Existing signature accepted. |
| `extractEntities` (extraction.ts:45) | Called by the regex path for entity extraction. Extended by `EntityExtractor.extract` (LLM) which wraps it as a fallback. | `src/memory/extraction/` directory with `entity.ts`, `hyperedge.ts`, `memory.ts`. |
| `Provider.parseModel` + `createDeepInfra` | Used by the LLM extractors. No new HTTP client, no new auth. | `extract` function in each extractor that builds the prompt, calls the provider, parses JSON. |
| `Session.messages` (session/index.ts:601) | Called by `TraceIngestor.ingest` to load the turn's `WithParts[]`. | None. |
| `MessageV2` part schema (message-v2.ts) | The discriminated union `PartTable.data`. `TraceIngestor` switches on `part.type`. | None. |
| `@foxybear/Hypergraph` (SDD-03 SC-5) | `store(node)` and `edge(edge)` write to the `node`/`hyperedge` tables. | None. |
| `@foxybear/Embedding` (embedding.ts:19) | Pattern: Effect Service + `Layer.effect` + `makeRuntime`. | `@foxybear/MemoryCapture` service in `src/memory/capture/`. |
| `extractFacts` (consolidation.ts:67) | Pattern list reused for W-11 scoring (turn contains `DECISION`/`CONSTRAINT`/etc. → score 1.0). | None. |
| CLI startup banner | Existing banner extended with W-26 disclosure message when extraction is enabled. | `src/cli/disclosure.ts` — builds the disclosure message from config. |

### New modules

```
src/memory/capture/
  trace.ts        — TraceIngestor namespace, ingest(input: SessionTurn): Effect<void>
  link.ts         — link(nodes, hyperedge_type, attrs): Effect<Hyperedge> helper
  score.ts        — score(turn): number — W-11 turn scoring
  service.ts      — @foxybear/MemoryCapture Effect Service (SC-5)
  session-turn.ts — SessionTurn type (sessionID, messageID, withParts[], persona)
  confidence.ts   — initial confidence policy (W-25): provenance → 0.7 | 0.5
src/memory/extraction/
  entity.ts       — EntityExtractor namespace, extract(text, opts): Effect<ENTITY[]>
  hyperedge.ts    — HyperedgeExtractor namespace, extract(text, nodes, opts): Effect<HYPEREDGE[]>
  memory.ts       — MemoryExtractor namespace, extract(text, opts): Effect<MEMORY[]>
  prompt.ts       — prompt builders (entity, hyperedge, memory) — text-only, no vectors
  parse.ts        — parse LLM JSON response → typed records, strict schema validation
  redact.ts       — secrets-redaction filter (W-21): redact(payload, fixture): Effect<Payload>
src/memory/capture/dependency.ts — W-16 dependency chain detector
src/memory/capture/procedure.ts  — W-17 procedure node emitter
src/cli/disclosure.ts            — W-26 startup disclosure message builder
docs/specs/data-flow-extraction.md — W-23 data classes + data flow diagram
test/memory/capture/
  trace.test.ts        — W-1 through W-6
  hook.test.ts         — W-7, W-8
  extract.test.ts      — W-9 through W-15
  dependency.test.ts   — W-16, W-17
  scheduler.test.ts    — W-18
  spike.test.ts        — W-19
  config.test.ts       — W-20
  governance.test.ts   — W-21, W-22, W-23, W-24
  confidence.test.ts   — W-25
  disclosure.test.ts   — W-26
  abort.test.ts        — W-27
test/fixture/spike-extraction/50-turn-trace.json — real captured session, 50 turns
test/fixture/spike-extraction/ground-truth-entities.json — manually-labeled entity set for hallucination rate
test/fixture/governance/secrets-fixture.json — 5 seeded secrets for W-21 catch rate
test/fixture/abort/labeled-eval-set.json — ≥50 turns with labeled ground-truth for A4
```

### Wiring

1. **Post-turn hook** (`src/session/prompt.ts:1541`): after the step loop exits (after `if (outcome === "break") break` at `:1537`), alongside `compaction.prune`, call `MemoryCapture.capture({ sessionID, messageID: handle.message.id, withParts: [...], persona })` via `Effect.forkIn(scope)` (the same `scope` used by `compaction.prune` at line 1541). Track the final step `result` from `handle.process` (`src/session/prompt.ts:1493`) across loop iterations in a closure variable (e.g., `let lastResult` declared before the `while (true)` loop at `:1316`, updated inside the loop after `handle.process` returns). Guard: only fire if `lastResult !== "compact"`. Wiring inside the loop at `:1538` would miss `"stop"` turns (the loop breaks at `:1537` before reaching `:1538`) and would fire per-step for `"continue"`/`"compact"` turns. Exceptions logged via `Effect.catch` and ignored.

2. **Scheduler** (`src/scheduler/scheduler.ts:380`): replace `recentSessionIds: []` with `await recentSessionIds()` where `recentSessionIds` queries `Session.list({ start: lastConsolidationTime })` and returns the IDs. The last-consolidation timestamp is tracked in the existing `_lastConsolidationTime` module state (consolidation.ts:675). IF SDD-02 has already shipped this fix, this spec's scheduler test verifies the post-fix state.

3. **Service composition** (`src/effect/app-runtime.ts`): add `MemoryCapture.defaultLayer` to the runtime layer stack (alongside `Embedding`, `Memory`, `Session`).

4. **Config resolution** (`src/config/bridge.ts`): expose `memory.extraction` (including `external_opt_in`, `self_hosted`, `self_hosted_fallback_model`) via `getConfig()`. `MemoryCapture.capture` reads it on each invocation (no caching — config changes apply on the next turn).

5. **Secrets redaction** (`src/memory/extraction/redact.ts`): the redaction filter runs in `MemoryCapture.capture` BEFORE the LLM call (W-9 → W-21). The filter reads the user's `~/.config/foxybear/auth.json` to build a deny-list of actual keys (never logged, never sent). The redacted payload is what W-14's no-leak test intercepts.

6. **CLI disclosure** (`src/cli/index.ts` entry): at session startup, after config load, if `mode ∈ {"hybrid","llm"}` AND `external_opt_in = true` AND `self_hosted = false`, print the W-26 disclosure message to stderr (so it doesn't pollute stdout for tooling). The message includes the parsed provider name and the data flow doc path.

### Naming

Per CC-9 and the project AGENTS.md style guide:

- Single-word function names: `capture`, `ingest`, `extract`, `link`, `score`, `parse`, `redact`.
- Single-word locals: `turn`, `parts`, `node`, `edge`, `cfg`, `opts`, `out`, `err`, `payload`.
- Multi-word allowed for namespaces (`TraceIngestor`, `EntityExtractor`, `MemoryCapture`) and types (`SessionTurn`, `ExtractedEntity`, `RedactedPayload`) where a single word would be ambiguous.
- `Bun.file()` for fixtures, not `fs.readFileSync`.
- `const` over `let`, early returns over `else`, type inference over explicit annotations, no `any`.
- Tests do NOT mock `TraceIngestor`, `EntityExtractor`, `MemoryCapture`, `Provider`, or the redaction filter. Real provider, real `Bun.file` fixture, real SurrealDB.

## VERIFY

Each test maps 1:1 to a WHAT statement. All tests run from `packages/fbh` (per the `do-not-run-tests-from-root` guard). No mocks of the implementation under test (per CC-5).

| Test | WHAT | Assertion |
|---|---|---|
| `trace.test.ts::action` | W-1 | A turn with one `ToolPart` in `status = "completed"` produces one `ACTION` node with `action_type = part.tool`, `input = state.input`, `output = state.output`, `success = true`, `step` derived from nearest `StepStartPart`. A turn with `status = "error"` produces `success = false` and `output = ""`. |
| `trace.test.ts::error` | W-2 | A turn with `assistantMessage.error` produces one `ERROR` node with `error_type` from the `NamedError` code, `severity = "high"`, `detected_by = "system"`. A turn with a tool error produces `error_type = "tool_error"`, `severity = "medium"`, `detected_by = "agent"`. |
| `trace.test.ts::message` | W-3 | A turn produces one `MESSAGE` node with `content` = concatenated `TextPart.text`, `step` = last `StepFinishPart` step index, `modality = "text"`, `agent_id = assistantMessage.agent`. |
| `trace.test.ts::collaboration` | W-4 | A turn with one `ACTION` and one `MESSAGE` produces one `COLLABORATION` hyperedge linking `MESSAGE` + `ACTION` (NOT `AGENT` — AGENT is reserved per CC-13, no table, no link) with `role_assignments = {agent_id: agent_name}` (agent_id as field, not node ref). `outcome = "success"` when no `ERROR`; `outcome = "error"` when `ERROR` present and no correction; `outcome = "recovered"` when `ERROR_CORRECTION` references the turn. |
| `trace.test.ts::correction` | W-5 | A turn with a tool error followed by a subsequent turn with a different `action_type` and `MESSAGE.content` referencing the error produces one `ERROR_CORRECTION` hyperedge. The `ERROR` node's `corrected` field is updated to `true` via a bi-temporal UPDATE (new version, `prev_version_id` set, prior version `tx_to` closed). |
| `trace.test.ts::evidence` | W-6 | A `MEMORY` node created by `Consolidation.extractTurn` or `MemoryExtractor.extract` for this turn's content produces one `EVIDENCE` hyperedge linking `MEMORY` + `MESSAGE` + supporting `ACTION` with `query_or_task_id = session.id`. |
| `hook.test.ts::fires_once` | W-7 | A real LLM session (small model, 1 turn) triggers `MemoryCapture.capture` exactly once after the step loop exits (not once per step). A multi-step turn (tool calls) also triggers capture exactly once. A turn whose final step result is `"stop"` (final answer) is captured. A turn whose final step result is `"compact"` is NOT captured (simulated via a test fixture where the step loop exits on a `"compact"` result, e.g. by injecting a `handle.process` test double that returns `"compact"` on its last call and forcing the loop to break). Verified via a bus event or a `Capture.occurred` counter incremented in the test layer. |
| `hook.test.ts::does_not_block` | W-8 | The LLM response returns to the user within `50ms` of `handle.process` completing, even when `MemoryCapture.capture` takes `2s` (simulated via a slow fixture). Verified by timing the user-visible response, not the capture. |
| `extract.test.ts::llm_mode` | W-9 | With `mode = "llm"`, `external_opt_in = true`, and secrets redaction passing (W-21), `EntityExtractor.extract`, `HyperedgeExtractor.extract`, and `MemoryExtractor.extract` are all invoked for a turn. Real provider, low `MAX_PER_SOURCE` cap. Asserts ≥ 1 entity extracted from a turn containing `"FoxyBear"` (CamelCase). |
| `extract.test.ts::regex_mode` | W-10 | With `mode = "regex"`, no LLM call is made (assert via a provider call counter). `Consolidation.extractTurn` is invoked. |
| `extract.test.ts::hybrid_below` | W-10 | With `mode = "hybrid"` and a turn scoring `0.0` (no error, no decision fact, short tool output), the regex path runs and no LLM call is made. |
| `extract.test.ts::opt_in_default_off` | W-22 | With `external_opt_in = false` (default) and `mode = "hybrid"` and a turn scoring `1.0`, no LLM call is made (regex path only). With `external_opt_in = true` (mutated), the same turn triggers an LLM call. |
| `extract.test.ts::scoring` | W-11 | A turn containing an `ERROR` scores `1.0`. A turn matching a `DECISION` regex scores `1.0`. A turn with a tool output > 200 chars scores `0.5`. A turn with only short text scores `0.0`. |
| `extract.test.ts::fallback` | W-12 | With `memory.extraction.model` set to an invalid model ID, the primary LLM call fails and the fallback model is invoked. With both `model` and `fallback_model` invalid, the regex path runs and no exception escapes `capture`. |
| `extract.test.ts::batch` | W-13 | With `batch_size = 5` and `async = true`, five turns produce a single LLM call (assert via provider call counter). The batch result writes five `ENTITY` records, each tagged with its source `MESSAGE` node ID. |
| `extract.test.ts::no_leak` | W-14 | The extraction LLM request payload (captured via a test-side provider wrapper that records the request body) contains no `Float32Array`, no `embedding` field, no `auth.json` contents. The `info`-level log line contains `turn_count`, `duration_ms`, `model`, `success` but no session content. |
| `extract.test.ts::provider_path` | W-15 | The extraction LLM call is dispatched via `Provider.Service` (not a raw `fetch`). Verified by a test that injects a provider layer stub that fails and asserts the failure propagates through the `Provider` service, not through a custom HTTP path. |
| `dependency.test.ts::chain` | W-16 | A turn whose `ACTION.input` contains the first 200 chars of the prior turn's `ACTION.output` produces one `NARY_FACT` hyperedge linking the two `ACTION` nodes with `description = "action <step N> relied on action <step M> output"`. |
| `dependency.test.ts::procedure` | W-17 | Three `ACTION` nodes with the same `action_type`, all `success = true`, linked by W-16 edges produce one `PROCEDURE` node + one `PROCEDURE` hyperedge. The `PROCEDURE.success_rate = 1.0`, `confidence = 0.7` (per W-25, tool-output provenance), `source_path = "tool"`. |
| `scheduler.test.ts::real_ids` | W-18 | After a session completes, the next scheduler `memory-consolidation` tick passes a non-empty `recentSessionIds` array containing the completed session's ID. Verified by capturing the `Consolidation.run` call args via a test double on `Consolidation` (not a mock of the scheduler under test — only the downstream `Consolidation.run` is stubbed). |
| `spike.test.ts::qwen_latency_cost` | W-19 | Loads `test/fixture/spike-extraction/50-turn-trace.json` via `Bun.file`, loads `ground-truth-entities.json` (manually-labeled entity set), runs `extract` (spike function) on each turn against the real Qwen2.5-7B-Instruct provider, asserts median per-turn latency `< 2000ms` AND median per-turn cost `< $0.001`. Reports entity hallucination rate separately (count of extracted entities not in ground-truth / total extracted) as informational metric in test output. On failure, logs actual medians + hallucination rate and the test fails (gating the spec's `implement` stage per CC-3). The spike `extract` function lives in `tmp/spike-extraction/` and is not shipped. |
| `config.test.ts::mode` | W-20 | With `mode = "hybrid"`, `external_opt_in = true`, a turn scoring `1.0` triggers an LLM call. With `mode = "regex"` (mutated at runtime), the same turn does not trigger an LLM call. |
| `config.test.ts::threshold` | W-20 | With `mode = "hybrid"`, `external_opt_in = true`, and `threshold = 0.7`, a turn scoring `0.5` runs the regex path. With `threshold = 0.0` (mutated), the same turn runs the LLM path. |
| `config.test.ts::batch_size` | W-20 | With `batch_size = 5`, five turns produce one LLM call. With `batch_size = 1` (mutated), five turns produce five LLM calls. |
| `config.test.ts::async` | W-20 | With `async = true`, the LLM response returns before capture completes. With `async = false` (mutated), the LLM response returns after capture completes (verified by ordering of the user-visible response and a capture-completed bus event). |
| `config.test.ts::external_opt_in` | W-20 | With `external_opt_in = false` (default), no LLM call is made regardless of `mode = "hybrid"` or `threshold = 0.0`. With `external_opt_in = true` (mutated), LLM calls proceed subject to W-21. |
| `config.test.ts::self_hosted` | W-20 | With `self_hosted = false`, `external_opt_in = true`, LLM calls go to `model` (DeepInfra). With `self_hosted = true`, `external_opt_in = false` (mutated), LLM calls go to `self_hosted_fallback_model` (`ollama://qwen2.5:7b-instruct`); no call to the external provider. |
| `governance.test.ts::secrets_redaction` | W-21 | A seeded fixture with 5 representative secrets (AWS key `AKIA...`, OpenAI key `sk-...`, GitHub token `ghp_...`, JWT `eyJ...`, `auth.json` content) is loaded. The redaction filter runs on a payload containing all 5. The redacted payload sent to the LLM (captured via test-side provider wrapper) contains zero of the 5 secrets (substring match). On any leak, the test fails AND the LLM path is gated off (assert via a flag check). |
| `governance.test.ts::opt_in` | W-22 | With `external_opt_in = false` and `mode = "hybrid"` and a turn scoring `1.0`, the LLM call counter is 0 and the regex path runs. With `external_opt_in = true` (mutated) and the same turn, the LLM call counter is ≥ 1. Default value in `~/.config/foxybear/fbh.json` (or unset) is `false`. |
| `governance.test.ts::data_classes_doc` | W-23 | `docs/specs/data-flow-extraction.md` exists (verified via `Bun.file`). The doc contains four required sections: (a) "Data classes that leave the harness", (b) "Data classes that do NOT leave", (c) "Provider retention policy", (d) "Logging policy". The doc contains a data flow diagram (textual or ASCII) showing session content → redaction filter → LLM payload → provider → response → hypergraph store. |
| `governance.test.ts::self_hosted_fallback` | W-24 | With `external_opt_in = false` and `self_hosted = true`, the LLM extraction runs against `self_hosted_fallback_model` (`ollama://qwen2.5:7b-instruct`) via `Provider.parseModel`. Asserts the parsed `providerID = "ollama"` and no call to `createDeepInfra` is made (provider call counter for DeepInfra = 0). |
| `confidence.test.ts::provenance_policy` | W-25 | A `PROCEDURE` node from an action chain (W-17) has `confidence = 0.7` and `source_path = "tool"`. A `MEMORY` from `Consolidation.extractTurn` (regex) has `confidence = 0.7` and `source_path = "tool"`. An `ENTITY` from `EntityExtractor.extract` (LLM) has `confidence = 0.5` and `source_path = "llm"`. A `MEMORY` from `MemoryExtractor.extract` (LLM) has `confidence = 0.5` and `source_path = "llm"`. |
| `disclosure.test.ts::startup_message` | W-26 | With `mode = "hybrid"` and `external_opt_in = true` and `self_hosted = false`, the CLI startup output (captured via stderr redirect) contains `"Memory extraction enabled"` AND the provider name (e.g., `"DeepInfra"`) AND a reference to `docs/specs/data-flow-extraction.md`. With `mode = "regex"` (mutated), the message is absent. With `external_opt_in = false` (mutated), the message is absent. With `self_hosted = true` (mutated), the message is absent (no external processing). |
| `abort.test.ts::a4_precision` | W-27 | A labeled eval fixture (≥ 50 turns, manually-labeled ground-truth) is loaded. The first iteration of M-2 extraction produces precision < 60% (simulated via a fixture where the LLM extracts entities with known precision). The system asserts `memory.extraction.mode` is forced to `"regex"` in config AND a decision-log entry is written to `docs/decisions/` with raw results (precision, recall, hallucination rate, leakage count = 0). |
| `abort.test.ts::a4_recall` | W-27 | Same fixture, first iteration produces recall < 40%. Same fallback behavior + decision log. |
| `abort.test.ts::a4_secrets_leakage` | W-27 | The W-21 secrets redaction filter is bypassed (simulated via a fixture with a secret that evades the filter). The system detects leakage (assert via W-21's failure flag), forces `mode = "regex"`, and writes the decision log entry with `leakage_count = 1`. |

### Typecheck and green suite (per CC-4)

After implementation, `bun run typecheck` SHALL be green and `bun test --timeout 30000` SHALL be green from `packages/fbh`. Known-baseline failures are tolerated via the workstream's `baselineFile`.

## Seams

1. **`Consolidation.run` line drift.** The master spec (SDD-00) cites `consolidation.ts:362` for `Consolidation.run`. The actual line is `533`. Line `362` is `Consolidation.consolidate` (a different function, called by `run`). This spec cites the correct line `533`. The master spec's line citation is stale; SDD-00 should be updated to `consolidation.ts:533`.

2. **Post-turn hook anchor.** The task brief said "Wire TraceIngestor into post-turn hook (src/session/index.ts, alongside Consolidation.extractTurn)." `src/session/index.ts` is the `Session` namespace (storage operations); it has no turn loop. The actual post-turn hook anchor is `src/session/prompt.ts:1525-1541`: the `if (result === "stop") return "break"` branch at :1525 is inside the `while (true)` step loop (loop starts at :1316); the loop exits at :1537 (`if (outcome === "break") break`); the post-turn hook is wired at :1541 (after the loop, alongside `compaction.prune`), so it fires once per turn (not once per step). Wiring inside the loop at :1538 would miss `"stop"` turns (the loop breaks at :1537 before reaching :1538) and would fire per-step for `"continue"`/`"compact"` turns, violating "exactly once per turn." The per-step sub-anchor (for dependency chain detection) is `src/session/processor.ts:357` (the `finish-step` event handler). This spec wires the hook at `prompt.ts:1541`.

3. **Tool call structure source.** The task brief said "ActionNode input/output comes from tool calls" and cited `src/harness/tools.ts`. `harness/tools.ts:41` is the tool registry (`harnessToolEffects` array), not the tool call structure. The actual tool call structure lives in `MessageV2.ToolPart` (`src/session/message-v2.ts:344`) and its state variants `ToolStateCompleted` (line 303) / `ToolStateError` (line 322). This spec reads from `MessageV2.ToolPart` via `Session.messages`.

4. **`Harness.run` not wired by this spec.** The master spec (SDD-00 §Architecture) says "Harness.run is NOT wired wholesale" and the M-4 packing spec extracts the AutoRecall path into `@foxybear/ContextPacker`. M-2 does not wire `Harness.run`; it only wires `MemoryCapture.capture` into the post-turn hook. `Harness.run`'s AutoRecall path remains dormant until SDD-07.

5. **Scheduler stub coordination with SDD-02.** The `recentSessionIds: []` stub at `scheduler.ts:380` is also claimed by SDD-02 (M-0 wire-up, CC-8). IF SDD-02 ships first and replaces the stub, this spec's W-18 is satisfied by SDD-02 and the scheduler test verifies the post-fix state. IF SDD-05 ships first, this spec makes the fix. The workstream dependency order (SDD-01 → SDD-02 → SDD-03 → SDD-04 → SDD-05) makes SDD-02 first the expected path; this spec's W-18 is defensive.

6. **`extractFacts` pattern list is internal to `consolidation.ts`.** W-11 scoring reuses the `DECISION`/`CONSTRAINT`/`PREFERENCE`/`CORRECTION` regex patterns from `extractFacts` (consolidation.ts:67). `extractFacts` is not exported. This spec either (a) exports `extractFacts` (one-line change, no logic change) or (b) duplicates the pattern list in `src/memory/capture/score.ts`. Option (a) is preferred — it's a wire-up, not a rewrite (per CC-2).

7. **AGENT node reference removed per CC-13.** The prior version of this spec (sdd-03) cited AGENT as actively populated in M-2 "as a side-effect of `CollaborationHyperedge.role_assignments` population." The master spec (revised per council) now classifies AGENT as RESERVED (enum-only, no table per CC-13). W-4 was updated to link `COLLABORATION` hyperedges to `MESSAGE` + `ACTION` only; `agent_id` is carried as a field on `role_assignments`, not as a node reference. The Out-of-scope section was updated to list all 7 reserved node types (Task, Agent, Insight, Modality, Community, Archetype, MetaProcedure) as enum-only.

8. **Dependency re-sequenced per council.** The prior version (sdd-03) depended on SDD-02 (M-1 schema). Per the council re-sequencing, the pre-registered probe (SDD-04) gates M-2: the relational stratum MUST PASS (SC-12) before M-2 starts. SDD-05 now depends on SDD-04 (transitive: SDD-03 M-1 schema, SDD-02 M-0 wire-up, SDD-01 P-0 audit). IF the probe fails the relational stratum, terminal fallback A3 fires and M-2 is re-scoped to baseline retrieval (no hypergraph traversal); the extraction pipeline still runs, but the consumed `@foxybear/Hypergraph` service is the baseline-retrieval variant.

9. **Data governance is net-new per council (CC-12, B4).** The prior version had no data governance WHEN/SHALL. The council found that M-2 sends code to DeepInfra — a confidentiality exposure no spec addressed. W-21 through W-24, W-26, and the data flow documentation (W-23) are net-new. The secrets-redaction filter (W-21) runs BEFORE the LLM call; the opt-in (W-22) defaults to FALSE; the self-hosted fallback (W-24) is pre-named; the CLI disclosure (W-26) shows when extraction is enabled.

10. **Initial-confidence policy is net-new per council ("Part X" gap).** The prior version set `confidence = 0.5 (initial)` for `PROCEDURE` (W-17) without a policy. W-25 establishes the policy: tool-output provenance → 0.7, LLM-inferred → 0.5. W-17 was updated to reference W-25 (PROCEDURE → 0.7, `source_path = "tool"`).

11. **Entity hallucination rate is net-new per council ("Part X" gap).** The prior version's spike (W-19) measured only latency and cost. The council found that entity hallucination rate (precision on existing entities vs. hallucination of new entities are different failure modes) should be measured separately. W-19 was extended to measure hallucination rate as an informational metric; the spike pass criterion remains latency + cost (per SC-7), and the hallucination rate feeds into abort A4's recall threshold (W-27).
