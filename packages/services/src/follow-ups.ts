import { FOLLOW_UP_REPEAT_MONTHS, FOLLOW_UP_STATUSES } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import {
  clinicalFollowUp,
  encounter,
  encounterProcedure,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, sql } from "drizzle-orm"
import { type CreateAppointmentInput, createAppointment } from "./appointments.js"
import { requireEncounter } from "./encounters.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { findOrgLocale } from "./locale.js"
import { requirePatient } from "./patients.js"

export type ScheduleFollowUpInput =
  | { appointmentId: string }
  | {
      appointment: Omit<
        CreateAppointmentInput,
        "patientId" | "status" | "reason" | "source" | "conversationId"
      >
    }

async function detail(tx: Db, orgId: string, patientId: string, id: string) {
  const [result] = await selectFollowUps(tx).where(scoped(orgId, patientId, id))
  if (!result) throw notFound("Control")
  return present(result)
}

function selectFollowUps(tx: Db) {
  return tx
    .select({
      control: clinicalFollowUp,
      appointment: {
        id: appointment.id,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status,
      },
    })
    .from(clinicalFollowUp)
    .leftJoin(
      appointment,
      and(
        eq(appointment.id, clinicalFollowUp.appointmentId),
        eq(appointment.organizationId, clinicalFollowUp.organizationId),
        eq(appointment.patientId, clinicalFollowUp.patientId),
      ),
    )
}

function present(row: {
  control: typeof clinicalFollowUp.$inferSelect
  appointment: { id: string; startsAt: Date; endsAt: Date; status: string } | null
}) {
  return {
    ...row.control,
    appointment: row.appointment,
    scheduledAt:
      row.appointment && ["programada", "confirmada"].includes(row.appointment.status)
        ? row.appointment.startsAt
        : null,
  }
}

export { FOLLOW_UP_STATUSES } from "@odentia/clinical"
export interface CreateFollowUpInput {
  planItemId?: string | null
  encounterProcedureId?: string | null
  originEncounterId?: string | null
  kind: "tratamiento" | "mantenimiento"
  title: string
  instructions?: string | null
  dueAt: string
  /** Cada cuántos meses se repite (1, 3, 6 o 12); sin él, una vez (issue 229, decisión 16). */
  repeatEveryMonths?: number | null
}

function instant(value: string, field: string): Date {
  const date = new Date(value)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(date.getTime()))
    throw invalidField(field, "Elige la fecha en el calendario.")
  return date
}
/** `field`: el nombre del dato en el cuerpo (`outcome`, `reason`), para decirlo junto a su campo. */
function note(value: string, field: string): string {
  const text = value?.trim()
  if (!text || text.length > 2000) throw invalidField(field, "Escribe de 1 a 2000 caracteres.")
  return text
}
function scoped(orgId: string, patientId: string, id: string) {
  return and(
    eq(clinicalFollowUp.id, id),
    eq(clinicalFollowUp.organizationId, orgId),
    eq(clinicalFollowUp.patientId, patientId),
  )
}
async function lock(tx: Db, orgId: string, patientId: string, id: string) {
  const [row] = await tx
    .select()
    .from(clinicalFollowUp)
    .where(scoped(orgId, patientId, id))
    .for("update")
  if (!row) throw notFound("Control")
  return row
}
async function audit(tx: Db, orgId: string, actorUserId: string, id: string, action: string) {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    entity: "clinical_follow_up",
    entityId: id,
    action,
  })
}
export async function createFollowUp(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateFollowUpInput,
) {
  await requirePatient(tx, orgId, patientId)
  const title = input.title?.trim()
  if (!title || title.length > 200) throw invalidField("title", "Escribe el título del control, como mucho 200 caracteres.")
  if (!["tratamiento", "mantenimiento"].includes(input.kind))
    throw invalidField("kind", "Elige el tipo de control de la lista.")
  if (input.kind === "tratamiento" && !input.planItemId)
    throw invalidField("planItemId", "Elige el tratamiento que sigue este control.")
  const dueAt = instant(input.dueAt, "dueAt")
  if (dueAt.toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10))
    throw invalidField("dueAt", "El control vence hoy o más adelante.")
  const repeatEveryMonths = input.repeatEveryMonths ?? null
  if (
    repeatEveryMonths !== null &&
    !(FOLLOW_UP_REPEAT_MONTHS as readonly number[]).includes(repeatEveryMonths)
  )
    throw invalidField("repeatEveryMonths", "Un control se repite cada 1, 3, 6 o 12 meses.")
  if (input.planItemId) {
    const [item] = await tx
      .select({ id: treatmentPlanItem.id })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, input.planItemId),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
    if (!item) throw new ServiceError("NOT_FOUND", 404, "Tratamiento no encontrado", { planItemId: "Ese tratamiento ya no está en su plan: elige otro." })
  }
  if (input.originEncounterId) await requireEncounter(tx, orgId, patientId, input.originEncounterId)
  if (input.encounterProcedureId) {
    const [procedure] = await tx
      .select({ procedure: encounterProcedure })
      .from(encounterProcedure)
      .innerJoin(
        encounter,
        and(
          eq(encounter.id, encounterProcedure.encounterId),
          eq(encounter.organizationId, orgId),
          eq(encounter.patientId, patientId),
        ),
      )
      .where(
        and(
          eq(encounterProcedure.id, input.encounterProcedureId),
          eq(encounterProcedure.organizationId, orgId),
        ),
      )
    if (!procedure) throw notFound("Procedimiento")
    if (input.planItemId && procedure.procedure.planItemId !== input.planItemId)
      throw validation("El procedimiento no corresponde al tratamiento")
  }
  const [row] = await tx
    .insert(clinicalFollowUp)
    .values({
      ...input,
      title,
      dueAt,
      repeatEveryMonths,
      organizationId: orgId,
      patientId,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, row.id, "follow_up.created")
  return detail(tx, orgId, patientId, row.id)
}
/**
 * Reserva la cita del control. Lo que la agenda rechaza (el hueco ya está
 * tomado, fuera de horario, sin unidad libre) es de la hora elegida: se dice
 * junto a ella, con el nombre que tiene en este cuerpo (`appointment.…`).
 */
async function reserveFollowUpAppointment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: Extract<ScheduleFollowUpInput, { appointment: unknown }>["appointment"],
) {
  try {
    return await createAppointment(tx, orgId, actorUserId, { ...input, patientId, status: "programada" })
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error
    // Lo que ya señala un dato (también un 404: el profesional, la unidad o el servicio ya no está) va con su nombre aquí.
    if (error.fields) {
      const fields = Object.fromEntries(Object.entries(error.fields).map(([key, text]) => [`appointment.${key}`, text]))
      throw new ServiceError(error.code, error.status, error.message, fields)
    }
    if (error.status !== 400 && error.status !== 409) throw error
    throw new ServiceError(error.code, error.status, error.message, { "appointment.startsAt": error.message })
  }
}
export async function scheduleFollowUp(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  id: string,
  input: ScheduleFollowUpInput,
) {
  // Cita antes que control: mismo orden que las transiciones de agenda.
  const appointmentId =
    "appointmentId" in input
      ? input.appointmentId
      : (await reserveFollowUpAppointment(tx, orgId, actorUserId, patientId, input.appointment)).id
  const [reserved] = await tx
    .select()
    .from(appointment)
    .where(
      and(
        eq(appointment.id, appointmentId),
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
      ),
    )
    .for("update")
  if (!reserved) throw notFound("Cita")
  if (!["programada", "confirmada"].includes(reserved.status)) {
    const message = "La cita no admite programar el control"
    throw new ServiceError(
      "FOLLOW_UP_APPOINTMENT_STATUS",
      409,
      message,
      "appointmentId" in input ? { appointmentId: message } : undefined,
    )
  }
  const current = await lock(tx, orgId, patientId, id)
  if (current.status !== "pendiente")
    throw new ServiceError("FOLLOW_UP_STATUS", 409, "Solo puede programar un control pendiente")
  await tx
    .update(clinicalFollowUp)
    .set({ status: "programado", appointmentId, updatedAt: new Date() })
    .where(scoped(orgId, patientId, id))
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    entity: "clinical_follow_up",
    entityId: id,
    action: "follow_up.scheduled",
    metadata: { appointmentId, previousAppointmentId: current.appointmentId },
  })
  return detail(tx, orgId, patientId, id)
}
export async function completeFollowUp(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  id: string,
  input: { encounterId: string; outcome: string },
) {
  const current = await lock(tx, orgId, patientId, id)
  if (!["pendiente", "programado"].includes(current.status))
    throw new ServiceError("FOLLOW_UP_STATUS", 409, "El control está cerrado")
  const enc = await requireEncounter(tx, orgId, patientId, input.encounterId)
  if (enc.status !== "finalizada") {
    const message = "Finalice la atención antes de completar el control"
    throw new ServiceError("ENCOUNTER_NOT_FINALIZED", 409, message, { encounterId: message })
  }
  const [row] = await tx
    .update(clinicalFollowUp)
    .set({
      status: "realizado",
      completedEncounterId: enc.id,
      outcome: note(input.outcome, "outcome"),
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(scoped(orgId, patientId, id))
    .returning()
  await audit(tx, orgId, actorUserId, id, "follow_up.completed")
  if (row) await repeatFollowUp(tx, orgId, actorUserId, row)
  return detail(tx, orgId, patientId, row.id)
}

/**
 * Un control que se repite, recién realizado, deja indicado el siguiente:
 * los mismos datos, para N meses después del día en que se hizo, a la hora
 * que tenía. Uno solo por control (`repeats_from_id` es único): completarlo
 * por la atención y a mano a la vez no deja dos.
 */
export async function repeatFollowUp(
  tx: Db,
  orgId: string,
  actorUserId: string,
  done: typeof clinicalFollowUp.$inferSelect,
): Promise<void> {
  if (!done.repeatEveryMonths || done.status !== "realizado") return
  const { timezone } = await findOrgLocale(tx, orgId)
  const at = (done.completedAt ?? new Date()).toISOString()
  const [next] = await tx.execute<{ due: Date | string }>(sql`
    select (((${at}::timestamptz at time zone ${timezone})::date + make_interval(months => ${done.repeatEveryMonths}))::date
      + (${done.dueAt.toISOString()}::timestamptz at time zone ${timezone})::time) at time zone ${timezone} as due`)
  if (!next) return
  const [row] = await tx
    .insert(clinicalFollowUp)
    .values({
      organizationId: orgId,
      patientId: done.patientId,
      planItemId: done.planItemId,
      originEncounterId: done.completedEncounterId,
      kind: done.kind,
      title: done.title,
      instructions: done.instructions,
      dueAt: new Date(next.due),
      repeatEveryMonths: done.repeatEveryMonths,
      repeatsFromId: done.id,
      createdBy: actorUserId,
    })
    .onConflictDoNothing({
      target: clinicalFollowUp.repeatsFromId,
      where: sql`"repeats_from_id" is not null`,
    })
    .returning({ id: clinicalFollowUp.id })
  if (!row) return
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    entity: "clinical_follow_up",
    entityId: row.id,
    action: "follow_up.repeated",
    metadata: { patientId: done.patientId, fromId: done.id, everyMonths: done.repeatEveryMonths },
  })
}

/** «Dejar de repetir»: el control abierto sigue en pie, pero al completarlo ya no deja otro. */
export async function stopFollowUpRepeat(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  id: string,
) {
  const current = await lock(tx, orgId, patientId, id)
  if (!["pendiente", "programado"].includes(current.status))
    throw new ServiceError("FOLLOW_UP_STATUS", 409, "El control está cerrado")
  if (!current.repeatEveryMonths)
    throw new ServiceError("FOLLOW_UP_REPEAT", 409, "El control no se repite")
  await tx
    .update(clinicalFollowUp)
    .set({ repeatEveryMonths: null, updatedAt: new Date() })
    .where(scoped(orgId, patientId, id))
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    entity: "clinical_follow_up",
    entityId: id,
    action: "follow_up.repeat_stopped",
    metadata: { patientId, everyMonths: current.repeatEveryMonths },
  })
  return detail(tx, orgId, patientId, id)
}
export async function cancelFollowUp(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  id: string,
  input: { reason: string },
) {
  const current = await lock(tx, orgId, patientId, id)
  if (!["pendiente", "programado"].includes(current.status))
    throw new ServiceError("FOLLOW_UP_STATUS", 409, "El control está cerrado")
  const [row] = await tx
    .update(clinicalFollowUp)
    .set({
      status: "cancelado",
      cancelledReason: note(input.reason, "reason"),
      cancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(scoped(orgId, patientId, id))
    .returning()
  await audit(tx, orgId, actorUserId, id, "follow_up.cancelled")
  return detail(tx, orgId, patientId, row.id)
}
export async function listFollowUps(
  tx: Db,
  orgId: string,
  patientId: string,
  input: { status?: string } = {},
) {
  await requirePatient(tx, orgId, patientId)
  if (input.status && !(FOLLOW_UP_STATUSES as readonly string[]).includes(input.status))
    throw validation("Estado de control inválido")
  const rows = await selectFollowUps(tx)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, patientId),
        input.status ? eq(clinicalFollowUp.status, input.status) : undefined,
      ),
    )
    .orderBy(asc(clinicalFollowUp.dueAt), asc(clinicalFollowUp.id))
  return rows.map(present)
}
