# SDD-00: Fix Council Provider Resolution

**Date:** 2026-08-05
**Project:** FoxyBear CLI (`packages/opencode`)
**Status:** Ready for implementation
**Supersedes:** C-2 in `260722_council_sdd-01-deliberation.md` (model resolution behavior)

## Problem

`council_deliberate` fails with `No API key for provider "perplexity-agent"` because the `models.dev` catalog maps model IDs to proxy/gateway providers instead of the intended native providers.

## Root Cause Analysis

Three layers of failure, verified by running code:

### Layer 1: Stale Process (immediate cause)

The running opencode process (PID 63409) started **Thu Jul 23 02:43:08 2026** and runs from source via `bun run --cwd packages/opencode src/index.ts`. The `config.ts` fix was applied to disk on **Aug 5 10:38:09 2026** — 13 days later. Bun loads TypeScript at startup; source edits do not hot-reload. The process has the **intermediate** `resolveModel` code in memory (catalog lookup without `KNOWN_PROVIDERS` guard).

Evidence:
```
$ ps -p 63409 -o lstart=
Thu Jul 23 02:43:08 2026

$ stat -f "%Sm" config.ts
Aug  5 10:38:09 2026
```

### Layer 2: Catalog Map Key Collision (latent bug in `loadCatalog`)

`loadCatalog()` in `config.ts:9-26` builds a `Map<string, ModelInfo>` using the bare `modelId` (the key within each provider's `models` record) as the map key:

```typescript
for (const [modelId, model] of Object.entries(provider.models ?? {})) {
  map.set(modelId, { id: modelId, ..., provider: providerId })
}
```

The models.dev catalog has **180 providers**. Many are proxy/gateway providers that serve the same upstream models. Some use unprefixed model keys (`gpt-5.4`); others use fully-qualified keys (`openai/gpt-5.4`). When multiple providers share the same model key, the **last provider in iteration order wins** — overwriting all previous entries.

Evidence:
```
$ bun -e "..."   # inspect catalog
modelKey=openai/gpt-5.4 → provider=anyapi
modelKey=openai/gpt-5.4 → provider=impossibl
...
modelKey=openai/gpt-5.4 → provider=perplexity-agent  ← LAST, wins the map slot
modelKey=gpt-5.4 → provider=openai
...
modelKey=gpt-5.4 → provider=cortecs  ← LAST for this key
```

### Layer 3: Intermediate `resolveModel` trusted the catalog blindly

The intermediate code (running in the stale process) looked up `catalog.get(id)` and returned the result without validating the provider. For `id = "openai/gpt-5.4"`, the catalog returns `{ provider: "perplexity-agent" }` (the last proxy that set this key). This provider is then passed to `getApiKey("perplexity-agent")`, which throws.

Simulation confirming the exact error:
```
=== INTERMEDIATE (stale, running in process) ===
openai/gpt-5.4 → provider: perplexity-agent           ← matches the error
anthropic/claude-opus-4-8 → provider: cloudflare-ai-gateway
deepinfra/zai-org/GLM-5.2 → provider: deepinfra       ← happens to work
anthropic/claude-fable-5 → provider: cloudflare-ai-gateway

=== FIXED (on disk, not yet loaded) ===
openai/gpt-5.4 → provider: openai
anthropic/claude-opus-4-8 → provider: anthropic
deepinfra/zai-org/GLM-5.2 → provider: deepinfra
anthropic/claude-fable-5 → provider: anthropic
```

### Why the on-disk `KNOWN_PROVIDERS` fix is insufficient

The on-disk fix adds a `KNOWN_PROVIDERS` allowlist that filters out bogus catalog results and falls back to parsing the ID. This IS correct and would work after a restart. However:

1. It retains the unreliable `loadCatalog()` map (180 providers, last-writer-wins collisions) for no benefit — the catalog lookup never returns a useful result for qualified IDs.
2. It makes `resolveModel` async (requires `Effect.promise` wrappers in `tool.ts`) for no reason — there is no I/O.
3. The `KNOWN_PROVIDERS` set is a maintenance burden that must be manually kept in sync with `transport.ts`'s `ENV_KEYS`.

The correct fix: **skip the catalog entirely**. The provider prefix in the model ID IS the source of truth.

## WHAT

### Provider Resolution (P)

P-1. WHEN `resolveModel` receives a qualified ID (e.g., `openai/gpt-5.4`), it SHALL split on the first `/` and return `{ id: <part after first />, name: <same>, provider: <part before first /> }`.

P-2. WHEN `resolveModel` receives an unqualified ID (no `/`, e.g., `gpt-5.4`), it SHALL return `{ id, name: id, provider: "openai" }`.

P-3. WHEN `resolveModel` receives a multi-slash ID (e.g., `deepinfra/zai-org/GLM-5.2`), it SHALL split on the **first** `/` only. The provider is `deepinfra`; the model ID is `zai-org/GLM-5.2`.

P-4. `resolveModel` SHALL NOT consult the `models.dev` catalog. The catalog has 180 providers with colliding model keys, making it unreliable for provider resolution. The provider prefix in the ID is authoritative.

P-5. `resolveModel` SHALL be synchronous. It performs no I/O and requires no `Effect.promise` wrapper.

### Defaults (D)

D-1. WHEN `~/.config/opencode/council.json` does not exist, `loadSettings` SHALL return defaults with fully-qualified model IDs: `["openai/gpt-5.4", "anthropic/claude-sonnet-4-6", "deepinfra/deepseek-ai/DeepSeek-V4-Pro", "deepinfra/moonshotai/Kimi-K2.6"]`, arbitrator `"openai/gpt-5.4"`.

D-2. Unqualified defaults SHALL NOT be used because they default to provider `"openai"` regardless of the actual provider (e.g., `claude-sonnet-4-6` would resolve to `openai`).

## HOW

### Change 1: Simplify `resolveModel` in `config.ts`

**File:** `packages/opencode/src/harness/council/config.ts`

Replace lines 1-26 and 53-63 (imports, `_catalog`, `loadCatalog`, `KNOWN_PROVIDERS`, `resolveModel`) with:

```typescript
import type { ModelInfo } from "./prompts"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { homedir } from "os"
```

Remove the `ModelsDev` import (line 5), `_catalog` (line 7), `loadCatalog` (lines 9-26), `KNOWN_PROVIDERS` (line 53).

Replace `resolveModel` (lines 55-63) with:

```typescript
export function resolveModel(id: string): ModelInfo {
  const slash = id.indexOf("/")
  const provider = slash >= 0 ? id.slice(0, slash) : "openai"
  const modelId = slash >= 0 ? id.slice(slash + 1) : id
  return { id: modelId, name: modelId, provider }
}
```

### Change 2: Update defaults in `loadSettings`

**File:** `packages/opencode/src/harness/council/config.ts`, lines 44-50

Replace:
```typescript
  return {
    models: ["gpt-5.4", "claude-sonnet-4-6", "deepseek-ai/DeepSeek-V4-Pro", "moonshotai/Kimi-K2.6"],
    arbitrator: "gpt-5.4",
    maxRounds: 3,
    threshold: 4,
    enableResearch: false,
  }
```

With:
```typescript
  return {
    models: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6", "deepinfra/deepseek-ai/DeepSeek-V4-Pro", "deepinfra/moonshotai/Kimi-K2.6"],
    arbitrator: "openai/gpt-5.4",
    maxRounds: 3,
    threshold: 4,
    enableResearch: false,
  }
```

### Change 3: Revert `tool.ts` to synchronous calls

**File:** `packages/opencode/src/harness/council/tool.ts`, lines 68-69

Replace:
```typescript
        const models = yield* Effect.promise(() => Promise.all(settings.models.map(resolveModel)))
        const arbitrator = yield* Effect.promise(() => resolveModel(settings.arbitrator))
```

With:
```typescript
        const models = settings.models.map(resolveModel)
        const arbitrator = resolveModel(settings.arbitrator)
```

### Change 4: Restart the opencode process

The running process (PID 63409) has stale code in memory. It must be restarted to load the updated source:

```bash
kill 63409
# Restart using whatever command launched it originally:
cd /Users/toddenglish/Development/FoxyBearOffice/development/opencode
bun run --cwd packages/opencode --conditions=browser src/index.ts
```

No rebuild is needed — the process runs from source via `bun run`, not from the compiled `dist/opencode-darwin-arm64/bin/opencode` binary.

## VERIFY

### Step 1: Verify `resolveModel` directly

```bash
cd /Users/toddenglish/Development/FoxyBearOffice/development/opencode && bun -e "
import { resolveModel } from './packages/opencode/src/harness/council/config';
const ids = ['openai/gpt-5.4', 'anthropic/claude-opus-4-8', 'deepinfra/zai-org/GLM-5.2', 'deepinfra/deepseek-ai/DeepSeek-V4-Pro', 'anthropic/claude-fable-5'];
const KNOWN = new Set(['openai', 'anthropic', 'deepinfra']);
let ok = true;
for (const id of ids) {
  const m = resolveModel(id);
  const valid = KNOWN.has(m.provider);
  if (!valid) ok = false;
  console.log((valid ? 'OK' : 'FAIL') + ' | ' + id + ' → provider=' + m.provider + ' modelId=' + m.id);
}
console.log(ok ? '\nALL PASS' : '\nFAILURES DETECTED');
"
```

Expected output:
```
OK | openai/gpt-5.4 → provider=openai modelId=gpt-5.4
OK | anthropic/claude-opus-4-8 → provider=anthropic modelId=claude-opus-4-8
OK | deepinfra/zai-org/GLM-5.2 → provider=deepinfra modelId=zai-org/GLM-5.2
OK | deepinfra/deepseek-ai/DeepSeek-V4-Pro → provider=deepinfra modelId=deepseek-ai/DeepSeek-V4-Pro
OK | anthropic/claude-fable-5 → provider=anthropic modelId=claude-fable-5

ALL PASS
```

### Step 2: Verify typecheck passes

```bash
cd /Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode && bun typecheck
```

### Step 3: Verify live `council_deliberate` call (after restart)

After restarting the opencode process, invoke `council_deliberate` with a simple prompt. The call should proceed past the API key resolution phase and begin making HTTP requests to OpenAI, Anthropic, and DeepInfra. The `perplexity-agent` / `cloudflare-ai-gateway` / `cortecs` errors should NOT appear.

```bash
# After restarting opencode, invoke the tool:
council_deliberate({ prompt: "What is 2+2?" })
```

If the tool still fails with `perplexity-agent`, the process was not restarted (check `ps aux | grep opencode` for the PID and start time).

### Step 4: Verify catalog is NOT consulted

After the fix, `config.ts` should have NO import of `ModelsDev` and NO `loadCatalog` function:

```bash
grep -n "ModelsDev\|loadCatalog\|KNOWN_PROVIDERS\|_catalog" \
  /Users/toddenglish/Development/FoxyBearOffice/development/opencode/packages/opencode/src/harness/council/config.ts
```

Expected: no output (no matches).
