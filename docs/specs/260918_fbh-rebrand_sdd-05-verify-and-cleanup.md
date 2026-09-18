# SDD-05: Verify & Cleanup (Stage 4 + Stage 5)

**Date:** 2026-09-18
**Project:** FoxyBear Harness
**Status:** Draft (pending audit + council + human gate)
**Master:** `260918_fbh-rebrand_sdd-00-master.md`
**Depends on:** SDD-01 (repo renamed), SDD-02 (packages rebranded), SDD-03 (core rebranded), SDD-04 (migration available).
**Owns:** SC-6 (verification commands), the FoxyBearOffice doc path cleanup.

Implements Phase A Stage 4 (verification: build, typecheck, tests, binary launch, config load, TUI, LLM session, provider auth, memory, plugins, server, scheduler) and Stage 5 (post-fork cleanup: FoxyBearOffice doc paths, `.foxybear/` config dirs). This is the spec that proves the rebrand worked end-to-end against the real binary.

## Background

The plan's Stage 4 lists 12 verification steps (4a–4l). The plan's Stage 5 lists 3 cleanup steps. Research confirmed the verification commands (`bun run typecheck` = `tsgo --noEmit`, `bun test --timeout 30000`, `bun run script/build.ts`, root `bun turbo typecheck`). This spec turns the 12 steps into acceptance criteria with real-binary smoke tests (CC-6), and adds the FoxyBearOffice doc path updates the plan's Stage 5 requires.

---

## WHAT

### Build & static gates (SC-6, CC-5)

1. **WHEN** SDD-05 runs the build gate, the system **SHALL** execute `cd packages/opencode && bun run build` and **SHALL** verify it exits zero with no errors. The build output **SHALL** produce the `fbh` binary at `packages/opencode/bin/fbh`.

2. **WHEN** SDD-05 runs the typecheck gate, the system **SHALL** execute `cd packages/opencode && bun run typecheck` (`tsgo --noEmit`) AND `bun turbo typecheck` (root, all packages), and **SHALL** verify both exit zero. Known-baseline failures listed in `development/opencode/docs/specs/.sdd-state-fbh/baseline-failures.txt` **SHALL** be tolerated; any failure NOT in the baseline file fails the gate.

3. **WHEN** SDD-05 runs the test gate, the system **SHALL** execute `cd packages/opencode && bun test --timeout 30000` and **SHALL** verify the suite is green (baseline tolerated). The system **SHALL** also run any per-package test suites for kept packages that have tests (`sdk/js`, `plugin`, `ui` — verify via glob during implementation) and verify green.

### Binary & config (plan 4d, 4e)

4. **WHEN** SDD-05 verifies the binary launch, the system **SHALL** run `fbh --help` against the built binary and **SHALL** verify the output prints `fbh` as the program name, with zero `opencode` strings in the help text (excluding backward-compat option names that reference legacy env vars, if any are documented).

5. **WHEN** SDD-05 verifies config loading, the system **SHALL** boot `fbh` with `HOME` set to a tmp dir containing `tmp/.config/foxybear/fbh.json` and **SHALL** verify the config is read from the new path. The system **SHALL** also verify the backward-compat path (tmp dir with `tmp/.config/foxybear/opencode.json` only) logs a deprecation warning and loads.

### TUI & LLM session (plan 4f, 4g, CC-6)

6. **WHEN** SDD-05 verifies the TUI, the system **SHALL** launch `fbh` (TUI mode) in a PTY against a tmp project dir and **SHALL** verify it renders without crashing for a minimum 2-second boot window, then **SHALL** send a `/quit` or exit keystroke and verify clean exit. The TUI launch **SHALL** use the real binary, not a mock.

7. **WHEN** SDD-05 verifies a real LLM session, the system **SHALL** boot `fbh` non-interactively (`fbh run` or the headless session mode) with a real provider key (read from `~/Development/.{openai_api,anthropic,deepinfra}.key` — the council config uses these), send a trivial prompt (`Reply with the single word: OK`), and **SHALL** verify a response is received within 30 seconds. The session **SHALL** be a real round-trip to a real provider (CC-6). The system **SHALL** verify the user agent sent is `fbh/<channel>/<version>` and the `x-fbh-client` header is present (per SDD-03 req 16).

### Provider auth & memory (plan 4h, 4i)

8. **WHEN** SDD-05 verifies provider auth, the system **SHALL** run `fbh auth list` (or equivalent) and **SHALL** verify the configured providers (from the migrated `council.json` or `fbh.json`) resolve and their auth tokens are read from the new `~/.local/share/foxybear/auth.json` path. The system **SHALL** verify a provider authed session succeeds (Step 7 covers this; Step 8 asserts the auth resolution path).

9. **WHEN** SDD-05 verifies the memory DB, the system **SHALL** boot `fbh` and trigger a `memory_remember` + `memory_recall` round-trip and **SHALL** verify the SQLite DB is created at `~/.local/share/foxybear/fbh.db` (or `fbh-<channel>.db`) and the SurrealDB backend connects to `~/.local/share/foxybear/memory-server/` (or the migrated path). The system **SHALL** verify the memory round-trip returns the stored content.

### Plugins & server (plan 4j, 4k)

10. **WHEN** SDD-05 verifies plugin loading, the system **SHALL** boot `fbh` with the voice TTS plugin enabled (per the existing `tui.json` config, migrated) and **SHALL** verify the plugin loads without error (the known prod bug from memory — external plugins load after tool registry caches — is documented; this step verifies the plugin FILE loads and registers, not that the tool is visible to the LLM, which is the known bug). The system **SHALL** log the plugin load status.

11. **WHEN** SDD-05 verifies the server, the system **SHALL** run `fbh serve` and **SHALL** verify the HTTP server binds an ephemeral port, a WebSocket client connects, and the server responds to a health check (`GET /health` or equivalent). The system **SHALL** verify clean shutdown on SIGTERM.

### Scheduler (plan 4l)

12. **WHEN** SDD-05 verifies the scheduler, the system **SHALL** boot `fbh` with the scheduler enabled, register a one-shot test task firing in 2 seconds, and **SHALL** verify the task executes within 5 seconds. (The plan's Phase Y patch-monitor task is a fast-follow; this step verifies the scheduler ticks, not the patch-monitor specifically.)

### Post-build binary string scan (R11 — Bun-bundled strings)

16. **WHEN** the build gate passes (req 1), the system **SHALL** locate the compiled `fbh` binary and **SHALL** execute `strings <binary> | grep -iE 'opencode'`. Any non-zero hit count **SHALL** fail verification. The system **SHALL** remediate by identifying the source of each inlined string (source-tree grep for the matched string), editing the source, and re-building. Source-tree grep alone is insufficient for bundled TS/Bun code — string literals inline into the binary and survive a source rename if the build cached them. This step is mandatory per council R11.

### Consumer-side integration (B7)

17. **WHEN** the verification gates pass, the system **SHALL** perform a consumer-side integration check: (a) create a clean tmp project importing `@foxybear/sdk` (if OQ2 shim exists) or a direct dependency; (b) `npx fbh --version` reports `fbh` not `opencode`; (c) `npx fbh init` in a clean directory creates state dirs using `foxybear` paths per SC-2; (d) if OpenCode was previously installed on the test machine, verify no path collision between `~/.config/opencode` and `~/.config/foxybear` (both can coexist per SDD-04 backward-compat). This step catches ecosystem breakage the internal test suite cannot see.

### Post-fork cleanup (plan Stage 5)

18. **WHEN** SDD-05 runs the doc path cleanup, the system **SHALL** update every reference to `development/opencode/` in `FoxyBearOffice/` docs and configs to `development/foxybear/`, including: `FoxyBearOffice/CLAUDE.md` (the dev projects table), `FoxyBearOffice/AGENTS.md` (if it references the path), and every `docs/*.md` that references the old path. The system **SHALL** verify a static grep for `development/opencode` across `FoxyBearOffice/` (excluding `development/` itself and `.git/`) returns zero matches.

19. **WHEN** SDD-05 runs the `.foxybear/` config dir verification, the system **SHALL** verify `FoxyBearOffice/` and `development/foxybear/` use `.foxybear/` project config dirs (not `.opencode/`), and **SHALL** verify the rebranded binary reads them. If a `.opencode/` dir exists at `development/foxybear/`, the system **SHALL** rename it to `.foxybear/` (with the backward-compat read making this non-breaking).

20. **WHEN** SDD-05 completes, the system **SHALL** produce a verification report at `development/foxybear/docs/specs/.sdd-state-fbh/verify/sdd-05.md` recording every step's pass/fail, the binary path, the tmp HOME used, the provider used for the LLM smoke, the session ID of the real LLM round-trip, and the post-build binary scan results (R11). The report **SHALL** end in `VERDICT: PASS` or `VERDICT: FAIL`.

---

## HOW

- The SDD-05 implementation is a verification script (`scripts/fbh-rebrand/05-verify-and-cleanup.sh`) plus a test harness in `test/fbh-rebrand/sdd-05.test.ts` that drives the real binary.
- **Build/typecheck/test:** direct command execution; baseline file consulted for tolerated failures.
- **Binary launch:** `fbh --help` captured and grepped for `opencode` (allowed: backward-compat env var docs).
- **Config load:** boot in tmp HOME with `FBH_TEST_HOME`; assert config read from `tmp/.config/foxybear/fbh.json`.
- **TUI:** `bunx node-pty` or a PTY harness launches `fbh`, captures 2s of output, sends exit. Real binary (CC-6).
- **LLM session:** `fbh run --print "Reply with the single word: OK"` (or the headless equivalent); capture stdout; assert "OK" appears within 30s; capture the HTTP request (via a proxy or the provider SDK's debug) to assert `x-fbh-client` header and `fbh/` UA.
- **Provider auth:** `fbh auth list` (or inspect the resolved provider config via a debug flag); assert tokens resolve from the new path.
- **Memory:** `fbh run` with a prompt that triggers `memory_remember`/`memory_recall` (or a direct tool test); assert the DB file exists at the new path; assert the round-trip.
- **Plugins:** boot with `tui.json` enabling the voice plugin; capture the plugin load log line.
- **Server:** `fbh serve --port 0` (ephemeral); `curl` the health endpoint; `wscat` or a WS client connects; SIGTERM and assert clean exit.
- **Scheduler:** boot with a 2s one-shot task; assert execution.
- **Doc cleanup:** `grep -rl "development/opencode" FoxyBearOffice/ --exclude-dir=development --exclude-dir=.git` and `sed` replace → `development/foxybear`; verify grep zero.
- **`.foxybear/` dir:** `mv development/foxybear/.opencode development/foxybear/.foxybear` if needed; verify the binary reads it.
- **Report:** write the verify report markdown.
- What is explicitly NOT built: no rebrand (SDD-01..04 done), no new features.

---

## VERIFY

Acceptance tests live at `test/fbh-rebrand/sdd-05.test.ts`. These ARE the verification — the test suite IS the gate. Real binary, real LLM, real filesystem.

- **V1 — build (req 1).** Action: `cd packages/opencode && bun run build`. Expected: exit 0; `bin/fbh` exists and is executable.
- **V2 — typecheck (req 2).** Action: `bun run typecheck` + `bun turbo typecheck`. Expected: both exit 0 (baseline tolerated).
- **V3 — tests (req 3).** Action: `bun test --timeout 30000` + per-package suites. Expected: green (baseline tolerated).
- **V4 — binary launch (req 4).** Action: `fbh --help`. Expected: exit 0; output contains `fbh`; output contains zero `opencode` (excluding documented backward-compat).
- **V5 — config load new (req 5).** Action: boot `fbh` in tmp HOME with `fbh.json`. Expected: config read; no deprecation warning.
- **V6 — config load legacy (req 5).** Action: boot in tmp HOME with only `opencode.json`. Expected: config read; deprecation warning to stderr.
- **V7 — TUI (req 6).** Action: launch `fbh` in a PTY for 2s. Expected: renders without crash; clean exit on quit.
- **V8 — real LLM session (req 7, CC-6).** Action: `fbh run --print "Reply with the single word: OK"` with a real provider. Expected: "OK" in response within 30s; request captured with `x-fbh-client` header and `fbh/<channel>/<version>` UA.
- **V9 — provider auth (req 8).** Action: `fbh auth list` (or debug). Expected: configured providers resolve; tokens from new `auth.json` path.
- **V10 — memory (req 9).** Action: boot + memory round-trip. Expected: `fbh.db` at new path; recall returns stored content; SurrealDB backend connects.
- **V11 — plugins (req 10).** Action: boot with voice plugin. Expected: plugin load log line present; no load error.
- **V12 — server (req 11).** Action: `fbh serve --port 0`; health check; WS connect; SIGTERM. Expected: health 200; WS connects; clean exit.
- **V13 — scheduler (req 12).** Action: boot with 2s one-shot task. Expected: task executes within 5s.
- **V14 — doc cleanup (req 13).** Action: run the path update. Expected: `grep -r "development/opencode" FoxyBearOffice/ --exclude-dir=development --exclude-dir=.git` returns zero.
- **V15 — `.foxybear/` dir (req 14).** Action: verify project config dir. Expected: `development/foxybear/.foxybear/` exists (or `.opencode/` renamed); binary reads it.
- **V16 — verify report (req 20).** Action: read `verify/sdd-05.md`. Expected: every step recorded; ends in `VERDICT: PASS`.
- **V17 — end-to-end smoke (CC-6).** Action: the full V1–V16 sequence. Expected: all pass. This is the live smoke the SDD process requires.
- **V18 — post-build binary string scan (req 16, R11).** Action: `strings packages/opencode/bin/fbh | grep -iE 'opencode'`. Expected: zero hits. If non-zero: remediate the source of each inlined string, re-build, re-scan.
- **V19 — consumer-side integration (req 17, B7).** Action: create a clean tmp project; `npx fbh --version`; `npx fbh init`. Expected: version reports `fbh`; init creates `foxybear` state dirs; no collision with any existing `opencode` paths.
