import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { Log } from "../util/log"
import { ENHANCE_SECTION, KATYA_TONE_GUIDE, AUDIO_TAG_VOCABULARY } from "./expressivity"
import { VoiceTTS } from "./elevenlabs"
import type { AudioSink, BusEmit } from "./elevenlabs"
import { AudioSink as RealAudioSink } from "./sink"

export { AUDIO_TAG_VOCABULARY }

const log = Log.create({ service: "voice" })
const dbg = (...a: unknown[]) => process.stderr.write(`[V] ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}\n`)

export type VoiceConfig = {
  apiKeyEnv: string
  voiceId: string
  modelId: string
  stability: "creative" | "natural" | "robust"
  speed: number
  similarityBoost: number
  speakerBoost: boolean
  style: number
  language: string
  playerPreference?: string
  pronunciationDictionaryId?: string
  pronunciationDictionaryVersionId?: string
  outputFormat: string
  tagEmissionTempBoost: boolean
  tagEmissionTempDelta: number
  maxSentenceRetries: number
  autoStart: boolean
}

type VoiceMode = {
  active: boolean
  sessionId: string | null
  playing: boolean
  connected: boolean
}

const TEMP_CEILING = 1

const modes = new Map<string, VoiceMode>()
const textParts = new Map<string, Set<string>>()
const ttsInstances = new Map<string, VoiceTTS>()
const lastFlushed = new Map<string, string>()
const sinks = new Map<string, AudioSink>()
let cfg: VoiceConfig | null = null
let warned = false

export function setAudioSink(sessionID: string, sink: AudioSink | null) {
  if (sink) sinks.set(sessionID, sink)
  else sinks.delete(sessionID)
}

export function getTTS(sessionID: string): VoiceTTS | null {
  dbg("getTTS sessionID=", sessionID)
  if (!cfg) {
    dbg("  no cfg")
    return null
  }
  const m = getMode(sessionID)
  if (!m.active) {
    dbg("  mode not active")
    return null
  }
  let tts = ttsInstances.get(sessionID)
  if (!tts) {
    dbg("  creating new VoiceTTS instance")
    const bus: BusEmit = (type, payload) => log.warn("tts event", { type, ...payload })
    let sink = sinks.get(sessionID)
    if (!sink) {
      sink = new RealAudioSink({ playerPreference: cfg.playerPreference })
      sinks.set(sessionID, sink)
    }
    tts = new VoiceTTS({
      cfg,
      sink,
      bus,
      onDegraded: () => {
        m.connected = false
        log.warn("voice degraded — non-retryable error")
      },
    })
    ttsInstances.set(sessionID, tts)
  } else {
    dbg("  reusing existing TTS instance")
  }
  return tts
}

type V2Client = {
  session: {
    abort: (params: { sessionID: string }) => Promise<unknown>
  }
}

let v2: V2Client | null = null

export function setV2Client(client: V2Client | null) {
  v2 = client
}

async function getV2(): Promise<V2Client> {
  if (v2) return v2
  const { Server } = await import("../server/server")
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) =>
    (await Server.Default()).app.fetch(input as Request, init)
  v2 = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    fetch: fetchFn as typeof fetch,
  }) as unknown as V2Client
  return v2
}

export function parseConfig(raw: Record<string, unknown>): VoiceConfig {
  if ("model_id" in raw) {
    throw new Error(
      'voice.model_id is not recognized — use "modelId" (camelCase) instead.',
    )
  }
  const parsed: VoiceConfig = {
    apiKeyEnv: (raw.apiKeyEnv as string) ?? "ELEVENLABS_API_KEY",
    voiceId: (raw.voiceId as string) ?? "xVQH621DS3eyBYrseRt5",
    modelId: (raw.modelId as string) ?? "eleven_v3",
    stability: (raw.stability as VoiceConfig["stability"]) ?? "natural",
    speed: (raw.speed as number) ?? 1.0,
    similarityBoost: (raw.similarityBoost as number) ?? 0.75,
    speakerBoost: (raw.speakerBoost as boolean) ?? true,
    style: (raw.style as number) ?? 0,
    language: (raw.language as string) ?? "en",
    playerPreference: raw.playerPreference as string | undefined,
    pronunciationDictionaryId: raw.pronunciationDictionaryId as string | undefined,
    pronunciationDictionaryVersionId: raw.pronunciationDictionaryVersionId as string | undefined,
    outputFormat: (raw.outputFormat as string) ?? "mp3_44100_128",
    tagEmissionTempBoost: (raw.tagEmissionTempBoost as boolean) ?? false,
    tagEmissionTempDelta: (raw.tagEmissionTempDelta as number) ?? 0,
    maxSentenceRetries: (raw.maxSentenceRetries as number) ?? 3,
    autoStart: (raw.autoStart as boolean) ?? false,
  }
  if (parsed.stability === "robust") {
    throw new Error(
      'voice.stability "robust" is not supported with eleven_v3. Use "creative" or "natural".',
    )
  }
  return parsed
}

export function getMode(sessionID: string): VoiceMode {
  let m = modes.get(sessionID)
  if (!m) {
    m = { active: false, sessionId: null, playing: false, connected: false }
    modes.set(sessionID, m)
  }
  return m
}

export function getTextParts(sessionID: string): Set<string> | undefined {
  return textParts.get(sessionID)
}

export function resetState() {
  for (const [, tts] of ttsInstances) tts.teardown()
  ttsInstances.clear()
  lastFlushed.clear()
  sinks.clear()
  modes.clear()
  textParts.clear()
  cfg = null
  warned = false
}

export function getConfig(): VoiceConfig | null {
  return cfg
}

export function stripTags(text: string): string {
  let result = text
  for (const tag of AUDIO_TAG_VOCABULARY) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    result = result.replace(new RegExp(`\\s*${escaped}\\s*`, "g"), " ")
  }
  return result.replace(/\s+/g, " ").trim()
}

function resolveKey(): string | null {
  if (!cfg) return null
  const v = cfg.apiKeyEnv
  if (!v) return null
  if (/^[A-Z_][A-Z0-9_]*$/.test(v) && v.length < 64) {
    return process.env[v] ?? null
  }
  return v
}

function activate(sessionID: string): boolean {
  dbg("activate sessionID=", sessionID)
  if (!cfg || !cfg.voiceId) {
    dbg("  no cfg or voiceId")
    if (!warned) {
      log.warn("voice not configured — voiceId missing")
      warned = true
    }
    return false
  }
  const key = resolveKey()
  dbg("  resolveKey result:", key ? "found (len=" + key.length + ")" : "null")
  if (!key) {
    log.warn("voice activation failed — API key not found")
    return false
  }
  const m = getMode(sessionID)
  m.active = true
  m.sessionId = sessionID
  m.connected = true
  dbg("  activated, mode=", m)
  return true
}

function deactivate(sessionID: string) {
  const m = getMode(sessionID)
  m.active = false
  m.playing = false
  m.connected = false
  const tts = ttsInstances.get(sessionID)
  if (tts) {
    tts.teardown()
    ttsInstances.delete(sessionID)
  }
  const sink = sinks.get(sessionID)
  if (sink) {
    sink.stop()
    sinks.delete(sessionID)
  }
}

function stopAudio(sessionID: string) {
  const tts = ttsInstances.get(sessionID)
  if (tts) void tts.bargeIn()
}

async function bargeIn(sessionID: string) {
  const m = getMode(sessionID)
  if (!m.active) return
  const tts = ttsInstances.get(sessionID)
  if (tts) await tts.bargeIn()
  m.playing = false
  const client = await getV2()
  await client.session.abort({ sessionID })
}

function teardownAll() {
  for (const [, sink] of sinks) sink.stop()
  sinks.clear()
  for (const [, tts] of ttsInstances) tts.teardown()
  ttsInstances.clear()
  lastFlushed.clear()
  modes.clear()
  textParts.clear()
}

function teardownSession(sessionID: string) {
  const sink = sinks.get(sessionID)
  if (sink) {
    sink.stop()
    sinks.delete(sessionID)
  }
  const tts = ttsInstances.get(sessionID)
  if (tts) {
    tts.teardown()
    ttsInstances.delete(sessionID)
  }
  lastFlushed.delete(sessionID)
  modes.delete(sessionID)
  textParts.delete(sessionID)
}

type AnyEvent = {
  type: string
  properties: Record<string, unknown>
}

export async function VoicePlugin(
  _input: PluginInput,
  _options?: PluginOptions,
): Promise<Hooks> {
  dbg("VoicePlugin() called")
  return {
    config: async (config: Record<string, unknown>) => {
      dbg("config hook fired, has voice?", !!config.voice)
      if (!config.voice) return
      try {
        cfg = parseConfig(config.voice as Record<string, unknown>)
        dbg("config parsed OK, voiceId=", cfg.voiceId, "apiKeyEnv starts with:", cfg.apiKeyEnv.slice(0, 10), "autoStart=", cfg.autoStart)
      } catch (err) {
        dbg("config parse FAILED:", String(err))
        log.error("voice config invalid", { error: err })
        cfg = null
      }
    },

    event: async ({ event }) => {
      const ev = event as unknown as AnyEvent
      const type = ev.type
      const props = ev.properties ?? {}

      if (type === "message.part.updated") {
        const sessionID = props.sessionID as string
        const part = props.part as { type?: string; id?: string } | undefined
        dbg("part.updated sessionID=", sessionID, "partType=", part?.type, "partID=", part?.id)
        if (!sessionID || !part?.id) return
        if (part.type === "text") {
          let set = textParts.get(sessionID)
          if (!set) {
            set = new Set()
            textParts.set(sessionID, set)
          }
          set.add(part.id)
          dbg("text-parts set now:", [...set])
        }
        return
      }

      if (type === "message.part.delta") {
        const sessionID = props.sessionID as string
        const partID = props.partID as string
        const field = props.field as string
        const delta = props.delta as string
        dbg("part.delta sessionID=", sessionID, "partID=", partID, "field=", field, "delta=", delta?.slice(0, 40))
        if (!sessionID || !partID) return
        const set = textParts.get(sessionID)
        if (!set || !set.has(partID)) {
          dbg("  DROPPED — not in text-parts set")
          return
        }

        if (cfg?.autoStart && cfg.voiceId) {
          const m = getMode(sessionID)
          if (!m.active) {
            dbg("  autoStart activating...")
            activate(sessionID)
          }
        }

        const m = getMode(sessionID)
        dbg("  mode active=", m.active, "playing=", m.playing)
        if (m.active) {
          if (field !== "text" || typeof delta !== "string") {
            dbg("  DROPPED — field=", field, "delta type=", typeof delta)
            return
          }
          dbg("  feeding TTS, delta length=", delta.length)
          const tts = getTTS(sessionID)
          if (tts) tts.feed(delta)
          else dbg("  TTS is null!")
        }
        return
      }

      if (type === "message.updated") {
        const sessionID = props.sessionID as string
        const info = props.info as { role?: string; time?: { completed?: number }; id?: string } | undefined
        dbg("message.updated sessionID=", sessionID, "role=", info?.role, "completed=", info?.time?.completed, "id=", info?.id)
        if (!sessionID || info?.role !== "assistant" || !info?.time?.completed || !info.id) return
        const last = lastFlushed.get(sessionID)
        if (last === info.id) {
          dbg("  already flushed, skipping")
          return
        }
        lastFlushed.set(sessionID, info.id)
        const tts = ttsInstances.get(sessionID)
        dbg("  flushing TTS, has instance=", !!tts)
        if (tts) void tts.flush()
        return
      }

      if (type === "session.status") {
        const sessionID = props.sessionID as string
        const status = props.status as { type?: string } | undefined
        dbg("session.status sessionID=", sessionID, "statusType=", status?.type)
        if (!sessionID || status?.type !== "busy") return
        const m = getMode(sessionID)
        if (m.active && m.playing) {
          dbg("  barge-in!")
          bargeIn(sessionID)
        }
        return
      }

      if (type === "session.deleted") {
        dbg("session.deleted")
        const sessionID = props.sessionID as string
        if (sessionID) teardownSession(sessionID)
        return
      }

      if (type === "server.instance.disposed") {
        dbg("server.instance.disposed — tearing down all")
        teardownAll()
        return
      }
    },

    tool: {
      "voice.toggle": tool({
        description: "Toggle voice/TTS on or off for the current session",
        args: {},
        async execute(_args, ctx) {
          const m = getMode(ctx.sessionID)
          if (m.active) {
            deactivate(ctx.sessionID)
            return "Voice off."
          }
          const ok = activate(ctx.sessionID)
          return ok ? "Voice on." : "Voice unavailable — check API key and config."
        },
      }),
      "voice.mute": tool({
        description: "Mute voice/TTS for the current session",
        args: {},
        async execute(_args, ctx) {
          deactivate(ctx.sessionID)
          return "Voice muted."
        },
      }),
    },

    "command.execute.before": async (cmd, output) => {
      dbg("command.execute.before command=", cmd.command)
      if (cmd.command !== "voice" && cmd.command !== "mute") return
      const m = getMode(cmd.sessionID)
      dbg("  current mode active=", m.active)
      const text = cmd.command === "voice"
        ? m.active ? (deactivate(cmd.sessionID), "Voice off.") : (activate(cmd.sessionID) ? "Voice on." : "Voice unavailable — check API key and config.")
        : (deactivate(cmd.sessionID), "Voice muted.")
      dbg("  result:", text, "noReply=true")
      ;(output.parts as unknown[]).length = 0
      ;(output.parts as unknown[]).push({ type: "text", text } as never)
      output.noReply = true
    },

    "experimental.text.complete": async (_input, output) => {
      if (!cfg) return
      output.text = stripTags(output.text)
    },

    "experimental.chat.system.transform": async (_input, output) => {
      if (!cfg) return
      output.system.push(ENHANCE_SECTION)
      output.system.push(KATYA_TONE_GUIDE)
    },

    "chat.params": async (_input, output) => {
      if (!cfg) return
      if (!cfg.tagEmissionTempBoost) return
      const temp = output.temperature
      if (typeof temp !== "number") return
      output.temperature = Math.min(temp + cfg.tagEmissionTempDelta, TEMP_CEILING)
    },
  }
}
