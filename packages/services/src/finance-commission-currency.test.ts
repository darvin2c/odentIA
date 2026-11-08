/**
 * La comisión en la moneda de lo cobrado (ADR 0155): lo cobrado en dólares da su comisión en
 * dólares, que se paga en dólares y aparte; un descuento solo baja lo de su moneda; lo que el
 * profesional le debe a la clínica se ve aunque no tenga cobros nuevos. El monto fijo va en la
 * moneda del servicio y nunca paga más de lo cobrado, y lo cobrado por adelantado de un
 * tratamiento es de quien haga cada sesión.
 */
import { randomUUID } from "node:crypto"
import { encounter, encounterProcedure, serviceCatalog } from "@odentia/db/schema/clinical"
import { expense } from "@odentia/db/schema/finance"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter } from "./encounters.js"
import { twoCurrencyClinic } from "./exam-two-currencies.js"
import {
  getMonthlyCommissions,
  listMonthCommissions,
  payMonthCommission,
  setCommissionException,
  setCommissionRate,
  unassignedCommissionSessions,
} from "./finance.js"
import { createPaymentMethod } from "./payment-methods.js"
import { collectCharge, createCharge, voidTicket } from "./payments.js"
import { addPlanItem } from "./plan.js"
import { commissionsMany, commissionsOwedMany } from "./report-finance.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

function currentPeriod(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get("year"), month: get("month") }
}

const wide = () => {
  const now = new Date()
  return { start: new Date(now.getTime() - 40 * 86_400_000), end: new Date(now.getTime() + 86_400_000) }
}

type Clinic = Awaited<ReturnType<typeof twoCurrencyClinic>>

/** Una atención firmada ahora con un servicio ya elegido, y su cargo. */
async function attendService(c: Clinic, patientId: string, serviceId: string, priceCents: number, currency: string) {
  const [session] = await ownerDb
    .insert(encounter)
    .values({ organizationId: c.orgId, patientId, professionalUserId: c.actor, branchId: c.branchId, reason: "Consulta" })
    .returning()
  const [procedure] = await ownerDb
    .insert(encounterProcedure)
    .values({ organizationId: c.orgId, encounterId: session!.id, serviceId, description: "Implante", priceCents, currency, createdBy: c.actor })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), signerName: "Dra. Rosa Examen", signerRegistration: "12345" })
    .where(eq(encounter.id, session!.id))
  return c.run((tx) => createCharge(tx, c.orgId, c.actor, patientId, { encounterProcedureId: procedure!.id, branchId: c.branchId }))
}

it("lo cobrado en dólares da su comisión en dólares, que se paga en dólares y aparte de los soles", async () => {
  const c = await twoCurrencyClinic(ownerDb, appDb)
  const patient = await c.person("Lucía Ramos")
  const [implant, resin] = await c.attended(patient, [
    { description: "Implante", priceCents: 100_000, currency: "USD" },
    { description: "Resina", priceCents: 30_000, currency: "PEN" },
  ])
  const usdPaid = await c.collect(patient, { chargeIds: [implant!.id], exchangeRate: "3.75", payments: [{ paymentMethodId: c.cash.id, amountCents: 100_000 }] })
  await c.collect(patient, { chargeIds: [resin!.id], payments: [{ paymentMethodId: c.cash.id, amountCents: 30_000 }] })
  const view = () => c.run((tx) => getMonthlyCommissions(tx, c.orgId, { professionalUserId: c.actor, ...currentPeriod() }))

  // Al 30 %: USD 300 por el implante y S/ 90 por la resina, cada uno en su moneda.
  const before = await view()
  expect(before).toMatchObject({ currency: "PEN", baseCents: 30_000, commissionCents: 9_000, pendingCents: 9_000 })
  expect(before.others).toHaveLength(1)
  expect(before.others[0]).toMatchObject({ currency: "USD", baseCents: 100_000, commissionCents: 30_000, pendingCents: 30_000 })

  // Reportes sigue en soles: el implante vale S/ 3,750 con el cambio de su pago.
  const [month] = await c.run((tx) => commissionsMany(tx, c.orgId, [wide()], { currency: "PEN" }))
  expect(month?.[0]).toMatchObject({ baseCents: 375_000 + 30_000, commissionCents: 112_500 + 9_000 })

  // Se paga cada moneda aparte: el gasto en dólares guarda su valor en soles.
  const paid = await c.run((tx) =>
    payMonthCommission(tx, c.orgId, c.actor, { professionalUserId: c.actor, ...currentPeriod(), branchId: c.branchId, currency: "USD" }),
  )
  expect(paid.settlement).toMatchObject({ currency: "USD", commissionCents: 30_000 })
  const [usdExpense] = await ownerDb.select().from(expense).where(eq(expense.id, paid.expense!.id))
  expect(usdExpense).toMatchObject({ currency: "USD", amountCents: 30_000, businessCents: 112_500 })
  const afterUsd = await view()
  expect(afterUsd.pendingCents).toBe(9_000)
  expect(afterUsd.others[0]).toMatchObject({ currency: "USD", paidCents: 30_000, pendingCents: 0, status: "pagado" })
  // En Reportes, lo de dólares ya no se debe; los soles sí.
  const [owedNow] = await c.run((tx) => commissionsOwedMany(tx, c.orgId, [new Date(Date.now() + 1000)], { currency: "PEN" }))
  expect(owedNow).toEqual({ cents: 9_000, professionals: 1 })

  // Se anula el cobro del implante ya pagado: lo de dólares se descuenta solo en dólares. Los soles
  // siguen por pagar enteros, y la fila dice lo que debe a la clínica.
  await c.run((tx) => voidTicket(tx, c.orgId, c.actor, patient, usdPaid.ticket.id, { reason: "Error", allowPostClose: false }))
  const afterVoid = await view()
  expect(afterVoid).toMatchObject({ currency: "PEN", pendingCents: 9_000, discountCents: 0, owedCents: 0 })
  expect(afterVoid.others[0]).toMatchObject({ currency: "USD", adjustmentCents: 30_000, discountCents: 0, owedCents: 30_000 })
  const rows = await c.run((tx) => listMonthCommissions(tx, c.orgId, currentPeriod()))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ currency: "PEN", pendingCents: 9_000 })
  expect(rows[0]!.others).toMatchObject([{ currency: "USD", owedCents: 30_000 }])
  // Reportes tampoco cruza monedas: lo de soles se sigue debiendo entero.
  const [owedAfter] = await c.run((tx) => commissionsOwedMany(tx, c.orgId, [new Date(Date.now() + 1000)], { currency: "PEN" }))
  expect(owedAfter).toEqual({ cents: 9_000, professionals: 1 })
})

it("el monto fijo va en la moneda del servicio, nunca paga más de lo cobrado y no vale en otra moneda", async () => {
  const c = await twoCurrencyClinic(ownerDb, appDb)
  const patient = await c.person("Bruno Díaz")
  const [usdService] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: c.orgId, name: `Implante ${randomUUID().slice(0, 8)}`, priceCents: 100_000, currency: "USD" })
    .returning()
  // USD 1,500 por cada implante: más que su precio. Se guarda en dólares, la moneda del servicio.
  await c.run((tx) =>
    setCommissionException(tx, c.orgId, c.actor, { professionalUserId: c.actor, serviceId: usdService!.id, fixedCents: 150_000 }),
  )
  const implant = await attendService(c, patient, usdService!.id, 100_000, "USD")
  await c.collect(patient, { chargeIds: [implant.id], exchangeRate: "3.75", payments: [{ paymentMethodId: c.cash.id, amountCents: 100_000 }] })
  const view = await c.run((tx) => getMonthlyCommissions(tx, c.orgId, { professionalUserId: c.actor, ...currentPeriod() }))
  // Nunca más de lo cobrado: USD 1,000, no 1,500.
  expect(view.others[0]!.lines.map((line) => [line.fixedCents, line.commissionCents])).toEqual([[150_000, 100_000]])

  // Un servicio en soles con monto en soles, atendido y cobrado en dólares: el monto no vale en otra
  // moneda (nunca se convierte), así que la línea queda sin regla y no se congela al pagar.
  const [penService] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: c.orgId, name: `Corona ${randomUUID().slice(0, 8)}`, priceCents: 50_000, currency: "PEN" })
    .returning()
  await c.run((tx) =>
    setCommissionException(tx, c.orgId, c.actor, { professionalUserId: c.actor, serviceId: penService!.id, fixedCents: 10_000 }),
  )
  const crown = await attendService(c, patient, penService!.id, 20_000, "USD")
  await c.collect(patient, { chargeIds: [crown.id], exchangeRate: "3.75", payments: [{ paymentMethodId: c.cash.id, amountCents: 20_000 }] })
  const mixed = await c.run((tx) => getMonthlyCommissions(tx, c.orgId, { professionalUserId: c.actor, ...currentPeriod() }))
  const crownLine = mixed.others[0]!.lines.find((line) => line.chargeId === crown.id)
  expect(crownLine).toMatchObject({ commissionCents: 0, unruled: true })

  // El servicio pasa a dólares y se escribe el monto de nuevo: vale también para lo atendido antes,
  // que se había quedado sin regla. Lo que no tenía regla nunca quedó sin poder pagarse.
  await ownerDb.update(serviceCatalog).set({ currency: "USD", priceCents: 20_000 }).where(eq(serviceCatalog.id, penService!.id))
  await c.run((tx) =>
    setCommissionException(tx, c.orgId, c.actor, { professionalUserId: c.actor, serviceId: penService!.id, fixedCents: 5_000 }),
  )
  const fixedUp = await c.run((tx) => getMonthlyCommissions(tx, c.orgId, { professionalUserId: c.actor, ...currentPeriod() }))
  const fixedLine = fixedUp.others[0]!.lines.find((line) => line.chargeId === crown.id)
  expect(fixedLine).toMatchObject({ fixedCents: 5_000, commissionCents: 5_000 })
  expect(fixedLine?.unruled).toBeUndefined()
})

it("lo adelantado de un servicio que se cobra por sesión no comisiona: comisiona el cobro de cada visita", async () => {
  const f = await clinicalFixture()
  await f.run((tx) =>
    tx.execute(sql`update "service_catalog" set "price_cents" = 15000, "billing_mode" = 'session' where "id" = ${f.service.id}`),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: 4 }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  const prepaid = await f.run((tx) => createCharge(tx, ...f.args, { budgetItemId: budget.items[0]!.id }))
  expect(prepaid.commissionSessions).toBeNull()
})

it("lo cobrado por adelantado de un tratamiento es de quien haga cada sesión; mientras tanto se ve aparte", async () => {
  const f = await clinicalFixture()
  await f.run((tx) =>
    tx.execute(sql`update "service_catalog" set "price_cents" = 80000, "billing_mode" = 'treatment' where "id" = ${f.service.id}`),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: 2 }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 1000 }))

  // Se cobra todo antes de la primera sesión: el cargo lleva sus 2 sesiones.
  const prepaid = await f.run((tx) => createCharge(tx, ...f.args, { budgetItemId: budget.items[0]!.id }))
  expect(prepaid).toMatchObject({ amountCents: 80000, commissionSessions: 2, encounterProcedureId: null })
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}` }).returning()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId: site!.id, chargeIds: [prepaid.id], payments: [{ paymentMethodId: cash.id, amountCents: 80000 }], requestId: randomUUID() }),
  )
  const view = () => f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...currentPeriod() }))
  // Aún no es de nadie, y la lista lo dice aparte.
  expect((await view()).lines).toEqual([])
  expect(await f.run((tx) => unassignedCommissionSessions(tx, "org_a"))).toEqual([{ currency: "PEN", pendingCents: 80000, stoppedCents: 0 }])

  // La sesión 1: la mitad es de quien la hizo, con su regla; el cobro ya cubre el tratamiento.
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  await f.ready(f.encounter.id)
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(closed.charges).toHaveLength(0)
  expect((await view()).lines.map((line) => [line.slice, line.sessions, line.baseCents, line.commissionCents])).toEqual([[1, 2, 40000, 4000]])
  expect(await f.run((tx) => unassignedCommissionSessions(tx, "org_a"))).toEqual([{ currency: "PEN", pendingCents: 40000, stoppedCents: 0 }])
})
