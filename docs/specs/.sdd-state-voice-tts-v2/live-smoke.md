# Live Smoke Test — Voice TTS v2

**Date:** 2026-08-07
**Harness:** `test/voice/smoke.test.ts` (real instance + real session + real
native command dispatch via `SessionPrompt.command`, default `InMemoryVoiceEngine`).

## Run

```
LIVE SMOKE
  /voice -> role=user "Voice on." state={"mode":"on","output":"unmuted","engine":"ready"}
  /mute  -> "Muted." state={"mode":"on","output":"muted","engine":"ready"}
  /voice -> "Voice off." state={"mode":"off","output":"unmuted","engine":"disconnected"}
```

## Observations

- `/voice` is handled as a **native system command**: the returned message is a
  `user` role message with `noReply` semantics — no LLM round-trip. Confirmation
  text "Voice on." is returned.
- `Voice.Service` state transitions are observable: `off → on (connecting →
  ready)`, `unmuted → muted`, `on → off (disconnected)`.
- The TTS engine (`InMemoryVoiceEngine` for this phase) connects and reports
  `ready`; muting stops playback without disabling voice mode; toggling off
  disconnects the engine.
- No exceptions; the text session continues unimpaired after each command.

## Scope note

This phase ships the **core voice control layer** (`Voice.Service`, native
`/voice` `/mute`, `VoiceEngine` contract, barge-in abort ownership, LLM-stream
tap). The ElevenLabs streaming engine (SDD-03), audio sink (SDD-04), and
expressivity (SDD-05) are deferred; the live smoke therefore exercises the
InMemoryVoiceEngine double, not real audio. The `VoiceEngine` interface is the
contract the real provider will implement.

**Result:** PASS
