/**
 * SDD-06 / Phase M-3 — @foxybear/MemoryLifecycle Effect service (SC-5).
 *
 * Layer.effect composing { decay, consolidate, graduate, prune, gc }.
 * Each method returns an Effect per SC-5's signatures. Registered in the
 * daemon runtime at src/cli/cmd/serve.ts alongside @foxybear/Memory and
 * @foxybear/Embedding.
 *
 * - decay(now?)        → { decayed, transitioned }
 * - consolidate(input)  → wraps Consolidation.run
 * - graduate()          → { graduated }
 * - prune(persona?)     → wraps Consolidation.prune
 * - gc(now?)            → { deleted }
 */
import { Effect, Layer, Context } from "effect"
import { ulid } from "ulid"
import { Consolidation } from "../consolidation"
import { Session } from "../../session"
import { Log } from "../../util/log"
import { makeRuntime } from "../../effect/run-service"
import { decay, type DecayResult } from "./decay"
import { gc, type GcResult } from "./gc"
import { graduate, type GraduateResult } from "./graduate"
import { prune, type PruneResult } from "./prune"

const log = Log.create({ service: "memory.lifecycle.service" })

export interface ConsolidateInput {
  persona: string
  lockDir?: string
  recentSessionIds?: string[]
}

export interface ConsolidateResult {
  merged: number
  pruned: number
  created: number
  indexUpdated: number
  durationMs: number
}

export interface Interface {
  readonly decay: (now?: number) => Effect.Effect<DecayResult>
  readonly consolidate: (input: ConsolidateInput) => Effect.Effect<ConsolidateResult>
  readonly graduate: () => Effect.Effect<GraduateResult>
  readonly prune: (persona?: string) => Effect.Effect<PruneResult>
  readonly gc: (now?: number) => Effect.Effect<GcResult>
}

class Service extends Context.Service<Service, Interface>()("@foxybear/MemoryLifecycle") {}

export { Service }

async function consolidateImpl(input: ConsolidateInput): Promise<ConsolidateResult> {
  const recent = input.recentSessionIds ?? [...Session.listGlobal({ limit: 50 })].map((s) => s.id)
  const lockDir = input.lockDir ?? "/tmp/opencode-consolidation"
  const result = await Consolidation.run({
    persona: input.persona,
    lockDir,
    recentSessionIds: recent,
  })
  return {
    merged: result.merged,
    pruned: result.pruned,
    created: result.created,
    indexUpdated: result.indexUpdated,
    durationMs: result.durationMs,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const decayFn = Effect.fn("MemoryLifecycle.decay")(function* (now?: number) {
      return yield* Effect.promise(() => decay(now))
    })

    const consolidate = Effect.fn("MemoryLifecycle.consolidate")(function* (input: ConsolidateInput) {
      return yield* Effect.promise(() => consolidateImpl(input))
    })

    const graduateFn = Effect.fn("MemoryLifecycle.graduate")(function* () {
      return yield* Effect.promise(() => graduate())
    })

    const pruneFn = Effect.fn("MemoryLifecycle.prune")(function* (persona?: string) {
      return yield* Effect.promise(() => prune(persona))
    })

    const gcFn = Effect.fn("MemoryLifecycle.gc")(function* (now?: number) {
      return yield* Effect.promise(() => gc(now))
    })

    return Service.of({ decay: decayFn, consolidate, graduate: graduateFn, prune: pruneFn, gc: gcFn })
  }),
)

export const defaultLayer = layer

const { runPromise } = makeRuntime(Service, defaultLayer)

// ── Public async API (convenience facades) ──

export async function decayNow(now?: number): Promise<DecayResult> {
  return runPromise((svc) => svc.decay(now))
}

export async function consolidate(input: ConsolidateInput): Promise<ConsolidateResult> {
  return runPromise((svc) => svc.consolidate(input))
}

export async function graduateNow(): Promise<GraduateResult> {
  return runPromise((svc) => svc.graduate())
}

export async function pruneNow(persona?: string): Promise<PruneResult> {
  return runPromise((svc) => svc.prune(persona))
}

export async function gcNow(now?: number): Promise<GcResult> {
  return runPromise((svc) => svc.gc(now))
}

export { ulid, log }
