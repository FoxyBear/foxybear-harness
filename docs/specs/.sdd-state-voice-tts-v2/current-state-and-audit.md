# Voice TTS v2 — Current State & Architecture Audit

**Date:** 2026-08-08
**Branch:** `feat/voice-tts-v2`
**Status:** PAUSED — audio works but text filtering is broken, implementation over-engineered

## What Works

- **Audio playback** — ElevenLabs API call succeeds, audio written to temp file, `afplay` plays it
- **Command dispatch** — `/voice` reaches `SessionPrompt.command` native branch, calls `voice.toggle()`
- **Bus subscriptions** — `message.part.delta` events received by Voice.Service
- **ElevenLabs engine** — connects, authenticates, synthesizes, returns audio stream
- **Config** — `voice` field in FoxyBearFields, key resolution from env or `{file:...}`

## What's Broken

### 1. Reasoning text synthesized instead of reply (CRITICAL)

`handlePartUpdated` tracks `partID → type` but **`PartUpdated` is never subscribed on the Bus**. A copy-paste bug subscribes to `PartDelta` twice instead of `PartDelta` + `PartUpdated`. The `partTypes` map is always empty, so all `field === "text"` deltas pass through — including reasoning deltas.

**v1 solved this** by subscribing to `message.part.updated`, tracking text-type `partID`s, and only forwarding deltas for confirmed text parts. The v2 code has the logic but never wires the subscription.

### 2. `/voice` shows "Voice on." in TUI (UX bug)

The native command branch creates a synthetic user message with `noReply: true`. Other slash commands are consumed silently. The `noReply` flag doesn't suppress the user message creation — it only prevents the LLM from responding.

### 3. No audio streaming — entire response buffered (PERFORMANCE)

The `synthesize` method buffers the entire LLM response into one string, makes one `stream()` call, buffers the entire audio stream, writes to a temp file, then plays. For a 200-word response, the user waits 10-30s+ before hearing anything.

**v1 specified** sentence-boundary chunking: accumulate text until `.`, `!`, `?`, `\n`, send each sentence as a separate `stream()` call, chain playback (play sentence N while synthesizing N+1). TTFA: ~1.1s per sentence.

### 4. Directory switch kills audio (EDGE CASE)

When `cd`-ing to a new directory while voice is active, the Bus subscriptions are registered to the old directory's InstanceState. A new `/voice` in the new directory fails because the old subscriptions point to the old PubSub.

## Architecture Audit (Independent Agent)

An independent agent read the v1 specs, v1 spike results, v2 specs, and current v2 implementation. Key findings:

### Lost learnings from v1

| v1 Feature | v1 Approach | v2 Status |
|---|---|---|
| Reasoning/reply filtering | Subscribe `PartUpdated`, track text-type `partID`s, include-only-text filter | Code exists but **never wired** — `PartDelta` subscribed twice instead |
| Sentence-boundary chunking | Accumulate until `.!?`, separate `stream()` calls, chained playback | **Not implemented** — buffers entire response |
| Stdin-pipe streaming audio sink | Spawn with `stdin: "pipe"`, write chunks as they arrive, no temp files | **Reverted** to temp-file pattern (sound.ts style) |
| TUI tag stripping | `experimental.text.complete` hook strips `[laughs]` etc. from display | **Not implemented** |
| Expressivity system prompt | `experimental.chat.system.transform` injects Tone Guide | **Not implemented** |
| Multi-player detection | `which`-probe 12 candidates (ffplay, mpv, afplay...) | **Hardcoded afplay** |

### Unnecessary complexity in v2

| v2 Addition | Lines | Value |
|---|---|---|
| `VoiceEngine` interface | ~30 | Zero — one provider, no alternatives planned |
| `InMemoryVoiceEngine` test double | 206 | Zero — tests pass but system doesn't work |
| `EngineEvent` union (8 variants) | ~40 | Zero — replaces direct method returns |
| 7-state engine state machine | ~100 | Fragile, hard to get right, delivers same UX as v1's 4-field `VoiceMode` |
| `VoiceStatePart` persistence spec | ~50 spec lines | Not implemented, not needed for a toggle |
| `EventQueue<T>` custom async iterable | 37 | Replaces simple callbacks |
| Native system command registration | Core mod | Heavier than needed — `noReply` in `CommandInput` is ~10 lines |

### The v2 architectural premise

The v2 spec identified three v1 failures:
1. **Tool visibility** — plugin tools not reliably visible to LLM → fix: make plugin internal (2 lines)
2. **Command-path mismatch** — slash commands can't be silent → fix: add `noReply` to `CommandInput` (~10 lines)
3. **SDK parameter mismatch** — `{id}` vs `{sessionID}` → fix: import from `@opencode-ai/sdk/v2` (1 line)

Each has a targeted fix that doesn't require the v2 architecture. The v2 architecture (Effect service, VoiceEngine interface, Bus subscriptions, native commands) was built to solve these three edge cases but lost five core TTS features in the process.

### Agent recommendation

**Scrap the v2 architecture. Return to a v1-style plugin approach with targeted fixes.**

Keep from v2:
- `@opencode-ai/sdk/v2` import
- `noReply: true` pattern (wire through `CommandInput` properly)

Revert to from v1:
1. Internal plugin (add to `INTERNAL_PLUGINS` in `plugin/index.ts`)
2. Include-only-text filter via `PartUpdated` correlation
3. Sentence-boundary chunking (SDD-03)
4. Stdin-pipe streaming audio sink (SDD-04)
5. `experimental.text.complete` for tag stripping (SDD-02)
6. `experimental.chat.system.transform` for expressivity (SDD-05)

Drop entirely:
- `VoiceEngine` interface, `InMemoryVoiceEngine`, `EngineEvent` union
- 7-state engine state machine
- `VoiceStatePart` persistence
- `EventQueue<T>` custom async iterable
- Native system command registration in core

## Current File State

| File | Lines | Purpose |
|---|---|---|
| `src/voice/index.ts` | ~430 | Voice.Service Effect service (over-engineered) |
| `src/voice/types.ts` | ~140 | Type definitions for engine interface |
| `src/voice/engine.ts` | ~200 | InMemoryVoiceEngine test double |
| `src/voice/elevenlabs.ts` | ~300 | ElevenLabsVoiceEngine + AudioSink (temp-file pattern) |
| `src/command/index.ts` | modified | Added `source: "system"` enum + voice/mute registration |
| `src/config/foxybear.ts` | modified | Added `voice` config field |
| `src/session/prompt.ts` | modified | Added Voice import, capture, native command branch, layer provide |
| `test/voice/` | 39 tests | Acceptance + contract tests (pass but don't verify production behavior) |

## Decision Point

The user has lost confidence in the current approach. Options:

1. **Fix v2 in place** — wire `PartUpdated` subscription, fix the `PartDelta` duplicate, fix the `/voice` display, implement sentence chunking. Est: moderate effort, still carries architectural overhead.

2. **Scrap v2, rebuild as v1-style plugin** — internal plugin with `event`/`tool` hooks, `PartUpdated` correlation, sentence chunking, stdin-pipe sink. Est: less effort than remaining v2 fixes, aligns with working v1 specs.

3. **Hybrid** — keep v2's Effect service for state management, replace Bus subscriptions with plugin `event` hook, replace VoiceEngine with direct calls. Est: moderate, keeps some v2 investment.

The independent audit recommends option 2.
