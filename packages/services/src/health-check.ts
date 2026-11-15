/**
 * «¿Cambió algo en tu salud o en tus medicinas desde tu última visita?» (mesa de formularios del
 * 13 nov, entrega 10, decisión 5): antes de cada cita suya por venir, si lo último que se supo de su
 * salud tiene más de un mes (`healthCheckDue` de `@odentia/clinical`). Una sola regla para su
 * enlace, el recordatorio y lo que ve recepción. Con «No» queda anotado que dijo que nada cambió,
 * con su fecha; con «Sí» elige qué cambió (sus medicinas, sus enfermedades o sus alergias) y vuelve a
 * responder solo eso, que llega como lo nuevo por revisar. Lo de antes no se borra. Nada de esto
 * traba la atención.
 */
import { healthCheckDue, type RegistrationFieldKey } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { and, eq, sql } from "drizzle-orm"
import { patientAllHealthQuestions } from "./patient-registration.js"
import { unfinishedAppointmentOf } from "./visit-answers.js"

export interface HealthCheck {
  /** Cuándo fue su última declaración: «desde tu última visita (13 nov)». */
  since: Date
  /** Lo que vuelve a responder si dice que algo cambió: todo lo que la clínica pregunta de su salud. */
  questions: RegistrationFieldKey[]
}

/**
 * Lo último que se supo de su salud: cuándo lo dijo (también que nada cambió) o cuándo el equipo
 * guardó o revisó sus antecedentes, o negó algo en la atención (revisión final del 15 nov, D3). Así
 * «¿Cambió algo?» llega también a quien nunca declaró y solo tiene lo que anotó el equipo. Nulo si
 * nadie supo nada todavía: entonces se le pregunta lo que falta, dato por dato.
 */
export async function lastHealthKnownAt(tx: Db, orgId: string, patientId: string): Promise<Date | null> {
  const [row] = await tx.execute<{ at: Date | string | null }>(sql`
    select greatest(
      (select max(said_at) from patient_health_declaration where organization_id = ${orgId} and patient_id = ${patientId}),
      (select max(created_at) from audit_event
        where organization_id = ${orgId} and entity = 'patient' and entity_id = ${patientId}
          and action in ('health.saved', 'health.reviewed', 'health.denied'))
    ) as at`)
  return row?.at ? new Date(row.at) : null
}

/**
 * Si antes de esa cita se le pregunta «¿Cambió algo?»: la cita es suya, sigue en pie y no terminó
 * (por venir o en curso, como «Tu visita»), su última declaración tiene más de un mes y la clínica
 * pregunta algo de su salud. Nulo:
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
    .where(and(eq(appointment.id, input.appointmentId), unfinishedAppointmentOf(orgId, input.patientId, now)))
    .limit(1)
  if (!row) return null
  const since = await lastHealthKnownAt(tx, orgId, input.patientId)
  if (!since || !healthCheckDue(since, now)) return null
  const questions = await patientAllHealthQuestions(tx, orgId, input.patientId)
  return questions.length > 0 ? { since, questions } : null
}
