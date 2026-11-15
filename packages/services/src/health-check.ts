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
import { patientHealthDeclaration } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
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

/** Lo que hace el equipo con su salud: guardar sus antecedentes, revisarlos con ella o negar algo en la atención. */
const STAFF_HEALTH_ACTIONS = ["health.saved", "health.reviewed", "health.denied"]

/**
 * Lo último que se supo de su salud: cuándo lo dijo (también que nada cambió) o cuándo el equipo
 * guardó o revisó sus antecedentes (revisión final del 15 nov, D3). Así «¿Cambió algo?» llega también
 * a quien nunca declaró y solo tiene lo que anotó el equipo. Nulo si nadie supo nada todavía: entonces
 * se le pregunta lo que falta, dato por dato.
 */
export async function lastHealthKnownAt(tx: Db, orgId: string, patientId: string): Promise<Date | null> {
  const said = await lastHealthSaidAt(tx, orgId, patientId)
  const [staff] = await tx
    .select({ at: sql<Date | null>`max(${auditEvent.createdAt})`.mapWith(auditEvent.createdAt) })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, orgId),
        eq(auditEvent.entity, "patient"),
        eq(auditEvent.entityId, patientId),
        inArray(auditEvent.action, STAFF_HEALTH_ACTIONS),
      ),
    )
  const known = [said, staff?.at ?? null].filter((at): at is Date => at !== null)
  return known.length > 0 ? new Date(Math.max(...known.map((at) => at.getTime()))) : null
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
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.id, input.appointmentId),
        eq(appointment.patientId, input.patientId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gt(appointment.endsAt, now),
      ),
    )
    .limit(1)
  if (!row) return null
  const since = await lastHealthKnownAt(tx, orgId, input.patientId)
  if (!since || !healthCheckDue(since, now)) return null
  const questions = await patientAllHealthQuestions(tx, orgId, input.patientId)
  return questions.length > 0 ? { since, questions } : null
}
