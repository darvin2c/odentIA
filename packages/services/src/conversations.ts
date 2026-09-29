import { type ChannelAdapter, channelAdapters, type NormalizedStatus } from "@odentia/channels"
import { type Db, type InboundMessageJob, sendOutboundMessage } from "@odentia/db"
import {
  channelConnection,
  contact,
  contactIdentity,
  conversation,
  message,
} from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, ilike, lt, or, sql } from "drizzle-orm"
import {
  findChannelIdentity,
  isDirectThread,
  isTelegramGroupThread,
  lockChannelIdentity,
  OMNI_CHANNELS,
} from "./contacts.js"
import { decodeCursor, encodeCursor } from "./cursors.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { createOpportunity } from "./opportunities.js"
import { decryptConfig } from "./secrets.js"
import type { AttachmentRef, Storage } from "./storage.js"

/** Ventana de WhatsApp para texto libre: 24h desde el último inbound. */
const WA_FREE_TEXT_WINDOW_MS = 24 * 60 * 60 * 1000

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
}

export interface IngestDeps {
  storage: Storage
  fetch: typeof fetch
  secretsKey: Buffer
  /** Transcripción best-effort de notas de voz; ausente = desactivada. */
  transcribe?: TranscribeFn
}

export type TranscribeFn = (input: {
  bytes: Uint8Array
  mimeType: string
  filename: string
}) => Promise<string>

export interface MessageItem {
  id: string
  direction: string
  senderKind: string
  senderUserId: string | null
  contentType: string
  body: string | null
  attachments: unknown
  externalId: string | null
  status: string
  error: string | null
  templateName: string | null
  templateLanguage: string | null
  templateParams: string[] | null
  createdAt: string
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
      Array.isArray(row.templateParams) &&
      row.templateParams.every((p): p is string => typeof p === "string")
        ? row.templateParams
        : null,
    createdAt: row.createdAt.toISOString(),
  }
}

async function notify(tx: Db, payload: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

async function audit(
  tx: Db,
  orgId: string,
  input: {
    actorUserId?: string | null
    action: string
    entity: string
    entityId?: string
    metadata?: unknown
  },
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId ?? null,
    metadata: (input.metadata ?? null) as Record<string, unknown> | null,
  })
}
export async function ingestInbound(
  tx: Db,
  job: InboundMessageJob,
  adapter: ChannelAdapter,
  deps: IngestDeps,
): Promise<{ conversationId: string; messageId: string; created: boolean }> {
  const orgId = job.orgId
  const event = job.event
  const [connection] = await tx
    .select()
    .from(channelConnection)
    .where(
      and(eq(channelConnection.id, job.connectionId), eq(channelConnection.organizationId, orgId)),
    )
    .limit(1)
  if (!connection) throw new ServiceError("CONNECTION_NOT_FOUND", 404, "Conexión no encontrada")
  if (connection.status !== "active") {
    throw new ServiceError("CONNECTION_DISABLED", 409, "Conexión desactivada")
  }

  const channel = connection.channel
  // Serializar creación/resolución/traslado de identidad bajo el mismo
  // advisory lock que usa la transferencia (sin capturar unique violations
  // en transacciones abortadas: se inserta con ON CONFLICT).
  await lockChannelIdentity(tx, orgId, channel, event.senderExternalId)
  let identity = await findChannelIdentity(tx, orgId, channel, event.senderExternalId)
  let contactId: string
  if (identity) {
    // El archivado no bloquea la recepción entrante ni crea un contacto
    // nuevo: se reutiliza el contacto archivado (el badge lo muestra).
    contactId = identity.contactId
  } else {
    const [created] = await tx
      .insert(contact)
      .values({
        organizationId: orgId,
        displayName: event.senderDisplayName ?? event.senderExternalId,
      })
      .returning({ id: contact.id })
    if (!created) throw new Error("No se pudo crear el contacto")
    contactId = created.id
    // El embudo son oportunidades: el contacto entrante nace con su primera
    // oportunidad en la etapa inicial (una por persona recién llegada).
    await createOpportunity(
      tx,
      orgId,
      {
        contactId,
        title: `Seguimiento · ${event.senderDisplayName ?? event.senderExternalId}`.slice(0, 200),
      },
      { userId: null },
    )
    const [insertedIdentity] = await tx
      .insert(contactIdentity)
      .values({
        organizationId: orgId,
        contactId,
        channel,
        externalUserId: event.senderExternalId,
        displayName: event.senderDisplayName ?? null,
        isPrimary: true,
      })
      .onConflictDoNothing({
        target: [
          contactIdentity.organizationId,
          contactIdentity.channel,
          contactIdentity.externalUserId,
        ],
      })
      .returning()
    identity =
      insertedIdentity ?? (await findChannelIdentity(tx, orgId, channel, event.senderExternalId))
    if (!identity) throw new Error("No se pudo resolver la identidad de canal")
    contactId = identity.contactId
  }

  let conversationId: string
  let threadContactId: string
  const [existing] = await tx
    .select()
    .from(conversation)
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.channelConnectionId, connection.id),
        eq(conversation.externalThreadId, event.externalThreadId),
      ),
    )
    .limit(1)
  if (existing) {
    conversationId = existing.id
    threadContactId = existing.contactId
    // Hilo compartido (p. ej. grupo de Telegram con otro remitente):
    // conservar interlocutor e identidad, nunca reasignar automáticamente.
    // Solo se vincula la identidad en hilos directos del mismo contacto.
    if (
      existing.contactIdentityId === null &&
      identity.contactId === existing.contactId &&
      isDirectThread(channel, event.externalThreadId, event.senderExternalId)
    ) {
      await tx
        .update(conversation)
        .set({ contactIdentityId: identity.id, updatedAt: new Date() })
        .where(and(eq(conversation.id, existing.id), eq(conversation.organizationId, orgId)))
    }
  } else {
    const [created] = await tx
      .insert(conversation)
      .values({
        organizationId: orgId,
        contactId,
        contactIdentityId: isDirectThread(channel, event.externalThreadId, event.senderExternalId)
          ? identity.id
          : null,
        channelConnectionId: connection.id,
        externalThreadId: event.externalThreadId,
      })
      .onConflictDoNothing({
        target: [conversation.channelConnectionId, conversation.externalThreadId],
      })
      .returning({ id: conversation.id, contactId: conversation.contactId })
    if (created) {
      conversationId = created.id
      threadContactId = created.contactId
    } else {
      // Carrera: otra ingesta creó el hilo; releer sin reintentar escrituras
      // sobre una transacción abortada.
      const [retry] = await tx
        .select({ id: conversation.id, contactId: conversation.contactId })
        .from(conversation)
        .where(
          and(
            eq(conversation.organizationId, orgId),
            eq(conversation.channelConnectionId, connection.id),
            eq(conversation.externalThreadId, event.externalThreadId),
          ),
        )
        .limit(1)
      if (!retry) throw new Error("No se pudo crear la conversación")
      conversationId = retry.id
      threadContactId = retry.contactId
    }
  }

  const content = event.content
  const isMedia = content.type === "media"
  let contentType: string
  let body: string | null
  if (!isMedia) {
    contentType = "text"
    body = content.text
  } else {
    contentType = content.mimeType.startsWith("image/")
      ? "image"
      : content.mimeType.startsWith("audio/")
        ? "audio"
        : "document"
    body = content.caption ?? null
  }

  let attachments: unknown[] = []
  let mediaError: string | null = null
  let mediaDownload: { bytes: Uint8Array; mimeType: string; filename: string } | null = null
  if (content.type === "media" && adapter.fetchMedia) {
    try {
      const providerConfig = decryptConfig(deps.secretsKey, connection.configEncrypted)
      const media = await adapter.fetchMedia(providerConfig, content.mediaExternalId, {
        fetch: deps.fetch,
      })
      const ext = EXT_BY_MIME[media.mimeType] ?? "bin"
      const ref = await deps.storage.putAttachment({
        orgId,
        conversationId,
        bytes: media.bytes,
        contentType: media.mimeType,
        ext,
      })
      attachments = [
        {
          objectKey: ref.objectKey,
          mimeType: ref.mimeType,
          filename: media.filename,
          size: ref.size,
        },
      ]
      mediaDownload = media
    } catch {
      // No perder el mensaje por un fallo de descarga; queda auditado.
      mediaError = "media-download-failed"
    }
  }

  // Nota de voz sin caption: transcribir a body (el agente lo lee como texto).
  // Best-effort: si falla, body queda null y la ingesta no se pierde.
  if (mediaDownload && contentType === "audio" && body === null && deps.transcribe) {
    try {
      body = await deps.transcribe(mediaDownload)
    } catch {
      body = null
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
    .returning({ id: message.id })
  if (inserted.length === 0) {
    const [dup] = await tx
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.conversationId, conversationId),
          eq(message.externalId, event.externalMessageId),
        ),
      )
      .limit(1)
    if (!dup) throw new Error("Dedupe sin fila existente")
    return { conversationId, messageId: dup.id, created: false }
  }
  const first = inserted[0]
  if (!first) throw new Error("Dedupe sin fila existente")
  const messageId = first.id

  const now = new Date()
  await tx
    .update(conversation)
    .set({
      lastInboundAt: now,
      lastMessageAt: now,
      unreadCount: sql`"unread_count" + 1`,
      updatedAt: now,
    })
    .where(eq(conversation.id, conversationId))
  await tx
    .update(contact)
    .set({ lastInteractionAt: now, updatedAt: now })
    .where(eq(contact.id, threadContactId))
  if (mediaError) {
    await audit(tx, orgId, {
      action: "message.media_failed",
      entity: "message",
      entityId: messageId,
      metadata: { externalId: event.externalMessageId },
    })
  }
  await audit(tx, orgId, { action: "message.created", entity: "message", entityId: messageId })
  await notify(tx, {
    orgId,
    kind: "message.created",
    conversationId,
    messageId,
    at: now.toISOString(),
  })
  return { conversationId, messageId, created: true }
}

/** Aplica estados del proveedor (delivered/read/failed) por externalId. */
export async function applyStatus(
  tx: Db,
  orgId: string,
  statuses: NormalizedStatus[],
): Promise<number> {
  let applied = 0
  for (const s of statuses) {
    const [updated] = await tx
      .update(message)
      .set({ status: s.status })
      .where(and(eq(message.organizationId, orgId), eq(message.externalId, s.externalMessageId)))
      .returning({ id: message.id, conversationId: message.conversationId })
    if (updated) {
      applied += 1
      await notify(tx, {
        orgId,
        kind: "message.updated",
        conversationId: updated.conversationId,
        messageId: updated.id,
        at: new Date().toISOString(),
      })
    }
  }
  return applied
}

export type OutboundContent =
  | { type: "text"; text: string }
  | { type: "template"; name: string; language: string; params: string[] }
  | { type: "media"; attachment: AttachmentRef; caption?: string }

/** Tipos MIME admitidos para media saliente y su extensión (límite WhatsApp: 16 MB). */
export const OUTBOUND_MEDIA_MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
}
export const OUTBOUND_MEDIA_MAX_BYTES = 16 * 1024 * 1024

async function requireOpenConversation(tx: Db, orgId: string, conversationId: string) {
  const [row] = await tx
    .select({ conversation, connection: channelConnection })
    .from(conversation)
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  if (row.conversation.status !== "open") {
    throw new ServiceError("CONVERSATION_CLOSED", 409, "La conversación está cerrada")
  }
  return row
}

function assertWindowAllows(
  row: { conversation: typeof conversation.$inferSelect },
  content: OutboundContent,
): void {
  // Los media salientes también son mensajes de sesión sujetos a la ventana.
  if (content.type === "template") return
  const last = row.conversation.lastInboundAt
  if (!last || Date.now() - last.getTime() > WA_FREE_TEXT_WINDOW_MS) {
    throw new ServiceError("WINDOW_CLOSED", 409, "Fuera de la ventana de 24h: usa una plantilla")
  }
}

/** Meta (Messenger/Instagram) exige ventana de 24h y no admite plantillas. */
function assertMetaWindowAllows(row: {
  conversation: typeof conversation.$inferSelect
}): void {
  const last = row.conversation.lastInboundAt
  if (!last || Date.now() - last.getTime() > WA_FREE_TEXT_WINDOW_MS) {
    throw new ServiceError(
      "WINDOW_CLOSED",
      409,
      "Fuera de la ventana de 24 h de Meta: espera un mensaje nuevo de la persona",
    )
  }
}

const META_OUTBOUND_PROVIDERS = ["messenger", "instagram"]
/**
 * Encola un mensaje saliente (texto o plantilla ya validada). Respuesta
 * humana (`user`) apaga el agente (patrón Kommo) y marca como leído.
 */
export async function sendOutbound(
  tx: Db,
  orgId: string,
  input: {
    conversationId: string
    senderKind: "user" | "agent"
    senderUserId?: string | null
    content: OutboundContent
  },
): Promise<MessageItem> {
  const row = await requireOpenConversation(tx, orgId, input.conversationId)
  if (row.connection.provider === "whatsapp_cloud_api") {
    assertWindowAllows(row, input.content)
  } else if (META_OUTBOUND_PROVIDERS.includes(row.connection.provider)) {
    assertMetaWindowAllows(row)
  }
  if (input.content.type === "text" && !input.content.text.trim()) {
    throw validation("El texto del mensaje es obligatorio")
  }
  const now = new Date()
  const patch: Partial<typeof conversation.$inferInsert> = {
    lastOutboundAt: now,
    lastMessageAt: now,
    updatedAt: now,
  }
  if (input.senderKind === "user") {
    patch.agentStatus = "off"
    patch.unreadCount = 0
  }
  await tx.update(conversation).set(patch).where(eq(conversation.id, input.conversationId))
  const content = input.content
  const contentType =
    content.type === "media"
      ? content.attachment.mimeType.startsWith("image/")
        ? "image"
        : content.attachment.mimeType.startsWith("audio/")
          ? "audio"
          : "document"
      : content.type
  const [created] = await tx
    .insert(message)
    .values({
      organizationId: orgId,
      conversationId: input.conversationId,
      direction: "out",
      senderKind: input.senderKind,
      senderUserId: input.senderUserId ?? null,
      contentType,
      body:
        content.type === "text"
          ? content.text
          : content.type === "media"
            ? (content.caption ?? null)
            : null,
      templateName: content.type === "template" ? content.name : null,
      templateLanguage: content.type === "template" ? content.language : null,
      templateParams: content.type === "template" ? content.params : null,
      attachments: content.type === "media" ? [content.attachment] : [],
      status: "queued",
    })
    .returning()
  if (!created) throw new Error("No se pudo crear el mensaje")
  await sendOutboundMessage(tx, { orgId, messageId: created.id })
  await audit(tx, orgId, {
    actorUserId: input.senderUserId ?? null,
    action: "message.created",
    entity: "message",
    entityId: created.id,
    metadata: { direction: "out", senderKind: input.senderKind },
  })
  await notify(tx, {
    orgId,
    kind: "message.created",
    conversationId: input.conversationId,
    messageId: created.id,
    at: now.toISOString(),
  })
  return toMessageItem(created)
}

/** Valida la plantilla contra el allowlist de la conexión (config descifrada). */
export function assertTemplateAllowed(templates: unknown, name: string, language: string): void {
  if (!Array.isArray(templates)) throw validation("La conexión no tiene plantillas configuradas")
  const found = templates.some(
    (t) =>
      !!t &&
      typeof t === "object" &&
      "name" in t &&
      t.name === name &&
      "language" in t &&
      t.language === language,
  )
  if (!found) throw validation("Plantilla no autorizada en esta conexión")
}

/** Envío de plantilla con validación contra la config descifrada. */
export async function sendTemplateOutbound(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  input: {
    conversationId: string
    senderKind: "user" | "agent"
    senderUserId?: string | null
    name: string
    language: string
    params: string[]
  },
): Promise<MessageItem> {
  const row = await requireOpenConversation(tx, orgId, input.conversationId)
  const config = decryptConfig(secretsKey, row.connection.configEncrypted)
  assertTemplateAllowed(config["templates"], input.name, input.language)
  return sendOutbound(tx, orgId, {
    conversationId: input.conversationId,
    senderKind: input.senderKind,
    senderUserId: input.senderUserId,
    content: { type: "template", name: input.name, language: input.language, params: input.params },
  })
}

export interface ConversationListItem {
  id: string
  status: string
  agentStatus: string
  unreadCount: number
  assignedUserId: string | null
  lastMessageAt: string | null
  contact: { id: string; displayName: string; isActive: boolean }
  connection: { id: string; channel: string; provider: string; displayName: string }
  preview: { body: string | null; direction: string; senderKind: string; createdAt: string } | null
}

export async function listConversations(
  tx: Db,
  orgId: string,
  input: {
    status?: string
    channel?: string
    assigned?: string
    q?: string
    cursor?: string
    limit?: number
  },
): Promise<{ items: ConversationListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100)
  const conditions = [eq(conversation.organizationId, orgId)]
  if (input.status) conditions.push(eq(conversation.status, input.status))
  if (input.channel) conditions.push(eq(channelConnection.channel, input.channel))
  if (input.assigned === "none") {
    conditions.push(sql`"conversation"."assigned_user_id" is null`)
  } else if (input.assigned) {
    conditions.push(eq(conversation.assignedUserId, input.assigned))
  }
  if (input.q) conditions.push(ilike(contact.displayName, `%${input.q}%`))
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor)
    if (!decoded) throw validation("Cursor inválido")
    const ts = new Date(decoded.ts)
    conditions.push(
      or(
        lt(conversation.lastMessageAt, ts),
        and(eq(conversation.lastMessageAt, ts), lt(conversation.id, decoded.id)),
      )!,
    )
  }
  const rows = await tx
    .select({ conversation, contact, connection: channelConnection })
    .from(conversation)
    .innerJoin(contact, eq(conversation.contactId, contact.id))
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(...conditions))
    .orderBy(desc(conversation.lastMessageAt), desc(conversation.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const previews = new Map<string, ConversationListItem["preview"]>()
  if (page.length > 0) {
    const ids = page.map((r) => r.conversation.id)
    const previewRows = (await tx.execute(sql`
      select distinct on ("conversation_id") "conversation_id", "body", "direction", "sender_kind", "created_at"
      from "message"
      where "conversation_id" in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      order by "conversation_id", "created_at" desc`)) as unknown as {
      conversation_id: string
      body: string | null
      direction: string
      sender_kind: string
      created_at: Date
    }[]
    for (const p of previewRows) {
      previews.set(p.conversation_id, {
        body: p.body,
        direction: p.direction,
        senderKind: p.sender_kind,
        createdAt: p.created_at instanceof Date ? p.created_at.toISOString() : String(p.created_at),
      })
    }
  }
  const items: ConversationListItem[] = page.map((r) => ({
    id: r.conversation.id,
    status: r.conversation.status,
    agentStatus: r.conversation.agentStatus,
    unreadCount: r.conversation.unreadCount,
    assignedUserId: r.conversation.assignedUserId,
    lastMessageAt: r.conversation.lastMessageAt ? r.conversation.lastMessageAt.toISOString() : null,
    contact: { id: r.contact.id, displayName: r.contact.displayName, isActive: r.contact.isActive },
    connection: {
      id: r.connection.id,
      channel: r.connection.channel,
      provider: r.connection.provider,
      displayName: r.connection.displayName,
    },
    preview: previews.get(r.conversation.id) ?? null,
  }))
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > limit && last?.conversation.lastMessageAt
      ? encodeCursor(last.conversation.lastMessageAt.toISOString(), last.conversation.id)
      : null
  return { items, nextCursor }
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
    .limit(1)
  if (!conv) throw notFound("Conversación")
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  const conditions = [eq(message.conversationId, conversationId)]
  if (input.before) {
    const decoded = decodeCursor(input.before)
    if (!decoded) throw validation("Cursor inválido")
    const ts = new Date(decoded.ts)
    conditions.push(
      or(lt(message.createdAt, ts), and(eq(message.createdAt, ts), lt(message.id, decoded.id)))!,
    )
  }
  const rows = await tx
    .select()
    .from(message)
    .where(and(...conditions))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const oldest = page[page.length - 1]
  return {
    items: page.reverse().map(toMessageItem),
    nextCursor:
      rows.length > limit && oldest
        ? encodeCursor(oldest.createdAt.toISOString(), oldest.id)
        : null,
  }
}

export interface ConversationDetail {
  conversation: {
    id: string
    status: string
    agentStatus: string
    unreadCount: number
    assignedUserId: string | null
    lastMessageAt: string | null
  }
  contact: { id: string; displayName: string; isActive: boolean }
  connection: {
    id: string
    channel: string
    provider: string
    displayName: string
    capabilities: unknown
  }
  messages: MessageItem[]
  messagesCursor: string | null
}

export async function getConversationDetail(
  tx: Db,
  orgId: string,
  id: string,
): Promise<ConversationDetail> {
  const [row] = await tx
    .select({ conversation, contact, connection: channelConnection })
    .from(conversation)
    .innerJoin(contact, eq(conversation.contactId, contact.id))
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  const adapter = channelAdapters[row.connection.provider as keyof typeof channelAdapters]
  const { items, nextCursor } = await listMessages(tx, orgId, id, {})
  return {
    conversation: {
      id: row.conversation.id,
      status: row.conversation.status,
      agentStatus: row.conversation.agentStatus,
      unreadCount: row.conversation.unreadCount,
      assignedUserId: row.conversation.assignedUserId,
      lastMessageAt: row.conversation.lastMessageAt
        ? row.conversation.lastMessageAt.toISOString()
        : null,
    },
    contact: {
      id: row.contact.id,
      displayName: row.contact.displayName,
      isActive: row.contact.isActive,
    },
    connection: {
      id: row.connection.id,
      channel: row.connection.channel,
      provider: row.connection.provider,
      displayName: row.connection.displayName,
      capabilities: adapter?.capabilities ?? null,
    },
    messages: items,
    messagesCursor: nextCursor,
  }
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
    .returning({ id: conversation.id })
  if (!updated) throw notFound("Conversación")
  // Acción canónica = kind SSE: el replay reconstruye conversation.updated.
  await audit(tx, orgId, {
    actorUserId: auditInput.actorUserId,
    action: "conversation.updated",
    entity: "conversation",
    entityId: id,
    metadata: { op: auditInput.op },
  })
  await notify(tx, {
    orgId,
    kind: "conversation.updated",
    conversationId: id,
    at: new Date().toISOString(),
  })
}

export async function assignConversation(
  tx: Db,
  orgId: string,
  id: string,
  userId: string | null,
  actorUserId?: string,
): Promise<void> {
  await mutateConversation(tx, orgId, id, { assignedUserId: userId }, { actorUserId, op: "assign" })
}

export async function closeConversation(
  tx: Db,
  orgId: string,
  id: string,
  actorUserId?: string,
): Promise<void> {
  await mutateConversation(tx, orgId, id, { status: "closed" }, { actorUserId, op: "close" })
}

export async function reopenConversation(
  tx: Db,
  orgId: string,
  id: string,
  actorUserId?: string,
): Promise<void> {
  await mutateConversation(tx, orgId, id, { status: "open" }, { actorUserId, op: "reopen" })
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
  )
}

export async function markRead(tx: Db, orgId: string, id: string): Promise<void> {
  await mutateConversation(tx, orgId, id, { unreadCount: 0 }, { op: "read" })
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
    .limit(1)
  if (!row) throw notFound("Mensaje")
  const attachments = row.message.attachments
  if (!Array.isArray(attachments)) throw notFound("Adjunto")
  const ref = attachments[index]
  if (
    !ref ||
    typeof ref !== "object" ||
    !("objectKey" in ref) ||
    typeof ref.objectKey !== "string"
  ) {
    throw notFound("Adjunto")
  }
  return storage.attachmentUrl(ref.objectKey, 900)
}

/**
 * Resolución manual de la identidad de una conversación (personal
 * autorizado). Limitada a una identidad del mismo contacto, canal y
 * organización. Los hilos grupales de Telegram nunca se atribuyen a una
 * identidad personal.
 */
export async function resolveConversationIdentity(
  tx: Db,
  orgId: string,
  conversationId: string,
  input: { identityId: string },
  actor?: { userId: string | null },
): Promise<{ id: string; contactIdentityId: string }> {
  const [row] = await tx
    .select({ conv: conversation, connection: channelConnection })
    .from(conversation)
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  const [identity] = await tx
    .select()
    .from(contactIdentity)
    .where(and(eq(contactIdentity.id, input.identityId), eq(contactIdentity.organizationId, orgId)))
    .limit(1)
  if (!identity) throw notFound("Identidad de canal")
  await lockChannelIdentity(tx, orgId, identity.channel, identity.externalUserId)
  const [currentIdentity] = await tx
    .select()
    .from(contactIdentity)
    .where(and(eq(contactIdentity.id, identity.id), eq(contactIdentity.organizationId, orgId)))
    .for("update")
  const [currentThread] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .for("update")
  if (!currentIdentity || !currentThread) throw notFound("Conversación o identidad")
  if (currentIdentity.contactId !== currentThread.contactId)
    throw new ServiceError(
      "IDENTITY_CONTACT_MISMATCH",
      409,
      "La identidad ya no pertenece al contacto de esta conversación",
    )
  if (identity.contactId !== row.conv.contactId) {
    throw new ServiceError(
      "IDENTITY_CONTACT_MISMATCH",
      409,
      "La identidad pertenece a otro contacto de la organización",
    )
  }
  if (identity.channel !== row.connection.channel) {
    throw new ServiceError(
      "IDENTITY_CHANNEL_MISMATCH",
      409,
      "La identidad es de otro canal distinto al de la conversación",
    )
  }
  if (isTelegramGroupThread(row.connection.channel, row.conv.externalThreadId)) {
    throw new ServiceError(
      "GROUP_THREAD",
      409,
      "Los hilos grupales no se atribuyen a una identidad personal",
    )
  }
  await tx
    .update(conversation)
    .set({ contactIdentityId: identity.id, updatedAt: new Date() })
    .where(and(eq(conversation.id, row.conv.id), eq(conversation.organizationId, orgId)))
  await audit(tx, orgId, {
    actorUserId: actor?.userId ?? null,
    action: "conversation.identity_resolved",
    entity: "conversation",
    entityId: row.conv.id,
    metadata: { conversationId: row.conv.id, identityId: identity.id },
  })
  return { id: row.conv.id, contactIdentityId: identity.id }
}

/**
 * Inicia (o reutiliza) la conversación directa de un contacto para una
 * identidad/conexión. Devuelve la conversación existente sin reabrirla en
 * silencio. WhatsApp crea el hilo `wa:<dígitos>` sin `lastInboundAt`
 * (el primer envío oficial exigirá plantilla). Telegram requiere una
 * conversación directa previamente recibida por ese bot.
 */
export async function startContactConversation(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  contactId: string,
  input: { identityId: string; connectionId: string },
): Promise<{ id: string; status: string; created: boolean }> {
  const actor = { userId: actorUserId }
  const [candidate] = await tx
    .select()
    .from(contactIdentity)
    .where(and(eq(contactIdentity.id, input.identityId), eq(contactIdentity.organizationId, orgId)))
    .limit(1)
  if (!candidate) throw notFound("Identidad de canal")
  await lockChannelIdentity(tx, orgId, candidate.channel, candidate.externalUserId)
  const [identity] = await tx
    .select()
    .from(contactIdentity)
    .where(and(eq(contactIdentity.id, input.identityId), eq(contactIdentity.organizationId, orgId)))
    .for("share")
  if (!identity || identity.contactId !== contactId) throw notFound("Identidad de canal")
  const [contactRow] = await tx
    .select({ id: contact.id, isActive: contact.isActive })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .for("update")
  if (!contactRow) throw notFound("Contacto")
  if (!contactRow.isActive)
    throw new ServiceError(
      "CONTACT_ARCHIVED",
      409,
      "Reactiva el contacto para iniciar conversaciones",
    )
  if (!OMNI_CHANNELS.includes(identity.channel as (typeof OMNI_CHANNELS)[number])) {
    throw validation("Canal no soportado: solo whatsapp, telegram, messenger o instagram")
  }
  const [connection] = await tx
    .select()
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.id, input.connectionId),
        eq(channelConnection.organizationId, orgId),
      ),
    )
    .limit(1)
    .for("share")
  if (!connection) throw notFound("Conexión")
  if (connection.status !== "active") {
    throw new ServiceError("CONNECTION_DISABLED", 409, "Conexión desactivada")
  }
  if (connection.channel !== identity.channel) {
    throw validation("La conexión es de otro canal distinto al de la identidad")
  }
  const candidates = await tx
    .select({
      id: conversation.id,
      status: conversation.status,
      externalThreadId: conversation.externalThreadId,
      lastInboundAt: conversation.lastInboundAt,
    })
    .from(conversation)
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.contactId, contactId),
        eq(conversation.contactIdentityId, identity.id),
        eq(conversation.channelConnectionId, connection.id),
      ),
    )
  // Solo WhatsApp crea el hilo en frío (con plantilla obligatoria). Telegram,
  // Messenger e Instagram exigen que la persona escriba primero.
  const needsPriorInbound = identity.channel !== "whatsapp"
  const existing = candidates.find(
    (row) =>
      isDirectThread(identity.channel, row.externalThreadId, identity.externalUserId) &&
      (!needsPriorInbound || row.lastInboundAt !== null),
  )
  if (existing) return { id: existing.id, status: existing.status, created: false }
  if (needsPriorInbound) {
    const who =
      identity.channel === "telegram"
        ? "Telegram exige que la persona escriba primero al bot"
        : "Meta exige que la persona escriba primero a la página o cuenta"
    throw new ServiceError(
      "CHANNEL_REQUIRES_INBOUND",
      409,
      `${who}: sin conversación previa no se puede iniciar`,
    )
  }
  const [created] = await tx
    .insert(conversation)
    .values({
      organizationId: orgId,
      contactId,
      contactIdentityId: identity.id,
      channelConnectionId: connection.id,
      externalThreadId: identity.externalUserId,
    })
    .onConflictDoNothing({
      target: [conversation.channelConnectionId, conversation.externalThreadId],
    })
    .returning({ id: conversation.id, status: conversation.status })
  if (created) {
    await audit(tx, orgId, {
      actorUserId: actor?.userId ?? null,
      action: "conversation.started",
      entity: "conversation",
      entityId: created.id,
      metadata: {
        conversationId: created.id,
        contactId,
        identityId: identity.id,
        connectionId: connection.id,
      },
    })
    return { id: created.id, status: created.status, created: true }
  }
  const [retry] = await tx
    .select({ id: conversation.id, status: conversation.status, contactId: conversation.contactId })
    .from(conversation)
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.channelConnectionId, connection.id),
        eq(conversation.externalThreadId, identity.externalUserId),
      ),
    )
    .limit(1)
  if (!retry || retry.contactId !== contactId) {
    throw new ServiceError(
      "AMBIGUOUS_CHANNEL_HISTORY",
      409,
      "El hilo ya existe con otro contacto: resuélvelo manualmente",
    )
  }
  return { id: retry.id, status: retry.status, created: false }
}
