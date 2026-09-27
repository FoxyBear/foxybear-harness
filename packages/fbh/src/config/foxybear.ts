import z from "zod"

export const FoxyBearFields = {
  memory: z
    .object({
      enabled: z
        .boolean()
        .default(false)
        .describe(
          "Master gate for Phase M-0 memory wire-up. When false (default), " +
            "migrateFromSqlite is NOT invoked from serve.ts, Scheduler.start is NOT called, " +
            "AutoRecall.autoRecall is NOT invoked from prompt.ts, and Consolidation.extractTurn " +
            "is NOT forked. Existing sessions proceed identically to a pre-M-0 daemon. " +
            "Opt in by setting memory.enabled: true.",
        ),
      embedding: z
        .object({
          provider: z.enum(["ollama", "deepinfra", "openai"]).default("deepinfra"),
          model: z.string().default("BAAI/bge-base-en-v1.5"),
          dimensions: z.number().int().default(768),
          fallback: z
            .object({
              provider: z.string(),
              model: z.string(),
            })
            .optional(),
        })
        .optional(),
      workforce: z
        .object({
          url: z.string().url().optional(),
          max_results: z.number().int().default(3),
        })
        .optional(),
      dedup_threshold: z.number().min(0).max(1).default(0.95),
      ttl_days: z.number().int().min(0).default(90),
      auto_capture: z
        .boolean()
        .default(true)
        .describe("Enable per-turn memory extraction"),
      extraction: z
        .object({
          mode: z.enum(["regex", "llm", "hybrid"]).default("hybrid").describe(
            "M-2 extraction mode. 'regex' uses the deterministic extractor only. " +
              "'llm' uses the LLM extractor for all turns (subject to external_opt_in). " +
              "'hybrid' uses regex below threshold, LLM at/above threshold.",
          ),
          model: z.string().default("deepinfra/Qwen/Qwen2.5-7B-Instruct").describe(
            "Primary extraction LLM model ID. Parsed via Provider.parseModel at runtime.",
          ),
          fallback_model: z.string().default("openai/gpt-4o-mini").describe(
            "Secondary extraction LLM used when the primary call fails (W-12).",
          ),
          self_hosted_fallback_model: z
            .string()
            .default("ollama://qwen2.5:7b-instruct")
            .describe("Pre-named self-hosted extraction fallback (W-24)."),
          external_opt_in: z.boolean().default(true).describe(
            "CC-12 / B4 / W-22: explicit user opt-in for sending session content to an " +
              "external extraction LLM provider. Phase N (SC-2) supersedes the Phase M default " +
              "of false — external extraction is enabled when memory.enabled: true. When false, " +
              "only the regex extraction path runs.",
          ),
          self_hosted: z
            .boolean()
            .default(false)
            .describe(
              "W-24: when true AND external_opt_in is false, route extraction to " +
                "self_hosted_fallback_model instead of the external provider.",
            ),
          threshold: z
            .number()
            .min(0)
            .max(1)
            .default(0.7)
            .describe("W-11: turn extraction score >= threshold uses the LLM in hybrid mode."),
          gate_threshold: z
            .number()
            .min(0)
            .max(1)
            .default(0.5)
            .describe(
              "Phase N SC-2: Jev Noul threshold for the gate. Stage 1 of the 4-stage " +
                "classification pipeline. Turns scoring above this threshold are extracted " +
                "via Gemini (layer2).",
            ),
          buffer_size: z
            .number()
            .int()
            .min(0)
            .default(5)
            .describe(
              "Phase N SC-2: circular buffer size — last N user turns kept as context for the " +
                "Jev gate. Default 5. Set 0 to disable the arc. SDD-03 owns the buffer.",
            ),
          batch_size: z
            .number()
            .int()
            .min(1)
            .default(5)
            .describe("W-13: number of turns batched into a single LLM call. 1 disables batching."),
          async: z
            .boolean()
            .default(true)
            .describe(
              "W-13: when true, extraction runs in the background via Effect.fork and does not " +
                "block the LLM response. Use false only in tests.",
            ),
          layer1: z
            .object({
              provider: z.string().default("openrouter"),
              model: z.string().default("typesafe/jev-1.13"),
              api_key: z.string().default("{file:~/Development/.openrouter.key}"),
            })
            .optional()
            .describe(
              "Phase N SC-2: Jev gate + classify provider config (layer 1 of the 4-stage " +
                "classification pipeline). CC-10: OpenRouter only. The api_key uses the " +
                "{file:...} form — substitution runs in paths.ts before the adapter sees the value.",
            ),
          layer2: z
            .object({
              provider: z.string().default("openrouter"),
              model: z.string().default("google/gemini-2.5-flash"),
              api_key: z.string().default("{file:~/Development/.openrouter.key}"),
            })
            .optional()
            .describe(
              "Phase N SC-2: Gemini extraction provider config (layer 2 of the 4-stage " +
                "classification pipeline). CC-10: OpenRouter only. The api_key uses the " +
                "{file:...} form — substitution runs in paths.ts before the adapter sees the value.",
            ),
          circuit_breaker: z
            .object({
              max_latency_ms: z.number().int().default(3000),
              max_consecutive_failures: z.number().int().default(5),
              max_error_rate_pct: z.number().min(0).max(100).default(5),
              fallback: z.enum(["regex", "none"]).default("regex"),
            })
            .optional()
            .describe(
              "Phase N SC-2: circuit breaker config (CC-9). When Jev/Gemini latency > max_latency_ms " +
                "for max_consecutive_failures calls, or error rate exceeds max_error_rate_pct, " +
                "fall back to regex-only extraction (the old stub behavior). Per-adapter state — " +
                "a Jev failure does not trip the Gemini breaker and vice versa.",
            ),
        })
        .optional()
        .describe("SDD-05 M-2 extraction pipeline config"),
      consolidation: z
        .object({
          min_hours_between: z.number().min(0).default(24),
          min_sessions_between: z.number().int().min(0).default(5),
          stale_warning_days: z.number().int().min(0).default(1),
          // @deprecated SDD-06 — replaced by memory.decay.* (simple exponential +
          // rehearsal). The lifecycle sub-score (memory.scoring.w_lifecycle)
          // subsumes this binary penalty. Kept for backward compat with existing
          // config files; no longer read by the recall scoring path.
          stale_penalty_days: z.number().int().min(0).default(7),
        })
        .optional(),
      // SDD-09 / Phase M-5 — save-time conflict detection config (SC-6).
      // cosine_threshold: ADD/UPDATE contradiction threshold. Default 0.3
      //   per SC-6; calibrated to 0.20 by the M-6 conflict-tune sweep
      //   (selected.value = 0.2, f1 = 0.67 on the contradiction-20 fixture).
      //   The calibrated value is consumed when present in fbh.json; this
      //   default is the fallback.
      // delete_threshold: UPDATE/DELETE strong-contradiction threshold (req
      //   11). Semantically distinct from memory.decay.archived_threshold
      //   (which gates DEPRECATED→ARCHIVED lifecycle on a confidence score,
      //   SC-3 line 178) — delete_threshold gates UPDATE→DELETE conflict
      //   verdict on a cosine similarity score. They share a default value
      //   (0.1) but represent different concepts (lifecycle confidence vs
      //   conflict cosine), so a separate key is cleaner than reusing
      //   archived_threshold (req 27).
      // llm_verify: LLM verification toggle (req 12). When true, a binary
      //   LLM prompt overrides the verdict toward ADD only. LLM unavailable
      //   → ADD fallback (no destructive UPDATE/DELETE without verification).
      conflict: z
        .object({
          cosine_threshold: z.number().min(0).max(1).default(0.3),
          delete_threshold: z.number().min(0).max(1).default(0.1),
          llm_verify: z.boolean().default(false),
        })
        .optional()
        .describe("SDD-09 M-5 save-time conflict detection config (SC-6)"),
      decay_model: z
        .enum(["simple", "prism", "none"])
        .default("simple")
        .describe(
          "SDD-06 M-3 decay model. 'simple' (default) applies exponential + " +
            "rehearsal. 'prism' is experimental (ESMS convergence proof " +
            "unverified) — observational only. 'none' disables the decay " +
            "engine (abort A5 state).",
        ),
      decay: z
        .object({
          active_rate: z.number().min(0).max(1).default(0.01),
          deprecated_rate: z.number().min(0).max(1).default(0.05),
          archived_rate: z.number().min(0).max(1).default(0.1),
          rehearsal_boost: z.number().min(0).max(1).default(0.1),
          deprecated_threshold: z.number().min(0).max(1).default(0.3),
          archived_threshold: z.number().min(0).max(1).default(0.1),
          archive_age_days: z.number().int().min(0).default(90),
          retention_days: z.number().int().min(0).default(365),
        })
        .optional()
        .describe("SDD-06 M-3 simple exponential + rehearsal decay config"),
      graduation: z
        .object({
          force_promote_access_count: z.number().int().min(0).default(5),
          semantic_shift_shadow: z.boolean().default(false),
        })
        .optional()
        .describe(
          "SDD-06 M-3 graduation config. force_promote_access_count=5 bounds " +
            "the gating bug; 0 disables force-promote. semantic_shift_shadow " +
            "logs SHADOW_METRIC events (training data, never gates).",
        ),
      scoring: z
        .object({
          w_semantic: z.number().min(0).max(1).default(0.3),
          w_role: z.number().min(0).max(1).default(0.1),
          w_confidence: z.number().min(0).max(1).default(0.2),
          w_provenance: z.number().min(0).max(1).default(0.1),
          w_recency: z.number().min(0).max(1).default(0.1),
          w_usage: z.number().min(0).max(1).default(0.1),
          w_lifecycle: z.number().min(0).max(1).default(0.1),
        })
        .optional()
        .describe("SDD-06 M-3 composite value scoring weights"),
      packing: z
        .object({
          budget_tokens: z
            .number()
            .int()
            .min(0)
            .default(1024)
            .describe(
              "SDD-07 M-4 context packing token budget. pack() fills the " +
                "system array with packed memory up to this many tokens. " +
                "Default 1024. When unset, pack defaults to 1024 (CP-10).",
            ),
          type_diversity: z
            .boolean()
            .default(true)
            .describe(
              "SDD-07 M-4 type diversity constraint. When true (default), " +
                "pack() includes at least one item per available node_type " +
                "before filling remaining budget with highest-scored items " +
                "(CP-09). When false, pack is pure greedy by score.",
            ),
          expansion_mode: z
            .enum(["hypergraph", "one_hop", "top_k"])
            .default("hypergraph")
            .describe(
              "SDD-07 M-4 expansion mode. 'hypergraph' (default) expands " +
                "through hyperedges via Hypergraph.query with depth=1 " +
                "(requires probe PASSED per CP-00). 'one_hop' = A3 fallback " +
                "(vector + 1-hop via SurrealBackend.query). 'top_k' = A6 " +
                "fallback (vector seeds only, no expansion — pack P95 > " +
                "300ms unfixable).",
            ),
        })
        .optional()
        .describe("SDD-07 M-4 context packing config (budget + diversity + expansion mode)"),
      scheduler: z
        .object({
          enabled: z.boolean().default(false),
          check_interval_seconds: z.number().int().min(1).default(60),
          max_concurrent_user_tasks: z.number().int().min(1).default(3),
          tasks: z
            .object({
              decay: z.object({ interval: z.string().default("hourly") }).optional(),
              consolidation: z.object({ interval: z.string().default("daily") }).optional(),
              graduation: z.object({ interval: z.string().default("daily") }).optional(),
              pruning: z.object({ interval: z.string().default("weekly") }).optional(),
              gc: z.object({ interval: z.string().default("weekly") }).optional(),
            })
            .optional()
            .describe(
              "SDD-06 M-3 memory maintenance task intervals (English labels: " +
                "hourly/daily/weekly — converted to cron by the scheduler)",
            ),
          pruning_schedule: z.string().default("0 3 * * *"),
          workforce_sync: z.string().default("0 */6 * * *"),
          transcript_cleanup: z.string().default("0 2 * * 0"),
        })
        .optional()
        .describe("SDD-06 M-3 memory-scoped scheduler config (tasks + intervals)"),
      graph_backend: z
        .enum(["sqlite", "neo4j", "surreal"])
        .default("sqlite")
        .describe(
          "Graph store backend for project/global memory tiers. " +
            "'sqlite' is the legacy default. " +
            "'surreal' is the recommended backend — embedded SurrealDB via @surrealdb/node, " +
            "vector + graph + text in one DB. " +
            "'neo4j' is the remote-server alternative.",
        ),
      migrate: z
        .object({
          dry_run: z
            .boolean()
            .default(false)
            .describe(
              "When true, migrateFromSqlite reports planned writes without taking them. " +
                "No marker file is created. Used as a guardrail before the actual migration.",
            ),
        })
        .optional()
        .describe("Phase M-0 migration guardrail config"),
      telemetry: z
        .object({
          window_hours: z
            .number()
            .int()
            .min(1)
            .default(48)
            .describe("Number of hourly buckets in the post-flag-flip telemetry gate"),
          p95_threshold_pct: z
            .number()
            .min(0)
            .default(10)
            .describe("Sustained P95 regression % that triggers ABORT A1"),
          p95_warn_pct: z
            .number()
            .min(0)
            .default(5)
            .describe("Sustained P95 regression % that triggers a warning (continued monitoring)"),
          test_window_seconds: z
            .number()
            .int()
            .min(1)
            .nullable()
            .default(null)
            .describe(
              "When set, replaces the 3600s hourly bucket with this many seconds (test mode). " +
                "Null in production.",
            ),
        })
        .optional()
        .describe("Phase M-0 telemetry gate config"),
      project_tags: z
        .array(z.string())
        .optional()
        .describe("Tags for scoped memory queries (match ANY)"),
      neo4j: z
        .object({
          uri: z.string().describe("Neo4j bolt URI"),
          username: z.string().default("neo4j"),
          password: z.string().describe("Neo4j password (use {env:NEO4J_PASSWORD})"),
        })
        .optional()
        .describe("Neo4j connection config (when graph_backend=neo4j)"),
      surreal: z
        .object({
          url: z.string().default("ws://127.0.0.1:8000"),
          username: z.string().default("root"),
          password: z.string().default("root"),
          namespace: z.string().default("foxybear"),
          database: z.string().default("memory"),
        })
        .optional()
        .describe("SurrealDB connection config (when graph_backend=surreal)"),
    })
    .optional()
    .describe("Persistent memory configuration"),
  persona: z
    .string()
    .optional()
    .describe("Default persona name for all sessions in this project"),
  owner: z
    .object({
      elevated: z
        .boolean()
        .default(false)
        .describe(
          "Whether this is Todd's declared process. Elevated processes preempt " +
            "busy peers, jump the scheduler queue, and (forward-compat) are " +
            "permitted to query all memory scopes. See spec16-finish §F and " +
            "docs/260427_foxybear_spec-elevated-privileges.md.",
        ),
    })
    .optional()
    .default({ elevated: false })
    .describe("Owner-elevation config for Todd's declared process (spec 16 §F)"),
  scheduler: z
    .object({
      enabled: z.boolean().default(false).describe("Enable cron scheduler (serve mode only)"),
      check_interval_seconds: z.number().int().min(1).default(60).describe("Cron evaluator tick interval"),
      max_concurrent_user_tasks: z.number().int().min(1).default(3).describe("Max concurrent user tasks"),
      pruning_schedule: z.string().default("0 3 * * *").describe("Cron for memory TTL pruning"),
      workforce_sync: z.string().default("0 */6 * * *").describe("Cron for workforce memory sync"),
      transcript_cleanup: z.string().default("0 2 * * 0").describe("Cron for old session cleanup"),
    })
    .optional(),
  mesh: z
    .object({
      enabled: z.boolean().default(false).describe("Enable mesh network"),
      name: z.string().default("").describe("Node name (defaults to hostname)"),
      secret: z.string().default("").describe("Shared secret for HMAC signing (use env reference)"),
      mdns: z.boolean().default(true).describe("Enable mDNS discovery"),
    })
    .optional(),
  atlassian: z
    .object({
      api_key: z.string().describe("Trello API key (use {file:path} reference)"),
      api_token: z.string().describe("Trello API token (use {file:path} reference)"),
    })
    .optional(),
  telegram: z
    .object({
      enabled: z.boolean().default(false).describe("Enable Telegram bot transport"),
      bot_token: z.string().optional().describe("Telegram bot token (use {env:TELEGRAM_BOT_TOKEN})"),
      allowed_chat_ids: z.array(z.string()).default([]).describe("Allowed Telegram chat IDs"),
      notify_chat_id: z.string().optional().describe("Chat ID for scheduled task notifications"),
      persona: z.string().default("katya").describe("Default persona for Telegram sessions"),
    })
    .optional(),
  voice: z
    .object({
      apiKeyEnv: z.string().default("ELEVENLABS_API_KEY").describe("Env var name OR {file:/path/to/keyfile} holding the ElevenLabs API key"),
      voiceId: z.string().default("xVQH621DS3eyBYrseRt5").describe("ElevenLabs voice id"),
      modelId: z.string().default("eleven_v3").describe("ElevenLabs model id"),
      stability: z.enum(["creative", "natural", "robust"]).default("natural").describe("Voice stability preset ('robust' is rejected at runtime)"),
      speed: z.number().min(0.7).max(1.2).default(1.0).describe("Playback speed"),
      similarityBoost: z.number().min(0).max(1).default(0.75).describe("Similarity boost"),
      speakerBoost: z.boolean().default(true).describe("Speaker boost"),
      style: z.number().min(0).max(1).default(0).describe("Style exaggeration"),
      language: z.string().default("en").describe("Output language"),
      playerPreference: z.string().optional().describe("Preferred audio player"),
      pronunciationDictionaryId: z.string().optional(),
      pronunciationDictionaryVersionId: z.string().optional(),
      outputFormat: z.string().default("mp3_44100_128").describe("Audio output format"),
      tagEmissionTempBoost: z.boolean().default(false),
      tagEmissionTempDelta: z.number().default(0),
      maxSentenceRetries: z.number().int().min(0).default(3).describe("Per-sentence retry budget"),
      autoStart: z.boolean().default(false).describe("Auto-enable voice on first assistant text delta"),
    })
    .optional()
    .describe("Katya voice/TTS configuration"),
}
