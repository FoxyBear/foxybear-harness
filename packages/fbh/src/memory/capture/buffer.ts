/**
 * SDD-03 / Phase N — Circular Buffer.
 *
 * Per-session, last-N user-turn context arc for the Jev gate. Session-scoped
 * (one buffer per session), user-turn-only (assistant and tool turns are not
 * salience-bearing), cleared on session end, configurable size (default 5),
 * in-memory only (not persisted). The buffer gives Jev the conversation arc
 * it needs to distinguish routine turns from memory-worthy ones.
 *
 * Master: 260926_fbh-phase-n_sdd-00-master.md (SC-1, SC-3).
 */
import { Effect, Stream } from "effect"
import { Bus } from "../../bus"
import { Session } from "../../session"
import { getConfig } from "../../config/bridge"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.capture.buffer" })

const DEFAULT_BUFFER_SIZE = 5

interface Turn {
  text: string
  role: string
}

// Module-level store — session-scoped Map matching the sessionMemoryStore
// precedent at compaction.ts:69 and ProvenanceTracker.store at tracker.ts:29.
// Each Map value holds the session's turns and its fixed size (read once at
// creation, per req 14 — existing session buffers retain their size if
// config changes mid-session; only new sessions get the new size).
const store = new Map<string, { turns: Turn[]; size: number }>()

// Config cache. `add` and `size` are synchronous per SC-1, so they read
// from this cache. `init()` resolves the actual buffer_size from config
// once on daemon startup and updates the cache. Falls back to the default
// when the config value is missing or invalid.
const cache = { size: DEFAULT_BUFFER_SIZE }

export namespace Buffer {
  // add: appends a user turn to the session's buffer. The filter is
  // role === "user" only — assistant/tool/system turns are a silent no-op
  // (req 4 — they are not salience-bearing). The size === 0 guard is
  // explicit (req 6 — in JS -0 === 0, so slice(-0) returns the full array;
  // the guard empties the array directly).
  export function add(sessionID: string, turn: { text: string; role: string }): void {
    if (turn.role !== "user") return
    const existing = store.get(sessionID)
    const size = existing?.size ?? cache.size
    if (size === 0) {
      store.set(sessionID, { turns: [], size })
      return
    }
    const turns = [...(existing?.turns ?? []), turn].slice(-size)
    store.set(sessionID, { turns, size })
  }

  // getContext: formatted prior turns for the Jev gate's `state` argument.
  // Oldest first, most recent last, 1-indexed. Empty buffer → "" (no header).
  export function getContext(sessionID: string): string {
    const entry = store.get(sessionID)
    if (!entry || entry.turns.length === 0) return ""
    return ["Prior user turns:", ...entry.turns.map((t, i) => `[${i + 1}] ${t.text}`)].join("\n")
  }

  // get: raw Turn[] access (for tests). Unknown/empty session → [].
  export function get(sessionID: string): { text: string; role: string }[] {
    return store.get(sessionID)?.turns ?? []
  }

  // clear: idempotent — Map.delete on a missing key is a no-op (req 17).
  export function clear(sessionID: string): void {
    store.delete(sessionID)
  }

  // size: the current configured global buffer size (NOT per-session).
  // Per-session sizes are fixed at creation and cached in the Map value.
  export function size(): number {
    return cache.size
  }
}

// Resolve buffer_size from config and update the cache. Called by init()
// on daemon startup. Falls back to DEFAULT_BUFFER_SIZE on any error.
async function resolve_size(): Promise<number> {
  try {
    const cfg = await getConfig()
    const n = cfg?.memory?.extraction?.buffer_size
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return DEFAULT_BUFFER_SIZE
    return n
  } catch {
    return DEFAULT_BUFFER_SIZE
  }
}

// init: subscribes to Session.Event.Deleted via the bus and clears the
// session's buffer when the session is deleted. Also resolves the buffer
// size from config once on startup. Runs in a scoped fiber so the
// subscription is disposed when the daemon's scope closes (req 20).
// Pattern matches the watch() helper at share-next.ts:161-176,199.
export const init = Effect.fn("Buffer.init")(function* () {
  const resolved = yield* Effect.promise(() => resolve_size())
  cache.size = resolved

  const bus = yield* Bus.Service
  yield* bus.subscribe(Session.Event.Deleted as never).pipe(
    Stream.runForEach((evt: { properties: { sessionID: string } }) =>
      Effect.sync(() => {
        Buffer.clear(evt.properties.sessionID)
        log.debug("buffer.cleared_on_session_deleted", { sessionID: evt.properties.sessionID })
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.sync(() => log.error("buffer session.deleted subscriber failed", { cause })),
    ),
    Effect.forkScoped,
  )
})
