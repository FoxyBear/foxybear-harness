/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createEffect, onMount } from "solid-js"
import type { Provider, Agent, Model } from "@foxybear/sdk/v2"
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
    name: "Test Provider",
    source: "env",
    env: [],
    options: {},
    models: {
      "model-a": model("model-a", "Model A", 200_000),
      "model-b": model("model-b", "Model B", 1_000_000),
      "model-c": model("model-c", "Model C", 256_000),
      "model-zero": model("model-zero", "Model Zero", 0),
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
      subscribe: async (handler: (event: unknown) => void) => {
        return () => {}
      },
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
  await wait(() => ctxFired, 5000)
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

  createEffect(() => {
    props.onCtx(ctx())
  })

  onMount(() => props.onReady(sync, local))
  return <box />
}

function assistant(
  id: string,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number }; total?: number },
  cost: number,
  modelID = "model-a",
) {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant" as const,
    time: { created: 1, completed: 1 },
    parentID: "msg_0",
    modelID,
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

describe("useContext", () => {
  test("returns undefined when no session", async () => {
    const { app, getCtx } = await mount(() => undefined)

    try {
      expect(getCtx()).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("returns undefined when no messages", async () => {
    const { app, sync, local, getCtx } = await mount(() => "ses_empty")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      await Bun.sleep(20)
      expect(getCtx()).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("returns undefined when no assistant messages with tokens", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [user("u1")])
      await Bun.sleep(20)
      expect(getCtx()).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("sums tokens correctly (input + output + reasoning + cache)", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", {
          input: 10_000,
          output: 5_000,
          reasoning: 2_000,
          cache: { read: 8_000, write: 1_000 },
        }, 0),
      ])
      await Bun.sleep(20)

      const ctx = getCtx()
      expect(ctx).toBeDefined()
      expect(ctx!.tokens).toBe(26_000)
    } finally {
      app.renderer.destroy()
    }
  })

  test("uses tokens.total when present", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", {
          input: 10_000,
          output: 5_000,
          reasoning: 2_000,
          cache: { read: 8_000, write: 1_000 },
          total: 30_000,
        }, 0),
      ])
      await Bun.sleep(20)

      const ctx = getCtx()
      expect(ctx!.tokens).toBe(30_000)
    } finally {
      app.renderer.destroy()
    }
  })

  test("uses currently selected model's limit, not last message's model", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", {
          input: 10_000,
          output: 5_000,
          reasoning: 2_000,
          cache: { read: 8_000, write: 1_000 },
        }, 0, "model-b"),
      ])
      await Bun.sleep(20)

      const ctx = getCtx()
      expect(ctx!.limit).toBe(200_000)
      expect(ctx!.pct).toBe(13)
    } finally {
      app.renderer.destroy()
    }
  })

  test("updates on model switch", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", {
          input: 10_000,
          output: 5_000,
          reasoning: 2_000,
          cache: { read: 8_000, write: 1_000 },
        }, 0),
      ])
      await Bun.sleep(20)

      const ctx1 = getCtx()
      expect(ctx1!.limit).toBe(200_000)
      expect(ctx1!.pct).toBe(13)

      local.model.set({ providerID: "test", modelID: "model-c" })
      await Bun.sleep(20)

      const ctx2 = getCtx()
      expect(ctx2!.limit).toBe(256_000)
      expect(ctx2!.pct).toBe(10)
    } finally {
      app.renderer.destroy()
    }
  })

  test("handles unknown context limit (limit.context === 0)", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-zero" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", {
          input: 10_000,
          output: 5_000,
          reasoning: 2_000,
          cache: { read: 8_000, write: 1_000 },
        }, 0),
      ])
      await Bun.sleep(20)

      const ctx = getCtx()
      expect(ctx!.limit).toBe(0)
      expect(ctx!.pct).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("sums cost across all assistant messages", async () => {
    const { app, local, sync, getCtx } = await mount(() => "ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } }, 0.1),
        user("u2"),
        assistant("a2", { input: 2000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } }, 0.2),
        user("u3"),
        assistant("a3", { input: 3000, output: 1500, reasoning: 0, cache: { read: 0, write: 0 } }, 0.05),
      ])
      await Bun.sleep(20)

      const ctx = getCtx()
      expect(ctx!.cost).toBeCloseTo(0.35, 10)
    } finally {
      app.renderer.destroy()
    }
  })
})
