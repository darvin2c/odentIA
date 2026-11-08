/**
 * Lo fijo vencido por sede (QA de comisiones, A6): Reportes dice cuánto falta pagar en cada sede,
 * para que «Pagar en Gastos» lleve a la sede donde está.
 */
import { randomUUID } from "node:crypto"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { fixedOwedAt, registerRecurringExpense } from "./expense-recurring.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("lo fijo vencido se dice también por sede", async () => {
  const f = await clinicalFixture()
  const now = new Date()
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth()
  const lastSpentAt = new Date(Date.UTC(year, month - 1, 5, 17)).toISOString()
  const sites = await ownerDb
    .insert(branch)
    .values([
      { organizationId: "org_a", name: `Miraflores ${randomUUID().slice(0, 6)}` },
      { organizationId: "org_a", name: `San Isidro ${randomUUID().slice(0, 6)}` },
    ])
    .returning()
  // El alquiler de cada sede, pagado el mes pasado: el de este mes vence el 1.
  for (const [site, cents] of [
    [sites[0]!, 500000],
    [sites[1]!, 300000],
  ] as const)
    await f.run((tx) =>
      registerRecurringExpense(tx, "org_a", f.actor, {
        branchId: site.id,
        category: "Alquiler",
        concept: "Alquiler del local",
        amountCents: cents,
        currency: "PEN",
        fromCash: false,
        spentAt: lastSpentAt,
        repeat: { everyMonths: 1, day: 1 },
      }),
    )
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 20, 17))
  const owed = await f.run((tx) => fixedOwedAt(tx, "org_a", at))
  const mine = owed.byBranch.filter((row) => row.branchId === sites[0]!.id || row.branchId === sites[1]!.id)
  expect(mine).toEqual([
    { branchId: sites[0]!.id, branchName: sites[0]!.name, cents: 500000, count: 1 },
    { branchId: sites[1]!.id, branchName: sites[1]!.name, cents: 300000, count: 1 },
  ])
  // En una sede, solo lo suyo.
  expect((await f.run((tx) => fixedOwedAt(tx, "org_a", at, { branchId: sites[1]!.id }))).byBranch).toEqual([
    { branchId: sites[1]!.id, branchName: sites[1]!.name, cents: 300000, count: 1 },
  ])
})
