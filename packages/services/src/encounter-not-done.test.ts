/**
 * «No se hizo» en una atención firmada (mesa del cierre de la atención, 19 nov 2026): lo firmado
 * queda tachado con su motivo, el tratamiento vuelve al plan (no se cancela), el diagnóstico que
 * esa firma resolvió vuelve a activo, y el dinero lo mueve caja: lo que nadie pagó se anula solo,
 * lo pagado no se toca y caja recibe la tarea.
 */
import { randomUUID } from "node:crypto"
import { crmTask } from "@odentia/db/schema/crm"
import {
  clinicalNote,
  encounter,
  serviceCatalog,
  encounterDiagnosis,
  encounterProcedure,
  patientCharge,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { getNotDonePreview, markProcedureNotDone } from "./encounter-not-done.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import { addEncounterProcedure, finalizeEncounter } from "./encounters.js"
import { createPaymentMethod } from "./payment-methods.js"
import { collectCharge, getAccountSummary } from "./payments.js"
import { addPlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Atiende y firma una resina en la 24 hecha directo del catálogo (S/ 180), por la caries de la 24. */
async function signedDirect(f: Fixture) {
  await f.ready(f.encounter.id)
  const [resin] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: "org_a", name: "Resina", scope: "tooth", source: "custom", priceCents: 18_000, currency: "PEN" })
    .returning()
  const caries = await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, { diagnosisCode: "K02.1", diagnosisType: "confirmed", toothNumber: 24 }),
  )
  const proc = await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: resin!.id, diagnosisCode: "K02.1", toothNumber: 24 }),
  )
  const diagnoses = [{ id: caries.id }]
  const signed = await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, f.encounter.id, { resolveDiagnosisIds: diagnoses.map((row) => row.id) }),
  )
  return { proc, signed, diagnosisIds: diagnoses.map((row) => row.id) }
}

const notDone = (f: Fixture, procedureId: string, opts: { actor?: string; memberRole?: string } = {}) =>
  f.run((tx) =>
    markProcedureNotDone(
      tx,
      "org_a",
      opts.actor ?? f.actor,
      f.patient.id,
      f.encounter.id,
      procedureId,
      { reason: "Lo registré en la pieza equivocada" },
      { memberRole: opts.memberRole ?? "clinician" },
    ),
  )

it("sin pagar: queda tachado con su motivo, vuelve al plan como pendiente, su caries a activa y el cobro se anula", async () => {
  const f = await clinicalFixture()
  const { proc, signed, diagnosisIds } = await signedDirect(f)
  expect(signed.charges).toHaveLength(1)
  const [resolvedBefore] = await ownerDb
    .select({ status: encounterDiagnosis.status })
    .from(encounterDiagnosis)
    .where(eq(encounterDiagnosis.id, diagnosisIds[0]!))
  expect(resolvedBefore?.status).toBe("resuelto")

  const preview = await f.run((tx) =>
    getNotDonePreview(tx, "org_a", f.actor, f.patient.id, f.encounter.id, proc.id, { memberRole: "clinician" }),
  )
  expect(preview.charges.map((charge) => charge.outcome)).toEqual(["anula"])
  expect(preview.planItem?.becomes).toBe("pendiente")
  expect(preview.diagnoses).toEqual(["Caries de la dentina"])

  const result = await notDone(f, proc.id)
  expect(result.cashierTaskId).toBeNull()
  const [row] = await ownerDb.select().from(encounterProcedure).where(eq(encounterProcedure.id, proc.id))
  expect(row?.voidReason).toBe("No se hizo: Lo registré en la pieza equivocada")
  expect(row?.voidedBy).toBe(f.actor)
  // El directo no se cancela: vuelve al plan por hacer.
  const [item] = await ownerDb
    .select({ status: treatmentPlanItem.status, completedAt: treatmentPlanItem.completedAt })
    .from(treatmentPlanItem)
    .where(eq(treatmentPlanItem.id, proc.planItemId!))
  expect(item).toEqual({ status: "pendiente", completedAt: null })
  const [dx] = await ownerDb
    .select({ status: encounterDiagnosis.status, resolvedAt: encounterDiagnosis.resolvedAt })
    .from(encounterDiagnosis)
    .where(eq(encounterDiagnosis.id, diagnosisIds[0]!))
  expect(dx).toEqual({ status: "activo", resolvedAt: null })
  const [charge] = await ownerDb.select().from(patientCharge).where(eq(patientCharge.encounterProcedureId, proc.id))
  expect(charge?.voidedAt).not.toBeNull()
  const account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.byCurrency.every((money) => money.saldo === 0)).toBe(true)
  // Lo que acompaña a lo firmado: una adenda que lo dice.
  const notes = await ownerDb
    .select({ note: clinicalNote.note, kind: clinicalNote.kind })
    .from(clinicalNote)
    .where(eq(clinicalNote.encounterId, f.encounter.id))
  expect(notes).toContainEqual({ kind: "adenda", note: expect.stringContaining("No se hizo: Resina") })
  // Una sola vez.
  await expect(notDone(f, proc.id)).rejects.toMatchObject({ code: "ALREADY_VOIDED" })
})

it("ya pagado: el cobro no se toca y caja recibe la tarea con lo pagado y el motivo", async () => {
  const f = await clinicalFixture()
  const { proc, signed } = await signedDirect(f)
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const [sede] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}` }).returning()
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId: sede!.id,
      chargeIds: [signed.charges[0]!.id],
      payments: [{ paymentMethodId: cash.id, amountCents: signed.charges[0]!.amountCents }],
      requestId: randomUUID(),
    }),
  )
  const result = await notDone(f, proc.id)
  expect(result.charges.map((charge) => charge.outcome)).toEqual(["caja"])
  const [charge] = await ownerDb.select().from(patientCharge).where(eq(patientCharge.encounterProcedureId, proc.id))
  expect(charge?.voidedAt).toBeNull()
  const [task] = await ownerDb.select().from(crmTask).where(eq(crmTask.id, result.cashierTaskId!))
  expect(task?.area).toBe("caja")
  expect(task?.patientId).toBe(f.patient.id)
  expect(task?.title).toContain("No se hizo y ya estaba pagado: Resina")
  expect(task?.reason).toContain("Lo registré en la pieza equivocada")
})

it("la sesión 1 de un tratamiento cobrado entero, con la 2 hecha: el cobro sigue y el tratamiento queda en curso", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: 2 }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  await f.ready(f.encounter.id)
  const first = await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { addSessionPlanItemIds: [] }))
  const [second] = await ownerDb
    .insert(encounter)
    .values({ organizationId: "org_a", patientId: f.patient.id, professionalUserId: f.actor, reason: "Sesión 2" })
    .returning()
  await f.ready(second!.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, second!.id, { planItemId: item.id }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, second!.id))

  const result = await notDone(f, first.id)
  expect(result.charges.map((charge) => charge.outcome)).toEqual(["sigue"])
  const [charge] = await ownerDb
    .select({ voidedAt: patientCharge.voidedAt })
    .from(patientCharge)
    .where(and(eq(patientCharge.encounterProcedureId, first.id)))
  expect(charge?.voidedAt).toBeNull()
  const [after] = await ownerDb.select({ status: treatmentPlanItem.status }).from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id))
  expect(after?.status).toBe("en_curso")
})

it("lo marca quien firmó, o el dueño; otro odontólogo no, y en el borrador tampoco", async () => {
  const f = await clinicalFixture()
  const other = await clinicalFixture()
  await f.ready(f.encounter.id)
  const draftProc = await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id }))
  await expect(notDone(f, draftProc.id)).rejects.toMatchObject({ code: "NOT_FINALIZED" })
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  await expect(notDone(f, draftProc.id, { actor: other.actor })).rejects.toMatchObject({ status: 403 })
  const result = await notDone(f, draftProc.id, { actor: other.actor, memberRole: "owner" })
  expect(result.procedureRow.voidedBy).toBe(other.actor)
})
