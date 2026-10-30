/**
 * Los documentos del paciente (ADR 0112): el QR público no dice nada de salud, lo
 * clínico del presupuesto sale solo a quien corresponde, y lo entregado queda congelado.
 */
import { randomUUID } from "node:crypto"
import {
  serviceCatalog,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import { and, eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { buildBudgetSnapshot, renderBudgetPdf } from "./budget-pdf.js"
import {
  createBudget,
  deliverBudget,
  getBudgetDetail,
  getBudgetPresentation,
  updateBudgetPresentation,
} from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  documentCheckToken,
  patientInitials,
  readDocumentCheck,
  readDocumentCheckToken,
} from "./document-check.js"
import { requirePatient } from "./patients.js"
import { addPlanItem } from "./plan.js"
import { cancelPrescription, createPrescription } from "./prescriptions.js"
import { listDecisionRecipients } from "./responsibilities.js"
import { getTemplatePatientGuide, updateService } from "./service-catalog.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const KEY = Buffer.alloc(32, 7)

it("el token: alterado o con otra clave no vale, sin distinguir por qué", () => {
  const id = randomUUID()
  const token = documentCheckToken(KEY, "org_a", "prescription", id)
  expect(readDocumentCheckToken(KEY, token)).toEqual({ orgId: "org_a", type: "prescription", id })
  const [payload, sig] = token.split(".") as [string, string]
  const other = documentCheckToken(KEY, "org_b", "prescription", id).split(".")[0]!
  expect(readDocumentCheckToken(KEY, `${other}.${sig}`)).toBeNull()
  expect(readDocumentCheckToken(KEY, `${payload}.${sig.slice(0, -2)}xx`)).toBeNull()
  expect(readDocumentCheckToken(KEY, payload)).toBeNull()
  expect(readDocumentCheckToken(Buffer.alloc(32, 8), token)).toBeNull()
  expect(readDocumentCheckToken(KEY, "basura")).toBeNull()
  expect(patientInitials("Rosa Quispe")).toBe("R. Q.")
})

it("el QR público de una receta: estados, y nada de salud ni el nombre completo", async () => {
  const f = await clinicalFixture()
  const rx = await f.run((tx) =>
    createPrescription(tx, ...f.args, {
      items: [
        {
          genericName: "Amoxicilina",
          strength: "500 mg",
          dosageForm: "tableta",
          dose: "1 tableta",
          route: "oral",
          frequency: "cada 8 horas",
          duration: "5 días",
          quantity: 15,
        },
      ],
    } as never),
  )
  const person = await f.run((tx) => requirePatient(tx, "org_a", f.patient.id))
  const check = await f.run((tx) => readDocumentCheck(tx, "org_a", "prescription", rx.id))
  expect(check?.state).toBe("vigente")
  expect(Object.keys(check ?? {}).sort()).toEqual(
    [
      "clinic",
      "issuedAt",
      "label",
      "patientInitials",
      "signer",
      "state",
      "validUntil",
      "voidedAt",
    ].sort(),
  )
  const text = JSON.stringify(check)
  expect(text.toLowerCase()).not.toContain("amoxicilina")
  expect(text).not.toContain(person.displayName)
  expect(check?.patientInitials).toBe(patientInitials(person.displayName))

  await ownerDb.execute(
    sql`update "prescription" set "valid_until" = '2020-01-01' where "id" = ${rx.id}`,
  )
  expect((await f.run((tx) => readDocumentCheck(tx, "org_a", "prescription", rx.id)))?.state).toBe(
    "vencido",
  )

  await f.run((tx) => cancelPrescription(tx, ...f.args, rx.id, { reason: "Motivo secreto" }))
  const voided = await f.run((tx) => readDocumentCheck(tx, "org_a", "prescription", rx.id))
  expect(voided?.state).toBe("anulado")
  expect(voided?.voidedAt).toBeTruthy()
  expect(JSON.stringify(voided)).not.toContain("Motivo secreto")

  // De otra clínica no se lee: es el mismo «no está».
  expect(
    await f.run((tx) => readDocumentCheck(tx, "org_a", "prescription", randomUUID())),
  ).toBeNull()
})

async function budgetWithGuide() {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
    }),
  )
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  return { f, item, budget, serviceId: f.service.id }
}

it("lo sugerido nunca sale sin guardar; al entregar se congela la del servicio", async () => {
  const { f, budget, serviceId } = await budgetWithGuide()
  const [service] = await ownerDb
    .select()
    .from(serviceCatalog)
    .where(eq(serviceCatalog.id, serviceId))
  const [template] = await ownerDb
    .insert(treatmentTemplate)
    .values({
      key: `sugerido-${randomUUID()}`,
      name: "Sugerido",
      kind: "endodoncia",
      scope: "general",
      patientGuide: { how: "Texto sugerido" },
    })
    .returning({ id: treatmentTemplate.id })
  await ownerDb
    .update(serviceCatalog)
    .set({ templateId: template!.id, source: "template" })
    .where(eq(serviceCatalog.id, serviceId))
  expect(service?.patientGuide).toBeNull()
  expect((await f.run((tx) => getTemplatePatientGuide(tx, template!.id))).suggestion).toEqual({
    how: "Texto sugerido",
  })
  // Unido al sugerido pero sin revisar: la línea no trae explicación.
  const draft = await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
  expect(draft.lines[0]?.guide).toBeNull()

  await f.run((tx) =>
    updateService(tx, "org_a", f.args[1], serviceId, { patientGuide: { how: "Lo de la clínica" } }),
  )
  const [reviewed] = await ownerDb
    .select()
    .from(serviceCatalog)
    .where(eq(serviceCatalog.id, serviceId))
  expect(reviewed?.patientGuideReviewedBy).toBe(f.args[1])
  expect(reviewed?.patientGuideReviewedAt).toBeTruthy()

  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    updateService(tx, "org_a", f.args[1], serviceId, { patientGuide: { how: "Cambió después" } }),
  )
  const delivered = await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
  expect(delivered.lines[0]?.guide).toEqual({ how: "Lo de la clínica" })
  expect(delivered.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/)

  // Entregado ya no se edita, ni por el servicio ni en la base.
  await expect(
    f.run((tx) =>
      updateBudgetPresentation(
        tx,
        ...f.args,
        budget.id,
        { proposal: "Otra" },
        { clinicalAccess: true },
      ),
    ),
  ).rejects.toMatchObject({ code: "BUDGET_STATUS" })
  await expect(
    ownerDb
      .update(treatmentBudget)
      .set({ findings: "Otra" })
      .where(eq(treatmentBudget.id, budget.id)),
  ).rejects.toThrow()
  await expect(
    ownerDb
      .update(treatmentBudgetItem)
      .set({ patientGuide: { how: "Otra" } })
      .where(and(eq(treatmentBudgetItem.budgetId, budget.id))),
  ).rejects.toThrow()
})

it("el ajuste para este paciente manda sobre la del servicio", async () => {
  const { f, budget, serviceId } = await budgetWithGuide()
  await f.run((tx) =>
    updateService(tx, "org_a", f.args[1], serviceId, { patientGuide: { how: "De la clínica" } }),
  )
  const presentation = await f.run((tx) =>
    getBudgetPresentation(tx, "org_a", f.patient.id, budget.id, { clinicalAccess: true }),
  )
  const lineId = presentation.lines[0]!.id
  expect(presentation.lines[0]?.serviceGuide).toEqual({ how: "De la clínica" })
  await f.run((tx) =>
    updateBudgetPresentation(
      tx,
      ...f.args,
      budget.id,
      { lines: [{ lineId, patientGuide: { how: "Solo para ella" } }] },
      { clinicalAccess: true },
    ),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const snap = await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
  expect(snap.lines[0]?.guide).toEqual({ how: "Solo para ella" })
})

it("lo encontrado: según el rol y el destinatario; nunca en el detalle del presupuesto", async () => {
  const { f, budget } = await budgetWithGuide()
  await f.run((tx) =>
    updateBudgetPresentation(
      tx,
      ...f.args,
      budget.id,
      { findings: "Pulpitis del molar" },
      { clinicalAccess: true },
    ),
  )

  const detail = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, budget.id))
  expect(JSON.stringify(detail)).not.toContain("Pulpitis del molar")
  expect(detail.hasFindings).toBe(true)

  const asReception = await f.run((tx) =>
    getBudgetPresentation(tx, "org_a", f.patient.id, budget.id, { clinicalAccess: false }),
  )
  expect(asReception.findings).toBeNull()
  expect(asReception.hasFindings).toBe(true)

  const snap = (actor: Parameters<typeof buildBudgetSnapshot>[4]) =>
    f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id, actor))
  expect((await snap({ memberRole: "reception" })).findings).toBeNull()
  expect((await snap({ memberRole: "cashier" })).allergies).toEqual([])
  expect((await snap({ memberRole: "admin" })).findings).toBe("Pulpitis del molar")
  const recipients = await f.run((tx) => listDecisionRecipients(tx, "org_a", f.patient.id))
  expect((await snap({ recipientContactId: recipients[0]!.contactId })).findings).toBe(
    "Pulpitis del molar",
  )
  expect((await snap({ recipientContactId: randomUUID() })).findings).toBeNull()
  // Sale sin romperse, con y sin lo clínico.
  const pdf = await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
  expect(Buffer.from((await renderBudgetPdf(pdf)).slice(0, 5)).toString("latin1")).toBe("%PDF-")
})
