import { withOrgContext } from "@odentia/db"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { addEncounterProcedure, voidEncounter, voidEncounterProcedure } from "./encounters.js"
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
    sql`with pp as (insert into contact (organization_id,display_name) values ('org_a','Paciente clínico') returning id) insert into patient (organization_id,person_id,patient_number) select 'org_a',pp.id,1 from pp returning id`,
  )
  const [service] = await ownerDb.execute<{ id: string }>(
    sql`insert into service_catalog (organization_id,name,scope,source,price_cents,currency) values ('org_a','Tratamiento','general','custom',120000,'PEN') returning id`,
  )
  const [first] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient.id},'clinical-actor') returning id`,
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
    sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient.id},'clinical-actor') returning id`,
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
    sql`with pp as (insert into contact (organization_id,display_name) values ('org_a','Paciente alternativas') returning id) insert into patient (organization_id,person_id,patient_number) select 'org_a',pp.id,2 from pp returning id`,
  )
  const [service] = await ownerDb.execute<{ id: string }>(
    sql`insert into service_catalog (organization_id,name,scope,source,price_cents,currency) values ('org_a','Obturación','general','custom',90000,'PEN') returning id`,
  )
  const [encounter] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient.id},'alt-actor') returning id`,
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

// QA del 6 nov (M12): la resina hecha hoy dejaba cerrado el plan y la siguiente
// indicación de la misma atención abría otro, así que lo de hoy salía en
// «Planes anteriores» y el plan decía «0 de 1».
it("lo indicado en la misma atención va a su plan aunque lo de hoy ya esté hecho; un plan con algo por hacer no es anterior", async () => {
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('m12-actor','Clínico','m12@example.test')`,
  )
  const [patient] = await ownerDb.execute<{ id: string }>(
    sql`with pp as (insert into contact (organization_id,display_name) values ('org_a','Paciente misma atención') returning id) insert into patient (organization_id,person_id,patient_number) select 'org_a',pp.id,3 from pp returning id`,
  )
  const [service] = await ownerDb.execute<{ id: string }>(
    sql`insert into service_catalog (organization_id,name,scope,source,price_cents,currency) values ('org_a','Resina','general','custom',90000,'PEN') returning id`,
  )
  const [encounter] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient.id},'m12-actor') returning id`,
  )
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  const args = ["org_a", "m12-actor", patient.id] as const
  const indication = { serviceId: service.id, sourceEncounterId: encounter.id }
  const hecha = await run((tx) => addPlanItem(tx, ...args, indication))
  // La resina de la 36 quedó hecha en esta misma atención: el plan ya no tiene nada por hacer.
  await ownerDb.execute(sql`update treatment_plan_item set status = 'realizado' where id = ${hecha.id}`)
  const siguiente = await run((tx) => addPlanItem(tx, ...args, indication))
  expect(siguiente.planId).toBe(hecha.planId)
  const plans = await run((tx) => listTreatmentPlans(tx, "org_a", patient.id))
  expect(plans).toHaveLength(1)
  expect(plans[0]).toMatchObject({ isOpen: true, active: true, totalItems: 2 })

  // Dos planes con algo por hacer (de antes de que hubiera uno solo): ninguno es anterior.
  await ownerDb.execute(sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${encounter.id}`)
  const [otra] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient.id},'m12-actor') returning id`,
  )
  const viejo = await run((tx) => createTreatmentPlan(tx, ...args, { title: "Plan anterior", originEncounterId: otra.id }))
  await run((tx) => addPlanItem(tx, ...args, { serviceId: service.id, sourceEncounterId: otra.id, planId: viejo.id }))
  const both = await run((tx) => listTreatmentPlans(tx, "org_a", patient.id))
  expect(both.map((row) => row.active)).toEqual([true, true])
  expect(both.filter((row) => row.isOpen)).toHaveLength(1)
})

it("una sesión anulada no deja completar el tratamiento, y anular la atención devuelve lo completado en ella", async () => {
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('clinical-void','Clínico','clinical-void@example.test') on conflict do nothing`,
  )
  const [patient] = await ownerDb.execute<{ id: string }>(
    sql`with pp as (insert into contact (organization_id,display_name) values ('org_a','Paciente de la sesión anulada') returning id) insert into patient (organization_id,person_id,patient_number) select 'org_a',pp.id,9101 from pp returning id`,
  )
  const [service] = await ownerDb.execute<{ id: string }>(
    sql`insert into service_catalog (organization_id,name,scope,source,price_cents,currency) values ('org_a','Endodoncia','general','custom',50000,'PEN') returning id`,
  )
  const draft = async () =>
    (
      await ownerDb.execute<{ id: string }>(
        sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient!.id},'clinical-void') returning id`,
      )
    )[0]!.id
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  const args = ["org_a", "clinical-void", patient!.id] as const
  const first = await draft()
  const plan = await run((tx) => createTreatmentPlan(tx, ...args, { title: "Plan", originEncounterId: first }))
  const item = await run((tx) => addPlanItem(tx, ...args, { serviceId: service!.id, planId: plan.id, sourceEncounterId: first }))
  const [budget] = await ownerDb.execute<{ id: string }>(
    sql`insert into treatment_budget (organization_id,patient_id,plan_id,budget_number,title,currency,status) values ('org_a',${patient!.id},${plan.id},9101,'Propuesta','PEN','aceptado') returning id`,
  )
  await ownerDb.execute(
    sql`update treatment_plan_item set decision_status = 'aceptado', budget_id = ${budget!.id} where id = ${item.id}`,
  )
  const statusOf = async () =>
    (await run((tx) => listPlanItems(tx, "org_a", patient!.id))).find((i) => i.id === item.id)?.status

  // La única sesión se anula: «Completar» ya no puede cerrarlo.
  const session = await run((tx) => addEncounterProcedure(tx, ...args, first, { planItemId: item.id }))
  await run((tx) => voidEncounterProcedure(tx, ...args, first, session.id, { reason: "Era otra pieza" }))
  expect(await statusOf()).toBe("programado")
  await expect(
    run((tx) => setPlanItemStatus(tx, ...args, item.id, { status: "realizado", encounterId: first })),
  ).rejects.toMatchObject({ code: "ATTENTION_REQUIRED" })

  // Con una sesión válida, se completa en otra atención sin sesión propia; anular esa atención lo reabre.
  await run((tx) => addEncounterProcedure(tx, ...args, first, { planItemId: item.id }))
  await ownerDb.execute(
    sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${first}`,
  )
  const second = await draft()
  await run((tx) => setPlanItemStatus(tx, ...args, item.id, { status: "realizado", encounterId: second }))
  expect(await statusOf()).toBe("realizado")
  await run((tx) => voidEncounter(tx, ...args, second, { reason: "Abierta por error" }))
  expect(await statusOf()).toBe("en_curso")
})
