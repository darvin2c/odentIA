/**
 * Semilla de disponibilidad: horarios explícitos por profesional/sede,
 * un bloqueo demostrativo y lista de espera inicial. Determinista e
 * idempotente (reemplaza lo existente de la sede). El padre la invoca por
 * sede antes de sembrar citas, para que la validación estricta no rechace
 * el seed histórico.
 */
import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import {
  professionalSchedule,
  scheduleBlock,
  waitlistEntry,
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
  // Solo roles profesionales atienden: recepción/caja nunca como odontólogos.
  const members = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, input.orgId),
        inArray(member.role, ["owner", "admin", "dentist"]),
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
  for (const dentist of members) {
    await setProfessionalSchedule(tx, input.orgId, input.ownerUserId, {
      branchId: input.branchId,
      dentistUserId: dentist.userId,
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
    dentistUserId: null,
    chairId: null,
    kind: "bloqueo",
    reason: "Fumigación de consultorios (demo)",
    startsAt: zonedTimeToUtc(tomorrow, 12 * 60, "America/Lima"),
    endsAt: zonedTimeToUtc(tomorrow, 14 * 60, "America/Lima"),
    createdBy: input.ownerUserId,
  })
  await tx
    .delete(waitlistEntry)
    .where(
      and(
        eq(waitlistEntry.organizationId, input.orgId),
        eq(waitlistEntry.branchId, input.branchId),
      ),
    )
  await tx.insert(waitlistEntry).values([
    {
      organizationId: input.orgId,
      branchId: input.branchId,
      patientId: input.patientId,
      contactId: null,
      dentistUserId: members[0]?.userId ?? input.ownerUserId,
      serviceId: null,
      serviceName: "Limpieza",
      priority: "alta",
      status: "en_espera",
      notes: "Prefiere mañanas (demo)",
      createdBy: input.ownerUserId,
    },
    {
      organizationId: input.orgId,
      branchId: input.branchId,
      patientId: null,
      contactId: input.contactId,
      dentistUserId: null,
      serviceId: null,
      serviceName: "Ortodoncia",
      priority: "normal",
      status: "en_espera",
      notes: "Interesado sin ficha (demo)",
      createdBy: input.ownerUserId,
    },
  ])
}
