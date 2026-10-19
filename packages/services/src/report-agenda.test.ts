/**
 * Reportes › Agenda: las horas libres de una semana cuadran con su agenda.
 * Cuenta el horario de cada día (su versión vigente ese día), lo quitan los
 * feriados y las ausencias, no lo quita un bloqueo de una sola unidad dental,
 * una cancelada libera su tiempo y lo atendido fuera del horario no suma.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { professionalSchedule, scheduleBlock } from "@odentia/db/schema/availability"
import { member, user } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { setProfessionalSchedule } from "./availability.js"
import { agendaMinutes, getAgendaReport, occupancyBySpan } from "./report-agenda.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

/** Lunes 12 de octubre de 2026, 10:00 en Lima. */
const NOW = new Date("2026-10-12T15:00:00Z")
/** La semana de prueba: del lunes 14 al domingo 20 de septiembre de 2026 (Lima, UTC−5). */
const WEEK = { start: new Date("2026-09-14T05:00:00Z"), end: new Date("2026-09-21T05:00:00Z") }
/** Una hora de Lima en UTC: «2026-09-14 09:00» → 14:00 Z. */
const lima = (day: string, time: string): Date => new Date(new Date(`${day}T${time}:00Z`).getTime() + 5 * 3_600_000)
const WEEKDAYS = [1, 2, 3, 4, 5]
const FULL_DAY = WEEKDAYS.flatMap((weekday) => [
  { weekday, startMin: 9 * 60, endMin: 13 * 60 },
  { weekday, startMin: 14 * 60, endMin: 18 * 60 },
])

async function clinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `agenda-${orgId}`)
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro" }).returning()
  const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" }).returning()
  const [person] = await insertTestPatients(ownerDb, { organizationId: orgId, displayName: "Rosa", patientNumber: 1 })
  const dentist = async (name: string) => {
    const id = randomUUID()
    await ownerDb.insert(user).values({ id, name, email: `${id}@agenda.test` })
    await ownerDb.insert(member).values({ id: randomUUID(), organizationId: orgId, userId: id, role: "dentist", createdAt: new Date() })
    return id
  }
  const schedule = (dentistUserId: string, rules: typeof FULL_DAY, validFrom: string, validUntil: string | null = null) =>
    ownerDb.insert(professionalSchedule).values(
      rules.map((rule) => ({
        organizationId: orgId,
        branchId: site!.id,
        dentistUserId,
        ...rule,
        isActive: validUntil === null,
        validFrom,
        validUntil,
      })),
    )
  const visit = (dentistUserId: string, day: string, from: string, to: string, status = "atendida") =>
    ownerDb.insert(appointment).values({
      organizationId: orgId,
      branchId: site!.id,
      chairId: chair!.id,
      dentistUserId,
      patientId: person!.id,
      serviceName: "Control",
      startsAt: lima(day, from),
      endsAt: lima(day, to),
      durationMin: Math.round((lima(day, to).getTime() - lima(day, from).getTime()) / 60_000),
      status,
      source: "recepcion",
    })
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  return { orgId, branchId: site!.id, chairId: chair!.id, dentist, schedule, visit, run }
}

it("las horas libres de una semana cuadran con su agenda", async () => {
  const c = await clinic()
  const ana = await c.dentist("Dra. Ana Torres")
  await c.schedule(ana, FULL_DAY, "2026-01-01")
  // Miércoles feriado: la sede cerrada. Jueves de 9 a 11, Ana ausente. El martes
  // por la tarde se bloquea solo la unidad dental: Ana sigue atendiendo en otra.
  await ownerDb.insert(scheduleBlock).values([
    { organizationId: c.orgId, branchId: c.branchId, kind: "bloqueo", reason: "Feriado", startsAt: lima("2026-09-16", "00:00"), endsAt: lima("2026-09-17", "00:00") },
    { organizationId: c.orgId, branchId: c.branchId, dentistUserId: ana, kind: "ausencia", reason: "Curso", startsAt: lima("2026-09-17", "09:00"), endsAt: lima("2026-09-17", "11:00") },
    { organizationId: c.orgId, branchId: c.branchId, chairId: c.chairId, kind: "bloqueo", reason: "Mantenimiento", startsAt: lima("2026-09-15", "14:00"), endsAt: lima("2026-09-15", "18:00") },
  ])
  await c.visit(ana, "2026-09-14", "09:00", "10:00")
  // Una que no vino ocupó su hora igual.
  await c.visit(ana, "2026-09-14", "10:00", "11:30", "no_asistio")
  // Una cancelada libera su tiempo.
  await c.visit(ana, "2026-09-15", "14:00", "15:00", "cancelada")
  await c.visit(ana, "2026-09-15", "16:00", "17:00")
  // Cruza el almuerzo: solo cuentan 12:30–13:00 y 14:00–14:30.
  await c.visit(ana, "2026-09-18", "12:30", "14:30")
  // El sábado no tiene horario: no suma.
  await c.visit(ana, "2026-09-19", "10:00", "11:00")

  const minutes = await c.run((tx) => agendaMinutes(tx, c.orgId, WEEK))
  const byDay = Object.fromEntries(minutes.days.map((day) => [day.day, { scheduled: day.scheduledMin, avail: day.availMin, occ: day.occMin }]))
  expect(byDay).toEqual({
    "2026-09-14": { scheduled: 480, avail: 480, occ: 150 },
    "2026-09-15": { scheduled: 480, avail: 480, occ: 60 },
    // Cerrado: tenía horario y el feriado lo tapó entero.
    "2026-09-16": { scheduled: 480, avail: 0, occ: 0 },
    "2026-09-17": { scheduled: 480, avail: 360, occ: 0 },
    "2026-09-18": { scheduled: 480, avail: 480, occ: 60 },
  })
  const hour = (day: string, at: number) => minutes.slots.find((slot) => slot.day === day && slot.hour === at)
  expect(hour("2026-09-14", 9)).toMatchObject({ availMin: 60, occMin: 60 })
  expect(hour("2026-09-14", 11)).toMatchObject({ availMin: 60, occMin: 30 })
  expect(hour("2026-09-18", 12)).toMatchObject({ availMin: 60, occMin: 30 })
  expect(hour("2026-09-18", 13)).toBeUndefined()
  expect(hour("2026-09-17", 9)).toBeUndefined()

  const [week] = occupancyBySpan(minutes.days, [WEEK])
  expect(week).toMatchObject({ availMin: 1800, occMin: 270 })

  // La pestaña dice lo mismo para el rango de esa semana, y la semana tipo lo reparte por hora.
  const report = await c.run((tx) => getAgendaReport(tx, c.orgId, { period: "2026-09-14..2026-09-20" }, NOW))
  expect(report.occupancy.current).toEqual({ availMin: 1800, occMin: 270 })
  expect(report.professionals).toEqual([
    expect.objectContaining({ userId: ana, attended: 4, noShow: 1, cancelled: 1, availMin: 1800, occMin: 270 }),
  ])
  expect(report.map.week.find((cell) => cell.weekday === 1 && cell.hour === 10)).toMatchObject({ availMin: 60, occMin: 60 })
  // Los 12 meses del mapa empiezan en octubre de 2025, antes del primer horario guardado (enero): se usó el de hoy y se dice.
  expect(report.map.assumed).toBe(true)
  expect(report.map.firstSchedule).toEqual([{ userId: ana, day: "2026-01-01" }])
})

it("cada día usa el horario que valía ese día; antes del primero guardado, el de hoy, y lo dice", async () => {
  const c = await clinic()
  const luis = await c.dentist("Luis Prado")
  // Hasta el martes atendía en la mañana; desde el miércoles, en la tarde.
  await c.schedule(luis, FULL_DAY.filter((rule) => rule.startMin === 9 * 60), "2026-09-01", "2026-09-16")
  await c.schedule(luis, FULL_DAY.filter((rule) => rule.startMin === 14 * 60), "2026-09-16")
  await c.visit(luis, "2026-09-15", "09:00", "10:00")
  await c.visit(luis, "2026-09-17", "09:00", "10:00")
  await c.visit(luis, "2026-09-17", "15:00", "16:00")
  // El lunes 31 de agosto aún no había horario guardado: se usa el de hoy (la tarde).
  const minutes = await c.run((tx) => agendaMinutes(tx, c.orgId, { start: new Date("2026-08-31T05:00:00Z"), end: WEEK.end }))
  const day = (value: string) => minutes.days.find((row) => row.day === value)
  expect(day("2026-08-31")).toMatchObject({ availMin: 240, assumed: true })
  expect(day("2026-09-15")).toMatchObject({ availMin: 240, occMin: 60, assumed: false })
  // La de la mañana del jueves ya queda fuera de su horario de entonces.
  expect(day("2026-09-17")).toMatchObject({ availMin: 240, occMin: 60, assumed: false })
  expect(minutes.slots.some((slot) => slot.day === "2026-09-17" && slot.hour === 9)).toBe(false)
})

it("cambiar un horario no borra el anterior: lo cierra desde hoy; el mismo día se reemplaza y el mismo horario no deja otro", async () => {
  const c = await clinic()
  const rojas = await c.dentist("Dra. Elena Rojas")
  const owner = rojas
  const save = (rules: typeof FULL_DAY) => c.run((tx) => setProfessionalSchedule(tx, c.orgId, owner, { branchId: c.branchId, dentistUserId: rojas, rules }))
  const rows = () =>
    ownerDb
      .select({ weekday: professionalSchedule.weekday, startMin: professionalSchedule.startMin, isActive: professionalSchedule.isActive, validFrom: professionalSchedule.validFrom, validUntil: professionalSchedule.validUntil })
      .from(professionalSchedule)
      .where(and(eq(professionalSchedule.organizationId, c.orgId), eq(professionalSchedule.dentistUserId, rojas)))
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())

  const first = await save(FULL_DAY.filter((rule) => rule.weekday === 2))
  expect(first.validFrom).toBe(today)
  // El mismo día otro horario lo reemplaza: un día no tiene dos.
  await save(FULL_DAY.filter((rule) => rule.weekday === 4))
  expect((await rows()).map((row) => row.weekday).sort()).toEqual([4, 4])
  // Si ese horario venía de antes, cambiarlo lo cierra hoy y el nuevo vale desde hoy.
  await ownerDb.update(professionalSchedule).set({ validFrom: "2026-01-05" }).where(eq(professionalSchedule.dentistUserId, rojas))
  const second = await save(FULL_DAY.filter((rule) => rule.weekday === 1))
  expect(second.rules.map((rule) => rule.weekday)).toEqual([1, 1])
  const history = await rows()
  expect(history.filter((row) => !row.isActive)).toEqual([
    expect.objectContaining({ weekday: 4, validFrom: "2026-01-05", validUntil: today }),
    expect.objectContaining({ weekday: 4, validFrom: "2026-01-05", validUntil: today }),
  ])
  expect(history.filter((row) => row.isActive).every((row) => row.weekday === 1 && row.validFrom === today && row.validUntil === null)).toBe(true)
  // Guardar el mismo horario no deja otra versión.
  await save(FULL_DAY.filter((rule) => rule.weekday === 1))
  expect(await rows()).toHaveLength(history.length)
})
