# SDD-02: Phase M-0 — Wire-Up

**Date:** 2026-09-21 (revised 2026-09-22 per council deliberation)
**Project:** FoxyBear Harness Phase M (`development/foxybear`)
**Status:** Draft (pending independent re-audit + human gate)
**Source plan:** `docs/specs/260921_fbh-phase-m_sdd-00-master.md`
**Research:** `docs/research/260921_fbh-phase-m_research.md` (§"Current state of the harness memory system", §"Build plan → Phase M-0")
**Workstream:** `fbh-phase-m` (`tools/sdd/workstreams/fbh-phase-m.json`)
**Depends on:** SDD-01 (P-0 dormant-code audit) — MUST pass before this spec's `implement` stage runs. ABORT A0 in SDD-01 halts the program before M-0 begins. The `tests` stage of this spec refuses to run until SDD-01's `implement` passed.
**Council findings:** This spec incorporates the 2026-09-22 council deliberation guardrails for M-0 (feature flag, dry-run, backup-before-migrate, 48h telemetry gate, abort A1). See SDD-00 §"Council deliberation summary" and SC-11. Originally numbered SDD-01; renumbered to SDD-02 after the P-0 audit was inserted as the new SDD-01.

This is the second feature spec for Phase M, the M-0 wire-up. The first (SDD-01) is the P-0 dormant-code audit which MUST pass before this spec's `implement` stage runs. This spec wires the dormant auto-recall + capture pipeline into the live session loop, fixes the SurrealDB path drift, runs the SQLite→Surreal migration, and re-enables the scheduler with real session IDs. It does NOT introduce new schema, new services, or new lifecycle logic — that is M-1 through M-6. The 2026-09-22 council deliberation established that M-0 migrates real user data and wires untested code (whose runtime behavior is verified by SDD-01, not by this spec) into the production session loop; the guardrails in WHAT #15-#21 below mitigate that risk. Where this spec conflicts with the master, the master wins.

## Scope

In scope (M-0 only):

- Fix SurrealDB path drift: kill the process serving `~/.local/share/opencode/memory-server`, start one against `~/.local/share/foxybear/memory-server`.
- Run `SurrealBackend.migrateFromSqlite` (surreal-backend.ts:378) from the `memory-backend` subsystem init. Create the `~/.local/share/foxybear/memory-migration-surreal.json` marker.
- Re-enable the scheduler in `~/.config/foxybear/fbh.json` (add `scheduler: { enabled: true }` block).
- Wire `AutoRecall.autoRecall` (recall.ts:185) + `AutoRecall.formatForInjection` (recall.ts:279) into `src/session/prompt.ts` as a pre-prompt hook — inject the "## Relevant Memories" block into the `system` array before `handle.process` (prompt.ts:1493).
- Wire `Consolidation.extractTurn` (consolidation.ts:594) into `src/session/prompt.ts` as a post-turn hook — capture per-turn facts after the LLM response finalizes.
- Fix the `Consolidation.run` stub at scheduler.ts:377-381 — pass real `recentSessionIds` from `Session.listGlobal` (index.ts:770), not the `[]` stub.
- Smoke test: a real LLM session with memory injection — verify the "## Relevant Memories" block appears in the prompt sent to the provider.
- **Guardrails (per 2026-09-22 council):** feature flag `memory.enabled` (default false); dry-run mode for `migrateFromSqlite`; backup-before-migrate with restore verification; 48-hour telemetry gate (P95 turn-latency, extraction errors, query volume); abort A1 (dry-run mismatch, unrecoverable loss, sustained P95 > 10% → rollback).

Out of scope (tracked for later phases):

- `Harness.run` wholesale wire-up (master key decision: extract memory bits only; harness.ts:54 remains for mesh/tool-prefetch if needed later).
- Any rewrite of existing logic (CC-2: wire-up only). Exception: `migrateFromSqlite` gets a small additive `dryRun` option (per WHAT #16) — the existing write loop is unchanged; only an early-return branch is added before it.
- The `scheduler.tasks` shape from SC-6 (decay/consolidation/graduation/pruning/gc intervals) — M-0 only needs `enabled: true` to wake the existing `memory-consolidation` + `memory-ttl-pruning` tasks. The full SC-6 config shape is M-1+.
- The `lockDir: "/tmp/opencode-consolidation"` rebrand straggler at scheduler.ts:379 — flagged as fast-follow, not M-0.
- LLM-driven extraction, hypergraph schema, lifecycle decay, budget-aware packing, conflict detection — M-1 through M-6.

### Guardrails (per 2026-09-22 council deliberation)

M-0 is NOT low-risk wire-up. The council found that M-0 (a) migrates real user memory data from SQLite to SurrealDB, and (b) wires dormant code paths (whose runtime behavior is verified by SDD-01, not by this spec) into the production session loop. The following guardrails are required and normative (WHAT #15-#21):

1. **Feature flag** (`memory.enabled`, default false) — WHAT #15. M-0 wire-up is dormant until the user explicitly opts in. Existing sessions continue unaffected.
2. **Dry-run mode** for `migrateFromSqlite` — WHAT #16. Report every planned write without taking it. No marker file created.
3. **Backup-before-migrate** — WHAT #17. SQLite DB + SurrealDB data dir backed up to a timestamped dir; restore verified before migration proceeds.
4. **48-hour telemetry gate** — WHAT #19, #20. P95 turn-latency, extraction errors, query volume emitted hourly for 48 hours. Sustained P95 regression > 10% vs pre-M-0 baseline → ABORT A1.
5. **Idempotent migrateFromSqlite** — WHAT #4 (existing, preserved). Marker file prevents re-runs.
6. **Abort A1** — WHAT #21. Dry-run row count mismatch, unrecoverable data loss, or sustained > 10% P95 over 48h → rollback (restore backup, flip flag, restart, verify). Floor: M-0 baseline-retrieval injection behind flag per SC-11.

No spike for this phase. M-0 is wire-up of already-built code, under the guardrails above.

## WHAT

All WHATs #1-#14 below are conditional on `memory.enabled: true` (per WHAT #15). When `memory.enabled: false` (the default), the M-0 wire-up is dormant and existing behavior is unchanged.

1. WHEN the fbh daemon starts, the system SHALL connect to SurrealDB at `~/.local/share/foxybear/memory-server` (not `~/.local/share/opencode/memory-server`).
2. WHEN the `memory-backend` subsystem initializes at serve.ts:77-88 with `backendType === "surreal"`, the system SHALL invoke `SurrealBackend.migrateFromSqlite` (surreal-backend.ts:378) after `backend.init()`.
3. WHEN `migrateFromSqlite` completes successfully, the system SHALL create the marker file at `~/.local/share/foxybear/memory-migration-surreal.json`.
4. WHEN the marker file already exists, the system SHALL skip re-execution of `migrateFromSqlite` and return `{ ran: false }` (idempotent).
5. WHEN `~/.config/foxybear/fbh.json` contains a `scheduler` block with `enabled: true`, the daemon SHALL start the scheduler subsystem at serve.ts:127-131.
6. WHEN the scheduler fires the `memory-consolidation` maintenance task (scheduler.ts:365), the system SHALL pass real `recentSessionIds` derived from `Session.listGlobal` (index.ts:770), not the `[]` stub at scheduler.ts:380.
7. WHEN the session prompt is assembled at prompt.ts:1477-1490, the system SHALL call `AutoRecall.autoRecall` (recall.ts:185) with the last user message text, the active persona, and the current `project_id`.
8. WHEN `AutoRecall.autoRecall` returns non-empty results, the system SHALL append `AutoRecall.formatForInjection(results)` (recall.ts:279) to the `system` array before `handle.process` is called at prompt.ts:1493.
9. WHEN `AutoRecall.autoRecall` returns empty results OR throws, the system SHALL proceed with no memory block (graceful degradation — no crash, no empty "## Relevant Memories" heading, no user-visible error).
10. WHEN a session turn finalizes (assistant message complete, no error), the system SHALL call `Consolidation.extractTurn` (consolidation.ts:594) with the session's messages, `sessionID`, and persona, running in the background (fire-and-forget — does not block the next turn).
11. WHEN `Consolidation.extractTurn` encounters malformed input OR its internal extraction times out, the system SHALL degrade gracefully (CN-05 — never block the user). `extractTurn` is structurally non-throwing by design (try/catch wraps the entire body at consolidation.ts:604-638). On malformed input (no user message, no `part.content`), it silently resolves to `void` (no warn log — `getLastUserMessage` returns null at consolidation.ts:102, `extractFacts` returns `[]`, `performExtraction` returns early at consolidation.ts:650). On timeout (extraction exceeds `timeoutMs`), it logs `consolidation: extraction timed out` at warn level. In both cases no exception propagates and the next turn proceeds normally.
12. WHEN a real LLM session runs against a real provider with at least one stored memory matching the query, the prompt sent to the LLM SHALL contain a "## Relevant Memories" block with at least one numbered entry.
13. WHEN `bun run typecheck` runs from `packages/fbh`, it SHALL exit 0.
14. WHEN `bun test --timeout 30000` runs from `packages/fbh`, it SHALL exit 0 (known-baseline failures tolerated per the workstream's `baselineFile`).
15. WHEN `~/.config/foxybear/fbh.json` does NOT set `memory.enabled: true`, the system SHALL skip every M-0 wire-up code path: `migrateFromSqlite` (surreal-backend.ts:378) is NOT invoked from `serve.ts:77-88`; `Scheduler.start` (serve.ts:127-131) is NOT called even if `scheduler.enabled: true` is set; `AutoRecall.autoRecall` (recall.ts:185) is NOT invoked from `prompt.ts:1477`; `Consolidation.extractTurn` (consolidation.ts:594) is NOT forked from `prompt.ts:1493+`. Existing sessions proceed identically to a pre-M-0 daemon. Default state of `memory.enabled` is `false` — M-0 does not affect any existing session until the user explicitly opts in by setting `memory.enabled: true` in `fbh.json`.
16. WHEN `memory.enabled: true` AND `memory.migrate.dry_run: true`, `SurrealBackend.migrateFromSqlite` (surreal-backend.ts:378) SHALL accept a `{ dryRun: true }` option and run in dry-run mode: it SHALL iterate every SQLite row that would be migrated (memories, entities, edges), compute the SurrealDB write it would perform for each, accumulate a report `{ dryRun: true, planned_rows: { memories: N_m, entities: N_e, edges: N_d }, planned_writes: [...], skipped: [...] }`, and return the report WITHOUT taking any write action. No SurrealDB mutations. No marker file created at `~/.local/share/foxybear/memory-migration-surreal.json`. The daemon logs `{ dryRun: true, planned_rows: {...} }` at info level. The existing `migrateFromSqlite` (verified at surreal-backend.ts:378-459) does NOT currently support a `dryRun` option — this spec ADDS the option (small additive change, not a rewrite: an early-return branch before the existing write loop at :405; the write loop itself is unchanged).
17. WHEN `memory.enabled: true` AND `memory.migrate.dry_run: false` AND the migration marker file does NOT exist, the system SHALL first take a backup before invoking `migrateFromSqlite`: copy `~/.local/share/foxybear/memory.db` (and `-wal`, `-shm` sidecars if present) and recursively copy `~/.local/share/foxybear/memory-server/` into `~/.local/share/foxybear/backups/pre-migration-<ISO8601>/`. The backup SHALL be verified by (a) opening the SQLite backup and running `SELECT COUNT(*) FROM memory` (must equal the live count) and (b) listing the SurrealDB backup dir (must contain `manifest/`, `sstables/`, `vlog/`, `wal/`). If either verification fails, the system SHALL NOT run `migrateFromSqlite` — abort in place, log `backup verification failed, aborting migration` at error level, leave the marker file absent. The backup directory SHALL be retained after migration for rollback (per WHAT #21).
18. WHEN `migrateFromSqlite` (non-dry-run) returns, the system SHALL compare its reported `memories` count `M` (and `entities`, `edges` counts) against the dry-run planned counts `N` (computed by running a dry-run pass first per WHAT #16, immediately before the actual migration). If `M < N` for any table (rows skipped, indicating unrecoverable data loss — the existing per-row try/catch at surreal-backend.ts:428-430, :453-455 logs `migration: skipped memory row` but continues), the system SHALL log the mismatch with the skipped row IDs (extracted from the warn logs), leave the marker file absent, restore from the WHAT #17 backup, and trigger ABORT A1 per WHAT #21.
19. WHEN `memory.enabled: true` and the daemon is running post-wire-up, the system SHALL emit telemetry hourly into `~/.local/share/foxybear/telemetry/m0-<ISO8601>-<bucket>.json` containing: (a) P95 turn-latency — `handle.process` dispatch (prompt.ts:1493) to assistant message finalize (`finished` branch at :1514), in milliseconds, computed per-turn and aggregated per-bucket via a sliding window; (b) extraction error count — number of `Consolidation.extractTurn` invocations that hit the `consolidation: extraction failed` or `consolidation: extraction timed out` warn log (consolidation.ts:623, :638); (c) query volume — `autoRecall` invocation count and `extractTurn` invocation count. A pre-M-0 baseline P95 SHALL be captured before `memory.enabled` flips to true (median P95 across 1 hour of pre-flag telemetry, same instrumentation, stored as `~/.local/share/foxybear/telemetry/m0-baseline-<ISO8601>.json`). The first 48 hourly buckets after the flag flip constitute the "48-hour telemetry gate". Test mode shortens the bucket via `memory.telemetry.test_window_seconds` (production default: 3600-second hourly buckets × 48 = 48 hours; test: 5-second buckets × 48 = 4 minutes simulated).
20. WHEN the 48-hour telemetry gate elapses, the system SHALL compute sustained P95 turn-latency regression: the median P95 across the 48 buckets divided by the pre-M-0 baseline P95, minus 1, expressed as a percentage. If the sustained regression exceeds 10%, the system SHALL trigger ABORT A1 per WHAT #21. "Sustained" = median across the full 48h, not a single hourly spike. A single bucket exceeding 10% is a warning logged at warn level, NOT an abort. The 5% threshold (≤ 5% sustained = pass) is the success criterion; > 5% and ≤ 10% sustained is a warning + continued monitoring; > 10% sustained is ABORT A1.
21. WHEN any of the following triggers occurs, the system SHALL halt and rollback (ABORT A1 per SC-11): (a) dry-run row count mismatch (`M < N` per WHAT #18); (b) unrecoverable data loss (any source row skipped per WHAT #18); (c) sustained P95 turn-latency regression > 10% over the 48h gate (per WHAT #20); (d) backup verification failure (per WHAT #17, migration aborted in place — restore is a no-op since migration didn't run). Rollback procedure: (1) restore the SQLite DB + SurrealDB data dir from the WHAT #17 backup (if migration occurred); (2) flip `memory.enabled` back to `false` in `~/.config/foxybear/fbh.json`; (3) restart the daemon; (4) verify P95 returns to baseline ± 5% over 1 hour of post-rollback telemetry (test: 1 minute); (5) log the rollback to `~/.local/share/foxybear/m0-rollback-<ISO8601>.json` with `{ trigger, action, verification }`. ABORT A1 halts the M-0 wire-up; the program continues at the floor (M-0 baseline-retrieval injection behind flag) per SC-11.

## HOW

### Reuse map

**Wired (existing, no rewrite — CC-2):**

| Function | Anchor | Wire-up site |
|---|---|---|
| `SurrealBackend.migrateFromSqlite` | `src/memory/surreal-backend.ts:378` | `src/cli/cmd/serve.ts:77-88` (`memory-backend` subsystem init, after `backend.init()`) |
| `AutoRecall.autoRecall` | `src/memory/recall.ts:185` | `src/session/prompt.ts:1477` (inside `SessionPrompt.prompt` Effect.fn, before `handle.process` at `:1493`) |
| `AutoRecall.formatForInjection` | `src/memory/recall.ts:279` | `src/session/prompt.ts:1485-1490` (append to `system` array) |
| `Consolidation.extractTurn` | `src/memory/consolidation.ts:594` | `src/session/prompt.ts:1493+` (after `handle.process` finalizes, fire-and-forget via `run.fork` at `:117`) |
| `Consolidation.run` | `src/memory/consolidation.ts:533` | already invoked at `src/scheduler/scheduler.ts:377`; fix the `recentSessionIds: []` stub at `:380` |
| `Memory.getPrunable` | `src/memory/memory.ts:756` | already invoked at `src/scheduler/scheduler.ts:389` (re-enabled by WHAT #5) |
| `Session.listGlobal` | `src/session/index.ts:770` | new `recent()` helper in scheduler.ts to feed `Consolidation.run` |

**New (small, wire-up only):**

| Function | Location | Purpose |
|---|---|---|
| `inject(input)` | `src/session/prompt.ts` (inline in `SessionPrompt.prompt` or as a local `Effect.fn`) | call `autoRecall` + `formatForInjection`, return the block string or `""` |
| `capture(input)` | `src/session/prompt.ts` (inline or local `Effect.fn`) | call `extractTurn` with the right message shape, fire-and-forget via `run.fork` |
| `recent(limit?)` | `src/scheduler/scheduler.ts` (local helper in `registerMaintenanceTasks`) | call `Session.listGlobal({ limit: limit ?? 50 })`, map to `id` array, feed `Consolidation.run` |
| `isMemoryEnabled()` | `src/memory/config.ts` (new, reads `Instance.config.memory?.enabled === true`) | master gate for all M-0 call sites (WHAT #15) |
| `migrateFromSqlite({ dryRun })` | `src/memory/surreal-backend.ts:378` (additive `dryRun` option, early-return branch before existing write loop) | dry-run report without writes (WHAT #16) |
| `backupBeforeMigrate()` | `src/memory/migrate-backup.ts` (new, ~30 lines) | copy SQLite + SurrealDB data dir, verify restore (WHAT #17) |
| `emitTelemetry(event)` | `src/memory/m0-telemetry.ts` (new, ~50 lines) | hourly P95 / error count / query volume writer (WHAT #19) |
| `checkAbortA1(trigger)` | `src/memory/m0-abort.ts` (new, ~40 lines) | rollback procedure: restore + flag flip + restart + verify (WHAT #21) |

### Approach

**A. SurrealDB path fix + migration (WHAT #1-#4)**

The code already points at the foxybear path. `src/cli/cmd/serve.ts:41` prints the start command: `~/.surrealdb/surreal start --user root --pass root surrealkv:~/.local/share/foxybear/memory-server`. The drift is the running process (PID 89686 serves the opencode path, per research §"Environmental drift").

M-0 actions:

1. Kill the running surreal process serving `~/.local/share/opencode/memory-server`.
2. Start a fresh surreal process against `~/.local/share/foxybear/memory-server` (the foxybear data dir already exists with `manifest/`, `sstables/`, `vlog/`, `wal/` — verified).
3. Wire `migrateFromSqlite` into the `memory-backend` subsystem init at `src/cli/cmd/serve.ts:77-88`. After `await backend.init()` (line 86), add:
   ```ts
   if (backendType === "surreal" && backend.migrateFromSqlite && isMemoryEnabled()) {
     const cfg = Instance.config.memory?.migrate ?? {}
     if (cfg.dry_run) {
       const report = await backend.migrateFromSqlite({ dryRun: true })
       log.info("memory migration dry-run", { ...report })
     } else {
       await backupBeforeMigrate()  // WHAT #17 — verifies restore before proceeding
       const dryRunReport = await backend.migrateFromSqlite({ dryRun: true })  // WHAT #18 — compute N first
       const report = await backend.migrateFromSqlite()  // actual migration, returns M
       if (report.memories < dryRunReport.memories || report.entities < dryRunReport.entities || report.edges < dryRunReport.edges) {
         await checkAbortA1("dry_run_mismatch_or_data_loss")  // WHAT #18, #21
         return
       }
       log.info("memory migration", { ran: report.ran, memories: report.memories, duration_ms: report.duration_ms })
     }
   }
   ```
   `migrateFromSqlite` is already idempotent — it checks the marker at `surreal-backend.ts:384` and returns `{ ran: false, ... }` if present. No new idempotency logic needed (WHAT #4 preserved).

**B. Scheduler re-enable + recentSessionIds fix (WHAT #5-#6)**

`~/.config/foxybear/fbh.json` currently has no `scheduler` block (verified — only `memory.embedding` + `memory.graph_backend` at lines 37-44). Add:

```json
{
  "scheduler": {
    "enabled": true
  }
}
```

The `SchedulerConfig` interface at `scheduler/scheduler.ts:45-52` defaults the rest (`check_interval_seconds: 60`, `pruning_schedule: "0 3 * * *`, etc.). The existing `memory-consolidation` task (scheduler.ts:365) and `memory-ttl-pruning` task (scheduler.ts:385) fire automatically once the scheduler starts.

Fix the `recentSessionIds: []` stub at `scheduler.ts:380`:

```ts
handler: async () => {
  const { Consolidation } = await import("../memory/consolidation")
  const { Session } = await import("../session")
  const recent = [...Session.listGlobal({ limit: 50 })].map(s => s.id)
  await Consolidation.run({
    persona: "default",
    lockDir: "/tmp/opencode-consolidation",
    recentSessionIds: recent,
  })
},
```

`Session.listGlobal` is a generator (`session/index.ts:770`) ordered by `desc(SessionTable.time_updated)` — exactly the "recent sessions" semantic the stub was missing.

Note: `lockDir: "/tmp/opencode-consolidation"` at scheduler.ts:379 is a rebrand straggler. M-0 leaves it (CC-2: wire-up only, no rewrite). Fast-follow.

**C. Pre-prompt injection (WHAT #7-#9 — the gap)**

`SessionPrompt.prompt` at `prompt.ts:1279` assembles the `system` array at `:1485-1490`:

```ts
const system = [
  ...(personaPrompt ? [personaPrompt] : []),
  ...env,
  ...(skills ? [skills] : []),
  ...instructions,
]
```

After this assembly and before `handle.process` at `:1493`, call a new `inject(input)` helper — but ONLY if `isMemoryEnabled()` returns true (WHAT #15):

```ts
const mem = isMemoryEnabled() ? yield* inject({ sessionID, query: lastUser.text, persona, project_id: Instance.project.id }) : ""
const system = [
  ...(personaPrompt ? [personaPrompt] : []),
  ...env,
  ...(skills ? [skills] : []),
  ...instructions,
  ...(mem ? [mem] : []),
]
```

`inject` is an `Effect.fnUntraced` that:

- Skips if `lastUser.text` starts with `/` (AR-02, recall.ts:187).
- Calls `AutoRecall.autoRecall({ sessionID, query, persona, project_id })` (recall.ts:185). `AutoRecall` handles its own caching (turnCache at recall.ts:201-207), embedding fallback (AR-05/06/07), and workforce query (AR-10/11) — none of that is rewritten.
- On non-empty results, returns `AutoRecall.formatForInjection(results)` (recall.ts:279).
- On empty results, returns `""` (AR-14 — formatForInjection already returns `""` for empty, so the helper just forwards).
- On any throw, logs at warn and returns `""` (graceful degradation — AR-07 pattern).

`persona` is already extracted at `prompt.ts:1484`: `PersonaSession.get(sessionID) ?? PersonaSession.getDefault()`. `project_id` is `Instance.project.id` (used throughout `system.ts:50`).

**D. Post-turn capture (WHAT #10-#11 — the gap)**

After `handle.process` at `prompt.ts:1493` returns and the assistant message is finalized (the `finished` branch at `:1514`), fork a `capture(input)` effect — but ONLY if `isMemoryEnabled()` returns true (WHAT #15):

```ts
if (finished && !handle.message.error && isMemoryEnabled()) {
  yield* run.fork(capture({ sessionID, messages: msgs, persona }))
  // existing structured-output / finish handling
}
```

`capture` is an `Effect.fnUntraced` that:

- Calls `Consolidation.extractTurn({ sessionID, messages, persona })` (consolidation.ts:594).
- `extractTurn` already handles: `auto_capture` config gate (CN-06), slash-command skip (CN-04), 10s timeout (CN-05), and never throws (CN-05). No new error handling needed — but `capture` wraps in a `try`/`catch` anyway because the existing code is async-Promise-based and we're calling it from an Effect context.
- `messages` shape: `extractTurn` expects `any[]` with `{ role, parts: [{ type: "text", content }] }` — verified via `getLastUserMessage` (consolidation.ts:102, filters on top-level `messages[i]?.role === "user"`) and `getTextContent` (consolidation.ts:92-100, returns `part.content`, NOT `part.text`). The session has `msgs: MessageV2.WithParts[]` at `prompt.ts:1481`, which differs in TWO ways: (1) role lives at `info.role` (`WithParts.info: Info`, message-v2.ts:511), not top-level `role`; (2) `MessageV2.TextPart` has `text` (message-v2.ts:113-128), not `content`. Passing `msgs` directly would silently extract zero facts (`getLastUserMessage` finds no user message, `getTextContent` returns `null` for every part). An adapter inside `capture` is REQUIRED (wire-up, not rewrite):
  ```ts
  const adapted = msgs.map(m => ({
    role: m.info.role,
    parts: m.parts.map(p => p.type === "text" ? { type: "text", content: p.text } : p),
  }))
  yield* Effect.promise(() => extractTurn({ sessionID, messages: adapted, persona }))
  ```

`run.fork` is already available at `prompt.ts:117` — fire-and-forget, the next turn is not blocked.

**E. Smoke test (WHAT #12)**

Test file: `packages/fbh/test/m0_wire_up.test.ts` (run from `packages/fbh` per AGENTS.md). No mocks of our code (CC-5). Real provider, real XDG paths.

Test cases:

1. **Path/marker**: assert `Bun.file(path.join(Global.Path.data, "memory-migration-surreal.json")).exists()` is true. Assert the daemon's SurrealDB client is connected to the foxybear path (read from the surreal config used at `serve.ts:60-62`).
2. **Scheduler with real IDs**: start the daemon with `scheduler.enabled: true`. Wait for the first `memory-consolidation` tick (or trigger `Scheduler.getMaintenanceTasks()[0].handler()` directly). Assert `Consolidation.run` receives a non-empty `recentSessionIds` array. The `gather` phase (consolidation.ts:301) iterates `input.recentSessionIds` — if non-empty, it calls `extractSearchTerms(sessionId)` per session. Assert at least one `searchTerms` lookup fires.
3. **Injection**: seed a memory via `Memory.store({ content, persona, project_id })`. Boot a real LLM session. Send a query that matches the seeded memory. Capture the outgoing prompt (intercept at the provider call layer — the existing `LLM.Service` at `session/llm.ts:56` is the choke point). Assert the captured prompt contains `## Relevant Memories` and at least one numbered entry.
4. **Capture**: after a real turn with content that triggers extraction (a preference statement like "always use Bun.file() over fs"), assert `Memory.list({ persona })` includes a memory with `metadata.source === "extraction"` (CN-03 at consolidation.ts:589).
5. **Call-site grep (CC-2)**: assert `grep -rn "AutoRecall.autoRecall\|AutoRecall.formatForInjection\|Consolidation.extractTurn\|Consolidation.run\|Memory.getPrunable" src/` returns at least one call site outside each function's own definition. Specifically: `AutoRecall.autoRecall` has a call site in `prompt.ts`; `Consolidation.extractTurn` has a call site in `prompt.ts`; `Consolidation.run` is called from `scheduler.ts` with non-empty `recentSessionIds`; `Memory.getPrunable` is called from `scheduler.ts:389`.

**F. Feature flag, dry-run, backup (WHAT #15-#18 — the guardrails)**

The `memory.enabled` flag is the master gate for ALL M-0 wire-up. Add to `~/.config/foxybear/fbh.json`:

```json
{
  "memory": {
    "enabled": false,
    "migrate": {
      "dry_run": false
    },
    "telemetry": {
      "window_hours": 48,
      "p95_threshold_pct": 10,
      "p95_warn_pct": 5,
      "test_window_seconds": null
    }
  }
}
```

Read via a new `isMemoryEnabled()` helper that reads `Instance.config.memory?.enabled === true`. The gate is a single `if` check at each M-0 call site (serve.ts:77 migration, serve.ts:127 scheduler, prompt.ts:1477 injection, prompt.ts:1493+ capture). CC-2 (wire-up only) permits this because the gate is a guardrail, not a behavior change.

`migrateFromSqlite` (surreal-backend.ts:378) currently does NOT support a `dryRun` option (verified at surreal-backend.ts:378-459 — the function signature is `async migrateFromSqlite(): Promise<MigrationReport>` and unconditionally writes). Add a `dryRun` parameter and an early-return branch before the existing write loop:

```ts
async migrateFromSqlite(opts?: { dryRun?: boolean }): Promise<MigrationReport> {
  if (!this.opened) throw new Error("SurrealBackend not initialized")
  const start = Date.now()
  const { Global } = await import("../global")
  const markerPath = path.join(Global.Path.data, "memory-migration-surreal.json")
  // In dry-run, do NOT check or write the marker — dry-run is non-mutating.
  if (!opts?.dryRun && fs.existsSync(markerPath)) {
    log.info("migration already complete, skipping", { markerPath })
    return { memories: 0, entities: 0, edges: 0, duration_ms: 0, ran: false }
  }
  const { Database } = await import("../storage/db")
  const { MemoryTopicsTable, GraphEntityTable, GraphEdgeTable } = await import("./memory.sql")
  const { bufferToFloat32 } = await import("./memory")
  const rows = Database.use((db) => ({
    memories: db.select().from(MemoryTopicsTable).all(),
    entities: db.select().from(GraphEntityTable).all(),
    edges: db.select().from(GraphEdgeTable).all(),
  }))
  if (opts?.dryRun) {
    const planned = { memories: rows.memories.length, entities: rows.entities.length, edges: rows.edges.length }
    log.info("dry-run migration report", { planned_rows: planned })
    return { dryRun: true, memories: planned.memories, entities: planned.entities, edges: planned.edges, duration_ms: Date.now() - start, ran: false }
  }
  // existing write loop at :405+ continues unchanged
  ...
}
```

This is a small additive change: a `dryRun` parameter, a marker-check skip in dry-run, and an early-return branch before the write loop. The existing write logic is unchanged. CC-2 permits this because the dry-run is a guardrail required by the 2026-09-22 council.

Before the actual (non-dry-run) migration, take a backup (new `backupBeforeMigrate()` helper in `src/memory/migrate-backup.ts`):

```ts
const backupDir = path.join(Global.Path.data, "backups", `pre-migration-${ISO8601}`)
await fs.mkdir(backupDir, { recursive: true })
await fs.copyFile(path.join(Global.Path.data, "memory.db"), path.join(backupDir, "memory.db"))
// copy -wal, -shm if present
for (const sidecar of ["memory.db-wal", "memory.db-shm"]) {
  const src = path.join(Global.Path.data, sidecar)
  if (fs.existsSync(src)) await fs.copyFile(src, path.join(backupDir, sidecar))
}
const surrealSrc = path.join(Global.Path.data, "memory-server")
const surrealDst = path.join(backupDir, "memory-server")
await fs.cp(surrealSrc, surrealDst, { recursive: true })

// verify (WHAT #17)
const liveCount = Database.use((db) => db.select().from(MemoryTopicsTable).all().length)
const sqliteBackup = new Database(path.join(backupDir, "memory.db"))
const backupCount = sqliteBackup.prepare("SELECT COUNT(*) as c FROM memory").get().c
if (backupCount !== liveCount) {
  throw new Error(`backup verification failed: sqlite row count mismatch (live=${liveCount}, backup=${backupCount})`)
}
const surrealBackupListing = await fs.readdir(surrealDst)
for (const required of ["manifest", "sstables", "vlog", "wal"]) {
  if (!surrealBackupListing.includes(required)) {
    throw new Error(`backup verification failed: surreal dir missing ${required}`)
  }
}
return backupDir
```

On verification failure: abort the migration (do not invoke `migrateFromSqlite`), log `backup verification failed, aborting migration` at error level, leave the marker file absent. The backup dir is retained for inspection.

**G. Telemetry + abort A1 (WHAT #19-#21 — the guardrails)**

Hourly telemetry writer (new `emitTelemetry(event)` helper in `src/memory/m0-telemetry.ts`):

```ts
// in session/prompt.ts: capture turnStartTime at handle.process dispatch
const turnStartTime = Date.now()
const handle = yield* handle.process(...)
if (finished && !handle.message.error) {
  const turnLatencyMs = Date.now() - turnStartTime
  if (isMemoryEnabled()) {
    yield* run.fork(emitTelemetry({ p95_turn_latency_ms: computeP95(turnLatencyMs), ... }))
  }
}
```

P95 computed over a sliding bucket (production: 3600-second hourly; test: `memory.telemetry.test_window_seconds`). Written to `~/.local/share/foxybear/telemetry/m0-<ISO8601>-<bucket>.json` at the top of each bucket.

Pre-M-0 baseline: 1 hour of telemetry with `memory.enabled: false`, same instrumentation. Computed median P95 over that hour. Stored as `~/.local/share/foxybear/telemetry/m0-baseline-<ISO8601>.json`. The baseline is captured before `memory.enabled` flips to true.

After 48 buckets elapse with `memory.enabled: true`, compute sustained P95 = median P95 across the 48 buckets. Compare to baseline. If `(sustainedP95 - baselineP95) / baselineP95 > 0.10`, fire ABORT A1 (new `checkAbortA1(trigger)` helper in `src/memory/m0-abort.ts`).

ABORT A1 rollback procedure:

1. Restore the SQLite DB + SurrealDB data dir from the WHAT #17 backup (if migration occurred; if migration was aborted in place per WHAT #17 verification failure, restore is a no-op)
2. Flip `memory.enabled` to `false` in `~/.config/foxybear/fbh.json`
3. Restart the daemon
4. Verify P95 returns to baseline ± 5% over 1 hour of post-rollback telemetry (test: 1 minute)
5. Log rollback to `~/.local/share/foxybear/m0-rollback-<ISO8601>.json` with `{ trigger, action, verification }`

For the dry-run mismatch and unrecoverable loss triggers (WHAT #18), the rollback fires immediately at migration time (not after 48h) — the migration has just completed (or partially completed), the mismatch is detected, and the rollback procedure runs.

## VERIFY

Acceptance criteria mapped 1:1 to WHAT. All tests run from `packages/fbh` (CC-4 / AGENTS.md). No mocks of implementation under test (CC-5).

| # | WHAT | Setup | Action | Expected |
|---|---|---|---|---|
| V1 | #1 (path) | Kill any surreal process; start one against the foxybear path | Start the fbh daemon (`fbh serve` or the daemon entry) | Daemon's surreal client connects to `~/.local/share/foxybear/memory-server`. `lsof`/`ps` confirms the surreal process serves the foxybear path. |
| V2 | #2,#3 (migration runs) | Fresh foxybear data dir, no marker file | Start the daemon; wait for `memory-backend` subsystem init | `~/.local/share/foxybear/memory-migration-surreal.json` exists. Migration log line `{ ran: true, memories: N, duration_ms: ... }` emitted. The existing 1 SQLite row (the Phase A rebrand memory) appears in the Surreal `memory` table. |
| V3 | #4 (idempotent) | Marker file present from V2 | Restart the daemon | `migrateFromSqlite` returns `{ ran: false, memories: 0, ... }`. No duplicate rows in Surreal. Log line: `migration already complete, skipping`. |
| V4 | #5 (scheduler starts) | `fbh.json` with `scheduler: { enabled: true }` | Start the daemon | `Scheduler.start` called (serve.ts:128). `Scheduler.running` is true. The `memory-consolidation` and `memory-ttl-pruning` tasks are registered (`Scheduler.getMaintenanceTasks()` returns both). |
| V5 | #6 (real recentSessionIds) | Scheduler running; at least one session exists in the SessionTable | Trigger the `memory-consolidation` task handler directly (`Scheduler.getMaintenanceTasks().find(t => t.name === "memory-consolidation").handler()`) | `Consolidation.run` receives `recentSessionIds.length >= 1`. The `gather` phase (consolidation.ts:301) iterates at least one session ID. No `[]` stub. |
| V6 | #7 (autoRecall called) | A session with at least one stored memory; persona + project_id set | Send a query through `SessionPrompt.prompt` (prompt.ts:1279) | `AutoRecall.autoRecall` is invoked with `{ sessionID, query: <last user text>, persona, project_id }`. Verified by observing the recall turn cache (recall.ts:201) is populated for this session+query. |
| V7 | #8 (block injected) | Same as V6; autoRecall returns non-empty | Capture the `system` array passed to `handle.process` at prompt.ts:1493 | `system` includes a string starting with `## Relevant Memories` containing at least one numbered entry. The block is the last element of `system` (after `instructions`). |
| V8 | #9 (graceful degradation) | No stored memories for this persona/project; OR force `Embedding.embedSafe` to fail by setting an invalid embedding provider | Send a query through `SessionPrompt.prompt` | `system` array does NOT contain any string starting with `## Relevant Memories`. No exception propagated. `handle.process` is still called. Daemon stays alive. |
| V9 | #10 (extractTurn called) | A real session turn completes (assistant message finalized, no error) | Wait for `handle.process` to return with `finished = true` | A `capture` effect is forked (via `run.fork` at prompt.ts:117). `Consolidation.extractTurn` is invoked with `{ sessionID, messages, persona }`. The next turn is not blocked (latency of next `handle.process` call is unchanged within measurement noise). |
| V10 | #11 (capture never blocks) | Two scenarios. (a) **Malformed input**: set `auto_capture: true` but pass a messages shape with no top-level `role` (e.g., raw `MessageV2.WithParts[]` unadapted — role lives at `info.role`). (b) **Timeout**: set `timeoutMs: 1` and seed a user message matching a preference pattern so `performExtraction` calls `Memory.store` (slow enough to miss the 1ms deadline). | Send a query; wait for turn finalization | (a) `extractTurn` resolves to `void` with NO warn log (silent graceful degradation — `getLastUserMessage` returns null, `extractFacts` returns `[]`, `performExtraction` returns early at consolidation.ts:650). No exception propagated. (b) Warn-level log line `consolidation: extraction timed out`. No exception propagated. In both cases the next turn proceeds normally. |
| V11 | #12 (smoke — end-to-end) | Real provider key (`~/Development/.openai_api.key` or anthropic). One seeded memory: `Memory.store({ content: "User prefers Bun.file() over fs", persona: "default", project_id: <current> })` | Run `fbh` in interactive mode; send the query "What file API should I use?" | The outgoing prompt to the provider contains `## Relevant Memories` and a numbered entry mentioning `Bun.file()`. Verified by inspecting the provider request payload (intercept at `LLM.Service` at `session/llm.ts:56` or provider client). |
| V12 | #13 (typecheck) | M-0 changes applied | Run `bun run typecheck` from `packages/fbh` | Exit 0. No new type errors. |
| V13 | #14 (test suite) | M-0 changes applied; tests from V1-V11 added | Run `bun test --timeout 30000` from `packages/fbh` | Exit 0, excluding known-baseline failures listed in the workstream's `baselineFile`. New M-0 tests pass. |
| V14 | #15 (feature flag off) | `fbh.json` without `memory.enabled` (or `memory.enabled: false`); one stored memory; one stored session | Start the daemon; send a query through `SessionPrompt.prompt` | `migrateFromSqlite` is NOT called (no `memory migration` log line). `Scheduler.start` is NOT called (Scheduler.running is false). `AutoRecall.autoRecall` is NOT invoked (recall turn cache at recall.ts:201 is empty for this session). `Consolidation.extractTurn` is NOT forked (no `capture` fiber; no `consolidation: extraction ...` log). The `system` array at prompt.ts:1493 contains no `## Relevant Memories` block. The marker file at `~/.local/share/foxybear/memory-migration-surreal.json` is NOT created. The session behaves identically to a pre-M-0 daemon (regression-safe). |
| V15 | #16 (dry-run) | `fbh.json` with `memory: { enabled: true, migrate: { dry_run: true } }`; SQLite has N_m memories, N_e entities, N_d edges; marker file absent | Start the daemon; wait for `memory-backend` subsystem init | `migrateFromSqlite` runs in dry-run mode. Returns `{ dryRun: true, memories: N_m, entities: N_e, edges: N_d, ran: false, duration_ms: ... }`. NO rows written to SurrealDB (Surreal `memory` table count is unchanged from pre-daemon). NO marker file created. Log line `{ dryRun: true, planned_rows: { memories: N_m, entities: N_e, edges: N_d } }` at info level. Subsequent restart with `dry_run: false` still migrates from scratch (marker still absent). |
| V16 | #17 (backup + restore verify) | `fbh.json` with `memory: { enabled: true, migrate: { dry_run: false } }`; SQLite has N rows; marker file absent | Start the daemon | Before `migrateFromSqlite` runs, `~/.local/share/foxybear/backups/pre-migration-<ISO8601>/` exists. Contains `memory.db` (with `-wal`, `-shm` if present) and `memory-server/` subtree (`manifest/`, `sstables/`, `vlog/`, `wal/`). `SELECT COUNT(*) FROM memory` on the SQLite backup equals N. SurrealDB backup dir listing contains `manifest/`, `sstables/`, `vlog/`, `wal/`. Both verifications pass. `migrateFromSqlite` proceeds. Marker file created. |
| V17 | #17 (restore fail → abort in place) | Same as V16, but corrupt the SQLite backup after creation (delete `memory.db` mid-test) OR replace the SurrealDB backup dir with an empty dir | Start the daemon | Backup verification FAILS. `migrateFromSqlite` is NOT invoked. Marker file is NOT created. Daemon logs `backup verification failed, aborting migration` at error level. Daemon stays alive. No SurrealDB mutations occurred. Backup dir is retained for inspection. |
| V18 | #18, #19 (telemetry emission) | `fbh.json` with `memory: { enabled: true, telemetry: { test_window_seconds: 5 } }`; daemon running with the M-0 wire-up active | Run for 4 minutes (test mode: 5-second buckets × 48 = 48 buckets); exercise 5+ turns | 48 telemetry files written to `~/.local/share/foxybear/telemetry/m0-<ISO8601>-<bucket>.json`. Each file contains `p95_turn_latency_ms`, `extraction_error_count`, `query_volume: { auto_recall, extract_turn }`. All three fields populated with non-zero values for at least one bucket (assuming turns were exercised). Pre-M-0 baseline file `m0-baseline-<ISO8601>.json` exists (captured before flag flip). |
| V19 | #18, #20, #21 (abort A1 — rollback) | Three scenarios. (a) **Dry-run mismatch**: seed SQLite with N rows; run dry-run (reports N); force one row to skip during actual migration (e.g., monkey-patch `migrateFromSqlite` write loop to throw on one row without changing `memories` count). (b) **Unrecoverable loss**: monkey-patch `migrateFromSqlite` to silently drop 1 row without logging a skip (return `memories: N - 1`). (c) **P95 sustained > 10%**: pre-M-0 baseline P95 = 100ms; inject synthetic 150ms latency into `handle.process` for all 48 test buckets (5-second buckets × 48 = 4 minutes). | Each scenario: start daemon with `memory.enabled: true`; wait through migration + 48h gate (test: 4 minutes simulated via `test_window_seconds: 5`) | (a) Dry-run row count mismatch detected: rollback fires. Marker file NOT created. Surreal `memory` table restored to pre-migration state (zero rows). `memory.enabled` flipped to `false` in `fbh.json`. Daemon restarted. `~/.local/share/foxybear/m0-rollback-<ISO8601>.json` exists with `{ trigger: "dry_run_mismatch", action: "restore+flag+restart", verification: "p95_returned_to_baseline" }`. (b) Same with `trigger: "unrecoverable_loss"`. (c) Sustained P95 = 150ms, baseline = 100ms, regression = 50% > 10%: rollback fires with `trigger: "p95_regression_sustained"`. After rollback, P95 returns to ≤ 105ms (baseline ± 5%) over 1 post-rollback hour (test: 1 minute). |

### Build / regression gate

After implementation, run from `development/foxybear/packages/fbh`:

```bash
bun run typecheck
bun test --timeout 30000
```

Both must exit 0 (CC-4). Known-baseline failures are tolerated per the workstream's `baselineFile`. The new `m0_wire_up.test.ts` MUST be green — it is not baseline.

## Seams noticed

- **Master spec anchor error for `Consolidation.run`**: The master spec (CC-2, line 81) and the research doc (line 46) both cite `Consolidation.run` at `consolidation.ts:362`. Verified actual: `run` is at `consolidation.ts:533`; line 362 is `consolidate` (the helper phase called from inside `run` at `:555`). This spec uses the verified line 533. Flagging for master spec errata.
- **`lockDir: "/tmp/opencode-consolidation"`** at `scheduler.ts:379` is a rebrand straggler. M-0 leaves it (CC-2: wire-up only). Fast-follow: rename to `~/.local/share/foxybear/consolidation-lock` or `/tmp/foxybear-consolidation`.
- **`runtimeConfig` to `Scheduler.start`** at `serve.ts:128-130` currently passes only `{ mesh }`. The `registerMaintenanceTasks` signature at `scheduler.ts:359-362` already accepts `memory?: { workforce?: { url?: string } }` but it is never wired through. M-0 does not need workforce. M-2 will need to extend the `runtimeConfig` passed at `serve.ts:128`.
- **`extractTurn` message shape**: `Consolidation.extractTurn` (consolidation.ts:594) accepts `messages: any[]` and uses `getLastUserMessage` (consolidation.ts:102) which expects `{ role, parts: [{ type: "text", content }] }` (returns `part.content`, NOT `part.text`, per `getTextContent` at consolidation.ts:92-100). The session's `msgs: MessageV2.WithParts[]` at `prompt.ts:1481` is NOT the same shape — role lives at `info.role` (message-v2.ts:511) and `TextPart.text` (message-v2.ts:113-128) is the field, not `content`. `capture` MUST adapt the shape (see HOW D). The `any[]` signature is also a style-guide violation (AGENTS.md: "Avoid `any`"). M-0 wires with the required adapter (CC-2: no rewrite of `extractTurn`'s signature); a follow-up cleanup spec should tighten the `extractTurn` input type to `MessageV2.WithParts[]` directly.
- **`SchedulerConfig` shape vs SC-6**: The existing `SchedulerConfig` (scheduler.ts:45-52) uses flat cron strings (`pruning_schedule`, `workforce_sync`, `transcript_cleanup`). SC-6 in the master spec specifies a nested `tasks: { decay, consolidation, graduation, pruning, gc }` shape. M-0 only needs `enabled: true` to wake the existing `memory-consolidation` + `memory-ttl-pruning` tasks. The full SC-6 shape is M-1+ when new tasks (decay, gc, graduation) are added.
- **`sessionMemoryStore` in `compaction.ts:69` is unrelated**: Grep for "memory" in `src/session/` matched `extractSessionMemoryFromMessages` at `compaction.ts:671`. This is an in-memory `Map<string, SessionMemory>` for compaction state, NOT the `@foxybear/Memory` service. Confirmed: zero references to `AutoRecall`, `Harness.run`, `formatForInjection`, `extractTurn`, or `Memory.recall` anywhere in `src/session/`. The gap is real.
- **`migrateFromSqlite` does NOT support a `dryRun` option** (verified at surreal-backend.ts:378-459 — the function signature is `async migrateFromSqlite(): Promise<MigrationReport>` and unconditionally writes). WHAT #16 adds the option. This is a small additive change to support the council guardrail, not a rewrite of the migration logic. CC-2 (wire-up only) permits this because the dry-run is required by the 2026-09-22 council guardrails.
- **No `memory.enabled` config flag exists** in the codebase (grep `memory\.enabled|memory_enabled|MemoryConfig` returns no matches in `packages/fbh/src/`). WHAT #15 adds the flag. The `Instance.config.memory` shape (which already holds `embedding` and `graph_backend`) needs a new `enabled: boolean` field plus a `migrate: { dry_run: boolean }` and `telemetry: { window_hours, p95_threshold_pct, p95_warn_pct, test_window_seconds }` sub-shape. Small additive config change.
- **No telemetry writer exists** for turn-latency / extraction errors / query volume. WHAT #19 adds a small `emitTelemetry` helper (~50 lines in `src/memory/m0-telemetry.ts`). The writer is fire-and-forget via `run.fork` (does not block the turn). P95 computation is a sliding window over a per-bucket array of latencies.
- **No backup-before-migrate logic exists**. WHAT #17 adds the backup + verification step before `migrateFromSqlite` (~30 lines in `src/memory/migrate-backup.ts`). The backup is a recursive `fs.cp` of the SQLite DB (+ `-wal`/`-shm` sidecars) + SurrealDB data dir; verification is a `SELECT COUNT(*)` + `readdir` of the expected subdirs.
- **Existing per-row skip logging** at surreal-backend.ts:428-430 (`log.warn("migration: skipped memory row", { id: m.id, error: String(err) })`) and :453-455 logs and continues. WHAT #18 makes `M < N` fatal: if any row is skipped, ABORT A1 fires. The existing log is preserved (used to identify which rows were skipped for the rollback report). The criterion is `M < N` (any skip), not "skip without a logged reason" — every skip is treated as data loss for the abort decision.
- **ABORT A1 rollback touches `fbh.json`** — the rollback procedure modifies the user's config file to flip `memory.enabled` to `false`. This is a config-file write outside the usual edit-via-CLI flow. Acceptable because ABORT A1 is a halt-and-rollback path, not a normal operation. Documented in the rollback log at `~/.local/share/foxybear/m0-rollback-<ISO8601>.json`.

## Anchors verified against real source

All anchors in this spec were verified by reading the actual source files on 2026-09-21 (re-verified 2026-09-22 for the guardrail additions):

- `src/scheduler/scheduler.ts:55` — `enabled: false` in `DEFAULT_CONFIG` ✓
- `src/scheduler/scheduler.ts:365` — `memory-consolidation` task ✓
- `src/scheduler/scheduler.ts:377-381` — `Consolidation.run({ persona: "default", lockDir: "/tmp/opencode-consolidation", recentSessionIds: [] })` ✓
- `src/scheduler/scheduler.ts:385` — `memory-ttl-pruning` task calling `Memory.getPrunable` ✓
- `src/memory/recall.ts:185` — `export async function autoRecall(input: AutoRecallInput): Promise<MemoryResult[]>` ✓
- `src/memory/recall.ts:279` — `export function formatForInjection(results: MemoryResult[], opts?: { degraded?: boolean }): string` ✓
- `src/memory/consolidation.ts:533` — `export async function run(input: { persona, lockDir, recentSessionIds: string[] })` ✓ (master spec says :362 — that is `consolidate`, not `run`; see Seams)
- `src/memory/consolidation.ts:594` — `export async function extractTurn(input: {...}): Promise<void>` ✓
- `src/memory/consolidation.ts:623` — `consolidation: extraction timed out` warn log inside the timeout branch ✓
- `src/memory/consolidation.ts:638` — `consolidation: extraction failed` warn log inside the catch branch ✓
- `src/memory/surreal-backend.ts:378` — `async migrateFromSqlite(): Promise<MigrationReport>` (verified: no `dryRun` option in the signature; WHAT #16 adds it) ✓
- `src/memory/surreal-backend.ts:384` — marker file idempotency check ✓
- `src/memory/surreal-backend.ts:405-459` — write loop (memory/entity/edge rows); unchanged by WHAT #16's dry-run early-return ✓
- `src/memory/surreal-backend.ts:428-430` — per-row try/catch with `log.warn("migration: skipped memory row", ...)` (continues; WHAT #18 makes `M < N` fatal) ✓
- `src/session/prompt.ts:1279` — `prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>` ✓
- `src/session/prompt.ts:1477-1490` — `system` array assembled from `[personaPrompt, ...env, skills, ...instructions]` ✓
- `src/session/prompt.ts:1493` — `handle.process({...})` dispatch site ✓
- `src/session/prompt.ts:1514` — `finished` branch (assistant message finalize; WHAT #19 turn-latency endpoint) ✓
- `src/session/prompt.ts:117` — `run.fork` available for fire-and-forget ✓
- `src/session/index.ts:770` — `Session.listGlobal({ limit, ... })` ordered by `desc(SessionTable.time_updated)` ✓
- `src/harness/harness.ts:54` — `export async function run(...)` in `namespace Harness` ✓ — zero call sites outside harness.ts confirmed (`grep "Harness\.run"` returns no matches in `src/`)
- `src/cli/cmd/serve.ts:41` — SurrealDB start hint already points at `~/.local/share/foxybear/memory-server` ✓
- `src/cli/cmd/serve.ts:56-73` — `graph` subsystem ✓
- `src/cli/cmd/serve.ts:74-98` — `memory-backend` subsystem ✓
- `src/cli/cmd/serve.ts:127-131` — `Scheduler.start` gated by `config?.scheduler?.enabled` ✓
- `~/.config/foxybear/fbh.json` — no `scheduler` block present (only `memory.embedding` + `memory.graph_backend` at lines 37-44); no `memory.enabled` key present ✓
- `~/.local/share/foxybear/memory-server/` — exists with `manifest/`, `sstables/`, `vlog/`, `wal/` ✓
- `~/.local/share/foxybear/memory-migration-surreal.json` — does NOT exist (migration never ran) ✓
- `~/.local/share/foxybear/backups/` — does NOT exist (WHAT #17 creates it) ✓
- `~/.local/share/foxybear/telemetry/` — does NOT exist (WHAT #19 creates it) ✓
- `~/.local/share/opencode/memory-server/` — exists (the running process serves this path; M-0 kills it) ✓
- Grep `memory\.enabled|memory_enabled|MemoryConfig` in `packages/fbh/src/` — no matches (WHAT #15 adds the flag) ✓

## Anchors not verified (new additions per 2026-09-22 council)

The following anchors reference code that does NOT yet exist in source — this spec adds them:

- WHAT #15: `isMemoryEnabled()` helper and `Instance.config.memory.enabled` field — does NOT exist; this spec adds it.
- WHAT #16: `migrateFromSqlite({ dryRun })` option and dry-run early-return branch — does NOT exist in `surreal-backend.ts:378`; this spec adds it (small additive change before the existing write loop at :405).
- WHAT #17: `backupBeforeMigrate()` helper in `src/memory/migrate-backup.ts` — does NOT exist; this spec adds it (~30 lines).
- WHAT #18: dry-run-vs-actual row count comparison logic in `serve.ts:77-88` — does NOT exist; this spec adds it (inline in the `memory-backend` subsystem init).
- WHAT #19: `emitTelemetry(event)` helper in `src/memory/m0-telemetry.ts` — does NOT exist; this spec adds it (~50 lines).
- WHAT #20: sustained P95 regression computation — does NOT exist; this spec adds it (small computation in `m0-telemetry.ts` after 48 buckets elapse).
- WHAT #21: `checkAbortA1(trigger)` helper in `src/memory/m0-abort.ts` — does NOT exist; this spec adds it (~40 lines). The rollback procedure (restore + flag flip + restart + verify) is new.
