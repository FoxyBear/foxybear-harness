# Independent Adversarial Audit — Round 3 (Re-audit)

**Spec:** `260808_voice-tts_sdd-v3-03-audio-sink.md`
**Auditor:** Independent (Katya)
**Date:** 2026-08-08
**Scope:** Verify round-2 blockers (duplicate VERIFY numbering V13/V14; req 8 & old req 13 identical WHEN conditions) are resolved via merge + renumbering; confirm prior fixes intact; check for regressions / new issues.

---

## Round-2 Blocker 1 — Duplicate VERIFY numbering (V13, V14 appeared twice)

**Claim:** VERIFYs renumbered to a single contiguous V1–V16 sequence; each label appears exactly once.

**Check:** VERIFY section (lines 83–113) enumerated:

| Label | Line | Title | Req ref |
|---|---|---|---|
| V1 | 83 | auto-detection memoizes first player | req 1 |
| V2 | 85 | playerPreference overrides, falls back on miss | req 2 |
| V3 | 87 | spawn uses stdin pipe, no temp file | req 3 |
| V4 | 89 | streaming + backpressure | req 4 |
| V5 | 91 | isFinal closes stdin and awaits exit | req 5 |
| V6 | 93 | barge-in kills player and discards queued chunks | req 6 |
| V7 | 95 | player-not-found degrades | req 7 |
| V8 | 97 | player crash recovers, ENOENT re-detection | req 8 |
| V9 | 99 | teardown idempotent | req 9 |
| V10 | 101 | post-stop write suppression | req 10 |
| V11 | 103 | MP3 vs PCM format flags | req 11 |
| V12 | 105 | volume applied at spawn via per-player flags | req 12 |
| V13 | 107 | no core files modified | req 13 |
| V14 | 109 | stop() idempotency | req 6 |
| V15 | 111 | dead-PID tolerance | req 9 |
| V16 | 113 | build/regression green | CC-8 |

16 labels, V1→V16 contiguous, each appearing once. No duplicate V13/V14. V13 is now "no core files modified" (matches the repurposed req 13); V14 is "stop() idempotency" (req 6). The previous duplicate pair is gone.

**Status:** ✅ RESOLVED.

---

## Round-2 Blocker 2 — req 8 & old req 13 identical WHEN conditions

**Claim:** req 8 and old req 13 merged into a single requirement (req 8) covering both crash recovery AND ENOENT re-detection; old duplicate removed; req 13 slot repurposed for the "no core files modified" requirement.

**Check:** Full requirement enumeration (lines 21–45):

| Req | Line | WHEN (condensed) | Topic |
|---|---|---|---|
| 1 | 21 | sink initializes, preference unset | auto-detect + memoize |
| 2 | 23 | preference set | probe single, fall back |
| 3 | 25 | first AudioChunk, no player alive | spawn stdin pipe |
| 4 | 27 | subsequent AudioChunks | write to stdin, backpressure |
| 5 | 29 | AudioChunk isFinal:true | close stdin, await exit |
| 6 | 31 | barge-in or stop() | kill player, idempotent |
| 7 | 33 | no player detected | no spawn, warn |
| 8 | 35 | player exits non-zero OR stdin write rejects EPIPE/Error | **crash recovery + ENOENT re-detection (merged)** |
| 9 | 37 | teardown occurs | kill, idempotent, dead-PID tolerant |
| 10 | 39 | chunks arrive after stop() | suppress, catch EPIPE |
| 11 | 41 | format MP3/PCM | format flags |
| 12 | 43 | volume level supplied | apply at spawn via per-player flags |
| 13 | 45 | sink is implemented | live in plugin, don't modify core files |

13 requirements, numbered 1–13 contiguous, no gaps/duplicates. All 13 WHEN conditions are semantically distinct — no two requirements share an identical WHEN. The merged req 8 (line 35) now reads, in full:

> "WHEN the player exits non-zero or a stdin write rejects with `EPIPE`/`Error`, the sink **SHALL** log the error, close stdin, mark idle, and **SHALL NOT** crash the session. Subsequent `AudioChunk`s for a new utterance **SHALL** spawn a fresh player. The memoized `kind` (requirement 1) **SHALL** be reused unless the crash indicates the binary is no longer executable (ENOENT/spawn failure), in which case the sink **SHALL** perform exactly one re-detection pass before giving up per requirement 7."

This single requirement contains both:
- **Crash recovery** (sentences 1–2): log, close stdin, mark idle, no session crash, fresh player on next utterance reusing memoized kind.
- **ENOENT re-detection** (sentence 3): if the crash indicates the binary is no longer executable (ENOENT/spawn failure), perform exactly one re-detection pass before giving up per req 7.

No separate requirement elsewhere restates this WHEN. New req 13 (line 45) is the "no core files modified" isolation requirement with a distinct WHEN ("WHEN the audio sink is implemented") — not a crash/EPIPE duplicate.

**Status:** ✅ RESOLVED.

---

## VERIFY ↔ Requirement Reference Integrity

Every VERIFY label's explicit `req N` reference resolves to a real requirement:

| VERIFY | Claims req | Req exists | Topic match |
|---|---|---|---|
| V1 | req 1 | ✅ | auto-detection ✅ |
| V2 | req 2 | ✅ | preference override ✅ |
| V3 | req 3 | ✅ | stdin pipe spawn ✅ |
| V4 | req 4 | ✅ | streaming/backpressure ✅ |
| V5 | req 5 | ✅ | isFinal ✅ |
| V6 | req 6 | ✅ | barge-in ✅ |
| V7 | req 7 | ✅ | player-not-found ✅ |
| V8 | req 8 | ✅ | crash + ENOENT (merged) ✅ |
| V9 | req 9 | ✅ | teardown ✅ |
| V10 | req 10 | ✅ | post-stop suppression ✅ |
| V11 | req 11 | ✅ | MP3/PCM flags ✅ |
| V12 | req 12 | ✅ | volume ✅ |
| V13 | req 13 | ✅ | no core files modified ✅ |
| V14 | req 6 | ✅ | stop() idempotency (req 6 declares idempotent stop) ✅ |
| V15 | req 9 | ✅ | dead-PID tolerance (req 9 declares dead-PID caught as success) ✅ |
| V16 | CC-8 | ✅ (cross-cutting) | build/regression gate ✅ |

Internal req cross-references inside req 8 ("requirement 1", "requirement 7") and inside V8 ("requirement 7") all resolve. No orphan references.

**Status:** ✅ ALL REFERENCES VALID.

---

## Prior Fixes — Still Intact

### (a) Volume requirement (req 12)
- L43 (req 12): "the sink **SHALL** apply it at spawn time by passing it through the same per-player volume-flag conventions used in the `args(kind, file, volume)` builder at `sound.ts:34-44` (`ffplay -af volume=N`, `mpv --volume <pct>`, `mpg123 -g <pct>`, `play -v N`, `cvlc --gain=N`, etc.)." — enumerates 5 player conventions.
- Cross-checked against source `sound.ts:34-44`:
  - `ffplay` → `-af volume=${volume}` ↔ spec `ffplay -af volume=N` ✅
  - `mpv` → `--volume String(Math.round(volume*100))` ↔ spec `mpv --volume <pct>` ✅
  - `mpg123/mpg321` → `-g String(Math.round(volume*100))` ↔ spec `mpg123 -g <pct>` ✅
  - `play` → `-v String(volume)` ↔ spec `play -v N` ✅
  - `cvlc` → `--gain=${volume}` ↔ spec `cvlc --gain=N` ✅
- "SC-1 does not define a `volume` config field; the sink exposes a runtime `setVolume` seam owned by SDD-01 and defaults to `1.0` until set." — seam/default present ✅
- V12 (L105) tests all three: ffplay `-af volume=0.5`, mpv `--volume 50`, mid-stream change deferred to next spawn. ✅
- **Intact.**

### (b) ENOENT re-detection (req 8)
- L35 (req 8, sentence 3): "unless the crash indicates the binary is no longer executable (ENOENT/spawn failure), in which case the sink **SHALL** perform exactly one re-detection pass before giving up per requirement 7." ✅
- V8 Setup B (L97): "fake `ffplay` whose `which` path becomes invalid after first spawn (simulated `ENOENT` on respawn)… exactly one re-detection pass runs; if it finds a player, playback resumes; if not, the sink enters the player-not-found path (requirement 7)." ✅
- **Intact.**

**Status:** ✅ ALL PRIOR FIXES INTACT.

---

## Source-Line Reference Accuracy

Spec cites four `sound.ts` line ranges; all verified against the actual file (156 lines):

| Spec cite | Claim | Actual | Match |
|---|---|---|---|
| L21 | LIST at `sound.ts:17-30` | LIST array lines 17–30 | ✅ |
| L25 | args builder at `sound.ts:34-44` | `args(kind,file,volume)` lines 34–44 | ✅ |
| L13 | `stdin: "ignore"` at `sound.ts:89` | line 89 = `stdin: "ignore"` | ✅ |
| L43 | args builder at `sound.ts:34-44` | (same as above) | ✅ |

HOW section describes `pick()` and `stop()` behavior consistent with `sound.ts:79-83` (pick memoizes `kind`) and `sound.ts:128-143` (stop: `seq++`, `clear`, `if (!proc) return`, `proc.kill()`). Semantically faithful; the sink is explicitly **new code** reimplementing these primitives for stdin-pipe (req 13 forbids modifying `sound.ts`).

**Status:** ✅ ALL LINE REFERENCES ACCURATE.

---

## Regression / New-Issue Scan

No structural regressions. The two round-2 edits (req 8 merge, VERIFY renumber) are localized and did not disturb surrounding content:
- Requirement sequence 1–13 contiguous, no gaps/duplicates.
- VERIFY sequence V1–V16 contiguous, no duplicates.
- No orphan `req N` cross-references; no broken anchors.
- Player LIST (req 1) matches source `sound.ts:17-30` exactly (12 candidates, same order).
- stdin-pipe variant (req 3) correctly replaces file positional with `"-"` and uses `["pipe","ignore","ignore"]` (V3), not `stdin: "ignore"` from the TUI source.

### Observations (non-blocking)

**O-1 — V14 and V15 both reference req 6/req 9 respectively while req 6 and req 9 each carry a V6/V9 plus an extra idempotency/dead-PID VERIFY.** V6 (req 6) tests barge-in; V14 (req 6) tests stop() idempotency; V9 (req 9) tests teardown idempotency; V15 (req 9) tests dead-PID tolerance. This is the same multi-VERIFY-per-req pattern used across the v3 spec family (e.g., SDD-02 req 16 has V17–V21). Not a defect — req 6 and req 9 each bundle two concerns (kill + idempotency; teardown + dead-PID tolerance) that warrant separate test setups. Non-blocking.

**O-2 — V16 references CC-8 only, not a specific req.** Consistent with the trailing build/regression gate convention across the v3 spec family (SDD-02 V22, etc.). Non-blocking.

Neither observation is a blocking defect. Both are pre-existing structural conventions, not introduced this round.

---

## Verdict

Both round-2 blockers are resolved:
1. Duplicate VERIFY numbering eliminated — V1–V16 contiguous, each label unique.
2. req 8 & old req 13 merged into a single requirement (req 8) covering both crash recovery and ENOENT re-detection; no duplicate WHEN conditions remain; req 13 repurposed for the isolation requirement.

All prior fixes (volume req 12 with per-player conventions matching `sound.ts:34-44`; ENOENT re-detection in req 8 + V8 Setup B) remain intact. All `sound.ts` line references are accurate. No new blocking issues introduced. Two non-blocking observations (O-1, O-2) noted for context — both are established spec-family conventions.

VERDICT: PASS
