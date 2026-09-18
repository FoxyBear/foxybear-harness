import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account"
import { AppFileSystem } from "../../src/filesystem"
import { Env } from "../../src/env"
import { tmpdir } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../../src/util/filesystem"
import { thresholds } from "../../src/session/overflow"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})

const emptyAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({}),
})

const layer = Config.layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provide(emptyAccount),
  Layer.provideMerge(infra),
)

const load = () =>
  Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(layer)))

const managedConfigDir = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!

beforeEach(async () => {
  await Effect.runPromise(
    Config.Service.use((svc) => svc.invalidate(true)).pipe(Effect.scoped, Effect.provide(layer)),
  )
})

afterEach(async () => {
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
  await Effect.runPromise(
    Config.Service.use((svc) => svc.invalidate(true)).pipe(Effect.scoped, Effect.provide(layer)),
  )
})

async function writeConfig(dir: string, config: object, name = "opencode.json") {
  await Filesystem.write(path.join(dir, name), JSON.stringify(config))
}

describe("compaction thresholds — defaults", () => {
  test("24. default thresholds — no config → tier1=0.8, tier2=0.9, tier3=0.95", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await load()
        const t = thresholds(cfg)
        expect(t.tier1).toBe(0.8)
        expect(t.tier2).toBe(0.9)
        expect(t.tier3).toBe(0.95)
      },
    })
  })
})

describe("compaction thresholds — custom", () => {
  test("25. custom thresholds — explicit values used correctly", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          compaction: {
            tier1_threshold: 0.7,
            tier2_threshold: 0.85,
            tier3_threshold: 0.9,
          },
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = await load()
        const t = thresholds(cfg)
        expect(t.tier1).toBe(0.7)
        expect(t.tier2).toBe(0.85)
        expect(t.tier3).toBe(0.9)
      },
    })
  })
})

describe("compaction thresholds — validation", () => {
  test("26a. all-explicit inversion — tier1=0.9, tier2=0.8 → validation error", async () => {
    const result = Config.Info.safeParse({
      compaction: {
        tier1_threshold: 0.9,
        tier2_threshold: 0.8,
        tier3_threshold: 0.95,
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("thresholds must satisfy"))).toBe(true)
    }
  })

  test("26b. partial-config-against-defaults inversion — { tier2_threshold: 0.7 } → error (0.7 < tier1 default 0.8)", async () => {
    const result = Config.Info.safeParse({
      compaction: {
        tier2_threshold: 0.7,
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("thresholds must satisfy"))).toBe(true)
    }
  })

  test("26. all-explicit inversion rejected through config service load", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          compaction: {
            tier1_threshold: 0.9,
            tier2_threshold: 0.8,
            tier3_threshold: 0.95,
          },
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(load()).rejects.toThrow()
      },
    })
  })

  test("26. partial-config-against-defaults inversion rejected through config service load", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          compaction: {
            tier2_threshold: 0.7,
          },
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(load()).rejects.toThrow()
      },
    })
  })
})

describe("compaction thresholds — refine rejection", () => {
  test("36a. explicit inversion — tier1 > tier2 → refine error message", async () => {
    const result = Config.Info.safeParse({
      compaction: {
        tier1_threshold: 0.9,
        tier2_threshold: 0.8,
        tier3_threshold: 0.95,
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("tier1 <= tier2 <= tier3"))).toBe(true)
    }
  })

  test("36b. partial-config-against-defaults inversion — tier2=0.7 < tier1 default 0.8 → refine error", async () => {
    const result = Config.Info.safeParse({
      compaction: {
        tier2_threshold: 0.7,
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("tier1 <= tier2 <= tier3"))).toBe(true)
    }
  })

  test("36. tier2 > tier3 inversion — tier2=0.95, tier3=0.9 → refine error", async () => {
    const result = Config.Info.safeParse({
      compaction: {
        tier2_threshold: 0.95,
        tier3_threshold: 0.9,
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("tier1 <= tier2 <= tier3"))).toBe(true)
    }
  })
})
