import { createMemo, type Accessor } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import type { AssistantMessage, Model } from "@foxybear/sdk/v2"

export function useContext(
  sessionID: () => string | undefined,
): Accessor<
  | {
      tokens: number
      limit: number
      pct: number | undefined
      cost: number
      model: Model | undefined
      lastMessage: AssistantMessage | undefined
    }
  | undefined
> {
  let local: ReturnType<typeof useLocal>
  let sync: ReturnType<typeof useSync>
  try {
    local = useLocal()
    sync = useSync()
  } catch {
    return () => undefined
  }

  return createMemo(() => {
    const sid = sessionID()
    if (!sid) return undefined
    const messages = sync.data.message[sid]
    if (!messages) return undefined

    const last = messages.findLast(
      (m): m is AssistantMessage => m.role === "assistant" && m.tokens.output > 0,
    )
    if (!last) return undefined

    const tokens =
      last.tokens.total ||
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write

    const current = local.model.current()
    const model = current
      ? sync.data.provider.find((p) => p.id === current.providerID)?.models?.[current.modelID]
      : undefined
    const limit = model?.limit?.context ?? 0

    const pct = limit > 0 ? Math.floor((tokens / limit) * 100) : undefined

    const cost = messages
      .filter((m): m is AssistantMessage => m.role === "assistant" && !!m.cost)
      .reduce((sum, m) => sum + m.cost, 0)

    return { tokens, limit, pct, cost, model, lastMessage: last }
  })
}
