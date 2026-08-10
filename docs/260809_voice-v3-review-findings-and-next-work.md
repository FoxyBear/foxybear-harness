# Voice TTS v3 — Code Review Findings & Next Work Items

**Date:** 2026-08-09
**Status:** Open
**Reviews:** `docs/review-voice-v3-opus.md`, `docs/review-voice-v3-glm.md`

## Code Review Blocking Issues

### B1 — Barge-in is dead code (both reviewers)
`m.playing` is never set to `true` in production code. The `session.status` handler guards on `if (m.active && m.playing)` — always false. Barge-in never fires. Audio from a previous turn continues playing when the user sends a new message.
- **Files:** `packages/opencode/src/voice/plugin.ts`
- **Fix:** Set `m.playing = true` when the first audio chunk is sent to the sink. Set `m.playing = false` when the sink's `isFinal` chunk completes or on `stop()`.

### B2 — API key resolution mismatch (both reviewers)
`resolveKey()` in `plugin.ts` uses `^[A-Z_][A-Z0-9_]*$` regex to detect env var names. `defaultFactory` in `elevenlabs.ts` uses `startsWith("ELEVENLABS")`. A custom env var like `"VOICE_KEY"` passes `resolveKey()` (regex matches, reads `process.env["VOICE_KEY"]`) but `defaultFactory` sees it doesn't start with `"ELEVENLABS"` and sends it as a literal API key → silent 401.
- **Files:** `packages/opencode/src/voice/plugin.ts`, `packages/opencode/src/voice/elevenlabs.ts`
- **Fix:** Unify key resolution. `resolveKey()` should return the resolved key string. `defaultFactory` should accept the key string, not re-resolve. The plugin passes the resolved key to the TTS constructor.

### B3 — voice/mute commands still in Command.Service (Opus)
`command/index.ts` still registers `voice` and `mute` as server commands. These were superseded by the HTTP route. Any client using `session.command()` gets an empty-template LLM invocation.
- **Files:** `packages/opencode/src/command/index.ts`
- **Fix:** Remove the `commands["voice"]` and `commands["mute"]` blocks.

### B4 — noReply wiring not reverted in prompt.ts (Opus)
`prompt.ts` still has `const hookOut = yield* plugin.trigger(...)` and `noReply: hookOut.noReply === true`. Dead code — VoicePlugin no longer has a `command.execute.before` hook. Also added an unused `Config` import.
- **Files:** `packages/opencode/src/session/prompt.ts`
- **Fix:** Revert to `yield* plugin.trigger("command.execute.before", ..., { parts })` without capturing return value. Remove `noReply` from the `prompt()` call. Remove unused import.

### B5 — noReply on hook output type not reverted (Opus)
`packages/plugin/src/index.ts` still has `noReply?: boolean` on the `command.execute.before` output type. Public SDK API change that should be reverted.
- **Files:** `packages/opencode/packages/plugin/src/index.ts`
- **Fix:** Remove `noReply?: boolean` from the output type.

## Code Review Non-Blocking Issues

### NB1 — Dead `stopAudio()` function (GLM)
Unused function in `plugin.ts`. Remove.

### NB2 — `[muttering]` tag not in vocabulary (GLM)
Appears in Enhance section example but not in `AUDIO_TAG_VOCABULARY`. Will leak to TUI if the LLM emits it. Add to vocabulary or remove from the example.

### NB3 — Empty-string sessionID not rejected by route (GLM)
`POST /voice/toggle` with `{ sessionID: "" }` passes zod validation (non-empty string check missing). `Session.get("")` behavior unknown. Add `z.string().min(1)` or `.uuid()` validation.

### NB4 — Sham test V22 in elevenlabs tests (GLM)
One test asserts `expect(true).toBe(true)` instead of real behavior. Replace with genuine assertion.

### NB5 — Tests manually set `m.playing = true` (Opus)
Tests pass barge-in by manually setting `m.playing` because production code never sets it. Once B1 is fixed, tests should assert `m.playing` is set automatically.

### NB6 — Test gap for non-ELEVENLABS env var names (Opus)
No test covers a custom env var name (e.g., `"VOICE_KEY"`). Once B2 is fixed, add a test that verifies the key resolves correctly through both `resolveKey()` and `defaultFactory`.

## New Bug Reports

### BUG-1 — TUI formatting broken when voice is on

When `/voice` is activated, the TUI formatting breaks — all tables and formatting are stripped from the rendered output. The `experimental.text.complete` hook fires at `text-end` and rewrites `output.text` via `stripTags()`. This may be stripping markdown formatting (tables, bold, code blocks) along with audio tags, or the regex in `stripTags()` is too aggressive (collapsing whitespace, removing brackets that are part of markdown syntax).

**Reproduction:** Turn on `/voice`, ask Katya a question that produces a table or formatted output. Observe the TUI loses formatting.

**Likely cause:** `stripTags()` at `plugin.ts:177-183` replaces each tag with a space and then collapses all whitespace: `result.replace(/\s+/g, " ").trim()`. This whitespace collapse may destroy markdown table formatting (which relies on `|` and multiple spaces). Additionally, the regex `\s*${tag}\s*` may match too broadly.

**Diagnosis needed:**
- Is `stripTags()` running on ALL text parts or only assistant text parts?
- Is the whitespace collapse `/\s+/g` destroying markdown tables?
- Should `stripTags()` only run when voice is active, or always? (Spec says always, but maybe it should only strip when voice is active since the tags only appear when the Enhance prompt is injected — which is always. Hmm.)
- Does the TUI re-render from the persisted part after `text-end`? If so, the stripped version replaces the formatted version.

### BUG-2 — Voice module stops working after extended use

After a little while of working correctly, the voice module stops producing audio even though `VoiceMode.active` is still `true`. Cannot reproduce reliably. Likely causes:

1. **ElevenLabs client goes stale** — the `ElevenLabsClient` instance in `elevenlabs.ts` is cached on the `VoiceTTS` instance. If the connection drops or the client enters a bad state, subsequent `stream()` calls fail silently.
2. **Epoch drift** — if `bargeIn()` increments the epoch but a new TTS instance isn't created, the old instance's epoch check (`this.epoch !== token`) may reject all chunks.
3. **TTS instance reuse** — `getTTS()` reuses the same `VoiceTTS` instance per session. If the instance enters `degraded` state (from a 401 or 404), it sets `this.degraded = true` and all subsequent `feed()` calls are no-ops. `degraded` is never reset.
4. **Audio sink death** — if `ffplay` crashes and `handleSpawnFail()` doesn't recover, subsequent writes go to a dead sink.
5. **Queue stall** — `this.queue` in `elevenlabs.ts` is a promise chain. If one `synth()` call hangs (network timeout without rejection), all subsequent sentences are queued behind it forever.

**Diagnosis needed:**
- Add a debug trace mode that logs every `feed()`, `synth()`, `stream()`, `write()`, and `stop()` call with timestamps
- Run a long session (20+ turns) with debug trace enabled
- Capture the moment audio stops and trace backward to find the first failure
- Check if `degraded` flag is set, if `epoch` has drifted, if `queue` is stalled, if the sink is dead

**Potential fixes:**
- Reset `degraded` flag on `/voice` toggle (deactivate → activate creates fresh state)
- Add a timeout on `synth()` calls (if no chunk arrives within 10s, abort and retry)
- Recreate the `ElevenLabsClient` on connection failure
- Add a heartbeat check — if no audio has been produced in 30s while voice is active and deltas are arriving, log a warning and recreate the TTS instance
