import { For, Show, createMemo, type JSX } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useContext } from "@tui/util/context"
import { Token } from "@/util/token"
import { isTieringEnabled, tier, type CompactionTier } from "@/session/overflow"
import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

export function DialogContext(props: { sessionID: string }): JSX.Element {
  const dialog = useDialog()

  let ctx: ReturnType<typeof useContext>
  let sync: ReturnType<typeof useSync>
  let local: ReturnType<typeof useLocal>
  let theme: ReturnType<typeof useTheme>["theme"]
  try {
    ctx = useContext(() => props.sessionID)
    sync = useSync()
    local = useLocal()
    theme = useTheme().theme
  } catch {
    return (
      <box paddingLeft={2} paddingRight={2}>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={1}>Context</text>
          <text onMouseUp={() => dialog.clear()}>esc</text>
        </box>
        <text>No messages yet</text>
      </box>
    )
  }

  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const model = createMemo(() => ctx()?.model)
  const provider = createMemo(() => {
    const m = model()
    if (!m) return undefined
    return sync.data.provider.find((p) => p.id === m.providerID)
  })

  const breakdown = createMemo(() => {
    const msgs = messages()
    let tools = 0
    let text = 0
    for (const m of msgs) {
      if (m.role === "assistant") {
        const parts = sync.data.part[m.id] ?? []
        for (const p of parts) {
          if (p.type === "tool") tools += Token.estimate((p as { output?: string }).output ?? "")
        }
      }
      if (m.role === "user" || m.role === "assistant") {
        const parts = sync.data.part[m.id] ?? []
        for (const p of parts) {
          if (p.type === "text") text += Token.estimate((p as { text: string }).text)
          if (p.type === "reasoning") text += Token.estimate((p as { text: string }).text)
        }
      }
    }
    return { tools, text }
  })

  const recent = createMemo(() => {
    const msgs = messages()
    return msgs.slice(-10).map((m) => {
      const am = m as AssistantMessage
      const tokens = am.tokens?.total ?? am.tokens?.input ?? 0
      const parts = sync.data.part[m.id] ?? []
      const toolCount = parts.filter((p) => p.type === "tool").length
      return { role: m.role, tokens, tools: toolCount }
    })
  })

  const compaction = createMemo(() => {
    const cfg = sync.data.config as unknown as Config.Info
    const m = model() as unknown as Provider.Model | undefined
    if (!m) return { enabled: false, tier: "none" as CompactionTier }
    return {
      enabled: isTieringEnabled({ cfg, model: m }),
      tier: tier({ cfg, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, model: m }),
    }
  })

  const remaining = createMemo(() => {
    const c = ctx()
    return c ? c.limit - c.tokens : 0
  })

  return (
    <box paddingLeft={2} paddingRight={2}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={1}>
          Context
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <Show when={ctx()?.lastMessage} fallback={<text fg={theme.textMuted}>No messages yet</text>}>
        <text fg={theme.text}>
          Model: {model()?.name ?? "Unknown"} ({provider()?.name ?? "Unknown"})
        </text>
        <text fg={theme.textMuted}>Context limit: {ctx()!.limit.toLocaleString()} tokens</text>
        <text fg={theme.text}>
          Used: {ctx()!.tokens.toLocaleString()} tokens ({ctx()!.pct ?? 0}%)
        </text>
        <text fg={theme.textMuted}>Remaining: {remaining().toLocaleString()} tokens</text>
        <text fg={theme.text}>Breakdown (estimated):</text>
        <text fg={theme.textMuted}>  Tool outputs  ~{breakdown().tools.toLocaleString()} tokens</text>
        <text fg={theme.textMuted}>  Messages     ~{breakdown().text.toLocaleString()} tokens</text>
        <text fg={theme.text}>Recent messages:</text>
        <For each={recent()}>
          {(m) => (
            <text fg={theme.textMuted}>
              {"  [" + m.role + "]  " + m.tokens.toLocaleString() + " tokens" +
                (m.tools > 0 ? "  " + m.tools + " tool calls" : "")}
            </text>
          )}
        </For>
        <text fg={theme.text}>Compaction: {compaction().enabled ? "enabled" : "disabled"}</text>
      </Show>
    </box>
  )
}
