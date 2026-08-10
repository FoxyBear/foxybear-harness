# Voice TTS v3 — Pragmatic Code Review

**Reviewer:** GLM-5.2 (Katya)
**Date:** 2026-08-10
**Commit:** `b3dcbdf4d`
**Scope:** Voice TTS v3 plugin, sink, TTS client, HTTP route, TUI wiring, config, tests.

**Tests:** 212 pass, 0 fail. Typecheck: clean.

---

## Summary

Architecturally sound. Plugin/sink/TTS separation is clean, HTTP route correctly replaces the old command-path approach, real `AudioSink` replaces the old noop, internal plugin registration is correct, and the test suite has genuine behavioral assertions. The commit message says "noReply wiring" but the voice plugin correctly contains no `noReply` or `command.execute.before` hooks — those were cleaned up properly. `command/index.ts` has no voice/mute registrations. `harness/commands.ts` correctly renamed `status` → `daemon`.

But two production bugs will bite: barge-in is dead code (user can't interrupt TTS), and API key resolution is inconsistent between activation and the ElevenLabs client factory (silent 401s with custom env var names).

---

## Blocking Issues

### B1 — `m.playing` never set to `true` — barge-in is dead code

**File:** `packages/opencode/src/voice/plugin.ts`

`VoiceMode.playing` is initialized to `false` (line 146), set to `false` in `deactivate()` (line 213) and `bargeIn()` (line 251), but **never set to `true` anywhere in production code**. The `session.status` handler guards barge-in on it:

```ts
// plugin.ts:365-374
if (type === "session.status") {
  const m = getMode(sessionID)
  if (m.active && m.playing) {   // ← m.playing always false
    bargeIn(sessionID)            // ← never reached
  }
}
```

`session.status` fires with `type: "busy"` at the start of every run loop (`prompt.ts:1315`). The intent: when the user sends a new message while TTS is playing, barge-in stops the audio and aborts the LLM session. With `m.playing` stuck at `false`, this never fires.

**Production impact:** User sends a new message while Katya is speaking. The audio keeps playing over their typing. The `session.abort` call never happens. The only way to stop audio is `/mute` or waiting for it to finish.

**Why tests pass:** Tests manually set `m.playing = true` (`sdd-v3-01.test.ts:275`, `sdd-v3-01.test.ts:330`, `sdd-v3-01.test.ts:353`). No test verifies the production event flow sets `m.playing` correctly — because it doesn't.

**Fix:** Wire `m.playing` to actual TTS state. Either:
- Add an `onPlaying` / `onIdle` callback to `VoiceTTSOpts`, fire from `synth()` when the first chunk is written and from `flush()` / `bargeIn()` / `teardown()`.
- Or in the `message.part.delta` handler, set `m.playing = true` after `tts.feed()` and clear it in the `message.updated` handler after `tts.flush()` completes.

The first approach is more accurate (tracks actual audio output, not just text feeding).

---

### B2 — API key resolution inconsistency between `resolveKey()` and `defaultFactory`

**Files:** `packages/opencode/src/voice/plugin.ts:180`, `packages/opencode/src/voice/elevenlabs.ts:57`

Two different heuristics decide whether `cfg.apiKeyEnv` is an env var name or a literal key:

```ts
// plugin.ts:resolveKey() — used for activation
if (/^[A-Z_][A-Z0-9_]*$/.test(v) && v.length < 64) {
  return process.env[v] ?? null    // treat as env var name
}
return v                           // treat as literal

// elevenlabs.ts:defaultFactory() — used for actual API calls
const apiKey = cfg.apiKeyEnv.startsWith("ELEVENLABS")
  ? process.env[cfg.apiKeyEnv]     // treat as env var name
  : cfg.apiKeyEnv                  // treat as literal
```

**The broken case:** `apiKeyEnv = "VOICE_API_KEY"` (or any all-caps name not starting with "ELEVENLABS").

- `resolveKey()`: matches the regex → reads `process.env.VOICE_API_KEY` → returns the key. **Activation succeeds.** User sees "Voice on."
- `defaultFactory`: doesn't start with "ELEVENLABS" → passes `"VOICE_API_KEY"` as the literal API key to `ElevenLabsClient`. **Every TTS request fails with 401.** TTS degrades silently.

User sees "Voice on." but never hears audio. No error in the TUI — just `tts.degraded` in the log.

**Cases that work (both heuristics agree):**
- `apiKeyEnv = "ELEVENLABS_API_KEY"` (default) — both treat as env var. ✓
- `apiKeyEnv = "sk_abc123..."` (literal key via `{file:...}` config preprocessor) — both treat as literal. ✓
- `apiKeyEnv = "ELEVENLABS_KEY"` (custom, starts with prefix) — both treat as env var. ✓

**Cases that break:**
- `apiKeyEnv = "VOICE_KEY"` — `resolveKey` treats as env var, `defaultFactory` treats as literal. ✗
- `apiKeyEnv = "TTS_API_KEY"` — same mismatch. ✗

**Fix:** Use a single shared resolution function. Pass the resolved key into `VoiceTTSOpts` instead of `cfg.apiKeyEnv`, so `defaultFactory` receives the actual key string:

```ts
// In getTTS():
const apiKey = resolveKey()
if (!apiKey) return null
tts = new VoiceTTS({ cfg, sink, bus, apiKey, onDegraded, ... })
```

Then `defaultFactory` just uses the resolved key directly:
```ts
const defaultFactory: ClientFactory = async (cfg, apiKey) => {
  const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js")
  return new ElevenLabsClient({ apiKey })
}
```

---

## Non-Blocking Issues

### N1 — `stopAudio()` is dead code

**File:** `packages/opencode/src/voice/plugin.ts:241`

```ts
function stopAudio(sessionID: string) {
  const tts = ttsInstances.get(sessionID)
  if (tts) void tts.bargeIn()
}
```

Defined but never called from production code or tests. Remove it or wire it up. If it was intended as the barge-in entry point for B1, it should be called from the `session.status` handler.

### N2 — `[muttering]` tag gap

**File:** `packages/opencode/src/voice/expressivity.ts`

The Enhance section uses `[muttering]` in an example (line 99): `"I guess you're right. [sighs] It's just... [muttering] difficult."` The Tone Guide lists `[muttering]` as forbidden (line 167). But `AUDIO_TAG_VOCABULARY` does not include `[muttering]`, so `stripTags()` won't strip it. If the model emits it (which the Enhance example trains it to), it appears as visible noise in the terminal.

The design intent (leave unknown brackets visible as regression signals) is correct for truly unexpected tags. But `[muttering]` is explicitly taught by the Enhance section, so it's a known emission — it should be in the vocabulary and stripped.

**Fix:** Add `"[muttering]"` to `AUDIO_TAG_VOCABULARY`, or remove it from the Enhance section example.

### N3 — Empty string sessionID passes schema validation

**File:** `packages/opencode/src/server/instance/voice.ts:30`

`SessionID.zod` is `z.string()` branded — no `.min(1)`. Empty string `""` passes validation, then `Session.get("")` throws `NotFoundError` → 404. Not a crash, but the 404 is less clear than a 400 "sessionID required." Add `.min(1)` to the route validator:

```ts
validator("json", z.object({ sessionID: SessionID.zod.min(1) }))
```

### N4 — No defensive type checks on hook outputs

**File:** `packages/opencode/src/voice/plugin.ts:388-397`

```ts
"experimental.text.complete": async (_input, output) => {
  if (!cfg) return
  output.text = stripTags(output.text)    // crashes if output.text is not a string
},
"experimental.chat.system.transform": async (_input, output) => {
  if (!cfg) return
  output.system.push(ENHANCE_SECTION)     // crashes if output.system is not an array
},
```

Both assume the caller provides the correct shape. The hook contract guarantees this, but a defensive check (`if (typeof output.text !== "string") return`) costs nothing and prevents a crash if the contract changes.

### N5 — `textParts` Map accumulates for inactive sessions

**File:** `packages/opencode/src/voice/plugin.ts:42, 312-318`

`message.part.updated` populates `textParts` for every session, regardless of whether voice is active. If voice is not configured (`cfg` is null) or the session never activates, the `textParts` entry persists until `session.deleted` or `resetState()`. On a long-running server with many sessions, this is a minor memory leak. Add a `cfg` guard at the top of the `message.part.updated` handler:

```ts
if (type === "message.part.updated") {
  if (!cfg) return    // ← skip if voice not configured
  ...
}
```

### N6 — No test for out-of-order `PartUpdated` / `PartDelta`

**File:** `packages/opencode/test/voice/verify/sdd-v3-01.test.ts:172-196`

The `PartUpdated` correlation assumes `message.part.updated` arrives before `message.part.delta`. If they arrive out of order, the delta is silently dropped. No test covers this. The bus is sequential (`Stream.runForEach`), so this likely never happens in practice, but the code is fragile — a future change to event ordering would break silently.

### N7 — Sham test: V22 "typecheck and test suite pass"

**File:** `packages/opencode/test/voice/verify/sdd-v3-02.test.ts:739-744`

```ts
test("typecheck and test suite pass", () => {
  expect(VoiceTTS).toBeDefined()
  expect(typeof VoiceTTS).toBe("function")
})
```

This doesn't test typecheck or the test suite. It checks that a class is constructable. The test name is misleading. Either rename it or remove it. Same pattern in `sdd-v3-03.test.ts:291-296`.

### N8 — `experimental.chat.system.transform` injects prompts only when `cfg` is set

**File:** `packages/opencode/src/voice/plugin.ts:393-397`

If `config.voice` is absent from the config file, `cfg` stays `null`, and the Enhance section + Tone Guide are never injected. This means Katya's personality (defined in the Tone Guide) is only active when voice is configured. This may be intentional (the guide is part of the voice plugin), but if the Tone Guide defines Katya's behavior regardless of voice, it should inject even without voice config. Design decision — not a code bug.

---

## What Works Well

- **Internal plugin registration** (`plugin/index.ts:66`) — `VoicePlugin` is in `INTERNAL_PLUGINS`, loaded directly, no external package needed. Clean.
- **HTTP route** (`server/instance/voice.ts`) — correct session validation via `Session.get()`, proper error responses (400 for bad body, 404 for missing session), synchronous state mutation before response.
- **TUI wiring** (`app.tsx:607-649`) — slash commands `/voice` and `/mute` call the HTTP route, no direct plugin imports. Clean separation.
- **Epoch-based cancellation** (`elevenlabs.ts:175-179, 234, 242`) — barge-in increments epoch, synth checks epoch at each chunk boundary, stale chunks dropped. Correct.
- **Serialized sentence ordering** (`elevenlabs.ts:152-155`) — `this.queue.then(() => this.synth(sentence))` ensures no overlapping POSTs. Tests V14 and V7 verify this.
- **Retry with backoff** (`elevenlabs.ts:233-268`) — 429/5xx retried with exponential backoff + jitter, 401/404/400 are fatal, mid-stream failure drains player before retry. Tests V9, V17, V18, V19, V20 cover this thoroughly.
- **Real AudioSink** (`sink.ts`) — stdin-piped player, auto-detection with preference override, ENOENT re-detection, gen-based write suppression after stop. Tests V1-V15 in sdd-v3-03 are real behavioral tests.
- **Tag stripping** (`plugin.ts:171-178`) — vocabulary-based, regex-escaped, whitespace-collapsed. Invalid tags left visible as regression signals. Correct design.
- **Config validation** — `model_id` rejected with actionable error, `stability: "robust"` rejected for v3. Good DX.
- **Pronunciation dictionary** — seeded PLS XML with FoxyBear brand terms, lazy update (not expanded on load). Correct.
- **Test suite** — 212 tests, genuine assertions on state, call counts, event sequences, retry behavior, epoch cancellation. Not sham tests (with the N7 exception).

---

## Verification

```
bun test test/voice/verify/   →  212 pass, 0 fail, 563 expect() calls, 2.04s
bun typecheck                  →  clean (tsgo --noEmit, no errors)
```

---

VERDICT: CHANGES REQUESTED

**Blocking issues:**
1. **B1** — `m.playing` never set to `true` in production; barge-in on `session.status` is dead code. User cannot interrupt TTS by sending a new message. Wire `m.playing` to actual TTS streaming state.
2. **B2** — API key resolution uses two different heuristics (`resolveKey()` regex vs `defaultFactory` prefix check). Custom env var names not starting with "ELEVENLABS" activate successfully but fail with 401 on every TTS request. Unify on a single resolution path.
