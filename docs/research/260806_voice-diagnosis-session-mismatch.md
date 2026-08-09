# Voice TTS Plugin — Session ID Mismatch Diagnosis

**Date:** 2026-08-06
**Scope:** Diagnose (not fix) whether the `command.execute.before` handler's `input.sessionID` can differ from the `sessionID` in subsequent `message.part.delta` Bus events, preventing the TTS pipeline from starting.

---

## Executive Summary

**For the `/voice` and `/mute` commands specifically: NO mismatch.** The `commandBefore` handler sets `mode.active = true` for `input.sessionID`, and the LLM's subsequent response fires `message.part.delta` events in the **same** session. The pipeline starts correctly.

**For subtask scenarios: YES, mismatch is possible — and expected.** When the LLM calls the `task` tool (or a command is configured with `isSubtask: true`), a **child session** is created with a different ID. The child session's `message.part.delta` events fire with the child's session ID, where `mode.active` is `false`. The subtask's streaming output is never spoken. The parent session's post-subtask summary IS spoken (same session ID, `mode.active` still true).

**Root cause if subtask output is expected to be spoken:** The voice plugin keys `VoiceMode` per-session (`Map<SessionID, SessionState>`) and has no mechanism to propagate `mode.active` from a parent session to its children. The `TaskTool` (`src/tool/task.ts:68-98`) creates a fresh `nextSession` via `sessions.create({ parentID: ctx.sessionID })` and runs the LLM there — a deliberate isolation boundary that the voice plugin does not cross.

---

## Session ID Flow Trace

### 1. Command execution → `command.execute.before`

```
server/instance/session.ts:937-939
  └─ sessionID from URL param (:sessionID)
  └─ SessionPrompt.command({ ...body, sessionID })       ← S1

session/prompt.ts:1649-1653
  └─ plugin.trigger("command.execute.before",
       { command, sessionID: S1, arguments },
       { parts })                                         ← S1
  └─ commandBefore(input.sessionID = S1)
       └─ getOrCreate(S1) → mode.active = true            ← state keyed by S1
       └─ output.parts mutated → [{ type: "text", text: "Voice on." }]
```

The `input.sessionID` in the hook is `CommandInput.sessionID`, sourced from the HTTP URL parameter. This is the session the user is interacting with.

### 2. Command execution → prompt → loop → processor → `message.part.delta`

```
session/prompt.ts:1655-1662
  └─ prompt({ sessionID: S1, parts })                     ← S1

session/prompt.ts:1293
  └─ loop({ sessionID: S1 })                               ← S1

session/prompt.ts:1418-1425
  └─ msg.sessionID = S1 (assistant message)
  └─ processor.create({ assistantMessage: msg, sessionID: S1 })

session/processor.ts:114-117
  └─ ctx.sessionID = S1
  └─ ctx.assistantMessage = msg (msg.sessionID = S1)

session/processor.ts:406-429 (text-delta)
  └─ ctx.currentText.sessionID = ctx.assistantMessage.sessionID = S1
  └─ session.updatePartDelta({ sessionID: S1, ... })

session/index.ts:636-644
  └─ bus.publish(MessageV2.Event.PartDelta, { sessionID: S1, ... })
```

**Result:** `message.part.delta` events carry `properties.sessionID = S1`. This matches the `commandBefore` handler's `input.sessionID = S1`. `getOrCreate(S1)` in the `event` function finds the existing state with `mode.active = true`. Pipeline starts. ✓

### 3. Subtask path (mismatch scenario)

```
session/prompt.ts:1628 (isSubtask = true)
  └─ parts = [{ type: "subtask", agent, ... }]

session/prompt.ts:1367-1370 (loop detects subtask)
  └─ handleSubtask({ task, sessionID: S1, ... })

session/prompt.ts:592-617
  └─ taskTool.execute(taskArgs, { sessionID: S1, ... })

tool/task.ts:68-98
  └─ nextSession = sessions.create({ parentID: S1 })      ← S2 (NEW session)
  └─ ops.prompt({ sessionID: nextSession.id = S2, ... })  ← S2

session/prompt.ts:1293 → loop({ sessionID: S2 })
  └─ processor.create({ sessionID: S2 })
  └─ updatePartDelta({ sessionID: S2, ... })

session/index.ts:643
  └─ bus.publish(PartDelta, { sessionID: S2, ... })       ← S2
```

**Result:** `message.part.delta` events for the subtask carry `properties.sessionID = S2`. The voice plugin's `event` function does `getOrCreate(S2)`, creating a **new** `SessionState` with `mode.active = false`. The condition `s.mode.active && !s.pipelineActive` is false. Pipeline never starts. ✗

After the subtask completes, `handleSubtask` (prompt.ts:695-713) inserts a synthetic "Summarize..." user message into **S1**. The loop continues in S1, the LLM generates a summary, and `message.part.delta` events fire with `sessionID = S1`. `getOrCreate(S1)` finds the state with `mode.active = true`. Pipeline starts for the summary. ✓

---

## Answers to Specific Questions

### Q1: Does `command.execute.before`'s `input.sessionID` match the session ID in subsequent `message.part.delta` events?

**Direct command path (non-subtask): YES.** The session ID flows unchanged:
`CommandInput.sessionID` → `prompt(sessionID)` → `loop(sessionID)` → `processor.create(sessionID)` → `updatePartDelta(sessionID)` → `bus.publish(PartDelta, { sessionID })`.

The `commandBefore` handler's `getOrCreate(input.sessionID)` and the `event` function's `getOrCreate(ev.properties.sessionID)` access the **same** `Map` entry.

**Subtask path: NO.** The `TaskTool` creates a child session (`sessions.create({ parentID: ctx.sessionID })`) and runs the LLM there. `message.part.delta` events for the child carry the child's session ID.

### Q2: Could the command be executed in a subtask with a different session ID?

**The command itself is always executed in `input.sessionID`.** But the command may **spawn** a subtask via two mechanisms:

1. **`isSubtask` flag** (prompt.ts:1628): If the command's agent has `mode: "subagent"` (or `cmd.subtask === true`), the command's user message contains a `subtask` part. The loop detects it and calls `handleSubtask()`, which calls `TaskTool.execute()`, which creates a child session.

2. **LLM calls the `task` tool** during the normal response loop. Any LLM turn in any session can call the `task` tool, which creates a child session regardless of the command configuration.

In both cases, the child session has a different ID. The parent command's `input.sessionID` is NOT the session where the subtask's LLM output fires.

**Note for `/voice` specifically:** The `commandBefore` handler (plugin.ts:221-223) replaces `output.parts` with `[{ type: "text", text: msg }]`, which **prevents** the subtask path by overwriting any subtask parts. So `/voice` always runs in the direct (non-subtask) path, and the session IDs match.

### Q3: Could `commandBefore`'s `getOrCreate(sid)` create a session state never accessed again?

**For `/voice` and `/mute`: NO.** The `commandBefore` handler:
1. Sets `mode.active = true` for `input.sessionID` (S1).
2. Replaces `output.parts` with a text part, preventing the subtask path.
3. The subsequent `prompt()` runs in S1, and `message.part.delta` events fire with `sessionID = S1`.
4. The `event` function's `getOrCreate(S1)` finds the existing state. ✓

**For subtask-producing commands with voice already active: YES (partially).** If voice mode was previously enabled for S1 (via an earlier `/voice`), and the user then runs a command or prompt that triggers a subtask (S2), the subtask's `message.part.delta` events fire with `sessionID = S2`. `getOrCreate(S2)` creates a **new** state with `mode.active = false`. The S1 state (with `mode.active = true`) is not accessed during the subtask — only when the post-subtask summary fires in S1.

### Q4: Is there a way to verify this at runtime? What logging would confirm the mismatch?

**Yes.** Add targeted logging to the voice plugin:

```typescript
// In commandBefore (plugin.ts:196):
const commandBefore = async (input, output) => {
  if (input.command === "voice" || input.command === "mute") {
    const sid = input.sessionID
    console.log(`[voice] commandBefore: command=${input.command} sid=${sid}`)
    const s = getOrCreate(sid)
    // ... toggle logic ...
    console.log(`[voice] commandBefore: mode.active=${s.mode.active} for sid=${sid}`)
    // ...
  }
}

// In event (plugin.ts:92):
async function event(input) {
  const ev = input.event as any
  if (ev.type === "message.part.delta") {
    const sid = ev.properties?.sessionID
    const s = sessions.get(sid)
    const existed = !!s
    const active = s?.mode.active ?? false
    console.log(`[voice] event delta: sid=${sid} existed=${existed} mode.active=${active}`)
    // If existed=false or active=false, this confirms the mismatch:
    // the delta's sessionID differs from the one commandBefore set active.
  }
  // ...
}
```

**What to look for in the logs:**
- If `commandBefore` logs `sid=S1, mode.active=true` and `event` logs `sid=S2, existed=false, mode.active=false` for the same turn → **mismatch confirmed** (subtask scenario).
- If `commandBefore` logs `sid=S1` and `event` logs `sid=S1, existed=true, mode.active=true` → **no mismatch** (direct path).

**Alternative: Bus-level tracing.** Subscribe to the Bus and log every `message.part.delta` event's `sessionID` alongside the `command.execute.before` trigger's `input.sessionID`. A diff between the two for the same user turn confirms the mismatch.

---

## Plugin Contract Analysis

The `command.execute.before` hook signature (`packages/plugin/src/index.ts:261-264`):

```typescript
"command.execute.before"?: (
  input: { command: string; sessionID: string; arguments: string },
  output: { parts: Part[] },
) => Promise<void>
```

**Does `input.sessionID` refer to the same session the LLM will use?**

**Yes, for the direct path.** `input.sessionID` is `CommandInput.sessionID` (from the HTTP URL param), and the subsequent `prompt()` call uses the same `input.sessionID` (prompt.ts:1656). The LLM's response fires `message.part.delta` events in this session.

**No, for the subtask path.** The `prompt()` call uses `input.sessionID`, but if the command produces a `subtask` part (via `isSubtask`), the loop calls `handleSubtask()` → `TaskTool.execute()` → `sessions.create({ parentID })` → `prompt({ sessionID: childSessionID })`. The child session's LLM output fires `message.part.delta` with the child's ID.

The hook's `input.sessionID` is the **command-execution session** — the session the user invoked the command in. It is NOT the session where a spawned subtask's LLM runs. The plugin contract does not distinguish these; it only provides the command's session ID.

---

## Root Cause (If Subtask Output Should Be Spoken)

The voice plugin's `Map<string, SessionState>` is keyed strictly by session ID. When `TaskTool` creates a child session (`tool/task.ts:68-98`), the child has a fresh ID with no inherited `VoiceMode` state. The plugin has no parent→child propagation mechanism.

The `commandBefore` handler (plugin.ts:196-224) only sets `mode.active` for the command's session ID. It does not (and cannot, via the hook contract) know about child sessions that will be created later by the `TaskTool`.

**If the intended behavior is "voice mode applies to subtask output too,"** the fix would need to either:
1. Propagate `mode.active` from parent to child sessions when `TaskTool` creates them (requires a hook or event the voice plugin can observe — currently no such surface exists).
2. Have the `event` function check the session's `parentID` and inherit `mode.active` from the parent (requires access to `Session.Info` which is not available in the `event` hook's `input`).
3. Use `PluginInput.client` to query `session.get(sessionID)` and walk up the `parentID` chain to find an ancestor with `mode.active = true` (adds latency and a network call per delta event).

**If the intended behavior is "voice mode only speaks the parent session's output,"** then the current behavior is correct by design — subtask output is silent, and only the post-subtask summary in the parent session is spoken.

---

## Spec Deviation Note

The SDD-01 spec (`docs/specs/260727_voice-tts_sdd-01-plugin-lifecycle.md:19,88,100`) describes the intended toggle mechanism as:

> `/voice` markdown command → prompt expansion → LLM calls `voice.toggle` tool → tool's `execute` sets `mode.active = true`

The actual implementation (`plugin.ts:196-224`) uses a **different** mechanism: the `commandBefore` handler intercepts `/voice` directly via `command.execute.before`, sets `mode.active = true`, and replaces `output.parts` to short-circuit the prompt template. No `voice.md` command file exists. No LLM round-trip to call `voice.toggle` is needed.

Both mechanisms produce the same session ID alignment (S1 throughout), so this deviation does not cause the mismatch. But it is worth noting that the `commandBefore` handler's part replacement (`output.parts.length = 0; output.parts.push(...)`) is an **undocumented short-circuit** — the spec explicitly states the hook "cannot short-circuit the subsequent prompt" (SDD-01:19). The implementation works around this by mutating the `parts` array reference (which `prompt()` subsequently uses), effectively short-circuiting without a formal contract.

---

## Files Examined

| File | Key Lines | Role |
|------|-----------|------|
| `voice/plugin.ts` | 76-90 (`getOrCreate`), 92-143 (`event`), 196-224 (`commandBefore`) | Voice plugin: session state, event handling, command interception |
| `session/prompt.ts` | 1276-1294 (`prompt`→`loop`), 1305-1542 (`runLoop`), 1556-1670 (`command`), 1649-1653 (trigger) | Command execution, prompt loop, processor creation |
| `session/processor.ts` | 109-125 (`create`), 406-430 (`text-delta`), 237-248 (`reasoning-delta`) | LLM event processing, `updatePartDelta` calls |
| `session/message-v2.ts` | 489-498 (`PartDelta` event) | Bus event definition with `sessionID` |
| `session/index.ts` | 636-644 (`updatePartDelta` → `bus.publish`) | Bus publishing of part deltas |
| `tool/task.ts` | 68-98 (`sessions.create`), 132-146 (`ops.prompt` with child session) | Child session creation for subtasks |
| `plugin/index.ts` | 248-257 (Bus subscription → `event` hook) | Event delivery to plugins |
| `packages/plugin/src/index.ts` | 261-264 (`command.execute.before` contract) | Plugin hook type signature |
