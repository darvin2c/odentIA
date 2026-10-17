/**
 * La persona actúa sobre su propia cita: confirmarla, cambiarla de hora o
 * cancelarla. Una sola regla para «Su enlace», el portal y el agente (fase 4,
 * tablero 2b), la del enlace (ADR 0037):
 *
 * - Solo una cita en pie (programada o confirmada) que todavía no empezó.
 * - Confirmar una cita ya confirmada no es un error: queda como está.
 * - La hora nueva es futura y cae dentro del horizonte (`OWN_APPOINTMENT_HORIZON_DAYS`).
 * - Cancelar deja el motivo «paciente»: «Ofrecer otra fecha» depende de él.
 * - Cambiar es mover la cita en la Agenda (`moveAppointment`), con las mismas
 *   reglas de disponibilidad; a la persona no se le avisa lo que acaba de hacer.
 *
 * Quién es la persona y desde dónde actúa (enlace, sesión del portal,
 * conversación) lo resuelve cada vía; la regla vive aquí.
 */
import type { Db } from "@odentia/db"
import { type AppointmentItem, moveAppointment, setAppointmentStatus } from "./appointments.js"
import { ServiceError, validation } from "./errors.js"

/** Hasta cuántos días adelante la persona puede llevar su cita. */
export const OWN_APPOINTMENT_HORIZON_DAYS = 120

const NOT_CHANGEABLE = "Esta cita ya no se puede cambiar desde aquí. Escríbenos por el chat."

/** Sigue en pie y no empezó: la persona todavía puede confirmarla, cambiarla o cancelarla. */
export function ownAppointmentChangeable(row: { status: string; startsAt: Date }, now: Date = new Date()): boolean {
  return (row.status === "programada" || row.status === "confirmada") && row.startsAt.getTime() > now.getTime()
}

export function assertOwnAppointmentChangeable(row: { status: string; startsAt: Date }, now: Date = new Date()): void {
  if (!ownAppointmentChangeable(row, now)) throw new ServiceError("BOOKING_NOT_CHANGEABLE", 409, NOT_CHANGEABLE)
}

/** La hora nueva que elige la persona: futura y dentro del horizonte. */
export function assertOwnNewTime(startsAt: string, now: Date = new Date()): Date {
  const when = new Date(startsAt)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(startsAt) || !Number.isFinite(when.getTime())) throw validation("Fecha ISO inválida")
  if (when.getTime() <= now.getTime()) throw validation("Elige una fecha futura")
  if (when.getTime() > now.getTime() + OWN_APPOINTMENT_HORIZON_DAYS * 86_400_000) {
    throw validation(`Solo puedes cambiarla dentro de los próximos ${OWN_APPOINTMENT_HORIZON_DAYS} días`)
  }
  return when
}

type OwnRow = { id: string; status: string; startsAt: Date }

/** Confirma su cita; si ya estaba confirmada, la deja como está (`already`). */
export async function confirmOwnAppointment(
  tx: Db,
  orgId: string,
  actor: string,
  row: OwnRow,
  via: string,
): Promise<{ item: AppointmentItem; already: boolean }> {
  assertOwnAppointmentChangeable(row)
  const already = row.status === "confirmada"
  const item = await setAppointmentStatus(tx, orgId, actor, row.id, "confirmada", { via })
  return { item, already }
}

/** Cancela su cita con el motivo «paciente». */
export async function cancelOwnAppointment(
  tx: Db,
  orgId: string,
  actor: string,
  row: OwnRow,
  note: string,
): Promise<AppointmentItem> {
  assertOwnAppointmentChangeable(row)
  return setAppointmentStatus(tx, orgId, actor, row.id, "cancelada", {
    cancelReason: "paciente",
    cancelNote: note,
    notice: false,
  })
}

/** Cambia su cita a otra hora libre de la semana (misma sede y duración). */
export async function moveOwnAppointment(
  tx: Db,
  orgId: string,
  actor: string,
  row: OwnRow & { version: number },
  input: { startsAt: string; dentistUserId: string; chairId?: string; expectedVersion?: number },
): Promise<AppointmentItem> {
  assertOwnAppointmentChangeable(row)
  const startsAt = assertOwnNewTime(input.startsAt)
  return moveAppointment(
    tx,
    orgId,
    actor,
    row.id,
    {
      expectedVersion: input.expectedVersion ?? row.version,
      startsAt: startsAt.toISOString(),
      dentistUserId: input.dentistUserId,
      ...(input.chairId ? { chairId: input.chairId } : {}),
    },
    { notice: false },
  )
}
