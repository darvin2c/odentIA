/**
 * La cita pasada (mesa de Inicio y Agenda del 10 nov, entrega 1): las reglas de la
 * cita viven en el servicio y no solo en la pantalla, «Sin cerrar» es un momento de
 * la cita, «Vino» no inventa la llegada y se deshace, y la atención de una cita de
 * otro día queda con su fecha.
 */
import { randomUUID } from "node:crypto"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { encounter } from "@odentia/db/schema/clinical"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  appointmentVisit,
  createAppointment,
  markAppointmentCame,
  moveAppointment,
  setAppointmentArrival,
  setAppointmentStatus,
  skipAppointmentRecord,
  undoAppointmentCame,
} from "./appointments.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createEncounter, finalizeEncounter, updateEncounterDraft } from "./encounters.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const DAY = 86_400_000
type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Una sede propia con su unidad dental y una cita por venir (en días desde pasado mañana). */
async function booker(f: Fixture) {
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${randomUUID()}`, timezone: "America/Lima" })
    .returning()
  await ownerDb.insert(scheduleRoom).values({ organizationId: "org_a", branchId: site!.id, name: "Unidad dental 1" })
  const base = new Date(Date.now() + 2 * DAY)
  base.setUTCMinutes(0, 0, 0)
  return (days: number, extra: { endsAt?: string } = {}) =>
    f.run((tx) =>
      createAppointment(tx, "org_a", f.actor, {
        patientId: f.patient.id,
        professionalUserId: f.actor,
        branchId: site!.id,
        startsAt: new Date(base.getTime() + days * DAY).toISOString(),
        ...(extra.endsAt ? { endsAt: extra.endsAt } : { durationMin: 30 }),
        outsideSchedule: true,
        notice: false,
      }),
    )
}

/** Lleva la cita al pasado (como si hubiera sido hace `daysAgo` días), sin pasar por el servicio. */
async function inThePast(id: string, daysAgo: number) {
  const startsAt = new Date(Date.now() - daysAgo * DAY)
  await ownerDb
    .update(appointment)
    .set({ startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) })
    .where(eq(appointment.id, id))
  return startsAt
}

it("«Sin cerrar» es el momento de la cita en pie cuya hora terminó sin llegada ni atención", () => {
  const now = new Date("2026-11-10T15:00:00Z")
  const past = "2026-11-10T14:00:00Z"
  const later = "2026-11-10T16:00:00Z"
  expect(appointmentVisit({ status: "confirmada", arrivedAt: null, encounterStatus: null, endsAt: past, now })).toBe("sin_cerrar")
  expect(appointmentVisit({ status: "programada", arrivedAt: null, encounterStatus: null, endsAt: past, now })).toBe("sin_cerrar")
  expect(appointmentVisit({ status: "programada", arrivedAt: null, encounterStatus: null, endsAt: later, now })).toBe("por_confirmar")
  expect(appointmentVisit({ status: "confirmada", arrivedAt: past, encounterStatus: null, endsAt: past, now })).toBe("llego")
  expect(appointmentVisit({ status: "confirmada", arrivedAt: null, encounterStatus: "borrador", endsAt: past, now })).toBe("en_atencion")
  expect(appointmentVisit({ status: "no_asistio", arrivedAt: null, encounterStatus: null, endsAt: past, now })).toBe("no_vino")
})

it("C4: quien la pide (equipo, Sofi o la persona) no lleva una cita a una hora que ya pasó", async () => {
  const f = await clinicalFixture()
  const book = await booker(f)
  const booked = await book(1)
  await expect(
    f.run((tx) =>
      moveAppointment(tx, "org_a", f.actor, booked.id, {
        startsAt: new Date(Date.now() - DAY).toISOString(),
        expectedVersion: booked.version,
        outsideSchedule: true,
      }, { requested: true }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION", fields: { startsAt: expect.stringContaining("ya pasó") } })
})

it("C5: lo cancelado y lo que no vino no vuelven por /status, y un cajón abierto antes no pisa lo que cambió otro", async () => {
  const f = await clinicalFixture()
  const book = await booker(f)
  const cancelled = await book(1)
  const seen = cancelled.version
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, cancelled.id, "cancelada", { notice: false }))
  await expect(
    f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, cancelled.id, "confirmada")),
  ).rejects.toMatchObject({ code: "APPOINTMENT_CLOSED" })
  // El cajón que se abrió antes de cancelar manda su versión: no revive la cita.
  await expect(
    f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, cancelled.id, "confirmada", { expectedVersion: seen })),
  ).rejects.toMatchObject({ code: "STALE_VERSION" })

  const missed = await book(2)
  await inThePast(missed.id, 1)
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, missed.id, "no_asistio"))
  await expect(
    f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, missed.id, "programada")),
  ).rejects.toMatchObject({ code: "APPOINTMENT_CLOSED" })
})

it("C6: «No vino» no se marca antes de la hora de la cita", async () => {
  const f = await clinicalFixture()
  const book = await booker(f)
  const tomorrow = await book(0)
  await expect(
    f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, tomorrow.id, "no_asistio")),
  ).rejects.toMatchObject({ code: "APPOINTMENT_NOT_YET" })
})

it("una cita dura como mucho 8 horas", async () => {
  const f = await clinicalFixture()
  const book = await booker(f)
  await expect(book(1, { endsAt: new Date(Date.now() + 2 * DAY + 3 * DAY).toISOString() })).rejects.toMatchObject({
    code: "VALIDATION",
    fields: { endsAt: expect.stringContaining("8 horas") },
  })
})

it("C2: «Vino» no inventa la hora de llegada, se deshace, y corrige un «No vino» por error de otro día", async () => {
  const f = await clinicalFixture()
  const book = await booker(f)
  const booked = await book(1)
  await inThePast(booked.id, 2)
  const came = await f.run((tx) => markAppointmentCame(tx, "org_a", f.actor, booked.id))
  expect(came).toMatchObject({ status: "atendida", arrivedAt: null })
  const undone = await f.run((tx) => undoAppointmentCame(tx, "org_a", f.actor, booked.id, { expectedVersion: came.version }))
  // Vuelve a como estaba antes de «Vino»: en pie y sin cerrar.
  expect(undone).toMatchObject({ status: "programada", visit: "sin_cerrar" })

  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, booked.id, "no_asistio"))
  const fixed = await f.run((tx) => markAppointmentCame(tx, "org_a", f.actor, booked.id))
  expect(fixed.status).toBe("atendida")
  // Deshacer vuelve a como estaba: «No vino».
  expect((await f.run((tx) => undoAppointmentCame(tx, "org_a", f.actor, booked.id))).status).toBe("no_asistio")
})

it("C1: hoy, pasada su hora, «Llegó» vale sin pasar por «No vino»", async () => {
  const f = await clinicalFixture()
  const book = await booker(f)
  const booked = await book(1)
  // Empezó hace una hora y ya terminó: llegó tarde.
  const startsAt = new Date(Date.now() - 60 * 60_000)
  await ownerDb
    .update(appointment)
    .set({ startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) })
    .where(eq(appointment.id, booked.id))
  const arrived = await f.run((tx) => setAppointmentArrival(tx, "org_a", f.actor, booked.id, true))
  expect(arrived.visit).toBe("llego")
})

it("C3: la atención de una cita de otro día queda con su fecha y termina a la hora de la cita; también la de una cerrada con «Vino»", async () => {
  const f = await clinicalFixture()
  // La atención del fixture se cierra antes: una persona tiene una sola atención abierta.
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const book = await booker(f)
  const booked = await book(1)
  const startsAt = await inThePast(booked.id, 3)
  const opened = await f.run((tx) => createEncounter(tx, "org_a", f.actor, f.patient.id, { appointmentId: booked.id }))
  expect(opened.startedAt.getTime()).toBe(startsAt.getTime())
  await f.run((tx) => updateEncounterDraft(tx, ...f.args, opened.id, { reason: "Control" }))
  await f.ready(opened.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, opened.id))
  const [closed] = await ownerDb.select().from(encounter).where(eq(encounter.id, opened.id))
  expect(closed!.endedAt!.getTime()).toBe(startsAt.getTime() + 30 * 60_000)

  // Cerrada con «Vino»: su profesional la registra después, con su fecha.
  const other = await book(2)
  const otherStart = await inThePast(other.id, 5)
  await f.run((tx) => markAppointmentCame(tx, "org_a", f.actor, other.id))
  const late = await f.run((tx) => createEncounter(tx, "org_a", f.actor, f.patient.id, { appointmentId: other.id }))
  expect(late.startedAt.getTime()).toBe(otherStart.getTime())
  // Con su atención registrada, «Vino» ya no se deshace.
  await expect(f.run((tx) => undoAppointmentCame(tx, "org_a", f.actor, other.id))).rejects.toMatchObject({ code: "ATTENTION_STARTED" })
  // Y «No hace falta» no hace nada: ya tiene su atención.
  expect((await f.run((tx) => skipAppointmentRecord(tx, "org_a", f.actor, other.id))).status).toBe("atendida")
})

it("deshacer un «Vino» de antes quita la llegada que inventaba; la llegada de otro día sin atención está sin cerrar", async () => {
  const f = await clinicalFixture()
  const book = await booker(f)
  const booked = await book(1)
  const startsAt = await inThePast(booked.id, 4)
  // Así lo dejaba la versión anterior de «Vino»: llegada a la hora de la cita.
  await ownerDb.update(appointment).set({ status: "atendida", arrivedAt: startsAt, arrivedBy: f.actor }).where(eq(appointment.id, booked.id))
  await ownerDb.insert(auditEvent).values({
    organizationId: "org_a", actorUserId: f.actor, entity: "appointment", entityId: booked.id,
    action: "appointment.status_atendida", metadata: { from: "confirmada", by: "vino", withoutEncounter: true },
  })
  const undone = await f.run((tx) => undoAppointmentCame(tx, "org_a", f.actor, booked.id))
  expect(undone).toMatchObject({ status: "confirmada", arrivedAt: null, visit: "sin_cerrar" })
  // Llegó ese día y nadie registró la atención: también está sin cerrar.
  await ownerDb.update(appointment).set({ arrivedAt: startsAt, arrivedBy: f.actor }).where(eq(appointment.id, booked.id))
  const [row] = await ownerDb.select({ branchId: appointment.branchId }).from(appointment).where(eq(appointment.id, booked.id))
  await ownerDb.update(branch).set({ timezone: "America/Lima" }).where(eq(branch.id, row!.branchId))
  const { getAppointment } = await import("./appointments.js")
  expect((await f.run((tx) => getAppointment(tx, "org_a", booked.id))).visit).toBe("sin_cerrar")
})
