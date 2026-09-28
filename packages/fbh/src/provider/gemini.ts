/**
 * SDD-02 / Phase N — Gemini Extraction Provider.
 *
 * Stage 2 of the 4-stage classification pipeline. The gate (SDD-01 Jev)
 * decides whether a turn enriches a future query; this provider wires the
 * extractor that pulls specific memory fragments from the full context.
 * Gemini 2.5 Flash was picked over Llama 70B / Qwen 7B in the spike bake-off
 * (5/5 JSON reliability, 1.2s avg, $0.30/M tokens). The Llama/Qwen markdown
 * code-fence wrapping failure mode (40% parse failure) is why this spec has
 * a parse-resilience requirement with fence stripping and retry.
 *
 * Provider is config-driven via memory.extraction.layer2 (master SC-2, CC-4),
 * accessed ONLY via OpenRouter (CC-10), rate-limited at 5 req/sec (CC-5),
 * circuit-broken to fall back to the regex extractor on repeated failure
 * (CC-9), and cost-logged to /memory/metrics (CC-8). Secrets redaction
 * (CC-6) runs upstream in SDD-05 before extract is called.
 *
 * Master: 260926_fbh-phase-n_sdd-00-master.md (SC-1, SC-2, SC-5).
 */
import { Decimal } from "decimal.js"
import { Log } from "../util/log"
import { getConfig } from "../config/bridge"
import { Provider } from "./provider"

const log = Log.create({ service: "provider.gemini" })

const DEFAULT_MODEL = "google/gemini-2.5-flash"
const ENDPOINT = process.env.FBH_GEMINI_ENDPOINT ?? "https://openrouter.ai/api/v1/chat/completions"
const QUEUE_DEPTH = 50
const RATE_PER_SEC = 5
const RATE_INTERVAL_MS = 1000 / RATE_PER_SEC
const RETRY_DELAYS_MS = [500, 1500]
const HALF_OPEN_MS = 60_000
const TYPES = ["preference", "correction", "decision", "constraint", "pattern", "context", "none"] as const
const SOURCES = ["user", "assistant"] as const

// SDD-07 / Phase N — Abstraction system prompt. Replaces the raw-fragment
// extract prompt with a self-contained summary that a future independent
// session can use without seeing the original conversation. The small model
// assigns memory_type in its JSON output, so the pipeline no longer needs
// a separate Jev classify step.
const ABSTRACT_PROMPT = `You are a memory abstraction engine for a coding agent. Your job is to read a conversation interaction and produce a self-contained memory summary that a future independent session could use without seeing the original conversation.

For each distinct memory-worthy fact, decision, preference, correction, or insight:
- State what was decided/learned/preferred
- State why it matters (the reasoning)
- State what scope it applies to (which project, which component, which context)

Return JSON: {"memories": [{"content": "...", "type": "preference|correction|decision|constraint|pattern|context"}]}

Be concise. Each memory should be 1-3 sentences. Only include things that would genuinely help a future session. If nothing is worth remembering, return {"memories": []}.`

export interface ExtractedMemory {
  content: string
  type: "preference" | "correction" | "decision" | "constraint" | "pattern" | "context" | "none"
  source: "user" | "assistant"
}

type MemoryType = (typeof TYPES)[number]
type MemorySource = (typeof SOURCES)[number]

// Circuit-breaker state — three mutable vars matching the SessionCompaction
// idiom at compaction.ts:384-385 (consecutiveFailures + autoDisabled).
// Everything else is held in `const` objects with mutable properties.
let consecutive = 0
let openSince = 0
let cfg: {
  provider: string
  model: string
  api_key: string
  external_opt_in: boolean
  max_latency_ms: number
  max_consecutive_failures: number
} | null = null

// Cost aggregate for /memory/metrics (CC-8). Daily counter resets on date rollover.
const daily = { cost: 0, calls: 0, day: "" }

// Token bucket rate limiter (CC-5: 5 req/sec). A FIFO queue of pending
// callers. Tokens refill at RATE_INTERVAL_MS spacing.
const bucket = {
  tokens: RATE_PER_SEC,
  last_refill: Date.now(),
  queue: [] as Array<() => void>,
}

function refill(): void {
  const now = Date.now()
  const elapsed = now - bucket.last_refill
  const added = Math.floor(elapsed / RATE_INTERVAL_MS)
  if (added > 0) {
    bucket.tokens = Math.min(RATE_PER_SEC, bucket.tokens + added)
    bucket.last_refill = now - (elapsed % RATE_INTERVAL_MS)
  }
}

function drain(): void {
  while (bucket.tokens > 0 && bucket.queue.length > 0) {
    bucket.tokens -= 1
    const next = bucket.queue.shift()
    if (next) next()
  }
}

async function acquire(): Promise<boolean> {
  refill()
  if (bucket.tokens > 0) {
    bucket.tokens -= 1
    return true
  }
  if (bucket.queue.length >= QUEUE_DEPTH) return false
  return new Promise<boolean>((resolve) => {
    bucket.queue.push(() => resolve(true))
    setTimeout(() => {
      refill()
      drain()
    }, RATE_INTERVAL_MS)
  })
}

async function resolve_cfg(): Promise<NonNullable<typeof cfg>> {
  if (cfg) return cfg
  const c = await getConfig()
  const layer2 = c?.memory?.extraction?.layer2
  const cb = c?.memory?.extraction?.circuit_breaker
  let apiKey = layer2?.api_key ?? ""
  if (apiKey.startsWith("{file:")) {
    const filePath = apiKey.replace(/^\{file:/, "").replace(/\}$/, "")
    try { apiKey = (await Bun.file(filePath).text()).trim() } catch {}
  }
  cfg = {
    provider: layer2?.provider ?? "openrouter",
    model: layer2?.model ?? DEFAULT_MODEL,
    api_key: apiKey,
    external_opt_in: c?.memory?.extraction?.external_opt_in ?? true,
    max_latency_ms: cb?.max_latency_ms ?? 3000,
    max_consecutive_failures: cb?.max_consecutive_failures ?? 5,
  }
  return cfg
}

function record_failure(): void {
  consecutive += 1
  if (consecutive >= (cfg?.max_consecutive_failures ?? 5)) {
    openSince = Date.now()
    log.warn("gemini.circuit_open", { consecutive, reason: "consecutive_failures" })
  }
}

function record_success(): void {
  consecutive = 0
  openSince = 0
}

function is_open(): boolean {
  if (openSince === 0) return false
  return Date.now() - openSince < HALF_OPEN_MS
}

function is_half_open(): boolean {
  if (openSince === 0) return false
  return Date.now() - openSince >= HALF_OPEN_MS
}

// Strip markdown code fences before parsing. The Llama/Qwen failure mode
// the spike documented (40% parse failure from ```json wrapping). Gemini
// did not exhibit it, but the strip is cheap insurance.
function strip_fences(text: string): string {
  const m = text.match(/^```(?:json)?\s*(.+?)\s*```$/s)
  return m ? m[1] : text
}

function valid_type(t: unknown): t is MemoryType {
  return typeof t === "string" && (TYPES as readonly string[]).includes(t)
}

function valid_source(s: unknown): s is MemorySource {
  return s === "user" || s === "assistant"
}

function filter_memories(parsed: unknown): ExtractedMemory[] {
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((m): ExtractedMemory[] => {
    if (typeof m !== "object" || m === null) return []
    const r = m as { content?: unknown; type?: unknown; source?: unknown }
    if (typeof r.content !== "string" || r.content.length === 0) return []
    if (!valid_type(r.type)) {
      log.warn("gemini.invalid_type", { type: String(r.type) })
      return []
    }
    if (!valid_source(r.source)) {
      log.warn("gemini.invalid_source", { source: String(r.source) })
      return []
    }
    return [{ content: r.content, type: r.type, source: r.source }]
  })
}

// SDD-07 — Abstraction output has no `source` field (the small model
// generates summaries, not user/assistant attributions). Default to
// "assistant" since the abstraction is the LLM's output.
function filter_abstracted(parsed: unknown): ExtractedMemory[] {
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((m): ExtractedMemory[] => {
    if (typeof m !== "object" || m === null) return []
    const r = m as { content?: unknown; type?: unknown }
    if (typeof r.content !== "string" || r.content.length === 0) return []
    if (!valid_type(r.type)) {
      log.warn("gemini.invalid_type", { type: String(r.type) })
      return []
    }
    return [{ content: r.content, type: r.type, source: "assistant" }]
  })
}

// Compute cost via the Decimal idiom at session/index.ts:287-303. The
// model's cost info comes from the models snapshot (models-snapshot.js).
// For Gemini 2.5 Flash the spike validated $0.30/M both directions.
function cost_usd(tokens_in: number, tokens_out: number): number {
  return new Decimal(0)
    .add(new Decimal(tokens_in).mul(0.30).div(1_000_000))
    .add(new Decimal(tokens_out).mul(0.30).div(1_000_000))
    .toNumber()
}

function roll_day(): void {
  const today = new Date().toDateString()
  if (daily.day !== today) {
    daily.day = today
    daily.cost = 0
    daily.calls = 0
  }
}

// Single attempt — extracted so the retry loop in `extract`/`abstract` stays
// const-clean. The optional `filter` defaults to `filter_memories` (extract
// path); `abstract` passes `filter_abstracted` since abstraction output has
// no `source` field.
async function attempt(
  body: unknown,
  c: NonNullable<typeof cfg>,
  filter: (parsed: unknown) => ExtractedMemory[] = filter_memories,
): Promise<{ ok: true; memories: ExtractedMemory[] } | { ok: false }> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false }
    const data = await res.json() as any
    // OpenRouter chat API returns { choices: [{ message: { content: "..." } }] }
    // The content is a JSON string (JSON mode)
    const content = data.choices?.[0]?.message?.content
    if (!content) return { ok: false }
    const stripped = strip_fences(content)
    const parsed = JSON.parse(stripped)
    const m = (parsed as { memories?: unknown }).memories
    if (!Array.isArray(m)) return { ok: false }
    return { ok: true, memories: filter(m) }
  } catch {
    return { ok: false }
  }
}

// Shared call helper — opt-in/circuit/rate-limit/retry/cost-log/circuit-
// breaker accounting. `extract` passes the caller-supplied system prompt;
// `abstract` passes ABSTRACT_PROMPT + filter_abstracted. The filter
// difference is the only structural divergence between the two paths.
async function call(
  systemPrompt: string,
  userContent: string,
  filter: (parsed: unknown) => ExtractedMemory[] = filter_memories,
): Promise<{ memories: ExtractedMemory[]; skipped_reason?: string }> {
  const c = await resolve_cfg()

  // CC-10: OpenRouter only. No direct Gemini API, no proxy.
  if (c.provider !== "openrouter") {
    throw new Error(`Gemini provider requires openrouter, got: ${c.provider}`)
  }
  // req 8: opt-in false short-circuits before any external call.
  if (!c.external_opt_in) {
    log.debug("gemini.external_opt_in_false")
    return { memories: [], skipped_reason: "external_opt_in false" }
  }
  // req 20: circuit open returns immediately, no network call.
  if (is_open()) {
    log.warn("gemini.circuit_open_skipped", { consecutive })
    return { memories: [], skipped_reason: "circuit_open" }
  }
  // req 3: empty content produces no memories.
  if (!userContent || userContent.length === 0) {
    return { memories: [], skipped_reason: "empty_content" }
  }

  // Rate limit (req 23). opt-in true + circuit closed/half_open are the
  // only paths that consume a token. Queue overflow returns rate_limited.
  const got = await acquire()
  if (!got) {
    log.warn("gemini.rate_limited", { queue_depth: bucket.queue.length })
    return { memories: [], skipped_reason: "rate_limited" }
  }

  // Build the OpenRouter chat request (SC-5). JSON mode + temperature 0.
  const model = c.model || DEFAULT_MODEL
  // The model ID (e.g., "google/gemini-2.5-flash") is passed directly to the
  // OpenRouter chat API. parseModel would extract "google" as the provider,
  // but we're routing via OpenRouter — skip the parseModel check.
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  }

  const start = Date.now()
  // Retry loop: initial + RETRY_DELAYS_MS = 3 attempts (reqs 13-16).
  // const-clean: state held in a `const` object, iterated via for...of.
  const state = { memories: [] as ExtractedMemory[], succeeded: false, attempts: 0 }
  const delays = [0, ...RETRY_DELAYS_MS]
  for (const delay of delays) {
    state.attempts += 1
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    const r = await attempt(body, c, filter)
    if (r.ok) {
      state.memories = r.memories
      state.succeeded = true
      break
    }
  }

  const latency_ms = Date.now() - start

  // Circuit-breaker accounting (reqs 18-22).
  if (!state.succeeded) {
    record_failure()
    roll_day()
    daily.calls += 1
    log.warn("gemini.call_failed", {
      model,
      provider: "openrouter",
      tokens: { input: 0, output: 0 },
      latency_ms,
      cost_usd: 0,
      success: false,
      attempts: state.attempts,
    })
    return { memories: [], skipped_reason: "json_parse_failed" }
  }

  // Latency breach counts as a failure but the result is still returned (req 18).
  if (latency_ms > c.max_latency_ms) {
    record_failure()
  } else {
    record_success()
  }

  // Cost logging (CC-8). Log metadata only — no session content (CC-6).
  const tokens_in = 0
  const tokens_out = state.memories.length
  const cost = cost_usd(tokens_in, tokens_out)
  roll_day()
  daily.calls += 1
  daily.cost += cost
  log.info("gemini.call", {
    model,
    provider: "openrouter",
    tokens: { input: tokens_in, output: tokens_out },
    latency_ms,
    cost_usd: cost,
    success: true,
  })

  // Half-open probe succeeded → close the circuit (req 21).
  if (is_half_open()) {
    record_success()
    log.info("gemini.circuit_closed", { reason: "probe_success" })
  }

  return { memories: state.memories, skipped_reason: undefined }
}

export namespace Gemini {
  // extract: the single entry point per master SC-1. Returns memories + an
  // optional skipped_reason from the closed set (req 3). The pipeline
  // (sdd-04) treats skipped_reason as a soft skip, not an exception.
  export async function extract(systemPrompt: string, userContent: string): Promise<{ memories: ExtractedMemory[]; skipped_reason?: string }> {
    return call(systemPrompt, userContent)
  }

  // abstract: SDD-07 — Summarize the turn into self-contained memories
  // instead of extracting raw verbatim fragments. The small model assigns
  // memory_type in its JSON output, so the pipeline no longer needs a
  // separate Jev classify step. Same circuit breaker + rate limiter +
  // retry infrastructure as extract; only the system prompt and the
  // filter differ.
  export async function abstract(ctx: string): Promise<{ memories: ExtractedMemory[]; skipped_reason?: string }> {
    return call(ABSTRACT_PROMPT, ctx, filter_abstracted)
  }

  // metrics: 24h cost aggregate + current day. Read by /memory/metrics.
  export function metrics(): { daily_cost: number; daily_calls: number; day: string } {
    roll_day()
    return { daily_cost: daily.cost, daily_calls: daily.calls, day: daily.day }
  }
}
