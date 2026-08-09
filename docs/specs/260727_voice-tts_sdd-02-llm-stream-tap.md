# SDD-02: LLM Stream Tap

**Date:** 2026-07-27
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending independent audit + human gate)
**Master:** `docs/specs/260727_voice-tts_sdd-00-master.md`
**Depends on:** SC-2 (VoiceMode state, owned by SDD-01), SC-5 (Abort Ownership, owned by SDD-01), SC-6 (Audio Tag Vocabulary, owned by SDD-05). Consumes the plugin `event` hook and the `experimental.text.complete` hook — both pre-existing plugin surfaces, not owned here.
**Defines:** SC-3 (Text Stream: LLM → TTS).

This feature spec taps the assistant's streaming text from opencode's existing Bus event stream and exposes it to the TTS engine as an async iterable of `string` chunks, while stripping inline audio tags from the TUI's rendered text. It refines SDD-00 and inherits all cross-cutting requirements (CC-1..CC-11). Where this document conflicts with the master, the master wins; in particular SC-3 (Text Stream) is the authoritative contract this spec defines, and SC-2/SC-5/SC-6 are consumed as given. No code is written against this spec until the full suite passes independent audit and the human gate (see `make sdd`).

## Background (why this is a tap, not a build)

The assistant text stream already exists and is already delivered to plugins. opencode's session processor emits a `message.part.delta` Bus event for every assistant text token and every reasoning token, and the plugin `event` hook fans every Bus event out to every loaded plugin. **No streaming-text surface is built.** This spec only (a) filters those events, (b) re-shapes the filtered deltas into the async iterable the TTS engine consumes, and (c) rewrites the final assistant text via the existing `experimental.text.complete` hook so the TUI never persists audio tags.

The delivery chain, all pre-existing:

- The processor's `text-delta` case appends `value.text` to `ctx.currentText.text` and calls `session.updatePartDelta({ ..., field: "text", delta: value.text })` (`packages/opencode/src/session/processor.ts:419-429`).
- `session.updatePartDelta` publishes `MessageV2.Event.PartDelta` on the Bus (`packages/opencode/src/session/index.ts:643`), typed as `"message.part.delta"` with `{ sessionID, messageID, partID, field, delta }` (`packages/opencode/src/session/message-v2.ts:489-498`).
- The plugin loader subscribes to the Bus with `bus.subscribeAll()` and runs `hook["event"]?.({ event: input as any })` for every event (`packages/opencode/src/plugin/index.ts:248-257`). Every loaded plugin's `event` hook receives every Bus event, including `message.part.delta`.
- The TUI consumes the same stream independently: `packages/app/src/context/global-sdk.tsx:87` coalesces `message.part.delta` events, and `packages/app/src/context/global-sync/event-reducer.ts:256-272` appends each `delta` to the part's `field` in the store. The plugin **cannot** intercept the TUI's subscription; it can only rewrite the final text after streaming via `experimental.text.complete`.

This spec therefore adds a filter + an async-iterable adapter + a completion stripper on the plugin side. It adds nothing to opencode core.

---

## WHAT

Behavioral requirements. Literal `WHEN`/`SHALL` tokens are machine-checkable. Cross-cutting and shared-contract references in parentheses.

1. **WHEN** voice mode transitions to active (SC-2 `active === true` with a non-null `sessionId`), the plugin **SHALL** receive Bus events via its `event` hook (`packages/plugin/src/index.ts:223`) — which the loader fans every Bus event into, including `message.part.delta` (`packages/opencode/src/plugin/index.ts:248-257`) — and **SHALL NOT** poll `sdk.session.messages` or re-query history to obtain streaming text. The live event stream is the only source of deltas. (CC-1, CC-9, SC-3)

2. **WHEN** a `message.part.delta` event arrives, the plugin **SHALL** consider it for forwarding only if `input.event.properties.sessionID` equals the active voice session id (SC-2 `sessionId`). Deltas for any other session **SHALL** be ignored, even if the plugin is loaded and voice is active. (SC-2, SC-3)

3. **WHEN** a `message.part.updated` event arrives (`packages/opencode/src/session/message-v2.ts:479-488`) with `part.type === "text"`, the plugin **SHALL** record that `partID` in a per-session `Set<PartID>` of **text parts**. **WHEN** a `message.part.delta` event arrives, the plugin **SHALL** forward the delta ONLY if its `partID` is in the text-parts set. This is an **include-only-text** filter — tool-call deltas, file-part deltas, reasoning deltas, and any other non-text part type **SHALL** be dropped. The `field` property does not distinguish part types (both the assistant-text emit at `packages/opencode/src/session/processor.ts:423-428` and the reasoning emit at `packages/opencode/src/session/processor.ts:241-247` carry `field === "text"`), so type is recoverable only by correlating with the antecedent `message.part.updated`. This is consistent with SC-3 in the master. (SC-3)

4. **WHEN** an assistant text delta passes the session and text-parts filters, the plugin **SHALL** make the `delta` string available to the TTS engine as one element of an async iterable (or async generator) yielding `string` chunks. The iterable **SHALL** be scoped to a single assistant text part (one turn): created when the first qualifying delta for a new `partID` arrives, and completed on response completion (requirement 6). The plugin **SHALL** yield deltas as they arrive, and **SHALL NOT** buffer the full message before yielding. (CC-10, SC-3)

5. **WHEN** a text delta is forwarded to the TTS engine, the plugin **SHALL** forward it verbatim, including any inline audio tags (`[laughs]`, `[sighs]`, `[whispers]`, etc.) drawn from the SC-6 vocabulary. The plugin **SHALL NOT** strip, translate, expand, or otherwise transform audio tags on the TTS-bound path. The TTS engine is the sole consumer of audio tags; the TUI is the sole consumer of stripped text. (CC-2, SC-6)

6. **WHEN** the plugin observes `input.event.type === "message.part.updated"` with `input.event.properties.part.type === "text"` and `input.event.properties.part.id` matching a part it has been forwarding (i.e., the assistant text part reaching `text-end`, `packages/opencode/src/session/processor.ts:432-451`), **OR** a `session.status` event (`packages/opencode/src/session/status.ts:30-36`) for the active session with `input.event.properties.status.type === "idle"` (the primary completion fallback — the deprecated `session.idle` event at `packages/opencode/src/session/status.ts:37-43` is still published alongside `session.status` at `status.ts:75-76` but may be removed), the plugin **SHALL** signal the TTS engine to flush — i.e., commit any buffered text to audio generation and end the current async iterable. The plugin **SHALL** treat this as the end of one assistant turn's text stream and **SHALL NOT** carry delta state across turns. (SC-3)

> **Note (SC-3 boundary with SDD-03).** SDD-03 owns sentence-boundary detection and flush semantics. SDD-02's responsibility ends at forwarding text deltas verbatim (including audio tags) and signaling response completion. SDD-02 **SHALL NOT** split sentences or flush buffers — that is SDD-03's responsibility.

7. **WHEN** the assistant's text part reaches `text-end` and the plugin is loaded, the plugin's `experimental.text.complete` hook (`packages/plugin/src/index.ts:325-328`, fired at `packages/opencode/src/session/processor.ts:435-443`) **SHALL** return a `text` string with all audio tags from the SC-6 vocabulary removed, so the persisted part and the TUI's subsequent re-render carry no tags. This stripping **SHALL** run whenever the plugin is loaded, regardless of whether voice mode is active, because CC-3 is unconditional: the user **SHALL NOT** see `[laughs]` in the terminal. (CC-3, SC-6)

8. **WHEN** an audio tag is in flight during streaming (before `text-end`), the tag **SHALL** be visible in the TUI until the `experimental.text.complete` rewrite fires and the subsequent `message.part.updated` re-renders the part. The plugin **SHALL NOT** attempt to strip tags from individual streaming deltas: no streaming-rewrite hook exists, and the `chat.message` hook (`packages/plugin/src/index.ts:233-242`) fires only on **user** message creation (`packages/opencode/src/session/prompt.ts:1235`, where `info` is the user message and `parts` are user parts) and therefore cannot mutate assistant text. This transient tag visibility during streaming **SHALL** be documented in the plugin README as a known cosmetic limitation. (CC-3)

9. **WHEN** the `experimental.text.complete` hook strips tags, it **SHALL** match only the known tags enumerated in SC-6, and **SHALL NOT** match arbitrary bracket patterns. False positives such as `[0]` in code snippets, `[i]`/`[j]` in array indexing, or `[Note]` in prose **SHALL** be preserved. The matcher **SHALL** be anchored to the SC-6 vocabulary (a known-tag set), not a generic `\[...\]` regex. (SC-6)

10. **WHEN** `client.session.abort({ sessionID })` is called for the active voice session (CC-6, SC-5 — the SDK method that cancels the upstream provider request), the plugin **SHALL** stop forwarding text deltas to the TTS engine immediately, **SHALL** terminate the active async iterable (break its loop), and **SHALL** signal the TTS engine to stop. The plugin **SHALL NOT** own its own `AbortController` for the LLM stream (SC-5); the SDK abort cancels emission upstream, and the plugin uses a local forwarding flag to stop its own tap synchronously rather than waiting for the stream to drain. (CC-6, SC-5)

11. **WHEN** the TTS engine is consuming the async iterable, the plugin **SHALL NOT** block the TUI from rendering text, accepting input, or running tools. The event hook callback and the async iterable **SHALL** run in a background fiber/task; the session loop **SHALL NOT** await TTS or audio playback before accepting the next input. (CC-4)

12. **WHEN** the plugin imports the `Event` type for its `event` hook signature, it **SHALL** prefer importing from `@opencode-ai/sdk/v2` — whose `Event` union includes `EventMessagePartDelta` (`packages/sdk/js/src/v2/gen/types.gen.ts:1106,2018`) — over the v1 `Event` type from `@opencode-ai/sdk`, whose union (`packages/sdk/js/src/gen/types.gen.ts:704-736`) lacks `EventMessagePartDelta`. If the v2 import path is unavailable in Bun at implementation time, the plugin **SHALL** fall back to the sanctioned `as any` cast with runtime shape guard (requirement 14). Verification of the v2 import path is a tracked fast-follow. (SDD-00 Open Question 5, SC-3)

13. **WHEN** voice mode is not active (SC-2 `active === false`), the plugin **SHALL NOT** forward any deltas to the TTS engine and **SHALL NOT** create an async iterable. The TTS path is fully gated on voice mode. The `experimental.text.complete` tag stripper (requirement 7) **SHALL** continue to run regardless, so the TUI remains tag-free even when voice is off. (CC-3, CC-5, SC-2)

14. (Refines requirement 12.) **WHEN** the plugin's `event` hook receives events, the implementation **SHALL** use an `as any` cast on the event payload (necessary because the `@opencode-ai/sdk` v1 `Event` type does not include `message.part.delta`) paired with a runtime shape guard that asserts the expected fields (`type`, `properties.sessionID`, `properties.partID`, `properties.delta`) before handling. The cast is sanctioned by this spec; CI lint rules **SHALL** permit it with a comment referencing this requirement. Verification of the `@opencode-ai/sdk/v2` import path for proper typing is a tracked fast-follow. (SDD-00 Open Question 5, SC-3)

---

## HOW

Implementation approach, FoxyBear best practices, explicit reuse map. No new mechanism where an existing one fits (CC-9, CC-10).

### Event subscription — reuse the `event` hook, do not subscribe to the Bus directly

The plugin **does not** call `bus.subscribeAll()` itself. The loader already subscribes to the Bus and fans every event into every loaded plugin's `event` hook (`packages/opencode/src/plugin/index.ts:248-257`). The plugin's sole subscription surface is:

```typescript
// packages/plugin/src/index.ts:223
event?: (input: { event: Event }) => Promise<void>
```

The handler switches on `input.event.type` (the Bus event's discriminator) and routes `message.part.delta`, `message.part.updated`, and `session.status` to the tap. All other events are ignored. This reuses the existing fan-out and avoids a second Bus subscription (CC-9). The `event` payload is delivered with `as any` at `packages/opencode/src/plugin/index.ts:252` because the v1 SDK `Event` union lacks `EventMessagePartDelta` (`packages/sdk/js/src/gen/types.gen.ts:704-736`); the plugin imports the v2 type per requirement 12 to avoid propagating that cast.

### PartDelta shape and the two emit sites

`message.part.delta` is defined at `packages/opencode/src/session/message-v2.ts:489-498`:

```typescript
PartDelta: BusEvent.define("message.part.delta", z.object({
  sessionID: SessionID.zod, messageID: MessageID.zod,
  partID: PartID.zod, field: z.string(), delta: z.string(),
}))
```

The two emit sites both pass `field: "text"`:

- Assistant text: `packages/opencode/src/session/processor.ts:423-429` (the `text-delta` case).
- Reasoning: `packages/opencode/src/session/processor.ts:241-247` (the `reasoning-delta` case).

**The `field` property does not distinguish the two.** This is the central finding that refines SC-3. The plugin correlates via part type instead (see next subsection).

### Include-only-text filter — correlate with `message.part.updated`

The plugin maintains a per-session `Set<PartID>` of **text parts** (not reasoning parts), populated from `message.part.updated` events (`packages/opencode/src/session/message-v2.ts:479-488`) whose `part.type === "text"`. (`message.part.updated` carries the full discriminated `part`; the `Part` union at `packages/opencode/src/session/message-v2.ts:386-404` discriminates on `type`; text parts carry `type: "text"`, reasoning parts `type: "reasoning"`.) `message.part.updated` is emitted by `session.updatePart` (`packages/opencode/src/session/index.ts:466-476`), which the processor calls on `reasoning-start` (`packages/opencode/src/session/processor.ts:234`) for reasoning parts before any `reasoning-delta` fires, so the part's type is known to the plugin before that part's first delta arrives. A `message.part.delta` is forwarded ONLY if its `partID` is in the text-parts set — an **include-only-text** filter, not an exclude-reasoning filter; tool-call deltas, file-part deltas, reasoning deltas, and any other non-text part type are dropped. The set is cleared on turn completion (requirement 6). The reasoning set (if maintained for diagnostics) is supplementary; the text-parts set is authoritative.

This is the honest mechanism. SC-3 in the master defines an include-only-text filter: `field` is `"text"` for both assistant text and reasoning, so the filter is on **part type**, recovered from the antecedent `message.part.updated`.

### Async iterable — a per-turn adapter over the event stream

The tap exposes an `AsyncIterable<string>` to the TTS engine (SDD-03). Concretely, the plugin holds a pending resolver per active `partID`; the `event` hook pushes each qualifying delta's `properties.delta` string by resolving the current chunk. A single async generator yields chunks until completion:

```typescript
async function* tap(sessionId, signal): AsyncIterable<string> {
  const q = new Queue<string>()           // per-turn
  const done = createResolvable<void>()
  active.set(sessionId, { q, done, signal })
  try {
    while (true) {
      const next = await Promise.race([q.next(), done])
      if (next === DONE) break
      yield next                          // verbatim, audio tags included (req 5)
    }
  } finally { active.delete(sessionId) }
}
```

The `event` hook does `active.get(sessionId)?.q.push(delta)` for qualifying deltas, and resolves `done` on completion (requirement 6) or abort (requirement 10). The generator is created when the first qualifying delta for a new `partID` arrives (requirement 4) and runs in a background fiber (requirement 11). The plugin does not buffer the full message — each delta is pushed and yielded as it arrives (CC-10).

### Verbatim forwarding — the TTS path never strips

On the TTS-bound path the `delta` string is pushed unmodified. Audio tags (`[laughs]`, `[sighs]`, ...) are bytes like any other; ElevenLabs v3 renders them (CC-2, SC-6). The stripper lives on a different path (TUI), so the two concerns never share code.

### Response completion — flush on `message.part.updated` (text) or `session.status`

The plugin treats a turn's text stream as complete when either:

- A `message.part.updated` arrives whose `part.type === "text"` and `partID` matches the part being forwarded — this corresponds to the processor's `text-end` case (`packages/opencode/src/session/processor.ts:432-451`), which calls `session.updatePart(ctx.currentText)` (`packages/opencode/src/session/processor.ts:449`) and so publishes `PartUpdated` (`packages/opencode/src/session/index.ts:469`). This is the primary completion signal.
- A `session.status` event (`packages/opencode/src/session/status.ts:30-36`) arrives for the active session with `status.type === "idle"` — the primary fallback for providers whose `text-end` is not cleanly observable, and for the idle-after-turn case. (The deprecated `session.idle` event at `packages/opencode/src/session/status.ts:37-43` is still published alongside `session.status` at `status.ts:75-76` but may be removed.)

On completion the plugin resolves the iterable's `done` (which flushes the TTS engine — the flush call itself is SDD-03's concern; this spec only signals end-of-stream) and clears the per-session text-parts set.

### TUI tag stripping — `experimental.text.complete`, always-on

The only hook that can rewrite the **persisted, re-rendered** assistant text is `experimental.text.complete` (`packages/plugin/src/index.ts:325-328`), which the processor triggers at `text-end` (`packages/opencode/src/session/processor.ts:435-443`):

```typescript
ctx.currentText.text = (yield* plugin.trigger(
  "experimental.text.complete",
  { sessionID, messageID, partID },
  { text: ctx.currentText.text },
)).text
```

The returned `text` replaces `ctx.currentText.text`, which is then persisted via `session.updatePart` (`packages/opencode/src/session/processor.ts:449`), publishing `message.part.updated` — which the TUI's reducer applies to the store, re-rendering the part without tags. The plugin's hook strips SC-6 tags and returns the cleaned string. This runs whenever the plugin is loaded, voice or not (requirement 7), because CC-3 is unconditional.

### Why `chat.message` is ruled out

`chat.message` (`packages/plugin/src/index.ts:233-242`) fires at `packages/opencode/src/session/prompt.ts:1235` on **user** message creation — its `output` is `{ message: UserMessage, parts: Part[] }` (user message and user parts), and it fires before the assistant turn begins. It cannot mutate assistant text and is not in the assistant streaming path. It is not used for TUI tag stripping.

### The streaming-tag cosmetic limitation (honest)

During streaming, the TUI's event reducer appends each `delta` to the part's field in the store (`packages/app/src/context/global-sync/event-reducer.ts:256-272`) as it arrives. The plugin cannot intercept that append — the TUI subscribes to the Bus independently (`packages/app/src/context/global-sdk.tsx:87`). Therefore an audio tag present in a streaming delta is visible in the TUI until `text-end`, when `experimental.text.complete` rewrites the text and the subsequent `message.part.updated` re-renders the part tag-free. The tag flashes briefly, then disappears. There is no streaming-rewrite hook in opencode today; this spec does not add one (CC-1, no fork). The transient visibility is documented as a known cosmetic limitation (requirement 8). A future enhancement — a streaming `text.delta` rewrite hook — would eliminate the flash, but is out of scope and would require an opencode core change.

Note: Audio tags are visible in the TUI during streaming and stripped on `text-end` via `experimental.text.complete`. No streaming-rewrite hook exists upstream, so the visibility window is inherently bounded by streaming duration. If the `experimental.text.complete` hook is unavailable or removed upstream, degraded behavior is: tags remain visible in the TUI transcript while audio still emotes correctly — cosmetic degradation, not functional failure. The experimental-hook dependency is tracked as architectural debt.

### Abort — local flag, no owned LLM AbortController

On barge-in (CC-6), the caller (SDD-01's voice mode transition, or a new user turn for the same session) invokes `client.session.abort({ sessionID })` (SC-5). This cancels the upstream provider request; the processor stops emitting deltas. The plugin does not wait for the stream to drain — it sets a local `aborted` flag on the active tap, resolves the iterable's `done` immediately, and signals the TTS engine to stop. The plugin **does not** construct its own `AbortController` for the LLM stream (SC-5); the local flag only gates its own forwarding, not upstream cancellation. The audio sink's separate stop mechanism (kill player + close stdin) is owned by SDD-04 and runs in parallel.

### Reuse map

| Concern | Reused surface | Anchor | Owned by |
|---|---|---|---|
| Bus event delivery to plugins | plugin `event` hook fan-out | `packages/opencode/src/plugin/index.ts:248-257` | opencode core (reused) |
| `event` hook signature | `Hooks.event` | `packages/plugin/src/index.ts:223` | plugin SDK (reused) |
| PartDelta event type | `MessageV2.Event.PartDelta` | `packages/opencode/src/session/message-v2.ts:489-498` | opencode core (reused) |
| Assistant text emit | `text-delta` case | `packages/opencode/src/session/processor.ts:423-429` | opencode core (reused) |
| Reasoning emit (same `field`) | `reasoning-delta` case | `packages/opencode/src/session/processor.ts:241-247` | opencode core (reused) |
| Part type correlation | `message.part.updated` | `packages/opencode/src/session/message-v2.ts:479-488` | opencode core (reused) |
| Idle/flush fallback | `session.status` (`status.type === "idle"`) | `packages/opencode/src/session/status.ts:30-36` | opencode core (reused) |
| TUI tag strip hook | `experimental.text.complete` | `packages/plugin/src/index.ts:325-328`, fired `packages/opencode/src/session/processor.ts:435-443` | plugin SDK (reused) |
| v2 Event typing | `EventMessagePartDelta` | `packages/sdk/js/src/v2/gen/types.gen.ts:1106,2018` | SDK (reused) |
| Abort | `client.session.abort` | SC-5 (owned by SDD-01) | SDK (reused) |
| Audio tag vocabulary | SC-6 tag set | master spec | SDD-05 (consumed) |
| Voice mode state | SC-2 `VoiceMode` | master spec | SDD-01 (consumed) |

### What is explicitly NOT built

- No new Bus subscription (the `event` hook fan-out is reused — CC-9).
- No streaming-rewrite hook and no opencode core edit (CC-1; the TUI streaming flash is accepted, requirement 8).
- No use of `chat.message` for assistant text — it fires on user messages only (`packages/opencode/src/session/prompt.ts:1235`).
- No owned `AbortController` for the LLM stream (SC-5; the plugin uses a local forwarding flag only).
- No audio playback, no ElevenLabs connection, no WebSocket — those are SDD-03 (ElevenLabs) and SDD-04 (Audio Sink). This spec produces an `AsyncIterable<string>` and a flush signal; it does not consume audio.
- No tag vocabulary of its own — the stripper matches against SC-6's known-tag set (owned by SDD-05).
- No voice mode state machine — SC-2 is consumed from SDD-01.

---

## VERIFY

Acceptance criteria for independent agents, exercising the tap against a **mocked Bus event stream** (a fake that replays a recorded sequence of `message.part.delta`, `message.part.updated`, and `session.status` events with controllable `sessionID`/`partID`/`field`/`type`/`delta`) driving the plugin's `event` hook directly, plus a stub TTS consumer that drains the plugin's `AsyncIterable<string>` and records every chunk and every flush. The `experimental.text.complete` path is exercised by running the plugin's hook against the real `plugin.trigger` seam (or a faithful stub of it) and asserting the returned `text`. No live LLM, no live ElevenLabs, no audio device. Each item maps 1:1 to a WHAT requirement. Every scenario states setup, action, expected observable.

- **V1 — event hook is the sole subscription surface (req 1, CC-1/CC-9).** Setup: plugin loaded with a spy on `bus.subscribeAll` (assert it is never called by the plugin) and an instrumented `event` hook entry. Action: replay a `message.part.delta` for the active session. Expected: the hook fires exactly once for the event; `bus.subscribeAll` is never invoked by plugin code; no `sdk.session.messages` call occurs. Confirms the tap reuses the loader's fan-out and does not subscribe itself.

- **V2 — session ID filter (req 2, SC-2).** Setup: voice active for session `S1`; stub TTS consumer attached. Action: replay deltas for `S1`, `S2`, `S1` in order (same `partID`, `field: "text"`, non-reasoning). Expected: only the `S1` deltas reach the consumer; the `S2` delta is dropped silently; the consumer sees chunks `[d1, d3]` and not `d2`.

- **V3 — include-only-text filter via part-type correlation, NOT `field` (req 3, SC-3).** Setup: voice active for `S1`. Action: replay (a) a `message.part.updated` for `partID=R` with `part.type === "reasoning"`, then (b) a `message.part.delta` for `partID=R`, `field: "text"`, `delta: "thinking..."`, then (c) a `message.part.updated` for `partID=T` with `part.type === "text"`, then (d) a `message.part.delta` for `partID=T`, `field: "text"`, `delta: "hello"`. Expected: the reasoning delta (b) is dropped even though its `field === "text"`; the text delta (d) is forwarded; the consumer sees `["hello"]` only. Assert the plugin recorded `T` in its text-parts set and `R` was not. Confirms `field` alone is insufficient and the text-parts set is the authoritative include filter.

- **V4 — async iterable is per-turn, streaming, unbuffered (req 4, CC-10).** Setup: voice active; consumer drains with a recorded timestamp per chunk. Action: replay three text deltas for the same `partID` with a 20ms gap between each, then a `message.part.updated` completing the part. Expected: the consumer receives each chunk within ~one event-loop tick of its replay (not all at once after completion); the iterable ends after the completion event. Assert no chunk is held until end-of-turn. Confirms streaming, not batch.

- **V5 — verbatim forwarding including audio tags (req 5, CC-2/SC-6).** Setup: voice active. Action: replay a text delta `delta: "That's a fun way to break prod. [laughs] I'm kidding — sort of."`. Expected: the consumer receives the exact byte string verbatim, including `[laughs]`; no transformation, stripping, or expansion is applied on the TTS-bound path. Assert equality, not substring.

- **V6 — completion flush on `message.part.updated` (text), and on `session.status` fallback (req 6, SC-3).** Setup A: voice active; replay deltas then a `message.part.updated` for the same text `partID` with `part.type === "text"`. Expected A: the iterable ends and a flush signal is emitted to the TTS engine; the per-session text-parts set is cleared. Setup B: voice active; replay deltas then a `session.status` with `status.type === "idle"` for the active session (no `text` PartUpdated). Expected B: the iterable ends and a flush is emitted (the idle fallback). Assert that in both cases no further deltas after the completion signal are forwarded to the ended iterable.

- **V7 — `experimental.text.complete` strips SC-6 tags, always-on (req 7, CC-3/SC-6).** Setup: plugin loaded; voice **inactive**. Action: invoke the plugin's `experimental.text.complete` hook with `text: "Hmm [sighs] that was rough. [laughs] Done."`. Expected: the returned `text` is `"Hmm  that was rough.  Done."` (tags removed, surrounding text preserved). Repeat with voice active: identical result. Confirms the stripper runs regardless of voice mode.

- **V8 — streaming tags visible until `text-end` rewrite; `chat.message` not used for assistant text (req 8, CC-3).** Setup: replay a text delta containing `[laughs]` and assert the TUI reducer (or its stub) appends it verbatim (tag visible) — the plugin does not strip on the delta path. Then fire `experimental.text.complete` and assert the post-rewrite text the TUI would re-render has no tag. Action B: assert the plugin registers **no** `chat.message` handler that mutates assistant parts (grep the plugin source; confirm `chat.message` is either unset or does not touch assistant text). Confirms the transient flash is accepted and `chat.message` is ruled out.

- **V9 — stripper matches known SC-6 tags only, not arbitrary brackets (req 9, SC-6).** Setup: plugin loaded. Action: invoke `experimental.text.complete` with `text: "arr[0] = [i] + [j]; see [Note] above; [laughs] ok."`. Expected: returned text is `"arr[0] = [i] + [j]; see [Note] above;  ok."` — only `[laughs]` (a known SC-6 tag) is removed; `[0]`, `[i]`, `[j]`, `[Note]` are preserved. Assert the matcher is vocabulary-anchored, not a generic bracket regex.

- **V10 — abort stops forwarding immediately, no owned LLM AbortController (req 10, CC-6/SC-5).** Setup: voice active; an in-flight iterable with one chunk already yielded; a local `aborted` flag on the tap. Action: simulate barge-in by calling the plugin's abort entrypoint (which sets the flag and resolves `done`), then replay a further text delta 5ms later. Expected: the late delta is **not** forwarded to the consumer; the iterable has already ended; the TTS-engine stop signal fired. Assert the plugin did **not** construct or call an `AbortController` for the LLM stream — only `client.session.abort` (mocked/stubbed) is the upstream cancel, and the plugin's local flag is the synchronous gate. Confirms SC-5.

- **V11 — no blocking of the session loop / TUI (req 11, CC-4).** Setup: voice active; consumer that drains slowly (100ms per chunk). Action: replay three deltas back-to-back, then immediately assert a synthetic "next input accepted" marker can be processed (the event hook returns without awaiting the consumer). Expected: the event hook returns promptly for each delta (does not await TTS consumption); the slow consumer drains in the background; the session loop is never observed waiting on the iterable. Assert the iterable runs in a background fiber/task.

- **V12 — v2 SDK typing import, no v1 union (req 12, Open Question 5).** Static + compile: grep the plugin source — the `Event` type is imported from `@opencode-ai/sdk/v2` (or payloads are matched structurally with no v1 `Event` import). `bun run typecheck` passes with the v2 import. If the v2 import path is unavailable in Bun, assert the plugin uses structural matching (`input.event.type === "message.part.delta"` and reads `input.event.properties` by key) and adds **no** `as any` cast of its own beyond what the loader already does. Confirm the v1 `Event` union (`packages/sdk/js/src/gen/types.gen.ts:704-736`) is not the import source.

- **V13 — forwarding gated on voice mode; stripping always on (req 13, CC-3/CC-5/SC-2).** Setup A: voice **inactive** (`SC-2 active === false`). Action A: replay a text delta for the session. Expected A: no async iterable is created; the consumer receives nothing; no TTS forwarding occurs. Action B (still voice inactive): invoke `experimental.text.complete` with a tagged string. Expected B: tags are still stripped (V7 cross-check). Setup C: transition voice to active and replay the same delta. Expected C: the iterable is created and the consumer receives the chunk. Confirms the TTS path is voice-gated and the TUI strip path is not.

- **V14 — sanctioned `as any` cast + runtime shape guard (req 14).** Static + runtime. Static: grep the plugin source — the `event` hook applies an `as any` cast to the event payload with an adjacent comment referencing requirement 14; the CI lint config permits this cast (does not error). Runtime: replay a malformed payload missing `properties.sessionID` (and separately `properties.partID`, `properties.delta`); the shape guard rejects each before any forwarding occurs and the hook does not crash the loader. Replay a well-formed `message.part.delta`; the guard passes and the delta is forwarded (cross-check V2). Confirms the cast is sanctioned and guarded, not untyped trust. The `@opencode-ai/sdk/v2` import-path verification is a tracked fast-follow, not gated here.

- **V15 — build/regression green (CC-8).** `bun run typecheck` passes from `packages/opencode` (and `packages/plugin` where the hook types live) and `bun test` is fully green, including the new tap/stripper/cast-guard tests above and the untouched session/processor/TUI-reducer suites. The TUI event-reducer behavior (`packages/app/src/context/global-sync/event-reducer.ts:256-272`) is unchanged by this spec — no TUI test should regress. A feature is not done with any red test.
