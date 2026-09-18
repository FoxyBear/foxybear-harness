import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@foxybear/plugin/tui"
import { createMemo } from "solid-js"
import { useContext } from "@tui/util/context"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const ctx = useContext(() => props.session_id)
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const cost = createMemo(() => msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0))

  const state = createMemo(() => {
    const c = ctx()
    if (c) {
      return {
        tokens: c.tokens,
        percent: c.pct,
        model: c.model?.name,
      }
    }
    return { tokens: 0, percent: undefined, model: undefined }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>
        {state().model ? state().model + " · " : ""}{state().tokens.toLocaleString()} tokens · {state().percent ?? 0}% used · {money.format(cost())} spent
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
