import type { VoiceConfig } from "./plugin"
import { Log } from "../util/log"

const log = Log.create({ service: "voice.tts" })

export type AudioChunk = {
  data: Uint8Array
  format: string
  isFinal: boolean
}

export type AudioSink = {
  stop: () => Promise<void> | void
  write: (chunk: AudioChunk) => Promise<void> | void
}

export type BusEmit = (type: string, payload: Record<string, unknown>) => void

export type StreamOpts = {
  modelId: string
  text: string
  voice_settings: Record<string, unknown>
  outputFormat: string
  pronunciation_dictionary_locators?: unknown
}

export type Client = {
  textToSpeech: {
    stream: (voiceId: string, opts: StreamOpts) => Promise<AsyncIterable<Uint8Array>>
  }
}

export type ClientFactory = (cfg: VoiceConfig) => Promise<Client>

export type VoiceTTSOpts = {
  cfg: VoiceConfig
  sink: AudioSink
  bus?: BusEmit
  onDegraded?: () => void
  onPlayingChange?: (playing: boolean) => void
  clientFactory?: ClientFactory
  backoff?: (attempt: number, retryAfter?: number) => Promise<void>
}

const BOUNDARY = new Set([".", "!", "?", "\n"])
const MAX_BUF = 500
const MIN_BUF = 400

const STABILITY: Record<VoiceConfig["stability"], number> = {
  creative: 0.3,
  natural: 0.5,
  robust: 0.5,
}

const defaultFactory: ClientFactory = async (cfg) => {
  try {
    const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js")
    const apiKey = cfg.apiKeyEnv.startsWith("ELEVENLABS") ? process.env[cfg.apiKeyEnv] : cfg.apiKeyEnv
    return new ElevenLabsClient({ apiKey }) as unknown as Client
  } catch (e) {
    throw e
  }
}

const defaultBackoff = (attempt: number, retryAfter?: number) =>
  new Promise<void>((r) =>
    setTimeout(r, retryAfter ?? Math.min(1000 * 2 ** attempt, 10000) + Math.random() * 100),
  )

function split(text: string): { sentences: string[]; rest: string } {
  const out: string[] = []
  let last = 0
  for (let i = 0; i < text.length; i++) {
    if (BOUNDARY.has(text[i]!)) {
      const piece = text.slice(last, i + 1).trim()
      if (piece) out.push(piece)
      last = i + 1
    }
  }
  return { sentences: out, rest: text.slice(last) }
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as { status?: number; statusCode?: number; response?: { status?: number } }
    return e.status ?? e.statusCode ?? e.response?.status
  }
}

function isFatal(s: number | undefined): boolean {
  return s === 401 || s === 404 || s === 400
}

function retryAfterOf(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as { headers?: Record<string, string> }
    const ra = e.headers?.["retry-after"] ?? e.headers?.["Retry-After"]
    if (ra) return parseInt(ra, 10) * 1000
  }
}

function toBytes(chunk: unknown): Uint8Array | null {
  if (chunk instanceof Uint8Array) return chunk
  if (chunk && typeof chunk === "object") {
    const c = chunk as { chunk?: unknown }
    if (c.chunk instanceof Uint8Array) return c.chunk
    if (typeof c.chunk === "string") return new TextEncoder().encode(c.chunk)
  }
  if (typeof chunk === "string") return new TextEncoder().encode(chunk)
  return null
}

export class VoiceTTS {
  private cfg: VoiceConfig
  private sink: AudioSink
  private bus: BusEmit
  private onDegraded: () => void
  private onPlayingChange: (playing: boolean) => void
  private factory: ClientFactory
  private backoffFn: (attempt: number, retryAfter?: number) => Promise<void>
  private buffer = ""
  private epoch = 0
  private client: Client | null = null
  private dead = false
  private degraded = false
  private queue: Promise<void> = Promise.resolve()

  constructor(opts: VoiceTTSOpts) {
    this.cfg = opts.cfg
    this.sink = opts.sink
    this.bus = opts.bus ?? (() => {})
    this.onDegraded = opts.onDegraded ?? (() => {})
    this.onPlayingChange = opts.onPlayingChange ?? (() => {})
    this.factory = opts.clientFactory ?? defaultFactory
    this.backoffFn = opts.backoff ?? defaultBackoff
  }

  feed(text: string): void {
    if (this.dead || this.degraded) return
    this.buffer += text
    const { sentences, rest } = split(this.buffer)
    this.buffer = rest
    if (this.buffer.length > MAX_BUF) {
      let cut = MAX_BUF
      for (let i = MAX_BUF; i >= MIN_BUF; i--) {
        if (this.buffer[i] === " ") {
          cut = i
          break
        }
      }
      const forced = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut)
      if (forced) sentences.push(forced)
    }
    for (const s of sentences) {
      const sentence = s
      const token = this.epoch
      this.queue = this.queue.then(() => this.synth(sentence, token))
    }
  }

  flush(): Promise<void> {
    const s = this.buffer.trim()
    this.buffer = ""
    if (s) {
      const token = this.epoch
      this.queue = this.queue.then(() => this.synth(s, token))
    }
    this.queue = this.queue.then(async () => {
      if (this.dead || this.degraded) return
      this.onPlayingChange(false)
      await this.sink.write({ data: new Uint8Array(0), format: this.cfg.outputFormat, isFinal: true })
    })
    return this.queue
  }

  drain(): Promise<void> {
    return this.queue
  }

  async bargeIn(): Promise<void> {
    this.epoch++
    this.buffer = ""
    this.onPlayingChange(false)
    await this.sink.stop()
  }

  teardown(): void {
    this.dead = true
    this.buffer = ""
    this.client = null
    void this.sink.stop()
  }

  private request(sentence: string): StreamOpts {
    const opts: StreamOpts = {
      modelId: this.cfg.modelId,
      text: sentence,
      voice_settings: {
        stability: STABILITY[this.cfg.stability],
        similarity_boost: this.cfg.similarityBoost,
        style: this.cfg.style,
        use_speaker_boost: this.cfg.speakerBoost,
        speed: this.cfg.speed,
        language: this.cfg.language,
      },
      outputFormat: this.cfg.outputFormat,
    }
    if (this.cfg.pronunciationDictionaryId) {
      opts.pronunciation_dictionary_locators = [
        {
          pronunciation_dictionary_id: this.cfg.pronunciationDictionaryId,
          version_id: this.cfg.pronunciationDictionaryVersionId,
        },
      ]
    }
    return opts
  }

  private degrade(): void {
    if (this.degraded) return
    this.degraded = true
    this.onDegraded()
    this.bus("tts.degraded", { reason: "non_retryable" })
    void this.sink.write({ data: new Uint8Array(0), format: this.cfg.outputFormat, isFinal: true })
  }

  private async synth(sentence: string, token: number): Promise<void> {
    if (this.dead || this.degraded) return
    if (this.epoch !== token) return
    if (!this.client) {
      try {
        this.client = await this.factory(this.cfg)
      } catch (e) {
        this.degrade()
        return
      }
    }
    const max = this.cfg.maxSentenceRetries
    for (let attempt = 0; attempt <= max; attempt++) {
      if (this.dead || this.degraded || this.epoch !== token) {
        return
      }
      let chunked = false
      try {
        const stream = await this.client.textToSpeech.stream(this.cfg.voiceId, this.request(sentence))
        let chunkCount = 0
        for await (const chunk of stream) {
          if (this.dead || this.epoch !== token) {
            return
          }
          const bytes = toBytes(chunk)
          if (!bytes || bytes.length === 0) continue
          chunked = true
          chunkCount++
          if (chunkCount === 1) this.onPlayingChange(true)
          await this.sink.write({ data: bytes, format: this.cfg.outputFormat, isFinal: false })
        }
        return
      } catch (err) {
        if (this.dead || this.epoch !== token) return
        const s = statusOf(err)
        if (isFatal(s)) {
          this.degrade()
          return
        }
        if (chunked) {
          await this.sink.stop()
        }
        if (attempt >= max) {
          this.bus("tts.sentence_failed", { reason: "exhausted", length: sentence.length })
          return
        }
        await this.backoffFn(attempt, retryAfterOf(err))
      }
    }
  }
}

export { log as ttsLog }
