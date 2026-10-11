import { expect, it } from "vitest"
import {
  adjustBudgetLines,
  createBudget,
  decideBudget,
  deliverBudget,
  getBudgetDetail,
} from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import {
  createPromotion,
  endPromotion,
  getPromotionMetrics,
  listPromotions,
  requirePromotionPrice,
  updatePromotion,
} from "./promotions.js"
import { setupTestDb } from "./test-setup.js"
setupTestDb()

const DAY = 24 * 60 * 60 * 1000

async function promoFixture(mode: "fixed" | "from" = "fixed") {
  const f = await clinicalFixture()
  const now = Date.now()
  const promo = await f.run((tx) =>
    createPromotion(tx, f.args[0], f.args[1], {
      name: mode === "fixed" ? "Limpieza octubre" : "Implante desde",
      startsAt: new Date(now - DAY).toISOString(),
      endsAt: new Date(now + 30 * DAY).toISOString(),
      conditions: "Solo octubre",
      items: [
        {
          serviceId: f.service.id,
          mode,
          priceCents: mode === "fixed" ? 79000 : 150000,
        },
      ],
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

it("el precio fijo se aplica opt-in y el snapshot sobrevive a cambios", async () => {
  const { f, promo, item, budget } = await promoFixture("fixed")
  const adjusted = await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, {
      lines: [{ planItemId: item.id, promotionId: promo.id }],
    }),
  )
  const line = adjusted.items.find((l) => l.planItemId === item.id)
  expect(line?.priceCents).toBe(79000)
  expect(line?.tariffPriceCents).toBe(120000)
  expect(line?.promotionName).toBe("Limpieza octubre")
  expect(line?.promotionMode).toBe("fixed")
  expect(adjusted.discountCents).toBe(41000)
  // Cambiar la promoción vale desde ahora: lo cotizado no se reescribe.
  await f.run((tx) =>
    updatePromotion(tx, f.args[0], f.args[1], promo.id, {
      items: [{ serviceId: f.service.id, mode: "fixed", priceCents: 69000 }],
    }),
  )
  const detail = await f.run((tx) => getBudgetDetail(tx, f.args[0], f.patient.id, budget.id))
  expect(detail.items.find((l) => l.planItemId === item.id)?.priceCents).toBe(79000)
  // Métricas: una vez usada tras decidir.
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  const metrics = await f.run((tx) => getPromotionMetrics(tx, "org_a", promo.id))
  expect(metrics.uses).toBe(1)
})

it("el precio «desde» exige el final y el motivo bajo el mínimo", async () => {
  const { f, promo, item, budget } = await promoFixture("from")
  await expect(
    f.run((tx) => requirePromotionPrice(tx, "org_a", promo.id, f.service.id)),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  const snapshot = await f.run((tx) =>
    requirePromotionPrice(tx, "org_a", promo.id, f.service.id, 180000),
  )
  expect(snapshot).toMatchObject({ mode: "from", priceCents: 180000, floorCents: 150000 })
  // Bajo el mínimo anunciado sin motivo: se rechaza; con motivo pasa.
  await expect(
    f.run((tx) =>
      adjustBudgetLines(tx, ...f.args, budget.id, {
        lines: [{ planItemId: item.id, promotionId: promo.id, promotionFinalPriceCents: 140000 }],
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  const adjusted = await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, budget.id, {
      lines: [
        {
          planItemId: item.id,
          promotionId: promo.id,
          promotionFinalPriceCents: 140000,
          reason: "Caso social",
        },
      ],
    }),
  )
  expect(adjusted.items.find((l) => l.planItemId === item.id)?.priceCents).toBe(140000)
})

it("la vencida deja de ofrecerse y lo cobrado no cambia", async () => {
  const f = await clinicalFixture()
  const now = Date.now()
  const promo = await f.run((tx) =>
    createPromotion(tx, f.args[0], f.args[1], {
      name: "Madre mayo",
      startsAt: new Date(now - 60 * DAY).toISOString(),
      endsAt: new Date(now - 30 * DAY).toISOString(),
      items: [{ serviceId: f.service.id, mode: "fixed", priceCents: 38000 }],
    }),
  )
  const vigentes = await f.run((tx) => listPromotions(tx, "org_a", { vigentesOnly: true }))
  expect(vigentes.some((p) => p.id === promo.id)).toBe(false)
  const todas = await f.run((tx) => listPromotions(tx, "org_a", {}))
  expect(todas.some((p) => p.id === promo.id)).toBe(true)
  await expect(
    f.run((tx) => requirePromotionPrice(tx, "org_a", promo.id, f.service.id, 38000)),
  ).rejects.toMatchObject({ code: "PROMOTION_NOT_LIVE" })
  const live = await f.run((tx) =>
    createPromotion(tx, f.args[0], f.args[1], {
      name: "Temporal",
      startsAt: new Date(now - DAY).toISOString(),
      endsAt: new Date(now + 30 * DAY).toISOString(),
      items: [{ serviceId: f.service.id, mode: "fixed", priceCents: 100000 }],
    }),
  )
  await f.run((tx) => endPromotion(tx, f.args[0], f.args[1], live.id))
  const after = await f.run((tx) => listPromotions(tx, "org_a", { vigentesOnly: true }))
  expect(after.some((p) => p.id === live.id)).toBe(false)
})

it("caja usa la misma regla de precio promocional", async () => {
  const { f, promo } = await promoFixture("fixed")
  const snapshot = await f.run((tx) =>
    requirePromotionPrice(tx, "org_a", promo.id, f.service.id),
  )
  expect(snapshot.priceCents).toBe(79000)
})
