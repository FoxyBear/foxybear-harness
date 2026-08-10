import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import {
  VoicePlugin,
  getMode,
  resetState,
  getTTS,
  setAudioSink,
  setV2Client,
  mute,
} from "../../../src/voice/plugin"
import { AudioSink } from "../../../src/voice/sink"
import type { AudioChunk } from "../../../src/voice/sink"
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

describe("AS1 — real AudioSink is created when voice activates", () => {
  test("getTTS uses a real AudioSink instance, not a noop sink", async () => {
    const hooks = await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    getMode("S1").active = true

    let captured: unknown = null
    const spy = mock(function (this: unknown, _chunk: AudioChunk) {
      captured = this
      return Promise.resolve()
    })
    const orig = AudioSink.prototype.write
    AudioSink.prototype.write = spy as any

    try {
      const tts = getTTS("S1")
      expect(tts).not.toBeNull()
      await tts!.flush()
      expect(spy).toHaveBeenCalled()
      expect(captured).toBeInstanceOf(AudioSink)
    } finally {
      AudioSink.prototype.write = orig
    }
  })
})

describe("AS2 — AudioSink is reused across calls for same session", () => {
  test("getTTS called twice returns same TTS (same sink)", async () => {
    const hooks = await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    getMode("S1").active = true

    const tts1 = getTTS("S1")
    const tts2 = getTTS("S1")
    expect(tts1).not.toBeNull()
    expect(tts2).not.toBeNull()
    expect(tts1).toBe(tts2)
  })

  test("reused TTS writes through real AudioSink on second access", async () => {
    const hooks = await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    getMode("S1").active = true

    let callCount = 0
    const spy = mock(function (_chunk: AudioChunk) {
      callCount++
      return Promise.resolve()
    })
    const orig = AudioSink.prototype.write
    AudioSink.prototype.write = spy as any

    try {
      const tts1 = getTTS("S1")
      await tts1!.flush()
      const afterFirst = callCount

      const tts2 = getTTS("S1")
      expect(tts1).toBe(tts2)
      await tts2!.flush()

      expect(callCount).toBeGreaterThan(afterFirst)
      expect(spy).toHaveBeenCalled()
    } finally {
      AudioSink.prototype.write = orig
    }
  })
})

describe("AS3 — AudioSink uses playerPreference from config", () => {
  test("sink created with playerPreference from cfg", async () => {
    const hooks = await load({ voiceId: "vX", playerPreference: "mpv" })
    process.env.ELEVENLABS_API_KEY = "k"
    getMode("S1").active = true

    let captured: any = null
    const spy = mock(function (this: any, _chunk: AudioChunk) {
      captured = this
      return Promise.resolve()
    })
    const orig = AudioSink.prototype.write
    AudioSink.prototype.write = spy as any

    try {
      const tts = getTTS("S1")
      await tts!.flush()
      expect(spy).toHaveBeenCalled()
      expect(captured).toBeInstanceOf(AudioSink)
      expect(captured.pref).toBe("mpv")
    } finally {
      AudioSink.prototype.write = orig
    }
  })

  test("sink created with undefined preference when cfg omits it", async () => {
    const hooks = await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    getMode("S1").active = true

    let captured: any = null
    const spy = mock(function (this: any, _chunk: AudioChunk) {
      captured = this
      return Promise.resolve()
    })
    const orig = AudioSink.prototype.write
    AudioSink.prototype.write = spy as any

    try {
      const tts = getTTS("S1")
      await tts!.flush()
      expect(spy).toHaveBeenCalled()
      expect(captured).toBeInstanceOf(AudioSink)
      expect(captured.pref).toBeUndefined()
    } finally {
      AudioSink.prototype.write = orig
    }
  })
})

describe("AS4 — AudioSink is cleaned up on deactivate", () => {
  test("deactivate removes sink from sinks map", async () => {
    const hooks = await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"

    const protoSpy = mock((_chunk: AudioChunk) => Promise.resolve())
    const orig = AudioSink.prototype.write
    AudioSink.prototype.write = protoSpy as any

    try {
      const probeWrite = mock(() => Promise.resolve())
      const probeStop = mock(() => {})
      setAudioSink("S1", { write: probeWrite, stop: probeStop } as any)
      getMode("S1").active = true

      const tts1 = getTTS("S1")
      expect(tts1).not.toBeNull()
      await tts1!.flush()
      expect(probeWrite).toHaveBeenCalledTimes(1)
      expect(protoSpy).not.toHaveBeenCalled()

      mute("S1")
      expect(getMode("S1").active).toBe(false)

      getMode("S1").active = true
      probeWrite.mockClear()
      protoSpy.mockClear()

      const tts2 = getTTS("S1")
      expect(tts2).not.toBeNull()
      await tts2!.flush()

      expect(probeWrite).not.toHaveBeenCalled()
      expect(protoSpy).toHaveBeenCalled()
    } finally {
      AudioSink.prototype.write = orig
    }
  })
})

describe("AS5 — AudioSink is cleaned up on teardown", () => {
  test("teardownAll clears all sinks", async () => {
    const hooks = await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"

    const protoSpy = mock((_chunk: AudioChunk) => Promise.resolve())
    const orig = AudioSink.prototype.write
    AudioSink.prototype.write = protoSpy as any

    try {
      const probe1Write = mock(() => Promise.resolve())
      setAudioSink("S1", { write: probe1Write, stop: () => {} } as any)
      const probe2Write = mock(() => Promise.resolve())
      setAudioSink("S2", { write: probe2Write, stop: () => {} } as any)

      getMode("S1").active = true
      getMode("S2").active = true

      const tts1 = getTTS("S1")
      await tts1!.flush()
      expect(probe1Write).toHaveBeenCalledTimes(1)
      expect(protoSpy).not.toHaveBeenCalled()

      await hooks.event!(ev("server.instance.disposed", { directory: "/tmp" }))

      getMode("S1").active = true
      probe1Write.mockClear()
      protoSpy.mockClear()

      const tts1b = getTTS("S1")
      expect(tts1b).not.toBeNull()
      await tts1b!.flush()

      expect(probe1Write).not.toHaveBeenCalled()
      expect(protoSpy).toHaveBeenCalled()
    } finally {
      AudioSink.prototype.write = orig
    }
  })

  test("teardownSession clears sink for that session only", async () => {
    const hooks = await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"

    const protoSpy = mock((_chunk: AudioChunk) => Promise.resolve())
    const orig = AudioSink.prototype.write
    AudioSink.prototype.write = protoSpy as any

    try {
      const probe1Write = mock(() => Promise.resolve())
      setAudioSink("S1", { write: probe1Write, stop: () => {} } as any)
      const probe2Write = mock(() => Promise.resolve())
      setAudioSink("S2", { write: probe2Write, stop: () => {} } as any)

      getMode("S1").active = true
      getMode("S2").active = true

      const tts1 = getTTS("S1")
      const tts2 = getTTS("S2")
      await tts1!.flush()
      await tts2!.flush()
      expect(probe1Write).toHaveBeenCalledTimes(1)
      expect(probe2Write).toHaveBeenCalledTimes(1)

      await hooks.event!(ev("session.deleted", { sessionID: "S1", info: {} }))

      getMode("S1").active = true
      probe1Write.mockClear()
      probe2Write.mockClear()
      protoSpy.mockClear()

      const tts1b = getTTS("S1")
      expect(tts1b).not.toBeNull()
      await tts1b!.flush()

      expect(probe1Write).not.toHaveBeenCalled()
      expect(protoSpy).toHaveBeenCalled()

      const tts2b = getTTS("S2")
      expect(tts2b).toBe(tts2)
      await tts2b!.flush()
      expect(probe2Write).toHaveBeenCalledTimes(1)
    } finally {
      AudioSink.prototype.write = orig
    }
  })
})

describe("AS6 — noopSink is gone", () => {
  test("plugin source no longer contains noopSink constant", async () => {
    const src = await Bun.file(
      new URL("../../../src/voice/plugin.ts", import.meta.url),
    ).text()
    expect(src).not.toContain("noopSink")
  })

  test("audio bytes are not silently discarded — sink is real AudioSink", async () => {
    const hooks = await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    getMode("S1").active = true

    let captured: any = null
    let receivedChunks: AudioChunk[] = []
    const spy = mock(function (this: any, chunk: AudioChunk) {
      captured = this
      receivedChunks.push(chunk)
      return Promise.resolve()
    })
    const orig = AudioSink.prototype.write
    AudioSink.prototype.write = spy as any

    try {
      const tts = getTTS("S1")
      expect(tts).not.toBeNull()
      await tts!.flush()

      expect(spy).toHaveBeenCalled()
      expect(captured).not.toBeNull()
      expect(captured).toBeInstanceOf(AudioSink)
      expect(receivedChunks.length).toBeGreaterThanOrEqual(1)
      const last = receivedChunks[receivedChunks.length - 1]
      expect(last.isFinal).toBe(true)
      expect(last.data).toBeInstanceOf(Uint8Array)
    } finally {
      AudioSink.prototype.write = orig
    }
  })
})
