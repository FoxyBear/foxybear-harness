declare global {
  const FBH_VERSION: string
  const FBH_CHANNEL: string
}

export const VERSION = typeof FBH_VERSION === "string" ? FBH_VERSION : "local"
export const CHANNEL = typeof FBH_CHANNEL === "string" ? FBH_CHANNEL : "local"
