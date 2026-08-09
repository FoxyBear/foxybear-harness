# SDD-01: Council Deliberate Tool

**Date:** 2026-07-22
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending independent audit + human gate)
**Model tier:** authored at Opus tier

This spec captures the intended behavior of the `council_deliberate` harness tool: a multi-model LLM deliberation engine that sends a prompt through structured debate (proposals, critiques, arbitration, optional revision rounds) across multiple providers and returns a synthesized answer.

## Architecture

### Components

```
tool.ts          config.ts         transport.ts       prompts.ts        ruling.ts        deliberation.ts
 CouncilTool      loadSettings()    callModel()        assignRoles()     parseRuling()    runCouncil()
 (Tool.define)    resolveModel()    getApiKey()        build*Prompt()    extractJSON()    (orchestrator)
                  ALL_MODELS[]      retryFetch()       ROLE_LABELS
```

The tool is registered in the harness tool registry (`harness/tools.ts`) and invoked by the AI SDK's tool execution path. It bridges to the deliberation engine via a `SubAgentRunner` interface that maps council model calls to the transport layer's `callModel()`.

### Data flow

1. LLM invokes `council_deliberate` with `{ prompt, verbose? }`
2. `tool.ts` loads settings, resolves models, pre-fetches API keys, builds a runner
3. `deliberation.ts` orchestrates phases: (research), proposals, critiques, arbitration, (revision loop), synthesis
4. Each phase calls `runner.run(model, systemPrompt, userPrompt)` which delegates to `transport.ts`
5. `transport.ts` makes direct HTTP calls to provider APIs (OpenAI, Anthropic, DeepInfra)
6. Results flow back through the deliberation engine to a `DeliberationResult`
7. `tool.ts` formats output (verbose or concise) and returns to the harness

## WHAT

Behavioral requirements. `WHEN`/`SHALL` are literal tokens. Negative requirements use `SHALL NOT`.

### Configuration (C)

C-1. WHEN the tool loads settings, it SHALL read from `~/.config/opencode/council.json` if the file exists and is valid JSON; WHEN the file does not exist or fails to parse, it SHALL fall back to defaults: models `["gpt-5.4", "claude-sonnet-4-6", "deepseek-ai/DeepSeek-V4-Pro", "moonshotai/Kimi-K2.6"]`, arbitrator `"gpt-5.4"`, maxRounds `3`, threshold `4`, enableResearch `false`.

C-2. WHEN resolving a model ID to a `ModelInfo`, the system SHALL look up the ID in the static `ALL_MODELS` catalog; WHEN no match is found, it SHALL fall back to `{ id, name: id, provider: "openai" }` rather than throwing.

C-3. WHEN the tool executes, it SHALL use at most 4 panel models (the first 4 from settings) plus one arbitrator model; the arbitrator MAY be the same model ID as a panel member.

### API Key Resolution (K)

K-1. WHEN resolving an API key for a provider, the system SHALL check sources in this precedence order: (1) environment variable (e.g. `OPENAI_API_KEY`), (2) key file at `~/Development/<filename>` (e.g. `.openai_api.key`), (3) auth store at `~/.opencode/data/auth.json` under `auth[provider].key` where `type === "api"`; it SHALL use the first non-empty value found.

K-2. WHEN no API key is found for a required provider, the system SHALL throw an error naming the provider and listing the expected environment variable and key file path.

K-3. WHEN the tool executes, it SHALL pre-cache all required API keys (for all panel models and the arbitrator) before starting deliberation, so that a missing key fails fast rather than mid-deliberation.

### Transport (T)

T-1. WHEN calling a model, the system SHALL create a per-request `AbortController` with a 180-second timeout; WHEN the timeout fires, the request SHALL be aborted.

T-2. WHEN a model call fails with a retryable condition (HTTP 429, 500, 502, 503, 504, network error, or timeout), the system SHALL retry up to 3 times with exponential backoff (1s, 2s, 4s); WHEN an `AbortError` occurs, the system SHALL NOT retry and SHALL throw immediately.

T-3. WHEN a non-retryable HTTP error occurs (e.g. 400, 401, 403), the system SHALL throw immediately with the model name, HTTP status, and response body (truncated to 300 chars).

T-4. WHEN calling an Anthropic model, the system SHALL use the Messages API (`/v1/messages`) with `x-api-key` header and `anthropic-version: 2023-06-01`; WHEN calling an OpenAI or DeepInfra model, the system SHALL use the Chat Completions API (`/v1/chat/completions`) with `Authorization: Bearer` header; DeepInfra calls SHALL use `api.deepinfra.com` as the base URL.

T-5. WHEN a model response contains no content (missing `choices[0].message.content` for OpenAI-compatible or `content[0].text` for Anthropic), the system SHALL throw an error naming the model.

### Abort Signal Isolation (A)

A-1. WHEN the tool executes within the harness, it SHALL NOT pass the session's abort signal (`ctx.abort`) to any `callModel()` call; each API call SHALL rely solely on its own 180-second timeout for cancellation.

A-2. WHEN the Effect scope's abort signal fires (which happens when the session scope closes during long-running tool execution), the deliberation SHALL continue to completion unaffected; the abort signal SHALL NOT propagate to in-flight HTTP requests or interrupt between-phase checks.

A-3. WHEN the runner calls `ctx.metadata()` for progress updates, it SHALL swallow any errors (`.catch(() => {})`) so that a closed scope does not interrupt deliberation.

### Role Assignment (R)

R-1. WHEN assigning roles to panel models, the system SHALL assign from the set `{advocate, skeptic, analyst, synthesizer}` with random shuffle; WHEN there are fewer than 4 models, roles SHALL wrap (modulo).

R-2. Each role SHALL carry a fixed behavioral directive: advocate argues FOR, skeptic argues AGAINST, analyst evaluates neutrally, synthesizer bridges opposing views.

### Deliberation Phases (D)

D-1. WHEN `enableResearch` is true, the system SHALL run Phase 0 (Research) before proposals: each panel model receives a research prompt and produces an evidence brief; research briefs SHALL be included in each model's proposal prompt.

D-2. WHEN Phase 1 (Proposals) begins, the system SHALL send all panel models their proposal prompts in parallel (`Promise.all`); each model SHALL receive its role assignment, any research brief, and the original prompt.

D-3. WHEN Phase 2 (Critiques) begins, the system SHALL generate cross-critiques: every panel model critiques every OTHER panel model's proposal (N*(N-1) critiques for N models), all in parallel; each critique prompt SHALL include the target proposal and all other proposals for context.

D-4. WHEN a critique response is received, the system SHALL parse it as JSON with fields `{strengths, weaknesses, suggestions, summary}`; WHEN the response is not valid JSON, the system SHALL fall back to empty arrays for strengths/weaknesses/suggestions and use the first 200 characters as the summary.

D-5. WHEN Phase 3 (Arbitration) begins for round 1, the system SHALL send the arbitrator all proposals, all critiques (capped at 15 for prompt size), the original prompt, the consensus threshold, and the round number.

D-6. WHEN the arbitrator's ruling is received, the system SHALL parse it via `parseRuling()` which extracts JSON (trying raw parse, fenced code block, brace extraction, bracket extraction in order); WHEN parsing fails entirely, the system SHALL produce a fallback ruling with `convergenceScore: 0`, `converged: false`, `action: "conclude"`, `parseError: true`, and the raw text preserved.

D-7. WHEN a ruling's `convergenceScore` meets or exceeds the threshold, `converged` SHALL be set to `true`.

D-8. WHEN a ruling's `action` field is not one of `"continue"`, `"extend"`, or `"conclude"`, the system SHALL default to `"conclude"`.

D-9. WHEN round 1's ruling indicates convergence (`converged === true`) OR the action is `"conclude"`, the system SHALL skip further rounds and proceed directly to synthesis.

D-10. WHEN round 1 does NOT converge, the system SHALL enter revision rounds (2 through `maxRounds`). Each revision round SHALL: (a) send each model a revision prompt containing their previous proposal, the arbitrator's directive for them, synthesized critique, established agreements, disagreement rulings, and the original prompt; (b) collect cross-critiques on revised proposals; (c) send the arbitrator all revised proposals, critiques, previous convergence scores, and round-specific momentum guidance.

D-11. WHEN previous convergence scores are available (round 2+), the arbitrator prompt SHALL include momentum guidance: "improving" if the latest score exceeds the prior, "stalled" if equal and below threshold.

D-12. WHEN any round's ruling indicates convergence or `"conclude"`, the system SHALL break out of the revision loop.

D-13. WHEN the revision loop ends (by convergence, conclude action, or exhausting `maxRounds`), the system SHALL proceed to Phase 4 (Synthesis): the arbitrator produces a final synthesis incorporating all final proposals, critiques, agreements, and disagreement rulings.

### Progress Reporting (P)

P-1. WHEN a deliberation phase transitions, the system SHALL call the progress callback with a phase identifier and human-readable detail string.

P-2. WHEN each model begins responding, the runner SHALL update the tool metadata title to `"Council: <model.name> responding..."`.

### Output Formatting (O)

O-1. WHEN `verbose` is false or omitted, the tool SHALL return only the `finalSynthesis` text; WHEN consensus was not reached, it SHALL append `"\n\n[No consensus after N rounds]"`.

O-2. WHEN `verbose` is true, the tool SHALL return a structured text output containing: header with prompt and consensus status, research briefs (if any, truncated to 500 chars each), round-by-round proposals (truncated to 400 chars), critique counts, and arbitrator ruling details (convergence score, action, agreement/disagreement counts), followed by the full final synthesis.

O-3. The tool result SHALL always include `metadata: { consensus: boolean, rounds: number }`.

### Error Handling (E)

E-1. WHEN any unhandled error occurs during deliberation, the tool SHALL propagate it via `Effect.orDie`, which converts it to a defect in the Effect runtime; this SHALL surface as a tool execution error to the calling LLM.

E-2. WHEN an API key is missing for any required provider, the error SHALL be thrown during key pre-caching (before deliberation starts), not during a model call mid-deliberation.

## Interfaces

### SubAgentRunner

```typescript
interface SubAgentRunner {
  run(model: ModelInfo, systemPrompt: string, userPrompt: string, tools?: string[]): Promise<string>
}
```

The `tools` parameter is used only in the research phase (Phase 0) to grant models access to `["read", "websearch", "memory", "bash"]`. In all other phases, `tools` is omitted.

### DeliberationResult

```typescript
interface DeliberationResult {
  prompt: string
  researchBriefs: Record<string, string>
  rounds: RoundResult[]
  finalSynthesis: string
  consensusReached: boolean
  totalRounds: number
}
```

### Ruling

```typescript
interface Ruling {
  agreements: string[]
  disagreements: Disagreement[]
  directives: Record<string, string>        // keyed by model ID
  synthesizedCritiques: Record<string, string> // keyed by model ID
  revisionChecks: RevisionCheck[]
  convergenceScore: number                   // 1-5
  converged: boolean
  action: "continue" | "extend" | "conclude"
  reasoning: string
  parseError: boolean
  rawRuling?: string                         // preserved on parse failure
}
```

## Non-regression

N-1. WHEN this spec is verified, the standalone council test suite (62 tests) and the harness typecheck SHALL remain green.

N-2. The tool SHALL remain functional when the session's Effect scope fires its abort signal during execution (the fix validated by the simulated-abort test on 2026-07-22, commit `6af9bc389`).
