import { expect, it } from "vitest"
import {
  adjustBudgetLines,
  createBudget,
  decideBudget,
  deliverBudget,
} from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem, createTreatmentPlan } from "./plan.js"
import { createCharge } from "./payments.js"
import { setupTestDb } from "./test-setup.js"
setupTestDb()

async function draftBudget() {
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
  return { f, item, budget }
}

it("el descuento exige motivo y queda en totales", async () => {
  const { f, item, budget } = await draftBudget()
  // Sin motivo y por debajo de la tarifa (120000): se rechaza.
  await expect(
    f.run((tx) =>
      adjustBudgetLines(tx, ...f.args, budget.id, {
        lines: [{ planItemId: item.id, priceCents: 100000 }],
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  const adjusted = await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, {
      lines: [{ planItemId: item.id, priceCents: 100000, reason: "Pronto pago" }],
    }),
  )
  const line = adjusted.items.find((l) => l.planItemId === item.id)
  expect(line?.priceCents).toBe(100000)
  expect(line?.tariffPriceCents).toBe(120000)
  expect(line?.priceReason).toBe("Pronto pago")
  expect(adjusted.tariffTotalCents).toBe(120000)
  expect(adjusted.totalCents).toBe(100000)
  expect(adjusted.discountCents).toBe(20000)
  // Con el precio acordado el cargo respeta el descuento, no la tarifa.
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  const charge = await f.run((tx) =>
    createCharge(tx, ...f.args, { budgetItemId: adjusted.items[0].id }),
  )
  expect(charge.amountCents).toBe(100000)
})

it("el odontólogo solo presupuesta su plan propio", async () => {
  const f = await clinicalFixture()
  const ownPlan = await f.run((tx) =>
    createTreatmentPlan(tx, ...f.args, {
      title: "Plan propio",
      originEncounterId: f.encounter.id,
    }),
  )
  expect(ownPlan.createdBy).toBe(f.actor)
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: ownPlan.id,
      sourceEncounterId: f.encounter.id,
    }),
  )
  const own = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: ownPlan.id, itemIds: [item.id] }, { memberRole: "dentist" }),
  )
  expect(own.planId).toBe(ownPlan.id)
  // Otro odontólogo no puede presupuestar ni entregar un plan ajeno.
  const other = "00000000-0000-0000-0000-000000000001"
  await expect(
    f.run((tx) =>
      createBudget(tx, "org_a", other, f.patient.id, { planId: ownPlan.id, itemIds: [item.id] }, { memberRole: "dentist" }),
    ),
  ).rejects.toMatchObject({ code: "BUDGET_NOT_OWN_PLAN" })
  await expect(
    f.run((tx) => deliverBudget(tx, "org_a", other, f.patient.id, own.id, { memberRole: "dentist" })),
  ).rejects.toMatchObject({ code: "BUDGET_NOT_OWN_PLAN" })
})

it("la respuesta parcial se completa sin reescribir ni cambiar de autoridad", async () => {
  const { f, item, budget } = await draftBudget()
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const partial = await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "pospuesto" }],
    }),
  )
  expect(partial.status).toBe("pospuesto")
  // Completar lo pospuesto conserva la decisión parcial como evidencia.
  const completed = await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  expect(completed.status).toBe("aceptado")
})
