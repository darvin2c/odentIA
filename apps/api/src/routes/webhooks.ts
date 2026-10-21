import {
  type ChannelProvider,
  channelAdapters,
  splitWhatsAppWebhook,
  verifyMetaChallenge,
  verifyMetaSignature,
  type WebhookParseResult,
} from "@odentia/channels"
import { type Db, sendInboundMessage, withOrgContext } from "@odentia/db"
import { channelConnection, inboundEvent } from "@odentia/db/schema/crm"
import { applyStatus, applyTemplateCategories, applyTemplateUpdates, decryptConfig, markWebhookVerified } from "@odentia/services"
import { and, eq, isNotNull } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { errorBody } from "../lib/error.js"

export interface WebhookDeps {
  /** Rol owner: SOLO para leer la conexión (la URL no trae org y la tabla
   * tiene RLS), ledger de dedupe y encolado. Nunca para datos de tenant. */
  ownerDb: Db
  /** Rol app: aplica estados, y anota la verificación de la dirección, dentro del contexto RLS de la org. */
  db: Db
  secretsKey: Buffer
  /**
   * La app de odentIA en Meta, si está configurada: con su clave secreta se
   * verifican los avisos de las cuentas conectadas con «Conectar con Facebook»
   * y con `verifyToken` se responde el reto de su dirección. Sin ella esa
   * dirección no existe.
   */
  metaApp?: { appSecret: string; verifyToken: string } | undefined
}

// El chat web no entra por aquí: sus mensajes llegan por `/api/webchat` con la
// sesión del visitante. Su código firma los avisos que salen al sitio y lo
// conoce quien hace la web: no puede servir para escribir como un visitante.
const providerParam = z.enum([
  "whatsapp_cloud_api",
  "telegram_bot_api",
  "messenger",
  "instagram",
  "gmail",
  "microsoft365",
])

/** La conexión a la que pertenece un aviso: lo justo para repartirlo. */
interface Target {
  id: string
  organizationId: string
}

/**
 * Webhooks de proveedor. Sin sesión ni contexto de org (llama el proveedor).
 * Todo el procesamiento pesado ocurre en el worker bajo RLS; aquí solo se
 * valida firma, se hace dedupe por ledger y se encola.
 */
export function createWebhooksRoute(deps: WebhookDeps) {
  const app = new Hono()

  /**
   * El camino de todo aviso ya verificado, llegue por la dirección de una
   * conexión o por la de la app de odentIA: libro de duplicados, estados,
   * cambios de plantilla y encolado de mensajes.
   */
  async function ingest(provider: ChannelProvider, connection: Target, parsed: WebhookParseResult) {
    const orgId = connection.organizationId

    for (const status of parsed.statuses) {
      // Sin timestamp en NormalizedStatus: el par (mensaje, estado) es único
      // por transición; los reintentos del proveedor traen el mismo estado.
      const eventId = `status:${status.externalMessageId}:${status.status}`
      const inserted = await deps.ownerDb
        .insert(inboundEvent)
        .values({ provider, externalEventId: eventId })
        .onConflictDoNothing()
        .returning({ id: inboundEvent.id })
      if (inserted.length === 0) continue
      await withOrgContext(deps.db, orgId, (tx) => applyStatus(tx, orgId, [status]).then(() => {}))
    }

    if (parsed.templateStatuses?.length) {
      const updates = parsed.templateStatuses
      await withOrgContext(deps.db, orgId, (tx) =>
        applyTemplateUpdates(tx, orgId, connection.id, updates).then(() => {}),
      )
    }

    // La categoría manda (ADR 0040): un aviso que Meta pasa a promoción solo sale a quien aceptó novedades.
    if (parsed.templateCategories?.length) {
      const updates = parsed.templateCategories
      await withOrgContext(deps.db, orgId, (tx) =>
        applyTemplateCategories(tx, orgId, connection.id, updates).then(() => {}),
      )
    }

    for (const event of parsed.messages) {
      const inserted = await deps.ownerDb
        .insert(inboundEvent)
        .values({ provider, externalEventId: event.externalEventId })
        .onConflictDoNothing()
        .returning({ id: inboundEvent.id })
      if (inserted.length === 0) continue
      await sendInboundMessage(deps.ownerDb, { orgId, connectionId: connection.id, event })
    }
  }

  // ---- la dirección de la app de odentIA (cuentas conectadas con «Conectar con Facebook») ----
  // Registradas antes que las rutas con parámetros: `/meta/whatsapp` no es una conexión.

  /**
   * Reto de verificación al dar de alta la dirección en la app de odentIA:
   * `hub.verify_token` debe ser el de la plataforma (`META_WEBHOOK_VERIFY_TOKEN`).
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
   */
  app.get("/meta/whatsapp", (c) => {
    if (!deps.metaApp) return c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404)
    const challenge = verifyMetaChallenge(
      {
        mode: c.req.query("hub.mode") ?? null,
        token: c.req.query("hub.verify_token") ?? null,
        challenge: c.req.query("hub.challenge") ?? null,
      },
      deps.metaApp.verifyToken,
    )
    if (challenge === null) return c.json(errorBody(c, "FORBIDDEN", "Verificación inválida"), 403)
    return c.text(challenge, 200)
  })

  /**
   * Avisos de todas las cuentas suscritas a la app de odentIA: una sola
   * dirección, firmada con la clave secreta de la app, que puede traer cambios
   * de varias clínicas en el mismo envío. Cada cambio se reparte a su conexión:
   * los mensajes y estados por el número que los recibió y los cambios de
   * plantilla por su cuenta. No se usan direcciones alternas por cuenta o por
   * número: con ellas una cuenta con dos números se repartiría mal, y los
   * cambios de plantilla llegan aquí de todos modos.
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override
   *
   * Solo reciben por aquí las conexiones hechas con el botón; una hecha a mano
   * sigue con su propia dirección y la clave de su propia app. Lo que no es de
   * ninguna conexión se descarta dejando registro y se responde 200: Meta
   * reintenta durante 7 días lo que no recibe un 200.
   *
   * Sin probar contra Meta: la app de odentIA todavía no existe.
   */
  app.post("/meta/whatsapp", async (c) => {
    if (!deps.metaApp) return c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404)
    const rawBody = await c.req.text().catch(() => "")
    if (!verifyMetaSignature(c.req.header(), rawBody, deps.metaApp.appSecret)) {
      return c.json(errorBody(c, "UNAUTHORIZED", "Firma inválida"), 401)
    }
    const provider: ChannelProvider = "whatsapp_cloud_api"
    for (const delivery of splitWhatsAppWebhook(rawBody)) {
      if (delivery.kind === "number") {
        const [connection] = await deps.ownerDb
          .select({
            id: channelConnection.id,
            organizationId: channelConnection.organizationId,
            status: channelConnection.status,
          })
          .from(channelConnection)
          .where(
            and(
              eq(channelConnection.provider, provider),
              eq(channelConnection.externalId, delivery.phoneNumberId),
              isNotNull(channelConnection.signup),
            ),
          )
          .limit(1)
        if (connection?.status !== "active") {
          console.warn(
            `[webhooks] aviso de WhatsApp descartado: el número ${delivery.phoneNumberId} no es de una conexión activa hecha con el botón`,
          )
          continue
        }
        await ingest(provider, connection, { messages: delivery.messages, statuses: delivery.statuses })
        continue
      }
      // Una cuenta puede tener más de un número conectado: el cambio vale para todos.
      const connections = await deps.ownerDb
        .select({
          id: channelConnection.id,
          organizationId: channelConnection.organizationId,
          status: channelConnection.status,
          signup: channelConnection.signup,
        })
        .from(channelConnection)
        .where(
          and(
            eq(channelConnection.provider, provider),
            eq(channelConnection.accountExternalId, delivery.accountId),
          ),
        )
      // Solo donde Meta confirmó la suscripción con el permiso de esa clínica:
      // así nadie recibe los cambios de una cuenta sobre la que no tiene permiso.
      const subscribed = connections.filter(
        (connection) => connection.status === "active" && connection.signup?.subscribedAt,
      )
      if (subscribed.length === 0) {
        console.warn(
          `[webhooks] cambio de plantilla descartado: la cuenta ${delivery.accountId} no es de una conexión activa y suscrita`,
        )
        continue
      }
      for (const connection of subscribed) {
        await ingest(provider, connection, {
          messages: [],
          statuses: [],
          templateStatuses: delivery.templateStatuses,
          templateCategories: delivery.templateCategories,
        })
      }
    }
    return c.json({ ok: true }, 200)
  })

  // ---- la dirección de cada conexión ----

  // Reto de verificación de Meta (WhatsApp/Messenger/Instagram):
  // hub.verify_token debe ser el webhookSecret generado al crear la conexión.
  // Al superarlo queda anotado cuándo: la pantalla del alta a mano lo detecta sola.
  app.get("/channels/:provider/:connectionId", async (c) => {
    const parsed = providerParam.safeParse(c.req.param("provider"))
    if (!parsed.success) return c.json(errorBody(c, "VALIDATION", "Proveedor inválido"), 400)
    if (
      parsed.data !== "whatsapp_cloud_api" &&
      parsed.data !== "messenger" &&
      parsed.data !== "instagram"
    ) {
      return c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404)
    }
    const [connection] = await deps.ownerDb
      .select({
        id: channelConnection.id,
        organizationId: channelConnection.organizationId,
        provider: channelConnection.provider,
        webhookSecret: channelConnection.webhookSecret,
      })
      .from(channelConnection)
      .where(eq(channelConnection.id, c.req.param("connectionId")))
      .limit(1)
    if (!connection || connection.provider !== parsed.data) {
      return c.json(errorBody(c, "FORBIDDEN", "Verificación inválida"), 403)
    }
    const challenge = verifyMetaChallenge(
      {
        mode: c.req.query("hub.mode") ?? null,
        token: c.req.query("hub.verify_token") ?? null,
        challenge: c.req.query("hub.challenge") ?? null,
      },
      connection.webhookSecret,
    )
    if (challenge === null) {
      return c.json(errorBody(c, "FORBIDDEN", "Verificación inválida"), 403)
    }
    await withOrgContext(deps.db, connection.organizationId, (tx) =>
      markWebhookVerified(tx, connection.organizationId, connection.id),
    )
    return c.text(challenge, 200)
  })

  app.post("/channels/:provider/:connectionId", async (c) => {
    const providerRaw = c.req.param("provider")
    const parsed = providerParam.safeParse(providerRaw)
    if (!parsed.success) return c.json(errorBody(c, "VALIDATION", "Proveedor inválido"), 400)
    const provider: ChannelProvider = parsed.data
    const adapter = channelAdapters[provider]
    // Proveedor válido pero sin adaptador registrado (slice pendiente):
    // 400 para distinguirlo del 200 de dedupe/desactivada.
    if (!adapter) return c.json(errorBody(c, "VALIDATION", "Proveedor no registrado"), 400)

    const [connection] = await deps.ownerDb
      .select()
      .from(channelConnection)
      .where(eq(channelConnection.id, c.req.param("connectionId")))
      .limit(1)
    // 200 aunque no exista/desactivada: el proveedor no debe reintentar.
    if (!connection || connection.status !== "active" || connection.provider !== provider) {
      return c.json({ ok: true }, 200)
    }
    let config: Record<string, unknown>
    try {
      config = decryptConfig(deps.secretsKey, connection.configEncrypted)
    } catch {
      return c.json({ ok: true }, 200)
    }

    const rawBody = await c.req.text().catch(() => "")
    const verified = adapter.verifyWebhook({
      headers: c.req.header(),
      rawBody,
      config,
      webhookSecret: connection.webhookSecret,
    })
    if (!verified) {
      return c.json(errorBody(c, "UNAUTHORIZED", "Firma inválida"), 401)
    }

    await ingest(provider, connection, adapter.parseWebhook({ headers: c.req.header(), rawBody, config }))

    // 200 siempre tras encolar: los errores de procesamiento son del worker.
    return c.json({ ok: true }, 200)
  })

  return app
}
