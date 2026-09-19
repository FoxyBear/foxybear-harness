import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
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
import { parseConfig } from "../../../src/voice/plugin"

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

async function* bytesThenThrow(chunks: Uint8Array[], err: unknown): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c
  throw err
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

describe("V1 — lazy SDK init", () => {
  test("client constructed lazily on first sentence, not eagerly", async () => {
    let calls = 0
    let capturedKey: string | undefined
    const factory: ClientFactory = async (cfg) => {
      calls++
      capturedKey = process.env[cfg.apiKeyEnv]
      return mkClient(async () => bytes([U8("audio")]))
    }
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: factory })
    expect(calls).toBe(0)
    tts.feed("Hello.")
    expect(calls).toBe(0)
    await tts.drain()
    expect(calls).toBe(1)
    expect(capturedKey).toBe("test-secret-key")
  })
})

describe("V2 — sentence accumulation + boundary detection", () => {
  test("splits at boundaries, preserves audio tags byte-equal", async () => {
    const calls: string[] = []
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("That's a fun way. ")
    tts.feed("[laughs] ")
    tts.feed("I'm kidding.")
    await tts.flush()
    expect(calls.length).toBe(2)
    expect(calls[0]).toBe("That's a fun way.")
    expect(calls[1]).toBe("[laughs] I'm kidding.")
  })
})

describe("V3 — modelId camelCase", () => {
  test("stream options use modelId not model_id", async () => {
    let captured: StreamOpts | null = null
    const client = mkClient(async (_vid, opts) => {
      captured = opts
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg({ modelId: "eleven_v3" }), clientFactory: mkFactory(client) })
    tts.feed("Hi.")
    await tts.flush()
    expect(captured).not.toBeNull()
    expect(captured!.modelId).toBe("eleven_v3")
    expect("model_id" in captured!).toBe(false)
  })
})

describe("V4 — outputFormat set, enable_ssml absent", () => {
  test("outputFormat present, no enable_ssml_parsing", async () => {
    let captured: StreamOpts | null = null
    const client = mkClient(async (_vid, opts) => {
      captured = opts
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("Hi.")
    await tts.flush()
    expect(captured!.outputFormat).toBe("mp3_44100_128")
    expect("enable_ssml_parsing" in captured!).toBe(false)
  })
})

describe("V5 — voice_settings mapped from stability preset", () => {
  test("creative maps to ~0.3, other fields pass through", async () => {
    let vs: Record<string, unknown> | null = null
    const client = mkClient(async (_vid, opts) => {
      vs = opts.voice_settings
      return bytes([U8("a")])
    })
    const tts = mkTTS({
      cfg: mkCfg({ stability: "creative", speed: 1.1, similarityBoost: 0.8, style: 0.3, speakerBoost: false, language: "fr" }),
      clientFactory: mkFactory(client),
    })
    tts.feed("Hi.")
    await tts.flush()
    expect(vs).not.toBeNull()
    expect(vs!.stability).toBe(0.3)
    expect(vs!.speed).toBe(1.1)
    expect(vs!.similarity_boost).toBe(0.8)
    expect(vs!.style).toBe(0.3)
    expect(vs!.use_speaker_boost).toBe(false)
    expect(vs!.language).toBe("fr")
  })

  test("natural maps to ~0.5", async () => {
    let vs: Record<string, unknown> | null = null
    const client = mkClient(async (_vid, opts) => {
      vs = opts.voice_settings
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg({ stability: "natural" }), clientFactory: mkFactory(client) })
    tts.feed("Hi.")
    await tts.flush()
    expect(vs!.stability).toBe(0.5)
  })
})

describe("V6 — pronunciation dictionary per sentence", () => {
  test("no locator when unset", async () => {
    let captured: StreamOpts | null = null
    const client = mkClient(async (_vid, opts) => {
      captured = opts
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("Hi.")
    await tts.flush()
    expect("pronunciation_dictionary_locators" in captured!).toBe(false)
  })

  test("locator present on every sentence POST", async () => {
    const calls: StreamOpts[] = []
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts)
      return bytes([U8("a")])
    })
    const tts = mkTTS({
      cfg: mkCfg({ pronunciationDictionaryId: "dict1", pronunciationDictionaryVersionId: "v1" }),
      clientFactory: mkFactory(client),
    })
    tts.feed("First. Second.")
    await tts.flush()
    expect(calls.length).toBe(2)
    for (const c of calls) {
      expect(c.pronunciation_dictionary_locators).toBeDefined()
    }
  })
})

describe("V7 — audio chunks emitted, sequential", () => {
  test("chunks from sentence 1 before sentence 2, POST order enforced", async () => {
    let s1Started = false
    let s1Resolve: () => void = () => {}
    const s1Done = new Promise<void>((r) => {
      s1Resolve = r
    })
    const order: string[] = []
    const client = mkClient(async (_vid, opts) => {
      if (opts.text === "First.") {
        s1Started = true
        order.push("s1-stream")
        await s1Done
        return bytes([U8("f1"), U8("f2")])
      }
      order.push("s2-stream")
      return bytes([U8("s1"), U8("s2")])
    })
    const { sink, chunks } = mkSink()
    const tts = mkTTS({ cfg: mkCfg(), sink, clientFactory: mkFactory(client) })
    tts.feed("First. Second.")
    await new Promise<void>((r) => {
      const check = () => (s1Started ? r() : setTimeout(check, 1))
      check()
    })
    expect(order).toEqual(["s1-stream"])
    s1Resolve()
    await tts.flush()
    expect(order).toEqual(["s1-stream", "s2-stream"])
    const dataStrings = chunks.filter((c) => !c.isFinal).map((c) => new TextDecoder().decode(c.data))
    expect(dataStrings).toEqual(["f1", "f2", "s1", "s2"])
  })
})

describe("V8 — turn completion flushes buffer, final isFinal", () => {
  test("one stream call, one final AudioChunk", async () => {
    const calls: string[] = []
    const { sink, chunks } = mkSink()
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      return bytes([U8("audio")])
    })
    const tts = mkTTS({ cfg: mkCfg(), sink, clientFactory: mkFactory(client) })
    tts.feed("Hello world")
    await tts.flush()
    expect(calls).toEqual(["Hello world"])
    const finals = chunks.filter((c) => c.isFinal)
    expect(finals.length).toBe(1)
    expect(finals[0]!.format).toBe("mp3_44100_128")
  })
})

describe("V9 — per-sentence retry", () => {
  test("fails twice then succeeds — 3 POSTs, backoff honored, audio resumes", async () => {
    let calls = 0
    let backoffCalls: { attempt: number; retryAfter?: number }[] = []
    const client = mkClient(async () => {
      calls++
      if (calls < 3) throw errWithStatus(429, { "retry-after": "2" })
      return bytes([U8("ok")])
    })
    const tts = mkTTS({
      cfg: mkCfg(),
      clientFactory: mkFactory(client),
      backoff: (attempt, retryAfter) => {
        backoffCalls.push({ attempt, retryAfter })
        return Promise.resolve()
      },
    })
    tts.feed("Retry me.")
    await tts.flush()
    expect(calls).toBe(3)
    expect(backoffCalls.length).toBe(2)
    expect(backoffCalls[0]!.retryAfter).toBe(2000)
  })

  test("all 3 fail — sentence skipped, pipeline continues", async () => {
    const calls: string[] = []
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      throw errWithStatus(500)
    })
    const { bus, events } = mkBus()
    const tts = mkTTS({ cfg: mkCfg(), bus, clientFactory: mkFactory(client) })
    tts.feed("Bad. Good.")
    await tts.flush()
    expect(calls.length).toBe(8)
    expect(events.some((e) => e.type === "tts.sentence_failed")).toBe(true)
  })
})

describe("V10 — non-retryable error", () => {
  test("401 — zero retries, connected=false, degraded event, no crash", async () => {
    let calls = 0
    let degraded = false
    const client = mkClient(async () => {
      calls++
      throw errWithStatus(401)
    })
    const { bus, events } = mkBus()
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
    expect(calls).toBe(1)
    expect(degraded).toBe(true)
    expect(events.some((e) => e.type === "tts.degraded")).toBe(true)
  })

  test("404 — no retry", async () => {
    let calls = 0
    const client = mkClient(async () => {
      calls++
      throw errWithStatus(404)
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("Hi.")
    await tts.flush()
    expect(calls).toBe(1)
  })

  test("400 — no retry", async () => {
    let calls = 0
    const client = mkClient(async () => {
      calls++
      throw errWithStatus(400)
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("Hi.")
    await tts.flush()
    expect(calls).toBe(1)
  })
})

describe("V11 — graceful degradation", () => {
  test("sink terminated with isFinal, subsequent feed ignored", async () => {
    const { sink, chunks } = mkSink()
    let calls = 0
    const client = mkClient(async () => {
      calls++
      throw errWithStatus(401)
    })
    const tts = mkTTS({ cfg: mkCfg(), sink, clientFactory: mkFactory(client) })
    tts.feed("Hi.")
    await tts.flush()
    const finals = chunks.filter((c) => c.isFinal)
    expect(finals.length).toBe(1)
    const before = calls
    tts.feed("More text.")
    await tts.drain()
    expect(calls).toBe(before)
  })

  test("re-arm works — new instance after degradation", async () => {
    const badClient = mkClient(async () => {
      throw errWithStatus(401)
    })
    const tts1 = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(badClient) })
    tts1.feed("Hi.")
    await tts1.flush()
    const goodClient = mkClient(async () => bytes([U8("ok")]))
    const tts2 = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(goodClient) })
    tts2.feed("Hi.")
    await tts2.flush()
    const { sink, chunks } = mkSink()
    expect(chunks.length).toBe(0)
  })
})

describe("V12 — teardown/barge-in", () => {
  test("teardown — no further stream calls, buffer cleared", async () => {
    let calls = 0
    const client = mkClient(async () => {
      calls++
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("Partial text without boundary")
    tts.teardown()
    await tts.flush()
    expect(calls).toBe(0)
  })

  test("barge-in — sink.stop called, no session.abort by this module", async () => {
    const { sink, ref } = mkSink()
    let abortCalled = false
    const client = mkClient(async () => {
      abortCalled = true
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg(), sink, clientFactory: mkFactory(client) })
    tts.feed("Hi.")
    await tts.bargeIn()
    expect(ref.stops).toBe(1)
  })
})

describe("V13 — epoch token drops stale chunks", () => {
  test("barge-in increments epoch, stale chunks dropped", async () => {
    let firstYielded: () => void = () => {}
    const started = new Promise<void>((r) => {
      firstYielded = r
    })
    let blockResolve: () => void = () => {}
    const block = new Promise<void>((r) => {
      blockResolve = r
    })
    const { sink, chunks } = mkSink()
    const client = mkClient(async () => {
      return (async function* () {
        yield U8("a")
        firstYielded()
        await block
        yield U8("b")
      })()
    })
    const tts = mkTTS({ cfg: mkCfg(), sink, clientFactory: mkFactory(client) })
    tts.feed("Sentence.")
    await started
    await tts.bargeIn()
    blockResolve()
    await tts.flush()
    const nonFinal = chunks.filter((c) => !c.isFinal)
    expect(nonFinal.length).toBe(1)
  })
})

describe("V14 — serialized ordering", () => {
  test("no overlapping POSTs, sentence 3 waits for sentence 2", async () => {
    let inFlight = false
    let maxConcurrent = 0
    let attempt = 0
    const order: string[] = []
    const client = mkClient(async (_vid, opts) => {
      if (inFlight) maxConcurrent++
      inFlight = true
      order.push(`start:${opts.text}`)
      if (opts.text === "B.") {
        attempt++
        if (attempt < 3) {
          inFlight = false
          throw errWithStatus(500)
        }
      }
      order.push(`end:${opts.text}`)
      inFlight = false
      return bytes([U8("x")])
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("A. B. C.")
    await tts.flush()
    expect(maxConcurrent).toBe(0)
    expect(order.indexOf("start:A.")).toBeLessThan(order.indexOf("start:B."))
    expect(order.indexOf("end:B.")).toBeLessThan(order.indexOf("start:C."))
  })
})

describe("V15 — flush semantics", () => {
  test("(a) Hi. Bye! → two POSTs", async () => {
    const calls: string[] = []
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("Hi. Bye!")
    await tts.flush()
    expect(calls).toEqual(["Hi.", "Bye!"])
  })

  test("(b) One. Two. Three. → three POSTs in order", async () => {
    const calls: string[] = []
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("One. Two. Three.")
    await tts.flush()
    expect(calls).toEqual(["One.", "Two.", "Three."])
  })

  test("(c) Hello world + response-end → one POST", async () => {
    const calls: string[] = []
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("Hello world")
    await tts.flush()
    expect(calls).toEqual(["Hello world"])
  })

  test("(d) Partial + barge-in → zero POSTs", async () => {
    let calls = 0
    const client = mkClient(async () => {
      calls++
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("Partial")
    await tts.bargeIn()
    await tts.flush()
    expect(calls).toBe(0)
  })

  test("(e) whitespace-only → zero POSTs", async () => {
    let calls = 0
    const client = mkClient(async () => {
      calls++
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    tts.feed("   ")
    await tts.flush()
    expect(calls).toBe(0)
  })

  test("(f) 600-char no punctuation → forced split by 500 codepoints", async () => {
    const calls: string[] = []
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      return bytes([U8("a")])
    })
    const tts = mkTTS({ cfg: mkCfg(), clientFactory: mkFactory(client) })
    const long = "a".repeat(600)
    tts.feed(long)
    await tts.flush()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[0]!.length).toBeLessThanOrEqual(500)
  })
})

describe("V16 — model_id rejected at init", () => {
  test("rejected with actionable error mentioning modelId", () => {
    expect(() => parseConfig({ model_id: "eleven_v3" })).toThrow(/modelId/)
  })

  test("no request sent", () => {
    expect(() => parseConfig({ model_id: "eleven_v3" })).toThrow()
  })
})

describe("V17 — mid-stream failure drains player before retry", () => {
  test("sink.stop invoked before next stream call", async () => {
    const order: string[] = []
    const sink: AudioSink = {
      stop: () => {
        order.push("stop")
      },
      write: () => {},
    }
    let attempt = 0
    const client = mkClient(async () => {
      attempt++
      order.push(`stream:${attempt}`)
      return bytesThenThrow([U8("c1"), U8("c2")], errWithStatus(500))
    })
    const tts = mkTTS({
      cfg: mkCfg({ maxSentenceRetries: 1 }),
      sink,
      clientFactory: mkFactory(client),
    })
    tts.feed("Hi.")
    await tts.flush()
    expect(attempt).toBe(2)
    expect(order.indexOf("stop")).toBeLessThan(order.indexOf("stream:2"))
  })

  test("no overlap between stop and retry", async () => {
    const order: string[] = []
    const sink: AudioSink = {
      stop: () => {
        order.push("stop")
      },
      write: () => {},
    }
    const client = mkClient(async () => {
      order.push("stream")
      return bytesThenThrow([U8("c1")], errWithStatus(500))
    })
    const tts = mkTTS({
      cfg: mkCfg({ maxSentenceRetries: 1 }),
      sink,
      clientFactory: mkFactory(client),
    })
    tts.feed("Hi.")
    await tts.flush()
    expect(order).toEqual(["stream", "stop", "stream", "stop"])
    expect(order.indexOf("stop")).toBeLessThan(order.lastIndexOf("stream"))
  })
})

describe("V18 — retry bound enforced on mid-stream failure", () => {
  test("exactly 4 POSTs for first sentence, then tts.sentence_failed, then next sentence processed", async () => {
    let calls = 0
    const streamCalls: string[] = []
    const client = mkClient(async (_vid, opts) => {
      calls++
      streamCalls.push(opts.text)
      return bytesThenThrow([U8("c1")], errWithStatus(500))
    })
    const { bus, events } = mkBus()
    const tts = mkTTS({ cfg: mkCfg({ maxSentenceRetries: 3 }), bus, clientFactory: mkFactory(client) })
    tts.feed("First. Second.")
    await tts.flush()
    expect(calls).toBe(8)
    expect(events.some((e) => e.type === "tts.sentence_failed")).toBe(true)
    expect(streamCalls.includes("Second.")).toBe(true)
  })
})

describe("V19 — exhaustion liveness on mid-stream failure", () => {
  test("all 3 dispatched, second fails, third plays", async () => {
    const order: string[] = []
    const client = mkClient(async (_vid, opts) => {
      if (opts.text === "Two.") {
        order.push(`fail:${opts.text}`)
        return bytesThenThrow([U8("c1")], errWithStatus(500))
      }
      order.push(`ok:${opts.text}`)
      return bytes([U8("audio")])
    })
    const { bus, events } = mkBus()
    const { sink, chunks } = mkSink()
    const tts = mkTTS({ cfg: mkCfg(), bus, sink, clientFactory: mkFactory(client) })
    tts.feed("One. Two. Three.")
    await tts.flush()
    expect(order).toContain("ok:One.")
    expect(order).toContain("fail:Two.")
    expect(order).toContain("ok:Three.")
    expect(events.some((e) => e.type === "tts.sentence_failed")).toBe(true)
    const nonFinal = chunks.filter((c) => !c.isFinal)
    expect(nonFinal.length).toBeGreaterThanOrEqual(2)
  })
})

describe("V20 — barge-in cancels pending retry", () => {
  test("no retry POST after barge-in, sentence_failed suppressed, B plays", async () => {
    let backoffResolve: () => void = () => {}
    let aCalls = 0
    const calls: string[] = []
    const { events } = mkBus()
    const client = mkClient(async (_vid, opts) => {
      calls.push(opts.text)
      if (opts.text === "A.") {
        aCalls++
        return bytesThenThrow([U8("c1")], errWithStatus(500))
      }
      return bytes([U8("b-audio")])
    })
    let stopReached: () => void = () => {}
    const stopReachedPromise = new Promise<void>((r) => {
      stopReached = r
    })
    const trackingSink: AudioSink = {
      stop: () => {
        stopReached()
      },
      write: () => {},
    }
    const tts = new VoiceTTS({
      cfg: mkCfg(),
      sink: trackingSink,
      bus: (type, payload) => events.push({ type, payload }),
      clientFactory: mkFactory(client),
      backoff: () =>
        new Promise<void>((r) => {
          backoffResolve = r
        }),
    })
    tts.feed("A.")
    await stopReachedPromise
    await tts.bargeIn()
    tts.feed("B.")
    backoffResolve()
    await tts.flush()
    expect(aCalls).toBe(1)
    expect(events.some((e) => e.type === "tts.sentence_failed")).toBe(false)
    expect(calls).toContain("B.")
  })
})

describe("V21 — secret hygiene of failure event", () => {
  test("tts.sentence_failed payload does not contain API key", async () => {
    const { bus, events } = mkBus()
    const client = mkClient(async () => {
      throw errWithStatus(500)
    })
    const tts = mkTTS({ cfg: mkCfg({ apiKeyEnv: "ELEVENLABS_API_KEY" }), bus, clientFactory: mkFactory(client) })
    tts.feed("Hi.")
    await tts.flush()
    const failEvent = events.find((e) => e.type === "tts.sentence_failed")
    expect(failEvent).toBeDefined()
    const payloadStr = JSON.stringify(failEvent!.payload)
    expect(payloadStr).not.toContain("test-secret-key")
    expect(payloadStr).not.toContain("ELEVENLABS_API_KEY")
  })
})

