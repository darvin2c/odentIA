/**
 * «¿Cambió algo en tu salud o en tus medicinas desde tu última visita?» (mesa de formularios del
 * 13 nov, entrega 10, decisión 5): antes de cada cita suya por venir, si su última declaración de
 * salud tiene más de un mes (`healthCheckDue` de `@odentia/clinical`). Una sola regla para su
 * enlace, el recordatorio y lo que ve recepción. Con «No» queda anotado que dijo que nada cambió,
 * con su fecha; con «Sí» vuelve a responder todo lo de su salud que la clínica pregunta, y eso
 * llega como lo nuevo por revisar. Lo de antes no se borra. Nada de esto traba la atención.
 */
import { healthCheckDue, type RegistrationFieldKey } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { patientHealthDeclaration } from "@odentia/db/schema/clinical"
import { and, eq, gt, inArray, sql } from "drizzle-orm"
import { patientAllHealthQuestions } from "./patient-registration.js"

export interface HealthCheck {
  /** Cuándo fue su última declaración: «desde tu última visita (13 nov)». */
  since: Date
  /** Lo que vuelve a responder si dice que algo cambió: todo lo que la clínica pregunta de su salud. */
  questions: RegistrationFieldKey[]
}

/** Cuándo dijo por última vez algo de su salud (también que nada cambió); nulo si nunca. */
export async function lastHealthSaidAt(tx: Db, orgId: string, patientId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: sql<Date | null>`max(${patientHealthDeclaration.saidAt})`.mapWith(patientHealthDeclaration.saidAt) })
    .from(patientHealthDeclaration)
    .where(and(eq(patientHealthDeclaration.organizationId, orgId), eq(patientHealthDeclaration.patientId, patientId)))
  return row?.at ?? null
}

/**
 * Si antes de esa cita se le pregunta «¿Cambió algo?»: la cita es suya, sigue en pie y es por
 * venir, su última declaración tiene más de un mes y la clínica pregunta algo de su salud. Nulo:
 * no se le pregunta. Al responder (que sí o que no) su última declaración pasa a ser de hoy, así
 * que no se le vuelve a preguntar para esa cita.
 */
export async function healthCheckOf(
  tx: Db,
  orgId: string,
  input: { patientId: string; appointmentId: string | null },
  now: Date = new Date(),
): Promise<HealthCheck | null> {
  if (!input.appointmentId) return null
  const [row] = await tx
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.id, input.appointmentId),
        eq(appointment.patientId, input.patientId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gt(appointment.startsAt, now),
      ),
    )
    .limit(1)
  if (!row) return null
  const since = await lastHealthSaidAt(tx, orgId, input.patientId)
  if (!since || !healthCheckDue(since, now)) return null
  const questions = await patientAllHealthQuestions(tx, orgId, input.patientId)
  return questions.length > 0 ? { since, questions } : null
}
