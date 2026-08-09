# Independent Adversarial Audit — Round 3 (Re-audit)

**Spec:** `260808_voice-tts_sdd-v3-02-elevenlabs.md`
**Auditor:** Independent (Katya)
**Date:** 2026-08-08
**Scope:** Verify round-2 blockers (dangling `req 17`, missing VERIFY for req 16) are resolved; confirm prior fixes intact; check for regressions / new issues.

---

## Round-2 Blocker 1 — Dangling "req 17" reference

**Claim:** The drain-before-retry requirement is now `req 16`; no `req 17` remains.

**Check:** Full-text grep for `req 17` → **0 matches**. Grep for `req 1[678]` → 6 matches, all `req 16`:
- L95 (HOW): "follow the drain-before-retry sequence (req 16)"
- L155 V17 → req 16a
- L157 V18 → req 16c
- L159 V19 → req 16d
- L161 V20 → req 16e
- L163 V21 → req 16d

No `req 17` anywhere in the document. The dangling reference is gone; all drain-before-retry pointers resolve to `req 16`.

**Status:** ✅ RESOLVED.

---

## Round-2 Blocker 2 — Missing VERIFY for req 16

**Claim:** VERIFY items V17–V22 now exist covering: drain-before-retry, retry bound, exhaustion liveness, barge-in cancellation, secret hygiene.

**Check:** VERIFY section now contains V17–V22 (lines 155–165), contiguous with the prior V1–V16 (verified 1–22 contiguous, no gaps/duplicates). Mapping to the five required aspects:

| Required aspect | VERIFY item | Req ref | Line | Present |
|---|---|---|---|---|
| drain-before-retry | V17 | req 16a | 155 | ✅ |
| retry bound | V18 | req 16c | 157 | ✅ |
| exhaustion liveness | V19 | req 16d | 159 | ✅ |
| barge-in cancellation | V20 | req 16e | 161 | ✅ |
| secret hygiene | V21 | req 16d | 163 | ✅ |

V22 (line 165) is the standard build/regression gate (`bun run typecheck` + `bun test`), consistent with the rest of the v3 spec family. Not req-16-specific but appropriate as the trailing guard.

**Sub-part reference integrity** against req 16 (line 66):
- 16(a) sink.stop() drain before retry → V17 ✅
- 16(b) fresh retry POST, no failed byte after retry's first byte → covered by V17's "no overlap between stop and retry" (stop confirmed before next stream()) ✅
- 16(c) retry bound `maxSentenceRetries` → V18 ✅
- 16(d) exhaustion → `tts.sentence_failed` + advance → V19 (liveness) + V21 (secret hygiene) ✅
- 16(e) epoch inheritance during retry → V20 (see note below)
- 16(f) streaming not buffered → no dedicated VERIFY (implementation note; not required by the round-3 mandate)

All five mandated aspects have a dedicated VERIFY item.

**Status:** ✅ RESOLVED.

---

## Prior Fixes — Still Intact

### (a) `maxSentenceRetries` default 3
- L52 (req 9): "SHALL NOT exceed `VoiceConfig.maxSentenceRetries` (default 3; 4 total POSTs per sentence)" ✅
- L66 (req 16c): "retry attempts SHALL NOT exceed `maxSentenceRetries` (default 3)" ✅
- L95 (HOW): "Bound: `maxSentenceRetries` (default 3 = 4 total POSTs)" ✅
- Consistent across WHAT ×2 and HOW ×1. **Intact.**

### (b) "robust" stability rejected at config validation
- L85 (HOW table): "`robust` | N/A — **rejected at config validation** … The config validator rejects `stability: "robust"` with an actionable error. It is never mapped to a stability value." ✅
- **Intact.** (See Observation O-1 for a related pre-existing wording inconsistency — non-blocking.)

### (c) "split at all detected boundaries"
- L38 (req 2): "the accumulated text **SHALL** be **split at all detected boundaries** and each sentence **SHALL** be sent as a separate `stream()` request, in source order." ✅
- **Intact.** (V2 line 125 + V15 line 151 verify multi-sentence split ordering.)

**Status:** ✅ ALL PRIOR FIXES INTACT.

---

## Regression / New-Issue Scan

No structural regressions detected. Numbering contiguous (reqs 1–16, V1–V22), no orphan cross-refs, no broken anchors. The two round-2 edits are localized and did not disturb surrounding content.

### Observations (non-blocking, not introduced this round)

**O-1 — req 5 still enumerates `robust` as a mappable preset (pre-existing).**
L44 (req 5) normative text: "The `stability` value **SHALL** be mapped from the v3 preset (`creative`/`natural`/`robust`)." This SHALL reads as "map robust to a stability value," which contradicts L85 where robust is rejected at config validation and "never mapped to a stability value." An implementer following req 5 literally would attempt to map robust rather than reject it. The HOW table corrects this, but the WHAT (normative contract) is self-contradictory on this point.
- **Impact:** Low — the HOW table + actionable error are clear; an implementer reading both sections will reject robust. But spec purity is compromised.
- **Origin:** Pre-existing (not introduced in this round; round 2 did not flag it as blocking). The rejection *mechanism* itself (the prior fix under audit) is intact and correct.
- **Recommend:** Tighten req 5 to enumerate only `creative`/`natural` as mappable presets and defer `robust` rejection to the validator (req 15 style), e.g. "mapped from the v3 preset (`creative`/`natural`); `robust` is rejected at config validation (see req 15)." Optional — does not block this gate.

**O-2 — V20 references `req 16e` but tests a pre-retry cancellation scenario.**
Req 16e (L66) describes: "a retry POST SHALL inherit the current epoch token — if barge-in occurs **during retry**, the retry's chunks SHALL be discarded by the standard epoch check." V20 instead tests: "trigger barge-in **before A's retry POST** → no retry POST occurs." These are related but distinct: req 16e covers barge-in *during* an in-flight retry POST (epoch discard), V20 covers barge-in *before* the retry POST is issued (pending-retry cancellation). The req-16e-specific scenario (epoch discards a retry's chunks mid-flight) is only generically covered by V13 (req 12, epoch drops stale chunks) — not directly verified in a mid-stream-failure-retry setup.
- **Impact:** Low — the epoch mechanism is tested (V13) and barge-in cancellation is tested (V20); combined coverage of the intent is adequate. The mismatch is a labeling precision issue, not a coverage hole that would let a bug ship.
- **Origin:** Introduced this round (V20 is new). But the mandated aspect ("barge-in cancellation") IS covered by V20, so this does not violate the round-3 mandate.
- **Recommend:** Either (a) relabel V20 to reference the teardown/barge-in interaction (req 11/12 × req 16) rather than req 16e, and add a small V-step that sets up barge-in *during* an in-flight retry POST and asserts the retry's chunks are dropped by epoch; or (b) expand V20 to cover both pre-retry and during-retry barge-in. Optional — does not block this gate.

Neither observation is a blocking defect: O-1 is pre-existing and the rejection mechanism is correct; O-2 still satisfies the mandated "barge-in cancellation" coverage. Both are flagged for author discretion in a future polish pass.

---

## Verdict

Both round-2 blockers are resolved. All prior fixes remain intact and correct. No new blocking issues were introduced. Two non-blocking observations (O-1, O-2) noted for optional future polish.

VERDICT: PASS
