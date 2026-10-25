/**
 * Semilla manual de Reportes › Agente: lo que el cobro por acción (ADR 0031)
 * contó de la historia de `seed-reports.ts`, con el plan de acciones de la
 * semilla. Solo manual (seed-dev la llama tras `seedReports`); nunca en
 * tests ni CI.
 *
 * - La suscripción de la clínica pasa a activa: 30 días de prueba al empezar
 *   la historia y, desde ahí, un mes por tramo, como los cierra el cobro.
 *   Sigue siendo de demostración: nada se factura.
 * - Una conversación por persona cada 24 horas donde respondió el agente; una
 *   consulta dictada en parte de las atenciones de quienes dictan, desde que
 *   empezaron; una cita recuperada en parte de las citas atendidas que agendó
 *   el agente el último año, tras un mensaje del Administrador que no fue un
 *   recordatorio (el mismo caso de `recoveredSql`).
 * - Algunas conversaciones que atendió el agente pasaron al equipo, que
 *   respondió después: cada tema queda resuelto con su tarea hecha (sin
 *   tarea, un tema sigue abierto para siempre y llena «Te espera»).
 *
 * Determinista: cada decisión sale de una huella de datos que la historia ya
 * fija (fechas y personas), no del orden ni de identificadores al azar. No
 * envía nada ni enciende nada.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { automationJob } from "@odentia/db/schema/automation"
import { agentHandoff } from "@odentia/db/schema/agent"
import { crmTask, message } from "@odentia/db/schema/crm"
import { saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { eq, inArray, sql } from "drizzle-orm"
import { getOrgLocale } from "./locale.js"
import { addMonths, currentMonthIn, monthStart } from "./report-periods.js"
import { CLIO_DETAIL, discountedMicros, planPrices, SOFI_DETAIL } from "./saas-actions.js"
import { SAAS_TERMS_INITIAL } from "./saas-commercial-terms.js"
import { addMonth } from "./saas-invoicing.js"
import { seedSaasBilling } from "./seed-saas-billing.js"

/** El plan de acciones de la semilla (`seed-saas-billing.ts`). */
const ACTION_PLAN_CODE = "odentia-ficticio"
/** Meses de historia de `seed-reports.ts`. */
const MONTHS_BACK = 24
const TRIAL_DAYS = 30
const DAY = 86_400_000
/** De las citas atendidas que agendó el agente el último año, cuántas volvieron tras un mensaje del Administrador. */
const RECOVERED_SHARE = 0.05
/** De las conversaciones que atendió el agente, cuántas pasó al equipo. */
const HANDOFF_SHARE = 0.12
/** Lo que escribió el Administrador antes de la reserva: nunca un recordatorio. */
const RECOVERY_KINDS = [
  { kind: "seguimiento_presupuesto", line: "Retomar un presupuesto" },
  { kind: "seguimiento_no_asistencia", line: "Reprogramar tras una inasistencia" },
  { kind: "cita_cancelada", line: "Ofrecer otra fecha tras una cancelación" },
] as const
const HANDOFF_REASONS = [
  { reason: "Pide hablar con una persona", summary: "Quiere que alguien del equipo le explique el tratamiento." },
  { reason: "Pregunta por un descuento", summary: "Pregunta si hay descuento por pagar al contado." },
  { reason: "Consulta clínica", summary: "Pregunta si puede tomar un antiinflamatorio antes de la cita." },
  { reason: "Pide una factura", summary: "Necesita la factura de su último pago a nombre de su empresa." },
] as const
const CHANNEL_NAME: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
  messenger: "Messenger",
  email: "correo",
  webchat: "el chat web",
}

export interface ReportsAgentSeedInput {
  orgId: string
  /** Quienes dictan sus consultas: desde cuántos meses atrás y qué parte de sus atenciones, al empezar y hoy. */
  dictating: Array<{ userId: string; fromMonthsAgo: number; share: [number, number] }>
  /**
   * El plan con que cobra la historia. Sin él, el de la semilla (que se crea si
   * falta); la demo de producción pasa el plan real y no crea planes.
   */
  planCode?: string
}

/** Un número de 0 a 1 que depende solo del texto: la misma historia da las mismas decisiones. */
function mark(text: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  // Mezcla final: textos que solo cambian al final no caen juntos.
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85eb_ca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2_ae35)
  hash ^= hash >>> 16
  return (hash >>> 0) / 4_294_967_296
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value))

function chunks<T>(items: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

export async function seedReportsAgent(tx: Db, input: ReportsAgentSeedInput): Promise<{ conversations: number; consultations: number; recoveries: number; handoffs: number }> {
  const { orgId } = input
  const planCode = input.planCode ?? ACTION_PLAN_CODE
  if (!input.planCode) await seedSaasBilling(tx)
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.code, planCode)).limit(1)
  if (!plan) throw new Error(`Falta el plan ${planCode}`)
  const price = (micros: number | null) => (micros === null ? null : discountedMicros(micros, 0))
  const priced = (micros: number | null) => ({ currency: plan.currency, basePriceMicros: micros, priceMicros: price(micros), discountBps: 0 })
  const prices = planPrices(plan)

  // --- La suscripción: prueba al empezar la historia y un mes por tramo -------------------
  const { timezone } = await getOrgLocale(tx, orgId)
  const now = new Date()
  const first = addMonths(currentMonthIn(timezone), -MONTHS_BACK)
  const historyStart = monthStart(timezone, first.year, first.month)
  const activatedAt = new Date(historyStart.getTime() + TRIAL_DAYS * DAY)
  let periodStart = activatedAt
  let periodEnd = addMonth(activatedAt)
  while (periodEnd <= now) {
    periodStart = periodEnd
    periodEnd = addMonth(periodEnd)
  }
  await tx
    .update(saasSubscription)
    .set({
      status: "activa",
      planId: plan.id,
      trialStartedAt: historyStart,
      trialEndsAt: activatedAt,
      activatedAt,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      billingCycle: "mensual",
      updatedAt: now,
    })
    .where(eq(saasSubscription.organizationId, orgId))

  // --- Conversaciones que atendió el agente, y las que pasó al equipo ---------------------
  const replies = (await tx.execute(sql`
    select m.created_at, m.conversation_id, c.contact_id, c.external_thread_id, cc.channel
    from message m
    join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
    join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id
    where m.organization_id = ${orgId} and m.direction = 'out' and m.sender_kind = 'agent'
      and c.external_thread_id like 'seed-reportes-%' and m.created_at >= ${historyStart.toISOString()}::timestamptz
    order by m.created_at, c.external_thread_id`)) as unknown as Array<{
    created_at: Date | string
    conversation_id: string
    contact_id: string
    external_thread_id: string
    channel: string
  }>
  const lastOf = new Map<string, number>()
  const conversations: Array<typeof saasAction.$inferInsert> = []
  const handoffs: Array<typeof agentHandoff.$inferInsert> = []
  const tasks: Array<typeof crmTask.$inferInsert> = []
  const teamReplies: Array<typeof message.$inferInsert> = []
  for (const reply of replies) {
    const at = asDate(reply.created_at)
    const last = lastOf.get(reply.contact_id)
    if (last === undefined || at.getTime() - last >= SAAS_TERMS_INITIAL.conversationWindowHours * 3_600_000) {
      lastOf.set(reply.contact_id, at.getTime())
      conversations.push({
        organizationId: orgId,
        kind: "conversacion",
        occurredAt: at,
        contactId: reply.contact_id,
        conversationId: reply.conversation_id,
        channel: reply.channel,
        // Tres de cada diez reservan, mueven o cancelan una cita; las demás preguntan (ADR 0085).
        ...(mark(`tipo:${reply.contact_id}:${at.toISOString()}`) < 0.3
          ? { tier: "gestiona", detail: `${SOFI_DETAIL.gestiona} por ${CHANNEL_NAME[reply.channel] ?? reply.channel}`, ...priced(prices.gestiona) }
          : { tier: "informa", detail: `${SOFI_DETAIL.informa} por ${CHANNEL_NAME[reply.channel] ?? reply.channel}`, ...priced(prices.informa) }),
        dedupeKey: `conversacion:${reply.contact_id}:${at.toISOString()}`,
      })
    }
    const roll = mark(`pase:${reply.external_thread_id}`)
    if (roll < HANDOFF_SHARE) {
      const topic = HANDOFF_REASONS[Math.floor((roll / HANDOFF_SHARE) * HANDOFF_REASONS.length)] ?? HANDOFF_REASONS[0]
      const passedAt = new Date(at.getTime() + 2 * 60_000)
      const answeredAt = new Date(at.getTime() + (12 + Math.floor(mark(`equipo:${reply.external_thread_id}`) * 34)) * 60_000)
      const taskId = randomUUID()
      tasks.push({
        id: taskId,
        organizationId: orgId,
        contactId: reply.contact_id,
        conversationId: reply.conversation_id,
        title: `Te lo pasó Sofi: ${topic.reason}`,
        status: "done",
        createdBy: "agent",
        area: "recepcion",
        createdAt: passedAt,
        updatedAt: answeredAt,
      })
      handoffs.push({
        organizationId: orgId,
        conversationId: reply.conversation_id,
        contactId: reply.contact_id,
        reason: topic.reason,
        summary: topic.summary,
        createdBy: "agent",
        createdAt: passedAt,
        taskId,
        // La misma regla de «Ahora» (decisión 1 del pulido de la Bandeja): aquí, dos horas de reloj.
        urgentAt: new Date(passedAt.getTime() + 2 * 3_600_000),
      })
      teamReplies.push({
        organizationId: orgId,
        conversationId: reply.conversation_id,
        direction: "out",
        senderKind: "user",
        status: "sent",
        body: "Hola, le escribo del equipo de la clínica para ayudarle con lo que consultó.",
        externalId: `seed-reportes-equipo-${reply.external_thread_id}`,
        createdAt: answeredAt,
        sentAt: answeredAt,
      })
    }
  }
  for (const batch of chunks(conversations)) await tx.insert(saasAction).values(batch).onConflictDoNothing()
  for (const batch of chunks(tasks)) await tx.insert(crmTask).values(batch)
  for (const batch of chunks(handoffs)) await tx.insert(agentHandoff).values(batch)
  for (const batch of chunks(teamReplies)) await tx.insert(message).values(batch).onConflictDoNothing()
  // La conversación termina con la respuesta del equipo: la Bandeja ordena por ella.
  if (teamReplies.length > 0) {
    await tx.execute(sql`
      update conversation c set last_message_at = v.at, last_outbound_at = v.at
      from (values ${sql.join(
        teamReplies.map((row) => sql`(${row.conversationId}::uuid, ${(row.createdAt as Date).toISOString()}::timestamptz)`),
        sql`, `,
      )}) as v(id, at)
      where c.organization_id = ${orgId} and c.id = v.id and (c.last_message_at is null or c.last_message_at < v.at)`)
  }

  // --- Consultas dictadas: quienes dictan, cada vez más ------------------------------------
  const names = new Map(
    (
      await tx
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(inArray(user.id, input.dictating.map((item) => item.userId)))
    ).map((row) => [row.id, row.name]),
  )
  const consultations: Array<typeof saasAction.$inferInsert> = []
  for (const professional of input.dictating) {
    const since = addMonths(currentMonthIn(timezone), -professional.fromMonthsAgo)
    const sinceAt = monthStart(timezone, since.year, since.month)
    const span = now.getTime() - sinceAt.getTime()
    const done = (await tx.execute(sql`
      select e.id, e.ended_at, pc.contact_id
      from encounter e
      left join patient_contact pc on pc.organization_id = e.organization_id and pc.patient_id = e.patient_id and pc.relationship = 'self'
      where e.organization_id = ${orgId} and e.professional_user_id = ${professional.userId} and e.status = 'finalizada'
        and e.appointment_id is not null and e.ended_at >= ${sinceAt.toISOString()}::timestamptz
      order by e.ended_at`)) as unknown as Array<{ id: string; ended_at: Date | string; contact_id: string | null }>
    const [from, to] = professional.share
    for (const row of done) {
      const endedAt = asDate(row.ended_at)
      const share = from + (to - from) * Math.min(1, Math.max(0, (endedAt.getTime() - sinceAt.getTime()) / span))
      if (mark(`dictado:${professional.userId}:${endedAt.toISOString()}`) >= share) continue
      const name = names.get(professional.userId)
      // Lo que dejó hecho Clío: una de cada cuatro arma el presupuesto, una de cada tres ordena la consulta (ADR 0085).
      const roll = mark(`tipo:${row.id}`)
      const tier = roll < 0.25 ? "completa" : roll < 0.6 ? "estandar" : "simple"
      consultations.push({
        organizationId: orgId,
        kind: "consulta",
        occurredAt: endedAt,
        contactId: row.contact_id,
        encounterId: row.id,
        tier,
        detail: name ? `${CLIO_DETAIL[tier]} por ${name}` : CLIO_DETAIL[tier],
        ...priced(prices[tier]),
        dedupeKey: `consulta:${row.id}`,
      })
    }
  }
  for (const batch of chunks(consultations)) await tx.insert(saasAction).values(batch).onConflictDoNothing()

  // --- Citas recuperadas: el Administrador escribió y el agente reservó ---------------------
  const yearAgo = addMonths(currentMonthIn(timezone), -12)
  const visits = (await tx.execute(sql`
    select a.id, a.created_at, a.starts_at, a.ends_at, a.source, a.conversation_id, a.patient_id, a.professional_user_id, pc.contact_id
    from appointment a
    join patient_contact pc on pc.organization_id = a.organization_id and pc.patient_id = a.patient_id and pc.relationship = 'self'
    where a.organization_id = ${orgId} and a.status = 'atendida' and a.source in ('agent', 'enlace')
      and a.created_at >= ${monthStart(timezone, yearAgo.year, yearAgo.month).toISOString()}::timestamptz
    order by a.starts_at, a.professional_user_id`)) as unknown as Array<{
    id: string
    created_at: Date | string
    starts_at: Date | string
    ends_at: Date | string
    source: string
    conversation_id: string | null
    patient_id: string
    professional_user_id: string
    contact_id: string
  }>
  const jobs: Array<typeof automationJob.$inferInsert> = []
  const recoveries: Array<typeof saasAction.$inferInsert> = []
  for (const visit of visits) {
    const key = `${asDate(visit.starts_at).toISOString()}:${visit.professional_user_id}`
    const roll = mark(`recuperada:${key}`)
    if (roll >= RECOVERED_SHARE) continue
    const line = RECOVERY_KINDS[Math.floor((roll / RECOVERED_SHARE) * RECOVERY_KINDS.length)] ?? RECOVERY_KINDS[0]
    const bookedAt = asDate(visit.created_at)
    const sentAt = new Date(bookedAt.getTime() - (1 + Math.floor(mark(`mensaje:${key}`) * 5)) * DAY - 3 * 3_600_000)
    jobs.push({
      organizationId: orgId,
      kind: line.kind,
      channel: "whatsapp",
      status: "enviado",
      dedupeKey: `semilla-reportes:${line.kind}:${visit.id}`,
      scheduledFor: sentAt,
      contactId: visit.contact_id,
      patientId: visit.patient_id,
      createdAt: sentAt,
      updatedAt: sentAt,
    })
    const how = visit.source === "enlace" ? "reservó desde el enlace" : "reservó en la conversación"
    recoveries.push({
      organizationId: orgId,
      kind: "cita",
      occurredAt: asDate(visit.ends_at),
      contactId: visit.contact_id,
      conversationId: visit.conversation_id,
      appointmentId: visit.id,
      channel: visit.source,
      windowStart: sentAt,
      detail: `Volvió tras «${line.line}» y ${how}`,
      dedupeKey: `cita:${visit.id}`,
      ...priced(plan.recoveryMicros),
    })
  }
  for (const batch of chunks(jobs)) await tx.insert(automationJob).values(batch).onConflictDoNothing()
  for (const batch of chunks(recoveries)) await tx.insert(saasAction).values(batch).onConflictDoNothing()

  return { conversations: conversations.length, consultations: consultations.length, recoveries: recoveries.length, handoffs: handoffs.length }
}
