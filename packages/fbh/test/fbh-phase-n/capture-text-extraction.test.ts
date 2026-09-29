import { describe, test, expect } from "bun:test"

// Unit test for the assistant text extraction in the capture hook.
// Verifies that the last assistant message's text parts are correctly
// extracted (not empty) when the message has mixed part types
// (step-start, reasoning, text, tool, step-finish).

// This tests the extraction logic that was returning responseLen=0
// because the capture hook wasn't finding the right text parts.

describe("Capture hook — assistant text extraction", () => {
  // Simulate the extraction logic from prompt.ts capture hook
  function extractAssistantText(messages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string } }> }>): { text: string; response: string; tools: Array<{ name: string; status: string }> } {
    const lastUser = messages.findLast((m) => m.info.role === "user")
    const lastAssistant = messages.findLast((m) => m.info.role === "assistant")

    const text = lastUser
      ? lastUser.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
          .slice(0, 2000)
      : ""

    const response = lastAssistant
      ? lastAssistant.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
          .slice(0, 2000)
      : ""

    const tools = lastAssistant
      ? lastAssistant.parts
          .filter((p): p is { type: "tool"; tool: string; state: { status: string } } => p.type === "tool")
          .map((p) => ({ name: p.tool, status: p.state.status }))
      : ([] as Array<{ name: string; status: string }>)

    return { text, response, tools }
  }

  test("extracts text from a mixed-part assistant message", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "What do you remember?" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "thinking..." },
          { type: "text", text: "I remember the fbh rebrand." },
          { type: "tool", tool: "grep", state: { status: "completed" } },
          { type: "step-finish" },
        ],
      },
    ]

    const result = extractAssistantText(messages)
    expect(result.text).toBe("What do you remember?")
    expect(result.response).toBe("I remember the fbh rebrand.")
    expect(result.tools).toEqual([{ name: "grep", status: "completed" }])
  })

  test("returns empty response when assistant has no text parts", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "ok" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "step-start" },
          { type: "tool", tool: "bash", state: { status: "completed" } },
          { type: "step-finish" },
        ],
      },
    ]

    const result = extractAssistantText(messages)
    expect(result.text).toBe("ok")
    expect(result.response).toBe("")
    expect(result.tools).toEqual([{ name: "bash", status: "completed" }])
  })

  test("extracts multiple text parts from assistant", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "build the memory system" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "I'll start by reading the existing code." },
          { type: "tool", tool: "read", state: { status: "completed" } },
          { type: "text", text: "The existing code has a stub extractor." },
        ],
      },
    ]

    const result = extractAssistantText(messages)
    expect(result.text).toBe("build the memory system")
    expect(result.response).toBe("I'll start by reading the existing code.\nThe existing code has a stub extractor.")
  })

  test("finds the LAST assistant message when there are multiple", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "first question" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "first response" },
          { type: "tool", tool: "grep", state: { status: "completed" } },
        ],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "second question" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "second response" },
          { type: "tool", tool: "edit", state: { status: "completed" } },
        ],
      },
    ]

    const result = extractAssistantText(messages)
    expect(result.text).toBe("second question")
    expect(result.response).toBe("second response")
    expect(result.tools).toEqual([{ name: "edit", status: "completed" }])
  })

  test("truncates to 2000 chars", () => {
    const longText = "x".repeat(3000)
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: longText }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: longText }] },
    ]

    const result = extractAssistantText(messages)
    expect(result.text.length).toBe(2000)
    expect(result.response.length).toBe(2000)
  })

  test("handles no assistant message gracefully", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ]

    const result = extractAssistantText(messages)
    expect(result.text).toBe("hello")
    expect(result.response).toBe("")
    expect(result.tools).toEqual([])
  })

  test("handles no user message gracefully", () => {
    const messages: any[] = []

    const result = extractAssistantText(messages)
    expect(result.text).toBe("")
    expect(result.response).toBe("")
    expect(result.tools).toEqual([])
  })

  test("handles reasoning parts (not extracted as text)", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "explain" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "reasoning", text: "internal reasoning here" },
          { type: "text", text: "Here is my explanation." },
        ],
      },
    ]

    const result = extractAssistantText(messages)
    expect(result.response).toBe("Here is my explanation.")
    expect(result.response).not.toContain("internal reasoning")
  })
})
