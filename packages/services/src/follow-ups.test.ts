import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { member } from "@odentia/db/schema/auth"
import { clinicalFollowUp, encounter } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  createAppointment,
  createChair,
  moveAppointment,
  setAppointmentStatus,
} from "./appointments.js"
import { setProfessionalSchedule } from "./availability.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  listFollowUps,
  scheduleFollowUp,
} from "./follow-ups.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function fixture() {
  const f = await clinicalFixture()
  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: "org_a",
    userId: f.actor,
    role: "dentist",
    createdAt: new Date(),
  })
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede control", timezone: "America/Lima" })
    .returning()
  const chair = await f.run((tx) =>
    createChair(tx, "org_a", { branchId: site.id, name: "Control" }),
  )
  await f.run((tx) =>
    setProfessionalSchedule(tx, "org_a", f.actor, {
      branchId: site.id,
      dentistUserId: f.actor,
      rules: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        startMin: 8 * 60,
        endMin: 20 * 60,
      })),
    }),
  )
  const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const startsAt = `${date}T15:00:00.000Z`
  const reservation = {
    branchId: site.id,
    chairId: chair.id,
    dentistUserId: f.actor,
    startsAt,
    durationMin: 30,
  }
  const create = () =>
    f.run((tx) =>
      createFollowUp(tx, ...f.args, { kind: "mantenimiento", title: "Control", dueAt: startsAt }),
    )
  return { ...f, reservation, create, date }
}

it("reserva, mueve y libera el control sin confundir asistencia con cierre clínico", async () => {
  const f = await fixture()
  const control = await f.create()
  const booked = await f.run((tx) =>
    scheduleFollowUp(tx, ...f.args, control.id, { appointment: f.reservation }),
  )
  expect(booked).toMatchObject({
    status: "programado",
    appointment: { status: "programada" },
    legacyScheduledAt: null,
  })
  const id = booked.appointmentId
  if (!id) throw new Error("La reserva del control no devolvió cita")
  await f.run((tx) =>
    moveAppointment(tx, "org_a", f.actor, id, {
      expectedVersion: 1,
      startsAt: `${f.date}T16:00:00Z`,
    }),
  )
  expect(
    (await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id)))[0].scheduledAt?.toISOString(),
  ).toBe(`${f.date}T16:00:00.000Z`)
  for (const status of ["cancelada", "no_asistio", "atendida"]) {
    await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, id, status))
    const [row] = await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))
    expect(row).toMatchObject({
      status: "pendiente",
      scheduledAt: null,
      appointmentId: id,
      appointment: { status },
    })
    await expect(
      f.run((tx) => scheduleFollowUp(tx, ...f.args, control.id, { appointmentId: id })),
    ).rejects.toMatchObject({ code: "FOLLOW_UP_APPOINTMENT_STATUS" })
  }
  await expect(
    f.run((tx) =>
      completeFollowUp(tx, ...f.args, control.id, {
        encounterId: f.encounter.id,
        outcome: "Evolución favorable",
      }),
    ),
  ).rejects.toMatchObject({ code: "ENCOUNTER_NOT_FINALIZED" })
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date() })
    .where(eq(encounter.id, f.encounter.id))
  await expect(
    f.run((tx) =>
      completeFollowUp(tx, ...f.args, control.id, { encounterId: f.encounter.id, outcome: " " }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  expect(
    await f.run((tx) =>
      completeFollowUp(tx, ...f.args, control.id, {
        encounterId: f.encounter.id,
        outcome: "Evolución favorable",
      }),
    ),
  ).toMatchObject({ status: "realizado", completedEncounterId: f.encounter.id })
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, id, "cancelada"))
  expect((await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id)))[0].status).toBe(
    "realizado",
  )
})

it("rechaza vínculos ajenos y no reserva fuera del horario", async () => {
  const f = await fixture()
  const other = await fixture()
  const control = await f.create()
  const foreign = await other.run((tx) =>
    createAppointment(tx, "org_a", other.actor, {
      ...other.reservation,
      patientId: other.patient.id,
    }),
  )
  await expect(
    f.run((tx) => scheduleFollowUp(tx, ...f.args, control.id, { appointmentId: foreign.id })),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      scheduleFollowUp(tx, "org_b", f.actor, f.patient.id, control.id, {
        appointmentId: foreign.id,
      }),
    ),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    f.run((tx) =>
      scheduleFollowUp(tx, ...f.args, control.id, {
        appointment: { ...f.reservation, startsAt: `${f.date}T06:00:00Z` },
      }),
    ),
  ).rejects.toBeDefined()
  expect(
    await ownerDb.select().from(appointment).where(eq(appointment.patientId, f.patient.id)),
  ).toEqual([])
  await expect(
    ownerDb
      .update(clinicalFollowUp)
      .set({ appointmentId: foreign.id })
      .where(eq(clinicalFollowUp.id, control.id)),
  ).rejects.toBeDefined()
})

it("dos programaciones concurrentes del control no dejan reservas huérfanas", async () => {
  const f = await fixture()
  const control = await f.create()
  const results = await Promise.allSettled(
    [15, 16].map((hour) =>
      f.run((tx) =>
        scheduleFollowUp(tx, ...f.args, control.id, {
          appointment: { ...f.reservation, startsAt: `${f.date}T${hour}:00:00Z` },
        }),
      ),
    ),
  )
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  const [row] = await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))
  const reservations = await ownerDb
    .select()
    .from(appointment)
    .where(eq(appointment.patientId, f.patient.id))
  expect(reservations.map((r) => r.id)).toEqual([row.appointmentId])
})

it("dos controles compitiendo por el mismo recurso solo reservan uno", async () => {
  const f = await fixture()
  const controls = [await f.create(), await f.create()]
  const results = await Promise.allSettled(
    controls.map((c) =>
      f.run((tx) => scheduleFollowUp(tx, ...f.args, c.id, { appointment: f.reservation })),
    ),
  )
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((r) => r.status === "rejected")).toMatchObject([
    { reason: { code: "APPOINTMENT_CONFLICT" } },
  ])
})

it("cancelar el control no cancela una cita compartida", async () => {
  const f = await fixture()
  const control = await f.create()
  const booked = await f.run((tx) =>
    scheduleFollowUp(tx, ...f.args, control.id, { appointment: f.reservation }),
  )
  const cancelled = await f.run((tx) =>
    cancelFollowUp(tx, ...f.args, control.id, { reason: "Ya no procede" }),
  )
  expect(cancelled).toMatchObject({
    status: "cancelado",
    appointmentId: booked.appointmentId,
    appointment: { status: "programada" },
  })
})

it("vincular mientras se cancela nunca deja una reserva verificada cancelada", async () => {
  const f = await fixture()
  const control = await f.create()
  const appt = await f.run((tx) =>
    createAppointment(tx, "org_a", f.actor, { ...f.reservation, patientId: f.patient.id }),
  )
  const results = await Promise.allSettled([
    f.run((tx) => scheduleFollowUp(tx, ...f.args, control.id, { appointmentId: appt.id })),
    f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, appt.id, "cancelada")),
  ])
  expect(results[1].status).toBe("fulfilled")
  if (results[0].status === "rejected")
    expect(results[0].reason).toMatchObject({ code: "FOLLOW_UP_APPOINTMENT_STATUS" })
  const [row] = await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))
  expect(row.status).toBe("pendiente")
  expect(row.scheduledAt).toBeNull()
})

it("concilia un histórico explícitamente sin perder su fecha declarada", async () => {
  const f = await fixture()
  const control = await f.create()
  const legacyScheduledAt = new Date("2020-01-02T15:00:00Z")
  await ownerDb
    .update(clinicalFollowUp)
    .set({ legacyScheduledAt })
    .where(eq(clinicalFollowUp.id, control.id))
  expect((await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id)))[0]).toMatchObject({
    status: "pendiente",
    appointmentId: null,
    scheduledAt: null,
    legacyScheduledAt,
  })
  const appt = await f.run((tx) =>
    createAppointment(tx, "org_a", f.actor, { ...f.reservation, patientId: f.patient.id }),
  )
  expect(
    await f.run((tx) => scheduleFollowUp(tx, ...f.args, control.id, { appointmentId: appt.id })),
  ).toMatchObject({
    status: "programado",
    appointmentId: appt.id,
    legacyScheduledAt,
    scheduledAt: new Date(f.reservation.startsAt),
  })
})
