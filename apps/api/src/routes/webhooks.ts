import { channelAdapters, type ChannelProvider } from "@odentia/channels";
import { sendInboundMessage, withOrgContext, type Db } from "@odentia/db";
import { channelConnection, inboundEvent } from "@odentia/db/schema/crm";
import { applyStatus, decryptConfig } from "@odentia/services";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { errorBody } from "../lib/error.js";

export interface WebhookDeps {
  /** Rol owner: SOLO para leer la conexión (la URL no trae org y la tabla
   * tiene RLS), ledger de dedupe y encolado. Nunca para datos de tenant. */
  ownerDb: Db;
  /** Rol app: aplica estados dentro del contexto RLS de la org. */
  db: Db;
  secretsKey: Buffer;
}

const providerParam = z.enum(["whatsapp_cloud_api", "telegram_bot_api"]);

/**
 * Webhooks de proveedor. Sin sesión ni contexto de org (llama el proveedor).
 * Todo el procesamiento pesado ocurre en el worker bajo RLS; aquí solo se
 * valida firma, se hace dedupe por ledger y se encola.
 */
export function createWebhooksRoute(deps: WebhookDeps) {
  const app = new Hono();

  // Reto de verificación de WhatsApp (Meta): hub.verify_token debe ser el
  // webhookSecret generado al crear la conexión.
  app.get("/channels/:provider/:connectionId", async (c) => {
    const parsed = providerParam.safeParse(c.req.param("provider"));
    if (!parsed.success) return c.json(errorBody(c, "VALIDATION", "Proveedor inválido"), 400);
    if (parsed.data !== "whatsapp_cloud_api") {
      return c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404);
    }
    const [connection] = await deps.ownerDb
      .select({ webhookSecret: channelConnection.webhookSecret })
      .from(channelConnection)
      .where(eq(channelConnection.id, c.req.param("connectionId")))
      .limit(1);
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && token && connection && token === connection.webhookSecret && challenge) {
      return c.text(challenge, 200);
    }
    return c.json(errorBody(c, "FORBIDDEN", "Verificación inválida"), 403);
  });

  app.post("/channels/:provider/:connectionId", async (c) => {
    const providerRaw = c.req.param("provider");
    const parsed = providerParam.safeParse(providerRaw);
    if (!parsed.success) return c.json(errorBody(c, "VALIDATION", "Proveedor inválido"), 400);
    const provider: ChannelProvider = parsed.data;
    const adapter = channelAdapters[provider];

    const [connection] = await deps.ownerDb
      .select()
      .from(channelConnection)
      .where(eq(channelConnection.id, c.req.param("connectionId")))
      .limit(1);
    // 200 aunque no exista/desactivada: el proveedor no debe reintentar.
    if (!connection || connection.status !== "active" || connection.provider !== provider) {
      return c.json({ ok: true }, 200);
    }
    let config: Record<string, unknown>;
    try {
      config = decryptConfig(deps.secretsKey, connection.configEncrypted);
    } catch {
      return c.json({ ok: true }, 200);
    }

    const rawBody = await c.req.text().catch(() => "");
    const verified = adapter.verifyWebhook({
      headers: c.req.header(),
      rawBody,
      config,
      webhookSecret: connection.webhookSecret,
    });
    if (!verified) {
      return c.json(errorBody(c, "UNAUTHORIZED", "Firma inválida"), 401);
    }

    const parsedBody = adapter.parseWebhook({ headers: c.req.header(), rawBody, config });
    const orgId = connection.organizationId;

    for (const status of parsedBody.statuses) {
      // Sin timestamp en NormalizedStatus: el par (mensaje, estado) es único
      // por transición; los reintentos del proveedor traen el mismo estado.
      const eventId = `status:${status.externalMessageId}:${status.status}`;
      const inserted = await deps.ownerDb
        .insert(inboundEvent)
        .values({ provider, externalEventId: eventId })
        .onConflictDoNothing()
        .returning({ id: inboundEvent.id });
      if (inserted.length === 0) continue;
      await withOrgContext(deps.db, orgId, (tx) => applyStatus(tx, orgId, [status]).then(() => {}));
    }

    for (const event of parsedBody.messages) {
      const inserted = await deps.ownerDb
        .insert(inboundEvent)
        .values({ provider, externalEventId: event.externalEventId })
        .onConflictDoNothing()
        .returning({ id: inboundEvent.id });
      if (inserted.length === 0) continue;
      await sendInboundMessage(deps.ownerDb, { orgId, connectionId: connection.id, event });
    }

    // 200 siempre tras encolar: los errores de procesamiento son del worker.
    return c.json({ ok: true }, 200);
  });

  return app;
}
