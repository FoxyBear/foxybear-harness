import {
  assignRoles,
  buildProposalPrompt,
  buildCritiquePrompt,
  buildArbitratePrompt,
  buildRevisePrompt,
  buildSynthesizePrompt,
  buildResearchPrompt,
  type ModelInfo,
  type RoleAssignment,
} from "./prompts";
export type { ModelInfo } from "./prompts";
export type { Ruling } from "./ruling";
import { parseRuling, extractJSON, type Ruling } from "./ruling";

export interface CouncilConfig {
  models: ModelInfo[];
  arbitrator: ModelInfo;
  maxRounds: number;
  threshold: number;
  enableResearch: boolean;
}

export interface Proposal {
  modelName: string;
  role: string;
  content: string;
}

export interface CritiqueResult {
  reviewer: string;
  target: string;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  summary: string;
}

export interface RoundResult {
  roundNumber: number;
  proposals: Proposal[];
  critiques: CritiqueResult[];
  ruling: Ruling;
}

export interface Failure {
  phase: string;
  model: string;
  error: string;
}

export interface DeliberationResult {
  prompt: string;
  researchBriefs: Record<string, string>;
  rounds: RoundResult[];
  finalSynthesis: string;
  consensusReached: boolean;
  totalRounds: number;
  failures: Failure[];
}

export interface SubAgentRunner {
  run(model: ModelInfo, systemPrompt: string, userPrompt: string, tools?: string[]): Promise<string>;
}

function parseCritiqueResponse(raw: string): { strengths: string[]; weaknesses: string[]; suggestions: string[]; summary: string } {
  try {
    const parsed = JSON.parse(extractJSON(raw));
    return {
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : raw.slice(0, 200),
    };
  } catch {
    return { strengths: [], weaknesses: [], suggestions: [], summary: raw.slice(0, 200) };
  }
}

function survive<T>(
  settled: PromiseSettledResult<T>[],
  names: string[],
  phase: string,
  fails: Failure[],
  min = 0,
): T[] {
  settled.forEach((s, i) => {
    if (s.status === "rejected") {
      const e = s.reason instanceof Error ? s.reason.message : String(s.reason);
      fails.push({ phase, model: names[i], error: e.slice(0, 200) });
    }
  });
  const ok = settled.filter((s): s is PromiseFulfilledResult<T> => s.status === "fulfilled").map((s) => s.value);
  if (ok.length < min) {
    const fl = fails.filter((f) => f.phase === phase);
    throw new Error(`Council phase "${phase}" failed: only ${ok.length} models succeeded. Failures: ${JSON.stringify(fl)}`);
  }
  return ok;
}

export async function runCouncil(
  prompt: string,
  config: CouncilConfig,
  runner: SubAgentRunner,
  onProgress?: (phase: string, detail: string) => void
): Promise<DeliberationResult> {
  const assignments = assignRoles(config.models);
  const failures: Failure[] = [];
  let active = assignments;

  // Phase 0: Research (optional, failures non-fatal — F-7)
  const researchBriefs: Record<string, string> = {};
  if (config.enableResearch) {
    const settled = await Promise.allSettled(
      assignments.map(async (a) => {
        onProgress?.("research", `${a.model.name} is researching...`);
        const researchPrompt = buildResearchPrompt(a, prompt);
        const brief = await runner.run(
          a.model,
          researchPrompt,
          "Research this topic and produce an evidence brief.",
          ["read", "websearch", "memory", "bash"]
        );
        onProgress?.("research", `${a.model.name} — research complete (${brief.length} chars)`);
        return { name: a.model.name, brief };
      })
    );
    const ok = survive(settled, assignments.map((a) => a.model.name), "research", failures);
    ok.forEach((r) => { researchBriefs[r.name] = r.brief; });
  }

  // Phase 1 + 2: Proposals and deliberation
  const rounds: RoundResult[] = [];
  const previousScores: number[] = [];
  let currentProposals: Proposal[] = [];
  let currentCritiques: CritiqueResult[] = [];

  // Round 1: Initial proposals (≥2 survivors required — F-2)
  onProgress?.("round", `Round 1 — proposals`);
  const proposalSettled = await Promise.allSettled(
    assignments.map(async (a) => {
      const brief = researchBriefs[a.model.name];
      const proposalPrompt = buildProposalPrompt(a, brief, prompt);
      const content = await runner.run(a.model, proposalPrompt, "Present your proposal.");
      return { modelName: a.model.name, role: a.role, content } satisfies Proposal;
    })
  );
  currentProposals = survive(proposalSettled, assignments.map((a) => a.model.name), "proposals", failures, 2);
  active = active.filter((a) => currentProposals.some((p) => p.modelName === a.model.name));

  // Round 1: Critiques (failed proposal models excluded as reviewer/target — F-4)
  onProgress?.("round", `Round 1 — critiques`);
  const critiqueTasks1 = active.flatMap((reviewer) =>
    active.filter((target) => target.model.id !== reviewer.model.id).map((target) => ({ reviewer, target }))
  );
  const critiqueSettled1 = await Promise.allSettled(
    critiqueTasks1.map(async ({ reviewer, target }) => {
      const targetProposal = currentProposals.find((p) => p.modelName === target.model.name)?.content ?? "";
      const critiquePrompt = buildCritiquePrompt(
        reviewer.model,
        reviewer.role,
        targetProposal,
        target.model.name,
        currentProposals.map((p) => ({ modelName: p.modelName, proposal: p.content })),
        prompt
      );
      const raw = await runner.run(reviewer.model, critiquePrompt, `Critique ${target.model.name}'s proposal.`);
      return { reviewer: reviewer.model.name, target: target.model.name, ...parseCritiqueResponse(raw) } satisfies CritiqueResult;
    })
  );
  currentCritiques = survive(critiqueSettled1, critiqueTasks1.map((t) => t.reviewer.model.name), "critiques", failures);

  // Round 1: Arbitrate (single-point — failure kills the council — F-5)
  onProgress?.("round", `Round 1 — arbitrator`);
  const arbitrateResult1 = await runner.run(
    config.arbitrator,
    buildArbitratePrompt(
      currentProposals.map((p) => ({ modelName: p.modelName, proposal: p.content })),
      currentCritiques,
      prompt,
      config.threshold,
      undefined,
      1
    ),
    "Evaluate the council's proposals and issue your ruling."
  ).catch((e) => { throw new Error(`Council arbitration failed (round 1): ${e instanceof Error ? e.message : String(e)}`); });
  const ruling1 = parseRuling(arbitrateResult1, config.threshold);
  previousScores.push(ruling1.convergenceScore);
  rounds.push({ roundNumber: 1, proposals: currentProposals, critiques: currentCritiques, ruling: ruling1 });

  let latestRuling = ruling1;

  if (latestRuling.converged || latestRuling.action === "conclude") {
    onProgress?.("round", latestRuling.converged ? `Consensus reached in round 1` : `Concluded by arbitrator in round 1`);
    const synthesis = await runner.run(
      config.arbitrator,
      buildSynthesizePrompt(
        currentProposals.map((p) => ({ modelName: p.modelName, proposal: p.content })),
        currentCritiques,
        { agreements: latestRuling.agreements, disagreements: latestRuling.disagreements },
        prompt
      ),
      "Synthesize the final output."
    ).catch((e) => { throw new Error(`Council synthesis failed: ${e instanceof Error ? e.message : String(e)}`); });
    return { prompt, researchBriefs, rounds, finalSynthesis: synthesis, consensusReached: latestRuling.converged, totalRounds: 1, failures };
  }

  // Rounds 2+: Revise → Critique → Arbitrate
  for (let roundNum = 2; roundNum <= config.maxRounds; roundNum++) {
    onProgress?.("round", `Round ${roundNum} — revise & critique`);

    // Revise (≥2 survivors required — F-2)
    const revisionSettled = await Promise.allSettled(
      active.map(async (a) => {
        const myProposal = currentProposals.find((p) => p.modelName === a.model.name)?.content ?? "";
        const directive = latestRuling.directives[a.model.id] ?? "";
        const synthesizedCritique = latestRuling.synthesizedCritiques[a.model.id] ?? "";
        const revisePrompt = buildRevisePrompt(
          a.model.name,
          myProposal,
          directive,
          synthesizedCritique,
          { agreements: latestRuling.agreements, disagreements: latestRuling.disagreements },
          prompt
        );
        const content = await runner.run(a.model, revisePrompt, `Revise your proposal for round ${roundNum}.`);
        return { modelName: a.model.name, role: a.role, content };
      })
    );
    currentProposals = survive(revisionSettled, active.map((a) => a.model.name), "revisions", failures, 2);
    active = active.filter((a) => currentProposals.some((p) => p.modelName === a.model.name));

    // Critique
    const critiqueTasks = active.flatMap((reviewer) =>
      active.filter((target) => target.model.id !== reviewer.model.id).map((target) => ({ reviewer, target }))
    );
    const critiqueSettled = await Promise.allSettled(
      critiqueTasks.map(async ({ reviewer, target }) => {
        const targetProposal = currentProposals.find((p) => p.modelName === target.model.name)?.content ?? "";
        const critiquePrompt = buildCritiquePrompt(
          reviewer.model,
          reviewer.role,
          targetProposal,
          target.model.name,
          currentProposals.map((p) => ({ modelName: p.modelName, proposal: p.content })),
          prompt
        );
        const raw = await runner.run(reviewer.model, critiquePrompt, `Critique ${target.model.name}'s revised proposal.`);
        return { reviewer: reviewer.model.name, target: target.model.name, ...parseCritiqueResponse(raw) } satisfies CritiqueResult;
      })
    );
    currentCritiques = survive(critiqueSettled, critiqueTasks.map((t) => t.reviewer.model.name), "critiques", failures);

    // Arbitrate (single-point — F-5)
    onProgress?.("round", `Round ${roundNum} — arbitrator`);
    const arbitrateResult = await runner.run(
      config.arbitrator,
      buildArbitratePrompt(
        currentProposals.map((p) => ({ modelName: p.modelName, proposal: p.content })),
        currentCritiques,
        prompt,
        config.threshold,
        previousScores,
        roundNum
      ),
      `Evaluate the council's round ${roundNum} proposals and issue your ruling.`
    ).catch((e) => { throw new Error(`Council arbitration failed (round ${roundNum}): ${e instanceof Error ? e.message : String(e)}`); });

    const ruling = parseRuling(arbitrateResult, config.threshold);
    previousScores.push(ruling.convergenceScore);
    rounds.push({ roundNumber: roundNum, proposals: currentProposals, critiques: currentCritiques, ruling });
    latestRuling = ruling;

    if (ruling.converged || ruling.action === "conclude") break;
  }

  // Phase 3: Synthesize (single-point — failure kills the council — F-6)
  onProgress?.("synthesize", "Producing final synthesis");
  const finalSynthesis = await runner.run(
    config.arbitrator,
    buildSynthesizePrompt(
      currentProposals.map((p) => ({ modelName: p.modelName, proposal: p.content })),
      currentCritiques,
      {
        agreements: rounds[rounds.length - 1].ruling.agreements,
        disagreements: rounds[rounds.length - 1].ruling.disagreements,
      },
      prompt
    ),
    "Synthesize the final output."
  ).catch((e) => { throw new Error(`Council synthesis failed: ${e instanceof Error ? e.message : String(e)}`); });

  return {
    prompt,
    researchBriefs,
    rounds,
    finalSynthesis,
    consensusReached: rounds[rounds.length - 1].ruling.converged,
    totalRounds: rounds.length,
    failures,
  };
}
