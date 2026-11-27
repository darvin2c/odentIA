/**
 * El control dictado para la segunda sesión de un tratamiento que termina con esta firma (QA del 26
 * nov, H6): el cierre lo sugiere quitar en su fila y quien firma decide; el sistema no lo quita solo.
 */
import { clinicalFollowUp, encounterDictationSuggestion, serviceCatalog } from "@odentia/db/schema/clinical"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter, getEncounterClosing } from "./encounters.js"
import { createFollowUp } from "./follow-ups.js"
import { addPlanItem } from "./plan.js"
import { sessionControlOf } from "./session-control.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const DAY = 86_400_000
const endo = { planItemId: "endo", title: "Endodoncia", n: 1, m: 2 }
const resina = { planItemId: "resina", title: "Resina compuesta", n: 1, m: 1 }

describe("sessionControlOf", () => {
  it("reconoce la sesión que sigue del tratamiento que nombra, o del único de hoy", () => {
    expect(sessionControlOf(["Control: segunda sesión de la endodoncia"], [endo, resina])).toEqual({
      planItemId: "endo",
      title: "Endodoncia",
      session: 2,
    })
    expect(sessionControlOf(["Control en 1 semana", "vuelva en una semana para la segunda sesión"], [endo])).toMatchObject({
      planItemId: "endo",
      session: 2,
    })
    expect(sessionControlOf(["Próxima sesión"], [endo])).toMatchObject({ session: 2 })
    expect(sessionControlOf(["Control para la sesión 3"], [endo], "endo")).toMatchObject({ session: 3 })
  })

  it("sin sesión dicha, con una sesión ya hecha o sin saber de cuál tratamiento, nada", () => {
    expect(sessionControlOf(["Control de mantenimiento"], [endo])).toBeNull()
    expect(sessionControlOf(["Control de la primera sesión"], [endo])).toBeNull()
    expect(sessionControlOf(["Control para la segunda sesión"], [endo, resina])).toBeNull()
  })
})

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Una endodoncia aceptada de dos sesiones, con su sesión 1 registrada hoy. */
async function firstSessionToday(f: Fixture) {
  await ownerDb.update(serviceCatalog).set({ name: "Endodoncia" }).where(eq(serviceCatalog.id, f.service.id))
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: 2 }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  // Lo que Clío dejó de «vuelva en una semana para la segunda sesión», ya confirmado.
  const control = await f.run((tx) =>
    createFollowUp(tx, ...f.args, {
      kind: "mantenimiento",
      title: "Control en 1 semana",
      dueAt: new Date(Date.now() + 7 * DAY).toISOString(),
      originEncounterId: f.encounter.id,
    }),
  )
  await ownerDb.insert(encounterDictationSuggestion).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    encounterId: f.encounter.id,
    professionalUserId: f.actor,
    kind: "control",
    payload: { title: "Control en 1 semana" },
    sourceText: "vuelva en una semana para la segunda sesión",
    status: "confirmada",
    entityId: control.id,
  })
  return { item, control }
}

const statusOf = async (id: string) =>
  (await ownerDb.select({ status: clinicalFollowUp.status }).from(clinicalFollowUp).where(eq(clinicalFollowUp.id, id)))[0]?.status

it("H6: el cierre dice para qué sesión era el control; «Quitar» con «Sí, terminar» lo cancela al firmar", async () => {
  const f = await clinicalFixture()
  const { item, control } = await firstSessionToday(f)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.controls.open.find((row) => row.id === control.id)?.forSession).toEqual({
    planItemId: item.id,
    title: "Endodoncia",
    session: 2,
  })
  await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, f.encounter.id, { completePlanItemIds: [item.id], dropFollowUpIds: [control.id] }),
  )
  expect(await statusOf(control.id)).toBe("cancelado")
})

it("H6: sin «Quitar», el control se queda aunque la endodoncia termine: el sistema no lo quita solo", async () => {
  const f = await clinicalFixture()
  const { item, control } = await firstSessionToday(f)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { completePlanItemIds: [item.id] }))
  expect(await statusOf(control.id)).toBe("pendiente")
})

it("H6: si la endodoncia sigue en curso, el control de su segunda sesión se queda aunque llegue «Quitar»", async () => {
  const f = await clinicalFixture()
  const { control } = await firstSessionToday(f)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { dropFollowUpIds: [control.id] }))
  expect(await statusOf(control.id)).toBe("pendiente")
})
