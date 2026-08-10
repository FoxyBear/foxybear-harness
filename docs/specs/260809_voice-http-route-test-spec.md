# SDD: Voice HTTP Route — TUI → Server State Mutation

**Date:** 2026-08-09
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending test authoring)

## Problem

`/voice` and `/mute` TUI slash commands need to mutate server-side voice state without creating chat messages or invoking the LLM. The previous approach (TUI imports `toggle()` directly from `@/voice/plugin`) fails because TUI and server are separate runtime contexts — module-level `cfg` is `null` in the TUI.

## Solution

Add a dedicated Hono route module at `server/instance/voice.ts` that imports `toggle()`/`mute()` from `@/voice/plugin` in the server's module context. The TUI calls it via `sdk.fetch` (the existing RPC proxy). This follows the exact pattern every other TUI→server mutation uses (e.g., `dialog-workspace-create.tsx:78`, `HarnessCommands`).

## Architecture

```
TUI /voice slash command
  → sdk.fetch("POST /voice/toggle", { sessionID })
  → Hono route handler calls toggle(sessionID)
  → mutates modes Map (server module context — same instance event hook reads)
  → returns { message: "Voice on." }
  → TUI shows toast
  → next message.part.delta → event hook reads same modes Map → TTS active
```

## Files to Create

### `packages/opencode/src/server/instance/voice.ts`

Hono route module with two POST endpoints:

- `POST /toggle` — body `{ sessionID: string }`, calls `toggle(sessionID)` from `@/voice/plugin`, returns `{ message: string, active: boolean }`
- `POST /mute` — body `{ sessionID: string }`, calls `mute(sessionID)` from `@/voice/plugin`, returns `{ message: string, active: boolean }`

Use the existing patterns from `session.ts`:
- `lazy()` wrapper from `@/util/lazy`
- `describeRoute` / `validator` / `resolver` from `hono-openapi`
- `z` from `zod` for validation
- `errors(400)` from `../error`

## Files to Modify

### `packages/opencode/src/server/instance/index.ts`

Add import and register route:
```typescript
import { VoiceRoutes } from "./voice"
// in the chain:
.route("/voice", VoiceRoutes())
```

### `packages/opencode/src/cli/cmd/tui/app.tsx`

1. **Remove** line 68: `import { toggle as voiceToggle, mute as voiceMute } from "@/voice/plugin"`

2. **Replace** the `/voice` slash command `onSelect` (lines ~612-622):
```typescript
onSelect: async () => {
  const sid = route.data.type === "session" ? route.data.sessionID : ""
  if (!sid) {
    toast.show({ message: "No active session.", variant: "error" })
    dialog.clear()
    return
  }
  const res = await sdk.fetch(new URL("/voice/toggle", sdk.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID: sid }),
  })
  const data = await res.json() as { message: string; active: boolean }
  toast.show({ message: data.message, variant: "success" })
  dialog.clear()
},
```

3. **Replace** the `/mute` slash command `onSelect` (lines ~629-639) — same pattern but `POST /voice/mute`.

## Tests to Write

Test file: `packages/opencode/test/voice/verify/voice-http-route.test.ts`

### Test Requirements (VERIFY)

1. **VR1 — VoiceRoutes module exports a Hono app** — `import { VoiceRoutes } from "../../../src/server/instance/voice"`, call `VoiceRoutes()`, verify it's a Hono instance with `.fetch` method.

2. **VR2 — POST /toggle returns message and active=true** — construct a Request `POST /toggle` with body `{ sessionID: "test-sess" }`, call `VoiceRoutes().fetch(request)`, parse response JSON, verify `{ message: string, active: boolean }` shape. The message should be "Voice on." or "Voice unavailable — check API key and config." (depends on whether cfg is set — use `resetState()` then `parseConfig()` with valid config before calling).

3. **VR3 — POST /toggle flips state** — call `/toggle` twice for same sessionID, verify `active` is true then false (or vice versa). Requires setting up valid config first via `parseConfig()` with a test apiKeyEnv.

4. **VR4 — POST /mute returns message and active=false** — call `/mute` with an active session, verify `{ message: "Voice muted.", active: false }`.

5. **VR5 — POST /mute on inactive session is still "Voice muted."** — call `/mute` on a session that was never activated, verify message is "Voice muted." and active is false.

6. **VR6 — Route is registered at /voice in InstanceRoutes** — `import { InstanceRoutes } from "../../../src/server/instance/index"`, construct a `POST /voice/toggle` request, call `InstanceRoutes(mockWebSocket).fetch(request)`, verify it routes to the voice handler (not 404).

7. **VR7 — Invalid body returns 400** — `POST /toggle` with `{}` (missing sessionID), verify HTTP 400.

8. **VR8 — app.tsx no longer imports from @/voice/plugin** — read `app.tsx` source, verify the line `import { toggle as voiceToggle, mute as voiceMute } from "@/voice/plugin"` does NOT exist.

### Test Setup

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { VoiceRoutes } from "../../../src/server/instance/voice"
import { resetState, parseConfig, getMode, toggle, mute } from "../../../src/voice/plugin"

beforeEach(() => {
  resetState()
  // Set up valid config so activate() succeeds
  // parseConfig expects a raw object matching VoiceConfig shape
  // Use a test API key that resolveKey() will accept
})
```

Note: `parseConfig` is exported from `plugin.ts`. The `config` hook normally calls it, but tests can call it directly to set up `cfg`. However, `cfg` is a module-level variable — `parseConfig` returns a config but doesn't set `cfg`. You may need to call the plugin's `config` hook instead, or export a `setConfig()` helper for testing. Check the existing test patterns in `sdd-v3-01.test.ts` for how they set up `cfg`.

### Key Files for Reference

- `packages/opencode/src/server/instance/session.ts` — route pattern (lazy, describeRoute, validator, errors)
- `packages/opencode/src/server/instance/index.ts` — route registration pattern
- `packages/opencode/src/server/error.ts` — errors() helper
- `packages/opencode/src/util/lazy.ts` — lazy() helper
- `packages/opencode/src/voice/plugin.ts` — toggle(), mute(), resetState(), parseConfig(), getMode()
- `packages/opencode/test/voice/verify/sdd-v3-01.test.ts` — existing test patterns for plugin setup
- `packages/opencode/src/cli/cmd/tui/component/dialog-workspace-create.tsx:78` — sdk.fetch pattern
- `packages/opencode/src/cli/cmd/tui/app.tsx:607-640` — current voice slash command registration

## Important

- Tests should be RED against current code (no voice route exists yet)
- Use `bun:test` (describe/test/expect)
- Do NOT modify implementation files — only write the test file
- Mock or set up config state directly (call exported functions, not the HTTP config hook)
- The route handler runs in the same module context as the plugin — `toggle()` mutates the same `modes` Map the `event` hook reads
