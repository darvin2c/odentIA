/**
 * Lo que ve recepción de «Antes de su cita» (mesa de formularios del 13 nov, entrega 10, caso
 * C10): si ya respondió lo que se le pregunta antes de su próxima cita, o si está por responder, y
 * cuándo se le envió su enlace. Nunca qué respondió: eso lo lee el equipo clínico. Es estado, no
 * contenido: viaja con `patients.write`, como «Faltan datos», sin un permiso nuevo y sin tocar lo
 * clínico (`clinical.alerts` sigue siendo la única excepción, y solo con las alergias).
 */
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { patientHealthDeclaration } from "@odentia/db/schema/clinical"
import { appointmentVisitAnswer } from "@odentia/db/schema/clinical-forms"
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm"
import { healthCheckOf } from "./health-check.js"
import { patientHealthToAsk } from "./patient-registration.js"
import { nextAppointmentIdOf, visitAskOf } from "./visit-answers.js"

export interface BeforeVisitStatus {
  /** Su próxima cita, la que lo pide. */
  appointmentId: string
  startsAt: Date
  /** `respondio`: no le queda nada por responder y respondió; `por_responder`: le queda algo. */
  state: "respondio" | "por_responder"
  /** Cuándo respondió por última vez lo de esta cita (su visita o su salud); nulo si nada. */
  answeredAt: Date | null
  /**
   * Cuándo salió por última vez un mensaje con su enlace, y por dónde (`whatsapp`, `email`,
   * `webchat`…, el canal de esa conversación). Salió de verdad: aceptado por el canal, no solo
   * encolado. Nulo si nunca salió.
   */
  linkSent: { at: Date; channel: string } | null
}

/** La última cita suya que ya pasó; una cancelada no fue una visita. */
async function lastVisitAt(tx: Db, orgId: string, patientId: string, now: Date): Promise<Date | null> {
  const [row] = await tx
    .select({ startsAt: appointment.startsAt })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        lte(appointment.startsAt, now),
        sql`${appointment.status} <> 'cancelada'`,
      ),
    )
    .orderBy(desc(appointment.startsAt))
    .limit(1)
  return row?.startsAt ?? null
}

/** Cuándo salió por última vez su enlace (cualquiera de los suyos) y por qué canal. */
async function linkSentOf(tx: Db, orgId: string, patientId: string): Promise<BeforeVisitStatus["linkSent"]> {
  const rows = await tx.execute<{ at: Date | string; channel: string }>(sql`
    select coalesce(m.sent_at, m.created_at) as at, cc.channel
    from message m
    join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
    join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id
    where m.organization_id = ${orgId} and m.direction = 'out' and m.status in ('sent', 'delivered', 'read')
      and exists (
        select 1 from appointment_booking_link l
        where l.organization_id = m.organization_id and l.patient_id = ${patientId}
          and (strpos(coalesce(m.body, ''), '{{su-enlace:' || l.id::text || '}}') > 0
            or strpos(coalesce(m.template_link, ''), l.id::text) > 0))
    order by coalesce(m.sent_at, m.created_at) desc
    limit 1`)
  const [row] = rows
  return row ? { at: new Date(row.at), channel: row.channel } : null
}

/**
 * El estado de «Antes de su cita» para su próxima cita: por responder si se le pregunta lo de su
 * visita, «¿Cambió algo?» o algo de su salud que nadie le preguntó; respondió si ya no le queda
 * nada y contó algo desde su última visita. Nulo sin cita por venir o si no hay nada que decir
 * (la clínica no le pregunta nada y no respondió nada). Lo que le falta de sus datos ya lo dice
 * «Faltan datos».
 */
export async function beforeVisitStatus(
  tx: Db,
  orgId: string,
  patientId: string,
  now: Date = new Date(),
): Promise<BeforeVisitStatus | null> {
  const appointmentId = await nextAppointmentIdOf(tx, orgId, patientId)
  if (!appointmentId) return null
  const [next] = await tx
    .select({ startsAt: appointment.startsAt })
    .from(appointment)
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, appointmentId)))
    .limit(1)
  if (!next) return null
  const pending =
    (await visitAskOf(tx, orgId, { patientId, appointmentId })) !== null ||
    (await healthCheckOf(tx, orgId, { patientId, appointmentId }, now)) !== null ||
    (await patientHealthToAsk(tx, orgId, patientId))
  const since = await lastVisitAt(tx, orgId, patientId, now)
  const [visit] = await tx
    .select({ at: appointmentVisitAnswer.submittedAt })
    .from(appointmentVisitAnswer)
    .where(and(eq(appointmentVisitAnswer.organizationId, orgId), eq(appointmentVisitAnswer.appointmentId, appointmentId)))
    .limit(1)
  // Lo que contó de su salud desde su enlace después de su última visita: es para esta cita.
  const [health] = await tx
    .select({ at: patientHealthDeclaration.saidAt })
    .from(patientHealthDeclaration)
    .where(
      and(
        eq(patientHealthDeclaration.organizationId, orgId),
        eq(patientHealthDeclaration.patientId, patientId),
        inArray(patientHealthDeclaration.via, ["enlace"]),
        ...(since ? [gt(patientHealthDeclaration.saidAt, since)] : []),
      ),
    )
    .orderBy(desc(patientHealthDeclaration.saidAt))
    .limit(1)
  const answered = [visit?.at, health?.at].filter((at): at is Date => !!at)
  const answeredAt = answered.length > 0 ? new Date(Math.max(...answered.map((at) => at.getTime()))) : null
  if (!pending && !answeredAt) return null
  return {
    appointmentId,
    startsAt: next.startsAt,
    state: pending ? "por_responder" : "respondio",
    answeredAt,
    linkSent: await linkSentOf(tx, orgId, patientId),
  }
}
