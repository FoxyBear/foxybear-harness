import { describe, expect, test } from "bun:test"
import type { Config } from "../../src/config/config"
import type { Provider } from "../../src/provider/provider"
import type { MessageV2 } from "../../src/session/message-v2"
import {
  utilization,
  tier,
  thresholds,
  isTieringEnabled,
  needsImmediateCompaction,
  isOverflow,
  type CompactionTier,
} from "../../src/session/overflow"

function model(opts: { context: number; output: number; input?: number }): Provider.Model {
  return {
    id: "test",
    providerID: "test",
    name: "Test",
    limit: { context: opts.context, input: opts.input, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    api: { id: "test", url: "https://example.com", npm: "@ai-sdk/openai" },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  } as Provider.Model
}

function tk(total: number): MessageV2.Assistant["tokens"] {
  return { total, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function cfg(compaction?: Record<string, unknown>): Config.Info {
  return { compaction } as Config.Info
}

describe("utilization", () => {
  test("1. returns 0 when context === 0", () => {
    const m = model({ context: 0, output: 32_000 })
    expect(utilization({ cfg: cfg(), tokens: tk(50_000), model: m })).toBe(0)
  })

  test("2. returns 0 when auto === false", () => {
    const m = model({ context: 200_000, output: 8_000, input: 200_000 })
    expect(utilization({ cfg: cfg({ auto: false }), tokens: tk(50_000), model: m })).toBe(0)
  })

  test("3. computes correct ratio — 50K tokens, 200K usable, no reserved", () => {
    const m = model({ context: 200_000, output: 8_000, input: 200_000 })
    expect(utilization({ cfg: cfg({ reserved: 0 }), tokens: tk(50_000), model: m })).toBeCloseTo(0.25)
  })

  test("4. uses limit.input - reserved when present — 50K/180K", () => {
    const m = model({ context: 200_000, output: 8_000, input: 200_000 })
    expect(utilization({ cfg: cfg({ reserved: 20_000 }), tokens: tk(50_000), model: m })).toBeCloseTo(50 / 180)
  })

  test("5. uses context - maxOutputTokens when no limit.input — 50K/192K", () => {
    const m = model({ context: 200_000, output: 8_000 })
    expect(utilization({ cfg: cfg(), tokens: tk(50_000), model: m })).toBeCloseTo(50 / 192)
  })

  test("6. can exceed 1.0 — 200K/100K → 2.0", () => {
    const m = model({ context: 200_000, output: 8_000, input: 100_000 })
    expect(utilization({ cfg: cfg({ reserved: 0 }), tokens: tk(200_000), model: m })).toBeCloseTo(2.0)
  })
})

describe("tier", () => {
  test("7. returns 'none' below tier 1 — utilization 0.79", () => {
    const m = model({ context: 100_000, output: 8_000, input: 100_000 })
    expect(tier({ cfg: cfg({ reserved: 0 }), tokens: tk(79_000), model: m })).toBe("none")
  })

  test("8. returns 'microcompact' at tier 1 — utilization 0.80", () => {
    const m = model({ context: 100_000, output: 8_000, input: 100_000 })
    expect(tier({ cfg: cfg({ reserved: 0 }), tokens: tk(80_000), model: m })).toBe("microcompact")
  })

  test("9. returns 'compact' at tier 2 — utilization 0.90", () => {
    const m = model({ context: 100_000, output: 8_000, input: 100_000 })
    expect(tier({ cfg: cfg({ reserved: 0 }), tokens: tk(90_000), model: m })).toBe("compact")
  })

  test("10. returns 'hard_stop' at tier 3 — utilization 0.95", () => {
    const m = model({ context: 100_000, output: 8_000, input: 100_000 })
    expect(tier({ cfg: cfg({ reserved: 0 }), tokens: tk(95_000), model: m })).toBe("hard_stop")
  })

  test("11. respects custom thresholds — tier1=0.7, tier2=0.85, tier3=0.9, utilization 0.86 → 'compact'", () => {
    const m = model({ context: 100_000, output: 8_000, input: 100_000 })
    const c = cfg({ reserved: 0, tier1_threshold: 0.7, tier2_threshold: 0.85, tier3_threshold: 0.9 })
    expect(tier({ cfg: c, tokens: tk(86_000), model: m })).toBe("compact")
  })

  test("12. returns highest applicable tier — utilization 0.96 → 'hard_stop'", () => {
    const m = model({ context: 100_000, output: 8_000, input: 100_000 })
    expect(tier({ cfg: cfg({ reserved: 0 }), tokens: tk(96_000), model: m })).toBe("hard_stop")
  })
})

describe("isOverflow (deprecated wrapper)", () => {
  test("13. returns true only at hard_stop — 0.90 → false, 0.95 → true", () => {
    const m = model({ context: 100_000, output: 8_000, input: 100_000 })
    const c = cfg({ reserved: 0 })
    expect(isOverflow({ cfg: c, tokens: tk(90_000), model: m })).toBe(false)
    expect(isOverflow({ cfg: c, tokens: tk(95_000), model: m })).toBe(true)
  })

  test("14. same guard conditions as tier() — context === 0 → false, auto === false → false", () => {
    const m0 = model({ context: 0, output: 32_000 })
    expect(isOverflow({ cfg: cfg(), tokens: tk(100_000), model: m0 })).toBe(false)
    const m = model({ context: 100_000, output: 8_000, input: 100_000 })
    expect(isOverflow({ cfg: cfg({ auto: false }), tokens: tk(100_000), model: m })).toBe(false)
  })
})

describe("exact-boundary >= semantics", () => {
  test("30. exact boundaries — 0.80/0.90/0.95 → microcompact/compact/hard_stop", () => {
    const m = model({ context: 100_000, output: 8_000, input: 100_000 })
    const c = cfg({ reserved: 0 })
    expect(tier({ cfg: c, tokens: tk(80_000), model: m })).toBe("microcompact")
    expect(tier({ cfg: c, tokens: tk(90_000), model: m })).toBe("compact")
    expect(tier({ cfg: c, tokens: tk(95_000), model: m })).toBe("hard_stop")
  })

  test("30. just-below boundaries — 0.799 → none, 0.899 → microcompact, 0.949 → compact", () => {
    const m = model({ context: 1_000_000, output: 8_000, input: 1_000_000 })
    const c = cfg({ reserved: 0 })
    expect(tier({ cfg: c, tokens: tk(799_000), model: m })).toBe("none")
    expect(tier({ cfg: c, tokens: tk(899_000), model: m })).toBe("microcompact")
    expect(tier({ cfg: c, tokens: tk(949_000), model: m })).toBe("compact")
  })
})

describe("tier3_threshold: 1.0 restores old behavior", () => {
  test("31. 0.99 → 'compact', 1.0 → 'hard_stop'", () => {
    const m = model({ context: 100_000, output: 8_000, input: 100_000 })
    const c = cfg({ reserved: 0, tier3_threshold: 1.0 })
    expect(tier({ cfg: c, tokens: tk(99_000), model: m })).toBe("compact")
    expect(tier({ cfg: c, tokens: tk(100_000), model: m })).toBe("hard_stop")
  })

  test("31. needsImmediateCompaction() matches old isOverflow() at 100%", () => {
    const m = model({ context: 100_000, output: 8_000, input: 100_000 })
    const c = cfg({ reserved: 0, tier3_threshold: 1.0 })
    expect(needsImmediateCompaction({ cfg: c, tokens: tk(99_000), model: m })).toBe(false)
    expect(needsImmediateCompaction({ cfg: c, tokens: tk(100_000), model: m })).toBe(true)
  })
})

describe("partial config with defaults", () => {
  test("32. { tier2_threshold: 0.85 } merges to {0.8, 0.85, 0.95}", () => {
    const t = thresholds(cfg({ tier2_threshold: 0.85 }))
    expect(t.tier1).toBe(0.8)
    expect(t.tier2).toBe(0.85)
    expect(t.tier3).toBe(0.95)
  })

  test("32. tier mapping with partial config — 0.80 → microcompact, 0.85 → compact, 0.95 → hard_stop", () => {
    const m = model({ context: 1_000_000, output: 8_000, input: 1_000_000 })
    const c = cfg({ reserved: 0, tier2_threshold: 0.85 })
    expect(tier({ cfg: c, tokens: tk(800_000), model: m })).toBe("microcompact")
    expect(tier({ cfg: c, tokens: tk(850_000), model: m })).toBe("compact")
    expect(tier({ cfg: c, tokens: tk(950_000), model: m })).toBe("hard_stop")
  })
})

describe("usable <= 0", () => {
  test("37. reserved >= limit.input → utilization returns 0, tier returns 'none', no divide-by-zero", () => {
    const m = model({ context: 200_000, output: 8_000, input: 50_000 })
    const c = cfg({ reserved: 50_000 })
    expect(utilization({ cfg: c, tokens: tk(10_000), model: m })).toBe(0)
    expect(tier({ cfg: c, tokens: tk(10_000), model: m })).toBe("none")
  })

  test("37. reserved > limit.input → utilization returns 0", () => {
    const m = model({ context: 200_000, output: 8_000, input: 50_000 })
    const c = cfg({ reserved: 60_000 })
    expect(utilization({ cfg: c, tokens: tk(10_000), model: m })).toBe(0)
  })
})

describe("thresholds", () => {
  test("default thresholds — no config → {0.8, 0.9, 0.95}", () => {
    const t = thresholds(cfg())
    expect(t.tier1).toBe(0.8)
    expect(t.tier2).toBe(0.9)
    expect(t.tier3).toBe(0.95)
  })

  test("custom thresholds — explicit values used correctly", () => {
    const t = thresholds(cfg({ tier1_threshold: 0.7, tier2_threshold: 0.85, tier3_threshold: 0.9 }))
    expect(t.tier1).toBe(0.7)
    expect(t.tier2).toBe(0.85)
    expect(t.tier3).toBe(0.9)
  })
})

describe("isTieringEnabled", () => {
  test("returns false when auto === false", () => {
    const m = model({ context: 200_000, output: 8_000, input: 200_000 })
    expect(isTieringEnabled({ cfg: cfg({ auto: false }), model: m })).toBe(false)
  })

  test("returns false when context === 0", () => {
    const m = model({ context: 0, output: 32_000 })
    expect(isTieringEnabled({ cfg: cfg(), model: m })).toBe(false)
  })

  test("returns false when usable <= 0 (reserved >= limit.input)", () => {
    const m = model({ context: 200_000, output: 8_000, input: 50_000 })
    expect(isTieringEnabled({ cfg: cfg({ reserved: 50_000 }), model: m })).toBe(false)
  })

  test("returns true when tiering is active", () => {
    const m = model({ context: 200_000, output: 8_000, input: 200_000 })
    expect(isTieringEnabled({ cfg: cfg({ reserved: 0 }), model: m })).toBe(true)
  })

  test("35. distinguishes disabled from healthy — auto:false vs healthy session", () => {
    const m = model({ context: 200_000, output: 8_000, input: 200_000 })
    expect(isTieringEnabled({ cfg: cfg({ auto: false }), model: m })).toBe(false)
    expect(isTieringEnabled({ cfg: cfg({ reserved: 0 }), model: m })).toBe(true)
  })
})
