import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import {
  VoicePlugin,
  AUDIO_TAG_VOCABULARY,
  parseConfig,
  getMode,
  getTextParts,
  resetState,
  getConfig,
  stripTags,
  setV2Client,
} from "../../../src/voice/plugin"
import type { PluginInput, Hooks } from "@opencode-ai/plugin"

const STUB = {
  client: {},
  project: { id: "t", worktree: "/tmp", time: { created: 0, updated: 0 } },
  directory: "/tmp",
  worktree: "/tmp",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost:4096"),
  $: {},
} as unknown as PluginInput

function ev(type: string, properties: Record<string, unknown>): any {
  return { event: { type, properties } }
}

async function load(voice?: Record<string, unknown>): Promise<Hooks> {
  resetState()
  const hooks = await VoicePlugin(STUB)
  if (voice !== undefined) {
    await hooks.config!({ voice } as any)
  }
  return hooks
}

beforeEach(() => {
  resetState()
  delete process.env.ELEVENLABS_API_KEY
})

afterEach(() => {
  resetState()
  setV2Client(null)
  delete process.env.ELEVENLABS_API_KEY
})

describe("V1 — internal plugin loads and returns Hooks", () => {
  test("VoicePlugin returns Hooks with all required hooks", async () => {
    const hooks = await VoicePlugin(STUB)
    expect(hooks.event).toBeDefined()
    expect(hooks.tool).toBeDefined()
    expect(hooks["command.execute.before"]).toBeDefined()
    expect(hooks["experimental.text.complete"]).toBeDefined()
    expect(hooks["experimental.chat.system.transform"]).toBeDefined()
  })

  test("tool hook contains voice.toggle and voice.mute", async () => {
    const hooks = await VoicePlugin(STUB)
    expect(hooks.tool!["voice.toggle"]).toBeDefined()
    expect(hooks.tool!["voice.mute"]).toBeDefined()
  })
})

describe("V2 — config parses with defaults", () => {
  test("parses with only voiceId, fills defaults", () => {
    const parsed = parseConfig({ voiceId: "vX" })
    expect(parsed.voiceId).toBe("vX")
    expect(parsed.modelId).toBe("eleven_v3")
    expect(parsed.stability).toBe("natural")
    expect(parsed.speed).toBe(1.0)
    expect(parsed.similarityBoost).toBe(0.75)
    expect(parsed.speakerBoost).toBe(true)
    expect(parsed.style).toBe(0)
    expect(parsed.language).toBe("en")
    expect(parsed.outputFormat).toBe("mp3_44100_128")
    expect(parsed.apiKeyEnv).toBe("ELEVENLABS_API_KEY")
    expect(parsed.tagEmissionTempBoost).toBe(false)
    expect(parsed.tagEmissionTempDelta).toBe(0)
    expect(parsed.maxSentenceRetries).toBe(3)
    expect(parsed.autoStart).toBe(false)
  })

  test("rejects stability robust with actionable error", () => {
    expect(() => parseConfig({ stability: "robust" })).toThrow(/robust/)
  })
})

describe("V3 — missing voiceId registers but stays inactive", () => {
  test("hooks are live with empty config", async () => {
    const hooks = await load({})
    expect(typeof hooks.event).toBe("function")
    expect(typeof hooks.tool!["voice.toggle"].execute).toBe("function")
  })

  test("VoiceMode.active is false when voiceId is empty", async () => {
    await load({ voiceId: "" })
    expect(getMode("S1").active).toBe(false)
  })

  test("delta does not activate TTS when inactive", async () => {
    const hooks = await load({ voiceId: "" })
    await hooks.event!(ev("message.part.updated", {
      sessionID: "S1", part: { type: "text", id: "P1" }, time: 0,
    }))
    await hooks.event!(ev("message.part.delta", {
      sessionID: "S1", messageID: "M1", partID: "P1", field: "text", delta: "hi",
    }))
    expect(getMode("S1").active).toBe(false)
  })
})

describe("V4 — per-session state, no cross-session bleed", () => {
  test("activating S1 does not affect S2", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const m1 = getMode("S1")
    m1.active = true
    m1.sessionId = "S1"
    expect(getMode("S2").active).toBe(false)
    expect(getMode("S2").sessionId).toBeNull()
  })

  test("after resetState, S1 state is gone", async () => {
    await load({ voiceId: "vX" })
    getMode("S1").active = true
    resetState()
    expect(getMode("S1").active).toBe(false)
  })
})

describe("V5 — voice.toggle flips state", () => {
  test("toggle activates when inactive", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)
    const result = await hooks.tool!["voice.toggle"].execute({} as any, { sessionID: "S1" } as any)
    expect(result).toBe("Voice on.")
    expect(getMode("S1").active).toBe(true)
  })

  test("mute deactivates when active", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)
    await hooks.tool!["voice.toggle"].execute({} as any, { sessionID: "S1" } as any)
    expect(getMode("S1").active).toBe(true)
    const result = await hooks.tool!["voice.mute"].execute({} as any, { sessionID: "S1" } as any)
    expect(result).toBe("Voice muted.")
    expect(getMode("S1").active).toBe(false)
  })
})

describe("V6 — voice.mute deactivates, no-op when inactive", () => {
  test("mute deactivates active session and stops audio", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)
    const m = getMode("S1")
    m.active = true
    m.playing = true
    await hooks.tool!["voice.mute"].execute({} as any, { sessionID: "S1" } as any)
    expect(getMode("S1").active).toBe(false)
    expect(getMode("S1").playing).toBe(false)
  })

  test("mute on already-inactive session still confirms", async () => {
    await load({ voiceId: "vX" })
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)
    const result = await hooks.tool!["voice.mute"].execute({} as any, { sessionID: "S1" } as any)
    expect(result).toBe("Voice muted.")
    expect(getMode("S1").active).toBe(false)
  })
})

describe("V7 — noReply suppresses LLM for /voice and /mute", () => {
  test("command.execute.before sets noReply for voice command", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)
    const output: { parts: any[]; noReply?: boolean } = { parts: [] }
    await hooks["command.execute.before"]!({ command: "voice", sessionID: "S1", arguments: "" }, output)
    expect(output.noReply).toBe(true)
    expect(output.parts.length).toBe(1)
    expect(output.parts[0].text).toMatch(/Voice/)
  })

  test("command.execute.before sets noReply for mute command", async () => {
    await load({ voiceId: "vX" })
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)
    const output: { parts: any[]; noReply?: boolean } = { parts: [] }
    await hooks["command.execute.before"]!({ command: "mute", sessionID: "S1", arguments: "" }, output)
    expect(output.noReply).toBe(true)
    expect(output.parts.length).toBe(1)
  })

  test("command.execute.before does not set noReply for other commands", async () => {
    const hooks = await load({ voiceId: "vX" })
    const output: { parts: any[]; noReply?: boolean } = { parts: [{ type: "text", text: "orig" }] }
    await hooks["command.execute.before"]!({ command: "help", sessionID: "S1", arguments: "" }, output)
    expect(output.noReply).toBeUndefined()
    expect(output.parts[0].text).toBe("orig")
  })
})

describe("V8 — include-only-text filter via PartUpdated correlation", () => {
  test("reasoning partID not in text-parts set, text partID is", async () => {
    const hooks = await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    getMode("S1").active = true

    await hooks.event!(ev("message.part.updated", {
      sessionID: "S1", part: { type: "reasoning", id: "R" }, time: 0,
    }))
    await hooks.event!(ev("message.part.delta", {
      sessionID: "S1", messageID: "M1", partID: "R", field: "text", delta: "thinking",
    }))

    await hooks.event!(ev("message.part.updated", {
      sessionID: "S1", part: { type: "text", id: "T" }, time: 0,
    }))
    await hooks.event!(ev("message.part.delta", {
      sessionID: "S1", messageID: "M1", partID: "T", field: "text", delta: "hello",
    }))

    const set = getTextParts("S1")!
    expect(set.has("T")).toBe(true)
    expect(set.has("R")).toBe(false)
  })
})

describe("V9 — autoStart on first assistant text delta", () => {
  test("stays inactive on reasoning delta even with autoStart", async () => {
    const hooks = await load({ voiceId: "vX", autoStart: true })
    process.env.ELEVENLABS_API_KEY = "k"
    await hooks.event!(ev("message.part.updated", {
      sessionID: "S1", part: { type: "reasoning", id: "R" }, time: 0,
    }))
    await hooks.event!(ev("message.part.delta", {
      sessionID: "S1", messageID: "M1", partID: "R", field: "text", delta: "thinking",
    }))
    expect(getMode("S1").active).toBe(false)
  })

  test("activates on first text delta with autoStart", async () => {
    const hooks = await load({ voiceId: "vX", autoStart: true })
    process.env.ELEVENLABS_API_KEY = "k"
    await hooks.event!(ev("message.part.updated", {
      sessionID: "S1", part: { type: "text", id: "T" }, time: 0,
    }))
    await hooks.event!(ev("message.part.delta", {
      sessionID: "S1", messageID: "M1", partID: "T", field: "text", delta: "hello",
    }))
    expect(getMode("S1").active).toBe(true)
  })

  test("does not autoStart when autoStart is false", async () => {
    const hooks = await load({ voiceId: "vX", autoStart: false })
    process.env.ELEVENLABS_API_KEY = "k"
    await hooks.event!(ev("message.part.updated", {
      sessionID: "S1", part: { type: "text", id: "T" }, time: 0,
    }))
    await hooks.event!(ev("message.part.delta", {
      sessionID: "S1", messageID: "M1", partID: "T", field: "text", delta: "hello",
    }))
    expect(getMode("S1").active).toBe(false)
  })
})

describe("V10 — activation resolves API key, falls back when absent", () => {
  test("activation fails when API key is absent", async () => {
    await load({ voiceId: "vX" })
    delete process.env.ELEVENLABS_API_KEY
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)
    const result = await hooks.tool!["voice.toggle"].execute({} as any, { sessionID: "S1" } as any)
    expect(getMode("S1").active).toBe(false)
    expect(result).toMatch(/unavailable|check/)
  })

  test("activation succeeds when API key is present", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)
    const result = await hooks.tool!["voice.toggle"].execute({} as any, { sessionID: "S1" } as any)
    expect(getMode("S1").active).toBe(true)
    expect(result).toBe("Voice on.")
  })

  test("text session continues after failed activation", async () => {
    await load({ voiceId: "vX" })
    delete process.env.ELEVENLABS_API_KEY
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)
    await hooks.tool!["voice.toggle"].execute({} as any, { sessionID: "S1" } as any)
    expect(getMode("S1").active).toBe(false)
    expect(typeof hooks["experimental.text.complete"]).toBe("function")
  })
})

describe("V11 — barge-in calls v2 SDK session.abort", () => {
  test("session.abort called via v2 SDK on barge-in", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const abortFn = mock((_p: { sessionID: string }) => Promise.resolve({}))
    setV2Client({ session: { abort: abortFn } })

    const m = getMode("S1")
    m.active = true
    m.playing = true

    await hooks.event!(ev("session.status", {
      sessionID: "S1", status: { type: "busy" },
    }))

    expect(abortFn).toHaveBeenCalledTimes(1)
    expect(abortFn.mock.calls[0]?.[0]).toEqual({ sessionID: "S1" })
    expect(getMode("S1").playing).toBe(false)
  })

  test("no barge-in when voice not playing", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const abortFn = mock((_p: { sessionID: string }) => Promise.resolve({}))
    setV2Client({ session: { abort: abortFn } })

    getMode("S1").active = true
    getMode("S1").playing = false

    await hooks.event!(ev("session.status", {
      sessionID: "S1", status: { type: "busy" },
    }))

    expect(abortFn).not.toHaveBeenCalled()
  })

  test("no barge-in when voice inactive", async () => {
    await load({ voiceId: "vX" })
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const abortFn = mock(() => Promise.resolve({}))
    setV2Client({ session: { abort: abortFn } })

    await hooks.event!(ev("session.status", {
      sessionID: "S1", status: { type: "busy" },
    }))

    expect(abortFn).not.toHaveBeenCalled()
  })
})

describe("V12 — teardown on server.instance.disposed", () => {
  test("all audio stopped and VoiceMode map cleared", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const m1 = getMode("S1")
    m1.active = true
    m1.playing = true
    const m2 = getMode("S2")
    m2.active = true
    m2.playing = true

    await hooks.event!(ev("server.instance.disposed", { directory: "/tmp" }))

    expect(getMode("S1").active).toBe(false)
    expect(getMode("S2").active).toBe(false)
  })
})

describe("V13 — session.deleted clears state", () => {
  test("S1 cleared, S2 untouched", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const m1 = getMode("S1")
    m1.active = true
    m1.playing = true
    const m2 = getMode("S2")
    m2.active = true
    m2.playing = true

    await hooks.event!(ev("session.deleted", { sessionID: "S1", info: {} }))

    expect(getMode("S1").active).toBe(false)
    expect(getMode("S1").sessionId).toBeNull()
    expect(getMode("S2").active).toBe(true)
  })
})

describe("V14 — experimental.text.complete strips tags", () => {
  test("strips audio tags when voice inactive", async () => {
    const hooks = await load({ voiceId: "vX" })
    const output = { text: "Hmm [sighs] that was rough. [laughs] Done." }
    await hooks["experimental.text.complete"]!({ sessionID: "S1", messageID: "M1", partID: "P1" }, output)
    expect(output.text).toBe("Hmm that was rough. Done.")
  })

  test("identical result when voice active", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)
    getMode("S1").active = true
    const output = { text: "Hmm [sighs] that was rough. [laughs] Done." }
    await hooks["experimental.text.complete"]!({ sessionID: "S1", messageID: "M1", partID: "P1" }, output)
    expect(output.text).toBe("Hmm that was rough. Done.")
  })

  test("strips all vocabulary tags", () => {
    const input = AUDIO_TAG_VOCABULARY.map((t) => `word${t}word`).join(" ")
    const stripped = stripTags(input)
    for (const tag of AUDIO_TAG_VOCABULARY) {
      expect(stripped).not.toContain(tag)
    }
  })
})

describe("V15 — experimental.chat.system.transform injects prompts", () => {
  test("output.system contains Enhance section and Katya Tone Guide", async () => {
    const hooks = await load({ voiceId: "vX" })
    const output = { system: ["existing prompt"] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "S1", model: {} as any }, output)
    expect(output.system.length).toBe(3)
    expect(output.system[0]).toBe("existing prompt")
    expect(output.system[1]).toMatch(/Enhance/i)
    expect(output.system[2]).toMatch(/Katya Tone Guide/i)
  })

  test("transform runs regardless of voice mode", async () => {
    const hooks = await load({ voiceId: "" })
    const output = { system: [] }
    await hooks["experimental.chat.system.transform"]!({ sessionID: "S1", model: {} as any }, output)
    expect(output.system.length).toBe(2)
  })
})

describe("V16 — AUDIO_TAG_VOCABULARY export", () => {
  test("contains all SC-6 tags", () => {
    expect(AUDIO_TAG_VOCABULARY).toContain("[laughs]")
    expect(AUDIO_TAG_VOCABULARY).toContain("[laughs harder]")
    expect(AUDIO_TAG_VOCABULARY).toContain("[chuckles]")
    expect(AUDIO_TAG_VOCABULARY).toContain("[sighs]")
    expect(AUDIO_TAG_VOCABULARY).toContain("[gasps]")
    expect(AUDIO_TAG_VOCABULARY).toContain("[whispers]")
    expect(AUDIO_TAG_VOCABULARY).toContain("[sarcastic]")
    expect(AUDIO_TAG_VOCABULARY).toContain("[excited]")
    expect(AUDIO_TAG_VOCABULARY).toContain("[pause]")
    expect(AUDIO_TAG_VOCABULARY.length).toBe(9)
  })
})
