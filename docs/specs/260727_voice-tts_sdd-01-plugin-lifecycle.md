# SDD-01: Voice Plugin Lifecycle

**Date:** 2026-07-27
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending independent audit + human gate)
**Master:** `docs/specs/260727_voice-tts_sdd-00-master.md`
**Depends on:** nothing — SDD-01 is first in the SDD-00 dependency order. This spec **defines** Shared Contract SC-1 (VoiceConfig), SC-2 (VoiceMode), and SC-5 (Abort Ownership). SDD-02..SDD-05 reference these.

This feature spec covers the plugin's lifecycle: registration through opencode's plugin system, config parsing/validation from `tui.json` plugin options, per-session voice-mode state, the `/voice` and `/mute` toggle surfaces, `autoStart` activation, deactivation on connection failure, teardown, barge-in abort ownership, and TUI status indicators. It refines SDD-00 and inherits all cross-cutting requirements (CC-1..CC-11). Where this document conflicts with the master, the master wins; in particular SC-1, SC-2, and SC-5 are authored here but authoritative in the master.

## Background (why this is a reuse, not a build)

The plugin system, the SDK client, the Bus event tap, the session abort chain, and the audio-player detection already exist. SDD-01 composes them; it does not modify opencode core (CC-1) and does not build a parallel mechanism (CC-10):

- **Plugin registration** is the `Plugin` type at `packages/plugin/src/index.ts:75` — `export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>`. External plugins are loaded by `PluginLoader.loadExternal` (`packages/opencode/src/plugin/loader.ts:152`) from the `tui.json` `plugin` array, with per-plugin `PluginOptions` threaded as the second argument (`packages/opencode/src/plugin/index.ts:110`).
- **The SDK client** is constructed once per instance at `packages/opencode/src/plugin/index.ts:126-135` (`createOpencodeClient(...)`) and exposed as `PluginInput.client` (`packages/opencode/src/plugin/index.ts:137-152`). This is the surface for `client.session.abort`.
- **The Bus tap** that SDD-02 uses to read `message.part.delta` is delivered to plugins via `bus.subscribeAll().pipe(Stream.runForEach(... hook["event"]?.({ event })))` at `packages/opencode/src/plugin/index.ts:248-257`. SDD-01 does not touch this; it only owns the state that SDD-02 reads to decide whether to forward.
- **The session abort chain** is verified end-to-end: HTTP `POST /:sessionID/abort` (`packages/opencode/src/server/instance/session.ts:385-413`) → `SessionPrompt.cancel` (`packages/opencode/src/session/prompt.ts:117-120`) → `SessionRunState.cancel` (`packages/opencode/src/session/run-state.ts:77-85`) → `Runner.cancel`/`Fiber.interrupt` (`packages/opencode/src/effect/runner.ts:163-170`) → `AbortController.abort` in the LLM stream (`packages/opencode/src/session/llm.ts:394-397`). SDD-01 calls `client.session.abort`; it does NOT hold its own `AbortController` for the LLM stream (SC-5).
- **Slash commands for plugins do not exist** as a registration hook. The verified surfaces are the `tool` hook (`packages/plugin/src/index.ts:225-227`, exposing tools the LLM calls) and markdown command files in `~/.config/opencode/commands/` (the willvc7 pattern). SDD-01 uses both: a `voice.toggle`/`voice.mute` tool as the programmatic surface, and `/voice`/`/mute` markdown commands as the user-facing affordance that route through the LLM to the tool. The `command.execute.before` hook (`packages/plugin/src/index.ts:261-264`, fired at `packages/opencode/src/session/prompt.ts:1649-1653`) fires as part of the normal command path but cannot short-circuit the subsequent prompt; it is not the toggle mechanism.

No new opencode core surface is introduced.

---

## WHAT

Behavioral requirements. Literal `WHEN`/`SHALL` tokens are machine-checkable. Cross-cutting references in parentheses.

1. **WHEN** the opencode plugin loader loads the voice plugin from the `tui.json` `plugin` array, the plugin **SHALL** register via the `Plugin` type (`packages/plugin/src/index.ts:75`), returning a `Hooks` object (`packages/plugin/src/index.ts:222-333`) whose `event` hook subscribes to Bus events and whose `tool` hook exposes `voice.toggle` and `voice.mute`. The plugin **SHALL** receive its config source as the `PluginOptions` second argument (`packages/opencode/src/plugin/index.ts:110`). No opencode core source file **SHALL** be modified to install or operate the plugin. (CC-1, CC-9, SC-1)

2. **WHEN** the plugin loads, it **SHALL** parse its `PluginOptions` into a `VoiceConfig` (SC-1) applying the documented defaults for every unspecified key (`apiKeyEnv` → `"ELEVENLABS_API_KEY"`, `modelId` → `"eleven_v3"`, `stability` → `"natural"`, `speed` → `1.0`, `similarityBoost` → `0.75`, `speakerBoost` → `true`, `outputFormat` → `"mp3_44100_128"`, `tagEmissionTempBoost` → `false`, `tagEmissionTempDelta` → `0.1`, `autoStart` → `false`), **SHALL** validate that `voiceId` is present and non-empty, and **SHALL** ignore unknown keys. The validator SHALL reject `stability: "robust"` with an actionable error message: 'stability "robust" is not supported for TTS — use "creative" or "natural"'. (SDD-05 req 8) The ElevenLabs API key **SHALL** be read from `process.env[config.apiKeyEnv]` at activation time and **SHALL NOT** be stored in the config object or any config file. (CC-7, SC-1)

3. **WHEN** `voiceId` is missing or empty, the plugin **SHALL** register successfully (so its hooks are live and `/voice` can later report the problem), but **SHALL** keep `VoiceMode.active = false` for every session, **SHALL NOT** attempt an ElevenLabs connection, and **SHALL** emit a TUI warning indicating voice is disabled due to invalid config. The text session **SHALL** continue unimpaired. (CC-5, CC-7, SC-1, SC-2)

4. **WHEN** the plugin is loaded, it **SHALL** maintain one `VoiceMode` (SC-2) per FoxyBear session id, keyed by `sessionID`, held in process memory only. The state **SHALL NOT** persist across daemon restarts; on restart voice mode is off unless `autoStart` is configured (requirement 8). Concurrent sessions **SHALL** have independent `VoiceMode` instances. (SC-2)

5. **WHEN** the `voice.toggle` tool (registered via the plugin `tool` hook, `packages/plugin/src/index.ts:225-227`) is called for a session, its `execute` **SHALL** flip that session's `VoiceMode.active` — activating per requirement 8 on inactive, deactivating per requirement 9 on active — and **SHALL** return a confirmation string describing the new state. **WHEN** the `/voice` markdown command (installed at `~/.config/opencode/commands/voice.md`, per the willvc7 pattern) is invoked for a session, its prompt expansion **SHALL** result in the LLM calling `voice.toggle`. No new slash-command registration surface **SHALL** be added; the `tool` hook is the only programmatic toggle surface. (CC-1, CC-9, SC-2)

6. **WHEN** the `voice.mute` tool is called for a session whose `VoiceMode.active` is true, its `execute` **SHALL** set `active = false`, stop any in-flight audio for that session, and return a confirmation. **WHEN** called on an already-inactive session, it **SHALL** be a no-op that still confirms. **WHEN** the `/mute` markdown command (installed at `~/.config/opencode/commands/mute.md`) is invoked, its prompt expansion **SHALL** result in the LLM calling `voice.mute`. The deactivation side-effects (audio stop, TTS stop signal to SDD-03) **SHALL** be shared with requirement 9. (SC-2)

7. **WHEN** the plugin option `autoStart: true` is set and config is valid, the plugin **SHALL** mark `VoiceMode.active = true` for a session on the first `message.part.delta` Bus event for that session whose `partID` is in the text-parts set (i.e., the first assistant text delta), delivered via the `event` hook (`packages/opencode/src/plugin/index.ts:248-257`), without requiring an explicit `/voice`. The plugin **SHALL** correlate `partID → type` via `message.part.updated` events (SC-3 in the master) so it can distinguish text deltas from all other part types; non-text deltas (including reasoning, tool-call, and file-part deltas) **SHALL NOT** trigger activation. Sessions that never receive an assistant text delta **SHALL NOT** activate. (SC-2, SC-3)

8. **WHEN** `VoiceMode.active` transitions to true for a session, the plugin **SHALL** resolve the ElevenLabs API key from `process.env[config.apiKeyEnv]`; if the key is absent or empty the plugin **SHALL NOT** activate, **SHALL** set `active = false` and `connected = false`, and **SHALL** fall back to text-only mode with a TUI status indicator (CC-5). The ElevenLabs SDK stream, the audio sink, and the LLM stream tap are owned by SDD-02/SDD-03/SDD-04; this spec owns only the state transition and the abort handle (requirement 10). (CC-5, SC-2)

9. **WHEN** the ElevenLabs SDK reports a connection failure and the SDD-03 retry budget is exhausted, the plugin **SHALL** set `VoiceMode.active = false` and `VoiceMode.connected = false` for that session, stop any in-flight audio, signal SDD-03 to stop the TTS stream, and emit a TUI status indicator that voice is off. The user's text session **SHALL** continue unimpaired. The same deactivation side-effects **SHALL** fire on `/mute` (requirement 6) and on explicit `/voice` toggle-off. (CC-5, SC-2)

10. **WHEN** a new user turn is submitted for a session whose `VoiceMode.active` is true and Katya is speaking (`VoiceMode.playing` is true), the plugin **SHALL** call `client.session.abort({ sessionID })` via `PluginInput.client` (constructed at `packages/opencode/src/plugin/index.ts:126-135`), chaining through `SessionPrompt.cancel` (`packages/opencode/src/session/prompt.ts:117-120`) → `SessionRunState.cancel` (`packages/opencode/src/session/run-state.ts:77-85`) → `Runner.cancel`/`Fiber.interrupt` (`packages/opencode/src/effect/runner.ts:163-170`) → `AbortController.abort` in the LLM stream (`packages/opencode/src/session/llm.ts:394-397`). The plugin **SHALL NOT** construct or hold its own `AbortController` for the LLM stream. The audio-sink stop (owned by SDD-04) **SHALL** fire in parallel with the session abort; SDD-01 does not wait for audio teardown before returning from the abort call. (CC-6, SC-5)

11. **WHEN** the plugin receives `input.event.type === "server.instance.disposed"` (defined at `packages/opencode/src/bus/index.ts:14-19`, published at `:55-67` in a finalizer block) via its `event` hook, the plugin **SHALL** run teardown for all active sessions: stop any in-flight audio, signal SDD-03 to stop each ElevenLabs TTS stream, clear all per-session `VoiceMode` entries, and release the abort handle. The event is published in the Bus finalizer and the plugin's subscription fiber may be interrupted before the async handler completes, so the plugin **SHALL** do best-effort cleanup (stop audio, stop TTS streams, clear state) and **SHALL NOT** rely on the handler completing before process exit. No audio process and no TTS stream **SHALL** outlive the plugin. (SC-2, SC-5)

12. **WHEN** `VoiceMode` changes for any session, the plugin **SHALL** publish a TUI status reflecting: voice active/inactive, connection state (connected/disconnected), and playing/idle. The indicator **SHALL** update on activation, deactivation, first audio chunk received (`active + not playing → active + playing`), stream completion (`active + playing → active + not playing`), barge-in, and connection failure. (CC-5, SC-2)

13. **WHEN** the voice plugin is installed, the system **SHALL** operate entirely through opencode's plugin system — the `event` hook for Bus subscription, `PluginInput.client` for SDK calls, the `tool` hook for `voice.toggle`/`voice.mute`, and markdown command files in `~/.config/opencode/commands/` for `/voice`/`/mute`. No opencode core source file **SHALL** be modified. (CC-1, CC-9)

14. **WHEN** the plugin receives `input.event.type === "session.deleted"` (defined at `packages/opencode/src/session/index.ts:208-216` as a `SyncEvent`, published via `SyncEvent.run` at `:452`) via its `event` hook, the plugin **SHALL** clear that session's `VoiceMode` entry, stop its audio, and stop its TTS stream. No `VoiceMode` entry **SHALL** outlive its session. (SC-2)

---

## HOW

Implementation approach, FoxyBear best practices, explicit reuse map. No new mechanism where an existing one fits (CC-10).

### Reuse map

| Concern | Anchor | Reuse |
|---|---|---|
| Plugin entry signature | `packages/plugin/src/index.ts:75` | `export type Plugin = (input, options?) => Promise<Hooks>` — the plugin's exported `default`/`server` |
| Hooks shape (`event`, `tool`, `config`, `command.execute.before`) | `packages/plugin/src/index.ts:222-333` | the returned `Hooks` object; `tool` is `{ [key: string]: ToolDefinition }` (225-227) |
| Plugin `options` from `tui.json` | `packages/opencode/src/plugin/index.ts:110` | `hooks.push(await server(input, load.options))` — `load.options` is the per-plugin `PluginOptions` |
| `PluginInput.client` (SDK) | `packages/opencode/src/plugin/index.ts:126-135` | `createOpencodeClient(...)` — used for `client.session.abort` |
| `PluginInput` construction | `packages/opencode/src/plugin/index.ts:137-152` | confirms `client` is the full SDK client, not a subset |
| External plugin loader | `packages/opencode/src/plugin/loader.ts:152` | `PluginLoader.loadExternal` resolves, installs, and imports from `tui.json` |
| Bus event delivery to plugins | `packages/opencode/src/plugin/index.ts:248-257` | `bus.subscribeAll().pipe(Stream.runForEach(... hook["event"]?.({ event })))` — how SDD-02 gets `message.part.delta`; SDD-01 uses it for `autoStart` and status |
| Plugin trigger invocation | `packages/opencode/src/plugin/index.ts:263-276` | `Plugin.trigger(name, input, output)` — the generic hook fan-out |
| `command.execute.before` fired | `packages/opencode/src/session/prompt.ts:1649-1653` | the existing slash-command dispatch; fires before `prompt(...)` and cannot short-circuit it |
| Session abort HTTP endpoint | `packages/opencode/src/server/instance/session.ts:385-413` | `POST /:sessionID/abort` → `SessionPrompt.cancel` |
| `SessionPrompt.cancel` | `packages/opencode/src/session/prompt.ts:117-120` | `cancel` → `state.cancel(sessionID)` |
| `SessionRunState.cancel` | `packages/opencode/src/session/run-state.ts:77-85` | `state.cancel(sessionID)` → `Runner.cancel` |
| `Runner.cancel` → `Fiber.interrupt` | `packages/opencode/src/effect/runner.ts:163-170` | `Fiber.interrupt(st.run.fiber)` interrupts the in-flight run |
| `AbortController` in LLM stream | `packages/opencode/src/session/llm.ts:394-397` | `new AbortController()` acquired with `Effect.acquireRelease`, `ctrl.abort()` on scope close — the upstream provider cancel |
| Player detection (status reference; sink owned by SDD-04) | `packages/opencode/src/cli/cmd/tui/util/sound.ts:79-83` | `pick()` = `LIST.find((item) => which(item))` — SDD-04 reuses for the sink; SDD-01 references only to report player availability in status |

### Plugin module (`packages/opencode-voice/src/index.ts`)

The plugin is an npm package (or local path) listed in `tui.json` `plugin` array. Its `server` export matches `Plugin`:

- Receives `(input: PluginInput, options?: PluginOptions)`. Reads config from `options` (requirement 2). `input.client` is held for `client.session.abort` (requirement 10).
- Returns `Hooks` with: `event` (for `autoStart` first-delta detection, session/plugin teardown, and status transitions), `tool` (registering `voice.toggle` and `voice.mute`), and `config` (receives the config at initialization — once — for logging/awareness purposes; there is no config-reload mechanism, the `config` hook is called exactly once during initialization at `packages/opencode/src/plugin/index.ts:238-245`). No `command.execute.before` interception is used for toggling — the markdown command → tool path is the toggle mechanism (CC-10; do not add a short-circuit surface that does not exist).

### Config parsing (SC-1)

Parse `options` into `VoiceConfig` with the SC-1 defaults. Validation is a single check: `voiceId` non-empty. On failure the plugin registers but stays inactive (requirement 3) — it does not throw, because a thrown error in the plugin loader drops the plugin entirely (`packages/opencode/src/plugin/index.ts:218-224`), which would prevent `/voice` from reporting the problem. The API key is read from `process.env[config.apiKeyEnv]` at activation (requirement 8), not at load — so a missing key at load time is not a config error, only a deactivation trigger at activation.

### Voice mode state (SC-2)

A `Map<SessionID, VoiceMode>` held in plugin module scope. Defaults for a new session: `{ active: false, sessionId: null, playing: false, connected: false }`. `active` flips on `voice.toggle`/`voice.mute` tool calls and on `autoStart` first-delta. `connected` is set by SDD-03 callbacks (connection open / connection failed). `playing` is set by SDD-04 callbacks (first chunk / stream end / barge-in stop). SDD-01 owns the `active` and `sessionId` fields and the abort handle; `connected` and `playing` are written by SDD-03/SDD-04 but the state object lives here so the status indicator (requirement 12) can read all four fields from one place.

### `/voice` and `/mute` dispatch (the willvc7 pattern)

- `~/.config/opencode/commands/voice.md` and `mute.md` are prompt templates that expand to instructions telling the LLM to call `voice.toggle` / `voice.mute` for the current session. The expansion runs through the normal `command.execute.before` → `prompt(...)` path (`packages/opencode/src/session/prompt.ts:1649-1653`); the hook fires but does not short-circuit (no such contract exists).
- The `voice.toggle` and `voice.mute` tools (registered via the `tool` hook, `packages/plugin/src/index.ts:225-227`) receive `sessionID` in their execute context (as `tool.execute.before`/`tool.execute.after` do, `packages/plugin/src/index.ts:265-280`). Their `execute` mutates the per-session `VoiceMode` and returns a one-line confirmation.
- **Known tradeoff:** the markdown command path costs one LLM round-trip (the willvc7 `/speak` cost, confirmed in the research doc). This is accepted for v1 because the verified `command.execute.before` hook cannot skip the subsequent prompt. A future optimization (a cancel/skip signal on the hook) is out of scope (CC-10). The `voice.toggle`/`voice.mute` tools remain callable by the LLM directly with no command overhead — that is the primary programmatic surface.

### `autoStart`

In the `event` hook, on a `message.part.delta` event for a session whose `VoiceMode` is absent or `active === false` and whose config has `autoStart: true`, correlate the event's `partID → type` via the `message.part.updated` events already seen (SC-3 in the master). If the `partID` is NOT in the text-parts set, ignore the delta — non-text deltas must not trigger activation. On the first assistant text delta (a `message.part.delta` whose `partID` is in the text-parts set), set `active = true` and run the activation path (requirement 8). This defers activation until the session actually produces assistant text, so idle sessions, reasoning-only turns, and tool-call turns do not open TTS streams.

### Activation / deactivation boundary with SDD-03

SDD-01 owns the **state transition** and the **trigger**; SDD-03 owns the **SDK stream lifecycle**. The seam: when `active` goes true, SDD-01 signals SDD-03 to connect (SDD-03 sets `connected` via callback); when SDD-03's retry budget exhausts, SDD-03 calls back into SDD-01's deactivation handler which sets `active = false`, `connected = false`, stops audio (SDD-04), and updates status. The same handler runs on `/mute` and on `/voice` toggle-off. SDD-01 does not open sockets, does not manage retry, does not decode audio.

### Barge-in abort (SC-5)

The barge-in trigger is owned by SDD-01 — it detects `session.status` Bus events with `status.type === "busy"` (new user turn started) via its `event` hook. On detection, SDD-01 SHALL call: (a) `client.session.abort({ sessionID })`, (b) `tts.bargeIn()`, (c) `tap.abort(sessionID)`, (d) `sink.stop()`. These fire in parallel. SDD-04 does NOT own barge-in detection — it only owns the `stop()` mechanism that kills the player. The chain (`SessionPrompt.cancel` → `SessionRunState.cancel` → `Fiber.interrupt` → `AbortController.abort`) is verified end-to-end in the reuse map. SDD-01 does NOT hold an `AbortController` for the LLM stream (SC-5); the one in `packages/opencode/src/session/llm.ts:394-397` is acquired per-stream and aborted on scope close by the cancel chain.

### Teardown

Plugins are plain async functions (`Plugin = (input, options?) => Promise<Hooks>`) with no Effect scope access; there is no `Effect.addFinalizer`/`acquireRelease` available and no `dispose`/`unload` hook in `Hooks`. Instead SDD-01 uses event-based detection:

- **Plugin unload** — the plugin listens for `server.instance.disposed` events (defined at `packages/opencode/src/bus/index.ts:14-19`, published at `:55-67` in a finalizer block) via its `event` hook. When `input.event.type === "server.instance.disposed"` is received, the plugin iterates active sessions: signals SDD-04 to stop audio, signals SDD-03 to stop TTS streams, clears the `VoiceMode` map, releases the SDK abort handle reference. **Race:** the event is published in the Bus finalizer and the plugin's subscription fiber may be interrupted before the async handler completes — the plugin does best-effort cleanup (stop audio, stop TTS streams, clear state) and does not rely on the handler completing before process exit (requirement 11).
- **Session end** — the plugin listens for `session.deleted` events (defined at `packages/opencode/src/session/index.ts:208-216` as a `SyncEvent`, published via `SyncEvent.run` at `:452`) via its `event` hook. When `input.event.type === "session.deleted"` is received, the plugin clears that session's `VoiceMode` entry, stops its audio, and stops its TTS stream (requirement 14).

No bespoke lifecycle manager; teardown is entirely event-driven through the existing `event` hook.

### Status indicators

A single status publisher reads the per-session `VoiceMode` and emits a TUI status line. It fires on every transition enumerated in requirement 12. The publisher is plugin-internal; it does not require a new TUI hook (CC-10) — it reuses the existing status surface that other plugins (dcartertwo/opencode-talk, per research) already exercise.

### What is explicitly NOT built

- No opencode core source modification (CC-1). The `event` hook, `PluginInput.client`, and `tool` hook are the only surfaces.
- No new slash-command registration hook (none exists; the `tool` hook + markdown command files are the verified path).
- No `command.execute.before` short-circuit (the hook cannot skip the prompt; CC-10 forbids adding that mechanism).
- No ElevenLabs connection management (SDD-03 owns connection lifecycle and retry budget).
- No audio playback / player spawning (SDD-04 owns the sink; SDD-01 only references `sound.ts:79-83` for status reporting).
- No LLM stream tap / `message.part.delta` forwarding (SDD-02 owns the text stream; SDD-01 only reads the event for `autoStart` and status).
- No audio tag stripping or expressivity (SDD-05; SC-6).
- No `AbortController` for the LLM stream (SC-5; the existing one in `llm.ts:394-397` is aborted by the cancel chain).
- No persistent voice-mode state across restarts (SC-2: state is in-process).

---

## VERIFY

Acceptance criteria for independent agents, exercising the plugin against a **mocked opencode plugin harness** (a fake `PluginInput` whose `client.session.abort` records calls, whose `event` hook receives injected Bus events, and whose `tool` hook records tool registrations) backed by a real temporary opencode instance so plugin load and scope teardown are genuinely exercised. Because the ElevenLabs SDK stream, audio sink, and LLM stream tap are owned by SDD-03/SDD-04/SDD-02, those subsystems are mocked at the SDD-01 seam: SDD-03's connect/failure callbacks are simulated, SDD-04's audio-stop is a recorded spy, and `client.session.abort` is the real SDK method against a real (stubbed-prompt) session. Each item is mapped 1:1 to WHAT requirements. Every scenario states setup, action, expected observable.

- **V1 — plugin loads from `tui.json` and returns Hooks (req 1, CC-1).** Setup: a `tui.json` with the voice plugin in the `plugin` array pointing at a local build of `packages/opencode-voice`; a valid `voiceId` in options. Action: start opencode and let the plugin loader run. Expected: the loader calls the plugin's `server` export with `(input, options)`; the returned object has non-empty `event` and `tool` hooks; `tool` contains `voice.toggle` and `voice.mute`; no opencode core source file was modified (assert via a clean `git diff -- packages/opencode/src` excluding the new plugin package).

- **V2 — config parses with defaults and validates `voiceId` (req 2, SC-1).** Setup: options with only `{ "voiceId": "vX" }`. Action: load the plugin. Expected: the parsed `VoiceConfig` has `apiKeyEnv === "ELEVENLABS_API_KEY"`, `modelId === "eleven_v3"`, `stability === "natural"`, `speed === 1.0`, `similarityBoost === 0.75`, `speakerBoost === true`, `outputFormat === "mp3_44100_128"`, `voiceId === "vX"`, `tagEmissionTempBoost === false`, `tagEmissionTempDelta === 0.1`; unknown keys in options are ignored; `process.env.ELEVENLABS_API_KEY` is NOT read at load time (assert the env var is unset and load still succeeds).

- **V3 — missing `voiceId` registers but stays inactive (req 3, CC-5/SC-1).** Setup: options `{}` (no `voiceId`). Action: load the plugin and inject a `message.part.delta` for a session. Expected: the plugin registered (hooks are live); `VoiceMode.active` is false for every session; no SDD-03 connect signal was emitted; a TUI warning was published indicating voice is disabled due to invalid config; the text session continued (the delta was not dropped by the plugin).

- **V4 — per-session state, no cross-session bleed, in-process only (req 4, SC-2).** Setup: two sessions S1, S2; activate S1 via `voice.toggle`. Action: inspect S2's `VoiceMode`, then restart the plugin (drop and re-load). Expected: S2's `VoiceMode.active` is false (independent); after restart, S1's `VoiceMode` is gone and `active` is false (no persistence); a fresh activation is required after restart.

- **V5 — `voice.toggle` flips state and `/voice` routes to it (req 5, SC-2).** Setup: plugin loaded, session S inactive. Action A: call `voice.toggle`'s `execute` for S. Expected: `VoiceMode.active` is true; the tool returned a confirmation string. Action B: invoke the `/voice` markdown command for S (inject the command through the `command.execute.before` → `prompt` path with an LLM stub that calls `voice.toggle`). Expected: the command's prompt expansion resulted in exactly one `voice.toggle` call; no new slash-command registration surface was added (assert no new opencode API was used beyond the `tool` hook).

- **V6 — `voice.mute` and `/mute` deactivate, no-op when inactive (req 6, SC-2).** Setup: session S active and playing (SDD-04 spy installed). Action A: call `voice.mute` for S. Expected: `active === false`; SDD-04 audio-stop spy fired; confirmation returned. Action B: call `voice.mute` again. Expected: no-op, still returns a confirmation, audio-stop spy did not fire a second time. Action C: invoke `/mute` markdown command. Expected: routes to exactly one `voice.mute` call.

- **V7 — `autoStart` activates on first assistant text delta, not reasoning delta (req 7, SC-2/SC-3).** Setup: plugin loaded with `autoStart: true` and valid config; session S with no prior activity. Action A: inject a `message.part.updated` for a reasoning part, then a `message.part.delta` carrying that reasoning `partID` for S through the `event` hook. Expected: `VoiceMode.active` stays false for S (non-text deltas do not activate). Action B: inject a `message.part.updated` for an assistant text part (adding it to the text-parts set), then a `message.part.delta` carrying that assistant `partID` for S. Expected: `VoiceMode.active` flipped to true for S on the first assistant text delta; the activation path (requirement 8) ran once. Action C: a second session S2 that receives only reasoning deltas stays inactive (no TTS stream opened for S2).

- **V8 — activation resolves API key, falls back when absent (req 8, CC-5).** Setup: valid config, `process.env.ELEVENLABS_API_KEY` unset. Action: trigger activation for S (via `voice.toggle`). Expected: `active` did not stay true; `active === false`, `connected === false`; an SDD-03 connect signal was NOT emitted; a TUI status indicator shows voice off; the text session continues. Action B: set the env var and toggle again. Expected: `active === true` and SDD-03 connect signal emitted.

- **V9 — deactivation on connection failure after retry budget (req 9, CC-5).** Setup: S active, SDD-03 mock configured to report failure after its retry budget. Action: trigger a connection attempt (activation) and let SDD-03 fire its failure callback. Expected: `active === false`, `connected === false`; SDD-04 audio-stop spy fired; SDD-03 close signal sent; TUI status shows voice off; the text session is unimpaired (a subsequent user turn is accepted). The same side-effects fire when `/mute` is used instead (assert by invoking `/mute` on a fresh active session and comparing the spy/signal set).

- **V10 — barge-in calls `client.session.abort`, no own AbortController (req 10, SC-5/CC-6).** Setup: S active and `playing === true`; a real (stubbed-prompt) session exists so `client.session.abort` is the real SDK method; instrument `SessionPrompt.cancel` to record. Action: fire the barge-in trigger for S. Expected: `client.session.abort({ sessionID: S })` was called exactly once; `SessionPrompt.cancel` was invoked for S (cancel chain entered); the plugin did NOT construct or hold an `AbortController` for the LLM stream (assert no `new AbortController()` in the plugin source outside any audio-sink-owned code); SDD-04 audio-stop spy fired in parallel; the abort call returned without awaiting audio teardown.

- **V11 — teardown clears all state on `server.instance.disposed` (req 11, SC-2/SC-5).** Setup: two active sessions S1, S2 with audio playing and TTS streams "active" (SDD-03/SDD-04 mocks active). Action: inject a `server.instance.disposed` event through the `event` hook (simulating the Bus finalizer publish). Expected: SDD-04 audio-stop spy fired for both S1 and S2; SDD-03 close signal sent for both; the `VoiceMode` map is empty; no `VoiceMode` entry remains; the SDK abort handle reference is released. Best-effort: the handler does not assume the subscription fiber completes before process exit.

- **V12 — status indicator fires on every transition (req 12, CC-5/SC-2).** Setup: status publisher instrumented to record. Action: drive each transition in order — activate (req 8), first audio chunk (`not playing → playing`), stream completion (`playing → not playing`), barge-in, connection failure, `/mute`. Expected: the publisher emitted a status update on each of the six transitions; each update reflects `active`, `connected`, and `playing` correctly; no transition was missed and no spurious update fired between transitions.

- **V13 — no core fork (req 13, CC-1/CC-9).** Static: `git diff -- packages/opencode/src packages/plugin/src` (excluding the new `packages/opencode-voice` package) is empty. The plugin reaches opencode only through `PluginInput.client`, the `event` hook, the `tool` hook, and markdown command files in `~/.config/opencode/commands/`. Assert the plugin's import graph contains no deep imports into `packages/opencode/src/**` (only `@opencode-ai/plugin` and `@opencode-ai/sdk` public surfaces).

- **V14 — build/regression green (CC-8).** `bun typecheck` passes and `bun test` is fully green, including the new plugin lifecycle tests above and the untouched existing suites. A feature is not done with any red test.

- **V15 — `session.deleted` clears that session's state (req 14, SC-2).** Setup: two active sessions S1, S2; S1 has audio playing and an SDK stream "active". Action: inject a `session.deleted` event for S1 through the `event` hook. Expected: S1's `VoiceMode` entry is cleared; SDD-04 audio-stop spy fired for S1; SDD-03 close signal sent for S1; S2's `VoiceMode` is untouched (no cross-session bleed).
