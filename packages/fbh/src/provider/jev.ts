/**
 * SDD-01 / Phase N — Jev Provider Adapter.
 *
 * Wires OpenRouter's alpha/decisions API (model typesafe/jev-1.13) into fbh
 * as a typed-decision adapter exposing `noul`, `choice`, `score` on a `Jev`
 * namespace. Jev is NOT a chat model — it cannot generate text — so it does
 * not extend LanguageModelV3 and does not fit Provider.getLanguage. It is a
 * sibling adapter, not a slot in the existing provider registry.
 *
 * Owns: the wire, the config plumbing (memory.extraction.layer1), the rate
 * limit (10 req/sec, CC-5), the circuit breaker (CC-9), and the cost log
 * (CC-8). Does NOT own the gate logic, the classify logic, or the pipeline
 * composition — those are sdd-04.
 *
 * Master: 260926_fbh-phase-n_sdd-00-master.md (SC-1, SC-2, SC-5).
 */
import z from "zod"
import { NamedError } from "@foxybear/util/error"
import { Log } from "../util/log"
import { getConfig } from "../config/bridge"

const log = Log.create({ service: "provider.jev" })

const ENDPOINT = process.env.FBH_JEV_ENDPOINT ?? "https://openrouter.ai/api/alpha/decisions"

const RATE_PER_SEC = 10
const RATE_CAPACITY = 10
const RATE_TIMEOUT_MS = 5000
const WINDOW_MAX = 100
const CALL_LOG_MAX = 10_000
const COOLDOWN_MS = 60_000
const COST_PER_M = 0.042

// Token bucket (CC-5: 10 req/sec). Module-level singleton, shared across
// gate + classify calls (the spike cost model assumed ~3 calls/turn).
const bucket = {
  tokens: RATE_CAPACITY,
  last: Date.now(),
}

async function acquire(): Promise<void> {
  const now = Date.now()
  const elapsed = now - bucket.last
  const refilled = Math.min(RATE_CAPACITY, bucket.tokens + (elapsed * RATE_PER_SEC) / 1000)
  bucket.tokens = refilled
  bucket.last = now
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return
  }
  const wait_ms = ((1 - bucket.tokens) / RATE_PER_SEC) * 1000
  if (wait_ms > RATE_TIMEOUT_MS) {
    throw new JevRateLimitedError({ wait_ms })
  }
  await new Promise((r) => setTimeout(r, wait_ms))
  return acquire()
}

// Circuit breaker (CC-9). Sliding window of last WINDOW_MAX calls + a
// closed/open/half_open state machine.
const breaker = {
  state: "closed" as "closed" | "open" | "half_open",
  consecutive_slow: 0,
  cooldown_until: 0,
  window: [] as Array<{ latency_ms: number; success: boolean; error_kind?: string }>,
}

function record(latency_ms: number, success: boolean, error_kind?: string): void {
  breaker.window.push({ latency_ms, success, error_kind })
  if (breaker.window.length > WINDOW_MAX) breaker.window.shift()

  if (breaker.state === "half_open") {
    if (success && latency_ms <= breaker_max_latency()) {
      transition("half_open", "closed", "probe_success")
      breaker.consecutive_slow = 0
    } else {
      transition("half_open", "open", "probe_failed")
      breaker.cooldown_until = Date.now() + COOLDOWN_MS
    }
    return
  }

  if (breaker.state === "closed") {
    if (latency_ms > breaker_max_latency()) {
      breaker.consecutive_slow += 1
    } else {
      breaker.consecutive_slow = 0
    }
    if (breaker.consecutive_slow >= breaker_max_failures()) {
      transition("closed", "open", "latency")
      breaker.cooldown_until = Date.now() + COOLDOWN_MS
      log.warn("jev.circuit_open", {
        reason: "latency",
        consecutive_slow: breaker.consecutive_slow,
        max_latency_ms: breaker_max_latency(),
      })
      return
    }
    const failed = breaker.window.filter((c) => !c.success).length
    const error_rate_pct = (failed / breaker.window.length) * 100
    if (breaker.window.length >= 20 && error_rate_pct > breaker_max_error_rate()) {
      transition("closed", "open", "error_rate")
      breaker.cooldown_until = Date.now() + COOLDOWN_MS
      log.warn("jev.circuit_open", {
        reason: "error_rate",
        error_rate_pct,
        window_size: breaker.window.length,
      })
    }
  }
}

function transition(from: "closed" | "open" | "half_open", to: "closed" | "open" | "half_open", reason: string): void {
  if (breaker.state === from) {
    breaker.state = to
    log.info("jev.circuit_transition", { from, to, reason })
  }
}

function check(): void {
  if (breaker.state === "open") {
    if (Date.now() < breaker.cooldown_until) {
      throw new JevCircuitOpenError({ state: "open", reason: "cooldown" })
    }
    transition("open", "half_open", "cooldown_elapsed")
  }
}

// Cost log (CC-8). Ring buffer of the last CALL_LOG_MAX calls.
const call_log: Array<{
  ts: number
  model: string
  question: string
  latency_ms: number
  tokens_in: number
  tokens_out: number
  cost_usd: number
  success: boolean
}> = []

function push_call(entry: (typeof call_log)[number]): void {
  call_log.push(entry)
  if (call_log.length > CALL_LOG_MAX) call_log.shift()
}

// Config reader — reads memory.extraction.layer1 + circuit_breaker on each
// call. Resolves {file:...} substitution for api_key (the default value uses
// this pattern but the zod default bypasses the config loader's substitution).
async function resolve_layer1(): Promise<{ provider: string; model: string; api_key: string }> {
  const cfg = await getConfig()
  const layer1 = cfg?.memory?.extraction?.layer1
  let apiKey = layer1?.api_key ?? ""
  if (apiKey.startsWith("{file:")) {
    const filePath = apiKey.replace(/^\{file:/, "").replace(/\}$/, "")
    try { apiKey = (await Bun.file(filePath).text()).trim() } catch {}
  }
  return {
    provider: layer1?.provider ?? "openrouter",
    model: layer1?.model ?? "typesafe/jev-1.13",
    api_key: apiKey,
  }
}

async function resolve_breaker(): Promise<{
  max_latency_ms: number
  max_consecutive_failures: number
  max_error_rate_pct: number
}> {
  const cfg = await getConfig()
  const cb = cfg?.memory?.extraction?.circuit_breaker
  return {
    max_latency_ms: cb?.max_latency_ms ?? 3000,
    max_consecutive_failures: cb?.max_consecutive_failures ?? 5,
    max_error_rate_pct: cb?.max_error_rate_pct ?? 5,
  }
}

// Breaker config is read async; the breaker record/check helpers need
// synchronous access. We cache the last-resolved values on first call.
let breaker_cfg: { max_latency_ms: number; max_consecutive_failures: number; max_error_rate_pct: number } | null = null

function breaker_max_latency(): number {
  return breaker_cfg?.max_latency_ms ?? 3000
}

function breaker_max_failures(): number {
  return breaker_cfg?.max_consecutive_failures ?? 5
}

function breaker_max_error_rate(): number {
  return breaker_cfg?.max_error_rate_pct ?? 5
}

// The shared call helper. All three public methods go through here.
async function call(
  question: string,
  kind: "noul" | "choice" | "score",
  state: string,
  instructions: string,
  criteria: unknown,
): Promise<unknown> {
  const cfg = await resolve_layer1()
  if (!breaker_cfg) breaker_cfg = await resolve_breaker()

  if (cfg.provider !== "openrouter") {
    throw new JevConfigError({ field: "memory.extraction.layer1.provider", value: cfg.provider })
  }
  if (!cfg.api_key) {
    throw new JevConfigError({ field: "memory.extraction.layer1.api_key" })
  }

  check()
  await acquire()

  const start = performance.now()
  let latency_ms = 0
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        state,
        questions: { [question]: { type: kind, instructions, criteria } },
      }),
    })
    latency_ms = performance.now() - start

    if (res.status === 429) {
      log.warn("jev.http_429", { question, status: 429 })
      record(latency_ms, false, "http")
      push_call({ ts: Date.now(), model: cfg.model, question, latency_ms, tokens_in: 0, tokens_out: 0, cost_usd: 0, success: false })
      log.warn("jev.call_failed", { model: cfg.model, question, latency_ms, error_kind: "http", error_status: 429 })
      throw new JevHttpError({ status: 429, body: "", question })
    }
    if (res.status >= 400) {
      const body = await res.text()
      record(latency_ms, false, "http")
      push_call({ ts: Date.now(), model: cfg.model, question, latency_ms, tokens_in: 0, tokens_out: 0, cost_usd: 0, success: false })
      log.warn("jev.call_failed", { model: cfg.model, question, latency_ms, error_kind: "http", error_status: res.status })
      throw new JevHttpError({ status: res.status, body, question })
    }

    const body = await res.json()
    const parsed = safe_parse(body, question)
    if (!parsed.ok) {
      record(latency_ms, false, "schema")
      push_call({ ts: Date.now(), model: cfg.model, question, latency_ms, tokens_in: 0, tokens_out: 0, cost_usd: 0, success: false })
      log.warn("jev.call_failed", { model: cfg.model, question, latency_ms, error_kind: "schema", error_status: 0 })
      throw new JevSchemaError({ question, body: JSON.stringify(body) })
    }

    const usage = (body as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    const tokens_in = usage?.prompt_tokens ?? 0
    const tokens_out = usage?.completion_tokens ?? 0
    const cost_usd = ((tokens_in + tokens_out) / 1_000_000) * COST_PER_M
    record(latency_ms, true)
    push_call({ ts: Date.now(), model: cfg.model, question, latency_ms, tokens_in, tokens_out, cost_usd, success: true })
    log.info("jev.call", { model: cfg.model, question, latency_ms, tokens_in, tokens_out, cost_usd })
    return parsed.value
  } catch (err) {
    if (err instanceof JevHttpError || err instanceof JevSchemaError || err instanceof JevCircuitOpenError || err instanceof JevRateLimitedError || err instanceof JevConfigError) {
      throw err
    }
    latency_ms = performance.now() - start
    record(latency_ms, false, "network")
    push_call({ ts: Date.now(), model: cfg.model, question, latency_ms, tokens_in: 0, tokens_out: 0, cost_usd: 0, success: false })
    log.warn("jev.call_failed", { model: cfg.model, question, latency_ms, error_kind: "network", error_status: 0 })
    throw new JevHttpError({ status: 0, body: String(err), question })
  }
}

// Parse + validate the OpenRouter decisions response.
// The API returns: { answers: { [question]: { noul: number } | { choice: string; probabilities: Record<string, number> } | { score: number } } }
function safe_parse(body: unknown, question: string): { ok: true; value: unknown } | { ok: false } {
  if (typeof body !== "object" || body === null) return { ok: false }
  // The API returns "answers" (confirmed from live demos), not "decisions"
  const answers = (body as { answers?: unknown }).answers ?? (body as { decisions?: unknown }).decisions
  if (typeof answers !== "object" || answers === null) return { ok: false }
  const q = (answers as Record<string, unknown>)[question]
  if (typeof q !== "object" || q === null) return { ok: false }
  return { ok: true, value: q }
}

// Error types via NamedError.create (provider.ts:1779 idiom).
export const JevHttpError = NamedError.create(
  "JevHttpError",
  z.object({
    status: z.number(),
    body: z.string(),
    question: z.string(),
  }),
)

export const JevSchemaError = NamedError.create(
  "JevSchemaError",
  z.object({
    question: z.string(),
    body: z.string(),
  }),
)

export const JevConfigError = NamedError.create(
  "JevConfigError",
  z.object({
    field: z.string(),
    value: z.string().optional(),
  }),
)

export const JevCircuitOpenError = NamedError.create(
  "JevCircuitOpenError",
  z.object({
    state: z.literal("open"),
    reason: z.string(),
  }),
)

export const JevRateLimitedError = NamedError.create(
  "JevRateLimitedError",
  z.object({
    wait_ms: z.number(),
  }),
)

export namespace Jev {
  // noul: binary calibrated probability in [0, 1].
  export async function noul(
    state: string,
    instructions: string,
    criteria: { true: string; false: string },
  ): Promise<number> {
    const q = await call("q", "noul", state, instructions, criteria)
    // The API returns { noul: number } (confirmed from live demos)
    const p = (q as { noul?: number }).noul ?? (q as { probability?: number }).probability
    if (typeof p !== "number") throw new JevSchemaError({ question: "q", body: JSON.stringify(q) })
    return p
  }

  // choice: multi-class. Returns the highest-probability class + the full
  // probability map. The adapter does NOT normalize — Jev's calibration
  // guarantee is sum 1.0 ± 0.001; if it drifts, we log and return raw.
  export async function choice(
    state: string,
    instructions: string,
    criteria: Record<string, string>,
  ): Promise<{ choice: string; probabilities: Record<string, number> }> {
    const q = await call("q", "choice", state, instructions, criteria)
    const d = q as { choice?: string; probabilities?: Record<string, number> }
    if (typeof d.choice !== "string" || !d.probabilities) {
      throw new JevSchemaError({ question: "q", body: JSON.stringify(q) })
    }
    const sum = Object.values(d.probabilities).reduce((a, b) => a + b, 0)
    if (Math.abs(sum - 1.0) > 0.001) {
      log.warn("jev.calibration_drift", { sum })
    }
    return { choice: d.choice, probabilities: d.probabilities }
  }

  // score: ordinal on the scale defined by criteria anchors.
  export async function score(state: string, instructions: string, criteria: string[]): Promise<number> {
    const q = await call("q", "score", state, instructions, criteria)
    const s = (q as { score?: number }).score
    if (typeof s !== "number") throw new JevSchemaError({ question: "q", body: JSON.stringify(q) })
    return s
  }

  // metrics: 24h aggregate + current breaker state. Read by /memory/metrics.
  export function metrics(): {
    calls_24h: number
    tokens_in_24h: number
    tokens_out_24h: number
    cost_usd_24h: number
    error_rate_pct: number
    circuit_state: "closed" | "open" | "half_open"
  } {
    const cutoff = Date.now() - 86_400_000
    const recent = call_log.filter((c) => c.ts > cutoff)
    const calls_24h = recent.length
    const tokens_in_24h = recent.reduce((a, c) => a + c.tokens_in, 0)
    const tokens_out_24h = recent.reduce((a, c) => a + c.tokens_out, 0)
    const cost_usd_24h = recent.reduce((a, c) => a + c.cost_usd, 0)
    const failed = recent.filter((c) => !c.success).length
    const error_rate_pct = calls_24h === 0 ? 0 : (failed / calls_24h) * 100
    return {
      calls_24h,
      tokens_in_24h,
      tokens_out_24h,
      cost_usd_24h,
      error_rate_pct,
      circuit_state: breaker.state,
    }
  }
}
