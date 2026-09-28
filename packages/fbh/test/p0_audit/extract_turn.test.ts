import { describe, test, beforeAll } from "bun:test"
import { record, clearResults } from "./helpers"
import { clearMemoryTables, readMemoryRows } from "./db"
import { Consolidation, invalidateConsolidationConfigCache } from "../../src/memory/consolidation"

const COMP = "extract_turn"

const msg = (text: string, role = "user") => ({ role, parts: [{ type: "text", content: text }] })

async function runAndCapture(
  id: string,
  desc: string,
  input: { sessionID: string; persona: string; messages: unknown[]; timeoutMs?: number; _testOverrides?: { auto_capture?: boolean } },
  settleMs = 300,
): Promise<void> {
  await clearMemoryTables()
  await record(COMP, id, desc, input, async () => {
    await Consolidation.extractTurn(input)
    await new Promise((r) => setTimeout(r, settleMs))
    return readMemoryRows().map((r) => ({ id: r.id, content: r.content, metadata: r.metadata }))
  })
}

describe("P-0 audit: Consolidation.extractTurn", () => {
  beforeAll(() => {
    clearResults(COMP)
    invalidateConsolidationConfigCache()
  })

  test("records observed behavior for all 11 inputs (a-k)", async () => {
    await runAndCapture("a", "preference statement: 'I prefer TypeScript over JavaScript'", {
      sessionID: "s-a", persona: "audit", messages: [msg("I prefer TypeScript over JavaScript.")],
    })
    await runAndCapture("b", "correction: 'No, actually we use Bun not Node'", {
      sessionID: "s-b", persona: "audit", messages: [msg("No, actually we use Bun not Node.")],
    })
    await runAndCapture("c", "decision: 'Let's go with SurrealDB'", {
      sessionID: "s-c", persona: "audit", messages: [msg("Let's go with SurrealDB for the graph backend.")],
    })
    await runAndCapture("d", "constraint: 'Kuzu doesn't work because Bun friction'", {
      sessionID: "s-d", persona: "audit", messages: [msg("Kuzu doesn't work because the Bun friction outweighs the benefits.")],
    })
    await runAndCapture("e", "pattern: 'Every time we build, use bun test'", {
      sessionID: "s-e", persona: "audit", messages: [msg("Every time we build, we should use bun test for the test suite.")],
    })
    await runAndCapture("f", "slash-command first message: '/help' — CN-04 skip", {
      sessionID: "s-f", persona: "audit", messages: [msg("/help")],
    }, 100)
    await runAndCapture("g", "auto_capture: false — CN-06 skip via _testOverrides", {
      sessionID: "s-g", persona: "audit", messages: [msg("I prefer Bun over Node.")], _testOverrides: { auto_capture: false },
    }, 100)
    await runAndCapture("h", "empty messages array", {
      sessionID: "s-h", persona: "audit", messages: [],
    }, 100)
    await runAndCapture("i", "messages array with no user role (only assistant)", {
      sessionID: "s-i", persona: "audit", messages: [{ role: "assistant", parts: [{ type: "text", content: "I prefer Bun." }] }],
    }, 100)
    await runAndCapture("j", "MessageV2 shape: info.role + part.text (not part.content) — verifies SDD-02 §HOW D adapter required", {
      sessionID: "s-j", persona: "audit", messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "I prefer Bun over Node." }] }],
    }, 100)
    await runAndCapture("k", "timeoutMs: 1 on a preference input — CN-05 timeout fires before extraction completes", {
      sessionID: "s-k", persona: "audit", messages: [msg("I prefer TypeScript over JavaScript.")], timeoutMs: 1,
    }, 600)
  }, 120000)
})
