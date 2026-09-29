/**
 * SDD-07 / Phase N — Gate-Abstract-Store Pipeline.
 *
 * The 4-stage orchestrator and SC-1 single entry point. Replaces SDD-04's
 * raw-fragment extract step with an abstraction step: the small model
 * summarizes the turn into self-contained memories that a future
 * independent session can use without seeing the original conversation.
 *
 * Stages:
 *   1. Gate     — Jev.noul on buffer context + current turn (calibrated probability)
 *   2. Abstract — Gemini.abstract on user text + LLM response + tool summary (JSON, temperature 0)
 *   3. Store    — Embedding.embedSafe + SurrealHypergraphBackend.store as MEMORY node
 *
 * The separate Jev.choice classify step from SDD-04 is removed — the
 * abstract output already includes the type in its JSON. Graceful
 * degradation: if abstract errors or returns empty, fall back to the
 * SDD-04 Gemini.extract path (source_path = "extraction").
 *
 * confidence lives in attributes (SC-1: NOT top-level NodeRecord fields).
 * Per spec #4, confidence = Jev's gate probability (enriches_future).
 *
 * Master: 260926_fbh-phase-n_sdd-00-master.md (SC-1, SC-2, CC-3, CC-6, CC-9).
 */
import { ulid } from "ulid"
import { Jev } from "../../provider/jev"
import { Gemini, type ExtractedMemory } from "../../provider/gemini"
import { Buffer } from "../capture/buffer"
import { Embedding } from "../embedding"
import { redact } from "../extraction/redact"
import { MemoryExtractor } from "../extraction/memory"
import { persistMemories } from "../extraction/persist"
import { getGlobalHypergraphBackend } from "../backend-registry"
import type { NodeRecord } from "../surreal-hypergraph-backend"
import { getConfig } from "../../config/bridge"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.classify.pipeline" })
const trace = process.env.FBH_MEM_TRACE === "1"
const tlog = (msg: string, fields?: any) => { if (trace) log.info(msg, fields) }

const GATE_INSTRUCTIONS =
  "Would this context, if recalled later, positively enrich a future LLM query?"
const GATE_CRITERIA = {
  true: "The context contains a memory-worthy signal — a preference, correction, decision, constraint, pattern, or useful working context that a future query would benefit from recalling.",
  false:
    "The context is routine — a mechanical tool call, an acknowledgment, or content with no durable value for future queries.",
}

const EXTRACT_PROMPT =
  "Extract specific memories from this conversation context. Each memory has a content (the memory text), a type (one of: preference, correction, decision, constraint, pattern, context, none), and a source (user or assistant). Return JSON: { memories: [{ content, type, source }], skipped_reason?: string }. Use 'none' for content with no durable value. Use 'context' for useful working context that isn't a durable fact (hypotheses, intermediate states, what was tried)."

const FALLBACK_EMBEDDING: Embedding.Config = {
  provider: "deepinfra",
  model: "BAAI/bge-base-en-v1.5",
  dimensions: 768,
  fallback: { provider: "ollama", model: "nomic-embed-text" },
}

export interface ClassifyInput {
  sessionID: string
  text: string
  project_id: string
  persona: string
  response?: string
  tools?: Array<{ name: string; status: string }>
}

export interface ClassifyResult {
  stored: number
  skipped: number
  errors: number
}

// Module-level circuit breaker (CC-9). consecutive counts Jev/Gemini
// failures; fallback_turns is the 2x backoff after the breaker trips.
// The breaker resets on the first successful Jev call.
const breaker = { consecutive: 0, fallback_turns: 0 }

interface Cfg {
  gate_threshold: number
  external_opt_in: boolean
  max_failures: number
  embedding: Embedding.Config
}

async function resolveCfg(): Promise<Cfg> {
  const c = await getConfig()
  const e = c?.memory?.extraction
  const emb = c?.memory?.embedding
  const embedding: Embedding.Config = emb
    ? {
        provider: emb.provider as "ollama" | "deepinfra" | "openai",
        model: emb.model,
        dimensions: emb.dimensions,
        fallback: emb.fallback ?? FALLBACK_EMBEDDING.fallback,
      }
    : FALLBACK_EMBEDDING
  return {
    gate_threshold: e?.gate_threshold ?? 0.5,
    external_opt_in: e?.external_opt_in ?? true,
    max_failures: e?.circuit_breaker?.max_consecutive_failures ?? 5,
    embedding,
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * classify — the SC-1 single entry point. Orchestrates gate → abstract →
 * store, then updates the circular buffer. Per-stage guards (W-23) ensure
 * a single stage failure doesn't abort the batch; exceptions are logged at
 * warn and swallowed. Never blocks the LLM response (CC-3 — the post-turn
 * hook dispatches via run.fork in SDD-05).
 */
export async function classify(input: ClassifyInput): Promise<ClassifyResult> {
  tlog("[MEM-TRACE] classify.entry", { sessionID: input.sessionID, textLen: input.text?.length ?? 0, responseLen: input.response?.length ?? 0, tools: input.tools?.length ?? 0, project_id: input.project_id })
  const cfg = await resolveCfg()

  // SC-2 / CC-6: external_opt_in gates all external LLM calls. When false,
  // no Jev or Gemini invocation — the turn is still buffered for future gates.
  if (!cfg.external_opt_in) {
    tlog("[MEM-TRACE] classify.opt_in_false", { sessionID: input.sessionID })
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return { stored: 0, skipped: 0, errors: 0 }
  }

  // CC-9: circuit breaker open → regex fallback for N turns (2x backoff).
  if (breaker.fallback_turns > 0) {
    tlog("[MEM-TRACE] classify.circuit_open", { sessionID: input.sessionID, fallback_turns: breaker.fallback_turns })
    breaker.fallback_turns -= 1
    const r = await regexFallback(input)
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return r
  }

  const out: ClassifyResult = { stored: 0, skipped: 0, errors: 0 }

  // Stage 1 — Gate (Jev Noul). State = buffer context + current turn, redacted.
  const ctx = Buffer.getContext(input.sessionID)
  const stateRaw = [ctx, input.text].filter(Boolean).join("\n")
  const { content: state } = redact(stateRaw)
  tlog("[MEM-TRACE] classify.gate_calling", { sessionID: input.sessionID, stateLen: state.length })

  let gateScore = 0
  try {
    gateScore = await Jev.noul(state, GATE_INSTRUCTIONS, GATE_CRITERIA)
    breaker.consecutive = 0
    tlog("[MEM-TRACE] classify.gate_result", { sessionID: input.sessionID, score: gateScore, threshold: cfg.gate_threshold })
  } catch (err) {
    breaker.consecutive += 1
    tlog("[MEM-TRACE] classify.gate_failed", { sessionID: input.sessionID, error: String(err), consecutive: breaker.consecutive })
    if (breaker.consecutive >= cfg.max_failures) {
      breaker.fallback_turns = cfg.max_failures * 2
      tlog("[MEM-TRACE] classify.circuit_opening", { sessionID: input.sessionID, fallback_turns: breaker.fallback_turns })
    }
    const r = await regexFallback(input)
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return r
  }

  // W-4: gate score <= threshold → skip Stage 2 + 3, no MEMORY node stored.
  if (gateScore <= cfg.gate_threshold) {
    tlog("[MEM-TRACE] classify.gate_skip", { sessionID: input.sessionID, score: gateScore, threshold: cfg.gate_threshold })
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return { stored: 0, skipped: 1, errors: 0 }
  }

  tlog("[MEM-TRACE] classify.gate_passed", { sessionID: input.sessionID, score: gateScore })

  // Stage 2 — Abstract (Gemini JSON, abstraction prompt). Construct a
  // context block containing the prior user turns (buffer arc), the current
  // user message, the LLM's response, and a tool summary. Truncate to 4000
  // chars. The abstract output is a self-contained summary with memory_type
  // assigned by the small model — no separate Jev.choice classify step.
  const ctxBlock = [
    `Prior user turns (context arc):`,
    Buffer.getContext(input.sessionID),
    ``,
    `Current user message:`,
    input.text,
    ``,
    `LLM response (this turn):`,
    input.response ?? "(no text response)",
    ``,
    `Tools used this turn:`,
    input.tools?.map((t) => `${t.name} → ${t.status}`).join(", ") ?? "(none)",
  ].join("\n").slice(0, 4000)
  const { content: payload } = redact(ctxBlock)

  let memories: ExtractedMemory[] = []
  let source_path = "abstraction"
  let abstractFailed = false
  try {
    tlog("[MEM-TRACE] classify.abstract_calling", { sessionID: input.sessionID, payloadLen: payload.length })
    const result = await Gemini.abstract(payload)
    memories = result.memories
    tlog("[MEM-TRACE] classify.abstract_result", { sessionID: input.sessionID, memories: memories.length, reason: result.skipped_reason })
    if (memories.length === 0) {
      tlog("[MEM-TRACE] classify.abstract_empty", { sessionID: input.sessionID, reason: result.skipped_reason })
    }
  } catch (err) {
    tlog("[MEM-TRACE] classify.abstract_failed", { sessionID: input.sessionID, error: String(err) })
    abstractFailed = true
  }

  // Graceful degradation (spec #6): if abstract errors OR returns empty,
  // fall back to the SDD-04 Gemini.extract path (verbatim fragments).
  if (abstractFailed || memories.length === 0) {
    tlog("[MEM-TRACE] classify.fallback_extract", { sessionID: input.sessionID, abstractFailed, memories: memories.length })
    try {
      const result = await Gemini.extract(EXTRACT_PROMPT, payload)
      memories = result.memories
      source_path = "extraction"
      tlog("[MEM-TRACE] classify.extract_result", { sessionID: input.sessionID, memories: memories.length, source_path })
      if (result.skipped_reason) {
        tlog("[MEM-TRACE] classify.extract_skip", { sessionID: input.sessionID, reason: result.skipped_reason })
      }
    } catch (err) {
      tlog("[MEM-TRACE] classify.extract_failed", { sessionID: input.sessionID, error: String(err) })
      const r = await regexFallback(input)
      Buffer.add(input.sessionID, { text: input.text, role: "user" })
      return r
    }
  }

  // W-8: empty memories from both paths → skip Stage 3.
  if (memories.length === 0) {
    tlog("[MEM-TRACE] classify.no_memories", { sessionID: input.sessionID })
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return { stored: 0, skipped: 1, errors: 0 }
  }

  // Stage 3 — Store.
  const backend = getGlobalHypergraphBackend()
  if (!backend || !backend.healthy()) {
    tlog("[MEM-TRACE] classify.backend_unhealthy", { sessionID: input.sessionID, backend: !!backend, healthy: backend?.healthy() })
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return { stored: 0, skipped: 0, errors: 1 }
  }
  tlog("[MEM-TRACE] classify.storing", { sessionID: input.sessionID, memories: memories.length, source_path })

  for (const frag of memories) {
    // W-11: type "none" → skip this fragment, no MEMORY node stored.
    if (frag.type === "none") {
      log.debug("classify.fragment_skip_none")
      out.skipped += 1
      continue
    }

    // Embed + SurrealHypergraphBackend.store as MEMORY node.
    // W-16: embedding failure → store with embedding = null (keyword fallback).
    // Per spec #4: confidence = Jev's gate probability (enriches_future).
    let embedding: Float32Array | null = null
    try {
      const emb = await Embedding.embedSafe(frag.content, cfg.embedding)
      if (emb.ok) embedding = emb.value
      else log.warn("classify.embed_failed", { error: emb.error.message })
    } catch (err) {
      log.warn("classify.embed_failed", { error: String(err) })
    }

    const now = nowSec()
    const node: NodeRecord = {
      node_id: ulid(),
      node_type: "MEMORY",
      created_at: now,
      updated_at: now,
      version: 1,
      status: "ACTIVE",
      embedding,
      attributes: {
        memory_type: frag.type,
        content: frag.content,
        source_nodes: [],
        usage_count: 0,
        last_used: now,
        contradiction_count: 0,
        downstream_gain: 0,
        project_id: input.project_id,
        session_id: input.sessionID,
        persona: input.persona,
        confidence: gateScore,
        source_path,
      },
      valid_from: now,
      valid_to: Infinity,
      tx_from: now,
      tx_to: Infinity,
      prev_version_id: null,
      invalidated_by: null,
    }

    try {
      await backend.store(node)
      out.stored += 1
      tlog("[MEM-TRACE] classify.stored_one", { sessionID: input.sessionID, type: frag.type, content: frag.content.slice(0, 80) })
    } catch (err) {
      tlog("[MEM-TRACE] classify.store_failed", { sessionID: input.sessionID, error: String(err) })
      out.errors += 1
    }
  }

  // Step 6 (SC-1): record the current turn in the buffer for future gates.
  Buffer.add(input.sessionID, { text: input.text, role: "user" })
  tlog("[MEM-TRACE] classify.complete", { sessionID: input.sessionID, stored: out.stored, skipped: out.skipped, errors: out.errors })
  return out
}

// Regex fallback (CC-9, W-5, W-9). extractRegex + persistMemories (Phase M
// path). Used when the gate Jev call fails or Gemini extraction fails. The
// caller records the current turn in the buffer after this returns.
async function regexFallback(input: ClassifyInput): Promise<ClassifyResult> {
  try {
    const records = MemoryExtractor.extractRegex(input.text)
    if (records.length === 0) return { stored: 0, skipped: 1, errors: 0 }
    const written = await persistMemories(records, {
      sessionID: input.sessionID,
      project_id: input.project_id,
      persona: input.persona,
    })
    return { stored: written, skipped: 0, errors: 0 }
  } catch (err) {
    log.warn("classify.regex_fallback_failed", { error: String(err) })
    return { stored: 0, skipped: 0, errors: 1 }
  }
}
