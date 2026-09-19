import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { VoicePlugin, getMode, resetState, setV2Client } from "../../../src/voice/plugin"
import type { PluginInput, Hooks } from "@foxybear/plugin"

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

async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
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

describe("B1-bargeIn — correct barge-in does not abort new generation", () => {
  test("barge-in does NOT call session.abort when session goes busy", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const abortFn = mock((_p: { sessionID: string }) => Promise.resolve({}))
    setV2Client({ session: { abort: abortFn } })

    const m = getMode("S1")
    m.active = true
    m.playing = true

    await hooks.event!(
      ev("session.status", {
        sessionID: "S1",
        status: { type: "busy" },
      }),
    )
    await settle()

    expect(abortFn).not.toHaveBeenCalled()
  })

  test("barge-in still sets m.playing to false", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const abortFn = mock((_p: { sessionID: string }) => Promise.resolve({}))
    setV2Client({ session: { abort: abortFn } })

    const m = getMode("S1")
    m.active = true
    m.playing = true

    await hooks.event!(
      ev("session.status", {
        sessionID: "S1",
        status: { type: "idle" },
      }),
    )
    await hooks.event!(
      ev("session.status", {
        sessionID: "S1",
        status: { type: "busy" },
      }),
    )
    await settle()

    expect(getMode("S1").playing).toBe(false)
  })

  test("no barge-in when m.playing is false", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const abortFn = mock((_p: { sessionID: string }) => Promise.resolve({}))
    setV2Client({ session: { abort: abortFn } })

    getMode("S1").active = true
    getMode("S1").playing = false

    await hooks.event!(
      ev("session.status", {
        sessionID: "S1",
        status: { type: "busy" },
      }),
    )
    await settle()

    expect(abortFn).not.toHaveBeenCalled()
    expect(getMode("S1").playing).toBe(false)
  })

  test("no barge-in when voice inactive", async () => {
    await load({ voiceId: "vX" })
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const abortFn = mock(() => Promise.resolve({}))
    setV2Client({ session: { abort: abortFn } })

    await hooks.event!(
      ev("session.status", {
        sessionID: "S1",
        status: { type: "busy" },
      }),
    )
    await settle()

    expect(abortFn).not.toHaveBeenCalled()
  })
})
