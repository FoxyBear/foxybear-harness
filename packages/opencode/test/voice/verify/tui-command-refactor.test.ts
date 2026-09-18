import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  VoicePlugin,
  getMode,
  resetState,
  setV2Client,
} from "../../../src/voice/plugin"
import * as VoiceMod from "../../../src/voice/plugin"
import { HarnessCommands } from "../../../src/harness/commands"
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

async function load(voice?: Record<string, unknown>): Promise<Hooks> {
  resetState()
  const hooks = await VoicePlugin(STUB)
  if (voice !== undefined) {
    await hooks.config!({ voice } as any)
  }
  return hooks
}

const toggle = (sessionID: string): string => (VoiceMod as any).toggle(sessionID)
const mute = (sessionID: string): string => (VoiceMod as any).mute(sessionID)

beforeEach(() => {
  resetState()
  delete process.env.ELEVENLABS_API_KEY
})

afterEach(() => {
  resetState()
  setV2Client(null)
  delete process.env.ELEVENLABS_API_KEY
})

describe("R1 — plugin exports toggle and mute functions", () => {
  test("toggle is exported and is a function", () => {
    expect(typeof (VoiceMod as any).toggle).toBe("function")
  })

  test("mute is exported and is a function", () => {
    expect(typeof (VoiceMod as any).mute).toBe("function")
  })
})

describe("R2 — toggle flips state", () => {
  test("toggle activates an inactive session", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    toggle("S1")
    expect(getMode("S1").active).toBe(true)
  })

  test("toggle deactivates an active session", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    toggle("S1")
    expect(getMode("S1").active).toBe(true)
    toggle("S1")
    expect(getMode("S1").active).toBe(false)
  })
})

describe("R3 — toggle returns confirmation strings", () => {
  test("returns 'Voice on.' when activating", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    const result = toggle("S1")
    expect(result).toBe("Voice on.")
  })

  test("returns 'Voice off.' when deactivating", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    toggle("S1")
    const result = toggle("S1")
    expect(result).toBe("Voice off.")
  })
})

describe("R4 — mute deactivates", () => {
  test("mute deactivates an active session", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    toggle("S1")
    expect(getMode("S1").active).toBe(true)
    mute("S1")
    expect(getMode("S1").active).toBe(false)
  })
})

describe("R5 — mute returns 'Voice muted.'", () => {
  test("always returns 'Voice muted.'", async () => {
    await load({ voiceId: "vX" })
    process.env.ELEVENLABS_API_KEY = "k"
    toggle("S1")
    const result = mute("S1")
    expect(result).toBe("Voice muted.")
  })
})

describe("R6 — plugin Hooks do NOT expose voice.toggle/voice.mute tools", () => {
  test("tool hook does not contain voice.toggle", async () => {
    const hooks = await VoicePlugin(STUB)
    expect(hooks.tool?.["voice.toggle"]).toBeUndefined()
  })

  test("tool hook does not contain voice.mute", async () => {
    const hooks = await VoicePlugin(STUB)
    expect(hooks.tool?.["voice.mute"]).toBeUndefined()
  })

  test("tool hook is absent or has no voice entries", async () => {
    const hooks = await VoicePlugin(STUB)
    if (hooks.tool) {
      const keys = Object.keys(hooks.tool)
      expect(keys).not.toContain("voice.toggle")
      expect(keys).not.toContain("voice.mute")
    }
  })
})

describe("R7 — plugin Hooks do NOT have command.execute.before for voice/mute", () => {
  test("command.execute.before is absent or no-op for voice", async () => {
    const hooks = await VoicePlugin(STUB)
    const hook = hooks["command.execute.before"]
    if (!hook) return
    const output: { parts: any[]; noReply?: boolean } = { parts: [] }
    await hook({ command: "voice", sessionID: "S1", arguments: "" }, output)
    expect(output.noReply).toBeUndefined()
    expect(output.parts.length).toBe(0)
  })

  test("command.execute.before is absent or no-op for mute", async () => {
    const hooks = await VoicePlugin(STUB)
    const hook = hooks["command.execute.before"]
    if (!hook) return
    const output: { parts: any[]; noReply?: boolean } = { parts: [] }
    await hook({ command: "mute", sessionID: "S1", arguments: "" }, output)
    expect(output.noReply).toBeUndefined()
    expect(output.parts.length).toBe(0)
  })
})

describe("R8 — harness command 'status' renamed to 'daemon'", () => {
  test("HarnessCommands.all() contains a command named 'daemon'", () => {
    const all = HarnessCommands.all()
    const names = all.map((c) => c.name)
    expect(names).toContain("daemon")
  })

  test("HarnessCommands.all() does NOT contain a command named 'status'", () => {
    const all = HarnessCommands.all()
    const names = all.map((c) => c.name)
    expect(names).not.toContain("status")
  })
})
