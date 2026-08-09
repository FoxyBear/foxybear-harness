# Verification Report — SDD-01 v2 (Voice System Commands)

**Spec:** `260806_voice-tts_sdd-v2-01-system-commands.md`
**Acceptance suite:** `test/voice/verify/sdd-v2-01.test.ts` (16 tests)
**Contract suite:** `test/voice/engine-contract.test.ts` (11 tests)
**Date:** 2026-08-07

## Verification method

Ran the acceptance suite (`bun test test/voice/verify/sdd-v2-01.test.ts`) and the
InMemoryVoiceEngine contract suite against the implementation. Each VERIFY
criterion maps 1:1 to a test. The harness constructs `Voice.Service` as an Effect
service with an injected `InMemoryVoiceEngine` and a recording abort client; Bus
events are captured via the shared `Bus.Service` (memoized). The v2 SDK abort
path is mocked by the injected `abort` function; the production default uses
`createOpencodeClient` from `@opencode-ai/sdk/v2`.

## Criteria coverage

| VERIFY | Test | Result |
|---|---|---|
| V1 service owns initial state | `V1 — Voice.Service is an Effect service and owns initial state` | PASS |
| V2 voice/mute system commands | `V2 — voice and mute registered as system commands` | PASS |
| V3 native branch skips LLM, toggles | `V3 — native command branch skips LLM and toggles state` | PASS |
| V4 config defaults + robust rejected | `V4 — config parses with defaults and rejects robust` | PASS |
| V5 missing voiceId inactive | `V5 — missing voiceId keeps voice inactive…` | PASS |
| V6 fail-closed on missing API key | `V6 — /voice fail-closed on missing API key` | PASS |
| V7 deactivation on connect failure | `V7 — deactivation on connection failure` | PASS |
| V8 barge-in stop-before-abort | `V8 — barge-in calls engine.stop before abort…` | PASS |
| V9 teardown clears state | `V9 — teardown clears all state on disposal` | PASS |
| V10 status events on transitions | `V10 — voice.status fires on transitions` | PASS |
| V11 session.deleted clears session | `V11 — session.deleted clears that session only` | PASS |
| V12 engine lifecycle callbacks | `V12 — engine factory lifecycle callbacks` | PASS |
| V13 autoStart on first delta | `V13 — autoStart activates on first assistant text delta` | PASS |
| V14 concurrency/idempotency | `V14 — concurrency/idempotency…` | PASS |
| V15 InMemoryVoiceEngine contract | `V15` + `engine-contract.test.ts` | PASS |
| V16 build/regression green | typecheck + `bun test` (pipeline-enforced) | PASS |

## Notes / deviations

- **In-memory state only (task constraint #7).** `VoiceStatePart` is kept as an
  in-memory transition record; no `MessageV2.Part` union was modified, so
  SDK-generated share types are unaffected. Observable behavior (state + Bus
  events) matches the spec.
- **Cycle avoidance (task constraint #5).** `SessionPrompt.command` imports
  `Voice` via a dynamic `import("@/voice")` inside the Effect; the voice module
  never imports `session/prompt.ts` or `app-runtime.ts`. Module-load ordering of
  `app-runtime ↔ SessionPrompt` is a pre-existing fragility (documented in the
  baseline file); the acceptance suite loads `app-runtime` first to stabilise
  it.
- Native commands are registered with `source: "system"` and handled before
  `commands.get`, returning a `noReply: true` user message.

## Build/regression gate

- `bun run typecheck` (from `packages/opencode`): clean.
- `bun test`: green modulo the documented pre-existing flaky cancel/shell timing
  tests in `test/session/prompt-effect.test.ts` (baseline-tolerated).

VERDICT: PASS
