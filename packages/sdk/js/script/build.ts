#!/usr/bin/env bun
//
// NOTE (FoxyBear rebrand): The openapi.json at packages/sdk/openapi.json was
// sed-renamed (opencode → fbh) but NOT regenerated from the actual server
// routes. Before publishing @foxybear/sdk or building an external consumer
// (mobile app, partner SDK, web client), run this script to regenerate:
//
//   ./packages/sdk/js/script/build.ts
//
// This requires a running fbh server (the `bun dev generate` command below
// starts one). The regenerated file will reflect the actual routes, not the
// sed-renamed approximation.
//
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

await $`bun dev generate > ${dir}/openapi.json`.cwd(path.resolve(dir, "../../fbh"))

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "FbhClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
