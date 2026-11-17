/**
 * La Bandeja de la administración (ADR 0196): lo que nos escriben desde fuera de la app, una
 * conversación por persona y canal, con su estado. Solo Administración: Soporte trabaja en su
 * cola y aquí recibe 403.
 *
 * Una conversación es un chat (`saas_chat`, con al menos un mensaje de la persona) o el hilo de un
 * correo (con al menos un correo que llegó: uno que escribimos y nadie respondió no espera nada).
 * No se guarda aparte: se lee de lo que entró y de lo que salió. El hilo de un correo se arma al
 * leer (`threadKeyOf` y su gemela `emailThreadKeySql`): el primer Message-ID de su `References`;
 * si no trae, la clave del correo que responde (un envío nuestro o un correo que llegó, por el
 * primero de su `In-Reply-To`) o ese mismo id; si tampoco, su propio Message-ID. Un correo que
 * llegó entra en ese hilo solo si quien lo envía ya está en él (`threadAddressSql`): si no, es su
 * propia conversación, aunque conozca el Message-ID de un hilo ajeno. Una respuesta nuestra va en
 * el hilo del correo que responde; lo que escribimos primero, en el de su `References` o su
 * propio Message-ID.
 *
 * El estado lo dice una sola regla en SQL (`conversationsSql`): solo cuenta como respuesta un
 * envío `respuesta` (un aviso no responde nada) creado desde lo último que llegó y que no sea el
 * aviso fijo con que Kairós pasa la conversación al equipo. «No necesita respuesta» y «Lo atiendo
 * yo» en un correo son lo único que se guarda (`saas_conversation_mark`); en un chat, quién lo
 * atiende lo dice la pausa de Kairós.
 */
import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  kairosItem,
  type SaasInboundAttachment,
  type SaasInboundMailbox,
  saasChat,
  saasClient,
  saasClientFile,
  saasConversationMark,
  saasInboundEmail,
  saasOutreach,
} from "@odentia/db/schema/admin-arm"
import { user } from "@odentia/db/schema/auth"
import { and, asc, desc, eq, gt, inArray, isNotNull, type SQL, sql } from "drizzle-orm"
import { type ChannelRules, channelRulesOf } from "./admin-channel-rules.js"
import { CLIENT_PHASES, type ClientPhase, clientPhaseSql } from "./admin-clients.js"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { emailThreadKeySql, firstIdSql, outreachThreadKeySql } from "./admin-email-thread.js"
import { inboundFileCarga, matchInboundClient } from "./admin-inbound-email.js"
import { CHAT_OUTREACH_SETTLE_MS, replySignature, replySubject } from "./admin-sales.js"
import { outreachSenderPreview } from "./admin-staff-mail.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { kairosHandlesSql } from "./kairos-sells.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const INBOX_STATES = ["te_toca", "kairos", "respondida"] as const
/** Te toca (espera a una persona), Kairós respondió (ya salió) o Respondida. */
export type InboxState = (typeof INBOX_STATES)[number]
export const INBOX_CHANNELS = ["correo", "whatsapp", "instagram", "messenger"] as const
export type InboxChannel = (typeof INBOX_CHANNELS)[number]

/** Cuántas conversaciones trae la lista como mucho, y cuántas si no se dice. */
export const INBOX_LIMIT_MAX = 100
export const INBOX_LIMIT_DEFAULT = 60
/** Lo que se lee de lo último que llegó en la lista. */
const PREVIEW_MAX = 280
/** Lo que se trae del texto para armar ese adelanto (un correo puede traer 20 000). */
const PREVIEW_SOURCE_MAX = 4000

function requireAdmin(actor: AdminActor | null): AdminActor {
  if (actor?.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Solo el rol Administración puede hacer esto")
  return actor
}

/* ---------- El hilo de un correo ---------- */

export {
  emailThreadKeySql,
  firstMessageId,
  headerThreadKeyOf,
  outreachThreadKeyOf,
  outreachThreadKeySql,
  type ThreadHeaders,
  threadKeyOf,
} from "./admin-email-thread.js"

/* ---------- Lo que llegó, en pocas palabras ---------- */

/** «El 12 de noviembre, Ana escribió:», «On Mon, … wrote:»: de ahí para abajo es lo citado. */
const QUOTE_HEADER = /^(el|on)\b.*(escribió|wrote):$/i

/**
 * Las primeras líneas de lo que llegó, para la lista: sin lo citado de un correo (lo que empieza
 * con «>» y lo que sigue a «… escribió:»), en una línea y hasta 280 caracteres. Nulo si no queda
 * texto (solo mandó un archivo, o el texto ya se borró).
 */
export function inboxPreview(text: string | null | undefined): string | null {
  if (!text) return null
  const lines: string[] = []
  let length = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (QUOTE_HEADER.test(line)) break
    if (!line || line.startsWith(">")) continue
    lines.push(line)
    length += line.length + 1
    if (length > PREVIEW_MAX) break
  }
  const joined = lines.join(" ").replace(/\s+/g, " ").trim()
  if (!joined) return null
  return joined.length > PREVIEW_MAX ? `${joined.slice(0, PREVIEW_MAX - 1)}…` : joined
}

/* ---------- La regla del estado ---------- */

/** Todas (las de la ventana y, con `clientId`, todo lo de ese cliente), un chat o un hilo. */
type ConversationScope =
  | { all: true; clientId?: string | null }
  | { chatId: string }
  | { threadKey: string }

/** Una respuesta que no es el aviso fijo con que Kairós pasa la conversación (o su respuesta que falló). */
const notHandoffSql = (alias: string) =>
  sql.raw(`not exists (select 1 from admin.kairos_chat_turn kt where kt.outreach_id = ${alias}.id
    and kt.outcome in ('paso', 'fallo'))`)

/** Entre las respuestas de un mismo instante, la que no se sabe si salió primero. */
const uncertainFirstSql = (alias: string) =>
  sql.raw(`(case ${alias}.status when 'incierto' then 0 when 'pendiente' then 1 else 2 end)`)

/**
 * No se sabe si salió: incierto, o pendiente desde hace más de lo que tarda en anotarse (la ruta
 * se cortó entre reservarlo y enviarlo). Es la regla de «¿Salió?» (`resolveOutreach`).
 */
const uncertainSql = (alias: string, settleAt: SQL) =>
  sql`(${sql.raw(`${alias}.status`)} = 'incierto' or (${sql.raw(`${alias}.status`)} = 'pendiente'
    and ${sql.raw(`${alias}.created_at`)} < ${settleAt}))`

/**
 * Los chats con su último mensaje `m` (el más nuevo por la hora de Meta, como Kairós): con qué se
 * compara una respuesta es la hora en que lo guardamos (`m.created_at`, nuestro reloj, el mismo
 * de la respuesta), no la que dice Meta.
 */
function chatConversationsSql(now: Date, chatId: string | null): SQL {
  const settleAt = sql`${new Date(now.getTime() - CHAT_OUTREACH_SETTLE_MS).toISOString()}::timestamptz`
  return sql`select 'chat'::text as kind, c.id::text as id, c.id::text as conv_key,
      c.channel::text as channel,
      coalesce(nullif(btrim(ct.name), ''), c.display_name) as who_name, c.address as who_address,
      null::text as subject, left(m.body, ${PREVIEW_SOURCE_MAX}) as preview,
      jsonb_array_length(m.media)::int as attachments,
      m.received_at as last_inbound_at, m.created_at as since,
      greatest(m.received_at, coalesce(lo.sent_at, lo.created_at)) as last_activity_at,
      c.client_id, null::text as mailbox, null::text as to_address,
      (case when c.kairos_paused_at is not null then c.kairos_paused_by end) as attended_by,
      mk.settled_at, (c.not_clinic_at is not null) as not_clinic,
      (c.kairos_paused_at is not null and c.kairos_paused_by is null) as handed_over,
      (select kt.why from admin.kairos_chat_turn kt where kt.chat_id = c.id
        and kt.outcome in ('paso', 'fallo') order by kt.updated_at desc limit 1) as handover_why,
      ${kairosHandlesSql(now)} as kairos_busy,
      false as draft_ready,
      r.status as reply_status, r.by_kairos as reply_by_kairos, r.created_by as reply_created_by,
      exists (select 1 from admin.saas_outreach u where u.chat_id = c.id and u.purpose = 'respuesta'
        and u.created_at >= m.created_at and ${uncertainSql("u", settleAt)} and ${notHandoffSql("u")})
        as reply_uncertain,
      exists (select 1 from admin.saas_outreach f where f.chat_id = c.id and f.purpose = 'respuesta'
        and f.status = 'no_salio' and f.created_at >= m.created_at
        and (f.created_by is not null or not f.by_kairos)) as failed_after,
      (nl.id is not null) as undelivered_after,
      (nl.by_kairos and nl.created_by is null) as undelivered_by_kairos,
      lo.status as last_out_status, lo.by_kairos as last_out_by_kairos,
      coalesce(lo.sent_at, lo.created_at) as last_out_at
    from admin.saas_chat c
    join lateral (select mm.id, mm.body, mm.media, mm.received_at, mm.created_at
      from admin.saas_inbound_message mm where mm.chat_id = c.id
      order by mm.received_at desc, mm.created_at desc, mm.id desc limit 1) m on true
    left join admin.saas_client cl on cl.id = c.client_id
    left join admin.saas_client_contact ct on ct.id = c.contact_id
    left join admin.saas_conversation_mark mk on mk.chat_id = c.id
    left join lateral (select o.status, o.by_kairos, o.created_by from admin.saas_outreach o
      where o.chat_id = c.id and o.purpose = 'respuesta' and o.status <> 'no_salio'
        and o.failed_at is null and o.created_at >= m.created_at and ${notHandoffSql("o")}
      order by o.created_at desc, ${uncertainFirstSql("o")}, o.id desc limit 1) r on true
    -- Lo que salió pero WhatsApp dijo que no llegó (un archivo que no pudo descargar): no responde.
    left join lateral (select o.id, o.by_kairos, o.created_by from admin.saas_outreach o
      where o.chat_id = c.id and o.purpose = 'respuesta' and o.failed_at is not null
        and o.created_at >= m.created_at
      order by o.created_at desc, o.id desc limit 1) nl on true
    left join lateral (select o.status, o.by_kairos, o.sent_at, o.created_at from admin.saas_outreach o
      where o.chat_id = c.id order by o.created_at desc, o.id desc limit 1) lo on true
    where ${chatId ? sql`c.id = ${chatId}::uuid` : sql`true`}`
}

/**
 * Cuántos días atrás lee la lista de la Bandeja (y su número): un hilo cuyo último correo llegó
 * antes ya no espera respuesta ahí, y leerlo todo recalculaba el hilo de cada correo guardado. Lo
 * de antes sigue en la ficha del cliente (su historial), y filtrar por un cliente trae todo lo
 * suyo. La ventana dice qué hilos se listan; de quién es un hilo lo dicen todos sus correos
 * (`mail_before`). Un hilo pedido (`getEmailThread`) se lee entero.
 */
export const INBOX_WINDOW_DAYS = 180
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Los hilos de correo, cada uno con el último correo que llegó (`l`, con él se abre). Una
 * respuesta cuenta si se creó desde que llegó ese correo o si lo responde a él (los relojes del
 * worker del correo y de la API pueden no coincidir al segundo). El cliente del hilo es el del
 * correo más nuevo que lo tiene: lo liga la entrada o una persona, nunca el hilo solo. La
 * respuesta que dejó lista Kairós cuenta solo si responde ese último correo: la de un correo
 * anterior ya no contesta lo que escribió después. Una marca de una persona se busca por la
 * clave del hilo y por el Message-ID de cada uno de sus correos: si después llega el padre de un
 * correo, la clave cambia y la marca sigue.
 */
function mailConversationsSql(
  now: Date,
  threadKey: string | null,
  clientId: string | null = null,
): SQL {
  const at = sql`${now.toISOString()}::timestamptz`
  const settleAt = sql`${new Date(now.getTime() - CHAT_OUTREACH_SETTLE_MS).toISOString()}::timestamptz`
  const sinceLast = sql`(o.created_at >= l.received_at or o.in_reply_to_email_id = l.id)`
  const windowStart = sql`${new Date(now.getTime() - INBOX_WINDOW_DAYS * DAY_MS).toISOString()}::timestamptz`
  // Lo que lee la lista: lo de la ventana y, si se filtra por un cliente, todo lo suyo.
  const inWindow = (alias: "e" | "o", column: "received_at" | "created_at") => {
    if (threadKey) return sql`true`
    const recent = sql`${sql.raw(`${alias}.${column}`)} >= ${windowStart}`
    return clientId
      ? sql`(${recent} or ${sql.raw(`${alias}.client_id`)} = ${clientId}::uuid)`
      : recent
  }
  return sql`with mail as (
      select e.id, e.message_id, e.client_id, e.mailbox, e.to_address, e.from_address, e.from_name,
        e.subject, e.text_body, e.attachments, e.received_at, ${emailThreadKeySql("e")} as thread_key
      from admin.saas_inbound_email e
      where ${inWindow("e", "received_at")}
    ), mail_last as (
      select distinct on (ml.thread_key) ml.* from mail ml where ml.thread_key is not null
      order by ml.thread_key, ml.received_at desc, ml.id desc
    ), mail_out as (
      -- La regla de outreachThreadKeySql, con la clave ya leída del correo que responde (o, si
      -- ese correo quedó fuera de la ventana, leída de nuevo).
      select o.id, o.status, o.by_kairos, o.created_by, o.purpose, o.created_at, o.sent_at,
        o.in_reply_to_email_id,
        (case when o.in_reply_to_email_id is null
            then coalesce(${firstIdSql(sql.raw(`o."references"`))}, nullif(btrim(o.message_id), ''))
          when mi.id is not null then mi.thread_key
          else (select ${emailThreadKeySql("ie")} from admin.saas_inbound_email ie
            where ie.id = o.in_reply_to_email_id) end) as thread_key
      from admin.saas_outreach o
      left join mail mi on mi.id = o.in_reply_to_email_id
      where o.channel = 'correo' and ${inWindow("o", "created_at")}
    ), thread_reply as (
      select distinct on (o.thread_key) o.thread_key, o.status, o.by_kairos, o.created_by
      from mail_out o join mail_last l on l.thread_key = o.thread_key
      where o.purpose = 'respuesta' and o.status <> 'no_salio' and ${sinceLast}
      order by o.thread_key, o.created_at desc, ${uncertainFirstSql("o")}, o.id desc
    ), thread_uncertain as (
      select distinct o.thread_key from mail_out o join mail_last l on l.thread_key = o.thread_key
      where o.purpose = 'respuesta' and ${sinceLast} and ${uncertainSql("o", settleAt)}
    ), thread_failed as (
      select distinct o.thread_key from mail_out o join mail_last l on l.thread_key = o.thread_key
      where o.purpose = 'respuesta' and o.status = 'no_salio' and ${sinceLast}
        and (o.created_by is not null or not o.by_kairos)
    ), thread_out as (
      select distinct on (o.thread_key) o.thread_key, o.status, o.by_kairos, o.sent_at, o.created_at
      from mail_out o where o.thread_key is not null
      order by o.thread_key, o.created_at desc, o.id desc
    ), mail_before as (
      -- La ventana dice qué hilos se listan, no de quién son: de un hilo listado, sus correos de
      -- antes con cliente (por el primer Message-ID de sus cabeceras, con índice; uno que solo
      -- responde por In-Reply-To a otro de antes no se busca).
      select ob.id, ob.client_id, ob.received_at, ${emailThreadKeySql("ob")} as thread_key
      from admin.saas_inbound_email ob
      where ${threadKey ? sql`false` : sql`ob.received_at < ${windowStart}`} and ob.client_id is not null
        and (ob.message_id in (select bl.thread_key from mail_last bl)
          or ${firstIdSql(sql.raw(`ob."references"`))} in (select bl.thread_key from mail_last bl)
          or ${firstIdSql(sql.raw("ob.in_reply_to"))} in (select bl.thread_key from mail_last bl))
    ), thread_client as (
      select distinct on (mc.thread_key) mc.thread_key, mc.client_id from (
        select cm.thread_key, cm.client_id, cm.received_at, cm.id from mail cm
        union all
        select cb.thread_key, cb.client_id, cb.received_at, cb.id from mail_before cb
      ) mc
      where mc.client_id is not null and mc.thread_key is not null
      order by mc.thread_key, mc.received_at desc, mc.id desc
    ), thread_mark as (
      select km.thread_key, max(mk.settled_at) as settled_at,
        (array_agg(mk.attended_by order by mk.attended_at desc nulls last)
          filter (where mk.attended_by is not null))[1] as attended_by
      from (select mt.thread_key, mt.thread_key as mark_key from mail mt where mt.thread_key is not null
        union select mm.thread_key, nullif(btrim(mm.message_id), '') from mail mm
          where mm.thread_key is not null) km
      join admin.saas_conversation_mark mk on mk.thread_key = km.mark_key
      group by km.thread_key
    ), thread_draft as (
      select distinct dl.thread_key from admin.kairos_item k
      join mail_last dl on dl.id::text = k.payload ->> 'emailId'
      where k.kind = 'responder_correo' and k.status = 'espera' and k.expires_at > ${at}
        and jsonb_typeof(k.payload -> 'draft') = 'object'
    )
    select 'correo'::text as kind, l.id::text as id, l.thread_key as conv_key, 'correo'::text as channel,
      l.from_name as who_name, l.from_address as who_address, l.subject,
      left(l.text_body, ${PREVIEW_SOURCE_MAX}) as preview,
      jsonb_array_length(l.attachments)::int as attachments,
      l.received_at as last_inbound_at, l.received_at as since,
      greatest(l.received_at, coalesce(lo.sent_at, lo.created_at)) as last_activity_at,
      tc.client_id, l.mailbox, l.to_address,
      mk.attended_by, mk.settled_at, false as not_clinic, false as handed_over,
      null::text as handover_why, false as kairos_busy, (td.thread_key is not null) as draft_ready,
      r.status as reply_status, r.by_kairos as reply_by_kairos, r.created_by as reply_created_by,
      (tu.thread_key is not null) as reply_uncertain, (tf.thread_key is not null) as failed_after,
      false as undelivered_after, false as undelivered_by_kairos,
      lo.status as last_out_status, lo.by_kairos as last_out_by_kairos,
      coalesce(lo.sent_at, lo.created_at) as last_out_at
    from mail_last l
    left join thread_client tc on tc.thread_key = l.thread_key
    left join thread_mark mk on mk.thread_key = l.thread_key
    left join thread_reply r on r.thread_key = l.thread_key
    left join thread_uncertain tu on tu.thread_key = l.thread_key
    left join thread_failed tf on tf.thread_key = l.thread_key
    left join thread_out lo on lo.thread_key = l.thread_key
    left join thread_draft td on td.thread_key = l.thread_key
    where ${threadKey ? sql`l.thread_key = ${threadKey}` : sql`true`}`
}

/**
 * Cada conversación con su estado y por qué, la única regla de la Bandeja (la lista, el número
 * del menú, el chat y el hilo la leen de aquí):
 * - «No necesita respuesta» desde lo último que llegó, o un chat «No es una clínica»: Respondida.
 * - Una respuesta desde lo último que llegó que salió o puede haber salido: Kairós respondió si
 *   la escribió Kairós solo, si no Respondida (diciendo si no se sabe si salió).
 * - Lo demás espera a una persona: Te toca, con su motivo (no salió la respuesta, salió pero
 *   WhatsApp dijo que no llegó, Kairós dejó la respuesta lista, Kairós la pasó al equipo o la
 *   está respondiendo). Lo que no llegó (`failed_at`) no cuenta como respuesta.
 */
function conversationsSql(now: Date, scope: ConversationScope): SQL {
  const parts: SQL[] = []
  if (!("threadKey" in scope))
    parts.push(chatConversationsSql(now, "chatId" in scope ? scope.chatId : null))
  if (!("chatId" in scope))
    parts.push(
      mailConversationsSql(
        now,
        "threadKey" in scope ? scope.threadKey : null,
        "all" in scope ? (scope.clientId ?? null) : null,
      ),
    )
  const union = sql.join(
    parts.map((part) => sql`(${part})`),
    sql` union all `,
  )
  const settled = sql`(v.settled_at is not null and v.settled_at >= v.since)`
  return sql`select v.*,
      (case when ${settled} then 'respondida' when v.not_clinic then 'respondida'
        when v.reply_status is not null then
          (case when v.reply_by_kairos and v.reply_created_by is null then 'kairos' else 'respondida' end)
        else 'te_toca' end) as state,
      (case when ${settled} then 'no_necesita' when v.not_clinic then 'no_es_clinica'
        when v.reply_status is not null then (case when v.reply_uncertain then 'incierta' end)
        when v.failed_after then 'no_salio' when v.undelivered_after then 'no_llego'
        when v.draft_ready then 'borrador'
        when v.handed_over then 'kairos_la_paso' when v.kairos_busy then 'kairos_responde' end)
        as why_code
    from (${union}) v`
}

/** Un instante leído con SQL a mano, en ISO 8601 (UTC). */
const iso = (expr: SQL) =>
  sql`to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

interface ConversationRow extends Record<string, unknown> {
  kind: "chat" | "correo"
  id: string
  conv_key: string
  channel: string
  who_name: string | null
  who_address: string
  subject: string | null
  preview: string | null
  attachments: number
  last_inbound_at: string
  last_activity_at: string
  client_id: string | null
  client_name: string | null
  client_product: string | null
  client_has_app: boolean | null
  client_phase: string | null
  mailbox: string | null
  to_address: string | null
  attended_by: string | null
  attended_name: string | null
  settled_at: string | null
  state: InboxState
  why_code: string | null
  handover_why: string | null
  reply_by_kairos: boolean | null
  /** La respuesta que no llegó (`failed_at`) la escribió Kairós solo. */
  undelivered_by_kairos: boolean | null
  draft_ready: boolean
  last_out_status: string | null
  last_out_by_kairos: boolean | null
  last_out_at: string | null
}

/** Las conversaciones con su cliente (y su fase) y quién las atiende, listas para leer. */
async function conversationRows(
  tx: Db,
  now: Date,
  scope: ConversationScope,
  options: { where?: SQL; limit?: number } = {},
): Promise<ConversationRow[]> {
  // `clientPhaseSql` lee la fila de `saas_client` por su nombre: va sin alias.
  const query = sql`select x.kind, x.id, x.conv_key, x.channel, x.who_name, x.who_address, x.subject,
      x.preview, x.attachments, ${iso(sql`x.last_inbound_at`)} as last_inbound_at,
      ${iso(sql`x.last_activity_at`)} as last_activity_at, x.client_id::text as client_id,
      x.client_name, x.client_product, x.client_has_app, x.client_phase, x.mailbox, x.to_address,
      x.attended_by, au.name as attended_name,
      (case when x.settled_at is null then null else ${iso(sql`x.settled_at`)} end) as settled_at,
      x.state, x.why_code, x.handover_why, x.reply_by_kairos, x.undelivered_by_kairos,
      x.draft_ready, x.last_out_status,
      x.last_out_by_kairos,
      (case when x.last_out_at is null then null else ${iso(sql`x.last_out_at`)} end) as last_out_at
    from (
      select s.*, saas_client.name as client_name, saas_client.product as client_product,
        (saas_client.organization_id is not null) as client_has_app,
        (case when saas_client.id is null then null else ${clientPhaseSql(now)} end) as client_phase
      from (${conversationsSql(now, scope)}) s
      left join admin.saas_client on saas_client.id = s.client_id
    ) x
    left join "user" au on au.id = x.attended_by
    where ${options.where ?? sql`true`}
    order by (case when x.state = 'te_toca' then 0 else 1 end),
      (case when x.state = 'te_toca' then x.last_inbound_at end) asc,
      x.last_activity_at desc, x.id asc
    ${options.limit ? sql`limit ${options.limit}` : sql``}`
  return [...(await tx.execute<ConversationRow>(query))] as ConversationRow[]
}

/** Por qué está así, en palabras. */
function stateWhyOf(row: ConversationRow): string | null {
  switch (row.why_code) {
    case "no_necesita":
      return "No necesitaba respuesta"
    case "no_es_clinica":
      return "No es una clínica"
    case "incierta":
      return row.reply_by_kairos
        ? "No se sabe si salió la respuesta de Kairós"
        : "No se sabe si salió tu respuesta"
    case "no_salio":
      return "No salió tu respuesta"
    case "no_llego":
      return row.undelivered_by_kairos ? "No llegó la respuesta de Kairós" : "No llegó tu respuesta"
    case "borrador":
      return "Kairós dejó la respuesta lista"
    case "kairos_la_paso": {
      const why = row.handover_why?.trim()
      return why ? `Kairós te la pasó: ${why}` : "Kairós te la pasó"
    }
    case "kairos_responde":
      return "Kairós la está respondiendo"
    default:
      return null
  }
}

const phaseOf = (value: string | null): ClientPhase =>
  (CLIENT_PHASES as readonly string[]).includes(value ?? "") ? (value as ClientPhase) : "por_vender"

const channelOf = (value: string): InboxChannel =>
  (INBOX_CHANNELS as readonly string[]).includes(value) ? (value as InboxChannel) : "correo"

/* ---------- La lista ---------- */

export interface InboxClient {
  id: string
  name: string
  phase: ClientPhase
  product: string | null
  hasApp: boolean
}

/** Una conversación de la lista (`inboxSchema` de la administración). */
export interface InboxItem {
  kind: "chat" | "correo"
  /** El chat, o el último correo que llegó del hilo: con él se abre. */
  id: string
  channel: InboxChannel
  /** Quién escribió: su nombre, si lo dio, y su dirección (correo, número o cuenta de Meta). */
  who: { name: string | null; address: string }
  subject: string | null
  /** Las primeras líneas de lo último que llegó; nulo si solo mandó un archivo o ya se borró. */
  preview: string | null
  attachments: number
  lastInboundAt: Date
  lastActivityAt: Date
  state: InboxState
  stateWhy: string | null
  /** Kairós dejó la respuesta lista (`responder_correo`): se envía o se cambia en el hilo. */
  draftReady: boolean
  client: InboxClient | null
  /** Solo correo: el buzón y la dirección a la que llegó. */
  mailbox: string | null
  to: string | null
  attendedBy: { id: string; name: string } | null
  lastOutbound: { status: string; byKairos: boolean; at: Date } | null
}

export interface Inbox {
  counts: { teToca: number; kairos: number; sinCliente: number }
  items: InboxItem[]
}

export interface InboxFilter {
  /** Por omisión, todas: primero lo que te toca. */
  estado?: InboxState | "todas"
  /** `sin` para lo que no tiene cliente, o el id de un cliente. */
  cliente?: string
  /** La fase del cliente; lo que no tiene cliente está por vender. */
  fase?: ClientPhase
  canal?: InboxChannel
  limit?: number
}

function itemOf(row: ConversationRow): InboxItem {
  return {
    kind: row.kind,
    id: row.id,
    channel: channelOf(row.channel),
    who: { name: row.who_name?.trim() || null, address: row.who_address },
    subject: row.subject,
    preview: inboxPreview(row.preview),
    attachments: row.attachments ?? 0,
    lastInboundAt: new Date(row.last_inbound_at),
    lastActivityAt: new Date(row.last_activity_at),
    state: row.state,
    stateWhy: stateWhyOf(row),
    draftReady: row.state === "te_toca" && row.draft_ready,
    client: row.client_id
      ? {
          id: row.client_id,
          name: row.client_name ?? "",
          phase: phaseOf(row.client_phase),
          product: row.client_product,
          hasApp: Boolean(row.client_has_app),
        }
      : null,
    mailbox: row.mailbox,
    to: row.to_address,
    attendedBy: row.attended_by ? { id: row.attended_by, name: row.attended_name ?? "" } : null,
    lastOutbound:
      row.last_out_status && row.last_out_at
        ? {
            status: row.last_out_status,
            byKairos: Boolean(row.last_out_by_kairos),
            at: new Date(row.last_out_at),
          }
        : null,
  }
}

function filterSql(filter: InboxFilter): SQL {
  const parts: SQL[] = []
  if (filter.estado && filter.estado !== "todas") parts.push(sql`x.state = ${filter.estado}`)
  if (filter.cliente === "sin") parts.push(sql`x.client_id is null`)
  else if (filter.cliente) parts.push(sql`x.client_id = ${filter.cliente}::uuid`)
  if (filter.fase) parts.push(sql`coalesce(x.client_phase, 'por_vender') = ${filter.fase}`)
  if (filter.canal) parts.push(sql`x.channel = ${filter.canal}`)
  return parts.length > 0 ? sql.join(parts, sql` and `) : sql`true`
}

/** Cuántas te tocan, cuántas respondió Kairós y cuántas te tocan sin cliente: de todas, sin filtro. */
async function countsOf(tx: Db, now: Date): Promise<Inbox["counts"]> {
  const [row] = [
    ...(await tx.execute<{ te_toca: number; kairos: number; sin_cliente: number }>(
      sql`select count(*) filter (where s.state = 'te_toca')::int as te_toca,
        count(*) filter (where s.state = 'kairos')::int as kairos,
        count(*) filter (where s.state = 'te_toca' and s.client_id is null)::int as sin_cliente
      from (${conversationsSql(now, { all: true })}) s`,
    )),
  ]
  return { teToca: row?.te_toca ?? 0, kairos: row?.kairos ?? 0, sinCliente: row?.sin_cliente ?? 0 }
}

/**
 * La Bandeja: las conversaciones que pide el filtro y, de todas, cuántas te tocan. Lo que te
 * toca va primero, lo que espera hace más arriba; lo demás, lo último que pasó arriba.
 */
export async function listInbox(
  tx: Db,
  actor: AdminActor | null,
  filter: InboxFilter = {},
  now = new Date(),
): Promise<Inbox> {
  requireAdmin(actor)
  if (filter.estado && filter.estado !== "todas" && !INBOX_STATES.includes(filter.estado))
    throw invalidField("estado", "Elige te toca, Kairós respondió, respondida o todas")
  if (filter.cliente && filter.cliente !== "sin" && !UUID.test(filter.cliente))
    throw invalidField("cliente", "El cliente no es válido")
  if (filter.fase && !CLIENT_PHASES.includes(filter.fase))
    throw invalidField("fase", "Esa fase no existe")
  if (filter.canal && !INBOX_CHANNELS.includes(filter.canal))
    throw invalidField("canal", "Elige correo, WhatsApp, Instagram o Messenger")
  const limit = Math.min(
    Math.max(Math.trunc(filter.limit ?? INBOX_LIMIT_DEFAULT), 1),
    INBOX_LIMIT_MAX,
  )
  const clientId = filter.cliente && filter.cliente !== "sin" ? filter.cliente : null
  const rows = await conversationRows(
    tx,
    now,
    { all: true, clientId },
    { where: filterSql(filter), limit },
  )
  return { counts: await countsOf(tx, now), items: rows.map(itemOf) }
}

/** El número del menú: solo lo que te toca. */
export async function inboxCounts(
  tx: Db,
  actor: AdminActor | null,
  now = new Date(),
): Promise<{ teToca: number }> {
  requireAdmin(actor)
  return { teToca: (await countsOf(tx, now)).teToca }
}

/* ---------- El estado de un chat (lo lee `getChat`) ---------- */

export interface ConversationState {
  state: InboxState
  stateWhy: string | null
  attendedBy: { id: string; name: string } | null
  settledAt: Date | null
  clientPhase: ClientPhase | null
}

/**
 * El estado de un chat con la regla de la Bandeja; nulo si nunca escribió (no está en la
 * Bandeja). Sin persona: quien llama ya revisó quién lo mira.
 */
export async function chatConversationState(
  tx: Db,
  chatId: string,
  now = new Date(),
): Promise<ConversationState | null> {
  if (!UUID.test(chatId)) return null
  const [row] = await conversationRows(tx, now, { chatId })
  return row ? stateOf(row) : null
}

function stateOf(row: ConversationRow): ConversationState {
  return {
    state: row.state,
    stateWhy: stateWhyOf(row),
    attendedBy: row.attended_by ? { id: row.attended_by, name: row.attended_name ?? "" } : null,
    settledAt: row.settled_at ? new Date(row.settled_at) : null,
    clientPhase: row.client_id ? phaseOf(row.client_phase) : null,
  }
}

/* ---------- El hilo de un correo ---------- */

export interface EmailThreadInbound {
  kind: "entro"
  id: string
  at: Date
  fromName: string | null
  fromAddress: string
  to: string
  subject: string | null
  /** Nulo si llegó sin texto o si se borró (con la carga de datos, a los 30 días). */
  text: string | null
  textDeleted: boolean
  notice: string | null
  senderVerified: boolean
  attachments: Array<{
    fileId: string | null
    filename: string
    contentType: string
    size: number
    /**
     * Con su documento guardado y sin marcar: el día de Lima en que se borraría si se marca ahora
     * como la carga, y si marcarlo lo borra en el acto (lo mismo que dice `getInboundEmail`).
     */
    cargaDeleteAfter: string | null
    cargaDueNow: boolean
  }>
}

export interface EmailThreadOutbound {
  kind: "salio"
  id: string
  at: Date
  by: { id: string; name: string } | null
  byKairos: boolean
  /** La dirección que firmó. */
  from: string | null
  to: string
  subject: string | null
  body: string
  status: string
  sentAt: Date | null
  files: Array<{ id: string; filename: string; contentType: string; size: number }>
  /** «¿Salió?»: no se sabe si salió (la misma regla de `resolveOutreach`). */
  canResolve: boolean
}

export type EmailThreadEntry = EmailThreadInbound | EmailThreadOutbound

export interface EmailThread {
  /** El último correo que llegó del hilo. */
  emailId: string
  threadKey: string
  subject: string | null
  mailbox: SaasInboundMailbox
  product: string
  client: InboxClient | null
  /** Sin cliente: de quién puede ser (nunca lo liga solo). */
  suggestion: { clientId: string; clientName: string; why: string } | null
  state: InboxState
  stateWhy: string | null
  attendedBy: { id: string; name: string } | null
  settledAt: Date | null
  /** Lo que llegó y lo que salió, en el orden en que pasó. */
  entries: EmailThreadEntry[]
  /** «Responder»: el último correo que llegó, con la operación de siempre (`prepareEmailReply`). */
  reply: {
    emailId: string
    to: string
    /** Quién firmaría («Ada Lovelace · odentIA <ada.lovelace@odentia32.com>»), con la regla del envío. */
    from: string | null
    subject: string
    /** La firma que el envío agrega al final (`replySignature`). */
    signature: string | null
    canReply: boolean
    why: string | null
  }
  rules: ChannelRules
  /**
   * La respuesta que dejó lista Kairós (`responder_correo`) para el último correo que llegó: se
   * envía o se cambia con su ítem. La de un correo anterior no sale aquí: no contesta lo último.
   */
  draft: {
    itemId: string
    /** El correo que responde (el último que llegó del hilo). */
    emailId: string
    subject: string | null
    body: string
    reason: string | null
    facts: string[]
    drafter: string
    note: string | null
  } | null
}

/** La clave del hilo de un correo que llegó; 404 si no existe. */
async function threadKeyOfEmail(tx: Db, emailId: string): Promise<string> {
  if (!UUID.test(emailId)) throw notFound("Correo")
  const [row] = [
    ...(await tx.execute<{ key: string | null }>(
      sql`select ${emailThreadKeySql("e")} as key from admin.saas_inbound_email e
        where e.id = ${emailId}::uuid`,
    )),
  ]
  if (!row) throw notFound("Correo")
  if (!row.key) throw new ServiceError("THREAD_UNKNOWN", 409, "Este correo no trae su Message-ID")
  return row.key
}

/** La clave, si cabe en la marca (`saas_conversation_mark_key_check`). */
async function markableThreadKey(tx: Db, emailId: string): Promise<string> {
  const key = await threadKeyOfEmail(tx, emailId)
  if (key.length < 3 || key.length > 998)
    throw new ServiceError(
      "THREAD_UNMARKABLE",
      409,
      "Este correo no trae un Message-ID con que marcar su hilo",
    )
  return key
}

/**
 * Las claves con que puede estar marcado un hilo: la de hoy y el Message-ID de cada uno de sus
 * correos (la marca se guardó con la clave de entonces, que cambia si después llega el padre de
 * un correo). Es la regla de `thread_mark` en `mailConversationsSql`.
 */
async function threadMarkKeys(tx: Db, threadKey: string): Promise<string[]> {
  const rows = await tx.execute<{ key: string }>(
    sql`select nullif(btrim(e.message_id), '') as key from admin.saas_inbound_email e
      where ${emailThreadKeySql("e")} = ${threadKey}`,
  )
  return [...new Set([threadKey, ...[...rows].flatMap((row) => (row.key ? [row.key] : []))])]
}

const MATCH_WHY: Record<string, string> = {
  contacto: "Escribe desde el correo de una persona de esta clínica",
  solicitud: "Escribe desde el correo de su solicitud en la web",
  miembro: "Escribe desde el correo de alguien del equipo de su cuenta",
}

/**
 * Un correo y su hilo entero, a partir de cualquiera de sus correos: lo que llegó y lo que
 * salió, su estado, de quién es (o de quién puede ser), con qué se responde y la respuesta que
 * dejó lista Kairós.
 */
export async function getEmailThread(
  tx: Db,
  actor: AdminActor | null,
  emailId: string,
  now = new Date(),
): Promise<EmailThread> {
  const staff = requireAdmin(actor)
  const threadKey = await threadKeyOfEmail(tx, emailId)
  const emails = await tx
    .select()
    .from(saasInboundEmail)
    .where(sql`${emailThreadKeySql("saas_inbound_email")} = ${threadKey}`)
    .orderBy(asc(saasInboundEmail.receivedAt), asc(saasInboundEmail.id))
  const latest = emails.at(-1)
  if (!latest) throw notFound("Correo")
  const emailIds = emails.map((email) => email.id)
  const replies = await tx
    .select({ row: saasOutreach, authorName: user.name })
    .from(saasOutreach)
    .leftJoin(user, eq(user.id, saasOutreach.createdBy))
    .where(
      and(
        eq(saasOutreach.channel, "correo"),
        sql`${outreachThreadKeySql("saas_outreach")} = ${threadKey}`,
      ),
    )
    .orderBy(asc(saasOutreach.createdAt), asc(saasOutreach.id))
  const fileIds = [...new Set(replies.flatMap(({ row }) => row.fileIds))]
  const fileRows = fileIds.length
    ? await tx
        .select({
          id: saasClientFile.id,
          filename: saasClientFile.filename,
          contentType: saasClientFile.contentType,
          size: saasClientFile.sizeBytes,
        })
        .from(saasClientFile)
        .where(inArray(saasClientFile.id, fileIds))
    : []
  const fileOf = new Map(fileRows.map((file) => [file.id, file]))
  // Lo que diría «¿Es la carga de datos?» de cada adjunto ya guardado.
  const attachmentIds = [
    ...new Set(
      emails.flatMap((email) =>
        (email.attachments as SaasInboundAttachment[]).flatMap((attachment) =>
          attachment.fileId ? [attachment.fileId] : [],
        ),
      ),
    ),
  ]
  const attachmentFiles = new Map(
    (attachmentIds.length
      ? await tx
          .select({
            id: saasClientFile.id,
            kind: saasClientFile.kind,
            receivedAt: saasClientFile.receivedAt,
            deletedAt: saasClientFile.deletedAt,
          })
          .from(saasClientFile)
          .where(inArray(saasClientFile.id, attachmentIds))
      : []
    ).map((file) => [file.id, file]),
  )
  // El texto de un correo que trajo la carga de datos se borra con ella a los 30 días.
  const withCarga = new Set(
    (
      await tx
        .select({ emailId: saasClientFile.inboundEmailId })
        .from(saasClientFile)
        .where(
          and(
            inArray(saasClientFile.inboundEmailId, emailIds),
            eq(saasClientFile.kind, "archivo_clinica"),
          ),
        )
    ).map((file) => file.emailId),
  )
  const [row] = await conversationRows(tx, now, { threadKey })
  const conversation = row ? stateOf(row) : null

  const client: InboxClient | null = row?.client_id
    ? {
        id: row.client_id,
        name: row.client_name ?? "",
        phase: phaseOf(row.client_phase),
        product: row.client_product,
        hasApp: Boolean(row.client_has_app),
      }
    : null
  const suggestion = client ? null : await threadSuggestion(tx, replies, latest)

  const product: ClinicalProduct =
    [client?.product, latest.product].find(
      (value): value is ClinicalProduct => !!value && isClinicalProduct(value),
    ) ?? "dental"
  const mailbox = latest.mailbox as SaasInboundMailbox
  const sender = await outreachSenderPreview(tx, staff, product, mailbox)

  const inbound: EmailThreadEntry[] = emails.map((email) => ({
    kind: "entro",
    id: email.id,
    at: email.receivedAt,
    fromName: email.fromName,
    fromAddress: email.fromAddress,
    to: email.toAddress,
    subject: email.subject,
    text: email.textBody,
    textDeleted: email.textBody === null && withCarga.has(email.id),
    notice: email.notice,
    senderVerified: email.senderVerified,
    attachments: (email.attachments as SaasInboundAttachment[]).map((attachment) => {
      const file = attachment.fileId ? attachmentFiles.get(attachment.fileId) : undefined
      return {
        fileId: attachment.fileId ?? null,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        ...(file ? inboundFileCarga(file, now) : { cargaDeleteAfter: null, cargaDueNow: false }),
      }
    }),
  }))
  const outbound: EmailThreadEntry[] = replies.map(({ row: reply, authorName }) => ({
    kind: "salio",
    id: reply.id,
    at: reply.sentAt ?? reply.createdAt,
    by: reply.createdBy ? { id: reply.createdBy, name: authorName ?? "" } : null,
    byKairos: reply.byKairos,
    from: reply.fromAddress,
    to: reply.toAddress,
    subject: reply.subject,
    body: reply.body,
    status: reply.status,
    sentAt: reply.sentAt,
    files: reply.fileIds.flatMap((id) => {
      const file = fileOf.get(id)
      return file ? [file] : []
    }),
    canResolve: reply.status === "incierto" || reply.status === "pendiente",
  }))
  // Por hora; a la misma hora, lo que llegó antes de lo que salió.
  const entries = [...inbound, ...outbound].sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() || (a.kind === b.kind ? 0 : a.kind === "entro" ? -1 : 1),
  )

  return {
    emailId: latest.id,
    threadKey,
    subject: latest.subject,
    mailbox,
    product,
    client,
    suggestion,
    state: conversation?.state ?? "te_toca",
    stateWhy: conversation?.stateWhy ?? null,
    attendedBy: conversation?.attendedBy ?? null,
    settledAt: conversation?.settledAt ?? null,
    entries,
    reply: {
      emailId: latest.id,
      to: latest.replyTo ?? latest.fromAddress,
      from: sender ? `${sender.name} <${sender.address}>` : null,
      subject: replySubject(latest.subject),
      signature: sender ? replySignature(sender, product) : null,
      canReply: Boolean(sender),
      why: sender ? null : "Tu acceso al equipo ya no está activo",
    },
    rules: channelRulesOf("correo"),
    draft: await threadDraft(tx, latest.id, now),
  }
}

/**
 * De quién puede ser un hilo sin cliente, sin ligarlo: el cliente de lo que le escribimos en ese
 * hilo, o el de su correo exacto (`matchInboundClient`: un contacto, su solicitud, alguien de su
 * cuenta). Si el remitente no está verificado, se dice: puede no ser quien dice.
 */
async function threadSuggestion(
  tx: Db,
  replies: ReadonlyArray<{ row: typeof saasOutreach.$inferSelect }>,
  latest: typeof saasInboundEmail.$inferSelect,
): Promise<EmailThread["suggestion"]> {
  const unverified = latest.senderVerified
    ? ""
    : ", pero el remitente no está verificado: confírmalo antes de ligarlo"
  const ours = replies.find(({ row }) => row.clientId)?.row.clientId ?? null
  const match = ours
    ? { clientId: ours, why: "Responde un correo que le escribimos a esta clínica" }
    : await matchInboundClient(tx, latest.fromAddress).then((found) =>
        found ? { clientId: found.clientId, why: MATCH_WHY[found.matchedBy] ?? "" } : null,
      )
  if (!match) return null
  const [client] = await tx
    .select({ name: saasClient.name, archivedAt: saasClient.archivedAt })
    .from(saasClient)
    .where(eq(saasClient.id, match.clientId))
    .limit(1)
  if (!client || client.archivedAt) return null
  return { clientId: match.clientId, clientName: client.name, why: `${match.why}${unverified}` }
}

/**
 * La respuesta que dejó lista Kairós para el último correo que llegó del hilo, la más nueva que
 * sigue en espera. La de un correo anterior no: contestaría lo de antes, no lo último.
 */
async function threadDraft(tx: Db, latestId: string, now: Date): Promise<EmailThread["draft"]> {
  const [item] = await tx
    .select()
    .from(kairosItem)
    .where(
      and(
        eq(kairosItem.kind, "responder_correo"),
        eq(kairosItem.status, "espera"),
        gt(kairosItem.expiresAt, now),
        sql`jsonb_typeof(${kairosItem.payload} -> 'draft') = 'object'`,
        sql`${kairosItem.payload} ->> 'emailId' = ${latestId}`,
      ),
    )
    .orderBy(desc(kairosItem.createdAt), desc(kairosItem.id))
    .limit(1)
  if (!item) return null
  const draft = (item.payload.draft ?? {}) as {
    subject?: unknown
    body?: unknown
    drafter?: unknown
  }
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null)
  const body = text(draft.body) ?? text(item.payload.body)
  if (!body) return null
  return {
    itemId: item.id,
    emailId: latestId,
    subject: text(draft.subject),
    body,
    reason: text(item.reason),
    facts: Array.isArray(item.payload.facts)
      ? item.payload.facts.filter((fact): fact is string => typeof fact === "string")
      : [],
    drafter: draft.drafter === "plantilla" ? "plantilla" : "modelo",
    note: text(item.payload.draftNote),
  }
}

/* ---------- Lo que marca una persona ---------- */

export interface AttendedThread {
  threadKey: string
  attendedBy: { id: string; name: string } | null
  attendedAt: Date | null
}

async function staffName(tx: Db, userId: string): Promise<string> {
  const [row] = await tx.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1)
  return row?.name ?? ""
}

/**
 * «Lo atiendo yo» en un correo (`on`), o soltarlo. Como la pausa de un chat: si ya lo atiende
 * alguien, sigue siendo esa persona; soltarlo lo puede cualquiera de Administración.
 */
export async function attendEmailThread(
  tx: Db,
  actor: AdminActor | null,
  emailId: string,
  on: boolean,
  now = new Date(),
): Promise<AttendedThread> {
  const staff = requireAdmin(actor)
  const threadKey = await markableThreadKey(tx, emailId)
  // La marca puede estar con la clave de antes del hilo (`threadMarkKeys`).
  const keys = await threadMarkKeys(tx, threadKey)
  let changed = false
  let mark: { attendedBy: string | null; attendedAt: Date | null } | undefined
  if (on) {
    const [taken] = await tx
      .select({
        attendedBy: saasConversationMark.attendedBy,
        attendedAt: saasConversationMark.attendedAt,
      })
      .from(saasConversationMark)
      .where(
        and(
          inArray(saasConversationMark.threadKey, keys),
          isNotNull(saasConversationMark.attendedBy),
        ),
      )
      .orderBy(desc(saasConversationMark.attendedAt))
      .limit(1)
      .for("update")
    if (taken) mark = taken
    else {
      const upserted = await tx
        .insert(saasConversationMark)
        .values({
          threadKey,
          attendedBy: staff.userId,
          attendedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: saasConversationMark.threadKey,
          set: {
            attendedBy: sql`coalesce(${saasConversationMark.attendedBy}, excluded.attended_by)`,
            attendedAt: sql`(case when ${saasConversationMark.attendedBy} is null
              then excluded.attended_at else ${saasConversationMark.attendedAt} end)`,
            updatedAt: now,
          },
        })
        .returning()
      mark = upserted[0]
      // Lo dejó esta persona ahora (si ya lo atendía alguien, sigue esa persona y no cambió nada).
      changed = mark?.attendedBy === staff.userId && mark.attendedAt?.getTime() === now.getTime()
    }
  } else {
    const released = await tx
      .update(saasConversationMark)
      .set({ attendedBy: null, attendedAt: null, updatedAt: now })
      .where(
        and(
          inArray(saasConversationMark.threadKey, keys),
          isNotNull(saasConversationMark.attendedBy),
        ),
      )
      .returning()
    changed = released.length > 0
    mark = released[0]
  }
  if (changed)
    await writeAdminAudit(tx, staff, {
      action: "arm.inbox_attended",
      entityId: emailId,
      metadata: { kind: "correo", emailId, threadKey, on },
    })
  const attendedBy = on && mark?.attendedBy ? mark.attendedBy : null
  return {
    threadKey,
    attendedBy: attendedBy ? { id: attendedBy, name: await staffName(tx, attendedBy) } : null,
    attendedAt: attendedBy ? (mark?.attendedAt ?? null) : null,
  }
}

export interface ConversationTarget {
  kind: "chat" | "correo"
  /** El chat, o cualquier correo del hilo. */
  id: string
}

export interface SettledConversation {
  kind: "chat" | "correo"
  id: string
  settledAt: Date | null
  settledBy: { id: string; name: string } | null
}

/** La marca de la conversación: `chat_id` del chat o `thread_key` del hilo. */
async function markTargetOf(
  tx: Db,
  target: ConversationTarget,
): Promise<{ chatId: string } | { threadKey: string }> {
  if (target.kind === "chat") {
    if (!UUID.test(target.id ?? "")) throw notFound("Conversación")
    const [chat] = await tx
      .select({ id: saasChat.id })
      .from(saasChat)
      .where(eq(saasChat.id, target.id))
      .limit(1)
    if (!chat) throw notFound("Conversación")
    return { chatId: chat.id }
  }
  if (target.kind === "correo") return { threadKey: await markableThreadKey(tx, target.id) }
  throw invalidField("kind", "Elige un chat o un correo")
}

/**
 * «No necesita respuesta»: lo que llegó hasta ahora ya no espera (si vuelve a escribir, la
 * conversación vuelve a «Te toca»). No envía nada ni cierra lo que preparó Kairós.
 */
export async function settleConversation(
  tx: Db,
  actor: AdminActor | null,
  target: ConversationTarget,
  now = new Date(),
): Promise<SettledConversation> {
  const staff = requireAdmin(actor)
  const key = await markTargetOf(tx, target)
  const set = { settledBy: staff.userId, settledAt: now, updatedAt: now }
  await tx
    .insert(saasConversationMark)
    .values({ ...key, ...set, createdAt: now })
    .onConflictDoUpdate({
      target: "chatId" in key ? saasConversationMark.chatId : saasConversationMark.threadKey,
      set,
    })
  await writeAdminAudit(tx, staff, {
    action: "arm.inbox_settled",
    entityId: target.id,
    metadata: { kind: target.kind, ...key },
  })
  return {
    kind: target.kind,
    id: target.id,
    settledAt: now,
    settledBy: { id: staff.userId, name: await staffName(tx, staff.userId) },
  }
}

/** Deshace «No necesita respuesta»: la conversación vuelve a leerse por lo que entró y salió. */
export async function unsettleConversation(
  tx: Db,
  actor: AdminActor | null,
  target: ConversationTarget,
  now = new Date(),
): Promise<SettledConversation> {
  const staff = requireAdmin(actor)
  const key = await markTargetOf(tx, target)
  const undone = await tx
    .update(saasConversationMark)
    .set({ settledBy: null, settledAt: null, updatedAt: now })
    .where(
      and(
        "chatId" in key
          ? eq(saasConversationMark.chatId, key.chatId)
          : // También la que quedó con la clave de antes del hilo.
            inArray(saasConversationMark.threadKey, await threadMarkKeys(tx, key.threadKey)),
        isNotNull(saasConversationMark.settledAt),
      ),
    )
    .returning({ id: saasConversationMark.id })
  if (undone.length > 0)
    await writeAdminAudit(tx, staff, {
      action: "arm.inbox_unsettled",
      entityId: target.id,
      metadata: { kind: target.kind, ...key },
    })
  return { kind: target.kind, id: target.id, settledAt: null, settledBy: null }
}
