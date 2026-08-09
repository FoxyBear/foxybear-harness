# SDD-03: ElevenLabs TTS Streaming

**Date:** 2026-07-27
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending independent audit + human gate)
**Master:** `docs/specs/260727_voice-tts_sdd-00-master.md`
**Depends on:** SC-1 (VoiceConfig), SC-3 (Text Stream, owned by SDD-02), SC-4 (Audio Chunk Stream, owned by SDD-04). References SC-2 (VoiceMode, owned by SDD-01), SC-5 (Abort Ownership, owned by SDD-01), SC-6 (Audio Tag Vocabulary, owned by SDD-05). The `AsyncIterable<string> → AsyncIterable<AudioChunk>` contract is unchanged from the original spec — only the transport changed from WebSocket to HTTP stream.
**Defines:** the ElevenLabs integration layer — a module (working name `ElevenLabsTTS`) that owns the HTTP streaming TTS integration via the ElevenLabs SDK (`client.textToSpeech.stream`), the sentence-chunked text→audio pipeline, voice-settings application, and retry/degradation behavior.

This feature spec covers the ElevenLabs SDK HTTP streaming TTS integration (`client.textToSpeech.stream`) and the sentence-chunked text→audio pipeline. It refines SDD-00 and inherits all cross-cutting requirements (CC-1..CC-11). Where this document conflicts with the master, the master wins; in particular the Shared Contract (SC-1..SC-6) is authoritative. This spec produces audio; it does not play it (SDD-04 owns the sink), tap the LLM (SDD-02 owns the text stream), parse config (SDD-01 owns VoiceConfig), or define the tag vocabulary (SDD-05 owns SC-6).

## Background (the integration boundary this spec owns)

`ElevenLabsTTS` is a pure transform between two async iterables:

```
SC-3 (SDD-02)                SDD-03 (this spec)              SC-4 (SDD-04)
AsyncIterable<string>  ──►  SDK stream() per sentence  ──►  AsyncIterable<AudioChunk>
(text deltas, verbatim,      (HTTP POST /v1/text-to-speech/    (decoded audio bytes,
 including audio tags)         {voice_id}/stream)              isFinal on completion)
```

- **Input:** the `AsyncIterable<string>` produced by SDD-02's LLM stream tap (SC-3). Each yielded string is an assistant text delta, **including inline audio tags** (`[laughs]`, `[sighs]`, …) that SDD-02 forwarded verbatim and stripped from the TUI (CC-3).
- **Output:** an `AsyncIterable<AudioChunk>` (SC-4) consumed by SDD-04's audio sink. Each `AudioChunk` carries decoded audio bytes, the configured `outputFormat`, and an `isFinal` flag set true exactly once when the turn's final sentence completes.
- **Transport:** the ElevenLabs SDK (`@elevenlabs/elevenlabs-js`) method `client.textToSpeech.stream(voiceId, { modelId, text, voice_settings, outputFormat })` — an HTTP POST to `/v1/text-to-speech/{voice_id}/stream` that returns a streaming response body. No WebSocket, no `stream-input` endpoint, no `SendText`/`flush`/`AudioOutput`/`Finished` message types. The SDK is initialized with the API key read from the environment variable named by `VoiceConfig.apiKeyEnv` (SC-1, CC-7). `PluginInput.client` (`packages/opencode/src/plugin/index.ts:126-135`) remains available for any REST fallback but is **not** used for the primary streaming path.

---

## WHAT

Behavioral requirements. Literal `WHEN`/`SHALL` tokens are machine-checkable. Cross-cutting references in parentheses.

1. **WHEN** voice mode transitions to active (SC-2) and a new assistant turn begins streaming, the `ElevenLabsTTS` module **SHALL** initialize the ElevenLabs SDK (`@elevenlabs/elevenlabs-js`) client with the API key read from the environment variable named by `VoiceConfig.apiKeyEnv` (SC-1, CC-7), and **SHALL** begin consuming the `AsyncIterable<string>` from SDD-02 (SC-3). The SDK client **SHALL** be initialized lazily on the first text delta of the turn, not eagerly on `/voice`, so a voice-mode session with no assistant response holds no client. No WebSocket is opened; the transport is HTTP per-sentence POSTs via `client.textToSpeech.stream()`. (CC-1, CC-4)

2. **WHEN** text deltas arrive from the SC-3 text stream (SDD-02's `AsyncIterable<string>`), the module **SHALL** accumulate text in a per-turn buffer until a sentence boundary is detected — defined as `.`, `!`, `?`, or `\n` occurring at the end of the accumulated text. When a sentence boundary is detected, the accumulated text (including any inline audio tags `[laughs]`, `[sighs]`, … unmodified, per SC-6 and CC-3) **SHALL** be **split at all detected boundaries** and each sentence **SHALL** be sent as a separate `stream()` request, in source order. The buffer **SHALL** be cleared after all sentences from the accumulated text have been sent. This is consistent with req 15's multi-sentence splitting. The module **SHALL NOT** strip, re-chunk, or alter the text; SDD-02 owns TUI stripping (CC-3) and SDD-05 owns the tag vocabulary (SC-6). (SC-3, SC-6, CC-3)

3. **WHEN** the module calls `client.textToSpeech.stream()`, it **SHALL** pass the model ID as `modelId` (camelCase) in the options object: `client.textToSpeech.stream(voiceId, { modelId: VoiceConfig.modelId ?? "eleven_v3", text: sentence, voice_settings, outputFormat })`. Using `model_id` (snake_case) is silently stripped by the SDK — the request falls back to the default v2 model with no error, losing v3 expressivity. This is a verified SDK behavior (see spike results). (SC-1)

4. **WHEN** the module calls `client.textToSpeech.stream()`, it **SHALL** set `outputFormat` from `VoiceConfig.outputFormat` (SC-1, default `mp3_44100_128`), and **SHALL NOT** set `enable_ssml_parsing` (v3 does not support SSML break tags — it uses inline audio tags per SC-6, and SSML parsing would mis-handle them). Unknown/extra options **SHALL NOT** be invented. (SC-1, SC-6)

5. **WHEN** the module calls `client.textToSpeech.stream()`, it **SHALL** include `voice_settings` in the stream request body mapped from `VoiceConfig` (SC-1): `{ stability, similarity_boost, style, use_speaker_boost, speed, language }`. The `stability` value **SHALL** be mapped from the v3 preset (`creative`/`natural`/`robust`) per ElevenLabs v3 documentation (creative → most expressive/lowest stability, robust → most stable/highest), and the chosen preset **SHALL** default to `natural` per SC-1. `speed`, `similarity_boost`, `style` (passed from `VoiceConfig.style`, SC-1, default 0), and `use_speaker_boost` pass through from SC-1 numerically with no transformation. `language` (SC-1, default `"en"`) **SHALL** be included to pin the language and prevent v3 from auto-detecting German for numbers and times. No WebSocket init message is needed — settings travel per-sentence in the POST body. (SC-1)

6. **WHEN** `VoiceConfig.pronunciationDictionaryId` is set (SC-1), the module **SHALL** include `pronunciation_dictionary_locators` in the stream request body for each sentence POST, referencing the configured dictionary. Per-sentence, not per-connection. When unset, the field **SHALL** be omitted entirely. (SC-1)

7. **WHEN** audio bytes arrive in the streaming response body of a sentence's `client.textToSpeech.stream()` call, the module **SHALL** decode them and emit `AudioChunk` objects (SC-4) with `data` = decoded bytes, `format` = `VoiceConfig.outputFormat` (SC-1), and `isFinal=false` into the `AsyncIterable<AudioChunk>` it owns (consumed by SDD-04). Sentences are processed sequentially — sentence N+1 **SHALL NOT** be sent until sentence N's audio stream is complete. Audio playback from the sink (SDD-04) **MAY** overlap with next-sentence synthesis since the sink handles its own queue. (SC-4, CC-4)

8. **WHEN** a sentence's stream response completes, the module **SHALL** continue accumulating text for the next sentence and issue the next `stream()` call when the next boundary is detected. **WHEN** SDD-02 signals that the assistant response is complete (response-end detection owned by SDD-02), the module **SHALL** flush any remaining text in the buffer as a final sentence POST, and **SHALL** emit exactly one final `AudioChunk` with `isFinal=true` (SC-4) after the final sentence's audio stream completes, terminating the audio stream for that turn. The module **SHALL** transition `VoiceMode.playing` to false (SC-2) once the sink has drained. (SC-2, SC-3, SC-4)

9. **WHEN** a sentence POST fails (network error, 429, or 5xx), the module **SHALL** retry that sentence only — each sentence POST is independent, so no replay buffer is needed. Retry attempts per sentence **SHALL NOT** exceed `VoiceConfig.maxSentenceRetries` (default 2; i.e., at most 3 total `stream()` POSTs per sentence) per req 17. Backoff is exponential (base delay e.g. 500ms doubled per attempt, capped, with jitter). 429 responses **SHALL** honor any `Retry-After` hint if ElevenLabs provides one, overriding the computed delay. On failure after retries, the module **SHALL** emit a `tts.sentence_failed` Bus event (per req 17(d)), skip that sentence, and continue the pipeline. If the failure occurs after one or more chunks have been forwarded to the sink, the drain-before-retry semantics of req 17(a) apply. (CC-5, SC-1)

10. **WHEN** the API returns a non-retryable error — 401 or expired API key, an invalid `voice_id` (404), or a malformed-request rejection (4xx other than 429) — the module **SHALL NOT** retry, **SHALL** set `VoiceMode.connected = false` (SC-2), surface a TUI warning naming the failure class, fall back to text-only for the remainder of the session, and **SHALL NOT** crash the session loop. The raw API error message **SHALL** be logged. (CC-5, SC-2)

11. **WHEN** graceful degradation is triggered (retry exhaustion per requirement 9, or a non-retryable error per requirement 10), the module **SHALL** set `VoiceMode.connected = false` (SC-2), emit a TUI status indicator that voice is off, terminate the current turn's audio stream (a final `AudioChunk` with `isFinal=true` if the sink is still awaiting, SC-4), and **SHALL NOT** block the session loop — text continues to render via the normal TUI path. The user **SHALL** be able to re-arm voice mode via `/voice` after correcting the underlying cause (SDD-01 owns the re-arm transition). (CC-5, SC-2)

12. **WHEN** teardown occurs — plugin unload, `/mute`, daemon shutdown, or barge-in (CC-6) — the module **SHALL** stop accumulating text, stop issuing new sentence POSTs, stop emitting `AudioChunk`s, and release the SDK client and per-turn buffer. On barge-in, the module **SHALL** call the sink's `stop()` method (SC-4), which is idempotent — safe to call multiple times. The module **SHALL** (a) stop accumulating text, (b) call the sink's idempotent `stop()` (SC-4) to kill audio playback, and (c) not send any pending sentences. Post-stop audio chunks from in-flight responses **SHALL** be dropped via the epoch token check (requirement 13). There is no WebSocket to close — the module simply stops sending new sentence requests; any in-flight `stream()` response is abandoned (its emitted chunks are discarded by the stopped sink and the epoch token check). Barge-in LLM cancellation is owned by SC-5 (SDD-01 calls `client.session.abort`); this module only tears down its own TTS path. (CC-6, SC-2, SC-4, SC-5)

13. **WHEN** barge-in occurs (CC-6), the module **SHALL** increment a per-session monotonic `utteranceGeneration` epoch token (SC-5). Each audio chunk received from an in-flight `stream()` response **SHALL** be checked against the current epoch before forwarding to the sink (SC-4). Chunks from a stale (pre-barge-in) epoch **SHALL** be dropped silently. This prevents late in-flight HTTP response chunks from reaching a killed player's stdin after barge-in. (SC-4, SC-5, CC-6)

14. **WHEN** processing sentences for synthesis, the module **SHALL** serialize synthesis and playback in emission order. Only one `stream()` POST **SHALL** be in-flight at a time — the module **SHALL NOT** issue the next sentence's POST until the current sentence's audio stream completes (or fails and is dropped per retry logic). A sentence that fails synthesis **SHALL** be retried up to 3 times; on retry exhaustion it **SHALL** be dropped with a log warning and the pipeline **SHALL** advance to the next sentence. Under no circumstances **SHALL** a retried sentence play after a subsequently-emitted sentence. Out-of-order playback is semantic corruption and **SHALL NOT** occur. (CC-4)

15. **WHEN** text deltas arrive from SDD-02, the module **SHALL** apply the following flush semantics:
    - **Boundaries:** flush on `.`, `!`, `?`, `\n` at end of accumulated text; the flush unit includes the delimiter.
    - **Multi-sentence deltas:** if a single delta completes multiple sentences, the module **SHALL** emit one TTS request per sentence, in source order.
    - **Residual buffer:** trailing incomplete text remains buffered; on completion detection (SDD-02 signals response-end), any non-empty residual **SHALL** be flushed once as a final sentence.
    - **Abort:** unsent residual **SHALL** be discarded on barge-in (per requirement 13 epoch discard).
    - **Empty-chunk suppression:** whitespace-only, delimiter-only, or tag-stripped-empty chunks **SHALL NOT** be POSTed to ElevenLabs.
    - **Max-buffer safeguard:** the accumulator **SHALL** split at the first sentence boundary detected at or after 400 characters. If no boundary is detected by 500 characters, the accumulator **SHALL** force-split at the most recent whitespace boundary; if no whitespace exists between 400 and 500 characters, the split **SHALL** occur at exactly 500 characters and the fragment **SHALL** be marked `force_split` for diagnostics. Splitting **SHALL** operate on Unicode codepoints, not bytes or UTF-16 code units. The 400/500 thresholds are measured in codepoints. Force-split at position 500 **SHALL NOT** bisect a codepoint; if position 500 falls within a multi-unit sequence, the split **SHALL** retreat to the preceding codepoint boundary. The implementation **SHALL NOT** produce malformed text under non-ASCII input.
    - **Known limitation:** abbreviation false boundaries (e.g., "Dr.", "e.g.", "3.14") MAY cause premature sentence splits. This is an accepted v1 limitation. (SC-3, CC-4)

16a. (SHALL) **WHEN** the module parses VoiceConfig at initialization, it **SHALL** reject `model_id` (snake_case) as an unknown key with an actionable error message identifying the correct camelCase `modelId`; no request is sent (per SC-1's unknown-key policy, `model_id` is the sole rejected key). (SC-1, SC-6)

16b. (SHOULD, conditional) **WHEN** the ElevenLabs streaming response surfaces model-version metadata, the module **SHOULD** assert it matches `eleven_v3` and emit a `tts.model_mismatch` warning on deviation. Pending API verification; tracked as fast-follow ticket **TTS-FF-001**. Until resolved, VERIFY asserts only 16a. (SC-1, SC-6)

17. **WHEN** a `stream()` POST fails after one or more audio chunks have been forwarded to the sink, the module **SHALL**:
    - (a) **Drain before retry:** immediately invoke `sink.stop()` (idempotent per SC-4) to terminate the player and discard in-flight audio. The module **SHALL** await sink teardown confirmation (player process exited, stdin closed) before initiating any retry.
    - (b) **Full-sentence retry:** only after (a) completes, the module MAY initiate a retry with a fresh `stream()` POST containing the full sentence text. No audio byte from a failed attempt **SHALL** reach the player after the first byte of its retry attempt. *Non-normative note: on this rare path the user may hear a partial fragment followed by the full retried sentence; this is an accepted v1 limitation, preferred over silently dropping sentence content.* The disclosure note is best-effort. If the disclosure note itself fails, it **SHALL NOT** trigger a further retry or disclosure cycle; the failure is logged and the sentence retry proceeds or exhausts per 17(c)–(d).
    - (c) **Bounded retries:** retry attempts per sentence **SHALL NOT** exceed `VoiceConfig.maxSentenceRetries` (default 2; i.e., at most 3 total `stream()` POSTs per sentence). The bound **SHALL** be finite in all configurations. *Note: `maxSentenceRetries` is a new `VoiceConfig` field (SC-1) defaulting to 2.*
    - (d) **Exhaustion is forward progress:** on retry exhaustion, the module **SHALL** emit a non-fatal `tts.sentence_failed` Bus event carrying the sentence text and terminal error (payload CC-11-compliant: no API key or secret material), then advance to the next queued sentence. The serialized pipeline **SHALL NOT** hang, block, or stall under any retry outcome.
    - (e) **Epoch inheritance:** a retry POST **SHALL** inherit the `utteranceGeneration` epoch current at retry initiation. If barge-in occurs between failure and retry, or during a retry, the retry's chunks **SHALL** be discarded by the standard SC-5 epoch check, the retry **SHALL** be cancelled, and the corresponding `tts.sentence_failed` emission **SHALL** be suppressed.
    - (f) **Forwarding model:** audio chunk forwarding is streaming (chunks piped as received), not buffered-then-piped; this is required to meet CC-10's SDK TTFA budget. The drain-and-retry sequence is what makes streaming compatible with req 14's ordering invariant. (SC-4, SC-5, CC-6, CC-10, CC-11)

---

## HOW

Implementation approach, FoxyBear best practices, explicit reuse map. No new mechanism where an existing one fits (CC-9).

### ElevenLabs SDK HTTP stream method (verified from spike)

The module uses the ElevenLabs SDK (`@elevenlabs/elevenlabs-js`) streaming TTS method, not a raw WebSocket:

- **Method:** `client.textToSpeech.stream(voiceId, { modelId, text, voice_settings, outputFormat })` — an HTTP POST to `/v1/text-to-speech/{voice_id}/stream` that returns a streaming response body. The SDK client is constructed with the API key from `process.env[VoiceConfig.apiKeyEnv]` — never the URL, never config files (CC-7). Production host `api.elevenlabs.io/`; US/EU/India/Singapore residency endpoints exist but are out of scope (default host only).
- **Per-sentence requests:** each sentence (per requirement 2) is an independent `stream()` call. There is no persistent connection, no `SendText`/`flush`/`AudioOutput`/`Finished` message protocol — the request body carries `{ modelId, text, voice_settings, outputFormat, pronunciation_dictionary_locators? }` and the response body streams audio bytes.
- **Critical gotcha (requirement 3):** the SDK expects `modelId` (camelCase). Passing `model_id` (snake_case) is silently stripped and the request falls back to the default v2 model with no error, losing v3 expressivity. This is a verified SDK behavior (see spike results). The module **SHALL** pass `modelId: VoiceConfig.modelId ?? "eleven_v3"`.
- **Audio tags (`[laughs]`, `[sighs]`, …):** sent **verbatim** inside the sentence `text` (SC-6, CC-3). v3 renders them; no special encoding, no SSML. `enable_ssml_parsing` is **not** set (requirement 4) — the v3 parser treats bracketed text as audio tags, not SSML.
- **Latency (spike-verified):** TTFA = ~1.1s per sentence. Total synthesis time per sentence = ~1-2s. The pipeline chains: play sentence N while synthesizing sentence N+1. The sink (SDD-04) handles its own playback queue, so audio playback overlaps with next-sentence synthesis without this module coordinating.

### Voice settings mapping (requirement 5)

SC-1 carries v3 presets; the SDK stream request body accepts a `voice_settings` object with a numeric `stability` plus the other fields. The module maps:

| `VoiceConfig.stability` (SC-1) | `voice_settings.stability` value | Intent |
|---|---|---|
| `creative` | low (per v3 docs, e.g. ~0.3) | most expressive, hallucination-prone — maximizes audio-tag responsiveness (CC-2) |
| `natural` (default) | mid (e.g. ~0.5) | balanced |
| `robust` | high (e.g. ~0.85) | most stable, ignores directional prompts |

The exact numeric per preset is **not published as a constant** in the research doc; the implementer **SHALL** confirm against ElevenLabs v3 docs and pin the values as named constants in the module. `speed`, `similarity_boost`, `style`, `use_speaker_boost` pass through from SC-1 numerically with no transformation. `voice_settings` travels in the per-sentence POST body (requirement 5); there is no connection-init message.

### Sentence accumulation and chunking (requirement 2)

The module receives text deltas from SDD-02 as an `AsyncIterable<string>` and accumulates them in a per-turn string buffer. Sentence boundaries are `.`, `!`, `?`, or `\n` at the end of the accumulated text. On a boundary, the accumulated sentence is sent to `client.textToSpeech.stream()` as a single request and the buffer is cleared. When SDD-02 signals turn completion (response-end detection owned by SDD-02), any remaining buffered text is flushed as a final sentence. Sentences are processed sequentially; the sink's playback queue (SDD-04) lets audio for sentence N play while sentence N+1 synthesizes.

### Retry and degradation (requirements 9–11)

- **Per-sentence retry:** each `stream()` POST is independent. A failed POST retries that sentence only — no replay buffer is needed. Retry bound is `VoiceConfig.maxSentenceRetries` (default 2 = 3 total POSTs) per req 17. Backoff is exponential (base delay e.g. 500ms doubled per attempt, capped, with jitter). 429 responses **SHALL** honor any `Retry-After` hint. Mid-stream failures (chunks already forwarded) follow req 17's drain-then-retry sequence.
- **On failure after retries:** skip that sentence, log a warning, continue the pipeline. The user hears a gap but subsequent sentences proceed normally.
- **Error classification (requirements 9 vs 10):**
  - **Non-retryable (req 10):** 401 / expired key, invalid `voice_id` (404), 400-class malformed request, auth header rejected. → set `VoiceMode.connected=false`, warn, degrade. No retry.
  - **Retryable (req 9):** network error (`ECONNRESET`, DNS transient), 429 rate limit, 5xx server error. → backoff + retry that sentence, max 3, then skip.
- **Degradation (req 11):** on a non-retryable error, the module sets `VoiceMode.connected=false` (SC-2), emits a TUI indicator (SDD-01 renders the actual indicator; this module publishes the state), terminates the sink's stream with a final `isFinal=true` chunk, and stops. It does **not** touch the LLM stream or the TUI text path.

### Reuse map and real anchors

- **`PluginInput.client`** (`packages/opencode/src/plugin/index.ts:126-135`) — available for any REST fallback (e.g. pronunciation-dictionary upload, a batch TTS fallback). **Not** used for the primary streaming path (the ElevenLabs SDK owns the HTTP POST). Referenced, not edited.
- **SC-3 text stream** (owned by SDD-02) — the module's `AsyncIterable<string>` input. The module does **not** subscribe to `message.part.delta` itself; SDD-02 hands it an already-filtered async iterable.
- **SC-4 audio chunk stream** (owned by SDD-04) — the module's `AsyncIterable<AudioChunk>` output. The module does **not** spawn `ffplay`/`mpv` or write to stdin; SDD-04 owns the sink and its playback queue.
- **SC-2 VoiceMode** (owned by SDD-01) — the module writes `connected` and `playing` transitions; it does **not** own the state object or its persistence (in-process, non-persistent per SC-2).
- **SC-5 Abort Ownership** (owned by SDD-01) — barge-in cancellation of the LLM is `client.session.abort`, called by SDD-01. This module only tears down its own TTS path on barge-in (requirement 12); it does **not** own an `AbortController` for the LLM stream.
- **CC-9 reuse:** no parallel HTTP/streaming mechanism is introduced. The module uses the `@elevenlabs/elevenlabs-js` SDK. The `which`-based player detection (`sound.ts:79-83`) and stdin-pipe spawning belong to SDD-04, not here.

### What is explicitly NOT built

- **No audio playback / player spawning** (SDD-04 owns the sink, SC-4).
- **No LLM stream tap / Bus subscription / TUI tag stripping** (SDD-02 owns SC-3 and CC-3 stripping).
- **No VoiceConfig parsing or `/voice`/`/mute` commands** (SDD-01 owns SC-1, SC-2, and the command surface).
- **No audio-tag vocabulary definition or system-prompt Enhance section** (SDD-05 owns SC-6).
- **No STT / microphone / Speech Engine turn-taking** (out of scope for the TTS suite per SDD-00).
- **No pronunciation-dictionary seeding/upload pipeline** (SDD-05 owns the dictionary content; this spec only references a pre-hosted locator by ID when `VoiceConfig.pronunciationDictionaryId` is set).
- **No opencode core modifications** (CC-1).

---

## VERIFY

Acceptance criteria for independent agents, exercising the module against a **mocked ElevenLabs SDK** (a fake `client.textToSpeech.stream` injected into the module that records call arguments, lets the test inject streaming response bytes / completion / errors, and asserts per-sentence call lifecycle). The SC-3 input is a test-driven `AsyncIterable<string>` (stand-in for SDD-02's tap); the SC-4 output is collected into an array for assertion (stand-in for SDD-04's sink). Each item is mapped 1:1 to a WHAT requirement. Every scenario states setup, action, expected observable.

- **V1 — lazy SDK init with auth + voice_id (req 1, CC-1/CC-4/CC-7).** Setup: `VoiceConfig` with `voiceId="vX"` and `apiKeyEnv="ELEVENLABS_API_KEY"`, env set, voice mode active, mocked SDK. Action: create the module and do NOT yet feed text; then feed one text delta `"Hello"`. Expected: zero `client.textToSpeech.stream` calls before a sentence boundary; the SDK client is constructed exactly once (lazily on the first sentence), initialized with the API key equal to `process.env.ELEVENLABS_API_KEY`. The key is read from the env var named in config, not hard-coded.

- **V2 — sentence accumulation + boundary detection, verbatim text incl. tags (req 2, SC-3/SC-6/CC-3).** Setup: feed the async iterable `["That's a fun way to break prod. ", "[laughs] ", "I'm kidding — sort of."]`. Action: drain. Expected: two `stream()` calls — the first with `text` = `"That's a fun way to break prod."` (boundary on `.`), the second with `text` = `"[laughs] I'm kidding — sort of."` (the `[laughs] ` delta accumulates into the second sentence and the boundary is the final `.`). The text is forwarded byte-equal to the accumulated sentence, **including** `"[laughs]"` verbatim — no stripping, no re-chunking, no escaping. Separately feed a delta ending in `\n` and assert it triggers a `stream()` call; feed a delta ending in `!` or `?` and assert the same.

- **V3 — `modelId` camelCase passed, not `model_id` (req 3, SC-1).** Setup: `VoiceConfig.modelId="eleven_v3"`. Action: trigger one sentence POST. Expected: the `stream()` options object contains `modelId: "eleven_v3"` (camelCase) and **does not** contain `model_id` (snake_case). Separately, assert via a mock that mimics the SDK's silent strip: when `model_id` is passed instead of `modelId`, the recorded outgoing request body contains `model_id` but the mock confirms the SDK would fall back to the default v2 model — the test asserts the module uses the camelCase key so this fallback never occurs.

- **V4 — `outputFormat` set, `enable_ssml_parsing` absent (req 4, SC-1/SC-6).** Setup: default `outputFormat="mp3_44100_128"`. Action: trigger one sentence POST. Expected: the `stream()` options object contains `outputFormat: "mp3_44100_128"` and **no** `enable_ssml_parsing` field. Repeat with a custom `outputFormat` and assert it passes through unchanged. Assert no extra/unknown option keys are present.

- **V5 — `voice_settings` in stream request body, stability mapped from preset (req 5, SC-1).** Setup: `VoiceConfig.stability="creative"`, plus explicit `speed`/`similarity_boost`/`style`/`use_speaker_boost`. Action: trigger one sentence POST. Expected: the `stream()` options object contains `voice_settings` with `stability` mapped from `creative` to the pinned creative numeric, and the other four fields passed through unchanged. The mapping is isolated in one helper (asserted by spy). No separate init/handshake message is sent — settings travel only in the per-sentence body.

- **V6 — `pronunciation_dictionary_locators` per sentence, omitted when unset (req 6, SC-1).** Setup: two configs — A (no `pronunciationDictionaryId`) and B (`pronunciationDictionaryId="dictZ"`). Action: trigger one sentence POST for each. Expected A: the `stream()` options object contains **no** `pronunciation_dictionary_locators`. Expected B: the `stream()` options object contains `pronunciation_dictionary_locators` referencing `dictZ`. Repeat with a multi-sentence turn in config B and assert the locator is present on **every** sentence POST (per-sentence, not per-connection).

- **V7 — audio chunks emitted with `isFinal=false`, sentences processed sequentially (req 7, SC-4/CC-4).** Setup: mock `stream()` to yield response bytes `[0x00,0x01,0x02]` for sentence 1 and `[0x03,0x04]` for sentence 2. Action: feed a two-sentence text stream. Expected: one `AudioChunk` (or chunk set) with `data` = `Uint8Array[0,1,2]`, `format` = `VoiceConfig.outputFormat`, `isFinal=false` from sentence 1; then `Uint8Array[3,4]`, `isFinal=false` from sentence 2. Sentence 2's `stream()` call is **not** issued until sentence 1's response body completes (assert via call ordering). Alignment data, if present on the wire, is ignored.

- **V8 — turn completion flushes buffer, final `isFinal=true`, `playing→false` after drain (req 8, SC-2/SC-3/SC-4).** Setup: feed chunks `"Hello world"` (no trailing boundary) then signal response-complete (SDD-02 contract). Action: drive completion. Expected: a `stream()` call is issued with `text` = `"Hello world"` (the remaining buffer flushed as a final sentence); after that sentence's audio stream completes, exactly one final `AudioChunk` with `isFinal=true` is emitted; the `AsyncIterable<AudioChunk>` completes (subsequent `next()` returns `{done:true}`); `VoiceMode.playing` transitions to false **after** the sink drains (assert the transition is gated on sink drain, not on stream completion alone, via a sink that delays drain).

- **V9 — per-sentence retry, max 3, exponential backoff, skip on failure (req 9, CC-5).** Setup: a mocked `stream()` that rejects (network error / 429 / 5xx) on the first two attempts for one sentence and succeeds on the third; fast-backoff (no real sleeps — inject a fake clock). Action: feed a multi-sentence stream where sentence 2 fails-then-succeeds. Expected: exactly 3 `stream()` attempts for sentence 2; delays are exponential (base×2^n with jitter) and a 429 case honors an injected `Retry-After`; on the 3rd success audio for sentence 2 resumes and sentence 3 proceeds. Then setup B: all 3 attempts fail for one sentence. Expected: after attempt 3 fails, the sentence is skipped, a warning is logged, and the pipeline continues to the next sentence (the user hears a gap but does not stall). No replay buffer is read or written — each `stream()` call carries only that sentence's text.

- **V10 — non-retryable error: no retry, `connected=false`, warn, no crash (req 10, CC-5/SC-2).** Setup: mock `stream()` to reject with 401/expired key; separately, a 404 not-found `voice_id`; separately, a 400 malformed request. Action: observe. Expected: in all three cases **zero** retry attempts; `VoiceMode.connected` set false; a TUI warning naming the class (auth/voice-id/malformed); the session loop is not crashed (the module returns normally); the raw API message is logged.

- **V11 — graceful degradation on non-retryable: `connected=false`, indicator, sink terminated, session unblocked, re-arm possible (req 11, CC-5/SC-2).** Setup: V10 setup (non-retryable). Action: trigger degradation. Expected: `VoiceMode.connected=false`; a TUI-status-indicator signal published; the sink receives a final `AudioChunk` with `isFinal=true` (so SDD-04 stops); the module returns and the session loop continues rendering text; a subsequent `/voice` re-arm (SDD-01) can produce a fresh turn that constructs a new SDK client normally.

- **V12 — teardown/barge-in stops new sentences, sink stopped, barge-in drops pending buffer (req 12, CC-6/SC-2/SC-4/SC-5).** Setup: mid-turn with sentences synthesizing. Action A (generic teardown): trigger plugin unload. Expected: no further `stream()` calls are issued; no further `AudioChunk`s emitted; the per-turn buffer is cleared. Action B (barge-in): trigger barge-in while audio is playing. Expected: the module stops accumulating text; the sink's `stop()` method is called (SC-4) to kill playback and is idempotent (assert calling it twice produces no throw); pending buffered sentences are **not** sent (no further `stream()` calls); post-stop chunks from in-flight responses are dropped via the epoch token (see V13); the module does **not** call `client.session.abort` (that is SDD-01's job per SC-5 — assert via a spy that the module never touches the SDK abort API).

- **V13 — epoch token drops stale post-barge-in chunks (req 13, SC-4/SC-5/CC-6).** Setup: mid-turn with one sentence's `stream()` response still in-flight (mock yields bytes slowly). Action: trigger barge-in; continue yielding bytes from the in-flight response. Expected: the `utteranceGeneration` epoch token increments exactly once on barge-in; every chunk yielded by the stale in-flight response is dropped (never forwarded to the sink) — assert zero `AudioChunk`s from the stale response reach the sink after barge-in; the sink's `stop()` (SC-4) was called and is safe to call again (idempotency asserted by calling twice and observing no throw).

- **V14 — serialized ordering: one in-flight POST, no out-of-order playback (req 14, CC-4).** Setup: a three-sentence turn where sentence 2 fails twice then succeeds; sentence 3's mock `stream()` resolves quickly. Action: feed the text stream. Expected: at no point are two `stream()` POSTs in-flight simultaneously (assert via a concurrency spy that records overlapping call windows — zero overlaps); sentence 3 is **not** issued until sentence 2 completes (or is dropped on retry exhaustion); in a separate setup where sentence 2 exhausts retries and is dropped, sentence 3 plays next and sentence 2's late retry **never** plays after sentence 3. Out-of-order playback does not occur.

- **V15 — flush semantics: boundaries, multi-sentence deltas, residual, abort, suppression, max-buffer (req 15, SC-3/CC-4).** Setup: drive the buffer with several scenarios. (a) Boundaries: feed `"Hi. Bye!"` as one delta — expect two `stream()` calls with `text` = `"Hi."` then `"Bye!"` (delimiter included). (b) Multi-sentence delta: feed `"One. Two. Three."` in a single delta — expect three `stream()` calls in order. (c) Residual: feed `"Hello world"` (no boundary) then signal response-end — expect one final `stream()` call with `text` = `"Hello world"`. (d) Abort: feed `"Partial"` then trigger barge-in — expect zero `stream()` calls for the residual (discarded per epoch). (e) Empty-chunk suppression: feed `"   "`, then `"."`, then `"[laughs]"` with no surrounding text — expect zero `stream()` calls (whitespace-only, delimiter-only, and tag-stripped-empty suppressed). (f) Max-buffer: feed a 600-character span with no punctuation — expect a forced `stream()` call by 500 characters (split at the most recent whitespace, or exactly 500 with `force_split` if no whitespace exists between 400 and 500) and the buffer cleared. (g) Known limitation: feed `"Dr. Smith arrived."` — accept that this yields `"Dr."` then `"Smith arrived."` (v1 limitation, no assertion failure).
- **V15.4 — Boundary in window (req 15).** Input with a sentence boundary at codepoint offset ~420. Assert: split occurs at that boundary, not at 500; neither fragment exceeds 500 codepoints.
- **V15.5 — Whitespace fallback (req 15).** Input with no sentence boundary in [400, 500) but whitespace at offset ~480. Assert: split at last whitespace before 500; second fragment begins at non-whitespace.
- **V15.6 — No-whitespace force-split, multi-byte safety (req 15).** Input with no whitespace before 500, containing a 4-byte UTF-8 sequence (e.g., emoji) spanning the boundary such that offset 500 falls mid-sequence. Assert: split retreats to the preceding codepoint boundary; both fragments are valid UTF-8, contain no truncated codepoint, and are POSTable to the SDK without encoding error.

- **V16 — `model_id` rejected at init (req 16a, SC-1/SC-6).** Setup: pass a VoiceConfig containing a `model_id` (snake_case) key. Action: initialize the module. Expected: initialization rejects the key with an actionable error message identifying the correct camelCase `modelId`; no request is sent. Req 16b (v2-fallback model-version metadata detection) is pending API verification (fast-follow **TTS-FF-001**) and is not asserted here.

- **V17.1 — Mid-stream failure drains player (req 17a, SC-4).** Mock `stream()` yields 2 chunks then throws. Assert `sink.stop()` is invoked and teardown confirmed before the next `stream()` call; assert stop/start sequence has no overlap.

- **V17.2 — Retry bound enforced (req 17c, SC-1).** Mock `stream()` always throws after 1 chunk. Assert exactly 3 POSTs for the sentence (default config), then `tts.sentence_failed` emission, then processing of the next queued sentence.

- **V17.3 — Exhaustion liveness (req 17d, CC-5).** Queue 3 sentences; mock the second to always fail. Assert all 3 are dispatched within a bounded window; second emits `tts.sentence_failed`; third plays normally.

- **V17.4 — Barge-in cancels pending retry (req 17e, SC-5/CC-6).** Force mid-stream failure on sentence A; trigger barge-in before A's retry POST. Assert no retry POST occurs; assert `tts.sentence_failed` suppressed; assert post-barge-in sentence B plays normally.

- **V17.5 — No cross-attempt byte interleaving (req 17a/17b, SC-4).** Run V17.1 with a mock player recording byte-arrival order. Assert no bytes from the failed attempt arrive after the retry's first byte. V17.5 assertion boundary: the sink/pipe input. The test verifies that no bytes from a prior attempt are forwarded to the pipe after the retry begins. It does not assert that no bytes from the prior attempt are ever audible — a sub-millisecond residual from bytes already in the pipe/player buffer is admitted by W1-a (SC-5) and is out of scope for this test.

- **V17.6 — Ordering preserved across retry (req 14/17b, CC-4).** Sentence A fails once then succeeds on retry; sentence B is queued. Assert B's first audio byte arrives only after A's retry completes or A is terminally failed.

- **V17.7 — Secret hygiene of failure event (req 17d, CC-11).** Inspect `tts.sentence_failed` payload under forced failure with a known API key in config. Assert key absent from payload (CC-11).

- **V18 — build/regression green (CC-8).** `bun run typecheck` passes and `bun test` is fully green from `packages/opencode`, including the new `ElevenLabsTTS` tests above and the untouched plugin/session/sound suites. A feature is not done with any red test.
