import { randomUUID } from "node:crypto"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter } from "./encounters.js"
import { createPaymentMethod } from "./payment-methods.js"
import { acceptedTreatmentTotals, collectCharge, getAccountSummary, returnFromTicket, voidTicket } from "./payments.js"
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

it("anular el ticket del adelanto lo deshace entero, y no se devuelve por partes (revisión del 9 nov)", async () => {
  const { f, cash, branchId, line } = await acceptedTreatment()
  const paid = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 30000,
      advanceForBudgetItemId: line.id,
      payments: [{ paymentMethodId: cash.id, amountCents: 30000 }],
      requestId: randomUUID(),
    }),
  )
  const chargeId = (paid.ticket.snapshot as { lines: Array<{ chargeId: string }> }).lines[0]!.chargeId
  // Devolver una parte dejaría lo devuelto como cobrado del tratamiento: al firmar se cobraría de menos.
  await expect(
    f.run((tx) =>
      returnFromTicket(tx, ...f.args, paid.ticket.id, {
        branchId,
        lines: [{ chargeId, amountCents: 10000 }],
        paymentMethodId: cash.id,
        reason: "Pidió una parte",
        requestId: randomUUID(),
      }),
    ),
  ).rejects.toMatchObject({ code: "ADVANCE_RETURNED_WHOLE" })
  // Anular el ticket: ni deuda «Adelanto: …» por cobrar, ni nada pagado del tratamiento.
  await f.run((tx) => voidTicket(tx, ...f.args, paid.ticket.id, { reason: "Se equivocó de paciente", allowPostClose: false }))
  const account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.pendiente).toHaveLength(0)
  expect(account.byCurrency.every((row) => row.porCobrar === 0 && row.aFavor === 0)).toBe(true)
  const [totals] = await f.run((tx) => acceptedTreatmentTotals(tx, "org_a", f.patient.id))
  expect(totals).toMatchObject({ paidCents: 0, remainingCents: 120000, owingCents: 0 })
  expect(totals?.lines[0]?.toChargeCents).toBe(120000)
})

it("M7: con un adelanto, el cierre y la cuenta dicen lo que costó entero, no solo el resto (QA del 10 nov)", async () => {
  const { f, cash, branchId, line } = await acceptedTreatment()
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 30000,
      advanceForBudgetItemId: line.id,
      payments: [{ paymentMethodId: cash.id, amountCents: 30000 }],
      requestId: randomUUID(),
    }),
  )
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: line.planItemId }))
  const done = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const charged = done.billing.lines.find((row) => row.status === "charged")
  // Hoy se carga el resto, y la línea dice lo acordado y lo adelantado.
  expect(charged).toMatchObject({ amountCents: 90000, agreedCents: 120000, advanceCents: 30000 })
  const account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.pendiente).toHaveLength(1)
  expect(account.pendiente[0]).toMatchObject({ totalCents: 90000, paidCents: 0, saldoCents: 90000, advancePaidCents: 30000 })
  // Nada se cobra dos veces: lo que debe es el resto.
  expect(account.byCurrency[0]).toMatchObject({ saldo: 90000 })
})
