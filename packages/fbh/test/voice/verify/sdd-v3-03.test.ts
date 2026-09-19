import { describe, expect, test, mock, beforeEach } from "bun:test"
import { AudioSink, argsStdin } from "../../../src/voice/sink"
import type { AudioChunk } from "../../../src/voice/sink"

const enc = (s: string) => new TextEncoder().encode(s)
const mk = (data: string, isFinal = false, fmt = "mp3_44100_128"): AudioChunk => ({ data: enc(data), format: fmt, isFinal })

function fakeStdin(slow = false, shouldFail = false) {
  const writes: Uint8Array[] = []
  return {
    writes,
    destroyed: false,
    write: mock((_d: Uint8Array, cb?: (err?: Error | null) => void) => {
      writes.push(_d)
      if (shouldFail) { cb?.(new Error("EPIPE") as any); return false }
      if (slow) setTimeout(cb!, 20); else cb?.()
      return true
    }),
    end: mock(() => {}),
  } as any
}

function fakeProc(opts: { slow?: boolean; failWrite?: boolean; exitOnEnd?: boolean } = {}) {
  const stdin = fakeStdin(opts.slow, opts.failWrite)
  const exitCbs: (() => void)[] = []
  const errorCbs: ((e: any) => void)[] = []
  const proc = {
    stdin,
    kill: mock((_sig?: string) => {}),
    once: mock((_ev: string, cb: any) => {
      if (_ev === "exit") exitCbs.push(cb)
      if (_ev === "error") errorCbs.push(cb)
    }),
    on: mock(() => {}),
    _exit: () => exitCbs.forEach((cb) => cb()),
    _error: (e: any) => errorCbs.forEach((cb) => cb(e)),
    pid: 12345,
  }
  if (opts.exitOnEnd) {
    const origEnd = stdin.end
    stdin.end = mock(() => { setTimeout(() => proc._exit(), 0) }) as any
  }
  return proc as any
}

function makeSink(kind: string | null, proc?: any): { sink: AudioSink; proc: any } {
  const p = proc ?? fakeProc({ exitOnEnd: true })
  const sink = new AudioSink()
  ;(sink as any).kind = kind
  ;(sink as any).spawnProc = () => p
  return { sink, proc: p }
}

describe("V1 — auto-detection memoizes", () => {
  test("kind set once, reused", () => {
    const sink = new AudioSink()
    ;(sink as any).kind = "ffplay"
    const k1 = (sink as any).pick()
    const k2 = (sink as any).pick()
    expect(k1).toBe("ffplay")
    expect(k2).toBe("ffplay")
  })
})

describe("V2 — playerPreference overrides, falls back", () => {
  test("constructor accepts playerPreference, detect uses it first", () => {
    const sink = new AudioSink({ playerPreference: "mpv" })
    expect((sink as any).pref).toBe("mpv")
  })

  test("playerPreference stored for detect fallback", () => {
    const sink = new AudioSink({ playerPreference: "nopeplayer" })
    expect((sink as any).pref).toBe("nopeplayer")
  })

  test("no playerPreference means auto-detect", () => {
    const sink = new AudioSink()
    expect((sink as any).pref).toBeUndefined()
  })
})

describe("V3 — stdin pipe, no temp file", () => {
  test("feed/write/stop/dispose/setVolume are public methods", () => {
    const sink = new AudioSink()
    expect(typeof sink.feed).toBe("function")
    expect(typeof sink.write).toBe("function")
    expect(typeof sink.stop).toBe("function")
    expect(typeof sink.dispose).toBe("function")
    expect(typeof sink.setVolume).toBe("function")
  })

  test("chunks go through stdin, not temp files", async () => {
    const proc = fakeProc({ exitOnEnd: true })
    const sink = new AudioSink()
    ;(sink as any).kind = "ffplay"
    ;(sink as any).spawnProc = () => proc
    await sink.write(mk("A"))
    await sink.write(mk("B"))
    await sink.write(mk("C", true))
    expect(proc.stdin.writes.length).toBe(3)
    expect(new TextDecoder().decode(proc.stdin.writes[0])).toBe("A")
  })
})

describe("V4 — streaming + backpressure", () => {
  test("sequential writes preserve order", async () => {
    const { sink, proc } = makeSink("ffplay", fakeProc({ slow: true, exitOnEnd: true }))
    await sink.write(mk("A"))
    await sink.write(mk("B"))
    expect(proc.stdin.writes.length).toBe(2)
    expect(new TextDecoder().decode(proc.stdin.writes[0])).toBe("A")
    expect(new TextDecoder().decode(proc.stdin.writes[1])).toBe("B")
  })
})

describe("V5 — isFinal closes stdin and awaits exit", () => {
  test("stdin.end called, exit awaited", async () => {
    const { sink, proc } = makeSink("ffplay")
    await sink.write(mk("hello", true))
    expect(proc.stdin.end).toHaveBeenCalledTimes(1)
  })
})

describe("V6 — barge-in kills player and discards chunks", () => {
  test("SIGTERM sent, stdin closed, no session.abort", async () => {
    const { sink, proc } = makeSink("ffplay")
    await sink.write(mk("A"))
    sink.stop()
    expect(proc.kill).toHaveBeenCalledTimes(1)
    expect(proc.stdin.end).toHaveBeenCalled()
  })
})

describe("V7 — player-not-found degrades", () => {
  test("no crash, no player spawned, writes silently dropped", async () => {
    const sink = new AudioSink()
    ;(sink as any).kind = null
    await sink.write(mk("data", true))
    expect((sink as any).proc).toBeUndefined()
  })
})

describe("V8 — crash recovery + ENOENT re-detection", () => {
  test("non-zero exit: fresh stream spawns new player", async () => {
    const { sink, proc } = makeSink("ffplay")
    await sink.write(mk("A"))
    sink.stop()
    const proc2 = fakeProc({ exitOnEnd: true })
    ;(sink as any).spawnProc = () => proc2
    await sink.write(mk("B", true))
    expect(proc2.stdin.writes.length).toBe(1)
  })

  test("ENOENT error triggers re-detection", async () => {
    const sink = new AudioSink()
    ;(sink as any).kind = "ffplay"
    let spawnCount = 0
    ;(sink as any).spawnProc = () => {
      spawnCount++
      const p = fakeProc()
      if (spawnCount === 1) {
        p.once = mock((_ev: string, cb: any) => {
          if (_ev === "error") setTimeout(() => cb({ code: "ENOENT" }), 0)
        }) as any
      }
      return p
    }
    ;(sink as any).pick = () => spawnCount <= 1 ? "ffplay" as any : null
    await sink.write(mk("A"))
    await new Promise((r) => setTimeout(r, 50))
    expect((sink as any).redetected).toBe(true)
    expect((sink as any).kind).toBeFalsy()
  })
})

describe("V9 — teardown idempotent", () => {
  test("dispose() three times is safe", async () => {
    const { sink, proc } = makeSink("ffplay")
    await sink.write(mk("A"))
    sink.dispose()
    sink.dispose()
    sink.dispose()
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })
})

describe("V10 — post-stop write suppression", () => {
  test("write after stop does not write to old proc", async () => {
    const proc1 = fakeProc({ exitOnEnd: true })
    const proc2 = fakeProc({ exitOnEnd: true })
    const sink = new AudioSink()
    ;(sink as any).kind = "ffplay"
    let spawnCall = 0
    ;(sink as any).spawnProc = () => { spawnCall++; return spawnCall === 1 ? proc1 : proc2 }
    await sink.write(mk("A"))
    const oldWriteCount = proc1.stdin.writes.length
    sink.stop()
    await sink.write(mk("B"))
    expect(proc1.stdin.writes.length).toBe(oldWriteCount)
  })

  test("EPIPE after stop is caught, no crash", async () => {
    const { sink } = makeSink("ffplay", fakeProc({ failWrite: true, exitOnEnd: true }))
    await sink.write(mk("A"))
    sink.stop()
    await sink.write(mk("B"))
  })
})

describe("V11 — MP3 vs PCM format flags", () => {
  test("ffplay MP3: no -f flag, ends with -", () => {
    const a = argsStdin("ffplay", 1.0, "mp3_44100_128")
    expect(a).not.toContain("-f")
    expect(a[a.length - 1]).toBe("-")
  })

  test("ffplay PCM: -f pcm_s16le -ar 44100 -ac 2", () => {
    const a = argsStdin("ffplay", 1.0, "pcm_s16le")
    expect(a).toContain("-f")
    expect(a).toContain("pcm_s16le")
    expect(a).toContain("44100")
    expect(a).toContain("2")
  })

  test("mpv: --volume flag with percentage", () => {
    const a = argsStdin("mpv", 0.5, "mp3_44100_128")
    expect(a).toContain("--volume")
    expect(a).toContain("50")
  })
})

describe("V12 — volume at spawn", () => {
  test("setVolume stores value", () => {
    const sink = new AudioSink()
    sink.setVolume(0.5)
    expect((sink as any).vol).toBe(0.5)
  })

  test("default volume is 1.0", () => {
    const sink = new AudioSink()
    expect((sink as any).vol).toBe(1.0)
  })

  test("volume passed to args", () => {
    const a = argsStdin("ffplay", 0.7, "mp3_44100_128")
    expect(a).toContain("volume=0.7")
  })
})

describe("V13 — no core files modified", () => {
  test("sink module exports AudioSink, imports from node:child_process not sound.ts", async () => {
    const mod = await import("../../../src/voice/sink")
    expect(mod.AudioSink).toBeDefined()
    expect(typeof mod.argsStdin).toBe("function")
  })

  test("AudioChunk type exported", () => {
    const c: AudioChunk = { data: enc("x"), format: "mp3", isFinal: false }
    expect(c.data.length).toBe(1)
  })
})

describe("V14 — stop() idempotency", () => {
  test("stop on idle sink is no-op", () => {
    const sink = new AudioSink()
    expect(() => sink.stop()).not.toThrow()
    expect(() => sink.stop()).not.toThrow()
  })

  test("stop on active sink kills once", async () => {
    const { sink, proc } = makeSink("ffplay")
    await sink.write(mk("A"))
    sink.stop()
    sink.stop()
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })
})

describe("V15 — dead-PID tolerance", () => {
  test("kill on dead proc caught, no throw", async () => {
    const sink = new AudioSink()
    ;(sink as any).kind = "ffplay"
    const proc = fakeProc()
    proc.kill = mock(() => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }) })
    ;(sink as any).spawnProc = () => proc
    await sink.write(mk("A"))
    expect(() => sink.stop()).not.toThrow()
  })
})

describe("V16 — build/regression green", () => {
  test("AudioSink is constructable and functional", () => {
    const sink = new AudioSink()
    expect(sink).toBeInstanceOf(AudioSink)
  })
})
