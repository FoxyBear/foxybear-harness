import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "memory.m0-telemetry" })

export interface TelemetryEvent {
  /** Per-turn P95 turn-latency in ms (handle.process dispatch to finalize). */
  p95_turn_latency_ms?: number
  /** Count of extractTurn invocations that hit the timeout/error warn log this bucket. */
  extraction_error_count?: number
  /** autoRecall / extractTurn invocation counts this bucket. */
  query_volume?: { auto_recall: number; extract_turn: number }
  /** Marks the pre-flag-flip baseline bucket. */
  baseline?: boolean
}

/**
 * Phase M-0 guardrail (WHAT #19).
 *
 * Fire-and-forget writer — caller forks this via `run.fork` so it never
 * blocks the turn. Writes a single JSON file per bucket to
 * `~/.local/share/foxybear/telemetry/m0-<ISO8601>-<bucket>.json`.
 *
 * The bucket interval is `3600s` hourly in production, or
 * `memory.telemetry.test_window_seconds` in test mode (caller computes
 * the bucket label and passes it via `event.baseline` etc.).
 */
export async function emitTelemetry(event: TelemetryEvent & { bucket?: string }): Promise<void> {
  try {
    const iso = new Date().toISOString().replace(/[:.]/g, "-")
    const bucket = event.bucket ?? iso
    const dir = path.join(Global.Path.data, "telemetry")
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `m0-${iso}-${bucket}.json`)
    await fs.writeFile(
      file,
      JSON.stringify(
        {
          ...event,
          bucket,
          written_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
  } catch (err) {
    log.warn("m0 telemetry write failed", { error: String(err) })
  }
}

/**
 * Sliding-window P95 over a per-bucket array of latencies.
 * Returns 0 for an empty array (no turns in this bucket).
 */
export function computeP95(latencies: number[]): number {
  if (latencies.length === 0) return 0
  const sorted = [...latencies].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  return sorted[idx] ?? 0
}
