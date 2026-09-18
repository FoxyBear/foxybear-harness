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
import {
  VoicePlugin,
  getMode,
  resetState,
  setV2Client,
  toggle,
  getTTS,
  setAudioSink,
} from "../../../src/voice/plugin"
import type { PluginInput, Hooks } from "@foxybear/plugin"

function mkCfg(o: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    apiKeyEnv: "ELEVENLABS_API_KEY",
    voiceId: "xVQH621DS3eyBYrtt5",
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

function errWithStatus(status: number, headers?: Record<string, string>): { status: number; headers?: Record<string, string>; message: string } {
  return { status, headers, message: `HTTP ${status}` }
}

const U8 = (s: string) => new TextEncoder().encode(s)

function mkTTS(opts: Partial<VoiceTTSOpts> & { cfg: VoiceConfig; onPlayingChange?: (playing: boolean) => void }): VoiceTTS {
  const sink = opts.sink ?? mkSink().sink
  const bus = opts.bus ?? mkBus().bus
  const onDegraded = opts.onDegraded ?? (() => {})
  const clientFactory = opts.clientFactory ?? mkFactory(mkClient(async () => bytes([])))
  const backoff = opts.backoff ?? (() => Promise.resolve())
  return new VoiceTTS({
    cfg: opts.cfg,
    sink,
    bus,
    onDegraded,
    clientFactory,
    backoff,
    onPlayingChange: opts.onPlayingChange,
  } as VoiceTTSOpts)
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

describe("B1-TTS — onPlayingChange callback", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "test-secret-key"
  })

  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY
  })

  test("onPlayingChange(true) called after first non-empty audio chunk", async () => {
    const calls: boolean[] = []
    const client = mkClient(async () => bytes([U8("audio")]))
    const tts = mkTTS({
      cfg: mkCfg(),
      clientFactory: mkFactory(client),
      onPlayingChange: (p) => calls.push(p),
    })
    tts.feed("Hello.")
    await tts.flush()
    expect(calls).toContain(true)
  })

  test("onPlayingChange(false) called after flush sends isFinal", async () => {
    const calls: boolean[] = []
    const client = mkClient(async () => bytes([U8("audio")]))
    const tts = mkTTS({
      cfg: mkCfg(),
      clientFactory: mkFactory(client),
      onPlayingChange: (p) => calls.push(p),
    })
    tts.feed("Hello.")
    await tts.flush()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1]).toBe(false)
  })

  test("onPlayingChange(false) called after bargeIn()", async () => {
    const calls: boolean[] = []
    let firstYielded: () => void = () => {}
    const started = new Promise<void>((r) => {
      firstYielded = r
    })
    let blockResolve: () => void = () => {}
    const block = new Promise<void>((r) => {
      blockResolve = r
    })
    const { sink } = mkSink()
    const client = mkClient(async () => {
      return (async function* () {
        yield U8("a")
        firstYielded()
        await block
        yield U8("b")
      })()
    })
    const tts = mkTTS({
      cfg: mkCfg(),
      sink,
      clientFactory: mkFactory(client),
      onPlayingChange: (p) => calls.push(p),
    })
    tts.feed("Sentence.")
    await started
    await tts.bargeIn()
    blockResolve()
    await tts.flush()
    expect(calls).toContain(false)
  })

  test("onPlayingChange never called with true when degraded (401 before any chunk)", async () => {
    const calls: boolean[] = []
    const client = mkClient(async () => {
      throw errWithStatus(401)
    })
    const tts = mkTTS({
      cfg: mkCfg(),
      clientFactory: mkFactory(client),
      onPlayingChange: (p) => calls.push(p),
    })
    tts.feed("Hi.")
    await tts.flush()
    expect(calls).not.toContain(true)
  })
})

describe("B1-Plugin — m.playing wired to onPlayingChange", () => {
  beforeEach(() => {
    resetState()
    setV2Client(null)
    delete process.env.ELEVENLABS_API_KEY
  })

  afterEach(() => {
    resetState()
    setV2Client(null)
    delete process.env.ELEVENLABS_API_KEY
  })

  test("m.playing is false after activation (no audio yet)", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    toggle("S1")
    expect(getMode("S1").playing).toBe(false)
  })

  test("m.playing is false after flush (wiring smoke test)", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    toggle("S1")
    setAudioSink("S1", { stop: () => {}, write: () => {} })
    const tts = getTTS("S1")!
    await tts.flush()
    expect(getMode("S1").playing).toBe(false)
  })

  test("onPlayingChange wired in getTTS — flush resets m.playing from true to false", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    toggle("S1")
    setAudioSink("S1", { stop: () => {}, write: () => {} })
    const tts = getTTS("S1")!
    getMode("S1").playing = true
    await tts.flush()
    expect(getMode("S1").playing).toBe(false)
  })
})
