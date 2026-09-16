import { type ChannelProvider, channelAdapters } from "@odentia/channels"
import { withOrgContext } from "@odentia/db"
import {
  createConnection,
  getConnectionTemplates,
  listConnections,
  setConnectionStatus,
  testConnection,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canWrite, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const createInput = z.object({
  channel: z.string().min(1),
  provider: z.enum(["whatsapp_cloud_api", "telegram_bot_api"]),
  displayName: z.string().min(1).max(120),
  config: z.record(z.string(), z.unknown()),
})

function webhookUrl(base: string, provider: string, id: string): string {
  return `${base.replace(/\/$/, "")}/api/webhooks/channels/${provider}/${id}`
}

export function createConnectionsRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const items = await listConnections(tx, orgId)
        return items.map((item) => ({
          ...item,
          capabilities: channelAdapters[item.provider as ChannelProvider]?.capabilities ?? null,
          webhookUrl: webhookUrl(deps.webhookBaseUrl, item.provider, item.id),
        }))
      }),
    )
  })

  app.post("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const created = await createConnection(tx, orgId, deps.secretsKey, parsed.data, {
          fetch,
          validateExternal: deps.validateExternal,
        })
        return {
          ...created,
          webhookUrl: webhookUrl(deps.webhookBaseUrl, parsed.data.provider, created.id),
        }
      }),
    )
  })

  app.get("/:id/templates", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getConnectionTemplates(tx, orgId, c.req.param("id"), deps.secretsKey),
      ),
    )
  })

  app.post("/:id/test", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        testConnection(tx, orgId, c.req.param("id"), deps.secretsKey, { fetch }),
      ),
    )
  })

  app.post("/:id/disable", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setConnectionStatus(tx, orgId, c.req.param("id"), "disabled"),
      ),
    )
  })

  app.post("/:id/enable", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setConnectionStatus(tx, orgId, c.req.param("id"), "active"),
      ),
    )
  })

  return app
}
