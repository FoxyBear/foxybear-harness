# SDD-03 v3: Audio Playback Sink

**Date:** 2026-08-08
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft v3 (pending independent audit + human gate)
**Master:** `docs/specs/260808_voice-tts_sdd-v3-00-master.md`
**Depends on:** SC-4 (Audio Chunk Stream, owned by this spec) and SC-5 (Abort Ownership, owned by SDD-01).

This feature spec covers the streaming audio playback component that pipes MP3/PCM chunks from SDD-02 (ElevenLabs) to a system audio player via stdin pipe. It inherits all cross-cutting requirements (CC-1..CC-12). This spec is the v1 SDD-04 with no architectural changes.

## Background

opencode ships a multi-platform audio playback module at `packages/opencode/src/cli/cmd/tui/util/sound.ts` (156 lines) that probes for `ffplay`/`mpv`/`afplay`/etc. via `which`, builds per-player CLI args, spawns the player, and kills it on stop. However, `sound.ts` is TUI-internal and file-only (uses `stdin: "ignore"`, `sound.ts:89`). The audio sink is **new plugin-owned code** that reimplements the `sound.ts` detection/args/stop logic for a stdin-pipe streaming shape, on top of the same primitives (`npm which`, `cross-spawn`/`child_process`).

**Key difference from v2:** v2 reverted to temp-file playback (write entire audio to disk, then play). v3 restores the v1 stdin-pipe approach: spawn with `stdin: "pipe"`, write chunks as they arrive, close stdin on completion. This is critical for low latency.

---

## WHAT

1. **WHEN** the audio sink initializes and `VoiceConfig.playerPreference` (SC-1) is unset, the sink **SHALL** probe the system for a known audio player by testing each candidate in order — `["ffplay","mpv","mpg123","mpg321","mplayer","afplay","play","omxplayer","aplay","cmdmp3","cvlc","powershell.exe"]` (the list at `sound.ts:17-30`) — using a `which`-style binary lookup, and **SHALL** select the first found. The selected player **SHALL** be memoized for the sink's lifetime. (CC-9, SC-1)

2. **WHEN** `playerPreference` is set, the sink **SHALL** probe that single binary. **WHEN** not on PATH, the sink **SHALL** fall back to auto-detection. (CC-7, CC-9, SC-1)

3. **WHEN** the first `AudioChunk` arrives and no player process is alive, the sink **SHALL** spawn the selected player with `stdin: "pipe"` — NOT `stdin: "ignore"` — using a stdin-pipe variant of the per-player args builder at `sound.ts:34-44` with the file positional replaced by `"-"`. The sink **SHALL NOT** write a temp file and **SHALL NOT** buffer the full audio before spawning. (CC-4, CC-9, CC-10, SC-4)

4. **WHEN** subsequent `AudioChunk`s arrive, the sink **SHALL** write each chunk's `data` to the player's stdin as it arrives. Writes **SHALL** be backpressure-aware: the sink awaits stdin write completion before pulling the next chunk. (CC-4, CC-10, SC-4)

5. **WHEN** an `AudioChunk` with `isFinal: true` arrives, the sink **SHALL** close the player's stdin, await the player's exit, and mark itself idle. (SC-4)

6. **WHEN** barge-in is triggered or the sink's `stop()` method is called, the sink **SHALL** immediately kill the player process via `proc.kill()` (SIGTERM), close stdin, and discard queued chunks. The sink **SHALL** become idle and spawn a fresh player on the next chunk. The `stop()` method **SHALL** be idempotent — calling on an already-stopped sink is a no-op, never an error. (CC-6, SC-4, SC-5)

7. **WHEN** no audio player binary is detected, the sink **SHALL NOT** spawn a process, **SHALL** discard chunks silently, and **SHALL** surface a one-time "no audio player found" warning. (CC-1, CC-5)

8. **WHEN** the player exits non-zero or a stdin write rejects with `EPIPE`/`Error`, the sink **SHALL** log the error, close stdin, mark idle, and **SHALL NOT** crash the session. Subsequent `AudioChunk`s for a new utterance **SHALL** spawn a fresh player. The memoized `kind` (requirement 1) **SHALL** be reused unless the crash indicates the binary is no longer executable (ENOENT/spawn failure), in which case the sink **SHALL** perform exactly one re-detection pass before giving up per requirement 7. (CC-5, CC-8)

9. **WHEN** teardown occurs, the sink **SHALL** kill any running player, close stdin, and release the process handle. Teardown **SHALL** be idempotent. `proc.kill()` on an already-dead PID **SHALL** be caught and treated as success. (SC-2, CC-1)

10. **WHEN** audio chunks arrive after `stop()` has been called, the sink **SHALL** silently suppress the write. `EPIPE` or `ERR_STREAM_DESTROYED` on post-stop writes **SHALL** be caught and discarded, never crashing the plugin. (CC-6, SC-4)

11. **WHEN** the audio format is MP3, the sink **SHALL** spawn with MP3-sniffing args (no format flag). **WHEN** PCM, the sink **SHALL** add PCM format flags. The format is read from the first chunk's `format` field and fixed for that stream's lifetime. (CC-9, SC-1, SC-4)

12. **WHEN** a volume level is supplied to the sink (default `1.0`), the sink **SHALL** apply it at spawn time by passing it through the same per-player volume-flag conventions used in the `args(kind, file, volume)` builder at `sound.ts:34-44` (`ffplay -af volume=N`, `mpv --volume <pct>`, `mpg123 -g <pct>`, `play -v N`, `cvlc --gain=N`, etc.). The sink **SHALL NOT** be required to change volume mid-stream; a volume change takes effect on the next utterance's spawn. SC-1 does not define a `volume` config field; the sink exposes a runtime `setVolume` seam owned by SDD-01 and defaults to `1.0` until set. (CC-7, CC-9)

13. **WHEN** the audio sink is implemented, it **SHALL** live inside the voice plugin module and **SHALL NOT** modify `sound.ts`, `which.ts`, or `process.ts`. (CC-1, CC-9)

---

## HOW

### Player detection (requirements 1, 2)

- `pick()`: module-level `let kind: string | null | undefined`. On first call, if `playerPreference` is set, `which(playerPreference)`; if found, `kind = playerPreference`; if not, emit warning and fall through to auto-detect. Auto-detect: `kind = LIST.find(item => which(item)) ?? null`. Memoize.
- `which(cmd)`: thin wrapper over `npm which` with `{ nothrow: true }`.

### Spawn + streaming (requirements 3, 4, 5, 11)

- On first chunk: `pick()`; if `null`, enter "player not found" path. Otherwise build args via `argsStdin(kind, volume, format)` and spawn with `stdio: ["pipe","ignore","ignore"]`.
- `argsStdin`: stdin variant of `sound.ts:34-44`. Replace file positional with `"-"`. For PCM, prepend format flags.
  - `ffplay` MP3: `["ffplay","-autoexit","-nodisp","-af","volume=${volume}","-"]`
  - `ffplay` PCM: `["ffplay","-autoexit","-nodisp","-f","pcm_s16le","-ar","44100","-ac","2","-"]`
  - `mpv` MP3: `["mpv","--no-video","--audio-display=no","--volume",String(round(volume*100)),"-"]`
- Stream loop: `for await (const chunk of input)`. For each chunk, if no `proc` alive, spawn. `await` write `chunk.data` to `proc.stdin`. On `chunk.isFinal`, `proc.stdin.end()`, `await proc.exited`, clear `proc`.
- Barge-in check: compare captured `seq` against live `seq`; if mismatched, break.

### Barge-in and stop (requirement 6)

- `stop()`: `seq++`; `clearTimeout(tail)`; if `proc`, `close(proc.stdin)` (best-effort) and `proc.kill()` (SIGTERM); set `proc = undefined`. Idempotent: `if (!proc) return` after `seq++`.
- `for await` loop breaks on `seq` mismatch. `EPIPE`/`ERR_STREAM_DESTROYED` caught and discarded.

### What is explicitly NOT built

- No `sound.ts` extension. `sound.ts` stays TUI-internal, file-only, untouched.
- No `which.ts` / `process.ts` import or edit.
- No LLM-stream abort. SC-5 owns `client.session.abort`.
- No temp-file path. stdin pipe replaces file-based playback.
- No mid-stream volume change. Volume applied at spawn time only.

---

## VERIFY

- **V1 — auto-detection memoizes first player (req 1, CC-9, SC-1).** Setup: fake `ffplay` and `mpv` on PATH. Action: feed a one-chunk MP3 stream. Expected: `ffplay` spawned (first in list); second stream does not re-detect.

- **V2 — playerPreference overrides, falls back on miss (req 2, CC-7).** Setup A: `playerPreference: "mpv"`. Expected: only `mpv` probed. Setup B: `playerPreference: "nopeplayer"`, `ffplay` on PATH. Expected: warning emitted; `ffplay` spawned.

- **V3 — spawn uses stdin pipe, no temp file (req 3, CC-9/CC-10).** Setup: fake `ffplay` copies stdin to buffer. Action: feed 3-chunk MP3 stream with `isFinal` on chunk 3. Expected: player receives all 3 chunks via stdin; `stdio` is `["pipe","ignore","ignore"]`; zero files written to `tmpdir()`.

- **V4 — streaming + backpressure (req 4, CC-4/CC-10).** Setup: fake `ffplay` drains slowly. Action: feed 3 chunks. Expected: first byte written before second chunk pulled; backpressure (producer's `next()` not called until prior write resolves).

- **V5 — isFinal closes stdin and awaits exit (req 5, SC-4).** Setup: fake `ffplay` waits 50ms after stdin end. Action: feed stream with `isFinal` on last chunk. Expected: `proc.stdin.end()` called once; sink resolves after `proc.exited`.

- **V6 — barge-in kills player and discards queued chunks (req 6, CC-6, SC-5).** Setup: fake `ffplay` blocks. Action: start stream; after chunk A, trigger `stop()`. Expected: SIGTERM sent; stdin closed; chunk B discarded; sink idle; fresh player on next stream. Did NOT call `client.session.abort`.

- **V7 — player-not-found degrades (req 7, CC-1/CC-5).** Setup: no players on PATH. Action: feed 3-chunk stream. Expected: no process spawned; zero chunks written; one warning; session not crashed.

- **V8 — player crash recovers, ENOENT re-detection (req 8, CC-5/CC-8).** Setup A: fake `ffplay` exits non-zero. Action: feed chunk A, then B, then C. Expected: error logged; stdin closed; idle; fresh stream spawns new player (reusing memoized kind). Setup B: fake `ffplay` whose `which` path becomes invalid after first spawn (simulated `ENOENT` on respawn). Action: feed a stream after the crash. Expected: exactly one re-detection pass runs; if it finds a player, playback resumes; if not, the sink enters the player-not-found path (requirement 7).

- **V9 — teardown idempotent (req 9, SC-2/CC-1).** Action: call `dispose()` three times. Expected: player killed once; second and third are no-ops; `proc.kill()` on dead PID caught as success.

- **V10 — post-stop write suppression (req 10, CC-6/SC-4).** Setup: fake `ffplay`, chunk producer. Action: start stream; call `stop()`; yield chunk B + extra write. Expected: no crash; chunk B discarded; `EPIPE` caught.

- **V11 — MP3 vs PCM format flags (req 11, CC-9, SC-1/SC-4).** Setup: fake `ffplay` recording argv. Action A: MP3 stream. Expected: no `-f` flag. Action B: PCM stream. Expected: `-f pcm_s16le -ar 44100 -ac 2` before `-`.

- **V12 — volume applied at spawn via per-player flags (req 12, CC-7/CC-9).** Setup: fake `ffplay` and fake `mpv` that record their argv. Action A: `setVolume(0.5)`, feed a stream with `ffplay` selected. Expected: argv contains `-af volume=0.5`. Action B: `setVolume(0.5)`, feed with `mpv` selected. Expected: argv contains `--volume 50`. Action C: change `setVolume(0.8)` mid-stream. Expected: running player's args unchanged; NEXT utterance's spawn uses `0.8`.

- **V13 — no core files modified (req 13, CC-1/CC-9).** Static: `git diff` against `sound.ts`, `which.ts`, `process.ts` is empty. Sink imports only `npm which`, `cross-spawn`, `child_process`, and plugin-local imports.

- **V14 — stop() idempotency (req 6, SC-4).** Action A: call `stop()` on sink at rest. Expected: no throw, no signal. Action B: call `stop()` on active sink. Expected: SIGTERM once. Call again: no throw, no second signal.

- **V15 — dead-PID tolerance (req 9, SC-2/CC-1).** Action: kill player externally, then call `stop()`. Expected: `ESRCH` caught; `stop()` returns normally; player exit non-fatal.

- **V16 — build/regression green (CC-8).** `bun run typecheck` passes and `bun test` green.
