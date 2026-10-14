# CONTEXT — FoxyBear Harness (fbh)

Multi-LLM CLI harness. TypeScript/Bun fork of OpenCode. Monorepo package at `packages/fbh/`.

## Pipeline Entities

**Daemon** — Long-lived background process started by `fbh serve`. Listens on `127.0.0.1:4096`. Owns all shared subsystems: database, graph, memory-backend, hypergraph, mesh, scheduler, telegram, http, queue-worker. PID file at `~/.local/share/foxybear/fbh-serve.pid`. Runs outside any Instance ALS context — cannot use `getConfig()` (instance-scoped); must use `getGlobalConfig()` or raw config reads.

**Session (TUI)** — Interactive terminal process. Connects to daemon via HTTP for shared state (memory, graph, queue). Each session has its own `InstanceState` ALS context. Falls back to `NoOpMemoryBackend` if daemon is unreachable at init — and stays there for its lifetime (no reconnect). _Avoid:_ "client" (ambiguous with test clients).

**Instance** — An ALS (AsyncLocalStorage) context wrapping a session's runtime state. Provides `getConfig()` (instance-scoped config). Not available in daemon subsystem init. _Avoid:_ using `Instance.current` or `getConfig()` in daemon boot paths.

**MemoryBackend (plain)** — Reads/writes the `memory` table in SurrealDB. Session proxy: `RemoteMemoryBackend` → daemon `/memory/*` routes. Holds ~920 records (explicit `memory_remember` stores). Has embeddings but no vector index.

**HypergraphBackend** — Reads/writes the `node` table in SurrealDB (224K+ records). Has HNSW vector index (768-dim, cosine, F32). Daemon implementation: `SurrealHypergraphBackend`. Session proxy: `RemoteHypergraphBackend` → daemon `/memory/hypergraph/*` routes. Circuit-breaker: marks `_healthy = false` on first failure, all subsequent calls skip instantly.

**NoOpMemoryBackend** — Fallback when daemon is unreachable. `write()` throws (not silent). `query()` returns `[]`. Logs once via `warnOnce()`.

**Capture Pipeline** — Auto-capture of conversation content. Fires on assistant responses. Path: `classify()` in `pipeline.ts` → Gate (Jev) → Abstract (Gemini) → Store (via `getGlobalHypergraphBackend().store()`). Writes to `node` table. Gated behind `FBH_MEM_TRACE=1` for trace logging.

**Recall Pipeline** — Two independent paths:
- **Auto-recall** (`recall.ts:AutoRecall.autoRecall`): Embeds query → `Memory.searchLocalWithEmbedding()` (memory table) + `fuseHypergraphNodes()` (node table HNSW KNN) → RRF fusion. Injects into system prompt.
- **Tool recall** (`memory.ts:recallImpl`): Embeds query → `backend.query()` (memory table) + `hyper.searchMemoryNodes()` (node table HNSW KNN) → merge by ID, sort by score. Called by `memory_recall` tool.

Both paths search the `memory` table AND `node` table independently.

**BackendRegistry** — Global singletons: `getGlobalMemoryBackend()` / `setGlobalMemoryBackend()` for plain backend, `getGlobalHypergraphBackend()` / `setGlobalHypergraphBackend()` for hypergraph. Returns `HypergraphBackend` interface (not concrete `SurrealHypergraphBackend`).

**Embedding** — Default: DeepInfra `BAAI/bge-base-en-v1.5` (768 dims). Fallback: Ollama `nomic-embed-text`. Config resolved once and cached.

## Relationships

- A **Daemon** has one `SurrealHypergraphBackend` and one `SurrealMemoryBackend` (both connect to SurrealDB via websocket).
- A **Session** has one `RemoteMemoryBackend` and one `RemoteHypergraphBackend` (both proxy to daemon HTTP routes).
- If daemon is unreachable at session init, session gets `NoOpMemoryBackend` and null hypergraph backend.
- The `memory` table (plain backend) and `node` table (hypergraph backend) are separate stores in the same SurrealDB namespace (`foxybear`/`memory`).
- `memory_remember` writes to `memory` table. Capture pipeline writes to `node` table. Recall searches both.

## Infrastructure

| Component | Address | Storage |
|-----------|---------|---------|
| Daemon | `127.0.0.1:4096` | — |
| SurrealDB | `ws://127.0.0.1:8000` | SurrealKV at `~/.local/share/foxybear/memory-server` |
| SQLite (per-branch) | — | `~/.local/share/foxybear/fbh-{branch}.db` |
| Logs | — | `~/.local/share/foxybear/log/` |
| Config | — | `~/.config/foxybear/config.json` |

SurrealDB namespace: `foxybear`, database: `memory`. Auth: `root`/`root`.

## Config Scoping

- `getConfig()` → instance-scoped → requires `Instance.current` → requires ALS context → **throws in daemon boot**
- `getGlobalConfig()` → global-scoped → uses `cachedGlobal` → **safe in daemon boot**
- `isMemoryEnabled()` → uses `getConfig()` → **unsafe in daemon boot** (returns false)
- Daemon boot gates must use `config?.memory?.enabled === true` from global config.

## Flagged Ambiguities

- **`memory` table vs `node` table**: Both store memories. `memory` is the legacy plain backend (920 records, no vector index). `node` is the hypergraph backend (224K+ records, HNSW index). They are NOT the same table and are searched independently.
- **store vs capture**: `memory_remember` → explicit store → `memory` table. Auto-capture → classify pipeline → `node` table. Both are "storing memories" but go to different tables.
- **healthy vs registered**: A backend can be registered (`getGlobalHypergraphBackend() !== null`) but not healthy (`backend.healthy() === false`). Always check both.
- **daemon boot vs session init**: Daemon boot runs subsystem init in a plain for-loop, no ALS context. Session init runs inside Instance.provide(). Code that works in sessions may throw in daemon boot.
