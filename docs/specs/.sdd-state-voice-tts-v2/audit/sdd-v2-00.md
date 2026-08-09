# Independent Adversarial Audit: Voice/TTS v2 Master Spec (Revised)

**Audited spec:** `docs/specs/260806_voice-tts_sdd-v2-00-master.md`

**Date:** 2026-08-07

**Scope:** Verify that the ten blocking issues identified in the previous audit are resolved in the current revision of the master spec.

---

## Executive Summary

The revised master spec resolves all ten previously reported blocking issues. The security invariant now explicitly carves out `Voice.Service`-owned `autoStart` and barge-in paths, the text-stream input surface is named, the engine contract is per-session, the command source enum includes `"system"`, optional hook references are removed, SDD-03 v2 is explicitly deferred to implementation and scoped out of the gate, layer wiring is documented in the dependent SDD-01 spec, barge-in ordering is consistent, and rejected-transition semantics are defined.

**VERDICT: PASS**

---

## Previous Blocking Issues — Resolution Status

| ID | Issue | Status | Evidence in current master spec |
|---|---|---|---|
| B1 | VI-1 contradicted by `autoStart` and barge-in | **Resolved** | `VI-1` now states voice-state transitions are reachable "ONLY through native command dispatch in `SessionPrompt.command`, except for two `Voice.Service`-owned paths: `autoStart` on first assistant text delta and barge-in reconciliation." (`260806_voice-tts_sdd-v2-00-master.md:100-103`) |
| B2 | `VoiceService` interface missing text-stream input | **Resolved** | `SC-3` states the LLM stream tap forwards text deltas to `Voice.Service` via `Voice.Service.feedText(sessionID, delta)` or an equivalent internal API; the concrete interface in SDD-01 v2 defines `feedText` (`260806_voice-tts_sdd-v2-00-master.md:178`; `260806_voice-tts_sdd-v2-01-system-commands.md:69`) |
| B3 | `VoiceEngine.stop` global instead of per-session | **Resolved** | Target shape and `CC-6` show `engine.stop(sessionID, "immediate")`; SDD-01 v2 contract defines `stop: (sessionID: string, urgency: "immediate" \| "flush") => Effect.Effect<void>` (`260806_voice-tts_sdd-v2-00-master.md:54`; `260806_voice-tts_sdd-v2-01-system-commands.md:207`) |
| B4 | Bus fan-out anchor wrong | **Resolved** | `CC-9` requires reuse of a direct `Bus.Service` subscription; SDD-01 v2 reuse map states `Voice.Service` adds its own `bus.subscribe(...)` consumer rather than reusing the plugin fan-out (`260806_voice-tts_sdd-v2-00-master.md:179`; `260806_voice-tts_sdd-v2-01-system-commands.md:319`) |
| B5 | Command source enum lacking "system" | **Resolved** | Glossary defines system commands as registered with `source: "system"`; SDD-01 v2 extends the `source` enum to `z.enum(["command", "mcp", "skill", "system"])` (`260806_voice-tts_sdd-v2-00-master.md:204`; `260806_voice-tts_sdd-v2-01-system-commands.md:159`) |
| B6 | Optional `onBargeIn()` hook referenced but undefined | **Resolved** | No `onBargeIn` or optional-hook language remains in the master spec or SDD-01 v2; SDD-01 v2 explicitly states "There are no optional hooks in the base `VoiceEngine` contract" and the amendments verify only that no unadvertised optional methods are probed (`260806_voice-tts_sdd-v2-01-system-commands.md:249`; `260806_voice-tts_sdd-v2-02-05-amendments.md:205`) |
| B7 | Missing SDD-03 v2 / provider appendix | **Resolved by scope** | Dependency order now lists "SDD-03 v2: ElevenLabs TTS Streaming" as a post-gate implementation spec: "Created during implementation phase; not required for gate." The master no longer claims the file exists for gate purposes (`260806_voice-tts_sdd-v2-00-master.md:193-198`) |
| B8 | `SessionPrompt.defaultLayer` not providing `Voice.Service` | **Resolved** | Architecture states `Voice.Service` is constructed by the instance layer and available to `SessionPrompt.command`; SDD-01 v2 includes an explicit "Layer wiring" section stating `Voice.Service` is provided via `SessionPrompt.defaultLayer` (`260806_voice-tts_sdd-v2-00-master.md:33-41`; `260806_voice-tts_sdd-v2-01-system-commands.md:305-309`) |
| B9 | Barge-in error case contradicting ordering | **Resolved** | `CC-6` mandates `engine.stop(sessionID, "immediate")` before `sdk.session.abort({ sessionID })`; SDD-01 v2 barge-in protocol and error cases preserve that ordering (`260806_voice-tts_sdd-v2-00-master.md:92`; `260806_voice-tts_sdd-v2-01-system-commands.md:261-275`) |
| B10 | `VoiceStatePart.transition.to` semantics for rejected transitions undefined | **Resolved** | SDD-01 v2 `VoiceStatePart` resume/replay rules state: "When `outcome === "rejected"`, `to` SHALL equal `from`." (`260806_voice-tts_sdd-v2-01-system-commands.md:108-111`) |

---

## Cross-Spec Notes

- **SDD-03 v2 deferral:** The master spec explicitly scopes SDD-03 v2, SDD-04 v2, and SDD-05 v2 out of the human gate. The provider-substitution appendix therefore is not a gate-blocking deliverable under the current master schedule. Implementation must still produce it during the implementation phase, but the previous "missing spec" blocking issue is removed by documented scope.
- **Layer wiring detail:** The master spec remains high-level about `SessionPrompt.defaultLayer`; the exact wiring claim lives in SDD-01 v2. This is appropriate for a master/dependency spec and does not create a blocking gap.

---

## Audit Criteria Assessment

| Criterion | Assessment |
|---|---|
| 1. WHEN/SHALL observable and testable | **Pass.** All behavioral claims trace to named service methods or state transitions. |
| 2. Cross-spec contradictions | **Pass.** The previous contradictions (VI-1 vs. `autoStart`/barge-in, barge-in ordering) are resolved. |
| 3. Security invariant VI-1 correctly scoped | **Pass.** VI-1 now explicitly exempts `Voice.Service`-owned `autoStart` and barge-in paths. |
| 4. State model internally consistent | **Pass.** Per-session `VoiceEngine` contract and rejected-transition semantics are consistent. |
| 5. Dependency order and gate scope clear | **Pass.** SDD-03/04/05 are explicitly marked post-gate. |

---

## VERDICT: PASS

The revised `260806_voice-tts_sdd-v2-00-master.md` resolves all ten previously reported blocking issues. The spec is internally consistent and ready to proceed to the human gate and implementation.

VERDICT: PASS
