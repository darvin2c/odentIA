import { type ChannelProvider, channelAdapters } from "@odentia/channels"
import { withOrgContext } from "@odentia/db"
import {
  createConnection,
  getConnectionTemplates,
  listChannelTemplates,
  syncConnectionTemplates,
  listConnections,
  setConnectionStatus,
  testConnection,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const createInput = z.object({
  channel: z.string().min(1),
  provider: z.enum(["whatsapp_cloud_api", "telegram_bot_api", "messenger", "instagram", "gmail", "microsoft365", "web_chat"]),
  displayName: z.string().min(1).max(120),
  config: z.record(z.string(), z.unknown()),
})

function webhookUrl(base: string, provider: string, id: string): string {
  return `${base.replace(/\/$/, "")}/api/webhooks/channels/${provider}/${id}`
}

export function createConnectionsRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura de configuración"), 403)
    }
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
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
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

  /**
   * Metadatos de uso (sin secretos ni webhookUrl): lo consume el inbox para
   * elegir conexión y el composer para plantillas. Accesible con
   * conversations.read para que recepción opere sin settings.read.
   */
  app.get("/usable", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "conversations.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura de conversaciones"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const items = await listConnections(tx, orgId)
        return items
          .filter((item) => item.status === "active")
          .map((item) => ({
            id: item.id,
            channel: item.channel,
            provider: item.provider,
            displayName: item.displayName,
            externalId: item.externalId,
            status: item.status,
            capabilities: channelAdapters[item.provider as ChannelProvider]?.capabilities ?? null,
          }))
      }),
    )
  })

  app.get("/:id/templates", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    // Solo nombres e idiomas (sin secretos): el composer del inbox lo usa con
    // conversations.read cuando la ventana de 24h está cerrada.
    if (!canAccess(memberRole, "conversations.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura de conversaciones"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getConnectionTemplates(tx, orgId, c.req.param("id"), deps.secretsKey),
      ),
    )
  })

  /** Catálogo completo, con el estado que da el proveedor: para Configuración › Canales. */
  app.get("/:id/templates/catalog", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listChannelTemplates(tx, orgId, c.req.param("id"))),
    )
  })

  /** Vuelve a leer las plantillas de la cuenta del proveedor. */
  app.post("/:id/templates/sync", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        syncConnectionTemplates(tx, orgId, c.req.param("id"), deps.secretsKey, {
          fetch,
          validateExternal: deps.validateExternal,
        }),
      ),
    )
  })

  app.post("/:id/test", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        testConnection(tx, orgId, c.req.param("id"), deps.secretsKey, { fetch }),
      ),
    )
  })

  app.post("/:id/disable", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setConnectionStatus(tx, orgId, c.req.param("id"), "disabled"),
      ),
    )
  })

  app.post("/:id/enable", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de configuración"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setConnectionStatus(tx, orgId, c.req.param("id"), "active"),
      ),
    )
  })

  return app
}
