/**
 * Presupuesto con caminos (ADR 0153): «conservar o extraer la 46» se marca en
 * la atención; lo común se responde sin elegir camino; la oportunidad sigue
 * abierta mientras algo espera; la revisión pregunta solo por lo que cambió y
 * no toca el precio de lo hecho; el odontólogo lee el presupuesto de su colega.
 */
import { randomUUID } from "node:crypto"
import { member, user } from "@odentia/db/schema/auth"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { opportunity } from "@odentia/db/schema/opportunities"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { placeBudgetPath } from "./budget-paths.js"
import { previewBudgetSend } from "./budget-send.js"
import {
  adjustBudgetLines,
  decideBudget,
  deliverBudget,
  findDraftBudget,
  getBudgetDetail,
  listBudgets,
  reviseBudget,
} from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure } from "./encounters.js"
import { getPatientAccount } from "./payments.js"
import { addPlanItem, listPlanItems } from "./plan.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { withOrgContext } from "@odentia/db"
setupTestDb()

/** Ana: resina 36 y profilaxis comunes; la 46, conservar (endodoncia y corona) o extraer (exodoncia). */
async function ana() {
  const f = await clinicalFixture()
  const service = async (name: string, priceCents: number, scope = "tooth") =>
    (
      await ownerDb
        .insert(serviceCatalog)
        .values({ organizationId: "org_a", name, scope, source: "custom", priceCents, currency: "PEN" })
        .returning()
    )[0]!
  const indicate = async (serviceId: string, toothNumber: number | null) =>
    f.run((tx) =>
      addPlanItem(tx, ...f.args, { serviceId, sourceEncounterId: f.encounter.id, toothNumber }),
    )
  const resina = await indicate((await service("Resina", 18000)).id, 36)
  const profilaxis = await indicate((await service("Profilaxis", 12000, "general")).id, null)
  const endodoncia = await indicate((await service("Endodoncia", 65000)).id, 46)
  const corona = await indicate((await service("Corona", 90000)).id, 46)
  const exodoncia = await indicate((await service("Exodoncia", 15000)).id, 46)
  return { f, resina, profilaxis, endodoncia, corona, exodoncia }
}

it("en la atención, la exodoncia es otro camino para la 46: el borrador nace con dos opciones y el plan sabe qué compite", async () => {
  const { f, resina, profilaxis, endodoncia, corona, exodoncia } = await ana()
  const budget = await f.run((tx) =>
    placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: exodoncia.id, path: "nuevo" }),
  )
  expect(budget.options).toHaveLength(2)
  const [a, b] = budget.options
  const itemsOf = (optionId: string) =>
    budget.items
      .filter((line) => line.optionId === optionId)
      .map((line) => line.planItemId)
      .sort()
  expect(itemsOf(a!.id)).toEqual([resina.id, profilaxis.id, endodoncia.id, corona.id].sort())
  expect(itemsOf(b!.id)).toEqual([resina.id, profilaxis.id, exodoncia.id].sort())
  // Nunca se suman: cada camino con su total.
  expect(budget.options.map((option) => option.totalCents)).toEqual([185000, 45000])
  const plan = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))
  const pathOf = (id: string) => plan.find((item) => item.id === id)!.path
  expect(pathOf(resina.id)).toBeNull()
  expect(pathOf(endodoncia.id)).toMatchObject({ positions: [1], pathCount: 2, chosen: false })
  expect(pathOf(exodoncia.id)).toMatchObject({ positions: [2], pathCount: 2, chosen: false })
  // La resina es de otra pieza: no compite con nada.
  await expect(
    f.run((tx) => placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: resina.id, path: "nuevo" })),
  ).rejects.toMatchObject({ code: "PATH_OTHER_SITE" })
})

it("sin elegir camino se acepta lo común y lo de la 46 queda pensándolo; la oportunidad sigue abierta hasta que elige", async () => {
  const { f, resina, profilaxis, endodoncia, corona, exodoncia } = await ana()
  const draft = await f.run((tx) =>
    placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: exodoncia.id, path: "nuevo" }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
  // Aceptar lo de un solo camino es elegirlo.
  await expect(
    f.run((tx) =>
      decideBudget(tx, ...f.args, draft.id, {
        decisions: [
          { planItemId: resina.id, decision: "aceptado" },
          { planItemId: profilaxis.id, decision: "aceptado" },
          { planItemId: endodoncia.id, decision: "aceptado" },
          { planItemId: corona.id, decision: "pospuesto" },
          { planItemId: exodoncia.id, decision: "pospuesto" },
        ],
      }),
    ),
  ).rejects.toMatchObject({ code: "BUDGET_OPTION_REQUIRED" })
  const partial = await f.run((tx) =>
    decideBudget(tx, ...f.args, draft.id, {
      decisions: [
        { planItemId: resina.id, decision: "aceptado" },
        { planItemId: profilaxis.id, decision: "aceptado" },
        { planItemId: endodoncia.id, decision: "pospuesto" },
        { planItemId: corona.id, decision: "pospuesto" },
        { planItemId: exodoncia.id, decision: "pospuesto" },
      ],
    }),
  )
  expect(partial.status).toBe("parcial")
  expect(partial.stateText).toBe("Aceptó 2 · falta elegir el camino")
  expect(partial.awaitsAnswer).toBe(true)
  // Lo común aceptado cuenta una vez, aunque esté en los dos caminos.
  expect(partial.acceptedCents).toBe(30000)
  expect(partial.options.map((option) => option.decision)).toEqual(["pendiente", "pendiente"])
  const [open] = await ownerDb.select().from(opportunity).where(eq(opportunity.budgetId, draft.id))
  expect(open).toMatchObject({ status: "open", amountCents: 155000 })
  // Lo acordado de la cuenta cuenta lo común una vez, aunque esté aceptado en los dos caminos.
  const account = await f.run((tx) => getPatientAccount(tx, "org_a", f.patient.id))
  expect(account.byCurrency.find((row) => row.currency === "PEN")?.agreedCents).toBe(30000)
  const plan = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))
  expect(plan.find((item) => item.id === exodoncia.id)).toMatchObject({ decisionStatus: "pospuesto" })
  // Una semana después elige conservar: lo ya respondido no se repite.
  const chosen = draft.options[0]!
  const done = await f.run((tx) =>
    decideBudget(tx, ...f.args, draft.id, {
      optionId: chosen.id,
      decisions: [
        { planItemId: endodoncia.id, decision: "aceptado" },
        { planItemId: corona.id, decision: "aceptado" },
      ],
    }),
  )
  expect(done.status).toBe("aceptado")
  expect(done.awaitsAnswer).toBe(false)
  expect(done.options.map((option) => option.decision)).toEqual(["elegida", "no_elegida"])
  const after = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))
  expect(after.find((item) => item.id === exodoncia.id)).toMatchObject({ decisionStatus: "no_elegida" })
  const [won] = await ownerDb.select().from(opportunity).where(eq(opportunity.budgetId, draft.id))
  expect(won).toMatchObject({ status: "won", amountCents: 185000 })
})

it("la revisión de un precio pregunta solo por lo que cambió, conserva lo aceptado y no toca el precio de lo hecho", async () => {
  const { f, resina, profilaxis, endodoncia, corona } = await ana()
  const draft = await f.run(async (tx) => {
    const { createBudget } = await import("./budgets.js")
    return createBudget(tx, ...f.args, { itemIds: [resina.id, profilaxis.id, endodoncia.id, corona.id] })
  })
  await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, draft.id, {
      decisions: [resina, profilaxis, endodoncia, corona].map((item) => ({ planItemId: item.id, decision: "aceptado" as const })),
    }),
  )
  // La resina se hizo.
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: resina.id }))
  const revision = await f.run((tx) =>
    reviseBudget(tx, ...f.args, draft.id, {
      itemIds: [resina.id, profilaxis.id, endodoncia.id, corona.id],
      reason: "Sube la corona",
    }),
  )
  // El precio de lo hecho no cambia.
  await expect(
    f.run((tx) => adjustBudgetLines(tx, ...f.args, revision.id, { lines: [{ planItemId: resina.id, priceCents: 20000, reason: "x" }] })),
  ).rejects.toMatchObject({ code: "BUDGET_LINE_USED" })
  await f.run((tx) => adjustBudgetLines(tx, ...f.args, revision.id, { lines: [{ planItemId: corona.id, priceCents: 100000 }] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, revision.id))
  const sent = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, revision.id))
  const decisionOf = (id: string) => sent.items.find((line) => line.planItemId === id)!.decision
  // Algo aceptado y algo por responder: «parcial», y lo aceptado se puede atender mientras tanto.
  expect(sent.status).toBe("parcial")
  expect(sent.awaitsAnswer).toBe(true)
  expect([resina, profilaxis, endodoncia].map((item) => decisionOf(item.id))).toEqual(["aceptado", "aceptado", "aceptado"])
  expect(decisionOf(corona.id)).toBe("pendiente")
  const plan = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))
  expect(plan.find((item) => item.id === corona.id)).toMatchObject({ decisionStatus: "aceptado", newTermsPending: true })
  expect(plan.find((item) => item.id === endodoncia.id)).toMatchObject({ newTermsPending: false })
  // Solo se responde la corona.
  const answered = await f.run((tx) =>
    decideBudget(tx, ...f.args, revision.id, { decisions: [{ planItemId: corona.id, decision: "aceptado" }] }),
  )
  expect(answered.status).toBe("aceptado")
})

it("con un camino rechazado y otro pensándolo, la oportunidad sigue abierta; elegir un camino sin nada abierto no se puede", async () => {
  const { f, resina, profilaxis, endodoncia, corona, exodoncia } = await ana()
  const draft = await f.run((tx) =>
    placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: exodoncia.id, path: "nuevo" }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
  const answered = await f.run((tx) =>
    decideBudget(tx, ...f.args, draft.id, {
      decisions: [
        { planItemId: resina.id, decision: "aceptado" },
        { planItemId: profilaxis.id, decision: "aceptado" },
        { planItemId: endodoncia.id, decision: "rechazado" },
        { planItemId: corona.id, decision: "rechazado" },
        { planItemId: exodoncia.id, decision: "pospuesto" },
      ],
    }),
  )
  expect(answered.awaitsAnswer).toBe(true)
  const [open] = await ownerDb.select().from(opportunity).where(eq(opportunity.budgetId, draft.id))
  expect(open).toMatchObject({ status: "open" })
  // El camino de la endodoncia ya no tiene nada abierto: no se elige sin responder.
  await expect(
    f.run((tx) =>
      decideBudget(tx, ...f.args, draft.id, { optionId: draft.options[0]!.id, decisions: [] }),
    ),
  ).rejects.toMatchObject({ code: "BUDGET_DECISION_FINAL" })
})

it("la revisión de un presupuesto con caminos sin elegir lleva los dos caminos", async () => {
  const { f, exodoncia } = await ana()
  const draft = await f.run((tx) =>
    placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: exodoncia.id, path: "nuevo" }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, draft.id))
  const revision = await f.run((tx) =>
    reviseBudget(tx, ...f.args, draft.id, {
      itemIds: [...new Set(draft.items.map((line) => line.planItemId))],
      reason: "Otro precio",
    }),
  )
  expect(revision.options).toHaveLength(2)
  expect(revision.options.map((option) => option.lineCount)).toEqual(
    draft.options.map((option) => option.lineCount),
  )
})

it("el odontólogo lee el presupuesto de su colega, pero no lo envía", async () => {
  const { f, resina } = await ana()
  const colleague = randomUUID()
  await ownerDb.insert(user).values({ id: colleague, name: "Colega", email: `${colleague}@example.test` })
  await ownerDb
    .insert(member)
    .values({ id: randomUUID(), organizationId: "org_a", userId: colleague, role: "clinician", createdAt: new Date() })
  await f.run((tx) =>
    placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: resina.id, path: "todos" }).catch(() => null),
  )
  const draft = await f.run(async (tx) => {
    const found = await findDraftBudget(tx, "org_a", f.patient.id)
    if (found) return found
    const { createBudget } = await import("./budgets.js")
    return createBudget(tx, ...f.args, { itemIds: [resina.id] })
  })
  const asColleague = { actorUserId: colleague, memberRole: "clinician" }
  const seen = await withOrgContext(appDb, "org_a", (tx) => listBudgets(tx, "org_a", f.patient.id, undefined, asColleague))
  expect(seen.map((budget) => [budget.id, budget.canChange])).toEqual([[draft.id, false]])
  const own = await f.run((tx) => listBudgets(tx, "org_a", f.patient.id, undefined, { actorUserId: f.actor, memberRole: "clinician" }))
  expect(own[0]!.canChange).toBe(true)
  const preview = await withOrgContext(appDb, "org_a", (tx) => previewBudgetSend(tx, "org_a", f.patient.id, draft.id, asColleague))
  expect(preview.blocked).toMatch(/lo envía quien lo preparó/)
})
