/**
 * Los pendientes de Gastos (entrega 3, 9 nov):
 * - el detalle muestra la cadena entera de correcciones, y a caja no le cuenta lo de un sueldo;
 * - la lista del mes se descarga para el contador, con el comprobante, el RUC y con qué se pagó.
 */
import { randomUUID } from "node:crypto"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { expensesMonthCsv } from "./expense-csv.js"
import { addCashMovement, correctExpense, createExpense, getMonthExpenses, voidExpense } from "./finance.js"
import { createPaymentMethod } from "./payment-methods.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

function thisMonth() {
  const now = new Date()
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
}

async function setup() {
  const f = await clinicalFixture()
  const [row] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede Centro ${randomUUID()}` }).returning()
  const branchId = row!.id
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Efectivo ${randomUUID()}`, typeCode: "10" }))
  const yape = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Yape ${randomUUID()}`, typeCode: "68" }))
  await f.run((tx) => addCashMovement(tx, "org_a", f.actor, { branchId, kind: "aporte", amountCents: 50_000, concept: "Fondo" }))
  return { f, branchId, branchName: row!.name, cash, yape }
}

it("el detalle trae la cadena entera de correcciones, de la más reciente a la primera", async () => {
  const { f, branchId, cash } = await setup()
  const body = { branchId, category: "Materiales", concept: "Algodón", currency: "PEN", paymentMethodId: cash.id }
  const first = await f.run((tx) => createExpense(tx, "org_a", f.actor, { ...body, amountCents: 2_400 }))
  const second = await f.run((tx) => correctExpense(tx, "org_a", f.actor, first.id, { ...body, amountCents: 4_200, requestId: randomUUID() }))
  const third = await f.run((tx) =>
    correctExpense(tx, "org_a", f.actor, second.id, { ...body, concept: "Algodón y gasas", amountCents: 4_500, requestId: randomUUID() }),
  )
  const month = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...thisMonth(), branchId }))
  expect(month.expenses.map((row) => row.id)).toEqual([third.id])
  const [row] = month.expenses
  expect(row?.history.map((was) => was.amountCents)).toEqual([4_200, 2_400])
  expect(row?.history[0]?.reason).toMatch(/Algodón y gasas/)
  // «Antes» sigue siendo el inmediato.
  expect(row?.replaced?.amountCents).toBe(4_200)
})

it("a caja la cadena se le corta en el sueldo: ni el sueldo ni el motivo de lo que vino antes (ADR 0166)", async () => {
  const { f, branchId, yape } = await setup()
  const admin = { seesPeople: true }
  const base = { branchId, currency: "PEN", paymentMethodId: yape.id }
  // Taxi → (lo corrige administración a) adelanto de sueldo → útiles de limpieza.
  const taxi = await f.run((tx) => createExpense(tx, "org_a", f.actor, { ...base, category: "Otros", concept: "Taxi", amountCents: 2_000 }))
  const salary = await f.run((tx) =>
    correctExpense(
      tx,
      "org_a",
      f.actor,
      taxi.id,
      { ...base, category: "Personal", concept: "Adelanto de sueldo de la asistente", amountCents: 2_000, requestId: randomUUID() },
      admin,
    ),
  )
  const supplies = await f.run((tx) =>
    correctExpense(
      tx,
      "org_a",
      f.actor,
      salary.id,
      { ...base, category: "Otros", concept: "Útiles de limpieza", amountCents: 2_000, requestId: randomUUID() },
      admin,
    ),
  )
  const cashier = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...thisMonth(), branchId }))
  const row = cashier.expenses.find((item) => item.id === supplies.id)
  expect(row?.history).toEqual([])
  expect(row?.replaced).toBeNull()
  expect(JSON.stringify(cashier)).not.toContain("asistente")
  // Quien administra comisiones ve la cadena entera.
  const owner = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...thisMonth(), branchId }, { seesCommissions: true }))
  expect(owner.expenses.find((item) => item.id === supplies.id)?.history.map((was) => was.concept)).toEqual([
    "Adelanto de sueldo de la asistente",
    "Taxi",
  ])
})

it("la lista del mes se descarga para el contador: comprobante con su código, RUC, medio, operación, sede y estado", async () => {
  const { f, branchId, branchName, cash, yape } = await setup()
  await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Laboratorio",
      concept: "Corona de la 46",
      amountCents: 43_000,
      currency: "PEN",
      paymentMethodId: yape.id,
      paymentReference: "889900",
      receiptType: "01",
      receiptNumber: "F001-123",
      supplierName: "Dental Lab, S.A.C.",
      supplierTaxId: "20100047218",
    }),
  )
  const wrong = await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, { branchId, category: "Otros", concept: "=HYPERLINK(1)", amountCents: 1_500, currency: "PEN", paymentMethodId: cash.id }),
  )
  await f.run((tx) => voidExpense(tx, "org_a", f.actor, wrong.id, { reason: "Era de otra sede" }))

  const file = await f.run((tx) => expensesMonthCsv(tx, "org_a", { ...thisMonth(), branchId }, { seesCommissions: false }))
  const period = `${thisMonth().year}-${String(thisMonth().month).padStart(2, "0")}`
  expect(file.filename).toMatch(new RegExp(`^gastos-sede-centro-.*-${period}\\.csv$`))
  const lines = file.body.replace(/^﻿/, "").trimEnd().split("\r\n")
  expect(lines[0]).toBe(
    "Fecha del pago,Concepto,Tipo,Comprobante,Código del comprobante,Número del comprobante,Proveedor,RUC del proveedor,Con qué se pagó,N.º de operación,Moneda,Importe,Valor en PEN,Sede,Estado,Motivo,Corrige a",
  )
  const lab = lines.find((line) => line.includes("Corona de la 46"))
  expect(lab).toContain(`Laboratorio,Factura,01,F001-123,"Dental Lab, S.A.C.",20100047218,${yape.name},889900,PEN,430.00,430.00,${branchName},Vigente`)
  // Lo anulado va con su estado y su motivo; lo que parece fórmula va como texto.
  const voided = lines.find((line) => line.includes("HYPERLINK"))
  expect(voided).toContain("'=HYPERLINK(1)")
  expect(voided).toContain("Anulado,Era de otra sede")
})

it("caja descarga los sueldos juntos y sin nombres; quien administra comisiones, con de quién es", async () => {
  const { f, branchId, yape } = await setup()
  await f.run((tx) =>
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
      { seesPeople: true },
    ),
  )
  const cashier = await f.run((tx) => expensesMonthCsv(tx, "org_a", { ...thisMonth(), branchId }, { seesCommissions: false }))
  expect(cashier.body).not.toContain("Ana")
  expect(cashier.body).not.toContain("777111")
  expect(cashier.body).not.toContain("De quién es el sueldo")
  expect(cashier.body).toContain("Pago de sueldos,Sueldos,Varios,,,,,Varios,")
  const owner = await f.run((tx) => expensesMonthCsv(tx, "org_a", { ...thisMonth(), branchId }, { seesCommissions: true }))
  expect(owner.body).toContain("De quién es el sueldo")
  expect(owner.body).toContain("Honorarios de Ana Pérez")
  expect(owner.body).toContain("777111")
})

it("lo anulado para convertirlo en sueldo no dice su motivo a caja (ADR 0166)", async () => {
  const { f, branchId, yape } = await setup()
  const base = { branchId, currency: "PEN", paymentMethodId: yape.id }
  const taxi = await f.run((tx) => createExpense(tx, "org_a", f.actor, { ...base, category: "Otros", concept: "Taxi", amountCents: 2_000 }))
  // Administración lo corrige a un sueldo en otro mes: el anulado queda en este, con su motivo.
  const next = new Date()
  next.setUTCMonth(next.getUTCMonth() + 1)
  await f.run((tx) =>
    correctExpense(
      tx,
      "org_a",
      f.actor,
      taxi.id,
      { ...base, category: "Personal", concept: "Adelanto de sueldo de la asistente", amountCents: 150_000, spentAt: next.toISOString(), requestId: randomUUID() },
      { seesPeople: true },
    ),
  )
  const cashier = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...thisMonth(), branchId }))
  const voided = cashier.expenses.find((row) => row.id === taxi.id)
  expect(voided?.voidedAt).not.toBeNull()
  expect(voided?.voidReason).toBeNull()
  expect(JSON.stringify(cashier)).not.toContain("asistente")
  const owner = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...thisMonth(), branchId }, { seesCommissions: true }))
  expect(owner.expenses.find((row) => row.id === taxi.id)?.voidReason).toMatch(/Personal/)
})
