# Re-Audit Report: SDD-01 v3 — Voice Plugin

**Date:** 2026-08-08
**Auditor:** Independent adversarial auditor (re-audit)
**Spec:** `docs/specs/260808_voice-tts_sdd-v3-01-plugin.md`
**Master:** `docs/specs/260808_voice-tts_sdd-v3-00-master.md`
**Prior audit:** Failed with 4 blocking issues (BLOCK-1 through BLOCK-4)
**Scope:** Verify all 4 fixes, check for new issues introduced

---

## Source Verification Performed

| Claim | File | Line(s) | Verified |
|-------|------|---------|----------|
| PromptInput has `noReply` | `packages/opencode/src/session/prompt.ts` | 1733 | `noReply: z.boolean().optional()` present |
| CommandInput does NOT have `noReply` | `packages/opencode/src/session/prompt.ts` | 1828–1849 | Fields: messageID, sessionID, agent, model, arguments, command, variant, parts — no `noReply` |
| `command()` defined | `packages/opencode/src/session/prompt.ts` | 1557 | `const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {` |
| `plugin.trigger` call not captured | `packages/opencode/src/session/prompt.ts` | 1650–1654 | `yield* plugin.trigger("command.execute.before", ...)` — return value discarded |
| `prompt()` short-circuit | `packages/opencode/src/session/prompt.ts` | 1293 | `if (input.noReply === true) return message` |
| `trigger` returns output | `packages/opencode/src/plugin/index.ts` | 275 | `return output` — mutated output object returned |
| `command.execute.before` hook output type | `packages/plugin/src/index.ts` | 261–264 | `output: { parts: Part[] }` — no `noReply` field currently |
| `experimental.text.complete` hook | `packages/plugin/src/index.ts` | 325–328 | Confirmed |
| `experimental.chat.system.transform` hook | `packages/plugin/src/index.ts` | 290–295 | Confirmed |
| `INTERNAL_PLUGINS` array | `packages/opencode/src/plugin/index.ts` | 58 | Confirmed — internal plugins loaded synchronously in `InstanceState.make` closure (lines 154–163) |
| Event hook fan-out | `packages/opencode/src/plugin/index.ts` | 248–254 | `bus.subscribeAll().pipe(Stream.runForEach(...))` — fiber interrupted on scope close (comment line 247) |
| `tagEmissionTempDelta` default | `packages/opencode/src/config/foxybear.ts` | 142 | `z.number().default(0)` |
| `maxSentenceRetries` default | `packages/opencode/src/config/foxybear.ts` | 143 | `z.number().int().min(0).default(3)` |
| Reasoning emit uses `field: "text"` | `packages/opencode/src/session/processor.ts` | 241–247 | `field: "text"` in `reasoning-delta` case |
| Text emit uses `field: "text"` | `packages/opencode/src/session/processor.ts` | 423–429 | `field: "text"` in `text-delta` case |

---

## BLOCK-1: Wrong CommandInput anchor — VERIFIED FIXED

**Original issue:** The noReply section incorrectly attributed `noReply` to `CommandInput` instead of `PromptInput`, and didn't specify that `command()` must capture the `plugin.trigger` return value.

**Fix in spec (lines 25–30):**

- Line 25: Correctly states `PromptInput` (~line 1733) already has `noReply: z.boolean().optional()`. No change needed.
- Line 26: Correctly states `CommandInput` (~line 1828) does NOT have `noReply`. No change needed — value comes from hook output.
- Line 27: Correctly states `command.execute.before` hook output (`packages/plugin/src/index.ts:261-264`) needs `noReply?: boolean` added to output type.
- Line 28: Correctly states `command()` (~line 1650) currently calls `yield* plugin.trigger(...)` without capturing the return value. Prescribes `const output = yield* plugin.trigger(...)` and passing `noReply: output.noReply === true` to `prompt()`. Correctly references the existing short-circuit at line 1293.

**Source verification:** All claims match the source code. `trigger` returns the mutated output object (`plugin/index.ts:275`), so capturing it and reading `output.noReply` is type-safe once the hook output type is updated.

**Minor nit (non-blocking):** Line 28 labels the anchor as "`command()` function (~line 1650)" but line 1650 is the `plugin.trigger` call within `command()`, not the function definition (line 1557). The text describes the trigger call, so the anchor is correct for the described code — the label is just slightly misleading.

**Verdict:** FIXED.

---

## BLOCK-2: Req 5 vs req 7 contradiction — VERIFIED FIXED

**Original issue:** Req 5 implied `/voice` markdown command results in the LLM calling `voice.toggle`, contradicting req 7 which says the `command.execute.before` hook handles `/voice` with `noReply: true`.

**Fix in spec (line 44, req 5):**

Req 5 now clearly separates the two toggle surfaces:

> "The `voice.toggle` and `voice.mute` tools are callable by the LLM in natural conversation (e.g., 'turn on voice'). **WHEN** the user types `/voice` or `/mute`, the `command.execute.before` hook (requirement 7) handles it directly with `noReply: true` — the LLM is NOT invoked. The tools and the `noReply` hook are two independent toggle surfaces: the `noReply` hook is the user-facing command path (no LLM round-trip), the tools are the LLM-facing programmatic surface."

Req 7 (line 48) is consistent: the `command.execute.before` hook sets `output.noReply = true` and mutates `output.parts` for the confirmation. No contradiction remains.

**Verdict:** FIXED.

---

## BLOCK-3: SC-1 defaults mismatch — VERIFIED FIXED

**Original issue:** SC-1 defaults for `tagEmissionTempDelta` and `maxSentenceRetries` were referenced with wrong values.

**Fix in master spec (lines 139–140):**

```
tagEmissionTempDelta: number   // default: 0 (matching foxybear.ts)
maxSentenceRetries: number  // default: 3 (matching foxybear.ts)
```

**Source verification:**
- `foxybear.ts:142`: `tagEmissionTempDelta: z.number().default(0)` — matches spec default 0.
- `foxybear.ts:143`: `maxSentenceRetries: z.number().int().min(0).default(3)` — matches spec default 3.

SDD-01 does not restate these defaults with incorrect values. V2 (line 157) says "parsed `VoiceConfig` has all SC-1 defaults" without restating specific values for these two fields, avoiding the prior error.

**Verdict:** FIXED.

---

## BLOCK-4: Unreliable event delivery — VERIFIED FIXED

**Original issue:** V12 did not acknowledge that `server.instance.disposed` delivery is unreliable because the event stream fiber may be interrupted before the handler completes.

**Fix in spec (line 177, V12):**

> "Note: in production, `server.instance.disposed` races with the Plugin scope close (the event stream fiber may be interrupted before the handler completes). The plugin does best-effort cleanup. The VERIFY tests the handler by direct injection; production delivery is best-effort."

**Source verification:** `plugin/index.ts:247` comment: "Subscribe to bus events, fiber interrupted when scope closes." The subscription uses `bus.subscribeAll().pipe(Stream.runForEach(...))` — when the instance scope closes, this fiber is interrupted, confirming the race condition the spec now acknowledges.

**Verdict:** FIXED.

---

## New Issues Check

No new blocking issues were introduced by the 4 fixes. All corrected text is accurate per source code. All source anchors in the corrected sections are correct.

The following pre-existing observations are noted for the author's awareness — none are blocking, none were introduced by the fixes:

### OBS-1: Master spec inconsistency on CommandInput (non-blocking)

The master spec (line 32) says "Add `noReply` to `CommandInput`" and (line 65) says "`noReply` in `CommandInput`". SDD-01 (line 26) correctly says "No change needed to `CommandInput` — the value comes from the hook output, not the command input." SDD-01 is correct per source code: `CommandInput` (prompt.ts:1828–1849) has no `noReply` field, and the value comes from the `command.execute.before` hook output, captured by `command()` and passed to `prompt()`. The master spec is stale on this point. The master's glossary (line 204) actually agrees with SDD-01: "A command whose `command.execute.before` hook sets `noReply: true`, causing `command()` to pass `noReply: true` to `prompt()`." The master should be updated to remove the "Add `noReply` to `CommandInput`" language. This is a master-spec issue, not an SDD-01 defect.

### OBS-2: Config-markdown command dependency undocumented (non-blocking, pre-existing from v1)

The `command()` function (prompt.ts:1559) calls `commands.get(input.command)` and throws "Command not found" if the command is not in the `Command.Service` registry. Commands are loaded from: (a) built-in defaults (init, review), (b) `Config.command` (config-markdown files like `~/.config/opencode/commands/voice.md`), (c) MCP prompts, (d) skills. The spec says "does NOT register voice/mute in `Command.Service`" (line 30) and "No native system command registration in `Command.Service`" (line 145) — meaning no code-level registration in `command/index.ts`. This is correct: v3 reverts v2's native code registration. However, v1 used config-markdown command files (`~/.config/opencode/commands/voice.md`, per `docs/research/260806_voice-diagnosis-command-path.md:21`), and v3 says "return to v1." The spec doesn't document this dependency — an implementer who doesn't know v1's setup might not realize config-markdown command files are required for `/voice` to reach the `command.execute.before` hook. Inherited from v1, not introduced by the fixes.

### OBS-3: `output.parts` mutation method unspecified (non-blocking, pre-existing from v1)

The spec says the hook should "mutate `output.parts` to contain a one-line confirmation" (line 48, line 101). The `command()` function passes `{ parts }` (shorthand for `{ parts: parts }`) as the hook output. Since `output.parts` is the same array reference as `parts`, in-place mutations (`.length = 0` + `.push()`) are reflected in the `parts` variable, which is then passed to `prompt()`. However, reassignment (`output.parts = [...]`) would NOT affect `parts`. v1 used in-place mutation (per `docs/research/260806_voice-diagnosis-command-path.md:68-69`). The spec says "mutate" (implying in-place) but doesn't specify the technique. An implementer who reassigns `output.parts` would find the confirmation text doesn't reach `prompt()`. The spec should be explicit: "mutate `output.parts` in-place (`.length = 0` then `.push()`)" or alternatively, the proposed `command()` change should pass `output.parts` to `prompt()` instead of `parts`. Inherited from v1, not introduced by the fixes.

---

## Summary

| Issue | Status | Notes |
|-------|--------|-------|
| BLOCK-1: Wrong CommandInput anchor | FIXED | PromptInput/CommandInput correctly distinguished; trigger capture prescribed |
| BLOCK-2: Req 5 vs req 7 contradiction | FIXED | Two toggle surfaces clearly separated; no contradiction |
| BLOCK-3: SC-1 defaults mismatch | FIXED | `tagEmissionTempDelta: 0`, `maxSentenceRetries: 3` — both match source |
| BLOCK-4: Unreliable event delivery | FIXED | V12 acknowledges best-effort; matches source fiber-interrupt behavior |
| New issues introduced | None | All corrected text verified against source |

VERDICT: PASS
