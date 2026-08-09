# SDD-02..05 v2: Engine Spec Amendments

**Date:** 2026-08-06
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft v2 amendment
**Master:** `docs/specs/260806_voice-tts_sdd-v2-00-master.md`
**Depends on:** SDD-01 v2 (`docs/specs/260806_voice-tts_sdd-v2-01-system-commands.md`)

This feature spec amends the v1 specs SDD-02 through SDD-05 (`docs/specs/260727_voice-tts_sdd-02-llm-stream-tap.md` through `docs/specs/260727_voice-tts_sdd-05-expressivity.md`) to reflect the v2 architecture in which voice-mode state and `/voice`/`/mute` commands are owned by a core `Voice.Service`. It does not reproduce the full text of those specs; it lists the normative changes required to make them consistent with v2.

---

## WHAT

1. **WHEN** the v2 architecture is active, the LLM stream tap (SDD-02) **SHALL** gate forwarding on `Voice.Service.getState(sessionID).mode === "on"` and **SHALL NOT** maintain its own voice-mode state map. The tap **SHALL NOT** expose `voice.toggle` or `voice.mute` tools and **SHALL NOT** rely on the `command.execute.before` hook.

2. **WHEN** the v2 architecture is active, the ElevenLabs TTS module (SDD-03) **SHALL** implement the `VoiceEngine` interface, **SHALL** be factory-constructed by the instance layer and handed to `Voice.Service`, and **SHALL** report playback lifecycle via the `VoiceEngine.events` observable channel. The module **SHALL NOT** call `session.abort` directly and **SHALL NOT** expose `voice.toggle` or `voice.mute` tools.

3. **WHEN** the v2 architecture is active, the audio playback sink (SDD-04) **SHALL** be owned by the TTS engine module, **SHALL** receive `play(sessionID, audioStream)` and `stop(sessionID)` calls from the engine, and **SHALL** report playback status through the engine's `events` channel.

4. **WHEN** the v2 architecture is active, the expressivity module (SDD-05) **SHALL** continue injecting the Enhance section and Katya Tone Guide through the `experimental.chat.system.transform` hook and **SHALL** continue boosting temperature through the `chat.params` hook. The expressivity module **SHALL NOT** own `/voice`/`/mute` or `VoiceState`.

5. **WHEN** any TTS engine module implements the `VoiceEngine` interface, it **SHALL** implement the required surface and **SHALL** follow the binding behavioral rules: flush fallback, capability guard, one-active-synthesis per session, and terminal-outcome reporting.

6. **WHEN** `Voice.Service` calls `synthesize(sessionID, textStream, options)`, the engine **SHALL** resolve on acceptance and **SHALL** report playback lifecycle via `events` keyed by `options.utteranceId`.

7. **WHEN** `Voice.Service` needs to stop audio, it **SHALL** call `stop(sessionID, urgency)` where `urgency` is `"immediate"` or `"flush"`. If the engine advertises `capabilities().flush === false`, `Voice.Service` **SHALL** treat `stop(sessionID, "flush")` as `stop(sessionID, "immediate")` and record the degradation.

8. **WHEN** the system needs to verify the `VoiceEngine` contract without a live provider, an `InMemoryVoiceEngine` test double **SHALL** exist and **SHALL** implement the full required `VoiceEngine` surface.

---

## HOW

### SDD-02 v2: LLM Stream Tap

#### Ownership changes

- All references to "the plugin maintains `VoiceMode`" or "SDD-01 owns `VoiceMode`" read "`Voice.Service` owns `VoiceState`".
- The tap gates forwarding on `Voice.Service.getState(sessionID).mode === "on"`.
- The tap receives Bus events through the existing plugin `event` hook and forwards text deltas to `Voice.Service.feedText(sessionID, delta)`.

#### Removed v1 surfaces

- The tap does not expose `voice.toggle` or `voice.mute` tools.
- The tap does not rely on the `command.execute.before` hook.
- The tap does not hold its own `AbortController` for the LLM stream; barge-in is signaled by `Voice.Service`.

#### Added v2 surfaces

- The tap calls `Voice.Service.feedText(sessionID, delta)` for each assistant text delta when `mode === "on"`. When `mode === "on"` and `output === "muted"`, the tap continues forwarding text; muting suppresses playback downstream, not synthesis.
- The tap accepts a `stopTap(sessionID)` signal from `Voice.Service` to terminate the active async iterable on barge-in.

### SDD-03 v2: ElevenLabs TTS Streaming

#### Ownership changes

- The ElevenLabs module implements the `VoiceEngine` interface and is factory-constructed by the instance layer, then handed to `Voice.Service`.
- The module reports playback lifecycle via the `VoiceEngine.events` observable channel; `Voice.Service` derives `engine` substate from these events.
- The module receives `VoiceConfig` from the instance layer at construction time.

#### Removed v1 surfaces

- The module is not responsible for `/voice` or `/mute` commands.
- The module does not call `client.session.abort` directly; barge-in is signaled by `Voice.Service`.
- The module does not expose `voice.toggle` or `voice.mute` tools.

#### Added v2 surfaces

The module implements the expanded `VoiceEngine` contract from SDD-01 v2:

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
- `connect(sessionID)` is idempotent and validates provider availability.
- `synthesize(sessionID, textStream, options)` resolves on acceptance; `options.utteranceId` is required.
- `stop(sessionID, "immediate")` halts audio immediately; `stop(sessionID, "flush")` requests a graceful end-of-turn flush. If `capabilities().flush === false`, `Voice.Service` treats `stop(sessionID, "flush")` as `stop(sessionID, "immediate")` and records the degradation.
- `disconnect(sessionID)` implies `stop(sessionID, "immediate")` and graceful teardown.
- One active synthesis per session by default; new synthesis replaces the current one only via explicit service policy.

#### Synthesize / sink ownership

- The engine owns the audio sink.
- `synthesize` resolves on acceptance; all playback lifecycle is reported via `events` keyed by `utteranceId`.
- If `capabilities().flush === false`, `Voice.Service` treats `stop(sessionID, "flush")` as `stop(sessionID, "immediate")`.

### SDD-04 v2: Audio Playback Sink

#### Ownership changes

- The sink is owned by the TTS engine module (SDD-03 v2) and receives `play(sessionID, audioStream)` and `stop(sessionID)` calls from the engine, which are triggered by `Voice.Service`.
- The sink reports playback status (`speaking_started` / `speaking_ended`) to the engine, which forwards to `Voice.Service` via `events`.

#### Removed v1 surfaces

- The sink is not responsible for barge-in detection; it only reacts to `stop()`.
- The sink is not responsible for voice-mode state.

#### Added v2 surfaces

- The sink exposes a `stop(sessionID)` method callable by the engine.
- The sink supports the `VoiceEngine` contract's `events` channel.

### SDD-05 v2: Expressivity

#### Ownership changes

- The system-prompt injection (Enhance section + Katya Tone Guide) continues to run through the plugin `experimental.chat.system.transform` hook.
- The `chat.params` temperature boost continues to run through the plugin `chat.params` hook.
- These hooks MAY be registered by a separate expressivity plugin; the spec is neutral on packaging.

#### Removed v1 surfaces

- The expressivity module does not own `/voice` or `/mute` commands.
- The expressivity module does not own `VoiceMode` state.

#### Unchanged

- The Enhance section text, Katya Tone Guide, SC-6 vocabulary, pronunciation dictionary seed, and voice-settings defaults are unchanged from v1.

### Cross-Spec Contract Summary

| Contract | v1 owner | v2 owner | Notes |
|---|---|---|---|
| `VoiceConfig` parsing | SDD-01 plugin | `Voice.Service` | Same schema |
| `VoiceState` state | SDD-01 plugin | `Voice.Service` | Core service; orthogonal dimensions |
| `/voice`, `/mute` commands | plugin `tool` | native system commands | No LLM round-trip |
| Barge-in abort | plugin calls v1 SDK | `Voice.Service` calls v2 SDK | `stop(sessionID, "immediate")` before `session.abort` |
| LLM text stream tap | plugin `event` hook | plugin hook forwarding to `Voice.Service` | Contract unchanged |
| ElevenLabs TTS | plugin module | `VoiceEngine` implementation | Factory-constructed, handed to core |
| Audio sink | plugin module | TTS engine module | Receives `stop(sessionID)` from engine |
| Expressivity prompts | plugin hooks | plugin hooks | Unchanged content |

### Mandatory Observability

All engine specs SHALL require logging/events for: command invoked, every state transition, connect/disconnect, synth accepted, playback started/completed/interrupted/failed, abort requested/completed/failed, teardown, config-validation failure. Voice bugs are timing-sensitive and undebuggable without this. The `EngineEvent` union includes `connected`, `disconnected`, and `synth_accepted` to satisfy this.

### Testability

SDD-03 v2 SHALL specify an `InMemoryVoiceEngine` in the shared package implementing the full required `VoiceEngine` surface, emitting observable state events, and injectable via Effect context. A contract test suite SHALL verify: concurrent stop/synthesize, synthesize-after-disconnect, disconnect-during-synthesis, and the full transition matrix.

### Provider Substitution

SDD-03 v2 SHALL include a "Provider Substitution" appendix proving the interface is not ElevenLabs-shaped: a local, non-streaming, offline engine (`streaming: false`, `bargeInSupport: "synthesis_only"`, barge-in latency = process-kill latency) fits the same contract via capabilities.

---

## VERIFY

- **V1 — Tap state ownership.** Setup: `Voice.Service` active with session S `mode === "on"`. Action: feed `message.part.delta` to the tap while S mode is off, then on. Expected: tap forwards only when mode is on; tap has no local voice-mode map.

- **V2 — Tap has no voice tools.** Setup: inspect tap exports / plugin hooks. Expected: no `voice.toggle` or `voice.mute` tools; no `command.execute.before` handler.

- **V3 — ElevenLabs module implements `VoiceEngine`.** Setup: instantiate module. Action: verify required methods exist and match signatures. Expected: `connect`, `synthesize`, `stop`, `disconnect`, `getStatus`, `getCapabilities`, `events` all present and session-scoped.

- **V4 — Engine reports lifecycle via events.** Setup: mock engine with controlled `events`. Action: drive `synthesize` to completion and failure. Expected: `speaking_started`, `speaking_ended`, and `speaking_failed` events emitted with matching `utteranceId` and `sessionID`.

- **V5 — Engine owns sink; synthesize resolves on acceptance.** Setup: instrument engine. Action: call `synthesize`. Expected: method resolves before playback completes; sink receives audio stream internally.

- **V6 — Flush fallback (engine-only).** Setup: engine with `capabilities().flush === false`. Action: call `stop(sessionID, "flush")`. Expected: engine treats it as `stop(sessionID, "immediate")`.

- **V7 — No unadvertised optional methods.** Setup: engine implementing only the required `VoiceEngine` surface. Action: `Voice.Service` interacts with the engine. Expected: `Voice.Service` only calls methods and reads capability flags defined in `EngineCapabilities`; no optional hooks are probed.

- **V8 — Sink ownership.** Setup: TTS engine module. Action: inspect sink references. Expected: sink is internal to engine module; `Voice.Service` does not import sink directly.

- **V9 — Expressivity hooks unchanged.** Setup: expressivity module. Action: verify `experimental.chat.system.transform` and `chat.params` hooks still inject Enhance + Tone Guide and boost temperature. Expected: same content as v1.

- **V10 — `InMemoryVoiceEngine` contract tests.** Setup: implement test double. Action: run contract suite. Expected: all tests pass, including concurrent stop/synthesize, synthesize-after-disconnect, disconnect-during-synthesis, full transition matrix.

- **V11 — Provider substitution appendix.** Setup: review SDD-03 v2 implementation docs. Expected: appendix includes a non-streaming offline engine example demonstrating capability-gated behavior.
