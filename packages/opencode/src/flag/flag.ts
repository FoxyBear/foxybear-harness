import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

export namespace Flag {
  export const OTEL_EXPORTER_OTLP_ENDPOINT = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  export const OTEL_EXPORTER_OTLP_HEADERS = process.env["OTEL_EXPORTER_OTLP_HEADERS"]

  export const FBH_AUTO_SHARE = truthy("FBH_AUTO_SHARE")
  export const FBH_AUTO_HEAP_SNAPSHOT = truthy("FBH_AUTO_HEAP_SNAPSHOT")
  export const FBH_GIT_BASH_PATH = process.env["FBH_GIT_BASH_PATH"]
  export const FBH_CONFIG = process.env["FBH_CONFIG"]
  export declare const FBH_PURE: boolean
  export declare const FBH_TUI_CONFIG: string | undefined
  export declare const FBH_CONFIG_DIR: string | undefined
  export declare const FBH_PLUGIN_META_FILE: string | undefined
  export const FBH_CONFIG_CONTENT = process.env["FBH_CONFIG_CONTENT"]
  export const FBH_DISABLE_AUTOUPDATE = truthy("FBH_DISABLE_AUTOUPDATE")
  export const FBH_ALWAYS_NOTIFY_UPDATE = truthy("FBH_ALWAYS_NOTIFY_UPDATE")
  export const FBH_DISABLE_PRUNE = truthy("FBH_DISABLE_PRUNE")
  export const FBH_DISABLE_TERMINAL_TITLE = truthy("FBH_DISABLE_TERMINAL_TITLE")
  export const FBH_SHOW_TTFD = truthy("FBH_SHOW_TTFD")
  export const FBH_PERMISSION = process.env["FBH_PERMISSION"]
  export const FBH_DISABLE_DEFAULT_PLUGINS = truthy("FBH_DISABLE_DEFAULT_PLUGINS")
  export const FBH_DISABLE_LSP_DOWNLOAD = truthy("FBH_DISABLE_LSP_DOWNLOAD")
  export const FBH_ENABLE_EXPERIMENTAL_MODELS = truthy("FBH_ENABLE_EXPERIMENTAL_MODELS")
  export const FBH_DISABLE_AUTOCOMPACT = truthy("FBH_DISABLE_AUTOCOMPACT")
  export const FBH_DISABLE_MODELS_FETCH = truthy("FBH_DISABLE_MODELS_FETCH")
  export const FBH_DISABLE_MOUSE = truthy("FBH_DISABLE_MOUSE")
  export const FBH_DISABLE_CLAUDE_CODE = truthy("FBH_DISABLE_CLAUDE_CODE")
  export const FBH_DISABLE_CLAUDE_CODE_PROMPT =
    FBH_DISABLE_CLAUDE_CODE || truthy("FBH_DISABLE_CLAUDE_CODE_PROMPT")
  export const FBH_DISABLE_CLAUDE_CODE_SKILLS =
    FBH_DISABLE_CLAUDE_CODE || truthy("FBH_DISABLE_CLAUDE_CODE_SKILLS")
  export const FBH_DISABLE_EXTERNAL_SKILLS =
    FBH_DISABLE_CLAUDE_CODE_SKILLS || truthy("FBH_DISABLE_EXTERNAL_SKILLS")
  export declare const FBH_DISABLE_PROJECT_CONFIG: boolean
  export const FBH_FAKE_VCS = process.env["FBH_FAKE_VCS"]
  export declare const FBH_CLIENT: string
  export const FBH_SERVER_PASSWORD = process.env["FBH_SERVER_PASSWORD"]
  export const FBH_SERVER_USERNAME = process.env["FBH_SERVER_USERNAME"]
  export const FBH_ENABLE_QUESTION_TOOL = truthy("FBH_ENABLE_QUESTION_TOOL")

  // Experimental
  export const FBH_EXPERIMENTAL = truthy("FBH_EXPERIMENTAL")
  export const FBH_EXPERIMENTAL_FILEWATCHER = Config.boolean("FBH_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  )
  export const FBH_EXPERIMENTAL_DISABLE_FILEWATCHER = Config.boolean(
    "FBH_EXPERIMENTAL_DISABLE_FILEWATCHER",
  ).pipe(Config.withDefault(false))
  export const FBH_EXPERIMENTAL_ICON_DISCOVERY =
    FBH_EXPERIMENTAL || truthy("FBH_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["FBH_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const FBH_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("FBH_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const FBH_ENABLE_EXA =
    truthy("FBH_ENABLE_EXA") || FBH_EXPERIMENTAL || truthy("FBH_EXPERIMENTAL_EXA")
  export const FBH_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("FBH_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const FBH_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("FBH_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const FBH_EXPERIMENTAL_OXFMT = FBH_EXPERIMENTAL || truthy("FBH_EXPERIMENTAL_OXFMT")
  export const FBH_EXPERIMENTAL_LSP_TY = truthy("FBH_EXPERIMENTAL_LSP_TY")
  export const FBH_EXPERIMENTAL_LSP_TOOL = FBH_EXPERIMENTAL || truthy("FBH_EXPERIMENTAL_LSP_TOOL")
  export const FBH_DISABLE_FILETIME_CHECK = Config.boolean("FBH_DISABLE_FILETIME_CHECK").pipe(
    Config.withDefault(false),
  )
  export const FBH_EXPERIMENTAL_PLAN_MODE = FBH_EXPERIMENTAL || truthy("FBH_EXPERIMENTAL_PLAN_MODE")
  export const FBH_EXPERIMENTAL_WORKSPACES = FBH_EXPERIMENTAL || truthy("FBH_EXPERIMENTAL_WORKSPACES")
  export const FBH_EXPERIMENTAL_MARKDOWN = !falsy("FBH_EXPERIMENTAL_MARKDOWN")
  export const FBH_MODELS_URL = process.env["FBH_MODELS_URL"]
  export const FBH_MODELS_PATH = process.env["FBH_MODELS_PATH"]
  export const FBH_DISABLE_EMBEDDED_WEB_UI = truthy("FBH_DISABLE_EMBEDDED_WEB_UI")
  export const FBH_DB = process.env["FBH_DB"]
  export const FBH_DISABLE_CHANNEL_DB = truthy("FBH_DISABLE_CHANNEL_DB")
  export const FBH_SKIP_MIGRATIONS = truthy("FBH_SKIP_MIGRATIONS")
  export const FBH_STRICT_CONFIG_DEPS = truthy("FBH_STRICT_CONFIG_DEPS")

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for FBH_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "FBH_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("FBH_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for FBH_TUI_CONFIG
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "FBH_TUI_CONFIG", {
  get() {
    return process.env["FBH_TUI_CONFIG"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for FBH_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "FBH_CONFIG_DIR", {
  get() {
    return process.env["FBH_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for FBH_PURE
// This must be evaluated at access time, not module load time,
// because the CLI can set this flag at runtime
Object.defineProperty(Flag, "FBH_PURE", {
  get() {
    return truthy("FBH_PURE")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for FBH_PLUGIN_META_FILE
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "FBH_PLUGIN_META_FILE", {
  get() {
    return process.env["FBH_PLUGIN_META_FILE"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for FBH_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "FBH_CLIENT", {
  get() {
    return process.env["FBH_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
