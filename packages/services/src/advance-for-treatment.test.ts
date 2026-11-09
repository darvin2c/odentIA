import { randomUUID } from "node:crypto"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createPaymentMethod } from "./payment-methods.js"
import { acceptedTreatmentTotals, collectCharge, getAccountSummary } from "./payments.js"
import { addPlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

/** Un tratamiento aceptado de S/ 1,200 (la tarifa del servicio de la ficha de prueba), con efectivo y una sede. */
async function acceptedTreatment() {
  const f = await clinicalFixture()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const [sede] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede adelanto ${randomUUID()}` })
    .returning()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  return { f, cash, branchId: sede.id, budget, line: budget.items[0] }
}

it("el adelanto para un tratamiento queda en él: no a favor suelto, y el total dice cuánto falta", async () => {
  const { f, cash, branchId, budget, line } = await acceptedTreatment()
  const requestId = randomUUID()
  const body = {
    branchId,
    advanceCents: 30000,
    advanceForBudgetItemId: line.id,
    payments: [{ paymentMethodId: cash.id, amountCents: 30000 }],
    requestId,
  }
  const paid = await f.run((tx) => collectCharge(tx, ...f.args, body))
  const snapshot = paid.ticket.snapshot as { lines: Array<{ chargeId: string | null; description: string; appliedCents: number }> }
  // El ticket dice para qué es, no «saldo a favor».
  expect(snapshot.lines).toHaveLength(1)
  expect(snapshot.lines[0]).toMatchObject({ description: `Adelanto: ${line.title}`, appliedCents: 30000 })
  expect(snapshot.lines[0]?.chargeId).not.toBeNull()
  const account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.byCurrency[0]).toMatchObject({ porCobrar: 0, aFavor: 0, saldo: 0 })
  expect(account.pendiente).toHaveLength(0)

  const [totals] = await f.run((tx) => acceptedTreatmentTotals(tx, "org_a", f.patient.id))
  expect(totals).toMatchObject({
    budgetId: budget.id,
    agreedCents: 120000,
    paidCents: 30000,
    remainingCents: 90000,
  })
  expect(totals?.lines[0]).toMatchObject({ budgetItemId: line.id, toChargeCents: 90000 })

  // El mismo cobro otra vez (un corte de red) no carga ni cobra de nuevo.
  const again = await f.run((tx) => collectCharge(tx, ...f.args, body))
  expect(again.duplicate).toBe(true)
  const [after] = await f.run((tx) => acceptedTreatmentTotals(tx, "org_a", f.patient.id))
  expect(after).toMatchObject({ paidCents: 30000, remainingCents: 90000 })
})

it("lo que tiene a favor no paga el adelanto de un tratamiento, y no se adelanta más de lo acordado", async () => {
  const { f, cash, branchId, line } = await acceptedTreatment()
  // S/ 100 a favor, sin tratamiento.
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 10000,
      payments: [{ paymentMethodId: cash.id, amountCents: 10000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 20000,
      advanceForBudgetItemId: line.id,
      payments: [{ paymentMethodId: cash.id, amountCents: 20000 }],
      requestId: randomUUID(),
    }),
  )
  const account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  // Lo de a favor sigue a favor; el adelanto del tratamiento está pagado entero con lo nuevo.
  expect(account.byCurrency[0]).toMatchObject({ aFavor: 10000, porCobrar: 0 })
  const [totals] = await f.run((tx) => acceptedTreatmentTotals(tx, "org_a", f.patient.id))
  expect(totals).toMatchObject({ paidCents: 20000, remainingCents: 100000 })

  await expect(
    f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId,
        advanceCents: 150000,
        advanceForBudgetItemId: line.id,
        payments: [{ paymentMethodId: cash.id, amountCents: 150000 }],
        requestId: randomUUID(),
      }),
    ),
  ).rejects.toMatchObject({ code: "CHARGE_EXCEEDS_BUDGET" })
  // El rechazo no dejó nada a medias: ni cargo ni cobro.
  const [still] = await f.run((tx) => acceptedTreatmentTotals(tx, "org_a", f.patient.id))
  expect(still).toMatchObject({ paidCents: 20000, remainingCents: 100000 })
})
