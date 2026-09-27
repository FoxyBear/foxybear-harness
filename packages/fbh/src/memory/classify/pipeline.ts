/**
 * SDD-04 / Phase N — Gate-Extract-Classify Pipeline.
 *
 * The 4-stage orchestrator and SC-1 single entry point. Replaces the Phase M
 * stub `extractViaLLM` with a real classification: Jev gate → Gemini extract
 * → Jev classify → embed + SurrealHypergraphBackend.store. The pipeline owns
 * the store step — neither the capture hook (SDD-05) nor re-backfill (SDD-06)
 * call SurrealHypergraphBackend.store directly for extracted memories.
 *
 * Stages:
 *   1. Gate    — Jev.noul on buffer context + current turn (calibrated probability)
 *   2. Extract — Gemini.extract on the redacted full context (JSON, temperature 0)
 *   3. Classify — Jev.choice per fragment over the 7-type map (SC-4)
 *   4. Store   — Embedding.embedSafe + SurrealHypergraphBackend.store as MEMORY node
 *
 * confidence and source_path live in attributes (SC-1: NOT top-level NodeRecord
 * fields). Initial confidence is 0.7 for all extracted memories (W-20).
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

// W-20 / W-21: initial confidence for all extracted memories. Gemini
// extraction is deterministic-quality; the gate+classify chain is calibrated.
// Lives in attributes.confidence, NOT as a top-level NodeRecord field.
const CLASSIFY_CONFIDENCE = 0.7

const GATE_INSTRUCTIONS =
  "Would this context, if recalled later, positively enrich a future LLM query?"
const GATE_CRITERIA = {
  true: "The context contains a memory-worthy signal — a preference, correction, decision, constraint, pattern, or useful working context that a future query would benefit from recalling.",
  false:
    "The context is routine — a mechanical tool call, an acknowledgment, or content with no durable value for future queries.",
}

const EXTRACT_PROMPT =
  "Extract specific memories from this conversation context. Each memory has a content (the memory text), a type (one of: preference, correction, decision, constraint, pattern, context, none), and a source (user or assistant). Return JSON: { memories: [{ content, type, source }], skipped_reason?: string }. Use 'none' for content with no durable value. Use 'context' for useful working context that isn't a durable fact (hypotheses, intermediate states, what was tried)."

const CLASSIFY_INSTRUCTIONS = "What type of memory is this?"
const CLASSIFY_CRITERIA = {
  preference: "User expresses a preference or liking.",
  correction: "User corrects a previous statement, approach, or belief.",
  decision: "User makes a decision or choice that persists.",
  constraint: "User states a constraint, limitation, or boundary.",
  pattern: "User describes a recurring behavior or workflow.",
  context:
    "Useful working context — intermediate state, hypothesis, what was tried (not a durable fact but would help future queries).",
  none: "No useful context for future queries.",
}

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
 * classify — the SC-1 single entry point. Orchestrates gate → extract →
 * classify → store, then updates the circular buffer. Per-stage guards
 * (W-23) ensure a single stage failure doesn't abort the batch; exceptions
 * are logged at warn and swallowed. Never blocks the LLM response (CC-3 —
 * the post-turn hook dispatches via run.fork in SDD-05).
 */
export async function classify(input: ClassifyInput): Promise<ClassifyResult> {
  const cfg = await resolveCfg()

  // SC-2 / CC-6: external_opt_in gates all external LLM calls. When false,
  // no Jev or Gemini invocation — the turn is still buffered for future gates.
  if (!cfg.external_opt_in) {
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return { stored: 0, skipped: 0, errors: 0 }
  }

  // CC-9: circuit breaker open → regex fallback for N turns (2x backoff).
  if (breaker.fallback_turns > 0) {
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

  let gateScore = 0
  try {
    gateScore = await Jev.noul(state, GATE_INSTRUCTIONS, GATE_CRITERIA)
    breaker.consecutive = 0
    log.debug("classify.gate", { score: gateScore, threshold: cfg.gate_threshold })
  } catch (err) {
    breaker.consecutive += 1
    log.warn("classify.gate_failed", { error: String(err), consecutive: breaker.consecutive })
    if (breaker.consecutive >= cfg.max_failures) {
      breaker.fallback_turns = cfg.max_failures * 2
      log.warn("classify.circuit_open", { fallback_turns: breaker.fallback_turns })
    }
    // W-5: fall back to regex for this turn; subsequent turns continue through gate.
    const r = await regexFallback(input)
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return r
  }

  // W-4: gate score <= threshold → skip Stage 2 + 3, no MEMORY node stored.
  if (gateScore <= cfg.gate_threshold) {
    log.debug("classify.gate_skip", { score: gateScore, threshold: cfg.gate_threshold })
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return { stored: 0, skipped: 1, errors: 0 }
  }

  // Stage 2 — Extract (Gemini JSON). Payload is the same context, redacted (W-18).
  const { content: payload } = redact(stateRaw)
  let memories: ExtractedMemory[] = []
  let extractSkip = false
  try {
    const result = await Gemini.extract(EXTRACT_PROMPT, payload)
    memories = result.memories
    if (result.skipped_reason) {
      extractSkip = true
      log.debug("classify.extract_skip", { reason: result.skipped_reason })
    }
  } catch (err) {
    // W-9: Gemini failure → regex fallback; pipeline does NOT abort.
    log.warn("classify.extract_failed", { error: String(err) })
    const r = await regexFallback(input)
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return r
  }

  // W-8: empty memories or skipped_reason → skip Stage 3 + 4.
  if (extractSkip || memories.length === 0) {
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return { stored: 0, skipped: 1, errors: 0 }
  }

  // Stage 3+4 — Classify + Store, per fragment. The backend is resolved once;
  // if null/unhealthy, the pipeline skips store and returns errors: 1.
  const backend = getGlobalHypergraphBackend()
  if (!backend || !backend.healthy()) {
    log.warn("classify.backend_unhealthy")
    Buffer.add(input.sessionID, { text: input.text, role: "user" })
    return { stored: 0, skipped: 0, errors: 1 }
  }

  for (const frag of memories) {
    // Stage 3 — Classify (Jev Choice). The Jev choice is authoritative for
    // memory_type (W-12) — it overrides the Gemini-returned type from Stage 2.
    let type = ""
    try {
      const choice = await Jev.choice(frag.content, CLASSIFY_INSTRUCTIONS, CLASSIFY_CRITERIA)
      type = choice.choice
    } catch (err) {
      // W-13: single fragment classify failure does NOT abort the batch.
      log.warn("classify.classify_failed", { error: String(err) })
      out.errors += 1
      continue
    }

    // W-11: type "none" → skip this fragment, no MEMORY node stored.
    if (type === "none") {
      log.debug("classify.fragment_skip_none")
      out.skipped += 1
      continue
    }

    // Stage 4 — Store. Embed + SurrealHypergraphBackend.store as MEMORY node.
    // W-16: embedding failure → store with embedding = null (keyword fallback).
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
        memory_type: type,
        content: frag.content,
        source_nodes: [],
        usage_count: 0,
        last_used: now,
        contradiction_count: 0,
        downstream_gain: 0,
        project_id: input.project_id,
        session_id: input.sessionID,
        persona: input.persona,
        confidence: CLASSIFY_CONFIDENCE,
        source_path: "llm",
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
    } catch (err) {
      log.warn("classify.store_failed", { error: String(err) })
      out.errors += 1
    }
  }

  // Step 6 (SC-1): record the current turn in the buffer for future gates.
  Buffer.add(input.sessionID, { text: input.text, role: "user" })
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
