# SDD-04 v3: Expressivity

**Date:** 2026-08-08
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Draft v3 (pending independent audit + human gate)
**Master:** `docs/specs/260808_voice-tts_sdd-v3-00-master.md`
**Depends on:** SC-6 (Audio Tag Vocabulary, owned by this spec). **Can be implemented in parallel with SDD-01..SDD-03.**

This feature spec makes Katya's spoken output expressive (CC-2): laughs, sighs, whispers, sarcasm. It inherits all cross-cutting requirements (CC-1..CC-12). This spec is the v1 SDD-05 with no changes to the expressivity content — the Enhance section, Katya Tone Guide, SC-6 vocabulary, and pronunciation dictionary are unchanged from v1.

## Background

Expressivity does not come from a TTS control channel. Per the research, ElevenLabs v3 renders inline audio tags (`[laughs]`, `[sighs]`, `[whispers]`) emitted by the LLM in its text output. The tag affects the next ~4-5 words then the voice returns to neutral. There is no side channel.

Expressivity is a **system-prompt engineering** problem, not a runtime problem:

- The LLM must be **instructed** to emit audio tags — the ElevenLabs "Enhance" system prompt (Appendix A).
- The LLM must be **calibrated** to Katya's persona — the Katya Tone Guide (Appendix B).
- The TTS engine must be **told** which tags to honor — SC-6 is the recognized vocabulary.
- Proper nouns must be **pronounceable** — an ElevenLabs-hosted `.pls` dictionary (Appendix C).

The mechanism is the existing `experimental.chat.system.transform` plugin hook (fires during prompt preparation, before the LLM sees the system prompt) and the `chat.params` hook (for optional temperature boost). No new runtime hook, no new event subscription, no new audio path.

---

## WHAT

1. **WHEN** the `experimental.chat.system.transform` hook fires, the plugin **SHALL** append the Enhance system prompt section (Appendix A, verbatim from ElevenLabs best-practices doc) to `output.system`. (CC-2, SC-6)

2. **WHEN** the hook fires, the plugin **SHALL** also append the Katya Tone Guide (Appendix B) as a separate entry immediately after the Enhance section, calibrating tag selection to Katya's persona: `[laughs]` ≤ 1 per 5 turns, `[sarcastic]` ≤ 1 per 10 turns, `[excited]` ≤ 1 per 10 turns, default delivery neutral and direct. (CC-2)

3. **WHEN** the LLM emits audio tags, the recognized vocabulary **SHALL** be exactly SC-6. Tags not in SC-6 **SHALL NOT** be treated as audio tags by any downstream component. The SDD-01 tag stripper **SHALL** strip only SC-6 tags from the TUI display, leaving other bracket tokens visible as a prompt-engineering regression signal. (CC-3, SC-6)

4. **WHEN** the LLM emits tags, placement rules (Appendix A §2 + Appendix B §4) **SHALL** direct the LLM to place tags immediately before or after the dialogue segment, and **SHALL NOT** permit tag nesting. (CC-2, SC-6)

5. **WHEN** the LLM emits tags across a session, the Katya Tone Guide (Appendix B §1) **SHALL** instruct the LLM to respect per-tag ceilings: `[laughs]` + `[laughs harder]` combined ≤ 1 per 5 turns, `[sarcastic]` ≤ 1 per 10 turns, `[excited]` ≤ 1 per 10 turns, ≤ 2 non-pause tags per response, pauses allowed freely. (CC-2)

6. **WHEN** `VoiceConfig.pronunciationDictionaryId` is set, the ElevenLabs SDK stream (SDD-02) **SHALL** reference the `.pls` lexicon by ID + version. The seeded dictionary (Appendix C) **SHALL** contain entries for all FoxyBear glossary terms. When unset, the plugin **SHALL** still operate (degraded pronunciation). (CC-5, CC-7, SC-1, SC-6)

7. **WHEN** a mispronunciation surfaces, the operator **SHALL** add the term to the PLS file, re-upload, and update `VoiceConfig.pronunciationDictionaryId` if needed. Dictionary updates are **lazy** (only on observed failure). (CC-5, CC-7, SC-1)

8. **WHEN** the TTS SDK stream is established, the plugin (via SDD-02) **SHALL** send voice settings tuned for expressivity: `stability` preset Creative or Natural (Robust is forbidden — suppresses directional prompts, violates CC-2). The config validator **SHALL** reject `"robust"`. (CC-2, CC-7, SC-1)

9. **WHEN** the `chat.params` hook fires and `tagEmissionTempBoost` is enabled (default off), the plugin **MAY** increment `output.temperature` by the configured delta. **WHEN** `tagEmissionTempBoost` is off (default), the plugin **SHALL NOT** apply the boost. **WHEN** `output.temperature` is `undefined`, the plugin **SHALL NOT** apply the boost. (CC-2, SC-1)

10. **WHEN** the LLM emits a bracket token not in SC-6, the SDD-01 tag stripper **SHALL** leave it visible in the TUI and SDD-02 **SHALL** send the original text to ElevenLabs verbatim. The plugin **SHALL NOT** raise a runtime error on invalid tags. (CC-3, SC-6)

11. **WHEN** voice mode is off (`VoiceMode.active === false`), the Enhance section and Katya Tone Guide **SHALL** still be injected — system prompt instructions are voice-mode-agnostic. Tags are inert in text-only mode: TUI strips them, no audio plays. (CC-2, CC-3, SC-2, SC-6)

---

## HOW

### Reuse map — `experimental.chat.system.transform`

The system prompt is constructed in `packages/opencode/src/session/llm.ts:109-113`. The hook fires before the LLM sees the system prompt. The hook's TypeScript signature is at `packages/plugin/src/index.ts:290-295`. An existing test (`packages/opencode/test/plugin/trigger.test.ts:50-78`) proves the pattern. The plugin uses `output.system.push(ENHANCE_SECTION, KATYA_TONE_GUIDE)`.

### Plugin-owned constants

- `ENHANCE_SECTION: string` — verbatim from Appendix A.
- `KATYA_TONE_GUIDE: string` — authored per Appendix B.
- `AUDIO_TAG_VOCABULARY: readonly string[]` — SC-6 tag list. Exported so SDD-01's tag stripper imports it (single source of truth).
- `systemTransformHandler(input, output)` — `output.system.push(ENHANCE_SECTION, KATYA_TONE_GUIDE)`. Idempotent (appends regardless of voice mode, per req 11).

### `chat.params` handler (optional, default off)

No-op unless `tagEmissionTempBoost === true`. When enabled, adds delta to `output.temperature` and clamps to model ceiling.

### Pronunciation dictionary

W3C PLS file hosted on ElevenLabs. Referenced by `pronunciation_dictionary_locators` on each TTS request. Upload is a one-time operator action. Updates are lazy.

### Voice settings

Defaults in SC-1: `stability: "natural"`, `speed: 1.0`, `similarityBoost: 0.75`, `speakerBoost: true`. SDD-02 sends these in the stream request body. SDD-04 specifies the values and the `"robust"` rejection rule.

### What is explicitly NOT built

- No new runtime hook (reuses `experimental.chat.system.transform` and `chat.params`).
- No new event subscription.
- No tag stripper (SDD-01 owns stripping; SDD-04 exports the vocabulary constant).
- No TTS forwarder (SDD-02 owns forwarding).
- No audio sink (SDD-03 owns playback).
- No voice mode state (SDD-01 owns state).
- No post-hoc text rewriter.
- No automatic dictionary upload or auto-discovery.

---

## VERIFY

- **V1 — Enhance section present (req 1, CC-2, SC-6).** Setup: register plugin, stub capturing `output.system`. Action: trigger `experimental.chat.system.transform`. Expected: `system` array contains Enhance section with `# Instructions`, `## 1. Role and Goal`, `## 5. Audio Tags`, and the line `DO NOT alter, add, or remove any words`.

- **V2 — Katya Tone Guide present after Enhance (req 2, CC-2).** Expected: `system` array contains Katya Tone Guide as separate string after Enhance; includes frequency limits and default-delivery directive.

- **V3 — SC-6 is recognized vocabulary; invalid tags not stripped (req 3, CC-3, SC-6).** Setup: tag-stripper fixture importing `AUDIO_TAG_VOCABULARY`. Action: feed text with `[laughs]` (valid) and `[standing]` (invalid). Expected: `[laughs]` stripped; `[standing]` remains visible.

- **V4 — Tag placement, no nesting (req 4, CC-2, SC-6).** Static: inspect Enhance + Tone Guide strings for placement directive and no-nesting rule. Behavioral: 10-sample smoke completion; no nested-tag pattern.

- **V5 — Frequency limits (req 5, CC-2).** Static: Tone Guide contains numeric limits. Behavioral: 10-turn smoke; count tags; assert limits honored.

- **V6 — Pronunciation dictionary seeded (req 6, CC-7, SC-1).** Setup: read PLS file. Expected: well-formed PLS XML; `<lexeme>` entries for all Appendix C terms; each has `<phoneme>` or `<alias>`.

- **V7 — Lazy update (req 7, CC-5, CC-7).** Setup: fixture PLS with missing term. Action: simulate mispronunciation, add `<lexeme>`, re-upload. Expected: new entry present; no pre-emptive expansion on load.

- **V8 — Voice settings tuned, Robust rejected (req 8, CC-2, CC-7, SC-1).** Setup: `stability: "natural"`. Action: trigger mocked TTS stream. Expected: settings sent with `stability: "natural"`, `speed: 1.0`, `similarity_boost: 0.75`, `use_speaker_boost: true`. Action B: `stability: "robust"` → rejected with CC-2 error.

- **V9 — Temperature boost, default off (req 9, CC-2, SC-1).** Setup A: `tagEmissionTempBoost: false`. Expected: temperature unchanged. Setup B: `tagEmissionTempBoost: true`, delta 0.1, base 0.7. Expected: 0.8. Setup C: base near ceiling 0.95, ceiling 1.0. Expected: clamped to 1.0. Setup D: base `undefined`. Expected: stays `undefined`.

- **V10 — Invalid tag handling (req 10, CC-3, SC-6).** Action: emit `[standing]`. Expected: TUI keeps it; TTS forwards verbatim; no exception.

- **V11 — System prompt voice-mode-agnostic (req 11, CC-2, CC-3, SC-2).** Setup: `VoiceMode.active === false`. Action: trigger prompt cycle. Expected: Enhance + Tone Guide still present; tag stripper still strips; no audio plays.

- **V12 — Build/regression green (CC-8).** `bun run typecheck` passes and `bun test` green.

---

## APPENDIX A — Enhance System Prompt Section

Same as v1 SDD-05 Appendix A. Verbatim from ElevenLabs best-practices doc. See `docs/specs/260727_voice-tts_sdd-05-expressivity.md` Appendix A for the full text.

## APPENDIX B — Katya Tone Guide

Same as v1 SDD-05 Appendix B. Authored against Katya's persona (sharp, direct, dry humor, Eastern European edge). See `docs/specs/260727_voice-tts_sdd-05-expressivity.md` Appendix B for the full text.

## APPENDIX C — Pronunciation Dictionary

Same as v1 SDD-05 Appendix C. W3C PLS file with `<lexeme>` entries for all FoxyBear glossary terms. See `docs/specs/260727_voice-tts_sdd-05-expressivity.md` Appendix C for the full XML.
