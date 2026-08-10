import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { toggle, mute, getMode } from "@/voice/plugin"
import { Session } from "../../session"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const VoiceRoutes = lazy(() =>
  new Hono()
    .basePath("/voice")
    .post(
      "/toggle",
      describeRoute({
        summary: "Toggle voice",
        description: "Toggle voice output on/off for a session.",
        operationId: "voice.toggle",
        responses: {
          200: {
            description: "Toggle result",
            content: {
              "application/json": {
                schema: resolver(z.object({ message: z.string(), active: z.boolean() })),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", z.object({ sessionID: Session.get.schema })),
      async (c) => {
        const { sessionID } = c.req.valid("json")
        await Session.get(sessionID)
        const message = toggle(sessionID)
        const active = getMode(sessionID).active
        return c.json({ message, active })
      },
    )
    .post(
      "/mute",
      describeRoute({
        summary: "Mute voice",
        description: "Mute voice output for a session.",
        operationId: "voice.mute",
        responses: {
          200: {
            description: "Mute result",
            content: {
              "application/json": {
                schema: resolver(z.object({ message: z.string(), active: z.boolean() })),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", z.object({ sessionID: Session.get.schema })),
      async (c) => {
        const { sessionID } = c.req.valid("json")
        await Session.get(sessionID)
        const message = mute(sessionID)
        return c.json({ message, active: false })
      },
    ),
)
