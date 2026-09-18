import { withOrgContext } from "@odentia/db"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { addEncounterProcedure } from "./encounters.js"
import { addPlanItem, createOptionGroup, createTreatmentPlan, derivePlanStatus, listPlanItems, revisePlanItem, setPlanItemStatus } from "./plan.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("conserva dos sesiones, exige completar explícitamente y encadena revisiones", async () => {
  await ownerDb.execute(sql`insert into "user" (id,name,email) values ('clinical-actor','Clínico','clinical@example.test')`)
  const [patient] = await ownerDb.execute<{ id: string }>(sql`insert into patient (organization_id,display_name,patient_number) values ('org_a','Paciente clínico',1) returning id`)
  const [service] = await ownerDb.execute<{ id: string }>(sql`insert into service_catalog (organization_id,name,specialty,scope,source,price_cents) values ('org_a','Tratamiento','general','general','custom',120000) returning id`)
  const [first] = await ownerDb.execute<{ id: string }>(sql`insert into encounter (organization_id,patient_id,dentist_user_id) values ('org_a',${patient.id},'clinical-actor') returning id`)
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  const args = ["org_a", "clinical-actor", patient.id] as const
  const plan = await run(tx => createTreatmentPlan(tx, ...args, { title: "Plan", originEncounterId: first.id }))
  const group = await run(tx => createOptionGroup(tx, ...args, { planId: plan.id, title: "Alternativas" }))
  const indication = { serviceId: service.id, planId: plan.id, sourceEncounterId: first.id, optionGroupId: group.id, isRecommended: true }
  const item = await run(tx => addPlanItem(tx, ...args, indication))
  const alternative = await run(tx => addPlanItem(tx, ...args, indication))
  expect((await run(tx => listPlanItems(tx, "org_a", patient.id))).find(i => i.id === item.id)?.isRecommended).toBe(false)
  const [budget] = await ownerDb.execute<{ id: string }>(sql`insert into treatment_budget (organization_id,patient_id,plan_id,budget_number,title,status) values ('org_a',${patient.id},${plan.id},1,'Propuesta','aceptado') returning id`)
  await ownerDb.execute(sql`update treatment_plan_item set decision_status = 'aceptado', budget_id = ${budget.id} where id = ${item.id}`)
  await expect(run(tx => setPlanItemStatus(tx, ...args, item.id, { status: "realizado", encounterId: first.id }))).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
  await run(tx => addEncounterProcedure(tx, ...args, first.id, { planItemId: item.id }))
  expect((await run(tx => listPlanItems(tx, "org_a", patient.id))).find(i => i.id === item.id)?.status).toBe("en_curso")
  await ownerDb.execute(sql`update encounter set status = 'finalizada' where id = ${first.id}`)
  const [second] = await ownerDb.execute<{ id: string }>(sql`insert into encounter (organization_id,patient_id,dentist_user_id) values ('org_a',${patient.id},'clinical-actor') returning id`)
  await run(tx => addEncounterProcedure(tx, ...args, second.id, { planItemId: item.id }))
  expect((await run(tx => listPlanItems(tx, "org_a", patient.id))).find(i => i.id === item.id)?.status).toBe("en_curso")
  const completed = await run(tx => setPlanItemStatus(tx, ...args, item.id, { status: "realizado", encounterId: second.id }))
  expect(completed.status).toBe("realizado")
  expect(completed.startedAt).not.toBeNull()
  expect(completed.completedAt).not.toBeNull()
  const revise = { encounterId: second.id, serviceId: service.id, reason: "Nueva evaluación" }
  await expect(run(tx => revisePlanItem(tx, ...args, item.id, revise))).rejects.toMatchObject({ code: "ITEM_CLOSED" })
  const replacement = await run(tx => revisePlanItem(tx, ...args, alternative.id, revise))
  expect(replacement.supersedesItemId).toBe(alternative.id)
  expect((await run(tx => listPlanItems(tx, "org_a", patient.id))).find(i => i.id === alternative.id)).toMatchObject({ status: "reemplazado", decisionStatus: "reemplazado" })
  const sessions = await run(tx => tx.execute(sql`select encounter_id from encounter_plan_item where plan_item_id = ${item.id}`))
  expect(sessions.map(s => s.encounter_id).sort()).toEqual([first.id, second.id].sort())
  await expect(run(tx => setPlanItemStatus(tx, ...args, replacement.id, { status: "cancelado" }))).rejects.toMatchObject({ code: "VALIDATION" })
})

it("no declara completado un plan mixto con indicaciones canceladas", () => {
  expect(derivePlanStatus(["realizado", "cancelado"])).toBe("En curso")
  expect(derivePlanStatus(["cancelado", "reemplazado"])).toBe("Cancelado")
  expect(derivePlanStatus(["realizado", "realizado"])).toBe("Completado")
})
