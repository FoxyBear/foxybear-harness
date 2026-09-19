/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { DialogContext } from "../../../src/cli/cmd/tui/component/dialog-context"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"
import { DialogProvider, useDialog } from "../../../src/cli/cmd/tui/ui/dialog"
import { CommandProvider, useCommandDialog } from "../../../src/cli/cmd/tui/component/dialog-command"

async function mount() {
  let command!: ReturnType<typeof useCommandDialog>
  let dialog!: ReturnType<typeof useDialog>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <KVProvider>
      <ToastProvider>
        <TuiConfigProvider config={{} as never}>
          <KeybindProvider>
            <DialogProvider>
              <CommandProvider>
                <Probe
                  onReady={(cmd, dlg) => {
                    command = cmd
                    dialog = dlg
                    done()
                  }}
                />
              </CommandProvider>
            </DialogProvider>
          </KeybindProvider>
        </TuiConfigProvider>
      </ToastProvider>
    </KVProvider>
  ))

  await ready
  return { app, command, dialog }
}

function Probe(props: {
  onReady: (
    command: ReturnType<typeof useCommandDialog>,
    dialog: ReturnType<typeof useDialog>,
  ) => void
}) {
  const command = useCommandDialog()
  const dialog = useDialog()
  onMount(() => props.onReady(command, dialog))
  return <box />
}

function contextCommand(sessionID: string) {
  return {
    title: "Context usage",
    value: "session.context",
    keybind: "session_context",
    category: "Session",
    slash: { name: "context" },
    onSelect: (dlg: ReturnType<typeof useDialog>) => {
      dlg.replace(() => <DialogContext sessionID={sessionID} />)
    },
  }
}

describe("/context command", () => {
  test("appears in slash autocomplete", async () => {
    const { app, command } = await mount()

    try {
      command.register(() => [contextCommand("ses_1")])
      await Bun.sleep(20)

      const slashes = command.slashes()
      const ctx = slashes.find((s) => s.display === "/context")
      expect(ctx).toBeDefined()
      expect(ctx!.display).toBe("/context")
    } finally {
      app.renderer.destroy()
    }
  })

  test("appears in command dialog as 'Context usage'", async () => {
    const { app, command } = await mount()

    try {
      command.register(() => [contextCommand("ses_1")])
      await Bun.sleep(20)

      command.show()
      await Bun.sleep(20)

      const text = app.captureCharFrame()
      expect(text).toContain("Context usage")
    } finally {
      app.renderer.destroy()
    }
  })

  test("opens DialogContext when selected", async () => {
    const { app, command, dialog } = await mount()

    try {
      command.register(() => [contextCommand("ses_1")])
      await Bun.sleep(20)

      command.trigger("session.context")
      await Bun.sleep(20)

      expect(dialog.stack.length).toBeGreaterThan(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("has keybind session_context", async () => {
    const { app } = await mount()

    try {
      const cmd = contextCommand("ses_1")
      expect(cmd.keybind).toBe("session_context")
    } finally {
      app.renderer.destroy()
    }
  })
})
