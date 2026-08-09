# SDD-04: Audio Playback Sink

**Date:** 2026-07-27
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft (pending independent audit + human gate)
**Master:** `docs/specs/260727_voice-tts_sdd-00-master.md`
**Depends on:** SC-4 (Audio Chunk Stream, owned by this spec) and SC-5 (Abort Ownership, owned by SDD-01). This spec consumes `AudioChunk` (SC-4) and the barge-in signal (CC-6, routed via SC-5) and defines the streaming audio playback component that pipes MP3/PCM chunks from SDD-03 (ElevenLabs) to a system audio player via stdin.

This feature spec refines SDD-00 and inherits all cross-cutting requirements (CC-1..CC-11). Where this document conflicts with the master, the master wins; in particular the Shared Contract (SC-1..SC-6) is authoritative. This spec owns the `AudioChunk` type (SC-4) — it is the definition site — and owns no other shared contract.

## Background (why this is a reuse of patterns, not an extension of `sound.ts`)

opencode already ships a multi-platform audio *playback* module at `packages/opencode/src/cli/cmd/tui/util/sound.ts` (156 lines): it probes for `ffplay`/`mpv`/`afplay`/… via `which`, builds per-player CLI args, spawns the player, and kills it on stop. The research ([`docs/research/260727_foxybear_voice-stt-tts-architecture.md`](../../../docs/research/260727_foxybear_voice-stt-tts-architecture.md)) verified three things that decide the shape of this spec:

1. **`sound.ts` is TUI-internal and file-only.** It plays bundled `.wav` SFX assets (`pulse-a/b/c.wav`, `charge.wav`) by copying them to `tmpdir()` and spawning the player with the file path as a positional arg. Its `run()` uses `stdin: "ignore"` (`sound.ts:89`). There is no stdin-pipe, no streaming-bytes, no `AsyncIterable` surface.
2. **`sound.ts` is not exposed to plugins.** The plugin contract (`packages/opencode/src/plugin/index.ts`, `PluginInput` from `@opencode-ai/plugin`) does not re-export `sound.ts`, `@/util/which`, or `@/util/process`. The published `@opencode-ai/util` package exports only `array/binary/encode/error/fn/identifier/iife/lazy/module/path/retry/slug` — no `which`, no `Process`. A plugin cannot `import { Sound } from …` without forking core, which CC-1 forbids.
3. **The `which`-detection pattern at `sound.ts:79-83` and the stop pattern at `sound.ts:128-143` are gold and reusable as logic.** CC-9 names them explicitly. We copy the *patterns* (the candidate list, the memoized `pick()`, the `seq++`-invalidation + `Process.stop` kill), not the module.

Therefore the audio sink is **new plugin-owned code** that reimplements the `sound.ts` detection/args/stop logic for a stdin-pipe streaming shape, on top of the same underlying primitives `sound.ts` itself uses (`npm which`, `cross-spawn`/`child_process`). No `sound.ts` edit. No fork. The sink accepts the `AsyncIterable<AudioChunk>` (SC-4) that SDD-03 yields and plays it through a system player's stdin.

---

## WHAT

Behavioral requirements. Literal `WHEN`/`SHALL` tokens are machine-checkable. Cross-cutting references in parentheses.

1. **WHEN** the audio sink initializes and `VoiceConfig.playerPreference` (SC-1) is unset, the sink **SHALL** probe the system for a known audio player by testing each candidate in order — the list `["ffplay","mpv","mpg123","mpg321","mplayer","afplay","play","omxplayer","aplay","cmdmp3","cvlc","powershell.exe"]` (the list at `sound.ts:17-30`) — using a `which`-style binary lookup (the `which()` pattern at `packages/opencode/src/util/which.ts:5`, wrapping `npm which` with PATH augmentation), and **SHALL** select the first candidate found. The selected `kind` **SHALL** be memoized for the sink's lifetime so detection runs at most once per process. (CC-9, SC-1)

2. **WHEN** `VoiceConfig.playerPreference` (SC-1) is set to a non-empty string, the sink **SHALL** probe that single binary name via `which` and **SHALL NOT** run the auto-detect list; the preferred player becomes the memoized `kind`. **WHEN** the preferred binary is not on PATH, the sink **SHALL** fall back to the auto-detection list (requirement 1), emit a one-time config warning to the TUI status indicator, and continue. (CC-7, CC-9, SC-1)

3. **WHEN** the first `AudioChunk` (SC-4) of an utterance arrives and no player process is currently alive, the sink **SHALL** spawn the selected player via `cross-spawn` (the npm package that `Process.spawn` wraps at `packages/opencode/src/util/process.ts:2`, following the `Process.spawn` pattern at `:59`) with `stdin: "pipe"` — **not** `stdin: "ignore"` as in `sound.ts:89` — using a stdin-pipe variant of the per-player args builder at `sound.ts:34-44` with the file positional replaced by `"-"` so the player reads audio from stdin. The sink **SHALL NOT** write a temp file and **SHALL NOT** buffer the full audio before spawning. (CC-4, CC-9, CC-10, SC-4)

4. **WHEN** subsequent `AudioChunk`s arrive from SDD-03, the sink **SHALL** write each chunk's `data` (`Uint8Array`, SC-4) to the player process's stdin as it arrives, without waiting for the full utterance, so that first audio reaches the speaker within the CC-10 latency budget. Writes **SHALL** be backpressure-aware: the sink awaits stdin write completion (or an `Error`/`EPIPE`) before pulling the next chunk and **SHALL NOT** enqueue an unbounded buffer. (CC-4, CC-10, SC-4)

5. **WHEN** an `AudioChunk` with `isFinal: true` (SC-4) arrives, the sink **SHALL** close the player's stdin (end the writable stream) so the player drains and exits naturally, **SHALL** await the player's `exited` promise (`Process.Child = ChildProcess & { exited: Promise<number> }`, `process.ts:57`), and then mark the sink idle and ready for the next utterance. (SC-4)

6. **WHEN** barge-in is triggered (CC-6 — a new user turn submitted while Katya is speaking), or the sink's `stop()` method (SC-4) is called by SDD-03 for retry, the sink **SHALL** immediately kill the player process via `proc.kill()` (SIGTERM, mirroring the `Process.stop` pattern at `packages/opencode/src/util/process.ts:149-153`) following the invalidation pattern at `sound.ts:128-143` (increment a `seq` counter to invalidate in-flight ops, kill the child via `proc.kill()`, clear any pending tail timer), close stdin if open, and **SHALL** discard any `AudioChunk`s already queued from SDD-03. The sink **SHALL** become idle and **SHALL** spawn a fresh player on the next chunk. The sink **SHALL** expose a `stop()` method (SC-4) callable by SDD-03 for retry scenarios, distinct from `isFinal: true` (turn-completion). This stop fires in parallel with the LLM-stream abort owned by SC-5; the sink does not own or call `client.session.abort`. The `stop()` method **SHALL** be idempotent — calling it on an already-stopped sink is a no-op, never an error; if no player process is running, `stop()` **SHALL** return immediately without throwing. (CC-6, SC-4, SC-5, GC1a)

7. **WHEN** a volume level is supplied to the sink (default `1.0`), the sink **SHALL** apply it at spawn time by passing it through the same per-player volume-flag conventions used in the `args(kind, file, volume)` builder at `sound.ts:34-44` (`ffplay -af volume=N`, `mpv --volume <pct>`, `mpg123 -g <pct>`, `play -v N`, `cvlc --gain=N`, etc.). The sink **SHALL NOT** be required to change volume mid-stream; a volume change takes effect on the next utterance's spawn. SC-1 does not define a `volume` config field; the sink exposes a runtime `setVolume` seam owned by SDD-01 (e.g. a `/volume` command) and defaults to `1.0` until set. (CC-7, CC-9)

8. **WHEN** no audio player binary is detected — neither `playerPreference` resolves (per requirement 2's fallback) nor any candidate in the list at `sound.ts:17-30` is on PATH — the sink **SHALL NOT** attempt to spawn a process, **SHALL** discard incoming `AudioChunk`s silently, and **SHALL** surface a one-time "voice off — no audio player found" warning to the TUI status indicator. The session **SHALL NOT** crash, throw, or block; this is the graceful-degradation seam for the audio path (the audio analogue of CC-5's ElevenLabs-unreachable fallback). (CC-1, CC-5)

9. **WHEN** the player process exits non-zero, or a stdin write rejects with `EPIPE`/`Error` (player crashed mid-stream), the sink **SHALL** log the error, close stdin if still open, mark itself idle, and **SHALL NOT** crash the session or propagate the error to SDD-03's upstream. Subsequent `AudioChunk`s for a new utterance **SHALL** spawn a fresh player. The memoized `kind` (requirement 1) **SHALL** be reused unless the crash indicates the binary is no longer executable, in which case the sink **SHALL** perform exactly one re-detection pass before giving up per requirement 8. (CC-5, CC-8)

10. **WHEN** the TTS plugin tears down (voice mode off via `/mute` or daemon shutdown), the sink **SHALL** kill any running player process via `proc.kill()` (SIGTERM, mirroring the `Process.stop` pattern at `process.ts:149-153`), close stdin, and release the process handle. Teardown **SHALL** be idempotent — safe to call when no player is running — and **SHALL NOT** throw if the process is already dead. `proc.kill()` on an already-dead PID **SHALL** be caught and treated as success (ESRCH is not an error in this context). Player-process exit during stop/teardown **SHALL** be treated as non-fatal. (SC-2, CC-1, GC1c)

11. **WHEN** the audio format for a stream is MP3 (`outputFormat` starting `mp3_`, default `mp3_44100_128` per SC-1, or the first chunk's `format` field per SC-4 indicating an MP3 MIME), the sink **SHALL** spawn the player with MP3-sniffing args — `ffplay`/`mpv` auto-detect MP3 from stdin with no format flag, so the stdin-variant args from requirement 3 are used as-is. **WHEN** the format is raw PCM (`outputFormat` starting `pcm_`, or the first chunk's `format` indicating PCM), the sink **SHALL** add PCM format flags to the player args (`ffplay -f pcm_s16le -ar <rate> -ac <channels>`, derived from the `outputFormat`/`format` string; `mpv --demuxer=rawaudio --audio-format=s16le --audio-samplerate=<rate>`). The format is read once from the first chunk's `format` field (SC-4) and the args are fixed for that stream's lifetime. (CC-9, SC-1, SC-4)

12. **WHEN** the audio sink is implemented, it **SHALL** live entirely inside the TTS plugin package and **SHALL NOT** modify `packages/opencode/src/cli/cmd/tui/util/sound.ts`, `packages/opencode/src/util/which.ts`, or `packages/opencode/src/util/process.ts`. It reuses their patterns — the detection list at `sound.ts:17-30`, the `pick()` memoization at `sound.ts:79-83`, the `args()` builder at `sound.ts:34-44`, the `seq++` + `Process.stop` stop pattern at `sound.ts:128-143` — by reimplementing the same logic in plugin-owned code on top of `npm which` and `cross-spawn`/`child_process` (the same primitives `which.ts:1` and `process.ts:2` wrap). (CC-1, CC-9)

13. **WHEN** audio chunks arrive after `stop()` has been called (e.g., late in-flight HTTP response chunks from SDD-03), the sink **SHALL** silently suppress the write — EPIPE or ERR_STREAM_DESTROYED on post-stop stdin writes **SHALL** be caught and discarded, never crashing the plugin or surfacing an unhandled rejection. The `for await` loop consuming the audio iterable **SHALL** break on `stop()` and discard any remaining queued chunks. (CC-6, SC-4, GC1b)

---

## HOW

Implementation approach, FoxyBear best practices, explicit reuse map. No new mechanism where an existing one fits (CC-9, CC-10).

### New file (plugin-owned): the audio sink module

The sink lives in the TTS plugin package (e.g. `packages/opencode-voice/src/sink.ts`, per the research pseudocode's `SoundStream`). It is a self-contained module with zero imports from `packages/opencode/src/` — the plugin contract does not re-export `sound.ts`, `@/util/which`, or `@/util/process` (verified: `@opencode-ai/util` exports only `array/binary/encode/error/fn/identifier/iife/lazy/module/path/retry/slug`). The sink depends on `npm which` (the same package `which.ts:1` wraps) and `cross-spawn` (the same package `process.ts:2` wraps) directly.

### Reuse map — patterns copied, modules not extended

| Pattern | Source anchor | Reuse shape |
|---|---|---|
| Player candidate list | `sound.ts:17-30` | Copy the `LIST` const verbatim into the sink module. |
| Binary detection (`which`) | `sound.ts:79-83` (`pick()`), `which.ts:5` | Reimplement `pick()`: memoize `kind` in a module-level variable; `LIST.find(item => which(item))`. The `which` helper reimplements the thin wrapper at `which.ts:5-13` over `npm which` — same `nothrow: true` + augmented-PATH shape. PATH augmentation uses the plugin's own bin dir (the opencode `Global.Path.bin` augmentation at `which.ts:7` is internal and not exposed; the sink augments with `process.env.PATH` plus any plugin-supplied bin). |
| Per-player args builder | `sound.ts:34-44` (`args()`) | Copy `args(kind, file, volume)` and add a stdin variant `argsStdin(kind, volume, format)`: replace the `file` positional with `"-"`, and for PCM prepend format flags (requirement 11). MP3 needs no format flag. |
| Spawn with stdin pipe | `sound.ts:85-93` (`run()`), `process.ts:59` (`spawn`), `process.ts:7` (`Stdio`) | Spawn via `cross-spawn` (same package as `process.ts:2`) with `stdio: ["pipe","ignore","ignore"]` — i.e. `stdin: "pipe"` (requirement 3), NOT `"ignore"` as at `sound.ts:89`. Wrap the child as `{ proc, exited }` mirroring `Process.Child` at `process.ts:57`. |
| Stop / barge-in | `sound.ts:128-143` (`stop()`), `sound.ts:135` (`Process.stop`), `process.ts:149` (`stop`) | Reimplement the `seq++` invalidation + kill pattern: increment a seq counter, `clearTimeout` any tail timer, kill the child via SIGTERM (`proc.kill()` — the same signal `Process.stop` uses at `process.ts:153`), close stdin. The SIGTERM→SIGKILL escalation at `process.ts:79-83` lives in `Process.spawn`'s abort handler, NOT in `Process.stop`; the sink MAY implement its own escalation (SIGTERM → 5s timeout → SIGKILL) as a new feature, but SHALL NOT imply it's reusing `Process.stop`'s behavior (which is SIGTERM-only). |
| `Process.Child.exited` | `process.ts:57`, `process.ts:86-101` | Build the `exited: Promise<number>` from `proc.once("exit"|"error")` exactly as `process.ts:86-101` does. |

### Player detection (requirements 1, 2)

- `pick()`: module-level `let kind: string | null | undefined`. On first call, if `cfg.playerPreference` (SC-1) is set, `which(cfg.playerPreference)`; if found, `kind = cfg.playerPreference`; if not found, emit a one-time warning and fall through to the auto-detect list. Auto-detect: `kind = LIST.find(item => which(item)) ?? null`. Memoize (`if (kind !== undefined) return kind`), matching `sound.ts:79-83`.
- `which(cmd)`: thin wrapper over `npm which` with `{ nothrow: true }` and PATH augmented with the plugin's bin dir, mirroring `which.ts:5-13`. No `Global.Path.bin` (internal).

### Spawn + streaming (requirements 3, 4, 5, 11)

- On the first chunk of an utterance: `pick()`; if `null`, enter the "player not found" path (requirement 8) — discard chunks, emit one warning, return. Otherwise build args via `argsStdin(kind, volume, format)` and spawn with `stdio: ["pipe","ignore","ignore"]`. Keep the `child` in a module-level `let proc`.
- `argsStdin(kind, volume, format)`: the stdin variant of `sound.ts:34-44`. For each `kind`, take the existing `args()` entry, drop the trailing `file` positional, append `"-"`. For PCM (`format` indicates raw PCM), prepend the format flags before `"-"` (requirement 11). For MP3, no format flag. Examples:
  - `ffplay` MP3: `["ffplay","-autoexit","-nodisp","-af",`volume=${volume}`,"-"]`
  - `ffplay` PCM: `["ffplay","-autoexit","-nodisp","-f","pcm_s16le","-ar","44100","-ac","2","-"]`
  - `mpv` MP3: `["mpv","--no-video","--audio-display=no","--volume",String(round(volume*100)),"-"]`
- Stream loop: `for await (const chunk of input)` (the `AsyncIterable<AudioChunk>` from SDD-03, SC-4). For each chunk, if no `proc` is alive, spawn (requirement 3). `await` write `chunk.data` to `proc.stdin` (backpressure — requirement 4). On `chunk.isFinal`, `proc.stdin.end()`, `await proc.exited`, clear `proc` (requirement 5).
- Barge-in check: at the top of each iteration and before each write, compare a captured `seq` against the live `seq`; if mismatched, break (requirement 6 invalidated this stream).

### Barge-in and retry-stop (requirement 6, CC-6, SC-4, SC-5)

- `stop()`: `seq++`; `clearTimeout(tail)`; if `proc`, `close(proc.stdin)` (best-effort) and send SIGTERM via `proc.kill()` (mirroring the `Process.stop` pattern at `process.ts:149-153`); set `proc = undefined`. Any in-flight `for await` loop observes `seq` changed and breaks, discarding queued chunks. The sink MAY add a SIGKILL fallback (SIGTERM → 5s timeout → SIGKILL) as new code, but this is NOT a reuse of `Process.stop`'s behavior (which is SIGTERM-only); the escalation at `process.ts:79-83` lives in `Process.spawn`'s abort handler. The `stop()` method is the sink's public retry-stop interface (SC-4), callable by SDD-03 before starting a retried audio stream. It is also the barge-in mechanism. This fires in parallel with the LLM abort owned by SC-5 (`client.session.abort`); the sink does not call it.

Barge-in safety gate (GC1a/b/c): `stop()` guards on `if (!proc) return` after `seq++`/`clearTimeout`, so a call on an already-stopped sink is a no-op (GC1a). The `for await` loop captures `seq` and breaks on mismatch; any write to a destroyed stdin is wrapped so `EPIPE`/`ERR_STREAM_DESTROYED` is caught and discarded — never thrown, never an unhandled rejection (GC1b). `proc.kill()` is wrapped in try/catch; `ESRCH` (and the player's `exit` arriving during stop) is treated as success, not an error (GC1c).

### Volume (requirement 7)

- Module-level `let volume = 1.0`. `setVolume(v)` mutates it (clamped 0..1). Applied at spawn time via `argsStdin(kind, volume, format)` — same per-player conventions as `sound.ts:34-44`. No mid-stream change. Default 1.0 because SC-1 defines no `volume` field; SDD-01 owns any `/volume` command that calls `setVolume`.

### Player not found + crash recovery (requirements 8, 9)

- "Player not found": `pick()` returns `null` → set a `noPlayer` flag → the stream loop drains and discards chunks; emit one TUI warning. Re-detection is NOT retried per chunk (memoized); a manual retry happens only on teardown/re-init.
- Crash: `proc.exited` resolves non-zero, or `proc.stdin.write` rejects (`EPIPE`) → log, `proc.stdin.destroy()`, `proc = undefined`, mark idle. Reuse memoized `kind`; if the crash is an `ENOENT`/spawn failure, perform one re-`pick()` pass; if still null, enter "player not found" (requirement 8).

### Teardown (requirement 10)

- `dispose()`: call `stop()` (idempotent — `if (!proc) return` after `seq++`/`clearTimeout`). Safe to call repeatedly. `proc.kill()` is wrapped to swallow `ESRCH` — an already-dead PID is success, not an error (GC1c). Registered as the plugin's teardown hook by SDD-01.

### What is explicitly NOT built

- **No `sound.ts` extension.** `sound.ts` stays TUI-internal, file-only, untouched (research-verified; CC-1/CC-9). The sink is a new plugin module.
- **No `which.ts` / `process.ts` import or edit.** These are `packages/opencode/src/util/` internals not exposed to plugins (verified via `@opencode-ai/util` exports). The sink reimplements the thin wrappers over `npm which` and `cross-spawn`.
- **No LLM-stream abort.** SC-5 owns `client.session.abort`; the sink's `stop()` only kills the player + closes stdin, in parallel with the abort (CC-6).
- **No `AudioChunk` producer.** SC-4 defines the type here, but SDD-03 (ElevenLabs) produces the chunks; SDD-02 produces the text. The sink only consumes.
- **No temp-file path.** The file-based `run()` at `sound.ts:85-93` and the `tmpdir()` asset-copy at `sound.ts:65-72` are deliberately not reused — stdin pipe replaces them (requirement 3).
- **No mid-stream volume change, no queuing of multiple utterances.** One stream → one player process → one stdin; a new utterance after the previous `isFinal` (or after barge-in) spawns fresh.

---

## VERIFY

Acceptance criteria for independent agents, exercising the sink against a **mocked player harness** (a fake `ffplay`/`mpv` shell script placed on `PATH` that reads stdin, optionally writes a marker file or delays exit, and can be told to crash with a non-zero code or `EPIPE`), driven by a synthetic `AsyncIterable<AudioChunk>` (SC-4) so the ElevenLabs SDK stream (SDD-03) is not exercised. Each item is mapped 1:1 to WHAT requirements. Every scenario states setup, action, expected observable.

- **V1 — auto-detection memoizes the first found player (req 1, CC-9, SC-1).** Setup: `playerPreference` unset; place fake `ffplay` and fake `mpv` on `PATH` (both record a marker); `which` resolves `ffplay` first per the list order at `sound.ts:17-30`. Action: feed a one-chunk MP3 stream and let it complete. Expected: exactly one `which`-probe sequence runs; the spawned binary is `ffplay`; feeding a second stream does NOT re-run detection (no second probe burst — assert via a `which` spy counter).

- **V2 — `playerPreference` overrides auto-detect, falls back on miss (req 2, CC-7).** Setup A: `playerPreference: "mpv"`; both `ffplay` and `mpv` on `PATH`. Action: feed a stream. Expected: only `mpv` is probed (not `ffplay`); `mpv` is spawned. Setup B: `playerPreference: "nopeplayer"` (not on PATH); `ffplay` on PATH. Action: feed a stream. Expected: a one-time config warning is emitted; auto-detect runs; `ffplay` is spawned. The warning fires exactly once across subsequent streams.

- **V3 — spawn uses stdin pipe, no temp file (req 3, CC-9/CC-10).** Setup: fake `ffplay` script that copies stdin to a captured buffer and exits 0 on `stdin` end; filesystem spy on `tmpdir()` writes. Action: feed a 3-chunk MP3 stream with `isFinal` on chunk 3. Expected: the player receives the concatenation of all 3 chunks via stdin (assert the buffer equals the chunks joined); `stdio` for the child is `["pipe","ignore","ignore"]` (assert via the spawn args); zero files are written to `tmpdir()` (no `sound.ts:65-72` file path).

- **V4 — streaming + backpressure, first-audio budget (req 4, CC-4/CC-10).** Setup: fake `ffplay` that drains stdin slowly (reads 1 byte per tick); a chunk producer that yields 3 chunks on separate microtasks. Action: feed the stream and measure the time from first chunk produced to first byte received by the player. Expected: the first byte is written to the player's stdin before the second chunk is pulled (no full-buffer wait); the sink awaits each stdin write before pulling the next chunk (assert the producer's `next()` is not called until the prior write resolves — backpressure); the first-audio time is sub-second (CC-10 budget measured, not just asserted).

- **V5 — `isFinal` closes stdin and awaits exit (req 5, SC-4).** Setup: fake `ffplay` that waits 50ms after `stdin` end before exiting 0. Action: feed a stream whose last chunk has `isFinal: true`; await the sink's completion. Expected: `proc.stdin.end()` is called exactly once on the final chunk; the sink's play promise resolves only after `proc.exited` resolves (assert ordering: `exited` resolves before the sink reports idle); `proc` is cleared.

- **V6 — barge-in kills the player and discards queued chunks (req 6, CC-6, SC-5).** Setup: fake `ffplay` that blocks (never exits); a chunk producer that yields chunk A, then waits, then yields chunk B. Action: start the stream; after chunk A is written, trigger `stop()` (barge-in) and then have the producer try to yield chunk B. Expected: SIGTERM is sent to the child via `proc.kill()` (assert via the fake receiving a signal); `proc.stdin` is closed; chunk B is discarded (the sink's loop breaks on `seq` mismatch — assert the sink does not write B to any player); the sink is idle and a subsequent stream spawns a fresh player. Assert the sink did NOT call `client.session.abort` (that is SC-5's owner).

- **V7 — volume applied at spawn via per-player flags (req 7, CC-7/CC-9).** Setup: fake `ffplay` and fake `mpv` that record their argv. Action A: `setVolume(0.5)`, feed a stream with `ffplay` selected. Expected: argv contains `-af volume=0.5` (the `sound.ts:35` convention). Action B: `setVolume(0.5)`, feed with `mpv` selected. Expected: argv contains `--volume 50` (the `sound.ts:37` convention). Action C: change `setVolume(0.8)` mid-stream (after spawn, before `isFinal`). Expected: the running player's args are unchanged; the NEXT utterance's spawn uses `0.8`.

- **V8 — player-not-found degrades gracefully (req 8, CC-1/CC-5).** Setup: no player binaries on `PATH` (`which` returns null for every candidate); `playerPreference` unset. Action: feed a 3-chunk stream. Expected: no process is spawned; zero chunks are written (assert no stdin writes since no child); exactly one "no audio player found" warning is emitted to the status indicator (assert dedup — a second stream does not re-warn); the session does not throw and the producer is fully drained without error.

- **V9 — player crash mid-stream recovers without crashing the session (req 9, CC-5/CC-8).** Setup A: fake `ffplay` that exits non-zero after receiving chunk A. Action: feed chunk A, then B, then C(`isFinal`). Expected: the error is logged; stdin is closed; the sink reports idle; the session does not throw. Setup B: continue with a fresh stream. Expected: a new player is spawned (reusing the memoized `kind` — no re-detection); chunks play normally. Setup C: fake `ffplay` whose `which` path becomes invalid after first spawn (simulated `ENOENT` on respawn). Action: feed a stream after the crash. Expected: exactly one re-detection pass runs; if it finds a player, playback resumes; if not, the sink enters the requirement-8 path.

- **V10 — teardown is idempotent and kills the running player (req 10, SC-2/CC-1).** Setup: fake `ffplay` blocking; feed a stream so `proc` is alive. Action: call `dispose()` three times. Expected: the player is killed exactly once (assert SIGTERM signal sent once via `proc.kill()` — the first call); the second and third calls are no-ops (no throw, no second signal); `proc` is undefined after the first call; stdin is closed.

- **V11 — MP3 default vs PCM format flags (req 11, CC-9, SC-1/SC-4).** Setup: fake `ffplay` recording argv. Action A: feed a stream whose first chunk has `format` indicating MP3 (`mp3_44100_128`). Expected: argv is `["ffplay","-autoexit","-nodisp","-af",`volume=1`,"-"]` — no `-f` format flag. Action B: feed a stream whose first chunk has `format` indicating raw PCM (`pcm_44100`, s16le, 2ch). Expected: argv contains `-f pcm_s16le -ar 44100 -ac 2` before the `-` stdin marker. Action C: feed a stream where chunk 1 says PCM but chunk 2 says MP3. Expected: the args are fixed at spawn from chunk 1 (PCM flags remain); no mid-stream reconfiguration.

- **V12 — no core files modified, patterns reimplemented (req 12, CC-1/CC-9).** Static: `git diff --name-only` against `packages/opencode/src/cli/cmd/tui/util/sound.ts`, `packages/opencode/src/util/which.ts`, and `packages/opencode/src/util/process.ts` is empty (these files are untouched). The sink module imports neither `sound.ts` nor `@/util/which` nor `@/util/process` (assert via `grep` on the sink's import statements — only `npm which`, `cross-spawn`, `child_process`, and plugin-local imports). The candidate list in the sink equals `sound.ts:17-30` verbatim (assert array equality).

- **V13 — `stop()` idempotency (req 6, GC1a, SC-4).** Setup A: a sink at rest with no `proc`. Action: call `stop()` twice. Expected: neither call throws; no `proc.kill()` is attempted (no PID to signal — assert via the spawn/signal spy that no signal is sent). Setup B: a sink with a blocking fake `ffplay` alive (`proc` set). Action: call `stop()`, then call `stop()` again. Expected: neither call throws; `proc.kill()` (SIGTERM) is sent exactly once (assert via the fake's signal log); the second call is a no-op (no second signal).

- **V14 — post-stop write suppression, no crash on late chunks (req 13, GC1b, CC-6/SC-4).** Setup: fake `ffplay` that drains stdin; a chunk producer that yields chunk A, waits, then yields chunk B. Action: start the stream; after chunk A is written, call `stop()`; then have the producer yield chunk B and attempt one explicit extra write to the (now destroyed) stdin. Expected: no crash and no unhandled rejection (assert an `unhandledRejection` spy stays clean); chunk B is silently discarded — never written to any player stdin (the `for await` loop broke on `stop()`); the late write's `EPIPE`/`ERR_STREAM_DESTROYED` is caught, not thrown.

- **V15 — dead-PID tolerance on stop/teardown (req 10, GC1c, SC-2/CC-1).** Setup: fake `ffplay` blocking; feed a stream so `proc` is alive. Action A: kill the player process externally (e.g. `process.kill(proc.pid, 'SIGKILL')`), then call `stop()`. Expected: `proc.kill()` throws `ESRCH` on the dead PID and the sink catches it — `stop()` returns normally (no throw); the player exit is treated as non-fatal. Action B: with the process already dead, call `stop()` again. Expected: no throw (ESRCH caught again); no second signal sent.

- **V16 — build/regression green (CC-8).** `bun run typecheck` passes and `bun test` is fully green, including the new sink tests above and the untouched `sound`/`util` suites. A feature is not done with any red test.
