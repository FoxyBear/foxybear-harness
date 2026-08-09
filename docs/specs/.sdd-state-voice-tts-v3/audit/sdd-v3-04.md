# Re-Audit: SDD v3-04 Expressivity (Tag-Stripper Ownership Fix)

**Date:** 2026-08-08
**Auditor:** Independent adversarial auditor (re-audit)
**Scope:** Verify fix for B1 (tag-stripper ownership cross-spec contradiction) + check for new issues
**Specs under review:**
- Master: `260808_voice-tts_sdd-v3-00-master.md`
- SDD-04: `260808_voice-tts_sdd-v3-04-expressivity.md`
- SDD-01: `260808_voice-tts_sdd-v3-01-plugin.md`

**Source files verified:**
- `packages/opencode/src/session/llm.ts:109-113`
- `packages/plugin/src/index.ts:246-255, 290-295, 325-328`
- `packages/opencode/test/plugin/trigger.test.ts:50-78`

---

## Original Blocking Issue (B1)

**B1 (RESOLVED):** The master spec's dependency order said SDD-04 owns "tag stripping from TUI display" but SDD-04's own "What is explicitly NOT built" section disclaimed it ("No tag stripper — SDD-01 owns stripping"). Cross-spec contradiction.

---

## Fix Verification

### Check 1 — Master dependency order no longer attributes tag stripping to SDD-04

**Master line 197 (SDD-04 entry):**
> "SDD-04 exports the `AUDIO_TAG_VOCABULARY` constant; SDD-01's tag stripper imports it. SDD-04 does NOT own the tag stripper itself — SDD-01 owns the `experimental.text.complete` hook handler that strips tags from TUI display."

**Master line 194 (SDD-01 entry):** Does not explicitly enumerate `experimental.text.complete` in the SDD-01 dependency-order line, but the SDD-04 entry's clarification is unambiguous and authoritative within the same section.

**Result:** PASS. The master now clearly states SDD-01 owns the `experimental.text.complete` hook handler and SDD-04 exports the vocabulary constant. No contradiction remains.

### Check 2 — SDD-04 "What is explicitly NOT built" still correct

**SDD-04 line 81:**
> "No tag stripper (SDD-01 owns stripping; SDD-04 exports the vocabulary constant)."

**Result:** PASS. Consistent with the master. SDD-04 disclaims the stripper, attributes it to SDD-01, and claims only the vocabulary export.

### Check 3 — SDD-01 req 14 claims the experimental.text.complete hook

**SDD-01 line 62 (req 14):**
> "WHEN the `experimental.text.complete` hook fires at `text-end`, the plugin SHALL strip SC-6 audio tags from the returned text so the TUI never displays them. This stripping SHALL run whenever the plugin is loaded, regardless of voice mode. (CC-3, SC-6)"

**SDD-01 line 88 (HOW):** Lists `experimental.text.complete` (tag stripping) in the returned Hooks object.
**SDD-01 line 132 (reuse map):** `experimental.text.complete` → `packages/plugin/src/index.ts:325-328` → Tag stripping at text-end.
**SDD-01 V14:** Verifies tag stripping with concrete input.

**Result:** PASS. SDD-01 explicitly claims the `experimental.text.complete` hook for tag stripping.

### Check 4 — All three specs consistent on tag-stripper ownership

| Spec | Statement | Owner of stripper | Owner of vocabulary |
|------|-----------|-----------------|-------------------|
| Master (197) | "SDD-01 owns the `experimental.text.complete` hook handler" | SDD-01 | SDD-04 |
| Master (190, SC-6) | "Owned by SDD-04. Referenced by SDD-01 (plugin, for stripping)" | SDD-01 | SDD-04 |
| Master (99, CC-3) | "at `text-end` via `experimental.text.complete`" | (mechanism) | — |
| Master (105, CC-9) | "`experimental.text.complete` for tag stripping" | (mechanism) | — |
| SDD-04 (81) | "No tag stripper (SDD-01 owns stripping; SDD-04 exports the vocabulary constant)" | SDD-01 | SDD-04 |
| SDD-04 (32, req 3) | "The SDD-01 tag stripper SHALL strip only SC-6 tags" | SDD-01 | SDD-04 |
| SDD-04 (46, req 10) | "the SDD-01 tag stripper SHALL leave it visible" | SDD-01 | — |
| SDD-04 (62, HOW) | "Exported so SDD-01's tag stripper imports it" | SDD-01 | SDD-04 |
| SDD-01 (62, req 14) | "the plugin SHALL strip SC-6 audio tags" | SDD-01 (self) | SC-6 ref |
| SDD-01 (88) | "`experimental.text.complete` (tag stripping)" | SDD-01 (self) | — |

**Result:** PASS. All three specs agree: SDD-01 owns the tag stripper (`experimental.text.complete` hook handler), SDD-04 owns the vocabulary (`AUDIO_TAG_VOCABULARY` constant / SC-6). Zero contradictions.

---

## Source Verification

### `experimental.chat.system.transform` trigger (llm.ts:109-113)

```typescript
yield* plugin.trigger(
  "experimental.chat.system.transform",
  { sessionID: input.sessionID, model: input.model },
  { system },
)
```
**SDD-04 line 56 claim:** "The system prompt is constructed in `packages/opencode/src/session/llm.ts:109-113`. The hook fires before the LLM sees the system prompt."
**Verified:** Lines 109-113 match exactly. The trigger passes `{ system }` as the output object (mutable array). ✓

### `experimental.chat.system.transform` signature (plugin/src/index.ts:290-295)

```typescript
"experimental.chat.system.transform"?: (
  input: { sessionID?: string; model: Model },
  output: { system: string[] },
) => Promise<void>
```
**SDD-04 line 56 claim:** "The hook's TypeScript signature is at `packages/plugin/src/index.ts:290-295`."
**Verified:** Lines 290-295 match. `output.system` is `string[]`, so `output.system.push(ENHANCE_SECTION, KATYA_TONE_GUIDE)` is valid. ✓

### `chat.params` signature (plugin/src/index.ts:246-255)

```typescript
"chat.params"?: (
  input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
  output: {
    temperature: number
    topP: number
    topK: number
    maxOutputTokens: number | undefined
    options: Record<string, any>
  },
) => Promise<void>
```
**SDD-04 req 9 claim:** The handler MAY increment `output.temperature`. Includes a "WHEN `output.temperature` is `undefined`" guard.
**Verified:** Hook exists and is wired. Minor note: `temperature: number` is typed as non-optional, so the `undefined` guard in req 9 / V9 Setup D is defensive against runtime undefined despite the type. Pre-existing from v1, not introduced by this fix. Non-blocking. ✓

### `experimental.text.complete` signature (plugin/src/index.ts:325-328)

```typescript
"experimental.text.complete"?: (
  input: { sessionID: string; messageID: string; partID: string },
  output: { text: string },
) => Promise<void>
```
**SDD-01 req 14 claim:** The plugin SHALL strip SC-6 audio tags from the returned text.
**Verified:** Hook exists. `output.text` is a mutable `string`, so the handler can rewrite it to strip tags. The `input` provides `sessionID`, `messageID`, `partID` — sufficient context for a per-part strip. ✓

### Test pattern (trigger.test.ts:50-78)

```typescript
"experimental.chat.system.transform": (_input, output) => {
  output.system.unshift("sync")
},
// ...
expect(out.system).toEqual(["sync"])
```
**SDD-04 line 56 claim:** "An existing test (`packages/opencode/test/plugin/trigger.test.ts:50-78`) proves the pattern."
**Verified:** Lines 50-78 show a working test that registers an `experimental.chat.system.transform` hook, mutates `output.system`, and asserts the result. The pattern (mutate `output.system` array) is proven. The implementation uses `.push()` vs the test's `.unshift()` — both are valid array mutations. ✓

---

## New Issues Check

### No new blocking issues introduced by the fix.

The fix was surgical: it replaced the attribution of "tag stripping from TUI display" from SDD-04 to SDD-01 in the master dependency order, and added an explicit clarification of the SDD-01/SDD-04 vocabulary import relationship. This change is consistent with SDD-04's and SDD-01's existing content.

### Non-blocking observations (not introduced by fix, noting for completeness)

**N1 — SDD-01 "Depends on: nothing" vs vocabulary import.** SDD-01 line 7 states "Depends on: nothing — SDD-01 is first in the dependency order." However, SDD-01's tag stripper imports `AUDIO_TAG_VOCABULARY` from SDD-04 (acknowledged in master line 197). This is a trivial compile-time constant dependency (`readonly string[]`), not an architectural dependency. SDD-01 can be implemented first with the vocabulary stubbed; SDD-04 "Can be implemented in parallel" per the master. The "Depends on: nothing" refers to the architectural dependency order (shared contracts), not import dependencies. Non-blocking. Pre-existing.

**N2 — `chat.params` temperature undefined guard vs typed signature.** SDD-04 req 9 / V9 Setup D test `output.temperature === undefined`, but the `chat.params` type signature shows `temperature: number` (non-optional). The guard is defensive against runtime undefined. Pre-existing from v1, not introduced by this fix. Non-blocking.

---

## Summary

| Check | Result |
|-------|--------|
| 1. Master no longer attributes tag stripping to SDD-04 | PASS |
| 2. SDD-04 "NOT built" section still correct | PASS |
| 3. SDD-01 req 14 claims experimental.text.complete | PASS |
| 4. All three specs consistent on ownership | PASS |
| 5. No new issues introduced | PASS |

**B1 status:** RESOLVED. The cross-spec contradiction has been eliminated. The master, SDD-04, and SDD-01 now agree: SDD-01 owns the tag stripper (`experimental.text.complete` hook handler), SDD-04 owns the vocabulary (`AUDIO_TAG_VOCABULARY` / SC-6). Source files confirm all hook signatures and line references cited by the specs are accurate.

VERDICT: PASS
