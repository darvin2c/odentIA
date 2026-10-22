import { type ChannelProvider, channelAdapters } from "@odentia/channels"
import { withOrgContext } from "@odentia/db"
import {
  changeConnectionCredentials,
  checkMessageText,
  connectionWebhookUrl,
  createClinicMessage,
  createConnection,
  deleteClinicMessage,
  getConnectionSetup,
  listClinicMessages,
  listConnections,
  listConnectionsOverview,
  revertMessageText,
  saveMessageText,
  setConnectionStatus,
  syncConnectionAccount,
  testConnection,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

// El chat web no se crea aquí: hay uno por clínica y nace solo (`getClinicWebchat`).
const createInput = z.object({
  channel: z.string().min(1),
  provider: z.enum([
    "whatsapp_cloud_api",
    "telegram_bot_api",
    "messenger",
    "instagram",
    "gmail",
    "microsoft365",
  ]),
  // Si falta, la conexión toma el nombre con el que el proveedor conoce la cuenta.
  displayName: z.string().max(120).optional(),
  config: z.record(z.string(), z.unknown()),
})

const credentialsInput = z.object({ config: z.record(z.string(), z.unknown()) })

// Los límites del texto los dice el servicio con sus palabras; aquí solo se
// acota el tamaño de lo que entra.
const checkInput = z.object({
  messageId: z.string().min(1).max(80).optional(),
  title: z.string().max(400).optional(),
  body: z.string().max(8000),
  buttonTitle: z.string().max(200).optional(),
})

const textInput = z.object({ body: z.string().max(8000) })

const messageInput = z.object({
  title: z.string().max(400),
  body: z.string().max(8000),
  buttonTitle: z.string().max(200).optional(),
})

export function createConnectionsRoute(deps: CrmDeps) {
  const app = new Hono()
  const providerDeps = {
    fetch,
    validateExternal: deps.validateExternal,
    webhookBaseUrl: deps.webhookBaseUrl,
  }
  const writeDeps = { fetch, validateExternal: deps.validateExternal, secretsKey: deps.secretsKey }

  /** Configuración: leer la ven quienes pueden abrirla; cambiarla, quienes la administran. */
  const forbidden = (c: Context, permission: "settings.read" | "settings.write") => {
    const { memberRole } = orgContextOf(c)
    if (canAccess(memberRole, permission)) return null
    return c.json(
      errorBody(
        c,
        "FORBIDDEN",
        permission === "settings.read"
          ? "Sin permiso de lectura de configuración"
          : "Sin permiso de configuración",
      ),
      403,
    )
  }

  app.get("/", async (c) => {
    const denied = forbidden(c, "settings.read")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const items = await listConnectionsOverview(tx, orgId)
        return items.map((item) => ({
          ...item,
          capabilities: channelAdapters[item.provider as ChannelProvider]?.capabilities ?? null,
          webhookUrl: connectionWebhookUrl(deps.webhookBaseUrl, item.provider, item.id),
        }))
      }),
    )
  })

  app.post("/", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const created = await createConnection(
          tx,
          orgId,
          deps.secretsKey,
          parsed.data,
          providerDeps,
        )
        return {
          ...created,
          webhookUrl: connectionWebhookUrl(deps.webhookBaseUrl, parsed.data.provider, created.id),
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

  /** «Actualizar»: relee la cuenta del proveedor, pide lo que falte y refresca la salud del número. */
  app.post("/:id/templates/sync", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        syncConnectionAccount(tx, orgId, c.req.param("id"), deps.secretsKey, providerDeps),
      ),
    )
  })

  /** Prueba la conexión y dice qué encontró. No cambia su nombre ni su estado. */
  app.post("/:id/test", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        testConnection(tx, orgId, c.req.param("id"), deps.secretsKey, providerDeps),
      ),
    )
  })

  /** Cambia la clave sin crear otra conexión: la misma cuenta, su dirección y sus conversaciones. */
  app.post("/:id/credentials", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    const parsed = credentialsInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        changeConnectionCredentials(
          tx,
          orgId,
          c.req.param("id"),
          deps.secretsKey,
          parsed.data,
          providerDeps,
        ),
      ),
    )
  })

  /**
   * Alta a mano de un canal de Meta: la dirección y la clave de verificación
   * (siempre a la vista), si Meta ya verificó y si ya entró un mensaje. Lleva
   * un secreto de la conexión: solo para quien administra la configuración.
   */
  app.get("/:id/setup", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getConnectionSetup(tx, orgId, c.req.param("id"), deps.webhookBaseUrl),
      ),
    )
  })

  app.post("/:id/disable", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setConnectionStatus(tx, orgId, c.req.param("id"), "disabled"),
      ),
    )
  })

  app.post("/:id/enable", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setConnectionStatus(tx, orgId, c.req.param("id"), "active", {
          secretsKey: deps.secretsKey,
          deps: providerDeps,
        }),
      ),
    )
  })

  // ---- los mensajes de WhatsApp de la clínica ---------------------------------

  app.get("/:id/messages", async (c) => {
    const denied = forbidden(c, "settings.read")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listClinicMessages(tx, orgId, c.req.param("id"))),
    )
  })

  /** Comprueba un texto mientras se escribe. No guarda ni pide nada. */
  app.post("/:id/messages/check", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    const parsed = checkInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        checkMessageText(tx, orgId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/:id/messages", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId, userId } = orgContextOf(c)
    const parsed = messageInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createClinicMessage(tx, orgId, c.req.param("id"), userId, parsed.data, writeDeps),
      ),
    )
  })

  app.put("/:id/messages/:messageId/text", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId, userId } = orgContextOf(c)
    const parsed = textInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        saveMessageText(
          tx,
          orgId,
          c.req.param("id"),
          userId,
          c.req.param("messageId"),
          parsed.data.body,
          writeDeps,
        ),
      ),
    )
  })

  app.post("/:id/messages/:messageId/revert", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        revertMessageText(
          tx,
          orgId,
          c.req.param("id"),
          userId,
          c.req.param("messageId"),
          writeDeps,
        ),
      ),
    )
  })

  app.delete("/:id/messages/:messageId", async (c) => {
    const denied = forbidden(c, "settings.write")
    if (denied) return denied
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        deleteClinicMessage(
          tx,
          orgId,
          c.req.param("id"),
          userId,
          c.req.param("messageId"),
          writeDeps,
        ),
      ),
    )
  })

  return app
}
