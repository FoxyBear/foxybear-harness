# Diagnostic brief: memory capture silently drops at the classify store stage

Written for a cold-start agent. Everything below is evidence gathered on this machine (Oct 7-8, 2026). Verify before trusting; falsify freely. **Read the Ops constraints before running anything.**

## Ops constraints (non-negotiable)

- Multiple live TUI sessions are running on this machine at all times. **No service restarts, no stopping SurrealDB, no writes to the live store, no daemon restarts** without explicit approval from Todd.
- The Surreal store was recently repaired after a corruption incident (restored from `~/.local/share/foxybear/backups/pre-migration-2026-10-07T12-54-50-081Z/`). Treat it as production data.
- Read-only diagnostics are fine: daemon HTTP (127.0.0.1:4096), Surreal HTTP (127.0.0.1:8000, root/root, NS `foxybear`, DB `memory`), log files in `~/.local/share/foxybear/log/`.
- Isolated experiments (throwaway Surreal on another port, tmp dirs, a sacrificial daemon on another port) are fine. Never touch the live daemon, the live store, or other sessions.
- Do not promote `tlog` (gated behind `FBH_MEM_TRACE=1`) to always-on `log.warn` on capture hot paths — a previous change did this and flooded every live TUI with garbage when the backend went unhealthy. `tlog` stays.

## Architecture (as observed)

**Processes:**

1. **Daemon** — `fbh serve` (compiled binary at `packages/fbh/dist/fbh-darwin-arm64/bin/fbh`, launcher `~/.bun/bin/fbh`). Starts subsystems via `DaemonLifecycle` (`src/daemon/lifecycle.ts`, definitions in `src/cli/cmd/serve.ts`): database, graph, memory-backend, mesh, scheduler, telegram, http, queue-worker. HTTP API on 127.0.0.1:4096 (`src/daemon/routes.ts` — `/memory/list`, `/memory/write`, `/memory/metrics`, `/memory/query`, `/memory/forget`, ...).
2. **SurrealDB server** — `~/.surrealdb/surreal start --user root --pass root surrealkv:~/.local/share/foxybear/memory-server`, ws://127.0.0.1:8000, NS `foxybear`, DB `memory`. Tables include `memory` (914 rows), `node` (224K — MEMORY/ENTITY/ACTION/TRACE nodes, embeddings), `hyperedge` (21K), `hyperedge_members`, `entity` (522), `event`, `mentions`.
3. **TUI/session processes** — each `fbh` TUI invocation hosts sessions **in-process** (embedded server). This is where the capture hook runs. Telegram sessions run in the daemon process instead.

**Backends (`src/memory/backend-registry.ts`):**

- Plain backend, `getGlobalMemoryBackend()`:
  - In the daemon: a direct `SurrealBackend` — registered by the `memory-backend` subsystem in `src/cli/cmd/serve.ts`.
  - In session processes: a `RemoteMemoryBackend` proxy to the daemon's routes — registered by `initMemoryBackendFromConfig` (`src/memory/init.ts`), called from `initHarnessServices` (`src/harness/worker-init.ts`), forked from `InstanceBootstrap` (`src/project/bootstrap.ts`) on every instance boot.
- Hypergraph backend, `getGlobalHypergraphBackend()`: `SurrealHypergraphBackend` (direct Surreal connection). **The only registration site in the codebase is the daemon boot** — inside the `memory-backend` subsystem in `src/cli/cmd/serve.ts`, gated on `backendType === "surreal" && await isMemoryEnabled()`. A recent change that registered it per-session in `src/memory/init.ts` was deliberately reverted — session/worker processes must not open direct Surreal connections; they go through the daemon proxy.

**Capture pipeline (fires at the end of each completed agent turn):**

`src/session/prompt.ts` post-prompt hook (gated on `memory.enabled`) → `classify()` in `src/memory/classify/pipeline.ts`:

1. Gate: `Jev.noul` (`src/provider/jev.ts`, openrouter `typesafe/jev-1.13`, endpoint `https://openrouter.ai/api/alpha/decisions`, env override `FBH_JEV_ENDPOINT`) — score vs threshold 0.5.
2. Abstraction: `Gemini.abstract` (`src/provider/gemini.ts`, openrouter `google/gemini-2.5-flash`, env override `FBH_GEMINI_ENDPOINT`) — returns self-contained memories JSON.
3. Fallbacks: `Gemini.extract`, then regex extraction.
4. **Store stage: `getGlobalHypergraphBackend()`** — `if (!backend || !backend.healthy()) → tlog("[MEM-TRACE] classify.backend_unhealthy") → return {stored: 0, errors: 1}`. On success it stores MEMORY nodes into the `node` table (+ embeddings via deepinfra). The fallback persist path (`persistMemories`, `src/memory/extraction/persist.ts`) uses the same hypergraph-gated backend.

The plain `memory` table is written by the memory tools (→ daemon `/memory/write`) and the marker-gated SQLite→Surreal migration. Recall/injection reads both tables.

## The problem

**Since Sep 28, zero capture memories have been stored. Every session's captured memories die at the classify store stage, silently.** The store itself is healthy (just repaired); the pipeline runs; the store step cannot find a hypergraph backend.

## Evidence

**Pipeline health (verified end-to-end, isolated):**

- A standalone probe running current source, with a `SurrealHypergraphBackend` manually registered in-process and pointed at a throwaway Surreal on port 8100: gate scored 0.93, Gemini returned 3 quality memories, all 3 stored. The code path works when a backend exists.
- Provider wires verified working with production keys: Jev (`/api/alpha/decisions` — note: chat/completions returns 400 for this model, that is expected, not a bug), Gemini (openrouter always reports `output: 2` tokens for it — reporting artifact, not emptiness), embeddings (deepinfra).

**Live sessions run the pipeline but nothing lands:**

- Oct 8, 2:11 AM session log (`~/.local/share/foxybear/log/2026-10-08T101106.log`): 4× `service=provider.jev ... jev.call` success lines, 4× `gemini.call` success lines. 2:23 AM session (`...102325.log`): 1× each. Gate passes, abstraction runs, memories are produced.
- Store outcomes: `SELECT math::max(valid_from) FROM node` → epoch 1790578950 = **Sep 28, 2026**. Newest `memory` table row = Oct 7 11:00 AM, written via the memory tool (plain backend), not capture. **No classify store has succeeded since Sep 28.**

**The hypergraph backend registers nowhere:**

- Daemon boot log Oct 8 3:37 AM (`...2026-10-08T103703.log`): `global memory backend registered` present; **no `global hypergraph backend registered` line**. Same absence in every available daemon boot log back to Oct 5.
- Session processes: after the revert of the per-session wiring, they never register a hypergraph backend — so classify in a TUI session always hits `backend_unhealthy` → `{stored: 0, errors: 1}` → tlog (gated off) → silence.
- The SQLite→Surreal migration also silently skips at boot for the same reason (its gate is in the same block). The marker file `~/.local/share/foxybear/memory-migration-surreal.json` was deleted as part of the store repair, yet the memory count stayed exactly 914 (no +28) across the subsequent daemon boot — the migration block did not run.

**Config (all verified true in the loaded global config, `~/.config/foxybear/foxybear.json`, with `{file:...}` substitution confirmed working):** `memory.enabled: true`, `memory.graph_backend: "surreal"`, extraction layers configured and working.

## The open question (diagnose this)

Why does the serve.ts hypergraph block skip at daemon boot?

```ts
// src/cli/cmd/serve.ts, memory-backend subsystem init (~L74-155)
const backendType = (config?.memory?.graph_backend ?? "sqlite")   // "surreal" ✓
if (backendType === "surreal" && await isMemoryEnabled()) {        // ← what does this return at boot, and why?
```

`isMemoryEnabled()` (`src/memory/config.ts`) reads the **instance-scoped** config via `getConfig()` (`src/config/bridge.ts` → `Config.Service.get()`), returns `false` on any throw. Empirically, called with no Instance context (standalone script), it returns false ("instance: No context found" — the ALS from `src/project/instance.ts`). The daemon boot log shows subsystem inits running **before** the "creating instance" lines, suggesting no instance context exists when the gate evaluates → gate false → block skipped. **This needs verification inside the actual daemon boot path, not a standalone script** — e.g., temporary instrumentation at the gate, run in a sacrificial daemon on another port (see Ops constraints). Note: `getGlobalConfig()` (the same bridge file) reads the global config and works fine at boot; whether the intended gate is the instance-scoped one is a design question, not just a bug question.

Second question: **where should classify's store stage write from session processes under the daemon-proxy architecture?** Today only the plain backend has a remote proxy (`RemoteMemoryBackend` → daemon `/memory/write`). The hypergraph store path has no proxy — session processes have no legitimate way to reach the `node` table. Options: (a) register the hypergraph backend in the daemon at boot and add a daemon route that session processes call remotely for hypergraph stores; (b) route capture stores through the plain backend/memory table; (c) something else already intended. This is Todd's architecture call — present options, don't pick for him.

## Log-file gotchas (learned the hard way)

- Log files in `~/.local/share/foxybear/log/` are per-process, timestamped. The daemon boot log is the one containing `args=["serve"]` / `PID file written`. `serve.log` captures only daemon stdout (console.log/error).
- Grepping logs pollutes them: every command the harness runs gets echoed as `service=permission` lines. Filter with `grep -v "permission\|pattern="`.
- `tlog`/`[MEM-TRACE]` lines are invisible unless `FBH_MEM_TRACE=1` — absence of trace lines proves nothing in production.
- File names appear to be UTC while `ls` shows local time (IST, +05:30). Correlate by content, not by name.

## Deliverables

1. Empirically determine what `isMemoryEnabled()` (and the whole gate) evaluates at daemon boot, with evidence.
2. Propose the minimal, architecture-consistent fix for getting capture memories from session processes into the store, with a verification plan: a fresh session completes one substantive turn → a new row appears in the `node` table (`valid_from` > now) → `/memory/metrics` counts increase.
3. Do not implement without Todd's approval. Do not restart anything without Todd's approval.

## Current state (as of writing)

- Daemon: PID 71554 (3:37 AM Oct 8), post-revert rebuilt binary. Surreal: healthy, restored store (914 memory rows, 224K nodes). Migration marker: deleted; migration: skipped at boot.
- Voice (separate, fixed): the TTS failure was `@elevenlabs/elevenlabs-js` never declared as a dependency (dynamic import fails in the compiled binary → permanent silent degrade). The dependency is now declared and bundled; `degrade()` logs the reason. Not part of this diagnosis.
