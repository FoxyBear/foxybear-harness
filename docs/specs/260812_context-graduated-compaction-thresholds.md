# Spec: Graduated Compaction Thresholds

**Date:** 2026-08-12
**Status:** Draft
**Work Item:** 1 of 2 (Context Window Understanding)
**Research:** `docs/research/260812_context-window-management-best-practices.md`

## Problem

Context overflow detection is binary. `isOverflow()` returns true at 100% of usable tokens, triggering full compaction. There is no graduated response — no microcompact at 80%, no full compact at 90%, no hard stop at 95%. The system goes from "fine" to "summarize everything" in one step.

Additionally, the harness (`harness.ts:74-85`) calls `microcompact()` on **every iteration** unconditionally, regardless of actual context utilization. The `budgetPercent` param and `tier1_threshold` config are passed through but not used for gating — `microcompact()` clears old tool outputs (beyond the last 5) every time it runs.

## WHAT

Replace the binary `isOverflow()` check with a graduated system that computes context utilization and triggers tiered responses at configurable thresholds.

### Tiers

| Tier | Threshold (default) | Action |
|------|---------------------|--------|
| 1 | 80% (`tier1_threshold`) | Microcompact — clear old tool outputs (existing `microcompact()`) |
| 2 | 90% (`tier2_threshold`) | Full compaction — summarize conversation (existing `create()`) |
| 3 | 95% (`tier3_threshold`) | Hard stop — refuse to send, force compaction before next LLM call |

### Utilization Calculation

Utilization = `tokens.total / model.limit.context` (or `tokens.total / usable` where usable = `limit.input - reserved`, matching current `isOverflow()` logic).

The provider-reported token count from the last assistant message is ground truth. No heuristic estimation. No pre-flight counting.

### Config

Add two fields to `config.compaction`:

```jsonc
{
  "compaction": {
    "auto": true,            // existing — enables auto-compaction
    "prune": true,           // existing — enables pruning
    "reserved": 20000,       // existing — token buffer
    "max_failures": 3,       // existing — circuit breaker
    "tier1_threshold": 0.8,  // existing field, new default (was 0.7)
    "tier2_threshold": 0.9,  // NEW — full compaction trigger
    "tier3_threshold": 0.95  // NEW — hard stop trigger
  }
}
```

When `auto === false`, all tiers are disabled (existing behavior preserved).

When `context === 0` (unknown model limit), all tiers are disabled (existing behavior preserved).

## HOW

### 1. New `utilization()` function (`session/overflow.ts`)

Replace the binary `isOverflow()` with a function that returns the utilization ratio (0–1):

```typescript
export function utilization(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }): number
```

- Returns `0` when `context === 0` or `auto === false` (same guard conditions as current `isOverflow()`).
- Computes `count` from `tokens.total || input + output + reasoning + cache.read + cache.write` (same as current).
- Computes `usable` from `limit.input - reserved` or `context - maxOutputTokens` (same as current).
- Returns `count / usable` (clamped to `[0, 1+]` — can exceed 1.0 when over budget).

### 2. New `tier()` function (`session/overflow.ts`)

```typescript
export type CompactionTier = "none" | "microcompact" | "compact" | "hard_stop"

export function tier(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }): CompactionTier
```

- Calls `utilization()`.
- Returns `"hard_stop"` if utilization >= `tier3_threshold` (default 0.95).
- Returns `"compact"` if utilization >= `tier2_threshold` (default 0.9).
- Returns `"microcompact"` if utilization >= `tier1_threshold` (default 0.8).
- Returns `"none"` otherwise.

### 3. Keep `isOverflow()` as a compatibility wrapper

```typescript
export function isOverflow(input: { ... }): boolean {
  return tier(input) === "hard_stop"
}
```

Existing callers that only care about the hard-stop case continue working. New callers use `tier()` for graduated response.

### 4. Update `prompt.ts:1385-1392` — graduated response in the prompt loop

Replace the binary check:

```typescript
// BEFORE (binary):
if (lastFinished && lastFinished.summary !== true &&
    (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))) {
  yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
  continue
}

// AFTER (graduated):
if (lastFinished && lastFinished.summary !== true) {
  const t = tier({ cfg: yield* config.get(), tokens: lastFinished.tokens, model })
  if (t === "hard_stop" || t === "compact") {
    yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
    continue
  }
  if (t === "microcompact") {
    const msgs = yield* session.messages({ sessionID })
    yield* compaction.microcompact({ sessionID, messages: msgs, budgetPercent: tier1Threshold })
    continue
  }
}
```

At `hard_stop` and `compact`, trigger full compaction (existing `create()`). At `microcompact`, trigger microcompaction (existing `microcompact()`). The `continue` restarts the loop so the next iteration sees the reduced context.

### 5. Update `processor.ts:397-402` — `needsCompaction` flag

Replace the binary overflow check with the tier check. Set `ctx.needsCompaction = true` when tier is `compact` or `hard_stop` (not `microcompact` — microcompact doesn't need to stop the stream, it can happen between turns):

```typescript
if (!ctx.assistantMessage.summary) {
  const t = tier({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
  if (t === "compact" || t === "hard_stop") {
    ctx.needsCompaction = true
  }
}
```

### 6. Update `harness.ts:74-85` — gate microcompact on tier 1

Stop calling microcompact on every iteration. Gate it on the tier check:

```typescript
// BEFORE: runs unconditionally every iteration
const threshold = cfg?.compaction?.tier1_threshold ?? 0.7
const messages = await deps.loadMessages(sessionID)
await deps.microcompact({ sessionID, messages, budgetPercent: threshold })

// AFTER: runs only when tier 1 threshold is reached
const messages = await deps.loadMessages(sessionID)
const last = findLastAssistant(messages)
if (last) {
  const model = resolveModel(last)  // from last assistant's providerID/modelID
  const t = tier({ cfg, tokens: last.tokens, model })
  if (t === "microcompact" || t === "compact" || t === "hard_stop") {
    await deps.microcompact({ sessionID, messages, budgetPercent: cfg?.compaction?.tier1_threshold ?? 0.8 })
  }
}
```

The harness needs the last assistant message's tokens and the model it was generated with. This is available from `messages` via the same `findLast` pattern the TUI uses.

### 7. Config schema (`config.ts:1024-1047`)

Add `tier2_threshold` and `tier3_threshold`:

```typescript
compaction: z.object({
  auto: z.boolean().optional(),
  prune: z.boolean().optional(),
  reserved: z.number().int().min(0).optional(),
  max_failures: z.number().int().min(1).optional(),
  tier1_threshold: z.number().min(0).max(1).optional()
    .describe("Budget percentage for tier-1 microcompaction (default: 0.8)"),
  tier2_threshold: z.number().min(0).max(1).optional()
    .describe("Budget percentage for tier-2 full compaction (default: 0.9)"),
  tier3_threshold: z.number().min(0).max(1).optional()
    .describe("Budget percentage for tier-3 hard stop (default: 0.95)"),
}).optional(),
```

### 8. Bus event for tier transitions

Publish a bus event when a tier transition occurs, so the TUI can react:

```typescript
export const Event = {
  Compacted: BusEvent.define("session.compacted", ...),  // existing
  TierChanged: BusEvent.define("session.tier_changed", z.object({
    sessionID: SessionID.zod,
    tier: z.enum(["none", "microcompact", "compact", "hard_stop"]),
    utilization: z.number(),
  })),
}
```

This fires after each assistant message completes and the tier is computed. The TUI subscribes to update the status bar / sidebar.

## VERIFY

### Unit Tests (`test/session/overflow.test.ts`)

1. **`utilization()` returns 0 when `context === 0`** — model with unknown limit, any token count → 0.
2. **`utilization()` returns 0 when `auto === false`** — compaction disabled → 0.
3. **`utilization()` computes correct ratio** — 50K tokens, 200K context, no reserved → 0.25.
4. **`utilization()` uses `limit.input - reserved` when present** — 50K tokens, 200K input limit, 20K reserved → 50/180 = 0.278.
5. **`utilization()` uses `context - maxOutputTokens` when no `limit.input`** — 50K tokens, 200K context, 8K output → 50/192 = 0.260.
6. **`utilization()` can exceed 1.0** — 200K tokens, 100K usable → 2.0.
7. **`tier()` returns `"none"` below tier 1** — utilization 0.79 → "none".
8. **`tier()` returns `"microcompact"` at tier 1** — utilization 0.80 → "microcompact".
9. **`tier()` returns `"compact"` at tier 2** — utilization 0.90 → "compact".
10. **`tier()` returns `"hard_stop"` at tier 3** — utilization 0.95 → "hard_stop".
11. **`tier()` respects custom thresholds** — tier1=0.7, tier2=0.85, tier3=0.9, utilization 0.86 → "compact".
12. **`tier()` returns highest applicable tier** — utilization 0.96 → "hard_stop" (not "compact").
13. **`isOverflow()` returns true only at `hard_stop`** — utilization 0.90 → false; utilization 0.95 → true.
14. **`isOverflow()` is a compatibility wrapper** — same guard conditions as `tier()`.

### Integration Tests (`test/session/compaction-graduated.test.ts`)

15. **Microcompact triggers at 80%** — session at 80% utilization → `microcompact()` called, old tool outputs cleared, loop continues.
16. **Full compact triggers at 90%** — session at 90% utilization → `create()` called, summary generated, loop continues.
17. **Hard stop at 95%** — session at 95% utilization → `create()` called with `overflow: true`, stream stops.
18. **Microcompact does not trigger below 80%** — session at 70% → no microcompact, no compaction.
19. **Circuit breaker disables all auto-tiers** — 3 consecutive compaction failures → auto-tiers disabled, `isAutoCompactionDisabled()` returns true.
20. **`auto === false` disables all tiers** — no microcompact, no compact, no hard stop.
21. **`context === 0` disables all tiers** — unknown model limit → no action.
22. **Harness gates microcompact on tier 1** — harness runs, utilization below 80% → microcompact NOT called. Utilization above 80% → microcompact called.
23. **TierChanged event fires on transition** — assistant message completes, utilization crosses 80% → `Event.TierChanged` published with `{ tier: "microcompact", utilization: 0.81 }`.

### Config Tests (`test/config/compaction.test.ts`)

24. **Default thresholds** — no config → tier1=0.8, tier2=0.9, tier3=0.95.
25. **Custom thresholds** — config specifies tier1=0.7, tier2=0.85, tier3=0.9 → used correctly.
26. **Threshold validation** — tier1 > tier2 → validation error (tier1 must be <= tier2). Actually: just enforce `0 <= tier1 <= tier2 <= tier3 <= 1` at the zod level via refine.

## Files Touched

| File | Change |
|------|--------|
| `session/overflow.ts` | Replace `isOverflow()` with `utilization()` + `tier()`. Keep `isOverflow()` as wrapper. |
| `session/compaction.ts` | Add `Event.TierChanged`. No logic changes to `microcompact()` / `create()`. |
| `session/prompt.ts:1385-1392` | Replace binary overflow check with `tier()` graduated response. |
| `session/processor.ts:397-402` | Replace `isOverflow()` with `tier()` check for `compact` / `hard_stop`. |
| `harness/harness.ts:74-85` | Gate microcompact on tier 1 threshold instead of running unconditionally. |
| `config/config.ts:1024-1047` | Add `tier2_threshold`, `tier3_threshold`. Change `tier1_threshold` default to 0.8. |

## Non-Goals

- No pre-flight token estimation (rejected — heuristic is imprecise, provider's count is ground truth).
- No agent budget injection (rejected — agents don't reliably self-regulate).
- No tool result truncation (rejected — graduated compaction handles it via microcompact).
- No per-provider tokenizer (overkill for threshold decisions).
- No server-side compaction integration (Anthropic-only, client-side is universal).
