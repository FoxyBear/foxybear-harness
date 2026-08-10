import { describe, expect, test, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import * as fs from "fs/promises"
import os from "os"
import path from "path"

import { VoiceRoutes } from "../../../src/server/instance/voice"
import { InstanceRoutes } from "../../../src/server/instance/index"
import { ErrorMiddleware } from "../../../src/server/middleware"
import { VoicePlugin, resetState, getMode } from "../../../src/voice/plugin"
import { Session } from "../../../src/session"
import { Instance } from "../../../src/project/instance"
import type { PluginInput } from "@opencode-ai/plugin"

const STUB = {
  client: {},
  project: { id: "t", worktree: "/tmp", time: { created: 0, updated: 0 } },
  directory: "/tmp",
  worktree: "/tmp",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost:4096"),
  $: {},
} as unknown as PluginInput

const APP_PATH = path.join(__dirname, "../../../src/cli/cmd/tui/app.tsx")

let dir: string

beforeAll(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "voice-route-")))
})

afterAll(async () => {
  await Instance.provide({ directory: dir, fn: () => Instance.dispose() }).catch(() => {})
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  resetState()
})

afterEach(() => {
  resetState()
})

async function setupCfg() {
  const hooks = await VoicePlugin(STUB)
  await hooks.config!({ voice: { voiceId: "vX", apiKeyEnv: "test-key-12345" } } as any)
}

async function createSession(): Promise<string> {
  let id = ""
  await Instance.provide({
    directory: dir,
    fn: async () => {
      id = (await Session.create({})).id
    },
  })
  return id
}

function post(u: string, body: unknown): Request {
  return new Request(u, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("Voice HTTP Route", () => {
  test("VR1 — VoiceRoutes exports a Hono app with .fetch", () => {
    const app = VoiceRoutes()
    expect(app).toBeDefined()
    expect(typeof app.fetch).toBe("function")
  })

  test("VR2 — POST /toggle returns message and active", async () => {
    await setupCfg()
    const sid = await createSession()
    const res = await Instance.provide({
      directory: dir,
      fn: async () => VoiceRoutes().fetch(post("http://localhost/voice/toggle", { sessionID: sid })),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(typeof data.message).toBe("string")
    expect(typeof data.active).toBe("boolean")
  })

  test("VR3 — POST /toggle flips state", async () => {
    await setupCfg()
    const sid = await createSession()

    const r1 = await Instance.provide({
      directory: dir,
      fn: async () => VoiceRoutes().fetch(post("http://localhost/voice/toggle", { sessionID: sid })),
    })
    const d1 = await r1.json()
    expect(d1.active).toBe(true)
    expect(d1.message).toBe("Voice on.")

    const r2 = await Instance.provide({
      directory: dir,
      fn: async () => VoiceRoutes().fetch(post("http://localhost/voice/toggle", { sessionID: sid })),
    })
    const d2 = await r2.json()
    expect(d2.active).toBe(false)
    expect(d2.message).toBe("Voice off.")
  })

  test("VR4 — POST /mute on active session returns muted", async () => {
    await setupCfg()
    const sid = await createSession()

    await Instance.provide({
      directory: dir,
      fn: async () => VoiceRoutes().fetch(post("http://localhost/voice/toggle", { sessionID: sid })),
    })

    const res = await Instance.provide({
      directory: dir,
      fn: async () => VoiceRoutes().fetch(post("http://localhost/voice/mute", { sessionID: sid })),
    })
    const data = await res.json()
    expect(data.message).toBe("Voice muted.")
    expect(data.active).toBe(false)
  })

  test("VR5 — POST /mute on inactive session still returns muted", async () => {
    await setupCfg()
    const sid = await createSession()

    const res = await Instance.provide({
      directory: dir,
      fn: async () => VoiceRoutes().fetch(post("http://localhost/voice/mute", { sessionID: sid })),
    })
    const data = await res.json()
    expect(data.message).toBe("Voice muted.")
    expect(data.active).toBe(false)
  })

  test("VR6 — Route registered at /voice in InstanceRoutes", async () => {
    await setupCfg()
    const sid = await createSession()
    const mockUpgrade = (() => ({})) as unknown as UpgradeWebSocket
    const u = `http://localhost/voice/toggle?directory=${encodeURIComponent(dir)}`
    const res = await InstanceRoutes(mockUpgrade).fetch(post(u, { sessionID: sid }))
    expect(res.status).not.toBe(404)
  })

  test("VR7 — Invalid body returns 400", async () => {
    const res = await VoiceRoutes().fetch(post("http://localhost/voice/toggle", {}))
    expect(res.status).toBe(400)
  })

  test("VR8 — app.tsx no longer imports from @/voice/plugin", async () => {
    const source = await Bun.file(APP_PATH).text()
    expect(
      source.includes('import { toggle as voiceToggle, mute as voiceMute } from "@/voice/plugin"'),
    ).toBe(false)
  })

  test("VR9 — Nonexistent sessionID returns 404", async () => {
    await setupCfg()
    const app = new Hono().onError(ErrorMiddleware).route("/voice", VoiceRoutes())
    const res = await Instance.provide({
      directory: dir,
      fn: async () =>
        app.fetch(post("http://localhost/voice/toggle", { sessionID: "ses_nonexistent00000000000000" })),
    })
    expect(res.status).toBe(404)
  })

  test("VR10 — toggle is synchronous (state set before response)", async () => {
    await setupCfg()
    const sid = await createSession()
    const res = await Instance.provide({
      directory: dir,
      fn: async () => VoiceRoutes().fetch(post("http://localhost/voice/toggle", { sessionID: sid })),
    })
    const data = await res.json()
    expect(data.active).toBe(getMode(sid).active)
  })
})
