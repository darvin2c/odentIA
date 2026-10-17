import {
  type ChannelAdapter,
  channelAdapters,
  type NormalizedStatus,
  type ReplyButton,
  type TemplateCategory,
} from "@odentia/channels"
import { normalizePhone } from "@odentia/clinical"
import { type Db, type InboundMessageJob, sendOutboundMessage } from "@odentia/db"
import {
  agentConfig,
  channelConnection,
  contact,
  contactIdentity,
  conversation,
  message,
} from "@odentia/db/schema/crm"
import { automationJob } from "@odentia/db/schema/automation"
import { patientContact } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, ilike, inArray, lt, or, type SQL, sql } from "drizzle-orm"
import { lineOfJobKind } from "./admin-lines.js"
import { assertTemplateSendable } from "./channel-templates.js"
import {
  claimWhatsAppNumber,
  findChannelIdentity,
  isDirectThread,
  isTelegramGroupThread,
  lockChannelIdentity,
  OMNI_CHANNELS,
} from "./contacts.js"
import { decodeCursor, encodeCursor } from "./cursors.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { CONVERSATION_VIEWS, type ConversationView, conversationViewSql } from "./conversation-state.js"
import { findOrgCountry } from "./locale.js"
import { hidePersonalLinkRefs } from "./personal-link-token.js"
import { windowOpen } from "./message-window.js"
import { decryptConfig } from "./secrets.js"
import type { AttachmentRef, Storage } from "./storage.js"


/** Acepta las marcas UTC emitidas por nuestros cursores sin perder microsegundos. */
function conversationCursor(value: string): { ts: string; id: string } {
  const decoded = decodeCursor(value)
  if (!decoded ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.id) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(decoded.ts)) {
    throw validation("Cursor inválido")
  }
  const date = new Date(decoded.ts)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== decoded.ts.slice(0, 19)) {
    throw validation("Cursor inválido")
  }
  return decoded
}

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

/**
 * ¿El agente leerá lo que entra en este hilo? Encendido en la conversación y
 * en la clínica, y atendiendo ese canal. El horario no cuenta: fuera de él lo
 * lee al abrir.
 */
async function agentReadsThread(tx: Db, orgId: string, conversationId: string, channel: string): Promise<boolean> {
  const [conv] = await tx
    .select({ agentStatus: conversation.agentStatus })
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (conv?.agentStatus !== "on") return false
  const [cfg] = await tx
    .select({ enabled: agentConfig.enabled, channels: agentConfig.channels })
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  return Boolean(cfg?.enabled) && (!cfg?.channels || cfg.channels.includes(channel))
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
  // Instante de aceptación real por el proveedor (outbound). Nulo si aún está
  // en cola/falló o si es histórico sin timestamp (sin backfill inventado).
  sentAt: string | null
  templateName: string | null
  templateLanguage: string | null
  templateParams: string[] | null
  /**
   * El mensaje lo envió una línea del Administrador, no una respuesta de la
   * conversación: cuál fue. Nulo en cualquier otro mensaje.
   */
  automatic: { key: string; name: string } | null
  createdAt: string
}
function toMessageItem(row: typeof message.$inferSelect, automatic: MessageItem["automatic"] = null): MessageItem {
  return {
    automatic,
    id: row.id,
    direction: row.direction,
    senderKind: row.senderKind,
    senderUserId: row.senderUserId,
    contentType: row.contentType,
    // «Su enlace» se ve sin su token: en el mensaje solo hay una referencia.
    body: row.body === null ? null : hidePersonalLinkRefs(row.body),
    attachments: row.attachments,
    externalId: row.externalId,
    status: row.status,
    error: row.error,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
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
    // Escribió desde ese número: sí tiene WhatsApp (decisión 23).
    if (identity.noWhatsappAt) {
      await tx
        .update(contactIdentity)
        .set({ noWhatsappAt: null })
        .where(and(eq(contactIdentity.organizationId, orgId), eq(contactIdentity.id, identity.id)))
    }
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
    // Un «hola» no es una oportunidad: la crea el agente o el equipo cuando la
    // persona pide algo concreto (ADR 0028).
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
    // Todo mensaje de la persona reabre la conversación cerrada antes que nada
    // (ADR 0024): ningún entrante queda escondido en una cerrada.
    if (existing.status === "closed") {
      await reopenIfClosed(tx, orgId, existing.id, { userId: null, via: "entrante" })
    }
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
  // Solo si el agente la va a leer (ADR 0031): con él apagado queda el audio
  // para el equipo y no se paga una transcripción que nadie usa.
  // Best-effort: si falla, body queda null y la ingesta no se pierde.
  if (
    mediaDownload &&
    contentType === "audio" &&
    body === null &&
    deps.transcribe &&
    (await agentReadsThread(tx, orgId, conversationId, channel))
  ) {
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
      // La persona respondió: si vuelve a callar, el agente puede insistir otra vez.
      nudgedAt: null,
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

/**
 * Aplica estados del proveedor por externalId. Registra el primer
 * sent/delivered/read en sent_at si sigue nulo; un fallo guarda el motivo que
 * entrega el adaptador (de ahí lo lee `reconcileDeliveries`).
 */
/**
 * WhatsApp no pudo entregar un mensaje porque el número no tiene WhatsApp
 * (decisión 23, caso 1): su identidad queda marcada. La ficha lo dice y no se
 * le vuelve a escribir por ahí hasta que escriba desde ese número o el equipo
 * lo vuelva a marcar como su WhatsApp.
 */
async function markNotOnWhatsApp(tx: Db, orgId: string, conversationId: string): Promise<void> {
  await tx.execute(sql`
    update contact_identity ci set no_whatsapp_at = now()
    from conversation cv
    where cv.organization_id = ${orgId} and cv.id = ${conversationId}
      and ci.organization_id = cv.organization_id and ci.id = cv.contact_identity_id
      and ci.channel = 'whatsapp' and ci.no_whatsapp_at is null`)
}

export async function applyStatus(
  tx: Db,
  orgId: string,
  statuses: NormalizedStatus[],
): Promise<number> {
  let applied = 0
  for (const s of statuses) {
    const status: string = s.status
    const firstSent = status === "sent" || status === "delivered" || status === "read"
    const [updated] = firstSent
      ? await tx
          .update(message)
          .set({ status: s.status, sentAt: sql`coalesce("sent_at", now())` })
          .where(and(eq(message.organizationId, orgId), eq(message.externalId, s.externalMessageId)))
          .returning({ id: message.id, conversationId: message.conversationId })
      : await tx
          .update(message)
          .set({ status: s.status, ...(s.error ? { error: s.error.slice(0, 500) } : {}) })
          .where(and(eq(message.organizationId, orgId), eq(message.externalId, s.externalMessageId)))
          .returning({ id: message.id, conversationId: message.conversationId })
    if (updated && s.notOnWhatsApp) await markNotOnWhatsApp(tx, orgId, updated.conversationId)
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
  /**
   * `listUnsubscribe`: en un correo automático, el enlace de baja que el
   * adaptador envía como cabecera `List-Unsubscribe` (RFC 2369).
   */
  | { type: "text"; text: string; buttons?: ReplyButton[]; listUnsubscribe?: string }
  // `preview` es el texto ya armado: lo que la persona lee, para mostrarlo en el hilo.
  | {
      type: "template"
      name: string
      language: string
      params: string[]
      buttons?: ReplyButton[]
      /** Token de «Su enlace» para el botón que lo abre (ADR 0037). */
      link?: string
      preview?: string
    }
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

/** Acciones de auditoría que cambian el estado de una conversación: el replay de SSE las entrega como `conversation.updated`. */
export const CONVERSATION_STATE_ACTIONS = [
  "conversation.updated",
  "conversation.closed",
  "conversation.resolved",
  "conversation.closed_resuelta",
  "conversation.closed_sin_respuesta",
  "conversation.reopened",
  "conversation.reopened_by_message",
  "conversation.taken",
  "conversation.released",
] as const

/**
 * Reabre una conversación cerrada (ADR 0024): vuelve a estar abierta, sin
 * cierre, con una atención nueva, sin recordatorio y con el agente encendido.
 * `via` dice por qué: un entrante de la persona, un envío de la clínica o el
 * botón «Reabrir». Devuelve si estaba cerrada; una abierta no se toca.
 */
export async function reopenIfClosed(
  tx: Db,
  orgId: string,
  id: string,
  by: { userId: string | null; via: "entrante" | "envio" | "equipo" },
): Promise<boolean> {
  const now = new Date()
  const [reopened] = await tx
    .update(conversation)
    .set({
      status: "open",
      closedAt: null,
      closedByUserId: null,
      closeReason: null,
      attentionStartedAt: now,
      nudgedAt: null,
      agentStatus: "on",
      updatedAt: now,
    })
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId), eq(conversation.status, "closed")))
    .returning({ id: conversation.id })
  if (!reopened) return false
  await audit(tx, orgId, {
    actorUserId: by.userId,
    action: by.via === "entrante" ? "conversation.reopened_by_message" : "conversation.reopened",
    entity: "conversation",
    entityId: id,
    metadata: { via: by.via },
  })
  await notify(tx, { orgId, kind: "conversation.updated", conversationId: id, at: now.toISOString() })
  return true
}

/**
 * La conversación con su conexión, para escribir en ella. Escribir a una
 * cerrada la reabre con quién lo hizo (ADR 0024): ya no se rechaza con
 * `CONVERSATION_CLOSED`.
 */
async function requireWritableConversation(tx: Db, orgId: string, conversationId: string, by: { userId: string | null }) {
  const read = () =>
    tx
      .select({ conversation, connection: channelConnection })
      .from(conversation)
      .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
      .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
  const [row] = await read()
  if (!row) throw notFound("Conversación")
  if (row.conversation.status !== "closed") return row
  await reopenIfClosed(tx, orgId, conversationId, { userId: by.userId, via: "envio" })
  const [reopened] = await read()
  if (!reopened) throw notFound("Conversación")
  return reopened
}

function assertWindowAllows(
  row: { conversation: typeof conversation.$inferSelect },
  content: OutboundContent,
): void {
  // Los media salientes también son mensajes de sesión sujetos a la ventana.
  if (content.type === "template") return
  if (!windowOpen(row.conversation.lastInboundAt)) {
    throw new ServiceError(
      "WINDOW_CLOSED",
      409,
      "Pasaron más de 24 horas desde que la persona escribió: WhatsApp solo deja enviarle un mensaje aprobado.",
    )
  }
}

/** Meta (Messenger/Instagram) exige ventana de 24h y no admite plantillas. */
function assertMetaWindowAllows(row: {
  conversation: typeof conversation.$inferSelect
}): void {
  if (!windowOpen(row.conversation.lastInboundAt)) {
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
  const row = await requireWritableConversation(tx, orgId, input.conversationId, { userId: input.senderUserId ?? null })
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
            : (content.preview ?? null),
      templateName: content.type === "template" ? content.name : null,
      templateLanguage: content.type === "template" ? content.language : null,
      templateParams: content.type === "template" ? content.params : null,
      templateLink: content.type === "template" ? (content.link ?? null) : null,
      replyButtons: content.type !== "media" && content.buttons?.length ? content.buttons : null,
      listUnsubscribe: content.type === "text" ? (content.listUnsubscribe ?? null) : null,
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

/**
 * Envío de plantilla. La valida contra el catálogo de la conexión: tiene que
 * estar aprobada por el proveedor, llevar tantos datos como variables tiene y
 * respetar su categoría (`category`, la que se pidió: lo que WhatsApp cuenta
 * como promoción solo sale a quien aceptó novedades). Es la misma regla para
 * una persona, una automatización y el sistema (ADR 0040).
 */
export async function sendTemplateOutbound(
  tx: Db,
  orgId: string,
  _secretsKey: Buffer,
  input: {
    conversationId: string
    senderKind: "user" | "agent"
    senderUserId?: string | null
    name: string
    language: string
    params: string[]
    /** La categoría con la que se pidió el mensaje. */
    category: TemplateCategory
    buttons?: ReplyButton[]
    /** Token de «Su enlace» para el botón de la plantilla que lo abre. */
    link?: string
    preview?: string
  },
): Promise<MessageItem> {
  // Abierta o cerrada: el envío (sendOutbound) la reabre si hace falta.
  const [row] = await tx
    .select({ connection: channelConnection, contactId: conversation.contactId })
    .from(conversation)
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  const template = await assertTemplateSendable(tx, orgId, row.connection.id, {
    name: input.name,
    language: input.language,
    params: input.params.length,
    category: input.category,
    contactId: row.contactId,
  })
  // Sin texto armado por quien envía, se arma con el cuerpo del catálogo.
  const preview =
    input.preview ??
    (template.body
      ? template.body.replace(/\{\{(\d+)\}\}/g, (_, position: string) => input.params[Number(position) - 1] ?? "")
      : undefined)
  return sendOutbound(tx, orgId, {
    conversationId: input.conversationId,
    senderKind: input.senderKind,
    senderUserId: input.senderUserId,
    content: {
      type: "template",
      name: input.name,
      language: input.language,
      params: input.params,
      ...(input.buttons?.length ? { buttons: input.buttons } : {}),
      ...(input.link ? { link: input.link } : {}),
      ...(preview ? { preview } : {}),
    },
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
/** Estados de una conversación: abierta o cerrada (con su motivo, ADR 0024). */
export const CONVERSATION_STATUSES = ["open", "closed"] as const

export interface ConversationFilters {
  status?: string
  channel?: string
  assigned?: string
  q?: string
}

/** Filtros de la bandeja sobre `conversation` + `contact` + `channel_connection`. */
function conversationFilterConditions(orgId: string, input: ConversationFilters): SQL[] {
  const conditions: SQL[] = [eq(conversation.organizationId, orgId)]
  if (input.status) {
    if (!(CONVERSATION_STATUSES as readonly string[]).includes(input.status)) {
      throw validation(`Estado inválido (${CONVERSATION_STATUSES.join("|")})`)
    }
    conditions.push(eq(conversation.status, input.status))
  }
  if (input.channel) conditions.push(eq(channelConnection.channel, input.channel))
  if (input.assigned === "none") {
    conditions.push(sql`"conversation"."assigned_user_id" is null`)
  } else if (input.assigned) {
    conditions.push(eq(conversation.assignedUserId, input.assigned))
  }
  const q = input.q?.trim()
  if (q) {
    const byName = ilike(contact.displayName, `%${q}%`)
    const digits = phoneDigitsOf(q)
    // Por teléfono: los dígitos del número que la persona dio o del hilo de
    // WhatsApp. Buscar solo filtra la lista; nunca identifica a nadie.
    conditions.push(
      digits
        ? or(
            byName,
            sql`regexp_replace(coalesce(${contact.phone}, ''), '[^0-9]', '', 'g') like ${`%${digits}%`}`,
            and(
              eq(channelConnection.channel, "whatsapp"),
              sql`regexp_replace(${conversation.externalThreadId}, '[^0-9]', '', 'g') like ${`%${digits}%`}`,
            ),
          )!
        : byName,
    )
  }
  return conditions
}

/**
 * Los dígitos de una búsqueda que parece un teléfono (al menos cuatro, entre
 * espacios, guiones, paréntesis o «+»); null si busca otra cosa.
 */
export function phoneDigitsOf(query: string): string | null {
  const trimmed = query.trim()
  if (!/^[\d\s\-()+.]+$/.test(trimmed)) return null
  const digits = trimmed.replace(/\D/g, "")
  return digits.length >= 4 ? digits : null
}

/**
 * Condiciones de cada vista de la bandeja: lista y contadores comparten la
 * única definición de `conversation-state.ts`.
 */
function conversationViewConditions(view: ConversationView): SQL[] {
  if (!(CONVERSATION_VIEWS as readonly string[]).includes(view)) {
    throw validation(`Vista inválida (${CONVERSATION_VIEWS.join("|")})`)
  }
  return [conversationViewSql(sql.raw('"conversation"'), view)]
}

/**
 * Totales de la bandeja con los filtros dados: todas las que cumplen los
 * filtros y, de ellas, cuántas caen en cada vista pedida. Se cuenta en
 * servidor sobre todo el resultado, no sobre la página cargada.
 */
export async function countConversationViews<V extends ConversationView>(
  tx: Db,
  orgId: string,
  input: ConversationFilters,
  views: readonly V[],
): Promise<{ all: number } & Record<V, number>> {
  const selection: Record<string, SQL<number>> = { all: sql<number>`count(*)::int` }
  for (const view of views) {
    selection[view] = sql<number>`(count(*) filter (where ${and(...conversationViewConditions(view))}))::int`
  }
  const [row] = await tx
    .select(selection)
    .from(conversation)
    .innerJoin(contact, eq(conversation.contactId, contact.id))
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(...conversationFilterConditions(orgId, input)))
  const totals: Record<string, number> = { all: row?.all ?? 0 }
  for (const view of views) totals[view] = row?.[view] ?? 0
  return totals as { all: number } & Record<V, number>
}

export async function listConversations(
  tx: Db,
  orgId: string,
  input: ConversationFilters & {
    view?: ConversationView
    cursor?: string
    limit?: number
  },
): Promise<{ items: ConversationListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100)
  const conditions = conversationFilterConditions(orgId, input)
  if (input.view !== undefined) conditions.push(...conversationViewConditions(input.view))
  const activityAt = sql`coalesce(${conversation.lastMessageAt}, ${conversation.createdAt})`
  if (input.cursor) {
    const decoded = conversationCursor(input.cursor)
    const ts = sql`${decoded.ts}::timestamptz`
    conditions.push(
      or(
        sql`${activityAt} < ${ts}`,
        and(sql`${activityAt} = ${ts}`, lt(conversation.id, decoded.id)),
      )!,
    )
  }
  const rows = await tx
    .select({
      conversation, contact, connection: channelConnection,
      cursorAt: sql<string>`to_char(${activityAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(conversation)
    .innerJoin(contact, eq(conversation.contactId, contact.id))
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(...conditions))
    .orderBy(desc(activityAt), desc(conversation.id))
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
    rows.length > limit && last
      ? encodeCursor(last.cursorAt, last.conversation.id)
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
    const decoded = conversationCursor(input.before)
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
  // Los mensajes que salieron por una línea del Administrador se marcan como automáticos.
  const outgoing = page.filter((row) => row.direction === "out").map((row) => row.id)
  const lines = outgoing.length
    ? await tx
        .select({ messageId: automationJob.sentMessageId, kind: automationJob.kind })
        .from(automationJob)
        .where(and(eq(automationJob.organizationId, orgId), inArray(automationJob.sentMessageId, outgoing)))
    : []
  const lineOf = new Map(lines.map((row) => [row.messageId, row.kind]))
  const automaticOf = (id: string): MessageItem["automatic"] => {
    const key = lineOf.get(id)
    // Un aviso de cita sale por «Recordar la cita»: se dice esa línea.
    const line = key ? lineOfJobKind(key) : null
    return key ? { key: line?.key ?? key, name: line?.name ?? key } : null
  }
  return {
    items: page.reverse().map((row) => toMessageItem(row, automaticOf(row.id))),
    nextCursor:
      rows.length > limit && oldest
        ? encodeCursor(oldest.createdAt.toISOString(), oldest.id)
        : null,
  }
}

export interface CrossThreadMessage {
  direction: string
  senderKind: string
  body: string | null
  createdAt: string
}

export interface ContactChannelHistoryItem {
  conversationId: string
  channel: string
  provider: string
  connectionName: string
  lastMessageAt: string | null
  messages: CrossThreadMessage[]
}

/**
 * Recuperación acotada y paginada del historial de otros hilos del mismo
 * contacto verificado, con procedencia (canal/conexión). La autorización la
 * da el contactId vigente del hilo: nunca se resuelve identidad por
 * coincidencia de teléfono ni se mezclan contactos. Al reasignar una
 * identidad los hilos transferidos cambian de contactId y dejan de aparecer
 * aquí para el contacto origen. Son mensajes conversacionales; nunca
 * historia clínica ni notas.
 */
export async function listContactChannelHistory(
  tx: Db,
  orgId: string,
  input: {
    contactId: string
    excludeConversationId?: string
    perConversation?: number
    limit?: number
    cursor?: string
  },
): Promise<{ items: ContactChannelHistoryItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 3, 1), 10)
  const per = Math.min(Math.max(input.perConversation ?? 5, 1), 20)
  const conditions = [
    eq(conversation.organizationId, orgId),
    eq(conversation.contactId, input.contactId),
  ]
  if (input.excludeConversationId) {
    conditions.push(sql`${conversation.id} <> ${input.excludeConversationId}::uuid`)
  }
  const activityAt = sql`coalesce(${conversation.lastMessageAt}, ${conversation.createdAt})`
  if (input.cursor) {
    const decoded = conversationCursor(input.cursor)
    const ts = sql`${decoded.ts}::timestamptz`
    conditions.push(
      or(
        sql`${activityAt} < ${ts}`,
        and(sql`${activityAt} = ${ts}`, lt(conversation.id, decoded.id)),
      )!,
    )
  }
  const rows = await tx
    .select({
      conversation,
      connection: channelConnection,
      cursorAt: sql<string>`to_char(${activityAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(conversation)
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(and(...conditions))
    .orderBy(desc(activityAt), desc(conversation.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const byConversation = new Map<string, CrossThreadMessage[]>()
  if (page.length > 0) {
    const ids = page.map((r) => r.conversation.id)
    const messageRows = (await tx.execute(sql`
      select "conversation_id", "direction", "sender_kind", "body", "created_at"
      from (
        select "id", "conversation_id", "direction", "sender_kind", "body", "created_at",
          row_number() over (partition by "conversation_id" order by "created_at" desc, "id" desc) as rn
        from "message"
        where "organization_id" = ${orgId}
          and "conversation_id" in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
      ) t
      where rn <= ${per}
      order by "conversation_id", "created_at" asc, "id" asc`)) as unknown as {
      conversation_id: string
      direction: string
      sender_kind: string
      body: string | null
      created_at: Date
    }[]
    for (const m of messageRows) {
      const list = byConversation.get(m.conversation_id) ?? []
      list.push({
        direction: m.direction,
        senderKind: m.sender_kind,
        body: m.body,
        createdAt: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at),
      })
      byConversation.set(m.conversation_id, list)
    }
  }
  const items: ContactChannelHistoryItem[] = page.map((r) => ({
    conversationId: r.conversation.id,
    channel: r.connection.channel,
    provider: r.connection.provider,
    connectionName: r.connection.displayName,
    lastMessageAt: r.conversation.lastMessageAt ? r.conversation.lastMessageAt.toISOString() : null,
    messages: byConversation.get(r.conversation.id) ?? [],
  }))
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(last.cursorAt, last.conversation.id)
      : null
  return { items, nextCursor }
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
  /** `isPatient`: su página la abre también quien solo ve pacientes (caja, odontología). */
  contact: { id: string; displayName: string; isActive: boolean; isPatient: boolean }
  connection: {
    id: string
    channel: string
    provider: string
    displayName: string
    capabilities: unknown
  }
  /**
   * La ventana de 24 horas de WhatsApp, para decirlo antes de escribir: abierta
   * se responde con libertad; cerrada, solo con un mensaje aprobado. Nulo en
   * los demás canales.
   */
  whatsappWindow: { open: boolean; lastInboundAt: string | null } | null
  messages: MessageItem[]
  messagesCursor: string | null
}

/** La persona ya es paciente (tiene su ficha propia). */
async function isSelfPatient(tx: Db, orgId: string, contactId: string): Promise<boolean> {
  const [own] = await tx
    .select({ id: patientContact.id })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.contactId, contactId),
        eq(patientContact.relationship, "self"),
      ),
    )
    .limit(1)
  return !!own
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
      isPatient: await isSelfPatient(tx, orgId, row.contact.id),
    },
    connection: {
      id: row.connection.id,
      channel: row.connection.channel,
      provider: row.connection.provider,
      displayName: row.connection.displayName,
      capabilities: adapter?.capabilities ?? null,
    },
    whatsappWindow:
      row.connection.provider === "whatsapp_cloud_api"
        ? {
            open: windowOpen(row.conversation.lastInboundAt),
            lastInboundAt: row.conversation.lastInboundAt?.toISOString() ?? null,
          }
        : null,
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

/** «Reabrir»: reabre a mano una conversación cerrada, sin mensaje. Una abierta queda igual. */
export async function reopenConversation(
  tx: Db,
  orgId: string,
  id: string,
  actorUserId?: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  await reopenIfClosed(tx, orgId, id, { userId: actorUserId ?? null, via: "equipo" })
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

export interface WriteToPersonResult {
  conversationId: string
  /** Se abrió una conversación nueva (antes no había ninguna por ese canal). */
  created: boolean
  channel: string
  /** El número de WhatsApp quedó como canal de la persona en este paso. */
  identityCreated: boolean
}

/**
 * «Escribirle»: la única vía para que una persona del equipo escriba a alguien
 * desde la Bandeja, la ficha, la Agenda o Finanzas. Devuelve la conversación
 * por la que se le escribe, sin enviar nada:
 *
 * 1. La conversación en la que la persona escribió en las últimas 24 horas, si
 *    hay una: ahí se le responde con libertad.
 * 2. Si no, WhatsApp: su hilo si ya existe o uno nuevo con su número. Si nunca
 *    escribió, la Bandeja ofrece los mensajes aprobados para empezar.
 * 3. Si no hay WhatsApp posible, la conversación más reciente que siga
 *    conectada.
 *
 * El número que se usa es el que una persona del equipo eligió en este paso
 * (`phone`) o el que la ficha tiene declarado y esa persona aceptó al pulsar
 * «Escribirle». Es la única forma, junto al alta manual, en que un teléfono se
 * convierte en canal de alguien; un mensaje que entra nunca se une a una ficha
 * por coincidir su número (ADR 0027). Si ese número ya es de otra persona de
 * la clínica, no se mueve: se dice.
 */
export async function writeToPerson(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  contactId: string,
  input: { phone?: string | null } = {},
): Promise<WriteToPersonResult> {
  const [person] = await tx
    .select({ id: contact.id, isActive: contact.isActive, phone: contact.phone })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!person) throw notFound("Contacto")
  if (!person.isActive) throw new ServiceError("CONTACT_ARCHIVED", 409, "Reactiva a la persona para escribirle")
  const threads = await tx
    .select({
      id: conversation.id,
      lastInboundAt: conversation.lastInboundAt,
      externalThreadId: conversation.externalThreadId,
      identityId: conversation.contactIdentityId,
      channel: channelConnection.channel,
      connectionId: channelConnection.id,
    })
    .from(conversation)
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.contactId, contactId),
        eq(channelConnection.status, "active"),
      ),
    )
    .orderBy(desc(sql`coalesce(${conversation.lastMessageAt}, ${conversation.createdAt})`), desc(conversation.id))
  const now = Date.now()
  const typedPhone = input.phone?.trim() || null
  if (!typedPhone) {
    const live = threads.find(
      (row) => windowOpen(row.lastInboundAt, now),
    )
    if (live) return { conversationId: live.id, created: false, channel: live.channel, identityCreated: false }
  }
  const [whatsapp] = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, "whatsapp"),
        eq(channelConnection.status, "active"),
      ),
    )
    .orderBy(asc(channelConnection.createdAt), asc(channelConnection.id))
    .limit(1)
  const fallback = threads[0]
  if (!whatsapp) {
    if (fallback && !typedPhone) {
      return { conversationId: fallback.id, created: false, channel: fallback.channel, identityCreated: false }
    }
    throw new ServiceError(
      "NO_WHATSAPP",
      409,
      "La clínica no tiene WhatsApp conectado. Pídele a quien administra la clínica que lo conecte en Configuración › Integraciones.",
    )
  }
  let identityId: string | null = null
  let identityCreated = false
  if (!typedPhone) {
    const [known] = await tx
      .select({ id: contactIdentity.id })
      .from(contactIdentity)
      .where(
        and(
          eq(contactIdentity.organizationId, orgId),
          eq(contactIdentity.contactId, contactId),
          eq(contactIdentity.channel, "whatsapp"),
        ),
      )
      .orderBy(desc(contactIdentity.isPrimary), asc(contactIdentity.createdAt), asc(contactIdentity.id))
      .limit(1)
    identityId = known?.id ?? null
  }
  let phone = identityId ? null : person.phone
  if (typedPhone) {
    phone = normalizePhone(typedPhone) ?? normalizePhone(typedPhone, await findOrgCountry(tx, orgId))
    if (!phone) throw validation("Escribe el número de WhatsApp con el código de su país.")
  }
  if (!identityId && phone) {
    const claimed = await claimWhatsAppNumber(tx, orgId, actorUserId, contactId, phone)
    identityId = claimed.identityId
    identityCreated = claimed.created
  }
  if (!identityId) {
    if (fallback) return { conversationId: fallback.id, created: false, channel: fallback.channel, identityCreated: false }
    throw new ServiceError("NO_PHONE", 409, "Falta su número de WhatsApp: escríbelo para poder escribirle.")
  }
  const started = await startContactConversation(tx, orgId, actorUserId, contactId, {
    identityId,
    connectionId: whatsapp.id,
  })
  return { conversationId: started.id, created: started.created, channel: "whatsapp", identityCreated }
}
