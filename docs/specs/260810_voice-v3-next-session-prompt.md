# Voice TTS v3 — Next Session Prompt

**Date:** 2026-08-10
**Branch:** `feat/voice-tts-v2`
**Project:** FoxyBear CLI (`development/opencode`)

## Context

You are continuing the Voice TTS v3 work on the FoxyBear opencode CLI. The voice plugin lets Katya speak with expressive audio via ElevenLabs. The plugin runs server-side as an internal plugin. The TUI is a separate runtime context — voice state lives server-side and is mutated via HTTP routes.

## What's Done

The v3 implementation is committed and working:
- Internal voice plugin (`src/voice/plugin.ts`) with config parsing, per-session state, event hook with PartUpdated correlation, barge-in, teardown
- ElevenLabs TTS streaming (`src/voice/elevenlabs.ts`) with sentence-boundary chunking, SDK stream(), retry/degradation
- Audio playback sink (`src/voice/sink.ts`) with player detection, stdin-pipe streaming
- Expressivity system (`src/voice/expressivity.ts`) with Enhance section, Katya Tone Guide, 37-tag vocabulary
- HTTP route (`src/server/instance/voice.ts`) with `POST /voice/toggle` and `POST /voice/mute` — TUI calls via `sdk.fetch`
- TUI slash commands (`app.tsx`) for `/voice` and `/mute` — no chat pollution, no LLM invocation
- Harness `/status` renamed to `/daemon` (fixes duplicate)
- 212 tests pass, typecheck clean

## What's Not Done — Read This Carefully

Two independent code reviews (Opus + GLM) found **5 blocking issues** and **6 non-blocking issues**. Two **production bugs** were reported by Todd. All are documented in:

**`docs/260809_voice-v3-review-findings-and-next-work.md`** — READ THIS FILE FIRST.

### Blocking Issues (from code review)

- **B1:** `m.playing` never set to `true` in production → barge-in is dead code
- **B2:** API key resolution mismatch — `resolveKey()` (regex) vs `defaultFactory` (`startsWith("ELEVENLABS")`) — custom env var names activate but send literal string to ElevenLabs → silent 401
- **B3:** `command/index.ts` still has `voice`/`mute` command registrations — should be removed (superseded by HTTP route)
- **B4:** `prompt.ts` noReply wiring not reverted — `hookOut` capture and `noReply: hookOut.noReply === true` still present
- **B5:** `plugin/src/index.ts` still has `noReply?: boolean` on `command.execute.before` hook output type

### Non-Blocking Issues

- **NB1:** Dead `stopAudio()` function in `plugin.ts`
- **NB2:** `[muttering]` tag not in vocabulary (appears in Enhance example)
- **NB3:** Empty-string sessionID not rejected by route
- **NB4:** Sham test V22 in elevenlabs tests (`expect(true).toBe(true)`)
- **NB5:** Tests manually set `m.playing = true` (should assert it's set automatically after B1 fix)
- **NB6:** No test for non-`ELEVENLABS` env var names (should add after B2 fix)

### Production Bugs (reported by Todd)

- **BUG-1:** TUI formatting broken when voice is on — all tables and markdown formatting stripped. Likely `stripTags()` whitespace collapse (`/\s+/g`) destroying markdown tables. Need to diagnose: is `stripTags()` running on all text? Is the whitespace collapse too aggressive? Should it only run when voice is active?

- **BUG-2:** Voice module stops working after extended use — audio stops even though `VoiceMode.active` is still `true`. Cannot reproduce reliably. Likely causes: ElevenLabs client goes stale, epoch drift, TTS instance enters `degraded` state (never reset), audio sink death, or queue stall. Needs a long debug trace session (20+ turns) to diagnose.

## Workflow

Todd (the user) writes specs and makes architectural decisions. Agents do the implementation work. The flow is:

1. **Todd reviews findings, decides priority, writes or approves a spec/plan**
2. **Agent writes tests from the spec's VERIFY section (RED state — tests fail against current code)**
3. **Todd reviews tests**
4. **Agent writes code to make tests pass (GREEN state)**
5. **Todd runs the app and verifies in production**
6. **Repeat for next issue**

Rules:
- Do NOT code without tests first (RED → GREEN)
- Do NOT modify test files when implementing code
- Do NOT commit unless Todd explicitly asks
- Run `bun run typecheck` and `bun test test/voice/ --timeout 30000` after every change
- When spawning agents: give them complete context (file paths, the specific issue, the test expectations)
- Todd diagnoses production issues himself (he runs the app). Agents fix what Todd identifies.
- For complex bugs (BUG-2), add debug instrumentation first, let Todd run the trace, then fix based on findings

## Key Files

### Source
- `packages/opencode/src/voice/plugin.ts` — main plugin
- `packages/opencode/src/voice/elevenlabs.ts` — ElevenLabs TTS
- `packages/opencode/src/voice/sink.ts` — audio sink
- `packages/opencode/src/voice/expressivity.ts` — system prompts, tag vocabulary
- `packages/opencode/src/voice/index.ts` — re-exports
- `packages/opencode/src/server/instance/voice.ts` — HTTP route
- `packages/opencode/src/cli/cmd/tui/app.tsx` — TUI slash commands
- `packages/opencode/src/command/index.ts` — command registry (has leftover voice/mute)
- `packages/opencode/src/session/prompt.ts` — prompt loop (has leftover noReply wiring)
- `packages/plugin/src/index.ts` — plugin SDK types (has leftover noReply)
- `packages/opencode/src/config/foxybear.ts` — voice config field
- `packages/opencode/src/session/processor.ts` — text-delta/text-end event sources

### Tests
- `packages/opencode/test/voice/verify/` — all voice test files

### Docs
- `docs/260809_voice-v3-review-findings-and-next-work.md` — all findings + bugs (READ FIRST)
- `docs/review-voice-v3-opus.md` — Opus code review
- `docs/review-voice-v3-glm.md` — GLM code review
- `docs/specs/260808_voice-tts_sdd-v3-*.md` — 5 SDD specs (master + 4 feature specs)
- `docs/specs/260809_voice-http-route-plan.md` — HTTP route plan
- `docs/specs/voice-tts-v3-session-prompt.md` — original session prompt that started this work

## Suggested Priority

1. **B3, B4, B5** — Quick cleanup (remove leftover noReply/command registrations). Low risk, fast.
2. **B1** — Barge-in dead code (`m.playing` never set). Moderate fix, needs `stripTags` to not break formatting.
3. **BUG-1** — TUI formatting broken. Likely the same `stripTags()` function. Diagnose first.
4. **B2** — API key resolution mismatch. Unify `resolveKey()` and `defaultFactory`.
5. **NB1-NB6** — Non-blocking cleanup. Bundle into one pass.
6. **BUG-2** — Voice stops after extended use. Needs debug trace session first. Add instrumentation, let Todd run, diagnose, then fix.

## Environment

- Working directory: `/Users/toddenglish/Development/FoxyBearOffice/development/opencode`
- Package directory: `packages/opencode`
- Typecheck: `bun run typecheck` (from `packages/opencode`)
- Tests: `bun test test/voice/ --timeout 30000` (from `packages/opencode`)
- Full tests: `bun test --timeout 30000` (from `packages/opencode`, may have pre-existing flaky failures in `test/session/prompt-effect.test.ts` — see `docs/specs/.sdd-state-voice-tts-v3/baseline-failures.txt`)
- API key: configured via `{file:~/Development/.elevenlabs.key}` in `~/.config/opencode/foxybear.json` — do NOT read this file, do NOT stream the key in any output
- Audio player: `ffplay` is installed and detected automatically
