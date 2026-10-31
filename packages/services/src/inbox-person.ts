import type { Db } from "@odentia/db"
import { and, type SQL, sql } from "drizzle-orm"
import {
  CONVERSATION_VIEWS,
  type ConversationView,
  conversationViewSql,
  handoffOpenExistsSql,
  personKeySql,
  VIEW_URGENCY,
} from "./conversation-state.js"
import {
  type ConversationFilters,
  conversationCursor,
  conversationFilterConditions,
} from "./conversations.js"
import { encodeCursor } from "./cursors.js"
import { validation } from "./errors.js"
import { handoffOpenSql } from "./handoff-state.js"
import { windowOpen } from "./message-window.js"

/**
 * Una fila por persona en la Bandeja (fase 4 del pulido, ADR 0076). Por
 * debajo todo sigue por canal (cada conversación con su tema, su cierre, su
 * espera de 15 minutos y lo que tiene sin leer); aquí solo se junta lo que
 * ve el equipo: la lista y sus totales cuentan personas y cada persona está
 * en el estado más urgente de sus conversaciones (`VIEW_URGENCY`).
 */

/** Una persona de la lista. */
export interface PersonRow {
  /** La conversación que la fila muestra: la más urgente y, entre iguales, la del último mensaje. */
  id: string
  /** Sus conversaciones con los filtros dados: la fila sigue elegida al abrir cualquiera. */
  conversationIds: string[]
  /** Sus canales, primero el de la conversación que se muestra. */
  channels: string[]
  /** Lo que tiene sin leer en todos sus canales. */
  unreadCount: number
  /** La última vez que alguien escribió, por cualquier canal. */
  lastAt: string
}

/**
 * Las conversaciones filtradas (`b`) y, de cada una, la persona y su lugar en
 * `VIEW_URGENCY` (`f`). Primero los filtros, materializados, y después una
 * consulta por vista, unidas: las vistas no se superponen, así cada
 * conversación sale una vez, y cada vista resuelve sus subconsultas de una
 * sola vez. Juntas en un `case`, o con las vistas dentro del join con
 * `contact`, Postgres las repite fila por fila (de 0,3 s a 3,6 s con 1.500
 * conversaciones). Lo que no está en ninguna vista no sale.
 */
function filteredCtes(orgId: string, filters: ConversationFilters): SQL {
  const base = sql.raw("b")
  const parts = VIEW_URGENCY.map(
    (view, index) => sql`
    select b.id, ${personKeySql(base)} as person_key, ${sql.raw(String(index))} as rank,
      ${view === "attend" ? handoffOpenExistsSql(base) : sql`false`} as topic,
      coalesce(b.last_message_at, b.created_at) as at, b.unread_count as unread, b.channel
    from b where ${conversationViewSql(base, view)}`,
  )
  return sql`
    b as materialized (
      select "conversation".*, "channel_connection"."channel" as channel
      from "conversation"
      join "contact" on "contact"."id" = "conversation"."contact_id"
      join "channel_connection" on "channel_connection"."id" = "conversation"."channel_connection_id"
      where ${and(...conversationFilterConditions(orgId, filters))}
    ),
    f as (${sql.join(parts, sql` union all `)})`
}

function rankOf(view: ConversationView): number {
  if (!(CONVERSATION_VIEWS as readonly string[]).includes(view)) {
    throw validation(`Vista inválida (${CONVERSATION_VIEWS.join("|")})`)
  }
  return VIEW_URGENCY.indexOf(view)
}

/**
 * Las personas de una vista, de la que escribió más recientemente a la que
 * menos. Con una vista, el estado (abierta o cerrada) no filtra: cada vista
 * ya lo dice, y Rosa con un canal por atender y otro cerrado está solo en
 * «Por atender», como en los totales.
 */
export async function listPersonRows(
  tx: Db,
  orgId: string,
  input: ConversationFilters & { view?: ConversationView; cursor?: string; limit?: number },
): Promise<{ rows: PersonRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100)
  const { view, cursor, limit: _limit, ...rest } = input
  const filters = view === undefined ? rest : { ...rest, status: undefined }
  const conditions: SQL[] = []
  if (view !== undefined) conditions.push(sql`l.rank = ${sql.raw(String(rankOf(view)))}`)
  if (cursor) {
    const decoded = conversationCursor(cursor)
    const ts = sql`${decoded.ts}::timestamptz`
    conditions.push(sql`(g.at < ${ts} or (g.at = ${ts} and l.person_key < ${decoded.id}::uuid))`)
  }
  const found = await tx.execute<{
    id: string
    person_key: string
    channel: string
    unread: number
    channels: string[]
    ids: string[]
    at: string
  }>(sql`
    with ${filteredCtes(orgId, filters)},
    l as (
      -- La más urgente; en «Por atender», primero la que tiene el tema: es la que hay que responder.
      select distinct on (person_key) person_key, id, rank, channel
      from f order by person_key, rank, topic desc, at desc, id desc
    ),
    g as (
      select person_key, max(at) as at, sum(unread)::int as unread,
        array_agg(distinct channel) as channels, array_agg(id) as ids
      from f group by person_key
    )
    select l.id, l.person_key, l.channel, g.unread, g.channels, g.ids,
      to_char(g.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
    from l join g on g.person_key = l.person_key
    ${conditions.length > 0 ? sql`where ${and(...conditions)}` : sql``}
    -- La persona es la fila: el cursor sigue a la persona, aunque cambie la conversación que la muestra.
    order by g.at desc, l.person_key desc
    limit ${limit + 1}`)
  const page = found.slice(0, limit)
  const rows = page.map((row) => ({
    id: row.id,
    conversationIds: row.ids,
    channels: [row.channel, ...row.channels.filter((channel) => channel !== row.channel)],
    unreadCount: Number(row.unread),
    lastAt: row.at,
  }))
  const last = page[page.length - 1]
  return {
    rows,
    nextCursor: found.length > limit && last ? encodeCursor(last.at, last.person_key) : null,
  }
}

/** Cuántas personas hay en cada vista con los filtros dados (sin el estado: cada vista lo dice). */
export async function countPersonViews(
  tx: Db,
  orgId: string,
  input: ConversationFilters,
): Promise<Record<ConversationView, number>> {
  const { status: _status, ...filters } = input
  const counts = VIEW_URGENCY.map(
    (view, index) =>
      sql`(count(*) filter (where rank = ${sql.raw(String(index))}))::int as ${sql.identifier(view)}`,
  )
  const [row] = await tx.execute<Record<ConversationView, number>>(sql`
    with ${filteredCtes(orgId, filters)},
    p as (select min(rank) as rank from f group by person_key)
    select ${sql.join(counts, sql`, `)} from p`)
  return Object.fromEntries(VIEW_URGENCY.map((view) => [view, Number(row?.[view] ?? 0)])) as Record<
    ConversationView,
    number
  >
}

/** Un canal de la persona en el hilo: por dónde se le puede responder. */
export interface PersonChannel {
  conversationId: string
  channel: string
  provider: string
  connectionName: string
  status: string
  /**
   * WhatsApp, Instagram y Messenger: «open» si escribió en las últimas 24
   * horas, «closed» si no. Nulo en los canales sin ventana.
   */
  replyWindow: "open" | "closed" | null
  /** Si su conexión está activa: por una apagada en Configuración no sale nada. */
  connectionActive: boolean
  /** Temas sin resolver en ese canal. */
  topics: number
  lastMessageAt: string | null
}

/** Los proveedores que solo dejan escribir libremente 24 horas después de lo último de la persona. */
const WINDOW_PROVIDERS = ["whatsapp_cloud_api", "instagram", "messenger"]

/**
 * Los canales de la persona de una conversación, del último que usó al
 * primero, para «Responder por» (decisión 6 del pulido).
 */
export async function personChannels(
  tx: Db,
  orgId: string,
  conversationId: string,
  now: Date,
): Promise<{ channels: PersonChannel[]; unreadCount: number }> {
  const rows = await tx.execute<{
    id: string
    channel: string
    provider: string
    display_name: string
    status: string
    connection_status: string
    last_inbound_at: Date | string | null
    last_message_at: Date | string | null
    unread_count: number
    topics: number
  }>(sql`
    select c2.id, cn.channel, cn.provider, cn.display_name, c2.status, cn.status as connection_status, c2.last_inbound_at, c2.last_message_at,
      c2.unread_count,
      (select count(*)::int from agent_handoff h
        where h.organization_id = c2.organization_id and h.conversation_id = c2.id and ${handoffOpenSql(sql.raw("h"))}) as topics
    from conversation c1
    join conversation c2 on c2.organization_id = c1.organization_id and ${personKeySql(sql.raw("c2"))} = ${personKeySql(sql.raw("c1"))}
    join channel_connection cn on cn.id = c2.channel_connection_id
    where c1.id = ${conversationId}::uuid and c1.organization_id = ${orgId}
    order by coalesce(c2.last_message_at, c2.created_at) desc, c2.id desc`)
  const iso = (value: Date | string | null) =>
    value === null ? null : new Date(value).toISOString()
  return {
    channels: rows.map((row) => ({
      conversationId: row.id,
      channel: row.channel,
      provider: row.provider,
      connectionName: row.display_name,
      status: row.status,
      replyWindow: WINDOW_PROVIDERS.includes(row.provider)
        ? windowOpen(iso(row.last_inbound_at), now)
          ? "open"
          : "closed"
        : null,
      connectionActive: row.connection_status === "active",
      topics: Number(row.topics),
      lastMessageAt: iso(row.last_message_at),
    })),
    unreadCount: rows.reduce((sum, row) => sum + Number(row.unread_count), 0),
  }
}
