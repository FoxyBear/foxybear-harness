# SDD: Abstraction-Based Memory — Summarize Turns Instead of Extracting Fragments

**Date:** 2026-09-27
**Project:** FoxyBear Harness Phase N (abstraction fix)
**Status:** Draft (immediate implementation — focused change to existing pipeline)
**Replaces:** The Gemini "extract" step in the Phase N classify pipeline (sdd-04)

## Problem

The current pipeline extracts **raw verbatim fragments** from the turn:
- "We use Bun not Node for the fbh harness"
- "The rebrand from OpenCode is complete"
- "SurrealDB is the graph backend"

These are pulled directly from the text — not abstracted, not summarized, not given context. A future session that retrieves "We use Bun not Node" doesn't know WHY (it was a rebrand decision), doesn't know the CONTEXT (fbh harness, not a general preference), and doesn't know the SCOPE (applies to fbh, not all projects).

## The architecture (Todd's vision)

```
1. User sends message
2. FBH searches DB (semantic similarity) for relevant memories → inject if found
3. LLM responds (possibly multiple steps with tool calls)
4. Turn completes → capture hook fires (async, fire-and-forget)
5. Jev gate: "Would this turn, if remembered, make a future INDEPENDENT session more efficient and reliable?"
6. If Jev says likely (> 0.5):
   a. Gather context: the current turn (user input + LLM response) + X previous turns (circular buffer)
   b. Small model abstracts: "Summarize this interaction into a self-contained memory that a future session could use without seeing the original conversation."
   c. Store the summary (not the raw fragments)
7. Done — the summary is now retrievable for future sessions
```

## The key difference: abstraction vs extraction

| Current (extraction) | New (abstraction) |
|---|---|
| Pulls raw fragments from the text | Summarizes the turn into a self-contained memory |
| "We use Bun not Node" | "The fbh harness uses Bun as its JavaScript runtime instead of Node. This was decided during the OpenCode → fbh rebrand. It applies to the fbh repo, not all FoxyBear projects." |
| No context, no reasoning, no scope | Full context, reasoning, and scope baked into the summary |
| Multiple fragments per turn | One summary per turn (or a few if the turn covers multiple topics) |
| Gemini extracts via JSON | Small model summarizes via chat |

## WHAT

1. **WHEN** the Jev gate passes (enriches_future > 0.5), the pipeline **SHALL** gather the current turn (user input + LLM final text response) plus the circular buffer's prior context (last X user turns).

2. **WHEN** gathering context for abstraction, the pipeline **SHALL** construct a context block containing:
   - The current user message (the user's input for this turn)
   - The LLM's final text response (the assistant's reasoning/output — the "thoughts")
   - Up to 5 prior user turns from the circular buffer (the conversation arc)
   - A summary of any tool calls made during the turn (tool name + success/failure, not full I/O)

3. **WHEN** abstracting, the pipeline **SHALL** send the context block to a small model with the prompt: "Summarize this interaction into a self-contained memory that a future independent session could use without seeing the original conversation. Include: what was decided/learned/preferred, why it matters, and what scope it applies to. Be concise (1-3 sentences). If there are multiple distinct memories, return them as separate items."

4. **WHEN** the small model returns, the pipeline **SHALL** store each summary as a MEMORY node with:
   - `content` = the abstracted summary
   - `memory_type` = assigned by Jev (from the gate's classification, not a separate classify call)
   - `confidence` = Jev's gate confidence (the `enriches_future` probability)
   - `source_path` = "abstraction"
   - `project_id` = the session's project_id
   - `session_id` = the session ID (for provenance)

5. **WHEN** the small model returns no useful content (empty or "none"), the pipeline **SHALL** skip storage (gate passed but nothing worth abstracting).

6. **WHEN** the small model errors (timeout, API failure, circuit breaker open), the pipeline **SHALL** fall back to the existing Gemini extraction path (verbatim fragments) as a graceful degradation.

## HOW

### File: `src/memory/classify/pipeline.ts`

Replace the "extract" step (currently calling `Gemini.extract`) with an "abstract" step:

1. After Jev gate passes, construct the context block:
   ```typescript
   const ctx = [
     `Prior user turns (context arc):`,
     Buffer.getContext(input.sessionID),
     ``,
     `Current user message:`,
     input.text,
     ``,
     `LLM response (this turn):`,
     input.response ?? "(no text response)",
     ``,
     `Tools used this turn:`,
     input.tools?.map(t => `${t.name} → ${t.status}`).join(", ") ?? "(none)",
   ].join("\n").slice(0, 4000)
   ```

2. Call the small model with a summarization prompt:
   ```typescript
   const summaries = await SmallModel.abstract(ctx)
   ```

3. Store each summary as a MEMORY node (same as current, but `content` = summary, `source_path` = "abstraction")

### The small model

**Model:** `google/gemini-2.5-flash` (already wired as `Gemini` provider — reuse it with a different prompt)

Rationale: already configured, 100% JSON reliability, $0.30/M tokens, 1.2s latency. No need for a separate model — just a different system prompt.

The system prompt for abstraction:
```
You are a memory abstraction engine for a coding agent. Your job is to read a conversation interaction and produce a self-contained memory summary that a future independent session could use without seeing the original conversation.

For each distinct memory-worthy fact, decision, preference, correction, or insight:
- State what was decided/learned/preferred
- State why it matters (the reasoning)
- State what scope it applies to (which project, which component, which context)

Return JSON: {"memories": [{"content": "...", "type": "preference|correction|decision|constraint|pattern|context"}]}

Be concise. Each memory should be 1-3 sentences. Only include things that would genuinely help a future session. If nothing is worth remembering, return {"memories": []}.
```

### What changes from the current pipeline

| Step | Current | New |
|---|---|---|
| Gate (Jev) | Same — "would this enrich a future query?" | Same |
| Extract (Gemini) | Pulls raw fragments: "We use Bun not Node" | **Abstract**: "The fbh harness uses Bun as its JS runtime instead of Node, decided during the OpenCode rebrand. Applies to the fbh repo." |
| Classify (Jev) | Separate Jev Choice per fragment | **Removed** — Jev already classified at the gate. The small model assigns type in its JSON output. |
| Store | Stores raw fragments | Stores abstracted summaries |
| Context | Current user text only | Current user text + LLM response + prior turns (buffer) + tool summary |

### What needs to change in `classify`'s input

The `ClassifyInput` interface needs two new optional fields:
```typescript
interface ClassifyInput {
  sessionID: string
  text: string          // user's message (existing)
  project_id: string    // existing
  persona: string       // existing
  response?: string     // NEW: the LLM's final text response for this turn
  tools?: Array<{ name: string; status: string }>  // NEW: tools used this turn
}
```

The capture hook in `prompt.ts` needs to pass these when calling `classify`:
```typescript
classify({
  sessionID,
  text,                 // user's input
  project_id,
  persona,
  response: assistantText,     // the LLM's final text response
  tools: toolSummary,          // summary of tool calls
})
```

## VERIFY

1. `bun run typecheck` exits 0
2. The pipeline stores **abstracted summaries** (not raw fragments) — verify by checking `node` table: `SELECT attributes.content, attributes.source_path FROM node WHERE node_type = 'MEMORY' ORDER BY tx_from DESC LIMIT 5` — `source_path` should be "abstraction" and content should be a self-contained summary, not a verbatim quote
3. The abstraction includes the LLM's response (the "thoughts") — verify the summary references the assistant's reasoning, not just the user's input
4. The abstraction includes prior context (the buffer arc) — verify the summary has enough context to be self-contained
5. Graceful degradation: if the small model fails, falls back to Gemini extraction (source_path = "extraction")
