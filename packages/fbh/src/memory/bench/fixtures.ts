/**
 * SDD-08 / Phase M-6 — Fixtures.
 *
 * Synthetic fixtures for the four A/B + tuning modes:
 *  - injection: queries answerable from a small fact corpus
 *  - relational: "what did agent X do with tool Y after error Z?" —
 *    the answer requires joining ActionNode + ErrorNode + AgentNode +
 *    ToolNode via hyperedges (per sdd-03). KV-only retrieval should
 *    miss; hypergraph should hit.
 *  - long_range: queries whose answers live in memory_topics rows
 *    older than 7 days (or > 50 turns back). KV should win; hypergraph
 *    should not regress by more than 0.05 (the regression guard).
 *  - contradiction: 50 real contradictions + 50 not, for the conflict
 *    threshold sweep (req 8) and the contradiction-rate measurement
 *    (req 16).
 *  - graduation: instance-scoped memories that should / should not
 *    graduate to project scope, for the semantic-shift sweep (req 10).
 *
 * Each fixture row carries expected_node_ids so Recall@k / MRR / nDCG
 * can be computed without an LLM in the loop. Answer F1 + Faithfulness
 * require an LLM; the harness fills those in at run time.
 */
export interface FixtureRow {
  id: string
  query: string
  expected_answer: string
  expected_node_ids: string[]
  turn_index: number
  /** For contradiction fixtures: whether this pair IS a contradiction. */
  is_contradiction?: boolean
  /** For graduation fixtures: whether this memory SHOULD graduate. */
  should_graduate?: boolean
  /** For relational fixtures: the agent / tool / error triple. */
  agent?: string
  tool?: string
  error?: string
}

export interface Fixture {
  id: string
  kind: "injection" | "relational" | "long_range" | "contradiction" | "graduation"
  rows: FixtureRow[]
}

/** Build a small relational fixture with hand-labeled expected_node_ids. */
export function relational(n: number): Fixture {
  const rows: FixtureRow[] = []
  const agents = ["alpha", "bravo", "charlie", "delta", "echo"]
  const tools = ["search", "calc", "write", "read", "edit"]
  const errors = ["timeout", "auth", "notfound", "perm", "quota"]
  for (let i = 0; i < n; i++) {
    const a = agents[i % agents.length]!
    const t = tools[i % tools.length]!
    const e = errors[i % errors.length]!
    const actionId = `act-${a}-${t}-${i}`
    const errorId = `err-${e}-${i}`
    const agentId = `agent-${a}`
    const toolId = `tool-${t}`
    rows.push({
      id: `rel-${i}`,
      query: `What did agent ${a} do with tool ${t} after error ${e}?`,
      expected_answer: `Agent ${a} used tool ${t} to retry after ${e} error`,
      expected_node_ids: [actionId, errorId, agentId, toolId],
      turn_index: i,
      agent: a, tool: t, error: e,
    })
  }
  return { id: `relational-${n}`, kind: "relational", rows }
}

/** Long-range fixture — answers in memory_topics rows older than 7 days. */
export function longRange(n: number): Fixture {
  const rows: FixtureRow[] = []
  const topics = [
    "the deployment config", "the migration plan", "the schema audit",
    "the API contract", "the SLO budget", "the oncall roster",
    "the release notes", "the incident postmortem",
  ]
  for (let i = 0; i < n; i++) {
    const topic = topics[i % topics.length]!
    rows.push({
      id: `lr-${i}`,
      query: `What did we decide about ${topic}?`,
      expected_answer: `Decision recorded about ${topic}`,
      expected_node_ids: [`topic-${topic.replace(/[^a-z0-9]+/g, "-")}`],
      turn_index: 60 + i,
    })
  }
  return { id: `long-range-${n}`, kind: "long_range", rows }
}

/** Injection fixture — answerable from a small fact corpus. */
export function injection(n: number): Fixture {
  const rows: FixtureRow[] = []
  const facts = [
    ["the API rate limit", "500 requests per minute per token"],
    ["the default model", "gpt-4o-mini for judging, qwen2.5-7b for extraction"],
    ["the embedding dim", "768 dimensions via BAAI/bge-base-en-v1.5"],
    ["the decay active_rate", "0.01 per day for ACTIVE memories"],
    ["the conflict cosine threshold", "0.30 is the midpoint of the sweep"],
    ["the packing budget", "1024 tokens default, swept across 512..4096"],
    ["the hypergraph depth", "depth=1 BFS via the adjacency map"],
    ["the scheduler interval", "60s tick for the cron evaluator"],
  ]
  for (let i = 0; i < n; i++) {
    const [q, a] = facts[i % facts.length]!
    rows.push({
      id: `inj-${i}`,
      query: `What is ${q}?`,
      expected_answer: a,
      expected_node_ids: [`fact-${i}`],
      turn_index: i,
    })
  }
  return { id: `injection-${n}`, kind: "injection", rows }
}

/** Contradiction fixture — 50 real + 50 not (per req 8). */
export function contradiction(n: number): Fixture {
  const rows: FixtureRow[] = []
  const real = [
    ["rate limit is 500/min", "rate limit is 1000/min"],
    ["model is gpt-4o-mini", "model is gpt-3.5-turbo"],
    ["budget is 1024 tokens", "budget is 2048 tokens"],
    ["depth is 1", "depth is 2"],
    ["threshold is 0.30", "threshold is 0.20"],
    ["active_rate is 0.01", "active_rate is 0.05"],
    ["scheduler tick is 60s", "scheduler tick is 30s"],
    ["embedding dim is 768", "embedding dim is 512"],
  ]
  const not = [
    ["rate limit is 500/min", "rate limit applies per token"],
    ["model is gpt-4o-mini", "gpt-4o-mini is used for judging"],
    ["budget is 1024 tokens", "1024 is the default budget"],
    ["depth is 1", "BFS uses depth=1 by default"],
    ["threshold is 0.30", "0.30 is the cosine midpoint"],
    ["active_rate is 0.01", "ACTIVE memories decay at 0.01"],
    ["scheduler tick is 60s", "the cron tick interval is 60s"],
    ["embedding dim is 768", "bge-base-en produces 768-dim vectors"],
  ]
  const half = Math.floor(n / 2)
  for (let i = 0; i < half; i++) {
    const [a, b] = real[i % real.length]!
    rows.push({
      id: `con-${i}`,
      query: `Pair: "${a}" vs "${b}"`,
      expected_answer: "CONTRADICTION",
      expected_node_ids: [`pair-${i}`],
      turn_index: i,
      is_contradiction: true,
    })
  }
  for (let i = 0; i < n - half; i++) {
    const [a, b] = not[i % not.length]!
    rows.push({
      id: `con-${i + half}`,
      query: `Pair: "${a}" vs "${b}"`,
      expected_answer: "NO_CONTRADICTION",
      expected_node_ids: [`pair-${i + half}`],
      turn_index: i + half,
      is_contradiction: false,
    })
  }
  return { id: `contradiction-${n}`, kind: "contradiction", rows }
}

/** Graduation fixture — instance-scoped memories that should / should not graduate. */
export function graduation(n: number): Fixture {
  const rows: FixtureRow[] = []
  const should = [
    "the project's release process", "the team's code review policy",
    "the API naming convention", "the oncall escalation path",
  ]
  const shouldNot = [
    "yesterday's lunch order", "this session's temp scratch note",
    "a one-off debugging command", "a fleeting question",
  ]
  const half = Math.floor(n / 2)
  for (let i = 0; i < half; i++) {
    rows.push({
      id: `grad-${i}`,
      query: `Should "${should[i % should.length]}" graduate to project scope?`,
      expected_answer: "YES",
      expected_node_ids: [`grad-${i}`],
      turn_index: i,
      should_graduate: true,
    })
  }
  for (let i = 0; i < n - half; i++) {
    rows.push({
      id: `grad-${i + half}`,
      query: `Should "${shouldNot[i % shouldNot.length]}" graduate to project scope?`,
      expected_answer: "NO",
      expected_node_ids: [`grad-${i + half}`],
      turn_index: i + half,
      should_graduate: false,
    })
  }
  return { id: `graduation-${n}`, kind: "graduation", rows }
}
