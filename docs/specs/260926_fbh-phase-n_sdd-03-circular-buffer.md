# SDD-03: Phase N — Circular Buffer

**Date:** 2026-09-26
**Project:** FoxyBear Harness Phase N (`development/foxybear`)
**Status:** Draft (pending independent audit + human gate)
**Master:** `260926_fbh-phase-n_sdd-00-master.md` (authoritative; where this spec conflicts, the master wins)
**Research:** `docs/research/260926_fbh-phase-n_salience-classification-spike.md` (§"Circular buffer — last 5 user turns")
**Workstream:** `fbh-phase-n` (`tools/sdd/workstreams/fbh-phase-n.json`)
**Depends on:** none (parallel with `sdd-01` Jev provider, `sdd-02` Gemini provider)
**Depended on by:** `sdd-04` (gate-extract-classify pipeline — needs `Buffer.add` + `Buffer.getContext` + `Buffer.get`)

Implements Phase N SDD-03: a per-session circular buffer of the last N user turns that gives the Jev gate (SDD-04) the conversation arc it needs to distinguish routine turns from memory-worthy ones. Session-scoped (one buffer per session), user-turn-only (assistant and tool turns are not salience-bearing), cleared on session end, configurable size (default 5), in-memory only (not persisted).

## Scope (from master SC-1, SC-3)

The master defines the interface at `sdd-00-master.md` SC-1 (`Buffer` namespace at `src/memory/capture/buffer.ts`):

```typescript
// src/memory/capture/buffer.ts
export namespace Buffer {
  export function add(sessionID: string, turn: { text: string; role: string }): void
  export function getContext(sessionID: string): string  // formatted prior turns for Jev state
  export function get(sessionID: string): { text: string; role: string }[]  // raw access (for tests)
  export function clear(sessionID: string): void
  export function size(): number  // configurable via config, default 5
}
```

> Session-scoped (one buffer per session). Cleared on session end. Only user turns are buffered (assistant turns and tool calls are not — they're not salience-bearing).

This spec implements that interface plus an `init()` Effect for the session-lifecycle hook that clears buffers on `Session.Event.Deleted`. `init()` is an extra export (not in SC-1) needed for the lifecycle subscription.

## Background

The gate (SDD-04, stage 1 of the 4-stage pipeline) calls `Jev.noul(state, instructions, criteria)` with `state` = the conversation arc. The spike (research §"Circular buffer") proved that without the arc, Jev cannot tell a routine "thanks" from a real memory like "always use Bun.file() not fs". The buffer holds the last 5 user turns so Jev sees "the user has been asking about X, then said Y" — the recency arc that disambiguates.

Two in-repo precedents for session-scoped in-memory `Map`s:

1. **`sessionMemoryStore`** at `session/compaction.ts:69` — `new Map<string, SessionMemory>()`, populated at `compaction.ts:672`, never cleared (a known leak this spec avoids).
2. **`ProvenanceTracker.store`** at `memory/packing/tracker.ts:29` — `new Map<string, Packed[]>()`, cleared at `packing/tracker.ts:46` and `:67` via `store.delete(sessionID)`.

The session-deleted sync event is `Session.Event.Deleted` at `session/index.ts:208-216` (type `"session.deleted"`, aggregate `sessionID`). It is fired by `Session.remove` at `session/index.ts:840`. The subscription pattern is `watch` at `share/share-next.ts:161-176` — `bus.subscribe(def).pipe(Stream.runForEach(cb), Effect.forkScoped)`, used at `:199` for `Session.Event.Deleted`.

The post-turn hook that will call `Buffer.add()` lives at `session/prompt.ts:166` (the `capture` Effect.fnUntraced), forked at `:1645` via `run.fork(capture(...))`. SDD-04 wires the gate into this hook; SDD-03 only provides the buffer.

---

## WHAT

### Buffer module (SC-1, SC-3)

1. **WHEN** SDD-03 implementation begins, the system **SHALL** create `src/memory/capture/buffer.ts` exporting the `Buffer` namespace per master SC-1, with `add(sessionID, turn)`, `getContext(sessionID)`, `get(sessionID)`, `clear(sessionID)`, and `size()`, plus an `init()` Effect for the session-deleted subscription (extra export, not in SC-1).

2. **WHEN** the `Turn` type is defined (internal to `buffer.ts`, not exported), it **SHALL** carry only `text: string` and `role: string` (SC-1). It **SHALL NOT** carry timestamps, message IDs, part IDs, persona, project_id, or any metadata — the buffer is a text-only context arc for Jev, and metadata would leak into the gate's `state` string. The SC-1 public `add` param shape `{ text: string; role: string }` IS the `Turn` type — there is no separate exported `Turn`.

### add() — session-scoped, user-turn-only filter (SC-1, SC-3)

3. **WHEN** `Buffer.add(sessionID, { text, role })` is called with `role === "user"`, the system **SHALL** append `{ text, role }` to the `Turn[]` for that `sessionID` in the module-level `Map<sessionID, { turns: Turn[]; size: number }>`. The `sessionID` **SHALL** scope the append — turns from one session never appear in another's buffer.

4. **WHEN** `Buffer.add(sessionID, { text, role })` is called with `role !== "user"` (e.g. `"assistant"`, `"tool"`, `"system"`), the system **SHALL** no-op — the turn is NOT appended. Assistant turns and tool calls are not salience-bearing per the master SC-3 note. The system **SHALL NOT** throw on non-user roles (the post-turn hook passes all roles; the filter is silent).

### add() — last-N maintenance (FIFO) and the size===0 edge case

5. **WHEN** `add()` causes `turns.length > size` for that session, the system **SHALL** drop the oldest turns (FIFO — `slice(-size)` semantics) until `turns.length === size`. The most recent `size` user turns are always retained; older turns are discarded. The system **SHALL NOT** retain more than `size` turns at any time.

6. **WHEN** the session's `size === 0` is configured (buffer disabled), `add()` **SHALL** set `turns` to `[]` explicitly and **SHALL NOT** call `slice(-0)` — in JavaScript `-0 === 0`, so `slice(-0)` is `slice(0)` which returns the full array, NOT `[]`. The system **SHALL** guard `size === 0` with an explicit early branch that empties the array. This is the "disable the arc" escape hatch. Every turn is dropped immediately.

### getContext() — formatted prior turns (SC-1)

7. **WHEN** `Buffer.getContext(sessionID)` is called on a non-empty buffer, it **SHALL** return a string in this exact format (oldest-to-newest, 1-indexed):

   ```
   Prior user turns:
   [1] {text of oldest turn}
   [2] {text of next turn}
   ...
   [N] {text of most recent turn}
   ```

   The turns **SHALL** be ordered oldest first, most recent last (so Jev reads the arc chronologically and the current turn — if `add()` was called before `getContext()` — appears as `[N]`). Each turn **SHALL** be prefixed with `[i] ` where `i` is the 1-indexed position. Turns **SHALL** be joined by `\n`. The header line **SHALL** be exactly `Prior user turns:`. The format **SHALL** be deterministic — same buffer state always produces the same string.

8. **WHEN** `Buffer.getContext(sessionID)` is called on an empty buffer (`turns.length === 0`), it **SHALL** return `""` (empty string — no header, no turns). The gate receives an empty `state` for the first turn of a session, which is correct (no prior context exists).

9. **WHEN** `Buffer.getContext(sessionID)` is called for a `sessionID` with no buffer entry (unknown session), it **SHALL** return `""` (same as empty — no prior context exists for an unknown session).

### get() — raw access for tests (SC-1)

10. **WHEN** `Buffer.get(sessionID)` is called, the system **SHALL** return the raw `Turn[]` (`{ text: string; role: string }[]`) for that `sessionID`. For an unknown session or empty buffer, it **SHALL** return `[]`. This is the test accessor (replaces the old `_peek` pattern) — the SC-1 public contract exposes it directly.

### size() — configured size accessor (SC-1)

11. **WHEN** `Buffer.size()` is called (no `sessionID` arg), the system **SHALL** return the currently configured buffer size (the value `memory.extraction.buffer_size` resolves to, default `5`). This is the global config value, NOT a per-session value — per-session sizes are fixed at session creation (req 14) and may differ from `size()` if config changed mid-session.

### Size config (SC-2 additive, CC-4)

12. **WHEN** `memory.extraction.buffer_size` is unset in config, the system **SHALL** default `size` to `5` (matching the master's "default 5" and the `MICROCOMPACT_PRESERVE = 5` precedent at `compaction.ts:85`).

13. **WHEN** `memory.extraction.buffer_size` is set to a positive integer in config, the system **SHALL** use that value as `size` for newly created session buffers.

14. **WHEN** a session buffer is created (first `add(sessionID, ...)` for that session), the system **SHALL** read `buffer_size` from config once and store it as that session's fixed `size` in the Map value (`{ turns: Turn[]; size: number }`). Existing session buffers **SHALL** retain their `size` if config changes mid-session — only new sessions get the new size. This avoids re-reading config on every `add()` (hot path) and avoids truncating mid-arc. To change `size` for an active session, the session must be restarted (or `Buffer.clear(sessionID)` called, which resets the buffer on next `add`).

### Session-scoping — one buffer per session (SC-3)

15. **WHEN** `Buffer.add(s1, ...)` and `Buffer.add(s2, ...)` are called with distinct sessionIDs, the system **SHALL** maintain distinct `Turn[]` entries in the `Map`. Turns added to `s1`'s buffer **SHALL NOT** appear in `Buffer.getContext(s2)`. No cross-session leakage — the gate's `state` for `s1` contains only `s1`'s user turns. The backing store is a module-level `Map<sessionID, { turns: Turn[]; size: number }>` (matching `sessionMemoryStore` at `compaction.ts:69` and `ProvenanceTracker.store` at `packing/tracker.ts:29`).

### Clear on session end (SC-3, session lifecycle)

16. **WHEN** `Session.Event.Deleted` (at `session/index.ts:208-216`) is published for a `sessionID`, the system **SHALL** delete that `sessionID`'s entry from the `Map` (matching `store.delete(sessionID)` at `packing/tracker.ts:46,67`). The buffer is garbage-collected; no turns persist.

17. **WHEN** `Buffer.clear(sessionID)` is called for a `sessionID` that has no buffer (unknown or already cleared), the system **SHALL** no-op — `Map.delete` on a missing key is already a no-op; the system **SHALL NOT** throw. This makes the clear path idempotent (a session can be deleted once but the event can be replayed).

### In-memory only (not persisted)

18. **WHEN** the process restarts (daemon restart, crash, etc.), the system **SHALL** start with empty buffers — the `Map` is module-level in-memory state, never written to disk or SurrealDB. The buffer is a transient context arc, not a durable memory. Durable memories are the job of the STORE stage (SDD-04 stage 4) via the Phase M pipeline, NOT this buffer.

### Subscription lifecycle (CC-3 async, session-deleted hook)

19. **WHEN** the daemon starts, the system **SHALL** call `init()` (an `Effect.Effect<void>`) from `src/cli/cmd/serve.ts` alongside other memory init calls. `init()` **SHALL** subscribe to `Session.Event.Deleted` via `bus.subscribe(Session.Event.Deleted).pipe(Stream.runForEach((evt) => Effect.sync(() => clear(evt.properties.sessionID))), Effect.forkScoped)` — matching the `watch` pattern at `share/share-next.ts:161-176,199`. The subscription **SHALL** run in a scoped fiber so it is disposed when the daemon's scope closes.

20. **WHEN** the daemon's scope closes (shutdown), the system **SHALL** dispose the `Session.Event.Deleted` subscription via the `Effect.forkScoped` semantics — no manual unsubscribe needed. The `Map` is also garbage-collected on process exit. No resource leak.

### Style & quality (CC-7, AGENTS.md)

21. **WHEN** SDD-03 implementation completes, the system **SHALL** follow the AGENTS.md style guide: single-word names where unambiguous (`add`, `get`, `clear`, `init`, `text`, `role`, `turn`, `turns`, `size`); `const` over `let` (no reassignment — use `turns.slice(-size)` for FIFO, not `turns.shift()` in a loop; the `Map` and `entry` objects are `const`); no `any` type; early returns over `else`; functional array methods (`filter`, `map`, `slice`, `flatMap`) over `for` loops; `Bun.file()` over `fs` (not used in this spec — buffer is in-memory, but if a marker or debug dump is added, use `Bun.file()`).

22. **WHEN** SDD-03 implementation completes, `bun run typecheck` and `bun test --timeout 30000` (run from `packages/fbh` per SC-10) **SHALL** both be green (CC-7). No red tests left.

---

## HOW

### Step 1: `buffer.ts` — Buffer namespace + module store (reqs 1-10, 12-15, 21)

Create `src/memory/capture/buffer.ts`:

- `interface Turn { text: string; role: string }` (internal, not exported — the SC-1 `add` param shape is the public contract).
- Module-level store:
  - `const store = new Map<string, { turns: Turn[]; size: number }>()` (matches `sessionMemoryStore` at `compaction.ts:69`, `ProvenanceTracker.store` at `packing/tracker.ts:29`). Each Map value holds the session's `turns` and its fixed `size` (read once at creation, per req 14).
- `export namespace Buffer` with:
  - `export function add(sessionID: string, turn: { text: string; role: string }): void` — early return if `turn.role !== "user"` (req 4). Else `const entry = store.get(sessionID) ?? { turns: [], size: resolveBufferSize() }` (lazy create, reads size once per session — req 14). If `entry.size === 0`: `entry.turns = []; store.set(sessionID, entry); return` (req 6 — explicit empty, NOT `slice(-0)`). Else `entry.turns = [...entry.turns, turn].slice(-entry.size); store.set(sessionID, entry)`. The `slice(-size)` handles both append and FIFO drop in one operation (req 5).
  - `export function getContext(sessionID: string): string` — `const entry = store.get(sessionID); if (!entry || entry.turns.length === 0) return ""` (reqs 8-9). Else `return ["Prior user turns:", ...entry.turns.map((t, i) => \`[${i + 1}] ${t.text}\`)].join("\n")`. Deterministic, oldest-to-newest (req 7).
  - `export function get(sessionID: string): { text: string; role: string }[]` — `return store.get(sessionID)?.turns ?? []` (req 10 — raw access, `[]` for unknown/empty).
  - `export function clear(sessionID: string): void` — `store.delete(sessionID)` (idempotent — `Map.delete` on missing key is a no-op, req 17).
  - `export function size(): number` — `return resolveBufferSize()` (req 11 — the current configured global size, NOT a per-session value).

### Step 2: Config reader — `resolveBufferSize()` (reqs 11-14)

Add a `resolveBufferSize()` function to `buffer.ts`:

- `const DEFAULT_BUFFER_SIZE = 5` (const, matches `MICROCOMPACT_PRESERVE = 5` at `compaction.ts:85` and master's "default 5").
- `function resolveBufferSize(): number` — reads `getConfig()` (from `config/bridge`, matching `extraction/mode.ts:46`), returns `cfg?.memory?.extraction?.buffer_size ?? DEFAULT_BUFFER_SIZE`. Validates: if the value is not a positive integer, falls back to `DEFAULT_BUFFER_SIZE` and logs a warning. `size === 0` is allowed (disabled buffer, req 6).
- Add `buffer_size` to the `memory.extraction` config shape (additive to SC-2). This spec keeps it standalone in `buffer.ts` to avoid coupling SDD-03 to SDD-04's config shape. `Buffer.size()` calls `resolveBufferSize()` on each invocation (returns the current config value, req 11); per-session sizes are cached in the Map value at session creation (req 14).

### Step 3: `init()` — session-deleted subscription (reqs 16, 19-20)

Add `export const init = Effect.fn("Buffer.init")(function* () { ... })` to `buffer.ts`:

- Yield `Bus.Service` (from `@/bus`, matching `share/share-next.ts:5`).
- `yield* bus.subscribe(Session.Event.Deleted).pipe(Stream.runForEach((evt) => Effect.sync(() => clear(evt.properties.sessionID))), Effect.catchCause((cause) => Effect.sync(() => log.error("buffer session.deleted subscriber failed", { cause }))), Effect.forkScoped)`.
- The `Effect.catchCause` matches `share/share-next.ts:168-172` — never let a subscriber error kill the fiber.
- The `Effect.forkScoped` ensures the subscription is disposed when the daemon's scope closes (req 20).

### Step 4: Wire `init()` into daemon startup

Edit `src/cli/cmd/serve.ts` — call `init()` alongside the other memory init calls (the `SurrealHypergraphBackend` init at `serve.ts:132-138` per SDD-M-03 req 17). The exact insertion point depends on what's already there; the constraint is: `init()` runs after `Bus` is available and before the daemon accepts sessions.

### Reuse map

| Existing asset | Anchor | Reuse |
|---|---|---|
| `sessionMemoryStore` | `session/compaction.ts:69` | Session-scoped `Map<string, T>` precedent. This spec adds the clear-on-delete that `sessionMemoryStore` lacks. |
| `ProvenanceTracker.store` + `store.delete` | `memory/packing/tracker.ts:29,46,67` | Session-scoped `Map` + clear-on-lifecycle precedent. Closest structural match. |
| `Session.Event.Deleted` | `session/index.ts:208-216` | The sync event to subscribe. Fired by `Session.remove` at `:840`. |
| `watch()` subscription pattern | `share/share-next.ts:161-176,199` | `bus.subscribe(def).pipe(Stream.runForEach(cb), Effect.catchCause(...), Effect.forkScoped)`. Copied verbatim in shape. |
| `m.info.role === "user"` filter | `session/prompt.ts:288`, `session/compaction.ts:158,246,353,492,517` | User-role filter pattern. Applied in `add()`. |
| `MICROCOMPACT_PRESERVE = 5` | `session/compaction.ts:85` | Last-N default precedent. `DEFAULT_BUFFER_SIZE = 5` mirrors it. |
| `resolveExtractionConfig` + `getConfig` | `memory/extraction/mode.ts:44-63,46` | Config reader pattern. `resolveBufferSize()` follows the same shape. |
| `DEFAULT_EXTRACTION` const | `memory/extraction/mode.ts:32-42` | Defaults-const pattern. `DEFAULT_BUFFER_SIZE` mirrors it. |
| `run.fork(capture(...))` post-turn hook | `session/prompt.ts:1645` | Where SDD-04 will call `Buffer.add(sessionID, {text, role})`. Not modified by this spec. |
| `Effect.fn("Domain.method")` | `session/compaction.ts:327`, `memory/packing/tracker.ts:37` | Named-effect pattern. Used for `init`. |

### What is explicitly NOT built

- **No gate logic** — SDD-04 owns the Jev `noul` call that consumes `Buffer.getContext(sessionID)`. This spec provides the buffer; SDD-04 reads it.
- **No extraction or classification** — SDD-04 owns stages 2-3 (Gemini extract, Jev classify). The buffer is stage 0 (context prep).
- **No persistence** — the buffer is in-memory only (req 18). No `Bun.file()` writes, no SurrealDB rows. Durable storage is the Phase M pipeline (SDD-04 stage 4).
- **No multi-process / multi-daemon sharing** — the `Map` is per-process. If two daemons run on the same project (not a supported config), each has its own buffers. Cross-process sync is out of scope.
- **No ring buffer with head/tail pointers** — at N=5, `array.slice(-5)` is O(N) and simpler than a ring buffer. The master says "circular buffer" conceptually; the implementation is a FIFO slice. No premature optimization.
- **No LRU, priority, or salience-based eviction** — FIFO only. The gate decides salience; the buffer just holds recency.
- **No trimming of turn text** — the full user turn text is buffered. If a turn is 10k chars, the buffer holds 10k chars. Token-budget management is the gate's problem (SDD-04 may truncate `state` before sending to Jev); the buffer stores raw text.
- **No assistant/tool buffering** — SC-3 is explicit: only user turns. The filter is in `add()` (req 4).
- **No `slice(-0)` reliance** — the `size === 0` case is guarded with an explicit `entry.turns = []` branch (req 6). In JS, `-0 === 0` so `slice(-0)` returns the full array; the guard avoids this bug.

---

## VERIFY

Tests at `packages/fbh/test/fbh-phase-n/sdd-03.test.ts` (run from `packages/fbh` per SC-10). No mocks of the `Buffer` namespace or the `Map` store (test the real implementation, per the AGENTS.md testing rule).

- **V1 — Buffer namespace implements SC-1 (reqs 1-2).** Action: import `Buffer` from `src/memory/capture/buffer.ts`. Expected: namespace exists; `add`, `getContext`, `get`, `clear`, `size` are exported functions; `size()` returns a number (default 5). `Buffer.size()` with no config returns `5`. `Buffer.getContext("never-existed")` returns `""`.

- **V2 — add() user-only filter (reqs 3-4).** Setup: call `Buffer.clear("s-filter")` to ensure clean state. Action: `Buffer.add("s-filter", { text: "hello", role: "user" })`; `Buffer.add("s-filter", { text: "thinking", role: "assistant" })`; `Buffer.add("s-filter", { text: "result", role: "tool" })`; `Buffer.add("s-filter", { text: "system note", role: "system" })`. Expected: `Buffer.get("s-filter")` shows only `"hello"` buffered — 1 turn, not 4. The assistant/tool/system calls are silent no-ops (no throw, no log at error level).

- **V3 — last-N maintenance FIFO (req 5).** Setup: config with `buffer_size = 3`. Action: `Buffer.add("s-fifo", {text:"a",role:"user"})`, `add("s-fifo", {text:"b",role:"user"})`, `add("s-fifo", {text:"c",role:"user"})`, `add("s-fifo", {text:"d",role:"user"})`, `add("s-fifo", {text:"e",role:"user"})`. Expected: `Buffer.get("s-fifo")` holds exactly `[c, d, e]` (last 3; `a` and `b` dropped FIFO). `Buffer.getContext("s-fifo")` returns:
  ```
  Prior user turns:
  [1] c
  [2] d
  [3] e
  ```

- **V4 — getContext() format oldest-to-newest with [N] prefix (req 7).** Setup: default config (size 5), `Buffer.clear("s-fmt")`. Action: `add("s-fmt", {text:"first",role:"user"})`, `add("s-fmt", {text:"second",role:"user"})`, `add("s-fmt", {text:"third",role:"user"})`, then `getContext("s-fmt")`. Expected: exactly `"Prior user turns:\n[1] first\n[2] second\n[3] third"` — deterministic, header present, 1-indexed, oldest first, `\n`-joined.

- **V5 — getContext() empty returns "" (reqs 8-9).** Setup: default config, `Buffer.clear("s-empty")`. Action: `getContext("s-empty")`. Expected: `""` (empty string, NOT `"Prior user turns:\n"` — no header when empty). Also `getContext("never-existed")` returns `""`.

- **V6 — size === 0 disables buffer (req 6).** Setup: config with `buffer_size = 0`. Action: `add("s-zero", {text:"x",role:"user"})`, `add("s-zero", {text:"y",role:"user"})`. Expected: `getContext("s-zero") === ""`, `get("s-zero")` returns `[]`. The `size === 0` guard empties the array explicitly — assert the implementation does NOT call `slice(-0)` (which in JS returns the full array due to `-0 === 0`). The turns are dropped immediately.

- **V7 — size() returns configured size (req 11).** Setup: config with no `memory.extraction.buffer_size`. Action: `Buffer.size()`. Expected: returns `5`. With `buffer_size = 3` configured: `Buffer.size()` returns `3`.

- **V8 — size config respected (reqs 12-13).** Setup: config with `memory.extraction.buffer_size = 3`. Action: `add("s-3", ...)` 5 turns. Expected: `get("s-3")` holds only last 3 turns (FIFO). `Buffer.size()` returns `3`.

- **V9 — size fixed at creation per session (req 14).** Setup: `add("s-fixed", {text:"a",role:"user"})` with `buffer_size = 5` → that session's internal size is `5` (5 turns buffered). Change config to `buffer_size = 10` mid-session. Action: `add("s-fixed", {text:"b",role:"user"})` more turns. Expected: the `s-fixed` session still caps at 5 turns (size fixed at creation), NOT 10. `Buffer.size()` returns `10` (current config). `add("s-new", {text:"a",role:"user"})` (new session) → `s-new` caps at 10. Then `clear("s-fixed")` and `add("s-fixed", {text:"a",role:"user"})` again — now `s-fixed` caps at 10 (fresh creation reads current config).

- **V10 — get() returns raw turns (req 10).** Setup: `add("s-get", {text:"alpha",role:"user"})`, `add("s-get", {text:"beta",role:"user"})`. Action: `Buffer.get("s-get")`. Expected: returns `[{ text: "alpha", role: "user" }, { text: "beta", role: "user" }]` — the raw `Turn[]`, in insertion order. `Buffer.get("never-existed")` returns `[]`.

- **V11 — session isolation, no turn leakage (req 15).** Setup: `clear("s1")`, `clear("s2")`. Action: `add("s1", {text:"alpha",role:"user"})`, `add("s1", {text:"beta",role:"user"})`, `add("s2", {text:"gamma",role:"user"})`. Expected: `getContext("s1")` contains `alpha` and `beta`, NOT `gamma`. `getContext("s2")` contains `gamma`, NOT `alpha` or `beta`. The `Map` keeps them separate.

- **V12 — clear on session end (req 16).** Setup: `add("s-end", {text:"a",role:"user"})` 3 turns. Action: simulate `Session.Event.Deleted` — either call `clear("s-end")` directly, or (integration) publish the sync event and let the subscriber fire. Expected: `get("s-end")` returns `[]` after clear. `add("s-end", {text:"x",role:"user"})` after clear creates a fresh buffer.

- **V13 — clear idempotent (req 17).** Action: `clear("never-existed")`. Expected: no throw, no error log. `clear("s-end")` called twice (after V12) — second call is a no-op, no throw.

- **V14 — in-memory only, not persisted (req 18).** Setup: `add("s-persist", {text:"a",role:"user"})`. Action: simulate process restart — re-import the `buffer.ts` module (Bun test hot reload, or `jest.resetModules()` equivalent in `bun test`) and check the store. Expected: store is empty after re-import — no `Bun.file()` reads, no SurrealDB queries by `buffer.ts`. (Assert via grep: `buffer.ts` does not import `Bun` or `surreal` — it only imports `Effect`, `Bus`, `Session`, `config/bridge`, `Log`.)

- **V15 — subscription init on daemon startup (req 19).** Action: call `init()` (or boot the daemon via `serve.ts`). Expected: `init()` subscribes to `Session.Event.Deleted` via `bus.subscribe`. Publish a `Session.Event.Deleted` event with `{ sessionID: "s-sub" }`; after the subscriber fires, `get("s-sub")` returns `[]` (cleared). Assert the subscription fiber is running (no throw from `init()`).

- **V16 — subscription disposed on daemon stop (req 20).** Setup: call `init()` inside a `Scope`; close the scope. Action: publish `Session.Event.Deleted` after scope close. Expected: `clear` is NOT called (subscriber disposed) — `get("s-after-close")` still returns the buffered turns (they were added before scope close and not cleared because the subscriber is gone). This verifies `Effect.forkScoped` cleanup. (Implementation note: use `Effect.runFork` with a `Scope` and `Scope.close` to test.)

- **V17 — style guide compliance (req 21).** Action: inspect `buffer.ts`. Expected: (a) function/variable names are single-word where unambiguous (`add`, `get`, `clear`, `init`, `text`, `role`, `turn`, `turns`, `size`); (b) no `let` (all `const` except no `let` at all — the `Map` is `const`, entries are `const`, `turns` arrays are reassigned via `slice` returning a new array, not via `let` mutation); (c) no `any` type (run `bun run typecheck` — `tsc` with `noImplicitAny` catches it); (d) no `for` loops (use `map`/`filter`/`slice`/`flatMap`); (e) no `Bun.file()` or `fs` import (buffer is in-memory); (f) early returns over `else` blocks; (g) `resolveBufferSize` uses `getConfig()` not `fs.readFileSync`.

- **V18 — typecheck + test green (req 22, CC-7).** `bun run typecheck` and `bun test --timeout 30000` (from `packages/fbh`) both green. No red tests, no type errors.

## Dependencies

- **None.** SDD-03 is parallel with `sdd-01` (Jev provider) and `sdd-02` (Gemini provider). It can be implemented first or concurrently.
- **Depended on by:** `sdd-04` (gate-extract-classify pipeline) — needs `Buffer.add(sessionID, {text, role})` in the post-turn hook (before the gate call), `Buffer.getContext(sessionID)` as the `state` argument to `Jev.noul`, and `Buffer.get(sessionID)` for test access. SDD-04's `implement` stage refuses to run until SDD-03's `tests` stage passes (per the master's dependency order).
- **Not depended on by:** `sdd-05` (wire into capture) and `sdd-06` (re-backfill) — they depend on `sdd-04`, not on SDD-03 directly. But SDD-03's `add()` call site is in the post-turn hook that `sdd-05` owns; the call is added by `sdd-04` (gate) or `sdd-05` (wire-up), and this spec only provides the buffer.
