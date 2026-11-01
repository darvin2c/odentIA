/**
 * Quién puede atender (ADR 0124). Hay dos preguntas y cada una tiene una sola
 * respuesta:
 *
 * - **Puede atender**: sigue en la clínica y su rol escribe en la historia
 *   (`canAttend`). Se le pone horario, se le da una cita, se le adscribe a una
 *   especialidad y se le fija una comisión.
 * - **Atiende**: además, tiene horario activo en esa sede. Es lo que leen la
 *   agenda, Sofi, el enlace de reserva y el horario de la sede. La base cierra
 *   el horario de quien deja de poder atender, así que ninguna de esas lecturas
 *   repite la regla.
 */
import { canAttend } from "@odentia/auth/permissions"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { branch } from "@odentia/db/schema/org"
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm"
import { invalidField, ServiceError, validation } from "./errors.js"

/**
 * Exige que `userId` pueda atender y devuelve su nombre. `field`: el dato del
 * cuerpo donde la pantalla dice el rechazo; sin él, el dato va en la dirección.
 */
export async function requireCanAttend(tx: Db, orgId: string, userId: string, field?: string): Promise<{ name: string }> {
  const [row] = await tx
    .select({ role: member.role, name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (!row) {
    const message = "Esa persona no está en la clínica: elige a quien atienda."
    throw new ServiceError("NOT_FOUND", 404, message, field ? { [field]: message } : undefined)
  }
  if (!canAttend(row.role)) {
    const message = `${row.name} no atiende pacientes: elige a quien atienda.`
    throw field ? invalidField(field, message) : validation(message)
  }
  return { name: row.name }
}

export interface TeamAttendance {
  userId: string
  /** En qué sedes y qué días tiene horario activo. */
  schedules: Array<{ branchName: string; weekdays: number[] }>
  /** Citas en pie por venir, de cualquier sede. Las pruebas no cuentan. */
  upcomingAppointments: number
}

/**
 * Lo que Equipo dice de cada persona: qué días atiende y cuántas citas se
 * quedarían por mover si deja de atender. Solo trae a quien tiene una de las dos.
 */
export async function listTeamAttendance(tx: Db, orgId: string, now = new Date()): Promise<TeamAttendance[]> {
  const [schedules, upcoming] = await Promise.all([
    tx
      .selectDistinct({
        userId: professionalSchedule.professionalUserId,
        branchName: branch.name,
        weekday: professionalSchedule.weekday,
      })
      .from(professionalSchedule)
      .innerJoin(branch, eq(branch.id, professionalSchedule.branchId))
      .where(
        and(
          eq(professionalSchedule.organizationId, orgId),
          eq(professionalSchedule.isActive, true),
          eq(branch.isActive, true),
        ),
      )
      .orderBy(asc(branch.name), asc(professionalSchedule.weekday)),
    tx
      .select({ userId: appointment.professionalUserId, total: sql<number>`count(*)::int` })
      .from(appointment)
      .where(
        and(
          eq(appointment.organizationId, orgId),
          inArray(appointment.status, ["programada", "confirmada"]),
          eq(appointment.isTest, false),
          gte(appointment.startsAt, now),
        ),
      )
      .groupBy(appointment.professionalUserId),
  ])
  const byUser = new Map<string, TeamAttendance>()
  const of = (userId: string): TeamAttendance => {
    const found = byUser.get(userId)
    if (found) return found
    const created: TeamAttendance = { userId, schedules: [], upcomingAppointments: 0 }
    byUser.set(userId, created)
    return created
  }
  for (const row of schedules) {
    const person = of(row.userId)
    const place = person.schedules.find((item) => item.branchName === row.branchName)
    if (place) place.weekdays.push(row.weekday)
    else person.schedules.push({ branchName: row.branchName, weekdays: [row.weekday] })
  }
  for (const row of upcoming) of(row.userId).upcomingAppointments = row.total
  return [...byUser.values()]
}
