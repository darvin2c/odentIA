import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { patient } from "@odentia/db/schema/clinical"
import { message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import {
  SAAS_REVIEW_REASONS,
  type SaasReviewReason,
  saasAction,
  saasActionReview,
  saasCharge,
} from "@odentia/db/schema/saas-billing"
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { openSupportCaseFromHelp, replyToSupportCase, setSupportCaseStatus } from "./admin-support.js"
import { sendToSpam } from "./contact-screen-actions.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { currentSaasPeriod, microsToCents } from "./saas-actions.js"

/**
 * «Pedir revisión» de una fila de «Cada acción de tus agentes» (issue 77,
 * ADR 0054). Cualquier fila del mes en curso o del anterior se puede revisar,
 * una vez. Si era spam, se devuelve al instante hasta el 10 % de las
 * conversaciones del mes y la persona pasa a Spam; desde ahí, y en todo lo
 * demás, revisa odentIA en un caso de Soporte. Devuelta antes de cobrarse, la
 * fila no se cobra; ya cobrada, sale como «Devolución por revisión» en el
 * cargo siguiente. Nada se reescribe: la revisión es una fila nueva.
 */

export { SAAS_REVIEW_REASONS } from "@odentia/db/schema/saas-billing"

/** Hasta qué parte de las conversaciones del mes se devuelve el spam sin revisar (decisión 6). */
export const SAAS_REVIEW_AUTO_SHARE = 0.1
/** Días que odentIA puede leer la conversación si la clínica lo permite (decisión 11). */
export const SAAS_REVIEW_READ_DAYS = 7
/** Lo que se promete para responder: días hábiles. */
export const SAAS_REVIEW_ANSWER_DAYS = 2
const NOTE_MAX = 1000
const DAY = 86_400_000

export const SAAS_REVIEW_REASON_WORDS: Record<SaasReviewReason, string> = {
  spam: "Era spam, publicidad o un número equivocado",
  agente: "El agente respondió mal o no ayudó",
  doble: "Se cobró dos veces",
  otro: "Otro motivo",
}

/** Un mes antes, el mismo día (el último del mes si no existe). */
function subMonth(date: Date): Date {
  const prev = new Date(date)
  const day = prev.getUTCDate()
  prev.setUTCDate(1)
  prev.setUTCMonth(prev.getUTCMonth() - 1)
  const last = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).getUTCDate()
  prev.setUTCDate(Math.min(day, last))
  return prev
}

/**
 * El tramo anterior al de hoy: el del último cargo final emitido o, si nunca
 * se cobró, el mes que termina donde empieza el de hoy. Es lo único que se
 * puede revisar además del mes en curso (decisión 7).
 */
export async function previousSaasPeriod(tx: Db, orgId: string, current: { start: Date }): Promise<{ start: Date; end: Date }> {
  const [last] = await tx
    .select({ start: saasCharge.periodStart, end: saasCharge.periodEnd })
    .from(saasCharge)
    .where(and(eq(saasCharge.organizationId, orgId), lte(saasCharge.periodEnd, current.start)))
    .orderBy(desc(saasCharge.periodEnd))
    .limit(1)
  if (last?.start && last.end) return { start: last.start, end: last.end }
  return { start: subMonth(current.start), end: current.start }
}

/** Los dos tramos que se pueden revisar: el de hoy y el anterior. */
export async function reviewablePeriods(tx: Db, orgId: string, now = new Date()) {
  const current = await currentSaasPeriod(tx, orgId, now)
  const previous = await previousSaasPeriod(tx, orgId, current)
  return { current, previous }
}

/**
 * ¿Cabe otra devolución automática en el tramo de esta acción? Hasta el
 * `SAAS_REVIEW_AUTO_SHARE` de sus conversaciones, redondeado hacia arriba:
 * una clínica con pocas conversaciones igual puede devolver una.
 */
async function withinAutoCap(tx: Db, orgId: string, period: { start: Date; end: Date }): Promise<boolean> {
  const inPeriod = and(eq(saasAction.organizationId, orgId), gte(saasAction.occurredAt, period.start), lt(saasAction.occurredAt, period.end))
  const [conversations] = await tx.select({ n: count() }).from(saasAction).where(and(inPeriod, eq(saasAction.kind, "conversacion")))
  const [autos] = await tx
    .select({ n: count() })
    .from(saasActionReview)
    .innerJoin(saasAction, eq(saasAction.id, saasActionReview.actionId))
    .where(and(inPeriod, eq(saasActionReview.organizationId, orgId), eq(saasActionReview.automatic, true)))
  const cap = Math.ceil(SAAS_REVIEW_AUTO_SHARE * Number(conversations?.n ?? 0))
  return Number(autos?.n ?? 0) + 1 <= cap
}

async function isPatientContact(tx: Db, orgId: string, contactId: string): Promise<boolean> {
  const [own] = await tx
    .select({ id: patient.id })
    .from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.personId, contactId)))
    .limit(1)
  return Boolean(own)
}

function moneyWords(priceMicros: number | null, currency: string | null): string {
  if (priceMicros === null) return "sin precio"
  const cents = microsToCents(priceMicros)
  return `${currency ?? ""} ${(cents / 100).toFixed(2).replace(".", ",")}`.trim()
}

const KIND_WORDS: Record<string, string> = { conversacion: "Conversación", consulta: "Consulta dictada", cita: "Cita recuperada" }

export interface ReviewRequestResult {
  status: "pendiente" | "devuelta"
  automatic: boolean
  caseId: string | null
}

type Action = typeof saasAction.$inferSelect

/** Crea la revisión de una acción; la devuelve sola si `automatic`. Sin efectos sobre la persona. */
async function createReview(
  tx: Db,
  orgId: string,
  actor: { userId: string; roleLabel: string },
  action: Action,
  input: { reason: SaasReviewReason; note: string | null; allowRead: boolean; automatic: boolean },
): Promise<ReviewRequestResult> {
  const now = new Date()
  if (input.automatic) {
    await tx.insert(saasActionReview).values({
      organizationId: orgId,
      actionId: action.id,
      reason: input.reason,
      note: input.note,
      requestedByUserId: actor.userId,
      status: "devuelta",
      automatic: true,
      decidedAt: now,
    })
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId: actor.userId,
      action: "saas.review_requested",
      entity: "saas_action",
      entityId: action.id,
      metadata: { reason: input.reason, automatic: true },
    })
    return { status: "devuelta", automatic: true, caseId: null }
  }
  // Lo revisa odentIA: un caso de Soporte con la fila adentro, como cualquier pregunta.
  const kase = await openSupportCaseFromHelp(tx, orgId, {
    userId: actor.userId,
    kind: "cobro",
    question: `Revisión de cobro · ${KIND_WORDS[action.kind] ?? action.kind} del ${action.occurredAt.toISOString().slice(0, 10)} · ${moneyWords(action.priceMicros, action.currency)} · ${SAAS_REVIEW_REASON_WORDS[input.reason]}`,
    detail: input.note,
    screen: "/billing/acciones",
    role: actor.roleLabel,
    appVersion: null,
    dedupeKey: `revision:${action.id}`,
  })
  await tx.insert(saasActionReview).values({
    organizationId: orgId,
    actionId: action.id,
    reason: input.reason,
    note: input.note,
    requestedByUserId: actor.userId,
    readUntil: input.allowRead && action.conversationId ? new Date(now.getTime() + SAAS_REVIEW_READ_DAYS * DAY) : null,
    supportCaseId: kase.id,
  })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: actor.userId,
    action: "saas.review_requested",
    entity: "saas_action",
    entityId: action.id,
    metadata: { reason: input.reason, automatic: false, readAllowed: input.allowRead },
  })
  return { status: "pendiente", automatic: false, caseId: kase.id }
}

/** La acción de la clínica, si está dentro de lo que se puede revisar. */
async function reviewableAction(tx: Db, orgId: string, actionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(actionId)) throw notFound("Acción")
  const [action] = await tx
    .select()
    .from(saasAction)
    .where(and(eq(saasAction.organizationId, orgId), eq(saasAction.id, actionId)))
    .limit(1)
  if (!action) throw notFound("Acción")
  const { current, previous } = await reviewablePeriods(tx, orgId)
  if (action.occurredAt < previous.start || action.occurredAt >= current.end) {
    throw new ServiceError("REVIEW_WINDOW_CLOSED", 409, "Solo se puede pedir revisión de lo de este mes y del anterior")
  }
  const period = action.occurredAt >= current.start ? { start: current.start, end: current.end } : previous
  return { action, period }
}

/**
 * «Pedir revisión» (tablero 6). Spam de una conversación de quien no es
 * paciente: se devuelve al instante si cabe en el tope y la persona pasa a
 * Spam, con todas sus conversaciones cobradas del periodo que se puede
 * revisar. Lo demás, y el spam por encima del tope, va a odentIA.
 */
export async function requestActionReview(
  tx: Db,
  orgId: string,
  actor: { userId: string; roleLabel: string },
  input: { actionId: string; reason: string; note?: string | null; allowRead?: boolean },
): Promise<ReviewRequestResult> {
  if (!(SAAS_REVIEW_REASONS as readonly string[]).includes(input.reason)) {
    throw validation(`Motivo inválido (${SAAS_REVIEW_REASONS.join("|")})`)
  }
  const reason = input.reason as SaasReviewReason
  const note = input.note?.trim() ? input.note.trim() : null
  if (note && note.length > NOTE_MAX) throw validation(`Lo que cuentas admite hasta ${NOTE_MAX} caracteres`)
  const { action, period } = await reviewableAction(tx, orgId, input.actionId)
  if (action.priceMicros === null) throw new ServiceError("REVIEW_NOT_CHARGED", 409, "Esta acción no tiene precio: no se cobra")
  const [existing] = await tx
    .select({ id: saasActionReview.id })
    .from(saasActionReview)
    .where(and(eq(saasActionReview.organizationId, orgId), eq(saasActionReview.actionId, action.id)))
    .limit(1)
  if (existing) throw new ServiceError("REVIEW_EXISTS", 409, "Ya pediste revisar este cobro")
  const spamOfPerson =
    reason === "spam" && action.kind === "conversacion" && action.contactId !== null && !(await isPatientContact(tx, orgId, action.contactId))
  const automatic = spamOfPerson && (await withinAutoCap(tx, orgId, period))
  const result = await createReview(tx, orgId, actor, action, { reason, note, allowRead: Boolean(input.allowRead), automatic })
  // Era spam: la persona pasa a Spam y sus otras conversaciones cobradas se revisan igual.
  if (spamOfPerson && action.contactId) await markSpamAndRefund(tx, orgId, actor, action.contactId)
  return result
}

/**
 * «Es spam» con sus cobros (decisión 5): la persona pasa a Spam y cada
 * conversación suya cobrada en lo que se puede revisar se devuelve sola
 * mientras quepa en el tope; las que no, quedan para odentIA.
 */
export async function markSpamAndRefund(
  tx: Db,
  orgId: string,
  actor: { userId: string; roleLabel: string },
  contactId: string,
): Promise<{ changed: boolean; refunded: number; reviewing: number }> {
  const { changed } = await sendToSpam(tx, orgId, { contactId, userId: actor.userId })
  if (await isPatientContact(tx, orgId, contactId)) return { changed, refunded: 0, reviewing: 0 }
  const { current, previous } = await reviewablePeriods(tx, orgId)
  const actions = await tx
    .select({ action: saasAction })
    .from(saasAction)
    .leftJoin(saasActionReview, and(eq(saasActionReview.organizationId, saasAction.organizationId), eq(saasActionReview.actionId, saasAction.id)))
    .where(
      and(
        eq(saasAction.organizationId, orgId),
        eq(saasAction.contactId, contactId),
        eq(saasAction.kind, "conversacion"),
        gte(saasAction.occurredAt, previous.start),
        lt(saasAction.occurredAt, current.end),
        sql`${saasAction.priceMicros} is not null`,
        isNull(saasActionReview.id),
      ),
    )
    .orderBy(asc(saasAction.occurredAt))
  let refunded = 0
  let reviewing = 0
  for (const { action } of actions) {
    const period = action.occurredAt >= current.start ? { start: current.start, end: current.end } : previous
    const automatic = await withinAutoCap(tx, orgId, period)
    await createReview(tx, orgId, actor, action, { reason: "spam", note: null, allowRead: false, automatic })
    if (automatic) refunded += 1
    else reviewing += 1
  }
  return { changed, refunded, reviewing }
}

/* ---------- Lo que ve y decide odentIA ---------- */

export interface StaffReviewView {
  id: string
  status: "pendiente" | "devuelta" | "mantenida"
  reason: SaasReviewReason
  reasonWords: string
  note: string | null
  requestedAt: Date
  requestedByName: string | null
  /** odentIA puede leer la conversación hasta esta fecha; nulo si no hay permiso. */
  readUntil: Date | null
  answer: string | null
  decidedAt: Date | null
  action: {
    id: string
    kind: string
    occurredAt: Date
    detail: string
    channel: string | null
    priceMicros: number | null
    currency: string | null
    charged: boolean
    hasConversation: boolean
  }
}

/** La revisión de un caso «Revisión de cobro» (con owner, para el personal). */
export async function getReviewOfCase(db: Db, caseId: string): Promise<StaffReviewView | null> {
  const [row] = await db
    .select({ review: saasActionReview, action: saasAction, requester: user.name })
    .from(saasActionReview)
    .innerJoin(saasAction, eq(saasAction.id, saasActionReview.actionId))
    .leftJoin(user, eq(user.id, saasActionReview.requestedByUserId))
    .where(eq(saasActionReview.supportCaseId, caseId))
    .limit(1)
  if (!row) return null
  const now = Date.now()
  return {
    id: row.review.id,
    status: row.review.status as StaffReviewView["status"],
    reason: row.review.reason as SaasReviewReason,
    reasonWords: SAAS_REVIEW_REASON_WORDS[row.review.reason as SaasReviewReason] ?? row.review.reason,
    note: row.review.note,
    requestedAt: row.review.requestedAt,
    requestedByName: row.requester,
    readUntil: row.review.readUntil && row.review.readUntil.getTime() > now ? row.review.readUntil : null,
    answer: row.review.answer,
    decidedAt: row.review.decidedAt,
    action: {
      id: row.action.id,
      kind: row.action.kind,
      occurredAt: row.action.occurredAt,
      detail: row.action.detail,
      channel: row.action.channel,
      priceMicros: row.action.priceMicros,
      currency: row.action.currency,
      charged: row.action.chargeId !== null,
      hasConversation: row.action.conversationId !== null,
    },
  }
}

/**
 * odentIA decide (tablero 7): devolver o mantener, siempre con lo que le dice
 * a la clínica. La respuesta sale como mensaje del caso, el caso queda
 * resuelto y el permiso de leer la conversación termina. Con owner.
 */
export async function decideActionReview(
  db: Db,
  actor: AdminActor,
  input: { caseId: string; accept: boolean; answer: string },
): Promise<void> {
  const answer = input.answer.trim()
  if (!answer) throw validation("Escribe qué le dices a la clínica")
  if (answer.length > NOTE_MAX) throw validation(`La respuesta admite hasta ${NOTE_MAX} caracteres`)
  const [review] = await db.select().from(saasActionReview).where(eq(saasActionReview.supportCaseId, input.caseId)).limit(1)
  if (!review) throw notFound("Revisión")
  const now = new Date()
  const updated = await db
    .update(saasActionReview)
    .set({
      status: input.accept ? "devuelta" : "mantenida",
      decidedAt: now,
      decidedByStaffId: actor.userId,
      answer,
      readUntil: null,
      updatedAt: now,
    })
    .where(and(eq(saasActionReview.id, review.id), eq(saasActionReview.status, "pendiente")))
    .returning({ id: saasActionReview.id })
  if (!updated.length) throw new ServiceError("REVIEW_ALREADY_DECIDED", 409, "Esta revisión ya se respondió")
  await replyToSupportCase(db, actor, input.caseId, answer)
  await setSupportCaseStatus(db, actor, input.caseId, "resuelto")
  await db.insert(auditEvent).values({
    organizationId: review.organizationId,
    actorUserId: actor.userId,
    action: "saas.review_decided",
    entity: "saas_action",
    entityId: review.actionId,
    metadata: { accepted: input.accept },
  })
  await writeAdminAudit(db, actor, {
    action: "saas.review.decided",
    organizationId: review.organizationId,
    entityId: review.id,
    metadata: { accepted: input.accept },
  })
}

/**
 * La conversación de una revisión, solo con el permiso de la clínica y
 * mientras dure (decisión 11). Sin adjuntos; queda en la auditoría del
 * personal. Con owner.
 */
export async function readReviewConversation(
  db: Db,
  actor: AdminActor,
  caseId: string,
): Promise<Array<{ direction: string; senderKind: string; body: string | null; createdAt: Date }>> {
  const [row] = await db
    .select({ review: saasActionReview, conversationId: saasAction.conversationId })
    .from(saasActionReview)
    .innerJoin(saasAction, eq(saasAction.id, saasActionReview.actionId))
    .where(eq(saasActionReview.supportCaseId, caseId))
    .limit(1)
  if (!row?.conversationId) throw notFound("Conversación")
  if (!row.review.readUntil || row.review.readUntil.getTime() <= Date.now()) {
    throw new ServiceError("REVIEW_READ_NOT_ALLOWED", 403, "La clínica no dio permiso para leer esta conversación, o ya venció")
  }
  const messages = await db
    .select({ direction: message.direction, senderKind: message.senderKind, body: message.body, createdAt: message.createdAt })
    .from(message)
    .where(and(eq(message.organizationId, row.review.organizationId), eq(message.conversationId, row.conversationId)))
    .orderBy(asc(message.createdAt))
    .limit(200)
  await writeAdminAudit(db, actor, {
    action: "saas.review.conversation_read",
    organizationId: row.review.organizationId,
    entityId: row.review.id,
  })
  return messages
}

/** Las revisiones devueltas de acciones ya cobradas que aún no salieron en un cargo (con owner). */
export async function pendingReviewCredits(
  tx: Db,
  orgId: string,
): Promise<Array<{ reviewId: string; actionId: string; priceMicros: number; kind: string }>> {
  const rows = await tx
    .select({ reviewId: saasActionReview.id, actionId: saasAction.id, priceMicros: saasAction.priceMicros, kind: saasAction.kind })
    .from(saasActionReview)
    .innerJoin(saasAction, eq(saasAction.id, saasActionReview.actionId))
    .where(
      and(
        eq(saasActionReview.organizationId, orgId),
        eq(saasActionReview.status, "devuelta"),
        isNull(saasActionReview.creditChargeId),
        sql`${saasAction.chargeId} is not null`,
        sql`${saasAction.priceMicros} is not null`,
      ),
    )
    .orderBy(asc(saasActionReview.decidedAt))
  return rows.map((row) => ({ reviewId: row.reviewId, actionId: row.actionId, priceMicros: Number(row.priceMicros), kind: row.kind }))
}

/** Anota en qué cargo se devolvieron (con owner). */
export async function markReviewsCredited(tx: Db, orgId: string, reviewIds: string[], chargeId: string): Promise<void> {
  if (!reviewIds.length) return
  await tx
    .update(saasActionReview)
    .set({ creditChargeId: chargeId, updatedAt: new Date() })
    .where(and(eq(saasActionReview.organizationId, orgId), inArray(saasActionReview.id, reviewIds)))
}
