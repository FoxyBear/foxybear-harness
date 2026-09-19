import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { VoiceTTS } from "../../../src/voice/elevenlabs"
import type {
  AudioChunk,
  AudioSink,
  BusEmit,
  Client,
  ClientFactory,
  StreamOpts,
  VoiceTTSOpts,
} from "../../../src/voice/elevenlabs"
import type { VoiceConfig } from "../../../src/voice/plugin"
import { VoicePlugin, getMode, resetState, setV2Client, toggle } from "../../../src/voice/plugin"
import type { PluginInput, Hooks } from "@foxybear/plugin"

function mkCfg(o: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    apiKeyEnv: "ELEVENLABS_API_KEY",
    voiceId: "xVQH621DS3eyBYrseRt5",
    modelId: "eleven_v3",
    stability: "natural",
    speed: 1,
    similarityBoost: 0.75,
    speakerBoost: true,
    style: 0,
    language: "en",
    outputFormat: "mp3_44100_128",
    tagEmissionTempBoost: false,
    tagEmissionTempDelta: 0,
    maxSentenceRetries: 3,
    autoStart: false,
    ...o,
  }
}

function mkClient(stream: (vid: string, opts: StreamOpts) => Promise<AsyncIterable<Uint8Array>>): Client {
  return { textToSpeech: { stream } }
}

function mkFactory(client: Client): ClientFactory {
  return async () => client
}

function mkSink() {
  const chunks: AudioChunk[] = []
  const ref = { stops: 0 }
  const sink: AudioSink = {
    stop: () => {
      ref.stops++
    },
    write: (c: AudioChunk) => {
      chunks.push(c)
    },
  }
  return { sink, chunks, ref }
}

function mkBus() {
  const events: { type: string; payload: Record<string, unknown> }[] = []
  const bus: BusEmit = (type, payload) => {
    events.push({ type, payload })
  }
  return { bus, events }
}

async function* bytes(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c
}

const U8 = (s: string) => new TextEncoder().encode(s)

function mkTTS(opts: Partial<VoiceTTSOpts> & { cfg: VoiceConfig; key?: string }): VoiceTTS {
  const sink = opts.sink ?? mkSink().sink
  const bus = opts.bus ?? mkBus().bus
  const onDegraded = opts.onDegraded ?? (() => {})
  const clientFactory = opts.clientFactory ?? mkFactory(mkClient(async () => bytes([])))
  const backoff = opts.backoff ?? (() => Promise.resolve())
  const ttsOpts: VoiceTTSOpts = {
    cfg: opts.cfg,
    sink,
    bus,
    onDegraded,
    clientFactory,
    backoff,
  }
  if (opts.key !== undefined) (ttsOpts as any).key = opts.key
  return new VoiceTTS(ttsOpts)
}

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
  setV2Client(null)
  delete process.env.ELEVENLABS_API_KEY
  delete process.env.VOICE_KEY
})

afterEach(() => {
  resetState()
  setV2Client(null)
  delete process.env.ELEVENLABS_API_KEY
  delete process.env.VOICE_KEY
})

describe("B2 — key resolution", () => {
  describe("plugin-level — resolveKey behavior", () => {
    test("custom env var name resolves correctly through plugin", async () => {
      await load({ voiceId: "vX", apiKeyEnv: "VOICE_KEY" })
      process.env.VOICE_KEY = "real-key-12345"
      const result = toggle("S1")
      expect(getMode("S1").active).toBe(true)
      expect(result).toBe("Voice on.")
    })

    test("literal key string passes through resolveKey", async () => {
      const literalKey =
        "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2g3h4i5j6k7l8m9n0o1p2q3r4s5t6u7v8w9x9y0z1a2b3c4d5e6f7g8h9i0"
      await load({ voiceId: "vX", apiKeyEnv: literalKey })
      const result = toggle("S1")
      expect(getMode("S1").active).toBe(true)
      expect(result).toBe("Voice on.")
    })

    test("custom env var name without env set — activation fails", async () => {
      await load({ voiceId: "vX", apiKeyEnv: "VOICE_KEY" })
      delete process.env.VOICE_KEY
      const result = toggle("S1")
      expect(getMode("S1").active).toBe(false)
      expect(result).toMatch(/unavailable|check/)
    })
  })

  describe("VoiceTTS — key passed to factory", () => {
    test("VoiceTTS passes resolved key to factory when key option is provided", async () => {
      const captured: { cfg: VoiceConfig; extra: unknown[] } = { cfg: null!, extra: [] }
      const factory = (async (cfg: VoiceConfig, ...extra: unknown[]) => {
        captured.cfg = cfg
        captured.extra = extra
        return mkClient(async () => bytes([U8("a")]))
      }) as ClientFactory
      const tts = mkTTS({
        cfg: mkCfg({ apiKeyEnv: "VOICE_KEY" }),
        clientFactory: factory,
        key: "resolved-key-12345",
      })
      tts.feed("Hi.")
      await tts.flush()
      const viaArg = captured.extra[0]
      const viaCfg = captured.cfg.apiKeyEnv === "resolved-key-12345"
      expect(viaArg === "resolved-key-12345" || viaCfg).toBe(true)
    })

    test("factory receives resolved key, not env var name", async () => {
      const captured: { cfg: VoiceConfig; extra: unknown[] } = { cfg: null!, extra: [] }
      const factory = (async (cfg: VoiceConfig, ...extra: unknown[]) => {
        captured.cfg = cfg
        captured.extra = extra
        return mkClient(async () => bytes([U8("a")]))
      }) as ClientFactory
      const tts = mkTTS({
        cfg: mkCfg({ apiKeyEnv: "VOICE_KEY" }),
        clientFactory: factory,
        key: "resolved-key-12345",
      })
      tts.feed("Hi.")
      await tts.flush()
      const viaArg = captured.extra[0]
      const viaCfg = captured.cfg.apiKeyEnv
      const gotResolved = viaArg === "resolved-key-12345" || viaCfg === "resolved-key-12345"
      expect(gotResolved).toBe(true)
    })

    test("backward compat — factory receives cfg when key not provided", async () => {
      process.env.ELEVENLABS_API_KEY = "test-key-67890"
      const captured: { cfg: VoiceConfig; extra: unknown[] } = { cfg: null!, extra: [] }
      const factory = (async (cfg: VoiceConfig, ...extra: unknown[]) => {
        captured.cfg = cfg
        captured.extra = extra
        return mkClient(async () => bytes([U8("a")]))
      }) as ClientFactory
      const tts = mkTTS({
        cfg: mkCfg({ apiKeyEnv: "ELEVENLABS_API_KEY" }),
        clientFactory: factory,
      })
      tts.feed("Hi.")
      await tts.flush()
      expect(captured.cfg.apiKeyEnv).toBe("ELEVENLABS_API_KEY")
      const resolved = process.env[captured.cfg.apiKeyEnv]
      expect(resolved).toBe("test-key-67890")
    })
  })
})
