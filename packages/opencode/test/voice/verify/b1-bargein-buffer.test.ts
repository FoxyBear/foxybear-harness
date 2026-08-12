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

describe("B1 — barge-in cancels buffered pre-barge sentences", () => {
  test("sentences queued before barge-in are not synthesized; only post-barge sentence streams", async () => {
    const calls: string[] = []
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      return bytes([U8("audio")])
    })

    let signalHit: () => void = () => {}
    const factoryHit = new Promise<void>((r) => {
      signalHit = r
    })
    let release: () => void = () => {}
    const block = new Promise<void>((r) => {
      release = r
    })

    const factory: ClientFactory = async () => {
      signalHit()
      await block
      return client
    }

    const tts = mkTTS({ cfg: mkCfg(), clientFactory: factory })

    tts.feed("First. Second. Third.")

    await factoryHit

    await tts.bargeIn()

    release()

    tts.feed("New.")

    await tts.flush()

    expect(calls).not.toContain("First.")
    expect(calls).not.toContain("Second.")
    expect(calls).not.toContain("Third.")
    expect(calls).toEqual(["New."])
  })
})
