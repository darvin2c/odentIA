import { withOrgContext } from "@odentia/db"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { addEncounterProcedure } from "./encounters.js"
import {
  addPlanItem,
  createTreatmentPlan,
  derivePlanStatus,
  listPlanItems,
  listTreatmentPlans,
  OPEN_PLAN_TITLE,
  revisePlanItem,
  setPlanItemStatus,
} from "./plan.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("conserva dos sesiones, exige completar explícitamente y encadena revisiones", async () => {
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('clinical-actor','Clínico','clinical@example.test')`,
  )
  const [patient] = await ownerDb.execute<{ id: string }>(
    sql`insert into patient (organization_id,display_name,patient_number) values ('org_a','Paciente clínico',1) returning id`,
  )
  const [service] = await ownerDb.execute<{ id: string }>(
    sql`insert into service_catalog (organization_id,name,specialty,scope,source,price_cents,currency) values ('org_a','Tratamiento','general','general','custom',120000,'PEN') returning id`,
  )
  const [first] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,dentist_user_id) values ('org_a',${patient.id},'clinical-actor') returning id`,
  )
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  const args = ["org_a", "clinical-actor", patient.id] as const
  const plan = await run((tx) =>
    createTreatmentPlan(tx, ...args, { title: "Plan", originEncounterId: first.id }),
  )
  const indication = {
    serviceId: service.id,
    planId: plan.id,
    sourceEncounterId: first.id,
  }
  const item = await run((tx) => addPlanItem(tx, ...args, indication))
  const alternative = await run((tx) => addPlanItem(tx, ...args, indication))
  const [budget] = await ownerDb.execute<{ id: string }>(
    sql`insert into treatment_budget (organization_id,patient_id,plan_id,budget_number,title,currency,status) values ('org_a',${patient.id},${plan.id},1,'Propuesta','PEN','aceptado') returning id`,
  )
  await ownerDb.execute(
    sql`update treatment_plan_item set decision_status = 'aceptado', budget_id = ${budget.id} where id = ${item.id}`,
  )
  await expect(
    run((tx) =>
      setPlanItemStatus(tx, ...args, item.id, { status: "realizado", encounterId: first.id }),
    ),
  ).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
  await run((tx) => addEncounterProcedure(tx, ...args, first.id, { planItemId: item.id }))
  expect(
    (await run((tx) => listPlanItems(tx, "org_a", patient.id))).find((i) => i.id === item.id)
      ?.status,
  ).toBe("en_curso")
  await ownerDb.execute(sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${first.id}`)
  const [second] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,dentist_user_id) values ('org_a',${patient.id},'clinical-actor') returning id`,
  )
  await run((tx) => addEncounterProcedure(tx, ...args, second.id, { planItemId: item.id }))
  expect(
    (await run((tx) => listPlanItems(tx, "org_a", patient.id))).find((i) => i.id === item.id)
      ?.status,
  ).toBe("en_curso")
  const completed = await run((tx) =>
    setPlanItemStatus(tx, ...args, item.id, { status: "realizado", encounterId: second.id }),
  )
  expect(completed.status).toBe("realizado")
  expect(completed.startedAt).not.toBeNull()
  expect(completed.completedAt).not.toBeNull()
  const revise = { encounterId: second.id, serviceId: service.id, reason: "Nueva evaluación" }
  await expect(run((tx) => revisePlanItem(tx, ...args, item.id, revise))).rejects.toMatchObject({
    code: "ITEM_CLOSED",
  })
  const replacement = await run((tx) => revisePlanItem(tx, ...args, alternative.id, revise))
  expect(replacement.supersedesItemId).toBe(alternative.id)
  expect(
    (await run((tx) => listPlanItems(tx, "org_a", patient.id))).find(
      (i) => i.id === alternative.id,
    ),
  ).toMatchObject({ status: "reemplazado", decisionStatus: "reemplazado" })
  const sessions = await run((tx) =>
    tx.execute(sql`select encounter_id from encounter_plan_item where plan_item_id = ${item.id}`),
  )
  expect(sessions.map((s) => s.encounter_id).sort()).toEqual([first.id, second.id].sort())
  await expect(
    run((tx) => setPlanItemStatus(tx, ...args, replacement.id, { status: "cancelado" })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
})

it("no declara completado un plan mixto con indicaciones canceladas", () => {
  expect(derivePlanStatus(["realizado", "cancelado"])).toBe("En curso")
  expect(derivePlanStatus(["cancelado", "reemplazado"])).toBe("Cancelado")
  expect(derivePlanStatus(["realizado", "realizado"])).toBe("Completado")
})

it("indica sin elegir plan: el plan abierto nace con la atención y recibe lo siguiente; reanuda un suspendido", async () => {
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('alt-actor','Clínico','alt@example.test')`,
  )
  const [patient] = await ownerDb.execute<{ id: string }>(
    sql`insert into patient (organization_id,display_name,patient_number) values ('org_a','Paciente alternativas',2) returning id`,
  )
  const [service] = await ownerDb.execute<{ id: string }>(
    sql`insert into service_catalog (organization_id,name,specialty,scope,source,price_cents,currency) values ('org_a','Obturación','general','general','custom',90000,'PEN') returning id`,
  )
  const [encounter] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,dentist_user_id) values ('org_a',${patient.id},'alt-actor') returning id`,
  )
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  const args = ["org_a", "alt-actor", patient.id] as const
  // Sin plan: la primera indicación abre el plan de la persona, con la atención como origen.
  const indication = { serviceId: service.id, sourceEncounterId: encounter.id }
  const resina = await run((tx) => addPlanItem(tx, ...args, indication))
  const corona = await run((tx) => addPlanItem(tx, ...args, indication))
  expect(corona.planId).toBe(resina.planId)
  const plans = await run((tx) => listTreatmentPlans(tx, "org_a", patient.id))
  expect(plans).toHaveLength(1)
  expect(plans[0]).toMatchObject({ isOpen: true, plan: { title: OPEN_PLAN_TITLE, originEncounterId: encounter.id } })
  const plan = plans[0]!.plan

  // Suspender deja de ser un callejón sin salida: se reanuda donde quedó.
  const [budget] = await ownerDb.execute<{ id: string }>(
    sql`insert into treatment_budget (organization_id,patient_id,plan_id,budget_number,title,currency,status) values ('org_a',${patient.id},${plan.id},2,'Propuesta','PEN','aceptado') returning id`,
  )
  await ownerDb.execute(
    sql`update treatment_plan_item set decision_status = 'aceptado', budget_id = ${budget.id} where id = ${resina.id}`,
  )
  await run((tx) => setPlanItemStatus(tx, ...args, resina.id, { status: "en_curso" }))
  await run((tx) =>
    setPlanItemStatus(tx, ...args, resina.id, {
      status: "suspendido",
      statusReason: "Paciente viaja",
    }),
  )
  const reanudado = await run((tx) =>
    setPlanItemStatus(tx, ...args, resina.id, { status: "programado" }),
  )
  expect(reanudado).toMatchObject({ status: "programado", statusReason: null })
  await run((tx) =>
    setPlanItemStatus(tx, ...args, resina.id, {
      status: "cancelado",
      statusReason: "Paciente decide no continuar",
    }),
  )
  await expect(
    run((tx) => setPlanItemStatus(tx, ...args, resina.id, { status: "en_curso" })),
  ).rejects.toMatchObject({ code: "ITEM_CLOSED" })
})
