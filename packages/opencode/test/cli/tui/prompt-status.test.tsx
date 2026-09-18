/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createEffect, onMount } from "solid-js"
import type { Provider, Agent, Model } from "@opencode-ai/sdk/v2"
import { useContext } from "../../../src/cli/cmd/tui/util/context"
import { useLocal } from "../../../src/cli/cmd/tui/context/local"
import { useSync } from "../../../src/cli/cmd/tui/context/sync"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider } from "../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { LocalProvider } from "../../../src/cli/cmd/tui/context/local"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"

const sighup = new Set(process.listeners("SIGHUP"))

afterEach(() => {
  for (const fn of process.listeners("SIGHUP")) {
    if (!sighup.has(fn)) process.off("SIGHUP", fn)
  }
})

function json(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
}

const agent: Agent = {
  name: "build",
  mode: "primary",
  permission: [],
  options: {},
}

function model(id: string, name: string, context: number): Model {
  return {
    id,
    providerID: "test",
    name,
    api: { id: "test", url: "", npm: "" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: true,
    },
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    limit: { context, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2024-01-01",
  }
}

const providers: Provider[] = [
  {
    id: "test",
    name: "Test",
    source: "env",
    env: [],
    options: {},
    models: {
      "model-a": model("model-a", "Model A", 200_000),
      "model-b": model("model-b", "Model B", 100_000),
    },
  },
]

function createFetch() {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      const url = new URL(req.url)

      if (url.pathname === "/config/providers") return json({ providers, default: { test: "model-a" } })
      if (url.pathname === "/provider") return json({ all: [], default: {}, connected: [] })
      if (url.pathname === "/experimental/console") return json({})
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === "/config") return json({})
      if (url.pathname === "/project/current") return json({ id: "proj-1" })
      if (url.pathname === "/path")
        return json({ state: "/tmp/state", config: "/tmp/config", worktree: "/tmp/wt", directory: "/tmp/root" })
      if (url.pathname === "/session") return json([])
      if (url.pathname === "/command") return json([])
      if (url.pathname === "/lsp") return json([])
      if (url.pathname === "/mcp") return json({})
      if (url.pathname === "/experimental/resource") return json({})
      if (url.pathname === "/formatter") return json([])
      if (url.pathname === "/session/status") return json({})
      if (url.pathname === "/provider/auth") return json({})
      if (url.pathname === "/vcs") return json({ branch: "main" })
      if (url.pathname === "/experimental/workspace") return json([])

      throw new Error(`unexpected: ${url.pathname}`)
    },
    { preconnect: fetch.preconnect.bind(fetch) },
  ) satisfies typeof fetch
}

function createEventSource() {
  return {
    source: {
      subscribe: async () => () => {},
    },
  }
}

async function wait(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

type Ctx = ReturnType<ReturnType<typeof useContext>>

async function mount(sid: () => string | undefined) {
  let sync!: ReturnType<typeof useSync>
  let local!: ReturnType<typeof useLocal>
  let ctxResult: Ctx | undefined
  let ctxFired = false
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <SDKProvider
      url="http://test"
      directory="/tmp/root"
      fetch={createFetch()}
      events={createEventSource().source as never}
    >
      <ArgsProvider continue={false}>
        <ExitProvider>
          <KVProvider>
            <ToastProvider>
              <TuiConfigProvider config={{} as never}>
                <ProjectProvider>
                  <SyncProvider>
                    <ThemeProvider mode="dark">
                      <LocalProvider>
                        <Probe
                          sid={sid}
                          onReady={(s, l) => {
                            sync = s
                            local = l
                            done()
                          }}
                          onCtx={(v) => {
                            ctxResult = v
                            ctxFired = true
                          }}
                        />
                      </LocalProvider>
                    </ThemeProvider>
                  </SyncProvider>
                </ProjectProvider>
              </TuiConfigProvider>
            </ToastProvider>
          </KVProvider>
        </ExitProvider>
      </ArgsProvider>
    </SDKProvider>
  ))

  await ready
  await wait(() => sync.status === "complete")
  await wait(() => ctxFired)
  return { app, sync, local, getCtx: () => ctxResult }
}

function Probe(props: {
  sid: () => string | undefined
  onReady: (sync: ReturnType<typeof useSync>, local: ReturnType<typeof useLocal>) => void
  onCtx: (value: Ctx | undefined) => void
}) {
  const sync = useSync()
  const local = useLocal()
  const ctx = useContext(props.sid)

  createEffect(() => props.onCtx(ctx()))
  onMount(() => props.onReady(sync, local))
  return <box />
}

function assistant(
  id: string,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  cost: number,
) {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant" as const,
    time: { created: 1, completed: 1 },
    parentID: "msg_0",
    modelID: "model-a",
    providerID: "test",
    mode: "normal",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost,
    tokens,
  }
}

function user(id: string) {
  return {
    id,
    sessionID: "ses_1",
    role: "user" as const,
    time: { created: 1 },
    agent: "build",
    model: { providerID: "test", modelID: "model-a" },
  }
}

describe("status bar — color thresholds", () => {
  test("muted color below 80%", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", { input: 20_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }, 0.5),
      ])
      await Bun.sleep(20)

      const ctx = getCtx()!
      expect(ctx.pct).toBe(12)
      expect(ctx.pct! < 80).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("warning color at 80%+", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", { input: 150_000, output: 8_000, reasoning: 2_000, cache: { read: 1_000, write: 0 } }, 0.5),
      ])
      await Bun.sleep(20)

      const ctx = getCtx()!
      expect(ctx.pct).toBe(80)
      expect(ctx.pct! >= 80).toBe(true)
      expect(ctx.pct! < 90).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("danger color at 90%+", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", { input: 170_000, output: 8_000, reasoning: 2_000, cache: { read: 1_000, write: 0 } }, 0.5),
      ])
      await Bun.sleep(20)

      const ctx = getCtx()!
      expect(ctx.pct).toBe(90)
      expect(ctx.pct! >= 90).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("hides cost when zero", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", { input: 20_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }, 0),
      ])
      await Bun.sleep(20)

      const ctx = getCtx()!
      expect(ctx.cost).toBe(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows tier indicator when tier event fires microcompact", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", { input: 150_000, output: 8_000, reasoning: 2_000, cache: { read: 1_000, write: 0 } }, 0.42),
      ])
      await Bun.sleep(20)

      const ctx = getCtx()!
      expect(ctx.pct).toBe(80)

      const set = sync.set as (key: string, subkey: string, value: unknown) => void
      set("tier", "ses_1", "microcompact")
      set("utilization", "ses_1", 0.81)
      await Bun.sleep(20)

      const data = sync.data as unknown as { tier: Record<string, string> }
      expect(data.tier.ses_1).toBe("microcompact")
    } finally {
      app.renderer.destroy()
    }
  })
})
