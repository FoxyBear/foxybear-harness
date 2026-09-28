/**
 * SDD-09 / Phase M-5 — ConflictDetector.check (SC-5).
 *
 * Save-time conflict detection wired into Memory.store (memory.ts:263
 * storeImpl). Computes the embedding of the new content, finds the top
 * live MEMORY neighbor in the same project_id (MOSAIC-style save-time
 * cross-reference), scores contradiction by cosine similarity against
 * the new embedding, and returns one of:
 *
 *   ADD    — no contradiction: no neighbors, or cosine >= cosine_threshold
 *            (complement/near-dup, falls through to existing dedup)
 *   UPDATE — cosine < cosine_threshold and >= delete_threshold
 *            (contradicts but same topic; rewrite the old)
 *   DELETE — cosine < delete_threshold
 *            (strongly contradicts; bi-temporal soft-delete the old)
 *
 * Threshold defaults (SC-6):
 *   cosine_threshold = 0.3 (calibrated to 0.20 by the M-6 conflict-tune
 *                            sweep — selected.value = 0.2 on the
 *                            contradiction-20 fixture; see
 *                            ~/.local/share/foxybear/bench/*-conflict-tune.json)
 *   delete_threshold = 0.1 (semantically distinct from
 *                          memory.decay.archived_threshold — req 27)
 *   llm_verify       = false
 *
 * When llm_verify=true, a binary LLM prompt ("Does the new content
 * contradict the old? yes/no") is invoked between the threshold
 * classification and the verdict return. The LLM's verdict overrides
 * toward ADD only (LLM says "no contradiction" → ADD regardless of
 * cosine). The LLM SHALL NOT override toward UPDATE or DELETE (cosine
 * remains the authority for those — req 12).
 *
 * LLM-unavailable fallback (req 12): when llm_verify=true but the LLM
 * call cannot complete (network error, missing keys, malformed response,
 * SDD-05 fell back to regex-only with no LLM client wired, model endpoint
 * unreachable), check SHALL fall back to verdict ADD (no destructive
 * UPDATE or DELETE without verification), log a warning, and the store
 * call SHALL NOT crash. This ensures a transient LLM outage does not
 * corrupt the graph by triggering destructive verdicts on unverified
 * cosine scores, at the cost of a duplicate ADD that a future store call
 * (with LLM available) can reconcile.
 *
 * Reuses:
 *   - Embedding.embedSafe (memory.ts:238 getEmbedding pattern)
 *   - SurrealHypergraphBackend.findMemoryNeighbor (cosine ORDER BY,
 *     scoped by project_id per surreal-backend.ts:208-212)
 *   - localize (HiGram path localization, reqs 13-15)
 *
 * Cross-project isolation (reqs 22-24): neighbor lookup is scoped to
 * project_id = $pid OR project_id = "global" OR project_id = "". A
 * stale-index violation (node with a different non-global project_id
 * returned) is excluded TS-side with a warning, and the store call does
 * not crash (req 24).
 */
import { Effect, Layer, Context } from "effect"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { homedir } from "os"
import { Embedding } from "../embedding"
import { getGlobalHypergraphBackend } from "../backend-registry"
import { getConfig } from "../../config/bridge"
import { Log } from "../../util/log"
import { localize, type Subgraph } from "./localize"

const log = Log.create({ service: "memory.conflict" })

export type Verdict = "ADD" | "UPDATE" | "DELETE"

export interface CheckResult {
  verdict: Verdict
  target?: string
  subgraph?: Subgraph
}

// Defaults per SC-6. The M-6 conflict-tune sweep calibrated cosine_threshold
// to 0.20 (down from the spec default 0.30) — selected.value = 0.2, f1 = 0.67
// on the contradiction-20 fixture. The calibrated value is consumed from
// config (memory.conflict.cosine_threshold) when present; this default is
// the fallback when config is unavailable.
const DEFAULT_COSINE_THRESHOLD = 0.3
const DEFAULT_DELETE_THRESHOLD = 0.1
const DEFAULT_LLM_VERIFY = false

interface ConflictConfig {
  cosine_threshold: number
  delete_threshold: number
  llm_verify: boolean
}

// Reads memory.conflict.cosine_threshold, memory.conflict.delete_threshold,
// memory.conflict.llm_verify from fbh.json (SC-6, CC-6). Falls back to
// defaults when config is unavailable.
async function resolveConfig(): Promise<ConflictConfig> {
  try {
    const cfg = await getConfig()
    const c = cfg.memory?.conflict
    return {
      cosine_threshold: c?.cosine_threshold ?? DEFAULT_COSINE_THRESHOLD,
      delete_threshold: c?.delete_threshold ?? DEFAULT_DELETE_THRESHOLD,
      llm_verify: c?.llm_verify ?? DEFAULT_LLM_VERIFY,
    }
  } catch {
    return {
      cosine_threshold: DEFAULT_COSINE_THRESHOLD,
      delete_threshold: DEFAULT_DELETE_THRESHOLD,
      llm_verify: DEFAULT_LLM_VERIFY,
    }
  }
}

// Reuse the getEmbedding pattern from memory.ts:238. Computes the embedding
// of the new content for neighbor lookup. Returns null when embedding is
// unavailable (check falls back to ADD).
async function embed(text: string): Promise<Float32Array | null> {
  try {
    const cfg = await getConfig()
    const mem = cfg.memory
    const embeddingConfig: Embedding.Config = mem?.embedding
      ? {
          provider: mem.embedding.provider as "ollama" | "deepinfra" | "openai",
          model: mem.embedding.model,
          dimensions: mem.embedding.dimensions,
          fallback: mem.embedding.fallback,
        }
      : {
          provider: "deepinfra",
          model: "BAAI/bge-base-en-v1.5",
          dimensions: 768,
        }
    const result = await Embedding.embedSafe(text, embeddingConfig)
    if (!result.ok) {
      log.warn("conflict: embedding unavailable, defaulting to ADD")
      return null
    }
    return result.value
  } catch {
    log.warn("conflict: embedding config unavailable, defaulting to ADD")
    return null
  }
}

// MOSAIC neighbor lookup: top live MEMORY node by cosine, scoped to
// project_id. Cross-project isolation guard (req 24) excludes stale-index
// violations TS-side with a warning.
async function findNeighbor(
  embedding: Float32Array,
  project_id: string,
): Promise<{ node_id: string; cosine: number; content: string; version: number } | null> {
  const backend = getGlobalHypergraphBackend()
  if (!backend) return null
  const raw = await backend.findMemoryNeighbor(embedding, project_id)
  if (!raw) return null
  // Cross-project isolation guard (req 24): exclude stale-index violations.
  const pid = String(raw.project_id ?? "")
  if (project_id && pid && pid !== project_id && pid !== "global") {
    log.warn("conflict: cross-project isolation violation excluded", {
      requested: project_id,
      returned: pid,
    })
    return null
  }
  return { node_id: raw.node_id, cosine: raw.cosine, content: raw.content, version: raw.version }
}

// LLM verify (binary): "Does the new content contradict the old? yes/no".
// Override toward ADD only when LLM says "no". Returns "unavailable" on
// network error, missing keys, or malformed response — caller falls back
// to ADD (req 12). Reuses the extraction LLM (memory.extraction.model,
// default deepinfra/Qwen/Qwen2.5-7B-Instruct per SDD-05).
async function verify(old_content: string, new_content: string): Promise<"yes" | "no" | "unavailable"> {
  try {
    const cfg = await getConfig()
    const model = cfg.memory?.extraction?.model
    if (!model) return "unavailable"
    const { Provider } = await import("../../provider/provider")
    const parsed = Provider.parseModel(model)
    const providerID = String(parsed.providerID)
    const modelID = String(parsed.modelID)
    if (!providerID || !modelID) return "unavailable"

    const key = resolveApiKey(providerID)
    if (!key) return "unavailable"

    const baseUrl = providerID === "deepinfra"
      ? "https://api.deepinfra.com/v1/chat/completions"
      : providerID === "openai"
        ? "https://api.openai.com/v1/chat/completions"
        : null
    if (!baseUrl) return "unavailable"

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: modelID,
          messages: [
            {
              role: "system",
              content: "Reply with one word: YES or NO.",
            },
            {
              role: "user",
              content: `Old: ${old_content}\nNew: ${new_content}\n\nDoes the new content contradict the old? Reply YES or NO.`,
            },
          ],
          temperature: 0,
          max_tokens: 8,
        }),
      })
      if (!res.ok) return "unavailable"
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const text = String(data.choices?.[0]?.message?.content ?? "").trim().toUpperCase()
      if (text.startsWith("NO")) return "no"
      if (text.startsWith("YES")) return "yes"
      return "unavailable"
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    log.warn("conflict: llm_verify call failed", { error: String(err) })
    return "unavailable"
  }
}

function resolveApiKey(provider: string): string {
  const envVar = `${provider.toUpperCase()}_API_KEY`
  if (process.env[envVar]) return process.env[envVar] as string
  const files: Record<string, string> = {
    openai: ".openai_api.key",
    deepinfra: ".deepinfra.key",
  }
  const filename = files[provider]
  if (filename) {
    try {
      const keyPath = resolve(homedir(), "Development", filename)
      if (existsSync(keyPath)) {
        const key = readFileSync(keyPath, "utf-8").trim()
        if (key) return key
      }
    } catch {}
  }
  return ""
}

// ── ConflictDetector service (SC-5) ──

export namespace ConflictDetector {
  export class Service extends Context.Service<Service, Interface>()("@foxybear/ConflictDetector") {}

  export interface Interface {
    readonly check: (content: string, project_id: string) => Effect.Effect<CheckResult>
  }

  /**
   * check(content, project_id) → Effect<CheckResult>.
   *
   * The save-time conflict detection entry point. Wired into Memory.store
   * via Effect.runPromise (memory.ts storeImpl). Returns { verdict, target,
   * subgraph } where subgraph is the localized evidence path for UPDATE/
   * DELETE verdicts (reqs 13-15).
   */
  export const check = Effect.fn("ConflictDetector.check")(function* (content: string, project_id: string) {
    const cfg = yield* Effect.promise(() => resolveConfig())

    // Compute embedding of the new content (req 5).
    const embedding = yield* Effect.promise(() => embed(content))
    if (!embedding) return { verdict: "ADD" as const }

    // Neighbor lookup: top live MEMORY node by cosine, scoped to project_id.
    const neighbor = yield* Effect.promise(() => findNeighbor(embedding, project_id))
    if (!neighbor) return { verdict: "ADD" as const }

    // Contradiction scoring (reqs 8-11).
    let verdict: Verdict
    let target: string | undefined
    if (neighbor.cosine >= cfg.cosine_threshold) {
      // cosine >= cosine_threshold → ADD (complement/near-dup, falls to dedup)
      verdict = "ADD"
    } else if (neighbor.cosine >= cfg.delete_threshold) {
      // cosine < cosine_threshold AND >= delete_threshold → UPDATE
      verdict = "UPDATE"
      target = neighbor.node_id
    } else {
      // cosine < delete_threshold → DELETE
      verdict = "DELETE"
      target = neighbor.node_id
    }

    // LLM verify (req 12): override toward ADD only.
    if (cfg.llm_verify && verdict !== "ADD") {
      const v = yield* Effect.promise(() => verify(neighbor.content, content))
      if (v === "unavailable") {
        // LLM-unavailable fallback: ADD (no destructive UPDATE/DELETE without verification)
        log.warn("conflict: llm_verify requested but LLM unavailable, defaulting to ADD")
        return { verdict: "ADD" as const }
      }
      if (v === "no") {
        // LLM says "no contradiction" → ADD regardless of cosine
        return { verdict: "ADD" as const }
      }
      // LLM says "yes" → keep the cosine-based verdict (UPDATE or DELETE)
    }

    // Path localization (reqs 13-15): identify the evidence subgraph for
    // UPDATE/DELETE verdicts. Recorded in the event payload as audit trail.
    if (verdict === "UPDATE" || verdict === "DELETE") {
      const subgraph = yield* Effect.promise(() => localize(target as string, project_id))
      return { verdict, target, subgraph }
    }

    return { verdict: "ADD" as const }
  })

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({ check })
    }),
  )

  export const defaultLayer = layer
}
