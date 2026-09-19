import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  ENHANCE_SECTION,
  KATYA_TONE_GUIDE,
  AUDIO_TAG_VOCABULARY,
  PRONUNCIATION_DICTIONARY,
} from "../../../src/voice/expressivity"
import {
  VoicePlugin,
  parseConfig,
  getMode,
  resetState,
  stripTags,
} from "../../../src/voice/plugin"
import type { PluginInput, Hooks } from "@foxybear/plugin"

const STUB = {
  client: {},
  project: { id: "t", worktree: "/tmp", time: { created: 0, updated: 0 } },
  directory: "/tmp",
  worktree: "/tmp",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost:4096"),
  $: {},
} as unknown as PluginInput

async function load(voice?: Record<string, unknown>): Promise<Hooks> {
  resetState()
  const hooks = await VoicePlugin(STUB)
  if (voice !== undefined) {
    await hooks.config!({ voice } as any)
  }
  return hooks
}

type ChatParamsOutput = {
  temperature: number | undefined
  topP: number
  topK: number
  maxOutputTokens: number | undefined
  options: Record<string, any>
}

function paramsOut(temp: number | undefined): ChatParamsOutput {
  return { temperature: temp, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
}

const GLOSSARY = [
  "FoxyBear",
  "opencode",
  "fbSDUILibrary",
  "fbSDUIFirebase",
  "fbSDUISchema",
  "fbTestClient",
  "KMP",
  "vLLM",
  "Gaea",
  "Forge",
  "Phoenix Outreach",
  "DiGA",
  "BfArM",
  "MoCA",
  "cURL",
  "GitLab",
  "GitHub",
  "JSON",
  "API",
]

function lexemes(xml: string): string[] {
  const matches = xml.match(/<lexeme>([\s\S]*?)<\/lexeme>/g) ?? []
  return matches
}

function graphemes(xml: string): string[] {
  const matches = xml.match(/<grapheme>([\s\S]*?)<\/grapheme>/g) ?? []
  return matches.map((m) => m.replace(/<\/?grapheme>/g, "").trim())
}

beforeEach(() => {
  resetState()
  delete process.env.ELEVENLABS_API_KEY
})

afterEach(() => {
  resetState()
  delete process.env.ELEVENLABS_API_KEY
})

describe("V1 — Enhance section present (req 1, CC-2, SC-6)", () => {
  test("system array contains Enhance section with required markers", async () => {
    const hooks = await load({ voiceId: "vX" })
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "S1", model: {} as any }, output)
    const enhance = output.system[0]
    expect(enhance).toContain("# Instructions")
    expect(enhance).toContain("## 1. Role and Goal")
    expect(enhance).toContain("## 5. Audio Tags")
    expect(enhance).toContain("DO NOT alter, add, or remove any words")
  })

  test("Enhance section constant matches injected string", async () => {
    const hooks = await load({ voiceId: "vX" })
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "S1", model: {} as any }, output)
    expect(output.system[0]).toBe(ENHANCE_SECTION)
  })
})

describe("V2 — Katya Tone Guide present after Enhance (req 2, CC-2)", () => {
  test("Tone Guide is separate string after Enhance in array order", async () => {
    const hooks = await load({ voiceId: "vX" })
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "S1", model: {} as any }, output)
    expect(output.system.length).toBe(2)
    expect(output.system[0]).toBe(ENHANCE_SECTION)
    expect(output.system[1]).toBe(KATYA_TONE_GUIDE)
  })

  test("Tone Guide contains frequency limits", () => {
    expect(KATYA_TONE_GUIDE).toContain("ONCE per 5 turns")
    expect(KATYA_TONE_GUIDE).toContain("ONCE per 10 turns")
  })

  test("Tone Guide contains default-delivery directive", () => {
    expect(KATYA_TONE_GUIDE).toContain("neutral, direct, confident")
  })
})

describe("V3 — SC-6 recognized vocabulary; invalid tags not stripped (req 3, CC-3, SC-6)", () => {
  test("valid tag [laughs] is stripped", () => {
    const text = "[laughs] Hello there."
    expect(stripTags(text)).not.toContain("[laughs]")
  })

  test("invalid tag [standing] remains visible", () => {
    const text = "[standing] Hello there."
    const result = stripTags(text)
    expect(result).toContain("[standing]")
  })

  test("vocabulary is imported from expressivity, not redeclared", () => {
    for (const tag of AUDIO_TAG_VOCABULARY) {
      expect(tag).toMatch(/^\[.+\]$/)
    }
    expect(AUDIO_TAG_VOCABULARY).toContain("[laughs]")
    expect(AUDIO_TAG_VOCABULARY).not.toContain("[standing]")
  })
})

describe("V4 — Tag placement, no nesting (req 4, CC-2, SC-6)", () => {
  test("Enhance section contains placement directive", () => {
    expect(ENHANCE_SECTION).toContain("immediately before the dialogue segment")
  })

  test("Tone Guide contains placement directive", () => {
    expect(KATYA_TONE_GUIDE).toContain("IMMEDIATELY BEFORE")
    expect(KATYA_TONE_GUIDE).toContain("IMMEDIATELY AFTER")
  })

  test("Tone Guide forbids tag nesting", () => {
    expect(KATYA_TONE_GUIDE).toContain("Do NOT nest tags")
    expect(KATYA_TONE_GUIDE).toContain("One tag per bracket pair")
  })

  test("no nested-tag pattern in vocabulary", () => {
    for (const tag of AUDIO_TAG_VOCABULARY) {
      const nested = /\[[a-z ]*\[[a-z ]*\]/
      expect(tag).not.toMatch(nested)
    }
  })
})

describe("V5 — Frequency limits (req 5, CC-2)", () => {
  test("Tone Guide contains per-tag numeric limits", () => {
    expect(KATYA_TONE_GUIDE).toContain("ONCE per 5 turns")
    expect(KATYA_TONE_GUIDE).toContain("ONCE per 10 turns")
    expect(KATYA_TONE_GUIDE).toContain("TWO non-pause audio tags per single response")
  })

  test("Tone Guide lists pause tags as freely allowed", () => {
    expect(KATYA_TONE_GUIDE).toContain("allowed freely")
  })
})

describe("V6 — Pronunciation dictionary seeded (req 6, CC-7, SC-1)", () => {
  test("PRONUNCIATION_DICTIONARY is well-formed PLS XML", () => {
    expect(PRONUNCIATION_DICTIONARY).toContain('<?xml version="1.0"')
    expect(PRONUNCIATION_DICTIONARY).toContain("<lexicon")
    expect(PRONUNCIATION_DICTIONARY).toContain("</lexicon>")
    expect(PRONUNCIATION_DICTIONARY).toContain('xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"')
  })

  test("contains lexeme for every glossary term", () => {
    const terms = graphemes(PRONUNCIATION_DICTIONARY)
    for (const g of GLOSSARY) {
      expect(terms).toContain(g)
    }
  })

  test("each lexeme has phoneme or alias", () => {
    const entries = lexemes(PRONUNCIATION_DICTIONARY)
    expect(entries.length).toBeGreaterThanOrEqual(GLOSSARY.length)
    for (const entry of entries) {
      const hasPhoneme = entry.includes("<phoneme>")
      const hasAlias = entry.includes("<alias>")
      expect(hasPhoneme || hasAlias).toBe(true)
    }
  })
})

describe("V7 — Lazy update on observed mispronunciation (req 7, CC-5, CC-7)", () => {
  test("new lexeme can be appended for missing term", () => {
    const missing = "fbSDUIVSCodeLayoutEditor"
    expect(graphemes(PRONUNCIATION_DICTIONARY)).not.toContain(missing)
    const updated = PRONUNCIATION_DICTIONARY.replace(
      "</lexicon>",
      `  <lexeme>\n    <grapheme>${missing}</grapheme>\n    <alias>eff bee ess dee you eye vscode layout editor</alias>\n  </lexeme>\n\n</lexicon>`,
    )
    expect(graphemes(updated)).toContain(missing)
    expect(updated).toContain("<alias>eff bee ess dee you eye vscode layout editor</alias>")
  })

  test("plugin does not expand dictionary on load", async () => {
    const before = PRONUNCIATION_DICTIONARY
    await load({ voiceId: "vX", pronunciationDictionaryId: "dict-123" })
    expect(PRONUNCIATION_DICTIONARY).toBe(before)
  })
})

describe("V8 — Voice settings tuned, Robust rejected (req 8, CC-2, CC-7, SC-1)", () => {
  test("defaults are expressivity-tuned", () => {
    const cfg = parseConfig({ voiceId: "vX" })
    expect(cfg.stability).toBe("natural")
    expect(cfg.speed).toBe(1.0)
    expect(cfg.similarityBoost).toBe(0.75)
    expect(cfg.speakerBoost).toBe(true)
  })

  test("stability robust is rejected", () => {
    expect(() => parseConfig({ voiceId: "vX", stability: "robust" })).toThrow(/robust/)
  })

  test("stability creative is accepted", () => {
    const cfg = parseConfig({ voiceId: "vX", stability: "creative" })
    expect(cfg.stability).toBe("creative")
  })
})

describe("V9 — Temperature boost, default off (req 9, CC-2, SC-1)", () => {
  test("Setup A — boost off, temperature unchanged", async () => {
    const hooks = await load({ voiceId: "vX", tagEmissionTempBoost: false })
    const out = paramsOut(0.7)
    await hooks["chat.params"]!({ sessionID: "S1", agent: "a", model: {} as any, provider: {} as any, message: {} as any }, out as any)
    expect(out.temperature).toBe(0.7)
  })

  test("Setup B — boost on, delta 0.1, base 0.7 → 0.8", async () => {
    const hooks = await load({ voiceId: "vX", tagEmissionTempBoost: true, tagEmissionTempDelta: 0.1 })
    const out = paramsOut(0.7)
    await hooks["chat.params"]!({ sessionID: "S1", agent: "a", model: {} as any, provider: {} as any, message: {} as any }, out as any)
    expect(out.temperature).toBeCloseTo(0.8, 10)
  })

  test("Setup C — boost on, base 0.95 + delta 0.1 → clamped to 1.0", async () => {
    const hooks = await load({ voiceId: "vX", tagEmissionTempBoost: true, tagEmissionTempDelta: 0.1 })
    const out = paramsOut(0.95)
    await hooks["chat.params"]!({ sessionID: "S1", agent: "a", model: {} as any, provider: {} as any, message: {} as any }, out as any)
    expect(out.temperature).toBe(1.0)
  })

  test("Setup D — boost on, temperature undefined → stays undefined", async () => {
    const hooks = await load({ voiceId: "vX", tagEmissionTempBoost: true, tagEmissionTempDelta: 0.1 })
    const out = paramsOut(undefined)
    await hooks["chat.params"]!({ sessionID: "S1", agent: "a", model: {} as any, provider: {} as any, message: {} as any }, out as any)
    expect(out.temperature).toBeUndefined()
  })

  test("boost off with undefined temperature stays undefined", async () => {
    const hooks = await load({ voiceId: "vX", tagEmissionTempBoost: false })
    const out = paramsOut(undefined)
    await hooks["chat.params"]!({ sessionID: "S1", agent: "a", model: {} as any, provider: {} as any, message: {} as any }, out as any)
    expect(out.temperature).toBeUndefined()
  })

  test("no cfg — chat.params is no-op", async () => {
    const hooks = await load()
    const out = paramsOut(0.7)
    await hooks["chat.params"]!({ sessionID: "S1", agent: "a", model: {} as any, provider: {} as any, message: {} as any }, out as any)
    expect(out.temperature).toBe(0.7)
  })
})

describe("V10 — Invalid tag handling (req 10, CC-3, SC-6)", () => {
  test("stripTags leaves [standing] visible", () => {
    const result = stripTags("[standing] Hello [laughs] world")
    expect(result).toContain("[standing]")
    expect(result).not.toContain("[laughs]")
  })

  test("stripTags does not throw on invalid tags", () => {
    expect(() => stripTags("[standing] [grinning] [pacing] [music]")).not.toThrow()
  })
})

describe("V11 — System prompt voice-mode-agnostic (req 11, CC-2, CC-3, SC-2)", () => {
  test("Enhance + Tone Guide injected when voice mode off", async () => {
    const hooks = await load({ voiceId: "vX" })
    const m = getMode("S1")
    m.active = false
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "S1", model: {} as any }, output)
    expect(output.system.length).toBe(2)
    expect(output.system[0]).toBe(ENHANCE_SECTION)
    expect(output.system[1]).toBe(KATYA_TONE_GUIDE)
  })

  test("tag stripper still strips valid tags when voice off", async () => {
    const hooks = await load({ voiceId: "vX" })
    getMode("S1").active = false
    const text = "[laughs] Hello [sighs] world"
    const result = stripTags(text)
    expect(result).not.toContain("[laughs]")
    expect(result).not.toContain("[sighs]")
    expect(result).toContain("Hello")
    expect(result).toContain("world")
  })

  test("transform injects even with empty voiceId config", async () => {
    const hooks = await load({ voiceId: "" })
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "S1", model: {} as any }, output)
    expect(output.system.length).toBe(2)
  })
})
