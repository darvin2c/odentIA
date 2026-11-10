/**
 * Las reglas de comisión (QA de comisiones, entrega 7; ADR 0151 y 0155): el porcentaje
 * vale desde el cambio por el día de la atención, un servicio puede tener otro
 * porcentaje o un monto fijo por cada uno, y un tratamiento de varias sesiones
 * reparte cada cobro en partes iguales, cada una de quien hizo su sesión.
 * Finanzas, Reportes y Argos dan lo mismo porque leen la misma vista.
 */
import { randomUUID } from "node:crypto"
import { user } from "@odentia/db/schema/auth"
import { encounter, encounterProcedure } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture, makeSigner, readyToClose } from "./clinical-test-fixture.js"
import { addEncounterProcedure, createEncounter, finalizeEncounter } from "./encounters.js"
import {
  commissionRulesOf,
  getMonthlyCommissions,
  listCommissionAgreements,
  listMonthCommissions,
  payMonthCommission,
  setCommissionException,
  setCommissionRate,
} from "./finance.js"
import { createPaymentMethod } from "./payment-methods.js"
import { collectCharge, createCharge, getTicketReturnable, returnFromTicket } from "./payments.js"
import { addPlanItem } from "./plan.js"
import { commissionsMany } from "./report-finance.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

function currentPeriod(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get("year"), month: get("month") }
}

async function seedBranch(): Promise<string> {
  const [row] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede reglas ${randomUUID()}` }).returning()
  return row!.id
}

/** Lo de Reportes del profesional en el mes (la misma cuenta, en SQL). */
async function reportOf(f: Awaited<ReturnType<typeof clinicalFixture>>, userId: string) {
  const year = new Date().getUTCFullYear()
  const rows = await f.run((tx) =>
    commissionsMany(tx, "org_a", [{ start: new Date(Date.UTC(year - 1, 0, 1)), end: new Date(Date.UTC(year + 1, 0, 1)) }], {
      currency: "PEN",
    }),
  )
  return rows[0]!.find((row) => row.userId === userId)
}

it("la regla es la del día de la atención; un servicio puede tener otro porcentaje o un monto fijo por cada uno", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  // Una atención de una corona de 300, finalizada ahora, con su cargo.
  let first = true
  const attend = async () => {
    const encounterId = first
      ? f.encounter.id
      : (await f.run((tx) => createEncounter(tx, ...f.args, { reason: "Otra corona" }))).id
    first = false
    const [procedure] = await ownerDb
      .insert(encounterProcedure)
      .values({ organizationId: "org_a", encounterId, serviceId: f.service.id, description: "Corona", priceCents: 30000, currency: "PEN", createdBy: f.actor })
      .returning()
    await ownerDb
      .update(encounter)
      .set({ status: "finalizada", finalizedAt: new Date(), branchId, signerName: "Clínico", signerRegistration: "12345" })
      .where(eq(encounter.id, encounterId))
    return f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: procedure!.id }))
  }
  const collect = (chargeId: string, cents: number) =>
    f.run((tx) =>
      collectCharge(tx, ...f.args, { branchId, chargeIds: [chargeId], payments: [{ paymentMethodId: cash.id, amountCents: cents }], requestId: randomUUID() }),
    )
  const view = () => f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...currentPeriod() }))

  // Lo cobrado antes de fijar el primer porcentaje también lo usa: la primera versión vale desde siempre.
  const crown = await attend()
  await collect(crown.id, 10000)
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 1000 }))
  expect((await view()).lines.map((line) => line.commissionCents)).toEqual([1000])

  // Cambiar al 20 % vale para lo que se atienda desde ahora: la segunda cuota de la corona ya atendida
  // sigue al 10 %, aunque se cobre después; una corona atendida después va al 20 %.
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 2000 }))
  await collect(crown.id, 10000)
  const later = await attend()
  await collect(later.id, 10000)
  const afterChange = await view()
  expect(afterChange.lines.map((line) => [line.rateBps, line.commissionCents])).toEqual([
    [1000, 1000],
    [1000, 1000],
    [2000, 2000],
  ])
  const rules = await f.run((tx) => commissionRulesOf(tx, "org_a", f.actor))
  expect(rules).toMatchObject({ rateBps: 2000, previousRateBps: 1000 })
  expect(rules.since).not.toBeNull()

  // Otro porcentaje para este servicio, para lo que se atienda desde ahora.
  await f.run((tx) => setCommissionException(tx, "org_a", f.actor, { professionalUserId: f.actor, serviceId: f.service.id, rateBps: 4500 }))
  const third = await attend()
  await collect(third.id, 5000)
  // Un monto fijo de 150 por cada uno, en proporción a lo cobrado: 5 000 de 30 000 es un sexto.
  await f.run((tx) => setCommissionException(tx, "org_a", f.actor, { professionalUserId: f.actor, serviceId: f.service.id, fixedCents: 15000 }))
  const fourth = await attend()
  await collect(fourth.id, 5000)
  const withService = await view()
  expect(withService.lines.slice(3).map((line) => [line.rateBps, line.fixedCents, line.forService, line.commissionCents])).toEqual([
    [4500, null, true, 2250],
    [null, 15000, true, 2500],
  ])
  expect((await f.run((tx) => commissionRulesOf(tx, "org_a", f.actor))).exceptions).toMatchObject([
    { serviceId: f.service.id, rateBps: null, fixedCents: 15000, fixedCurrency: "PEN", serviceCurrency: "PEN" },
  ])
  // Reportes da lo mismo que Finanzas.
  expect((await reportOf(f, f.actor))?.commissionCents).toBe(withService.commissionCents)

  // Al pagar, cada línea congela la regla que usó.
  const paid = await f.run((tx) => payMonthCommission(tx, "org_a", f.actor, { professionalUserId: f.actor, ...currentPeriod(), branchId }))
  expect(paid.settlement.rateBps).toBeNull()
  const settled = await view()
  expect(settled.lines.map((line) => [line.settled, line.rateBps, line.fixedCents, line.commissionCents])).toEqual([
    [true, 1000, null, 1000],
    [true, 1000, null, 1000],
    [true, 2000, null, 2000],
    [true, 4500, null, 2250],
    [true, null, 15000, 2500],
  ])

  // Quitar la excepción vuelve al general desde ahora.
  await f.run((tx) => setCommissionException(tx, "org_a", f.actor, { professionalUserId: f.actor, serviceId: f.service.id }))
  expect((await f.run((tx) => commissionRulesOf(tx, "org_a", f.actor))).exceptions).toEqual([])
})

it("un tratamiento de 3 sesiones reparte cada cobro: cada sesión comisiona a quien la hizo, cuando la hace", async () => {
  const f = await clinicalFixture()
  await f.run((tx) =>
    tx.execute(sql`update "service_catalog" set "price_cents" = 90000, "billing_mode" = 'treatment' where "id" = ${f.service.id}`),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: 3 }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))

  // Sesión 1, de quien abre el tratamiento: el cargo es de todo el tratamiento y congela 3 partes.
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  await f.ready(f.encounter.id)
  const first = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const charge = first.charges[0]!
  expect(charge).toMatchObject({ amountCents: 90000, commissionSessions: 3 })

  // Se cobra todo al empezar.
  const branchId = await seedBranch()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId, chargeIds: [charge.id], payments: [{ paymentMethodId: cash.id, amountCents: 90000 }], requestId: randomUUID() }),
  )
  const other = randomUUID()
  await ownerDb.insert(user).values({ id: other, name: "Otra doctora", email: `${other}@example.test` })
  await makeSigner("org_a", other)
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 1000 }))
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: other, rateBps: 2000 }))
  const of = (userId: string) => f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: userId, ...currentPeriod() }))

  // Solo la sesión hecha comisiona: un tercio para quien la hizo; las otras dos, aún de nadie.
  expect((await of(f.actor)).lines.map((line) => [line.slice, line.sessions, line.baseCents, line.commissionCents])).toEqual([
    [1, 3, 30000, 3000],
  ])
  expect((await of(other)).lines).toEqual([])

  // Se le paga la sesión 1 antes de que se haga la 2.
  await f.run((tx) => payMonthCommission(tx, "org_a", f.actor, { professionalUserId: f.actor, ...currentPeriod(), branchId }))

  // Sesión 2, de otra doctora: su tercio aparece al hacerla, con su porcentaje.
  const second = await f.run((tx) => createEncounter(tx, "org_a", other, f.patient.id, { reason: "Segunda sesión" }))
  await f.run((tx) => addEncounterProcedure(tx, "org_a", other, f.patient.id, second.id, { planItemId: item.id }))
  await readyToClose("org_a", other, f.patient.id, second.id)
  const closed = await f.run((tx) => finalizeEncounter(tx, "org_a", other, f.patient.id, second.id))
  expect(closed.charges).toHaveLength(0)
  const hers = await of(other)
  expect(hers.lines.map((line) => [line.slice, line.sessions, line.baseCents, line.commissionCents, line.settled])).toEqual([
    [2, 3, 30000, 6000, false],
  ])
  // La sesión 1 ya pagada no vuelve a aparecer por pagar.
  const his = await of(f.actor)
  expect(his.lines.map((line) => [line.slice, line.settled])).toEqual([[1, true]])
  expect(his.pendingCents).toBe(0)
  // Reportes reparte igual.
  expect((await reportOf(f, other))?.commissionCents).toBe(6000)
  expect((await reportOf(f, f.actor))?.commissionCents).toBe(3000)
})

it("lo pagado antes del cambio, sin parte, cubre el cobro entero: no se paga dos veces", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const [procedure] = await ownerDb
    .insert(encounterProcedure)
    .values({ organizationId: "org_a", encounterId: f.encounter.id, serviceId: f.service.id, description: "Corona", priceCents: 30000, currency: "PEN", createdBy: f.actor })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), branchId, signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const charge = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: procedure!.id }))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId, chargeIds: [charge.id], payments: [{ paymentMethodId: cash.id, amountCents: 30000 }], requestId: randomUUID() }),
  )
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 1000 }))
  await f.run((tx) => payMonthCommission(tx, "org_a", f.actor, { professionalUserId: f.actor, ...currentPeriod(), branchId }))
  // Si después ese cargo pasara a repartirse en 3 (un dato viejo, o una corrección a mano), la línea
  // pagada sin parte sigue cubriendo las tres.
  await ownerDb.execute(sql`update patient_charge set commission_sessions = 3 where id = ${charge.id}`)
  const view = await f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...currentPeriod() }))
  expect(view.lines.every((line) => line.settled)).toBe(true)
  expect(view.pendingCents).toBe(0)
})

it("lo que queda tras devolver una parte conserva la regla del día de la atención", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const [procedure] = await ownerDb
    .insert(encounterProcedure)
    .values({ organizationId: "org_a", encounterId: f.encounter.id, serviceId: f.service.id, description: "Corona", priceCents: 30000, currency: "PEN", createdBy: f.actor })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), branchId, signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const charge = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: procedure!.id }))
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 3000 }))
  const paid = await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId, chargeIds: [charge.id], payments: [{ paymentMethodId: cash.id, amountCents: 30000 }], requestId: randomUUID() }),
  )
  // Después baja al 20 %, y se devuelven 10 000: lo que queda (20 000) sigue al 30 % de su día.
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 2000 }))
  const { lines } = await f.run((tx) => getTicketReturnable(tx, "org_a", f.patient.id, paid.ticket.id))
  await f.run((tx) =>
    returnFromTicket(tx, "org_a", f.actor, f.patient.id, paid.ticket.id, {
      branchId,
      lines: [{ chargeId: lines[0]!.chargeId, amountCents: 10000 }],
      paymentMethodId: cash.id,
      reason: "Reclamo",
      requestId: randomUUID(),
    }),
  )
  const view = await f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...currentPeriod() }))
  expect(view.lines.map((line) => [line.rateBps, line.baseCents, line.commissionCents])).toEqual([[3000, 20000, 6000]])
})

it("un mes ya cerrado dice las reglas con que terminó, no las de hoy", async () => {
  const f = await clinicalFixture()
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 1000 }))
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 2000 }))
  const now = currentPeriod()
  const last = now.month === 1 ? { year: now.year - 1, month: 12 } : { year: now.year, month: now.month - 1 }
  const past = await f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...last }))
  const current = await f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...now }))
  expect(past.rateBps).toBe(1000)
  expect(current.rateBps).toBe(2000)
})

it("sin porcentaje general, la primera comisión de un servicio vale también para lo ya cobrado sin pagar", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const [procedure] = await ownerDb
    .insert(encounterProcedure)
    .values({ organizationId: "org_a", encounterId: f.encounter.id, serviceId: f.service.id, description: "Corona", priceCents: 30000, currency: "PEN", createdBy: f.actor })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), branchId, signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const charge = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: procedure!.id }))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId, chargeIds: [charge.id], payments: [{ paymentMethodId: cash.id, amountCents: 10000 }], requestId: randomUUID() }),
  )
  const view = () => f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...currentPeriod() }))
  const agreementOf = async () =>
    (await f.run((tx) => listCommissionAgreements(tx, "org_a"))).find((row) => row.professionalUserId === f.actor)

  // Sin ninguna comisión decidida: el cobro no comisiona todavía, y la persona aparece para fijarla.
  expect((await view()).lines.map((line) => [line.commissionCents, line.unruled])).toEqual([[0, true]])
  expect(await agreementOf()).toMatchObject({ hasRate: false, rateBps: 0, exceptions: [] })

  // Solo por servicio: 150 por cada corona. Es la primera para ese servicio sin porcentaje general,
  // así que vale también para la corona ya cobrada (un tercio de 300: 50).
  await f.run((tx) => setCommissionException(tx, "org_a", f.actor, { professionalUserId: f.actor, serviceId: f.service.id, fixedCents: 15000 }))
  expect((await view()).lines.map((line) => [line.fixedCents, line.forService, line.commissionCents])).toEqual([[15000, true, 5000]])
  // Comisionar solo por servicio decide lo demás: un porcentaje general de 0, desde siempre.
  expect(await agreementOf()).toMatchObject({ hasRate: true, rateBps: 0, exceptions: [{ serviceId: f.service.id, fixedCents: 15000 }] })
  // Un porcentaje que se ponga después ya no es el primero: vale desde ese día, no reabre lo de antes.
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 3000 }))
  expect((await view()).lines.map((line) => line.commissionCents)).toEqual([5000])
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 0 }))

  // Cambiarla después ya no es la primera: vale para lo que se atienda desde ahora.
  await f.run((tx) => setCommissionException(tx, "org_a", f.actor, { professionalUserId: f.actor, serviceId: f.service.id, rateBps: 4500 }))
  expect((await view()).lines.map((line) => line.commissionCents)).toEqual([5000])
})

it("quien no cobra comisión no aparece en el mes; quien aún no la tiene decidida, sí", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const [procedure] = await ownerDb
    .insert(encounterProcedure)
    .values({ organizationId: "org_a", encounterId: f.encounter.id, serviceId: f.service.id, description: "Corona", priceCents: 30000, currency: "PEN", createdBy: f.actor })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), branchId, signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const charge = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: procedure!.id }))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId, chargeIds: [charge.id], payments: [{ paymentMethodId: cash.id, amountCents: 30000 }], requestId: randomUUID() }),
  )
  const row = async () =>
    (await f.run((tx) => listMonthCommissions(tx, "org_a", currentPeriod()))).find((item) => item.professionalUserId === f.actor)

  // Atendió y nadie decidió su comisión: su fila lo dice, para ponerla.
  expect(await row()).toMatchObject({ hasRate: false, exceptionCount: 0, commissionCents: 0, baseCents: 30000 })

  // «No cobra comisión»: un porcentaje de 0, decidido. No tiene nada que pagar en el mes y no se lista.
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 0 }))
  expect(await row()).toBeUndefined()
  expect((await f.run((tx) => listCommissionAgreements(tx, "org_a"))).find((item) => item.professionalUserId === f.actor)).toMatchObject({
    hasRate: true,
    rateBps: 0,
    exceptions: [],
  })
})

it("cada línea dice su servicio, antes y después de pagada: el mismo servicio cobrado con dos textos se junta", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  // La misma corona del catálogo, cobrada con dos textos.
  const procedures = await ownerDb
    .insert(encounterProcedure)
    .values(
      ["Corona", "Corona pieza 2.1"].map((description) => ({
        organizationId: "org_a",
        encounterId: f.encounter.id,
        serviceId: f.service.id,
        description,
        priceCents: 30000,
        currency: "PEN",
        createdBy: f.actor,
      })),
    )
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), branchId, signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const charges: Array<{ id: string }> = []
  for (const procedure of procedures) charges.push(await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: procedure.id })))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: charges.map((charge) => charge.id),
      payments: [{ paymentMethodId: cash.id, amountCents: 60000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) => setCommissionException(tx, "org_a", f.actor, { professionalUserId: f.actor, serviceId: f.service.id, rateBps: 5000 }))
  const services = async () =>
    (await f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...currentPeriod() }))).lines
      .map((line) => [line.description, line.serviceId, line.serviceName, line.settled])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))

  expect(await services()).toEqual([
    ["Corona", f.service.id, f.service.name, false],
    ["Corona pieza 2.1", f.service.id, f.service.name, false],
  ])
  // Pagadas, guardan el cargo y no el servicio: se lee de su procedimiento, como lo hace la vista.
  await f.run((tx) => payMonthCommission(tx, "org_a", f.actor, { professionalUserId: f.actor, ...currentPeriod(), branchId }))
  expect(await services()).toEqual([
    ["Corona", f.service.id, f.service.name, true],
    ["Corona pieza 2.1", f.service.id, f.service.name, true],
  ])
})

it("el historial de una comisión: cada cambio una vez, con quién, lo más nuevo primero", async () => {
  const f = await clinicalFixture()
  const historyOf = async () =>
    (await f.run((tx) => listCommissionAgreements(tx, "org_a"))).find((row) => row.professionalUserId === f.actor)?.history ?? []
  const [actor] = await ownerDb.select({ name: user.name }).from(user).where(eq(user.id, f.actor))
  const by = actor?.name ?? null

  // La primera comisión de un servicio, sin porcentaje general, guarda también el general 0: un solo cambio.
  await f.run((tx) => setCommissionException(tx, "org_a", f.actor, { professionalUserId: f.actor, serviceId: f.service.id, rateBps: 5000 }))
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 3000 }))
  await f.run((tx) => setCommissionException(tx, "org_a", f.actor, { professionalUserId: f.actor, serviceId: f.service.id }))

  const history = await historyOf()
  expect(
    history.map((event) => [
      event.fromStart,
      event.byName,
      event.changes.map((change) => [change.serviceId, change.serviceName, change.rateBps, change.fixedCents]),
    ]),
  ).toEqual([
    [false, by, [[f.service.id, f.service.name, null, null]]],
    [false, by, [[null, null, 3000, null]]],
    [true, by, [[null, null, 0, null], [f.service.id, f.service.name, 5000, null]]],
  ])
  expect(by).not.toBeNull()
  expect(history.map((event) => event.at.getTime())).toEqual(history.map((event) => event.at.getTime()).sort((a, b) => b - a))
})
