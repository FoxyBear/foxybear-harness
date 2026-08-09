# Voice Command Diagnosis: `/voice` Slash Command Path

**Date:** 2026-08-06
**Status:** Diagnosis complete — root cause identified
**Scope:** Why `/voice` command sends "Voice toggled." to the LLM instead of being handled silently

---

## Executive Summary

The `command.execute.before` hook **cannot prevent LLM invocation**. It fires before `prompt()` is called but has no mechanism to skip it. The `prompt()` function is unconditionally called for every command, creating a user message from the (possibly mutated) parts and invoking the LLM loop. The only short-circuit path (`noReply: true`, prompt.ts:1292) exists in `PromptInput` but is never wired into `CommandInput` or the `command()` function. There is no "silent command" pattern in the current architecture — every command sends its template to the LLM.

---

## 1. Step-by-Step Trace: User Types `/voice`

### Step 1 — Command lookup (prompt.ts:1556-1565)

`SessionPrompt.command(input)` is called with `input.command = "voice"`, `input.arguments = ""`.

`commands.get("voice")` retrieves the command `Info` from the registry. The command was loaded from `~/.config/opencode/commands/voice.md` via `Config.command` (command/index.ts:107-120). Its template is the body of the markdown file after frontmatter:

```
Voice toggled.
```

### Step 2 — Template expansion (prompt.ts:1570-1604)

The template `"Voice toggled."` is processed:
- No `$N` placeholders, no `$ARGUMENTS`, no shell backtick matches.
- `template = "Voice toggled."` (trimmed).

### Step 3 — Prompt parts resolution (prompt.ts:1627)

`resolvePromptParts(template)` converts the string into parts (prompt.ts:122-154):
- No `@file` references in the template.
- Returns `[{ type: "text", text: "Voice toggled." }]`.

### Step 4 — Parts construction (prompt.ts:1629-1640)

`voice.md` has no `subtask` field, and the default agent is not in `"subagent"` mode, so `isSubtask = false`:

```typescript
const parts = [...templateParts, ...(input.parts ?? [])]
// parts = [{ type: "text", text: "Voice toggled." }]
```

This creates a **new array** containing the template parts.

### Step 5 — `command.execute.before` hook fires (prompt.ts:1649-1653)

```typescript
yield* plugin.trigger(
  "command.execute.before",
  { command: "voice", sessionID, arguments: "" },
  { parts },   // ← shorthand for { parts: parts } — wraps the array reference
)
```

The `output` object is a **new wrapper** `{ parts: parts }`, but `output.parts` **is the same array reference** as the local `parts` variable.

The voice plugin's `commandBefore` handler fires (voice/plugin.ts:196-224):

```typescript
const commandBefore = async (input, output) => {
  if (input.command === "voice" || input.command === "mute") {
    // ... toggle voice state ...
    output.parts.length = 0              // ← clears the shared array IN PLACE
    output.parts.push({ type: "text", text: msg })  // ← adds to the shared array
  }
}
```

Because the hook mutates the array **in place** (`.length = 0` + `.push()`), the mutation **does** reach the local `parts` variable. After the hook:
- If voice was OFF → `parts = [{ type: "text", text: "Voice on." }]`
- If voice was ON → `parts = [{ type: "text", text: "Voice off." }]`

**Important:** If the hook does NOT fire (plugin not loaded, validation failed, handler not registered), `parts` remains `[{ type: "text", text: "Voice toggled." }]` — the original template content.

### Step 6 — `prompt()` is called UNCONDITIONALLY (prompt.ts:1655-1662)

```typescript
const result = yield* prompt({
  sessionID: input.sessionID,
  messageID: input.messageID,
  model: userModel,
  agent: userAgent,
  parts,              // ← the (possibly mutated) parts array
  variant: input.variant,
  // NOTE: noReply is NOT passed — not even a field in CommandInput
})
```

`prompt()` is called regardless of what the hook did. There is no check of a return value, no conditional skip.

### Step 7 — Inside `prompt()` (prompt.ts:1276-1294)

```typescript
const prompt = Effect.fn("SessionPrompt.prompt")(function* (input: PromptInput) {
  const session = yield* sessions.get(input.sessionID)
  yield* revert.cleanup(session)
  const message = yield* createUserMessage(input)    // ← creates USER message from parts
  yield* sessions.touch(input.sessionID)
  // ... permission setup ...

  if (input.noReply === true) return message         // ← ONLY short-circuit (line 1292)
  return yield* loop({ sessionID: input.sessionID }) // ← LLM loop invoked (line 1293)
})
```

- `createUserMessage(input)` (prompt.ts:918) creates a **user message** (role: "user") from `input.parts`. The text "Voice toggled." (or "Voice on." if the hook fired) becomes a user message in the session.
- `input.noReply` is `undefined` (never passed by `command()`), so the short-circuit at line 1292 does NOT fire.
- `loop()` is called, which invokes `runLoop()` (prompt.ts:1305), which enters the LLM agent loop.

### Step 8 — LLM responds

The LLM receives the conversation history including the new user message containing the command text. The LLM sees "Voice toggled." (or "Voice on.") as a user message and **responds to it** — generating an assistant reply like "I've toggled voice mode for you" or similar.

---

## 2. Can `command.execute.before` Prevent LLM Invocation?

### **NO.** With evidence.

The hook fires at prompt.ts:1649, **before** `prompt()` is called at prompt.ts:1655. But:

1. **The hook's output type is `{ parts: Part[] }`** (plugin/src/index.ts:261-264). It can only modify parts — there is no `noReply`, `skip`, `cancel`, or `abort` field.

2. **The trigger return value is not used for control flow.** The `trigger()` function (plugin/index.ts:263-276) returns `output`, but the caller at prompt.ts:1649 does `yield*` without capturing the return value:
   ```typescript
   yield* plugin.trigger("command.execute.before", input, { parts })
   // return value discarded
   ```

3. **No conditional check after the trigger.** After the trigger call, `prompt()` is called unconditionally (prompt.ts:1655-1662). There is no `if (shouldSkip) return` or equivalent.

4. **The only short-circuit (`noReply: true`, prompt.ts:1292) is unreachable from commands.**
   - `CommandInput` (prompt.ts:1827-1847) does NOT include a `noReply` field.
   - The `command()` function (prompt.ts:1655-1662) does NOT pass `noReply` to `prompt()`.
   - The `command.execute.before` hook output (`{ parts: Part[] }`) has no `noReply` field.

5. **Throwing from the hook would abort with an error, not skip silently.** The trigger uses `yield* Effect.promise(async () => fn(input, output))` (plugin/index.ts:273). If `fn` throws, the effect fails and propagates up — the command would error out, not skip the LLM gracefully.

---

## 3. Why the LLM Sees "Voice toggled."

There are two scenarios, both resulting in the LLM being invoked:

### Scenario A: Hook fires successfully

The plugin IS loaded (confirmed: `.opencode/opencode.jsonc` registers `"../packages/opencode/src/voice/plugin.ts"` with valid config). Config validation passes (`voiceId` is set, `stability: "natural"` is valid). The `commandBefore` handler fires and mutates `parts` in-place from `"Voice toggled."` to `"Voice on."` or `"Voice off."`.

**Result:** The LLM sees "Voice on." (or "Voice off.") as a user message and responds to it. The voice state IS toggled correctly, but the LLM generates an unnecessary response.

### Scenario B: Hook does not fire

If the plugin fails to load or `createVoicePlugin` returns early (voice/plugin.ts:35-43 — validation failure returns `{ event: async () => {} }` without `command.execute.before`), the hook never fires. Parts remain the original template content.

**Result:** The LLM sees "Voice toggled." as a user message and responds to it. Voice state is NOT toggled.

### Which scenario is happening?

The user reports seeing "Voice toggled." — the exact template text. This suggests **Scenario B** (hook not firing) OR the user is describing the general symptom (LLM responds to command text regardless of which text).

However, the config appears valid, so the plugin should load. If the user is seeing "Voice toggled." specifically, possible causes:
- Plugin loaded but `command.execute.before` handler not registered (check if `createVoicePlugin` early-returns)
- Instance state mismatch (plugin loaded for a different directory context)
- The `getOrCreate(sid)` call inside `commandBefore` throws (e.g., `AudioSink` constructor fails), causing the hook to error out before mutating parts

**In all cases, the root cause is the same:** even if the hook fires perfectly and mutates parts, `prompt()` is still called and the LLM is still invoked.

---

## 4. How Other Commands Avoid This Problem

### They don't. ALL commands go through the LLM.

**`/init`** (command/index.ts:87-95):
- Template: `initialize.txt` content (guides AGENTS.md setup).
- `subtask`: not set → `isSubtask = false`.
- Goes through `prompt()` → LLM. **Intentional** — the LLM is meant to help set up the file.

**`/review`** (command/index.ts:96-105):
- Template: `review.txt` content (code review instructions).
- `subtask: true` → `isSubtask = true`.
- Parts become a `subtask` part (prompt.ts:1629-1639), dispatched to a subagent.
- Goes through `prompt()` → LLM (as subtask). **Intentional** — the LLM performs the review.

**MCP prompts** (command/index.ts:122-150):
- Template fetched from MCP server.
- Goes through `prompt()` → LLM. **Intentional** — MCP prompts are designed for the LLM.

**Skill commands** (command/index.ts:152-163):
- Template is skill content.
- Goes through `prompt()` → LLM. **Intentional** — skills inject instructions for the LLM.

### Key insight

The entire command system was designed for commands that produce **prompts for the LLM**. Every command — `/init`, `/review`, MCP prompts, skills — sends its template to the LLM. There is no precedent for a "side-effect-only" command that toggles state without LLM involvement.

The `command.execute.before` hook was designed to **modify** the prompt before LLM invocation, not to **skip** it.

---

## 5. Does `output.parts` Mutation Reach `prompt()`?

### **YES** — if done in-place.

The trigger is called with `output = { parts }`, which is shorthand for `output = { parts: parts }`. The `output.parts` property IS the same array reference as the local `parts` variable.

```typescript
// prompt.ts:1640, 1649-1653
const parts = [...templateParts, ...(input.parts ?? [])]  // new array

yield* plugin.trigger(
  "command.execute.before",
  { command, sessionID, arguments },
  { parts },  // output.parts === parts (same reference)
)

// After trigger: parts variable still points to the same array,
// which the hook may have mutated in-place.

const result = yield* prompt({ parts, ... })  // prompt receives mutated array
```

The voice plugin's mutation technique:
```typescript
output.parts.length = 0                          // clears shared array in-place ✓
output.parts.push({ type: "text", text: msg })   // adds to shared array in-place ✓
```

This **works** — `prompt()` receives the mutated array.

**What would NOT work:**
```typescript
output.parts = [{ type: "text", text: msg }]  // reassignment ✗
// This changes output.parts to point to a NEW array,
// but the local `parts` variable still points to the OLD array.
// prompt() would receive the original unmutated parts.
```

---

## 6. Root Cause Diagnosis

### Primary Root Cause

**The command system has no mechanism for "silent" commands that perform side effects without LLM invocation.**

The flow is structurally hard-wired:

```
command() → expand template → build parts → command.execute.before hook → prompt() → LLM loop
```

There is no branch between the hook and `prompt()` that can skip the LLM. The `noReply` flag (the only LLM-skip mechanism) exists in `PromptInput` but is:
- Absent from `CommandInput` (prompt.ts:1827-1847)
- Never passed by `command()` to `prompt()` (prompt.ts:1655-1662)
- Absent from the `command.execute.before` hook output type (`{ parts: Part[] }`)

### Secondary Issue

Even if the hook fires and mutates parts from "Voice toggled." to "Voice on.", the LLM still receives "Voice on." as a user message and generates a response. The mutation changes WHAT the LLM sees, but not WHETHER the LLM is invoked.

### Why the Previous Tool-Based Approach Worked

When the LLM called a `voice.toggle` **tool**, the tool executed as a side effect within the LLM loop. The tool's return value ("Voice on.") went back to the LLM as a tool result, not as a user message. The LLM could then acknowledge it or ignore it. The tool approach works because it operates WITHIN the LLM loop, not as a command that feeds INTO it.

### Architectural Mismatch

The `/voice` slash command is being used as a **system control toggle** (like `/clear` or `/compact`), but it's being processed through the **prompt-generation command pipeline** (like `/init` or `/review`). These are fundamentally different use cases:

| Aspect | Prompt commands (`/init`, `/review`) | Control commands (`/voice`, `/clear`) |
|--------|--------------------------------------|---------------------------------------|
| Purpose | Generate LLM prompt | Perform system side effect |
| LLM needed? | Yes | No |
| User message? | Yes (the prompt) | No (should be silent) |
| Response expected? | Yes (LLM acts on prompt) | No (system acknowledges) |

The command system only supports the first column.

---

## 7. Potential Fix Directions (Not Prescribed)

For reference — the diagnosis above identifies the problem. Fix options would need separate evaluation:

1. **Wire `noReply` through `CommandInput`**: Add `noReply` to `CommandInput`, pass it to `prompt()`. The `command.execute.before` hook would need an output field to signal it. Requires changes to `CommandInput`, `command()`, hook output type, and the trigger caller.

2. **Short-circuit in `command()` after the hook**: Check a hook output flag (e.g., `output.skipLLM`) before calling `prompt()`. If true, create the user message via `createUserMessage` with `noReply: true` and return early. Requires changes to hook output type and `command()`.

3. **TUI-level intercept**: Intercept `/voice` in the TUI/client before it reaches `SessionPrompt.command()`. Handle the toggle entirely client-side. No server/command changes needed, but splits logic across layers.

4. **Revert to tool-based approach**: Keep `voice.toggle` as an LLM tool. The LLM calls it when the user says "turn on voice" in natural language. Works within the existing architecture but requires the LLM to cooperate.

---

## File References

| File | Key Lines | Role |
|------|----------|------|
| `packages/opencode/src/session/prompt.ts` | 1556-1670 | `command()` function — the command execution pipeline |
| `packages/opencode/src/session/prompt.ts` | 1276-1294 | `prompt()` function — creates user message, invokes LLM loop, `noReply` short-circuit |
| `packages/opencode/src/session/prompt.ts` | 1827-1847 | `CommandInput` schema — no `noReply` field |
| `packages/opencode/src/command/index.ts` | 87-105 | `/init` and `/review` command definitions |
| `packages/opencode/src/plugin/index.ts` | 263-276 | `trigger()` function — calls hooks, returns output |
| `packages/opencode/src/voice/plugin.ts` | 196-224 | `commandBefore` handler — toggles state, mutates `output.parts` |
| `packages/opencode/src/voice/plugin.ts` | 35-43 | Early return paths — returns minimal Hooks without `command.execute.before` |
| `packages/plugin/src/index.ts` | 261-264 | `command.execute.before` hook signature — output is `{ parts: Part[] }` only |
| `.opencode/opencode.jsonc` | plugin field | Voice plugin registration (local file path + config) |
| `~/.config/opencode/commands/voice.md` | full file | Command template: `"Voice toggled."` |
