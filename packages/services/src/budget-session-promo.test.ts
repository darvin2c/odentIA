/**
 * Presupuesto por sesión y promociones en el tiempo: el total que ve el
 * paciente, lo que se cobra en cada visita y lo acordado que sobrevive a que
 * la promoción termine.
 */
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  adjustBudgetLines,
  createBudget,
  decideBudget,
  deliverBudget,
  getBudgetDetail,
  getBudgetPrintPayload,
} from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter } from "./encounters.js"
import { buildBudgetSnapshot, renderBudgetPdf } from "./financial-document-pdf.js"
import { addPlanItem } from "./plan.js"
import { createPromotion } from "./promotions.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

const DAY = 24 * 60 * 60 * 1000

async function expirePromotion(promotionId: string): Promise<void> {
  await ownerDb.execute(
    sql`update "promotion" set "starts_at" = now() - interval '10 days', "ends_at" = now() - interval '1 day' where "id" = ${promotionId}`,
  )
}

async function sessionBudget(plannedSessions: number, visitCents: number) {
  const f = await clinicalFixture()
  await f.run((tx) =>
    tx.execute(
      sql`update "service_catalog" set "name" = 'Control de ortodoncia', "price_cents" = ${visitCents}, "billing_mode" = 'session' where "id" = ${f.service.id}`,
    ),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
      plannedSessions,
    }),
  )
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  return { f, item, budget }
}

async function promoBudget(mode: "fixed" | "from", promoCents: number) {
  const f = await clinicalFixture()
  const promo = await f.run((tx) =>
    createPromotion(tx, f.args[0], f.args[1], {
      name: "Sonrisa de octubre",
      startsAt: new Date(Date.now() - DAY).toISOString(),
      endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
      conditions: null,
      items: [{ serviceId: f.service.id, mode, priceCents: promoCents }],
    }),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
    }),
  )
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  return { f, promo, item, budget }
}

it("lo que se cobra por sesión se presupuesta por su total y se cobra una visita cada vez", async () => {
  const { f, item, budget } = await sessionBudget(18, 15000)
  // 18 visitas de 150: el paciente ve 2 700, no 150.
  expect(budget.items[0]).toMatchObject({ priceCents: 15000, sessionsPlanned: 18, lineTotalCents: 270000 })
  expect(budget.totalCents).toBe(270000)
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const accepted = await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  expect(accepted.acceptedCents).toBe(270000)

  // La deuda nace visita a visita: la primera atención cobra solo 150.
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  await f.ready(f.encounter.id)
  const first = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(first.charges.map((charge) => charge.amountCents)).toEqual([15000])

  // La hoja lo explica: precio por visita, visitas previstas y total.
  const sheet = await f.run((tx) => getBudgetPrintPayload(tx, f.args[0], f.args[2], budget.id))
  expect(sheet.lines[0]).toMatchObject({ unitCents: 15000, units: 18, totalCents: 270000, billingMode: "session" })
  expect(sheet.totalCents).toBe(270000)
  const snap = await f.run((tx) => buildBudgetSnapshot(tx, f.args[0], f.args[2], budget.id))
  const pdf = await renderBudgetPdf(snap)
  expect(Buffer.from(pdf.slice(0, 5)).toString("latin1")).toBe("%PDF-")
})

it("las visitas previstas se fijan al presupuestar y solo en lo que se cobra por sesión", async () => {
  const { f, item, budget } = await sessionBudget(1, 15000)
  expect(budget.totalCents).toBe(15000)
  const adjusted = await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, { lines: [{ planItemId: item.id, sessionsPlanned: 12 }] }),
  )
  expect(adjusted.items[0]).toMatchObject({ sessionsPlanned: 12, lineTotalCents: 180000 })
  expect(adjusted.totalCents).toBe(180000)

  const other = await promoBudget("fixed", 79000)
  await expect(
    other.f.run((tx) =>
      adjustBudgetLines(tx, ...other.f.args, other.budget.id, {
        lines: [{ planItemId: other.item.id, sessionsPlanned: 3 }],
      }),
    ),
  ).rejects.toThrow(/por sesión/)
})

it("una promoción que terminó no impide cerrar la atención ni cambia lo acordado", async () => {
  const { f, promo, item, budget } = await promoBudget("fixed", 79000)
  await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, { lines: [{ planItemId: item.id, promotionId: promo.id }] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  // El paciente aceptó a tiempo y vuelve cuando la promoción ya terminó.
  await expirePromotion(promo.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  await f.ready(f.encounter.id)
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(closed.charges).toHaveLength(1)
  expect(closed.charges[0]).toMatchObject({ amountCents: 79000, promotionName: "Sonrisa de octubre" })
})

it("un borrador no se entrega con una promoción que ya terminó", async () => {
  const { f, promo, item, budget } = await promoBudget("fixed", 79000)
  await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, { lines: [{ planItemId: item.id, promotionId: promo.id }] }),
  )
  await expirePromotion(promo.id)
  await expect(f.run((tx) => deliverBudget(tx, ...f.args, budget.id))).rejects.toMatchObject({
    code: "PROMOTION_NOT_LIVE",
  })
  // Quitarla devuelve la tarifa, sin pedir motivo, y entonces sí se entrega.
  const restored = await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, { lines: [{ planItemId: item.id, promotionId: null }] }),
  )
  expect(restored.items[0]).toMatchObject({
    promotionId: null,
    promotionName: null,
    priceCents: 120000,
    priceReason: null,
  })
  expect(restored.discountCents).toBe(0)
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const delivered = await f.run((tx) => getBudgetDetail(tx, f.args[0], f.args[2], budget.id))
  expect(delivered.status).toBe("presentado")
})

it("lo acordado por encima de la tarifa se cobra completo al atender", async () => {
  const { f, item, budget } = await promoBudget("fixed", 79000)
  // Sin promoción: se acuerda un precio mayor que la tarifa (120 000).
  await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, { lines: [{ planItemId: item.id, priceCents: 135000 }] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  await f.ready(f.encounter.id)
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(closed.charges.map((charge) => charge.amountCents)).toEqual([135000])
  // La hoja no imprime un «descuento negativo».
  const sheet = await f.run((tx) => getBudgetPrintPayload(tx, f.args[0], f.args[2], budget.id))
  expect(sheet.lines[0]).toMatchObject({ listTotalCents: 135000, totalCents: 135000, discountCents: 0 })
})
