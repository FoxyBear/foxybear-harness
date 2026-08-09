# SDD-00 Master: Katya Voice TTS Module

**Date:** 2026-07-27
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending independent audit + human gate)
**Model tier:** authored at top tier

This is the master spec for Katya's Text-to-Speech (TTS) module — the output path that gives Katya a spoken voice with expressivity (pauses, laughs, breath, emotion). It defines the architecture, the cross-cutting requirements every feature spec inherits, the shared contract (types, config, state ownership), and the dependency order between specs. The five feature specs (SDD-01 through SDD-05) refine this document. Where a feature spec conflicts with this master, this master wins and the feature spec must be corrected.

No code is written against any spec until the full suite passes independent audit and the human gate (see `make sdd`).

## Architecture

### Problem being solved

Katya runs inside the FoxyBear CLI (opencode fork) as a text-based assistant. Todd wants her to speak — not in the flat robotic TTS of existing opencode voice plugins, but with human expressivity: laughs mid-response, pauses for emphasis, sighs, whispered asides. The perceptual gap is that brain work is invisible (unlike muscle soreness), so the voice must carry the warmth and texture that text alone cannot.

The hard requirement is **expressivity**, not just "audio output." Existing opencode voice plugins (renjfk, willvc7, Olbrasoft, dcartertwo) all use batch TTS with local neural vocoders (Piper, Kokoro, EdgeTTS, macOS `say`) that cannot render emotional prosody, cannot accept streaming input, and cannot laugh. The research ([`docs/research/260727_foxybear_voice-stt-tts-architecture.md`](../../research/260727_foxybear_voice-stt-tts-architecture.md)) identified ElevenLabs v3 Conversational as the only TTS provider with a published, supported mechanism for LLM-emitted expressivity tokens (`[laughs]`, `[sighs]`, `[sarcastic]`) that the TTS model renders with documented 4-5-word scope.

### Scope: TTS only

This spec suite covers the **TTS output path only**: LLM text tokens → ElevenLabs TTS → audio playback. The STT input path (Todd speaks → text → session input) is explicitly out of scope and will be specced separately. The TTS module is designed to integrate with a future STT module via the Speech Engine's bidirectional speech engine — but the TTS path works standalone with text input from the keyboard and voice output through speakers.

### Target shape

A plugin in opencode's native plugin system that taps the assistant's streaming text, forwards it to ElevenLabs, and plays the resulting audio — all without forking opencode core:

```
User types (keyboard) or speaks (future STT)
  └─► opencode session loop (unchanged)
        └─► LLM streams tokens via Bus events
              └─► message.part.delta events
                    │
                    ├─► TUI renders text (stripped of audio tags)
                    │
                    └─► TTS plugin event hook receives delta
                          └─► sentence accumulator (buffers until . ! ? \n)
                                └─► ElevenLabs SDK stream() per sentence (eleven_v3, HTTP)
                                      └─► audio chunks (MP3)
                                            └─► Audio Sink (ffplay/mpv stdin pipe)
                                                  └─► 🔊 Katya speaks, expressively
```

The plugin subscribes to `message.part.delta` Bus events via the `event` hook, pipes the text (including inline audio tags like `[laughs]`) to ElevenLabs' SDK HTTP streaming TTS API (`client.textToSpeech.stream()`), sentence by sentence, receives audio chunks, and plays them through a streaming audio sink that pipes to a system player (`ffplay`/`mpv`/`afplay`) via stdin. The TUI continues rendering text as today, with audio tags stripped from the visual display.

### Why a plugin, not a fork

The research confirmed all required API surfaces are plugin-accessible via `PluginInput.client` and the `event` hook ([`packages/opencode/src/plugin/index.ts:126-135,248-257`](../../../packages/opencode/src/plugin/index.ts)). No opencode core modifications are needed for the TTS path. The upgrade story stays clean.

### Plugin loading timing constraint (diagnosed 2026-08-06)

External plugins load asynchronously via `PluginLoader.loadExternal` AFTER the tool registry caches its `InstanceState` state. The tool registry's `init` function calls `plugin.list()` during `InstanceState.make`, which memoizes the result. If external plugins haven't finished loading when the registry's `init` runs, their tools are not in the cached `custom` array and are never re-read.

This means: **external plugin tools may not be visible to the LLM's tool list.** The `event` hook (Bus subscription) works regardless of timing — events are delivered to all hooks in the `hooks` array, which is mutated in place by `applyPlugin`. But the tool registry reads `plugin.list()` once during its own `init` and caches the result.

**Implication for this spec suite:** The `voice.toggle` and `voice.mute` tools (SDD-01) may not reach the LLM if the voice plugin is loaded as an external plugin. Two mitigations are available:
1. Make the voice plugin an **internal plugin** (loaded synchronously during `init`, before the registry caches) — requires adding to `INTERNAL_PLUGINS` in `plugin/index.ts`.
2. Move `plugin.list()` from the registry's cached `init` to the per-turn `all()` function — requires modifying `tool/registry.ts`.

The implementation SHALL use one of these mitigations. The specs' VERIFY sections SHALL include an integration test that verifies tool visibility against a real (non-mock) tool registry.

### Why SDK HTTP stream, not WebSocket streaming-input

The spike ([`docs/research/260727_elevenlabs-spike-results.md`](../../research/260727_elevenlabs-spike-results.md)) confirmed that the WebSocket streaming-input endpoint (`/v1/text-to-speech/{voice_id}/stream-input`) does NOT support `eleven_v3` — it returns HTTP 404. This is confirmed by [ElevenLabs' own docs](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts.md): *"That endpoint does not support the `eleven_v3` model."* The WebSocket endpoint is limited to v2/Flash/Turbo models (concurrency_group: "turbo").

The SDK's `client.textToSpeech.stream()` method (HTTP POST to `/v1/text-to-speech/{voice_id}/stream`) DOES support `eleven_v3` and returns audio chunks as a streaming response (TTFA ~1.1s verified). The architecture uses this method with sentence-boundary chunking: accumulate LLM text until a sentence boundary (`.`, `!`, `?`, `\n`), POST each sentence to the stream endpoint, and chain audio playback.

**Critical SDK gotcha:** The `stream()` method expects `modelId` (camelCase). Using `model_id` (snake_case) is silently stripped — the request falls back to the default v2 model with no error. This is documented in the spike results and must be enforced in implementation.

## Cross-Cutting Requirements

These apply to all feature specs. Each is testable and must be honored by every relevant WHEN/SHALL requirement downstream.

- **CC-1 No fork required.** WHEN the TTS plugin is installed, the system SHALL operate entirely through opencode's plugin system (`event` hook + `PluginInput.client`). No modifications to opencode core source files are required. The plugin SHALL be installable via `tui.json` `plugin` array.
- **CC-2 Expressivity is the core feature.** WHEN Katya's response contains an inline audio tag (`[laughs]`, `[sighs]`, `[whispers]`, etc.), the TTS engine SHALL render it as audible expressivity (laughter, sigh, whisper) affecting the prosody of the next ~4-5 words. Flat monotone delivery SHALL NOT be accepted.
- **CC-3 TUI text and spoken audio are independent streams.** WHEN an audio tag appears in the LLM output, the TUI SHALL strip it from the rendered text display, and the TTS engine SHALL receive it verbatim. The user SHALL NOT see `[laughs]` in the terminal.
- **CC-4 No blocking.** WHEN the TTS plugin is active, it SHALL NOT block the TUI from rendering text, accepting input, or running tools. Audio playback SHALL run in a background fiber/process. The session loop SHALL NOT wait for audio playback to complete before accepting the next input.
- **CC-5 Graceful degradation.** WHEN the ElevenLabs API is unreachable, returns an error, or the API key is missing, the system SHALL silently fall back to text-only mode (no audio) and SHALL NOT crash or block the session. The user SHALL be notified via a TUI status indicator that voice is off.
- **CC-6 Barge-in (audio cutoff).** WHEN a new user turn is submitted (via keyboard or future STT) while Katya is speaking, the system SHALL stop audio playback immediately. The in-flight LLM stream SHALL be cancelled via `client.session.abort({ sessionID })` if the new turn is for the same session.
- **CC-7 Config-driven.** WHEN the plugin loads, it SHALL read its configuration from `tui.json` plugin options (voice ID, model ID, stability preset, API key env var name, audio player preference). Sensible defaults SHALL apply for unspecified options. The API key itself SHALL be read from an environment variable, never stored in config files.
- **CC-8 No broken tests.** WHEN any feature is implemented, the existing test suite SHALL remain green and typecheck SHALL pass. A feature is not done if it leaves red tests.
- **CC-9 Reuse before building.** Implementations SHALL reuse named existing patterns (the `which`-based player detection from `sound.ts:79-83`, the plugin `event` hook for Bus subscription, the `PluginInput.client` SDK surface) rather than introducing parallel mechanisms.
- **CC-10 Latency budget.** WHEN the LLM begins streaming a response, the first audio chunk SHALL reach the speaker within 2 seconds of the first text token (spike-verified: 1.1s TTFA for a 440-char, 10-sentence input via SDK stream with eleven_v3) under normal network conditions. Full-synthesis-then-play (batch mode) SHALL NOT be the primary path. The 2s budget is measured against SDK time-to-first-audio (from POST to first audio byte). End-to-end perceived latency = (LLM time-to-first-sentence-boundary) + ~1.1s, which may exceed a 2s 'feel' on long opening sentences. This is a measurement-scope clarification, not a defect. Sustained conversational latency and long-session (30+ min) behavior are integration-test items, not gate items. No end-to-end user-facing TTFA SLO is defined for v1. LLM boundary emission latency is outside plugin control and varies by provider, model, and prompt. The 2s budget is a component SLO on SDK TTFA. End-to-end measurement is deferred to integration-test scope.
- **CC-11 No secret exposure.** The ElevenLabs API key SHALL NOT appear in logs, diagnostics, error surfaces, serialized config, or Bus event payloads. Audio data **SHALL NOT** be persisted to disk, written to logs or diagnostics, included in Bus payloads, or exposed via any out-of-process interface. Audio transits plugin process memory and the OS pipe to the system player only; player process memory is outside plugin control and is the sanctioned render path. A missing API key SHALL fail closed with a non-secret actionable message (e.g., "ELEVENLABS_API_KEY environment variable not set"). If auth headers are surfaced via SDK errors, they SHALL be redacted.

## Shared Contract

This section resolves every cross-spec seam. The master wins on any conflict. Feature specs reference these by `SC-N` identifiers.

### SC-1: Plugin Config Schema

Owned by: SDD-01 (Voice Plugin Lifecycle). Referenced by: all specs.

```typescript
type VoiceConfig = {
  apiKeyEnv: string         // env var name holding ElevenLabs API key (default: "ELEVENLABS_API_KEY")
  voiceId: string           // ElevenLabs voice ID (IVC or Voice Library)
  // default: "xVQH621DS3eyBYrseRt5" (Katya, Voice Library, confirmed by Todd)
  modelId: string           // ElevenLabs model ID (default: "eleven_v3"); MUST be passed as `modelId` (camelCase) to SDK stream(), NOT `model_id` (snake_case) — snake_case is silently stripped
  stability: "creative" | "natural" | "robust"  // v3 stability preset (default: "natural")
  speed: number             // 0.7–1.2 (default: 1.0)
  similarityBoost: number  // 0–1 (default: 0.75)
  speakerBoost: boolean     // (default: true)
  style: number              // voice style/exaggeration 0-1 (default: 0)
  language: string           // language code for voice_settings (default: "en") — pins language to prevent v3 auto-detecting German for numbers/times
  playerPreference?: string // preferred audio player binary (default: auto-detect)
  pronunciationDictionaryId?: string  // ElevenLabs PLS dictionary locator ID
  pronunciationDictionaryVersionId?: string  // version ID for the hosted pronunciation dictionary
  outputFormat: string      // audio format (default: "mp3_44100_128")
  tagEmissionTempBoost: boolean  // optional temperature boost for tag emission (default: false)
  tagEmissionTempDelta: number   // temperature delta when boost enabled (default: 0.1)
  maxSentenceRetries: number  // max retry attempts per sentence (default: 2, i.e. 3 total POSTs)
  autoStart: boolean         // auto-activate voice on first assistant text delta (default: false)
}
```

The config is read from `tui.json` `plugin` array options. Unknown keys are ignored, except `model_id` (snake_case) which SHALL be rejected with an actionable error message identifying the correct camelCase `modelId` (per SDD-03 req 16a). Missing required keys (`voiceId`) cause a config validation error at plugin load — the plugin registers but stays inactive with a TUI warning.

The `voiceId` default of `xVQH621DS3eyBYrseRt5` is the SC-1 config default, not a hardcoded constant in SDD-03. Implementations SHALL read it from VoiceConfig, not inline it in the TTS module.

### SC-2: Voice Mode State

Owned by: SDD-01. Referenced by: all specs.

```typescript
type VoiceMode = {
  active: boolean           // is TTS currently enabled for this session?
  sessionId: string | null  // the session being voiced (null if idle)
  playing: boolean          // is audio currently being played?
  connected: boolean       // is the ElevenLabs SDK client alive?
}
```

State transitions:
- `inactive → active`: `/voice` command invoked or plugin option `autoStart: true`
- `active → inactive`: `/mute` command, or `/voice` toggle, or ElevenLabs connection failure (after retry budget exhausted)
- `active + not playing → active + playing`: first audio chunk received from ElevenLabs
- `active + playing → active + not playing`: audio stream completed, or barge-in (CC-6)

State is **per-session and in-process**. It does not persist across daemon restarts. On restart, voice mode is off by default (unless `autoStart` config option is set).

### SC-3: Text Stream (LLM → TTS)

Owned by: SDD-02 (LLM Stream Tap). Referenced by: SDD-03 (ElevenLabs), SDD-05 (Expressivity).

The TTS plugin receives assistant text deltas via the `event` hook (`packages/opencode/src/plugin/index.ts:248-257`), which delivers all Bus events including `message.part.delta` (defined at `packages/opencode/src/session/message-v2.ts:489-498`, emitted at `packages/opencode/src/session/processor.ts:423`). The event hook receives `{ event: input }` where `input` is the raw Bus payload `{ type, properties }` — NOT `GlobalEvent` with a `.payload` wrapper. The correct access pattern is `input.event.type` and `input.event.properties`.

The plugin filters for:
- `input.event.type === "message.part.delta"`
- `input.event.properties.sessionID === currentSessionId`

**Include-only-text filter via part-type correlation (NOT `field`):** Both the assistant-text emit (`packages/opencode/src/session/processor.ts:423-429`) and the reasoning emit (`packages/opencode/src/session/processor.ts:241-247`) carry `field === "text"`. The `field` property does NOT distinguish assistant text from reasoning. The plugin SHALL maintain a per-session `Set<PartID>` of **text parts** (not reasoning parts), populated from `message.part.updated` events (`packages/opencode/src/session/message-v2.ts:479-488`) whose `part.type === "text"`. A `message.part.delta` SHALL be forwarded ONLY if its `partID` is in the text-parts set. This is an **include-only-text** filter — tool-call deltas, file-part deltas, reasoning deltas, and any other non-text part type SHALL be dropped. `message.part.updated` is a `SyncEvent` published via the Bus (verified: `sync/index.ts:148-151` publishes to `ProjectBus`, which IS the Bus).

Each forwarded delta's `properties.delta` string is sent to the TTS engine verbatim — including audio tags like `[laughs]`. The plugin does NOT buffer full messages; it forwards chunks as they arrive.

The plugin also listens for `message.part.updated` (text part completion) and `session.status` events (deprecated `session.idle` fallback, `packages/opencode/src/session/status.ts:37-43`) to detect when a response is complete and flush the TTS stream.

### SC-4: Audio Chunk Stream (TTS → Speaker)

Owned by: SDD-04 (Audio Playback Sink). Referenced by: SDD-03 (ElevenLabs).

```typescript
type AudioChunk = {
  data: Uint8Array    // raw audio bytes (MP3 or PCM per outputFormat)
  format: string       // MIME type or format identifier
  isFinal: boolean     // true if this is the last chunk in the stream
}
```

The audio sink accepts an `AsyncIterable<AudioChunk>` and plays it through a system player via stdin pipe. The sink is responsible for:
- Player detection (reuse `which` pattern from `sound.ts:79-83`)
- Spawning the player with `stdin: "pipe"` (not `"ignore"` as in `sound.ts:89`)
- Writing chunks to stdin as they arrive
- Closing stdin on completion or barge-in
- Process lifecycle (kill on teardown)

**Sink `stop()` method (retry-stop signal):** The sink SHALL expose a `stop()` method that immediately kills the player process, closes stdin, and discards queued chunks — identical to barge-in behavior (CC-6) but callable by SDD-03 for retry scenarios. This is distinct from `isFinal: true` on an AudioChunk, which signals normal turn-completion. SDD-03 SHALL call `stop()` before starting a retried audio stream to prevent overlapping audio. The sink SHALL be ready to accept a new `AsyncIterable<AudioChunk>` immediately after `stop()` returns.

**Idempotency and post-stop safety:** The sink's `stop()` method SHALL be idempotent — calling it on an already-stopped sink is a no-op, never an error. Writes attempted after `stop()` SHALL be silently suppressed; EPIPE or ERR_STREAM_DESTROYED on post-stop writes SHALL be caught and discarded, never crashing the plugin or surfacing an unhandled rejection. `proc.kill()` on an already-dead PID SHALL be caught and treated as success. Player-process exit during stop/teardown SHALL be treated as non-fatal.

### SC-5: Abort Ownership

Owned by: SDD-01. Referenced by: SDD-02 (LLM Tap), SDD-04 (Audio Sink).

Barge-in cancellation flows through `client.session.abort({ sessionID })` (SDK method, verified at `packages/opencode/src/server/instance/session.ts:385-413`, chained through `SessionPrompt.cancel` → `Fiber.interrupt` → `AbortController.abort` at `packages/opencode/src/session/llm.ts:394-397`).

The TTS plugin does NOT own its own `AbortController` for the LLM stream. It calls `client.session.abort()` which cancels the upstream provider request. The plugin's own audio sink has a separate stop mechanism (kill the player process + close stdin) that fires in parallel with the session abort.

**Per-session epoch token:** The TTS layer SHALL maintain a monotonic `utteranceGeneration` epoch token, scoped per-session (consistent with SDD-01's `session.deleted` cleanup semantics — a global epoch would let one session's barge-in discard another session's audio). Barge-in increments the current session's epoch. Each audio chunk from an in-flight `stream()` response SHALL be checked against the current epoch before forwarding to the sink; stale-epoch chunks SHALL be dropped. The epoch check **SHALL** be performed on every audio chunk prior to sink forwarding, not per-sentence or per-request. This residual window applies equally to barge-in teardown and to SDD-03 req 17(a) drain-before-retry. In both cases, the normative boundary for clean separation is the sink/pipe input — i.e., no new audio bytes are forwarded to the pipe after the drain or stop signal — not the audible output boundary. A sub-millisecond residual from bytes already in the OS pipe buffer or the player's internal buffer may be audible before teardown completes, and is accepted as v1 architectural debt. On barge-in, accumulated-but-unflushed text SHALL be discarded, and re-arming for a new response SHALL be safe (the state machine returns to a clean speakable state).

**Barge-in detection and notification chain (S1 fix):** Barge-in SHALL be triggered by `session.status` Bus events with `status.type === "busy"` (new user turn started). SDD-01 owns detection — it receives the event via its `event` hook. On detection, SDD-01 SHALL: (a) call `client.session.abort({ sessionID })` to cancel the in-flight LLM stream, (b) call `tts.bargeIn()` which increments the epoch token and clears the TTS buffer, (c) call `tap.abort(sessionID)` which stops the tap from forwarding further deltas, (d) call `sink.stop()` which kills the player process. These actions fire in parallel — no ordering dependency between them. SDD-04 does NOT own barge-in detection — it is an audio playback component with no visibility into user input.

### SC-6: Audio Tag Vocabulary

Owned by: SDD-05 (Expressivity). Referenced by: SDD-02 (LLM Tap, for stripping), SDD-03 (ElevenLabs, for forwarding).

The set of valid audio tags is defined by ElevenLabs' published v3 documentation. The plugin SHALL recognize and strip these tag patterns from TUI display:

- Emotion/action: `[laughs]`, `[laughs harder]`, `[starts laughing]`, `[wheezing]`, `[whispers]`, `[sighs]`, `[exhales]`, `[sarcastic]`, `[curious]`, `[excited]`, `[crying]`, `[snorts]`, `[mischievously]`
- Sound effects: `[gunshot]`, `[applause]`, `[clapping]`, `[explosion]`, `[swallows]`, `[gulps]`
- Pauses: `[pause]`, `[short pause]`, `[long pause]`
- Experimental: `[sings]`, `[woo]`

The tag-matching pattern is: `\[([a-z][a-z ]*[a-z])\]` (lowercase letters and spaces between square brackets). False positives (e.g., a code snippet containing `[0]`) SHALL NOT be stripped — the stripper SHALL only match known tags from the vocabulary above, not any bracket pattern.

## Dependency Order

Specs may be implemented in this order. Later specs depend on earlier ones.

1. **SDD-01: Voice Plugin Lifecycle** — plugin registration, config parsing, `/voice` `/mute` commands, state management, teardown. No dependencies. Defines SC-1, SC-2, SC-5.
2. **SDD-02: LLM Stream Tap** — `event` hook subscription to `message.part.delta`, async iterable adapter, TUI tag stripping, response completion detection. Depends on SC-2 (VoiceMode), SC-3 (Text Stream), SC-6 (Audio Tag Vocabulary). Defines SC-3.
3. **SDD-03: ElevenLabs TTS Streaming** — SDK HTTP stream lifecycle, sentence-boundary chunking, audio chunk reception, voice settings, pronunciation dictionary, error handling/retry. Depends on SC-1 (VoiceConfig), SC-3 (Text Stream), SC-4 (Audio Chunk Stream). Defines the ElevenLabs integration.
4. **SDD-04: Audio Playback Sink** — player detection, stdin-pipe streaming, volume control, barge-in cutoff, process lifecycle. Depends on SC-4 (Audio Chunk Stream), SC-5 (Abort Ownership). Defines the audio sink.
5. **SDD-05: Expressivity** — Enhance system prompt section, Katya tone guide, audio tag emission rules, pronunciation dictionary seeding. Depends on SC-6 (Audio Tag Vocabulary). Can be implemented in parallel with SDD-01..SDD-04 since it's primarily system-prompt engineering and config.

## Glossary

Opinionated vocabulary for this spec suite. One name per concept.

- **TTS.** Text-to-Speech. The output path: Katya's text response → audible speech.
- **STT.** Speech-to-Text. The input path: Todd's voice → text. Out of scope for this suite.
- **Audio tag.** An inline token in the LLM's text output (e.g., `[laughs]`, `[sighs]`) that the TTS engine renders as audible expressivity. ElevenLabs v3 design — not SSML.
- **Voice mode.** The plugin's active state where assistant responses are spoken aloud. Toggled via `/voice`.
- **Audio sink.** The streaming audio playback component that pipes MP3/PCM chunks from ElevenLabs to a system player via stdin.
- **Sentence-boundary chunking.** Accumulating LLM text tokens until a sentence boundary (., !, ?, \n), then sending the complete sentence to the TTS API. This is the streaming pattern for v3, which doesn't support WebSocket streaming-input. Contrast with token-by-token streaming (WebSocket, v2 only).
- **IVC.** Instant Voice Clone. ElevenLabs' few-shot voice cloning method. Works with `eleven_v3`. Preferred over PVC (Professional Voice Clone) which does not preserve characteristics under `eleven_v3`.
- **Enhance prompt.** The system-prompt section, published verbatim by ElevenLabs, that instructs an LLM to insert audio tags into its output without altering the text's meaning. Pasted into Katya's system prompt.
- **Pronunciation dictionary.** An ElevenLabs-hosted `.pls` lexicon that maps graphemes to phonemes for custom terms (FoxyBear brand names, technical terms). Referenced by ID on each TTS request.
- **Barge-in.** When the user interrupts Katya mid-speech. Audio stops immediately; the LLM stream is cancelled.

## Post-Spike Consistency (Council GC2)

All 6 specs in this suite SHALL be free of the following stale references in normative text (rationale/historical-pivot notes are exempt):

| Pattern | Acceptable location |
|---|---|
| `chunkSchedule` | Nowhere (removed WebSocket artifact) |
| `WebSocket` / `websocket` / `ws://` / `streaming-input` | Only in rationale / rejected-alternatives / historical-pivot notes, never in normative requirements |
| Any voice ID other than `xVQH621DS3eyBYrseRt5` | Nowhere in normative text |
| `model_id` (snake_case) | Only in SDD-03 req 3 as the documented gotcha, never as a usage |
| Any wording implying v3 works over WS input, or Text-to-Dialogue is real-time-acceptable | Nowhere |

## Open Questions

These are flagged risks that Todd should be aware of. They do not block spec authoring but may affect implementation decisions.

1. **Bun compatibility of `@elevenlabs/elevenlabs-js`.** RESOLVED — Bun + `@elevenlabs/elevenlabs-js` SDK works for HTTP streaming. Verified with sentence-boundary chunking spike.
2. **ElevenLabs v3 Conversational exact latency.** RESOLVED — v3 SDK stream TTFA = 1,103ms (440-char input), within 2s CC-10 budget. Verified via spike.
3. **Voice sourcing for Katya.** RESOLVED — Todd confirmed voice ID `xVQH621DS3eyBYrseRt5` (Voice Library, `eleven_v3`). Selected from 3-voice comparison test using the morning briefing protocol. Expressivity (audio tags) verified: `[sighs]`, `[sarcastic]`, `[curious]`, `[whispers]`, `[laughs]`, `[excited]` all render correctly.
4. **Pricing and rate limits.** v3 Conversational in ElevenAgents is documented at $0.08/min. Full pricing tiers and rate limits not fetched. **Action:** verify before committing budget.
5. **v1/v2 Event typing gap.** The plugin `event` hook's `Event` type (from `@opencode-ai/sdk` v1) does not include `message.part.delta`. Runtime delivers it via `as any` cast. The plugin should import from `@opencode-ai/sdk/v2` for proper typing, or treat payloads structurally. **Action:** verify v2 import path works in Bun.
6. **Echo cancellation.** When STT is added, Katya's speaker output will bleed into the microphone. Headphones are the initial mitigation. System AEC is a future concern. **Action:** document in plugin README; validate with headphones first.

## Tracked Fast-Follow Tickets

| Ticket | Description | Graduation trigger |
|---|---|---|
| **TTS-FF-001** | R2 metadata detection — verify ElevenLabs stream() response exposes model version | API response inspection during implementation |
| **TTS-FF-002** | R4 v2-import verification — retire the sanctioned `as any` cast | Bun import test of `@opencode-ai/sdk/v2` |
| **TTS-FF-003** | R6 sustained-latency / long-session integration testing | Post-implementation integration test suite |
