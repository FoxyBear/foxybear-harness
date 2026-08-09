# SDD-00 Master v3: Katya Voice TTS Module — Clean Rebuild

**Date:** 2026-08-08
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft v3 (supersedes v2 `260806_voice-tts_sdd-v2-00-master.md`; pending independent audit + human gate)
**Model tier:** authored at top tier

This is the master spec for Katya's Text-to-Speech (TTS) module, v3. It supersedes the v2 master and the v2 system-command architecture. v3 returns to the v1-style internal plugin approach with three targeted fixes that address the three diagnosed failures of v1, without the 600+ lines of over-engineered abstraction that v2 introduced. The five feature specs (SDD-01 through SDD-04) refine this document. Where a feature spec conflicts with this master, this master wins.

The v1 specs (`260727_voice-tts_sdd-*.md`) are the PRIMARY reference. The v3 specs are v1 + 3 targeted fixes. If v1 and v2 conflict, v1 wins.

## Architecture

### Problem being solved

Katya runs inside the FoxyBear CLI as a text-based assistant. Todd wants her to speak with human expressivity: laughs mid-response, pauses for emphasis, sighs, whispered asides. The v1 approach (plugin-based) worked in hours; v2 over-engineered it into a 600-line VoiceEngine abstraction that took days and still doesn't work properly.

An independent audit found that v2:
- Lost 5 core features that v1 had correctly designed (reasoning/reply filtering, sentence-boundary chunking, stdin-pipe streaming, TUI tag stripping, expressivity system prompt)
- Built 600+ lines of abstraction (VoiceEngine interface, InMemoryVoiceEngine, 7-state engine state machine, EventQueue, EngineEvent union) to solve 3 edge-case problems that each had 2-10 line fixes

**Decision: Scrap v2. Return to v1-style internal plugin approach with targeted fixes.**

### The three targeted fixes (v1 → v3)

The v2 spec identified three v1 failures. Each has a targeted fix that does NOT require the v2 architecture:

1. **Tool visibility race** — external plugin tools were not reliably visible to the LLM because the tool registry cached plugin state before external plugins finished loading.
   - **v3 fix:** Make the voice plugin an **internal plugin** — add it to `INTERNAL_PLUGINS` in `packages/opencode/src/plugin/index.ts` (line 58). Internal plugins load synchronously during `init`, before the registry caches. This is a 2-line change to the INTERNAL_PLUGINS array, not a core architecture change.

2. **Command-path mismatch** — `/voice` and `/mute` were processed through the prompt-generation command pipeline, forcing an unnecessary LLM round-trip and relying on the `command.execute.before` hook, which cannot skip the LLM.
   - **v3 fix:** Wire `noReply` through `CommandInput` properly. Add `noReply` to the `command.execute.before` hook output type. When a plugin's hook sets `noReply: true`, `command()` captures the trigger return value and passes `noReply` to `prompt()`, which already has the short-circuit at line 1293 (`if (input.noReply === true) return message`). This suppresses LLM invocation — the confirmation text is still created as a user message (visible in TUI), but `prompt()` returns immediately without entering the LLM loop. ~10-line core change, not an architecture change.

3. **SDK parameter mismatch** — the plugin input client was constructed from the v1 SDK (`@opencode-ai/sdk`), whose session methods expect `{ id }`, while voice code called `{ sessionID }`.
   - **v3 fix:** Import from `@opencode-ai/sdk/v2` in the voice plugin's abort call. The v2 SDK's methods expect `{ sessionID }`. This is a 1-line import change.

### Scope: TTS only

Same as v1: TTS output path only (LLM text → ElevenLabs → audio playback). STT is out of scope.

### Target shape

```
User types (keyboard) or speaks (future STT)
  └─► opencode session loop (unchanged)
        └─► LLM streams tokens via Bus events
              └─► message.part.delta events
                    │
                    ├─► TUI renders text (stripped of audio tags)
                    │
                    └─► TTS internal plugin event hook receives delta
                          └─► PartUpdated correlation: include-only-text filter
                                └─► sentence accumulator (buffers until . ! ? \n)
                                      └─► ElevenLabs SDK stream() per sentence (eleven_v3, HTTP)
                                            └─► audio chunks (MP3)
                                                  └─► Audio Sink (ffplay/mpv stdin pipe)
                                                        └─► 🔊 Katya speaks, expressively
```

### Why an internal plugin, not a core service

v1's plugin approach was correct. The only issue was the tool visibility race, which is fixed by making the plugin internal (loaded synchronously). The v2 approach (core Effect service, VoiceEngine interface, native commands) was built to solve 3 edge cases but lost 5 core features. v3 keeps the plugin approach and fixes the 3 edge cases with targeted changes:

- **Internal plugin registration** — add to `INTERNAL_PLUGINS` (2 lines). Fixes tool visibility without a core service.
- **`noReply` in `CommandInput`** — wire through `command()` → `prompt()` (~10 lines). Fixes silent commands without native command registration.
- **`@opencode-ai/sdk/v2` import** — correct SDK parameter shape (1 line). Fixes the `{id}` vs `{sessionID}` mismatch.

No Effect service. No VoiceEngine interface. No 7-state state machine. No EventQueue. No Bus subscriptions (use the plugin `event` hook which already receives all Bus events). The plugin manages its own simple state: `{ mode: on/off, muted: bool, playing: bool, sessionID: string }`.

### Why SDK HTTP stream, not WebSocket streaming-input

Same as v1: the WebSocket streaming-input endpoint does NOT support `eleven_v3` (returns 404, confirmed by ElevenLabs docs). The SDK's `client.textToSpeech.stream()` method (HTTP POST) supports `eleven_v3` with TTFA ~1.1s. Architecture uses sentence-boundary chunking.

**Critical SDK gotcha:** The `stream()` method expects `modelId` (camelCase). Using `model_id` (snake_case) is silently stripped — the request falls back to the default v2 model with no error, losing v3 expressivity.

## Lessons Learned (what v2 got wrong)

| v2 Addition | Lines | Why it was wrong |
|---|---|---|
| `VoiceEngine` interface | ~30 | One provider, no alternatives planned. Direct function calls suffice. |
| `InMemoryVoiceEngine` test double | 206 | Tests pass but system doesn't work — testing the wrong thing. |
| `EngineEvent` union (8 variants) | ~40 | Replaces simple callbacks with async iterables. Unnecessary indirection. |
| 7-state engine state machine | ~100 | Fragile, hard to get right. v1's 4-field `VoiceMode` delivers the same UX. |
| `VoiceStatePart` persistence spec | ~50 | Not needed for a toggle. Added spec complexity for zero value. |
| `EventQueue<T>` custom async iterable | 37 | Replaces simple callbacks. Unnecessary. |
| Native system command registration | Core mod | Heavier than needed — `noReply` in `CommandInput` is ~10 lines. |
| Bus subscriptions in voice service | Core mod | The plugin `event` hook already receives all Bus events. |
| `PartDelta` subscribed twice (copy-paste bug) | Bug | `PartUpdated` was never subscribed — reasoning text synthesized instead of reply. |
| Hardcoded `afplay` | Regression | v1 specified 12-candidate `which`-based detection. |
| No sentence chunking (buffers entire response) | Regression | v1 specified sentence-boundary chunking with chained playback. |
| Temp-file audio (not stdin-pipe) | Regression | v1 specified stdin-pipe streaming. v2 reverted to temp files. |

## Cross-Cutting Requirements

Inherited from v1 (CC-1 through CC-11), with these modifications:

- **CC-1 No fork required.** WHEN the TTS plugin is installed, the system SHALL operate entirely through opencode's plugin system (`event` hook + `PluginInput.client` + `tool` hook). The only core modification is the ~10-line `noReply` wiring in `CommandInput`/`command()` — everything else goes through the plugin system. The plugin SHALL be an internal plugin (added to `INTERNAL_PLUGINS`), not an external plugin.
- **CC-2 Expressivity is the core feature.** Same as v1.
- **CC-3 TUI text and spoken audio are independent streams.** WHEN an audio tag appears in the LLM output, the TUI SHALL strip it from the rendered text display (at `text-end` via `experimental.text.complete`), and the TTS engine SHALL receive it verbatim. The user SHALL NOT see audio tags in the final persisted text. **Known limitation:** during streaming, audio tags MAY be transiently visible in the TUI until `text-end` fires and `experimental.text.complete` rewrites the part. This transient visibility is a known cosmetic limitation — no streaming-rewrite hook exists in the plugin system, and CC-1 prevents adding one. The tag flashes briefly, then disappears on `text-end`.
- **CC-4 No blocking.** Same as v1.
- **CC-5 Graceful degradation.** Same as v1.
- **CC-6 Barge-in (audio cutoff).** WHEN a new user turn is submitted while Katya is speaking, the system SHALL stop audio playback immediately and call `client.session.abort({ sessionID })` via the v2 SDK.
- **CC-7 Config-driven.** Same as v1. Config is read from the `voice` field in FoxyBearFields (`packages/opencode/src/config/foxybear.ts`).
- **CC-8 No broken tests.** Same as v1.
- **CC-9 Reuse before building.** Implementations SHALL reuse named existing patterns (the `which`-based player detection from `sound.ts:79-83`, the plugin `event` hook for Bus subscription, the `PluginInput.client` SDK surface, `experimental.text.complete` for tag stripping, `experimental.chat.system.transform` for system prompt injection).
- **CC-10 Latency budget.** Same as v1: first audio chunk SHALL reach the speaker within 2 seconds of the first text token (spike-verified: 1.1s TTFA via SDK stream with eleven_v3).
- **CC-11 No secret exposure.** Same as v1.
- **CC-12 v2 SDK for session abort.** The voice plugin SHALL use `@opencode-ai/sdk/v2` for `session.abort` calls. The v1 SDK SHALL NOT be used for new code.

## Security Invariants

- **VI-1 Voice Dispatch Isolation.** Voice-state transitions are reachable ONLY through: (a) the `command.execute.before` hook for `/voice`/`/mute` (with `noReply`), (b) the `voice.toggle`/`voice.mute` plugin tools (which are LLM-callable by design — the LLM may call them in natural conversation), (c) the `autoStart` path (first assistant text delta), and (d) the barge-in path. No model-generated **text** content — assistant text, streamed tokens — SHALL invoke voice toggle or mute. LLM tool calls to `voice.toggle`/`voice.mute` ARE an allowed path (the tools are the programmatic surface). The prohibition is on model text content directly triggering state changes without going through the tool or command hook.
- **VI-1 scoping guard.** VI-1 covers control-plane integrity only. Injected text reaching the stream tap MAY still be spoken; content safety is a separate concern.
- **VI-2 No secret exposure.** The ElevenLabs API key SHALL NOT appear in logs, diagnostics, error surfaces, serialized config, or Bus event payloads. Audio data SHALL NOT be persisted to disk, written to logs, or exposed via any out-process interface. A missing API key SHALL fail closed with a non-secret actionable message.
- **VI-3 noReply scope.** The `noReply` flag SHALL only be set by the plugin's `command.execute.before` hook for commands `"voice"` and `"mute"`. It SHALL NOT be set for any other command. The `noReply` flag suppresses LLM invocation but does NOT suppress the user message — the confirmation text is still visible in the TUI.

## Shared Contract

### SC-1: VoiceConfig

Same schema as v1. Owned by SDD-01. Referenced by all specs. Read from the `voice` field in FoxyBearFields (`packages/opencode/src/config/foxybear.ts`, already present, KEEP).

```typescript
type VoiceConfig = {
  apiKeyEnv: string         // default: "ELEVENLABS_API_KEY"
  voiceId: string           // default: "xVQH621DS3eyBYrseRt5" (Katya, confirmed by Todd)
  modelId: string           // default: "eleven_v3"; MUST be passed as `modelId` (camelCase) to SDK stream()
  stability: "creative" | "natural" | "robust"  // default: "natural"
  speed: number             // 0.7–1.2 (default: 1.0)
  similarityBoost: number  // 0–1 (default: 0.75)
  speakerBoost: boolean     // (default: true)
  style: number              // 0-1 (default: 0)
  language: string           // default: "en"
  playerPreference?: string
  pronunciationDictionaryId?: string
  pronunciationDictionaryVersionId?: string
  outputFormat: string      // default: "mp3_44100_128"
  tagEmissionTempBoost: boolean  // default: false
  tagEmissionTempDelta: number   // default: 0 (matching foxybear.ts)
  maxSentenceRetries: number  // default: 3 (matching foxybear.ts)
  autoStart: boolean         // default: false
}
```

### SC-2: Voice Mode State

Owned by SDD-01. Simple in-process state, NOT an Effect service, NOT a 7-state machine.

```typescript
type VoiceMode = {
  active: boolean           // is TTS currently enabled for this session?
  sessionId: string | null  // the session being voiced (null if idle)
  playing: boolean          // is audio currently being played?
  connected: boolean        // is the ElevenLabs SDK client alive?
}
```

State transitions:
- `inactive → active`: `/voice` command invoked or `autoStart: true`
- `active → inactive`: `/mute` command, or `/voice` toggle, or connection failure
- `active + not playing → active + playing`: first audio chunk received
- `active + playing → active + not playing`: audio stream completed, or barge-in

State is **per-session and in-process**. It does not persist across daemon restarts.

### SC-3: Text Stream (LLM → TTS)

Same as v1. The plugin receives text deltas via the `event` hook, which fans out all Bus events including `message.part.delta`.

**Include-only-text filter via PartUpdated correlation (CRITICAL):** Both the assistant-text emit (`processor.ts:423-429`) and the reasoning emit (`processor.ts:241-247`) carry `field === "text"`. The `field` property does NOT distinguish assistant text from reasoning. The plugin SHALL maintain a per-session `Set<PartID>` of **text parts** (not reasoning parts), populated from `message.part.updated` events whose `part.type === "text"`. A `message.part.delta` SHALL be forwarded ONLY if its `partID` is in the text-parts set.

### SC-4: Audio Chunk Stream (TTS → Speaker)

Same as v1.

```typescript
type AudioChunk = {
  data: Uint8Array    // raw audio bytes (MP3 or PCM per outputFormat)
  format: string       // MIME type or format identifier
  isFinal: boolean     // true if this is the last chunk in the stream
}
```

### SC-5: Abort Ownership

Same as v1. Barge-in flows through `client.session.abort({ sessionID })` via the **v2 SDK** (`@opencode-ai/sdk/v2`). The plugin does NOT own its own `AbortController` for the LLM stream. The audio sink has a separate stop mechanism (kill the player process + close stdin) that fires in parallel.

### SC-6: Audio Tag Vocabulary

Same as v1. Owned by SDD-04 (Expressivity). Referenced by SDD-01 (plugin, for stripping) and SDD-02 (ElevenLabs, for forwarding).

## Dependency Order

1. **SDD-01: Voice Plugin** — internal plugin registration, config parsing, `/voice`/`/mute` as plugin tools, event hook for PartDelta/PartUpdated, state management, barge-in, teardown, `noReply` wiring. Defines SC-1, SC-2, SC-5.
2. **SDD-02: ElevenLabs TTS** — sentence-boundary chunking, `stream()` API, voice settings, error handling/retry. Depends on SC-1, SC-3, SC-4.
3. **SDD-03: Audio Playback Sink** — `which`-based player detection (12 candidates), stdin-pipe streaming (NOT temp file), backpressure, volume, barge-in. Depends on SC-4, SC-5.
4. **SDD-04: Expressivity** — system prompt injection, audio tag vocabulary (SC-6), pronunciation dictionary. Depends on SC-6. Can be implemented in parallel. SDD-04 exports the `AUDIO_TAG_VOCABULARY` constant; SDD-01's tag stripper imports it. SDD-04 does NOT own the tag stripper itself — SDD-01 owns the `experimental.text.complete` hook handler that strips tags from TUI display.

## Glossary

Same as v1, plus:

- **Internal plugin.** A plugin loaded synchronously during `init` via the `INTERNAL_PLUGINS` array in `packages/opencode/src/plugin/index.ts`. Unlike external plugins (loaded asynchronously via `PluginLoader.loadExternal`), internal plugins are available before the tool registry caches its state. This fixes the tool visibility race.
- **`noReply` command.** A command whose `command.execute.before` hook sets `noReply: true`, causing `command()` to pass `noReply: true` to `prompt()`, which short-circuits at line 1293 (`if (input.noReply === true) return message`) — no LLM invocation, no user message creation beyond the confirmation text.

## Open Questions

1. **Bun compatibility of `@elevenlabs/elevenlabs-js`.** RESOLVED (v1 spike).
2. **ElevenLabs v3 latency.** RESOLVED — 1.1s TTFA (v1 spike).
3. **Voice sourcing.** RESOLVED — voice ID `xVQH621DS3eyBYrseRt5` (confirmed by Todd).
4. **`@opencode-ai/sdk/v2` import path in Bun.** RESOLVED — the v2 SDK import path works in Bun for `session.abort`.
