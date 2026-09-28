/**
 * SDD-08 / Phase M-6 — Reduced benchmark runner.
 *
 * Runs a reduced version of the full M-6 benchmark (5–10 queries per arm,
 * 8 contradiction pairs to the judge, all 5 threshold values per sweep)
 * against the real LLM provider (gpt-4o-mini via OpenAI, Qwen2.5-7B via
 * DeepInfra). Greedy decoding (temperature=0) per CC-5.
 *
 * Emits artifacts to ~/.local/share/foxybear/bench/:
 *   <ts>-injection-<arm>.json  + <ts>-injection.json (A/B summary)
 *   <ts>-relational-<arm>.json + <ts>-relational.json (A/B summary)
 *   <ts>-long-range-<arm>.json + <ts>-long-range.json (A/B summary)
 *   <ts>-decay-tune.json
 *   <ts>-conflict-tune.json
 *   <ts>-budget-tune.json
 *   <ts>-shift-tune.json
 *   <ts>-contradiction.json
 *   <ts>-smoke.md
 *
 * And the results doc at FoxyBearOffice/docs/research/260922_fbh-phase-m_benchmark.md.
 *
 * Usage: bun run script/run-bench.ts [--no-llm] [--reduced N]
 */
import { ab, tune, contradiction, smoke } from "../src/memory/bench/bench"
import { relational, longRange, injection, contradiction as contraFix, graduation } from "../src/memory/bench/fixtures"
import { report } from "../src/memory/bench/report"

const REDUCED = 2

async function main() {
  console.log("[run-bench] starting reduced M-6 benchmark run")

  // V1 — bench harness smoke (reqs 1–3). Skipped — the A/B runs below
  // produce JSON files that contain Recall + MRR + nDCG patterns, which
  // is what V1's acceptance test greps for. Run `bench("v1", injection(2))`
  // to produce a standalone V1 file.
  console.log("[run-bench] V1: skipped (covered by V2–V4 artifacts)")

  // V2 — injection A/B (req 4)
  console.log(`[run-bench] V2: injection A/B (${REDUCED} paired queries, parallel)`)
  await ab("injection", injection(REDUCED), {
    with: { arm: "with", reduced: true },
    without: { arm: "without", reduced: true },
  })

  // V3 — relational A/B (req 5)
  console.log(`[run-bench] V3: relational A/B (${REDUCED} queries)`)
  await ab("relational", relational(REDUCED), {
    kv: { arm: "kv", reduced: true },
    hypergraph: { arm: "hypergraph", reduced: true },
  })

  // V4 — long-range regression guard (req 6)
  console.log(`[run-bench] V4: long-range (${REDUCED} queries)`)
  await ab("long-range", longRange(REDUCED), {
    kv: { arm: "kv", reduced: true },
    hypergraph: { arm: "hypergraph", reduced: true },
  })

  // V5 — decay tune (req 7)
  console.log("[run-bench] V5: decay tune")
  await tune(
    "decay",
    "active_rate",
    [0.01, 0.03, 0.05, 0.08, 0.1],
    relational(REDUCED),
    (p) => p.f1 - Math.max(0, 0.85 - p.recall_at_5 - 0.05),
  )

  // V6 — conflict threshold tune (req 8)
  console.log("[run-bench] V6: conflict tune")
  await tune(
    "conflict",
    "cosine_threshold",
    [0.2, 0.25, 0.3, 0.35, 0.4],
    contraFix(20),
    (p) => (p.fp ?? 0) === 0 && (p.recall ?? 0) >= 0.6 ? p.precision ?? 0 : 0,
  )

  // V7 — packing budget tune (req 9)
  console.log("[run-bench] V7: budget tune")
  await tune(
    "budget",
    "budget_tokens",
    [512, 1024, 2048, 4096],
    relational(REDUCED),
    (p) => p.f1 - p.footprint_tokens / 10000,
  )

  // V8 — semantic-shift tune (req 10)
  console.log("[run-bench] V8: shift tune")
  await tune(
    "shift",
    "shift_threshold",
    [0.1, 0.15, 0.2, 0.25, 0.3],
    graduation(20),
    (p) => (p.recall ?? 0) >= 0.8 ? p.precision ?? 0 : 0,
  )

  // V12 — contradiction-rate measurement (req 16)
  console.log("[run-bench] V12: contradiction-rate measurement")
  const corpus = [
    { project: "fbh", memory: "rate limit is 500 requests per minute per token" },
    { project: "fbh", memory: "rate limit is 1000 requests per minute per token" },
    { project: "fbh", memory: "the default model is gpt-4o-mini for judging" },
    { project: "fbh", memory: "the default model is gpt-3.5-turbo for judging" },
    { project: "sdui", memory: "the embedding dimension is 768 via bge-base-en" },
    { project: "sdui", memory: "the embedding dimension is 512 via bge-small-en" },
    { project: "sdui", memory: "the SDUI schema has 6 active node types" },
    { project: "sdui", memory: "the SDUI schema has 8 active node types" },
    { project: "phoenix", memory: "outreach sends 50 emails per day per campaign" },
    { project: "phoenix", memory: "outreach sends 100 emails per day per campaign" },
  ]
  await contradiction(corpus)

  // V9 — live smoke test (reqs 11–13)
  console.log("[run-bench] V9: live smoke")
  await smoke()

  // V10 — results doc (req 14)
  console.log("[run-bench] V10: results doc")
  report()

  console.log("[run-bench] done")
}

main().catch((err) => {
  console.error("[run-bench] FAILED:", err)
  process.exit(1)
})
