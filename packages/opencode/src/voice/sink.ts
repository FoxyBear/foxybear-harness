import { spawn, type ChildProcess } from "node:child_process"
import { Log } from "../util/log"

const log = Log.create({ service: "voice.sink" })
const dbg = (...a: unknown[]) => process.stderr.write(`[VS] ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}\n`)

export type AudioChunk = {
  data: Uint8Array
  format: string
  isFinal: boolean
}

const LIST = [
  "ffplay",
  "mpv",
  "mpg123",
  "mpg321",
  "mplayer",
  "afplay",
  "play",
  "omxplayer",
  "aplay",
  "cmdmp3",
  "cvlc",
  "powershell.exe",
] as const

type Kind = (typeof LIST)[number]

function detect(preference?: string): Kind | null {
  dbg("detect preference=", preference)
  if (preference) {
    const r = Bun.spawnSync(["which", preference], { stdout: "ignore", stderr: "ignore" })
    if (r.exitCode === 0) {
      dbg("  preference found:", preference)
      return preference as Kind
    }
    dbg("  preference not on PATH, falling back")
    log.warn(`playerPreference "${preference}" not on PATH, falling back to auto-detect`)
  }
  for (const c of LIST) {
    const r = Bun.spawnSync(["which", c], { stdout: "ignore", stderr: "ignore" })
    if (r.exitCode === 0) {
      dbg("  auto-detected:", c)
      return c
    }
  }
  dbg("  no player found!")
  return null
}

export function argsStdin(kind: Kind, volume: number, format: string): string[] {
  const dash = "-"
  if (kind === "ffplay") {
    const base = [kind, "-autoexit", "-nodisp", "-af", `volume=${volume}`]
    if (format.startsWith("pcm")) return [...base, "-f", "pcm_s16le", "-ar", "44100", "-ac", "2", dash]
    return [...base, dash]
  }
  if (kind === "mpv") return [kind, "--no-video", "--audio-display=no", "--volume", String(Math.round(volume * 100)), dash]
  if (kind === "mpg123" || kind === "mpg321") return [kind, "-g", String(Math.round(volume * 100)), dash]
  if (kind === "mplayer") return [kind, "-vo", "null", "-volume", String(Math.round(volume * 100)), dash]
  if (kind === "afplay" || kind === "omxplayer" || kind === "aplay" || kind === "cmdmp3") return [kind, dash]
  if (kind === "play") return [kind, "-v", String(volume), dash]
  if (kind === "cvlc") return [kind, `--gain=${volume}`, "--play-and-exit", dash]
  return [kind, "-c", `(New-Object Media.SoundPlayer '${dash}').PlaySync()`]
}

export class AudioSink {
  private kind: Kind | null | undefined
  private proc: ChildProcess | undefined
  private gen = 0
  private vol = 1.0
  private fmt = ""
  private warned = false
  private redetected = false
  private pref?: string

  constructor(opts?: { playerPreference?: string }) {
    this.pref = opts?.playerPreference
  }

  setVolume(v: number) {
    this.vol = v
  }

  private pick(): Kind | null {
    if (this.kind !== undefined) return this.kind
    this.kind = detect(this.pref)
    if (!this.kind && !this.warned) {
      this.warned = true
      log.warn("no audio player found")
    }
    return this.kind
  }

  private spawnProc(): ChildProcess | undefined {
    const k = this.pick()
    dbg("spawnProc kind=", k, "vol=", this.vol, "fmt=", this.fmt)
    if (!k) return
    const a = argsStdin(k, this.vol, this.fmt)
    dbg("  args:", a.join(" "))
    const p = spawn(a[0], a.slice(1), { stdio: ["pipe", "ignore", "ignore"] })
    dbg("  spawned pid=", p.pid)
    return p
  }

  async feed(chunks: AsyncIterable<AudioChunk>): Promise<void> {
    const my = this.gen
    if (!this.fmt) {
      for await (const c of chunks) {
        if (my !== this.gen) return
        this.fmt = c.format
        await this.writeChunk(c, my)
        if (c.isFinal) return
      }
      return
    }
    for await (const c of chunks) {
      if (my !== this.gen) return
      await this.writeChunk(c, my)
      if (c.isFinal) return
    }
  }

  async write(chunk: AudioChunk): Promise<void> {
    dbg("write dataLen=", chunk.data.length, "fmt=", chunk.format, "isFinal=", chunk.isFinal, "gen=", this.gen)
    await this.writeChunk(chunk, this.gen)
  }

  private async writeChunk(chunk: AudioChunk, gen: number): Promise<void> {
    if (gen !== this.gen) {
      dbg("  writeChunk DROPPED gen mismatch gen=", gen, "this.gen=", this.gen)
      return
    }
    if (!this.fmt) this.fmt = chunk.format
    if (!this.proc) {
      dbg("  no proc, spawning...")
      try {
        this.proc = this.spawnProc()
      } catch (e) {
        dbg("  spawn threw:", String(e))
        this.handleSpawnFail()
        if (!this.proc) return
      }
      if (this.proc) {
        this.proc.once("error", (e: NodeJS.ErrnoException) => {
          dbg("  proc error event:", e.code)
          if (e.code === "ENOENT") this.handleSpawnFail()
          this.proc = undefined
        })
      }
    }
    if (!this.proc?.stdin) {
      dbg("  no stdin available")
      return
    }
    try {
      await new Promise<void>((res, rej) => {
        if (gen !== this.gen) return res()
        const stdin = this.proc?.stdin
        if (!stdin || stdin.destroyed) return res()
        stdin.write(chunk.data, (err) => (err ? rej(err) : res()))
      })
      dbg("  wrote", chunk.data.length, "bytes to stdin OK")
    } catch (e: any) {
      if (e?.code === "EPIPE" || e?.code === "ERR_STREAM_DESTROYED") {
        dbg("  EPIPE/DESTROYED caught, ignoring")
        return
      }
      dbg("  write error:", e?.message)
      log.error("stdin write failed", { error: e?.message })
    }
    if (gen !== this.gen) return
    if (chunk.isFinal) {
      dbg("  isFinal — closing stdin, awaiting exit")
      try { this.proc?.stdin?.end() } catch {}
      try { await this.waitExit() } catch {}
      this.proc = undefined
      dbg("  proc exited, cleared")
    }
  }

  stop() {
    dbg("stop gen++", this.gen + 1, "hasProc=", !!this.proc)
    this.gen++
    try { this.proc?.stdin?.end() } catch {}
    try { this.proc?.kill("SIGTERM") } catch {}
    this.proc = undefined
  }

  dispose() {
    this.stop()
  }

  private handleSpawnFail() {
    if (this.redetected) return
    this.redetected = true
    this.kind = undefined
    this.pick()
  }

  private waitExit(): Promise<void> {
    return new Promise((res) => {
      if (!this.proc) return res()
      const p = this.proc
      p.once("exit", () => res())
      p.once("error", () => res())
    })
  }
}
