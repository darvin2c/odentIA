import { FOLLOW_UP_STATUSES } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import {
  clinicalFollowUp,
  encounter,
  encounterProcedure,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq } from "drizzle-orm"
import { type CreateAppointmentInput, createAppointment } from "./appointments.js"
import { requireEncounter } from "./encounters.js"
import { notFound, ServiceError, validation } from "./errors.js"
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
}

function instant(value: string): Date {
  const date = new Date(value)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(date.getTime()))
    throw validation("Fecha ISO inválida")
  return date
}
function note(value: string): string {
  const text = value?.trim()
  if (!text || text.length > 2000) throw validation("El texto debe tener 1–2000 caracteres")
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
  if (!title || title.length > 200) throw validation("El título debe tener 1–200 caracteres")
  if (!["tratamiento", "mantenimiento"].includes(input.kind))
    throw validation("Tipo de control inválido")
  if (input.kind === "tratamiento" && !input.planItemId)
    throw validation("El control de tratamiento requiere una indicación")
  const dueAt = instant(input.dueAt)
  if (dueAt.toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10))
    throw validation("El control debe vencer hoy o en el futuro")
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
    if (!item) throw notFound("Tratamiento")
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
    .values({ ...input, title, dueAt, organizationId: orgId, patientId, createdBy: actorUserId })
    .returning()
  await audit(tx, orgId, actorUserId, row.id, "follow_up.created")
  return detail(tx, orgId, patientId, row.id)
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
      : (
          await createAppointment(tx, orgId, actorUserId, {
            ...input.appointment,
            patientId,
            status: "programada",
          })
        ).id
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
  if (!["programada", "confirmada"].includes(reserved.status))
    throw new ServiceError(
      "FOLLOW_UP_APPOINTMENT_STATUS",
      409,
      "La cita no admite programar el control",
    )
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
  if (enc.status !== "finalizada")
    throw new ServiceError(
      "ENCOUNTER_NOT_FINALIZED",
      409,
      "Finalice la atención antes de completar el control",
    )
  const [row] = await tx
    .update(clinicalFollowUp)
    .set({
      status: "realizado",
      completedEncounterId: enc.id,
      outcome: note(input.outcome),
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(scoped(orgId, patientId, id))
    .returning()
  await audit(tx, orgId, actorUserId, id, "follow_up.completed")
  return detail(tx, orgId, patientId, row.id)
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
      cancelledReason: note(input.reason),
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
