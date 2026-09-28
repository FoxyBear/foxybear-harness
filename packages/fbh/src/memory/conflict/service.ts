/**
 * SDD-09 / Phase M-5 — @foxybear/ConflictDetector Effect service (SC-5).
 *
 * Layer.effect composing ConflictDetector.check. Registered in the daemon
 * runtime at src/cli/cmd/serve.ts alongside @foxybear/Memory and
 * @foxybear/MemoryLifecycle. The check method returns an Effect per SC-5's
 * signatures; callers bridge to a Promise via Effect.runPromise (the
 * canonical Effect-to-Promise bridge used throughout the codebase — e.g.
 * memory.ts:636 makeRuntime's runPromise, session/prompt.ts:116,
 * mcp/oauth-provider.ts:66).
 *
 * Awaiting an Effect<T> directly does not resolve to T — `await someEffect`
 * returns the unevaluated Effect runtime object, not the T it would produce;
 * Effect.runPromise(effect) drives the Effect to completion and returns a
 * Promise<T>. The wiring in memory.ts storeImpl uses Effect.runPromise to
 * bridge ConflictDetector.check's Effect to storeImpl's async flow.
 */
import { Effect, Layer, Context } from "effect"
import { Log } from "../../util/log"
import { makeRuntime } from "../../effect/run-service"
import { ConflictDetector, type CheckResult } from "./check"

const log = Log.create({ service: "memory.conflict.service" })

export { ConflictDetector }
export type { CheckResult }

export const layer = ConflictDetector.defaultLayer

export const defaultLayer = layer

const { runPromise } = makeRuntime(ConflictDetector.Service, defaultLayer)

// ── Public async API (convenience facade) ──

export async function check(content: string, project_id: string): Promise<CheckResult> {
  return runPromise((svc) => svc.check(content, project_id))
}

export { Effect, Layer, Context, log }
