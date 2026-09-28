import { getConfig } from "../config/bridge"

/**
 * Phase M-0 master gate (WHAT #15).
 *
 * Returns true iff `memory.enabled === true` in the resolved global config.
 * When false (the default), every M-0 wire-up code path stays dormant:
 * `migrateFromSqlite` is NOT invoked from serve.ts; `Scheduler.start` is
 * NOT called; `AutoRecall.autoRecall` is NOT invoked from prompt.ts;
 * `Consolidation.extractTurn` is NOT forked. Existing sessions proceed
 * identically to a pre-M-0 daemon.
 *
 * Reads `Instance.config.memory?.enabled` per the spec. The config is
 * fetched via the global config bridge (same path used by serve.ts).
 */
export async function isMemoryEnabled(): Promise<boolean> {
  try {
    const cfg = await getConfig()
    return cfg?.memory?.enabled === true
  } catch {
    return false
  }
}
