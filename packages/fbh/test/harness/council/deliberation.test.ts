import { describe, expect, test } from "bun:test"
import {
  runCouncil,
  type CouncilConfig,
  type SubAgentRunner,
  type DeliberationResult,
} from "@/harness/council/deliberation"
import type { ModelInfo } from "@/harness/council/prompts"

// Spec VERIFY tests 12–22. runCouncil IS exported; we inject a fake
// SubAgentRunner so no network is touched. DeliberationResult.failures does
// not exist yet — referencing it is intentional RED (undefined → assertions fail).

const PROPOSAL = "Proposal: 2+2=4"
const CRITIQUE = JSON.stringify({
  strengths: ["solid"],
  weaknesses: ["risky"],
  suggestions: ["expand"],
  summary: "ok",
})
const SYNTH = "Final synthesis: 4"
const REVISE = "Revised proposal: 2+2=4"

function ruling(score: number, converged: boolean, action = "conclude"): string {
  return JSON.stringify({
    agreements: [],
    disagreements: [],
    directives: {},
    synthesizedCritiques: {},
    revisionChecks: [],
    convergenceScore: score,
    converged,
    action,
    reasoning: "ruling",
  })
}

const MARKERS: Array<[string, RegExp]> = [
  ["synthesize", /Synthesize the final output/],
  ["arbitrate", /Evaluate the council/],
  ["revise", /Revise your proposal/],
  ["critiques", /Critique .*'s .*proposal/],
  ["research", /Research this topic/],
  ["proposals", /Present your proposal/],
]

function phaseOf(user: string): string {
  for (const [phase, re] of MARKERS) if (re.test(user)) return phase
  return "unknown"
}

function targetOf(user: string): string | undefined {
  const m = user.match(/Critique ([^']+)'s (?:revised )?proposal/)
  return m ? m[1] : undefined
}

class Fake implements SubAgentRunner {
  shouldFail: (m: ModelInfo, phase: string, target?: string) => boolean = () => false
  arbitrate: string[] = [ruling(5, true)]
  calls: Array<{ model: string; phase: string; target?: string }> = []
  private idx = 0

  async run(model: ModelInfo, _system: string, user: string, _tools?: string[]): Promise<string> {
    const phase = phaseOf(user)
    const target = phase === "critiques" ? targetOf(user) : undefined
    this.calls.push({ model: model.name, phase, target })
    if (this.shouldFail(model, phase, target)) throw new Error(`${model.name} boom`)
    if (phase === "arbitrate") return this.arbitrate[Math.min(this.idx++, this.arbitrate.length - 1)]
    if (phase === "synthesize") return SYNTH
    if (phase === "revise") return REVISE
    if (phase === "critiques") return CRITIQUE
    if (phase === "research") return `Brief for ${model.name}`
    if (phase === "proposals") return PROPOSAL
    return "ok"
  }
}

const MODELS: ModelInfo[] = [
  { id: "a", name: "A", provider: "openai" },
  { id: "b", name: "B", provider: "openai" },
  { id: "c", name: "C", provider: "openai" },
  { id: "d", name: "D", provider: "openai" },
]
const ARBITRATOR: ModelInfo = { id: "arb", name: "Arb", provider: "openai" }

function cfg(over: Partial<CouncilConfig> = {}): CouncilConfig {
  return {
    models: MODELS,
    arbitrator: ARBITRATOR,
    maxRounds: 1,
    threshold: 4,
    enableResearch: false,
    ...over,
  }
}

function fail(result: DeliberationResult): { phase: string; model: string; error: string }[] {
  return (result as unknown as { failures?: { phase: string; model: string; error: string }[] }).failures ?? []
}

describe("council deliberation: fault tolerance", () => {
  test("survives 1 of 4 proposal failures", async () => {
    const runner = new Fake()
    runner.shouldFail = (m, phase) => phase === "proposals" && m.name === "A"
    const result = await runCouncil("What is 2+2?", cfg(), runner)
    expect(result.rounds[0].proposals.length).toBe(3)
    expect(fail(result).some((f) => f.model === "A" && f.phase === "proposals")).toBe(true)
  })

  test("fails when fewer than 2 proposals succeed", async () => {
    const runner = new Fake()
    runner.shouldFail = (m, phase) => phase === "proposals" && ["A", "B", "C"].includes(m.name)
    await expect(runCouncil("What is 2+2?", cfg(), runner)).rejects.toThrow(/phase "proposals" failed/)
  })

  test("survives critique failures", async () => {
    const runner = new Fake()
    runner.shouldFail = (m, phase, target) =>
      phase === "critiques" &&
      ((m.name === "A" && target === "B") || (m.name === "C" && target === "D"))
    const result = await runCouncil("What is 2+2?", cfg(), runner)
    expect(result.rounds[0].critiques.length).toBe(10)
    expect(fail(result).filter((f) => f.phase === "critiques").length).toBe(2)
  })

  test("excludes failed proposal model from critiques", async () => {
    const runner = new Fake()
    runner.shouldFail = (m, phase) => phase === "proposals" && m.name === "A"
    const result = await runCouncil("What is 2+2?", cfg(), runner)
    const critiques = result.rounds[0].critiques
    expect(critiques.some((c) => c.target === "A")).toBe(false)
    expect(critiques.some((c) => c.reviewer === "A")).toBe(false)
  })

  test("fails when the arbitrator fails", async () => {
    const runner = new Fake()
    runner.shouldFail = (m, phase) => phase === "arbitrate"
    await expect(runCouncil("What is 2+2?", cfg(), runner)).rejects.toThrow(/arbitr/i)
  })

  test("fails when synthesis fails", async () => {
    const runner = new Fake()
    runner.shouldFail = (m, phase) => phase === "synthesize"
    await expect(runCouncil("What is 2+2?", cfg(), runner)).rejects.toThrow(/synth/i)
  })

  test("survives research failures", async () => {
    const runner = new Fake()
    runner.shouldFail = (m, phase) => phase === "research" && m.name === "A"
    const result = await runCouncil("What is 2+2?", cfg({ enableResearch: true }), runner)
    expect(Object.keys(result.researchBriefs).length).toBe(3)
    expect(result.researchBriefs["A"]).toBeUndefined()
  })

  test("survives revision failures", async () => {
    const runner = new Fake()
    runner.arbitrate = [ruling(1, false, "continue"), ruling(5, true)]
    runner.shouldFail = (m, phase) => phase === "revise" && m.name === "A"
    const result = await runCouncil("What is 2+2?", cfg({ maxRounds: 2 }), runner)
    expect(result.rounds[1].proposals.length).toBe(3)
    expect(fail(result).some((f) => f.model === "A" && f.phase === "revisions")).toBe(true)
  })

  test("includes a failures array in the result on partial failure", async () => {
    const runner = new Fake()
    runner.shouldFail = (m, phase) => phase === "proposals" && m.name === "A"
    const result = await runCouncil("What is 2+2?", cfg(), runner)
    const failures = fail(result)
    expect(Array.isArray(failures)).toBe(true)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.every((f) => f.phase && f.model && typeof f.error === "string")).toBe(true)
  })

  test("completes with all models succeeding (happy path)", async () => {
    const runner = new Fake()
    const result = await runCouncil("What is 2+2?", cfg(), runner)
    expect(result.rounds[0].proposals.length).toBe(4)
    expect(result.rounds[0].critiques.length).toBe(12)
    expect(result.finalSynthesis).toBe(SYNTH)
    expect(fail(result).length).toBe(0)
  })

  test("completes with consensus in round 1", async () => {
    const runner = new Fake()
    runner.arbitrate = [ruling(5, true)]
    const result = await runCouncil("What is 2+2?", cfg(), runner)
    expect(result.totalRounds).toBe(1)
    expect(result.consensusReached).toBe(true)
  })
})
