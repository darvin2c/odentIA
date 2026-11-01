/**
 * Semilla de disponibilidad: horarios explícitos por profesional/sede,
 * y un bloqueo demostrativo. Determinista e
 * idempotente (reemplaza lo existente de la sede). El padre la invoca por
 * sede antes de sembrar citas, para que la validación estricta no rechace
 * el seed histórico.
 */
import { ATTENDING_ROLES } from "@odentia/auth/permissions"
import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import {
  professionalSchedule,
  scheduleBlock,
} from "@odentia/db/schema/availability"
import { and, eq, inArray } from "drizzle-orm"
import { setProfessionalSchedule, zonedTimeToUtc } from "./availability.js"

/**
 * Turnos demo todos los días 09:00–13:00 y 14:00–18:00 (hora local de la
 * sede): el seed de citas cae en hoy/mañana/ayer y debe funcionar cualquier
 * día de la semana, domingo incluido.
 */
const DEMO_RULES = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
  { weekday, startMin: 9 * 60, endMin: 13 * 60 },
  { weekday, startMin: 14 * 60, endMin: 18 * 60 },
])

export async function seedAvailability(
  tx: Db,
  input: {
    orgId: string
    ownerUserId: string
    branchId: string
    patientId: string
    contactId: string
  },
): Promise<void> {
  // Solo quien puede atender lleva horario.
  const members = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, input.orgId),
        inArray(member.role, [...ATTENDING_ROLES]),
      ),
    )
  // Reemplazo acotado a la sede del seed (el seed-dev ya purga la org antes).
  await tx
    .delete(professionalSchedule)
    .where(
      and(
        eq(professionalSchedule.organizationId, input.orgId),
        eq(professionalSchedule.branchId, input.branchId),
      ),
    )
  for (const professional of members) {
    await setProfessionalSchedule(tx, input.orgId, input.ownerUserId, {
      branchId: input.branchId,
      professionalUserId: professional.userId,
      rules: DEMO_RULES,
    })
  }
  await tx
    .delete(scheduleBlock)
    .where(
      and(
        eq(scheduleBlock.organizationId, input.orgId),
        eq(scheduleBlock.branchId, input.branchId),
      ),
    )
  // Bloqueo demo: mañana 12:00–14:00 hora Lima (cubre el hueco del mediodía).
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) as string
  await tx.insert(scheduleBlock).values({
    organizationId: input.orgId,
    branchId: input.branchId,
    professionalUserId: null,
    roomId: null,
    kind: "bloqueo",
    reason: "Fumigación de consultorios",
    startsAt: zonedTimeToUtc(tomorrow, 12 * 60, "America/Lima"),
    endsAt: zonedTimeToUtc(tomorrow, 14 * 60, "America/Lima"),
    createdBy: input.ownerUserId,
  })
}
