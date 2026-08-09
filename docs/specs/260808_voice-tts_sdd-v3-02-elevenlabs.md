# SDD-02 v3: ElevenLabs TTS Streaming

**Date:** 2026-08-08
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft v3 (pending independent audit + human gate)
**Master:** `docs/specs/260808_voice-tts_sdd-v3-00-master.md`
**Depends on:** SC-1 (VoiceConfig), SC-3 (Text Stream, owned by SDD-01), SC-4 (Audio Chunk Stream, owned by SDD-03).

This feature spec covers the ElevenLabs SDK HTTP streaming TTS integration (`client.textToSpeech.stream`) and the sentence-chunked text→audio pipeline. It inherits all cross-cutting requirements (CC-1..CC-12). This spec is the v1 SDD-03 with no architectural changes — only the v3 shared contract references are updated.

## Background

The module is a pure transform between two async iterables:

```
SC-3 (SDD-01)                SDD-02 (this spec)              SC-4 (SDD-03)
AsyncIterable<string>  ──►  SDK stream() per sentence  ──►  AsyncIterable<AudioChunk>
(text deltas, verbatim,      (HTTP POST /v1/text-to-speech/    (decoded audio bytes,
 including audio tags)         {voice_id}/stream)              isFinal on completion)
```

- **Input:** the `AsyncIterable<string>` from SDD-01's text stream tap (SC-3). Each string is an assistant text delta, including inline audio tags.
- **Output:** an `AsyncIterable<AudioChunk>` (SC-4) consumed by SDD-03's audio sink.
- **Transport:** ElevenLabs SDK (`@elevenlabs/elevenlabs-js`) method `client.textToSpeech.stream(voiceId, { modelId, text, voice_settings, outputFormat })`.

Spike results (verified):
- Model: `eleven_v3` (does NOT support `optimizeStreamingLatency` — returns 400)
- Voice ID: `xVQH621DS3eyBYrseRt5` (Katya's voice, confirmed by Todd)
- TTFA: ~1.1s per sentence
- SDK expects `modelId` (camelCase), NOT `model_id` (snake_case — silently stripped)

---

## WHAT

1. **WHEN** voice mode transitions to active and a new assistant turn begins streaming, the module **SHALL** initialize the ElevenLabs SDK client with the API key from `process.env[VoiceConfig.apiKeyEnv]` (SC-1, CC-7). The SDK client **SHALL** be initialized lazily on the first text delta, not eagerly on `/voice`. (CC-1, CC-4)

2. **WHEN** text deltas arrive from the SC-3 text stream, the module **SHALL** accumulate text until a sentence boundary is detected — `.`, `!`, `?`, or `\n` at the end of accumulated text. When a boundary is detected, the accumulated text **SHALL** be **split at all detected boundaries** and each sentence **SHALL** be sent as a separate `stream()` request, in source order. The buffer **SHALL** be cleared after all sentences from the accumulated text have been sent. (SC-3, SC-6, CC-3)

3. **WHEN** the module calls `client.textToSpeech.stream()`, it **SHALL** pass the model ID as `modelId` (camelCase): `client.textToSpeech.stream(voiceId, { modelId: VoiceConfig.modelId ?? "eleven_v3", text, voice_settings, outputFormat })`. Using `model_id` (snake_case) is silently stripped by the SDK. (SC-1)

4. **WHEN** the module calls `stream()`, it **SHALL** set `outputFormat` from `VoiceConfig.outputFormat` (default `mp3_44100_128`) and **SHALL NOT** set `enable_ssml_parsing`. (SC-1, SC-6)

5. **WHEN** the module calls `stream()`, it **SHALL** include `voice_settings` mapped from `VoiceConfig`: `{ stability, similarity_boost, style, use_speaker_boost, speed, language }`. The `stability` value **SHALL** be mapped from the v3 preset (`creative`/`natural`/`robust`). `language` (default `"en"`) **SHALL** be included to pin the language. (SC-1)

6. **WHEN** `VoiceConfig.pronunciationDictionaryId` is set, the module **SHALL** include `pronunciation_dictionary_locators` in the stream request body. When unset, the field **SHALL** be omitted. (SC-1)

7. **WHEN** audio bytes arrive in the streaming response body, the module **SHALL** decode them and emit `AudioChunk` objects (SC-4) with `data` = decoded bytes, `format` = `VoiceConfig.outputFormat`, `isFinal=false`. Sentences **SHALL** be processed sequentially — sentence N+1 **SHALL NOT** be sent until sentence N's audio stream completes. (SC-4, CC-4)

8. **WHEN** the assistant response is complete (SDD-01 signals response-end), the module **SHALL** flush remaining buffered text as a final sentence POST and **SHALL** emit exactly one final `AudioChunk` with `isFinal=true`. (SC-2, SC-3, SC-4)

9. **WHEN** a sentence POST fails (network error, 429, or 5xx), the module **SHALL** retry that sentence only. Retry attempts per sentence **SHALL NOT** exceed `VoiceConfig.maxSentenceRetries` (default 3; 4 total POSTs per sentence). Backoff is exponential with jitter. 429 responses **SHALL** honor `Retry-After`. On failure after retries, the module **SHALL** skip that sentence and continue. (CC-5, SC-1)

10. **WHEN** a non-retryable error occurs (401, expired key, invalid voice_id 404, 400 malformed), the module **SHALL NOT** retry, **SHALL** set `VoiceMode.connected = false` (SC-2), surface a TUI warning, fall back to text-only, and **SHALL NOT** crash the session loop. (CC-5, SC-2)

11. **WHEN** teardown or barge-in occurs, the module **SHALL** stop accumulating text, stop issuing new sentence POSTs, stop emitting AudioChunks, and release the SDK client. On barge-in, the module **SHALL** call the sink's `stop()` method (SC-4). The module **SHALL NOT** call `client.session.abort` (that is SDD-01's job per SC-5). (CC-6, SC-2, SC-4, SC-5)

12. **WHEN** barge-in occurs, the module **SHALL** increment a per-session monotonic epoch token. Each audio chunk from an in-flight `stream()` response **SHALL** be checked against the current epoch before forwarding to the sink. Stale-epoch chunks **SHALL** be dropped. (SC-4, SC-5, CC-6)

13. **WHEN** processing sentences, only one `stream()` POST **SHALL** be in-flight at a time. A sentence that fails synthesis **SHALL** be retried up to 3 times; on exhaustion it **SHALL** be dropped and the pipeline **SHALL** advance. Out-of-order playback **SHALL NOT** occur. (CC-4)

14. **WHEN** text deltas arrive, the module **SHALL** apply flush semantics: flush on `.`, `!`, `?`, `\n` at end of accumulated text; multi-sentence deltas produce one POST per sentence in source order; trailing incomplete text remains buffered until response-end; unsent residual discarded on barge-in; whitespace-only/delimiter-only/tag-stripped-empty chunks suppressed; max-buffer safeguard splits at 400-500 codepoints. (SC-3, CC-4)

15. **WHEN** the module parses VoiceConfig, it **SHALL** reject `model_id` (snake_case) as an unknown key with an actionable error message identifying the correct camelCase `modelId`. (SC-1, SC-6)

16. **WHEN** a `stream()` POST fails after one or more audio chunks have been forwarded to the sink, the module **SHALL**: (a) call `sink.stop()` (idempotent per SC-4) to terminate the player and discard in-flight audio before retrying; (b) only after (a) completes, MAY initiate a retry with a fresh `stream()` POST containing the full sentence text — no audio byte from the failed attempt SHALL reach the player after the first byte of its retry; (c) retry attempts SHALL NOT exceed `maxSentenceRetries` (default 3); (d) on exhaustion, emit a non-fatal `tts.sentence_failed` Bus event (CC-11-compliant: no API key or secret) and advance to the next sentence; (e) a retry POST SHALL inherit the current epoch token — if barge-in occurs during retry, the retry's chunks SHALL be discarded by the standard epoch check; (f) audio chunk forwarding is streaming (chunks piped as received), not buffered-then-piped. (SC-4, SC-5, CC-6, CC-10, CC-11)

---

## HOW

### ElevenLabs SDK HTTP stream method

- **Method:** `client.textToSpeech.stream(voiceId, { modelId, text, voice_settings, outputFormat })`
- **Per-sentence requests:** each sentence is an independent `stream()` call. No persistent connection, no WebSocket.
- **Critical gotcha:** pass `modelId` (camelCase), NOT `model_id` (snake_case).
- **Latency:** TTFA ~1.1s per sentence. Pipeline chains: play sentence N while synthesizing N+1.

### Voice settings mapping

| `VoiceConfig.stability` | `voice_settings.stability` value | Intent |
|---|---|---|
| `creative` | low (~0.3) | most expressive, hallucination-prone — maximizes audio-tag responsiveness (CC-2) |
| `natural` (default) | mid (~0.5) | balanced |
| `robust` | N/A — **rejected at config validation** | Robust suppresses directional prompts per the v3 prompting guide, defeating audio tags. The config validator rejects `stability: "robust"` with an actionable error. It is never mapped to a stability value. |

`speed`, `similarity_boost`, `style`, `use_speaker_boost` pass through numerically. `language` pins the language.

### Sentence accumulation and chunking

Accumulate text deltas in a per-turn buffer. On boundary (`.`, `!`, `?`, `\n`), send accumulated sentence via `stream()` and clear buffer. On response-end, flush remaining text as final sentence. Max-buffer safeguard at 400/500 codepoints.

### Retry and degradation

- **Per-sentence retry:** each `stream()` POST is independent. Failed POST retries that sentence only. Bound: `maxSentenceRetries` (default 3 = 4 total POSTs). Exponential backoff with jitter. 429 honors `Retry-After`. Mid-stream failures (chunks already forwarded to the sink) follow the drain-before-retry sequence (req 16).
- **Non-retryable (req 10):** 401, expired key, 404 voice_id, 400 malformed. No retry. Set `connected=false`, warn, degrade.
- **Degradation:** set `VoiceMode.connected=false`, terminate sink with `isFinal=true`, stop. Text continues via TUI.

### Reuse map

| Concern | Reused surface | Anchor |
|---|---|---|
| ElevenLabs SDK | `@elevenlabs/elevenlabs-js` | npm package |
| `client.textToSpeech.stream()` | SDK method | spike-verified |
| SC-3 text stream | `AsyncIterable<string>` from SDD-01 | SC-3 |
| SC-4 audio chunk stream | `AsyncIterable<AudioChunk>` to SDD-03 | SC-4 |
| SC-2 VoiceMode | state writes | SDD-01 |
| SC-5 Abort Ownership | `client.session.abort` called by SDD-01 | SC-5 |

### What is explicitly NOT built

- No VoiceEngine interface — direct function calls to SDK.
- No EventQueue — simple async generator or callback-based pipeline.
- No audio playback / player spawning (SDD-03 owns the sink).
- No LLM stream tap / Bus subscription (SDD-01 owns the event hook).
- No VoiceConfig parsing (SDD-01 owns config).
- No opencode core modifications (CC-1).

---

## VERIFY

- **V1 — lazy SDK init (req 1, CC-1/CC-4/CC-7).** Setup: valid config, voice active, mocked SDK. Action: create module, feed one text delta. Expected: SDK client constructed lazily on first sentence; API key read from env var.

- **V2 — sentence accumulation + boundary detection (req 2, SC-3/SC-6/CC-3).** Setup: feed `["That's a fun way. ", "[laughs] ", "I'm kidding."]`. Expected: two `stream()` calls; first with `"That's a fun way."`, second with `"[laughs] I'm kidding."`; text forwarded byte-equal including `[laughs]`.

- **V3 — modelId camelCase (req 3, SC-1).** Setup: `VoiceConfig.modelId="eleven_v3"`. Action: trigger one sentence POST. Expected: `stream()` options contains `modelId: "eleven_v3"` (camelCase); no `model_id` (snake_case).

- **V4 — outputFormat set, enable_ssml absent (req 4, SC-1/SC-6).** Action: trigger one sentence POST. Expected: `outputFormat: "mp3_44100_128"` present; `enable_ssml_parsing` absent.

- **V5 — voice_settings mapped (req 5, SC-1).** Setup: `stability="creative"`. Action: trigger POST. Expected: `voice_settings` with `stability` mapped from creative to numeric; other fields passed through.

- **V6 — pronunciation dictionary per sentence (req 6, SC-1).** Setup A (no dict): no `pronunciation_dictionary_locators`. Setup B (dict set): locator present on every sentence POST.

- **V7 — audio chunks emitted, sequential (req 7, SC-4/CC-4).** Setup: mock `stream()` yields bytes. Action: feed two-sentence stream. Expected: chunks from sentence 1 before sentence 2; sentence 2's POST not issued until sentence 1 completes.

- **V8 — turn completion flushes buffer, final isFinal (req 8, SC-2/SC-3/SC-4).** Setup: feed `"Hello world"` (no boundary) then signal response-complete. Expected: one `stream()` call with `"Hello world"`; one final `AudioChunk` with `isFinal=true`.

- **V9 — per-sentence retry (req 9, CC-5).** Setup: mock fails twice then succeeds. Expected: 3 POSTs; exponential backoff; 429 honors `Retry-After`; on success audio resumes. Setup B: all 3 fail. Expected: sentence skipped, pipeline continues.

- **V10 — non-retryable error (req 10, CC-5/SC-2).** Setup: mock returns 401. Expected: zero retries; `connected=false`; TUI warning; session not crashed.

- **V11 — graceful degradation (req 10 cont.).** Expected: `connected=false`; sink terminated with `isFinal=true`; session continues; `/voice` re-arm works.

- **V12 — teardown/barge-in (req 11, CC-6/SC-2/SC-4/SC-5).** Setup: mid-turn. Action A (teardown): no further `stream()` calls; buffer cleared. Action B (barge-in): sink `stop()` called; no `client.session.abort` called by this module.

- **V13 — epoch token drops stale chunks (req 12, SC-4/SC-5/CC-6).** Setup: mid-turn with in-flight response. Action: trigger barge-in; continue yielding bytes. Expected: epoch increments; stale chunks dropped; zero chunks reach sink after barge-in.

- **V14 — serialized ordering (req 13, CC-4).** Setup: three-sentence turn, sentence 2 fails twice then succeeds. Expected: zero overlapping POSTs; sentence 3 not issued until sentence 2 completes; no out-of-order playback.

- **V15 — flush semantics (req 14, SC-3/CC-4).** (a) `"Hi. Bye!"` → two POSTs. (b) `"One. Two. Three."` → three POSTs in order. (c) `"Hello world"` + response-end → one POST. (d) `"Partial"` + barge-in → zero POSTs. (e) `"   "` → zero POSTs (suppressed). (f) 600-char no punctuation → forced split by 500 codepoints.

- **V16 — model_id rejected at init (req 15, SC-1/SC-6).** Setup: config with `model_id` (snake_case). Expected: rejected with actionable error; no request sent.

- **V17 — Mid-stream failure drains player before retry (req 16a, SC-4).** Setup: mock `stream()` yields 2 chunks then throws. Action: trigger sentence POST. Expected: `sink.stop()` is invoked and teardown confirmed before the next `stream()` call; no overlap between stop and retry.

- **V18 — Retry bound enforced on mid-stream failure (req 16c, SC-1).** Setup: mock `stream()` always throws after 1 chunk. Expected: exactly 4 POSTs for the sentence (default config), then `tts.sentence_failed` emission, then processing of the next queued sentence.

- **V19 — Exhaustion liveness on mid-stream failure (req 16d, CC-5).** Setup: queue 3 sentences; mock the second to always fail mid-stream. Expected: all 3 are dispatched within a bounded window; second emits `tts.sentence_failed`; third plays normally.

- **V20 — Barge-in cancels pending retry (req 16e, SC-5/CC-6).** Setup: force mid-stream failure on sentence A; trigger barge-in before A's retry POST. Expected: no retry POST occurs; `tts.sentence_failed` suppressed; post-barge-in sentence B plays normally.

- **V21 — Secret hygiene of failure event (req 16d, CC-11).** Setup: force failure with a known API key in config. Expected: `tts.sentence_failed` payload does not contain the API key or any secret material.

- **V22 — build/regression green (CC-8).** `bun run typecheck` passes and `bun test` green.
