import type { Db } from "@odentia/db"
import {
  agentAnswerTrace,
  agentKnowledgeEntry,
  agentKnowledgeGap,
  agentLesson,
  agentReviewItem,
  agentTestCase,
  type AnswerBasisItem,
  type AnswerCheck,
  CORRECTION_FAILURES,
  type CorrectionFailure,
  LESSON_KINDS,
  type LessonKind,
  type LessonSource,
  type LessonStatus,
  type ReviewReason,
  agentHandoff,
} from "@odentia/db/schema/agent"
import { user } from "@odentia/db/schema/auth"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm"
import { looksClinical } from "./agent-person-memory.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import {
  addAskFormsToAnswer,
  ASK_FORM_CHARS,
  ASK_FORM_LIMIT,
  createKnowledgeEntry,
  getKnowledgeEntry,
  type KnowledgeEntryItem,
  listActiveKnowledge,
  normalizeForSearch,
  scoreKnowledgeMatch,
  setKnowledgeStatus,
  updateKnowledgeEntry,
} from "./knowledge.js"

/* ---------- Aprender: revisar lo dudoso, corregir y aprobar lo que el agente aprende ---------- */

/** Una de cada tantas respuestas enviadas entra en revisión como muestra al azar. */
export const REVIEW_SAMPLE_ONE_IN = 20
/** Solo se revisa lo reciente: una respuesta de hace semanas ya no enseña nada urgente. */
const REVIEW_WINDOW_DAYS = 14
/** Si alguien del equipo escribe dentro de este plazo tras la respuesta, cuenta como que tomó la conversación. */
const TEAM_TOOK_MINUTES = 120
const REVIEW_PENDING_LIMIT = 50
/** Lo que no encontró entra cuando ya respondió; si tras este plazo no hay respuesta, entra sin ella. */
const GAP_REPLY_WAIT_MINUTES = 10
const GAP_WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** Un mensaje así de corto («Si», «Gracias») no se puede juzgar sin lo que se le dijo antes. */
const SHORT_MESSAGE_WORDS = 3
const LESSON_BODY_CHARS = 2000
const LESSON_TITLE_CHARS = 200
/**
 * Reglas activas de un agente: todas le llegan en cada mensaje (decisión 17 de
 * la fase 4), así que no se pasa de este tope (ADR 0119). La regla que
 * sobraría se aprueba reemplazando otra; agregar o restaurar una pide quitar
 * otra antes. Una clínica que ya tenía más conserva las suyas: van las más
 * recientes y el agente y «Aprender» dicen cuántas quedaron fuera.
 */
export const LESSON_RULE_LIMIT = 40
/**
 * Lo que mide una regla, como mucho. Va entera en cada mensaje: una regla
 * larga casi siempre es un ejemplo o una respuesta oficial (ADR 0119).
 */
export const RULE_BODY_CHARS = 300
/** Ejemplos que acompañan un turno: solo los parecidos a lo que se pregunta. */
export const LESSON_EXAMPLE_LIMIT = 2
/** Puntuación mínima para decir que una pregunta toca el tema de una lección o de un caso. */
const TOPIC_SCORE = 30
/** Puntuación mínima para proponer cambiar una respuesta oficial existente en vez de crear otra. */
const SAME_ANSWER_SCORE = 300

/** Qué clase de lección propone cada falla: la pantalla lo dice antes de enviar. */
export const LESSON_KIND_BY_FAILURE: Record<CorrectionFailure, LessonKind> = {
  dato_equivocado: "respuesta_oficial",
  falto_dato: "respuesta_oficial",
  no_debio_responder: "regla",
  tono: "ejemplo",
  otra_cosa: "ejemplo",
}

export interface ReviewItem {
  id: string
  agent: string
  conversationId: string
  /** Nula en lo que no encontró cuando su aviso fue un pase al equipo: esos no dejan traza. */
  traceId: string | null
  reason: ReviewReason
  /** Lo que buscó sin encontrar nada (`no_encontro`). */
  query: string | null
  /** Las veces que se buscó lo mismo (`no_encontro`) y, de esas, las de los últimos siete días. */
  asked: { total: number; week: number } | null
  /** Lo último que se le dijo, si lo que escribió es tan corto que no se entiende solo. */
  before: string | null
  /** Lo que el interlocutor escribió seguido antes de esa respuesta. */
  question: string
  reply: string
  teamReply: string | null
  status: "pendiente" | "bien" | "corregida"
  contactName: string | null
  channel: string | null
  basis: AnswerBasisItem[]
  checks: AnswerCheck[]
  createdAt: string
}

/** De dónde sale una lección: una corrección o una respuesta que se dio por buena. */
export type LessonOrigin = "correccion" | "respuesta_buena"

export interface LessonItem {
  id: string
  kind: LessonKind
  /** `escrita`: la escribió la clínica; `aprendida`: salió de una corrección o de una respuesta buena. */
  source: LessonSource
  scope: string
  /** El agente cuya respuesta la originó; una respuesta oficial es de toda la clínica (`scope`), pero nace de uno. */
  agent: string
  origin: LessonOrigin
  /** Quien recibió la respuesta que la originó. */
  contactName: string | null
  title: string
  question: string
  body: string
  failure: CorrectionFailure | null
  originalReply: string
  status: LessonStatus
  conversationId: string | null
  knowledgeEntryId: string | null
  /** Título y texto vigentes de la respuesta oficial que la lección cambia o creó. */
  knowledgeEntry: { title: string; body: string } | null
  previousBody: string | null
  uses: number
  lastUsedAt: string | null
  proposedByName: string | null
  approvedByName: string | null
  approvedAt: string | null
  withdrawnAt: string | null
  createdAt: string
}

export interface LessonImpact {
  /** Casos de prueba activos de ese agente. */
  total: number
  /** Los que tocan el tema de la lección: son los que pueden cambiar. */
  touched: Array<{ id: string; question: string; expected: string }>
}

export interface TestCaseItem {
  id: string
  agent: string
  question: string
  expected: string
  lessonId: string | null
  status: "activo" | "retirado"
  createdAt: string
}

/** `field`: el nombre del dato en el cuerpo, para decir el error junto a él. */
function cleanText(value: unknown, field: string, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw invalidField(field, `${label} es obligatorio`)
  const text = value.trim()
  if (text.length > max) throw invalidField(field, `${label} admite hasta ${max} caracteres`)
  return text
}

function shorten(text: string, max: number): string {
  const clean = text.replace(/[ \t\r\n]+/g, " ").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

/** Reglas activas de un agente. */
export async function countActiveRules(tx: Db, orgId: string, scope: string): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(agentLesson)
    .where(and(eq(agentLesson.organizationId, orgId), eq(agentLesson.status, "activa"), eq(agentLesson.kind, "regla"), eq(agentLesson.scope, scope)))
  return row?.total ?? 0
}

/** Que una regla más no pase del tope: si no cabe, se dice qué hacer. */
export async function assertRuleRoom(tx: Db, orgId: string, scope: string, doing: "aprobar" | "agregar" | "restaurar"): Promise<void> {
  // Dos aprobaciones a la vez con 39 reglas no pueden dejar 41: se cuenta de a una, hasta el fin de la transacción.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent_rules:${orgId}:${scope}`}))`)
  if ((await countActiveRules(tx, orgId, scope)) < LESSON_RULE_LIMIT) return
  throw new ServiceError(
    "RULE_LIMIT",
    409,
    doing === "aprobar"
      ? `Ya hay ${LESSON_RULE_LIMIT} reglas: elige cuál reemplaza esta`
      : `Ya hay ${LESSON_RULE_LIMIT} reglas: retira o une una antes de ${doing} otra`,
  )
}

/** Una regla larga no se activa: llegaría cortada. */
function assertRuleLength(body: string, field: string): void {
  if (body.length > RULE_BODY_CHARS) {
    throw invalidField(field, `Una regla admite hasta ${RULE_BODY_CHARS} caracteres: lo más largo va mejor como ejemplo o respuesta oficial`)
  }
}

function scopeOf(kind: LessonKind, agent: string): string {
  // Un dato es de toda la clínica; una regla o un ejemplo, solo del agente que lo recibió.
  return kind === "respuesta_oficial" ? "clinica" : agent
}

async function audit(tx: Db, orgId: string, actorUserId: string | null, action: string, entity: string, entityId: string, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action, entity, entityId, metadata })
}

function wordsOf(text: string): Set<string> {
  return new Set(normalizeForSearch(text).split(" ").filter((word) => word.length >= 3))
}

/** Dos textos preguntan lo mismo si comparten casi todas sus palabras. */
function sameQuestion(a: string, b: string): boolean {
  const left = wordsOf(a)
  const right = wordsOf(b)
  if (left.size === 0 || right.size === 0) return false
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / Math.min(left.size, right.size) >= 0.6 && shared >= 2
}

/* ---------- Por revisar ---------- */

/**
 * Lo que el interlocutor escribió seguido hasta el mensaje `q`, sin nada de la
 * clínica en medio: sus últimos mensajes, los mismos que se muestran al corregir.
 */
const WRITTEN_UP_TO_Q = sql`(
  select string_agg(w.body, E'\n' order by w.created_at) from (
    select b.body, b.created_at from message b
    where b.organization_id = q.organization_id and b.conversation_id = q.conversation_id
      and b.direction = 'in' and b.body is not null and b.created_at <= q.created_at
      and not exists (
        select 1 from message o
        where o.organization_id = q.organization_id and o.conversation_id = q.conversation_id
          and o.direction = 'out' and o.created_at > b.created_at and o.created_at < q.created_at)
    order by b.created_at desc limit 12
  ) w)`

/**
 * Lo escrito se guarda hasta este largo. Si pasa, se conserva lo último: es lo
 * que se respondió.
 */
const WRITTEN_CHARS = 2000

/**
 * Dos preguntas abiertas son la misma si se buscó lo mismo o se escribió lo
 * mismo. Lo corto no agrupa: el «Si» de dos personas no es la misma pregunta.
 */
function gapKeys(gap: { query: string; question: string }): string[] {
  const searched = normalizeForSearch(gap.query)
  const written = normalizeForSearch(gap.question)
  return [
    ...(searched ? [`buscado:${searched}`] : []),
    ...(written.split(" ").length > SHORT_MESSAGE_WORDS ? [`escrito:${written}`] : []),
  ]
}

/**
 * Una pregunta abierta que todavía no tiene fila. Espera a que Sofi responda (el
 * mismo turno, en segundos), para que el número y la lista digan lo mismo; si no
 * llega a responder, entra igual pasado el plazo.
 */
const unreviewedGap = (orgId: string) => sql`
  g.organization_id = ${orgId} and g.status = 'abierta' and g.review_item_id is null
  and not exists (select 1 from conversation c where c.organization_id = g.organization_id and c.id = g.conversation_id and c.is_test)
  and (g.created_at < now() - make_interval(mins => ${GAP_REPLY_WAIT_MINUTES}) or exists (
    select 1 from message m
    where m.organization_id = g.organization_id and m.conversation_id = g.conversation_id
      and m.direction = 'out' and m.sender_kind = 'agent' and m.body is not null and m.created_at > g.created_at))`

/** Las búsquedas de las filas de «Buscó y no encontró» que siguen esperando, para sumarles las que se repiten. */
async function pendingGapKeys(tx: Db, orgId: string): Promise<Map<string, string>> {
  const linked = await tx
    .select({ reviewItemId: agentReviewItem.id, query: agentKnowledgeGap.query, question: agentKnowledgeGap.question })
    .from(agentKnowledgeGap)
    .innerJoin(agentReviewItem, eq(agentReviewItem.id, agentKnowledgeGap.reviewItemId))
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.status, "pendiente"), eq(agentReviewItem.reason, "no_encontro")))
  const keys = new Map<string, string>()
  for (const row of linked) for (const key of gapKeys(row)) keys.set(key, row.reviewItemId)
  return keys
}

/**
 * Lo que buscó sin encontrar nada entra a «Por revisar», una fila por búsqueda.
 * Sale de las preguntas abiertas y no de la traza: lo que no encuentra suele
 * terminar en un pase al equipo, y ese aviso no deja traza. Lo que respondió se
 * lee del mensaje que le siguió, ya salga de una respuesta o de ese aviso.
 */
async function syncGapsIntoReview(tx: Db, orgId: string): Promise<number> {
  const [waiting] = await tx.execute<{ any: boolean }>(sql`select exists (select 1 from agent_knowledge_gap g where ${unreviewedGap(orgId)}) as any`)
  if (!waiting?.any) return 0
  // Dos pestañas a la vez no crean dos filas de la misma búsqueda.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent_review_gaps:${orgId}`}))`)
  const gaps = await tx.execute<{
    id: string
    conversation_id: string
    agent: string
    trigger_message_id: string | null
    question: string
    query: string
    created_at: Date | string
    written: string | null
    reply: string | null
    team_reply: string | null
    trace_id: string | null
  }>(sql`
    select g.id, g.conversation_id, g.agent, g.trigger_message_id, g.question, g.query, g.created_at,
           ${WRITTEN_UP_TO_Q} as written,
           reply.body as reply, team.body as team_reply, tr.id as trace_id
    from agent_knowledge_gap g
    left join message q on q.organization_id = g.organization_id and q.id = g.trigger_message_id
    left join lateral (
      select m.body from message m
      where m.organization_id = g.organization_id and m.conversation_id = g.conversation_id
        and m.direction = 'out' and m.sender_kind = 'agent' and m.body is not null and m.created_at > g.created_at
        -- Pasado el plazo ya no es la respuesta a esto: puede ser otro tema, días después.
        and m.created_at <= g.created_at + make_interval(mins => ${GAP_REPLY_WAIT_MINUTES})
      order by m.created_at asc limit 1
    ) reply on true
    left join lateral (
      select m.body from message m
      where m.organization_id = g.organization_id and m.conversation_id = g.conversation_id
        and m.direction = 'out' and m.sender_kind = 'user' and m.body is not null and m.created_at > g.created_at
      order by m.created_at asc limit 1
    ) team on true
    left join lateral (
      select t.id from agent_answer_trace t
      where t.organization_id = g.organization_id and t.conversation_id = g.conversation_id
        and t.trigger_message_id = g.trigger_message_id and t.outcome = 'enviada'
      order by t.created_at desc limit 1
    ) tr on true
    where ${unreviewedGap(orgId)}
    -- De la más antigua a la más nueva: cada una suma sus llaves a la fila, y así la que
    -- comparte lo buscado con una y lo escrito con otra no abre una fila más.
    order by g.created_at asc
    limit 300`)
  const keys = await pendingGapKeys(tx, orgId)
  let added = 0
  for (const gap of gaps) {
    const gapKeysOf = gapKeys(gap)
    let reviewItemId = gapKeysOf.map((key) => keys.get(key)).find((id) => id !== undefined)
    if (!reviewItemId) {
      // La respuesta ya pudo entrar por otra señal: se queda en esa fila, ahora con este motivo.
      const [taken] = gap.trace_id
        ? await tx
            .select({ id: agentReviewItem.id, status: agentReviewItem.status })
            .from(agentReviewItem)
            .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.traceId, gap.trace_id)))
            .limit(1)
        : []
      if (taken && taken.status !== "pendiente") {
        // Esa respuesta ya se decidió: la pregunta sigue la suerte de su fila y no se revisa dos veces.
        await tx
          .update(agentKnowledgeGap)
          .set({ reviewItemId: taken.id, status: taken.status === "bien" ? "descartada" : "resuelta", resolvedAt: new Date() })
          .where(eq(agentKnowledgeGap.id, gap.id))
        continue
      }
      if (taken) {
        await tx
          .update(agentReviewItem)
          .set({ reason: "no_encontro", query: gap.query, triggerMessageId: gap.trigger_message_id })
          .where(eq(agentReviewItem.id, taken.id))
        reviewItemId = taken.id
      } else {
        const [row] = await tx
          .insert(agentReviewItem)
          .values({
            organizationId: orgId,
            agent: gap.agent,
            conversationId: gap.conversation_id,
            traceId: gap.trace_id,
            triggerMessageId: gap.trigger_message_id,
            reason: "no_encontro",
            query: gap.query,
            question: (gap.written ?? gap.question).slice(-WRITTEN_CHARS),
            reply: gap.reply ?? "",
            teamReply: gap.team_reply?.slice(0, 4000) ?? null,
            createdAt: new Date(gap.created_at),
          })
          .returning({ id: agentReviewItem.id })
        if (!row) throw new Error("No se pudo agregar lo que no encontró")
        reviewItemId = row.id
        added += 1
      }
    }
    for (const key of gapKeysOf) keys.set(key, reviewItemId)
    await tx.update(agentKnowledgeGap).set({ reviewItemId }).where(eq(agentKnowledgeGap.id, gap.id))
  }
  return added
}

/**
 * Añade a «Por revisar» lo que buscó sin encontrar y las respuestas enviadas
 * que algo hace dudar: el equipo escribió justo después, el interlocutor repitió
 * la pregunta, o cayó en la muestra al azar. Se concilia al consultar; es
 * idempotente por respuesta. Son señales para que mire una persona, no un
 * veredicto de que estuvo mal.
 */
export async function syncReviewQueue(tx: Db, orgId: string): Promise<number> {
  const fromGaps = await syncGapsIntoReview(tx, orgId)
  const rows = await tx.execute<{
    id: string
    conversation_id: string
    agent: string
    reply_text: string
    question: string | null
    written: string | null
    next_direction: string | null
    next_sender: string | null
    next_body: string | null
    next_soon: boolean | null
    sampled: boolean
  }>(sql`
    select t.id, t.conversation_id, t.agent, t.reply_text,
           q.body as question,
           ${WRITTEN_UP_TO_Q} as written,
           nxt.direction as next_direction, nxt.sender_kind as next_sender, nxt.body as next_body,
           (nxt.created_at - t.created_at) <= make_interval(mins => ${TEAM_TOOK_MINUTES}) as next_soon,
           (abs(hashtext(t.id::text)) % ${REVIEW_SAMPLE_ONE_IN}) = 0 as sampled
    from agent_answer_trace t
    left join message q on q.organization_id = t.organization_id and q.id = t.trigger_message_id
    left join lateral (
      select m.direction, m.sender_kind, m.body, m.created_at from message m
      where m.organization_id = t.organization_id and m.conversation_id = t.conversation_id
        and m.created_at > t.created_at and m.id is distinct from t.message_id
        and m.sender_kind <> 'agent'
      order by m.created_at asc limit 1
    ) nxt on true
    where t.organization_id = ${orgId} and t.outcome = 'enviada'
      and t.created_at >= now() - make_interval(days => ${REVIEW_WINDOW_DAYS})
      -- Una prueba del chat web no es una respuesta a una persona (fase 6 del pulido).
      and not exists (select 1 from conversation tc where tc.organization_id = t.organization_id and tc.id = t.conversation_id and tc.is_test)
      and not exists (
        select 1 from agent_review_item r where r.organization_id = t.organization_id and r.trace_id = t.id)
      -- Esa respuesta ya se mira por lo que no encontró.
      and not exists (
        select 1 from agent_knowledge_gap g where g.organization_id = t.organization_id and g.trigger_message_id = t.trigger_message_id)
    order by t.created_at desc
    limit 200`)
  let added = fromGaps
  for (const row of rows) {
    const question = row.question ?? ""
    let reason: ReviewReason | null = null
    if (row.next_direction === "out" && row.next_sender === "user" && row.next_soon) reason = "equipo_tomo"
    else if (row.next_direction === "in" && row.next_body && sameQuestion(question, row.next_body)) reason = "repitio_pregunta"
    else if (row.sampled) reason = "muestra"
    if (!reason) continue
    const inserted = await tx
      .insert(agentReviewItem)
      .values({
        organizationId: orgId,
        agent: row.agent,
        conversationId: row.conversation_id,
        traceId: row.id,
        reason,
        question: (row.written ?? question).slice(-WRITTEN_CHARS),
        reply: row.reply_text,
        teamReply: reason === "equipo_tomo" ? (row.next_body?.slice(0, 4000) ?? null) : null,
      })
      .onConflictDoNothing({ target: [agentReviewItem.organizationId, agentReviewItem.traceId] })
      .returning({ id: agentReviewItem.id })
    added += inserted.length
  }
  return added
}

const reviewColumns = {
  item: agentReviewItem,
  contactName: contact.displayName,
  channel: channelConnection.channel,
  basis: agentAnswerTrace.basis,
  checks: agentAnswerTrace.checks,
}

function toReviewItem(row: {
  item: typeof agentReviewItem.$inferSelect
  contactName: string | null
  channel: string | null
  basis: AnswerBasisItem[] | null
  checks: AnswerCheck[] | null
}): ReviewItem {
  return {
    id: row.item.id,
    agent: row.item.agent,
    conversationId: row.item.conversationId,
    traceId: row.item.traceId,
    reason: row.item.reason,
    query: row.item.query,
    asked: null,
    before: null,
    question: row.item.question,
    reply: row.item.reply,
    teamReply: row.item.teamReply,
    status: row.item.status as ReviewItem["status"],
    contactName: row.contactName,
    channel: row.channel,
    basis: row.basis ?? [],
    checks: row.checks ?? [],
    createdAt: row.item.createdAt.toISOString(),
  }
}

function reviewQuery(tx: Db) {
  return tx
    .select(reviewColumns)
    .from(agentReviewItem)
    .innerJoin(conversation, eq(conversation.id, agentReviewItem.conversationId))
    .leftJoin(contact, eq(contact.id, conversation.contactId))
    .leftJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .leftJoin(agentAnswerTrace, eq(agentAnswerTrace.id, agentReviewItem.traceId))
}

export async function listReviewItems(tx: Db, orgId: string): Promise<ReviewItem[]> {
  const rows = await reviewQuery(tx)
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.status, "pendiente")))
    .orderBy(desc(agentReviewItem.createdAt))
    .limit(REVIEW_PENDING_LIMIT)
  const items = rows.map(toReviewItem)

  const searched = items.filter((item) => item.reason === "no_encontro").map((item) => item.id)
  const asked = searched.length
    ? await tx
        .select({ id: agentKnowledgeGap.reviewItemId, createdAt: agentKnowledgeGap.createdAt })
        .from(agentKnowledgeGap)
        .where(and(eq(agentKnowledgeGap.organizationId, orgId), inArray(agentKnowledgeGap.reviewItemId, searched)))
    : []
  const weekStart = Date.now() - GAP_WEEK_MS

  const short = items.filter((item) => item.question.trim().split(/\s+/).length <= SHORT_MESSAGE_WORDS).map((item) => item.id)
  const earlier = short.length
    ? await tx.execute<{ id: string; before: string | null }>(sql`
        select r.id, (
          select o.body from message o
          where o.organization_id = r.organization_id and o.conversation_id = r.conversation_id
            and o.direction = 'out' and o.body is not null and o.created_at < q.created_at
          order by o.created_at desc limit 1
        ) as before
        from agent_review_item r
        left join agent_answer_trace t on t.organization_id = r.organization_id and t.id = r.trace_id
        join message q on q.organization_id = r.organization_id and q.id = coalesce(r.trigger_message_id, t.trigger_message_id)
        where r.organization_id = ${orgId} and r.id in (${sql.join(short.map((id) => sql`${id}::uuid`), sql`, `)})`)
    : []
  const beforeById = new Map([...earlier].map((row) => [row.id, row.before]))

  return items.map((item) => {
    const times = asked.filter((row) => row.id === item.id)
    return {
      ...item,
      before: beforeById.get(item.id) ?? null,
      asked:
        item.reason === "no_encontro"
          ? { total: times.length, week: times.filter((row) => row.createdAt.getTime() > weekStart).length }
          : null,
    }
  })
}

/** Una fila de la conversación alrededor de una respuesta. */
export interface AnswerConversationMessage {
  id: string
  /** `antes`: lo último que se le dijo; `escribio`: lo que escribió seguido; `respondio`: la respuesta del agente; `equipo`: lo que el equipo escribió después. */
  role: "antes" | "escribio" | "respondio" | "equipo"
  from: "persona" | "agente" | "equipo"
  body: string
  at: string
}

export interface AnswerConversation {
  messages: AnswerConversationMessage[]
  /** En qué se convierte cada falla, para decirlo antes de enviar la corrección. */
  lessonKinds: Record<CorrectionFailure, LessonKind>
}

/** Lo justo para juzgar una respuesta: lo anterior, lo que escribió, lo que respondió y lo que el equipo escribió después. */
async function conversationAround(
  tx: Db,
  orgId: string,
  input: { conversationId: string; triggerMessageId: string | null; replyMessageId: string | null },
): Promise<AnswerConversation> {
  const result: AnswerConversation = { messages: [], lessonKinds: LESSON_KIND_BY_FAILURE }
  if (!input.triggerMessageId) return result
  const columns = {
    id: message.id,
    direction: message.direction,
    senderKind: message.senderKind,
    body: message.body,
    createdAt: message.createdAt,
  }
  const inThread = and(eq(message.organizationId, orgId), eq(message.conversationId, input.conversationId), isNotNull(message.body))
  const [trigger] = await tx
    .select(columns)
    .from(message)
    .where(and(inThread, eq(message.id, input.triggerMessageId)))
    .limit(1)
  if (!trigger) return result
  // Se compara en la base y no con la fecha leída: esa pierde los microsegundos y dejaría fuera al propio mensaje.
  const timeOf = (id: string) => sql`(select m0.created_at from message m0 where m0.organization_id = ${orgId} and m0.id = ${id})`
  const earlier = await tx
    .select(columns)
    .from(message)
    .where(and(inThread, sql`${message.createdAt} <= ${timeOf(trigger.id)}`))
    .orderBy(desc(message.createdAt))
    .limit(12)
  const firstOut = earlier.findIndex((row) => row.direction === "out")
  const written = (firstOut === -1 ? earlier : earlier.slice(0, firstOut)).reverse()
  const before = firstOut === -1 ? undefined : earlier[firstOut]
  const [reply] = await tx
    .select(columns)
    .from(message)
    .where(
      and(
        inThread,
        input.replyMessageId
          ? eq(message.id, input.replyMessageId)
          : and(
              eq(message.direction, "out"),
              eq(message.senderKind, "agent"),
              sql`${message.createdAt} > ${timeOf(trigger.id)}`,
              // Pasado el plazo ya no es la respuesta a esto, como en la fila.
              sql`${message.createdAt} <= ${timeOf(trigger.id)} + make_interval(mins => ${GAP_REPLY_WAIT_MINUTES})`,
            ),
      ),
    )
    .orderBy(asc(message.createdAt))
    .limit(1)
  const [team] = await tx
    .select(columns)
    .from(message)
    .where(and(inThread, eq(message.direction, "out"), eq(message.senderKind, "user"), sql`${message.createdAt} > ${timeOf((reply ?? trigger).id)}`))
    .orderBy(asc(message.createdAt))
    .limit(1)
  const line = (row: (typeof earlier)[number], role: AnswerConversationMessage["role"]): AnswerConversationMessage => ({
    id: row.id,
    role,
    from: row.direction === "in" ? "persona" : row.senderKind === "user" ? "equipo" : "agente",
    body: row.body ?? "",
    at: row.createdAt.toISOString(),
  })
  result.messages = [
    ...(before ? [line(before, "antes")] : []),
    ...written.map((row) => line(row, "escribio")),
    ...(reply ? [line(reply, "respondio")] : []),
    ...(team ? [line(team, "equipo")] : []),
  ]
  return result
}

export async function getReviewConversation(tx: Db, orgId: string, id: string): Promise<AnswerConversation> {
  const [row] = await tx
    .select({
      conversationId: agentReviewItem.conversationId,
      own: agentReviewItem.triggerMessageId,
      trigger: agentAnswerTrace.triggerMessageId,
      replyMessageId: agentAnswerTrace.messageId,
    })
    .from(agentReviewItem)
    .leftJoin(agentAnswerTrace, eq(agentAnswerTrace.id, agentReviewItem.traceId))
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.id, id)))
    .limit(1)
  if (!row) throw notFound("Respuesta por revisar")
  return conversationAround(tx, orgId, { conversationId: row.conversationId, triggerMessageId: row.own ?? row.trigger, replyMessageId: row.replyMessageId })
}

export async function getAnswerConversation(tx: Db, orgId: string, traceId: string): Promise<AnswerConversation> {
  const [trace] = await tx
    .select({ conversationId: agentAnswerTrace.conversationId, trigger: agentAnswerTrace.triggerMessageId, replyMessageId: agentAnswerTrace.messageId })
    .from(agentAnswerTrace)
    .where(and(eq(agentAnswerTrace.organizationId, orgId), eq(agentAnswerTrace.id, traceId)))
    .limit(1)
  if (!trace) throw notFound("Respuesta del agente")
  return conversationAround(tx, orgId, { conversationId: trace.conversationId, triggerMessageId: trace.trigger, replyMessageId: trace.replyMessageId })
}

async function requireReviewItem(tx: Db, orgId: string, id: string): Promise<ReviewItem> {
  const [row] = await reviewQuery(tx)
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.id, id)))
    .limit(1)
  if (!row) throw notFound("Respuesta por revisar")
  return toReviewItem(row)
}

/** Lo que no encontró sigue la suerte de su fila: se abre con ella, se descarta o queda resuelto. */
async function moveReviewGaps(
  tx: Db,
  orgId: string,
  actorUserId: string,
  reviewItemId: string,
  status: "abierta" | "descartada" | "resuelta",
): Promise<void> {
  const open = status === "abierta"
  await tx
    .update(agentKnowledgeGap)
    .set({ status, resolvedBy: open ? null : actorUserId, resolvedAt: open ? null : new Date() })
    .where(and(eq(agentKnowledgeGap.organizationId, orgId), eq(agentKnowledgeGap.reviewItemId, reviewItemId)))
}

/**
 * «Estuvo bien»: sale de la lista y nada más. Sofi sigue respondiendo igual;
 * para que aprenda de esa respuesta, `proposeExampleFromReview`.
 */
export async function markReviewOk(tx: Db, orgId: string, actorUserId: string, id: string): Promise<void> {
  const [row] = await tx
    .update(agentReviewItem)
    .set({ status: "bien", decidedBy: actorUserId, decidedAt: new Date() })
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.id, id), eq(agentReviewItem.status, "pendiente")))
    .returning({ id: agentReviewItem.id })
  if (!row) {
    await requireReviewItem(tx, orgId, id)
    throw new ServiceError("REVIEW_NOT_PENDING", 409, "Esa respuesta ya se revisó")
  }
  await moveReviewGaps(tx, orgId, actorUserId, id, "descartada")
  await audit(tx, orgId, actorUserId, "agent.review_ok", "agent_review_item", id)
}

/** La lección que sigue en pie de esa fila; una descartada ya no cuenta. */
async function liveLessonOf(tx: Db, orgId: string, reviewItemId: string): Promise<{ id: string } | undefined> {
  const [lesson] = await tx
    .select({ id: agentLesson.id })
    .from(agentLesson)
    .where(and(eq(agentLesson.organizationId, orgId), eq(agentLesson.reviewItemId, reviewItemId), ne(agentLesson.status, "descartada")))
    .limit(1)
  return lesson
}

/** «Deshacer»: una respuesta marcada como bien vuelve a la lista, salvo que ya haya dejado una lección. */
export async function reopenReviewItem(tx: Db, orgId: string, actorUserId: string, id: string): Promise<void> {
  await requireReviewItem(tx, orgId, id)
  if (await liveLessonOf(tx, orgId, id)) {
    throw new ServiceError("REVIEW_NOT_REOPENABLE", 409, "Esa respuesta ya no se puede volver a abrir: dejó una lección")
  }
  const [row] = await tx
    .update(agentReviewItem)
    .set({ status: "pendiente", decidedBy: null, decidedAt: null })
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.id, id), eq(agentReviewItem.status, "bien")))
    .returning({ id: agentReviewItem.id })
  if (!row) throw new ServiceError("REVIEW_NOT_REOPENABLE", 409, "Esa respuesta ya no está marcada como bien")
  await moveReviewGaps(tx, orgId, actorUserId, id, "abierta")
  await audit(tx, orgId, actorUserId, "agent.review_reopened", "agent_review_item", id)
}

/**
 * «Guardar como ejemplo»: propone esa respuesta para preguntas parecidas y, si
 * seguía en la lista, la da por buena. Como toda lección, espera la aprobación
 * de quien administra el agente.
 */
export async function proposeExampleFromReview(tx: Db, orgId: string, actorUserId: string, id: string): Promise<LessonItem> {
  const item = await requireReviewItem(tx, orgId, id)
  if (!item.question.trim() || !item.reply.trim()) throw validation("Esa respuesta no tiene una pregunta que sirva de ejemplo")
  if (item.status === "corregida") throw new ServiceError("REVIEW_NOT_PENDING", 409, "Esa respuesta ya se revisó")
  if (await liveLessonOf(tx, orgId, id)) throw new ServiceError("REVIEW_NOT_PENDING", 409, "Esa respuesta ya dejó una lección")
  if (item.status === "pendiente") await markReviewOk(tx, orgId, actorUserId, id)
  const [lesson] = await tx
    .insert(agentLesson)
    .values({
      organizationId: orgId,
      kind: "ejemplo",
      scope: item.agent,
      title: shorten(`Cuando preguntan: ${item.question}`, LESSON_TITLE_CHARS),
      question: item.question,
      body: item.reply.slice(0, LESSON_BODY_CHARS),
      originalReply: item.reply,
      reviewItemId: item.id,
      conversationId: item.conversationId,
      proposedBy: actorUserId,
    })
    .returning()
  if (!lesson) throw new Error("No se pudo proponer el ejemplo")
  await audit(tx, orgId, actorUserId, "agent.lesson_proposed", "agent_lesson", lesson.id, { kind: "ejemplo", fromGoodReply: true })
  return getLesson(tx, orgId, lesson.id)
}

/**
 * «Sí, estuvo bien» desde la ficha de una respuesta en la Bandeja. Si la
 * respuesta esperaba revisión, sale de la lista; si no, queda registrada como
 * revisada y bien. Repetirlo no cambia nada.
 */
export async function markAnswerOk(tx: Db, orgId: string, actorUserId: string, traceId: string): Promise<void> {
  const item = await flagAnswerForReview(tx, orgId, actorUserId, traceId)
  if (item.status !== "pendiente") return
  await markReviewOk(tx, orgId, actorUserId, item.id)
}

/** Las preguntas abiertas que dejó ese mensaje y aún no tienen fila. */
function gapsOfTrigger(orgId: string, conversationId: string, triggerMessageId: string) {
  return and(
    eq(agentKnowledgeGap.organizationId, orgId),
    eq(agentKnowledgeGap.conversationId, conversationId),
    eq(agentKnowledgeGap.triggerMessageId, triggerMessageId),
    eq(agentKnowledgeGap.status, "abierta"),
    isNull(agentKnowledgeGap.reviewItemId),
  )
}

/** Una persona marca una respuesta desde la Bandeja para corregirla; devuelve su entrada en la lista. */
export async function flagAnswerForReview(tx: Db, orgId: string, actorUserId: string, traceId: string): Promise<ReviewItem> {
  const [trace] = await tx
    .select()
    .from(agentAnswerTrace)
    .where(and(eq(agentAnswerTrace.organizationId, orgId), eq(agentAnswerTrace.id, traceId)))
    .limit(1)
  if (!trace) throw notFound("Respuesta del agente")
  const [existing] = await tx
    .select({ id: agentReviewItem.id })
    .from(agentReviewItem)
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.traceId, traceId)))
    .limit(1)
  if (existing) return requireReviewItem(tx, orgId, existing.id)
  let question = ""
  let searched: { query: string } | undefined
  if (trace.triggerMessageId) {
    const [asked] = await tx.execute<{ written: string | null }>(sql`
      select ${WRITTEN_UP_TO_Q} as written from message q
      where q.organization_id = ${orgId} and q.id = ${trace.triggerMessageId}`)
    question = asked?.written ?? ""
    const [gap] = await tx
      .select({ query: agentKnowledgeGap.query })
      .from(agentKnowledgeGap)
      .where(gapsOfTrigger(orgId, trace.conversationId, trace.triggerMessageId))
      .limit(1)
    searched = gap
  }
  const [row] = await tx
    .insert(agentReviewItem)
    .values({
      organizationId: orgId,
      agent: trace.agent,
      conversationId: trace.conversationId,
      traceId,
      reason: searched ? "no_encontro" : "marcada",
      ...(searched ? { query: searched.query, triggerMessageId: trace.triggerMessageId } : {}),
      question: question.slice(-WRITTEN_CHARS),
      reply: trace.replyText,
    })
    .returning({ id: agentReviewItem.id })
  if (!row) throw new Error("No se pudo marcar la respuesta")
  // Si además buscó sin encontrar, la pregunta sigue la suerte de esta fila: la lista no la vuelve a traer.
  if (searched && trace.triggerMessageId) {
    await tx
      .update(agentKnowledgeGap)
      .set({ reviewItemId: row.id })
      .where(gapsOfTrigger(orgId, trace.conversationId, trace.triggerMessageId))
  }
  await audit(tx, orgId, actorUserId, "agent.review_flagged", "agent_review_item", row.id, { traceId })
  return requireReviewItem(tx, orgId, row.id)
}

/* ---------- Lecciones ---------- */

async function namesOf(tx: Db, ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id) && id !== "agent"))]
  if (wanted.length === 0) return new Map()
  const rows = await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, wanted))
  return new Map(rows.map((row) => [row.id, row.name]))
}

async function toLessonItems(tx: Db, orgId: string, rows: Array<typeof agentLesson.$inferSelect>): Promise<LessonItem[]> {
  const names = await namesOf(tx, rows.flatMap((row) => [row.proposedBy, row.approvedBy]))
  const entryIds = rows.map((row) => row.knowledgeEntryId).filter((id): id is string => id !== null)
  const entries = entryIds.length
    ? await tx
        .select({ id: agentKnowledgeEntry.id, title: agentKnowledgeEntry.title, body: agentKnowledgeEntry.body })
        .from(agentKnowledgeEntry)
        .where(and(eq(agentKnowledgeEntry.organizationId, orgId), inArray(agentKnowledgeEntry.id, entryIds)))
    : []
  const entryById = new Map(entries.map((entry) => [entry.id, { title: entry.title, body: entry.body }]))
  // De dónde sale: la respuesta revisada dice de qué agente era.
  const reviewIds = rows.map((row) => row.reviewItemId).filter((id): id is string => id !== null)
  const reviews = reviewIds.length
    ? await tx
        .select({ id: agentReviewItem.id, agent: agentReviewItem.agent })
        .from(agentReviewItem)
        .where(and(eq(agentReviewItem.organizationId, orgId), inArray(agentReviewItem.id, reviewIds)))
    : []
  const reviewById = new Map(reviews.map((review) => [review.id, review]))
  const conversationIds = [...new Set(rows.map((row) => row.conversationId).filter((id): id is string => id !== null))]
  const contacts = conversationIds.length
    ? await tx
        .select({ id: conversation.id, name: contact.displayName })
        .from(conversation)
        .leftJoin(contact, eq(contact.id, conversation.contactId))
        .where(and(eq(conversation.organizationId, orgId), inArray(conversation.id, conversationIds)))
    : []
  const contactByConversation = new Map(contacts.map((row) => [row.id, row.name]))
  return rows.map((row) => {
    const review = row.reviewItemId ? reviewById.get(row.reviewItemId) : undefined
    return {
      id: row.id,
      kind: row.kind,
      source: row.source,
      scope: row.scope,
      agent: row.scope !== "clinica" ? row.scope : (review?.agent ?? "recepcion"),
      origin: (row.failure === null ? "respuesta_buena" : "correccion") as LessonOrigin,
      contactName: row.conversationId ? (contactByConversation.get(row.conversationId) ?? null) : null,
      title: row.title,
      question: row.question,
      body: row.body,
      failure: row.failure,
      originalReply: row.originalReply,
      status: row.status,
      conversationId: row.conversationId,
      knowledgeEntryId: row.knowledgeEntryId,
      knowledgeEntry: row.knowledgeEntryId ? (entryById.get(row.knowledgeEntryId) ?? null) : null,
      previousBody: row.previousBody,
      uses: row.uses,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      proposedByName: names.get(row.proposedBy) ?? null,
      approvedByName: row.approvedBy ? (names.get(row.approvedBy) ?? null) : null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }
  })
}

async function lockLesson(tx: Db, orgId: string, id: string): Promise<typeof agentLesson.$inferSelect> {
  const [row] = await tx
    .select()
    .from(agentLesson)
    .where(and(eq(agentLesson.organizationId, orgId), eq(agentLesson.id, id)))
    .for("update")
    .limit(1)
  if (!row) throw notFound("Lección")
  return row
}

export async function getLesson(tx: Db, orgId: string, id: string): Promise<LessonItem> {
  const [row] = await tx
    .select()
    .from(agentLesson)
    .where(and(eq(agentLesson.organizationId, orgId), eq(agentLesson.id, id)))
    .limit(1)
  if (!row) throw notFound("Lección")
  const [item] = await toLessonItems(tx, orgId, [row])
  if (!item) throw notFound("Lección")
  return item
}

export async function listLessons(tx: Db, orgId: string, status: LessonStatus): Promise<LessonItem[]> {
  // Lo que escribió la clínica no se aprendió: vive en «Lo que el agente debe saber».
  const rows = await tx
    .select()
    .from(agentLesson)
    .where(and(eq(agentLesson.organizationId, orgId), eq(agentLesson.status, status), eq(agentLesson.source, "aprendida")))
    .orderBy(desc(agentLesson.updatedAt))
    .limit(200)
  return toLessonItems(tx, orgId, rows)
}

const RULE_FOR_NO_ANSWER = (question: string) =>
  `Si preguntan algo como «${shorten(question, 160)}», no respondas por tu cuenta: pasa el caso a una persona.`

function lessonDraft(input: { failure: CorrectionFailure; question: string; corrected: string }): {
  kind: LessonKind
  title: string
  body: string
} {
  const asked = input.question.trim()
  const kind = LESSON_KIND_BY_FAILURE[input.failure]
  if (kind === "regla") {
    return {
      kind,
      title: shorten(asked ? `No responder: ${asked}` : "No responder por su cuenta", LESSON_TITLE_CHARS),
      body: input.corrected || RULE_FOR_NO_ANSWER(asked || "esto"),
    }
  }
  if (kind === "respuesta_oficial") {
    return { kind, title: shorten(asked || input.corrected, LESSON_TITLE_CHARS), body: input.corrected }
  }
  return {
    kind,
    title: shorten(asked ? `Cuando preguntan: ${asked}` : input.corrected, LESSON_TITLE_CHARS),
    body: input.corrected,
  }
}

/** La respuesta oficial vigente que ya trata esa pregunta, si la hay: la lección propondrá cambiarla. */
async function matchingAnswer(tx: Db, orgId: string, question: string): Promise<string | null> {
  if (!question.trim()) return null
  let best: { id: string; score: number } | null = null
  for (const entry of await listActiveKnowledge(tx, orgId)) {
    const score = scoreKnowledgeMatch(question, entry)
    if (score >= SAME_ANSWER_SCORE && (!best || score > best.score)) best = { id: entry.id, score }
  }
  return best?.id ?? null
}

async function insertLesson(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: {
    agent: string
    failure: CorrectionFailure
    question: string
    corrected: string
    originalReply: string
    reviewItemId: string | null
    conversationId: string | null
    kind?: LessonKind
  },
): Promise<LessonItem> {
  const draft = lessonDraft(input)
  const kind = input.kind ?? draft.kind
  const [row] = await tx
    .insert(agentLesson)
    .values({
      organizationId: orgId,
      kind,
      scope: scopeOf(kind, input.agent),
      title: draft.title,
      question: input.question.slice(0, 2000),
      body: (kind === draft.kind ? draft.body : input.corrected).slice(0, LESSON_BODY_CHARS),
      failure: input.failure,
      originalReply: input.originalReply.slice(0, 4000),
      reviewItemId: input.reviewItemId,
      conversationId: input.conversationId,
      knowledgeEntryId: kind === "respuesta_oficial" ? await matchingAnswer(tx, orgId, input.question) : null,
      proposedBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se pudo proponer la lección")
  await audit(tx, orgId, actorUserId, "agent.lesson_proposed", "agent_lesson", row.id, { kind, failure: input.failure })
  const [item] = await toLessonItems(tx, orgId, [row])
  if (!item) throw new Error("No se pudo leer la lección")
  return item
}

/**
 * «Enseñárselo a Sofi» desde lo que respondió el equipo: queda una respuesta
 * oficial por aprobar en Aprender y, cuando se aprueba, esa pregunta deja de
 * volver. No cambia nada por sí sola. Lo clínico no se enseña: Sofi no da
 * consejos clínicos, y un pago lo responde caja con lo que ve en su caja.
 */
export async function proposeLessonFromReply(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { conversationId: string; question: string; answer: string },
): Promise<LessonItem> {
  const question = input.question.trim()
  const answer = input.answer.trim()
  if (!question || !answer) throw validation("Falta la pregunta o la respuesta para enseñárselo.")
  const [topic] = await tx
    .select({ kind: agentHandoff.kind })
    .from(agentHandoff)
    .where(and(eq(agentHandoff.organizationId, orgId), eq(agentHandoff.conversationId, input.conversationId)))
    .orderBy(desc(agentHandoff.createdAt))
    .limit(1)
  if (topic?.kind === "clinico" || topic?.kind === "pago" || looksClinical(question) || looksClinical(answer)) {
    throw validation("Esto no se le enseña: es clínico o de un pago, y lo sigue viendo una persona.")
  }
  return insertLesson(tx, orgId, actorUserId, {
    agent: "recepcion",
    failure: "falto_dato",
    question,
    corrected: answer,
    originalReply: "",
    reviewItemId: null,
    conversationId: input.conversationId,
  })
}

export interface CorrectAnswerInput {
  /** La entrada de «Por revisar»; o la respuesta marcada desde la Bandeja (`traceId`). */
  reviewItemId?: string
  traceId?: string
  failure: string
  correctedReply?: string
  /** En lo que no encontró: cómo se guarda la pregunta, si no es lo que escribió la persona. */
  question?: string
}

/**
 * Corrige una respuesta del agente, también una que se dio por buena y resultó
 * no estarlo. No cambia nada por sí sola: deja una lección propuesta que
 * alguien que administra el agente aprueba o descarta.
 */
export async function correctAnswer(tx: Db, orgId: string, actorUserId: string, input: CorrectAnswerInput): Promise<LessonItem> {
  if (!(CORRECTION_FAILURES as readonly string[]).includes(input.failure)) throw invalidField("failure", "Elige qué falló")
  const failure = input.failure as CorrectionFailure
  const corrected = typeof input.correctedReply === "string" ? input.correctedReply.trim() : ""
  if (!corrected && failure !== "no_debio_responder") throw invalidField("correctedReply", "Escribe cómo debió responder")
  if (corrected.length > LESSON_BODY_CHARS) throw invalidField("correctedReply", `La respuesta admite hasta ${LESSON_BODY_CHARS} caracteres`)
  const asked = input.question?.trim() ?? ""
  if (asked.length > LESSON_TITLE_CHARS) throw invalidField("question", `La pregunta admite hasta ${LESSON_TITLE_CHARS} caracteres`)
  // «No debió responder» propone una regla: lo que escribe es la regla misma.
  if (failure === "no_debio_responder") assertRuleLength(corrected, "correctedReply")
  let item: ReviewItem
  if (input.reviewItemId) item = await requireReviewItem(tx, orgId, input.reviewItemId)
  else if (input.traceId) item = await flagAnswerForReview(tx, orgId, actorUserId, input.traceId)
  else throw validation("Indica qué respuesta corriges")
  const [claimed] = await tx
    .update(agentReviewItem)
    .set({ status: "corregida", decidedBy: actorUserId, decidedAt: new Date() })
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.id, item.id), inArray(agentReviewItem.status, ["pendiente", "bien"])))
    .returning({ id: agentReviewItem.id })
  if (!claimed) throw new ServiceError("REVIEW_NOT_PENDING", 409, "Esa respuesta ya se revisó")
  await moveReviewGaps(tx, orgId, actorUserId, item.id, "resuelta")
  return insertLesson(tx, orgId, actorUserId, {
    agent: item.agent,
    failure,
    question: asked || item.question,
    corrected,
    originalReply: item.reply,
    reviewItemId: item.id,
    conversationId: item.conversationId,
  })
}

/**
 * «Sumar a esa respuesta»: lo que no encontró ya estaba en una respuesta oficial
 * dicho con otras palabras. Lo buscado se suma a sus formas de preguntar y su
 * texto no cambia, así que no pasa por una lección.
 */
export async function addReviewToAnswer(tx: Db, orgId: string, actorUserId: string, id: string, entryId: string): Promise<KnowledgeEntryItem> {
  const item = await requireReviewItem(tx, orgId, id)
  if (item.reason !== "no_encontro") throw validation("Solo lo que no encontró se suma a una respuesta")
  // Solo la que Sofi puede encontrar: sumarla a un borrador o a una vencida no le serviría de nada.
  const target = await getKnowledgeEntry(tx, orgId, entryId)
  if (target.state !== "vigente") throw invalidField("entryId", "Esa respuesta no está vigente: elige otra")
  const [claimed] = await tx
    .update(agentReviewItem)
    .set({ status: "corregida", decidedBy: actorUserId, decidedAt: new Date() })
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.id, id), eq(agentReviewItem.status, "pendiente")))
    .returning({ id: agentReviewItem.id })
  if (!claimed) throw new ServiceError("REVIEW_NOT_PENDING", 409, "Esa respuesta ya se revisó")
  const entry = await addAskFormsToAnswer(tx, orgId, actorUserId, entryId, await searchedFor(tx, orgId, id))
  await moveReviewGaps(tx, orgId, actorUserId, id, "resuelta")
  await tx
    .update(agentKnowledgeGap)
    .set({ resolvedEntryId: entryId })
    .where(and(eq(agentKnowledgeGap.organizationId, orgId), eq(agentKnowledgeGap.reviewItemId, id)))
  return entry
}

/**
 * Cómo se preguntó lo que no encontró esa fila: lo que se buscó y, si habla de
 * eso, lo que escribió la persona. En una ráfaga el último mensaje puede ser de
 * otro tema, y como forma de preguntar llevaría a Sofi a la respuesta equivocada.
 */
async function searchedFor(tx: Db, orgId: string, reviewItemId: string | null): Promise<string[]> {
  if (!reviewItemId) return []
  const rows = await tx
    .select({ query: agentKnowledgeGap.query, question: agentKnowledgeGap.question })
    .from(agentKnowledgeGap)
    .where(and(eq(agentKnowledgeGap.organizationId, orgId), eq(agentKnowledgeGap.reviewItemId, reviewItemId)))
  return rows.flatMap((row) => {
    const searched = wordsOf(row.query)
    const onTopic = !row.question.includes("\n") && [...wordsOf(row.question)].some((word) => searched.has(word))
    return onTopic ? [row.question, row.query] : [row.query]
  })
}

export interface UpdateLessonInput {
  title?: string
  body?: string
  kind?: string
  /** `null`: guardar como respuesta nueva en vez de cambiar la que ya existe. */
  knowledgeEntryId?: null
}

/** Editar una lección mientras está propuesta: una vez activa se retira y se propone otra. */
export async function updateLesson(tx: Db, orgId: string, actorUserId: string, id: string, input: UpdateLessonInput): Promise<LessonItem> {
  const current = await lockLesson(tx, orgId, id)
  if (current.status !== "propuesta") throw new ServiceError("LESSON_NOT_PROPOSED", 409, "Solo se edita una lección que aún no se aprobó")
  if (input.kind !== undefined && !(LESSON_KINDS as readonly string[]).includes(input.kind)) throw invalidField("kind", "Elige qué clase de lección es")
  const kind = (input.kind as LessonKind | undefined) ?? current.kind
  const agent = current.scope === "clinica" ? "recepcion" : current.scope
  let knowledgeEntryId = current.knowledgeEntryId
  if (kind !== "respuesta_oficial" || input.knowledgeEntryId === null) knowledgeEntryId = null
  else if (kind !== current.kind) knowledgeEntryId = await matchingAnswer(tx, orgId, current.question)
  const body = input.body === undefined ? current.body : cleanText(input.body, "body", "El texto", LESSON_BODY_CHARS)
  // También al pasarla a regla sin tocar el texto.
  if (kind === "regla") assertRuleLength(body, "body")
  await tx
    .update(agentLesson)
    .set({
      title: input.title === undefined ? current.title : cleanText(input.title, "title", "El título", LESSON_TITLE_CHARS),
      body,
      kind,
      scope: scopeOf(kind, agent),
      knowledgeEntryId,
      updatedAt: new Date(),
    })
    .where(eq(agentLesson.id, id))
  await audit(tx, orgId, actorUserId, "agent.lesson_edited", "agent_lesson", id, { kind })
  return getLesson(tx, orgId, id)
}

/**
 * Las formas de preguntar que deja una lección: su pregunta y lo que se buscó sin
 * encontrar, para que la próxima vez la encuentre. Un mensaje de varias líneas
 * no: mezcla temas.
 */
async function askFormsOfLesson(tx: Db, orgId: string, lesson: typeof agentLesson.$inferSelect): Promise<string[]> {
  const seen = new Set([normalizeForSearch(lesson.title)])
  const forms: string[] = []
  for (const raw of [lesson.question, ...(await searchedFor(tx, orgId, lesson.reviewItemId))]) {
    if (raw.includes("\n")) continue
    const form = shorten(raw, ASK_FORM_CHARS)
    const key = normalizeForSearch(form)
    if (!key || seen.has(key)) continue
    seen.add(key)
    forms.push(form)
  }
  return forms.slice(0, ASK_FORM_LIMIT)
}

/** Pone en el conocimiento lo que dice una lección de respuesta oficial; devuelve la entrada y lo que había. */
async function applyOfficialAnswer(
  tx: Db,
  orgId: string,
  actorUserId: string,
  lesson: typeof agentLesson.$inferSelect,
): Promise<{ entryId: string; previousBody: string | null }> {
  const askForms = await askFormsOfLesson(tx, orgId, lesson)
  if (lesson.knowledgeEntryId) {
    const [entry] = await tx
      .select()
      .from(agentKnowledgeEntry)
      .where(and(eq(agentKnowledgeEntry.organizationId, orgId), eq(agentKnowledgeEntry.id, lesson.knowledgeEntryId)))
      .limit(1)
    if (entry) {
      const previousBody = entry.body === lesson.body ? lesson.previousBody : entry.body
      await updateKnowledgeEntry(tx, orgId, actorUserId, entry.id, {
        body: lesson.body,
        askForms: [...new Set([...entry.askForms, ...askForms])].slice(0, ASK_FORM_LIMIT),
      })
      if (entry.status !== "publicada") await setKnowledgeStatus(tx, orgId, actorUserId, entry.id, "publicada")
      return { entryId: entry.id, previousBody }
    }
  }
  const created = await createKnowledgeEntry(tx, orgId, actorUserId, {
    kind: "faq",
    title: lesson.title,
    body: lesson.body,
    askForms,
  })
  await setKnowledgeStatus(tx, orgId, actorUserId, created.id, "publicada")
  return { entryId: created.id, previousBody: null }
}

/** Guarda la pregunta de la lección como caso de prueba, o actualiza el que ya la cubría. */
async function keepTestCase(tx: Db, orgId: string, actorUserId: string, lesson: typeof agentLesson.$inferSelect): Promise<void> {
  if (!lesson.question.trim()) return
  const agent = lesson.scope === "clinica" ? "recepcion" : lesson.scope
  const [own] = await tx
    .select({ id: agentTestCase.id })
    .from(agentTestCase)
    .where(and(eq(agentTestCase.organizationId, orgId), eq(agentTestCase.lessonId, lesson.id)))
    .limit(1)
  if (own) {
    await tx
      .update(agentTestCase)
      .set({ status: "activo", expected: lesson.body, updatedAt: new Date() })
      .where(eq(agentTestCase.id, own.id))
    return
  }
  await tx.insert(agentTestCase).values({
    organizationId: orgId,
    agent,
    question: lesson.question,
    expected: lesson.body,
    lessonId: lesson.id,
    createdBy: actorUserId,
  })
}

/**
 * Aprobar activa la lección: desde ese momento el agente la usa. Una respuesta
 * oficial entra al conocimiento (nueva, o cambiando la que ya había); una regla
 * o un ejemplo quedan para su agente. Su pregunta queda como caso de prueba.
 */
/**
 * Aprueba una lección. Una regla que contradice otra (`findRuleConflict`) se
 * avisa antes en la pantalla; con `replaceId` («Reemplazar») la otra deja de
 * valer en el mismo paso. «Mantener las dos» aprueba sin `replaceId`.
 */
export async function approveLesson(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  opts: { replaceId?: string } = {},
): Promise<LessonItem> {
  const lesson = await lockLesson(tx, orgId, id)
  if (lesson.status !== "propuesta") throw new ServiceError("LESSON_NOT_PROPOSED", 409, `La lección ya está ${lesson.status}`)
  if (lesson.kind === "regla") {
    assertRuleLength(lesson.body, "body")
    // Reemplazando otra, el total no cambia.
    if (!opts.replaceId) await assertRuleRoom(tx, orgId, lesson.scope, "aprobar")
  }
  if (opts.replaceId) {
    if (lesson.kind !== "regla") throw validation("Solo una regla reemplaza a otra")
    const replaced = await lockLesson(tx, orgId, opts.replaceId)
    if (replaced.status !== "activa" || replaced.kind !== "regla" || replaced.scope !== lesson.scope) {
      throw new ServiceError("LESSON_NOT_ACTIVE", 409, "La regla que se iba a reemplazar ya no está activa")
    }
    const now = new Date()
    await tx
      .update(agentLesson)
      .set({ status: "retirada", withdrawnBy: actorUserId, withdrawnAt: now, updatedAt: now })
      .where(eq(agentLesson.id, replaced.id))
    await audit(tx, orgId, actorUserId, "agent.lesson_replaced", "agent_lesson", replaced.id, { by: id })
  }
  const applied = lesson.kind === "respuesta_oficial" ? await applyOfficialAnswer(tx, orgId, actorUserId, lesson) : null
  await tx
    .update(agentLesson)
    .set({
      status: "activa",
      approvedBy: actorUserId,
      approvedAt: new Date(),
      knowledgeEntryId: applied?.entryId ?? null,
      previousBody: applied?.previousBody ?? null,
      updatedAt: new Date(),
    })
    .where(eq(agentLesson.id, id))
  if (applied && lesson.reviewItemId) {
    await tx
      .update(agentKnowledgeGap)
      .set({ resolvedEntryId: applied.entryId })
      .where(and(eq(agentKnowledgeGap.organizationId, orgId), eq(agentKnowledgeGap.reviewItemId, lesson.reviewItemId)))
  }
  await keepTestCase(tx, orgId, actorUserId, lesson)
  await audit(tx, orgId, actorUserId, "agent.lesson_approved", "agent_lesson", id, { kind: lesson.kind })
  return getLesson(tx, orgId, id)
}

export async function discardLesson(tx: Db, orgId: string, actorUserId: string, id: string): Promise<LessonItem> {
  const lesson = await lockLesson(tx, orgId, id)
  if (lesson.status !== "propuesta") throw new ServiceError("LESSON_NOT_PROPOSED", 409, `La lección ya está ${lesson.status}`)
  await tx.update(agentLesson).set({ status: "descartada", updatedAt: new Date() }).where(eq(agentLesson.id, id))
  // Descartar la corrección no responde la pregunta: lo que no encontró vuelve a la lista.
  if (lesson.reviewItemId) {
    const [back] = await tx
      .update(agentReviewItem)
      .set({ status: "pendiente", decidedBy: null, decidedAt: null })
      .where(
        and(
          eq(agentReviewItem.organizationId, orgId),
          eq(agentReviewItem.id, lesson.reviewItemId),
          eq(agentReviewItem.reason, "no_encontro"),
          eq(agentReviewItem.status, "corregida"),
        ),
      )
      .returning({ id: agentReviewItem.id })
    if (back) await moveReviewGaps(tx, orgId, actorUserId, back.id, "abierta")
  }
  await audit(tx, orgId, actorUserId, "agent.lesson_discarded", "agent_lesson", id)
  return getLesson(tx, orgId, id)
}

/**
 * Retirar deja de usar la lección al instante y devuelve el conocimiento a
 * como estaba: restaura el texto anterior de la respuesta que cambió, sin las
 * formas de preguntar que le sumó, o despublica la que creó. Si alguien cambió
 * esa respuesta después, no se toca: manda lo último que escribió una persona.
 */
export async function withdrawLesson(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: { withdrawCase?: boolean } = {},
): Promise<LessonItem> {
  const lesson = await lockLesson(tx, orgId, id)
  if (lesson.status !== "activa") throw new ServiceError("LESSON_NOT_ACTIVE", 409, "Solo se retira una lección activa")
  if (lesson.kind === "respuesta_oficial" && lesson.knowledgeEntryId) {
    const [entry] = await tx
      .select()
      .from(agentKnowledgeEntry)
      .where(and(eq(agentKnowledgeEntry.organizationId, orgId), eq(agentKnowledgeEntry.id, lesson.knowledgeEntryId)))
      .limit(1)
    if (entry && entry.body === lesson.body) {
      if (lesson.previousBody !== null) {
        const added = new Set((await askFormsOfLesson(tx, orgId, lesson)).map(normalizeForSearch))
        await updateKnowledgeEntry(tx, orgId, actorUserId, entry.id, {
          body: lesson.previousBody,
          askForms: entry.askForms.filter((form) => !added.has(normalizeForSearch(form))),
        })
      } else await setKnowledgeStatus(tx, orgId, actorUserId, entry.id, "borrador")
    }
  }
  await tx
    .update(agentLesson)
    .set({ status: "retirada", withdrawnBy: actorUserId, withdrawnAt: new Date(), updatedAt: new Date() })
    .where(eq(agentLesson.id, id))
  if (input.withdrawCase) {
    await tx
      .update(agentTestCase)
      .set({ status: "retirado", updatedAt: new Date() })
      .where(and(eq(agentTestCase.organizationId, orgId), eq(agentTestCase.lessonId, id)))
  }
  await audit(tx, orgId, actorUserId, "agent.lesson_withdrawn", "agent_lesson", id, { withdrawCase: input.withdrawCase === true })
  return getLesson(tx, orgId, id)
}

/** Restaurar vuelve a activar una lección retirada, con su caso de prueba. */
export async function restoreLesson(tx: Db, orgId: string, actorUserId: string, id: string): Promise<LessonItem> {
  const lesson = await lockLesson(tx, orgId, id)
  if (lesson.status !== "retirada") throw new ServiceError("LESSON_NOT_WITHDRAWN", 409, "Solo se restaura una lección retirada")
  if (lesson.kind === "regla") {
    assertRuleLength(lesson.body, "body")
    await assertRuleRoom(tx, orgId, lesson.scope, "restaurar")
  }
  const applied = lesson.kind === "respuesta_oficial" ? await applyOfficialAnswer(tx, orgId, actorUserId, lesson) : null
  await tx
    .update(agentLesson)
    .set({
      status: "activa",
      withdrawnBy: null,
      withdrawnAt: null,
      knowledgeEntryId: applied?.entryId ?? null,
      previousBody: applied?.previousBody ?? null,
      updatedAt: new Date(),
    })
    .where(eq(agentLesson.id, id))
  await keepTestCase(tx, orgId, actorUserId, lesson)
  await audit(tx, orgId, actorUserId, "agent.lesson_restored", "agent_lesson", id)
  return getLesson(tx, orgId, id)
}

/* ---------- Casos de prueba ---------- */

export async function listTestCases(tx: Db, orgId: string, agent?: string): Promise<TestCaseItem[]> {
  const rows = await tx
    .select()
    .from(agentTestCase)
    .where(
      and(
        eq(agentTestCase.organizationId, orgId),
        eq(agentTestCase.status, "activo"),
        agent ? eq(agentTestCase.agent, agent) : undefined,
      ),
    )
    .orderBy(asc(agentTestCase.createdAt))
    .limit(500)
  return rows.map((row) => ({
    id: row.id,
    agent: row.agent,
    question: row.question,
    expected: row.expected,
    lessonId: row.lessonId,
    status: row.status as TestCaseItem["status"],
    createdAt: row.createdAt.toISOString(),
  }))
}

/**
 * Guarda como caso de prueba una pregunta de «Probar» con la respuesta que
 * quien administra dio por buena. No nace de una lección: no cambia lo que el
 * agente sabe ni lo que responde. Guardar otra vez la misma pregunta actualiza
 * la respuesta esperada en vez de duplicar el caso.
 */
export async function saveTestCase(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { question: string; expected: string; agent?: string },
): Promise<TestCaseItem> {
  const question = cleanText(input.question, "question", "La pregunta", 2000)
  const expected = cleanText(input.expected, "expected", "La respuesta esperada", 4000)
  const agent = input.agent ?? "recepcion"
  const [same] = await tx
    .select({ id: agentTestCase.id })
    .from(agentTestCase)
    .where(
      and(
        eq(agentTestCase.organizationId, orgId),
        eq(agentTestCase.agent, agent),
        eq(agentTestCase.question, question),
        isNull(agentTestCase.lessonId),
      ),
    )
    .limit(1)
  const [row] = same
    ? await tx
        .update(agentTestCase)
        .set({ status: "activo", expected, updatedAt: new Date() })
        .where(eq(agentTestCase.id, same.id))
        .returning()
    : await tx.insert(agentTestCase).values({ organizationId: orgId, agent, question, expected, createdBy: actorUserId }).returning()
  if (!row) throw validation("No se pudo guardar el caso de prueba")
  // La auditoría no copia el texto de la conversación de prueba.
  await audit(tx, orgId, actorUserId, "agent.test_case_saved", "agent_test_case", row.id, { agent, updated: Boolean(same) })
  return {
    id: row.id,
    agent: row.agent,
    question: row.question,
    expected: row.expected,
    lessonId: row.lessonId,
    status: row.status as TestCaseItem["status"],
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * A qué casos de prueba toca una lección: los que preguntan por su tema. Es
 * una comparación de textos, sin llamar al modelo: dice cuáles pueden cambiar,
 * no cómo responderá el agente. Su propio caso no cuenta.
 */
export async function lessonImpact(tx: Db, orgId: string, lesson: LessonItem): Promise<LessonImpact> {
  const agent = lesson.scope === "clinica" ? undefined : lesson.scope
  const cases = (await listTestCases(tx, orgId, agent)).filter((item) => item.lessonId !== lesson.id)
  const topic = { title: lesson.title, body: lesson.body, askForms: lesson.question ? [lesson.question] : [] }
  return {
    total: cases.length,
    touched: cases
      .filter((item) => scoreKnowledgeMatch(item.question, topic) >= TOPIC_SCORE)
      .slice(0, 5)
      .map((item) => ({ id: item.id, question: item.question, expected: item.expected })),
  }
}

/* ---------- Lo aprendido, dentro del turno del agente ---------- */

export interface TurnLessons {
  /** Reglas activas del agente: van siempre en su prompt (todas, hasta `LESSON_RULE_LIMIT`). */
  rules: Array<{ id: string; title: string; body: string }>
  /** Reglas activas que no caben pasado el tope: se dicen, nunca se callan. */
  rulesLeftOut: number
  /** Ejemplos aprobados parecidos a lo que se pregunta ahora. */
  examples: Array<{ id: string; title: string; question: string; body: string }>
  /** Lecciones que tocan el tema del mensaje: las que cuentan como usadas en este turno. */
  matchedIds: string[]
  matched: Array<{ id: string; kind: LessonKind; title: string }>
}

/** ¿Tiene el agente algún ejemplo activo? Sin ninguno no hace falta buscarlos por significado. */
export async function hasActiveExamples(tx: Db, orgId: string, agent: string): Promise<boolean> {
  const rows = await tx
    .select({ id: agentLesson.id })
    .from(agentLesson)
    .where(and(eq(agentLesson.organizationId, orgId), eq(agentLesson.status, "activa"), eq(agentLesson.kind, "ejemplo"), eq(agentLesson.scope, agent)))
    .limit(1)
  return rows.length > 0
}

/** Ejemplos que se comparan por palabras cuando no hay búsqueda por significado: los más recientes. */
const EXAMPLES_BY_WORDS = 200

/**
 * Lo que el agente ha aprendido y aplica a este turno. Las reglas van todas
 * (son pocas y cortas); de los ejemplos, solo los parecidos a la pregunta:
 * primero los que trajo la búsqueda por significado entre todos
 * (`rankedExampleIds`, de `rankByMeaning`; ADR 0119) y, si falta, los
 * parecidos por palabras entre los más recientes. `skipIds` y `extra` sirven
 * para probar cómo respondería sin una lección o con una que todavía no se
 * aprobó.
 */
export async function lessonsForTurn(
  tx: Db,
  orgId: string,
  agent: string,
  latestText: string,
  opts: {
    skipIds?: readonly string[]
    extra?: Array<{ id: string; kind: LessonKind; title: string; question: string; body: string }>
    rankedExampleIds?: readonly string[]
  } = {},
): Promise<TurnLessons> {
  const columns = { id: agentLesson.id, kind: agentLesson.kind, title: agentLesson.title, question: agentLesson.question, body: agentLesson.body }
  const active = and(eq(agentLesson.organizationId, orgId), eq(agentLesson.status, "activa"), eq(agentLesson.scope, agent))
  // Las reglas, todas: los ejemplos (que solo van si se parecen a la pregunta) no les quitan lugar.
  const ruleRows = await tx
    .select(columns)
    .from(agentLesson)
    .where(and(active, eq(agentLesson.kind, "regla")))
    // Una sola lista (decisión 24): primero lo que escribió la clínica, en su orden; después lo aprendido.
    .orderBy(
      sql`case ${agentLesson.source} when 'escrita' then 0 else 1 end`,
      sql`case ${agentLesson.source} when 'escrita' then ${agentLesson.createdAt} end asc`,
      desc(agentLesson.approvedAt),
      asc(agentLesson.id),
    )
  const exampleRows = await tx
    .select(columns)
    .from(agentLesson)
    .where(and(active, eq(agentLesson.kind, "ejemplo")))
    .orderBy(desc(agentLesson.approvedAt))
    .limit(EXAMPLES_BY_WORDS)
  const ranked = opts.rankedExampleIds ?? []
  // Lo que encontró el significado puede ser más antiguo que los recientes: se lee aparte, solo de este agente.
  const rankedRows = ranked.length
    ? await tx
        .select(columns)
        .from(agentLesson)
        .where(and(active, eq(agentLesson.kind, "ejemplo"), inArray(agentLesson.id, [...ranked])))
    : []
  const rows = [...ruleRows, ...exampleRows]
  const skip = new Set(opts.skipIds ?? [])
  const all = [...(opts.extra ?? []).filter((item) => item.kind !== "respuesta_oficial"), ...rows.filter((row) => !skip.has(row.id))]
  const scored = all.map((lesson) => ({
    lesson,
    score: latestText.trim()
      ? scoreKnowledgeMatch(latestText, { title: lesson.question || lesson.title, body: "", askForms: [] })
      : 0,
  }))
  const allRules = scored.filter((item) => item.lesson.kind === "regla")
  const rules = allRules.slice(0, LESSON_RULE_LIMIT)
  const byMeaning = ranked
    .map((id) => rankedRows.find((row) => row.id === id))
    .filter((row): row is (typeof rankedRows)[number] => row !== undefined && !skip.has(row.id))
    .map((lesson) => ({ lesson, score: TOPIC_SCORE }))
  const byWords = scored
    .filter((item) => item.lesson.kind === "ejemplo" && item.score >= TOPIC_SCORE)
    .sort((a, b) => b.score - a.score)
  const examples = [...byMeaning, ...byWords]
    .filter((item, index, list) => list.findIndex((other) => other.lesson.id === item.lesson.id) === index)
    .slice(0, LESSON_EXAMPLE_LIMIT)
  const matched = [...rules.filter((item) => item.score >= TOPIC_SCORE), ...examples].map((item) => item.lesson)
  return {
    rules: rules.map(({ lesson }) => ({ id: lesson.id, title: lesson.title, body: lesson.body })),
    rulesLeftOut: allRules.length - rules.length,
    examples: examples.map(({ lesson }) => ({ id: lesson.id, title: lesson.title, question: lesson.question, body: lesson.body })),
    matchedIds: matched.map((lesson) => lesson.id),
    matched: matched.map((lesson) => ({ id: lesson.id, kind: lesson.kind, title: lesson.title })),
  }
}

export function formatLessonRules(rules: TurnLessons["rules"], leftOut = 0): string {
  if (rules.length === 0) return ""
  return [
    "Lo que debes saber de tu clínica (lo escribió la clínica o lo aprobó al corregirte). Cúmplelo siempre; si choca con los principios de arriba, ganan los principios:",
    // Lo nuevo ya no pasa de `RULE_BODY_CHARS`; una regla anterior a ese tope llega cortada.
    ...rules.map((rule) => `- ${shorten(rule.body, RULE_BODY_CHARS)}`),
    leftOut > 0 ? `(La clínica tiene ${leftOut} reglas más antiguas que no caben aquí; si algo no está en estas, no lo supongas.)` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

export function formatLessonExamples(examples: TurnLessons["examples"]): string {
  if (examples.length === 0) return ""
  return [
    "Ejemplos que tu clínica aprobó para preguntas parecidas a esta. Sigue su contenido y su tono; no copies datos que no apliquen a este caso:",
    ...examples.map((example) => `- Pregunta: «${shorten(example.question || example.title, 200)}»\n  Respuesta: «${shorten(example.body, 500)}»`),
  ].join("\n")
}

/** Cuenta un uso de las lecciones que tocaron el turno, y de las que dieron la respuesta oficial consultada. */
export async function noteLessonUse(tx: Db, orgId: string, input: { lessonIds?: readonly string[]; entryIds?: readonly string[] }): Promise<void> {
  const lessonIds = [...new Set(input.lessonIds ?? [])].filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const entryIds = [...new Set(input.entryIds ?? [])]
  if (lessonIds.length > 0) {
    await tx
      .update(agentLesson)
      .set({ uses: sql`${agentLesson.uses} + 1`, lastUsedAt: new Date() })
      .where(and(eq(agentLesson.organizationId, orgId), eq(agentLesson.status, "activa"), inArray(agentLesson.id, lessonIds)))
  }
  if (entryIds.length > 0) {
    await tx
      .update(agentLesson)
      .set({ uses: sql`${agentLesson.uses} + 1`, lastUsedAt: new Date() })
      .where(
        and(
          eq(agentLesson.organizationId, orgId),
          eq(agentLesson.status, "activa"),
          eq(agentLesson.kind, "respuesta_oficial"),
          inArray(agentLesson.knowledgeEntryId, entryIds),
        ),
      )
  }
}

/* ---------- La pantalla «Aprender» ---------- */

export interface LearningOverview {
  /** Las más recientes, hasta `REVIEW_PENDING_LIMIT`. */
  review: ReviewItem[]
  /** Todas las que esperan: el mismo número del menú, aunque la lista se corte. */
  reviewTotal: number
  proposed: Array<LessonItem & { impact: LessonImpact }>
  learned: LessonItem[]
  withdrawn: LessonItem[]
  cases: number
  /** Cuántas reglas activas de un agente le llegan como mucho (`LESSON_RULE_LIMIT`): pasado el tope, la pantalla lo dice. */
  ruleLimit: number
}

export async function getLearningOverview(tx: Db, orgId: string): Promise<LearningOverview> {
  await syncReviewQueue(tx, orgId)
  const proposed = await listLessons(tx, orgId, "propuesta")
  const [cases] = await tx
    .select({ total: count() })
    .from(agentTestCase)
    .where(and(eq(agentTestCase.organizationId, orgId), eq(agentTestCase.status, "activo")))
  const withImpact: LearningOverview["proposed"] = []
  for (const lesson of proposed) withImpact.push({ ...lesson, impact: await lessonImpact(tx, orgId, lesson) })
  const [waiting] = await tx
    .select({ total: count() })
    .from(agentReviewItem)
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.status, "pendiente")))
  return {
    review: await listReviewItems(tx, orgId),
    reviewTotal: waiting?.total ?? 0,
    proposed: withImpact,
    learned: await listLessons(tx, orgId, "activa"),
    withdrawn: await listLessons(tx, orgId, "retirada"),
    cases: cases?.total ?? 0,
    ruleLimit: LESSON_RULE_LIMIT,
  }
}

/**
 * Lo que espera a una persona en «Aprender»: respuestas por revisar y lecciones
 * por aprobar. Lo que no encontró se cuenta aunque nadie haya abierto la lista
 * todavía (es la que lo concilia): si no, el menú no avisaría de nada nuevo.
 */
export async function countLearningPending(tx: Db, orgId: string): Promise<{ review: number; lessons: number }> {
  const [review] = await tx
    .select({ total: count() })
    .from(agentReviewItem)
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.status, "pendiente")))
  const [lessons] = await tx
    .select({ total: count() })
    .from(agentLesson)
    .where(and(eq(agentLesson.organizationId, orgId), eq(agentLesson.status, "propuesta")))
  const unreviewed = await tx.execute<{ query: string; question: string }>(sql`
    select g.query, g.question from agent_knowledge_gap g
    where ${unreviewedGap(orgId)}
      -- Su respuesta ya tiene fila: al conciliar se queda en ella, no suma otra.
      and not exists (
        select 1 from agent_answer_trace t
        join agent_review_item r on r.organization_id = t.organization_id and r.trace_id = t.id
        where t.organization_id = g.organization_id and t.conversation_id = g.conversation_id
          and t.trigger_message_id = g.trigger_message_id)
    order by g.created_at asc
    limit 300`)
  let searched = 0
  if (unreviewed.length > 0) {
    const seen = new Set((await pendingGapKeys(tx, orgId)).keys())
    for (const gap of unreviewed) {
      const keys = gapKeys(gap)
      if (!keys.some((key) => seen.has(key))) searched += 1
      for (const key of keys) seen.add(key)
    }
  }
  return { review: (review?.total ?? 0) + searched, lessons: lessons?.total ?? 0 }
}
