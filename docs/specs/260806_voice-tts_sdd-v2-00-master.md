# SDD-00 Master v2: Katya Voice TTS Module — System-Command Architecture

**Date:** 2026-08-06
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft v2 (supersedes `260727_voice-tts_sdd-00-master.md`; pending independent audit + human gate)
**Model tier:** authored at top tier

This is the master spec for Katya's Text-to-Speech (TTS) module, v2. It supersedes the v1 master (`docs/specs/260727_voice-tts_sdd-00-master.md`) and the v1 plugin-lifecycle spec (`docs/specs/260727_voice-tts_sdd-01-plugin-lifecycle.md`). The v2 redesign is driven by three diagnosed failures of the v1 plugin-only architecture:

1. **Tool visibility:** external plugin tools were not reliably visible to the LLM tool list because the tool registry cached plugin state before external plugins finished loading.
2. **Command-path mismatch:** `/voice` and `/mute` were processed through the prompt-generation command pipeline, forcing an unnecessary LLM round-trip and relying on the `command.execute.before` hook, which cannot skip the LLM.
3. **SDK parameter mismatch:** the plugin input client was constructed from the v1 SDK (`@opencode-ai/sdk`), whose session methods expect `{ id }`, while voice code called `{ sessionID }`, causing literal `{id}` to be sent in URLs and failing schema validation.

v2 resolves these by making voice-mode state a **first-class core service** and `/voice`/`/mute` **native system commands**. The TTS engine (ElevenLabs + audio sink) remains modular but is constructed by the instance layer and handed to `Voice.Service` through a stable internal API. All session operations use the v2 SDK (`@opencode-ai/sdk/v2`), whose methods expect `{ sessionID }`.

## Architecture

### Problem being solved

Katya runs inside the FoxyBear CLI as a text-based assistant. Todd wants her to speak with human expressivity. The v1 architecture attempted to do this entirely through opencode's plugin system. That approach failed at the seams listed above. v2 keeps the TTS engine modular but moves the **voice-mode toggle** and **session-abort orchestration** into core, where they belong.

### Scope: TTS output path + voice-mode control

This spec suite covers:
- The TTS output path: LLM text tokens → ElevenLabs TTS → audio playback.
- Voice-mode state and the `/voice` / `/mute` toggle commands.
- Barge-in cancellation of the LLM stream when the user interrupts.

STT input path remains out of scope.

### Target shape

```
User types /voice or /mute
  └─► TUI calls sdk.session.command({ sessionID, command: "voice" })  [v2 SDK]
        └─► server/instance/session.ts POST /:sessionID/command
              └─► SessionPrompt.command
                    └─► native branch runs before Command.Service lookup
                          └─► Voice.Service.toggle(sessionID) / .mute(sessionID)
                                └─► updates VoiceState (core-owned)
                                └─► notifies TTS engine via VoiceEngine contract

User types a prompt while voice is on
  └─► LLM streams tokens via Bus events
        ├─► TUI renders text (tags stripped)
        └─► Voice.Service receives text deltas and forwards them to the TTS engine
              └─► ElevenLabs SDK stream() per sentence
                    └─► audio chunks
                          └─► Audio Sink
                                └─► 🔊 Katya speaks

User interrupts (new turn / barge-in)
  └─► Voice.Service.bargeIn(sessionID)
        ├─► engine.stop(sessionID, "immediate")
        ├─► sdk.session.abort({ sessionID })  [v2 SDK]
        └─► engine reports terminal outcome via events
```

### Why system commands, not plugin tools

The command system in opencode has no "silent side-effect command" path for plugins. Every command template is expanded into a user message and sent to the LLM. The `command.execute.before` hook can mutate the message parts but cannot skip the LLM. Making `/voice` and `/mute` native system commands lets `SessionPrompt.command` handle them directly, set state, and return a `noReply: true` user message — no LLM invocation, no tool visibility problem.

### Why a core voice service

Voice-mode state must be:
- Available synchronously to `SessionPrompt.command`.
- Observable by the Bus event fan-out so the TTS engine can start/stop.
- Scoped per-session and cleaned up on session deletion / instance disposal.
- Able to call `sdk.session.abort({ sessionID })` with the correct v2 SDK parameter shape.

A core `Voice.Service` (Effect service, `Context.Tag`) satisfies all of these.

### Why factory construction, not registration

The v1 failure was a read-before-write race: the tool registry read plugin tools before plugins finished loading. v2 does not "fix" that race — it stops running it. `Voice.Service` receives its `VoiceEngine` dependency through the Effect layer at construction time, via a factory that constructs the default ElevenLabs engine in-tree. There is no window in which the service exists but its engine is "not yet registered." Provider lazy-loading happens inside the fully-wired engine as a state transition, not as a load-order race between independently-lifecycled modules.

External or plugin engines remain possible later, but they are explicitly out of the critical path.

### Why the TTS engine stays modular

The ElevenLabs integration, sentence-boundary chunking, voice settings, retry logic, and audio sink are large, provider-specific modules. They are not part of opencode core's domain. v2 keeps them in a dedicated TTS engine module that implements the `VoiceEngine` interface and is constructed by the instance layer. `Voice.Service` never imports provider SDKs.

## Cross-Cutting Requirements

These apply to all feature specs in the v2 suite. Each is testable.

- **CC-1 No fork required for TTS engine.** The TTS engine (ElevenLabs + sink) SHALL operate through a stable internal API exposed by `Voice.Service`. No modifications to opencode core source files are required to add or replace the TTS engine.
- **CC-2 Expressivity is the core feature.** Same as v1: audio tags SHALL render as audible expressivity.
- **CC-3 TUI text and spoken audio are independent streams.** Same as v1.
- **CC-4 No blocking.** Same as v1.
- **CC-5 Graceful degradation.** Same as v1.
- **CC-6 Barge-in (audio cutoff).** WHEN a new user turn is submitted while Katya is speaking, the system SHALL call `engine.stop(sessionID, "immediate")` before calling `sdk.session.abort({ sessionID })` via the v2 SDK.
- **CC-7 Config-driven.** Same as v1, but config is read by `Voice.Service` and passed to the registered TTS engine.
- **CC-8 No broken tests.** Same as v1.
- **CC-9 Reuse before building.** Implementations SHALL reuse the existing `Command.Service` registration, `SessionPrompt.command` native branch, v2 SDK `createOpencodeClient`, and direct `Bus.Service` subscription.
- **CC-10 Latency budget.** Same as v1.
- **CC-11 No secret exposure.** Same as v1.
- **CC-12 v2 SDK only for session operations.** `Voice.Service` and the TTS engine SHALL use `@opencode-ai/sdk/v2` for all session operations (`session.command`, `session.abort`, event subscription). The v1 SDK SHALL NOT be used for new code.

## Security Invariants

- **VI-1 Voice Dispatch Isolation.** Voice-state transitions (`mode`, `output`) are reachable ONLY through native command dispatch in `SessionPrompt.command`, except for two `Voice.Service`-owned paths: `autoStart` on first assistant text delta and barge-in reconciliation. No model-generated content — assistant text, tool call, tool result, or streamed token — SHALL invoke `Voice.Service.toggle` or `Voice.Service.mute`. Any future feature exposing voice control to the LLM is an explicit, reviewed relaxation of VI-1.
- **VI-1 scoping guard.** VI-1 covers control-plane integrity only. Injected text reaching the stream tap MAY still be spoken; content safety is a separate concern.

## Non-Goals

The following are explicitly out of scope for v2 to prevent `Voice.Service` bloat:
- Cross-restart persistence of voice-mode state (config layer only; future work).
- Expressivity prompt authoring beyond invoking the existing plugin hooks.
- Pronunciation-dictionary editing workflows.
- Provider tuning UIs or per-provider configuration beyond `VoiceConfig`.
- Generic multimodal policy (image/video generation remains plugin-based).

## Phased Delivery

| Phase | Scope | Deliverable |
|---|---|---|
| Phase 0 | SDK abort fix | Replace v1 abort call with v2 SDK `sdk.session.abort({ sessionID })`; ships independently |
| Phase 1 | Core service + native commands | `Voice.Service`, native `/voice`/`/mute`, persisted `VoiceStatePart`, state model, no-engine behavior |
| Phase 2 | Engine contract + hardening | Expanded `VoiceEngine` interface, factory construction, barge-in protocol, concurrency rules, teardown ordering, test doubles |

## Shared Contract

### SC-1: VoiceConfig

Same schema as v1. Owned by `Voice.Service`. Referenced by all specs.

```typescript
type VoiceConfig = {
  apiKeyEnv: string         // default: "ELEVENLABS_API_KEY"
  voiceId: string           // default: "xVQH621DS3eyBYrseRt5"
  modelId: string           // default: "eleven_v3"
  stability: "creative" | "natural" | "robust"
  speed: number             // 0.7–1.2 (default: 1.0)
  similarityBoost: number  // 0–1 (default: 0.75)
  speakerBoost: boolean     // default: true
  style: number             // 0-1 (default: 0)
  language: string           // default: "en"
  playerPreference?: string
  pronunciationDictionaryId?: string
  pronunciationDictionaryVersionId?: string
  outputFormat: string      // default: "mp3_44100_128"
  tagEmissionTempBoost: boolean
  tagEmissionTempDelta: number
  maxSentenceRetries: number
  autoStart: boolean
}
```

### SC-2: VoiceState

Owned by `Voice.Service`. State is per-session and in-process; it does not persist across daemon restarts. The state has three orthogonal dimensions:

```typescript
type VoiceState = {
  mode: "off" | "on"                // user intent: is voice enabled?
  output: "unmuted" | "muted"       // playback muted? meaningful only when mode=on
  engine:
    | "uninitialized"
    | "disconnected"
    | "connecting"
    | "ready"
    | "speaking"
    | "stopping"
    | "failed"
}
```

Binding rules:
- `/voice` toggles `mode`; `/mute` toggles `output` only when `mode === "on"`.
- `output` resets to `"unmuted"` on every `mode` off→on cycle.
- `mode === "on"` with `engine === "failed"` is an invalid persistent state; a terminal engine failure SHALL transition `mode` to `"off"`.
- All transitions SHALL flow through a single `transition()` method that validates state changes and emits the persisted `VoiceStatePart` + Bus event atomically.
- Engine substate is not restored from history on resume; it re-derives from `"disconnected"`. The persisted `engine` field is advisory/audit-only.

### SC-3: Text Stream (LLM → TTS)

Owned by SDD-02 v2. Same semantics as v1, but the tap receives events from the Bus and forwards them to `Voice.Service` via `Voice.Service.feedText(sessionID, delta)` or an equivalent internal API.

### SC-4: Audio Chunk Stream (TTS → Speaker)

Owned by SDD-04 v2. Same `AudioChunk` type as v1.

### SC-5: Abort Ownership

Owned by `Voice.Service`. Barge-in flows through `sdk.session.abort({ sessionID })` using the v2 SDK. The TTS engine and audio sink receive stop signals from `Voice.Service`; they do not call `session.abort` themselves.

### SC-6: Audio Tag Vocabulary

Owned by SDD-05 v2. Same vocabulary as v1.

## Dependency Order

1. **SDD-01 v2: Voice System Commands** — `Voice.Service`, native `/voice`/`/mute`, `VoiceEngine` API, config parsing, state management, teardown, barge-in abort ownership.
2. **SDD-02 v2: LLM Stream Tap** — Bus subscription, async iterable adapter, TUI tag stripping.
3. **SDD-03 v2: ElevenLabs TTS Streaming** — SDK HTTP stream lifecycle, sentence chunking. (Created during implementation phase; not required for gate.)
4. **SDD-04 v2: Audio Playback Sink** — player detection, stdin-pipe streaming. (Created during implementation phase; not required for gate.)
5. **SDD-05 v2: Expressivity** — system prompt sections, tag vocabulary, pronunciation dictionary. (Created during implementation phase; not required for gate.)

## Glossary

- **Voice.Service.** Core Effect service that owns voice-mode state and orchestrates the TTS engine.
- **VoiceEngine.** The interface implemented by the TTS engine module (ElevenLabs + sink) and constructed by the instance layer.
- **System command.** A command registered in `Command.Service` with `source: "system"` and handled natively by `SessionPrompt.command` without LLM invocation.
- Other terms same as v1.

## Open Questions

1. **Packaging of the TTS engine.** Should it remain an internal plugin or become a core-adjacent module? The `VoiceEngine` interface decouples this decision.
2. **Subtask voice inheritance.** Same as v1: child sessions do not inherit voice mode unless explicitly propagated by `Voice.Service`.

## Tracked Fast-Follow Tickets

| Ticket | Description | Graduation trigger |
|---|---|---|
| **TTS-FF-001** | R2 metadata detection | Same as v1 |
| **TTS-FF-002** | R4 v2-import verification | N/A — v2 is the architecture |
| **TTS-FF-003** | R6 sustained-latency / long-session integration testing | Same as v1 |
