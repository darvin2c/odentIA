/**
 * La consulta ya marcada al firmar y el cierre que nombra lo que se firma (mesa del cierre de la
 * atención, 19 nov 2026): una consulta sin nada hecho firmaba «No se carga nada» y la evaluación
 * de la cita no la cobraba nadie; y el cierre decía «2 procedimientos» sin nombrarlos ni el total.
 */
import { randomUUID } from "node:crypto"
import { appointment } from "@odentia/db/schema/agenda"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { clinicalFollowUp, encounter, encounterProcedure, patientCharge, serviceCatalog } from "@odentia/db/schema/clinical"
import { and, eq, isNull } from "drizzle-orm"
import { expect, it } from "vitest"
import { createRoom } from "./appointments.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter, getEncounterClosing } from "./encounters.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** La evaluación de la clínica (S/ 50), la que sus servicios ofrecen como evaluación. */
async function evaluation(f: Fixture) {
  const [row] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: "org_a", name: "Evaluación odontológica", scope: "general", source: "custom", priceCents: 5_000, currency: "PEN" })
    .returning()
  await ownerDb.update(serviceCatalog).set({ evaluationServiceId: row!.id }).where(eq(serviceCatalog.id, f.service.id))
  return row!
}

const closingOf = (f: Fixture) => f.run((tx) => getEncounterClosing(tx, "org_a", f.actor, f.patient.id, f.encounter.id))

it("si la clínica no tiene una consulta con precio no se propone nada, y la ya cobrada al llegar no se vuelve a cargar", async () => {
  const f = await clinicalFixture()
  await f.ready(f.encounter.id)
  expect((await closingOf(f)).consultation).toBeNull()
  // Cobrada a mano al llegar: no se propone otra.
  const consult = await evaluation(f)
  await ownerDb.insert(patientCharge).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    description: "Evaluación odontológica",
    amountCents: 5_000,
    currency: "PEN",
    createdBy: f.actor,
  })
  expect((await closingOf(f)).consultation).toBeNull()
  await expect(
    f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { consultationServiceId: consult.id })),
  ).resolves.toMatchObject({ charges: [] })
})

it("sin nada hecho: viene marcada la evaluación de la clínica; al firmar se registra, se carga y no deja un «control de evaluación»", async () => {
  const f = await clinicalFixture()
  const consult = await evaluation(f)
  await f.ready(f.encounter.id)
  const closing = await closingOf(f)
  expect(closing.billing.lines).toEqual([])
  // Las pruebas comparten la clínica: otra evaluación igual puede venir primero.
  expect(closing.consultation?.options.map((option) => option.serviceId)).toContain(consult.id)
  expect(closing.consultation?.proposed).toMatchObject({ name: "Evaluación odontológica", priceCents: 5_000, currency: "PEN" })
  const signed = await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, f.encounter.id, {
      consultationServiceId: consult.id,
      nextControl: { dueAt: closing.controls.shortcuts.week },
    }),
  )
  expect(signed.charges.map((charge) => [charge.description, charge.amountCents])).toEqual([["Evaluación odontológica", 5_000]])
  const procedures = await ownerDb
    .select({ serviceId: encounterProcedure.serviceId })
    .from(encounterProcedure)
    .where(and(eq(encounterProcedure.encounterId, f.encounter.id), isNull(encounterProcedure.voidedAt)))
  expect(procedures).toEqual([{ serviceId: consult.id }])
  const controls = await ownerDb
    .select({ title: clinicalFollowUp.title, planItemId: clinicalFollowUp.planItemId })
    .from(clinicalFollowUp)
    .where(eq(clinicalFollowUp.patientId, f.patient.id))
  expect(controls.some((control) => control.title.toLowerCase().includes("evaluación"))).toBe(false)
})

it("desmarcada: no se carga nada y la actividad guarda quién la desmarcó", async () => {
  const f = await clinicalFixture()
  await evaluation(f)
  await f.ready(f.encounter.id)
  const signed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { consultationServiceId: null }))
  expect(signed.charges).toEqual([])
  const [unchecked] = await ownerDb
    .select({ actor: auditEvent.actorUserId })
    .from(auditEvent)
    .where(and(eq(auditEvent.action, "encounter.consultation_unchecked"), eq(auditEvent.entityId, f.encounter.id)))
  expect(unchecked?.actor).toBe(f.actor)
})

it("con algo hecho hoy no se propone, y el cierre nombra cada acto con lo que se cargará, con la misma regla de la firma", async () => {
  const f = await clinicalFixture()
  await evaluation(f)
  await f.ready(f.encounter.id)
  const proc = await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id }))
  const closing = await closingOf(f)
  expect(closing.consultation).toBeNull()
  expect(closing.billing.lines).toEqual([
    expect.objectContaining({ procedureId: proc.id, description: "Tratamiento propio", amountCents: 120_000, currency: "PEN" }),
  ])
  expect(closing.billing.totals).toEqual([{ currency: "PEN", totalCents: 120_000 }])
  const signed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(signed.charges.map((charge) => charge.amountCents)).toEqual([120_000])
})

it("cobrada al llegar con otro nombre («Consulta»), tampoco se vuelve a proponer", async () => {
  const f = await clinicalFixture()
  await evaluation(f)
  await f.ready(f.encounter.id)
  expect((await closingOf(f)).consultation).not.toBeNull()
  await ownerDb.insert(patientCharge).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    description: "Consulta",
    amountCents: 5_000,
    currency: "PEN",
    createdBy: f.actor,
  })
  expect((await closingOf(f)).consultation).toBeNull()
})

it("la cita era de una consulta sin costo (la reevaluación): no se propone otra", async () => {
  const f = await clinicalFixture()
  await evaluation(f)
  const [free] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: "org_a", name: "Reevaluación postoperatoria", scope: "general", source: "custom", priceCents: 0, currency: "PEN" })
    .returning()
  // Es la evaluación de otro servicio: cuenta como consulta.
  const [other] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: "org_a", name: "Exodoncia", scope: "general", source: "custom", priceCents: 20_000, currency: "PEN", evaluationServiceId: free!.id })
    .returning()
  expect(other).toBeDefined()
  const [sede] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}`, timezone: "America/Lima" }).returning()
  const room = await f.run((tx) => createRoom(tx, "org_a", { branchId: sede!.id, name: "Unidad" }))
  const startsAt = new Date(Date.now() + 3_600_000)
  const [visit] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: "org_a",
      branchId: sede!.id,
      patientId: f.patient.id,
      professionalUserId: f.actor,
      roomId: room.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
      status: "confirmada",
      serviceId: free!.id,
    })
    .returning()
  await ownerDb.update(encounter).set({ appointmentId: visit!.id }).where(eq(encounter.id, f.encounter.id))
  await f.ready(f.encounter.id)
  expect((await closingOf(f)).consultation).toBeNull()
})
