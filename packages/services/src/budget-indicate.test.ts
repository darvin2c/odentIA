/**
 * El presupuesto que se ve es el que queda (QA del 16 nov, E3, casos B1 del banco): lo que se
 * indica con un borrador a la vista entra ya en él, con la misma operación que al firmar; lo de
 * otra pieza va en todas las opciones, y lo de una pieza con caminos espera a que se diga en cuál.
 */
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { expect, it } from "vitest"
import { placeBudgetPath } from "./budget-paths.js"
import {
  type BudgetWithTotals,
  createBudget,
  decideBudget,
  deliverBudget,
  findDraftBudget,
  getBudgetDetail,
} from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { budgetLine, getPlanNextSteps } from "./plan-next.js"
import { addPlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function setup() {
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
  const draft = async () => {
    const row = await f.run((tx) => findDraftBudget(tx, "org_a", f.patient.id))
    return row ? f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, row.id)) : null
  }
  return { f, service, indicate, draft }
}

const totals = (budget: BudgetWithTotals | null) =>
  [...(budget?.options ?? [])].sort((a, b) => a.position - b.position).map((option) => option.totalCents)

it("B1: con las opciones A y B de la 36 armadas, la resina 24 indicada después entra en las dos (A S/ 2,030 y B S/ 630)", async () => {
  const { f, service, indicate, draft } = await setup()
  const endo = await indicate((await service("Endodoncia", 65000)).id, 36)
  await indicate((await service("Corona cerámica", 90000)).id, 36)
  const exo = await indicate((await service("Exodoncia", 15000)).id, 36)
  await indicate((await service("Resina", 18000)).id, 15)
  await indicate((await service("Profilaxis", 12000, "general")).id, null)
  await f.run((tx) => placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: exo.id, path: "nuevo" }))
  expect(totals(await draft())).toEqual([185000, 45000])

  const resina24 = await indicate((await service("Resina distal", 18000)).id, 24)
  expect(resina24.budgetId).not.toBeNull()
  expect(totals(await draft())).toEqual([203000, 63000])

  // Un perno en la 36, que ya tiene caminos, no entra solo en las dos: se pregunta a qué opción va.
  const perno = await indicate((await service("Perno", 30000)).id, 36)
  expect(perno.budgetId).toBeNull()
  expect(totals(await draft())).toEqual([203000, 63000])
  await f.run((tx) => placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: perno.id, path: 1 }))
  expect(totals(await draft())).toEqual([233000, 63000])
  expect(endo.id).toBeTruthy()
})

it("B1d: sin opciones, con un borrador de ayer sin enviar, lo indicado hoy entra al total; ya entregado, no entra y nace al firmar aparte", async () => {
  const { f, service, indicate, draft } = await setup()
  const corona = await indicate((await service("Corona", 90000)).id, 46)
  await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [corona.id] }))
  expect(totals(await draft())).toEqual([90000])
  const resina = await indicate((await service("Resina", 18000)).id, 24)
  expect(resina.budgetId).not.toBeNull()
  expect(totals(await draft())).toEqual([108000])

  // Recepción lo entrega en plena consulta: lo siguiente ya no entra en él.
  const sent = (await draft())!
  await f.run((tx) => deliverBudget(tx, ...f.args, sent.id))
  const sellante = await indicate((await service("Sellante", 5000)).id, 16)
  expect(sellante.budgetId).toBeNull()
  const after = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, sent.id))
  expect(after.totalCents).toBe(108000)
  expect(await draft()).toBeNull()
})

it("B1c: elige A, acepta la endodoncia y lo común y «lo piensa» la corona: la línea dice lo aceptado y lo que piensa, y sigue esperando respuesta", async () => {
  const { f, service, indicate, draft } = await setup()
  const endo = await indicate((await service("Endodoncia", 65000)).id, 36)
  const corona = await indicate((await service("Corona cerámica", 90000)).id, 36)
  const exo = await indicate((await service("Exodoncia", 15000)).id, 36)
  const resina = await indicate((await service("Resina", 18000)).id, 15)
  const limpieza = await indicate((await service("Profilaxis", 12000, "general")).id, null)
  await f.run((tx) => placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: exo.id, path: "nuevo" }))
  const built = (await draft())!
  await f.run((tx) => deliverBudget(tx, ...f.args, built.id))
  const optionA = [...built.options].sort((a, b) => a.position - b.position)[0]!
  const answered = await f.run((tx) =>
    decideBudget(tx, ...f.args, built.id, {
      optionId: optionA.id,
      decisions: [
        { planItemId: endo.id, decision: "aceptado" },
        { planItemId: resina.id, decision: "aceptado" },
        { planItemId: limpieza.id, decision: "aceptado" },
        { planItemId: corona.id, decision: "pospuesto" },
      ],
    }),
  )
  const spaced = (text: string) => text.replace(/ /g, " ")
  expect(spaced(budgetLine(answered, "es-PE"))).toBe(
    "Eligió la opción A · aceptó S/ 950.00 · lo piensa: Corona cerámica · S/ 900.00",
  )
  // Sigue esperando respuesta (Sofi y Argos no la cuentan como aceptada), con la misma palabra.
  expect(answered.awaitsAnswer).toBe(true)
  const { steps } = await f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, () => true))
  const waiting = steps.find((step) => step.kind === "respuesta")
  expect(waiting).toMatchObject({ text: "Lo piensa" })
  expect(spaced(waiting?.detail ?? "")).toContain("Corona cerámica · S/ 900.00")
})
