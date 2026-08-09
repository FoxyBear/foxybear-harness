# SDD-01 v2: Voice System Commands

**Date:** 2026-08-06
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft v2 (supersedes `docs/specs/260727_voice-tts_sdd-01-plugin-lifecycle.md`)
**Master:** `docs/specs/260806_voice-tts_sdd-v2-00-master.md`
**Depends on:** nothing — SDD-01 v2 is first in the v2 dependency order. It defines SC-1 (VoiceConfig), SC-2 (VoiceState), and SC-5 (Abort Ownership) for the v2 architecture.

This feature spec covers the v2 voice-mode control layer: a core `Voice.Service` Effect service, native `/voice` and `/mute` system commands registered in `Command.Service`, config parsing, per-session state, barge-in abort orchestration, and the `VoiceEngine` internal API that the TTS engine implements. It refines the v2 master and inherits all cross-cutting requirements (CC-1..CC-12).

## Background (why this is a core service, not a plugin)

The v1 plugin-only architecture failed because:

1. **Plugin tools are not reliably visible to the LLM.** The tool registry caches plugin tool lists during `InstanceState.make`, before external plugins finish loading. v2 removes the toggle from the plugin `tool` hook entirely.
2. **Slash commands cannot be silent.** The command pipeline expands the command template into a user message and unconditionally calls `prompt()`, which invokes the LLM. The `command.execute.before` hook can mutate parts but cannot skip the LLM. v2 handles `/voice` and `/mute` as native system commands that return `noReply: true`.
3. **The plugin input client is v1 SDK.** It expects `{ id }` for session methods, but voice code (and the rest of the codebase) calls `{ sessionID }`. v2 uses the v2 SDK (`@opencode-ai/sdk/v2`) everywhere, whose methods expect `{ sessionID }`.

The correct boundary is:
- **Core owns:** voice-mode state, the `/voice`/`/mute` command surface, session-abort orchestration, and config validation.
- **TTS engine owns:** ElevenLabs SDK integration, sentence-boundary chunking, audio sink, and audio-tag vocabulary (via system-prompt injection).

This spec defines the core side. The engine side is SDD-03 v2 and SDD-04 v2.

---

## WHAT

Behavioral requirements. Literal `WHEN`/`SHALL` tokens are machine-checkable. Cross-cutting references in parentheses.

1. **WHEN** the opencode instance initializes, `Voice.Service` **SHALL** be constructed as an Effect service in the instance layer and **SHALL** be available to `SessionPrompt.command`, the Bus event subscription, and the TTS engine. `Voice.Service` **SHALL** own the per-session `VoiceState` (SC-2). (CC-1, CC-9, SC-2)

2. **WHEN** `Command.Service` builds the command registry, it **SHALL** register `"voice"` and `"mute"` as native system commands with `source: "system"`, empty templates, no `subtask` flag, and no markdown or config-command loading. (CC-9, SC-2)

3. **WHEN** `SessionPrompt.command` receives `input.command === "voice"` or `input.command === "mute"`, it **SHALL** handle them in a native branch that runs **before** `commands.get(input.command)`, bypassing template expansion and the `command.execute.before` hook. It **SHALL** call `Voice.Service.toggle(input.sessionID)` or `Voice.Service.mute(input.sessionID)` and return a user message with `noReply: true` containing a one-line confirmation. The LLM **SHALL NOT** be invoked for these commands. (CC-9, SC-2)

4. **WHEN** `Voice.Service` loads, it **SHALL** parse its configuration source into a `VoiceConfig` (SC-1) applying the documented defaults for every unspecified key. The validator **SHALL** reject `stability: "robust"` with an actionable error message. The ElevenLabs API key **SHALL** be read from `process.env[config.apiKeyEnv]` when `connect(sessionID)` is first called and **SHALL NOT** be stored in the config object or any config file. (CC-7, SC-1)

5. **WHEN** `voiceId` is missing or empty, `Voice.Service` **SHALL** keep `mode === "off"` for every session, **SHALL NOT** attempt an ElevenLabs connection, and **SHALL** emit a `voice.warning` Bus event indicating voice is disabled due to invalid config. The text session **SHALL** continue unimpaired. (CC-5, CC-7, SC-1, SC-2)

6. **WHEN** `/voice` is invoked and config is valid, `Voice.Service` **SHALL** validate engine constructability before flipping `mode` to `"on"`. Optimistic acknowledgment while a connect attempt is in flight (`engine === "connecting"`) is permitted. **Any** construction failure, config-validation failure, or terminal connect failure **SHALL** revert `mode` to `"off"`, write a `VoiceStatePart` with `outcome: "rejected"` and an actionable reason, and emit an `engine_unavailable` Bus event. (CC-5, SC-2)

7. **WHEN** the ElevenLabs SDK reports a connection failure and the TTS engine's retry budget is exhausted, `Voice.Service` **SHALL** transition `mode` to `"off"` and `engine` to `"failed"` for that session, stop any in-flight audio, and emit a `voice.status` Bus event. The user's text session **SHALL** continue unimpaired. (CC-5, SC-2)

8. **WHEN** a new user turn is submitted for a session whose `mode === "on"` and Katya is speaking (`engine === "speaking"`), `Voice.Service` **SHALL** call `engine.stop(sessionID, "immediate")` and then `sdk.session.abort({ sessionID })` using the v2 SDK client. It **SHALL NOT** construct or hold its own `AbortController` for the LLM stream. (CC-6, CC-12, SC-5)

9. **WHEN** the instance disposes, `Voice.Service` **SHALL** run teardown for all active sessions: call `engine.disconnect(sessionID)` so audio tails complete, clear all per-session `VoiceState` entries, and release the v2 SDK abort handle. (SC-2, SC-5)

10. **WHEN** `VoiceState` changes for any session, `Voice.Service` **SHALL** publish a `voice.status` Bus event reflecting the full `VoiceState`. (CC-5, SC-2)

11. **WHEN** `Voice.Service` receives a `session.deleted` Bus event for a session, it **SHALL** clear that session's `VoiceState` entry, stop its audio, and disconnect its engine. No `VoiceState` entry **SHALL** outlive its session. (SC-2)

12. **WHEN** the instance layer constructs `Voice.Service`, it **SHALL** provide a `VoiceEngine` implementation via factory. `Voice.Service` **SHALL** call the engine's `connect(sessionID)`, `synthesize(sessionID, textStream, options)`, `stop(sessionID, urgency)`, and `disconnect(sessionID)` as defined in the `VoiceEngine` contract. (CC-1, CC-9)

13. **WHEN** `VoiceConfig.autoStart` is true and config is valid, `Voice.Service` **SHALL** expose an internal `autoStart(sessionID)` method that SDD-02 v2 calls on the first assistant text delta; this method transitions `mode` to `"on"` for that session without requiring an explicit `/voice`. (SC-2, SC-3)

---

## HOW

### `Voice.Service` interface

```typescript
export interface VoiceService {
  readonly toggle: (sessionID: string) => Effect.Effect<string>
  readonly mute: (sessionID: string) => Effect.Effect<string>
  readonly bargeIn: (sessionID: string) => Effect.Effect<void>
  readonly autoStart: (sessionID: string) => Effect.Effect<void>
  readonly feedText: (sessionID: string, delta: string) => Effect.Effect<void>
  readonly getState: (sessionID: string) => Effect.Effect<VoiceState>
  readonly getEngineStatus: (sessionID: string) => Effect.Effect<EngineStatus>
}
```

Internal-only methods (not exposed on the public interface but part of the service implementation): teardown, `session.deleted` handler, engine event consumer.

### `VoiceStatePart` persistence

Every transition — including no-ops and rejections — writes a persisted structured system part into session history and emits a Bus event.

```typescript
type VoiceStatePart = {
  type: "voice.state"
  id: PartID
  messageID: MessageID
  sessionID: SessionID
  ts: number              // wall-clock, audit only
  seq: number             // per-session monotonic; authoritative ordering
  transition: {
    trigger:
      | "command:/voice"
      | "command:/mute"
      | "barge-in"
      | "config"
      | "engine-failure"
      | "teardown"
      | "autoStart"
    from: VoiceState
    to: VoiceState
    outcome: "applied" | "noop" | "rejected"
    reason?: string        // required when outcome != "applied"
  }
  text: string            // deterministic confirmation or reason text
  synthetic: true
}
```

Resume/replay rules:
- Replay reconstructs state from the last part in `seq` order (not `ts`).
- When `outcome === "rejected"`, `to` SHALL equal `from`.
- Engine substate is never restored from history; it re-derives from `"disconnected"`.
- The `text` is service-authored and deterministic; it enters LLM context on the next turn automatically.
- `VoiceStatePart` is model-visible (`synthetic: true`) because the LLM needs to know voice state on the next turn.

### Command semantics

| Command | Current state | Result | Confirmation text |
|---|---|---|---|
| `/voice` | `mode === "off"`, engine constructable | `mode → "on"`, `output → "unmuted"`, `engine → "connecting"` | "Voice on." |
| `/voice` | `mode === "on"` | `mode → "off"`, `output → "unmuted"`, stop playback | "Voice off." |
| `/mute` | `mode === "on"`, `output === "unmuted"` | `output → "muted"`, stop playback | "Muted." |
| `/mute` | `mode === "on"`, `output === "muted"` | no-op | "Already muted." |
| `/mute` | `mode === "off"` | pure no-op | "Voice mode is off; /mute has no effect until voice is enabled." |

Rules:
- Repeated `/voice` or `/mute` in the same direction are no-ops.
- Per-session command handling is serialized.
- `/voice` during `engine === "connecting"` is acknowledged optimistically; a second `/voice` no-ops.
- `/mute` during `engine === "speaking"` is immediate and idempotent.
- Engine failure automatically transitions `mode → "off"` and `engine → "failed"`, so the user never sees `mode === "on"` with `engine === "failed"`.

### Native command handling in `SessionPrompt.command`

The native branch runs before `commands.get`:

```typescript
const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
  if (input.command === "voice" || input.command === "mute") {
    const voice = yield* Voice.Service
    const text = input.command === "voice"
      ? yield* voice.toggle(input.sessionID)
      : yield* voice.mute(input.sessionID)
    return yield* prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      parts: [{ type: "text", text }],
      noReply: true,
    })
  }

  const cmd = yield* commands.get(input.command)
  // ... existing command path
})
```

`Command.Info.source` is extended to include `"system"`:

```typescript
source: z.enum(["command", "mcp", "skill", "system"]).optional()
```

### Command registration

`Command.Service` registers `"voice"` and `"mute"` in its `init` function:

```typescript
commands["voice"] = {
  name: "voice",
  description: "toggle voice mode on or off",
  source: "system",
  template: "",
  hints: [],
}
commands["mute"] = {
  name: "mute",
  description: "mute voice mode",
  source: "system",
  template: "",
  hints: [],
}
```

### v2 SDK client

`Voice.Service` constructs or receives a v2 SDK client:

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
const sdk = createOpencodeClient({ /* instance-scoped */ })
```

Barge-in uses `sdk.session.abort({ sessionID })`.

### `VoiceEngine` contract

The engine is constructed by the instance layer and handed to `Voice.Service`. Exact TypeScript signatures are reference material; the behavioral rules are normative.

```typescript
export interface VoiceEngine {
  readonly connect: (sessionID: string) => Effect.Effect<void>
  readonly disconnect: (sessionID: string) => Effect.Effect<void>
  readonly synthesize: (
    sessionID: string,
    textStream: AsyncIterable<string>,
    options: { utteranceId: string },
  ) => Effect.Effect<void>
  readonly stop: (sessionID: string, urgency: "immediate" | "flush") => Effect.Effect<void>
  readonly getStatus: (sessionID: string) => EngineStatus
  readonly getCapabilities: (sessionID: string) => EngineCapabilities
  readonly events: AsyncIterable<EngineEvent & { sessionID: string }>
}

type EngineStatus = {
  ready: boolean
  speaking: boolean
  lastError?: VoiceEngineError
}

type EngineCapabilities = {
  streaming: boolean
  bargeInSupport: "none" | "synthesis_only" | "word_boundary"
  flush: boolean
  outputFormat: string
}

type EngineEvent =
  | { type: "speaking_started"; utteranceId: string }
  | { type: "speaking_ended"; utteranceId: string }
  | { type: "speaking_interrupted"; utteranceId: string }
  | { type: "speaking_failed"; utteranceId: string; error: VoiceEngineError }
  | { type: "status_changed"; status: EngineStatus }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "synth_accepted"; utteranceId: string }

type VoiceEngineError = {
  code: "connection_refused" | "auth_failed" | "synthesis_failed" | "timeout" | "internal"
  message: string
  retryable: boolean
}
```

Behavioral rules:
- `connect` is idempotent and validates provider availability.
- `synthesize` resolves on acceptance; `options.utteranceId` is required.
- `stop(sessionID, "immediate")` halts audio immediately; `stop(sessionID, "flush")` requests a graceful end-of-turn flush. If `capabilities().flush === false`, `Voice.Service` treats `stop("flush")` as `stop("immediate")` and records the degradation.
- `disconnect(sessionID)` implies `stop(sessionID, "immediate")` and graceful teardown.
- One active synthesis per session by default; new synthesis replaces the current one only via explicit service policy.
- `Voice.Service` only invokes methods and reads capability flags that are defined in `EngineCapabilities`. There are no optional hooks in the base `VoiceEngine` contract.

| EngineEvent / Status | Current `VoiceState.engine` | New `VoiceState.engine` |
|---|---|---|
| `connect(sessionID)` called | `disconnected` | `connecting` |
| `status_changed { ready: true }` | `connecting` | `ready` |
| `speaking_started` | `ready` | `speaking` |
| `stop(sessionID, "immediate")` called | `speaking` | `stopping` |
| `speaking_ended` / `speaking_interrupted` | `stopping` | `ready` |
| `speaking_failed` | any | `failed` → `mode: "off"` |
| `disconnect(sessionID)` called | any | `disconnected` |

### Barge-in protocol

1. Trigger signals `Voice.Service`.
2. `Voice.Service` transitions `engine → "stopping"` and calls `engine.stop(sessionID, "immediate")`.
3. `Voice.Service` calls `sdk.session.abort({ sessionID })`.
4. Engine reports terminal outcome via `events`; `Voice.Service` reconciles state and writes a `VoiceStatePart { trigger: "barge-in" }`.

Ordering: `engine.stop(sessionID, "immediate")` MUST precede `session.abort`.

Error cases:
- If `engine.stop` fails before `abort` is called: log, proceed to call `abort`; after abort completes, force `disconnect()` and transition `engine → "failed"`.
- If `abort` fails after `stop` succeeded: audio is stopped, generation continues; emit `voice.bargeIn.partial`.

### Tap wiring

SDD-02 v2 calls `Voice.Service.feedText(sessionID, delta)` for each assistant text delta when `mode === "on"`. `Voice.Service` accumulates deltas and forwards completed text/sentences to `engine.synthesize(sessionID, textStream, options)`. On barge-in, `Voice.Service` also signals the tap to terminate its async iterable.

### Bus events

`Voice.Service` subscribes directly to `Bus.Service` for:
- `session.deleted` — clear state.
- `message.part.delta` — for `autoStart` detection.

`Voice.Service` publishes:
- `voice.status` — on every state transition; payload `{ sessionID, state: VoiceState }`.
- `voice.warning` — on config errors or missing API key; payload `{ sessionID, message }`.
- `voice.bargeIn.partial` — when abort fails after stop succeeds.

### Concurrency rules

Precedence under racing triggers:
1. Explicit user `/voice` or `/mute`
2. Session close / teardown
3. Input-driven barge-in
4. Engine / provider failures

### Teardown ordering

On instance shutdown, `Voice.Service.disconnect(sessionID)` runs before session teardown so audio tails complete. Per-session state is created on first voice interaction and removed on session end. Mid-synthesis session destruction triggers `stop(sessionID, "immediate")` → `disconnect(sessionID)`; errors are logged and surfaced via Bus event, never silently swallowed.

### State machine

All transitions flow through a single `transition(sessionID, trigger, mutator)` method. Invalid states (e.g., `mode === "on"` with `engine === "failed"`) are rejected at the transition boundary; engine failure automatically transitions `mode → "off"` first. A state-transition diagram SHALL be included in the implementation README.

### Layer wiring

`Voice.Service` is constructed in the instance layer and provided to `SessionPrompt.command` by adding its Layer to `SessionPrompt.defaultLayer` (or the equivalent instance composition). The `VoiceEngine` factory is injected at construction time; `Voice.Service` never imports provider SDKs.

### Reuse map

| Concern | Anchor | Reuse |
|---|---|---|
| Command registration | `packages/opencode/src/command/index.ts:76-190` | Add `"voice"` and `"mute"` to `commands` record with `source: "system"` |
| Command source enum | `packages/opencode/src/command/index.ts:34-52` | Extend `source` enum with `"system"` |
| Native command branch | `packages/opencode/src/session/prompt.ts:1556-1696` | Add early branch before `commands.get(input.command)` |
| v2 SDK client | `packages/opencode/src/cli/cmd/tui/context/sdk.tsx:1-30` | `createOpencodeClient` from `@opencode-ai/sdk/v2` |
| Session abort endpoint | `packages/opencode/src/server/instance/session.ts:385-413` | `POST /:sessionID/abort` → `SessionPrompt.cancel` |
| Effect service pattern | `packages/opencode/src/command/index.ts:74-75` | `Context.Service` + `Layer.effect` |
| Bus service | `packages/opencode/src/bus/` | `Voice.Service` adds its own `bus.subscribe(...)` consumer |

### What is explicitly NOT built

- No plugin `tool` hook for `voice.toggle` / `voice.mute`.
- No markdown command files for `/voice` / `/mute`.
- No `command.execute.before` short-circuit.
- No v1 SDK usage for new code.
- No ElevenLabs connection management in core (owned by TTS engine).
- No audio playback / player spawning in core (owned by TTS engine).
- No LLM stream tap in core (owned by SDD-02 v2).
- No audio tag stripping or expressivity in core (owned by SDD-05 v2).

---

## VERIFY

Acceptance criteria for independent agents, exercising `Voice.Service` against a **mocked TTS engine** and a **real (stubbed-prompt) session** for the abort path. All tests run from `packages/opencode`.

### Test harness

- Construct `Voice.Service` in tests with an injected `InMemoryVoiceEngine`.
- Capture Bus events via a test `Bus.Service` or an in-memory subscriber.
- For V8 (barge-in abort), mock the v2 SDK client so `sdk.session.abort({ sessionID })` records its call without a real HTTP round-trip.

### Criteria

- **V1 — `Voice.Service` is an Effect service and owns state.** Setup: instance layer with `Voice.Service` provided. Action: retrieve the service and call `getState(sessionID)` for a new session. Expected: returns `{ mode: "off", output: "unmuted", engine: "uninitialized" }`; service is reachable from `SessionPrompt.command` context.

- **V2 — `voice` and `mute` registered as system commands.** Setup: `Command.Service` initialized. Action: call `Command.Service.get("voice")` and `Command.Service.get("mute")`. Expected: both return `Info` with `source: "system"`, empty template, no `subtask`; no markdown or config-command file is read.

- **V3 — native command branch skips LLM and toggles state.** Setup: `SessionPrompt.command` with `input.command = "voice"`, session S inactive. Action: invoke command. Expected: `Voice.Service.getState(S).mode === "on"`; returned message has `noReply: true`; LLM loop is NOT invoked; confirmation text is returned.

- **V4 — config parses with defaults and validates.** Setup: options with only `{ voiceId: "vX" }`. Action: initialize `Voice.Service`. Expected: parsed `VoiceConfig` matches v1 defaults; `stability: "robust"` rejected.

- **V5 — missing `voiceId` keeps voice inactive.** Setup: options `{}`. Action: initialize service and call `toggle(S)`. Expected: state stays `mode: "off"`; `voice.warning` event emitted; no engine `connect` call.

- **V6 — `/voice` fail-closed on missing API key.** Setup: valid config, env unset. Action: `toggle(S)`. Expected: `mode` does not stay `"on"`; `VoiceStatePart` with `outcome: "rejected"` and reason; `voice.warning` event emitted.

- **V7 — deactivation on connection failure.** Setup: S active, engine mock configured to report failure. Action: trigger failure event. Expected: `mode === "off"`, `engine === "failed"`; audio stop signal emitted; `VoiceStatePart` recorded.

- **V8 — barge-in calls v2 SDK `session.abort` with stop-before-abort ordering.** Setup: S active and `engine === "speaking"`; instrumented v2 SDK client. Action: `Voice.Service.bargeIn(S)`. Expected: `engine.stop(S, "immediate")` called before `sdk.session.abort({ sessionID: S })`; terminal engine event received.

- **V9 — teardown clears all state on instance disposal.** Setup: two active sessions S1, S2. Action: dispose instance. Expected: `engine.disconnect` called for both (before session teardown); `VoiceState` map empty.

- **V10 — status indicator fires on transitions.** Setup: status subscriber instrumented. Action: drive activate, first audio chunk, stream completion, barge-in, connection failure, `/mute`. Expected: `voice.status` event on each transition.

- **V11 — `session.deleted` clears that session's state.** Setup: S1 active, S2 active. Action: inject `session.deleted` for S1. Expected: S1 cleared; S2 untouched.

- **V12 — TTS engine factory and lifecycle callbacks.** Setup: mock `VoiceEngine`. Action: construct service with engine, toggle S on, feed text stream. Expected: `connect(S)` called; `synthesize(S, stream, { utteranceId })` called; `stop(S, "immediate")` called on `/mute`; `disconnect(S)` on disposal.

- **V13 — `autoStart` activates on first assistant text delta.** Setup: `autoStart: true`. Action: call `Voice.Service.autoStart(S)` (as SDD-02 v2 would). Expected: `mode` flips to `"on"`; engine `connect(S)` called.

- **V14 — concurrency/idempotency matrix.** Setup: instrumented state machine. Action: drive the matrix — `/voice` during connect, `/mute` during speech, double-toggle, barge-in + `/mute` race, teardown during speech. Expected: each resolves to the defined state; no duplicate `connect()`; no stuck states.

- **V15 — `InMemoryVoiceEngine` contract test.** Setup: implement `InMemoryVoiceEngine` implementing the required `VoiceEngine` surface. Action: run the contract test suite. Expected: all tests pass, including concurrent stop/synthesize, synthesize-after-disconnect, disconnect-during-synthesis, and full transition matrix.

- **V16 — build/regression green (CC-8).** `bun run typecheck` passes and `bun test` is fully green.
