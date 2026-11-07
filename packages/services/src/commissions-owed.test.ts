/**
 * Lo pendiente de comisiones de todos los meses (D-16) y lo atendido aún sin cobrar en
 * «Mis comisiones» (C-3), de la ronda de QA de comisiones.
 */
import { randomUUID } from "node:crypto"
import { encounter, encounterProcedure } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { setCommissionRate } from "./finance.js"
import { createPaymentMethod } from "./payment-methods.js"
import { collectCharge, createCharge } from "./payments.js"
import { commissionsOwedByMonth, myAttendedUnpaid } from "./report-finance.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

function currentPeriod(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get("year"), month: get("month") }
}

it("dice cuánto falta pagar en total y en qué meses, y lo atendido que aún no se cobra", async () => {
  const f = await clinicalFixture()
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede pendiente ${randomUUID()}` }).returning()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const [procedure] = await ownerDb
    .insert(encounterProcedure)
    .values({ organizationId: "org_a", encounterId: f.encounter.id, serviceId: f.service.id, description: "Corona", priceCents: 30000, currency: "PEN", createdBy: f.actor })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), branchId: site!.id, signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const charge = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: procedure!.id }))
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 1000 }))

  // Atendido y sin cobrar: 300 por cobrar, sin comisión aún.
  expect(await f.run((tx) => myAttendedUnpaid(tx, "org_a", f.actor, currentPeriod()))).toEqual({
    attendedCents: 30000,
    unpaidCents: 30000,
  })

  // Se cobran 100: quedan 200 por cobrar y 10 de comisión por pagar este mes.
  await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId: site!.id, chargeIds: [charge.id], payments: [{ paymentMethodId: cash.id, amountCents: 10000 }], requestId: randomUUID() }),
  )
  expect((await f.run((tx) => myAttendedUnpaid(tx, "org_a", f.actor, currentPeriod()))).unpaidCents).toBe(20000)
  const owed = await f.run((tx) => commissionsOwedByMonth(tx, "org_a"))
  const month = owed.months.find((item) => item.year === currentPeriod().year && item.month === currentPeriod().month)
  expect(month?.cents).toBeGreaterThanOrEqual(1000)
  expect(owed.owedCents).toBeGreaterThanOrEqual(1000)
})
