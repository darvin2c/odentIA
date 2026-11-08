import { randomUUID } from "node:crypto"
import { member } from "@odentia/db/schema/auth"
import { appointment } from "@odentia/db/schema/agenda"
import { clinicalFollowUp } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createAppointment, createRoom } from "./appointments.js"
import { setProfessionalSchedule } from "./availability.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createFollowUp, listFollowUps } from "./follow-ups.js"
import { addPlanItem } from "./plan.js"
import { getPlanNextStep } from "./plan-next.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import {
  getTreatmentCoordination,
  scheduleFollowUpFromCoordination,
} from "./treatment-coordination.js"

setupTestDb()

it("coordinación: expone títulos, estados y fechas, nunca el detalle clínico ni económico", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: "org_a",
    userId: f.actor,
    role: "clinician",
    createdAt: new Date(),
  })
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede coordinación", timezone: "America/Lima" })
    .returning()
  const room = await f.run((tx) =>
    createRoom(tx, "org_a", { branchId: site.id, name: "Coordinación" }),
  )
  await f.run((tx) =>
    setProfessionalSchedule(tx, "org_a", f.actor, {
      branchId: site.id,
      professionalUserId: f.actor,
      rules: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        startMin: 8 * 60,
        endMin: 20 * 60,
      })),
    }),
  )
  const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const startsAt = `${date}T15:00:00.000Z`
  await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      planId: f.plan.id,
      serviceId: f.service.id,
      sourceEncounterId: f.encounter.id,
      diagnosisCode: null,
      detail: "Detalle clínico reservado",
    }),
  )
  const control = await f.run((tx) =>
    createFollowUp(tx, ...f.args, {
      kind: "mantenimiento",
      title: "Control semestral",
      dueAt: startsAt,
      instructions: "Indicación clínica reservada",
    }),
  )

  const view = await f.run((tx) => getTreatmentCoordination(tx, "org_a", f.patient.id))
  expect(view.budgetsAwaitingDecision).toEqual([])
  expect(view.treatments).toEqual([
    {
      id: expect.any(String),
      title: "Tratamiento propio",
      status: "pendiente",
      decision: "pendiente",
      serviceId: expect.any(String),
      toSchedule: false,
      // Sin aceptar, no tiene sesiones por reservar.
      sessionsLeft: 0,
      nextSession: { n: 1, m: 1 },
    },
  ])
  expect(view.followUps).toHaveLength(1)
  expect(Object.keys(view.followUps[0]).sort()).toEqual(
    // La sede y el inicio de su ventana son de agenda: dónde reservar y desde cuándo le sirve una cita (ADR 0152).
    ["appointment", "branchId", "dueAt", "id", "legacyScheduledAt", "overdue", "patientId", "status", "title", "windowFrom"].sort(),
  )
  expect(JSON.stringify(view)).not.toMatch(/reservad[oa]|priceCents|toothNumber|diagnosis/)

  // Reservar desde la coordinación es la misma operación clínica, con respuesta mínima.
  const booked = await f.run((tx) =>
    scheduleFollowUpFromCoordination(tx, ...f.args, control.id, {
      appointment: {
        branchId: site.id,
        roomId: room.id,
        professionalUserId: f.actor,
        startsAt,
        durationMin: 30,
      },
    }),
  )
  expect(booked).toMatchObject({ status: "programado", appointment: { status: "programada" } })
  expect(booked).not.toHaveProperty("instructions")
  const [stored] = await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))
  expect(stored).toMatchObject({ status: "programado", appointmentId: booked.appointment?.id })

  // Otra organización no ve al paciente.
  await expect(
    f.run((tx) => getTreatmentCoordination(tx, "org_b", f.patient.id)),
  ).rejects.toMatchObject({ status: 404 })
})

// QA del 6 nov (X3): el Resumen no decía el control, tampoco uno vencido. La
// coordinación dice cuál es el próximo, si venció y qué cita lo cumple, con las
// reglas de «Qué sigue».
it("coordinación: el próximo control dice si venció y qué cita lo cumple", async () => {
  const f = await clinicalFixture()
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede próximo control", timezone: "America/Lima" })
    .returning()
  const room = await f.run((tx) => createRoom(tx, "org_a", { branchId: site.id, name: "Próximo control" }))
  expect((await f.run((tx) => getTreatmentCoordination(tx, "org_a", f.patient.id))).nextControl).toBeNull()
  const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const startsAt = `${date}T15:00:00.000Z`
  const later = await f.run((tx) =>
    createFollowUp(tx, ...f.args, { kind: "mantenimiento", title: "Control lejano", dueAt: `2099-01-01T15:00:00.000Z` }),
  )
  const control = await f.run((tx) =>
    createFollowUp(tx, ...f.args, { kind: "mantenimiento", title: "Control semestral", dueAt: startsAt }),
  )
  // Tocaba hace tres días y se indicó hace seis meses: vencido y sin cita.
  await ownerDb
    .update(clinicalFollowUp)
    .set({ dueAt: new Date(Date.now() - 3 * 86400000), createdAt: new Date(Date.now() - 180 * 86400000) })
    .where(eq(clinicalFollowUp.id, control.id))
  const overdue = (await f.run((tx) => getTreatmentCoordination(tx, "org_a", f.patient.id))).nextControl
  expect(overdue).toMatchObject({ id: control.id, title: "Control semestral", status: "pendiente", overdue: true, appointment: null })
  expect(overdue?.id).not.toBe(later.id)

  // Una cita por venir le sirve: ya no está vencido y esa es la cita que lo cumple.
  const visit = await f.run((tx) =>
    createAppointment(tx, "org_a", f.actor, {
      branchId: site.id,
      roomId: room.id,
      professionalUserId: f.actor,
      patientId: f.patient.id,
      startsAt,
      durationMin: 30,
      outsideSchedule: true,
    }),
  )
  expect((await f.run((tx) => getTreatmentCoordination(tx, "org_a", f.patient.id))).nextControl).toMatchObject({
    id: control.id,
    overdue: false,
    appointment: { id: visit.id },
  })
})

// Revisión del 7 nov (puntos 2 y 10): la persona en la sala, con su control vencido,
// veía «Control vencido · sin cita por venir» y «Reservar cita». Con una cita viva
// hoy desde que abrió su ventana, el control se cumple con su atención de hoy: no
// está vencido, ni en el Resumen, ni en el Plan, ni en «Qué sigue».
it("con la persona en la sala hoy, su control vencido se cumple con la atención de hoy", async () => {
  const f = await clinicalFixture()
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede sala de espera", timezone: "America/Lima" })
    .returning()
  const room = await f.run((tx) => createRoom(tx, "org_a", { branchId: site.id, name: "Sala de espera" }))
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const control = await f.run((tx) =>
    createFollowUp(tx, ...f.args, { kind: "mantenimiento", title: "Profilaxis semestral", dueAt: `${tomorrow}T15:00:00.000Z` }),
  )
  await ownerDb
    .update(clinicalFollowUp)
    .set({ dueAt: new Date(Date.now() - 3 * 86400000), createdAt: new Date(Date.now() - 180 * 86400000) })
    .where(eq(clinicalFollowUp.id, control.id))
  // Vencido y sin cita: el Plan y el Resumen lo dicen igual.
  expect((await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id)))[0]).toMatchObject({ overdue: true, servedToday: null })
  expect((await f.run((tx) => getTreatmentCoordination(tx, "org_a", f.patient.id))).followUps[0]).toMatchObject({ overdue: true })

  // Llegó hoy a su cita, cuya hora ya pasó.
  const visit = await f.run((tx) =>
    createAppointment(tx, "org_a", f.actor, {
      branchId: site.id,
      roomId: room.id,
      professionalUserId: f.actor,
      patientId: f.patient.id,
      startsAt: `${tomorrow}T15:00:00.000Z`,
      durationMin: 30,
      outsideSchedule: true,
    }),
  )
  // El inicio del día en Lima (UTC−5) o hace media hora, lo que sea más tarde: siempre hoy.
  const limaToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
  const startsAt = new Date(Math.max(Date.parse(`${limaToday}T05:01:00.000Z`), Date.now() - 30 * 60_000))
  await ownerDb
    .update(appointment)
    .set({ status: "confirmada", startsAt, endsAt: new Date(startsAt.getTime() + 60_000), arrivedAt: new Date(), arrivedBy: f.actor })
    .where(eq(appointment.id, visit.id))
  const view = await f.run((tx) => getTreatmentCoordination(tx, "org_a", f.patient.id))
  expect(view.nextControl).toMatchObject({ id: control.id, overdue: false, today: true, appointment: { id: visit.id } })
  expect(view.followUps[0]).toMatchObject({ overdue: false })
  expect(await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, () => true))).toMatchObject({
    kind: "control",
    text: "Profilaxis semestral · se cumple con su atención de hoy",
    action: { label: "Ver la cita", appointmentId: visit.id },
  })
})
