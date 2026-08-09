# Independent Adversarial Audit: SDD-01 v2 Voice System Commands (Revised)

**Auditor:** independent adversarial auditor (not spec author)  
**Date:** 2026-08-07  
**Spec:** `docs/specs/260806_voice-tts_sdd-v2-01-system-commands.md`  
**Master:** `docs/specs/260806_voice-tts_sdd-v2-00-master.md`  
**Codebase:** `development/opencode/packages/opencode/src/`

---

## Audit Method

Re-reviewed the revised spec against the master cross-cutting requirements (CC-1..CC-12) and the source anchors referenced in the reuse map:

- `packages/opencode/src/command/index.ts`
- `packages/opencode/src/session/prompt.ts` (lines 1556–1696 and surrounding context)
- `packages/opencode/src/cli/cmd/tui/context/sdk.tsx` (lines 1–30)
- `packages/opencode/src/server/instance/session.ts` (lines 385–413)
- `packages/opencode/src/bus/index.ts`
- `packages/opencode/src/session/message-v2.ts` (for Part-model compatibility)

Criteria:

1. Each previous blocking issue is either resolved or remains unaddressed.
2. Revised `WHEN`/`SHALL` statements are observable and internally consistent.
3. Code anchors point to real, relevant source locations.
4. VERIFY criteria are independently checkable.

---

## Blocking Issues Review

### B1 — Command registration contradicted native-command interception

**Status:** RESOLVED

The revised spec now:

- Defines `Command.Info.source` extended with `"system"` (`source: z.enum(["command", "mcp", "skill", "system"]).optional()`).
- Registers `"voice"` and `"mute"` with `source: "system"`, empty `template`, and no `subtask`.
- Places the native branch in `SessionPrompt.command` **before** `commands.get(input.command)`, returning a `noReply: true` text part.

This removes the contradiction: the commands are registered (satisfying discovery and `Command.Service.get`), but `SessionPrompt.command` intercepts them before the template/LLM path executes.

### B2 — VoiceEngine contract ambiguous about session scoping

**Status:** RESOLVED

The `VoiceEngine` interface is now fully per-session:

- `connect(sessionID: string)`
- `disconnect(sessionID: string)`
- `synthesize(sessionID: string, textStream, options)`
- `stop(sessionID: string, urgency: "immediate" | "flush")`
- `getStatus(sessionID: string) => EngineStatus`
- `getCapabilities(sessionID: string) => EngineCapabilities`
- `events: AsyncIterable<EngineEvent & { sessionID: string }>`

This makes barge-in targeting, per-session status reconciliation, and event routing unambiguous.

### B3 — VoiceStatePart persistence model did not fit existing part model

**Status:** RESOLVED

The revised `VoiceStatePart` shape now matches the existing `MessageV2.Part` conventions:

```typescript
type VoiceStatePart = {
  type: "voice.state"
  id: PartID
  messageID: MessageID
  sessionID: SessionID
  ts: number
  seq: number
  transition: { ... }
  text: string
  synthetic: true
}
```

It carries the standard `id`, `messageID`, `sessionID`, and `type` discriminator required by `MessageV2.PartBase`, and uses the existing `synthetic` flag for model visibility. It would still need to be added to the `MessageV2.Part` discriminated union in `session/message-v2.ts`, but the shape itself is now compatible with `PartData = Omit<MessageV2.Part, "id" | "sessionID" | "messageID">`.

### B4 — Bus event fan-out anchor did not deliver events to Voice.Service

**Status:** RESOLVED

The reuse map no longer points to the plugin fan-out. Instead, the spec states that `Voice.Service` yields `Bus.Service` directly and subscribes to:

- `session.deleted`
- `message.part.delta` (for `autoStart` detection)

It publishes:

- `voice.status`
- `voice.warning`
- `voice.bargeIn.partial`

This is consistent with the real `Bus.Service` interface in `packages/opencode/src/bus/index.ts`.

### B5 — Auto-start trigger ownership crossed spec boundaries

**Status:** RESOLVED

The spec now exposes `Voice.Service.autoStart(sessionID)` as an internal method and explicitly states that **SDD-02 v2** calls it on the first assistant text delta. The contract boundary is clear: SDD-01 owns the method; SDD-02 owns the trigger. V13 tests `autoStart` directly without depending on SDD-02 details.

### B6 — Engine status mapping to VoiceState unspecified

**Status:** RESOLVED

A normative "Engine status → VoiceState.engine mapping" table is now included:

| EngineEvent / Status | Current `VoiceState.engine` | New `VoiceState.engine` |
|---|---|---|
| `connect(sessionID)` called | `disconnected` | `connecting` |
| `status_changed { ready: true }` | `connecting` | `ready` |
| `speaking_started` | `ready` | `speaking` |
| `stop(sessionID, "immediate")` called | `speaking` | `stopping` |
| `speaking_ended` / `speaking_interrupted` | `stopping` | `ready` |
| `speaking_failed` | any | `failed` → `mode: "off"` |
| `disconnect(sessionID)` called | any | `disconnected` |

This makes V7, V10, and V14 independently verifiable.

### B7 — TUI status/warning emission not observable

**Status:** RESOLVED

The spec now defines explicit Bus events:

- `voice.status` — payload `{ sessionID, state: VoiceState }`
- `voice.warning` — payload `{ sessionID, message }`
- `voice.bargeIn.partial` — payload for partial barge-in failures

V5, V6, V7, and V10 assert publication of these events, making them observable by an independent agent.

### B8 — `/voice` when `mode === "on"` conflicted with invalid-state rejection

**Status:** RESOLVED

The spec now clarifies that engine failure automatically transitions `mode → "off"` and `engine → "failed"` atomically. The state-machine section states: "Invalid states (e.g., `mode === "on"` with `engine === "failed"`) are rejected at the transition boundary; engine failure automatically transitions `mode → "off"` first." Consequently, a `/voice` command when `mode === "on"` is always a valid off→on toggle; the invalid state cannot persist long enough to be observed by command semantics.

### B9 — Command source enum could not represent native commands

**Status:** RESOLVED

`Command.Info.source` is extended to `z.enum(["command", "mcp", "skill", "system"]).optional()`. V2 now expects `source: "system"` for both `/voice` and `/mute`.

### B10 — VERIFY criteria depended on unspecified test harness

**Status:** RESOLVED

The VERIFY section now includes an explicit "Test harness" subsection:

- `Voice.Service` is constructed with an injected `InMemoryVoiceEngine`.
- Bus events are captured via a test `Bus.Service` or in-memory subscriber.
- V8 instruments a **mocked v2 SDK client** so `sdk.session.abort({ sessionID })` records without an HTTP round-trip.
- V13 tests `Voice.Service.autoStart(S)` directly.
- V15 defines the `InMemoryVoiceEngine` contract test suite.

The harness is now sufficiently specified for independent verification.

---

## Code Anchor Verification

| Spec anchor | Real source location | Assessment |
|---|---|---|
| `packages/opencode/src/command/index.ts:76-190` | File ends at line 191; lines 76-190 cover `Layer.effect` and `defaultLayer`. | Accurate. |
| `packages/opencode/src/command/index.ts:34-52` | `Command.Info` schema including `source` enum at line 40. | Accurate; currently `z.enum(["command", "mcp", "skill"])` and must be extended to include `"system"`. |
| `packages/opencode/src/session/prompt.ts:1556-1696` | `SessionPrompt.command` function spans lines 1556–1670. | Accurate; native branch must be inserted before line 1558 (`const cmd = yield* commands.get`). |
| `packages/opencode/src/cli/cmd/tui/context/sdk.tsx:1-30` | `createOpencodeClient` imported from `@opencode-ai/sdk/v2` at line 1. | Accurate. |
| `packages/opencode/src/server/instance/session.ts:385-413` | `POST /:sessionID/abort` at lines 385–413 calling `SessionPrompt.cancel`. | Accurate. |
| `packages/opencode/src/bus/` | `Bus.Service` with `subscribe`, `subscribeCallback`, `publish`. | Accurate. |

All anchors point to real, relevant code locations. No anchor is fabricated or materially misaligned.

---

## Non-Blocking Observations

### N1 — VoiceStatePart still needs union membership

The revised `VoiceStatePart` shape is compatible with `MessageV2.PartBase`, but the spec does not explicitly state that `"voice.state"` must be added to the `MessageV2.Part` discriminated union in `session/message-v2.ts`. This is implied by "writes a persisted structured system part," but an explicit note would reduce implementation risk.

### N2 — `voice.status` payload naming

The spec uses `state: VoiceState` in the `voice.status` payload, while the service exposes `getState(sessionID) => Effect.Effect<VoiceState>`. The naming is consistent. No issue.

### N3 — `autoStart` Bus event ambiguity

The spec says `Voice.Service` subscribes to `message.part.delta` for `autoStart` detection, but also says SDD-02 v2 calls `Voice.Service.autoStart(sessionID)`. These are two valid mechanisms; the spec should clarify which is authoritative. The current wording leans toward the explicit method call, which is preferable.

---

## Conclusion

All ten blocking issues from the previous audit have been addressed in the revised spec. The `WHEN`/`SHALL` statements are internally consistent, the `VoiceEngine` contract is unambiguously per-session, the `VoiceStatePart` model fits the existing message-part schema, the Bus wiring is correctly anchored, and the VERIFY criteria are independently checkable.

The remaining observations are minor clarifications and do not block approval.

---

VERDICT: PASS
