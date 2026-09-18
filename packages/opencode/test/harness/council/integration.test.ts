import { describe, expect, test } from "bun:test"
import { runCouncil, type CouncilConfig, type SubAgentRunner } from "@/harness/council/deliberation"
import { callModel, getApiKey } from "@/harness/council/transport"
import { loadSettings, resolveModel } from "@/harness/council/config"
import type { ModelInfo } from "@/harness/council/prompts"

// Spec VERIFY tests 23–24. Real API calls — run with:
//   bun test test/harness/council/integration.test.ts --timeout 120000
// Skipped entirely (via describe.skipIf) when no API keys are available, so
// these never fire in fast CI runs.

const hasOpenAI = !!process.env.OPENAI_API_KEY
const hasAnthropic = !!process.env.ANTHROPIC_API_KEY

// A runner that issues real model calls via callModel (no session abort signal).
function liveRunner(): SubAgentRunner {
  return {
    async run(model: ModelInfo, systemPrompt: string, userPrompt: string) {
      const key = getApiKey(model.provider)
      return callModel(model, key, systemPrompt, userPrompt)
    },
  }
}

describe.skipIf(!hasOpenAI || !hasAnthropic)("council integration (live)", () => {
  test("live council with 2 models completes", async () => {
    void loadSettings()
    const models = ["gpt-5.4", "claude-opus-4-8"].map(resolveModel)
    const arbitrator = resolveModel("gpt-5.4")
    const config: CouncilConfig = {
      models,
      arbitrator,
      maxRounds: 1,
      threshold: 4,
      enableResearch: false,
    }

    const start = Date.now()
    const result = await runCouncil("What is 2+2?", config, liveRunner())
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(120_000)
    expect(result.finalSynthesis.length).toBeGreaterThan(0)
  })

  test("live council survives a bad model", async () => {
    const good = ["gpt-5.4", "claude-opus-4-8"].map(resolveModel)
    const bogus = resolveModel("openai/nonexistent-model-x")
    const models = [good[0]!, good[1]!, bogus]
    const arbitrator = resolveModel("gpt-5.4")
    const config: CouncilConfig = {
      models,
      arbitrator,
      maxRounds: 1,
      threshold: 4,
      enableResearch: false,
    }

    const result = await runCouncil("What is 2+2?", config, liveRunner())
    const failures = (result as unknown as { failures?: { model: string }[] }).failures ?? []

    expect(result.finalSynthesis.length).toBeGreaterThan(0)
    expect(result.rounds[0].proposals.length).toBe(2)
    expect(failures.some((f) => f.model === "nonexistent-model-x")).toBe(true)
  })
})
