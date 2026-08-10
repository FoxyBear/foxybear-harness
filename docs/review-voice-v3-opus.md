# Voice TTS v3 — Adversarial Code Review

**Reviewer:** Opus (independent)
**Date:** 2026-08-10
**Commit:** `b3dcbdf4d` (`feat(voice): v3 TTS plugin with internal registration, noReply wiring, real audio sink`)
**Scope:** All new and modified source files + test files for voice TTS v3.

**Tests:** 212 pass, 0 fail. Typecheck: clean.

---

## Summary

The voice TTS v3 implementation is architecturally sound — the plugin/sink/TTS separation is clean, the HTTP route approach correctly replaces the old command-path approach, and the test coverage is genuine and thorough. However, there are **5 blocking issues**: the barge-in feature is non-functional in production (dead state), the old command-path approach was not fully reverted (dual paths coexist), and the API key resolution logic is inconsistent between activation and API call paths.

---

## Blocking Issues

### B1 — `m.playing` never set to `true` — barge-in is dead code

**File:** `packages/opencode/src/voice/plugin.ts`

`VoiceMode.playing` is initialized to `false` (line 146), set to `false` in `deactivate()` (line 213), `bargeIn()` (line 251), but **never set to `true` anywhere in production code**. The `session.status` event handler guards barge-in on this field:

```ts
if (m.active && m.playing) {
  bargeIn(sessionID)    // ← never reached in production
}
```

Tests pass because they manually set `m.playing = true` (e.g., `sdd-v3-01.test.ts:275`). In production, `m.playing` is always `false`, so barge-in on user input never fires. The epoch-based barge-in in `VoiceTTS` works correctly for mid-stream cancellation, but the plugin-level barge-in that also calls `session.abort` is completely dead.

**Fix:** Set `m.playing = true` when TTS starts streaming audio (e.g., in the `message.part.delta` handler after `tts.feed()`, or via an `onPlaying` callback from `VoiceTTS`), and clear it when audio completes or is stopped. Alternatively, remove `m.playing` and use `ttsInstances.has(sessionID)` + a TTS "is streaming" flag.

---

### B2 — `command/index.ts` still has voice/mute commands (should be removed)

**File:** `packages/opencode/src/command/index.ts:106-119`

The spec (`260809_voice-http-route-plan.md` line 34) states the old approach is superseded by the HTTP route and the command registration should be removed. But the diff **added** `commands["voice"]` and `commands["mute"]` with empty templates (`template: ""`), and they are still present:

```ts
commands["voice"] = {
  name: "voice",
  description: "toggle voice mode on or off",
  source: "command",
  template: "",
  hints: [],
}
commands["mute"] = { ... template: "" ... }
```

If any client invokes `/voice` or `/mute` through the backend command system (the `/command` API endpoint, or the SDK `command` method), the empty template creates a user message with empty content and invokes the LLM with an empty prompt. The TUI bypasses this by calling `sdk.fetch("/voice/toggle")` directly, but the backend command path is a broken dual path.

**Fix:** Remove the `commands["voice"]` and `commands["mute"]` registrations from `command/index.ts`.

---

### B3 — `prompt.ts` noReply wiring not reverted

**File:** `packages/opencode/src/session/prompt.ts:1650-1661`

The spec says the `noReply` wiring should be reverted (it was replaced by the HTTP route approach). But the diff modified `prompt.ts` to capture the hook output and pass `noReply` to `prompt()`:

```ts
const hookOut = yield* plugin.trigger(
  "command.execute.before",
  { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
  { parts, noReply: undefined },
)
const result = yield* prompt({
  ...
  parts: hookOut.parts,          // ← changed from `parts`
  noReply: hookOut.noReply === true,  // ← added
})
```

Since `VoicePlugin` does NOT register a `command.execute.before` hook, `hookOut.noReply` is always `undefined` and `hookOut.parts` is the same object as `parts`. This is dead code that modifies the core `prompt()` call path. It also added an unused `import { Config } from "../config/config"` (line 32 — `Config` is never referenced in the file).

**Fix:** Revert `prompt.ts` to the pre-voice state: change back to `yield* plugin.trigger(...)` without capturing the return, use `parts` not `hookOut.parts`, remove `noReply: hookOut.noReply === true`, and remove the unused `Config` import.

---

### B4 — `plugin/src/index.ts` noReply type not reverted

**File:** `packages/plugin/src/index.ts:263`

The `command.execute.before` hook output type was changed from `{ parts: Part[] }` to `{ parts: Part[]; noReply?: boolean }`. This is a public API change to the plugin SDK package that affects all plugins. Since no plugin uses `noReply` (VoicePlugin doesn't have this hook), this should be reverted.

**Fix:** Change the output type back to `{ parts: Part[] }`.

---

### B5 — `apiKeyEnv` resolution is inconsistent — custom env var names silently fail

**Files:** `packages/opencode/src/voice/plugin.ts:180-188` vs `packages/opencode/src/voice/elevenlabs.ts:57`

Two different key resolution strategies exist:

**`resolveKey()` in plugin.ts** (used for activation check):
```ts
if (/^[A-Z_][A-Z0-9_]*$/.test(v) && v.length < 64) {
  return process.env[v] ?? null   // env var lookup
}
return v                          // raw key value
```

**`defaultFactory` in elevenlabs.ts** (used for actual API call):
```ts
const apiKey = cfg.apiKeyEnv.startsWith("ELEVENLABS") ? process.env[cfg.apiKeyEnv] : cfg.apiKeyEnv
```

If a user configures `apiKeyEnv: "MY_VOICE_KEY"` (a valid env var name that doesn't start with "ELEVENLABS"):
- `resolveKey()` matches the regex, finds the key in `process.env`, activation **succeeds**
- `defaultFactory` doesn't match `startsWith("ELEVENLABS")`, passes `"MY_VOICE_KEY"` as the literal API key
- ElevenLabs API call fails with **401** — the user gets voice "on" but no audio, with a degraded event

The `{file:/path/to/keyfile}` case works by accident because the config system resolves `{file:...}` references in raw config text before parsing (`config/paths.ts:substitute()`), so the plugin receives the actual key value, not the `{file:...}` token. But this is undocumented and fragile.

**Fix:** Resolve the key in one place. Either:
1. Export `resolveKey()` from `plugin.ts` and call it in `defaultFactory`, or
2. Resolve the key in `plugin.ts` during activation and store it on the config object (e.g., `cfg._resolvedKey`), then `defaultFactory` reads `cfg._resolvedKey`.

---

## Non-Blocking Issues

### N1 — `stopAudio()` function is dead code
**File:** `plugin.ts:241-244` — defined but never called. Remove it.

### N2 — `getTextParts()` exported but never used outside tests
**File:** `plugin.ts:152` — exported and re-exported from `index.ts:6` but never called from production code. Only used in tests as a probe. Consider making it test-only or removing the export.

### N3 — `toggle` and `mute` not re-exported from `voice/index.ts`
**File:** `voice/index.ts` — exports `parseConfig`, `getMode`, `getTextParts`, `resetState`, `getConfig`, `stripTags`, `setV2Client`, `getTTS`, `setAudioSink` — but NOT `toggle` and `mute`, which are the primary control surface used by the HTTP route. The route imports them directly from `./plugin` which works, but the index should export the public API consistently.

### N4 — Unused `Config` import in `prompt.ts`
**File:** `prompt.ts:32` — `import { Config } from "../config/config"` was added by the diff but `Config` is never referenced in the file. Remove it.

### N5 — `try/catch` in `defaultFactory` is a no-op
**File:** `elevenlabs.ts:54-62`:
```ts
try {
  const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js")
  ...
} catch (e) {
  throw e    // ← catch-and-rethrow, adds nothing
}
```
Remove the try/catch or add actual error handling/logging.

### N6 — Empty `else {}` block in `getTTS()`
**File:** `plugin.ts:80-81` — the else branch is empty. Remove it.

### N7 — Config schema allows `stability: "robust"` but `parseConfig` throws
**File:** `config/foxybear.ts:131` — the zod enum includes `"robust"`, but `parseConfig` throws at runtime. If a user configures `robust`, the config validates fine but the plugin silently fails (`cfg = null`, no voice). The error is logged but the user gets no TUI feedback. Consider removing `"robust"` from the zod enum, or converting the `parseConfig` throw to a fallback to `"natural"`.

### N8 — `bargeIn()` called without `await` or `.catch()` in event handler
**File:** `plugin.ts:370-372` — `bargeIn(sessionID)` is async but called fire-and-forget. If `session.abort` throws, the error is silently swallowed. The event hook framework (`plugin/index.ts:251-258`) uses `Effect.sync` which doesn't await the returned Promise. Not a crash issue but means barge-in failures are invisible.

### N9 — `getV2()` hardcodes `baseUrl: "http://localhost:4096"`
**File:** `plugin.ts:103-106` — the `baseUrl` is hardcoded but the `fetchFn` uses `Server.Default().app.fetch()` (in-process), so the URL is never actually used for network calls. It's misleading but harmless. Consider using a placeholder or the `serverUrl` from `PluginInput`.

### N10 — VR8 test is brittle (checks exact string absence)
**File:** `voice-http-route.test.ts:157-162` — checks that a specific import string is absent from `app.tsx`. A differently-formatted import would pass the test while still importing from `@/voice/plugin`. Consider using a regex or checking for the module path pattern instead.

### N11 — `elevenlabs.d.ts` type declaration may not match actual SDK
**File:** `src/elevenlabs.d.ts` — declares `stream()` returning `Promise<AsyncIterable<Uint8Array>>`, but `toBytes()` in `elevenlabs.ts` handles both raw `Uint8Array` and `{ chunk: ... }` wrapper objects, suggesting the actual SDK wraps chunks. The type declaration is deliberately minimal (a stub), but the `as unknown as Client` cast in `defaultFactory` means type mismatches won't be caught at compile time. The `toBytes()` function is the real safety net here.

---

## What's Good

- **Architecture:** The plugin/sink/TTS three-layer separation is clean. `VoiceTTS` is testable in isolation with injected `ClientFactory`, `AudioSink`, and `BusEmit`. The `AudioSink` correctly abstracts player detection and stdin-pipe streaming.
- **PartUpdated correlation:** The `textParts` Set-based filter is correct — reasoning parts are excluded, text parts are included. The `message.part.updated` → `message.part.delta` correlation via partID is sound.
- **Retry/degradation:** The epoch-based barge-in in `VoiceTTS` is correct — stale chunks from a previous epoch are dropped mid-stream. The per-sentence retry with backoff, fatal-error detection (401/404/400), and graceful degradation are well-implemented.
- **Test quality:** Tests are genuine — they assert real behavior, not tautologies. The `sdd-v3-02` test suite exercises concurrency (serialized ordering, mid-stream failure, barge-in cancellation) with carefully orchestrated async mocks. The `sdd-v3-03` tests for ENOENT re-detection and dead-PID tolerance are particularly good.
- **Security:** The HTTP route validates `sessionID` via `Session.get.schema` and calls `Session.get(sessionID)` to verify existence (404 on nonexistent). No secret exposure — the `tts.sentence_failed` event payload contains only `reason` and `length`, not the API key. The `sdd-v3-02.test.ts` V21 test explicitly verifies this.
- **Config handling:** The `model_id` rejection with an actionable error, and the `stability: "robust"` rejection, are good UX touches. The `tagEmissionTempBoost` with clamping to `TEMP_CEILING` is correct.

---

## Test Gaps

1. **No test for `m.playing` lifecycle** — because `m.playing` is never set to `true`, no test catches this. A test that asserts `m.playing === true` after audio starts would have caught B1.
2. **No test for custom env var name** — all tests use `ELEVENLABS_API_KEY` which starts with "ELEVENLABS" and works with both resolution strategies. A test with `apiKeyEnv: "MY_CUSTOM_KEY"` would have caught B5.
3. **No integration test for the full event flow** — no test exercises `delta → feed → synth → sink.write` end-to-end with a real `AudioSink` (the `audio-sink-wiring` tests use `AudioSink.prototype.write` mocks).
4. **No test that verifies `command/index.ts` does NOT have voice/mute** — the `tui-command-refactor.test.ts` tests the plugin but not the command registry. A test asserting `!commands["voice"]` would have caught B2.

---

## Verdict

**VERDICT: CHANGES REQUESTED**

### Blocking issues to fix before merge:

1. **B1** — `m.playing` never set to `true`; barge-in is dead code. Set `m.playing` when TTS starts streaming, clear it on stop/complete.
2. **B2** — Remove `commands["voice"]` and `commands["mute"]` from `command/index.ts`. They are superseded by the HTTP route and create a broken dual path.
3. **B3** — Revert `prompt.ts` noReply wiring: remove `hookOut` capture, use `parts` not `hookOut.parts`, remove `noReply: hookOut.noReply === true`, remove unused `Config` import.
4. **B4** — Revert `plugin/src/index.ts`: remove `noReply?: boolean` from `command.execute.before` hook output type.
5. **B5** — Fix `apiKeyEnv` resolution: make `defaultFactory` use the same resolution logic as `resolveKey()`, or resolve the key once and pass the resolved value to the TTS instance.
