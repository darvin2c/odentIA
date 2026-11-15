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
import { BASE_PRODUCT, type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  type AriadnaChatReplyKind,
  type ChatTurnAgent,
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
import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm"
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
import { clinicOriginOf } from "./public-links.js"

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

/**
 * Topes por día de Lima, contra el gasto y el abuso: lo que pasa de ahí lo ve el equipo («tope»
 * en Hoy). Turnos de una conversación; turnos y avisos de todas (un aviso por correo a una
 * dirección que dieron en un chat cuenta aquí, porque nadie la verificó); presentaciones que agenda
 * Kairós en todas (cada conversación o cliente tiene como mucho una abierta).
 */
export const KAIROS_TURNS_PER_CHAT_DAY = 30
export const KAIROS_TURNS_PER_DAY = 500
export const KAIROS_BOOKINGS_PER_DAY = 10
/** El código de un tope: el agente lo pasa al equipo en vez de insistir. */
export const KAIROS_CAP_CODE = "KAIROS_TOPE"

/** El comienzo del día de Lima de `now` (Perú: UTC−5 todo el año). */
function limaDayStart(now: Date): Date {
  return new Date(`${limaDate(now)}T00:00:00-05:00`)
}

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

/* ---------- El interruptor de Ariadna (ADR 0191) ---------- */

export async function getAriadnaChats(tx: Db): Promise<KairosSellsSetting> {
  const [row] = await tx
    .select({ setting: kairosSetting, name: user.name })
    .from(kairosSetting)
    .leftJoin(user, eq(user.id, kairosSetting.ariadnaUpdatedBy))
    .where(eq(kairosSetting.id, true))
    .limit(1)
  if (!row) return { enabled: false, updatedAt: null, updatedBy: null }
  return {
    enabled: row.setting.ariadnaEnabled,
    updatedAt: row.setting.ariadnaUpdatedAt,
    updatedBy: row.setting.ariadnaUpdatedBy
      ? { userId: row.setting.ariadnaUpdatedBy, name: row.name ?? "" }
      : null,
  }
}

/** Prende o apaga «Ariadna responde en los chats de las clínicas con su app». Solo Administración. */
export async function setAriadnaChats(
  tx: Db,
  actor: AdminActor,
  enabled: boolean,
  now = new Date(),
): Promise<KairosSellsSetting> {
  if (actor.role !== "admin")
    throw new ServiceError(
      "FORBIDDEN",
      403,
      "Solo el rol Administración prende o apaga a Ariadna en los chats",
    )
  if (typeof enabled !== "boolean") throw invalidField("enabled", "Di si la prendes o la apagas")
  await tx
    .insert(kairosSetting)
    .values({
      id: true,
      ariadnaEnabled: enabled,
      ariadnaUpdatedBy: actor.userId,
      ariadnaUpdatedAt: now,
    })
    .onConflictDoUpdate({
      target: kairosSetting.id,
      set: { ariadnaEnabled: enabled, ariadnaUpdatedBy: actor.userId, ariadnaUpdatedAt: now },
    })
  await writeAdminAudit(tx, actor, {
    action: enabled ? "ariadna.chats_enabled" : "ariadna.chats_disabled",
    entityId: "kairos_setting",
  })
  return getAriadnaChats(tx)
}

const ariadnaEnabledSql = sql`coalesce((select s.ariadna_enabled from admin.kairos_setting s where s.id), false)`

/**
 * Quién atiende la conversación `c` de cliente `cl`, en SQL: Kairós a quien no tiene su app (sin
 * cliente o un cliente sin cuenta, no archivado), Ariadna a la clínica que ya la tiene. Lo decide la
 * persona que ligó la conversación a su cliente, nunca el teléfono.
 */
const agentHandlesSql = sql`((${sellsEnabledSql} and (cl.id is null or (cl.organization_id is null and cl.archived_at is null)))
    or (${ariadnaEnabledSql} and cl.organization_id is not null and cl.archived_at is null))`
const agentOfSql = sql`case when cl.organization_id is not null then 'ariadna' else 'kairos' end`

/** Cómo se llama quien atiende, en los textos de Hoy y de los topes. */
export const CHAT_AGENT_NAMES: Record<ChatTurnAgent, string> = {
  kairos: "Kairós",
  ariadna: "Ariadna",
}

/**
 * Ariadna atiende esta conversación: prendida, sin pausa, no «No es una clínica»
 * y de una clínica que ya tiene su app.
 */
export async function ariadnaHandlesChat(
  tx: Db,
  chat: { kairosPausedAt: Date | null; notClinicAt: Date | null },
  client: { organizationId: string | null; archivedAt?: Date | null } | null,
): Promise<boolean> {
  if (chat.kairosPausedAt || chat.notClinicAt || !client?.organizationId || client.archivedAt)
    return false
  return (await getAriadnaChats(tx)).enabled
}

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
  return sql`(${agentHandlesSql} and c.kairos_paused_at is null and c.not_clinic_at is null
    and m.received_at > ${at} - interval '24 hours'
    and not exists (select 1 from admin.kairos_chat_turn t where t.message_id = m.id
      and (t.outcome = 'omitido' or (t.outcome = 'en_curso'
        and t.created_at < ${at} - make_interval(secs => ${KAIROS_TURN_STALE_MS / 1000})))))`
}

/* ---------- Qué responder ---------- */

export interface KairosChatToAnswer {
  chatId: string
  messageId: string
  /** Quién responde: Kairós (sin app) o Ariadna (clínica con su app). Sin él, Kairós. */
  agent?: ChatTurnAgent
}

/**
 * Las condiciones de una conversación que Kairós responde ahora, sobre `c`, `cl` y su último mensaje `m`.
 * Ya respondida es con una respuesta nuestra creada después de guardar el mensaje
 * (`m.created_at`), no después de la hora que dice Meta (`received_at`: segundos
 * enteros y su reloj): un «Sí» escrito en el mismo segundo en que salió la
 * respuesta anterior quedaba como ya respondido y sin turno. Un aviso de Kairós
 * (`purpose = 'aviso'`: recordatorio, otra hora, cambio) no responde nada.
 */
function answerableSql(now: Date) {
  const at = sql`${now.toISOString()}::timestamptz`
  return sql`${agentHandlesSql}
    and c.kairos_paused_at is null and c.not_clinic_at is null
    and m.received_at > ${at} - interval '24 hours'
    and m.received_at <= ${at} - make_interval(secs => ${KAIROS_SELL_QUIET_MS / 1000})
    and not exists (select 1 from admin.saas_outreach o where o.chat_id = c.id and o.purpose = 'respuesta'
      and o.status in ('pendiente', 'enviado', 'incierto') and o.created_at >= m.created_at)
    and not exists (select 1 from admin.kairos_chat_turn t where t.message_id = m.id)
    and not exists (select 1 from admin.kairos_chat_turn t where t.chat_id = c.id
      and t.outcome = 'en_curso' and t.created_at > ${at} - make_interval(secs => ${KAIROS_TURN_STALE_MS / 1000}))`
}

const lastMessageJoin = sql`join lateral (select id, received_at, created_at from admin.saas_inbound_message
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
    agent: ChatTurnAgent
  }>(sql`select c.id as chat_id, m.id as message_id, ${agentOfSql} as agent
    from admin.saas_chat c ${lastMessageJoin}
    where ${answerableSql(now)}
    order by m.received_at asc, c.id asc
    limit ${limit}`)
  return [...rows].map((row) => ({
    chatId: row.chat_id,
    messageId: row.message_id,
    agent: row.agent,
  }))
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
  const [still] = await tx.execute<{
    message_id: string
    agent: ChatTurnAgent
  }>(sql`select m.id as message_id,
      ${agentOfSql} as agent
    from admin.saas_chat c ${lastMessageJoin}
    where c.id = ${target.chatId}::uuid and ${answerableSql(now)}`)
  if (!still || still.message_id !== target.messageId) return null
  // La conversación cambió de quién la atiende (le dieron su app) desde que se eligió: no toca.
  if (still.agent !== (target.agent ?? "kairos")) return null
  const [row] = await tx
    .insert(kairosChatTurn)
    .values({
      chatId: target.chatId,
      messageId: target.messageId,
      agent: still.agent,
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
    /** Solo Ariadna: lo que respondió o a quién lo pasó. */
    ariadnaReply?: AriadnaChatReplyKind | null
  },
  now = new Date(),
): Promise<void> {
  const [turn] = await tx
    .update(kairosChatTurn)
    .set({
      outcome: result.outcome,
      why: result.why ? result.why.slice(0, 500) : null,
      outreachId: result.outreachId ?? null,
      ...(result.ariadnaReply ? { ariadnaReply: result.ariadnaReply } : {}),
      updatedAt: now,
    })
    .where(eq(kairosChatTurn.id, turnId))
    .returning({
      chatId: kairosChatTurn.chatId,
      messageId: kairosChatTurn.messageId,
      agent: kairosChatTurn.agent,
    })
  if (!turn) throw notFound("Turno de Kairós")
  // Lo que Ariadna pasa a Administración (cobros, su plan) es solo de Administración desde ese
  // mensaje: Soporte no lo ve en la conversación ni en Hoy, y lo que se responda nace igual.
  if (result.ariadnaReply === "administracion")
    await raiseAnsweredAdminOnly(tx, turn.chatId, result.outreachId ?? null)
  if (result.outcome === "paso" || result.outcome === "fallo") {
    const [chat] = await tx
      .update(saasChat)
      .set({ kairosPausedAt: now, kairosPausedBy: null, updatedAt: now })
      .where(and(eq(saasChat.id, turn.chatId), sql`${saasChat.kairosPausedAt} is null`))
      .returning({ clientId: saasChat.clientId })
    await writeAdminAudit(tx, null, {
      action: result.outcome === "paso" ? "kairos.chat_handed_over" : "kairos.chat_failed",
      entityId: chat?.clientId ?? turn.chatId,
      metadata: {
        chatId: turn.chatId,
        clientId: chat?.clientId ?? null,
        why: result.why ?? null,
        agent: turn.agent,
        ...(result.ariadnaReply ? { to: result.ariadnaReply } : {}),
      },
    })
  }
}

/**
 * Ariadna pasó a Administración: sube a «solo Administración» todo lo que escribió la persona desde
 * nuestra última respuesta (lo mismo que leyó `ariadnaChatContext`: sus mensajes seguidos, y lo que
 * llegó mientras respondía) y su actividad «Nos escribió por …». `ownReply` es la respuesta de este
 * mismo turno, que no cuenta como la anterior. Solo sube, de no a sí (la base no deja bajarlo).
 */
async function raiseAnsweredAdminOnly(
  tx: Db,
  chatId: string,
  ownReply: string | null,
): Promise<void> {
  const [since] = await tx.execute<{ at: string | null }>(sql`select max(o.created_at)::text as at
    from admin.saas_outreach o
    where o.chat_id = ${chatId}::uuid and o.purpose = 'respuesta' and o.status <> 'no_salio'
      and (${ownReply}::uuid is null or o.id <> ${ownReply}::uuid)`)
  const from = since?.at ? sql`${since.at}::timestamptz` : sql`'-infinity'::timestamptz`
  await tx.execute(sql`update admin.saas_inbound_message set admin_only = true
    where chat_id = ${chatId}::uuid and created_at >= ${from} and not admin_only`)
  // La actividad de cada mensaje lleva su conversación y la hora que dijo Meta (`happened_at`).
  await tx.execute(sql`update admin.saas_follow_up f set admin_only = true
    from admin.saas_inbound_message m
    where m.chat_id = ${chatId}::uuid and m.created_at >= ${from}
      and f.chat_id = m.chat_id and f.direction = 'entro' and f.happened_at = m.received_at
      and not f.admin_only`)
}

/**
 * Por qué Kairós ya no puede actuar en esta conversación, o null: se apagó, se pausó (o la pasó
 * al equipo), es «No es una clínica», su cliente ya tiene su app o está archivado, o pasaron las
 * 24 h de Meta. Se mira con la conversación bloqueada antes de cada herramienta que escribe y al
 * reservar la respuesta: lo que cambió mientras el modelo pensaba gana.
 */
export async function kairosChatBlocked(
  tx: Db,
  chatId: string,
  now = new Date(),
  /** Quién atiende el turno: Ariadna solo responde a la clínica con su app; Kairós, a quien no la tiene. */
  agent: ChatTurnAgent = "kairos",
  /**
   * De quién era la conversación cuando se leyó para responder (el cliente y su clínica): si una
   * persona la movió a otro mientras tanto, lo pensado era para otro y no se escribe.
   */
  expected?: { clientId: string; organizationId: string | null },
): Promise<string | null> {
  if (!UUID.test(chatId)) return "La conversación no existe"
  const [chat] = await tx
    .select()
    .from(saasChat)
    .where(eq(saasChat.id, chatId))
    .for("update")
    .limit(1)
  if (!chat) return "La conversación no existe"
  const ariadna = agent === "ariadna"
  if (ariadna ? !(await getAriadnaChats(tx)).enabled : !(await getKairosSells(tx)).enabled)
    return ariadna ? "Ariadna se apagó" : "Kairós se apagó"
  if (chat.kairosPausedAt) return "La conversación se pausó"
  if (chat.notClinicAt) return "La conversación es «No es una clínica»"
  const [client] = chat.clientId
    ? await tx
        .select({ organizationId: saasClient.organizationId, archivedAt: saasClient.archivedAt })
        .from(saasClient)
        .where(eq(saasClient.id, chat.clientId))
        .limit(1)
    : []
  if (expected && chat.clientId !== expected.clientId) return "La conversación pasó a otro cliente"
  if (expected && (client?.organizationId ?? null) !== expected.organizationId)
    return "La conversación es de otra clínica"
  if (!ariadna && client?.organizationId) return "La clínica ya tiene su app"
  if (client?.archivedAt) return "El cliente está archivado"
  if (ariadna && !client?.organizationId)
    return "La conversación ya no es de una clínica con su app"
  if (!chatFreeWindow(chat.lastInboundAt, now).canReplyFreely) return "Pasaron las 24 horas de Meta"
  return null
}

/**
 * Si este turno pasa un tope del día de Lima: 30 de esta conversación, o 500 de todas contando los
 * avisos de las presentaciones. Devuelve el motivo (con «tope», para Hoy) o null. No cuenta el
 * turno que se está mirando.
 */
export async function kairosTurnCap(
  tx: Db,
  chatId: string,
  turnId: string,
  now = new Date(),
  agent: ChatTurnAgent = "kairos",
): Promise<string | null> {
  const name = CHAT_AGENT_NAMES[agent]
  const [counts] = await tx.execute<{ chat: number; all: number }>(sql`select
      (select count(*)::int from admin.kairos_chat_turn t where t.chat_id = ${chatId}::uuid
        and t.id <> ${turnId}::uuid and ${limaDaySql(sql`t.created_at`, now)}) as chat,
      (select count(*)::int from admin.kairos_chat_turn t where t.id <> ${turnId}::uuid
        and ${limaDaySql(sql`t.created_at`, now)})
      + (select count(*)::int from admin.saas_outreach o where o.by_kairos and o.purpose = 'aviso'
        and ${limaDaySql(sql`o.created_at`, now)}) as all`)
  if ((counts?.chat ?? 0) >= KAIROS_TURNS_PER_CHAT_DAY)
    return `Llegó al tope de ${KAIROS_TURNS_PER_CHAT_DAY} respuestas de ${name} de hoy en esta conversación`
  // El tope de todas es uno solo, entre Kairós y Ariadna: los dos responden con la misma cuenta.
  if ((counts?.all ?? 0) >= KAIROS_TURNS_PER_DAY)
    return `${name} llegó a su tope de ${KAIROS_TURNS_PER_DAY} respuestas y avisos de hoy`
  return null
}

/** `column` cae en el día de Lima de `now` (las filas guardan `now` de quien las escribió). */
function limaDaySql(column: SQL, now: Date) {
  const start = limaDayStart(now)
  return sql`${column} >= ${start.toISOString()}::timestamptz
    and ${column} < ${new Date(start.getTime() + DAY).toISOString()}::timestamptz`
}

/** Cuántos turnos y avisos lleva Kairós hoy: los avisos paran en el mismo tope de todas. */
async function kairosDayCount(tx: Db, now: Date): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`select
      (select count(*)::int from admin.kairos_chat_turn t where ${limaDaySql(sql`t.created_at`, now)})
      + (select count(*)::int from admin.saas_outreach o where o.by_kairos and o.purpose = 'aviso'
        and ${limaDaySql(sql`o.created_at`, now)}) as n`)
  return row?.n ?? 0
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

/* ---------- Lo que lee Ariadna (ADR 0191) ---------- */

export interface AriadnaChatContext {
  chat: { id: string; channel: "whatsapp" | "instagram" | "messenger" }
  client: { id: string; name: string; product: ClinicalProduct; organizationId: string }
  /** Lo que escribió la persona desde nuestra última respuesta, en orden (sin firmas ni archivos). */
  question: string
  /** Cuántos archivos mandó en esos mensajes (no los puede ver). */
  files: number
  /** Lo que preguntó antes de nuestra última respuesta, para entender «¿y cómo la creo?». */
  previous: { question: string; where: null } | null
  /** Su última respuesta fue «¿quieres que te pase con Soporte?». */
  offered: boolean
  /** Ariadna todavía no escribió en esta conversación. */
  firstReply: boolean
  /** El origen de la app de la clínica, para el enlace a la pantalla; nulo sin dirección configurada. */
  appOrigin: string | null
}

/**
 * Lo que Ariadna necesita para responder: de quién es la conversación (el producto, para su guía, y
 * el subdominio, para el enlace) y lo que escribió la persona. Nada de la clínica: ni quién escribe,
 * ni su rol, ni sus datos.
 */
export async function ariadnaChatContext(tx: Db, chatId: string): Promise<AriadnaChatContext> {
  if (!UUID.test(chatId)) throw notFound("Conversación")
  const [chat] = await tx.select().from(saasChat).where(eq(saasChat.id, chatId)).limit(1)
  if (!chat?.clientId) throw notFound("Conversación")
  const [client] = await tx
    .select()
    .from(saasClient)
    .where(eq(saasClient.id, chat.clientId))
    .limit(1)
  if (!client?.organizationId)
    throw new ServiceError(
      "CHAT_NOT_CLINIC_APP",
      409,
      "La conversación no es de una clínica con su app",
    )
  const replies = await tx
    .select()
    .from(saasOutreach)
    .where(and(eq(saasOutreach.chatId, chat.id), eq(saasOutreach.purpose, "respuesta")))
    .orderBy(desc(saasOutreach.createdAt), desc(saasOutreach.id))
    .limit(KAIROS_HISTORY_MAX)
  const lastReply = replies.find((reply) => reply.status !== "no_salio") ?? null
  const messages = await tx
    .select()
    .from(saasInboundMessage)
    .where(eq(saasInboundMessage.chatId, chat.id))
    .orderBy(desc(saasInboundMessage.createdAt), desc(saasInboundMessage.id))
    .limit(KAIROS_HISTORY_MAX)
  const after = (
    lastReply
      ? messages.filter((m) => m.createdAt.getTime() >= lastReply.createdAt.getTime())
      : messages
  ).reverse()
  const before = lastReply
    ? messages.find((m) => m.createdAt.getTime() < lastReply.createdAt.getTime())
    : undefined
  const [lastTurn] = await tx
    .select({ reply: kairosChatTurn.ariadnaReply, outreachId: kairosChatTurn.outreachId })
    .from(kairosChatTurn)
    .where(
      and(
        eq(kairosChatTurn.chatId, chat.id),
        eq(kairosChatTurn.agent, "ariadna"),
        eq(kairosChatTurn.outcome, "respondio"),
      ),
    )
    .orderBy(desc(kairosChatTurn.updatedAt))
    .limit(1)
  const product: ClinicalProduct = isClinicalProduct(client.product) ? client.product : BASE_PRODUCT
  return {
    chat: { id: chat.id, channel: chat.channel as AriadnaChatContext["chat"]["channel"] },
    client: { id: client.id, name: client.name, product, organizationId: client.organizationId },
    question: after
      .map((m) => (m.body ?? "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 500),
    files: after.reduce((sum, m) => sum + m.media.length, 0),
    previous: before?.body?.trim()
      ? { question: before.body.trim().slice(0, 500), where: null }
      : null,
    // La oferta vale si fue lo último que dijo Ariadna aquí.
    offered: Boolean(
      lastReply && lastTurn?.reply === "oferta" && lastTurn.outreachId === lastReply.id,
    ),
    firstReply: !replies.some((reply) => reply.byAriadna),
    appOrigin: await clinicOriginOf(tx, client.organizationId),
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
 * (si no, de quien esté libre; con una presentación abierta, solo de quien la
 * presenta), repartidas: la primera, y después las que caen
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
  // Con una presentación abierta, lo que se ofrece es para moverla: solo con quien la presenta
  // (`kairosMove` no la pasa a otra persona).
  const open = await openPresentation(tx, chatId, chat.clientId)
  const all: StaffSlot[] = await staffSlots(tx, {
    onlyUserId: open?.assigneeUserId ?? null,
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
 * La hora ya no se puede dar (otro se la ganó, venció o ya no tiene las 2 h de
 * aviso): la propuesta quedó vencida. Se devuelve en vez de lanzar para que
 * quien llama confirme la transacción y lo vencido quede guardado.
 */
export interface KairosBookRefused {
  refused: { code: string; message: string }
}

/**
 * `agendar`: confirma la hora pendiente que la persona eligió (`confirmProposal`,
 * con el candado de quien presenta). Antes, la clínica y (Instagram o
 * Messenger) un WhatsApp o un correo para avisarle. Si ya tiene una abierta, no
 * agenda otra (`PRESENTATION_EXISTS`: el agente lo pasa al equipo; mover es
 * `mover`). Como mucho `KAIROS_BOOKINGS_PER_DAY` al día entre todas.
 */
export async function kairosBook(
  tx: Db,
  chatId: string,
  proposalId: string,
  now = new Date(),
): Promise<KairosBooked | KairosBookRefused> {
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
      "Ya tiene una presentación agendada: Kairós agenda una sola por clínica",
    )
  // Contra las presentaciones falsas: un tope al día entre todas (con el candado, nadie se lo salta).
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kairos-vende:agendar'))`)
  const [booked] = await tx.execute<{ n: number }>(sql`select count(*)::int as n
    from admin.saas_task t where t.kind = 'presentacion' and t.by_kairos
      and ${limaDaySql(sql`t.created_at`, now)}`)
  if ((booked?.n ?? 0) >= KAIROS_BOOKINGS_PER_DAY)
    throw new ServiceError(
      KAIROS_CAP_CODE,
      409,
      `Kairós llegó al tope de ${KAIROS_BOOKINGS_PER_DAY} presentaciones agendadas hoy`,
    )
  const result = await confirmProposal(tx, proposalId, now)
  if (result.status !== "confirmada") return { refused: result.error }
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
 * misma persona (si la hora es con otra, 409: se ofrece otra o se pasa al equipo;
 * `kairosSlots` ya ofrece solo las de quien presenta). Si la hora ya no se puede
 * dar, la propuesta queda vencida y se devuelve (`KairosBookRefused`).
 */
export async function kairosMove(
  tx: Db,
  chatId: string,
  proposalId: string,
  now = new Date(),
): Promise<KairosBooked | KairosBookRefused> {
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
  try {
    await tx.transaction((inner) =>
      movePresentation(inner as Db, null, task.id, pending.startsAt, now),
    )
  } catch (error) {
    if (error instanceof ServiceError && (error.code === "SLOT_TAKEN" || error.fields?.startsAt)) {
      await tx
        .update(kairosProposal)
        .set({ status: "vencida", updatedAt: now })
        .where(eq(kairosProposal.id, pending.id))
      return { refused: { code: "SLOT_TAKEN", message: error.message } }
    }
    throw error
  }
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
 *   una vez por presentación, con «hoy» o «mañana» según cuándo sale. No si se
 *   agendó después de esa hora ni si la confirmación de Kairós o el aviso de un
 *   cambio de esa misma hora salieron a menos de 24 h de empezar (`toldRecently`).
 * - `otra_hora`: «Pedir otra hora» (`needs_new_time_at`), una vez por pedido.
 * - `cambio`: una persona la movió (también con «Mover» de Hoy) o la pasó a otra
 *   persona, una vez por cambio.
 * Todos van con `purpose = 'aviso'`: no cuentan como respuesta.
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
    // Mientras espera otra hora (cualquier cambio de una persona la atiende y la limpia: mover,
    // «Mover» de Hoy, pasar a otra), la hora que tiene no vale: ni cambio ni recordatorio.
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
      where a.action in ('arm.presentation_moved', 'arm.presentation_reassigned', 'arm.task_moved')
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
      new Date(task.created_at) < remindFrom &&
      !(await toldRecently(tx, task.id, dueAt))
    ) {
      // «hoy» o «mañana» según cuándo sale, en Lima (el worker pudo pasar tarde).
      const day = limaDate(dueAt)
      const relative =
        day === limaDate(now)
          ? "hoy"
          : day === limaDate(new Date(now.getTime() + DAY))
            ? "mañana"
            : null
      await add(
        "recordatorio",
        `recordatorio:${task.id}:${task.due_at}`,
        `${hello} Te recuerdo tu presentación${relative ? ` de ${relative}` : ""}: el ${when} (hora de Lima) con ${presenter.name}. ${presenter.meetingUrl ? `Entra a la hora aquí ${presenter.meetingUrl}` : `${presenter.name} te comparte el enlace antes de empezar.`}`,
        "recordatorio_presentacion",
        relative ? `Tu presentación es ${relative}` : "Se acerca tu presentación",
        params,
      )
    }
  }
  return out
}

/**
 * Ya se le dijo esta misma hora hace poco: la confirmación de Kairós al agendarla o moverla, o el
 * aviso de un cambio, a menos de 24 h de empezar. Entonces el recordatorio sobra.
 */
async function toldRecently(tx: Db, taskId: string, dueAt: Date): Promise<boolean> {
  const due = dueAt.toISOString()
  const since = new Date(dueAt.getTime() - DAY).toISOString()
  const [row] = await tx.execute<{ told: boolean }>(sql`select
      exists (select 1 from admin.kairos_proposal p where p.task_id = ${taskId}::uuid
        and p.status = 'confirmada' and p.starts_at = ${due}::timestamptz
        and p.updated_at > ${since}::timestamptz)
      or exists (select 1 from admin.admin_audit a where a.action = 'kairos.presentation_notice'
        and a.metadata ->> 'taskId' = ${taskId} and a.metadata ->> 'kind' = 'cambio'
        and a.metadata ->> 'dueAt' = ${due} and (a.metadata ->> 'at')::timestamptz > ${since}::timestamptz)
      as told`)
  return Boolean(row?.told)
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
  // Los avisos (también los correos a una dirección que dieron en un chat, sin verificar) paran en
  // el tope del día de Kairós.
  if ((await kairosDayCount(tx, now)) >= KAIROS_TURNS_PER_DAY) return null
  const [task] = await tx
    .select({ dueAt: saasTask.dueAt })
    .from(saasTask)
    .where(eq(saasTask.id, notice.taskId))
    .limit(1)
  await writeAdminAudit(tx, null, {
    action: "kairos.presentation_notice",
    entityId: notice.key,
    metadata: {
      taskId: notice.taskId,
      clientId: notice.clientId,
      kind: notice.kind,
      by: notice.route.by,
      dueAt: task?.dueAt?.toISOString() ?? null,
      at: now.toISOString(),
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
          purpose: "aviso",
        }
      : { body: notice.text, closeItems: false, purpose: "aviso" },
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
