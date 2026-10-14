import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// Regression test for the missing dependency that silently killed voice.
// defaultFactory does `await import("@elevenlabs/elevenlabs-js")` — the
// package was never declared in package.json, so the import threw in the
// compiled binary (no bun auto-install), classify... voice degraded on
// the first sentence and stayed silent forever.

const PKG = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "package.json"), "utf-8"))

describe("ElevenLabs SDK dependency", () => {
  test("@elevenlabs/elevenlabs-js is declared in package.json", () => {
    expect(PKG.dependencies["@elevenlabs/elevenlabs-js"]).toBeDefined()
  })

  test("@elevenlabs/elevenlabs-js resolves and exports ElevenLabsClient", async () => {
    const mod = await import("@elevenlabs/elevenlabs-js")
    expect(mod.ElevenLabsClient).toBeDefined()
  })

  test("ElevenLabsClient constructs with an apiKey", async () => {
    const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js")
    const client = new ElevenLabsClient({ apiKey: "sk_test_regression" })
    expect(client).toBeDefined()
  })
})
