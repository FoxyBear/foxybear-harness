export * from "./client.js"
export * from "./server.js"

import { createFbhClient } from "./client.js"
import { createFbhServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createOpencode(options?: ServerOptions) {
  const server = await createFbhServer({
    ...options,
  })

  const client = createFbhClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
