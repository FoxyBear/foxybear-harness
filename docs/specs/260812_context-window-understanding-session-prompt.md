# Context Window Understanding — Next Session Prompt

**Date:** 2026-08-12
**Branch:** `dev` (merged from `feat/voice-tts-v2`)
**Project:** FoxyBear CLI (`development/opencode`)

## Context

The voice TTS v3 work is complete and merged into `dev`. All 13 review findings (5 blocking, 6 non-blocking, 2 production bugs) are resolved. 254 voice tests pass, typecheck clean.

The next work item is **context window understanding** — giving the system (and the agent) awareness of context window utilization so it can manage token budget proactively instead of reactively.

## What Exists Today

### Current Compaction Flow (reactive)

The system only reacts to context overflow **after** it happens:

1. **`session/overflow.ts`** — `isOverflow()` checks if `tokens.total >= usable` where `usable = model.limit.input - reserved` (or `context - maxOutputTokens`). Called after each assistant message completes.

2. **`session/processor.ts:397-402`** — After `text-end`, checks `isOverflow()`. If true, sets `ctx.needsCompaction = true`, which triggers `Stream.takeUntil(() => ctx.needsCompaction)` to stop the stream.

3. **`session/prompt.ts:1385-1391`** — After each loop iteration, checks `compaction.isOverflow({ tokens: lastFinished.tokens, model })`. If true, triggers `compaction.create({ auto: true })`.

4. **`provider/error.ts:9-29`** — `OVERFLOW_PATTERNS` regex array matches provider error messages (Anthropic, OpenAI, Google, Groq, vLLM, etc.). Used to detect overflow errors and trigger compaction.

5. **`session/compaction.ts`** — Full compaction system:
   - `create()` — generates a summary of the conversation, inserts it as a "compaction" part
   - `microcompact()` — tier-1 compaction: clears old tool outputs (preserves last N), frees tokens without full summarization
   - `prune()` — removes compacted parts from DB
   - Circuit breaker: disables auto-compaction after 3 consecutive failures
   - `isOverflow()` — delegates to `overflow.ts`

6. **`session/message-v2.ts:62-63`** — `ContextOverflowError` named error type.

7. **Token tracking** — `session/index.ts:249-300` tracks `tokens.input`, `tokens.output`, `tokens.cache.read`, `tokens.cache.write`, `tokens.reasoning`, `tokens.total` per assistant message. Cost is calculated from these.

### What's Missing (the gaps)

- **No proactive context budget awareness.** The agent doesn't know how much context window it has left. It can't prioritize, trim, or change behavior as the window fills.
- **No pre-flight token estimation.** Overflow is only detected after a provider error or after the response completes. There's no "you're at 80% — consider compacting" signal.
- **No token count visible to the agent.** The agent can't see its own token usage or context utilization. It has no way to self-regulate.
- **No context window budget passed to the agent prompt.** The agent doesn't know the model's context limit or how much is left.
- **Compaction is binary.** It either triggers (100% full) or doesn't. No graduated response (warn at 70%, microcompact at 85%, full compact at 95%).
- **No tool-result size awareness.** Large tool outputs (file reads, search results) eat context silently. No truncation or summarization before they enter the context.

## Workflow

Same workflow as voice TTS v3 — Todd reviews findings, decides priority, writes or approves specs. Agents write tests (RED), then code (GREEN). Todd verifies in production.

1. **Todd reviews this prompt, decides scope and priority**
2. **Todd and assistant create specs for each work item**
3. **Agent writes tests from the spec's VERIFY section (RED state)**
4. **Todd reviews tests**
5. **Agent writes code to make tests pass (GREEN state)**
6. **Todd runs the app and verifies in production**
7. **Repeat for next item**

Rules:
- Do NOT code without tests first (RED → GREEN)
- Do NOT modify test files when implementing code
- Do NOT commit unless Todd explicitly asks
- Run `bun run typecheck` and `bun test --timeout 30000` after every change
- When spawning agents: give them complete context (file paths, the specific issue, test expectations)

## Key Files

### Token Tracking & Overflow
- `packages/opencode/src/session/overflow.ts` — `isOverflow()` check (22 lines, the whole file)
- `packages/opencode/src/session/index.ts:249-300` — token tracking per assistant message
- `packages/opencode/src/session/processor.ts:364-402` — token/overflow handling in stream processor
- `packages/opencode/src/session/prompt.ts:1385-1391` — post-loop overflow check
- `packages/opencode/src/provider/error.ts:9-29` — provider overflow error patterns

### Compaction
- `packages/opencode/src/session/compaction.ts` — full compaction system (709 lines)
- `packages/opencode/src/session/message-v2.ts:62-63,211,680,937` — compaction part type, `ContextOverflowError`
- `packages/opencode/src/session/session.sql.ts:37` — `time_compacting` column

### Model Limits
- `packages/opencode/src/provider/provider.ts:1055-1057,1257-1259` — model limit fields (`context`, `input`, `output`)
- `packages/opencode/src/provider/transform.ts:963-964` — `maxOutputTokens()` helper
- `packages/opencode/src/acp/agent.ts:77` — `model.limit.context` usage

### Session/LLM
- `packages/opencode/src/session/llm.ts:172` — `maxOutputTokens` passed to LLM stream
- `packages/opencode/src/session/instruction.ts:41` — skips compacted parts when building instructions
- `packages/opencode/src/session/prompt.ts` — main prompt loop (1889 lines)

### Config
- `packages/opencode/src/config/config.ts` — compaction config (`auto`, `reserved`, `tier1_threshold`, `max_failures`, `prune`)

## Suggested Areas to Explore

These are starting points for discussion, not a fixed scope. Todd decides what's in and what's out.

### A. Token Budget Awareness for the Agent
Pass context window utilization to the agent's system prompt so it can self-regulate:
- Current token count (input, output, cache, total)
- Model context limit
- Percentage used
- Remaining tokens
- A directive: "You are at X% of your context window. Prioritize conciseness / consider summarizing tool results before returning them."

### B. Pre-Flight Token Estimation
Estimate token count before sending to the provider:
- Count tokens in the assembled message array before the LLM call
- Compare against model context limit
- Trigger compaction/microcompaction proactively at thresholds (e.g., 80%, 85%)
- Avoid the round-trip error → retry → compact cycle

### C. Graduated Compaction Triggers
Replace the binary overflow check with tiered thresholds:
- **70%**: Inject a reminder into the agent's context ("You are approaching your context limit")
- **80%**: Trigger microcompact (clear old tool outputs)
- **90%**: Trigger full compaction (summarize conversation)
- **95%**: Hard stop — refuse to send, force compaction

### D. Tool Result Truncation
Large tool outputs eat context silently. Options:
- Truncate tool results above a size threshold (e.g., 10K tokens)
- Summarize tool results via a lightweight model before inserting into context
- Allow the agent to specify "I only need the first/last N lines" when calling tools

### E. Context Window Visibility in TUI
Show context utilization in the TUI:
- Token count / percentage used in the status bar
- Warning indicator when approaching the limit
- Visual indicator when compaction is triggered

## Environment

- Working directory: `/Users/toddenglish/Development/FoxyBearOffice/development/opencode`
- Package directory: `packages/opencode`
- Typecheck: `bun run typecheck` (from `packages/opencode`)
- Tests: `bun test --timeout 30000` (from `packages/opencode`)
- Full voice tests: `bun test test/voice/ --timeout 30000` (from `packages/opencode`)
- Default branch: `dev`
