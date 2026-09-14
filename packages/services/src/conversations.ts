import { channelAdapters, type ChannelAdapter, type NormalizedStatus } from "@odentia/channels";
import { sendOutboundMessage, type Db, type InboundMessageJob } from "@odentia/db";
import {
  channelConnection,
  contact,
  contactIdentity,
  conversation,
  message,
} from "@odentia/db/schema/crm";
import { auditEvent } from "@odentia/db/schema/org";
import { and, asc, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "./cursors.js";
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js";
import { ensureDefaultPipeline } from "./pipelines.js";
import { decryptConfig } from "./secrets.js";
import type { Storage } from "./storage.js";

/** Ventana de WhatsApp para texto libre: 24h desde el último inbound. */
const WA_FREE_TEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
};

export interface IngestDeps {
  storage: Storage;
  fetch: typeof fetch;
  secretsKey: Buffer;
}

export interface MessageItem {
  id: string;
  direction: string;
  senderKind: string;
  senderUserId: string | null;
  contentType: string;
  body: string | null;
  attachments: unknown;
  externalId: string | null;
  status: string;
  error: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  templateParams: string[] | null;
  createdAt: string;
}
function toMessageItem(row: typeof message.$inferSelect): MessageItem {
  return {
    id: row.id,
    direction: row.direction,
    senderKind: row.senderKind,
    senderUserId: row.senderUserId,
    contentType: row.contentType,
    body: row.body,
    attachments: row.attachments,
    externalId: row.externalId,
    status: row.status,
    error: row.error,
    templateName: row.templateName,
    templateLanguage: row.templateLanguage,
    templateParams:
      Array.isArray(row.templateParams) && row.templateParams.every((p): p is string => typeof p === "string")
        ? row.templateParams
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function notify(tx: Db, payload: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`);
}

async function audit(
  tx: Db,
  orgId: string,
  input: { actorUserId?: string | null; action: string; entity: string; entityId?: string; metadata?: unknown },
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    metadata: (input.metadata ?? null) as Record<string, unknown> | null,
  });
}
export async function ingestInbound(
  tx: Db,
  job: InboundMessageJob,
  adapter: ChannelAdapter,
  deps: IngestDeps,
): Promise<{ conversationId: string; messageId: string; created: boolean }> {
  const orgId = job.orgId;
  const event = job.event;
  const [connection] = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.id, job.connectionId), eq(channelConnection.organizationId, orgId)))
    .limit(1);
  if (!connection) throw new ServiceError("CONNECTION_NOT_FOUND", 404, "Conexión no encontrada");
  if (connection.status !== "active") {
    throw new ServiceError("CONNECTION_DISABLED", 409, "Conexión desactivada");
  }

  const channel = connection.channel;
  const [identity] = await tx
    .select()
    .from(contactIdentity)
    .where(
      and(
        eq(contactIdentity.organizationId, orgId),
        eq(contactIdentity.channel, channel),
        eq(contactIdentity.externalUserId, event.senderExternalId),
      ),
    )
    .limit(1);
  let contactId: string;
  if (identity) {
    contactId = identity.contactId;
  } else {
    const { stages } = await ensureDefaultPipeline(tx, orgId);
    const first = stages[0];
    if (!first) throw new Error("Pipeline default sin etapas");
    const [created] = await tx
      .insert(contact)
      .values({
        organizationId: orgId,
        displayName: event.senderDisplayName ?? event.senderExternalId,
        stageId: first.id,
      })
      .returning({ id: contact.id });
    if (!created) throw new Error("No se pudo crear el contacto");
    contactId = created.id;
    await tx.insert(contactIdentity).values({
      organizationId: orgId,
      contactId,
      channel,
      externalUserId: event.senderExternalId,
      displayName: event.senderDisplayName ?? null,
      isPrimary: true,
    });
  }

  let conversationId: string;
  const [existing] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(
      and(
        eq(conversation.channelConnectionId, connection.id),
        eq(conversation.externalThreadId, event.externalThreadId),
      ),
    )
    .limit(1);
  if (existing) {
    conversationId = existing.id;
  } else {
    try {
      const [created] = await tx
        .insert(conversation)
        .values({
          organizationId: orgId,
          contactId,
          channelConnectionId: connection.id,
          externalThreadId: event.externalThreadId,
        })
        .returning({ id: conversation.id });
      if (!created) throw new Error("No se pudo crear la conversación");
      conversationId = created.id;
    } catch (error) {
      // Carrera: otra ingesta creó la conversación; releer.
      if (!isUniqueViolation(error)) throw error;
      const [retry] = await tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(
          and(
            eq(conversation.channelConnectionId, connection.id),
            eq(conversation.externalThreadId, event.externalThreadId),
          ),
        )
        .limit(1);
      if (!retry) throw error;
      conversationId = retry.id;
    }
  }

  const content = event.content;
  const isMedia = content.type === "media";
  let contentType: string;
  let body: string | null;
  if (!isMedia) {
    contentType = "text";
    body = content.text;
  } else {
    contentType = content.mimeType.startsWith("image/")
      ? "image"
      : content.mimeType.startsWith("audio/")
        ? "audio"
        : "document";
    body = content.caption ?? null;
  }

  let attachments: unknown[] = [];
  let mediaError: string | null = null;
  if (content.type === "media" && adapter.fetchMedia) {
    try {
      const providerConfig = decryptConfig(deps.secretsKey, connection.configEncrypted);
      const media = await adapter.fetchMedia(providerConfig, content.mediaExternalId, { fetch: deps.fetch });
      const ext = EXT_BY_MIME[media.mimeType] ?? "bin";
      const ref = await deps.storage.putAttachment({
        orgId,
        conversationId,
        bytes: media.bytes,
        contentType: media.mimeType,
        ext,
      });
      attachments = [{ objectKey: ref.objectKey, mimeType: ref.mimeType, filename: media.filename, size: ref.size }];
    } catch {
      // No perder el mensaje por un fallo de descarga; queda auditado.
      mediaError = "media-download-failed";
    }
  }

  // Dedupe: ON CONFLICT DO NOTHING sin arbiter (el índice es parcial y el
  // especificador de columnas no lo satisface; el único unique en juego es
  // el de (conversation_id, external_id)).
  const inserted = await tx
    .insert(message)
    .values({
      organizationId: orgId,
      conversationId,
      direction: "in",
      senderKind: "contact",
      contentType,
      body,
      attachments,
      externalId: event.externalMessageId,
      status: "received",
      error: mediaError,
    })
    .onConflictDoNothing()
    .returning({ id: message.id });
  if (inserted.length === 0) {
    const [dup] = await tx
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.externalId, event.externalMessageId)))
      .limit(1);
    if (!dup) throw new Error("Dedupe sin fila existente");
    return { conversationId, messageId: dup.id, created: false };
  }
  const first = inserted[0];
  if (!first) throw new Error("Dedupe sin fila existente");
  const messageId = first.id;

  const now = new Date();
  await tx
    .update(conversation)
    .set({
      lastInboundAt: now,
      lastMessageAt: now,
      unreadCount: sql`"unread_count" + 1`,
      updatedAt: now,
    })
    .where(eq(conversation.id, conversationId));
  await tx
    .update(contact)
    .set({ lastInteractionAt: now, updatedAt: now })
    .where(eq(contact.id, contactId));
  if (mediaError) {
    await audit(tx, orgId, {
      action: "message.media_failed",
      entity: "message",
      entityId: messageId,
      metadata: { externalId: event.externalMessageId },
    });
  }
  await audit(tx, orgId, { action: "message.created", entity: "message", entityId: messageId });
  await notify(tx, { orgId, kind: "message.created", conversationId, messageId, at: now.toISOString() });
  return { conversationId, messageId, created: true };
}

/** Aplica estados del proveedor (delivered/read/failed) por externalId. */
export async function applyStatus(tx: Db, orgId: string, statuses: NormalizedStatus[]): Promise<number> {
  let applied = 0;
  for (const s of statuses) {
    const [updated] = await tx
      .update(message)
      .set({ status: s.status })
      .where(and(eq(message.organizationId, orgId), eq(message.externalId, s.externalMessageId)))
      .returning({ id: message.id, conversationId: message.conversationId });
    if (updated) {
      applied += 1;
      await notify(tx, {
        orgId,
        kind: "message.updated",
        conversationId: updated.conversationId,
        messageId: updated.id,
        at: new Date().toISOString(),
      });
    }
  }
  return applied;
}

export type OutboundContent =
  | { type: "text"; text: string }
  | { type: "template"; name: string; language: string; params: string[] };

async function requireOpenConversation(tx: Db, orgId: string, conversationId: string) {
  const [row] = await tx
    .select({ conversation, connection: channelConnection })
    .from(conversation)
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1);
  if (!row) throw notFound("Conversación");
  if (row.conversation.status !== "open") {
    throw new ServiceError("CONVERSATION_CLOSED", 409, "La conversación está cerrada");
  }
  return row;
}

function assertWindowAllows(row: { conversation: typeof conversation.$inferSelect }, content: OutboundContent): void {
  if (content.type !== "text") return;
  const last = row.conversation.lastInboundAt;
  if (!last || Date.now() - last.getTime() > WA_FREE_TEXT_WINDOW_MS) {
    throw new ServiceError("WINDOW_CLOSED", 409, "Fuera de la ventana de 24h: usa una plantilla");
  }
}

/**
 * Encola un mensaje saliente (texto o plantilla ya validada). Respuesta
 * humana (`user`) apaga el agente (patrón Kommo) y marca como leído.
 */
export async function sendOutbound(
  tx: Db,
  orgId: string,
  input: {
    conversationId: string;
    senderKind: "user" | "agent";
    senderUserId?: string | null;
    content: OutboundContent;
  },
): Promise<MessageItem> {
  const row = await requireOpenConversation(tx, orgId, input.conversationId);
  if (row.connection.provider === "whatsapp_cloud_api") {
    assertWindowAllows(row, input.content);
  }
  if (input.content.type === "text" && !input.content.text.trim()) {
    throw validation("El texto del mensaje es obligatorio");
  }
  const now = new Date();
  const patch: Partial<typeof conversation.$inferInsert> = {
    lastOutboundAt: now,
    lastMessageAt: now,
    updatedAt: now,
  };
  if (input.senderKind === "user") {
    patch.agentStatus = "off";
    patch.unreadCount = 0;
  }
  await tx.update(conversation).set(patch).where(eq(conversation.id, input.conversationId));
  const [created] = await tx
    .insert(message)
    .values({
      organizationId: orgId,
      conversationId: input.conversationId,
      direction: "out",
      senderKind: input.senderKind,
      senderUserId: input.senderUserId ?? null,
      contentType: input.content.type,
      body: input.content.type === "text" ? input.content.text : null,
      templateName: input.content.type === "template" ? input.content.name : null,
      templateLanguage: input.content.type === "template" ? input.content.language : null,
      templateParams: input.content.type === "template" ? input.content.params : null,
      attachments: [],
      status: "queued",
    })
    .returning();
  if (!created) throw new Error("No se pudo crear el mensaje");
  await sendOutboundMessage(tx, { orgId, messageId: created.id });
  await audit(tx, orgId, {
    actorUserId: input.senderUserId ?? null,
    action: "message.created",
    entity: "message",
    entityId: created.id,
    metadata: { direction: "out", senderKind: input.senderKind },
  });
  await notify(tx, {
    orgId,
    kind: "message.created",
    conversationId: input.conversationId,
    messageId: created.id,
    at: now.toISOString(),
  });
  return toMessageItem(created);
}

/** Valida la plantilla contra el allowlist de la conexión (config descifrada). */
export function assertTemplateAllowed(
  templates: unknown,
  name: string,
  language: string,
): void {
  if (!Array.isArray(templates)) throw validation("La conexión no tiene plantillas configuradas");
  const found = templates.some(
    (t) =>
      !!t &&
      typeof t === "object" &&
      "name" in t &&
      t.name === name &&
      "language" in t &&
      t.language === language,
  );
  if (!found) throw validation("Plantilla no autorizada en esta conexión");
}

/** Envío de plantilla con validación contra la config descifrada. */
export async function sendTemplateOutbound(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  input: {
    conversationId: string;
    senderKind: "user" | "agent";
    senderUserId?: string | null;
    name: string;
    language: string;
    params: string[];
  },
): Promise<MessageItem> {
  const row = await requireOpenConversation(tx, orgId, input.conversationId);
  const config = decryptConfig(secretsKey, row.connection.configEncrypted);
  assertTemplateAllowed(config["templates"], input.name, input.language);
  return sendOutbound(tx, orgId, {
    conversationId: input.conversationId,
    senderKind: input.senderKind,
    senderUserId: input.senderUserId,
    content: { type: "template", name: input.name, language: input.language, params: input.params },
  });
}

export interface ConversationListItem {
  id: string;
  status: string;
  agentStatus: string;
  unreadCount: number;
  assignedUserId: string | null;
  lastMessageAt: string | null;
  contact: { id: string; displayName: string };
  connection: { id: string; channel: string; provider: string; displayName: string };
  preview: { body: string | null; direction: string; senderKind: string; createdAt: string } | null;
}

export async function listConversations(
  tx: Db,
  orgId: string,
  input: { status?: string; channel?: string; assigned?: string; q?: string; cursor?: string; limit?: number },
): Promise<{ items: ConversationListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const conditions = [eq(conversation.organizationId, orgId)];
  if (input.status) conditions.push(eq(conversation.status, input.status));
  if (input.channel) conditions.push(eq(channelConnection.channel, input.channel));
  if (input.assigned === "none") {
    conditions.push(sql`"conversation"."assigned_user_id" is null`);
  } else if (input.assigned) {
    conditions.push(eq(conversation.assignedUserId, input.assigned));
  }
  if (input.q) conditions.push(ilike(contact.displayName, `%${input.q}%`));
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded) throw validation("Cursor inválido");
    const ts = new Date(decoded.ts);
    conditions.push(
      or(
        lt(conversation.lastMessageAt, ts),
        and(eq(conversation.lastMessageAt, ts), lt(conversation.id, decoded.id)),
      )!,
    );
  }
  const rows = await tx
    .select({ conversation, contact, connection: channelConnection })
    .from(conversation)
    .innerJoin(contact, eq(conversation.contactId, contact.id))
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(...conditions))
    .orderBy(desc(conversation.lastMessageAt), desc(conversation.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const previews = new Map<string, ConversationListItem["preview"]>();
  if (page.length > 0) {
    const ids = page.map((r) => r.conversation.id);
    const previewRows = (await tx.execute(sql`
      select distinct on ("conversation_id") "conversation_id", "body", "direction", "sender_kind", "created_at"
      from "message"
      where "conversation_id" in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      order by "conversation_id", "created_at" desc`)) as unknown as {
      conversation_id: string;
      body: string | null;
      direction: string;
      sender_kind: string;
      created_at: Date;
    }[];
    for (const p of previewRows) {
      previews.set(p.conversation_id, {
        body: p.body,
        direction: p.direction,
        senderKind: p.sender_kind,
        createdAt: p.created_at instanceof Date ? p.created_at.toISOString() : String(p.created_at),
      });
    }
  }
  const items: ConversationListItem[] = page.map((r) => ({
    id: r.conversation.id,
    status: r.conversation.status,
    agentStatus: r.conversation.agentStatus,
    unreadCount: r.conversation.unreadCount,
    assignedUserId: r.conversation.assignedUserId,
    lastMessageAt: r.conversation.lastMessageAt ? r.conversation.lastMessageAt.toISOString() : null,
    contact: { id: r.contact.id, displayName: r.contact.displayName },
    connection: {
      id: r.connection.id,
      channel: r.connection.channel,
      provider: r.connection.provider,
      displayName: r.connection.displayName,
    },
    preview: previews.get(r.conversation.id) ?? null,
  }));
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last?.conversation.lastMessageAt
      ? encodeCursor(last.conversation.lastMessageAt.toISOString(), last.conversation.id)
      : null;
  return { items, nextCursor };
}

export async function listMessages(
  tx: Db,
  orgId: string,
  conversationId: string,
  input: { before?: string; limit?: number },
): Promise<{ items: MessageItem[]; nextCursor: string | null }> {
  const [conv] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1);
  if (!conv) throw notFound("Conversación");
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const conditions = [eq(message.conversationId, conversationId)];
  if (input.before) {
    const decoded = decodeCursor(input.before);
    if (!decoded) throw validation("Cursor inválido");
    const ts = new Date(decoded.ts);
    conditions.push(or(lt(message.createdAt, ts), and(eq(message.createdAt, ts), lt(message.id, decoded.id)))!);
  }
  const rows = await tx
    .select()
    .from(message)
    .where(and(...conditions))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const oldest = page[page.length - 1];
  return {
    items: page.reverse().map(toMessageItem),
    nextCursor:
      rows.length > limit && oldest ? encodeCursor(oldest.createdAt.toISOString(), oldest.id) : null,
  };
}

export interface ConversationDetail {
  conversation: {
    id: string;
    status: string;
    agentStatus: string;
    unreadCount: number;
    assignedUserId: string | null;
    lastMessageAt: string | null;
  };
  contact: { id: string; displayName: string };
  connection: { id: string; channel: string; provider: string; displayName: string; capabilities: unknown };
  messages: MessageItem[];
  messagesCursor: string | null;
}

export async function getConversationDetail(tx: Db, orgId: string, id: string): Promise<ConversationDetail> {
  const [row] = await tx
    .select({ conversation, contact, connection: channelConnection })
    .from(conversation)
    .innerJoin(contact, eq(conversation.contactId, contact.id))
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId)))
    .limit(1);
  if (!row) throw notFound("Conversación");
  const adapter = channelAdapters[row.connection.provider as keyof typeof channelAdapters];
  const { items, nextCursor } = await listMessages(tx, orgId, id, {});
  return {
    conversation: {
      id: row.conversation.id,
      status: row.conversation.status,
      agentStatus: row.conversation.agentStatus,
      unreadCount: row.conversation.unreadCount,
      assignedUserId: row.conversation.assignedUserId,
      lastMessageAt: row.conversation.lastMessageAt ? row.conversation.lastMessageAt.toISOString() : null,
    },
    contact: { id: row.contact.id, displayName: row.contact.displayName },
    connection: {
      id: row.connection.id,
      channel: row.connection.channel,
      provider: row.connection.provider,
      displayName: row.connection.displayName,
      capabilities: adapter?.capabilities ?? null,
    },
    messages: items,
    messagesCursor: nextCursor,
  };
}

async function mutateConversation(
  tx: Db,
  orgId: string,
  id: string,
  patch: Partial<typeof conversation.$inferInsert>,
  auditInput: { actorUserId?: string | null; op: string },
): Promise<void> {
  const [updated] = await tx
    .update(conversation)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId)))
    .returning({ id: conversation.id });
  if (!updated) throw notFound("Conversación");
  // Acción canónica = kind SSE: el replay reconstruye conversation.updated.
  await audit(tx, orgId, { actorUserId: auditInput.actorUserId, action: "conversation.updated", entity: "conversation", entityId: id, metadata: { op: auditInput.op } });
  await notify(tx, { orgId, kind: "conversation.updated", conversationId: id, at: new Date().toISOString() });
}

export async function assignConversation(
  tx: Db,
  orgId: string,
  id: string,
  userId: string | null,
  actorUserId?: string,
): Promise<void> {
  await mutateConversation(tx, orgId, id, { assignedUserId: userId }, { actorUserId, op: "assign" });
}

export async function closeConversation(tx: Db, orgId: string, id: string, actorUserId?: string): Promise<void> {
  await mutateConversation(tx, orgId, id, { status: "closed" }, { actorUserId, op: "close" });
}

export async function reopenConversation(tx: Db, orgId: string, id: string, actorUserId?: string): Promise<void> {
  await mutateConversation(tx, orgId, id, { status: "open" }, { actorUserId, op: "reopen" });
}

export async function setAgentStatus(
  tx: Db,
  orgId: string,
  id: string,
  enabled: boolean,
  actorUserId?: string,
): Promise<void> {
  await mutateConversation(
    tx,
    orgId,
    id,
    { agentStatus: enabled ? "on" : "off" },
    { actorUserId, op: "agent" },
  );
}

export async function markRead(tx: Db, orgId: string, id: string): Promise<void> {
  await mutateConversation(tx, orgId, id, { unreadCount: 0 }, { op: "read" });
}

/** Resuelve un adjunto a URL firmada (15 min), verificando la cadena RLS. */
export async function attachmentUrl(
  tx: Db,
  orgId: string,
  messageId: string,
  index: number,
  storage: Storage,
): Promise<string> {
  const [row] = await tx
    .select({ message, conversation })
    .from(message)
    .innerJoin(conversation, eq(message.conversationId, conversation.id))
    .where(
      and(
        eq(message.id, messageId),
        eq(message.organizationId, orgId),
        eq(conversation.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Mensaje");
  const attachments = row.message.attachments;
  if (!Array.isArray(attachments)) throw notFound("Adjunto");
  const ref = attachments[index];
  if (!ref || typeof ref !== "object" || !("objectKey" in ref) || typeof ref.objectKey !== "string") {
    throw notFound("Adjunto");
  }
  return storage.attachmentUrl(ref.objectKey, 900);
}
