import { randomUUID } from "node:crypto"
import { member } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { createChair } from "./appointments.js"
import { setProfessionalSchedule } from "./availability.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createFollowUp, listFollowUps } from "./follow-ups.js"
import { addPlanItem } from "./plan.js"
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
    role: "dentist",
    createdAt: new Date(),
  })
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede coordinación", timezone: "America/Lima" })
    .returning()
  const chair = await f.run((tx) =>
    createChair(tx, "org_a", { branchId: site.id, name: "Coordinación" }),
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
    { id: expect.any(String), title: "Tratamiento propio", status: "pendiente", decision: "pendiente" },
  ])
  expect(view.followUps).toHaveLength(1)
  expect(Object.keys(view.followUps[0]).sort()).toEqual(
    ["appointment", "dueAt", "id", "legacyScheduledAt", "patientId", "status", "title"].sort(),
  )
  expect(JSON.stringify(view)).not.toMatch(/reservad[oa]|priceCents|toothNumber|diagnosis/)

  // Reservar desde la coordinación es la misma operación clínica, con respuesta mínima.
  const booked = await f.run((tx) =>
    scheduleFollowUpFromCoordination(tx, ...f.args, control.id, {
      appointment: {
        branchId: site.id,
        chairId: chair.id,
        dentistUserId: f.actor,
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
