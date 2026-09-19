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

function errWithStatus(status: number, headers?: Record<string, string>): { status: number; headers?: Record<string, string>; message: string } {
  return { status, headers, message: `HTTP ${status}` }
}

const U8 = (s: string) => new TextEncoder().encode(s)

function mkTTS(opts: Partial<VoiceTTSOpts> & { cfg: VoiceConfig }): VoiceTTS {
  const sink = opts.sink ?? mkSink().sink
  const bus = opts.bus ?? mkBus().bus
  const onDegraded = opts.onDegraded ?? (() => {})
  const clientFactory = opts.clientFactory ?? mkFactory(mkClient(async () => bytes([])))
  const backoff = opts.backoff ?? (() => Promise.resolve())
  return new VoiceTTS({ cfg: opts.cfg, sink, bus, onDegraded, clientFactory, backoff })
}

beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = "test-secret-key"
})

afterEach(() => {
  delete process.env.ELEVENLABS_API_KEY
})

describe("BUG-2 — 400 does not permanently degrade session", () => {
  test("400 on bracket sentence does not prevent subsequent sentences", async () => {
    const badSentence = "[Chat: peakmed-design / DM: Mada / Gmail: Gemini notes Aug 7 + Feedback Aug 11]"
    const calls: string[] = []
    const { sink, chunks } = mkSink()
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      if (opts.text === badSentence) {
        throw errWithStatus(400)
      }
      return bytes([U8("audio")])
    })
    const tts = mkTTS({ cfg: mkCfg(), sink, clientFactory: mkFactory(client) })

    tts.feed(badSentence)
    await tts.flush()
    tts.feed("Good morning.")
    await tts.flush()
    await tts.drain()

    expect(calls).toContain("Good morning.")
    expect(calls).toContain(badSentence)
    expect(chunks.filter((c) => !c.isFinal).length).toBeGreaterThan(0)
  })

  test("401 permanently degrades — no audio written", async () => {
    const { sink, chunks } = mkSink()
    const client = mkClient(async () => {
      throw errWithStatus(401)
    })
    const tts = mkTTS({ cfg: mkCfg(), sink, clientFactory: mkFactory(client) })

    tts.feed("Hi.")
    await tts.flush()
    await tts.drain()

    expect(chunks.filter((c) => !c.isFinal).length).toBe(0)
  })

  test("400 does not trigger onDegraded callback", async () => {
    let degraded = false
    const { bus, events } = mkBus()
    const client = mkClient(async () => {
      throw errWithStatus(400)
    })
    const tts = mkTTS({
      cfg: mkCfg(),
      bus,
      onDegraded: () => {
        degraded = true
      },
      clientFactory: mkFactory(client),
    })

    tts.feed("Hi.")
    await tts.flush()
    await tts.drain()

    expect(degraded).toBe(false)
    expect(events.some((e) => e.type === "tts.degraded")).toBe(false)
  })

  test("401 does trigger onDegraded callback", async () => {
    let degraded = false
    const { bus, events } = mkBus()
    const client = mkClient(async () => {
      throw errWithStatus(401)
    })
    const tts = mkTTS({
      cfg: mkCfg(),
      bus,
      onDegraded: () => {
        degraded = true
      },
      clientFactory: mkFactory(client),
    })

    tts.feed("Hi.")
    await tts.flush()
    await tts.drain()

    expect(degraded).toBe(true)
    expect(events.some((e) => e.type === "tts.degraded")).toBe(true)
  })

  test("multiple 400s in sequence don't degrade — all skipped, session continues", async () => {
    const calls: string[] = []
    const { sink, chunks } = mkSink()
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      if (opts.text.startsWith("Bad")) {
        throw errWithStatus(400)
      }
      return bytes([U8("good")])
    })
    const tts = mkTTS({ cfg: mkCfg(), sink, clientFactory: mkFactory(client) })

    tts.feed("Bad one. Bad two. Bad three. Good four.")
    await tts.flush()
    await tts.drain()

    expect(calls).toContain("Good four.")
    expect(calls).toContain("Bad one.")
    expect(calls).toContain("Bad two.")
    expect(calls).toContain("Bad three.")
    expect(chunks.filter((c) => !c.isFinal).length).toBeGreaterThan(0)
  })

  test("400 on first sentence, then normal sentences work", async () => {
    const calls: string[] = []
    const { sink, chunks } = mkSink()
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      if (opts.text === "Bad first.") {
        throw errWithStatus(400)
      }
      return bytes([U8("audio")])
    })
    const tts = mkTTS({ cfg: mkCfg(), sink, clientFactory: mkFactory(client) })

    tts.feed("Bad first. Good second. Good third.")
    await tts.flush()
    await tts.drain()

    expect(calls).toContain("Good second.")
    expect(calls).toContain("Good third.")
    expect(chunks.filter((c) => !c.isFinal).length).toBeGreaterThan(0)
  })
})
