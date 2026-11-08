/**
 * Corregir el precio en Cobrar (QA de comisiones, estudio del precio):
 * - Un descuento sobre el cargo de un tratamiento de varias sesiones no se deshace al
 *   firmar la sesión siguiente: el sistema no vuelve a cobrar la diferencia.
 * - Una promoción de precio fijo es por unidad: con 3 resinas, el cargo es 3 veces su precio.
 */
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture, readyToClose } from "./clinical-test-fixture.js"
import { addEncounterProcedure, createEncounter, finalizeEncounter } from "./encounters.js"
import { createCharge, updateCharge } from "./payments.js"
import { addPlanItem } from "./plan.js"
import { createPromotion } from "./promotions.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("un descuento al cargo de un tratamiento de 2 sesiones no se vuelve a cobrar en la segunda", async () => {
  const f = await clinicalFixture()
  await f.run((tx) =>
    tx.execute(sql`update "service_catalog" set "price_cents" = 100000, "billing_mode" = 'treatment' where "id" = ${f.service.id}`),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: 2 }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  await f.ready(f.encounter.id)
  const first = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const charge = first.charges[0]!
  expect(charge.amountCents).toBe(100000)

  // En Cobrar se le hace un descuento antes de que pague.
  await f.run((tx) => updateCharge(tx, ...f.args, charge.id, { amountCents: 80000, reason: "Descuento acordado" }))

  // La sesión 2 no genera otro cargo por los 200 del descuento.
  const second = await f.run((tx) => createEncounter(tx, ...f.args, { reason: "Segunda sesión" }))
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, second.id, { planItemId: item.id }))
  await readyToClose("org_a", f.actor, f.patient.id, second.id)
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, second.id))
  expect(closed.charges).toEqual([])
  const charges = await ownerDb.execute<{ amount: number }>(
    sql`select amount_cents as amount from patient_charge where plan_item_id = ${item.id} and voided_at is null`,
  )
  expect(charges.map((row) => Number(row.amount))).toEqual([80000])
})

it("una promoción de precio fijo es por unidad: 3 resinas en promoción son 3 veces su precio", async () => {
  const f = await clinicalFixture()
  await f.run((tx) => tx.execute(sql`update "service_catalog" set "price_cents" = 15000 where "id" = ${f.service.id}`))
  const promo = await f.run((tx) =>
    createPromotion(tx, "org_a", f.actor, {
      name: "Resinas de noviembre",
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      items: [{ serviceId: f.service.id, mode: "fixed", priceCents: 10000 }],
    }),
  )
  const procedure = await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id, quantity: 3 }))
  expect(procedure.priceCents).toBe(45000)
  // Al cobrar con la promoción.
  const charged = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: procedure.id, promotionId: promo.id }))
  expect(charged.amountCents).toBe(30000)
  // Y al aplicarla después en Cobrar, sobre un cargo sin promoción.
  const plain = await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id, quantity: 3 }),
  )
  const later = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: plain.id }))
  expect(later.amountCents).toBe(45000)
  const applied = await f.run((tx) => updateCharge(tx, ...f.args, later.id, { promotionId: promo.id }))
  expect(applied.amountCents).toBe(30000)
})
