/**
 * Caja automática: se crea al cobrar, el arqueo cuenta solo efectivo, el
 * cierre congela hoja inmutable con diferencia notificada, gastos con salida
 * de caja, deudas por sede y resumen sin contar la apertura como ingreso.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { branch } from "@odentia/db/schema/org"
import { member, user } from "@odentia/db/schema/auth"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  closeCashWindow,
  createExpense,
  getCashState,
  getDayMovements,
  getDebts,
  listExpenses,
} from "./finance.js"
import { getOrgLocale } from "./locale.js"
import { collectCharge, createCharge } from "./payments.js"
import { createPaymentMethod } from "./payment-methods.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

interface Fixture {
  actor: string
  patient: { id: string }
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
}

async function seedCashbox(f: Fixture) {
  const [branchRow] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede caja ${randomUUID()}` })
    .returning()
  const cash = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }),
  )
  const card = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Tarjeta", typeCode: "48" }),
  )
  return { branchId: branchRow.id, cash, card }
}

it("la caja se crea al cobrar y el arqueo cuenta solo efectivo", async () => {
  const f = await clinicalFixture()
  const { branchId, cash, card } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Obturación", amountCents: 30000, currency: "PEN" }),
  )
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [
        { paymentMethodId: cash.id, amountCents: 30000 },
        { paymentMethodId: card.id, amountCents: 10000, reference: "OP-7" },
      ],
      requestId: randomUUID(),
    }),
  )
  const state = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  expect(state.cashOnHandCents).toBe(30000)
  expect(state.byMethod).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "Efectivo", amountCents: 30000 }),
      expect.objectContaining({ name: "Tarjeta", amountCents: 10000 }),
    ]),
  )
  const closed = await f.run((tx) =>
    closeCashWindow(tx, "org_a", f.actor, {
      branchId,
      countedCents: 30000,
      retainedCents: 5000,
      deliveredCents: 25000,
    }),
  )
  expect(closed.differenceCents).toBe(0)
  expect(closed.retainedCents).toBe(5000)
  // La ventana siguiente abre sola con lo que quedó.
  const next = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  expect(next.cashOnHandCents).toBe(5000)
})

it("el gasto con salida de caja descuenta el contado y el directo no", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Consulta", amountCents: 20000, currency: "PEN", branchId }),
  )
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 20000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Materiales",
      concept: "Guantes y mascarillas",
      amountCents: 8550,
      fromCash: true,
    }),
  )
  await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Alquiler",
      concept: "Alquiler del local",
      amountCents: 350000,
    }),
  )
  const state = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  expect(state.cashOnHandCents).toBe(11450)
  const materials = await f.run((tx) =>
    listExpenses(tx, "org_a", { branchId, category: "Materiales" }),
  )
  expect(materials).toHaveLength(1)
})

it("las deudas agrupan por persona y lo que queda no se cuenta como cobro", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Endodoncia", amountCents: 60000, currency: "PEN", branchId }),
  )
  const debts = await f.run((tx) => getDebts(tx, "org_a", { branchId }))
  expect(debts).toHaveLength(1)
  expect(debts[0]).toMatchObject({ totalCents: 60000, chargesCount: 1, currency: "PEN" })
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 60000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    closeCashWindow(tx, "org_a", f.actor, {
      branchId,
      countedCents: 60000,
      retainedCents: 60000,
      deliveredCents: 0,
    }),
  )
  // Lo que quedó abre la ventana nueva como «quedó del cierre anterior», no
  // como un cobro: nada se cuenta dos veces.
  const state = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  expect(state.cashOnHandCents).toBe(60000)
  expect(state.tickets).toBe(0)
  expect(state.breakdown).toMatchObject({ openingCents: 60000, cashCollectedCents: 0 })
  expect(state.lastClosure?.differenceCents).toBe(0)
  // «Hoy» es el día de la clínica, no el de UTC: de noche no coinciden.
  const { timezone } = await f.run((tx) => getOrgLocale(tx, "org_a"))
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date())
  const movements = await f.run((tx) =>
    getDayMovements(tx, "org_a", { branchId, day: today }),
  )
  expect(movements.movements.length).toBeGreaterThan(0)
})

it("la diferencia del cierre avisa a administración", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  const adminId = randomUUID()
  await ownerDb.insert(user).values({ id: adminId, name: "Admin", email: `${adminId}@example.test` })
  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: "org_a",
    userId: adminId,
    role: "admin",
    createdAt: new Date(),
  })
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Control", amountCents: 15000, currency: "PEN" }),
  )
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 15000 }],
      requestId: randomUUID(),
    }),
  )
  const closed = await f.run((tx) =>
    closeCashWindow(tx, "org_a", f.actor, {
      branchId,
      countedCents: 14500,
      retainedCents: 4500,
      deliveredCents: 10000,
    }),
  )
  expect(closed.differenceCents).toBe(-500)
})

it("el egreso nunca deja la caja en negativo", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Apertura", amountCents: 5000, currency: "PEN" }),
  )
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
      requestId: randomUUID(),
    }),
  )
  // Gasto de 8550 con 5000 en caja se rechaza.
  await expect(
    f.run((tx) =>
      createExpense(tx, "org_a", f.actor, {
        branchId,
        category: "Materiales",
        concept: "Guantes",
        amountCents: 8550,
        fromCash: true,
      }),
    ),
  ).rejects.toMatchObject({ code: "INSUFFICIENT_CASH" })
  // El gasto exacto sí pasa y deja la caja en cero.
  await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Materiales",
      concept: "Guantes",
      amountCents: 5000,
      fromCash: true,
    }),
  )
  const state = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  expect(state.cashOnHandCents).toBe(0)
})
