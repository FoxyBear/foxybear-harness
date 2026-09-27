# SDD-00 Master: FoxyBear Harness Phase N — Memory Classification Layer

**Date:** 2026-09-26
**Project:** FoxyBear Harness Phase N (`development/foxybear`)
**Status:** Draft (pending independent audit + human gate)
**Source research:** `docs/research/260926_fbh-phase-n_salience-classification-spike.md`
**Workstream:** `fbh-phase-n` (`tools/sdd/workstreams/fbh-phase-n.json`)

This is the master spec for Phase N: the memory classification layer that replaces the stub extractor (SDD-05 of Phase M) with a real 4-stage pipeline. It defines the architecture, cross-cutting requirements, shared contract (model interfaces, config, circular buffer), and dependency order.

## Architecture

### Problem being solved

Phase M shipped the memory infrastructure (hippocampus): storage, retrieval, injection, lifecycle, conflict detection. But the classification intelligence (prefrontal cortex) was a stub — `extractViaLLM` in entity.ts/memory.ts returns regex results labeled `source_path: "llm"`. The result: 138k noise ENTITY nodes ("The", file paths), 4 MEMORY nodes from regex patterns, 0 real classifications.

Phase N replaces the stub with a validated 4-stage pipeline:
1. **Gate** — Jev classifies whether the turn would enrich a future query (Noul probability)
2. **Extract** — Gemini 2.5 Flash extracts specific memory fragments from the full context (JSON)
3. **Classify** — Jev classifies each fragment by type (Choice over 7 types)
4. **Store** — Existing Phase M pipeline (embed → SurrealDB → ContextPacker retrieves → injects)

### The 4-stage pipeline

```
User turn completes (post-turn hook, async via run.fork)
  ↓
Circular buffer (last 5 user turns as context arc)
  ↓
Stage 1: GATE — Jev (OpenRouter decisions API, typesafe/jev-1.13)
  Question: Noul "Would this context enrich a future query?"
  ↓ if enriches_future > 0.5
Stage 2: EXTRACT — Gemini 2.5 Flash (OpenRouter chat API, JSON mode)
  Question: "Extract specific memories from this full context (user + assistant + tools)"
  ↓ produces memory fragments [{content, type, source}]
Stage 3: CLASSIFY — Jev (per fragment)
  Question: Choice "What type is this memory?" (preference/correction/decision/constraint/pattern/context/none)
  ↓ if type != "none"
Stage 4: STORE — existing Phase M pipeline
  Embed each fragment (DeepInfra BAAI/bge-base-en-v1.5)
  → SurrealHypergraphBackend.store as MEMORY node
  → ContextPacker retrieves on future queries
  → "## Relevant Memories" injected into prompt
```

### Key decisions (from spike, empirically validated)

- **Jev for gate + classify** (typed decisions, calibrated, $0.042/M, 70-500ms) — can't generate text but can classify
- **Gemini 2.5 Flash for extraction** (JSON, 100% reliability, 1.2s, $0.30/M) — can generate text (Jev can't)
- **No regex gate** — misses 68% of real memories (150-turn three-mode comparison proved this)
- **No Memory Worth** — a stored memory is by definition expected useful; worth is learned via lifecycle decay
- **Circular buffer** (last 5 user turns) — gives Jev the conversation arc to distinguish routine turns from real memories
- **Reframed question** — "would this enrich a future query?" not "contains a durable fact?" — catches working context
- **New `context` memory type** — useful working context that's not a durable fact (hypotheses, intermediate states)

### Cost

~$0.0006/turn (Jev gate + Gemini extraction on ~50% of turns). ~$0.03/day for 50 turns. Negligible.

### The inverse proof (validated)

The full round-trip (store → HNSW KNN retrieve → inject → answer) was validated across 3 real sessions. The memory system's unique value is **across-session recall** — a new session with no shared context gets specific answers from stored memories instead of generic advice. Case 3 (Phoenix pipeline) proved: cold = generic CRM advice, warm = exact 4-step reply process from Session A.

## Scope

In scope (Phase N):

- **SDD-01** Jev provider adapter — wire Jev (OpenRouter decisions API) into the fbh provider abstraction. Noul/Choice/Score typed calls.
- **SDD-02** Gemini provider adapter — wire Gemini 2.5 Flash (OpenRouter chat API, JSON mode) for extraction.
- **SDD-03** Circular buffer — maintain last N user turns as context for the gate. Session-scoped, per-turn update.
- **SDD-04** Gate-extract-classify pipeline — the 4-stage classification: Jev gate → Gemini extract → Jev classify. Replaces the stub `extractViaLLM`.
- **SDD-05** Wire into capture — replace the stub extractor calls in prompt.ts post-turn hook with the real pipeline.
- **SDD-06** Re-backfill — re-run the backfill script with the real classifier against all 1,269 sessions. Clean slate: delete 224k noise nodes, re-ingest with quality.

Out of scope:

- Goal relevance (needs explicit goal-tracking — deferred)
- Memory Worth (redundant with lifecycle decay — deferred)
- Domain mapping (7 types sufficient — deferred)
- Phase 4 distillation (LoRA fine-tune — collect labels first)
- Hypergraph expansion from MEMORY nodes (the ContextPacker already does this — Phase M)

## Cross-Cutting Requirements

- **CC-1 No data loss.** The re-backfill SHALL preserve all deterministic TraceIngestor data (65k ACTION, 2k ERROR, 18k MESSAGE nodes). Only the 139k stub-generated ENTITY/MEMORY/PROCEDURE nodes are deleted and re-classified.
- **CC-2 Stub replacement, not addition.** The stub `extractViaLLM` in entity.ts and memory.ts SHALL be replaced by the real pipeline. No parallel code paths.
- **CC-3 Async, non-blocking.** All classification runs post-turn via `run.fork`. Never blocks the LLM response.
- **CC-4 Config-driven.** `memory.extraction.layer1` (Jev) and `memory.extraction.layer2` (Gemini) config SHALL control model selection, thresholds, and API keys.
- **CC-5 Rate limits.** Jev: 10 req/sec. Gemini: 5 req/sec. OpenRouter enforces both.
- **CC-6 Data governance.** Secrets-redaction filter runs BEFORE any content is sent to Jev or Gemini. `external_opt_in` gates external calls.
- **CC-7 Green suite.** `bun run typecheck` and `bun test` SHALL be green after each spec.
- **CC-8 Cost logging.** Each Jev/Gemini call SHALL log token count + cost. Aggregate daily cost SHALL be visible via `/memory/metrics`.
- **CC-9 Circuit breaker.** If Jev or Gemini latency > 3s for 5 consecutive calls, or error rate > 5%, fall back to regex-only extraction (the old stub behavior). Log the fallback.
- **CC-10 OpenRouter only.** Both Jev and Gemini are accessed via OpenRouter (not direct APIs). Single key, single billing.

## Security

- **API keys unchanged.** OpenRouter key at `~/Development/.openrouter.key`. No new keys needed.
- **Secrets redaction.** The redact filter (from SDD-05) runs before any content is sent to Jev or Gemini.
- **No embeddings to LLM.** Embeddings (Float32Array) are NEVER sent to Jev or Gemini. Only text content.
- **Project isolation.** Stored memories SHALL carry `project_id` (from the session context). Retrieval is scoped (Phase M).
- **No session content at info level.** Jev/Gemini call logs SHALL contain only metadata (token count, latency, model), not content.

## Shared Contract

### SC-1: Model interfaces, file paths, and function names (AUTHORITATIVE — feature specs MUST match)

**File paths (exact):**

| Module | File | Exported as |
|---|---|---|
| Jev provider | `src/provider/jev.ts` | `Jev` (namespace with `noul`, `choice`, `score`) |
| Gemini provider | `src/provider/gemini.ts` | `Gemini` (namespace with `extract`) |
| Circular buffer | `src/memory/capture/buffer.ts` | `Buffer` (namespace with `add`, `getContext`, `get`, `clear`) |
| Classification pipeline | `src/memory/classify/pipeline.ts` | `classify` (async function, the single entry point) |
| Capture hook (existing) | `src/session/prompt.ts` | `capture` (Effect.fnUntraced, edited by sdd-05) |

**Jev provider interface:**

```typescript
// src/provider/jev.ts
export namespace Jev {
  export async function noul(state: string, instructions: string, criteria: { true: string; false: string }): Promise<number>
  export async function choice(state: string, instructions: string, criteria: Record<string, string>): Promise<{ choice: string; probabilities: Record<string, number> }>
  export async function score(state: string, instructions: string, criteria: string[]): Promise<number>
}
```

**Gemini extraction provider interface:**

```typescript
// src/provider/gemini.ts
export interface ExtractedMemory {
  content: string
  type: "preference" | "correction" | "decision" | "constraint" | "pattern" | "context" | "none"
  source: "user" | "assistant"
}

export namespace Gemini {
  export async function extract(systemPrompt: string, userContent: string): Promise<{ memories: ExtractedMemory[]; skipped_reason?: string }>
}
```

**Circular buffer interface:**

```typescript
// src/memory/capture/buffer.ts
export namespace Buffer {
  export function add(sessionID: string, turn: { text: string; role: string }): void
  export function getContext(sessionID: string): string  // formatted prior turns for Jev state
  export function get(sessionID: string): { text: string; role: string }[]  // raw access (for tests)
  export function clear(sessionID: string): void
  export function size(): number  // configurable via config, default 5
}
```

Session-scoped (Map<sessionID, Turn[]>). Cleared on session end. Only user turns buffered.

**Classification pipeline interface (the single entry point — sdd-04 owns it, sdd-05 calls it):**

```typescript
// src/memory/classify/pipeline.ts
export interface ClassifyInput {
  sessionID: string
  text: string  // current user turn text
  project_id: string
  persona: string
}

export interface ClassifyResult {
  stored: number  // count of memories stored
  skipped: number  // count of fragments skipped (type "none" or gate failed)
  errors: number  // count of errors
}

export async function classify(input: ClassifyInput): Promise<ClassifyResult>
```

The pipeline (`classify`) is the ONLY entry point. sdd-05 (capture hook) calls `classify(input)`. sdd-05 does NOT call Jev, Gemini, or Buffer directly — only `classify`. The pipeline internally:
1. Gets buffer context via `Buffer.getContext(input.sessionID)`
2. Gates via `Jev.noul`
3. Extracts via `Gemini.extract` (if gate passes)
4. Classifies each fragment via `Jev.choice`
5. Stores each fragment via `SurrealHypergraphBackend.store` (if type != "none")
6. Updates the buffer via `Buffer.add(input.sessionID, { text: input.text, role: "user" })`

**Store ownership: the pipeline owns the store.** The capture hook (sdd-05) does NOT call `SurrealHypergraphBackend.store` for extracted memories — only the pipeline does. sdd-05 calls `classify(input)` and the pipeline handles everything: gate, extract, classify, store, buffer update.

**Stubs replaced (CC-2 — exact list):**

| Stub | File | Function | Replacement |
|---|---|---|---|
| EntityExtractor.extractViaLLM | `src/memory/extraction/entity.ts:82` | returns regex labeled "llm" | `classify` pipeline (sdd-04) |
| MemoryExtractor.extractViaLLM | `src/memory/extraction/memory.ts:63` | returns regex labeled "llm" | `classify` pipeline (sdd-04) |
| HyperedgeExtractor.extractViaLLM | `src/memory/extraction/hyperedge.ts:60` | returns regex labeled "llm" | `classify` pipeline (sdd-04) |

All three stubs are replaced. The regex extractors (`extractRegex`) remain as the circuit-breaker fallback (CC-9).

### SC-2: Config shape (additive to existing `memory.extraction`)

**AUTHORITATIVE defaults (all feature specs MUST use these):**

| Field | Default | Owner | Notes |
|---|---|---|---|
| `external_opt_in` | `true` | master | Phase N enables external extraction by default (the user opts in via `memory.enabled: true`). All feature specs MUST use `true` as the default. The Phase M default of `false` is superseded. |
| `gate_threshold` | `0.5` | master | Jev Noul threshold for the gate |
| `mode` | `"hybrid"` | master | Unchanged from Phase M |
| `model` | `"deepinfra/Qwen/Qwen2.5-7B-Instruct"` | existing | Phase M field — RETAINED as the regex-fallback model (circuit breaker). Not used for LLM extraction in Phase N. |
| `layer1.model` | `"typesafe/jev-1.13"` | master | Jev gate + classify |
| `layer2.model` | `"google/gemini-2.5-flash"` | master | Gemini extraction |
| `circuit_breaker.fallback` | `"regex"` | master | Fall back to existing `extractRegex` functions |

The existing `model` and `threshold` fields from Phase M are RETAINED (not removed) for backward compat + circuit-breaker fallback. The new `layer1`/`layer2`/`gate_threshold`/`circuit_breaker` fields are ADDITIVE.

```json
"memory": {
  "extraction": {
    "mode": "hybrid",
    "model": "deepinfra/Qwen/Qwen2.5-7B-Instruct",
    "threshold": 0.7,
    "external_opt_in": true,
    "layer1": {
      "provider": "openrouter",
      "model": "typesafe/jev-1.13",
      "api_key": "{file:~/Development/.openrouter.key}"
    },
    "layer2": {
      "provider": "openrouter",
      "model": "google/gemini-2.5-flash",
      "api_key": "{file:~/Development/.openrouter.key}"
    },
    "gate_threshold": 0.5,
    "circuit_breaker": {
      "max_latency_ms": 3000,
      "max_consecutive_failures": 5,
      "max_error_rate_pct": 5,
      "fallback": "regex"
    }
  }
}
```

### SC-3: Circular buffer (interface in SC-1)

The circular buffer interface is defined in SC-1 above (`Buffer` namespace at `src/memory/capture/buffer.ts`). Session-scoped (one buffer per session). Cleared on session end. Only user turns are buffered.

### SC-4: The 7 memory types

| Type | Description |
|---|---|
| `preference` | User expresses a preference or liking |
| `correction` | User corrects a previous statement, approach, or belief |
| `decision` | User makes a decision or choice that persists |
| `constraint` | User states a constraint, limitation, or boundary |
| `pattern` | User describes a recurring behavior or workflow |
| `context` | Useful working context — intermediate state, hypothesis, what was tried |
| `none` | No useful context for future queries (skip — don't store) |

### SC-5: OpenRouter API patterns

**Jev (decisions API):**
```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer <key>
{
  "model": "typesafe/jev-1.13",
  "state": "<buffer context + current turn>",
  "questions": {
    "enriches_future": { "type": "noul", "instructions": "...", "criteria": {...} },
    "memory_type": { "type": "choice", "instructions": "...", "criteria": {...} }
  }
}
```

**Gemini (chat API, JSON mode):**
```
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer <key>
{
  "model": "google/gemini-2.5-flash",
  "messages": [...],
  "response_format": { "type": "json_object" },
  "temperature": 0
}
```

## Glossary

- **Gate** — Stage 1: Jev Noul decides whether the turn would enrich a future query. Binary: classify or skip.
- **Extract** — Stage 2: Gemini extracts specific memory fragments from the full context. Produces JSON with content + type + source per fragment.
- **Classify** — Stage 3: Jev Choice classifies each extracted fragment by type (7 types).
- **Circular buffer** — Last N user turns (default 5) maintained as context for the gate. Gives Jev the conversation arc.
- **Stub extractor** — The Phase M code that returns regex results labeled `source_path: "llm"`. Phase N replaces this.
- **Across-session recall** — The memory system's unique value: a new session with no shared context gets specific answers from stored memories.
- **Circuit breaker** — If Jev/Gemini fail repeatedly, fall back to regex-only (the old stub behavior).

## Dependency (authoring order — parallel vs sequential)

**LESSON from Phase M + Phase N audits:** Specs that share an interface MUST be authored sequentially after the master's shared contract is finalized. Parallel authoring produces locally-correct specs with broken seams (different function names, file paths, config defaults). The master's SC-1 through SC-5 are AUTHORITATIVE — feature specs MUST match exactly.

**Authoring order:**

```
Phase 1 (sequential): sdd-00 master (shared contract first — SC-1/SC-2/SC-3/SC-4/SC-5)
Phase 2 (parallel):   sdd-01 (Jev provider)     ← no deps, uses SC-1
                      sdd-02 (Gemini provider)   ← no deps, uses SC-1
                      sdd-03 (Circular buffer)  ← no deps, uses SC-1
Phase 3 (sequential): sdd-04 (pipeline)         ← depends on sdd-01, sdd-02, sdd-03 interfaces (SC-1)
Phase 4 (sequential): sdd-05 (wire capture)     ← depends on sdd-04's classify() interface (SC-1)
Phase 5 (sequential): sdd-06 (re-backfill)      ← depends on sdd-05
```

**Implementation order (SDD pipeline enforces):**

```
sdd-01 (Jev provider)     ← no deps
sdd-02 (Gemini provider)   ← no deps
sdd-03 (Circular buffer)  ← no deps
  └→ sdd-04 (pipeline)         [depends: sdd-01, sdd-02, sdd-03]
       └→ sdd-05 (wire capture) [depends: sdd-04]
            └→ sdd-06 (re-backfill) [depends: sdd-05]
```

sdd-01, sdd-02, sdd-03 can be implemented in parallel (no shared state). sdd-04 depends on all three. sdd-05 depends on sdd-04. sdd-06 depends on sdd-05.
