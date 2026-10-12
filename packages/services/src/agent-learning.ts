import type { Db } from "@odentia/db"
import {
  agentAnswerTrace,
  agentKnowledgeEntry,
  agentLesson,
  agentReviewItem,
  agentTestCase,
  type AnswerBasisItem,
  type AnswerCheck,
  CORRECTION_FAILURES,
  type CorrectionFailure,
  LESSON_KINDS,
  type LessonKind,
  type LessonStatus,
  type ReviewReason,
} from "@odentia/db/schema/agent"
import { user } from "@odentia/db/schema/auth"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import {
  createKnowledgeEntry,
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
const LESSON_BODY_CHARS = 2000
const LESSON_TITLE_CHARS = 200
/** Reglas que caben en el prompt; las más recientes ganan. */
export const LESSON_RULE_LIMIT = 20
/** Ejemplos que acompañan un turno: solo los parecidos a lo que se pregunta. */
export const LESSON_EXAMPLE_LIMIT = 2
/** Puntuación mínima para decir que una pregunta toca el tema de una lección o de un caso. */
const TOPIC_SCORE = 30
/** Puntuación mínima para proponer cambiar una respuesta oficial existente en vez de crear otra. */
const SAME_ANSWER_SCORE = 300

export interface ReviewItem {
  id: string
  agent: string
  conversationId: string
  traceId: string
  reason: ReviewReason
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

/** De dónde sale una lección: una corrección, un borrador cambiado al aprobar o una respuesta que se dio por buena. */
export type LessonOrigin = "correccion" | "borrador_editado" | "respuesta_buena"

export interface LessonItem {
  id: string
  kind: LessonKind
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

function cleanText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw validation(`${label} es obligatorio`)
  const text = value.trim()
  if (text.length > max) throw validation(`${label} admite hasta ${max} caracteres`)
  return text
}

function shorten(text: string, max: number): string {
  const clean = text.replace(/[ \t\r\n]+/g, " ").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

function scopeOf(kind: LessonKind, agent: string): string {
  // Un dato es de toda la clínica; una regla o un ejemplo, solo del agente que lo recibió.
  return kind === "respuesta_oficial" ? "clinica" : agent
}

async function audit(tx: Db, orgId: string, actorUserId: string | null, action: string, entity: string, entityId: string, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action, entity, entityId, metadata })
}

/** Dos textos preguntan lo mismo si comparten casi todas sus palabras. */
function sameQuestion(a: string, b: string): boolean {
  const left = new Set(normalizeForSearch(a).split(" ").filter((word) => word.length >= 3))
  const right = new Set(normalizeForSearch(b).split(" ").filter((word) => word.length >= 3))
  if (left.size === 0 || right.size === 0) return false
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / Math.min(left.size, right.size) >= 0.6 && shared >= 2
}

/* ---------- Por revisar ---------- */

/**
 * Añade a «Por revisar» las respuestas enviadas que algo hace dudar: el equipo
 * escribió justo después, el interlocutor repitió la pregunta, o cayó en la
 * muestra al azar. Se concilia al consultar; es idempotente por respuesta.
 * Son señales para que mire una persona, no un veredicto de que estuvo mal.
 */
export async function syncReviewQueue(tx: Db, orgId: string): Promise<number> {
  const rows = await tx.execute<{
    id: string
    conversation_id: string
    agent: string
    reply_text: string
    question: string | null
    next_direction: string | null
    next_sender: string | null
    next_body: string | null
    next_soon: boolean | null
    sampled: boolean
  }>(sql`
    select t.id, t.conversation_id, t.agent, t.reply_text,
           (select q.body from message q where q.organization_id = t.organization_id and q.id = t.trigger_message_id) as question,
           nxt.direction as next_direction, nxt.sender_kind as next_sender, nxt.body as next_body,
           (nxt.created_at - t.created_at) <= make_interval(mins => ${TEAM_TOOK_MINUTES}) as next_soon,
           (abs(hashtext(t.id::text)) % ${REVIEW_SAMPLE_ONE_IN}) = 0 as sampled
    from agent_answer_trace t
    left join lateral (
      select m.direction, m.sender_kind, m.body, m.created_at from message m
      where m.organization_id = t.organization_id and m.conversation_id = t.conversation_id
        and m.created_at > t.created_at and m.id is distinct from t.message_id
        and m.sender_kind <> 'agent'
      order by m.created_at asc limit 1
    ) nxt on true
    where t.organization_id = ${orgId} and t.outcome = 'enviada'
      and t.created_at >= now() - make_interval(days => ${REVIEW_WINDOW_DAYS})
      and not exists (
        select 1 from agent_review_item r where r.organization_id = t.organization_id and r.trace_id = t.id)
    order by t.created_at desc
    limit 200`)
  let added = 0
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
        question: question.slice(0, 2000),
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
  return rows.map(toReviewItem)
}

async function requireReviewItem(tx: Db, orgId: string, id: string): Promise<ReviewItem> {
  const [row] = await reviewQuery(tx)
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.id, id)))
    .limit(1)
  if (!row) throw notFound("Respuesta por revisar")
  return toReviewItem(row)
}

/**
 * «Estuvo bien»: sale de la lista. Con `asExample`, además propone guardar esa
 * respuesta como ejemplo para preguntas parecidas; como toda lección, espera
 * la aprobación de quien administra el agente.
 */
export async function markReviewOk(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: { asExample?: boolean } = {},
): Promise<LessonItem | null> {
  const item = input.asExample ? await requireReviewItem(tx, orgId, id) : null
  if (item && !item.question.trim()) throw validation("Esa respuesta no tiene una pregunta que sirva de ejemplo")
  const [row] = await tx
    .update(agentReviewItem)
    .set({ status: "bien", decidedBy: actorUserId, decidedAt: new Date() })
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.id, id), eq(agentReviewItem.status, "pendiente")))
    .returning({ id: agentReviewItem.id })
  if (!row) {
    await requireReviewItem(tx, orgId, id)
    throw new ServiceError("REVIEW_NOT_PENDING", 409, "Esa respuesta ya se revisó")
  }
  await audit(tx, orgId, actorUserId, "agent.review_ok", "agent_review_item", id, { asExample: item !== null })
  if (!item) return null
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
  if (trace.triggerMessageId) {
    const [asked] = await tx
      .select({ body: message.body })
      .from(message)
      .where(and(eq(message.organizationId, orgId), eq(message.id, trace.triggerMessageId)))
      .limit(1)
    question = asked?.body ?? ""
  }
  const [row] = await tx
    .insert(agentReviewItem)
    .values({
      organizationId: orgId,
      agent: trace.agent,
      conversationId: trace.conversationId,
      traceId,
      reason: "marcada",
      question: question.slice(0, 2000),
      reply: trace.replyText,
    })
    .returning({ id: agentReviewItem.id })
  if (!row) throw new Error("No se pudo marcar la respuesta")
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
  // De dónde sale: la respuesta revisada dice de qué agente era y si fue un borrador cambiado al aprobar.
  const reviewIds = rows.map((row) => row.reviewItemId).filter((id): id is string => id !== null)
  const reviews = reviewIds.length
    ? await tx
        .select({ id: agentReviewItem.id, agent: agentReviewItem.agent, reason: agentReviewItem.reason })
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
      scope: row.scope,
      agent: row.scope !== "clinica" ? row.scope : (review?.agent ?? "recepcion"),
      origin: (review?.reason === "editada" ? "borrador_editado" : row.failure === null ? "respuesta_buena" : "correccion") as LessonOrigin,
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
  const rows = await tx
    .select()
    .from(agentLesson)
    .where(and(eq(agentLesson.organizationId, orgId), eq(agentLesson.status, status)))
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
  if (input.failure === "no_debio_responder") {
    return {
      kind: "regla",
      title: shorten(asked ? `No responder: ${asked}` : "No responder por su cuenta", LESSON_TITLE_CHARS),
      body: input.corrected || RULE_FOR_NO_ANSWER(asked || "esto"),
    }
  }
  if (input.failure === "dato_equivocado" || input.failure === "falto_dato") {
    return { kind: "respuesta_oficial", title: shorten(asked || input.corrected, LESSON_TITLE_CHARS), body: input.corrected }
  }
  return {
    kind: "ejemplo",
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

export interface CorrectAnswerInput {
  /** La entrada de «Por revisar»; o la respuesta marcada desde la Bandeja (`traceId`). */
  reviewItemId?: string
  traceId?: string
  failure: string
  correctedReply?: string
}

/**
 * Corrige una respuesta del agente. No cambia nada por sí sola: deja una
 * lección propuesta que alguien que administra el agente aprueba o descarta.
 */
export async function correctAnswer(tx: Db, orgId: string, actorUserId: string, input: CorrectAnswerInput): Promise<LessonItem> {
  if (!(CORRECTION_FAILURES as readonly string[]).includes(input.failure)) throw validation("Indica qué falló")
  const failure = input.failure as CorrectionFailure
  const corrected = typeof input.correctedReply === "string" ? input.correctedReply.trim() : ""
  if (!corrected && failure !== "no_debio_responder") throw validation("Escribe cómo debió responder")
  if (corrected.length > LESSON_BODY_CHARS) throw validation(`La respuesta admite hasta ${LESSON_BODY_CHARS} caracteres`)
  let item: ReviewItem
  if (input.reviewItemId) item = await requireReviewItem(tx, orgId, input.reviewItemId)
  else if (input.traceId) item = await flagAnswerForReview(tx, orgId, actorUserId, input.traceId)
  else throw validation("Indica qué respuesta corriges")
  const [claimed] = await tx
    .update(agentReviewItem)
    .set({ status: "corregida", decidedBy: actorUserId, decidedAt: new Date() })
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.id, item.id), eq(agentReviewItem.status, "pendiente")))
    .returning({ id: agentReviewItem.id })
  if (!claimed) throw new ServiceError("REVIEW_NOT_PENDING", 409, "Esa respuesta ya se revisó")
  return insertLesson(tx, orgId, actorUserId, {
    agent: item.agent,
    failure,
    question: item.question,
    corrected,
    originalReply: item.reply,
    reviewItemId: item.id,
    conversationId: item.conversationId,
  })
}

/**
 * El equipo cambió el borrador de un mensaje antes de aprobarlo: el mensaje ya
 * salió con su texto, y aquí queda propuesto guardarlo para la próxima vez.
 */
export async function proposeLessonFromEditedApproval(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { proposalId: string; conversationId: string | null; originalText: string; editedText: string },
): Promise<LessonItem | null> {
  if (normalizeForSearch(input.originalText) === normalizeForSearch(input.editedText)) return null
  const [trace] = await tx
    .select()
    .from(agentAnswerTrace)
    .where(and(eq(agentAnswerTrace.organizationId, orgId), eq(agentAnswerTrace.proposalId, input.proposalId)))
    .orderBy(desc(agentAnswerTrace.createdAt))
    .limit(1)
  let question = ""
  let reviewItemId: string | null = null
  if (trace) {
    if (trace.triggerMessageId) {
      const [asked] = await tx
        .select({ body: message.body })
        .from(message)
        .where(and(eq(message.organizationId, orgId), eq(message.id, trace.triggerMessageId)))
        .limit(1)
      question = asked?.body ?? ""
    }
    const [item] = await tx
      .insert(agentReviewItem)
      .values({
        organizationId: orgId,
        agent: trace.agent,
        conversationId: trace.conversationId,
        traceId: trace.id,
        reason: "editada",
        question: question.slice(0, 2000),
        reply: input.originalText.slice(0, 4000),
        teamReply: input.editedText.slice(0, 4000),
        status: "corregida",
        decidedBy: actorUserId,
        decidedAt: new Date(),
      })
      .onConflictDoNothing({ target: [agentReviewItem.organizationId, agentReviewItem.traceId] })
      .returning({ id: agentReviewItem.id })
    reviewItemId = item?.id ?? null
  }
  return insertLesson(tx, orgId, actorUserId, {
    agent: trace?.agent ?? "recepcion",
    failure: "falto_dato",
    question,
    corrected: input.editedText.slice(0, LESSON_BODY_CHARS),
    originalReply: input.originalText,
    reviewItemId,
    conversationId: input.conversationId,
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
  if (input.kind !== undefined && !(LESSON_KINDS as readonly string[]).includes(input.kind)) throw validation("Clase de lección desconocida")
  const kind = (input.kind as LessonKind | undefined) ?? current.kind
  const agent = current.scope === "clinica" ? "recepcion" : current.scope
  let knowledgeEntryId = current.knowledgeEntryId
  if (kind !== "respuesta_oficial" || input.knowledgeEntryId === null) knowledgeEntryId = null
  else if (kind !== current.kind) knowledgeEntryId = await matchingAnswer(tx, orgId, current.question)
  await tx
    .update(agentLesson)
    .set({
      title: input.title === undefined ? current.title : cleanText(input.title, "El título", LESSON_TITLE_CHARS),
      body: input.body === undefined ? current.body : cleanText(input.body, "El texto", LESSON_BODY_CHARS),
      kind,
      scope: scopeOf(kind, agent),
      knowledgeEntryId,
      updatedAt: new Date(),
    })
    .where(eq(agentLesson.id, id))
  await audit(tx, orgId, actorUserId, "agent.lesson_edited", "agent_lesson", id, { kind })
  return getLesson(tx, orgId, id)
}

/** Pone en el conocimiento lo que dice una lección de respuesta oficial; devuelve la entrada y lo que había. */
async function applyOfficialAnswer(
  tx: Db,
  orgId: string,
  actorUserId: string,
  lesson: typeof agentLesson.$inferSelect,
): Promise<{ entryId: string; previousBody: string | null }> {
  const askForms = lesson.question.trim() && normalizeForSearch(lesson.question) !== normalizeForSearch(lesson.title)
    ? [shorten(lesson.question, 120)]
    : []
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
        askForms: [...new Set([...entry.askForms, ...askForms])],
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
export async function approveLesson(tx: Db, orgId: string, actorUserId: string, id: string): Promise<LessonItem> {
  const lesson = await lockLesson(tx, orgId, id)
  if (lesson.status !== "propuesta") throw new ServiceError("LESSON_NOT_PROPOSED", 409, `La lección ya está ${lesson.status}`)
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
  await keepTestCase(tx, orgId, actorUserId, lesson)
  await audit(tx, orgId, actorUserId, "agent.lesson_approved", "agent_lesson", id, { kind: lesson.kind })
  return getLesson(tx, orgId, id)
}

export async function discardLesson(tx: Db, orgId: string, actorUserId: string, id: string): Promise<LessonItem> {
  const lesson = await lockLesson(tx, orgId, id)
  if (lesson.status !== "propuesta") throw new ServiceError("LESSON_NOT_PROPOSED", 409, `La lección ya está ${lesson.status}`)
  await tx.update(agentLesson).set({ status: "descartada", updatedAt: new Date() }).where(eq(agentLesson.id, id))
  await audit(tx, orgId, actorUserId, "agent.lesson_discarded", "agent_lesson", id)
  return getLesson(tx, orgId, id)
}

/**
 * Retirar deja de usar la lección al instante y devuelve el conocimiento a
 * como estaba: restaura el texto anterior de la respuesta que cambió, o
 * despublica la que creó. Si alguien cambió esa respuesta después, no se toca:
 * manda lo último que escribió una persona.
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
      if (lesson.previousBody !== null) await updateKnowledgeEntry(tx, orgId, actorUserId, entry.id, { body: lesson.previousBody })
      else await setKnowledgeStatus(tx, orgId, actorUserId, entry.id, "borrador")
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
  const question = cleanText(input.question, "La pregunta", 2000)
  const expected = cleanText(input.expected, "La respuesta esperada", 4000)
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
  /** Reglas activas del agente: van siempre en su prompt. */
  rules: Array<{ id: string; title: string; body: string }>
  /** Ejemplos aprobados parecidos a lo que se pregunta ahora. */
  examples: Array<{ id: string; title: string; question: string; body: string }>
  /** Lecciones que tocan el tema del mensaje: las que cuentan como usadas en este turno. */
  matchedIds: string[]
  matched: Array<{ id: string; kind: LessonKind; title: string }>
}

/**
 * Lo que el agente ha aprendido y aplica a este turno. Las reglas van todas
 * (son pocas y cortas); de los ejemplos, solo los parecidos a la pregunta.
 * `skipIds` y `extra` sirven para probar cómo respondería sin una lección o
 * con una que todavía no se aprobó.
 */
export async function lessonsForTurn(
  tx: Db,
  orgId: string,
  agent: string,
  latestText: string,
  opts: { skipIds?: readonly string[]; extra?: Array<{ id: string; kind: LessonKind; title: string; question: string; body: string }> } = {},
): Promise<TurnLessons> {
  const rows = await tx
    .select({ id: agentLesson.id, kind: agentLesson.kind, title: agentLesson.title, question: agentLesson.question, body: agentLesson.body })
    .from(agentLesson)
    .where(
      and(
        eq(agentLesson.organizationId, orgId),
        eq(agentLesson.status, "activa"),
        eq(agentLesson.scope, agent),
        inArray(agentLesson.kind, ["regla", "ejemplo"]),
      ),
    )
    .orderBy(desc(agentLesson.approvedAt))
    .limit(200)
  const skip = new Set(opts.skipIds ?? [])
  const all = [...(opts.extra ?? []).filter((item) => item.kind !== "respuesta_oficial"), ...rows.filter((row) => !skip.has(row.id))]
  const scored = all.map((lesson) => ({
    lesson,
    score: latestText.trim()
      ? scoreKnowledgeMatch(latestText, { title: lesson.question || lesson.title, body: "", askForms: [] })
      : 0,
  }))
  const rules = scored.filter((item) => item.lesson.kind === "regla").slice(0, LESSON_RULE_LIMIT)
  const examples = scored
    .filter((item) => item.lesson.kind === "ejemplo" && item.score >= TOPIC_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, LESSON_EXAMPLE_LIMIT)
  const matched = [...rules.filter((item) => item.score >= TOPIC_SCORE), ...examples].map((item) => item.lesson)
  return {
    rules: rules.map(({ lesson }) => ({ id: lesson.id, title: lesson.title, body: lesson.body })),
    examples: examples.map(({ lesson }) => ({ id: lesson.id, title: lesson.title, question: lesson.question, body: lesson.body })),
    matchedIds: matched.map((lesson) => lesson.id),
    matched: matched.map((lesson) => ({ id: lesson.id, kind: lesson.kind, title: lesson.title })),
  }
}

export function formatLessonRules(rules: TurnLessons["rules"]): string {
  if (rules.length === 0) return ""
  return [
    "Reglas que tu clínica aprobó al corregirte. Cúmplelas siempre; si chocan con los principios de arriba, ganan los principios:",
    ...rules.map((rule) => `- ${shorten(rule.body, 300)}`),
  ].join("\n")
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
  review: ReviewItem[]
  proposed: Array<LessonItem & { impact: LessonImpact }>
  learned: LessonItem[]
  withdrawn: LessonItem[]
  cases: number
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
  return {
    review: await listReviewItems(tx, orgId),
    proposed: withImpact,
    learned: await listLessons(tx, orgId, "activa"),
    withdrawn: await listLessons(tx, orgId, "retirada"),
    cases: cases?.total ?? 0,
  }
}

/** Lo que espera a una persona en «Aprender»: respuestas por revisar y lecciones por aprobar. */
export async function countLearningPending(tx: Db, orgId: string): Promise<{ review: number; lessons: number }> {
  const [review] = await tx
    .select({ total: count() })
    .from(agentReviewItem)
    .where(and(eq(agentReviewItem.organizationId, orgId), eq(agentReviewItem.status, "pendiente")))
  const [lessons] = await tx
    .select({ total: count() })
    .from(agentLesson)
    .where(and(eq(agentLesson.organizationId, orgId), eq(agentLesson.status, "propuesta")))
  return { review: review?.total ?? 0, lessons: lessons?.total ?? 0 }
}
