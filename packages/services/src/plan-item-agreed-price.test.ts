/**
 * «Cambiar» un renglón en la atención (la pieza, sus caras, el detalle o el
 * diagnóstico) no toca lo que se acordó por él en el presupuesto en borrador:
 * el precio pactado, su motivo, la promoción y el modo de cobro siguen. Solo
 * cambiar de servicio es otra indicación y vuelve a la tarifa (QA del 8 nov,
 * entrega 3: «Cambiar» volvía a copiar la línea y perdía el precio acordado).
 */
import { encounter, serviceCatalog, treatmentPlan } from "@odentia/db/schema/clinical"
import { expect, it } from "vitest"
import { adjustBudgetLines, createBudget, getBudgetDetail } from "./budgets.js"
import { twoCurrencyClinic } from "./exam-two-currencies.js"
import { addPlanItem, updatePlanItem } from "./plan.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function clinicWithDraft() {
  const c = await twoCurrencyClinic(ownerDb, appDb, { rate: null })
  const patientId = await c.person("Lucía Ramos")
  const [session] = await ownerDb
    .insert(encounter)
    .values({ organizationId: c.orgId, patientId, professionalUserId: c.actor, branchId: c.branchId, reason: "Consulta" })
    .returning()
  const [plan] = await ownerDb
    .insert(treatmentPlan)
    .values({ organizationId: c.orgId, patientId, title: "Plan clínico", originEncounterId: session!.id })
    .returning()
  const service = async (name: string, priceCents: number) => {
    const [created] = await ownerDb
      .insert(serviceCatalog)
      .values({ organizationId: c.orgId, name, scope: "general", source: "custom", priceCents, currency: "PEN" })
      .returning()
    return created!
  }
  const resin = await service("Resina", 30_000)
  const crown = await service("Corona", 90_000)
  const args = [c.orgId, c.actor, patientId] as const
  const item = await c.run((tx) =>
    addPlanItem(tx, ...args, { serviceId: resin.id, planId: plan!.id, sourceEncounterId: session!.id }),
  )
  const draft = await c.run((tx) => createBudget(tx, ...args, { planId: plan!.id, itemIds: [item.id] }))
  // El precio que se le acordó: 250 en vez de 300, con su motivo.
  await c.run((tx) =>
    adjustBudgetLines(tx, ...args, draft.id, {
      lines: [{ planItemId: item.id, priceCents: 25_000, reason: "Paciente frecuente" }],
    }),
  )
  const line = async () =>
    (await c.run((tx) => getBudgetDetail(tx, c.orgId, patientId, draft.id))).items.find(
      (row) => row.planItemId === item.id,
    )!
  return { ...c, args, item, crown, encounterId: session!.id, line }
}

it("cambiar el detalle o el diagnóstico conserva el precio acordado y su motivo", async () => {
  const f = await clinicWithDraft()
  expect(await f.line()).toMatchObject({ priceCents: 25_000, tariffPriceCents: 30_000, priceReason: "Paciente frecuente" })

  await f.run((tx) =>
    updatePlanItem(tx, ...f.args, f.item.id, { encounterId: f.encounterId, detail: "Cara vestibular" }),
  )
  expect(await f.line()).toMatchObject({ priceCents: 25_000, tariffPriceCents: 30_000, priceReason: "Paciente frecuente" })
})

it("cambiar de servicio es otra indicación: vuelve a la tarifa del nuevo y sin el motivo", async () => {
  const f = await clinicWithDraft()
  await f.run((tx) =>
    updatePlanItem(tx, ...f.args, f.item.id, { encounterId: f.encounterId, serviceId: f.crown.id }),
  )
  expect(await f.line()).toMatchObject({ title: "Corona", priceCents: 90_000, tariffPriceCents: 90_000, priceReason: null })
})
