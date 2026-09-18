import { expect, it } from "vitest"
import { createBudget, decideBudget, presentBudget, reviseBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import { applyPayment, createCharge, createPayment, getPatientAccount, refundPayment, voidPaymentApplication } from "./payments.js"
import { setupTestDb } from "./test-setup.js"
setupTestDb()

it("concilia cargos, anticipos y devoluciones sin mezclar monedas ni sobregirar", async () => {
  const f = await clinicalFixture()
  const item = await f.run(tx => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run(tx => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run(tx => presentBudget(tx, ...f.args, budget.id))
  await f.run(tx => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  expect((await f.run(tx => getPatientAccount(tx, "org_a", f.patient.id))).charges).toEqual([])
  const first = await f.run(tx => createCharge(tx, ...f.args, { budgetItemId: budget.items[0].id, amountCents: 40000 }))
  const payment1 = await f.run(tx => createPayment(tx, ...f.args, { amountCents: 30000, currency: "PEN", paidAt: "2026-01-10T12:00:00Z", method: "efectivo" }))
  const application1 = await f.run(tx => applyPayment(tx, ...f.args, payment1.id, { chargeId: first.id, amountCents: 30000 }))
  const second = await f.run(tx => createCharge(tx, ...f.args, { budgetItemId: budget.items[0].id, amountCents: 80000 }))
  const payment2 = await f.run(tx => createPayment(tx, ...f.args, { amountCents: 50000, currency: "PEN", paidAt: "2026-01-11T12:00:00Z", method: "transferencia" }))
  await f.run(tx => applyPayment(tx, ...f.args, payment2.id, { chargeId: second.id, amountCents: 50000 }))
  const account = await f.run(tx => getPatientAccount(tx, "org_a", f.patient.id))
  expect(account.byCurrency).toEqual([{ currency: "PEN", agreedCents: 120000, chargedCents: 120000, paidCents: 80000, appliedCents: 80000, refundedCents: 0, outstandingCents: 40000, availableCreditCents: 0 }])
  await expect(f.run(tx => refundPayment(tx, ...f.args, payment1.id, { amountCents: 100, reason: "Devolución" }))).rejects.toMatchObject({ status: 409 })
  await expect(f.run(tx => applyPayment(tx, ...f.args, payment1.id, { chargeId: first.id, amountCents: 100 }))).rejects.toMatchObject({ status: 409 })
  const dollars = await f.run(tx => createPayment(tx, ...f.args, { amountCents: 100, currency: "USD", paidAt: "2026-01-11T12:00:00Z", method: "tarjeta" }))
  await expect(f.run(tx => applyPayment(tx, ...f.args, dollars.id, { chargeId: first.id, amountCents: 100 }))).rejects.toMatchObject({ code: "CURRENCY_MISMATCH" })
  await f.run(tx => voidPaymentApplication(tx, ...f.args, application1.id, { reason: "Corrección de aplicación" }))
  await f.run(tx => refundPayment(tx, ...f.args, payment1.id, { amountCents: 30000, reason: "Devolución del excedente" }))
  const corrected = await f.run(tx => getPatientAccount(tx, "org_a", f.patient.id))
  expect(corrected.byCurrency.find(c => c.currency === "PEN")).toMatchObject({ availableCreditCents: 0, refundedCents: 30000, outstandingCents: 70000, appliedCents: 50000 })
  expect(corrected.applications.find(a => a.id === application1.id)?.voidReason).toBe("Corrección de aplicación")
  const other = await f.run(tx => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  await expect(f.run(tx => reviseBudget(tx, ...f.args, budget.id, { itemIds: [other.id], reason: "Revisión" }))).rejects.toMatchObject({ code: "BUDGET_ITEM_IN_USE" })
})
