/**
 * Lo que la QA de Gastos del 8 nov encontró en el servidor (entrega 1):
 * - S1: lo que se le paga al personal lo ve quien administra comisiones; los demás, «Sueldos» en una
 *   sola fila, sin nombres, y no lo anotan, pagan ni anulan (ADR 0166).
 * - G2: reintentar el mismo formulario después de un corte devuelve lo mismo (ADR 0018).
 * - G12: el pago del impuesto de lo cobrado no suma en «Gastado» (ADR 0083).
 */
import { randomUUID } from "node:crypto"
import { member } from "@odentia/db/schema/auth"
import { cashMovement, expense } from "@odentia/db/schema/finance"
import { branch } from "@odentia/db/schema/org"
import { and, eq, isNull } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  getRecurringMonth,
  payRecurringOccurrence,
  registerRecurringExpense,
} from "./expense-recurring.js"
import { addCashMovement, createExpense, getMonthExpenses, voidExpense } from "./finance.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

/** Quien administra comisiones (`commissions.write`). */
const ADMIN = { seesPeople: true }

async function seedBranch(): Promise<string> {
  const [row] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede gastos ${randomUUID()}` })
    .returning()
  return row!.id
}

function thisMonth() {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1
  return { year, month, key: `${year}-${String(month).padStart(2, "0")}` }
}

it("caja ve los sueldos en una sola fila, sin nombres, y no los anota, paga ni anula (S1)", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const current = thisMonth()
  await ownerDb
    .insert(member)
    .values({
      id: randomUUID(),
      organizationId: "org_a",
      userId: f.actor,
      role: "clinician",
      createdAt: new Date(),
    })
    .onConflictDoNothing()
  const salary = (
    concept: string,
    memberUserId: string | null,
    amountCents: number,
    viewer = ADMIN,
  ) =>
    f.run((tx) =>
      registerRecurringExpense(
        tx,
        "org_a",
        f.actor,
        {
          branchId,
          category: "Personal",
          concept,
          amountCents,
          currency: "PEN",
          fromCash: false,
          repeat: {
            everyMonths: 1,
            day: 28,
            month: current.key,
            paid: false,
            ...(memberUserId ? { memberUserId } : {}),
          },
        },
        viewer,
      ),
    )
  const doctor = await salary("Sueldo base", f.actor, 90_000)
  // El nombre también puede ir en el concepto: un sueldo sin persona tampoco se le muestra a caja.
  await salary("Sueldo de Rosa", null, 120_000)
  await f.run((tx) =>
    registerRecurringExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Alquiler",
      concept: "Alquiler",
      amountCents: 300_000,
      currency: "PEN",
      fromCash: false,
      repeat: { everyMonths: 1, day: 1, month: current.key, paid: false },
    }),
  )

  // Caja: una fila «Sueldos» con el total, sin persona; el alquiler, como siempre.
  const cashier = await f.run((tx) => getRecurringMonth(tx, "org_a", { ...current, branchId }))
  expect(cashier.due.filter((row) => row.category === "Personal")).toEqual([
    expect.objectContaining({
      concept: "Sueldos",
      memberUserId: null,
      memberName: null,
      amountCents: 210_000,
      group: 2,
    }),
  ])
  expect(JSON.stringify(cashier)).not.toContain("Rosa")
  expect(cashier.templates.filter((row) => row.category === "Personal")).toEqual([
    expect.objectContaining({ concept: "Sueldos", memberName: null, group: 2 }),
  ])
  expect(cashier.due.find((row) => row.concept === "Alquiler")).toMatchObject({ group: null })

  // Quien administra comisiones ve cada uno, con su persona.
  const admin = await f.run((tx) =>
    getRecurringMonth(tx, "org_a", { ...current, branchId }, new Date(), ADMIN),
  )
  expect(
    admin.due
      .filter((row) => row.category === "Personal")
      .map((row) => row.concept)
      .sort(),
  ).toEqual(["Sueldo base", "Sueldo de Rosa"])

  // Caja no anota, paga ni anula lo del personal: lo frena el servidor, no solo la pantalla.
  await expect(salary("Sueldo nuevo", null, 1_000, { seesPeople: false })).rejects.toMatchObject({
    code: "FORBIDDEN",
  })
  await expect(
    f.run((tx) =>
      payRecurringOccurrence(tx, "org_a", f.actor, doctor.recurring.id, { month: current.key }),
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" })
  const paid = await f.run((tx) =>
    payRecurringOccurrence(
      tx,
      "org_a",
      f.actor,
      doctor.recurring.id,
      { month: current.key },
      ADMIN,
    ),
  )
  await expect(
    f.run((tx) => voidExpense(tx, "org_a", f.actor, paid.id, { reason: "Prueba" })),
  ).rejects.toMatchObject({
    code: "FORBIDDEN",
  })

  // En la lista del mes, caja ve «Pago de sueldos» con el total y sin a quién; quien administra, el gasto.
  const list = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...current, branchId }))
  expect(list.expenses.find((item) => item.category === "Personal")).toMatchObject({
    concept: "Pago de sueldos",
    amountCents: 90_000,
    salary: true,
    recurringId: null,
  })
  const seen = await f.run((tx) =>
    getMonthExpenses(tx, "org_a", { ...current, branchId }, { seesCommissions: true }),
  )
  expect(seen.expenses.find((item) => item.id === paid.id)).toMatchObject({
    concept: "Sueldo base",
  })
})

it("reintentar el mismo formulario después de un corte no registra otro gasto ni saca el efectivo dos veces (G2)", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const fund = randomUUID()
  const first = await f.run((tx) =>
    addCashMovement(tx, "org_a", f.actor, {
      branchId,
      kind: "aporte",
      amountCents: 10_000,
      concept: "Fondo",
      requestId: fund,
    }),
  )
  const again = await f.run((tx) =>
    addCashMovement(tx, "org_a", f.actor, {
      branchId,
      kind: "aporte",
      amountCents: 10_000,
      concept: "Fondo",
      requestId: fund,
    }),
  )
  expect(again.id).toBe(first.id)

  const key = randomUUID()
  const body = {
    branchId,
    category: "Otros",
    concept: "Taxi al banco",
    amountCents: 2_500,
    currency: "PEN",
    fromCash: true,
    requestId: key,
  }
  const spent = await f.run((tx) => createExpense(tx, "org_a", f.actor, body))
  const retried = await f.run((tx) => createExpense(tx, "org_a", f.actor, body))
  expect(retried.id).toBe(spent.id)
  expect(
    await ownerDb.select({ id: expense.id }).from(expense).where(eq(expense.requestId, key)),
  ).toHaveLength(1)
  const out = await ownerDb
    .select({ id: cashMovement.id })
    .from(cashMovement)
    .where(and(eq(cashMovement.expenseId, spent.id), isNull(cashMovement.voidedAt)))
  expect(out).toHaveLength(1)
  // La misma clave con otro gasto es un error: la clave es de un solo formulario.
  await expect(
    f.run((tx) => createExpense(tx, "org_a", f.actor, { ...body, amountCents: 3_000 })),
  ).rejects.toMatchObject({
    code: "REQUEST_ID_CONFLICT",
  })
})

it("el pago del impuesto de lo cobrado está en la lista y no suma en «Gastado» (G12)", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const current = thisMonth()
  await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Impuestos",
      concept: "IGV de octubre",
      amountCents: 180_000,
      currency: "PEN",
      salesTax: true,
    }),
  )
  await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Impuestos",
      concept: "Arbitrios",
      amountCents: 20_000,
      currency: "PEN",
    }),
  )
  const month = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...current, branchId }))
  expect(month.totalCents).toBe(20_000)
  expect(month.salesTaxCents).toBe(180_000)
  expect(month.byCategory).toEqual([{ category: "Impuestos", cents: 20_000 }])
  expect(month.expenses.map((row) => row.concept).sort()).toEqual(["Arbitrios", "IGV de octubre"])
})
