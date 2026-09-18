/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import type { Provider, Agent, Model } from "@opencode-ai/sdk/v2"
import { DialogContext } from "../../../src/cli/cmd/tui/component/dialog-context"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { LocalProvider, useLocal } from "../../../src/cli/cmd/tui/context/local"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { DialogProvider, useDialog } from "../../../src/cli/cmd/tui/ui/dialog"
import { CommandProvider } from "../../../src/cli/cmd/tui/component/dialog-command"

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
      "model-a": model("model-a", "Claude Sonnet 5", 1_000_000),
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

async function mount(sessionID: string) {
  let sync!: ReturnType<typeof useSync>
  let local!: ReturnType<typeof useLocal>
  let dialog!: ReturnType<typeof useDialog>
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
                        <KeybindProvider>
                          <DialogProvider>
                            <CommandProvider>
                              <Probe
                                onReady={(s, l, d) => {
                                  sync = s
                                  local = l
                                  dialog = d
                                  done()
                                }}
                                sessionID={sessionID}
                              />
                            </CommandProvider>
                          </DialogProvider>
                        </KeybindProvider>
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
  return { app, sync, local, dialog }
}

function Probe(props: {
  sessionID: string
  onReady: (
    sync: ReturnType<typeof useSync>,
    local: ReturnType<typeof useLocal>,
    dialog: ReturnType<typeof useDialog>,
  ) => void
}) {
  const sync = useSync()
  const local = useLocal()
  const dialog = useDialog()

  onMount(() => {
    dialog.replace(() => <DialogContext sessionID={props.sessionID} />)
    props.onReady(sync, local, dialog)
  })
  return <box />
}

type TestApp = Awaited<ReturnType<typeof testRender>>

function frame(app: TestApp) {
  return app.captureCharFrame()
}

describe("DialogContext", () => {
  test("renders model name and limit", async () => {
    const { app, local, sync } = await mount("ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", { input: 100_000, output: 50_000, reasoning: 10_000, cache: { read: 40_000, write: 5_000 } }, 0.42),
      ])
      await Bun.sleep(50)

      const text = frame(app)
      expect(text).toContain("Claude Sonnet 5")
      expect(text).toContain("1,000,000")
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows used/remaining tokens and percentage", async () => {
    const { app, local, sync } = await mount("ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", { input: 100_000, output: 50_000, reasoning: 10_000, cache: { read: 40_000, write: 5_000 } }, 0.42),
      ])
      await Bun.sleep(50)

      const text = frame(app)
      expect(text).toContain("205,000")
      expect(text).toContain("20")
      expect(text).toContain("795,000")
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows breakdown with non-negative integers", async () => {
    const { app, local, sync } = await mount("ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", { input: 100_000, output: 50_000, reasoning: 10_000, cache: { read: 40_000, write: 5_000 } }, 0.42),
      ])
      await Bun.sleep(50)

      const text = frame(app)
      expect(text).toContain("Breakdown")
      expect(text).toMatch(/\d+/)
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows recent messages", async () => {
    const { app, local, sync } = await mount("ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", { input: 100_000, output: 50_000, reasoning: 10_000, cache: { read: 40_000, write: 5_000 } }, 0.42),
        user("u2"),
        assistant("a2", { input: 120_000, output: 30_000, reasoning: 5_000, cache: { read: 20_000, write: 3_000 } }, 0.1),
      ])
      await Bun.sleep(50)

      const text = frame(app)
      expect(text).toContain("assistant")
      expect(text).toContain("user")
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows compaction status", async () => {
    const { app, local, sync } = await mount("ses_1")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      sync.set("message", "ses_1", [
        user("u1"),
        assistant("a1", { input: 100_000, output: 50_000, reasoning: 10_000, cache: { read: 40_000, write: 5_000 } }, 0.42),
      ])
      sync.set("config", { compaction: { auto: true } })
      await Bun.sleep(50)

      const text = frame(app)
      expect(text.toLowerCase()).toMatch(/compaction|enabled|disabled/)
    } finally {
      app.renderer.destroy()
    }
  })

  test("handles empty session", async () => {
    const { app, local, sync } = await mount("ses_empty")

    try {
      local.model.set({ providerID: "test", modelID: "model-a" })
      await Bun.sleep(50)

      const text = frame(app)
      expect(text.length).toBeGreaterThan(0)
    } finally {
      app.renderer.destroy()
    }
  })
})
