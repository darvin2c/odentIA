/**
 * El gasto rediseñado (ADR 0167; QA de Gastos del 8 nov, entrega 2):
 * - guarda con qué se pagó (el medio de la clínica, congelado) y solo el efectivo sale de la caja;
 * - el comprobante es el tipo del país (SUNAT en el Perú) y lleva a quién se pagó;
 * - «Corregir» anula y registra en una operación, y la lista muestra el nuevo con lo de antes;
 * - «Anotar lo que se repite» no paga, y «Pagar» propone el medio de siempre.
 */
import { randomUUID } from "node:crypto"
import { cashMovement, expense } from "@odentia/db/schema/finance"
import { branch } from "@odentia/db/schema/org"
import { and, eq, isNull } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { endRecurringExpense, getRecurringMonth, noteRecurringExpense, payRecurringOccurrence } from "./expense-recurring.js"
import { addCashMovement, correctExpense, createExpense, getMonthExpenses } from "./finance.js"
import { createPaymentMethod } from "./payment-methods.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function seedBranch(): Promise<string> {
  const [row] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede rediseño ${randomUUID()}` }).returning()
  return row!.id
}

function thisMonth() {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1
  return { year, month, key: `${year}-${String(month).padStart(2, "0")}` }
}

async function setup() {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Efectivo ${randomUUID()}`, typeCode: "10" }))
  const yape = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Yape ${randomUUID()}`, typeCode: "68" }))
  await f.run((tx) => addCashMovement(tx, "org_a", f.actor, { branchId, kind: "aporte", amountCents: 50_000, concept: "Fondo" }))
  return { f, branchId, cash, yape }
}

const cashOut = (expenseId: string) =>
  ownerDb
    .select({ amountCents: cashMovement.amountCents, direction: cashMovement.direction })
    .from(cashMovement)
    .where(and(eq(cashMovement.expenseId, expenseId), isNull(cashMovement.voidedAt)))

it("el gasto guarda con qué se pagó: solo el efectivo sale de la caja, y Yape lleva su n.º de operación", async () => {
  const { f, branchId, cash, yape } = await setup()
  const inCash = await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Materiales",
      concept: "Algodón de la farmacia",
      amountCents: 4_200,
      currency: "PEN",
      paymentMethodId: cash.id,
      receiptType: "03",
      receiptNumber: "B001-2345",
    }),
  )
  expect(inCash).toMatchObject({ methodTypeCode: "10", receiptType: "03", receiptKind: "Boleta de venta", paymentReference: null })
  expect(inCash.shiftId).not.toBeNull()
  expect(await cashOut(inCash.id)).toEqual([{ amountCents: 4_200, direction: "egreso" }])

  // Yape no toca la caja aunque llegue `fromCash`: manda el medio.
  const byYape = await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Servicios",
      concept: "Luz",
      amountCents: 28_000,
      currency: "PEN",
      fromCash: true,
      paymentMethodId: yape.id,
      paymentReference: "123456",
      receiptType: "14",
      supplierName: "Luz del Sur",
      supplierTaxId: "20331898008",
    }),
  )
  expect(byYape).toMatchObject({
    shiftId: null,
    methodName: yape.name,
    paymentReference: "123456",
    receiptKind: "Recibo de servicios públicos",
    supplierName: "Luz del Sur",
    supplierTaxId: "20331898008",
  })
  expect(await cashOut(byYape.id)).toEqual([])
  // Un comprobante que no es del país no pasa.
  await expect(
    f.run((tx) =>
      createExpense(tx, "org_a", f.actor, { branchId, concept: "Otro", amountCents: 100, currency: "PEN", receiptType: "99" }),
    ),
  ).rejects.toMatchObject({ fields: { receiptType: expect.any(String) } })
  // La búsqueda encuentra por el comprobante y por el n.º de operación.
  const found = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...thisMonth(), branchId, q: "servicios públicos" }))
  expect(found.expenses.map((row) => row.id)).toEqual([byYape.id])
  const byOperation = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...thisMonth(), branchId, q: "123456" }))
  expect(byOperation.expenses.map((row) => row.id)).toEqual([byYape.id])
})

it("corregir anula y registra en una operación: la caja cuenta la diferencia y la lista muestra uno, con lo de antes", async () => {
  const { f, branchId, cash, yape } = await setup()
  const wrong = await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Materiales",
      concept: "Algodón",
      amountCents: 2_400,
      currency: "PEN",
      paymentMethodId: cash.id,
    }),
  )
  const body = {
    branchId,
    category: "Materiales",
    concept: "Algodón",
    amountCents: 4_200,
    currency: "PEN",
    paymentMethodId: cash.id,
    requestId: randomUUID(),
  }
  const right = await f.run((tx) => correctExpense(tx, "org_a", f.actor, wrong.id, body))
  expect(right).toMatchObject({ amountCents: 4_200, replacesExpenseId: wrong.id })
  const [old] = await ownerDb.select().from(expense).where(eq(expense.id, wrong.id))
  expect(old?.voidedAt).not.toBeNull()
  expect(old?.voidReason).toMatch(/^Corregido: S\/\s24\.00 → S\/\s42\.00$/)
  // Lo que salió vuelve y sale lo nuevo: la caja cuenta 18 de más, no 42.
  expect(await cashOut(wrong.id)).toEqual([])
  expect(await cashOut(right.id)).toEqual([{ amountCents: 4_200, direction: "egreso" }])
  // El reintento devuelve la misma corrección.
  expect((await f.run((tx) => correctExpense(tx, "org_a", f.actor, wrong.id, body))).id).toBe(right.id)

  // La lista muestra el nuevo, con lo de antes; el corregido no va aparte.
  const month = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...thisMonth(), branchId }))
  expect(month.expenses.map((row) => row.id)).toEqual([right.id])
  expect(month.expenses[0]?.replaced).toMatchObject({ amountCents: 2_400, reason: expect.stringMatching(/^Corregido: S\/\s24/) })
  expect(month.totalCents).toBe(4_200)

  // Cambiar de efectivo a Yape: lo que salió de la caja vuelve entero.
  const byYape = await f.run((tx) =>
    correctExpense(tx, "org_a", f.actor, right.id, { ...body, requestId: randomUUID(), paymentMethodId: yape.id }),
  )
  expect(byYape.shiftId).toBeNull()
  expect(await cashOut(right.id)).toEqual([])
  const [second] = await ownerDb.select().from(expense).where(eq(expense.id, right.id))
  expect(second?.voidReason).toBe(`Corregido: ${cash.name} → ${yape.name}`)
  // Lo anulado no se corrige.
  await expect(f.run((tx) => correctExpense(tx, "org_a", f.actor, wrong.id, { ...body, requestId: randomUUID() }))).rejects.toMatchObject({
    code: "EXPENSE_VOIDED",
  })
})

it("anotar lo que se repite no paga; empieza en lo que aún no vence y «Pagar» propone el medio de siempre", async () => {
  const { f, branchId, yape } = await setup()
  const current = thisMonth()
  // Hoy es el día 15: con el día 1 ya pasó este mes y empieza el que viene; con el 28, este.
  const at15 = new Date(Date.UTC(current.year, current.month - 1, 15, 17))
  const next = current.month === 12 ? `${current.year + 1}-01` : `${current.year}-${String(current.month + 1).padStart(2, "0")}`
  const rent = await f.run((tx) =>
    noteRecurringExpense(
      tx,
      "org_a",
      f.actor,
      { branchId, category: "Alquiler", concept: "Alquiler", amountCents: 300_000, currency: "PEN", everyMonths: 1, day: 1, paymentMethodId: yape.id },
      undefined,
      at15,
    ),
  )
  expect(rent).toMatchObject({ firstMonth: next, paymentMethodId: yape.id, fromCash: false })
  const light = await f.run((tx) =>
    noteRecurringExpense(
      tx,
      "org_a",
      f.actor,
      { branchId, category: "Servicios", concept: "Luz", amountCents: 25_000, currency: "PEN", everyMonths: 1, day: 28 },
      undefined,
      at15,
    ),
  )
  expect(light.firstMonth).toBe(current.key)
  const spent = await ownerDb.select({ id: expense.id }).from(expense).where(eq(expense.recurringId, light.id))
  expect(spent).toEqual([])

  // Pagar el alquiler (cuando toque) propone Yape: no sale de la caja.
  const month = await f.run((tx) => getRecurringMonth(tx, "org_a", { ...current, branchId }))
  expect(month.templates.find((row) => row.id === rent.id)).toMatchObject({ paymentMethodId: yape.id })
  const paid = await f.run((tx) =>
    payRecurringOccurrence(tx, "org_a", f.actor, light.id, { month: current.key, amountCents: 28_000, paymentMethodId: yape.id, paymentReference: "777" }),
  )
  expect(paid).toMatchObject({ amountCents: 28_000, shiftId: null, paymentReference: "777", recurringMonth: current.key })
})

it("la fila de sueldos que ve caja no dice a quién, con qué ni lo de antes, aunque el pago lo diga (ADR 0166)", async () => {
  const { f, branchId, yape } = await setup()
  const admin = { seesPeople: true }
  const paid = await f.run((tx) =>
    createExpense(
      tx,
      "org_a",
      f.actor,
      {
        branchId,
        category: "Personal",
        concept: "Honorarios de Ana Pérez",
        amountCents: 150_000,
        currency: "PEN",
        paymentMethodId: yape.id,
        paymentReference: "777111",
        receiptType: "02",
        supplierName: "Ana Pérez",
        supplierTaxId: "10456789012",
      },
      {},
      admin,
    ),
  )
  await f.run((tx) =>
    correctExpense(tx, "org_a", f.actor, paid.id, {
      branchId,
      category: "Personal",
      concept: "Honorarios de Ana Pérez",
      amountCents: 160_000,
      currency: "PEN",
      paymentMethodId: yape.id,
    }, { seesPeople: true }),
  )
  const cashier = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...thisMonth(), branchId }))
  const row = cashier.expenses.find((item) => item.category === "Personal")
  expect(row).toMatchObject({
    concept: "Pago de sueldos",
    supplierName: null,
    supplierTaxId: null,
    paymentReference: null,
    methodName: null,
    replaced: null,
    replacesExpenseId: null,
  })
  expect(JSON.stringify(cashier)).not.toContain("Ana")
  // Buscar el nombre no la encuentra: la fila junta ya no lo lleva.
  const found = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...thisMonth(), branchId, q: "Ana" }))
  expect(found.expenses).toEqual([])
})

it("corregir un pago del IGV a otro tipo deja de ser el impuesto de lo cobrado", async () => {
  const { f, branchId, yape } = await setup()
  const igv = await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Impuestos",
      concept: "IGV",
      amountCents: 10_000,
      currency: "PEN",
      salesTax: true,
      paymentMethodId: yape.id,
    }),
  )
  const fixed = await f.run((tx) =>
    correctExpense(tx, "org_a", f.actor, igv.id, {
      branchId,
      category: "Otros",
      concept: "Arbitrios",
      amountCents: 10_000,
      currency: "PEN",
      paymentMethodId: yape.id,
    }),
  )
  expect(fixed).toMatchObject({ category: "Otros", salesTax: false })
})

it("dejar de repetir una deuda anotada hoy no la borra; lo anotado por error y sin vencer, sí (G3)", async () => {
  const { f, branchId } = await setup()
  const current = thisMonth()
  const previous = current.month === 1 ? `${current.year - 1}-12` : `${current.year}-${String(current.month - 1).padStart(2, "0")}`
  // Se anota hoy el alquiler del mes pasado, que no se pagó: es una deuda.
  const debt = await f.run((tx) =>
    noteRecurringExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Alquiler",
      concept: "Alquiler adeudado",
      amountCents: 200_000,
      currency: "PEN",
      everyMonths: 1,
      day: 1,
      firstMonth: previous,
    }),
  )
  const ended = await f.run((tx) => endRecurringExpense(tx, "org_a", f.actor, debt.id))
  expect(ended.stillDue).toContain(previous)
})

it("lo de antes de un sueldo corregido a otro tipo no se le dice a caja (ADR 0166)", async () => {
  const { f, branchId, yape } = await setup()
  const admin = { seesPeople: true }
  const salary = await f.run((tx) =>
    createExpense(
      tx,
      "org_a",
      f.actor,
      { branchId, category: "Personal", concept: "Sueldo de la asistente", amountCents: 2_000, currency: "PEN", paymentMethodId: yape.id },
      {},
      admin,
    ),
  )
  await f.run((tx) =>
    correctExpense(
      tx,
      "org_a",
      f.actor,
      salary.id,
      { branchId, category: "Otros", concept: "Taxi", amountCents: 2_000, currency: "PEN", paymentMethodId: yape.id },
      admin,
    ),
  )
  const cashier = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...thisMonth(), branchId }))
  expect(cashier.expenses.find((row) => row.concept === "Taxi")?.replaced).toBeNull()
  expect(JSON.stringify(cashier)).not.toContain("asistente")
})
