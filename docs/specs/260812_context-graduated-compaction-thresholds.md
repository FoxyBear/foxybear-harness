# Spec: Graduated Compaction Thresholds

**Date:** 2026-08-12
**Status:** Revised (council-approved with changes, 2026-08-12)
**Work Item:** 1 of 2 (Context Window Understanding)
**Research:** `docs/research/260812_context-window-management-best-practices.md`
**Council Review:** 4/5 consensus, 2 rounds — `docs/specs/260812_context-graduated-compaction-thresholds.md` (council verbose output)

## Problem

Context overflow detection is binary. `isOverflow()` returns true at 100% of usable tokens, triggering full compaction. There is no graduated response — no microcompact at 80%, no full compact at 90%, no hard stop at 95%. The system goes from "fine" to "summarize everything" in one step.

Additionally, the harness (`harness.ts:74-85`) calls `microcompact()` on **every iteration** unconditionally, regardless of actual context utilization. The `budgetPercent` param and `tier1_threshold` config are passed through but not used for gating — `microcompact()` clears old tool outputs (beyond the last 5) every time it runs.

## WHAT

Replace the binary `isOverflow()` check with a graduated system that computes context utilization and triggers tiered responses at configurable thresholds.

### Tiers

| Tier | Threshold (default) | Action | Owner |
|------|---------------------|--------|-------|
| 1 | 80% (`tier1_threshold`) | Microcompact — clear old tool outputs (existing `microcompact()`) | `harness.ts` (between turns) |
| 2 | 90% (`tier2_threshold`) | Full compaction — summarize conversation (existing `create()`) | `prompt.ts` (in-loop) |
| 3 | 95% (`tier3_threshold`) | Hard stop — refuse to send, force compaction before next LLM call | `prompt.ts` (in-loop) |

**Single ownership (A3):** Microcompact is owned by the harness (between turns, tier 1 only). Full compaction and hard stop are owned by `prompt.ts` (in-loop, tiers 2–3). No component runs both. This eliminates the double-compaction race where the harness microcompacts a session that `prompt.ts` is about to fully summarize.

### Utilization Calculation

Utilization = `tokens.total / usable` where `usable` = `limit.input - reserved` when `limit.input` is present, otherwise `context - maxOutputTokens` — matching current `isOverflow()` logic exactly.

The provider-reported token count from the last assistant message is ground truth. No heuristic estimation. No pre-flight counting.

**Dual-limit precedence (B3):** When both `limit.input` and `context` are present, `limit.input - reserved` takes precedence (matches existing `isOverflow()`). When neither is present (`context === 0`), all tiers are disabled.

**`usable <= 0` (B3):** When `reserved >= limit.input` or `context <= maxOutputTokens`, `usable` is `<= 0`. Return `0` from `utilization()` (disabled/no-tier). Never divide by zero. Deterministic, not crash.

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

Replace the binary `isOverflow()` with a function that returns the utilization ratio (≥ 0):

```typescript
export function utilization(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }): number
```

- Returns `0` when `context === 0` or `auto === false` (same guard conditions as current `isOverflow()`).
- Returns `0` when `usable <= 0` (B3).
- Computes `count` from `tokens.total || input + output + reasoning + cache.read + cache.write` (same as current).
- Computes `usable` from `limit.input - reserved` (when `limit.input` present) or `context - maxOutputTokens` (same precedence as current).
- Returns `count / usable` (can exceed 1.0 when over budget).

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

### 3. New `thresholds()` accessor (`session/overflow.ts`) — A2

Single canonical accessor for resolved thresholds with defaults applied. Both `prompt.ts` and `harness.ts` call this. The default value for each threshold lives in exactly one place.

```typescript
export function thresholds(cfg: Config.Info): { tier1: number; tier2: number; tier3: number } {
  return {
    tier1: cfg.compaction?.tier1_threshold ?? 0.8,
    tier2: cfg.compaction?.tier2_threshold ?? 0.9,
    tier3: cfg.compaction?.tier3_threshold ?? 0.95,
  }
}
```

### 4. New `isTieringEnabled()` helper (`session/overflow.ts`) — B2

Distinguishes "compaction disabled" from "fresh session" — both return `utilization() === 0`. The TUI needs this on initial load.

```typescript
export function isTieringEnabled(input: { cfg: Config.Info; model: Provider.Model }): boolean {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false
  const usable = input.model.limit.input
    ? input.model.limit.input - (input.cfg.compaction?.reserved ?? 20_000)
    : input.model.limit.context - maxOutputTokens(input.model)
  return usable > 0
}
```

### 5. `needsImmediateCompaction()` + deprecated `isOverflow()` — B1

The old `isOverflow()` fired at 100% of usable. The new wrapper fires at `tier3_threshold` (default 0.95) — a policy change, not pure compatibility. Rename and deprecate:

```typescript
/** @deprecated Use tier() for graduated response. Fires at tier3_threshold (default 0.95), not 100%. */
export function isOverflow(input: { ... }): boolean {
  return tier(input) === "hard_stop"
}

/** Returns true when hard-stop compaction is needed (tier 3). */
export function needsImmediateCompaction(input: { ... }): boolean {
  return tier(input) === "hard_stop"
}
```

All existing `isOverflow()` callers should be grepped and audited. Each tolerates the earlier trigger (95% leaves room for the compaction summary itself and prevents provider-side truncation at 100%). Users wanting old behavior set `tier3_threshold: 1.0`.

### 6. Update `prompt.ts:1385-1392` — graduated response (tiers 2–3 only) — A3

`prompt.ts` owns full compaction and hard stop. It does NOT microcompact — the harness handles tier 1 between turns.

```typescript
// AFTER (graduated, tiers 2–3 only):
if (lastFinished && lastFinished.summary !== true) {
  const t = tier({ cfg: yield* config.get(), tokens: lastFinished.tokens, model })
  if (t === "hard_stop" || t === "compact") {
    yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
    continue
  }
  // tier 1 (microcompact) is handled by the harness between turns — not here
}
```

**Source-turn dedup + iteration cap (A5):** Microcompact only clears tool outputs beyond the last 5. A conversation-body-heavy session at 82% frees nearly nothing. The escape hatch:

1. **Dedup:** Track the last assistant-message ID for which microcompact was triggered. Do not re-trigger microcompact for the same source turn. Store this alongside the existing compaction circuit-breaker state.
2. **Escalation:** If a source turn is still at tier `microcompact` after its one microcompact pass — the local cleanup cannot help — escalate that source turn to `create()` (full compaction produces genuine reduction).
3. **Backstop:** Hard iteration cap (max 2 consecutive local-compaction cycles without a new LLM response) forces `create()` as a reliable failsafe.

Because microcompact is in the harness (between turns), the `continue`-loop churn is reduced, but the dedup guard and iteration cap apply to whichever component re-enters.

### 7. Update `processor.ts:397-402` — `needsCompaction` flag

Replace the binary overflow check with the tier check. Set `ctx.needsCompaction = true` when tier is `compact` or `hard_stop` (not `microcompact` — microcompact doesn't stop the stream, it happens between turns):

```typescript
if (!ctx.assistantMessage.summary) {
  const t = tier({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
  if (t === "compact" || t === "hard_stop") {
    ctx.needsCompaction = true
  }
}
```

**Implementation note:** Verify `processor.ts` can `yield* config.get()` in its execution context (matches `prompt.ts` pattern in the same module — likely fine, but check first).

### 8. Update `harness.ts:74-85` — gate microcompact on tier 1 only — A3, A4

The harness owns microcompact (tier 1 only). It does NOT run at tiers 2–3 — `prompt.ts` handles those. This eliminates the race where the harness microcompacts a session `prompt.ts` is about to fully summarize.

```typescript
// BEFORE: runs unconditionally every iteration
const threshold = cfg?.compaction?.tier1_threshold ?? 0.7
const messages = await deps.loadMessages(sessionID)
await deps.microcompact({ sessionID, messages, budgetPercent: threshold })

// AFTER: runs only at tier 1, with resolved model
const messages = await deps.loadMessages(sessionID)
const last = findLastAssistant(messages)
if (last && agentRun.resolvedModel) {
  const t = tier({ cfg, tokens: last.tokens, model: agentRun.resolvedModel })
  if (t === "microcompact") {
    const { tier1 } = thresholds(cfg)
    await deps.microcompact({ sessionID, messages, budgetPercent: tier1 })
  }
}
```

**Model resolution (A4):** `tier()` needs a real `Provider.Model` (with `limit.input`/`limit.context`/`maxOutputTokens`), not a model ID string. The harness currently does not resolve a model. Fix: carry the resolved model on the agent run state. Extend the `AgentRun` interface (or equivalent harness run state) with `resolvedModel: Provider.Model`, populated during session initialization when the model name is first resolved against the provider registry.

**Safe fallback:** If `resolvedModel` is absent or `findLastAssistant()` returns null, the harness is a safe no-op (no crash, no compaction) — matching the `context === 0` guard.

### 9. Config schema (`config.ts:1024-1047`) — A1

Add `tier2_threshold` and `tier3_threshold`. Add `.refine()` with monotonic cross-field validation. Apply defaults before comparing so partial-config inversions are caught:

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
}).optional()
  .refine((cfg) => {
    const t1 = cfg?.tier1_threshold ?? 0.8
    const t2 = cfg?.tier2_threshold ?? 0.9
    const t3 = cfg?.tier3_threshold ?? 0.95
    return t1 <= t2 && t2 <= t3
  }, { message: "Compaction thresholds must satisfy tier1 <= tier2 <= tier3" }),
```

Test 26 must verify both all-explicit inversion AND partial-config-against-defaults inversion (e.g., setting only `tier2: 0.7`, below the tier1 default of 0.8).

### 10. Bus event for tier transitions — A6

`TierChanged` is a **stateful transition event**, not a per-message broadcast. It fires only when the tier changes. Prior-tier state is stored per session alongside the existing compaction circuit-breaker state.

```typescript
export const Event = {
  Compacted: BusEvent.define("session.compacted", ...),  // existing
  TierChanged: BusEvent.define("session.tier_changed", z.object({
    sessionID: SessionID.zod,
    previousTier: z.enum(["none", "microcompact", "compact", "hard_stop"]),
    newTier: z.enum(["none", "microcompact", "compact", "hard_stop"]),
    utilization: z.number(),
    tieringEnabled: z.boolean(),  // B2 — distinguishes disabled from healthy-empty
  })),
}
```

**Firing rules:**
1. Store per-session `lastTier` (initial: `"none"`).
2. After each assistant message completes, compute `tier()`.
3. Fire `TierChanged` **only when `previousTier !== newTier`**. Update `lastTier` after firing. No `none → none` events.
4. Include downward transitions (e.g., `compact → none` after a summary). The TUI needs to know when pressure clears.
5. On the first message of a session, `previousTier` is `"none"`.

**Hysteresis:** Not required for this spec. Compaction is a discrete event that sharply reduces utilization, so oscillation across a single boundary is unlikely to be pathological. If flapping is observed in practice, Spec 2 may add a hysteresis band as a UX policy decision.

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
14. **`isOverflow()` is a deprecated wrapper** — same guard conditions as `tier()`.

### Integration Tests (`test/session/compaction-graduated.test.ts`)

15. **Microcompact triggers at 80%** — session at 80% utilization → `microcompact()` called (by harness), old tool outputs cleared, loop continues.
16. **Full compact triggers at 90%** — session at 90% utilization → `create()` called (by prompt.ts), summary generated, loop continues.
17. **Hard stop at 95%** — session at 95% utilization → `create()` called with `overflow: true`, stream stops.
18. **Microcompact does not trigger below 80%** — session at 70% → no microcompact, no compaction.
19. **Circuit breaker disables all auto-tiers** — 3 consecutive compaction failures → auto-tiers disabled, `isAutoCompactionDisabled()` returns true.
20. **`auto === false` disables all tiers** — no microcompact, no compact, no hard stop.
21. **`context === 0` disables all tiers** — unknown model limit → no action.
22. **Harness gates microcompact on tier 1** — harness runs, utilization below 80% → microcompact NOT called. Utilization above 80% → microcompact called.
23. **TierChanged event fires on transition** — assistant message completes, utilization crosses 80% → `Event.TierChanged` published with `{ previousTier: "none", newTier: "microcompact", utilization: 0.81, tieringEnabled: true }`.

### Config Tests (`test/config/compaction.test.ts`)

24. **Default thresholds** — no config → tier1=0.8, tier2=0.9, tier3=0.95.
25. **Custom thresholds** — config specifies tier1=0.7, tier2=0.85, tier3=0.9 → used correctly.
26. **Threshold validation** — enforce `0 <= tier1 <= tier2 <= tier3 <= 1` via `.refine()`. Test both: (a) all-explicit inversion (`tier1=0.9, tier2=0.8` → validation error), (b) partial-config-against-defaults inversion (`{ tier2_threshold: 0.7 }` → validation error, since 0.7 < tier1 default 0.8).

### Additional Tests (council-required gaps)

27. **Downward transition after compaction** — session at 90% → `create()` fires → utilization drops → assert tier is "none"/"microcompact" and `TierChanged` fires with `{ previousTier: "compact", newTier: "none" }`.
28. **Microcompact insufficient → escalation** — body-heavy session at 82%, microcompact frees < 2%, same source turn still tier-1; assert escalation to `create()` and no infinite loop (tests A5 escape hatch).
29. **Source-turn dedup** — same assistant message evaluated twice; assert microcompact fires at most once for that source turn.
30. **Exact-boundary `>=` semantics** — utilization exactly 0.80/0.90/0.95 map to microcompact/compact/hard_stop; 0.799/0.899/0.949 map to the lower tier.
31. **`tier3_threshold: 1.0` restores old behavior** — utilization 0.99 → "compact"; 1.0 → "hard_stop"; `needsImmediateCompaction()` matches old `isOverflow()` at 100%.
32. **Partial config with defaults** — `{ tier2_threshold: 0.85 }` merges to `{0.8, 0.85, 0.95}`; verify tier mapping.
33. **Single-owner enforcement** — at 92%, `create()` fires from `prompt.ts` and `microcompact()` does NOT fire from the harness on the same message (tests A3).
34. **TierChanged no-fire when unchanged** — two consecutive messages both at 35% → event fires at most once.
35. **Disabled vs healthy-empty** — `auto: false` with 0 tokens vs healthy 0-token session → distinguishable via `isTieringEnabled()` / `tieringEnabled` field (tests B2).
36. **Config refine rejection** — both explicit inversion (`tier1 > tier2`) and partial-config-against-defaults inversion (tests A1).
37. **`usable <= 0`** — `reserved >= limit.input`; assert `utilization()` returns 0, `tier()` returns "none", no divide-by-zero (tests B3).
38. **Harness with no assistant messages** — `findLastAssistant()` returns null → harness no-ops, no crash, no event.

## Files Touched

| File | Change |
|------|--------|
| `session/overflow.ts` | Add `utilization()`, `tier()`, `thresholds()`, `isTieringEnabled()`, `needsImmediateCompaction()`. Keep deprecated `isOverflow()` delegate. Export all. |
| `session/compaction.ts` | Add `Event.TierChanged` (with `previousTier`/`newTier`/`tieringEnabled`). Track per-session `lastTier`. No logic changes to `microcompact()` / `create()`. |
| `session/prompt.ts:1385-1392` | Graduated tier response owning tiers 2–3 (full compaction/hard stop). Source-turn dedup + iteration cap. Use `thresholds()` accessor. No microcompact (A3). |
| `session/processor.ts:397-402` | Replace `isOverflow()` with `needsImmediateCompaction()`; set `needsCompaction` for `compact`/`hard_stop`. |
| `harness/harness.ts:74-85` | Gate microcompact on tier 1 **only** (A3). Use `agentRun.resolvedModel` (A4). Use `thresholds()` accessor (A2). No-op when model unresolved or no assistant messages. |
| `config/config.ts:1024-1047` | Add `tier2_threshold`, `tier3_threshold`, `.refine()` monotonic check (A1). `tier1_threshold` default → 0.8. |
| `harness/types.ts` (or `AgentRun` definition site) | Add `resolvedModel: Provider.Model` (A4). |

## Non-Goals

- No pre-flight token estimation (rejected — heuristic is imprecise, provider's count is ground truth).
- No agent budget injection (rejected — agents don't reliably self-regulate).
- No tool result truncation (rejected — graduated compaction handles it via microcompact).
- No per-provider tokenizer (overkill for threshold decisions).
- No server-side compaction integration (Anthropic-only, client-side is universal).
- No hysteresis on tier transitions (deferred to Spec 2 if flapping observed).
- No fallback arbitrator for compaction (single-path `create()`).

## Implementation Notes (verify during implementation)

- Confirm `processor.ts` can `yield* config.get()` in its execution context (matches `prompt.ts` pattern — likely fine).
- Confirm existing `overflow.ts` branches `limit.input - reserved` vs `context - maxOutputTokens` with the precedence assumed above (B3).
- Full grep of `isOverflow()` callers beyond the two cited sites to confirm each tolerates the 95% trigger (B1).
- Confirm `microcompact()` and `create()` are safe against a single session under the single-owner model (A3).

## Spec 2 Dependency

The revised `TierChanged` payload `{ sessionID, previousTier, newTier, utilization, tieringEnabled }` is sufficient for Work Item 2 (TUI Context Visibility):

- **Live updates:** TUI subscribes to transitions with direction context (up/down).
- **Initial render:** TUI computes current tier synchronously via exported `tier()` and `isTieringEnabled()` using the last assistant message and resolved model. Events alone cannot cover initial load.
- **Disabled state:** `tieringEnabled: false` prevents rendering "compaction disabled" identically to "context 0%".

No changes needed to the downstream spec.
