# Voice HTTP Route — Implementation Plan

**Date:** 2026-08-09
**Status:** Approved (council consensus)
**Supersedes:** `command.execute.before` + `noReply` + `voice.toggle`/`voice.mute` tools in SDD-00 and SDD-01

## Decision

Dedicated Hono route module at `server/instance/voice.ts`. TUI calls via `sdk.fetch`. State stays in `plugin.ts` module scope (server context). No chat messages, no LLM, no tools.

## Council Consensus

Both review agents independently confirmed the approach. Key decisions:

| Decision | Rationale |
|----------|-----------|
| Route at `/voice/*` (not `/session/:id/voice`) | Domain namespace pattern. Avoids coupling session.ts to voice internals. |
| `toggle()`/`mute()` stay in `plugin.ts` | State and functions that mutate it belong together. 437 lines isn't large. |
| TUI rejects when no session | Don't auto-create. Voice is meaningless without a session. `autoStart` covers default-on. |
| Route handler validates sessionID | `Session.get(sessionID)` prevents phantom-session memory leaks from `getMode()` lazy creation. |
| No auth on route | Consistent with existing posture (local daemon, no per-route auth anywhere). |
| `autoStart` not in route | Config-driven, consumed by event hook. Route is manual control only. |
| No race conditions | `toggle()` is synchronous. Bun single-threaded. State set before HTTP response. |

## Spec Updates Required

### SDD-00 Master (`260808_voice-tts_sdd-v3-00-master.md`)

1. **"Three targeted fixes" section**: Fix #2 (command-path mismatch / `noReply` wiring) is replaced by the HTTP route approach. Rewrite to describe the dedicated Hono route at `/voice/toggle` and `/voice/mute`, called via `sdk.fetch`.

2. **Architecture diagram**: Remove `command.execute.before` from the flow. The toggle path is now: `TUI /voice → POST /voice/toggle → server route → toggle() → modes Map`.

3. **Cross-cutting requirements**:
   - CC-1: Remove the `noReply` core modification mention. The only core modification is now adding `VoiceRoutes` to `server/instance/index.ts` (one `.route()` line). The `noReply` wiring in `prompt.ts` and `plugin/src/index.ts` has been reverted.
   - CC-12: Keep (v2 SDK for session abort).

4. **Shared Contract**: SC-2 (VoiceMode) — no change. SC-5 (Abort Ownership) — no change.

5. **Security Invariants**:
   - VI-1: Update — voice-state transitions are reachable through: (a) `POST /voice/toggle` HTTP route, (b) `POST /voice/mute` HTTP route, (c) `autoStart` path (first assistant text delta), (d) barge-in path. Remove mention of `command.execute.before` hook and `voice.toggle`/`voice.mute` tools.
   - VI-3: Remove (was about `noReply` scope — no longer relevant).
   - Add: VI-4 — Route validates sessionID via `Session.get()` to prevent phantom-session memory leaks.

6. **Dependency Order**: SDD-01 no longer owns `noReply` wiring. It exports `toggle()`/`mute()` functions called by the HTTP route (new file `server/instance/voice.ts`).

### SDD-01 Plugin (`260808_voice-tts_sdd-v3-01-plugin.md`)

1. **"The `noReply` core change" section**: Replace entirely with "The HTTP route control surface" section describing:
   - New file `server/instance/voice.ts` with `POST /toggle` and `POST /mute`
   - Registered in `server/instance/index.ts` as `.route("/voice", VoiceRoutes())`
   - Route imports `toggle()`/`mute()` from `@/voice/plugin` (server module context)
   - Route validates sessionID via `Session.get()`
   - TUI calls via `sdk.fetch(new URL("/voice/toggle", sdk.url), { method: "POST", body: ... })`

2. **WHAT requirements**: 
   - Remove requirements 7 (noReply for /voice and /mute) — replaced by HTTP route
   - Remove requirements 5/6 (voice.toggle/voice.mute as plugin tools) — tools removed
   - Add: "WHEN the server receives `POST /voice/toggle` with `{ sessionID }`, the route handler SHALL validate the session exists, call `toggle(sessionID)`, and return `{ message, active }`"
   - Add: "WHEN the server receives `POST /voice/mute` with `{ sessionID }`, the route handler SHALL validate the session exists, call `mute(sessionID)`, and return `{ message, active: false }`"
   - Add: "WHEN the sessionID does not exist, the route SHALL return 404"

3. **HOW section**:
   - Remove `noReply` wiring in `prompt.ts`
   - Remove `command.execute.before` hook
   - Remove `voice.toggle`/`voice.mute` tool registrations
   - Add: HTTP route module at `server/instance/voice.ts`, registered in `server/instance/index.ts`
   - Add: TUI slash command `onSelect` calls `sdk.fetch` POST to `/voice/toggle` or `/voice/mute`

4. **VERIFY section**:
   - Remove V7 (noReply suppresses LLM)
   - Update V5/V6 to test via HTTP route instead of tool execution
   - Add: VR1-VR8 from the HTTP route test spec

5. **Reuse map**: 
   - Remove `command.execute.before` anchor
   - Remove `noReply` short-circuit anchor
   - Add: `server/instance/voice.ts` (new route module)
   - Add: `server/instance/index.ts` (route registration)
   - Add: `sdk.fetch` pattern from `dialog-workspace-create.tsx:78`

### SDD-02, SDD-03, SDD-04

No changes. The HTTP route only changes how the TUI triggers the toggle. TTS streaming, audio sink, and expressivity are unaffected.

## Implementation Steps

### Step 1: Write tests (RED)

Test file: `packages/opencode/test/voice/verify/voice-http-route.test.ts`

Tests from the test spec (`260809_voice-http-route-test-spec.md`):
- VR1: VoiceRoutes exports Hono app
- VR2: POST /toggle returns `{ message, active }`
- VR3: POST /toggle flips state (true → false)
- VR4: POST /mute returns `{ message: "Voice muted.", active: false }`
- VR5: POST /mute on inactive session still returns "Voice muted."
- VR6: Route registered at `/voice` in InstanceRoutes (not 404)
- VR7: Invalid body returns 400
- VR8: app.tsx no longer imports from `@/voice/plugin`

Additional tests from council feedback:
- VR9: Nonexistent sessionID returns 404 (Session.get validation)
- VR10: toggle() is synchronous (state set before response)

### Step 2: Create route module

New file: `packages/opencode/src/server/instance/voice.ts`

```typescript
export const VoiceRoutes = lazy(() =>
  new Hono()
    .post("/toggle",
      describeRoute({ operationId: "voice.toggle", ... }),
      validator("json", z.object({ sessionID: z.string() })),
      async (c) => {
        const { sessionID } = c.req.valid("json")
        await AppRuntime.runPromise(Session.get(sessionID))  // 404 if phantom
        const message = toggle(sessionID)
        const active = getMode(sessionID).active
        return c.json({ message, active })
      }
    )
    .post("/mute",
      describeRoute({ operationId: "voice.mute", ... }),
      validator("json", z.object({ sessionID: z.string() })),
      async (c) => {
        const { sessionID } = c.req.valid("json")
        await AppRuntime.runPromise(Session.get(sessionID))
        const message = mute(sessionID)
        return c.json({ message, active: false })
      }
    )
)
```

### Step 3: Register route

Modify: `packages/opencode/src/server/instance/index.ts`

```typescript
import { VoiceRoutes } from "./voice"
// in the chain:
.route("/voice", VoiceRoutes())
```

### Step 4: Update TUI

Modify: `packages/opencode/src/cli/cmd/tui/app.tsx`

1. Remove line 68: `import { toggle as voiceToggle, mute as voiceMute } from "@/voice/plugin"`
2. Replace `/voice` onSelect: `sdk.fetch(new URL("/voice/toggle", sdk.url), { method: "POST", ... })`
3. Replace `/mute` onSelect: `sdk.fetch(new URL("/voice/mute", sdk.url), { method: "POST", ... })`

### Step 5: Verify

- `bun run typecheck` — clean
- `bun test test/voice/ --timeout 30000` — all green
- `bun test test/plugin/trigger.test.ts --timeout 30000` — no regressions

### Step 6: Update specs

Update SDD-00 and SDD-01 per the spec update section above. Mark the `noReply` approach as superseded.

## Out of Scope

- SDK regeneration (`sdk.client.voice.toggle()`) — optional, `sdk.fetch` is sufficient
- Moving `toggle()`/`mute()` to separate module — premature
- Auth on voice routes — systemic concern, not voice-specific
- autoStart in the route — config-driven, handled by event hook
- Session creation for "no active session" — TUI rejects, correct behavior
