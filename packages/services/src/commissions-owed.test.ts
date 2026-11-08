/**
 * Lo pendiente de comisiones de todos los meses (D-16) y lo atendido aún sin cobrar en
 * «Mis honorarios» (C-3 y C1), de las rondas de QA de comisiones.
 */
import { randomUUID } from "node:crypto"
import { encounter, encounterProcedure } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { user } from "@odentia/db/schema/auth"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { twoCurrencyClinic } from "./exam-two-currencies.js"
import { setCommissionRate } from "./finance.js"
import { createPaymentMethod } from "./payment-methods.js"
import { collectCharge, createCharge } from "./payments.js"
import { commissionsOwedByMonth, myAttendedUnpaid, owedMonthsOf } from "./report-finance.js"
import { currentMonthIn } from "./report-periods.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

// La zona de la clínica de las pruebas (`org_a`, del Perú).
const currentPeriod = () => currentMonthIn("America/Lima")

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

  // Atendido y sin cobrar: 300 por cobrar, sin comisión aún; el servicio y su día, nada más.
  expect(await f.run((tx) => myAttendedUnpaid(tx, "org_a", f.actor, currentPeriod()))).toEqual({
    currencies: [{ currency: "PEN", unpaidCents: 30000 }],
    items: [{ id: procedure!.id, description: "Corona", attendedAt: f.encounter.startedAt.toISOString(), currency: "PEN" }],
  })

  // Se cobran 100: quedan 200 por cobrar y 10 de comisión por pagar este mes.
  await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId: site!.id, chargeIds: [charge.id], payments: [{ paymentMethodId: cash.id, amountCents: 10000 }], requestId: randomUUID() }),
  )
  expect((await f.run((tx) => myAttendedUnpaid(tx, "org_a", f.actor, currentPeriod()))).currencies).toEqual([
    { currency: "PEN", unpaidCents: 20000 },
  ])
  const owed = await f.run((tx) => commissionsOwedByMonth(tx, "org_a"))
  const month = owed.months.find((item) => item.year === currentPeriod().year && item.month === currentPeriod().month)
  expect(month).toMatchObject({ cents: 1000, professionals: 1 })
  expect(owed.owedCents).toBe(1000)
})

it("lo atendido sin cobrar va en cada moneda aparte, sin paciente ni importe, y otro profesional no lo ve", async () => {
  const c = await twoCurrencyClinic(ownerDb, appDb)
  const patient = await c.person("Lucía Ramos")
  const [resin, crown, implant] = await c.attended(patient, [
    { description: "Resina", priceCents: 31_000, currency: "PEN" },
    { description: "Corona", priceCents: 100_000, currency: "PEN" },
    { description: "Implante", priceCents: 24_000, currency: "USD" },
  ])
  // Se cobra la resina entera: sale de la lista.
  await c.collect(patient, { chargeIds: [resin!.id], payments: [{ paymentMethodId: c.cash.id, amountCents: 31_000 }] })
  const period = currentPeriod()
  const mine = await c.run((tx) => myAttendedUnpaid(tx, c.orgId, c.actor, period))
  // Nunca se suman soles y dólares: cada moneda con lo suyo, la del negocio primero.
  expect(mine.currencies).toEqual([
    { currency: "PEN", unpaidCents: 100_000 },
    { currency: "USD", unpaidCents: 24_000 },
  ])
  expect(mine.items.map((item) => [item.description, item.currency])).toEqual([
    ["Corona", "PEN"],
    ["Implante", "USD"],
  ])
  expect(mine.items.map((item) => item.id).sort()).toEqual([crown!.encounterProcedureId, implant!.encounterProcedureId].sort())
  // Solo el servicio, el día y la moneda: ni el paciente ni lo que debe.
  for (const item of mine.items) expect(Object.keys(item).sort()).toEqual(["attendedAt", "currency", "description", "id"])
  expect(JSON.stringify(mine)).not.toContain("Lucía")

  // Otro profesional de la misma clínica no ve lo que atendió ella.
  const other = randomUUID()
  await ownerDb.insert(user).values({ id: other, name: "Dr. Otro", email: `${other}@example.com` })
  expect(await c.run((tx) => myAttendedUnpaid(tx, c.orgId, other, period))).toEqual({ currencies: [], items: [] })
})

it("lo que se descuenta se reparte del mes más antiguo: los meses suman el total", () => {
  // 50 por descontar; 40 nuevos en septiembre y 60 en octubre: septiembre 0, octubre 50.
  const { byMonth, owedCents } = owedMonthsOf(
    [
      { month: "2026-10", userId: "a", cents: 6000 },
      { month: "2026-09", userId: "a", cents: 4000 },
      { month: "2026-10", userId: "b", cents: 1000 },
    ],
    new Map([["a", 5000]]),
  )
  expect(owedCents).toBe(6000)
  expect(Object.fromEntries(byMonth)).toEqual({ "2026-10": { cents: 6000, professionals: 2 } })
  const sum = [...byMonth.values()].reduce((total, month) => total + month.cents, 0)
  expect(sum).toBe(owedCents)
})
