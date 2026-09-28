/**
 * SDD-08 / Phase M-6 — Real LLM client (CC-5: no request mocking).
 *
 * Two endpoints:
 *  - judge (OpenAI gpt-4o-mini) — Faithfulness + contradiction confirmation.
 *  - extract (DeepInfra Qwen2.5-7B-Instruct) — extraction / answer generation.
 *
 * Keys are read from ~/Development/.openai_api.key and ~/Development/.deepinfra.key
 * (per the task spec). Greedy decoding (temperature=0) so a re-run against
 * the same fixture reproduces aggregate metrics within ±1% (req 2, req 3).
 */
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { homedir } from "os"

export interface LLMConfig {
  provider: string
  model: string
  api_key: string
  base_url: string
}

const DEFAULT_JUDGE: LLMConfig = {
  provider: "openai",
  model: "gpt-4o-mini",
  api_key: "",
  base_url: "https://api.openai.com/v1",
}

const DEFAULT_EXTRACT: LLMConfig = {
  provider: "deepinfra",
  model: "Qwen/Qwen2.5-7B-Instruct",
  api_key: "",
  base_url: "https://api.deepinfra.com/v1/openai",
}

function loadKey(envVar: string, filename: string): string {
  if (process.env[envVar]) return process.env[envVar]!
  const p = resolve(homedir(), "Development", filename)
  if (existsSync(p)) return readFileSync(p, "utf-8").trim()
  return ""
}

export function judgeConfig(): LLMConfig {
  return { ...DEFAULT_JUDGE, api_key: loadKey("OPENAI_API_KEY", ".openai_api.key") }
}

export function extractConfig(): LLMConfig {
  return { ...DEFAULT_EXTRACT, api_key: loadKey("DEEPINFRA_API_KEY", ".deepinfra.key") }
}

export interface ChatMsg { role: "system" | "user" | "assistant"; content: string }

/** Real LLM call — POST /chat/completions with greedy decoding. */
export async function chat(cfg: LLMConfig, messages: ChatMsg[]): Promise<string> {
  if (!cfg.api_key) throw new Error(`no api key for ${cfg.provider}`)
  const res = await fetch(`${cfg.base_url}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0,
      max_tokens: 256,
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`${cfg.provider} returned ${res.status}: ${t.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    choices: { message: { content: string } }[]
  }
  return data.choices[0]?.message?.content ?? ""
}

/** Faithfulness judge — "Is this answer supported by the retrieved context?" */
export async function judge(cfg: LLMConfig, answer: string, context: string): Promise<string> {
  const messages: ChatMsg[] = [
    {
      role: "system",
      content: "You are a strict fact-checker. Reply with one word: YES, PARTIAL, or NO.",
    },
    {
      role: "user",
      content:
        `Context:\n${context}\n\nAnswer:\n${answer}\n\n` +
        `Is the answer fully supported by the context? Reply YES, PARTIAL, or NO.`,
    },
  ]
  return (await chat(cfg, messages)).trim()
}

/** Contradiction judge — "Does this new memory contradict the existing memory?" */
export async function contradict(
  cfg: LLMConfig,
  existing: string,
  candidate: string,
): Promise<{ contradicts: boolean; severity: "minor" | "moderate" | "severe" | "none"; raw: string }> {
  const messages: ChatMsg[] = [
    {
      role: "system",
      content:
        "Reply in one line: YES/<severity> or NO. Severity is minor, moderate, or severe.",
    },
    {
      role: "user",
      content:
        `Existing memory: ${existing}\nNew memory: ${candidate}\n` +
        `Does the new memory contradict the existing memory? Reply YES/minor, YES/moderate, ` +
        `YES/severe, or NO.`,
    },
  ]
  const raw = (await chat(cfg, messages)).trim()
  const m = raw.toUpperCase().match(/^(YES|NO)(?:\s*\/\s*(MINOR|MODERATE|SEVERE))?/)
  if (m && m[1] === "YES") {
    const sev = (m[2] ?? "MODERATE").toLowerCase() as "minor" | "moderate" | "severe"
    return { contradicts: true, severity: sev, raw }
  }
  return { contradicts: false, severity: "none", raw }
}

/** Generate an answer given a prompt (with or without injected memory). */
export async function answer(cfg: LLMConfig, prompt: string, context: string): Promise<string> {
  const messages: ChatMsg[] = [
    {
      role: "system",
      content:
        "You are a precise assistant. Use only the provided context to answer. " +
        "If the context is empty, answer from general knowledge.",
    },
    { role: "user", content: `${context}\n\nQuestion: ${prompt}` },
  ]
  return (await chat(cfg, messages)).trim()
}
