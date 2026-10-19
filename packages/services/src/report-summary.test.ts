/**
 * Resumen de Reportes: cada cifra es la misma regla que su pestaña, calculada
 * para varios tramos a la vez. Lo neto cobrado es el de Finanzas; la deuda
 * vencida es la del Administrador, contada como estaba en cada momento.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { patientCharge, patientPayment, patientPaymentApplication, patientPaymentRefund } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { addPlanItem } from "./plan.js"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { collectedNetMany, getFinanceTotalsBetween } from "./finance.js"
import { budgetAcceptanceMany, overdueDebtMany } from "./report-summary.js"
import { budgetTotalsMany } from "./reports.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

async function clinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `resumen-${orgId}`)
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro" }).returning()
  const [person] = await insertTestPatients(ownerDb, { organizationId: orgId, displayName: "Rosa", patientNumber: 1 })
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  return { orgId, branchId: site!.id, patientId: person!.id, run }
}

const day = (iso: string): Date => new Date(iso)
const AUGUST = { start: day("2026-08-01T05:00:00Z"), end: day("2026-09-01T05:00:00Z") }
const SEPTEMBER = { start: day("2026-09-01T05:00:00Z"), end: day("2026-10-01T05:00:00Z") }

it("lo cobrado neto de varios tramos es lo mismo que Finanzas, con anulaciones y devoluciones", async () => {
  const c = await clinic()
  const pay = async (paidAt: string, amountCents: number) => {
    const [row] = await ownerDb
      .insert(patientPayment)
      .values({ organizationId: c.orgId, patientId: c.patientId, branchId: c.branchId, amountCents, currency: "PEN", paidAt: day(paidAt), methodName: "Efectivo" })
      .returning()
    return row!
  }
  const august = await pay("2026-08-10T15:00:00Z", 30_000)
  await pay("2026-08-20T15:00:00Z", 10_000)
  const september = await pay("2026-09-12T15:00:00Z", 50_000)
  // En septiembre se anula un cobro de agosto: corrige septiembre, no agosto.
  await ownerDb.update(patientPayment).set({ voidedAt: day("2026-09-05T15:00:00Z"), voidReason: "Error de registro" }).where(eq(patientPayment.id, august.id))
  // Y se devuelve parte de un cobro de septiembre.
  await ownerDb.insert(patientPaymentRefund).values({ organizationId: c.orgId, patientId: c.patientId, paymentId: september.id, amountCents: 5_000, refundedAt: day("2026-09-20T15:00:00Z"), reason: "Devolución" })

  const [sep, aug] = await c.run((tx) => collectedNetMany(tx, c.orgId, [SEPTEMBER, AUGUST]))
  const finance = async (span: { start: Date; end: Date }) => (await c.run((tx) => getFinanceTotalsBetween(tx, c.orgId, span)))[0]?.netoCents
  expect(sep).toEqual([{ currency: "PEN", cents: await finance(SEPTEMBER) }])
  expect(aug).toEqual([{ currency: "PEN", cents: await finance(AUGUST) }])
  // 50 000 − 5 000 de devolución − 30 000 del cobro de agosto anulado.
  expect(sep?.[0]?.cents).toBe(15_000)
})

it("te deben hace más de 30 días: lo que se debía en cada momento, descontado lo que tenía a favor", async () => {
  const c = await clinic()
  const charge = async (createdAt: string, amountCents: number) => {
    const [row] = await ownerDb
      .insert(patientCharge)
      .values({ organizationId: c.orgId, patientId: c.patientId, branchId: c.branchId, description: "Tratamiento", amountCents, currency: "PEN", createdAt: day(createdAt) })
      .returning()
    return row!
  }
  const first = await charge("2026-08-01T15:00:00Z", 50_000)
  await charge("2026-09-25T15:00:00Z", 10_000)
  // Pagó parte el 20 de agosto y dejó 5 000 a favor el 10 de septiembre, sin aplicar.
  const [partial] = await ownerDb
    .insert(patientPayment)
    .values({ organizationId: c.orgId, patientId: c.patientId, branchId: c.branchId, amountCents: 20_000, currency: "PEN", paidAt: day("2026-08-20T15:00:00Z"), methodName: "Efectivo" })
    .returning()
  await ownerDb.insert(patientPaymentApplication).values({ organizationId: c.orgId, patientId: c.patientId, paymentId: partial!.id, chargeId: first.id, amountCents: 20_000, createdAt: day("2026-08-20T15:00:00Z") })
  await ownerDb
    .insert(patientPayment)
    .values({ organizationId: c.orgId, patientId: c.patientId, branchId: c.branchId, amountCents: 5_000, currency: "PEN", paidAt: day("2026-09-10T15:00:00Z"), methodName: "Efectivo" })

  const [midAugust, endSeptember] = await c.run((tx) => overdueDebtMany(tx, c.orgId, undefined, [day("2026-08-15T15:00:00Z"), SEPTEMBER.end]))
  // A mediados de agosto la deuda tenía dos semanas: todavía no está vencida.
  expect(midAugust).toEqual([])
  // Al cerrar septiembre: 30 000 del primero + 10 000 del segundo − 5 000 a favor.
  expect(endSeptember).toEqual([{ currency: "PEN", cents: 35_000, people: 1 }])
  // Otra sede no tiene sus conceptos.
  const [elsewhere] = await ownerDb.insert(branch).values({ organizationId: c.orgId, name: "Norte" }).returning()
  const [other] = await c.run((tx) => overdueDebtMany(tx, c.orgId, elsewhere!.id, [SEPTEMBER.end]))
  expect(other).toEqual([])
})

it("aceptación: un presupuesto aceptado en parte es uno aceptado, aunque sus líneas caigan en dos grupos", async () => {
  const f = await clinicalFixture()
  const items = [
    await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id })),
    await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id })),
  ]
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: items.map((item) => item.id) }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [
        { planItemId: items[0]!.id, decision: "aceptado" },
        { planItemId: items[1]!.id, decision: "pospuesto" },
      ],
    }),
  )
  const presentedAt = await ownerDb.execute<{ presented_at: string }>(sql`select presented_at from treatment_budget where id = ${budget.id}`)
  const at = new Date(presentedAt[0]!.presented_at)
  const span = { start: new Date(at.getTime() - 60_000), end: new Date(at.getTime() + 60_000) }
  const [acceptance] = await f.run((tx) => budgetAcceptanceMany(tx, "org_a", [span]))
  expect(acceptance).toEqual({ presented: 1, accepted: 1 })
  const [groups] = await f.run((tx) => budgetTotalsMany(tx, "org_a", [span]))
  expect(groups?.[0]).toMatchObject({ accepted: { count: 1 }, waiting: { count: 1 } })
})
