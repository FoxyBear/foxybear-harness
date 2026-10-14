import { describe, expect, test, mock } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// Regression tests for the memory capture store stage.
//
// classify() stores through getGlobalHypergraphBackend(). When absent,
// the pipeline returns errors:1 and skips the store stage gracefully.
//
// Jev/Gemini are module-mocked so the pipeline reaches the store stage
// deterministically — the unit under test is the store-stage drop, not
// the providers.

mock.module("../../src/provider/jev", () => ({
  Jev: {
    noul: async () => 0.93,
  },
}))

mock.module("../../src/provider/gemini", () => ({
  Gemini: {
    abstract: async () => ({
      memories: [{ content: "Test decision: prefer tabs over spaces in this project.", type: "decision" }],
    }),
  },
}))

const SRC = join(import.meta.dir, "..", "..", "src")

describe("classify store stage", () => {
  test("returns errors:1 when no hypergraph backend is registered", async () => {
    const { Instance } = await import("../../src/project/instance")
    const { classify } = await import("../../src/memory/classify/pipeline")
    const { setGlobalHypergraphBackend } = await import("../../src/memory/backend-registry")
    setGlobalHypergraphBackend(null)

    const r = await Instance.provide({
      directory: import.meta.dir,
      fn: () =>
        classify({
          sessionID: "ses_test_no_backend",
          text: "We decided to prefer tabs over spaces in this project.",
          response: "Understood — tabs it is for this project.",
          tools: [],
          project_id: "test-project",
          persona: "default",
        }),
    })

    expect(r).toEqual({ stored: 0, skipped: 0, errors: 1 })
  })

  test("backend_unhealthy and store_failed use gated tlog (not log.warn) to avoid TUI noise", () => {
    const src = readFileSync(join(SRC, "memory", "classify", "pipeline.ts"), "utf-8")
    expect(src).toMatch(/tlog\("\[MEM-TRACE\] classify\.backend_unhealthy/)
    expect(src).toMatch(/tlog\("\[MEM-TRACE\] classify\.store_failed/)
    expect(src).not.toMatch(/log\.warn\("classify\.backend_unhealthy/)
    expect(src).not.toMatch(/log\.warn\("classify\.store_failed/)
  })
})

describe("harness init", () => {
  test("harness init calls initMemoryBackendFromConfig", () => {
    const src = readFileSync(join(SRC, "harness", "worker-init.ts"), "utf-8")
    expect(src).toMatch(/initMemoryBackendFromConfig/)
  })
})
