import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget, reviseBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import { sql } from "drizzle-orm"
import {
  collectCharge,
  createCharge,
  getAccountSummary,
  getPatientAccount,
  refundCredit,
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

it("el portal dice los mismos montos que Caja: multiplica por sesiones y resta las devoluciones", async () => {
  const f = await clinicalFixture()
  const { cash } = await seedMethods(f)
  const branchId = await seedBranch(f)
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  // Ortodoncia por sesiones: 12 visitas de S/ 1 200.
  await ownerDb.execute(
    sql`update treatment_budget_item set billing_mode = 'session', sessions_planned = 12 where budget_id = ${budget.id}`,
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  // Paga S/ 500 por adelantado y se le devuelven S/ 100.
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 50000,
      payments: [{ paymentMethodId: cash.id, amountCents: 50000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) => refundCredit(tx, ...f.args, { branchId, amountCents: 10000, reason: "Pagó de más" }))
  const caja = (await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))).byCurrency.find((c) => c.currency === "PEN")
  const portal = (await f.run((tx) => getPatientAccount(tx, "org_a", f.patient.id))).byCurrency.find((c) => c.currency === "PEN")
  expect(portal?.agreedCents).toBe(12 * 120000)
  expect(portal).toMatchObject({ pagado: 40000, aFavor: 40000, porCobrar: 0, saldo: 0 })
  expect(portal).toMatchObject({ pagado: caja?.pagado, aFavor: caja?.aFavor, porCobrar: caja?.porCobrar, saldo: caja?.saldo })
})

it("el saldo descuenta lo que tiene a favor, y «Aplicar» cancela la deuda con un movimiento registrado", async () => {
  const f = await clinicalFixture()
  const { cash } = await seedMethods(f)
  const branchId = await seedBranch(f)
  await f.run((tx) => createCharge(tx, ...f.args, { description: "Resina", amountCents: 10000 }))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 6000,
      payments: [{ paymentMethodId: cash.id, amountCents: 6000 }],
      requestId: randomUUID(),
    }),
  )
  const before = (await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))).byCurrency[0]
  // «Debe: S/ 100 · A favor: S/ 60 · Saldo: S/ 40».
  expect(before).toMatchObject({ porCobrar: 10000, aFavor: 6000, saldo: 4000 })
  // Aplicar lo que tiene a favor: el mismo cobro de caja, sin dinero nuevo.
  const applied = await f.run((tx) => collectCharge(tx, ...f.args, { branchId, requestId: randomUUID() }))
  expect(applied.creditAppliedCents).toBe(6000)
  // No alcanza: lo que falta.
  expect(applied.remainingCents).toBe(4000)
  expect(applied.ticket).toMatchObject({ totalCents: 0, creditAppliedCents: 6000 })
  expect(applied.account.byCurrency[0]).toMatchObject({ porCobrar: 4000, aFavor: 0, saldo: 4000 })
  // Lo registrado se ve en sus cobros.
  expect(applied.account.cobros.some((row) => row.ticketId === applied.ticket.id)).toBe(true)
})
