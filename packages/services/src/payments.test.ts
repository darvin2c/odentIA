import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget, reviseBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import {
  collectCharge,
  createCharge,
  getAccountSummary,
  updateCharge,
  voidCharge,
} from "./payments.js"
import { createPaymentMethod } from "./payment-methods.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

interface Fixture {
  actor: string
  patient: { id: string }
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
}

async function seedMethods(f: Fixture) {
  const cash = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }),
  )
  const yape = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Yape", typeCode: "68" }),
  )
  return { cash, yape }
}

async function seedBranch(_f: Fixture) {
  const [row] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede cobro ${randomUUID()}` })
    .returning()
  return row.id
}

it("conserva el límite por tratamiento y la edición con motivo sin aplicaciones", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  const first = await f.run((tx) =>
    createCharge(tx, ...f.args, { budgetItemId: budget.items[0].id, amountCents: 40000 }),
  )
  // La línea hereda la promoción de la propuesta (aquí sin promoción).
  expect(first.promotionId).toBeNull()
  const edited = await f.run((tx) =>
    updateCharge(tx, ...f.args, first.id, { amountCents: 35000, reason: "Descuento en mostrador" }),
  )
  expect(edited.amountCents).toBe(35000)
  expect(edited.editReason).toBe("Descuento en mostrador")
  const second = await f.run((tx) =>
    createCharge(tx, ...f.args, { budgetItemId: budget.items[0].id, amountCents: 80000 }),
  )
  expect(second.amountCents).toBe(80000)
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  const pen = summary.byCurrency.find((c) => c.currency === "PEN")
  expect(pen).toMatchObject({ porCobrar: 115000, pagado: 0, aFavor: 0 })
  expect(summary.pendiente).toHaveLength(2)
  expect(summary.pendiente[0]).toMatchObject({ budgetItemId: budget.items[0].id })
  const other = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  await expect(
    f.run((tx) => reviseBudget(tx, ...f.args, budget.id, { itemIds: [other.id], reason: "Cambio de plan" })),
  ).rejects.toMatchObject({ code: "BUDGET_ITEM_IN_USE" })
})

it("no vuelve a cobrar el mismo tratamiento al revisar la propuesta", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const original = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, original.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, original.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  await f.run((tx) =>
    createCharge(tx, ...f.args, { budgetItemId: original.items[0].id, amountCents: 120000 }),
  )
  const revision = await f.run((tx) =>
    reviseBudget(tx, ...f.args, original.id, { itemIds: [item.id], reason: "Revisión sin cambios" }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, revision.id))
  await f.run((tx) => decideBudget(tx, ...f.args, revision.id, {
    decisions: [{ planItemId: item.id, decision: "aceptado" }],
  }))
  await expect(
    f.run((tx) => createCharge(tx, ...f.args, { budgetItemId: revision.items[0].id })),
  ).rejects.toMatchObject({ code: "CHARGE_EXCEEDS_BUDGET" })
})

it("el concepto manual toma la moneda de la clínica sin pedirla", async () => {
  const f = await clinicalFixture()
  const charge = await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Cepillo", amountCents: 2500 }),
  )
  expect(charge.currency).toBe("PEN")
  expect(charge.amountCents).toBe(2500)
})

it("cobra multimedio con vuelto, reparte FIFO y anula el concepto sin cobros", async () => {
  const f = await clinicalFixture()
  const { cash, yape } = await seedMethods(f)
  const branchId = await seedBranch(f)
  const first = await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Resina", amountCents: 33000, currency: "PEN" }),
  )
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Profilaxis", amountCents: 12000, currency: "PEN" }),
  )
  const collected = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [
        { paymentMethodId: cash.id, amountCents: 20000 },
        { paymentMethodId: yape.id, amountCents: 25000, reference: "OP-1" },
      ],
      cashReceivedCents: 50000,
      requestId: "11111111-1111-4111-8111-111111111111",
    }),
  )
  expect(collected.ticket.ticketNumber).toBe(1)
  expect(collected.ticket.changeCents).toBe(30000)
  expect(collected.remainingCents).toBe(0)
  expect(collected.payments).toHaveLength(2)
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(summary.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({
    porCobrar: 0,
    pagado: 45000,
    aFavor: 0,
  })
  expect(summary.cobros[0]).toMatchObject({ number: 1, status: "vigente" })
  // Un concepto con cobros aplicados no se edita ni se anula.
  await expect(
    f.run((tx) => updateCharge(tx, ...f.args, first.id, { amountCents: 1, reason: "X" })),
  ).rejects.toMatchObject({ code: "CHARGE_HAS_APPLICATIONS" })
  await expect(
    f.run((tx) => voidCharge(tx, ...f.args, first.id, { reason: "X" })),
  ).rejects.toMatchObject({ code: "CHARGE_HAS_APPLICATIONS" })
})
