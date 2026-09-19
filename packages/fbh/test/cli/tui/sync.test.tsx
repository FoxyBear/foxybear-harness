/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, GlobalEvent } from "@foxybear/sdk/v2"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { ProjectProvider, useProject } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"

const sighup = new Set(process.listeners("SIGHUP"))

afterEach(() => {
  for (const fn of process.listeners("SIGHUP")) {
    if (!sighup.has(fn)) process.off("SIGHUP", fn)
  }
})

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

function createFetch() {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      const url = new URL(req.url)

      if (url.pathname === "/config/providers") return json({ providers: [], default: {} })
      if (url.pathname === "/provider") return json({ all: [], default: {}, connected: [] })
      if (url.pathname === "/experimental/console") return json({})
      if (url.pathname === "/agent") return json([])
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
  let fn: ((event: GlobalEvent) => void) | undefined
  return {
    source: {
      subscribe: async (handler: (event: GlobalEvent) => void) => {
        fn = handler
        return () => {
          if (fn === handler) fn = undefined
        }
      },
    },
    emit(evt: GlobalEvent) {
      if (!fn) throw new Error("not ready")
      fn(evt)
    },
  }
}

function wrap(payload: Event): GlobalEvent {
  return { directory: "/tmp/root", payload }
}

async function mount() {
  const source = createEventSource()
  let sync!: ReturnType<typeof useSync>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <SDKProvider
      url="http://test"
      directory="/tmp/root"
      fetch={createFetch()}
      events={source.source}
    >
      <ArgsProvider continue={false}>
        <ExitProvider>
          <ProjectProvider>
            <SyncProvider>
              <Probe
                onReady={(s) => {
                  sync = s
                  done()
                }}
              />
            </SyncProvider>
          </ProjectProvider>
        </ExitProvider>
      </ArgsProvider>
    </SDKProvider>
  ))

  await ready
  return { app, sync, emit: source.emit }
}

function Probe(props: { onReady: (sync: ReturnType<typeof useSync>) => void }) {
  const sync = useSync()
  onMount(() => props.onReady(sync))
  return <box />
}

describe("sync — session.tier_changed event", () => {
  test("updates store.tier and store.utilization from event", async () => {
    const { app, sync, emit } = await mount()

    try {
      const evt = wrap({
        type: "session.tier_changed",
        properties: {
          sessionID: "ses_1",
          previousTier: "none",
          newTier: "microcompact",
          utilization: 0.81,
          tieringEnabled: true,
        },
      } as unknown as Event)

      emit(evt)

      await wait(() => {
        const data = sync.data as unknown as { tier?: Record<string, string> }
        return data.tier?.ses_1 !== undefined
      })

      const data = sync.data as unknown as { tier: Record<string, string>; utilization: Record<string, number> }
      expect(data.tier.ses_1).toBe("microcompact")
      expect(data.utilization.ses_1).toBe(0.81)
    } finally {
      app.renderer.destroy()
    }
  })
})
