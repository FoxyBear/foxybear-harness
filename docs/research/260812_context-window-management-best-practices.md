# Context Window Management — Research & Best Practices

**Date:** 2026-08-12
**Author:** Katya (research agent)
**Status:** Research complete, specs drafted. See:
- `docs/specs/260812_context-graduated-compaction-thresholds.md` (Work Item 1)
- `docs/specs/260812_context-tui-visibility.md` (Work Item 2)

## Purpose

Research current best practices for context window management in LLM agent systems, with specific attention to:
1. How to know the context window for a model (multi-provider, model-switching)
2. How to track context utilization
3. What happens when models switch mid-session
4. Current state-of-the-art patterns

## Current Codebase State (opencode)

### Model Limit Source

- **`provider.ts:963-967`** — `Model.limit` schema: `{ context: number, input?: number, output: number }`
- **models.dev catalog** (`provider/models.ts:111-151`) — fetched from `https://models.dev/api.json`, cached 5-min TTL, refreshed hourly. Build-time snapshot fallback. Config override via `Flag.OPENCODE_MODELS_PATH`.
- **Config overrides** (`provider.ts:1256-1260`) — users define custom models with custom limits in `opencode.jsonc`. Merges over catalog values. If neither specifies, `context` and `output` default to `0`.
- **Provider API discovery** — DeepInfra fetches `https://api.deepinfra.com/models/list` and sets `limit.context = m.max_tokens`. GitLab uses `discoverWorkflowModels()`.
- **`context === 0` disables overflow detection** — `isOverflow()` returns `false` when context limit is unknown.

### Model Switching (Mid-Session)

- **Model stored per-user-message** (`prompt.ts:919-952`) — each user message has `{ providerID, modelID, variant }`.
- **Resolved from `lastUser.model` each loop iteration** (`prompt.ts:1365`) — `getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)`.
- **ACP** (`acp/session.ts:86-96`, `acp/agent.ts:1292-1312`) — maintains in-memory `model` per session, settable via `setModel()`.
- **No cross-model token mismatch** — the context window is per-request, not accumulated state. Each LLM call sends the full assembled prompt (all message history from the DB). The model processes it fresh and reports its own usage from its own tokenizer. By the time `isOverflow()` runs, `lastFinished.tokens` and `model` are from the **same response** — same tokenizer, same limit. The loop resolves the model and processes the response in the same iteration.

### Overflow Detection (Binary, Reactive)

**`session/overflow.ts`** (entire file, 22 lines):

```typescript
const COMPACTION_BUFFER = 20_000

export function isOverflow(input: { cfg, tokens, model }) {
  if (input.cfg.compaction?.auto === false) return false
  const context = input.model.limit.context
  if (context === 0) return false

  const count = input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  const reserved = input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, maxOutputTokens(input.model))
  const usable = input.model.limit.input
    ? input.model.limit.input - reserved
    : context - maxOutputTokens(input.model)
  return count >= usable
}
```

- Checked AFTER each assistant message completes (`prompt.ts:1385-1392`, `processor.ts:397-402`).
- Also checked via provider error pattern matching (`provider/error.ts:9-29`).
- `usable` = `limit.input - reserved` (or `context - maxOutputTokens`). For a 200K context model with 8K output: usable = 192K.

### Token Tracking

- **Per-assistant-message** (`message-v2.ts:437-446`) — `{ total?, input, output, reasoning, cache: { read, write } }`.
- **Computed by `Session.getUsage()`** (`session/index.ts:240-305`) from AI SDK `LanguageModelUsage`. Adjusts for AI SDK v6 normalizing cached tokens into `inputTokens`.
- **No cumulative session total persisted** — session usage computed by finding last assistant message.
- **Compaction** creates a new message with zeroed tokens, marked `summary: true`. Overflow check skips summary messages.

### Compaction System

- **`session/compaction.ts`** (709 lines) — `create()` (full summary), `microcompact()` (tier-1: clear old tool outputs), `prune()`.
- **Circuit breaker** — disables auto-compaction after 3 consecutive failures.
- **Config** (`config.ts:1024-1047`) — `auto`, `prune`, `reserved`, `max_failures`, `tier1_threshold`.

### What's Missing (Gaps)

1. No proactive context budget awareness — agent doesn't know how much window is left.
2. No pre-flight token estimation — overflow only detected after provider error or response completion.
3. No token count visible to the agent — no self-regulation.
4. No context window budget in agent prompt.
5. Compaction is binary — no graduated response.
6. No tool-result size awareness — large outputs eat context silently.

---

## External Best Practices

### 1. Context Awareness (Anthropic Native, Model-Specific)

**Source:** [Anthropic Context Windows docs](https://docs.anthropic.com/en/docs/build-with-claude/context-windows#context-awareness)

Some Claude models natively track their remaining token budget:

- **Models with context awareness:** Sonnet 5, Sonnet 4.6, Sonnet 4.5, Haiku 4.5
- **Models WITHOUT:** Opus 4.7+, Fable 5, Mythos 5 (they use "task budgets" beta instead)

**How it works (automatic, server-side):**
- API injects `<budget:token_budget>200000</budget:token_budget>` into system prompt
- After each tool call: `<system_warning>Token usage: 35000/200000; 165000 remaining</system_warning>`
- Nothing to enable — the API does it automatically
- The budget matches the context window: 1M for Sonnet 5/4.6, 200K for Sonnet 4.5/Haiku 4.5

**Relevance to FoxyBear:** This is Anthropic-only and model-specific. For non-Anthropic providers, we'd need our own injection. For Anthropic models with it, we don't need to duplicate it — but we should be aware it exists and not conflict with it.

### 2. Server-Side Compaction (Anthropic, Beta)

**Source:** [Anthropic Compaction docs](https://docs.anthropic.com/en/docs/build-with-claude/compaction)

**Beta header:** `compact-2026-01-12`
**Supported models:** Claude Fable 5, Mythos 5, Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5, Sonnet 4.6

**How it works:**
- Add `compact_20260112` strategy to `context_management.edits` in the API request
- API detects when input tokens reach trigger threshold
- Generates a summary, creates a `compaction` block
- Continues response with compacted context
- On subsequent requests, API drops all content blocks prior to the `compaction` block

**Parameters:**
- `trigger` — `{ type: "input_tokens", value: N }` (min 50,000, default 150,000)
- `pause_after_compaction` — pause after summary, inject content, then continue
- `instructions` — custom summarization prompt (replaces default completely)

**Total token budget pattern:**
```python
TRIGGER_THRESHOLD = 100_000
TOTAL_TOKEN_BUDGET = 3_000_000
n_compactions = 0
# After each compaction: n_compactions += 1
# If n_compactions * TRIGGER_THRESHOLD >= TOTAL_TOKEN_BUDGET: prompt wrap-up
```

**Relevance:** This is Anthropic-only. Our existing client-side compaction is the universal fallback. We could potentially delegate to server-side for supported Anthropic models, but that's an optimization, not a replacement. Multi-provider support means client-side compaction remains essential.

### 3. Context Editing (Anthropic, Beta)

**Source:** [Anthropic Context Editing docs](https://docs.anthropic.com/en/docs/build-with-claude/context-editing)

**Beta header:** `context-management-2025-06-27`

**Tool Result Clearing** (`clear_tool_uses_20250919`):
- Clears old tool results at configurable threshold
- `keep: { type: "tool_uses", value: N }` — keep last N tool uses
- `clear_at_least: { type: "input_tokens", value: N }` — ensure meaningful cache invalidation
- `exclude_tools: ["web_search"]` — exclude specific tools
- `clear_tool_inputs: true` — also clear tool call parameters (not just results)
- Replaces cleared results with placeholder text

**Thinking Block Clearing** (`clear_thinking_20251015`):
- `keep: { type: "thinking_turns", value: N }` — keep last N turns
- `keep: "all"` — keep all (maximizes cache hits)
- Must be listed first in `edits` array when combined with tool result clearing

**Key detail:** Applied server-side before prompt reaches Claude. Client maintains full unmodified history. No need to sync client state.

**Prompt caching interaction:**
- Tool result clearing invalidates cached prefixes
- Thinking block clearing: keeping blocks preserves cache, clearing invalidates
- `clear_at_least` ensures enough tokens cleared to make cache invalidation worthwhile

**Relevance:** Our existing `microcompact()` does similar tool-result clearing client-side. This is the Anthropic-native version. Again, multi-provider means client-side remains the universal approach.

### 4. Token Counting API (Anthropic)

**Source:** [Anthropic Token Counting docs](https://docs.anthropic.com/en/docs/build-with-claude/token-counting)

- Pre-flight token estimation via `/v1/messages/count-tokens`
- Returns `{ input_tokens: N }`
- **FREE** but rate-limited (2K-8K RPM by tier)
- Supports system, messages, tools, images, PDFs
- **Critical:** Claude 4.7+ uses a newer tokenizer producing ~30% more tokens
- "Count against the model you plan to use rather than reusing counts measured against earlier models"

**Relevance:** Anthropic-specific. Other providers have their own (OpenAI's `tiktoken`, Google's countTokens). For a universal pre-flight estimation, a heuristic (chars/4) is simpler and sufficient for threshold decisions. Exact counts matter for cost, not for "are we above 80%?".

### 5. Effective Context Engineering (Anthropic Blog)

**Source:** [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

**Core principle:** Find the smallest set of high-signal tokens that maximize the likelihood of desired outcome.

**Context rot:** As token count grows, model's ability to accurately recall information decreases. Context is a finite resource with diminishing marginal returns. This is a performance gradient, not a hard cliff.

**Key strategies:**

1. **Just-in-time retrieval** — agents maintain lightweight identifiers (file paths, stored queries, web links) and dynamically load data at runtime using tools. Claude Code uses this: `head`/`tail` to analyze data without loading full objects.

2. **Progressive disclosure** — agents discover context through exploration. File sizes suggest complexity, naming conventions hint at purpose, timestamps proxy for relevance. Maintain only what's necessary in working memory.

3. **Hybrid strategy** — some data up front (CLAUDE.md files), some via autonomous exploration (glob, grep). Claude Code uses this hybrid model.

4. **Compaction** — summarize conversation near limit, reinitiate with summary. Art is in selection: preserve architectural decisions, unresolved bugs, implementation details; discard redundant tool outputs. Claude Code keeps summary + 5 most recently accessed files.

5. **Structured note-taking** — agent writes notes to memory outside context window, pulls them back later. Claude Code's to-do list pattern. Claude Plays Pokémon demonstrates precise tallies across thousands of steps.

6. **Sub-agent architectures** — specialized sub-agents handle focused tasks with clean context. Return condensed summaries (1-2K tokens). Main agent coordinates, sub-agents do deep work.

**Tool design:** Tools should return token-efficient information and encourage efficient agent behaviors. Bloated tool sets with overlapping functionality create ambiguous decision points. Minimal viable set of tools.

**System prompts:** Right altitude — Goldilocks zone between brittle if-else hardcoded logic and vague high-level guidance. Organize into distinct sections with XML tags or Markdown headers. Minimal set of information that fully outlines expected behavior.

---

## Key Challenges for FoxyBear (Multi-Provider, Model-Switching)

### Challenge 1: Context Window Size Varies Wildly

| Model | Context | Output |
|-------|---------|--------|
| Claude Sonnet 5 | 1M | 128K |
| Claude Opus 5 | 1M | 128K |
| GPT-5.6 Sol | 272K | - |
| Gemini 3.1 Pro | 1M | - |
| Grok 4.5 | 256K | - |

When a user switches from Sonnet 5 (1M) to GPT-5.6 (272K) mid-session, the usable budget drops by 73%. A conversation at 40% of Sonnet's window is at 100%+ of GPT-5.6's window.

### Challenge 2: Tokenizers Differ Across Providers (but this doesn't affect tracking)

- Claude 4.7+ produces ~30% more tokens than earlier Claude models for the same text
- OpenAI, Google, DeepInfra all use different tokenizers
- **But:** the context window is per-request. Each call sends the full assembled prompt; the model reports its own usage from its own tokenizer; `isOverflow()` compares that count against the same model's limit. By the time `isOverflow()` runs, `lastFinished.tokens` and `model` are from the same response — same tokenizer, same limit. There is no cross-model mismatch.
- **Pre-flight estimation was considered and rejected.** A heuristic (e.g., chars/4) is imprecise enough that it either triggers false positives (unnecessary compaction, lost context) or still misses (the reactive fallback fires anyway). The provider's own usage report is ground truth and already arrives after each response. Not worth the complexity.

### Challenge 3: Provider Capabilities Differ

| Capability | Anthropic | OpenAI | Google | DeepInfra |
|-----------|-----------|--------|--------|-----------|
| Server-side compaction | Beta | No | No | No |
| Context editing | Beta | No | No | No |
| Token counting API | Free | tiktoken | countTokens | No |
| Context awareness | Some models | No | No | No |

Our client-side compaction is the universal fallback. Provider-native features are optimizations for specific providers.

### Challenge 4: Context Awareness Is Model-Specific

- Anthropic Sonnet/Haiku models: native context awareness (automatic, server-side)
- Anthropic Opus/Fable/Mythos: no native awareness (task budgets beta)
- All non-Anthropic models: no native awareness

For universal budget awareness, we need our own injection that works across all providers. For Anthropic models with native awareness, we should avoid conflicting with their injected tags.

### Challenge 5: TUI Doesn't Reflect Context State or Model Switches

When the user switches models mid-session, the session info panel on the right doesn't update to reflect the new model or its context limit. There is also no `/context` command (like Claude Code has) to show how much context is used and what's consuming it. The user has no visibility into context utilization without watching for compaction events.

---

## Scope (Decided 2026-08-12)

Todd reviewed research and decided on three work items. Pre-flight estimation and agent budget injection were rejected.

### 1. Graduated Compaction Thresholds

Replace the binary `isOverflow()` with tiered thresholds using the accurate provider-reported token counts:

- **80%**: trigger microcompact (clear old tool outputs) — existing `microcompact()` already exists
- **90%**: trigger full compaction — existing `create()` already exists
- **95%+**: hard stop — refuse to send, force compaction

The binary `isOverflow()` becomes the 95% tier. The circuit breaker and config remain.

### 2. Tool Result Truncation — REJECTED

Todd rejected hard caps as overly restrictive — they lose data even when there's ample headroom. The problem (large outputs eating context silently) is already handled by the graduated compaction thresholds: at 80%, microcompact clears old tool outputs. Edge cases (single output so massive it blows past the window) are caught by existing provider overflow error handling. No truncation needed.

### 3. TUI Context Visibility

- **Session info panel** — update on model switch to show the new model and its context limit
- **Context usage display** — show token count / percentage used in the status bar
- **`/context` command** — show how much context is used and what's consuming it (like Claude Code's `/context`)

---

## What We Decided NOT to Build

- **Pre-flight token estimation** — rejected by Todd. Heuristic is imprecise (false positives or misses), provider's own usage report is ground truth and already arrives after each response. Not worth the complexity.
- **Agent budget injection** — rejected. Agents don't reliably self-regulate (per FoxyBear principle: "agents are not code"). The graduated thresholds handle this deterministically in code.
- **Tool result truncation** — rejected. Hard caps are overly restrictive when headroom exists. Graduated compaction (microcompact at 80%) already clears old tool outputs. Provider overflow errors catch edge cases.
- **Per-provider tokenizer library** — overkill for threshold decisions.
- **LLM summarization of tool outputs** — latency rabbit hole.
- **Provider-specific server-side compaction integration** — optimization, not foundation. Client-side compaction is the universal fallback.

---

## References

- [Anthropic: Context Windows](https://docs.anthropic.com/en/docs/build-with-claude/context-windows)
- [Anthropic: Compaction](https://docs.anthropic.com/en/docs/build-with-claude/compaction)
- [Anthropic: Context Editing](https://docs.anthropic.com/en/docs/build-with-claude/context-editing)
- [Anthropic: Token Counting](https://docs.anthropic.com/en/docs/build-with-claude/token-counting)
- [Anthropic: Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic: Prompting Best Practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Cursor: Models & Pricing](https://docs.cursor.com/context/codebase-context)
