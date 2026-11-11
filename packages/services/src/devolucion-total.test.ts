/**
 * Una devolución total no deja el tratamiento otra vez por cobrar (ADR 0068;
 * auditoría de estados del 11 nov, decisión del usuario): la siguiente atención
 * no lo cobra sola, el cierre dice «se devolvió todo» y la caja lo cobra a mano
 * si corresponde. Un adelanto devuelto sí se cobra al atender.
 */
import { randomUUID } from "node:crypto"
import { encounter, patientCharge, serviceCatalog } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { and, eq, isNull } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter } from "./encounters.js"
import { createPaymentMethod } from "./payment-methods.js"
import {
  acceptedTreatmentTotals,
  collectCharge,
  createCharge,
  getAccountSummary,
  returnFromTicket,
  wholeReturnedCharges,
} from "./payments.js"
import { addPlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Un tratamiento aceptado (S/ 1,200 por tratamiento, o S/ 150 por sesión), con efectivo y una sede. */
async function acceptedTreatment(mode: "treatment" | "session" = "treatment", sessions?: number) {
  const f = await clinicalFixture()
  if (mode === "session")
    await ownerDb.update(serviceCatalog).set({ billingMode: "session", priceCents: 15_000 }).where(eq(serviceCatalog.id, f.service.id))
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const [sede] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede devolución ${randomUUID()}` })
    .returning()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
      ...(sessions ? { plannedSessions: sessions } : {}),
    }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  return { f, cash, branchId: sede!.id, item, line: budget.items[0]! }
}

/** Firma una atención nueva con una sesión del tratamiento y devuelve sus líneas de cobro. */
async function signVisit(f: Fixture, planItemId: string, encounterId?: string, answer: { addSessionPlanItemIds?: string[] } = {}) {
  let id = encounterId
  if (!id) {
    const [row] = await ownerDb
      .insert(encounter)
      .values({ organizationId: "org_a", patientId: f.patient.id, professionalUserId: f.actor, reason: "Control" })
      .returning({ id: encounter.id })
    id = row!.id
  }
  await f.ready(id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, id, { planItemId }))
  return f.run((tx) => finalizeEncounter(tx, ...f.args, id, answer))
}

/** Cobra un concepto entero en efectivo. */
async function collect(f: Fixture, cashId: string, branchId: string, chargeId: string, amountCents: number) {
  return f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [chargeId],
      payments: [{ paymentMethodId: cashId, amountCents }],
      requestId: randomUUID(),
    }),
  )
}

/** Devuelve un importe de un concepto del ticket, pagándolo en efectivo. */
async function giveBack(f: Fixture, cashId: string, branchId: string, ticketId: string, chargeId: string, amountCents: number) {
  return f.run((tx) =>
    returnFromTicket(tx, ...f.args, ticketId, {
      branchId,
      lines: [{ chargeId, amountCents }],
      paymentMethodId: cashId,
      reason: "Reclamo de la paciente",
      requestId: randomUUID(),
    }),
  )
}

it("por tratamiento: devuelto todo, la siguiente atención no lo cobra otra vez y la cuenta dice lo devuelto", async () => {
  // Una ortodoncia de tres sesiones, que se cobra entera en la primera.
  const { f, cash, branchId, item, line } = await acceptedTreatment("treatment", 3)
  const first = await signVisit(f, item.id, f.encounter.id)
  const charge = first.charges[0]!
  expect(charge.amountCents).toBe(120_000)
  const paid = await collect(f, cash.id, branchId, charge.id, 120_000)
  await giveBack(f, cash.id, branchId, paid.ticket.id, charge.id, 120_000)

  // Meses después vuelve por el mismo tratamiento: el cierre lo dice y no carga nada.
  const again = await signVisit(f, item.id)
  expect(again.charges).toEqual([])
  expect(again.billing.lines.map((row) => [row.status, row.reason])).toEqual([["skipped", "returned"]])

  // En Caja, la línea del presupuesto tampoco vuelve a cargarse sola: se cobra como otro concepto.
  await expect(f.run((tx) => createCharge(tx, ...f.args, { budgetItemId: line.id }))).rejects.toMatchObject({
    code: "CHARGE_EXCEEDS_BUDGET",
    message: expect.stringContaining("se devolvió todo"),
  })
  const account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.pendiente).toEqual([])
  expect(account.conCargo).toContain(item.id)
  const [totals] = await f.run((tx) => acceptedTreatmentTotals(tx, "org_a", f.patient.id))
  expect(totals).toMatchObject({ agreedCents: 120_000, paidCents: 0, remainingCents: 0, returnedCents: 120_000, discountCents: 0 })
  expect(totals?.lines[0]?.toChargeCents).toBe(0)
})

it("devuelto en dos veces cuenta una sola vez lo cobrado", async () => {
  const { f, cash, branchId, item } = await acceptedTreatment("treatment", 3)
  const charge = (await signVisit(f, item.id, f.encounter.id)).charges[0]!
  const paid = await collect(f, cash.id, branchId, charge.id, 120_000)
  await giveBack(f, cash.id, branchId, paid.ticket.id, charge.id, 20_000)
  // Lo que queda (S/ 1,000) es otro concepto con lo devuelto anotado: aún no está devuelto entero.
  expect(await f.run((tx) => wholeReturnedCharges(tx, "org_a", f.patient.id, [item.id]))).toEqual([])
  const [rest] = await ownerDb
    .select({ id: patientCharge.id, amountCents: patientCharge.amountCents, returnedCents: patientCharge.returnedCents })
    .from(patientCharge)
    .where(and(eq(patientCharge.originalChargeId, charge.id), isNull(patientCharge.voidedAt)))
  expect(rest).toMatchObject({ amountCents: 100_000, returnedCents: 20_000 })
  await giveBack(f, cash.id, branchId, paid.ticket.id, rest!.id, 100_000)
  const whole = await f.run((tx) => wholeReturnedCharges(tx, "org_a", f.patient.id, [item.id]))
  expect(whole).toEqual([expect.objectContaining({ planItemId: item.id, chargedCents: 120_000, returnedCents: 120_000 })])

  const again = await signVisit(f, item.id)
  expect(again.charges).toEqual([])
  const [totals] = await f.run((tx) => acceptedTreatmentTotals(tx, "org_a", f.patient.id))
  expect(totals).toMatchObject({ remainingCents: 0, returnedCents: 120_000 })
})

it("un adelanto devuelto no cuenta como cobrado: al atender se cobra el tratamiento", async () => {
  const { f, cash, branchId, item, line } = await acceptedTreatment()
  const paid = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 30_000,
      advanceForBudgetItemId: line.id,
      payments: [{ paymentMethodId: cash.id, amountCents: 30_000 }],
      requestId: randomUUID(),
    }),
  )
  const advanceId = (paid.ticket.snapshot as { lines: Array<{ chargeId: string }> }).lines[0]!.chargeId
  await giveBack(f, cash.id, branchId, paid.ticket.id, advanceId, 30_000)
  expect(await f.run((tx) => wholeReturnedCharges(tx, "org_a", f.patient.id, [item.id]))).toEqual([])
  const done = await signVisit(f, item.id, f.encounter.id)
  expect(done.charges.map((row) => row.amountCents)).toEqual([120_000])
})

it("por sesión: la visita devuelta entera cuenta para el tope y no deja otra por cobrar", async () => {
  const { f, cash, branchId, item } = await acceptedTreatment("session", 2)
  const one = await signVisit(f, item.id, f.encounter.id)
  const paid = await collect(f, cash.id, branchId, one.charges[0]!.id, 15_000)
  await giveBack(f, cash.id, branchId, paid.ticket.id, one.charges[0]!.id, 15_000)
  // En la segunda «Falta otra sesión»: la tercera va más allá de las dos acordadas.
  const two = await signVisit(f, item.id, undefined, { addSessionPlanItemIds: [item.id] })
  expect(two.charges.map((row) => row.amountCents)).toEqual([15_000])
  // La tercera ya no se cobra sola: la primera se cobró y se devolvió, y las acordadas eran dos.
  const three = await signVisit(f, item.id)
  expect(three.charges).toEqual([])
  expect(three.billing.lines.map((row) => row.reason)).toEqual(["returned"])
})
