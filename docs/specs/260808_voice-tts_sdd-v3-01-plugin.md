# SDD-01 v3: Voice Plugin

**Date:** 2026-08-08
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft v3 (pending independent audit + human gate)
**Master:** `docs/specs/260808_voice-tts_sdd-v3-00-master.md`
**Depends on:** nothing — SDD-01 is first in the dependency order. Defines SC-1 (VoiceConfig), SC-2 (VoiceMode), SC-5 (Abort Ownership).

This feature spec covers the plugin's lifecycle: internal plugin registration, config parsing from the `voice` field in FoxyBearFields, per-session voice-mode state, `/voice` and `/mute` as plugin tools, the `event` hook subscription for PartDelta/PartUpdated, `autoStart`, barge-in, teardown, and the `noReply` wiring for silent commands. It inherits all cross-cutting requirements (CC-1..CC-12).

## Background

v3 returns to the v1 plugin approach. The three diagnosed v1 failures are fixed with targeted changes:

1. **Tool visibility** — the voice plugin is an **internal plugin**, added to `INTERNAL_PLUGINS` in `packages/opencode/src/plugin/index.ts` (line 58). Internal plugins load synchronously during `init`, before the tool registry caches. No race.
2. **Silent commands** — `noReply` is wired through `CommandInput` → `command()` → `prompt()`. The `command.execute.before` hook output gains an optional `noReply: boolean`. When set to `true`, `prompt()` short-circuits at line 1293 — no LLM invocation.
3. **SDK parameter shape** — the plugin imports `@opencode-ai/sdk/v2` for `session.abort`.

No Effect service. No VoiceEngine interface. No state machine. The plugin is a plain async function that returns `Hooks` with `event`, `tool`, `experimental.text.complete`, and `experimental.chat.system.transform` handlers. State is a `Map<SessionID, VoiceMode>` in module scope.

### The `noReply` core change (~10 lines)

This is the ONLY core modification in v3. It enables silent commands without native command registration:

1. **`PromptInput`** (`packages/opencode/src/session/prompt.ts` ~line 1733) — already has `noReply: z.boolean().optional()`. No change needed to `PromptInput`.
2. **`CommandInput`** (`packages/opencode/src/session/prompt.ts` ~line 1828) — does NOT have `noReply`. No change needed — the value comes from the hook output, not the command input.
3. **`command.execute.before` hook output** (`packages/plugin/src/index.ts:261-264`) — add `noReply?: boolean` to the output type.
4. **`command()` function** (`packages/opencode/src/session/prompt.ts` ~line 1650) — the current code calls `yield* plugin.trigger("command.execute.before", ...)` without capturing the return value. Change it to `const output = yield* plugin.trigger("command.execute.before", ...)` and pass `noReply: output.noReply === true` to `prompt()`. The `prompt()` function already has the short-circuit at line 1293 (`if (input.noReply === true) return message`).

This is ~10 lines of change to `command()` and 1 line to the hook output type. It does NOT add a native command branch, does NOT register voice/mute in `Command.Service`, and does NOT import any voice module into core.

---

## WHAT

1. **WHEN** the opencode plugin loader initializes, the voice plugin **SHALL** be loaded as an internal plugin via the `INTERNAL_PLUGINS` array in `packages/opencode/src/plugin/index.ts` (line 58). The plugin **SHALL** register via the `Plugin` type, returning a `Hooks` object with `event`, `tool`, `experimental.text.complete`, and `experimental.chat.system.transform` hooks. (CC-1, CC-9)

2. **WHEN** the plugin loads, it **SHALL** read its configuration from the `voice` field in FoxyBearFields (`packages/opencode/src/config/foxybear.ts`) and parse it into a `VoiceConfig` (SC-1) applying documented defaults. The validator **SHALL** reject `stability: "robust"` with an actionable error. The ElevenLabs API key **SHALL** be read from `process.env[config.apiKeyEnv]` at activation time and **SHALL NOT** be stored in config files. (CC-7, SC-1)

3. **WHEN** `voiceId` is missing or empty, the plugin **SHALL** register successfully (hooks live) but **SHALL** keep `VoiceMode.active = false` for every session and **SHALL** emit a TUI warning. The text session **SHALL** continue unimpaired. (CC-5, SC-1, SC-2)

4. **WHEN** the plugin is loaded, it **SHALL** maintain one `VoiceMode` (SC-2) per session, keyed by `sessionID`, in a module-level `Map<string, VoiceMode>`. State **SHALL NOT** persist across daemon restarts. Concurrent sessions **SHALL** have independent `VoiceMode` instances. (SC-2)

5. **WHEN** the `voice.toggle` tool (registered via the plugin `tool` hook) is called for a session, its `execute` **SHALL** flip `VoiceMode.active` and return a confirmation string. The `voice.toggle` and `voice.mute` tools are callable by the LLM in natural conversation (e.g., "turn on voice"). **WHEN** the user types `/voice` or `/mute`, the `command.execute.before` hook (requirement 7) handles it directly with `noReply: true` — the LLM is NOT invoked. The tools and the `noReply` hook are two independent toggle surfaces: the `noReply` hook is the user-facing command path (no LLM round-trip), the tools are the LLM-facing programmatic surface. (SC-2)

6. **WHEN** the `voice.mute` tool is called for a session whose `VoiceMode.active` is true, its `execute` **SHALL** set `active = false`, stop in-flight audio, and return a confirmation. **WHEN** called on an already-inactive session, it **SHALL** be a no-op that still confirms. (SC-2)

7. **WHEN** the `command.execute.before` hook fires for command `"voice"` or `"mute"`, the plugin **SHALL** set `output.noReply = true` and mutate `output.parts` to contain a one-line confirmation. The `command()` function **SHALL** pass `noReply: true` to `prompt()`, which short-circuits at line 1293 — no LLM invocation, no visible user message in the TUI beyond the confirmation text. (CC-1)

8. **WHEN** the plugin receives a `message.part.updated` event with `part.type === "text"`, the plugin **SHALL** record that `partID` in a per-session `Set<PartID>` of text parts. **WHEN** a `message.part.delta` event arrives, the plugin **SHALL** forward the delta ONLY if its `partID` is in the text-parts set. This is an include-only-text filter — reasoning deltas, tool-call deltas, file-part deltas **SHALL** be dropped. The `field` property does NOT distinguish part types (both text and reasoning carry `field === "text"`). (SC-3)

9. **WHEN** `VoiceConfig.autoStart` is true and config is valid, the plugin **SHALL** activate voice on the first assistant **text** delta (partID in text-parts set) for a session, without requiring an explicit `/voice`. Non-text deltas **SHALL NOT** trigger activation. (SC-2, SC-3)

10. **WHEN** `VoiceMode.active` transitions to true, the plugin **SHALL** resolve the API key from `process.env[config.apiKeyEnv]`; if absent, the plugin **SHALL NOT** activate, **SHALL** set `active = false`, and **SHALL** fall back to text-only mode. (CC-5, SC-2)

11. **WHEN** a new user turn is submitted for a session whose `VoiceMode.active` is true and Katya is speaking, the plugin **SHALL** call `client.session.abort({ sessionID })` via the **v2 SDK** (`@opencode-ai/sdk/v2`). The audio-sink stop (owned by SDD-03) **SHALL** fire in parallel. The plugin **SHALL NOT** construct its own `AbortController` for the LLM stream. (CC-6, CC-12, SC-5)

12. **WHEN** the plugin receives `input.event.type === "server.instance.disposed"` via its `event` hook, the plugin **SHALL** run teardown for all active sessions: stop audio, clear state, release resources. (SC-2)

13. **WHEN** the plugin receives `input.event.type === "session.deleted"` via its `event` hook, the plugin **SHALL** clear that session's `VoiceMode` entry, stop its audio, and stop its TTS stream. (SC-2)

14. **WHEN** the `experimental.text.complete` hook fires at `text-end`, the plugin **SHALL** strip SC-6 audio tags from the returned text so the TUI never displays them. This stripping **SHALL** run whenever the plugin is loaded, regardless of voice mode. (CC-3, SC-6)

15. **WHEN** the `experimental.chat.system.transform` hook fires, the plugin **SHALL** append the Enhance section and Katya Tone Guide to `output.system`. This **SHALL** run regardless of voice mode. (CC-2)

---

## HOW

### Internal plugin registration

Add the voice plugin to `INTERNAL_PLUGINS` in `packages/opencode/src/plugin/index.ts` (line 58):

```typescript
const INTERNAL_PLUGINS: PluginInstance[] = [
  // ... existing plugins ...
  VoicePlugin,
]
```

The voice plugin is imported at the top of `plugin/index.ts` and added to the array. It loads synchronously during `init`, before the tool registry caches. No race.

### Plugin module

The plugin lives in `packages/opencode/src/voice/plugin.ts` (internal, not a separate npm package). Its `server` export matches `Plugin`:

- Receives `(input: PluginInput, options?: PluginOptions)`.
- Returns `Hooks` with: `event` (PartDelta/PartUpdated/SessionDeleted/InstanceDisposed + autoStart + status), `tool` (`voice.toggle` + `voice.mute`), `command.execute.before` (noReply for /voice and /mute), `experimental.text.complete` (tag stripping), `experimental.chat.system.transform` (expressivity).

### Config parsing (SC-1)

Read from the `voice` field in FoxyBearFields. Validation: `voiceId` non-empty, `stability !== "robust"`. On failure, register but stay inactive.

### Voice mode state (SC-2)

A `Map<SessionID, VoiceMode>` in module scope. Defaults: `{ active: false, sessionId: null, playing: false, connected: false }`.

### `/voice` and `/mute` dispatch

Two mechanisms:
1. **`command.execute.before` hook** — for commands `"voice"` and `"mute"`, set `output.noReply = true` and mutate `output.parts` to contain the confirmation text. This makes the command silent (no LLM invocation). The `command()` function passes `noReply` to `prompt()`.
2. **`voice.toggle` / `voice.mute` tools** — registered via the `tool` hook. Callable by the LLM directly. The primary programmatic surface.

### Include-only-text filter via PartUpdated correlation

The plugin maintains a per-session `Set<PartID>` of text parts. When `message.part.updated` arrives with `part.type === "text"`, add the `partID` to the set. When `message.part.delta` arrives, forward ONLY if the `partID` is in the text-parts set. This is the critical learning: `field === "text"` is NOT enough — you MUST correlate with PartUpdated.

### Barge-in (SC-5)

Barge-in is triggered by `session.status` Bus events with `status.type === "busy"`. On detection:
1. Call `client.session.abort({ sessionID })` via `@opencode-ai/sdk/v2`.
2. Stop the audio sink (kill player + close stdin).
3. Clear the TTS buffer.
These fire in parallel.

### Teardown

Event-driven via the `event` hook:
- `server.instance.disposed` → stop all audio, clear all state.
- `session.deleted` → clear that session's state, stop its audio.

### Reuse map

| Concern | Anchor | Reuse |
|---|---|---|
| Internal plugin registration | `packages/opencode/src/plugin/index.ts:58` | Add to `INTERNAL_PLUGINS` array |
| Plugin entry signature | `packages/plugin/src/index.ts:75` | `export type Plugin = (input, options?) => Promise<Hooks>` |
| Bus event delivery | `packages/opencode/src/plugin/index.ts:248-257` | `event` hook fan-out |
| `command.execute.before` hook | `packages/plugin/src/index.ts:261-264` | Add `noReply?: boolean` to output |
| `noReply` short-circuit in prompt | `packages/opencode/src/session/prompt.ts:1293` | Already exists; just wire it |
| Session abort (v2 SDK) | `@opencode-ai/sdk/v2` | `createOpencodeClient` → `sdk.session.abort({ sessionID })` |
| `experimental.text.complete` | `packages/plugin/src/index.ts:325-328` | Tag stripping at text-end |
| `experimental.chat.system.transform` | `packages/plugin/src/index.ts:290-295` | System prompt injection |
| PartDelta event type | `packages/opencode/src/session/message-v2.ts:489-498` | `MessageV2.Event.PartDelta` |
| PartUpdated event type | `packages/opencode/src/session/message-v2.ts:479-488` | `MessageV2.Event.PartUpdated` |
| Assistant text emit | `packages/opencode/src/session/processor.ts:423-429` | `text-delta` case |
| Reasoning emit (same field) | `packages/opencode/src/session/processor.ts:241-247` | `reasoning-delta` case |

### What is explicitly NOT built

- No Effect service for voice — the plugin manages its own simple state.
- No VoiceEngine interface — direct function calls to ElevenLabs SDK.
- No 7-state engine state machine — simple `VoiceMode` with 4 fields.
- No Bus subscriptions — use the plugin `event` hook.
- No native system command registration in `Command.Service`.
- No `VoiceStatePart` persistence.
- No `EventQueue<T>` custom async iterable.

---

## VERIFY

Acceptance criteria for independent agents. Each item maps 1:1 to WHAT requirements.

- **V1 — internal plugin loads and returns Hooks (req 1, CC-1).** Setup: opencode instance with voice plugin in `INTERNAL_PLUGINS`. Action: start opencode. Expected: plugin's `server` export called with `(input, options)`; returned object has `event`, `tool`, `command.execute.before`, `experimental.text.complete`, `experimental.chat.system.transform` hooks; `tool` contains `voice.toggle` and `voice.mute`.

- **V2 — config parses with defaults (req 2, SC-1).** Setup: `voice` config with only `{ voiceId: "vX" }`. Action: load the plugin. Expected: parsed `VoiceConfig` has all SC-1 defaults; `stability === "natural"`, `modelId === "eleven_v3"`, `voiceId === "vX"`; `stability: "robust"` rejected with actionable error.

- **V3 — missing voiceId registers but stays inactive (req 3, CC-5).** Setup: config `{}` (no `voiceId`). Action: load plugin, inject a `message.part.delta`. Expected: hooks are live; `VoiceMode.active` is false; no TTS stream opened; TUI warning emitted.

- **V4 — per-session state, no cross-session bleed (req 4, SC-2).** Setup: two sessions S1, S2; activate S1. Action: inspect S2's `VoiceMode`. Expected: S2 `active === false`; after restart, S1's state is gone.

- **V5 — voice.toggle flips state (req 5, SC-2).** Setup: session S inactive. Action: call `voice.toggle`'s `execute`. Expected: `active === true`; confirmation returned. Action B: call `voice.mute`'s `execute`. Expected: `active === false`; audio stopped.

- **V6 — voice.mute deactivates, no-op when inactive (req 6, SC-2).** Setup: S active. Action A: call `voice.mute`. Expected: `active === false`; audio stopped. Action B: call `voice.mute` again. Expected: no-op, still confirms.

- **V7 — noReply suppresses LLM for /voice and /mute (req 7, CC-1).** Setup: instrument `prompt()` to record calls. Action: invoke `/voice` command. Expected: `prompt()` called with `noReply: true`; `prompt()` short-circuits at line 1293; LLM loop NOT invoked; no user message created beyond the confirmation.

- **V8 — include-only-text filter via PartUpdated correlation (req 8, SC-3).** Setup: voice active for S1. Action: replay (a) `message.part.updated` for `partID=R` with `part.type === "reasoning"`, then (b) `message.part.delta` for `partID=R` with `field: "text"`, then (c) `message.part.updated` for `partID=T` with `part.type === "text"`, then (d) `message.part.delta` for `partID=T`. Expected: reasoning delta (b) dropped despite `field === "text"`; text delta (d) forwarded; text-parts set contains T but not R.

- **V9 — autoStart on first assistant text delta (req 9, SC-2/SC-3).** Setup: `autoStart: true`, valid config. Action A: replay reasoning delta. Expected: stays inactive. Action B: replay text delta. Expected: activates on first text delta.

- **V10 — activation resolves API key, falls back when absent (req 10, CC-5).** Setup: valid config, `process.env.ELEVENLABS_API_KEY` unset. Action: trigger activation. Expected: `active === false`; TUI status shows voice off; text session continues.

- **V11 — barge-in calls v2 SDK session.abort (req 11, CC-6/CC-12/SC-5).** Setup: S active and playing; v2 SDK client instrumented. Action: fire barge-in. Expected: `sdk.session.abort({ sessionID: S })` called via v2 SDK; audio sink stopped in parallel; no own `AbortController` for LLM stream.

- **V12 — teardown on server.instance.disposed (req 12, SC-2).** Setup: two active sessions. Action: inject `server.instance.disposed`. Expected: all audio stopped; `VoiceMode` map empty. Note: in production, `server.instance.disposed` races with the Plugin scope close (the event stream fiber may be interrupted before the handler completes). The plugin does best-effort cleanup. The VERIFY tests the handler by direct injection; production delivery is best-effort.

- **V13 — session.deleted clears state (req 13, SC-2).** Setup: S1, S2 active. Action: inject `session.deleted` for S1. Expected: S1 cleared; S2 untouched.

- **V14 — experimental.text.complete strips tags (req 14, CC-3/SC-6).** Setup: plugin loaded, voice inactive. Action: invoke `experimental.text.complete` with `"Hmm [sighs] that was rough. [laughs] Done."`. Expected: returned text has tags removed. Repeat with voice active: identical result.

- **V15 — experimental.chat.system.transform injects prompts (req 15, CC-2).** Setup: plugin loaded. Action: trigger system transform hook. Expected: `output.system` contains Enhance section and Katya Tone Guide.

- **V16 — build/regression green (CC-8).** `bun run typecheck` passes and `bun test` is green (excluding known-baseline failures).
