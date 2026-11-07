import { randomUUID } from "node:crypto"
import { appointment } from "@odentia/db/schema/agenda"
import { appointmentPlanItem, clinicalFollowUp, encounter, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createRoom } from "./appointments.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { getEncounterDetail } from "./encounters.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Para qué se agendó la cita de la atención (ADR 0139): se ofrece como motivo
 * y nunca se firma solo. Sin motivo escrito al reservarla, lo dice el control
 * reservado con ella o los tratamientos que continúa.
 */
setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Una cita para la atención del fixture, con el motivo escrito al reservarla (o ninguno). */
async function visitFor(f: Fixture, reason: string | null) {
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${randomUUID().slice(0, 6)}`, timezone: "America/Lima" })
    .returning()
  if (!site) throw new Error("Sin sede")
  const room = await f.run((tx) => createRoom(tx, "org_a", { branchId: site.id, name: "Unidad dental" }))
  const startsAt = new Date(Date.now() + 3_600_000)
  const [visit] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: "org_a",
      branchId: site.id,
      patientId: f.patient.id,
      professionalUserId: f.actor,
      roomId: room.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
      status: "confirmada",
      reason,
    })
    .returning()
  if (!visit) throw new Error("Sin cita")
  // La atención en borrador, unida a la cita y todavía sin motivo propio.
  await ownerDb.update(encounter).set({ appointmentId: visit.id, reason: null }).where(eq(encounter.id, f.encounter.id))
  return visit
}

async function treatment(f: Fixture, title: string, tooth: number | null) {
  const [row] = await ownerDb
    .insert(treatmentPlanItem)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      planId: f.plan.id,
      title,
      currency: "PEN",
      decisionStatus: "aceptado",
      status: "programado",
      siteSystem: tooth ? "ISO-3950" : null,
      siteCode: tooth ? String(tooth) : null,
    })
    .returning()
  if (!row) throw new Error("Sin tratamiento")
  return row
}

async function controlFor(
  f: Fixture,
  visit: { id: string; startsAt: Date },
  input: { title: string; planItemId: string; status?: "programado" | "cancelado" },
) {
  await ownerDb.insert(clinicalFollowUp).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    planItemId: input.planItemId,
    kind: "tratamiento",
    title: input.title,
    dueAt: visit.startsAt,
    status: input.status ?? "programado",
    appointmentId: visit.id,
  })
}

const bookedReason = async (f: Fixture) =>
  (await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, f.encounter.id))).bookedReason

it("lo escrito al reservar la cita va primero, aunque haya un control reservado con ella", async () => {
  const f = await clinicalFixture()
  const visit = await visitFor(f, "  Limpieza dental ")
  const endo = await treatment(f, "Endodoncia posterior vital", 46)
  await controlFor(f, visit, { title: "Control de evolución endodóntica", planItemId: endo.id })
  expect(await bookedReason(f)).toBe("Limpieza dental")
})

it("sin motivo escrito, ofrece el título del control reservado con la cita; uno cancelado no cuenta", async () => {
  const f = await clinicalFixture()
  const visit = await visitFor(f, null)
  const endo = await treatment(f, "Endodoncia posterior vital", 46)
  await controlFor(f, visit, { title: "Control cancelado", planItemId: endo.id, status: "cancelado" })
  await controlFor(f, visit, { title: "Control de evolución endodóntica", planItemId: endo.id })
  expect(await bookedReason(f)).toBe("Control de evolución endodóntica")
})

it("sin motivo ni control, dice qué tratamientos continúa, con su pieza si la tienen", async () => {
  const f = await clinicalFixture()
  const visit = await visitFor(f, "   ")
  // Sin nada agendado con la cita, no hay nada que ofrecer.
  expect(await bookedReason(f)).toBeNull()
  const endo = await treatment(f, "Endodoncia posterior vital", 46)
  const cleaning = await treatment(f, "Profilaxis", null)
  await ownerDb.insert(appointmentPlanItem).values([
    { organizationId: "org_a", patientId: f.patient.id, appointmentId: visit.id, planItemId: endo.id },
    { organizationId: "org_a", patientId: f.patient.id, appointmentId: visit.id, planItemId: cleaning.id },
  ])
  expect(await bookedReason(f)).toBe("Continúa: Endodoncia posterior vital de la 46 y Profilaxis")
})

it("con dos controles reservados con la cita, los nombra a los dos", async () => {
  const f = await clinicalFixture()
  const visit = await visitFor(f, null)
  const endo = await treatment(f, "Endodoncia posterior vital", 46)
  const resin = await treatment(f, "Resina compuesta", 16)
  await controlFor(f, visit, { title: "Control de evolución endodóntica", planItemId: endo.id })
  await controlFor(f, visit, { title: "Control de la resina", planItemId: resin.id })
  expect(await bookedReason(f)).toBe("Control de evolución endodóntica y Control de la resina")
})

it("lo cancelado o reemplazado después de agendar no se nombra en «Continúa»", async () => {
  const f = await clinicalFixture()
  const visit = await visitFor(f, null)
  const endo = await treatment(f, "Endodoncia posterior vital", 46)
  const cancelled = await treatment(f, "Resina cancelada", 16)
  const replaced = await treatment(f, "Corona reemplazada", 36)
  await ownerDb.update(treatmentPlanItem).set({ status: "cancelado" }).where(eq(treatmentPlanItem.id, cancelled.id))
  await ownerDb.update(treatmentPlanItem).set({ status: "reemplazado" }).where(eq(treatmentPlanItem.id, replaced.id))
  await ownerDb.insert(appointmentPlanItem).values(
    [endo, cancelled, replaced].map((item) => ({
      organizationId: "org_a",
      patientId: f.patient.id,
      appointmentId: visit.id,
      planItemId: item.id,
    })),
  )
  expect(await bookedReason(f)).toBe("Continúa: Endodoncia posterior vital de la 46")
  // Si todo lo agendado se cayó, no hay motivo que ofrecer.
  await ownerDb.update(treatmentPlanItem).set({ status: "cancelado" }).where(eq(treatmentPlanItem.id, endo.id))
  expect(await bookedReason(f)).toBeNull()
})
