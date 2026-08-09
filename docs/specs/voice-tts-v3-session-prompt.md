# Session Prompt: Voice TTS v3 — Clean Rebuild

## Context

The Voice TTS v2 implementation is being scrapped. An independent audit found it over-engineered — it built 600+ lines of abstraction (VoiceEngine interface, InMemoryVoiceEngine, 7-state engine state machine, EventQueue, EngineEvent union) to solve 3 edge-case problems that each had 2-10 line fixes. In doing so, it lost 5 core features that the v1 specs had correctly designed. The v1 approach (plugin-based) worked in hours; v2 took days and still doesn't work properly.

**Decision: Scrap v2. Return to a v1-style internal plugin approach with targeted fixes. Create a v3 SDD, then send it to council for review.**

## Skills to Load

Load these skills before starting:
1. `sdd-workstream` — for the SDD pipeline process
2. `dev-standards` — for coding standards, commit conventions, TDD
3. `tdd` — for the implementation loop (will be needed after spec approval)

## Step 1: Read All Source Material

Read these files IN ORDER before doing anything else. Do not skip any.

### v1 Spike Results (ElevenLabs API verification)
- `/Users/toddenglish/Development/FoxyBearOffice/docs/research/260727_elevenlabs-spike-results.md`

### v1 Specs (the ones that worked — 6 files)
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/specs/260727_voice-tts_sdd-00-master.md`
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/specs/260727_voice-tts_sdd-01-plugin-lifecycle.md`
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/specs/260727_voice-tts_sdd-02-llm-stream-tap.md`
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/specs/260727_voice-tts_sdd-03-elevenlabs-tts.md`
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/specs/260727_voice-tts_sdd-04-audio-sink.md`
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/specs/260727_voice-tts_sdd-05-expressivity.md`

### v2 Specs (the ones that over-engineered — 3 files)
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/specs/260806_voice-tts_sdd-v2-00-master.md`
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/specs/260806_voice-tts_sdd-v2-01-system-commands.md`
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/specs/260806_voice-tts_sdd-v2-02-05-amendments.md`

### v2 Diagnosis Docs (why v1 failed and v2 was attempted)
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/research/260806_voice-diagnosis-command-path.md`
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/research/260806_voice-diagnosis-session-mismatch.md`

### Audit Report (why v2 is being scrapped)
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/docs/specs/.sdd-state-voice-tts-v2/current-state-and-audit.md`

### v2 Implementation (the mess to clean up)
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/voice/index.ts`
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/voice/types.ts`
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/voice/engine.ts`
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/voice/elevenlabs.ts`

### Core files modified by v2 (to be reverted)
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/command/index.ts` — added `source: "system"` enum + voice/mute registration (REVERT)
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/session/prompt.ts` — added Voice import, capture, native command branch, layer provide (REVERT)
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/config/foxybear.ts` — added `voice` config field (KEEP)

### Reference files for the plugin system
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/plugin/index.ts` — plugin loader, INTERNAL_PLUGINS (line 58), event/tool/experimental hooks
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/plugin/shared.ts` — plugin types (PluginInput, hooks)
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/cli/cmd/tui/util/sound.ts` — working audio player reference (which-based player detection, file-based playback)

### v1 key file locations (for code anchors)
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/session/message-v2.ts` — PartDelta/PartUpdated event definitions, Part types (text, reasoning, step-start)
- `/Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/session/processor.ts` — where PartDelta is published (text at ~423, reasoning at ~241)

## Step 2: Clean Up the v2 Mess

Before writing the v3 spec, clean up the v2 implementation:

1. **Delete v2 voice source files:**
   - `packages/opencode/src/voice/index.ts`
   - `packages/opencode/src/voice/types.ts`
   - `packages/opencode/src/voice/engine.ts`
   - `packages/opencode/src/voice/elevenlabs.ts`

2. **Delete v2 test files:**
   - `packages/opencode/test/voice/` (entire directory)

3. **Revert core modifications:**
   - `packages/opencode/src/command/index.ts` — remove `source: "system"` from the zod enum, remove `voice` and `mute` command registrations
   - `packages/opencode/src/session/prompt.ts` — remove `Voice` import, remove `const voice = yield* Voice.Service`, remove the native command branch (`if (input.command === "voice" || input.command === "mute")`), remove `Layer.provide(Voice.defaultLayer...)` from `defaultLayer`
   - `packages/opencode/src/test/session/prompt-effect.test.ts` — remove Voice import and layer addition
   - `packages/opencode/src/test/session/snapshot-tool-race.test.ts` — remove Voice import and layer addition

4. **Keep:**
   - `packages/opencode/src/config/foxybear.ts` — the `voice` config field (this is correct and needed)
   - `docs/specs/260727_voice-tts_sdd-*.md` — the v1 specs (reference for v3)
   - `docs/specs/260806_voice-tts_sdd-v2-*.md` — the v2 specs (cautionary reference)
   - `docs/specs/.sdd-state-voice-tts-v2/current-state-and-audit.md` — the audit

5. **Verify:** Run `bun run typecheck` from `packages/opencode` and `bun test` to confirm the revert is clean.

## Step 3: Author the v3 SDD

Create a v3 spec suite that follows the audit's recommendation: **v1-style internal plugin approach with targeted fixes**.

### v3 Architecture (from the audit):

**Keep from v2:**
- `@opencode-ai/sdk/v2` import for correct SDK parameter shapes
- `noReply: true` pattern for silent commands (but wire it through `CommandInput` properly — suppress user message creation when `noReply` is true, ~10-line core change, not an architecture change)
- The `voice` config field in FoxyBearFields

**Revert to from v1:**
1. **Internal plugin** — add the voice plugin to `INTERNAL_PLUGINS` in `packages/opencode/src/plugin/index.ts` (line 58). This fixes the tool visibility race without core modifications.
2. **Include-only-text filter via `PartUpdated` correlation** — subscribe to `message.part.updated`, track text-type `partID`s, forward only text-type deltas. THIS IS THE CRITICAL LEARNING: `field === "text"` does NOT distinguish reasoning from reply — both carry `field: "text"`. You MUST correlate `partID` with `PartUpdated` events to know which parts are text-type.
3. **Sentence-boundary chunking** (v1 SDD-03) — accumulate LLM text until `.`, `!`, `?`, `\n`, send each sentence as a separate `stream()` call, chain playback (play sentence N while synthesizing N+1). TTFA: ~1.1s per sentence.
4. **Stdin-pipe streaming audio sink** (v1 SDD-04) — spawn player with `stdin: "pipe"`, write chunks as they arrive from ElevenLabs, close stdin on completion. Reuse `sound.ts`'s `which`-based player detection pattern (12 candidates: ffplay, mpv, afplay, etc.) but with stdin-pipe spawning, NOT the file-based pattern.
5. **`experimental.text.complete` for tag stripping** (v1 SDD-02) — strip audio tags (`[laughs]`, `[sighs]`, etc.) from TUI display on `text-end`.
6. **`experimental.chat.system.transform` for expressivity** (v1 SDD-05) — inject the Enhance section and Katya Tone Guide into the system prompt.

**Drop entirely from v2:**
- `VoiceEngine` interface, `InMemoryVoiceEngine`, `EngineEvent` union, `EngineCapabilities`, `EngineStatus`
- 7-state engine state machine (`uninitialized → disconnected → connecting → ready → speaking → stopping → failed`)
- `VoiceStatePart` persistence
- `EventQueue<T>` custom async iterable
- Native system command registration in core (command/index.ts, prompt.ts)
- Bus subscription approach (use plugin `event` hook instead)

### v3 Spec Structure:

Write the spec suite in `docs/specs/` following the naming convention `260808_voice-tts_sdd-v3-*.md`:

1. **`260808_voice-tts_sdd-v3-00-master.md`** — Master spec with shared contract, architecture overview, and the 3 targeted fixes from v2 (internal plugin, noReply wiring, v2 SDK import). Include a "Lessons Learned" section documenting what v2 got wrong.

2. **`260808_voice-tts_sdd-v3-01-plugin.md`** — Plugin lifecycle: internal plugin registration, event hook for PartDelta/PartUpdated, tool hook for voice.toggle, how `/voice` and `/mute` work as plugin tools (not native commands). HOW: PartUpdated correlation for text-type filtering. VERIFY: reasoning deltas are NOT forwarded, text deltas ARE forwarded.

3. **`260808_voice-tts_sdd-v3-02-elevenlabs.md`** — ElevenLabs TTS: sentence-boundary chunking, `stream()` API usage, voice settings, error handling. Include spike results (v3 model, no `optimizeStreamingLatency`, voice ID `xVQH621DS3eyBYrseRt5`).

4. **`260808_voice-tts_sdd-v3-03-audio-sink.md`** — Audio sink: `which`-based player detection (12 candidates), stdin-pipe streaming (NOT temp file), backpressure, volume control, barge-in (kill process).

5. **`260808_voice-tts_sdd-v3-04-expressivity.md`** — Expressivity: system prompt injection, audio tag vocabulary, tag stripping from TUI display.

Each spec must have WHEN/SHALL statements (machine-checkable) and VERIFY criteria (independent agent can check).

### Key constraints for v3:
- **No core modifications** except the ~10-line `noReply` wiring in `CommandInput`/`command()` if needed. Everything else goes through the plugin system.
- **No VoiceEngine interface** — direct function calls to ElevenLabs SDK.
- **No Effect service** for voice — the plugin manages its own simple state (mode: on/off, muted: bool, playing: bool, sessionID: string).
- **No Bus subscriptions** — use the plugin `event` hook which already receives all Bus events.
- **No InMemoryVoiceEngine** — test against the real plugin with mocked ElevenLabs calls.
- The v1 specs are the PRIMARY reference. The v3 specs are v1 + 3 targeted fixes. If v1 and v2 conflict, v1 wins.

## Step 4: SDD Pipeline

After authoring the v3 specs:

1. Create the SDD workstream config: `tools/sdd/workstreams/voice-tts-v3.json` pointing at `docs/specs/` with `cwd: packages/opencode` and the typecheck/test commands.

2. Run the SDD pipeline stages:
   ```
   bun /Users/toddenglish/Development/FoxyBearOffice/tools/sdd/sdd.ts --ws voice-tts-v3 author
   bun /Users/toddenglish/Development/FoxyBearOffice/tools/sdd/sdd.ts --ws voice-tts-v3 audit
   ```

3. The audit stage will spawn independent auditors to review each spec. Fix any blocking issues they find.

4. Do NOT proceed to the gate stage. After audit passes, STOP and report to Todd. He will review and approve the gate, then send to council for review.

## Step 5: Council Review

After the SDD audit passes and Todd approves the gate, send the v3 specs to council for review using:
```
council_deliberate with a prompt summarizing the v3 architecture and asking for consensus on the approach
```

The council should debate:
- Is the internal plugin approach correct?
- Is the PartUpdated correlation the right filtering mechanism?
- Is sentence-boundary chunking the right latency strategy?
- Is stdin-pipe streaming feasible with Bun.spawn?
- Are there any remaining v2 ideas worth keeping?

## Critical Context

- **Branch:** `feat/voice-tts-v2` (will need a new branch or rename for v3)
- **Working directory:** `/Users/toddenglish/Development/FoxyBearOffice/development/opencode`
- **Test command:** `bun test` from `packages/opencode`
- **Typecheck:** `bun run typecheck` from `packages/opencode`
- **Build:** `bun run packages/opencode/script/build.ts --single --skip-embed-web-ui`
- **Binary location:** `packages/opencode/dist/opencode-darwin-arm64/bin/opencode`
- **Debug log:** `foxybear --print-logs --log-level DEBUG 2> /tmp/foxybear-voice-debug.log`
- **ElevenLabs key:** `~/Development/.elevenlabs.key` (resolve via `{file:~/Development/.elevenlabs.key}` in config `apiKeyEnv`)
- **Voice ID:** `xVQH621DS3eyBYrseRt5` (Katya's voice, confirmed by Todd)
- **Model:** `eleven_v3` (does NOT support `optimizeStreamingLatency` — returns 400)
- **SDK:** `@elevenlabs/elevenlabs-js` (installed in opencode node_modules)
- **Config field:** `voice` in FoxyBearFields in `packages/opencode/src/config/foxybear.ts` (already added, KEEP)
- **TUI sound reference:** `packages/opencode/src/cli/cmd/tui/util/sound.ts` — working audio player with `which`-based detection (but uses file-based playback, v3 spec requires stdin-pipe)

## Todd's Expectations

- This should take hours, not days. The v1 specs are thorough and spike-verified. v3 is v1 + 3 small fixes.
- No over-engineering. If you're writing an interface, a state machine, or an abstraction layer, stop. The plugin system provides everything needed.
- The reasoning/reply filtering is THE critical feature. Get it right. `field === "text"` is NOT enough. You MUST correlate `partID` with `PartUpdated` events.
- Audio must stream with low latency. Sentence-boundary chunking + stdin-pipe playback. Not temp files.
- `/voice` must be silent in the TUI (no visible user message). Fix via `noReply` in `CommandInput`, not via native command registration.
- The SDD process is mandatory. Specs first, audit, gate, then implementation.
- Do NOT implement code in this session. Author specs, run audit, report to Todd.
