import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { VoicePlugin, getMode, resetState, setV2Client } from "../../../src/voice/plugin"
import type { PluginInput, Hooks } from "@opencode-ai/plugin"

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

describe("B1-busy-transition — barge-in fires only on idle→busy, not busy→busy", () => {
  test("busy→busy (tool call continuation): barge-in does NOT fire, audio keeps playing", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const abortFn = mock((_p: { sessionID: string }) => Promise.resolve({}))
    setV2Client({ session: { abort: abortFn } })

    const m = getMode("S1")
    m.active = true
    m.playing = true

    // First busy — start of the response (audio already playing from text streaming)
    await hooks.event!(
      ev("session.status", {
        sessionID: "S1",
        status: { type: "busy" },
      }),
    )
    await settle()

    // Second busy — tool call continuation (busy→busy, no idle in between)
    await hooks.event!(
      ev("session.status", {
        sessionID: "S1",
        status: { type: "busy" },
      }),
    )
    await settle()

    // Barge-in should NOT have fired on either busy (no idle→busy transition)
    expect(abortFn).not.toHaveBeenCalled()
    expect(getMode("S1").playing).toBe(true)
  })

  test("idle→busy (new message): barge-in DOES fire, audio stops", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const abortFn = mock((_p: { sessionID: string }) => Promise.resolve({}))
    setV2Client({ session: { abort: abortFn } })

    const m = getMode("S1")
    m.active = true
    m.playing = true

    // Session goes idle (previous response completed)
    await hooks.event!(
      ev("session.status", {
        sessionID: "S1",
        status: { type: "idle" },
      }),
    )
    await settle()

    // New message starts (idle→busy)
    await hooks.event!(
      ev("session.status", {
        sessionID: "S1",
        status: { type: "busy" },
      }),
    )
    await settle()

    // Barge-in SHOULD have fired — audio stops without aborting new generation
    expect(abortFn).not.toHaveBeenCalled()
    expect(getMode("S1").playing).toBe(false)
  })

  test("voice inactive: barge-in does NOT fire on repeated busy events", async () => {
    await load({ voiceId: "vX" })
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const abortFn = mock((_p: { sessionID: string }) => Promise.resolve({}))
    setV2Client({ session: { abort: abortFn } })

    const m = getMode("S1")
    m.active = false
    m.playing = false

    for (let i = 0; i < 3; i++) {
      await hooks.event!(
        ev("session.status", {
          sessionID: "S1",
          status: { type: "busy" },
        }),
      )
      await settle()
    }

    expect(abortFn).not.toHaveBeenCalled()
    expect(getMode("S1").playing).toBe(false)
  })

  test("not playing (m.playing = false): barge-in does NOT fire on busy", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const hooks = await VoicePlugin(STUB)
    await hooks.config!({ voice: { voiceId: "vX" } } as any)

    const abortFn = mock((_p: { sessionID: string }) => Promise.resolve({}))
    setV2Client({ session: { abort: abortFn } })

    const m = getMode("S1")
    m.active = true
    m.playing = false

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
})
