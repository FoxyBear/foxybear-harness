# Independent Adversarial Audit — Re-Audit (Round 3)

**Spec:** `260808_voice-tts_sdd-v3-00-master.md`
**Date:** 2026-08-08
**Auditor:** Independent adversarial agent
**Round:** 3 (re-audit of round-2 failure)

## Background

Round 2 found 1 blocking issue: the noReply description in fix #2 (line 32) said noReply "suppresses user message creation," which directly contradicted VI-3's statement that noReply "does NOT suppress the user message." The author claims this is now fixed.

## Source Verification

**File:** `packages/opencode/src/session/prompt.ts`

```
1278:  function* (input: PromptInput) {
1279:    const session = yield* sessions.get(input.sessionID)
1280:    yield* revert.cleanup(session)
1281:    const message = yield* createUserMessage(input)     // ← user message created HERE
1282:    yield* sessions.touch(input.sessionID)
...
1293:    if (input.noReply === true) return message            // ← short-circuit HERE
1294:    return yield* loop({ sessionID: input.sessionID })    // ← LLM loop skipped
```

**Confirmed:** `createUserMessage` (line 1281) runs BEFORE the `noReply` short-circuit (line 1293). The user message IS created. Only `loop(...)` (line 1294 — the LLM invocation) is skipped. The returned `message` is the user message created at line 1281.

## Check Results

### Check 1 — Fix #2 noReply description (line 32)

> "When a plugin's hook sets `noReply: true`, `command()` captures the trigger return value and passes `noReply` to `prompt()`, which already has the short-circuit at line 1293 (`if (input.noReply === true) return message`). **This suppresses LLM invocation** — the confirmation text is still created as a user message (visible in TUI), but `prompt()` returns immediately without entering the LLM loop."

- Says "suppresses LLM invocation" — NOT "suppresses user message creation." ✓
- Explicitly states "the confirmation text is still created as a user message." ✓
- Consistent with source: `createUserMessage` at 1281 creates the user message; short-circuit at 1293 skips the LLM loop. ✓

**PASS** — The blocking issue from round 2 is resolved.

### Check 2 — VI-3 consistency (line 115)

> "The `noReply` flag suppresses LLM invocation but does NOT suppress the user message — the confirmation text is still visible in the TUI."

- Says "suppresses LLM invocation" — matches fix #2. ✓
- Says "does NOT suppress the user message" — matches fix #2 and source. ✓
- No contradiction with line 32. ✓

**PASS** — VI-3 is consistent with fix #2.

### Check 3 — Previous fixes still correct

#### SC-1 VoiceConfig defaults (lines 124-142)

All defaults present and correct:
- `apiKeyEnv`: `"ELEVENLABS_API_KEY"` ✓
- `voiceId`: `"xVQH621DS3eyBYrseRt5"` ✓
- `modelId`: `"eleven_v3"` with camelCase note ✓
- `stability`: `"natural"` ✓
- `speed`: `1.0` ✓
- `similarityBoost`: `0.75` ✓
- `speakerBoost`: `true` ✓
- `style`: `0` ✓
- `language`: `"en"` ✓
- `outputFormat`: `"mp3_44100_128"` ✓
- `tagEmissionTempBoost`: `false` ✓
- `tagEmissionTempDelta`: `0` (matching foxybear.ts) ✓
- `maxSentenceRetries`: `3` (matching foxybear.ts) ✓
- `autoStart`: `false` ✓

**PASS.**

#### VI-1 Voice Dispatch Isolation (lines 112-113)

- Allowed paths listed: (a) `command.execute.before` hook for `/voice`/`/mute` with `noReply`, (b) `voice.toggle`/`voice.mute` plugin tools (LLM-callable by design), (c) `autoStart` path (first assistant text delta), (d) barge-in path. ✓
- Prohibition: model-generated TEXT content shall not invoke voice toggle/mute. ✓
- Clarification: LLM tool calls to `voice.toggle`/`voice.mute` ARE allowed. ✓
- Scoping guard (line 113): VI-1 covers control-plane integrity only; content safety is separate. ✓

**PASS.**

#### CC-3 TUI text and spoken audio independent (line 99)

- Audio tags stripped from TUI display at `text-end` via `experimental.text.complete`. ✓
- TTS engine receives tags verbatim. ✓
- User shall not see audio tags in final persisted text. ✓
- Known limitation documented: transient visibility during streaming until `text-end` fires. ✓

**PASS.**

#### SC-6 Audio Tag Vocabulary ownership (lines 189-190, 197)

- Owned by SDD-04 (Expressivity). ✓
- Referenced by SDD-01 (plugin, for stripping) and SDD-02 (ElevenLabs, for forwarding). ✓
- SDD-04 exports `AUDIO_TAG_VOCABULARY` constant; SDD-01's tag stripper imports it. ✓
- SDD-04 does NOT own the tag stripper — SDD-01 owns the `experimental.text.complete` hook handler. ✓

**PASS.**

### Check 4 — No new issues introduced

#### Glossary noReply entry (line 204)

> "A command whose `command.execute.before` hook sets `noReply: true`, causing `command()` to pass `noReply: true` to `prompt()`, which short-circuits at line 1293 (`if (input.noReply === true) return message`) — no LLM invocation, no user message creation beyond the confirmation text."

The phrase "no user message creation beyond the confirmation text" is terse. A careless reader could misread "beyond" as "except" and conclude the confirmation text is NOT a user message. However:
- Fix #2 (line 32) explicitly states "the confirmation text is still created as a user message."
- VI-3 (line 115) explicitly states "does NOT suppress the user message."
- The glossary's "beyond" means "in addition to" — i.e., no user message is created IN ADDITION TO the confirmation text. This is accurate: `createUserMessage` creates the user message (confirmation text), and the LLM loop (which would produce an assistant message) is skipped.

Read in full-spec context, there is no contradiction. The glossary could be clearer (e.g., "the confirmation text is created as the user message; no additional messages are created"), but this is a **non-blocking clarity observation**, not a blocking inconsistency.

**Non-blocking observation** — no action required for PASS.

#### Other sections reviewed

- Architecture (lines 12-22): consistent with three targeted fixes. ✓
- Lessons Learned table (lines 78-91): no changes that introduce contradictions. ✓
- Cross-cutting requirements CC-1 through CC-12 (lines 97-108): all consistent. ✓
- Security invariants VI-1 through VI-3 (lines 112-115): all consistent. ✓
- Shared contracts SC-1 through SC-6 (lines 119-190): all consistent. ✓
- Dependency order (lines 192-197): SDD-01 through SDD-04 ordering consistent. ✓
- Open questions (lines 207-210): all resolved, no new open questions. ✓

No new blocking issues introduced.

## Summary

| Check | Result |
|-------|--------|
| 1. Fix #2 says "suppresses LLM invocation" not "suppresses user message creation" | PASS |
| 2. VI-3 consistent with noReply description | PASS |
| 3a. SC-1 defaults correct | PASS |
| 3b. VI-1 correct | PASS |
| 3c. CC-3 correct | PASS |
| 3d. SC-6 ownership correct | PASS |
| 4. No new issues introduced | PASS |

**Non-blocking observation:** Glossary line 204 ("no user message creation beyond the confirmation text") is terse and could be misread in isolation, but is consistent when read alongside fix #2 (line 32) and VI-3 (line 115). Recommend tightening for clarity in a future pass but not blocking.

## Verdict

The round-2 blocking issue (noReply description contradicting VI-3 on user message creation) is resolved. Line 32 now correctly says "suppresses LLM invocation" and explicitly states the confirmation text is created as a user message. VI-3 is consistent. All previous fixes (SC-1 defaults, VI-1, CC-3, SC-6 ownership) remain correct. No new blocking issues introduced.

VERDICT: PASS
