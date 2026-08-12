# Spec: TUI Context Visibility

**Date:** 2026-08-12
**Status:** Draft
**Work Item:** 2 of 2 (Context Window Understanding)
**Research:** `docs/research/260812_context-window-management-best-practices.md`

## Problem

Two issues with context visibility in the TUI:

1. **Session info doesn't update on model switch.** The sidebar context panel (`sidebar/context.tsx`) and the status bar (`prompt/index.tsx` `usage` memo) both read the **last assistant message's** `providerID`/`modelID` to determine the context limit. When the user switches models via `/models`, the displayed context percentage doesn't update until the next message is sent with the new model. Switching from a 1M-context model to a 256K-context model should immediately show the new percentage.

2. **No `/context` command.** There is no way to see a breakdown of context usage — what's consuming tokens, how much is used vs available, what the current model's limit is. Claude Code has `/context` for this.

## WHAT

### A. Sidebar + Status Bar Update on Model Switch

Both the sidebar context panel and the status bar should show context utilization against the **currently selected model's** limit, not the last assistant message's model. When the user switches models, the percentage updates immediately.

Token count still comes from the last assistant message (that's the ground truth). But the denominator (context limit) comes from `local.model.current()` — the model that will be used for the next message.

### B. `/context` Command

A new slash command that shows a context usage breakdown:

```
┌─ Context ────────────────────────────────────────┐
│ Model: Claude Sonnet 5 (Anthropic)              │
│ Context limit: 1,000,000 tokens                  │
│ Used: 234,567 tokens (23%)                       │
│ Remaining: 765,433 tokens                        │
│                                                  │
│ Breakdown (estimated):                           │
│   System prompt     ~8,000 tokens                │
│   Tool definitions  ~12,000 tokens               │
│   Messages          ~45,000 tokens               │
│   Tool outputs      ~169,000 tokens              │
│                                                  │
│ Recent messages:                                  │
│   [assistant]  12,345 tokens  5 tool calls       │
│   [user]       1,200 tokens                      │
│   [assistant]  8,900 tokens  2 tool calls        │
│   [user]       850 tokens                        │
│                                                  │
│ Compaction: enabled                               │
│   Circuit breaker: OK (0/3 failures)             │
│   Last tier: none                                 │
└──────────────────────────────────────────────────┘
```

Shown as a dialog (like `/compact` opens a confirmation, but this is read-only).

## HOW

### A. Shared context computation helper

Both the sidebar and the status bar compute context utilization identically. Factor this into a shared hook so both use the same logic and both read from `local.model` for the limit.

**New file:** `packages/opencode/src/cli/cmd/tui/util/context.ts`

```typescript
export function useContext(sessionID: () => string | undefined) {
  const local = useLocal()
  const sync = useSync()

  const state = createMemo(() => {
    const sid = sessionID()
    if (!sid) return undefined
    const messages = sync.data.message[sid]
    if (!messages) return undefined

    // Find last assistant message with tokens
    const last = [...messages].reverse().find(
      m => m.role === "assistant" && m.tokens && m.tokens.output > 0
    )
    if (!last) return undefined

    // Sum tokens (ground truth from provider)
    const tokens =
      last.tokens.total ||
      last.tokens.input + last.tokens.output +
      last.tokens.reasoning +
      last.tokens.cache.read + last.tokens.cache.write

    // Context limit from CURRENTLY SELECTED model (not last message's model)
    const current = local.model.current()
    const model = current
      ? sync.data.provider.find(p => p.id === current.providerID)?.models?.[current.modelID]
      : undefined
    const limit = model?.limit?.context ?? 0

    const pct = limit > 0 ? Math.round((tokens / limit) * 100) : undefined
    const cost = messages
      .filter(m => m.role === "assistant" && m.cost)
      .reduce((sum, m) => sum + (m.cost ?? 0), 0)

    return { tokens, limit, pct, cost, model, lastMessage: last }
  })

  return state
}
```

### B. Update sidebar context panel

**File:** `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/context.tsx`

Replace the `state` memo (lines 17-33) to use the shared helper:

```typescript
const ctx = useContext(() => props.api.state.session.id)
const state = ctx()  // { tokens, limit, pct, cost, model }
```

The display (lines 38-42) stays the same — it already renders `tokens`, `pct`, `cost`. The difference is that `limit` now comes from `local.model.current()` instead of the last assistant message's model. When the user switches models, `local.model.current()` changes, the memo re-evaluates, and the percentage updates immediately.

Also add the model name to the sidebar display:

```
Context
Claude Sonnet 5 · 234,567 tokens · 23% used · $0.42 spent
```

### C. Update status bar

**File:** `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`

Replace the `usage` memo (lines 145-162) with the shared helper:

```typescript
const ctx = useContext(() => route.sessionID)
const usage = createMemo(() => {
  const s = ctx()
  if (!s) return undefined
  return {
    context: s.pct ? `${s.tokens.toLocaleString()} (${s.pct}%)` : `${s.tokens.toLocaleString()}`,
    cost: s.cost > 0 ? money.format(s.cost) : undefined,
    pct: s.pct,
  }
})
```

Add color thresholds to the status bar display (lines 1245-1250):

```tsx
<Match when={usage()}>
  {(item) => {
    const u = item()
    const color = u.pct >= 90 ? theme.danger : u.pct >= 80 ? theme.warning : theme.textMuted
    return (
      <text fg={color} wrapMode="none">
        {[u.context, u.cost].filter(Boolean).join(" · ")}
      </text>
    )
  }}
</Match>
```

- 80%+ → warning color (yellow)
- 90%+ → danger color (red)
- Below 80% → muted (default)

### D. `/context` command

**File:** `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` (session-scoped commands, after `/compact` at ~line 494)

Register the command:

```typescript
{
  title: "Context usage",
  value: "session.context",
  keybind: "session_context",
  category: "Session",
  slash: { name: "context" },
  onSelect: (dialog) => {
    dialog.replace(() => <DialogContext sessionID={route.sessionID} />)
  },
},
```

This automatically surfaces in `/`-autocomplete and the command dialog — no separate registration needed.

**New file:** `packages/opencode/src/cli/cmd/tui/component/dialog-context.tsx`

A `DialogContext` component that renders the context breakdown:

```typescript
export function DialogContext(props: { sessionID: string }) {
  const ctx = useContext(() => props.sessionID)
  const sync = useSync()
  const local = useLocal()
  const command = useCommandDialog()

  const breakdown = createMemo(() => {
    const s = ctx()
    if (!s) return undefined
    const messages = sync.data.message[props.sessionID] ?? []

    // Estimate breakdown by category
    const toolOutputs = messages
      .filter(m => m.role === "assistant")
      .flatMap(m => /* sum tool part token estimates */)
    const messageTokens = messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => /* estimate text tokens */)

    return {
      toolOutputs: /* sum */,
      messages: /* sum */,
      recent: messages.slice(-10).map(m => ({
        role: m.role,
        tokens: m.tokens?.total ?? estimate(m),
        tools: /* count tool parts */,
      })),
    }
  })

  return (
    <Dialog>
      <Box title="Context">
        <text>Model: {Model.name(...)} ({provider})</text>
        <text>Context limit: {limit.toLocaleString()} tokens</text>
        <text>Used: {tokens.toLocaleString()} tokens ({pct}%)</text>
        <text>Remaining: {(limit - tokens).toLocaleString()} tokens</text>
        <text></text>
        <text>Breakdown (estimated):</text>
        <text>  Tool outputs   ~{toolOutputs.toLocaleString()} tokens</text>
        <text>  Messages       ~{messages.toLocaleString()} tokens</text>
        <text></text>
        <text>Recent messages:</text>
        {recent.map(m => <text>  [{m.role}]  {m.tokens.toLocaleString()} tokens</text>)}
        <text></text>
        <text>Compaction: {auto ? "enabled" : "disabled"}</text>
        <text>  Circuit breaker: {ok ? "OK" : "tripped"}</text>
      </Box>
    </Dialog>
  )
}
```

The breakdown uses `Token.estimate()` (chars/4) for individual message/tool-output sizes — these are estimates for display only, not for compaction decisions. The total tokens and percentage use the provider-reported ground truth.

### E. Compaction tier in status bar

Subscribe to the `Event.TierChanged` bus event (from spec 1) to show the current tier in the status bar:

```
234,567 (23%) · $0.42 · [context: ok]
```

When tier is `microcompact`:
```
234,567 (81%) · $0.42 · [context: microcompact]
```

When tier is `compact` or `hard_stop`:
```
234,567 (91%) · $0.42 · [context: compacting...]
```

This requires the TUI to subscribe to `session.tier_changed` events via the sync store. Add a handler in `sync.tsx`:

```typescript
case "session.tier_changed": {
  set(store, "tier", sessionID, event.data.tier)
  set(store, "utilization", sessionID, event.data.utilization)
  break
}
```

## VERIFY

### Unit Tests (`test/cli/util/context.test.ts`)

1. **`useContext` returns undefined when no session** — `sessionID()` returns undefined → `undefined`.
2. **`useContext` returns undefined when no messages** — session exists but no messages → `undefined`.
3. **`useContext` returns undefined when no assistant messages with tokens** — only user messages → `undefined`.
4. **`useContext` sums tokens correctly** — last assistant has input=10K, output=5K, reasoning=2K, cache.read=8K, cache.write=1K → total=26K (or uses `tokens.total` if present).
5. **`useContext` uses currently selected model's limit** — `local.model.current()` returns model A (200K context), last assistant message used model B (1M context) → limit=200K, pct=13% (not 2.6%).
6. **`useContext` updates on model switch** — model switches from A (200K) to C (256K) → limit=256K, pct recalculates.
7. **`useContext` handles unknown context limit** — model has `limit.context === 0` → pct=undefined.
8. **`useContext` sums cost across all assistant messages** — 3 assistant messages with costs $0.10, $0.20, $0.05 → cost=$0.35.

### Component Tests (`test/cli/dialog-context.test.ts`)

9. **DialogContext renders model name and limit** — shows "Claude Sonnet 5" and "1,000,000 tokens".
10. **DialogContext shows used/remaining** — 234K used, 766K remaining, 23%.
11. **DialogContext shows breakdown** — tool outputs and messages estimates are non-negative integers.
12. **DialogContext shows recent messages** — last 10 messages with role and token count.
13. **DialogContext shows compaction status** — "enabled" / "disabled", circuit breaker state.
14. **DialogContext handles empty session** — no messages → shows "No messages yet" or equivalent.

### Status Bar Tests (`test/cli/prompt-status.test.ts`)

15. **Status bar shows muted color below 80%** — pct=23 → `theme.textMuted`.
16. **Status bar shows warning color at 80%+** — pct=81 → `theme.warning`.
17. **Status bar shows danger color at 90%+** — pct=91 → `theme.danger`.
18. **Status bar hides cost when zero** — cost=0 → no cost shown.
19. **Status bar shows tier indicator** — tier event fires "microcompact" → shows "[context: microcompact]".

### Command Tests (`test/cli/commands.test.ts`)

20. **`/context` appears in slash autocomplete** — typing `/con` shows `/context` option.
21. **`/context` appears in command dialog** — command dialog lists "Context usage".
22. **`/context` opens dialog** — selecting it renders `DialogContext`.
23. **`/context` has keybind** — `session_context` keybind opens the dialog.

### Sync Tests (`test/cli/sync.test.ts`)

24. **`session.tier_changed` event updates store** — event arrives → `store.tier[sessionID]` = "microcompact", `store.utilization[sessionID]` = 0.81.

## Files Touched

| File | Change |
|------|--------|
| `cli/cmd/tui/util/context.ts` | NEW — shared `useContext()` hook. |
| `cli/cmd/tui/feature-plugins/sidebar/context.tsx` | Use `useContext()`, add model name to display. |
| `cli/cmd/tui/component/prompt/index.tsx` | Use `useContext()`, add color thresholds, add tier indicator. |
| `cli/cmd/tui/component/dialog-context.tsx` | NEW — `DialogContext` component. |
| `cli/cmd/tui/routes/session/index.tsx` | Register `/context` command (~line 494). |
| `cli/cmd/tui/context/sync.tsx` | Handle `session.tier_changed` event. |

## Dependencies

- **Spec 1 (Graduated Compaction Thresholds)** — the `Event.TierChanged` bus event and tier status are defined in spec 1. The TUI tier indicator (section E) depends on it. If spec 1 is not yet implemented, section E can be deferred — sections A–D are independent.

## Non-Goals

- No real-time token counting during streaming (tokens are only available after the response completes).
- No per-provider tokenizer for the breakdown (estimates via chars/4 are sufficient for display).
- No context budget injection into the agent prompt (rejected — agents don't reliably self-regulate).
