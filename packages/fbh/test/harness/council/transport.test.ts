import { afterEach, describe, expect, mock, test } from "bun:test"
import { callModel, getApiKey } from "@/harness/council/transport"
import type { ModelInfo } from "@/harness/council/prompts"

// CouncilTimeoutError does not exist yet (RED). Dynamic import keeps the file
// loadable so individual tests fail granularly instead of nuking the whole file.
const transport = await import("@/harness/council/transport")
const CouncilTimeoutError = (transport as unknown as { CouncilTimeoutError?: unknown }).CouncilTimeoutError as
  | (new (model: string, elapsedMs: number) => Error)
  | undefined

const realFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.fetch = realFetch
  globalThis.setTimeout = realSetTimeout
  mock.restore()
})

// Speed up retry backoff + the 180s request timeout so tests don't wait for real
// seconds. Every setTimeout callback fires after 1ms regardless of the delay arg.
function fastTimers() {
  globalThis.setTimeout = ((cb: (...a: unknown[]) => void, ..._rest: unknown[]) =>
    realSetTimeout(cb, 1) as unknown as number) as unknown as typeof setTimeout
}

function openaiResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function httpError(status: number, body: string): Response {
  return new Response(body, { status })
}

// A fetch that hangs until its abort signal fires, then rejects with a bare
// AbortError — exactly what a real fetch does when the controller aborts.
function hangingFetch(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (async (_input, init) => {
    const signal = init?.signal
    if (!signal) return new Promise<Response>(() => {})
    return new Promise<Response>((_, reject) => {
      if (signal.aborted) return reject(abortErr())
      signal.addEventListener("abort", () => reject(abortErr()), { once: true })
    })
  })
}

function abortErr(): Error {
  const e = new Error("The operation was aborted")
  e.name = "AbortError"
  return e
}

const gpt: ModelInfo = { id: "gpt-test", name: "GPT-Test", provider: "openai" }

describe("council transport: CouncilTimeoutError", () => {
  test("is a typed Error — instanceof Error and CouncilTimeoutError, name set", () => {
    expect(CouncilTimeoutError, "CouncilTimeoutError should be exported").toBeDefined()
    const err = new CouncilTimeoutError!("GPT-5.4", 180001)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CouncilTimeoutError!)
    expect(err.name).toBe("CouncilTimeoutError")
  })

  test("carries model name and elapsedMs", () => {
    const err = new CouncilTimeoutError!("GPT-5.4", 180001)
    expect((err as unknown as { model: string }).model).toBe("GPT-5.4")
    expect((err as unknown as { elapsedMs: number }).elapsedMs).toBe(180001)
  })
})

// retryFetch is not exported. We exercise it indirectly through callModel by
// mocking globalThis.fetch to throw specific errors and counting invocations.
describe("council transport: retryFetch (via callModel)", () => {
  test("retries CouncilTimeoutError then succeeds", async () => {
    fastTimers()
    expect(CouncilTimeoutError, "CouncilTimeoutError must exist for this test").toBeDefined()
    const toErr = new CouncilTimeoutError!("GPT-Test", 180001)
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      if (calls < 3) throw toErr
      return openaiResponse("ok")
    }) as unknown as typeof fetch

    const out = await callModel(gpt, "k", "sys", "usr")
    expect(out).toBe("ok")
    expect(calls).toBe(3)
  })

  test("does NOT retry a bare AbortError", async () => {
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      throw abortErr()
    }) as unknown as typeof fetch

    await expect(callModel(gpt, "k", "sys", "usr")).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test("retries HTTP 429", async () => {
    fastTimers()
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      if (calls < 3) return httpError(429, "rate limited")
      return openaiResponse("ok")
    }) as unknown as typeof fetch

    const out = await callModel(gpt, "k", "sys", "usr")
    expect(out).toBe("ok")
    expect(calls).toBe(3)
  })

  test("retries HTTP 503", async () => {
    fastTimers()
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      if (calls < 3) return httpError(503, "unavailable")
      return openaiResponse("ok")
    }) as unknown as typeof fetch

    const out = await callModel(gpt, "k", "sys", "usr")
    expect(out).toBe("ok")
    expect(calls).toBe(3)
  })

  test("does NOT retry HTTP 400", async () => {
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      return httpError(400, "bad request")
    }) as unknown as typeof fetch

    await expect(callModel(gpt, "k", "sys", "usr")).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test("exhausts retries and throws the last CouncilTimeoutError", async () => {
    fastTimers()
    expect(CouncilTimeoutError).toBeDefined()
    const toErr = new CouncilTimeoutError!("GPT-Test", 180001)
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      throw toErr
    }) as unknown as typeof fetch

    await expect(callModel(gpt, "k", "sys", "usr")).rejects.toBeInstanceOf(CouncilTimeoutError!)
    expect(calls).toBe(3)
  })
})

describe("council transport: callModel timeout vs cancel", () => {
  test("throws CouncilTimeoutError when the 180s request timeout fires", async () => {
    fastTimers()
    expect(CouncilTimeoutError).toBeDefined()
    globalThis.fetch = hangingFetch() as unknown as typeof fetch

    await expect(callModel(gpt, "k", "sys", "usr")).rejects.toBeInstanceOf(CouncilTimeoutError!)
  })

  test("propagates a bare AbortError when an external signal aborts", async () => {
    fastTimers()
    const controller = new AbortController()
    let calls = 0
    globalThis.fetch = mock(async (_input, init) => {
      calls++
      const signal = init?.signal
      if (!signal) return openaiResponse("ok")
      return new Promise<Response>((_, reject) => {
        if (signal.aborted) return reject(abortErr())
        signal.addEventListener("abort", () => reject(abortErr()), { once: true })
      })
    }) as unknown as typeof fetch

    // Abort AFTER callModel is in flight: the external-signal listener is
    // registered before `await fetch` yields, so aborting here propagates to
    // the internal controller before the (fake, 1ms) request timeout fires.
    const pending = callModel(gpt, "k", "sys", "usr", controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toBe(1)
  })

  test("retries on timeout then succeeds on the second call", async () => {
    fastTimers()
    let calls = 0
    globalThis.fetch = mock(async (_input, init) => {
      calls++
      const signal = init?.signal
      // First call: hang until the request timeout aborts it (→ CouncilTimeoutError → retry).
      // Second call: resolve immediately with content (beats the 1ms fake timer).
      if (calls === 1) {
        return new Promise<Response>((_, reject) => {
          if (!signal) return reject(new Error("no signal"))
          if (signal.aborted) return reject(abortErr())
          signal.addEventListener("abort", () => reject(abortErr()), { once: true })
        })
      }
      return openaiResponse("recovered")
    }) as unknown as typeof fetch

    const out = await callModel(gpt, "k", "sys", "usr")
    expect(out).toBe("recovered")
    expect(calls).toBe(2)
  })
})

describe("council transport: getApiKey sanity", () => {
  test("throws a clear error for an unknown provider", () => {
    expect(() => getApiKey("no-such-provider-xyz")).toThrow(/No API key/)
  })
})
