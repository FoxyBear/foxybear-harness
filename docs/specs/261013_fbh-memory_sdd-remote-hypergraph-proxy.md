# SDD: Remote Hypergraph Proxy — Restore Capture Pipeline

**Date:** 2026-10-13
**Project:** FoxyBear Harness (`development/foxybear`)
**Status:** Implementing
**Depends on:** SDD-03 (hypergraph schema), SDD-05 (auto-capture pipeline)

## Problem

Since Sep 28, zero capture memories have been stored. Two root causes:

1. **Boot-gate false negative.** `isMemoryEnabled()` uses instance-scoped `getConfig()` which requires ALS context from `Instance.provide()`. Daemon subsystem init runs outside any Instance context, so the call throws `LocalContext.NotFound("instance")`, the catch returns `false`, and the hypergraph backend never registers.

2. **No session-to-daemon proxy.** Even with the backend registered in the daemon, session processes (TUI) have no way to reach it. The plain `MemoryBackend` has `RemoteMemoryBackend` (proxy to daemon `/memory/*` routes). The `HypergraphBackend` had no equivalent — session processes call `getGlobalHypergraphBackend()`, get `null`, and classify's store stage silently drops.

Additionally, completed one-off migration and backfill code remained in the daemon boot path. When marker files were deleted during a store repair, this dead code re-ran and crashed SurrealDB with a stack overflow.

## Scope

In scope:
- Fix the daemon boot gate to use global config (`config?.memory?.enabled === true`)
- Remove completed migration and backfill code from daemon boot
- `HypergraphBackend` interface extracted from `SurrealHypergraphBackend`
- `RemoteHypergraphBackend` — session-process proxy to daemon hypergraph routes
- Daemon routes: health, store, edge, search
- Session init wiring

Out of scope:
- Remote proxying of query/expand methods (hypergraph traversal degrades gracefully)
- Schema changes
- Lifecycle, conflict, packing (daemon-only, unaffected)

## Behavioral Spec

### Boot Gate

- WHEN the daemon starts with `memory.enabled: true` in global config
  - SHALL register the `SurrealHypergraphBackend` as the global hypergraph backend
  - SHALL log `global hypergraph backend registered`
  - SHALL NOT call `isMemoryEnabled()` (instance-scoped, unavailable at boot)
  - SHALL NOT run migration or backfill (completed, markers exist)

- WHEN the daemon starts with `memory.enabled` absent or false
  - SHALL NOT register the hypergraph backend
  - SHALL NOT attempt SurrealDB connection for hypergraph

### Daemon Routes

- WHEN `GET /memory/hypergraph/health` is called and hypergraph backend is registered
  - SHALL return 200 `{"healthy": true}`

- WHEN `GET /memory/hypergraph/health` is called and no hypergraph backend exists
  - SHALL return 503

- WHEN `POST /memory/hypergraph/store` receives a valid NodeRecord JSON
  - SHALL deserialize the embedding from `number[]` to `Float32Array`
  - SHALL call `backend.store(node)` on the daemon's hypergraph backend
  - SHALL return 200 with `{"node_id": "<id>"}`

- WHEN `POST /memory/hypergraph/edge` receives a valid HyperedgeRecord JSON
  - SHALL deserialize the embedding from `number[]` to `Float32Array`
  - SHALL call `backend.edge(e)` on the daemon's hypergraph backend
  - SHALL return 200 with `{"hyperedge_id": "<id>"}`

- WHEN `POST /memory/hypergraph/search` receives `{embedding, project_id, limit}`
  - SHALL deserialize the embedding from `number[]` to `Float32Array`
  - SHALL call `backend.searchMemoryNodes(embedding, project_id, limit)`
  - SHALL return 200 with the array of matching memory nodes

### Remote Proxy (Session Process)

- WHEN a session process initializes memory with `backendType === "surreal"` and daemon is reachable
  - SHALL create a `RemoteHypergraphBackend` pointed at the daemon
  - SHALL call `init()` which probes `/memory/hypergraph/health`
  - SHALL register it as the global hypergraph backend

- WHEN `RemoteHypergraphBackend.store(node)` is called
  - SHALL serialize `Float32Array` embedding to `number[]`
  - SHALL POST to `/memory/hypergraph/store`
  - SHALL return the original node on success
  - SHALL throw on HTTP error

- WHEN `RemoteHypergraphBackend.edge(e)` is called
  - SHALL serialize `Float32Array` embedding to `number[]`
  - SHALL POST to `/memory/hypergraph/edge`
  - SHALL return the original edge on success

- WHEN `RemoteHypergraphBackend.searchMemoryNodes(embedding, project_id, limit)` is called
  - SHALL serialize `Float32Array` embedding to `number[]`
  - SHALL POST to `/memory/hypergraph/search`
  - SHALL return the matching memory nodes from the daemon's hypergraph backend

- WHEN daemon-only methods are called on `RemoteHypergraphBackend` (query, expand, lifecycle methods)
  - SHALL return empty results ([], null, {node_count:0, edge_count:0})
  - SHALL NOT throw
  - SHALL NOT contact the daemon

### Recall — Direct HNSW Search

- WHEN `memory_recall` tool or `recallImpl()` is called with a query
  - SHALL embed the query and run HNSW KNN search directly on the `node` table via `searchMemoryNodes()`
  - SHALL merge node results with `memory` table results, dedup by ID (node records preferred)
  - SHALL sort merged results by score descending
  - SHALL NOT depend on `memory` table seeds to reach `node` table records
  - SHALL degrade silently if hypergraph backend is absent or unhealthy

### Interface

- WHEN `getGlobalHypergraphBackend()` is called
  - SHALL return `HypergraphBackend | null` (not the concrete `SurrealHypergraphBackend`)
  - SHALL accept both `SurrealHypergraphBackend` (daemon) and `RemoteHypergraphBackend` (session)

### Dead Code Removal

- SHALL remove the SQLite→Surreal migration block from daemon boot (completed one-off)
- SHALL remove the `backfill()` call from daemon boot (completed one-off)
- SHALL NOT affect migration/backfill source files (may be useful for future CLI commands)
