/**
 * Kairós vende en los chats (ADR 0189 y el lienzo «Kairós vende», K1–K9): lo
 * que el worker necesita para que Kairós responda solo en WhatsApp, Instagram y
 * Messenger a quien todavía no tiene su app, y agende la presentación.
 *
 * Reglas que rigen aquí:
 * - Solo con el interruptor prendido (`kairos_setting.sells_enabled`, solo
 *   Administración), en una conversación sin «Lo atiendo yo», que no es «No es
 *   una clínica» y cuyo cliente, si tiene, aún no tiene su app (la de una
 *   clínica con su app espera a Soporte). Solo dentro de las 24 h de Meta.
 * - Un mensaje, una vez (`kairos_chat_turn.message_id` único) y una
 *   conversación a la vez (candado por conversación al reclamarla).
 * - Lo que hace Kairós queda a su nombre: sin persona en la auditoría, sus
 *   envíos con `by_kairos`. Nunca liga una conversación a una clínica que ya
 *   existía: crea la suya y, si se parece a otra, deja «¿Es la misma que…?».
 * - Si lo pasa al equipo, falla o cree que escribe un paciente, la conversación
 *   queda pausada sin persona («Kairós la pasó al equipo») y Hoy la muestra:
 *   el aviso fijo que salió no cuenta como respuesta.
 * - Los avisos de la presentación (recordatorio del día anterior, pedir otra
 *   hora, un cambio hecho por una persona) salen una sola vez por su clave en
 *   la auditoría, escrita en la misma transacción que reserva el envío.
 */
import type { Db } from "@odentia/db"
import {
  type KairosTurnOutcome,
  kairosChatTurn,
  kairosProposal,
  kairosSetting,
  saasChat,
  saasClient,
  saasClientContact,
  saasInboundMessage,
  saasOutreach,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminAudit, adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { findClientDuplicates } from "./admin-clients.js"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import {
  type ChatReply,
  chatFreeWindow,
  kairosAssignChat,
  prepareKairosChatReply,
} from "./admin-inbound-chat.js"
import { raiseKairosDuplicate } from "./admin-kairos.js"
import { kairosAllowedEmailText } from "./admin-kairos-drafts.js"
import { type OutreachRow, prepareKairosMail } from "./admin-sales.js"
import {
  cancelPresentation,
  confirmProposal,
  type KairosProposalRow,
  movePresentation,
  pendingKairosProposal,
  presentationWhenWords,
  proposeSlot,
  type StaffSlot,
  staffSlots,
} from "./admin-staff-schedule.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { type KairosSalesFacts, kairosSalesFacts } from "./kairos-sales-facts.js"
import { limaDate } from "./peru-business-days.js"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const E164 = /^\+[1-9][0-9]{6,14}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Kairós espera a que la persona termine de escribir: responde lo que lleva este rato sin mensajes nuevos. */
export const KAIROS_SELL_QUIET_MS = 20_000
/** Un turno que quedó «en curso» más que esto se cortó (el worker se cayó): Hoy lo muestra. */
export const KAIROS_TURN_STALE_MS = 10 * MINUTE
/** Cuántos mensajes de la conversación ve el modelo como mucho. */
export const KAIROS_HISTORY_MAX = 20
/** Cuántas horas ofrece Kairós de una vez. */
export const KAIROS_SLOTS_OFFERED = 3

/** El aviso fijo cuando Kairós no puede responder (falla, comprobación, no sabe): nunca deja sin respuesta. */
export const KAIROS_FALLBACK_TEXT = "Gracias por escribir. Alguien del equipo te responde pronto."

/* ---------- El interruptor ---------- */

export interface KairosSellsSetting {
  enabled: boolean
  updatedAt: Date | null
  updatedBy: { userId: string; name: string } | null
}

export async function getKairosSells(tx: Db): Promise<KairosSellsSetting> {
  const [row] = await tx
    .select({ setting: kairosSetting, name: user.name })
    .from(kairosSetting)
    .leftJoin(user, eq(user.id, kairosSetting.updatedBy))
    .where(eq(kairosSetting.id, true))
    .limit(1)
  if (!row) return { enabled: false, updatedAt: null, updatedBy: null }
  return {
    enabled: row.setting.sellsEnabled,
    updatedAt: row.setting.updatedAt,
    updatedBy: row.setting.updatedBy
      ? { userId: row.setting.updatedBy, name: row.name ?? "" }
      : null,
  }
}

/** Prende o apaga «Kairós responde solo en los chats». Solo Administración. */
export async function setKairosSells(
  tx: Db,
  actor: AdminActor,
  enabled: boolean,
  now = new Date(),
): Promise<KairosSellsSetting> {
  if (actor.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Solo el rol Administración prende o apaga a Kairós")
  if (typeof enabled !== "boolean") throw invalidField("enabled", "Di si lo prendes o lo apagas")
  await tx
    .insert(kairosSetting)
    .values({ id: true, sellsEnabled: enabled, updatedBy: actor.userId, updatedAt: now })
    .onConflictDoUpdate({
      target: kairosSetting.id,
      set: { sellsEnabled: enabled, updatedBy: actor.userId, updatedAt: now },
    })
  await writeAdminAudit(tx, actor, {
    action: enabled ? "kairos.sells_enabled" : "kairos.sells_disabled",
    entityId: "kairos_setting",
  })
  return getKairosSells(tx)
}

/** El interruptor, en SQL: con la fila apagada o sin fila, falso. */
const sellsEnabledSql = sql`coalesce((select s.sells_enabled from admin.kairos_setting s where s.id), false)`

/**
 * Kairós atiende esta conversación: prendido, sin pausa, no «No es una clínica»
 * y sin la app de una clínica. Lo muestra el cajón de la conversación.
 */
export async function kairosHandlesChat(
  tx: Db,
  chat: { kairosPausedAt: Date | null; notClinicAt: Date | null },
  client: { organizationId: string | null } | null,
): Promise<boolean> {
  if (chat.kairosPausedAt || chat.notClinicAt || client?.organizationId) return false
  return (await getKairosSells(tx)).enabled
}

/**
 * En las reglas de Hoy (`ruleInboundChats`): el último mensaje de la conversación `c` (con su
 * cliente `cl` y su mensaje `m`) lo está atendiendo Kairós, así que «Responder» no sale. Deja de
 * serlo si se apagó, se pausó (o Kairós la pasó al equipo), pasaron las 24 h, la omitió o su
 * turno quedó colgado.
 */
export function kairosHandlesSql(now: Date) {
  const at = sql`${now.toISOString()}::timestamptz`
  return sql`(${sellsEnabledSql} and c.kairos_paused_at is null and c.not_clinic_at is null
    and cl.organization_id is null
    and m.received_at > ${at} - interval '24 hours'
    and not exists (select 1 from admin.kairos_chat_turn t where t.message_id = m.id
      and (t.outcome = 'omitido' or (t.outcome = 'en_curso'
        and t.created_at < ${at} - make_interval(secs => ${KAIROS_TURN_STALE_MS / 1000})))))`
}

/* ---------- Qué responder ---------- */

export interface KairosChatToAnswer {
  chatId: string
  messageId: string
}

/** Las condiciones de una conversación que Kairós responde ahora, sobre `c`, `cl` y su último mensaje `m`. */
function answerableSql(now: Date) {
  const at = sql`${now.toISOString()}::timestamptz`
  return sql`${sellsEnabledSql}
    and c.kairos_paused_at is null and c.not_clinic_at is null
    and (cl.id is null or (cl.organization_id is null and cl.archived_at is null))
    and m.received_at > ${at} - interval '24 hours'
    and m.received_at <= ${at} - make_interval(secs => ${KAIROS_SELL_QUIET_MS / 1000})
    and not exists (select 1 from admin.saas_outreach o where o.chat_id = c.id
      and o.status in ('pendiente', 'enviado', 'incierto') and o.created_at >= m.received_at)
    and not exists (select 1 from admin.kairos_chat_turn t where t.message_id = m.id)
    and not exists (select 1 from admin.kairos_chat_turn t where t.chat_id = c.id
      and t.outcome = 'en_curso' and t.created_at > ${at} - make_interval(secs => ${KAIROS_TURN_STALE_MS / 1000}))`
}

const lastMessageJoin = sql`join lateral (select id, received_at from admin.saas_inbound_message
    where chat_id = c.id order by received_at desc, created_at desc, id desc limit 1) m on true
  left join admin.saas_client cl on cl.id = c.client_id`

/**
 * Las conversaciones con un mensaje de la persona sin responder que Kairós
 * puede responder ahora, la más antigua primero. Vacío con el interruptor apagado.
 */
export async function kairosChatsToAnswer(
  tx: Db,
  now = new Date(),
  limit = 10,
): Promise<KairosChatToAnswer[]> {
  const rows = await tx.execute<{
    chat_id: string
    message_id: string
  }>(sql`select c.id as chat_id, m.id as message_id
    from admin.saas_chat c ${lastMessageJoin}
    where ${answerableSql(now)}
    order by m.received_at asc, c.id asc
    limit ${limit}`)
  return [...rows].map((row) => ({ chatId: row.chat_id, messageId: row.message_id }))
}

/**
 * Reclama el turno de ese mensaje: con el candado de la conversación vuelve a
 * mirar que se pueda responder y que siga siendo el último, y anota el turno
 * `en_curso`. Devuelve su id, o null si ya no toca (otro worker, llegó otro
 * mensaje, se apagó o se pausó).
 */
export async function claimKairosTurn(
  tx: Db,
  target: KairosChatToAnswer,
  now = new Date(),
): Promise<string | null> {
  if (!UUID.test(target.chatId) || !UUID.test(target.messageId)) return null
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`kairos-vende:${target.chatId}`}))`)
  const [still] = await tx.execute<{ message_id: string }>(sql`select m.id as message_id
    from admin.saas_chat c ${lastMessageJoin}
    where c.id = ${target.chatId}::uuid and ${answerableSql(now)}`)
  if (!still || still.message_id !== target.messageId) return null
  const [row] = await tx
    .insert(kairosChatTurn)
    .values({
      chatId: target.chatId,
      messageId: target.messageId,
      outcome: "en_curso",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: kairosChatTurn.id })
  return row?.id ?? null
}

/** Cómo terminó el turno. Si lo pasó o falló, la conversación queda pausada sin persona. */
export async function finishKairosTurn(
  tx: Db,
  turnId: string,
  result: {
    outcome: Exclude<KairosTurnOutcome, "en_curso">
    why?: string | null
    outreachId?: string | null
  },
  now = new Date(),
): Promise<void> {
  const [turn] = await tx
    .update(kairosChatTurn)
    .set({
      outcome: result.outcome,
      why: result.why ? result.why.slice(0, 500) : null,
      outreachId: result.outreachId ?? null,
      updatedAt: now,
    })
    .where(eq(kairosChatTurn.id, turnId))
    .returning({ chatId: kairosChatTurn.chatId })
  if (!turn) throw notFound("Turno de Kairós")
  if (result.outcome === "paso" || result.outcome === "fallo") {
    const [chat] = await tx
      .update(saasChat)
      .set({ kairosPausedAt: now, kairosPausedBy: null, updatedAt: now })
      .where(and(eq(saasChat.id, turn.chatId), sql`${saasChat.kairosPausedAt} is null`))
      .returning({ clientId: saasChat.clientId })
    await writeAdminAudit(tx, null, {
      action: result.outcome === "paso" ? "kairos.chat_handed_over" : "kairos.chat_failed",
      entityId: chat?.clientId ?? turn.chatId,
      metadata: { chatId: turn.chatId, clientId: chat?.clientId ?? null, why: result.why ?? null },
    })
  }
}

/* ---------- Lo que ve el modelo ---------- */

/** Un mensaje de la conversación tal como lo ve el modelo. */
export interface KairosChatLine {
  who: "persona" | "kairos" | "equipo"
  at: Date
  text: string
}

export interface KairosChatContext {
  chat: {
    id: string
    channel: "whatsapp" | "instagram" | "messenger"
    displayName: string | null
    lastInboundAt: Date | null
  }
  client: { id: string; name: string; product: string; ownerUserId: string | null } | null
  contact: { id: string; name: string; phone: string | null; email: string | null } | null
  /** Kairós todavía no le escribió en esta conversación: se presenta. */
  firstReply: boolean
  /** Lo hablado, lo último al final, con lo que escribió la persona ya filtrado (sin datos de pacientes). */
  history: KairosChatLine[]
  /** Cuántas frases de la persona se quitaron por parecer de un paciente. */
  omitted: number
  /** El WhatsApp o el correo que dejó en sus mensajes, leído sin modelo (el filtro puede taparlo). */
  leftContact: { phone: string | null; email: string | null }
  /** La hora que espera su sí. */
  proposal: (KairosProposalRow & { assigneeName: string }) | null
  /** Su presentación abierta, si ya tiene. */
  presentation: {
    taskId: string
    startsAt: Date
    assigneeName: string
    meetingUrl: string | null
  } | null
  sales: KairosSalesFacts
}

/** Un celular o un correo escritos en un mensaje: el celular en E.164 (9 cifras que empiezan con 9 son de Perú). */
export function contactIn(text: string | null | undefined): {
  phone: string | null
  email: string | null
} {
  const raw = text ?? ""
  const email =
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(raw)?.[0]?.toLowerCase() ?? null
  let phone: string | null = null
  for (const found of raw.matchAll(/\+?\d[\d\s.-]{6,17}\d/g)) {
    const digits = found[0].replace(/[^\d]/g, "")
    const candidate = found[0].trim().startsWith("+")
      ? `+${digits}`
      : digits.length === 9 && digits.startsWith("9")
        ? `+51${digits}`
        : digits.length === 11 && digits.startsWith("51")
          ? `+${digits}`
          : null
    if (candidate && E164.test(candidate)) {
      phone = candidate
      break
    }
  }
  return { phone, email: email && EMAIL.test(email) ? email : null }
}

/** El texto de una respuesta sin la firma del final («— Ana · odentIA»). */
function withoutSignature(body: string): string {
  return body.replace(/\n+—\s[^\n]*$/u, "").trim()
}

async function staffName(
  tx: Db,
  userId: string | null,
): Promise<{ name: string; meetingUrl: string | null }> {
  if (!userId) return { name: "alguien del equipo", meetingUrl: null }
  const [row] = await tx
    .select({ name: user.name, meetingUrl: adminStaff.meetingUrl })
    .from(user)
    .leftJoin(adminStaff, eq(adminStaff.userId, user.id))
    .where(eq(user.id, userId))
    .limit(1)
  return { name: row?.name ?? "alguien del equipo", meetingUrl: row?.meetingUrl ?? null }
}

/** La presentación abierta con hora de esta conversación (o, si no, de su cliente). */
async function openPresentation(tx: Db, chatId: string, clientId: string | null) {
  const [task] = await tx
    .select()
    .from(saasTask)
    .where(
      and(
        eq(saasTask.kind, "presentacion"),
        eq(saasTask.status, "abierta"),
        sql`${saasTask.dueAt} is not null`,
        clientId
          ? sql`(${saasTask.channelChatId} = ${chatId}::uuid or ${saasTask.clientId} = ${clientId}::uuid)`
          : eq(saasTask.channelChatId, chatId),
      ),
    )
    .orderBy(asc(saasTask.dueAt))
    .limit(1)
  return task ?? null
}

/** Lo que el modelo necesita para responder esta conversación, ya filtrado. */
export async function kairosChatContext(
  tx: Db,
  chatId: string,
  now = new Date(),
): Promise<KairosChatContext> {
  if (!UUID.test(chatId)) throw notFound("Conversación")
  const [chat] = await tx.select().from(saasChat).where(eq(saasChat.id, chatId)).limit(1)
  if (!chat) throw notFound("Conversación")
  const [client] = chat.clientId
    ? await tx.select().from(saasClient).where(eq(saasClient.id, chat.clientId)).limit(1)
    : []
  const [contact] = chat.contactId
    ? await tx
        .select()
        .from(saasClientContact)
        .where(eq(saasClientContact.id, chat.contactId))
        .limit(1)
    : []
  const messages = await tx
    .select()
    .from(saasInboundMessage)
    .where(eq(saasInboundMessage.chatId, chat.id))
    .orderBy(desc(saasInboundMessage.receivedAt), desc(saasInboundMessage.id))
    .limit(KAIROS_HISTORY_MAX)
  const replies = await tx
    .select()
    .from(saasOutreach)
    .where(eq(saasOutreach.chatId, chat.id))
    .orderBy(desc(saasOutreach.createdAt), desc(saasOutreach.id))
    .limit(KAIROS_HISTORY_MAX)
  let omitted = 0
  const lines: KairosChatLine[] = []
  for (const message of messages) {
    const allowed = kairosAllowedEmailText(message.body, { adminOnly: true })
    omitted += allowed.omitted
    const files = message.media.length
    const text = [
      allowed.lines.join(" "),
      files > 0
        ? `(mandó ${files === 1 ? "un archivo" : `${files} archivos`} que no puedes ver)`
        : "",
    ]
      .filter(Boolean)
      .join(" ")
    lines.push({ who: "persona", at: message.receivedAt, text: text || "(un mensaje sin texto)" })
  }
  for (const reply of replies) {
    if (reply.status === "no_salio") continue
    lines.push({
      who: reply.byKairos ? "kairos" : "equipo",
      at: reply.createdAt,
      text: withoutSignature(reply.body),
    })
  }
  const history = lines.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-KAIROS_HISTORY_MAX)
  // El contacto que dejó: del último mensaje que lo trae (sin modelo, antes del filtro).
  let leftContact: { phone: string | null; email: string | null } = { phone: null, email: null }
  for (const message of messages) {
    const found = contactIn(message.body)
    if (found.phone || found.email) {
      leftContact = found
      break
    }
  }
  const pending = await pendingKairosProposal(tx, chat.id, now)
  const task = await openPresentation(tx, chat.id, chat.clientId)
  const presenter = task ? await staffName(tx, task.assigneeUserId) : null
  return {
    chat: {
      id: chat.id,
      channel: chat.channel as KairosChatContext["chat"]["channel"],
      displayName: chat.displayName,
      lastInboundAt: chat.lastInboundAt,
    },
    client: client
      ? {
          id: client.id,
          name: client.name,
          product: client.product,
          ownerUserId: client.ownerUserId,
        }
      : null,
    contact: contact
      ? { id: contact.id, name: contact.name, phone: contact.phone, email: contact.email }
      : null,
    firstReply: !replies.some((reply) => reply.byKairos),
    history,
    omitted,
    leftContact,
    proposal: pending
      ? { ...pending, assigneeName: (await staffName(tx, pending.assigneeUserId)).name }
      : null,
    presentation:
      task?.dueAt && presenter
        ? {
            taskId: task.id,
            startsAt: task.dueAt,
            assigneeName: presenter.name,
            meetingUrl: presenter.meetingUrl,
          }
        : null,
    sales: await kairosSalesFacts(tx, client?.product ?? "dental"),
  }
}

/* ---------- Lo que hace con sus herramientas ---------- */

/** Una hora que Kairós ofrece: con quién y cuándo. */
export interface KairosOfferedSlot {
  startsAt: Date
  userId: string
  name: string
}

/**
 * Hasta tres horas para ofrecer (`ver_horarios`): las del responsable si tiene
 * (si no, de quien esté libre), repartidas: la primera, y después las que caen
 * al menos 2 h después o en otro día. `from`/`to` acotan a lo que pidió.
 */
export async function kairosSlots(
  tx: Db,
  chatId: string,
  range: { from?: Date | null; to?: Date | null },
  now = new Date(),
): Promise<KairosOfferedSlot[]> {
  const [chat] = await tx
    .select({ clientId: saasChat.clientId, owner: saasClient.ownerUserId })
    .from(saasChat)
    .leftJoin(saasClient, eq(saasClient.id, saasChat.clientId))
    .where(eq(saasChat.id, chatId))
    .limit(1)
  if (!chat) throw notFound("Conversación")
  const all: StaffSlot[] = await staffSlots(tx, {
    preferUserId: chat.owner ?? null,
    from: range.from ?? null,
    to: range.to ?? null,
    now,
    limit: 200,
  })
  const picked: StaffSlot[] = []
  for (const slot of all) {
    if (picked.length >= KAIROS_SLOTS_OFFERED) break
    const last = picked.at(-1)
    if (
      !last ||
      limaDate(slot.startsAt) !== limaDate(last.startsAt) ||
      slot.startsAt.getTime() - last.startsAt.getTime() >= 2 * HOUR
    )
      picked.push(slot)
  }
  return picked.map((slot) => ({ startsAt: slot.startsAt, userId: slot.userId, name: slot.name }))
}

/** `proponer_hora`: la hora que eligió, con quien la ofreció; la última manda. */
export async function kairosPropose(
  tx: Db,
  chatId: string,
  slot: { startsAt: Date; userId: string },
  now = new Date(),
): Promise<KairosProposalRow> {
  return proposeSlot(tx, { chatId, assigneeUserId: slot.userId, startsAt: slot.startsAt }, now)
}

/** Lo que dice el mensaje cuando queda agendada o se mueve: día, hora de Lima, con quién y su sala. */
export interface KairosBooked {
  taskId: string
  startsAt: Date
  assigneeName: string
  meetingUrl: string | null
  /** El texto fijo que va en la respuesta (lo agrega el código, no el modelo). */
  confirmation: string
}

function bookedWords(
  kind: "agendada" | "movida",
  startsAt: Date,
  assigneeName: string,
  meetingUrl: string | null,
): string {
  const head =
    kind === "agendada"
      ? `Quedó agendada tu presentación de 45 minutos para el ${presentationWhenWords(startsAt)} (hora de Lima) con ${assigneeName}.`
      : `Tu presentación pasó al ${presentationWhenWords(startsAt)} (hora de Lima), con ${assigneeName}.`
  const room = meetingUrl
    ? `Es por videollamada: entra a la hora aquí ${meetingUrl}`
    : `Es por videollamada: ${assigneeName} te comparte el enlace antes de empezar.`
  return `${head} ${room}`
}

/** Lo que falta para agendar, o null: la clínica y, por Instagram o Messenger, su WhatsApp o su correo. */
export async function kairosBookingMissing(
  tx: Db,
  chatId: string,
): Promise<"clinica" | "contacto" | null> {
  const [row] = await tx
    .select({ chat: saasChat, contact: saasClientContact })
    .from(saasChat)
    .leftJoin(saasClientContact, eq(saasClientContact.id, saasChat.contactId))
    .where(eq(saasChat.id, chatId))
    .limit(1)
  if (!row) throw notFound("Conversación")
  if (!row.chat.clientId) return "clinica"
  if (row.chat.channel !== "whatsapp" && !row.contact?.phone && !row.contact?.email)
    return "contacto"
  return null
}

/**
 * `agendar`: confirma la hora pendiente que la persona eligió (`confirmProposal`,
 * con el candado de quien presenta). Antes, la clínica y (Instagram o
 * Messenger) un WhatsApp o un correo para avisarle. Si ya tiene una abierta, no
 * agenda otra: eso es `mover`.
 */
export async function kairosBook(
  tx: Db,
  chatId: string,
  proposalId: string,
  now = new Date(),
): Promise<KairosBooked> {
  const missing = await kairosBookingMissing(tx, chatId)
  if (missing === "clinica")
    throw new ServiceError("CLIENT_REQUIRED", 409, "Falta el nombre de la clínica")
  if (missing === "contacto")
    throw new ServiceError("CONTACT_REQUIRED", 409, "Falta su WhatsApp o su correo para avisarle")
  const pending = await pendingKairosProposal(tx, chatId, now)
  if (!pending || pending.id !== proposalId)
    throw new ServiceError("PROPOSAL_CLOSED", 409, "Esa hora ya no está propuesta")
  const [chat] = await tx
    .select({ clientId: saasChat.clientId })
    .from(saasChat)
    .where(eq(saasChat.id, chatId))
    .limit(1)
  if (await openPresentation(tx, chatId, chat?.clientId ?? null))
    throw new ServiceError(
      "PRESENTATION_EXISTS",
      409,
      "Ya tiene una presentación agendada: muévela",
    )
  const result = await confirmProposal(tx, proposalId, now)
  if (result.status !== "confirmada")
    throw new ServiceError(result.error.code, 409, result.error.message)
  const presenter = await staffName(tx, result.proposal.assigneeUserId)
  await writeAdminAudit(tx, null, {
    action: "kairos.presentation_booked",
    entityId: result.task.clientId,
    metadata: {
      chatId,
      clientId: result.task.clientId,
      taskId: result.task.id,
      startsAt: result.proposal.startsAt.toISOString(),
    },
  })
  return {
    taskId: result.task.id,
    startsAt: result.proposal.startsAt,
    assigneeName: presenter.name,
    meetingUrl: presenter.meetingUrl,
    confirmation: bookedWords(
      "agendada",
      result.proposal.startsAt,
      presenter.name,
      presenter.meetingUrl,
    ),
  }
}

/**
 * `mover`: la presentación abierta pasa a la hora pendiente que eligió, con la
 * misma persona (si la hora es con otra, 409: se ofrece otra o se pasa al equipo).
 */
export async function kairosMove(
  tx: Db,
  chatId: string,
  proposalId: string,
  now = new Date(),
): Promise<KairosBooked> {
  const pending = await pendingKairosProposal(tx, chatId, now)
  if (!pending || pending.id !== proposalId)
    throw new ServiceError("PROPOSAL_CLOSED", 409, "Esa hora ya no está propuesta")
  const [chat] = await tx
    .select({ clientId: saasChat.clientId })
    .from(saasChat)
    .where(eq(saasChat.id, chatId))
    .limit(1)
  const task = await openPresentation(tx, chatId, chat?.clientId ?? null)
  if (!task) throw new ServiceError("NO_PRESENTATION", 409, "No tiene una presentación agendada")
  if (task.assigneeUserId !== pending.assigneeUserId)
    throw new ServiceError(
      "OTHER_PRESENTER",
      409,
      "Esa hora es con otra persona del equipo: ofrece una de quien presenta o pásalo al equipo",
    )
  await movePresentation(tx, null, task.id, pending.startsAt, now)
  await tx
    .update(kairosProposal)
    .set({ status: "confirmada", taskId: task.id, updatedAt: now })
    .where(eq(kairosProposal.id, pending.id))
  const presenter = await staffName(tx, task.assigneeUserId)
  return {
    taskId: task.id,
    startsAt: pending.startsAt,
    assigneeName: presenter.name,
    meetingUrl: presenter.meetingUrl,
    confirmation: bookedWords("movida", pending.startsAt, presenter.name, presenter.meetingUrl),
  }
}

/** `cancelar`: la persona pidió cancelar su presentación; quien presenta lo ve en Hoy. */
export async function kairosCancel(
  tx: Db,
  chatId: string,
  reason: string | null,
  now = new Date(),
): Promise<{ taskId: string; startsAt: Date }> {
  const [chat] = await tx
    .select({ clientId: saasChat.clientId })
    .from(saasChat)
    .where(eq(saasChat.id, chatId))
    .limit(1)
  const task = await openPresentation(tx, chatId, chat?.clientId ?? null)
  if (!task?.dueAt)
    throw new ServiceError("NO_PRESENTATION", 409, "No tiene una presentación agendada")
  await cancelPresentation(
    tx,
    null,
    task.id,
    { reason: `La clínica la canceló por el chat${reason ? `: ${reason}` : ""}` },
    now,
  )
  return { taskId: task.id, startsAt: task.dueAt }
}

/**
 * `pedir_contacto`: guarda el WhatsApp (E.164) o el correo que dejó en la
 * persona de la conversación (si no tiene uno; nunca pisa el que ya tiene).
 * Sin clínica todavía, 409: primero el nombre de la clínica.
 */
export async function kairosSaveContact(
  tx: Db,
  chatId: string,
  input: { phone?: string | null; email?: string | null },
  now = new Date(),
): Promise<{ phone: string | null; email: string | null }> {
  const [chat] = await tx
    .select()
    .from(saasChat)
    .where(eq(saasChat.id, chatId))
    .for("update")
    .limit(1)
  if (!chat) throw notFound("Conversación")
  if (!chat.clientId)
    throw new ServiceError("CLIENT_REQUIRED", 409, "Falta el nombre de la clínica")
  const phone = input.phone?.replace(/[\s()-]/g, "") || null
  const email = input.email?.trim().toLowerCase() || null
  if (phone && !E164.test(phone))
    throw invalidField("whatsapp", "El celular va con el código del país, como +51987654321")
  if (email && !EMAIL.test(email)) throw invalidField("correo", "Ese correo no es válido")
  let contactId = chat.contactId
  if (!contactId) {
    const [created] = await tx
      .insert(saasClientContact)
      .values({
        clientId: chat.clientId,
        name: chat.displayName?.trim().slice(0, 160) || "Contacto (nombre por preguntar)",
        rolesConfirmed: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: saasClientContact.id })
    contactId = created?.id ?? null
    if (contactId)
      await tx.update(saasChat).set({ contactId, updatedAt: now }).where(eq(saasChat.id, chat.id))
  }
  if (!contactId) throw new ServiceError("INTERNAL", 500, "No se pudo guardar el contacto")
  const [contact] = await tx
    .select()
    .from(saasClientContact)
    .where(eq(saasClientContact.id, contactId))
    .for("update")
    .limit(1)
  if (!contact) throw notFound("Contacto")
  const set: { phone?: string; email?: string; updatedAt: Date } = { updatedAt: now }
  if (phone && !contact.phone) set.phone = phone
  if (email && !contact.email) set.email = email
  if (set.phone || set.email) {
    await tx.update(saasClientContact).set(set).where(eq(saasClientContact.id, contact.id))
    await writeAdminAudit(tx, null, {
      action: "kairos.contact_saved",
      entityId: chat.clientId,
      metadata: {
        chatId,
        contactId: contact.id,
        phone: Boolean(set.phone),
        email: Boolean(set.email),
      },
    })
  }
  return { phone: set.phone ?? contact.phone, email: set.email ?? contact.email }
}

/**
 * `datos_de_la_clinica`: con el nombre de la clínica, Kairós crea su cliente
 * (y su persona) y le liga la conversación, como lo haría una persona, a su
 * nombre. Si la conversación ya es de un cliente, no cambia nada. Si el nombre
 * (o el correo o el celular) se parece a otro cliente, no los une ni la liga a
 * ese: crea la nueva y deja «¿Es la misma que…?» en Hoy para una persona.
 */
export async function kairosClinicData(
  tx: Db,
  chatId: string,
  input: {
    clinicName: string
    personName?: string | null
    product?: string | null
    city?: string | null
  },
  now = new Date(),
): Promise<{ clientId: string; created: boolean; similar: string[] }> {
  const [chat] = await tx
    .select()
    .from(saasChat)
    .where(eq(saasChat.id, chatId))
    .for("update")
    .limit(1)
  if (!chat) throw notFound("Conversación")
  if (chat.clientId) return { clientId: chat.clientId, created: false, similar: [] }
  if (chat.notClinicAt)
    throw new ServiceError("NOT_CLINIC", 409, "Esta conversación está marcada «No es una clínica»")
  const name = input.clinicName.replace(/\s+/g, " ").trim().slice(0, 160)
  if (name.length < 2) throw invalidField("clinica", "Escribe el nombre de la clínica")
  const product =
    (["dental", "medical", "optical"] as const).find((p) => p === input.product) ?? "dental"
  const [client] = await tx
    .insert(saasClient)
    .values({
      name,
      product,
      city: input.city?.trim().slice(0, 120) || null,
      origin: chat.channel === "whatsapp" ? "whatsapp" : "redes",
      originDetail: `Escribió por ${chat.channel === "whatsapp" ? "WhatsApp" : chat.channel === "instagram" ? "Instagram" : "Messenger"} y Kairós la registró`,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!client) throw new ServiceError("INTERNAL", 500, "No se pudo crear el cliente")
  const personName =
    input.personName?.replace(/\s+/g, " ").trim().slice(0, 160) ||
    chat.displayName?.trim().slice(0, 160) ||
    "Contacto (nombre por preguntar)"
  const [contact] = await tx
    .insert(saasClientContact)
    .values({
      clientId: client.id,
      name: personName,
      rolesConfirmed: false,
      isPrimary: true,
      phone: chat.channel === "whatsapp" && E164.test(chat.address) ? chat.address : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: saasClientContact.id })
  await writeAdminAudit(tx, null, {
    action: "kairos.chat_client_created",
    entityId: client.id,
    metadata: { clientId: client.id, chatId, channel: chat.channel },
  })
  await kairosAssignChat(tx, chat.id, { clientId: client.id, contactId: contact?.id ?? null }, now)
  const hints = await findClientDuplicates(
    tx,
    {
      name,
      product,
      phone: chat.channel === "whatsapp" ? chat.address : null,
    },
    client.id,
  )
  const similar: string[] = []
  for (const hint of hints) {
    if (!hint.clientId) continue
    similar.push(hint.name)
    await raiseKairosDuplicate(
      tx,
      { keepId: hint.clientId, keepName: hint.name, dropId: client.id, why: hint.words },
      now,
    )
  }
  return { clientId: client.id, created: true, similar }
}

/* ---------- Los avisos de la presentación ---------- */

export type KairosNoticeKind = "recordatorio" | "otra_hora" | "cambio"

/** Un aviso por enviar: por dónde, qué dice y su clave (una vez). */
export interface KairosNotice {
  kind: KairosNoticeKind
  /** La clave en la auditoría (`kairos.presentation_notice`): con ella sale una sola vez. */
  key: string
  taskId: string
  clientId: string
  route:
    | {
        by: "chat"
        chatId: string
        template: "retomar_conversacion" | "recordatorio_presentacion" | null
        params: string[]
      }
    | { by: "correo"; to: string; contactId: string | null; subject: string }
  text: string
}

/** El día de Lima anterior a `at`, a las 09:00 (cuando sale el recordatorio). */
function dayBeforeNine(at: Date): Date {
  const day = limaDate(at)
  const before = new Date(new Date(`${day}T00:00:00-05:00`).getTime() - DAY)
  return new Date(`${limaDate(before)}T09:00:00-05:00`)
}

const firstWord = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || ""

type NoticeTask = {
  id: string
  client_id: string
  client_name: string
  product: string
  due_at: string
  created_at: string
  assignee_user_id: string | null
  channel_chat_id: string | null
  needs_new_time_at: string | null
  contact_id: string | null
}

/**
 * Por dónde se le avisa a la clínica: su conversación de WhatsApp (texto si
 * está en las 24 h, si no la plantilla); si la conversación es de Instagram o
 * Messenger, un WhatsApp de su persona que ya sea de esta clínica dentro de sus
 * 24 h, o su correo. Nunca abre una conversación con un celular que no es de
 * esta clínica. Null si no hay por dónde.
 */
async function noticeRoute(
  tx: Db,
  task: NoticeTask,
  now: Date,
  template: "retomar_conversacion" | "recordatorio_presentacion",
  params: string[],
  subject: string,
): Promise<KairosNotice["route"] | null> {
  const [chat] = task.channel_chat_id
    ? await tx.select().from(saasChat).where(eq(saasChat.id, task.channel_chat_id)).limit(1)
    : []
  const contactId = chat?.contactId ?? task.contact_id
  const [contact] = contactId
    ? await tx.select().from(saasClientContact).where(eq(saasClientContact.id, contactId)).limit(1)
    : []
  const free = (at: Date | null) => chatFreeWindow(at, now).canReplyFreely
  if (chat && chat.clientId === task.client_id) {
    if (free(chat.lastInboundAt)) return { by: "chat", chatId: chat.id, template: null, params: [] }
    if (chat.channel === "whatsapp") return { by: "chat", chatId: chat.id, template, params }
  }
  if (contact?.phone) {
    const [wa] = await tx
      .select()
      .from(saasChat)
      .where(and(eq(saasChat.channel, "whatsapp"), eq(saasChat.address, contact.phone)))
      .limit(1)
    if (wa && wa.clientId === task.client_id)
      return free(wa.lastInboundAt)
        ? { by: "chat", chatId: wa.id, template: null, params: [] }
        : { by: "chat", chatId: wa.id, template, params }
  }
  if (contact?.email) return { by: "correo", to: contact.email, contactId: contact.id, subject }
  return null
}

async function noticeSent(tx: Db, key: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: adminAudit.id })
    .from(adminAudit)
    .where(and(eq(adminAudit.action, "kairos.presentation_notice"), eq(adminAudit.entityId, key)))
    .limit(1)
  return Boolean(row)
}

/**
 * Lo que hay que avisarle a las clínicas que agendaron por un chat:
 * - `recordatorio`: desde las 09:00 de Lima del día anterior y hasta 2 h antes,
 *   una vez por presentación (no si se agendó después de esa hora: la
 *   confirmación es de hace poco).
 * - `otra_hora`: «Pedir otra hora» (`needs_new_time_at`), una vez por pedido.
 * - `cambio`: una persona la movió o la pasó a otra persona, una vez por cambio.
 */
export async function kairosPresentationNotices(tx: Db, now = new Date()): Promise<KairosNotice[]> {
  const at = sql`${now.toISOString()}::timestamptz`
  const tasks = [
    ...(await tx.execute<NoticeTask>(sql`select t.id, t.client_id, c.name as client_name, c.product,
      to_char(t.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as due_at,
      to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
      t.assignee_user_id, t.channel_chat_id, t.contact_id,
      to_char(t.needs_new_time_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as needs_new_time_at
    from admin.saas_task t join admin.saas_client c on c.id = t.client_id
    where t.kind = 'presentacion' and t.status = 'abierta' and t.due_at is not null
      and t.channel_chat_id is not null and c.organization_id is null and c.archived_at is null
      and t.due_at > ${at} and t.due_at < ${at} + interval '15 days'
    order by t.due_at asc`)),
  ]
  const out: KairosNotice[] = []
  for (const task of tasks) {
    const dueAt = new Date(task.due_at)
    const presenter = await staffName(tx, task.assignee_user_id)
    const [contact] = task.contact_id
      ? await tx
          .select({ name: saasClientContact.name })
          .from(saasClientContact)
          .where(eq(saasClientContact.id, task.contact_id))
          .limit(1)
      : []
    const hello = firstWord(contact?.name) ? `Hola, ${firstWord(contact?.name)}.` : "Hola."
    const when = presentationWhenWords(dueAt)
    const room = presenter.meetingUrl ?? `la sala que te comparte ${presenter.name}`
    const params = [firstWord(contact?.name) || task.client_name, `${when} (hora de Lima)`, room]
    const add = async (
      kind: KairosNoticeKind,
      key: string,
      text: string,
      template: "retomar_conversacion" | "recordatorio_presentacion",
      subject: string,
      templateParams: string[],
    ) => {
      if (await noticeSent(tx, key)) return
      const route = await noticeRoute(tx, task, now, template, templateParams, subject)
      if (route) out.push({ kind, key, taskId: task.id, clientId: task.client_id, route, text })
    }
    if (task.needs_new_time_at) {
      await add(
        "otra_hora",
        `otra_hora:${task.id}:${task.needs_new_time_at}`,
        `${hello} Te escribo por tu presentación del ${when}: quien te iba a presentar no va a poder a esa hora. ¿Qué otro día y hora te acomodan? Te busco una nueva.`,
        "retomar_conversacion",
        "Tu presentación necesita otra hora",
        ["Kairós"],
      )
      continue
    }
    const change = await tx.execute<{
      id: string
      action: string
    }>(sql`select a.id, a.action from admin.admin_audit a
      where a.action in ('arm.presentation_moved', 'arm.presentation_reassigned')
        and a.actor_user_id is not null and a.metadata ->> 'taskId' = ${task.id}
        and a.created_at > ${task.created_at}::timestamptz
      order by a.created_at desc limit 1`)
    const last = [...change][0]
    if (last)
      await add(
        "cambio",
        `cambio:${task.id}:${last.id}`,
        `${hello} Cambió tu presentación: ahora es el ${when} (hora de Lima) con ${presenter.name}. ${presenter.meetingUrl ? `Entra a la hora aquí ${presenter.meetingUrl}` : `${presenter.name} te comparte el enlace antes de empezar.`}`,
        "recordatorio_presentacion",
        "Cambió tu presentación",
        params,
      )
    const remindFrom = dayBeforeNine(dueAt)
    if (
      now >= remindFrom &&
      dueAt.getTime() - now.getTime() > 2 * HOUR &&
      new Date(task.created_at) < remindFrom
    )
      await add(
        "recordatorio",
        `recordatorio:${task.id}:${task.due_at}`,
        `${hello} Te recuerdo tu presentación de mañana: el ${when} (hora de Lima) con ${presenter.name}. ${presenter.meetingUrl ? `Entra a la hora aquí ${presenter.meetingUrl}` : `${presenter.name} te comparte el enlace antes de empezar.`}`,
        "recordatorio_presentacion",
        "Tu presentación es mañana",
        params,
      )
  }
  return out
}

/** Lo reservado de un aviso: por un chat (`sendChatOutreach`) o por correo (`outreachEmail`). */
export type KairosNoticeReserved =
  | { by: "chat"; reply: ChatReply; channel: "whatsapp" | "instagram" | "messenger" }
  | { by: "correo"; outreach: OutreachRow }

/**
 * Reserva un aviso una sola vez: con el candado de la presentación vuelve a
 * mirar su clave, la escribe y reserva el envío en la misma transacción. Null
 * si ya salió (otra réplica del worker).
 */
export async function reserveKairosNotice(
  tx: Db,
  notice: KairosNotice,
  now = new Date(),
): Promise<KairosNoticeReserved | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`kairos-aviso:${notice.taskId}`}))`)
  if (await noticeSent(tx, notice.key)) return null
  await writeAdminAudit(tx, null, {
    action: "kairos.presentation_notice",
    entityId: notice.key,
    metadata: {
      taskId: notice.taskId,
      clientId: notice.clientId,
      kind: notice.kind,
      by: notice.route.by,
    },
  })
  if (notice.route.by === "correo") {
    const outreach = await prepareKairosMail(
      tx,
      {
        clientId: notice.clientId,
        contactId: notice.route.contactId,
        to: notice.route.to,
        subject: notice.route.subject,
        body: notice.text,
      },
      now,
    )
    return { by: "correo", outreach }
  }
  const reply = await prepareKairosChatReply(
    tx,
    notice.route.chatId,
    notice.route.template
      ? {
          body: `Plantilla «${notice.route.template}»: ${notice.route.params.join(" · ")}`,
          template: notice.route.template,
          templateParams: notice.route.params,
          closeItems: false,
        }
      : { body: notice.text, closeItems: false },
    now,
  )
  const [chat] = await tx
    .select({ channel: saasChat.channel })
    .from(saasChat)
    .where(eq(saasChat.id, reply.chatId))
    .limit(1)
  return {
    by: "chat",
    reply,
    channel: (chat?.channel ?? "whatsapp") as "whatsapp" | "instagram" | "messenger",
  }
}
