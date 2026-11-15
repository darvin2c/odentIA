/**
 * Los canales de la administración: lo que le escriben a Sallca por WhatsApp
 * (su número), Instagram (su cuenta) o Messenger (su página de Facebook)
 * entra como el correo (`admin-inbound-email.ts`). Lo manda la ruta firmada
 * del webhook de Meta, después de bajar los archivos; entra una sola vez por
 * su `wamid` (`external_id`).
 *
 * Una conversación (`saas_chat`) es una por remitente. Nunca se liga sola por
 * el teléfono, ni siquiera si coincide con el celular de un contacto: lo decide
 * una persona de Administración (`assignChat`), con la sugerencia de
 * `chatSuggestion` cuando un solo contacto tiene ese número. Con cliente, cada
 * mensaje deja su actividad («Nos escribió por WhatsApp», por Instagram o por
 * Messenger) y sus archivos pasan a
 * ser documentos del cliente, solo de Administración, que se guardan hasta que
 * Administración marca la carga (`markClientFileCarga`).
 *
 * Quién ve qué: una conversación sin cliente, o de un cliente que aún no tiene
 * su cuenta, es comercial y solo la ve Administración. La de una clínica que
 * ya tiene su app también la ve Soporte; lo que Administración responde ahí lo
 * ve Soporte salvo que lo marque «Solo administración». Se decide al escribirlo
 * (`admin_only` del mensaje y del envío), no al leerlo: lo que llegó o salió
 * mientras era venta sigue siendo solo de Administración aunque la clínica
 * tenga su app después, y si la conversación pasa a un cliente sin app, todo
 * sube a solo Administración (nunca baja). Para Soporte, lo que no ve no existe
 * (404).
 *
 * Responder: texto libre solo dentro de las 24 h desde el último mensaje de la
 * persona; después, la plantilla. `prepareChatReply` reserva el envío
 * (`pendiente`) y la ruta lo envía después del commit; el resultado lo anotan
 * `markChatOutreachSent`, `markChatOutreachFailed` (rechazo explícito de Meta)
 * o `markChatOutreachUncertain` (no se sabe: nunca se reintenta), y los estados
 * que llegan después, `applyChatStatus`. Nada de esto viaja al modelo.
 */

import { isClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  kairosChatTurn,
  kairosItem,
  SAAS_CHAT_CHANNELS,
  type SaasChatChannel,
  type SaasInboundMedia,
  type SaasOutreachPurpose,
  type SaasOutreachStatus,
  saasChat,
  saasClient,
  saasClientContact,
  saasClientFile,
  saasInboundMessage,
  saasOutreach,
  saasProposal,
} from "@odentia/db/schema/admin-arm"
import { user } from "@odentia/db/schema/auth"
import { saasFollowUp, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import { mailBrandName } from "@odentia/mail"
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import { cargaDeleteAfter, cleanFilename, registerClientFile } from "./admin-client-files.js"
import { outreachAdminOnlySql } from "./admin-clients.js"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { sendableProposal } from "./admin-sales.js"
import { invalidField, issueFields, notFound, ServiceError, validation } from "./errors.js"
import { getKairosSells } from "./kairos-sells.js"
import { limaDate } from "./peru-business-days.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const E164 = /^\+[1-9][0-9]{6,14}$/

/** Cuánto dura la ventana de WhatsApp para responder con texto libre desde el último mensaje. */
export const CHAT_FREE_REPLY_MS = 24 * 60 * 60_000
/** Las plantillas con que se retoma una conversación fuera de las 24 h. */
export const CHAT_TEMPLATES = ["retomar_conversacion"] as const
export type ChatTemplate = (typeof CHAT_TEMPLATES)[number]
/** Cuántos archivos trae como mucho un mensaje (Meta manda uno; el tope es de seguridad). */
export const CHAT_MEDIA_MAX = 10
const BODY_MAX = 10_000
const OUTREACH_BODY_MAX = 5000
const ACTIVITY_MAX = 2000

const mediaSchema = z.strictObject({
  /** Dónde lo guardó quien llama (`inboundAttachmentKey`). */
  objectKey: z
    .string()
    .regex(/^inbound\/[A-Za-z0-9_.-]{1,200}$/, "La clave del archivo no es de un mensaje entrante"),
  mimeType: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/, "Tipo de archivo no válido"),
  filename: z.string().min(1, "Falta el nombre del archivo").max(1000),
  size: z.number().int("Tamaño no válido").min(0, "Tamaño no válido"),
})

/** El id de quien escribe en Instagram (IGSID) o Messenger (PSID): texto sin espacios. */
const META_USER_ID = /^[^\s]{1,128}$/

const inboundSchema = z
  .strictObject({
    channel: z.enum(SAAS_CHAT_CHANNELS, "Canal no válido"),
    /** WhatsApp: el número en E.164; Instagram, el IGSID; Messenger, el PSID. */
    address: z.string().trim().regex(META_USER_ID, "Falta quién escribe"),
    /** Solo WhatsApp: el `wa_id` (o BSUID) de quien escribe. */
    waId: z.string().trim().max(256).nullish(),
    displayName: z.string().nullish(),
    externalId: z.string().trim().min(1, "Falta el id del mensaje").max(256, "Id demasiado largo"),
    body: z.string().nullish(),
    media: z.array(mediaSchema).max(CHAT_MEDIA_MAX, "Demasiados archivos").default([]),
    receivedAt: z.date("Fecha de llegada no válida"),
  })
  .refine((value) => value.channel !== "whatsapp" || E164.test(value.address), {
    message: "El número de quien escribe no es E.164",
    path: ["address"],
  })
export type InboundChatInput = z.input<typeof inboundSchema>

export interface InboundChatResult {
  chatId: string
  messageId: string
  /** Ya había llegado (mismo id de Meta): no se registró otra vez. Quien llama borra lo que subió. */
  duplicate: boolean
  clientId: string | null
}

type ChatRow = typeof saasChat.$inferSelect
type MessageRow = typeof saasInboundMessage.$inferSelect
type OutreachRecord = typeof saasOutreach.$inferSelect

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", 403, message)
}

function requireAdmin(actor: AdminActor | null): AdminActor {
  if (!actor) throw forbidden("Se requiere personal de administración")
  if (actor.role !== "admin") throw forbidden("Solo el rol Administración puede hacer esto")
  return actor
}

/** Recorta y quita lo que no se imprime al final; vacío es nulo. */
function trimTo(value: string | null | undefined, max: number): string | null {
  const clean = (value ?? "").trim()
  return clean ? clean.slice(0, max) : null
}

/** Lo que dice llegar en el futuro cuenta desde ahora. */
function notAfter(at: Date, now: Date): Date {
  return at.getTime() < now.getTime() ? at : now
}

/** Si quien mira ve la conversación: Administración siempre; Soporte, solo la de una clínica con su app. */
function seesChat(actor: AdminActor, client: { organizationId: string | null } | null): boolean {
  return actor.role === "admin" || Boolean(client?.organizationId)
}

async function clientOf(tx: Db, clientId: string | null) {
  if (!clientId) return null
  const [row] = await tx.select().from(saasClient).where(eq(saasClient.id, clientId)).limit(1)
  return row ?? null
}

/** La conversación bloqueada, si quien mira la ve; si no, como si no existiera. */
async function lockChat(tx: Db, actor: AdminActor | null, chatId: string): Promise<ChatRow> {
  if (!UUID.test(chatId)) throw notFound("Conversación")
  const [chat] = await tx
    .select()
    .from(saasChat)
    .where(eq(saasChat.id, chatId))
    .for("update")
    .limit(1)
  if (!chat) throw notFound("Conversación")
  // Sin persona es Kairós (el worker): lo que atiende no depende de un rol.
  if (actor && !seesChat(actor, await clientOf(tx, chat.clientId))) throw notFound("Conversación")
  return chat
}

/**
 * Lo que Kairós dejó en Hoy de esta conversación (`chat_sin_cliente`,
 * `responder_chat`) y ya no hace falta porque una persona lo resolvió aquí:
 * queda vencido con su motivo y su clave libre, como `Pass.closeItems`. Si
 * vuelve a hacer falta (escribe otra vez, o la respuesta no salió), la pasada
 * siguiente lo vuelve a poner. «Lo que hizo» lo cuenta (`kairos.item_closed`).
 */
async function closeChatKairosItems(
  tx: Db,
  chatId: string,
  kinds: readonly ("chat_sin_cliente" | "responder_chat")[],
  why: string,
  now: Date,
  /** El ítem que se está aprobando con esta misma operación: no se cierra, lo deja ejecutado su sí. */
  exceptItemId: string | null = null,
): Promise<void> {
  const closed = await tx
    .update(kairosItem)
    .set({
      status: "vencida",
      error: `Ya no hace falta: ${why}`.slice(0, 500),
      idempotencyKey: sql`'vencida:' || ${kairosItem.id}::text || ':' || ${kairosItem.idempotencyKey}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(kairosItem.status, "espera"),
        inArray(kairosItem.kind, [...kinds]),
        sql`${kairosItem.payload} ->> 'chatId' = ${chatId}`,
        exceptItemId ? sql`${kairosItem.id} <> ${exceptItemId}::uuid` : undefined,
      ),
    )
    .returning({
      id: kairosItem.id,
      kind: kairosItem.kind,
      title: kairosItem.title,
      clientId: kairosItem.clientId,
      adminOnly: kairosItem.adminOnly,
    })
  for (const item of closed) {
    const client = await clientOf(tx, item.clientId)
    await writeAdminAudit(tx, null, {
      action: "kairos.item_closed",
      entityId: item.id,
      organizationId: client?.organizationId ?? null,
      metadata: {
        clientId: item.clientId,
        itemId: item.id,
        kind: item.kind,
        title: item.title,
        why,
        adminOnly: item.adminOnly,
      },
    })
  }
}

/**
 * La conversación pasa a un cliente sin app (venta): sus mensajes, respuestas y
 * actividades suben a solo Administración. Nunca bajan (la base lo impide en
 * el envío y en el mensaje; la bitácora solo deja de no a sí).
 */
async function raiseChatAdminOnly(tx: Db, chatId: string): Promise<void> {
  await tx
    .update(saasInboundMessage)
    .set({ adminOnly: true })
    .where(and(eq(saasInboundMessage.chatId, chatId), eq(saasInboundMessage.adminOnly, false)))
  await tx
    .update(saasOutreach)
    .set({ adminOnly: true })
    .where(and(eq(saasOutreach.chatId, chatId), eq(saasOutreach.adminOnly, false)))
  await tx
    .update(saasFollowUp)
    .set({ adminOnly: true })
    .where(and(eq(saasFollowUp.chatId, chatId), eq(saasFollowUp.adminOnly, false)))
}

/** «agenda.xlsx», «2 archivos»: lo que dice la actividad de un mensaje con archivos. */
function mediaWords(count: number): string {
  return count === 1 ? "1 archivo" : `${count} archivos`
}

/** El texto de la actividad «Nos escribió por …»: lo que escribió y cuántos archivos trajo. */
function inboundActivityBody(message: { body: string | null; media: SaasInboundMedia[] }): string {
  const files = message.media.length > 0 ? mediaWords(message.media.length) : null
  const text = message.body?.trim()
  if (!text) return files ? `Mandó ${files}` : "Mandó un mensaje sin texto"
  const suffix = files ? ` (${files})` : ""
  return `${text.slice(0, ACTIVITY_MAX - suffix.length)}${suffix}`
}

/**
 * La actividad de un mensaje que entró. Sin `request_id`: no es un contacto
 * nuestro ni mueve la fecha de volver. Solo de Administración si el mensaje lo
 * es (se decidió al llegar) o si el cliente aún no tiene su cuenta.
 */
async function recordInboundMessageActivity(
  tx: Db,
  chat: ChatRow,
  client: typeof saasClient.$inferSelect,
  message: {
    body: string | null
    media: SaasInboundMedia[]
    receivedAt: Date
    adminOnly: boolean
  },
): Promise<void> {
  await tx.insert(saasFollowUp).values({
    clientId: client.id,
    authorUserId: null,
    body: inboundActivityBody(message),
    kind: chat.channel as SaasChatChannel,
    direction: "entro",
    contactId: chat.contactId,
    chatId: chat.id,
    happenedAt: message.receivedAt,
    adminOnly: message.adminOnly || !client.organizationId,
  })
}

/**
 * Registra los archivos de un mensaje que aún tienen su objeto como
 * documentos del cliente; devuelve la lista con su `fileId`. Se guardan: solo
 * se borran si Administración los marca como la carga de datos.
 */
async function attachMessageMedia(
  tx: Db,
  actor: AdminActor | null,
  channel: SaasChatChannel,
  clientId: string,
  message: Pick<MessageRow, "id" | "receivedAt"> & { media: SaasInboundMedia[] },
  now: Date,
): Promise<{ media: SaasInboundMedia[]; fileIds: string[] }> {
  const fileIds: string[] = []
  const out: SaasInboundMedia[] = []
  for (const item of message.media) {
    if (!item.objectKey || item.fileId) {
      out.push(item)
      continue
    }
    const file = await registerClientFile(
      tx,
      actor,
      {
        clientId,
        kind: "correo",
        filename: item.filename,
        objectKey: item.objectKey,
        contentType: item.mimeType,
        sizeBytes: item.size,
        adminOnly: true,
        deleteAfter: null,
        source: channel,
        receivedAt: notAfter(message.receivedAt, now),
        inboundMessageId: message.id,
      },
      now,
    )
    fileIds.push(file.id)
    out.push({ ...item, fileId: file.id })
  }
  return { media: out, fileIds }
}

/**
 * Registra un mensaje que entró por WhatsApp, Instagram o Messenger, una vez
 * por su `externalId` (el id del mensaje en Meta). Lo
 * llama la ruta firmada, sin persona, después de subir los archivos. La
 * conversación se crea la primera vez que escribe ese número; nunca se liga
 * a un cliente por el teléfono.
 */
export async function ingestInboundChat(
  tx: Db,
  raw: InboundChatInput,
  now = new Date(),
): Promise<InboundChatResult> {
  const parsed = inboundSchema.safeParse(raw)
  if (!parsed.success)
    throw validation(
      parsed.error.issues[0]?.message ?? "Mensaje no válido",
      issueFields(parsed.error.issues),
    )
  const input = parsed.data
  const displayName = trimTo(input.displayName, 200)
  const waId = input.channel === "whatsapp" ? trimTo(input.waId, 256) : null
  const [chat] = await tx
    .insert(saasChat)
    .values({ channel: input.channel, address: input.address, waId, displayName })
    .onConflictDoUpdate({
      target: [saasChat.channel, saasChat.address],
      set: {
        waId: sql`coalesce(excluded.wa_id, ${saasChat.waId})`,
        displayName: sql`coalesce(excluded.display_name, ${saasChat.displayName})`,
        updatedAt: now,
      },
    })
    .returning()
  if (!chat) throw new ServiceError("INTERNAL", 500, "No se pudo abrir la conversación")
  const media: SaasInboundMedia[] = input.media.map((item) => ({
    objectKey: item.objectKey,
    mimeType: item.mimeType,
    filename: cleanFilename(item.filename),
    size: item.size,
    fileId: null,
  }))
  const body = trimTo(input.body, BODY_MAX)
  const client = await clientOf(tx, chat.clientId)
  // Se decide al llegar: Soporte solo ve lo que entra en una conversación de una clínica con su app.
  const adminOnly = !client?.organizationId
  const [created] = await tx
    .insert(saasInboundMessage)
    .values({
      chatId: chat.id,
      externalId: input.externalId,
      body,
      media,
      receivedAt: input.receivedAt,
      adminOnly,
      // Cuándo lo guardamos, con el reloj de nuestras respuestas: Kairós vende mira esto para saber si ya respondió.
      createdAt: now,
    })
    .onConflictDoNothing({ target: saasInboundMessage.externalId })
    .returning()
  if (!created) {
    const [existing] = await tx
      .select({ id: saasInboundMessage.id, chatId: saasInboundMessage.chatId })
      .from(saasInboundMessage)
      .where(eq(saasInboundMessage.externalId, input.externalId))
      .limit(1)
    if (!existing)
      throw new ServiceError("CONFLICT", 409, "El mensaje se está registrando en otra petición")
    const [owner] = await tx
      .select({ clientId: saasChat.clientId })
      .from(saasChat)
      .where(eq(saasChat.id, existing.chatId))
      .limit(1)
    return {
      chatId: existing.chatId,
      messageId: existing.id,
      duplicate: true,
      clientId: owner?.clientId ?? null,
    }
  }
  const arrived = notAfter(input.receivedAt, now)
  await tx
    .update(saasChat)
    .set({
      lastInboundAt: sql`greatest(${saasChat.lastInboundAt}, ${arrived.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(eq(saasChat.id, chat.id))
  let files = 0
  if (client) {
    const attached = await attachMessageMedia(tx, null, input.channel, client.id, created, now)
    files = attached.fileIds.length
    if (files > 0)
      await tx
        .update(saasInboundMessage)
        .set({ media: attached.media })
        .where(eq(saasInboundMessage.id, created.id))
    await recordInboundMessageActivity(tx, chat, client, {
      body,
      media,
      receivedAt: input.receivedAt,
      adminOnly,
    })
  }
  await writeAdminAudit(tx, null, {
    action: "inbound.chat_received",
    entityId: created.id,
    organizationId: client?.organizationId ?? null,
    metadata: {
      channel: input.channel,
      chatId: chat.id,
      clientId: client?.id ?? null,
      media: media.length,
      files,
    },
  })
  return { chatId: chat.id, messageId: created.id, duplicate: false, clientId: client?.id ?? null }
}

/** El contacto sugerido para una conversación sin cliente. */
export interface ChatSuggestion {
  contactId: string
  contactName: string
  clientId: string
  clientName: string
}

/**
 * La sugerencia de «¿De quién es este WhatsApp?» (solo WhatsApp: Instagram y
 * Messenger no traen teléfono): el único contacto de un
 * cliente no archivado con exactamente ese celular. Si son dos o más, ninguno:
 * el teléfono no identifica a nadie, solo sugiere. Nunca liga nada.
 */
export async function chatSuggestion(tx: Db, address: string): Promise<ChatSuggestion | null> {
  if (!E164.test(address)) return null
  const rows = await tx
    .select({
      contactId: saasClientContact.id,
      contactName: saasClientContact.name,
      clientId: saasClient.id,
      clientName: saasClient.name,
    })
    .from(saasClientContact)
    .innerJoin(saasClient, eq(saasClient.id, saasClientContact.clientId))
    .where(and(eq(saasClientContact.phone, address), isNull(saasClient.archivedAt)))
    .limit(2)
  return rows.length === 1 ? (rows[0] ?? null) : null
}

/** La solicitud más reciente del cliente: lo que respondemos también es de ella (la lista vieja). */
async function latestRequestId(tx: Db, clientId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: saasWaitlistRequest.id })
    .from(saasWaitlistRequest)
    .where(eq(saasWaitlistRequest.clientId, clientId))
    .orderBy(desc(saasWaitlistRequest.createdAt))
    .limit(1)
  return row?.id ?? null
}

/** Si un envío es solo de Administración (la misma regla que lee Soporte). */
async function outreachIsAdminOnly(tx: Db, outreachId: string): Promise<boolean> {
  const [flag] = await tx
    .select({ adminOnly: outreachAdminOnlySql(`"saas_outreach"`) })
    .from(saasOutreach)
    .where(eq(saasOutreach.id, outreachId))
    .limit(1)
  return Boolean(flag?.adminOnly)
}

/**
 * Salió una respuesta de una conversación con cliente: queda «Le escribimos
 * por …» (su canal) en su bitácora, con la hora en que salió, de quien la escribió
 * y con la conversación (para moverla con ella). Solo de Administración si el
 * envío lo es. Sin cliente no deja nada: lo deja `assignChat` al ligarla.
 */
async function recordReplyActivity(tx: Db, row: OutreachRecord, now: Date): Promise<void> {
  if (!row.clientId) return
  const [contact] = row.contactId
    ? await tx
        .select({ id: saasClientContact.id })
        .from(saasClientContact)
        .where(
          and(
            eq(saasClientContact.id, row.contactId),
            eq(saasClientContact.clientId, row.clientId),
          ),
        )
        .limit(1)
    : []
  await tx.insert(saasFollowUp).values({
    clientId: row.clientId,
    requestId: await latestRequestId(tx, row.clientId),
    authorUserId: row.createdBy,
    byKairos: row.byKairos,
    body: row.body.slice(0, ACTIVITY_MAX),
    kind: row.channel as SaasChatChannel,
    direction: "salio",
    contactId: contact?.id ?? null,
    chatId: row.chatId,
    proposalId: row.proposalId,
    happenedAt: row.sentAt ?? now,
    adminOnly: await outreachIsAdminOnly(tx, row.id),
  })
  if (row.proposalId) {
    // Como por correo (`outreachWentOut`): una propuesta ya enviada no cambia su fecha.
    await tx
      .update(saasProposal)
      .set({ status: "enviada", sentAt: now, updatedAt: now })
      .where(and(eq(saasProposal.id, row.proposalId), eq(saasProposal.status, "borrador")))
  }
}

export interface AssignChatInput {
  clientId: string
  /** La persona del cliente que escribe; opcional. */
  contactId?: string | null
  /**
   * El ítem de Kairós que se aprueba con esto («¿De quién es?» desde Hoy): no se
   * cierra como «ya no hace falta», queda ejecutado por su sí.
   */
  kairosItemId?: string | null
}

export interface AssignChatResult {
  chatId: string
  clientId: string
  contactId: string | null
  /** El cliente que tenía antes, si se movió a otro. */
  movedFrom: string | null
  fileIds: string[]
}

/**
 * Una persona de Administración dice de quién es una conversación: el cliente
 * y, si quiere, el contacto (que recibe este celular si no tenía uno). Lo que
 * llegó antes pasa al cliente: cada mensaje deja su actividad con su hora, sus
 * archivos pasan a ser documentos del cliente y las respuestas que salieron
 * sin cliente quedan suyas. Si ya era de otro cliente («Mover a otra
 * clínica»), sus actividades, archivos y respuestas se mueven con ella.
 */
export async function assignChat(
  tx: Db,
  actor: AdminActor | null,
  chatId: string,
  input: AssignChatInput,
  now = new Date(),
): Promise<AssignChatResult> {
  return assignChatBy(tx, requireAdmin(actor), chatId, input, now)
}

/**
 * Kairós dice de quién es una conversación que atiende solo: la clínica que él
 * mismo creó con el nombre que le dieron (`datos_de_la_clinica`), nunca una que
 * ya existía. Es la misma operación que la de una persona, a nombre de Kairós
 * (sin `matched_by_user`, auditada sin persona).
 */
export async function kairosAssignChat(
  tx: Db,
  chatId: string,
  input: AssignChatInput,
  now = new Date(),
): Promise<AssignChatResult> {
  return assignChatBy(tx, null, chatId, input, now)
}

async function assignChatBy(
  tx: Db,
  staff: AdminActor | null,
  chatId: string,
  input: AssignChatInput,
  now: Date,
): Promise<AssignChatResult> {
  const chat = await lockChat(tx, staff, chatId)
  if (!UUID.test(input.clientId ?? "")) throw invalidField("clientId", "Cliente no encontrado")
  const [client] = await tx
    .select()
    .from(saasClient)
    .where(eq(saasClient.id, input.clientId))
    .limit(1)
  if (!client) throw invalidField("clientId", "Cliente no encontrado")
  if (client.archivedAt) throw invalidField("clientId", "Ese cliente está archivado")
  let contact: typeof saasClientContact.$inferSelect | null = null
  if (input.contactId) {
    if (!UUID.test(input.contactId))
      throw invalidField("contactId", "Esa persona no es de este cliente")
    const [row] = await tx
      .select()
      .from(saasClientContact)
      .where(
        and(eq(saasClientContact.id, input.contactId), eq(saasClientContact.clientId, client.id)),
      )
      .for("update")
      .limit(1)
    if (!row) throw invalidField("contactId", "Esa persona no es de este cliente")
    contact = row
  }
  const previous = chat.clientId
  const contactId = contact?.id ?? (previous === client.id ? chat.contactId : null)
  await tx
    .update(saasChat)
    .set({
      clientId: client.id,
      contactId,
      matchedByUser: staff?.userId ?? null,
      matchedAt: now,
      notClinicAt: null,
      notClinicBy: null,
      updatedAt: now,
    })
    .where(eq(saasChat.id, chat.id))
  // El celular de la persona: si no tenía, este. Uno que ya tiene no se pisa. Solo en WhatsApp:
  // en Instagram y Messenger la dirección es un id de Meta, no un teléfono.
  if (contact && !contact.phone && chat.channel === "whatsapp" && E164.test(chat.address))
    await tx
      .update(saasClientContact)
      .set({ phone: chat.address, updatedAt: now })
      .where(eq(saasClientContact.id, contact.id))
  // Ya se dijo de quién es: lo que Kairós pedía decidir sobra. Si se movió a otra
  // clínica, su «Responder» pasa al cliente nuevo en la pasada siguiente.
  await closeChatKairosItems(
    tx,
    chat.id,
    previous && previous !== client.id
      ? ["chat_sin_cliente", "responder_chat"]
      : ["chat_sin_cliente"],
    previous && previous !== client.id
      ? "la conversación pasó a otro cliente"
      : "ya se dijo de quién es",
    now,
    input.kairosItemId ?? null,
  )
  // Con un cliente sin app, lo de la conversación es de la venta: sube a solo Administración (nunca baja).
  if (!client.organizationId) await raiseChatAdminOnly(tx, chat.id)
  const assigned = { ...chat, clientId: client.id, contactId }
  if (previous === client.id) {
    if (contactId !== chat.contactId)
      await writeAdminAudit(tx, staff, {
        action: "chat.contact_set",
        entityId: chat.id,
        organizationId: client.organizationId,
        metadata: { clientId: client.id, contactId },
      })
    return { chatId: chat.id, clientId: client.id, contactId, movedFrom: null, fileIds: [] }
  }

  if (previous) {
    // Mover a otra clínica: lo que ya era del cliente anterior pasa al nuevo. El contacto del
    // anterior no es de este: la actividad y la respuesta lo pierden (solo puede pasar a nulo).
    const activities = await tx
      .update(saasFollowUp)
      .set({ clientId: client.id, contactId: null })
      .where(and(eq(saasFollowUp.chatId, chat.id), eq(saasFollowUp.clientId, previous)))
      .returning({ id: saasFollowUp.id })
    const messageIds = tx
      .select({ id: saasInboundMessage.id })
      .from(saasInboundMessage)
      .where(eq(saasInboundMessage.chatId, chat.id))
    const files = await tx
      .update(saasClientFile)
      .set({ clientId: client.id })
      .where(
        and(
          inArray(saasClientFile.inboundMessageId, messageIds),
          eq(saasClientFile.clientId, previous),
        ),
      )
      .returning({ id: saasClientFile.id })
    // La posible carga de esos archivos sigue en Hoy, ahora del cliente nuevo (la regla no la
    // vuelve a poner: es una por archivo).
    if (files.length > 0)
      await tx
        .update(kairosItem)
        .set({ clientId: client.id, updatedAt: now })
        .where(
          and(
            eq(kairosItem.kind, "posible_carga"),
            eq(kairosItem.status, "espera"),
            sql`${kairosItem.payload} ->> 'fileId' in (${sql.join(
              files.map((file) => sql`${file.id}`),
              sql`, `,
            )})`,
          ),
        )
    const replies = await tx
      .update(saasOutreach)
      .set({ clientId: client.id, contactId: null, updatedAt: now })
      .where(and(eq(saasOutreach.chatId, chat.id), eq(saasOutreach.clientId, previous)))
      .returning({ id: saasOutreach.id })
    await writeAdminAudit(tx, staff, {
      action: "chat.moved",
      entityId: chat.id,
      organizationId: client.organizationId,
      metadata: {
        from: previous,
        to: client.id,
        contactId,
        activities: activities.length,
        files: files.length,
        replies: replies.length,
      },
    })
    return {
      chatId: chat.id,
      clientId: client.id,
      contactId,
      movedFrom: previous,
      fileIds: files.map((file) => file.id),
    }
  }

  // Primera vez: cada mensaje que llegó deja su actividad y sus archivos, en orden.
  const messages = await tx
    .select()
    .from(saasInboundMessage)
    .where(eq(saasInboundMessage.chatId, chat.id))
    .orderBy(asc(saasInboundMessage.receivedAt), asc(saasInboundMessage.id))
  const fileIds: string[] = []
  for (const message of messages) {
    const attached = await attachMessageMedia(
      tx,
      staff,
      chat.channel as SaasChatChannel,
      client.id,
      message,
      now,
    )
    if (attached.fileIds.length > 0) {
      fileIds.push(...attached.fileIds)
      await tx
        .update(saasInboundMessage)
        .set({ media: attached.media })
        .where(eq(saasInboundMessage.id, message.id))
    }
    await recordInboundMessageActivity(tx, assigned, client, message)
  }
  // Lo que se le respondió antes de saber de quién era pasa a su cliente.
  const replies = await tx
    .update(saasOutreach)
    .set({ clientId: client.id, updatedAt: now })
    .where(and(eq(saasOutreach.chatId, chat.id), isNull(saasOutreach.clientId)))
    .returning()
  for (const reply of replies)
    if (reply.status === "enviado") await recordReplyActivity(tx, reply, now)
  await writeAdminAudit(tx, staff, {
    action: "chat.assigned",
    entityId: chat.id,
    organizationId: client.organizationId,
    metadata: {
      clientId: client.id,
      contactId,
      messages: messages.length,
      files: fileIds.length,
      replies: replies.length,
    },
  })
  return { chatId: chat.id, clientId: client.id, contactId, movedFrom: null, fileIds }
}

/**
 * «No es una clínica»: la conversación sale de lo que hay que decidir. Sus
 * mensajes siguen entrando, sin pedir nada. Una con cliente no se marca así.
 */
export async function markChatNotClinic(
  tx: Db,
  actor: AdminActor | null,
  chatId: string,
  now = new Date(),
): Promise<{ chatId: string; notClinicAt: Date }> {
  const staff = requireAdmin(actor)
  const chat = await lockChat(tx, staff, chatId)
  if (chat.clientId) throw new ServiceError("CONFLICT", 409, "Esa conversación ya es de un cliente")
  if (chat.notClinicAt) return { chatId: chat.id, notClinicAt: chat.notClinicAt }
  await tx
    .update(saasChat)
    .set({ notClinicAt: now, notClinicBy: staff.userId, updatedAt: now })
    .where(eq(saasChat.id, chat.id))
  await closeChatKairosItems(tx, chat.id, ["chat_sin_cliente"], "no es una clínica", now)
  await writeAdminAudit(tx, staff, {
    action: "chat.not_clinic",
    entityId: chat.id,
    metadata: { address: chat.address },
  })
  return { chatId: chat.id, notClinicAt: now }
}

/** Deshace «No es una clínica»: vuelve a lo que hay que decidir. */
export async function undoChatNotClinic(
  tx: Db,
  actor: AdminActor | null,
  chatId: string,
  now = new Date(),
): Promise<{ chatId: string }> {
  const staff = requireAdmin(actor)
  const chat = await lockChat(tx, staff, chatId)
  if (!chat.notClinicAt) return { chatId: chat.id }
  await tx
    .update(saasChat)
    .set({ notClinicAt: null, notClinicBy: null, updatedAt: now })
    .where(eq(saasChat.id, chat.id))
  await writeAdminAudit(tx, staff, {
    action: "chat.not_clinic_undone",
    entityId: chat.id,
    metadata: { address: chat.address },
  })
  return { chatId: chat.id }
}

export interface OpenChatInput {
  clientId: string
  contactId: string
  /** Por ahora solo WhatsApp: Instagram y Messenger no dejan escribir primero. */
  channel: "whatsapp"
}

/**
 * «Escribir por WhatsApp» desde la ficha: la conversación con el celular de
 * ese contacto, creada (ya ligada a su cliente y contacto) si nunca escribió.
 * El celular solo sugiere, nunca liga: una que ya existe sin cliente (o marcada
 * «No es una clínica») no se toca y da 409 `CHAT_UNASSIGNED` con su `chatId`
 * en `fields`, para que una persona diga de quién es desde su conversación.
 * Una de otro cliente tampoco (409): se mueve desde su conversación. Para
 * Soporte, un cliente que no ve no existe.
 */
export async function openChatForContact(
  tx: Db,
  actor: AdminActor | null,
  input: OpenChatInput,
  now = new Date(),
): Promise<{ chatId: string; created: boolean }> {
  if (!actor) throw forbidden("Se requiere personal de administración")
  if (input.channel !== "whatsapp")
    throw invalidField("channel", "Solo se le escribe primero por WhatsApp")
  if (!UUID.test(input.clientId ?? "")) throw notFound("Cliente")
  const client = await clientOf(tx, input.clientId)
  if (!client || !seesChat(actor, client)) throw notFound("Cliente")
  if (client.archivedAt) throw invalidField("clientId", "Ese cliente está archivado")
  if (!UUID.test(input.contactId ?? ""))
    throw invalidField("contactId", "Esa persona no es de este cliente")
  const [contact] = await tx
    .select()
    .from(saasClientContact)
    .where(
      and(eq(saasClientContact.id, input.contactId), eq(saasClientContact.clientId, client.id)),
    )
    .limit(1)
  if (!contact) throw invalidField("contactId", "Esa persona no es de este cliente")
  const phone = contact.phone?.trim() ?? ""
  if (!E164.test(phone)) throw invalidField("contactId", "Esa persona no tiene celular")
  const [existing] = await tx
    .select()
    .from(saasChat)
    .where(and(eq(saasChat.channel, input.channel), eq(saasChat.address, phone)))
    .for("update")
    .limit(1)
  if (existing) {
    if (existing.clientId === client.id) {
      if (!existing.contactId)
        await tx
          .update(saasChat)
          .set({ contactId: contact.id, updatedAt: now })
          .where(eq(saasChat.id, existing.id))
      return { chatId: existing.id, created: false }
    }
    if (existing.clientId)
      throw new ServiceError(
        "CHAT_OTHER_CLIENT",
        409,
        "Ese celular ya escribe como otra clínica: muévelo desde su conversación",
      )
    // Ya escribió sin saberse de quién: el celular no basta para decirlo (persona única). Lo
    // decide una persona en «¿De quién es?»; la pantalla la abre con este `chatId`.
    throw new ServiceError(
      "CHAT_UNASSIGNED",
      409,
      "Ese celular ya nos escribió y falta decir de quién es. Dilo primero en Hoy.",
      { chatId: existing.id },
    )
  }
  const [created] = await tx
    .insert(saasChat)
    .values({
      channel: input.channel,
      address: phone,
      displayName: trimTo(contact.name, 200),
      clientId: client.id,
      contactId: contact.id,
      matchedByUser: actor.userId,
      matchedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: saasChat.id })
  if (!created) throw new ServiceError("INTERNAL", 500, "No se pudo abrir la conversación")
  await writeAdminAudit(tx, actor, {
    action: "chat.opened",
    entityId: created.id,
    organizationId: client.organizationId,
    metadata: { channel: input.channel, clientId: client.id, contactId: contact.id },
  })
  return { chatId: created.id, created: true }
}

/** Un archivo de un mensaje, ya documento del cliente, y si es la carga de datos. */
export interface ChatFile {
  fileId: string
  messageId: string | null
  filename: string
  contentType: string
  size: number
  kind: "correo" | "archivo_clinica"
  /** Solo en la carga (`archivo_clinica`): el día de Lima en que se borra. */
  deleteAfter: string | null
  deleted: boolean
  /** En uno sin marcar: el día en que se borraría si se marca ahora. */
  cargaDeleteAfter: string | null
  /** Marcarlo ahora lo borra en el acto (llegó hace 30 días o más). */
  cargaDueNow: boolean
}

/** Lo que entró o salió en una conversación, en el orden en que pasó. */
export type ChatEntry =
  | {
      kind: "entro"
      id: string
      at: Date
      body: string | null
      /** Sus archivos; Soporte recibe `[]` (son solo de Administración) y solo `mediaCount`. */
      media: Array<{ filename: string; mimeType: string; size: number; fileId: string | null }>
      mediaCount: number
    }
  | {
      kind: "salio"
      id: string
      at: Date
      body: string
      status: SaasOutreachStatus
      template: string | null
      adminOnly: boolean
      createdBy: { userId: string; name: string } | null
      sentAt: Date | null
      /** Lo escribió Kairós solo (`by_kairos`): se muestra con su nombre, no el de una persona. */
      byKairos: boolean
    }

export interface ChatDetail {
  id: string
  channel: SaasChatChannel
  address: string
  displayName: string | null
  client: { id: string; name: string; product: string; hasAccount: boolean } | null
  contact: { id: string; name: string; phone: string | null } | null
  notClinicAt: Date | null
  /** «Lo atiendo yo» (o Kairós la pasó al equipo): mientras tenga fecha, Kairós no responde solo. */
  kairosPausedAt: Date | null
  /**
   * Kairós responde solo en esta conversación: está prendido, no está pausada, no es de una
   * clínica con su app ni «No es una clínica» (`kairosHandlesChat`).
   */
  handledByKairos: boolean
  /**
   * Kairós podría atenderla si no estuviera pausada: está prendido y no es de una clínica con su
   * app ni «No es una clínica». Con esto la pantalla ofrece «Devolver a Kairós».
   */
  kairosAvailable: boolean
  /** Quién dijo «Lo atiendo yo»; nulo si nadie (o si la pasó Kairós). */
  kairosPausedBy: { userId: string; name: string } | null
  /** Kairós la pasó al equipo (o no pudo responder): cuándo y por qué. Nulo si no fue así. */
  kairosHandover: { at: Date; why: string | null } | null
  lastInboundAt: Date | null
  /** Se puede responder con texto libre: no pasaron 24 h desde su último mensaje. */
  canReplyFreely: boolean
  /** Hasta cuándo se puede responder con texto libre; nulo si nunca escribió. */
  freeUntil: Date | null
  /** La firma que el envío agrega al final de la respuesta de quien mira. */
  replySignature: string
  /** Solo para Administración, sin cliente: el único contacto con ese celular. */
  suggestion: ChatSuggestion | null
  entries: ChatEntry[]
  /** Los archivos como documentos del cliente: solo para Administración (Soporte recibe `[]`). */
  files: ChatFile[]
}

/** La ventana de las 24 h desde el último mensaje de la persona. */
export function chatFreeWindow(
  lastInboundAt: Date | null,
  now: Date,
): { canReplyFreely: boolean; freeUntil: Date | null } {
  if (!lastInboundAt) return { canReplyFreely: false, freeUntil: null }
  const freeUntil = new Date(lastInboundAt.getTime() + CHAT_FREE_REPLY_MS)
  return { canReplyFreely: now.getTime() < freeUntil.getTime(), freeUntil }
}

/** «Ana», el primer nombre de quien escribe; sin nombre, «El equipo». */
function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "El equipo"
}

/** «odentIA», «latidIA» o «vistIA» por el producto del cliente; sin cliente, la marca base. */
function chatBrand(client: { product: string } | null): string {
  return client && isClinicalProduct(client.product)
    ? mailBrandName(productWords(client.product).brand)
    : mailBrandName()
}

/** «— Ana · odentIA»: la firma de una respuesta en una conversación. */
export function chatSignature(name: string | null | undefined, client: { product: string } | null) {
  return `— ${firstName(name)} · ${chatBrand(client)}`
}

/** «— Kairós · odentIA»: lo que escribe Kairós solo lleva su nombre, no el de una persona. */
export function kairosChatSignature(client: { product: string } | null) {
  return `— Kairós · ${chatBrand(client)}`
}

async function userName(tx: Db, userId: string): Promise<string | null> {
  const [row] = await tx.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1)
  return row?.name ?? null
}

/**
 * Una conversación para leerla y responderla: sus mensajes y respuestas por
 * hora, de quién es y si se puede responder con texto libre. Soporte solo ve
 * la de una clínica con su app (las demás no existen para él: 404), sin sus
 * archivos ni lo que Administración marcó solo para ella.
 */
export async function getChat(
  tx: Db,
  actor: AdminActor,
  chatId: string,
  now = new Date(),
): Promise<ChatDetail> {
  if (!UUID.test(chatId)) throw notFound("Conversación")
  const [chat] = await tx.select().from(saasChat).where(eq(saasChat.id, chatId)).limit(1)
  if (!chat) throw notFound("Conversación")
  const client = await clientOf(tx, chat.clientId)
  if (!seesChat(actor, client)) throw notFound("Conversación")
  const admin = actor.role === "admin"
  const [contact] = chat.contactId
    ? await tx
        .select({
          id: saasClientContact.id,
          name: saasClientContact.name,
          phone: saasClientContact.phone,
        })
        .from(saasClientContact)
        .where(eq(saasClientContact.id, chat.contactId))
        .limit(1)
    : []
  // Soporte no ve lo que llegó o salió mientras era de la venta (`admin_only`, fijado al escribirlo).
  const messages = await tx
    .select()
    .from(saasInboundMessage)
    .where(
      and(
        eq(saasInboundMessage.chatId, chat.id),
        admin ? undefined : eq(saasInboundMessage.adminOnly, false),
      ),
    )
    .orderBy(asc(saasInboundMessage.receivedAt), asc(saasInboundMessage.id))
  const replies = await tx
    .select({
      row: saasOutreach,
      adminOnly: outreachAdminOnlySql(`"saas_outreach"`),
      authorName: user.name,
    })
    .from(saasOutreach)
    .leftJoin(user, eq(user.id, saasOutreach.createdBy))
    .where(
      and(
        eq(saasOutreach.chatId, chat.id),
        admin ? undefined : sql`not ${outreachAdminOnlySql(`"saas_outreach"`)}`,
      ),
    )
    .orderBy(asc(saasOutreach.createdAt), asc(saasOutreach.id))
  const entries: ChatEntry[] = [
    ...messages.map(
      (message): ChatEntry => ({
        kind: "entro",
        id: message.id,
        at: message.receivedAt,
        body: message.body,
        media: admin
          ? message.media.map((item) => ({
              filename: item.filename,
              mimeType: item.mimeType,
              size: item.size,
              fileId: item.fileId ?? null,
            }))
          : [],
        mediaCount: message.media.length,
      }),
    ),
    ...replies.map(
      ({ row, adminOnly, authorName }): ChatEntry => ({
        kind: "salio",
        id: row.id,
        at: row.sentAt ?? row.createdAt,
        body: row.body,
        status: row.status as SaasOutreachStatus,
        template: row.template,
        adminOnly: Boolean(adminOnly),
        createdBy: row.createdBy ? { userId: row.createdBy, name: authorName ?? "" } : null,
        sentAt: row.sentAt,
        byKairos: row.byKairos,
      }),
    ),
  ].sort((a, b) => a.at.getTime() - b.at.getTime())
  // Lo mismo que `kairosHandlesChat`, sin la pausa: la pantalla ofrece «Devolver a Kairós».
  const kairosAvailable =
    !chat.notClinicAt && !client?.organizationId && (await getKairosSells(tx)).enabled
  // Pausada sin persona: la pasó Kairós (su último turno que pasó o falló dice por qué).
  const [handed] =
    chat.kairosPausedAt && !chat.kairosPausedBy
      ? await tx
          .select({ at: kairosChatTurn.updatedAt, why: kairosChatTurn.why })
          .from(kairosChatTurn)
          .where(
            and(
              eq(kairosChatTurn.chatId, chat.id),
              inArray(kairosChatTurn.outcome, ["paso", "fallo"]),
            ),
          )
          .orderBy(desc(kairosChatTurn.updatedAt))
          .limit(1)
      : []
  const kairosHandover =
    chat.kairosPausedAt && !chat.kairosPausedBy
      ? { at: handed?.at ?? chat.kairosPausedAt, why: handed?.why ?? null }
      : null
  const today = limaDate(now)
  const files: ChatFile[] =
    admin && messages.length > 0
      ? (
          await tx
            .select()
            .from(saasClientFile)
            .where(
              inArray(
                saasClientFile.inboundMessageId,
                messages.map((message) => message.id),
              ),
            )
            .orderBy(asc(saasClientFile.createdAt), asc(saasClientFile.id))
        )
          .filter((file) => file.kind === "correo" || file.kind === "archivo_clinica")
          .map((file): ChatFile => {
            const carga = file.kind === "archivo_clinica"
            const ifMarked = carga ? null : cargaDeleteAfter(file.receivedAt, now)
            return {
              fileId: file.id,
              messageId: file.inboundMessageId,
              filename: file.filename,
              contentType: file.contentType,
              size: file.sizeBytes,
              kind: carga ? "archivo_clinica" : "correo",
              deleteAfter: carga ? file.deleteAfter : null,
              deleted: file.deletedAt !== null,
              cargaDeleteAfter: file.deletedAt ? null : ifMarked,
              cargaDueNow: !file.deletedAt && ifMarked !== null && ifMarked <= today,
            }
          })
      : []
  return {
    id: chat.id,
    channel: chat.channel as SaasChatChannel,
    address: chat.address,
    displayName: chat.displayName,
    client: client
      ? {
          id: client.id,
          name: client.name,
          product: client.product,
          hasAccount: Boolean(client.organizationId),
        }
      : null,
    contact: contact ?? null,
    notClinicAt: chat.notClinicAt,
    kairosPausedAt: chat.kairosPausedAt,
    handledByKairos: kairosAvailable && !chat.kairosPausedAt,
    kairosAvailable,
    kairosPausedBy:
      chat.kairosPausedAt && chat.kairosPausedBy
        ? { userId: chat.kairosPausedBy, name: (await userName(tx, chat.kairosPausedBy)) ?? "" }
        : null,
    kairosHandover,
    lastInboundAt: chat.lastInboundAt,
    ...chatFreeWindow(chat.lastInboundAt, now),
    replySignature: chatSignature(await userName(tx, actor.userId), client),
    suggestion:
      admin && !client && chat.channel === "whatsapp"
        ? await chatSuggestion(tx, chat.address)
        : null,
    entries,
    files,
  }
}

/** Por qué no se puede responder con texto libre, en cada canal (pasaron 24 h, o nunca escribió). */
const CHAT_WINDOW_CLOSED_WORDS: Record<SaasChatChannel, (wrote: boolean) => string> = {
  whatsapp: (wrote) =>
    wrote
      ? "Pasaron 24 horas desde su último mensaje: WhatsApp solo deja retomar con la plantilla"
      : "Todavía no escribió: WhatsApp solo deja empezar con la plantilla",
  instagram: (wrote) =>
    wrote
      ? "Pasaron 24 horas desde su último mensaje: Instagram ya no deja responderle. Escríbele un correo o por WhatsApp"
      : "Todavía no escribió por Instagram: escríbele un correo o por WhatsApp",
  messenger: (wrote) =>
    wrote
      ? "Pasaron 24 horas desde su último mensaje: Messenger ya no deja responderle. Escríbele un correo o por WhatsApp"
      : "Todavía no escribió por Messenger: escríbele un correo o por WhatsApp",
}

export interface ChatReplyInput {
  /** Lo que escribe la persona; con plantilla, el texto que se guarda de ella (opcional). */
  body?: string | null
  /** Solo Administración: Soporte no lo ve aunque vea la conversación. */
  adminOnly?: boolean | null
  /** Fuera de las 24 h, solo en WhatsApp: la plantilla con que se retoma. */
  template?: string | null
  /**
   * La propuesta de la que habla el texto (solo Administración, lista y
   * vigente, como en «Escribir»). Por WhatsApp no va el PDF; con la plantilla
   * no va (la plantilla no la nombra).
   */
  proposalId?: string | null
  /** El mensaje de Kairós del que sale (`mensaje`): su ítem sigue a este envío. */
  kairosItemId?: string | null
}

export interface ChatReply {
  outreachId: string
  chatId: string
  clientId: string | null
  /** El número al que sale. */
  to: string
  /** Lo que sale: el texto con su firma, o lo que se guarda de la plantilla. */
  body: string
  template: ChatTemplate | null
  /** Los parámetros de la plantilla, en orden (el primer nombre de quien escribe). */
  templateParams: string[]
}

/**
 * Reserva la respuesta de una conversación (`pendiente`): la ruta la envía
 * después del commit con el id del envío como `biz_opaque_callback_data` y
 * anota el resultado. Texto libre solo dentro de las 24 h desde el último
 * mensaje de la persona (después, 409 con el motivo en `body`: la pantalla
 * ofrece la plantilla o el correo). Firma con el primer nombre de quien
 * escribe y la marca del cliente.
 */
export async function prepareChatReply(
  tx: Db,
  actor: AdminActor,
  chatId: string,
  input: ChatReplyInput,
  now = new Date(),
): Promise<ChatReply> {
  const chat = await lockChat(tx, actor, chatId)
  const client = await clientOf(tx, chat.clientId)
  let template: ChatTemplate | null = null
  if (input.template) {
    if (chat.channel !== "whatsapp")
      throw invalidField("template", "Solo WhatsApp retoma una conversación con una plantilla")
    if (!(CHAT_TEMPLATES as readonly string[]).includes(input.template))
      throw invalidField("template", "Esa plantilla no existe")
    template = input.template as ChatTemplate
  }
  const name = await userName(tx, actor.userId)
  const signature = chatSignature(name, client)
  let body: string
  let templateParams: string[] = []
  if (template) {
    templateParams = [firstName(name)]
    body = trimTo(input.body, OUTREACH_BODY_MAX) ?? `Plantilla «${template}»: ${templateParams[0]}`
  } else {
    if (!chatFreeWindow(chat.lastInboundAt, now).canReplyFreely) {
      const message = CHAT_WINDOW_CLOSED_WORDS[chat.channel as SaasChatChannel](
        chat.lastInboundAt !== null,
      )
      throw new ServiceError("CHAT_WINDOW_CLOSED", 409, message, { body: message })
    }
    const text = (input.body ?? "").trim()
    if (!text) throw invalidField("body", "Escribe el mensaje")
    const max = OUTREACH_BODY_MAX - signature.length - 2
    if (text.length > max) throw invalidField("body", `Usa como máximo ${max} caracteres`)
    body = `${text}\n\n${signature}`
  }
  // Se decide al reservarlo, como el mensaje al llegar: lo de una conversación que no es de una
  // clínica con su app es de la venta; lo demás, si Administración lo marca. Lo que escribe
  // Soporte (solo en una clínica con app) nunca lo es.
  // Escribir a mano es atenderla: Kairós deja de responder solo aquí, como con «Lo atiendo yo».
  // Así una persona puede escribir primero (la propuesta, un seguimiento) sin que respondan los dos.
  if (!chat.kairosPausedAt) {
    await tx
      .update(saasChat)
      .set({ kairosPausedAt: now, kairosPausedBy: actor.userId, updatedAt: now })
      .where(eq(saasChat.id, chat.id))
    await writeAdminAudit(tx, actor, {
      action: "chat.kairos_paused",
      entityId: chat.id,
      metadata: { chatId: chat.id, alEscribir: true },
    })
  }
  const adminOnly =!client?.organizationId || (actor.role === "admin" && Boolean(input.adminOnly))
  let proposalId: string | null = null
  if (input.proposalId && !template) {
    if (!chat.clientId)
      throw invalidField("proposalId", "Esta conversación no es de un cliente: ligala antes")
    proposalId = await sendableProposal(tx, actor, chat.clientId, input.proposalId, now)
  }
  let kairosItemId: string | null = null
  if (input.kairosItemId) {
    if (!UUID.test(input.kairosItemId))
      throw invalidField("kairosItemId", "Ese borrador de Kairós no existe")
    const [item] = await tx
      .select({ id: kairosItem.id, clientId: kairosItem.clientId })
      .from(kairosItem)
      .where(eq(kairosItem.id, input.kairosItemId))
      .limit(1)
    if (!item || !chat.clientId || item.clientId !== chat.clientId)
      throw invalidField("kairosItemId", "Ese borrador de Kairós no es de esta conversación")
    kairosItemId = item.id
  }
  const [row] = await tx
    .insert(saasOutreach)
    .values({
      clientId: chat.clientId,
      contactId: chat.contactId,
      channel: chat.channel as SaasChatChannel,
      toAddress: chat.address,
      body,
      chatId: chat.id,
      template,
      adminOnly,
      proposalId,
      kairosItemId,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo preparar el envío")
  // Ya se le respondió: Hoy no lo pide más. Si no sale, la pasada siguiente lo vuelve a poner.
  await closeChatKairosItems(
    tx,
    chat.id,
    ["chat_sin_cliente", "responder_chat"],
    "ya se le respondió",
    now,
  )
  await writeAdminAudit(tx, actor, {
    action: "arm.outreach_prepared",
    organizationId: client?.organizationId ?? null,
    entityId: chat.clientId ?? chat.id,
    metadata: {
      outreachId: row.id,
      channel: chat.channel,
      chatId: chat.id,
      template,
      adminOnly,
      proposalId,
      kairosItemId,
    },
  })
  return {
    outreachId: row.id,
    chatId: chat.id,
    clientId: chat.clientId,
    to: chat.address,
    body,
    template,
    templateParams,
  }
}

/**
 * Las plantillas de utilidad con que escribe Kairós fuera de las 24 h: retomar (pedir otra hora) y
 * el recordatorio de la presentación (nombre, día y hora, enlace de la sala).
 */
export const KAIROS_CHAT_TEMPLATES = ["retomar_conversacion", "recordatorio_presentacion"] as const
export type KairosChatTemplate = (typeof KAIROS_CHAT_TEMPLATES)[number]

export interface KairosChatReplyInput {
  /** El texto (sin firma: la pone el envío); con plantilla, lo que se guarda de ella. */
  body: string
  /** Fuera de las 24 h, solo WhatsApp. */
  template?: KairosChatTemplate | null
  templateParams?: string[]
  /**
   * Si Hoy deja de pedir respuesta (`chat_sin_cliente`, `responder_chat`). No cuando Kairós lo
   * pasa al equipo: ahí la respuesta es el aviso fijo y Hoy lo tiene que mostrar.
   */
  closeItems?: boolean
  /** `aviso` (recordatorio, otra hora, cambio): no responde el último mensaje. Por omisión, `respuesta`. */
  purpose?: SaasOutreachPurpose
}

/**
 * Reserva lo que escribe Kairós solo en una conversación (`pendiente`, a su nombre: `by_kairos`,
 * sin persona), con su firma «— Kairós · odentIA». Se envía después del commit con
 * `sendChatOutreach`, igual que lo de una persona: enviado, no salió o incierto, nunca se
 * reintenta. Texto libre solo dentro de las 24 h (después, 409 `CHAT_WINDOW_CLOSED`); la plantilla,
 * solo en WhatsApp. Siempre es solo de Administración: Kairós solo escribe en la venta.
 */
export async function prepareKairosChatReply(
  tx: Db,
  chatId: string,
  input: KairosChatReplyInput,
  now = new Date(),
): Promise<ChatReply> {
  const chat = await lockChat(tx, null, chatId)
  const client = await clientOf(tx, chat.clientId)
  const template = input.template ?? null
  if (template && chat.channel !== "whatsapp")
    throw invalidField("template", "Solo WhatsApp retoma una conversación con una plantilla")
  const signature = kairosChatSignature(client)
  let body: string
  if (template) {
    body = trimTo(input.body, OUTREACH_BODY_MAX) ?? `Plantilla «${template}»`
  } else {
    if (!chatFreeWindow(chat.lastInboundAt, now).canReplyFreely) {
      const message = CHAT_WINDOW_CLOSED_WORDS[chat.channel as SaasChatChannel](
        chat.lastInboundAt !== null,
      )
      throw new ServiceError("CHAT_WINDOW_CLOSED", 409, message, { body: message })
    }
    const text = (input.body ?? "").trim()
    if (!text) throw invalidField("body", "Escribe el mensaje")
    body = `${text.slice(0, OUTREACH_BODY_MAX - signature.length - 2)}\n\n${signature}`
  }
  const [row] = await tx
    .insert(saasOutreach)
    .values({
      clientId: chat.clientId,
      contactId: chat.contactId,
      channel: chat.channel as SaasChatChannel,
      toAddress: chat.address,
      body,
      chatId: chat.id,
      template,
      adminOnly: true,
      byKairos: true,
      purpose: input.purpose ?? "respuesta",
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo preparar el envío")
  if (input.closeItems !== false)
    await closeChatKairosItems(
      tx,
      chat.id,
      ["chat_sin_cliente", "responder_chat"],
      "Kairós le respondió",
      now,
    )
  await writeAdminAudit(tx, null, {
    action: "kairos.chat_reply_prepared",
    organizationId: client?.organizationId ?? null,
    entityId: chat.clientId ?? chat.id,
    metadata: { outreachId: row.id, channel: chat.channel, chatId: chat.id, template },
  })
  return {
    outreachId: row.id,
    chatId: chat.id,
    clientId: chat.clientId,
    to: chat.address,
    body,
    template: template as ChatTemplate | null,
    templateParams: input.templateParams ?? [],
  }
}

/**
 * «Lo atiendo yo»: Kairós deja de responder solo en esta conversación hasta «Devolver a Kairós».
 * Lo hace cualquiera del equipo que la ve. Si ya estaba pausada, no cambia quién la pausó.
 */
export async function pauseChatKairos(
  tx: Db,
  actor: AdminActor,
  chatId: string,
  now = new Date(),
): Promise<{ chatId: string; kairosPausedAt: Date }> {
  const chat = await lockChat(tx, actor, chatId)
  if (chat.kairosPausedAt) return { chatId: chat.id, kairosPausedAt: chat.kairosPausedAt }
  await tx
    .update(saasChat)
    .set({ kairosPausedAt: now, kairosPausedBy: actor.userId, updatedAt: now })
    .where(eq(saasChat.id, chat.id))
  await writeAdminAudit(tx, actor, {
    action: "chat.kairos_paused",
    entityId: chat.id,
    metadata: { chatId: chat.id },
  })
  return { chatId: chat.id, kairosPausedAt: now }
}

/** «Devolver a Kairós»: vuelve a responder solo lo que siga sin respuesta y lo que llegue. */
export async function resumeChatKairos(
  tx: Db,
  actor: AdminActor,
  chatId: string,
  now = new Date(),
): Promise<{ chatId: string; kairosPausedAt: null }> {
  const chat = await lockChat(tx, actor, chatId)
  if (chat.kairosPausedAt) {
    await tx
      .update(saasChat)
      .set({ kairosPausedAt: null, kairosPausedBy: null, updatedAt: now })
      .where(eq(saasChat.id, chat.id))
    await writeAdminAudit(tx, actor, {
      action: "chat.kairos_resumed",
      entityId: chat.id,
      metadata: { chatId: chat.id },
    })
  }
  return { chatId: chat.id, kairosPausedAt: null }
}

export interface ChatMessageInput {
  /** La persona del cliente: su celular es la conversación. */
  contactId: string
  body: string
  proposalId?: string | null
  kairosItemId?: string | null
}

/**
 * El mensaje que se le escribe primero a una persona del cliente por el
 * WhatsApp de Sallca (el de Kairós, `mensaje`): la conversación de su celular
 * (creada si nunca escribió, `openChatForContact`) y la respuesta reservada
 * (`prepareChatReply`). Dentro de las 24 h sale el texto; fuera, WhatsApp
 * solo deja empezar con la plantilla `retomar_conversacion` y el texto no
 * sale (la plantilla no lo lleva): queda dicho en `template`. La ruta lo envía
 * después del commit, como cualquier respuesta.
 */
export async function prepareChatMessage(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  input: ChatMessageInput,
  now = new Date(),
): Promise<ChatReply> {
  // Una conversación comercial es solo de Administración (D4): Soporte no la abre ni la ve.
  const client = UUID.test(clientId) ? await clientOf(tx, clientId) : null
  if (client && !seesChat(actor, client))
    throw new ServiceError(
      "CHAT_ADMIN_ONLY",
      409,
      "El WhatsApp con una clínica que aún no tiene su cuenta lo envía Administración: pídeselo o escríbele un correo",
    )
  const opened = await openChatForContact(
    tx,
    actor,
    { clientId, contactId: input.contactId, channel: "whatsapp" },
    now,
  )
  const [chat] = await tx
    .select({ lastInboundAt: saasChat.lastInboundAt })
    .from(saasChat)
    .where(eq(saasChat.id, opened.chatId))
    .limit(1)
  const free = chatFreeWindow(chat?.lastInboundAt ?? null, now).canReplyFreely
  return prepareChatReply(
    tx,
    actor,
    opened.chatId,
    free
      ? { body: input.body, proposalId: input.proposalId, kairosItemId: input.kairosItemId }
      : { template: "retomar_conversacion", kairosItemId: input.kairosItemId },
    now,
  )
}

/** El envío de una conversación, bloqueado; sin persona (lo anota la ruta o el webhook). */
async function lockChatOutreach(
  tx: Db,
  where: { outreachId?: string | null; externalId?: string | null },
): Promise<OutreachRecord | null> {
  const condition = where.outreachId
    ? UUID.test(where.outreachId)
      ? eq(saasOutreach.id, where.outreachId)
      : null
    : where.externalId
      ? eq(saasOutreach.externalId, where.externalId)
      : null
  if (!condition) return null
  const [row] = await tx.select().from(saasOutreach).where(condition).for("update").limit(1)
  return row?.chatId ? row : null
}

/** Pasa el envío a su estado nuevo y, si salió, deja la actividad. Una sola vez por cambio. */
async function settleChatOutreach(
  tx: Db,
  row: OutreachRecord,
  status: "enviado" | "incierto" | "no_salio",
  now: Date,
  extra: { externalId?: string | null; why?: string | null; metaStatus?: string | null } = {},
): Promise<OutreachRecord> {
  const [updated] = await tx
    .update(saasOutreach)
    .set({
      status,
      sentAt: status === "enviado" ? now : null,
      ...(extra.externalId && !row.externalId ? { externalId: extra.externalId } : {}),
      updatedAt: now,
    })
    .where(eq(saasOutreach.id, row.id))
    .returning()
  if (!updated) throw notFound("Envío")
  if (status === "enviado") await recordReplyActivity(tx, updated, now)
  await writeAdminAudit(tx, null, {
    action:
      status === "enviado"
        ? "arm.outreach_sent"
        : status === "incierto"
          ? "arm.outreach_uncertain"
          : "arm.outreach_failed",
    entityId: row.clientId ?? row.chatId,
    metadata: {
      outreachId: row.id,
      chatId: row.chatId,
      from: row.status,
      ...(extra.why ? { why: extra.why.slice(0, 500) } : {}),
      ...(extra.metaStatus ? { metaStatus: extra.metaStatus } : {}),
    },
  })
  if (status !== "enviado" && updated.byKairos && updated.purpose === "respuesta")
    await handOverKairosReply(tx, updated, status, now, extra.why ?? null)
  return updated
}

/**
 * La respuesta de Kairós no salió (Meta la rechazó) o no se sabe si salió: la conversación no
 * está atendida. Su turno pasa a `fallo` con el porqué y la conversación queda pausada sin
 * persona («Kairós se la pasó al equipo»): `responder_chat` sale en Hoy y el equipo la ve.
 */
async function handOverKairosReply(
  tx: Db,
  row: OutreachRecord,
  status: "incierto" | "no_salio",
  now: Date,
  why: string | null,
): Promise<void> {
  const words =
    status === "no_salio"
      ? `Su respuesta no salió${why ? ` (${why.slice(0, 200)})` : ""}`
      : "No se sabe si salió su respuesta"
  const turns = await tx
    .update(kairosChatTurn)
    .set({ outcome: "fallo", why: words.slice(0, 500), updatedAt: now })
    .where(and(eq(kairosChatTurn.outreachId, row.id), eq(kairosChatTurn.outcome, "respondio")))
    .returning({ chatId: kairosChatTurn.chatId })
  const chatId = turns[0]?.chatId ?? row.chatId
  if (!chatId) return
  const paused = await tx
    .update(saasChat)
    .set({ kairosPausedAt: now, kairosPausedBy: null, updatedAt: now })
    .where(and(eq(saasChat.id, chatId), isNull(saasChat.kairosPausedAt)))
    .returning({ id: saasChat.id })
  if (turns.length > 0 || paused.length > 0)
    await writeAdminAudit(tx, null, {
      action: "kairos.chat_failed",
      entityId: row.clientId ?? chatId,
      metadata: { chatId, clientId: row.clientId, outreachId: row.id, why: words },
    })
}

export interface ChatOutreachResult {
  outreachId: string
  status: SaasOutreachStatus
  /** Si este aviso cambió algo (uno repetido o tardío no cambia nada). */
  changed: boolean
}

function resultOf(row: OutreachRecord, changed: boolean): ChatOutreachResult {
  return { outreachId: row.id, status: row.status as SaasOutreachStatus, changed }
}

/**
 * Meta aceptó el envío: `enviado`, con su `wamid`. También uno incierto, si
 * Meta responde tarde. Lo ya resuelto no cambia.
 */
export async function markChatOutreachSent(
  tx: Db,
  outreachId: string,
  externalId: string,
  now = new Date(),
): Promise<ChatOutreachResult> {
  const row = await lockChatOutreach(tx, { outreachId })
  if (!row) throw notFound("Envío")
  const wamid = trimTo(externalId, 256)
  if (row.status !== "pendiente" && row.status !== "incierto") return resultOf(row, false)
  return resultOf(await settleChatOutreach(tx, row, "enviado", now, { externalId: wamid }), true)
}

/** Meta lo rechazó explícitamente: no salió, con el motivo en la auditoría. Es final. */
export async function markChatOutreachFailed(
  tx: Db,
  outreachId: string,
  why: string | null,
  now = new Date(),
): Promise<ChatOutreachResult> {
  const row = await lockChatOutreach(tx, { outreachId })
  if (!row) throw notFound("Envío")
  if (row.status !== "pendiente" && row.status !== "incierto") return resultOf(row, false)
  return resultOf(await settleChatOutreach(tx, row, "no_salio", now, { why }), true)
}

/**
 * Se cortó y no se sabe si salió: `incierto`. Nunca se reintenta; lo resuelve
 * el estado que mande Meta después o una persona («¿Salió?»).
 */
export async function markChatOutreachUncertain(
  tx: Db,
  outreachId: string,
  now = new Date(),
): Promise<ChatOutreachResult> {
  const row = await lockChatOutreach(tx, { outreachId })
  if (!row) throw notFound("Envío")
  if (row.status !== "pendiente") return resultOf(row, false)
  return resultOf(await settleChatOutreach(tx, row, "incierto", now), true)
}

export const CHAT_META_STATUSES = ["sent", "delivered", "read", "failed"] as const
export type ChatMetaStatus = (typeof CHAT_META_STATUSES)[number]

/**
 * Un estado que llegó por el webhook de WhatsApp, por el `wamid` del envío o
 * por su id (`biz_opaque_callback_data`). Solo WhatsApp: Instagram y Messenger
 * no mandan estados con nuestro id (su incierto lo resuelve una persona). `sent`, `delivered` o `read` dicen que
 * salió: lo pendiente o incierto pasa a enviado. `failed` solo cambia lo
 * pendiente o incierto (a no salió): lo que ya salió no vuelve atrás. Lo que no
 * es de una conversación, o no se reconoce, se ignora (nulo).
 */
export async function applyChatStatus(
  tx: Db,
  input: { externalId?: string | null; outreachId?: string | null; status: ChatMetaStatus },
  now = new Date(),
): Promise<ChatOutreachResult | null> {
  if (!(CHAT_META_STATUSES as readonly string[]).includes(input.status)) return null
  const row =
    (input.externalId ? await lockChatOutreach(tx, { externalId: input.externalId }) : null) ??
    (input.outreachId ? await lockChatOutreach(tx, { outreachId: input.outreachId }) : null)
  if (!row || row.channel !== "whatsapp") return null
  if (row.status !== "pendiente" && row.status !== "incierto") return resultOf(row, false)
  const next = input.status === "failed" ? "no_salio" : "enviado"
  return resultOf(
    await settleChatOutreach(tx, row, next, now, {
      externalId: input.externalId ?? null,
      metaStatus: input.status,
    }),
    true,
  )
}
