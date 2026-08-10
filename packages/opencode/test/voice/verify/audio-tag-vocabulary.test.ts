import { describe, expect, test } from "bun:test"
import { stripTags } from "../../../src/voice/plugin"
import { AUDIO_TAG_VOCABULARY } from "../../../src/voice/expressivity"

const SC6_TAGS = [
  "[laughs]",
  "[laughs harder]",
  "[starts laughing]",
  "[wheezing]",
  "[whispers]",
  "[sighs]",
  "[exhales]",
  "[sarcastic]",
  "[curious]",
  "[excited]",
  "[crying]",
  "[snorts]",
  "[mischievously]",
  "[gunshot]",
  "[applause]",
  "[clapping]",
  "[explosion]",
  "[swallows]",
  "[gulps]",
  "[pause]",
  "[short pause]",
  "[long pause]",
  "[sings]",
  "[woo]",
]

const ENHANCE_TAGS = [
  "[happy]",
  "[sad]",
  "[angry]",
  "[whisper]",
  "[annoyed]",
  "[appalled]",
  "[thoughtful]",
  "[surprised]",
  "[laughing]",
  "[chuckles]",
  "[clears throat]",
  "[short pause]",
  "[long pause]",
  "[exhales sharply]",
  "[inhales deeply]",
]

describe("VT1 — Every SC-6 tag is stripped", () => {
  for (const tag of SC6_TAGS) {
    test(`strips ${tag} from text`, () => {
      expect(stripTags(`${tag} Hello there.`)).toBe("Hello there.")
    })
  }
})

describe("VT2 — Every Enhance section tag is stripped", () => {
  for (const tag of ENHANCE_TAGS) {
    test(`strips ${tag} from text`, () => {
      expect(stripTags(`${tag} Hello there.`)).toBe("Hello there.")
    })
  }
})

describe("VT3 — Multi-tag stripping", () => {
  test("removes all three tags from a mixed line", () => {
    expect(stripTags("[laughs] Hello [sighs] world [curious] done.")).toBe(
      "Hello world done.",
    )
  })
})

describe("VT4 — Tags with surrounding text preserved", () => {
  test("removes tag, preserves text, cleans whitespace", () => {
    expect(stripTags("[sighs] Hello there.")).toBe("Hello there.")
  })
})

describe("VT5 — Non-SC-6 bracket tokens NOT stripped", () => {
  test("forbidden tokens remain as regression signals", () => {
    const out = stripTags("[standing] Hello [grinning]")
    expect(out).toContain("[standing]")
    expect(out).toContain("[grinning]")
    expect(out).toBe("[standing] Hello [grinning]")
  })
})

describe("VT6 — AUDIO_TAG_VOCABULARY matches SC-6", () => {
  test("contains all 24 SC-6 tags", () => {
    for (const tag of SC6_TAGS) {
      expect(AUDIO_TAG_VOCABULARY).toContain(tag)
    }
  })

  test("is the union of SC-6 + Enhance section tags", () => {
    for (const tag of ENHANCE_TAGS) {
      expect(AUDIO_TAG_VOCABULARY).toContain(tag)
    }
  })
})

describe("VT7 — Empty/whitespace-only result after stripping", () => {
  test("lone tag yields empty string", () => {
    expect(stripTags("[sighs]")).toBe("")
  })
})

describe("VT8 — Tags at different positions", () => {
  test("tag at start", () => {
    expect(stripTags("[laughs] Hi.")).toBe("Hi.")
  })

  test("tag at end", () => {
    expect(stripTags("Hi. [laughs]")).toBe("Hi.")
  })

  test("tag mid-sentence", () => {
    expect(stripTags("Hi [laughs] there.")).toBe("Hi there.")
  })
})

describe("VT9 — Multiple same tags stripped", () => {
  test("repeated tag collapses to empty", () => {
    expect(stripTags("[sighs] [sighs] [sighs]")).toBe("")
  })
})

describe("VT10 — Mixed valid and invalid tags", () => {
  test("valid tags stripped, invalid preserved", () => {
    expect(stripTags("[laughs] Hello [standing] world [sighs]")).toBe(
      "Hello [standing] world",
    )
  })
})
