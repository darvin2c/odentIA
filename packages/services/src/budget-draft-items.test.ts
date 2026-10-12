/**
 * Tratamientos de un borrador: se añaden con las mismas reglas que al
 * prepararlo, solo mientras es borrador, y un borrador no admite repetirlos.
 */
import { treatmentPlanItem } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  addBudgetItems,
  adjustBudgetLines,
  createBudget,
  deliverBudget,
  removeBudgetItems,
  reviseBudget,
} from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import { setupTestDb } from "./test-setup.js"
setupTestDb()

async function draftWithSpareItem() {
  const f = await clinicalFixture()
  const indicate = () =>
    f.run((tx) =>
      addPlanItem(tx, ...f.args, {
        serviceId: f.service.id,
        planId: f.plan.id,
        sourceEncounterId: f.encounter.id,
      }),
    )
  const first = await indicate()
  const spare = await indicate()
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [first.id] }),
  )
  return { f, first, spare, budget }
}

it("añadir un tratamiento al borrador lo cotiza a su tarifa y actualiza los totales", async () => {
  const { f, first, spare, budget } = await draftWithSpareItem()
  // La primera línea ya tiene un precio acordado: añadir otra no lo toca.
  await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, {
      lines: [{ planItemId: first.id, priceCents: 100000, reason: "Paciente frecuente" }],
    }),
  )
  const updated = await f.run((tx) =>
    addBudgetItems(tx, ...f.args, budget.id, { itemIds: [spare.id] }),
  )
  expect(updated.items).toHaveLength(2)
  const added = updated.items.find((line) => line.planItemId === spare.id)
  expect(added).toMatchObject({
    priceCents: 120000,
    tariffPriceCents: 120000,
    promotionId: null,
    decision: "pendiente",
    lineDiscountCents: null,
  })
  expect(updated.items.find((line) => line.planItemId === first.id)).toMatchObject({
    priceCents: 100000,
    lineDiscountCents: 20000,
  })
  expect(updated).toMatchObject({ tariffTotalCents: 240000, totalCents: 220000, discountCents: 20000 })

  const audits = await f.run((tx) =>
    tx
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "budget.items_added"), eq(auditEvent.entityId, budget.id))),
  )
  expect(audits).toHaveLength(1)
  expect(audits[0]?.metadata).toMatchObject({ itemIds: [spare.id], itemCount: 1 })
})

it("quitar un tratamiento del borrador lo deja sin presupuestar y queda auditado", async () => {
  const { f, first, spare, budget } = await draftWithSpareItem()
  await f.run((tx) => addBudgetItems(tx, ...f.args, budget.id, { itemIds: [spare.id] }))
  await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, {
      lines: [{ planItemId: first.id, priceCents: 100000, reason: "Paciente frecuente" }],
    }),
  )
  const updated = await f.run((tx) =>
    removeBudgetItems(tx, ...f.args, budget.id, { itemIds: [first.id] }),
  )
  expect(updated.items.map((line) => line.planItemId)).toEqual([spare.id])
  expect(updated).toMatchObject({ totalCents: 120000, tariffTotalCents: 120000, discountCents: 0 })
  // La indicación queda libre: no apunta a ningún presupuesto.
  const [freed] = await f.run((tx) =>
    tx
      .select({ budgetId: treatmentPlanItem.budgetId })
      .from(treatmentPlanItem)
      .where(eq(treatmentPlanItem.id, first.id)),
  )
  expect(freed?.budgetId).toBeNull()
  const audits = await f.run((tx) =>
    tx
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "budget.items_removed"), eq(auditEvent.entityId, budget.id))),
  )
  expect(audits).toHaveLength(1)
  expect(audits[0]?.metadata).toMatchObject({
    itemCount: 1,
    removed: [{ planItemId: first.id, priceCents: 100000, reason: "Paciente frecuente" }],
  })
  // Puede volver a entrar, otra vez a su tarifa.
  const back = await f.run((tx) =>
    addBudgetItems(tx, ...f.args, budget.id, { itemIds: [first.id] }),
  )
  expect(back.items.find((line) => line.planItemId === first.id)).toMatchObject({
    priceCents: 120000,
    priceReason: null,
  })
})

it("un borrador que quedó sin tratamientos no se entrega, y entregado ya no se le quitan", async () => {
  const { f, first, spare, budget } = await draftWithSpareItem()
  await expect(
    f.run((tx) => removeBudgetItems(tx, ...f.args, budget.id, { itemIds: [spare.id] })),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })
  const emptied = await f.run((tx) =>
    removeBudgetItems(tx, ...f.args, budget.id, { itemIds: [first.id] }),
  )
  expect(emptied.items).toHaveLength(0)
  await expect(f.run((tx) => deliverBudget(tx, ...f.args, budget.id))).rejects.toMatchObject({
    code: "VALIDATION",
  })

  await f.run((tx) => addBudgetItems(tx, ...f.args, budget.id, { itemIds: [first.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await expect(
    f.run((tx) => removeBudgetItems(tx, ...f.args, budget.id, { itemIds: [first.id] })),
  ).rejects.toMatchObject({ code: "BUDGET_STATUS" })
})

it("el borrador de una revisión no admite añadir ni quitar tratamientos", async () => {
  const { f, first, spare, budget } = await draftWithSpareItem()
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const revision = await f.run((tx) =>
    reviseBudget(tx, ...f.args, budget.id, { itemIds: [first.id], reason: "Cambio de plan" }),
  )
  await expect(
    f.run((tx) => addBudgetItems(tx, ...f.args, revision.id, { itemIds: [spare.id] })),
  ).rejects.toMatchObject({ code: "BUDGET_REVISION_ITEMS" })
  await expect(
    f.run((tx) => removeBudgetItems(tx, ...f.args, revision.id, { itemIds: [first.id] })),
  ).rejects.toMatchObject({ code: "BUDGET_REVISION_ITEMS" })
})

it("no repite un tratamiento ya cotizado ni admite añadir fuera del borrador", async () => {
  const { f, first, spare, budget } = await draftWithSpareItem()
  await expect(
    f.run((tx) => addBudgetItems(tx, ...f.args, budget.id, { itemIds: [first.id] })),
  ).rejects.toMatchObject({ code: "ITEM_ALREADY_QUOTED" })
  await expect(
    f.run((tx) => addBudgetItems(tx, ...f.args, budget.id, { itemIds: [] })),
  ).rejects.toMatchObject({ code: "VALIDATION" })

  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await expect(
    f.run((tx) => addBudgetItems(tx, ...f.args, budget.id, { itemIds: [spare.id] })),
  ).rejects.toMatchObject({ code: "BUDGET_STATUS" })
})
