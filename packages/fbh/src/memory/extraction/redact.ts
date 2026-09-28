/**
 * SDD-05 / Phase M-2 W-21 — Secrets-redaction filter.
 *
 * Runs BEFORE content is sent to the extraction LLM. Redacts:
 *   - API keys: sk-..., AIza..., ghp_..., AKIA..., xoxb-...
 *   - JWT tokens: eyJ...
 *   - auth.json contents (matched against the user's actual auth file)
 *   - bearer tokens
 *   - password/secret/token field values in JSON
 *
 * No secrets SHALL be sent to the extraction LLM. The catch rate is
 * measured by governance.test.ts::secrets_redaction against a seeded
 * fixture of 5 representative secrets; zero leakage is required.
 *
 * The redaction is a defense-in-depth layer. CC-12 / B4 also require
 * explicit opt-in (memory.extraction.external_opt_in default false),
 * CLI disclosure (W-26), and a pre-named self-hosted fallback (W-24).
 */

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk-[A-Za-z0-9]{20,}/g, label: "OPENAI_KEY" },
  { re: /AIza[0-9A-Za-z_\-]{35,}/g, label: "GOOGLE_KEY" },
  { re: /ghp_[A-Za-z0-9]{36,}/g, label: "GITHUB_TOKEN" },
  { re: /AKIA[0-9A-Z]{16}/g, label: "AWS_KEY" },
  { re: /xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{20,}/g, label: "SLACK_TOKEN" },
  { re: /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, label: "JWT" },
  { re: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/gi, label: "BEARER" },
]

const JSON_FIELD_RE = /"(?:password|secret|token|api_key|apikey|access_token|refresh_token)"\s*:\s*"(?:[^"\\]|\\.)*"/gi

export interface RedactedPayload {
  content: string
  redactions: Array<{ label: string; count: number }>
}

export function redact(content: string, opts?: { authKeys?: string[] }): RedactedPayload {
  let out = content
  const redactions: Array<{ label: string; count: number }> = []

  for (const { re, label } of PATTERNS) {
    const matches = out.match(re)
    if (matches && matches.length > 0) {
      redactions.push({ label, count: matches.length })
      out = out.replace(re, `[REDACTED:${label}]`)
    }
  }

  const jsonMatches = out.match(JSON_FIELD_RE)
  if (jsonMatches && jsonMatches.length > 0) {
    redactions.push({ label: "JSON_SECRET_FIELD", count: jsonMatches.length })
    out = out.replace(JSON_FIELD_RE, '"$1":"[REDACTED]"')
  }

  const authKeys = opts?.authKeys ?? []
  for (const key of authKeys) {
    if (key && key.length >= 8 && out.includes(key)) {
      redactions.push({ label: "AUTH_JSON_KEY", count: 1 })
      out = out.split(key).join("[REDACTED:AUTH_JSON]")
    }
  }

  return { content: out, redactions }
}

export function leaked(originalContent: string, redacted: RedactedPayload, secrets: string[]): string[] {
  return secrets.filter((s) => s && redacted.content.includes(s))
}
