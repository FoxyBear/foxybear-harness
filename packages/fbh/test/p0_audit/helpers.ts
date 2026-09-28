import { mkdirSync, existsSync, readFileSync, rmSync, mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const OUTPUT_DIR = join(import.meta.dir, "results")
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })

export interface Observed {
  component: string
  input_id: string
  input_description: string
  input: unknown
  output: unknown
  error: string | null
  duration_ms: number
  timestamp: string
}

function ser(v: unknown, seen = new WeakSet()): unknown {
  if (v === undefined) return null
  if (v === null) return null
  const t = typeof v
  if (t === "string" || t === "number" || t === "boolean") return v
  if (t === "bigint") return String(v)
  if (t === "symbol") return (v as symbol).toString()
  if (t === "function") return `[fn ${(v as { name?: string }).name || "anon"}]`
  if (v instanceof Float32Array) return Array.from(v)
  if (v instanceof Float64Array) return Array.from(v)
  if (v instanceof Uint8Array) return Array.from(v)
  if (v instanceof Int8Array) return Array.from(v)
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return Array.from(v as Buffer)
  if (v instanceof Date) return v.toISOString()
  if (v instanceof Error) return { _error: v.message, stack: v.stack?.split("\n").slice(0, 5).join("\n") }
  if (v instanceof Map) return { _map: Array.from(v.entries()).map(([k, val]) => [ser(k, seen), ser(val, seen)]) }
  if (v instanceof Set) return { _set: Array.from(v).map((x) => ser(x, seen)) }
  if (t === "object") {
    if (seen.has(v as object)) return "[circular]"
    seen.add(v as object)
    if (Array.isArray(v)) return v.map((x) => ser(x, seen))
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      try {
        out[k] = ser(val, seen)
      } catch {
        out[k] = "[unserializable]"
      }
    }
    return out
  }
  return String(v)
}

export async function record(
  component: string,
  input_id: string,
  input_description: string,
  input: unknown,
  fn: () => unknown | Promise<unknown>,
): Promise<Observed> {
  const start = Date.now()
  let out: unknown = null
  let err: string | null = null
  try {
    out = ser(await fn())
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  const duration_ms = Date.now() - start
  const entry: Observed = {
    component,
    input_id,
    input_description,
    input: ser(input),
    output: out,
    error: err,
    duration_ms,
    timestamp: new Date().toISOString(),
  }
  const file = join(OUTPUT_DIR, `${component}.json`)
  let entries: Observed[] = []
  if (existsSync(file)) {
    try {
      entries = JSON.parse(readFileSync(file, "utf-8"))
    } catch {
      entries = []
    }
  }
  entries.push(entry)
  await Bun.write(file, JSON.stringify(entries, null, 2))
  return entry
}

export function clearResults(component: string): void {
  const file = join(OUTPUT_DIR, `${component}.json`)
  if (existsSync(file)) {
    try {
      rmSync(file)
    } catch {}
  }
}

export function resultsDir(): string {
  return OUTPUT_DIR
}

export function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "fbh-p0-audit-"))
}

export function rmTmp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

const DAY_MS = 24 * 60 * 60 * 1000

export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS)
}

export function msAgo(n: number): Date {
  return new Date(Date.now() - n)
}
