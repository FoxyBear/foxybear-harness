/**
 * SDD-08 / Phase M-6 — AgentMemBench metric implementations.
 *
 * Seven metrics (per req 1):
 *  - Recall@k for k = 1, 5, 10
 *  - MRR (mean reciprocal rank)
 *  - nDCG@k
 *  - Answer F1 (token-overlap between LLM answer and expected_answer)
 *  - LLM-judge Faithfulness (YES / PARTIAL / NO from a second LLM call)
 *  - Memory Footprint (tokens of injected context)
 *  - Latency (ms, wall-clock query → response)
 *
 * Style: pure functions, no I/O. The bench entry point (bench.ts) wires
 * these to the daemon HTTP API and the real LLM provider (CC-5 — no
 * mocks of our code; the LLM-judge IS a real second LLM call).
 */
import { Token } from "../../util/token"

export interface PerQuery {
  query: string
  expected_answer: string
  expected_node_ids: string[]
  retrieved_node_ids: string[]
  answer: string
  faithfulness: "YES" | "PARTIAL" | "NO"
  recall_at_1: number
  recall_at_5: number
  recall_at_10: number
  mrr: number
  ndcg_at_5: number
  ndcg_at_10: number
  f1: number
  footprint_tokens: number
  latency_ms: number
}

export interface Aggregate {
  recall_at_1: number
  recall_at_5: number
  recall_at_10: number
  mrr: number
  ndcg_at_5: number
  ndcg_at_10: number
  f1: number
  faithfulness_yes: number
  faithfulness_partial: number
  faithfulness_no: number
  faithfulness_score: number
  footprint_tokens_avg: number
  latency_ms_avg: number
  n: number
}

/** Recall@k — fraction of expected IDs that appear in the top-k retrieved. */
export function recallAtK(retrieved: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0
  const top = retrieved.slice(0, k)
  const hit = top.filter((id) => expected.includes(id)).length
  return hit / expected.length
}

/** MRR — 1/rank of the first relevant hit, 0 if no hit. */
export function mrr(retrieved: string[], expected: string[]): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (expected.includes(retrieved[i]!)) return 1 / (i + 1)
  }
  return 0
}

/** DCG@k — graded relevance discount. */
function dcgAtK(retrieved: string[], expected: string[], k: number): number {
  const top = retrieved.slice(0, k)
  let sum = 0
  for (let i = 0; i < top.length; i++) {
    const rel = expected.includes(top[i]!) ? 1 : 0
    sum += rel / Math.log2(i + 2)
  }
  return sum
}

/** nDCG@k — DCG / ideal DCG. */
export function ndcgAtK(retrieved: string[], expected: string[], k: number): number {
  const ideal = dcgAtK(expected, expected, k)
  if (ideal === 0) return 0
  return dcgAtK(retrieved, expected, k) / ideal
}

/** Answer F1 — token-overlap F1 between answer and expected_answer. */
export function answerF1(answer: string, expected: string): number {
  const a = tokenize(answer)
  const e = tokenize(expected)
  if (a.length === 0 || e.length === 0) return 0
  const aSet = new Set(a)
  const eSet = new Set(e)
  let tp = 0
  for (const t of aSet) if (eSet.has(t)) tp++
  if (tp === 0) return 0
  const precision = tp / aSet.size
  const recall = tp / eSet.size
  return (2 * precision * recall) / (precision + recall)
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** Faithfulness score: YES=1.0, PARTIAL=0.5, NO=0. */
export function faithScore(v: "YES" | "PARTIAL" | "NO"): number {
  if (v === "YES") return 1.0
  if (v === "PARTIAL") return 0.5
  return 0
}

/** Parse a YES/PARTIAL/NO judge response. */
export function parseFaith(raw: string): "YES" | "PARTIAL" | "NO" {
  const s = raw.trim().toUpperCase()
  if (s.startsWith("YES")) return "YES"
  if (s.startsWith("PARTIAL")) return "PARTIAL"
  return "NO"
}

/** Footprint — token count of the injected context block. */
export function footprint(text: string): number {
  return Token.estimate(text)
}

/** Latency — wall-clock ms between two Date.now() samples. */
export function latency(start: number, end: number): number {
  return Math.max(0, end - start)
}

/** Aggregate a list of per-query metrics into a single summary. */
export function aggregate(rows: PerQuery[]): Aggregate {
  const n = rows.length
  if (n === 0) {
    return {
      recall_at_1: 0, recall_at_5: 0, recall_at_10: 0,
      mrr: 0, ndcg_at_5: 0, ndcg_at_10: 0, f1: 0,
      faithfulness_yes: 0, faithfulness_partial: 0, faithfulness_no: 0,
      faithfulness_score: 0, footprint_tokens_avg: 0, latency_ms_avg: 0, n: 0,
    }
  }
  const sum = (f: (r: PerQuery) => number) => rows.reduce((a, r) => a + f(r), 0)
  const yes = rows.filter((r) => r.faithfulness === "YES").length
  const partial = rows.filter((r) => r.faithfulness === "PARTIAL").length
  const no = rows.filter((r) => r.faithfulness === "NO").length
  return {
    recall_at_1: sum((r) => r.recall_at_1) / n,
    recall_at_5: sum((r) => r.recall_at_5) / n,
    recall_at_10: sum((r) => r.recall_at_10) / n,
    mrr: sum((r) => r.mrr) / n,
    ndcg_at_5: sum((r) => r.ndcg_at_5) / n,
    ndcg_at_10: sum((r) => r.ndcg_at_10) / n,
    f1: sum((r) => r.f1) / n,
    faithfulness_yes: yes,
    faithfulness_partial: partial,
    faithfulness_no: no,
    faithfulness_score: sum((r) => faithScore(r.faithfulness)) / n,
    footprint_tokens_avg: sum((r) => r.footprint_tokens) / n,
    latency_ms_avg: sum((r) => r.latency_ms) / n,
    n,
  }
}

/**
 * Wilcoxon signed-rank p-value (two-sided, normal approximation).
 *
 * Inline implementation per spec HOW §A/B runner — no new heavy
 * dependency. Adequate for n ≥ 5 paired observations.
 */
export function wilcoxon(a: number[], b: number[]): { p: number; z: number; n: number } {
  const diffs = a.map((v, i) => v - b[i]!).filter((d) => d !== 0)
  const n = diffs.length
  if (n === 0) return { p: 1.0, z: 0, n: 0 }
  const abs = diffs.map((d) => Math.abs(d))
  const sorted = [...abs].sort((x, y) => x - y)
  const ranks = abs.map((v) => sorted.indexOf(v) + 1)
  const wPlus = diffs.reduce((s, d, i) => (d > 0 ? s + ranks[i]! : s), 0)
  const wMinus = diffs.reduce((s, d, i) => (d < 0 ? s + ranks[i]! : s), 0)
  const w = Math.min(wPlus, wMinus)
  const mean = (n * (n + 1)) / 4
  const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24)
  const z = sd > 0 ? (w - mean) / sd : 0
  const p = 2 * (1 - normalCdf(Math.abs(z)))
  return { p: Math.min(1, Math.max(0, p)), z, n }
}

function normalCdf(z: number): number {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * z)
  const d = 0.3989422804014327 * Math.exp(-z * z / 2)
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return 1 - p
}
