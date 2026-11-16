/**
 * «Quitar» lo indicado hoy y su «Deshacer» (QA del 16 nov, B1e): lo quitado vuelve a su
 * opción del presupuesto, con su precio y en su orden; la otra opción no cambia ni pasa a
 * «va después» de él.
 */
import { serviceCatalog, treatmentBudget, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { user } from "@odentia/db/schema/auth"
import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { expect, it } from "vitest"
import { placeBudgetPath } from "./budget-paths.js"
import { adjustBudgetLines, type BudgetWithTotals, deliverBudget, findDraftBudget, getBudgetDetail } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { removeIndicatedFromEncounter, restoreRemovedInEncounter } from "./encounter-plan-remove.js"
import { addPlanItem, listPlanItems } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

/** Marta: en la 46, resina (opción A) o exodoncia (opción B), y la limpieza en las dos. */
async function marta() {
  const f = await clinicalFixture()
  const service = async (name: string, priceCents: number, scope = "tooth") =>
    (
      await ownerDb
        .insert(serviceCatalog)
        .values({ organizationId: "org_a", name, scope, source: "custom", priceCents, currency: "PEN" })
        .returning()
    )[0]!
  const indicate = async (serviceId: string, toothNumber: number | null) =>
    f.run((tx) => addPlanItem(tx, ...f.args, { serviceId, sourceEncounterId: f.encounter.id, toothNumber }))
  const resina = await indicate((await service("Resina", 18000)).id, 46)
  const exodoncia = await indicate((await service("Exodoncia", 15000)).id, 46)
  const limpieza = await indicate((await service("Profilaxis", 12000, "general")).id, null)
  await f.run((tx) => placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: exodoncia.id, path: "nuevo" }))
  return { f, resina, exodoncia, limpieza }
}

/** Cada opción con su posición, si es la recomendada, su total y lo que lleva (con su precio). */
function shape(budget: BudgetWithTotals) {
  return [...budget.options]
    .sort((a, b) => a.position - b.position)
    .map((option) => ({
      position: option.position,
      isRecommended: option.isRecommended,
      totalCents: option.totalCents,
      lines: budget.items
        .filter((line) => line.optionId === option.id)
        .map((line) => `${line.planItemId}:${line.priceCents}:${line.priceReason ?? ""}`)
        .sort(),
    }))
}

it("«Deshacer» devuelve la resina a la opción A con su precio acordado, y la exodoncia no «va después» (B1e)", async () => {
  const { f, resina, exodoncia, limpieza } = await marta()
  const draft = (await f.run((tx) => findDraftBudget(tx, "org_a", f.patient.id)))!
  // Un precio acordado en la opción A: «Deshacer» no puede volver con la tarifa.
  const optionA = (await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, draft.id))).options.find(
    (option) => option.position === 1,
  )!
  await f.run((tx) =>
    adjustBudgetLines(tx, ...f.args, draft.id, {
      lines: [{ planItemId: resina.id, optionId: optionA.id, priceCents: 16000, reason: "Precio de la casa" }],
    }),
  )
  const before = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, draft.id))
  expect(shape(before).map((option) => option.totalCents)).toEqual([28000, 27000])

  await f.run((tx) => removeIndicatedFromEncounter(tx, ...f.args, f.encounter.id, resina.id))
  // Sin la resina, A solo tenía la limpieza (lo común): deja de ser una opción.
  const removed = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, draft.id))
  expect(shape(removed).map((option) => option.totalCents)).toEqual([27000])

  await f.run((tx) => restoreRemovedInEncounter(tx, ...f.args, f.encounter.id, resina.id))
  const after = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, draft.id))
  expect(shape(after)).toEqual(shape(before))
  const plan = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))
  const row = (id: string) => plan.find((item) => item.id === id)!
  // El mismo tratamiento, no uno nuevo: vuelve por decidir, en su camino y con su orden.
  expect(plan.filter((item) => item.status !== "cancelado").map((item) => item.id)).toEqual([
    resina.id,
    exodoncia.id,
    limpieza.id,
  ])
  expect(row(resina.id)).toMatchObject({ status: "pendiente", decisionStatus: "pendiente", budgetId: draft.id })
  expect(row(resina.id).path).toMatchObject({ positions: [1], pathCount: 2 })
  expect(row(exodoncia.id).path).toMatchObject({ positions: [2], pathCount: 2 })
  expect(row(exodoncia.id).waitsFor).toBeNull()
  // Dos veces no: ya volvió.
  await expect(
    f.run((tx) => restoreRemovedInEncounter(tx, ...f.args, f.encounter.id, resina.id)),
  ).rejects.toMatchObject({ code: "NOT_RESTORABLE" })
})

it("sin presupuesto vuelve tal cual; con el presupuesto ya entregado no adivina y lo quitado sigue quitado", async () => {
  const f = await clinicalFixture()
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: "org_a", name: "Sellante", scope: "tooth", source: "custom", priceCents: 5000, currency: "PEN" })
    .returning()
  const sellante = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: service!.id, sourceEncounterId: f.encounter.id, toothNumber: 16 }),
  )
  await f.run((tx) => removeIndicatedFromEncounter(tx, ...f.args, f.encounter.id, sellante.id))
  await f.run((tx) => restoreRemovedInEncounter(tx, ...f.args, f.encounter.id, sellante.id))
  const [back] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, sellante.id))
  expect(back).toMatchObject({ status: "pendiente", statusReason: null, budgetId: null })

  // Con dos opciones y el presupuesto entregado entre «Quitar» y «Deshacer».
  const { f: g, resina } = await marta()
  const draft = (await g.run((tx) => findDraftBudget(tx, "org_a", g.patient.id)))!
  await g.run((tx) => removeIndicatedFromEncounter(tx, ...g.args, g.encounter.id, resina.id))
  await g.run((tx) => deliverBudget(tx, ...g.args, draft.id))
  await expect(
    g.run((tx) => restoreRemovedInEncounter(tx, ...g.args, g.encounter.id, resina.id)),
  ).rejects.toMatchObject({ code: "UNDO_BUDGET_GONE" })
  const [still] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, resina.id))
  expect(still).toMatchObject({ status: "cancelado" })
})

// Revisión del 16 nov (R8): se quita la resina y después la exodoncia; «Deshacer» de la resina no
// deja un camino sin nada suyo (B con solo la limpieza común).
it("R8: «Deshacer» en otro orden no deja un camino vacío, y la opción que se fue con otro «Quitar» no vuelve vacía", async () => {
  const { f, resina, exodoncia, limpieza } = await marta()
  const draft = (await f.run((tx) => findDraftBudget(tx, "org_a", f.patient.id)))!
  await f.run((tx) => removeIndicatedFromEncounter(tx, ...f.args, f.encounter.id, resina.id))
  await f.run((tx) => removeIndicatedFromEncounter(tx, ...f.args, f.encounter.id, exodoncia.id))
  await f.run((tx) => restoreRemovedInEncounter(tx, ...f.args, f.encounter.id, resina.id))
  const after = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, draft.id))
  // Sin la exodoncia, B solo tenía lo común: un solo camino, con la resina y la limpieza.
  expect(shape(after).map((option) => option.lines.map((line) => line.split(":")[0]).sort())).toEqual([
    [limpieza.id, resina.id].sort(),
  ])
  expect(after.options).toHaveLength(1)
})

it("R8: al revés (primero la exodoncia, después la resina), «Deshacer» de la exodoncia no resucita la opción A vacía", async () => {
  const { f, resina, exodoncia, limpieza } = await marta()
  const draft = (await f.run((tx) => findDraftBudget(tx, "org_a", f.patient.id)))!
  await f.run((tx) => removeIndicatedFromEncounter(tx, ...f.args, f.encounter.id, exodoncia.id))
  await f.run((tx) => removeIndicatedFromEncounter(tx, ...f.args, f.encounter.id, resina.id))
  await f.run((tx) => restoreRemovedInEncounter(tx, ...f.args, f.encounter.id, exodoncia.id))
  const after = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, draft.id))
  expect(after.options).toHaveLength(1)
  expect(shape(after)[0]!.lines.map((line) => line.split(":")[0]).sort()).toEqual([exodoncia.id, limpieza.id].sort())
})

// Revisión del 16 nov (R9): el borrador de ayer es de otra persona; hoy atiende quien indicó la
// resina. Su «Quitar» y su «Deshacer» funcionan aunque se lleve su única línea.
it("R9: un clínico con el borrador de otra persona puede quitar y deshacer lo suyo", async () => {
  const { f, resina } = await marta()
  const draft = (await f.run((tx) => findDraftBudget(tx, "org_a", f.patient.id)))!
  const other = randomUUID()
  await ownerDb.insert(user).values({ id: other, name: "Otra doctora", email: `${other}@example.test` })
  await ownerDb.update(treatmentBudget).set({ createdBy: other }).where(eq(treatmentBudget.id, draft.id))
  // De lo indicado hoy, solo la resina es de este clínico; lo otro lo indicó la otra doctora.
  await ownerDb
    .update(treatmentPlanItem)
    .set({ createdBy: other })
    .where(eq(treatmentPlanItem.budgetId, draft.id))
  await ownerDb.update(treatmentPlanItem).set({ createdBy: f.args[1] }).where(eq(treatmentPlanItem.id, resina.id))
  const opts = { memberRole: "clinician" }
  await f.run((tx) => removeIndicatedFromEncounter(tx, ...f.args, f.encounter.id, resina.id, opts))
  await f.run((tx) => restoreRemovedInEncounter(tx, ...f.args, f.encounter.id, resina.id, opts))
  const [back] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, resina.id))
  expect(back).toMatchObject({ status: "pendiente", budgetId: draft.id })
})
