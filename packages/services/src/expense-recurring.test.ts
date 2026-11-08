/**
 * Gastos que se repiten (QA de comisiones, entrega 8): lo que toca cada mes se
 * calcula al leer, se paga con un toque y una sola vez, «este mes no» lo saca, y
 * anular su gasto lo deja otra vez por pagar. El sueldo de una persona va junto a
 * su comisión.
 */
import { randomUUID } from "node:crypto"
import { member } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { dueDayIn, occursIn } from "./expense-recurring-occurrences.js"
import {
  endRecurringExpense,
  fixedOwedAt,
  getRecurringMonth,
  payRecurringOccurrence,
  registerRecurringExpense,
  skipRecurringOccurrence,
  unskipRecurringOccurrence,
  updateRecurringExpense,
} from "./expense-recurring.js"
import { getMonthlyCommissions, voidExpense } from "./finance.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

describe("cuándo toca", () => {
  it("cada mes, cada 6 meses y hasta su fin", () => {
    const monthly = { firstMonth: "2026-01", lastMonth: null, everyMonths: 1 }
    expect(occursIn(monthly, "2025-12")).toBe(false)
    expect(occursIn(monthly, "2026-01")).toBe(true)
    expect(occursIn(monthly, "2026-11")).toBe(true)
    const twice = { firstMonth: "2026-07", lastMonth: null, everyMonths: 6 }
    expect(["2026-07", "2026-12", "2027-01"].map((key) => occursIn(twice, key))).toEqual([true, false, true])
    expect(occursIn({ ...monthly, lastMonth: "2026-05" }, "2026-06")).toBe(false)
  })

  it("el 31 vence el último día de un mes más corto, sin correrse para siempre", () => {
    expect(dueDayIn(31, "2026-02")).toBe(28)
    expect(dueDayIn(31, "2028-02")).toBe(29)
    expect(dueDayIn(31, "2026-03")).toBe(31)
  })
})

function lastMonthOf(now: Date): { year: number; month: number; key: string; spentAt: string } {
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth()
  return { year, month, key: `${year}-${String(month).padStart(2, "0")}`, spentAt: new Date(Date.UTC(year, month - 1, 5, 17)).toISOString() }
}

async function seedBranch(): Promise<string> {
  const [row] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede fijos ${randomUUID()}` }).returning()
  return row!.id
}

it("se anota una vez, toca cada mes, se paga con un toque una sola vez y anular lo deja por pagar", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const now = new Date()
  const before = lastMonthOf(now)
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
  const currentKey = `${current.year}-${String(current.month).padStart(2, "0")}`

  // El alquiler del mes pasado, marcado «Se repite» el día 1: queda pagado ese mes.
  const first = await f.run((tx) =>
    registerRecurringExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Alquiler",
      concept: "Alquiler del local",
      amountCents: 650000,
      currency: "PEN",
      fromCash: false,
      spentAt: before.spentAt,
      repeat: { everyMonths: 1, day: 1 },
    }),
  )
  expect(first.recurring).toMatchObject({ firstMonth: before.key, everyMonths: 1, day: 1 })
  const id = first.recurring.id
  const pastMonth = await f.run((tx) => getRecurringMonth(tx, "org_a", { year: before.year, month: before.month, branchId }))
  expect(pastMonth.fixed).toMatchObject({ totalCents: 650000, paidCents: 650000, dueCents: 0 })

  // Este mes toca otra vez y ya venció (el día 1): está por pagar, con el importe de la vez anterior.
  const month = await f.run((tx) => getRecurringMonth(tx, "org_a", { ...current, branchId }))
  const due = month.due.find((row) => row.recurringId === id)
  expect(due).toMatchObject({ month: currentKey, amountCents: 650000, concept: "Alquiler del local" })
  expect(month.fixed).toMatchObject({ totalCents: 650000, paidCents: 0, dueCents: 650000 })

  // Un toque lo paga; el segundo dice que ya se pagó.
  const paid = await f.run((tx) => payRecurringOccurrence(tx, "org_a", f.actor, id, { month: currentKey }))
  expect(paid).toMatchObject({ amountCents: 650000, recurringId: id, recurringMonth: currentKey })
  await expect(
    f.run((tx) => payRecurringOccurrence(tx, "org_a", f.actor, id, { month: currentKey })),
  ).rejects.toMatchObject({ code: "RECURRING_ALREADY_PAID" })
  expect((await f.run((tx) => getRecurringMonth(tx, "org_a", { ...current, branchId }))).due.some((row) => row.recurringId === id)).toBe(false)

  // Anular ese gasto lo deja otra vez por pagar.
  await f.run((tx) => voidExpense(tx, "org_a", f.actor, paid.id, { reason: "Se pagó dos veces por error" }))
  expect((await f.run((tx) => getRecurringMonth(tx, "org_a", { ...current, branchId }))).due.some((row) => row.recurringId === id)).toBe(true)

  // «No hubo este mes» lo saca, no deja pagarlo, y «Deshacer» lo devuelve.
  await f.run((tx) => skipRecurringOccurrence(tx, "org_a", f.actor, id, { month: currentKey }))
  const skipped = await f.run((tx) => getRecurringMonth(tx, "org_a", { ...current, branchId }))
  expect(skipped.due.some((row) => row.recurringId === id)).toBe(false)
  expect(skipped.fixed.totalCents).toBe(0)
  await expect(
    f.run((tx) => payRecurringOccurrence(tx, "org_a", f.actor, id, { month: currentKey })),
  ).rejects.toMatchObject({ code: "RECURRING_SKIPPED" })
  await f.run((tx) => unskipRecurringOccurrence(tx, "org_a", f.actor, id, { month: currentKey }))
  // Otro importe (la luz cambia): se paga con ese y se propone la próxima vez.
  const other = await f.run((tx) => payRecurringOccurrence(tx, "org_a", f.actor, id, { month: currentKey, amountCents: 700000 }))
  expect(other.amountCents).toBe(700000)
})

it("el sueldo de una persona va junto a su comisión del mes, pagado o no", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const now = new Date()
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
  await ownerDb
    .insert(member)
    .values({ id: randomUUID(), organizationId: "org_a", userId: f.actor, role: "clinician", createdAt: new Date() })
    .onConflictDoNothing()
  // Un sueldo solo puede ser de alguien del equipo y con el tipo Personal.
  await expect(
    f.run((tx) =>
      registerRecurringExpense(tx, "org_a", f.actor, {
        branchId,
        category: "Alquiler",
        concept: "Sueldo",
        amountCents: 300000,
        currency: "PEN",
        fromCash: false,
        repeat: { everyMonths: 1, day: 28, memberUserId: f.actor },
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await f.run((tx) =>
    registerRecurringExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Personal",
      concept: "Sueldo del doctor",
      amountCents: 300000,
      currency: "PEN",
      fromCash: false,
      repeat: { everyMonths: 1, day: 28, memberUserId: f.actor },
    }),
  )
  const view = await f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...current }))
  expect(view.salary).toMatchObject({ cents: 300000, paidCents: 300000, dueCents: 0 })
})

it("el mes que paga, lo que se propone tras un cambio y lo que no se puede cambiar del pasado", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const now = new Date()
  const before = lastMonthOf(now)
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
  const currentKey = `${current.year}-${String(current.month).padStart(2, "0")}`
  const twoBack = before.month === 1 ? `${before.year - 1}-12` : `${before.year}-${String(before.month - 1).padStart(2, "0")}`
  await ownerDb
    .insert(member)
    .values({ id: randomUUID(), organizationId: "org_a", userId: f.actor, role: "clinician", createdAt: new Date() })
    .onConflictDoNothing()
  const salary = (month?: string) =>
    f.run((tx) =>
      registerRecurringExpense(tx, "org_a", f.actor, {
        branchId,
        category: "Personal",
        concept: "Sueldo de recepción",
        amountCents: 250000,
        currency: "PEN",
        fromCash: false,
        repeat: { everyMonths: 1, day: 31, memberUserId: f.actor, ...(month ? { month } : {}) },
      }),
    )
  // Empezar antes del mes anterior dejaría por pagar meses quizá ya pagados como gastos sueltos.
  await expect(salary(twoBack)).rejects.toMatchObject({ code: "VALIDATION" })
  // El sueldo del mes pasado pagado hoy es del mes pasado: este mes queda por pagar.
  const created = await salary(before.key)
  expect(created.recurring.firstMonth).toBe(before.key)
  const id = created.recurring.id
  const due = (await f.run((tx) => getRecurringMonth(tx, "org_a", { ...current, branchId }))).due.find(
    (row) => row.recurringId === id,
  )
  // El día de la plantilla viaja entero: «Cambiar» no lo corre al último del mes.
  expect(due).toMatchObject({ month: currentKey, day: 31 })

  // Se pagó otro importe; cambiar solo el concepto no hace volver al importe de antes.
  await f.run((tx) => voidExpense(tx, "org_a", f.actor, created.expense!.id, { reason: "Prueba" }))
  await f.run((tx) => payRecurringOccurrence(tx, "org_a", f.actor, id, { month: before.key, amountCents: 270000 }))
  await f.run((tx) => updateRecurringExpense(tx, "org_a", f.actor, id, { concept: "Sueldo de recepción (turno mañana)" }))
  const after = (await f.run((tx) => getRecurringMonth(tx, "org_a", { ...current, branchId }))).due.find(
    (row) => row.recurringId === id,
  )
  expect(after).toMatchObject({ amountCents: 270000, concept: "Sueldo de recepción (turno mañana)" })

  // La persona no se cambia y el fin no queda antes de un mes pagado.
  await expect(
    f.run((tx) => updateRecurringExpense(tx, "org_a", f.actor, id, { memberUserId: randomUUID() })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await expect(
    f.run((tx) => updateRecurringExpense(tx, "org_a", f.actor, id, { lastMonth: twoBack })),
  ).rejects.toMatchObject({ code: "VALIDATION" })

  // Dejar de repetir termina en lo último pagado y dice si quedó algo antes sin pagar.
  const ended = await f.run((tx) => endRecurringExpense(tx, "org_a", f.actor, id))
  expect(ended).toMatchObject({ lastMonth: before.key, stillDue: [] })
})

it("se anota sin pagar, y el sueldo que se paga al mes siguiente no vence en su propio mes", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const now = new Date()
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
  const currentKey = `${current.year}-${String(current.month).padStart(2, "0")}`
  const next = current.month === 12 ? { year: current.year + 1, month: 1 } : { year: current.year, month: current.month + 1 }
  const nextKey = `${next.year}-${String(next.month).padStart(2, "0")}`

  // El sueldo de este mes se paga el 2 del siguiente, y aún no se paga: se anota sin ningún gasto.
  const created = await f.run((tx) =>
    registerRecurringExpense(tx, "org_a", f.actor, {
      branchId,
      category: "Personal",
      concept: "Sueldo de recepción",
      amountCents: 300000,
      currency: "PEN",
      fromCash: false,
      repeat: { everyMonths: 1, day: 2, month: currentKey, paid: false, dueNextMonth: true },
    }),
  )
  expect(created.expense).toBeNull()
  expect(created.recurring).toMatchObject({ firstMonth: currentKey, dueNextMonth: true })
  const spent = await ownerDb.execute<{ n: number }>(
    sql`select count(*)::int as n from expense where recurring_id = ${created.recurring.id}`,
  )
  expect(spent[0]?.n).toBe(0)

  // Este mes queda por pagar, pero no vencido: vence el 2 del mes siguiente.
  const month = await f.run((tx) => getRecurringMonth(tx, "org_a", { ...current, branchId }))
  expect(month.due.find((row) => row.recurringId === created.recurring.id)).toMatchObject({
    month: currentKey,
    dueOn: `${nextKey}-02`,
    overdue: false,
  })
  expect(await f.run((tx) => fixedOwedAt(tx, "org_a", now, { branchId }))).toMatchObject({ cents: 0, count: 0 })

  // El 5 del mes siguiente, ya venció y se debe.
  const later = new Date(Date.UTC(next.year, next.month - 1, 5, 17))
  const nextMonth = await f.run((tx) => getRecurringMonth(tx, "org_a", { ...next, branchId }, later))
  expect(nextMonth.due.find((row) => row.month === currentKey && row.recurringId === created.recurring.id)).toMatchObject({
    overdue: true,
  })
  expect(await f.run((tx) => fixedOwedAt(tx, "org_a", later, { branchId }))).toMatchObject({ count: 1 })
})

it("un gasto pagado es el pago de su mes o del anterior, no de uno posterior a su fecha", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const now = new Date()
  const before = lastMonthOf(now)
  const currentKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
  await expect(
    f.run((tx) =>
      registerRecurringExpense(tx, "org_a", f.actor, {
        branchId,
        category: "Servicios",
        concept: "Internet",
        amountCents: 12000,
        currency: "PEN",
        fromCash: false,
        spentAt: before.spentAt,
        repeat: { everyMonths: 1, day: 7, month: currentKey },
      }),
    ),
  ).rejects.toMatchObject({ fields: { "repeat.month": expect.any(String) } })
})
