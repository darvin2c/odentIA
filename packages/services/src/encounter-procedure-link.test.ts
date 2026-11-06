import { withOrgContext } from "@odentia/db"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget } from "./budgets.js"
import { addEncounterProcedure } from "./encounters.js"
import { addPlanItem, createTreatmentPlan, listPlanItems, setPlanItemStatus } from "./plan.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

// QA CT (ADR 0100): registrar un servicio que ya es un tratamiento aceptado y
// abierto del plan lo ejecuta ese tratamiento; no crea otra indicación.
it("un servicio del catálogo que ya es tratamiento aceptado del plan se ejecuta ese tratamiento, sin otra indicación", async () => {
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('clinical-link','Clínico','clinical-link@example.test')`,
  )
  const [patient] = await ownerDb.execute<{ id: string }>(
    sql`with pp as (insert into contact (organization_id,display_name) values ('org_a','Paciente enlace') returning id) insert into patient (organization_id,person_id,patient_number) select 'org_a',pp.id,1 from pp returning id`,
  )
  const [service] = await ownerDb.execute<{ id: string }>(
    sql`insert into service_catalog (organization_id,name,scope,source,price_cents,currency) values ('org_a','Resina','general','custom',80000,'PEN') returning id`,
  )
  const [first] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient.id},'clinical-link') returning id`,
  )
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  const args = ["org_a", "clinical-link", patient.id] as const
  const plan = await run((tx) => createTreatmentPlan(tx, ...args, { title: "Plan", originEncounterId: first.id }))
  const item = await run((tx) =>
    addPlanItem(tx, ...args, { serviceId: service.id, planId: plan.id, sourceEncounterId: first.id }),
  )
  const [budget] = await ownerDb.execute<{ id: string }>(
    sql`insert into treatment_budget (organization_id,patient_id,plan_id,budget_number,title,currency,status) values ('org_a',${patient.id},${plan.id},1,'Propuesta','PEN','aceptado') returning id`,
  )
  await ownerDb.execute(
    sql`update treatment_plan_item set decision_status = 'aceptado', budget_id = ${budget.id} where id = ${item.id}`,
  )
  // Solo puede haber una atención abierta por paciente: la primera se cierra.
  await ownerDb.execute(
    sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${first.id}`,
  )
  // Una atención nueva, en la que el equipo registra la resina del catálogo.
  const [second] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient.id},'clinical-link') returning id`,
  )
  const before = (await run((tx) => listPlanItems(tx, "org_a", patient.id))).length

  const procedure = await run((tx) => addEncounterProcedure(tx, ...args, second.id, { serviceId: service.id }))

  // Usa el tratamiento aceptado y no crea otra indicación en el plan.
  expect(procedure.planItemId).toBe(item.id)
  expect((await run((tx) => listPlanItems(tx, "org_a", patient.id))).length).toBe(before)
})

// QA del 6 nov (F-A1): una endodoncia prevista en 2 sesiones, aceptada al
// hacerla en la primera, quedaba «Realizado». En la segunda ya no se ofrecía,
// el catálogo creaba otra endodoncia de la misma pieza y se cobraba otra vez.
it("aceptar al hacerlo un tratamiento de varias sesiones lo deja en curso y la sesión siguiente es del mismo tratamiento", async () => {
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('clinical-sessions','Clínico','clinical-sessions@example.test')`,
  )
  const [patient] = await ownerDb.execute<{ id: string }>(
    sql`with pp as (insert into contact (organization_id,display_name) values ('org_a','Paciente sesiones') returning id) insert into patient (organization_id,person_id,patient_number) select 'org_a',pp.id,2 from pp returning id`,
  )
  const [service] = await ownerDb.execute<{ id: string }>(
    sql`insert into service_catalog (organization_id,name,scope,source,price_cents,currency) values ('org_a','Endodoncia','general','custom',65000,'PEN') returning id`,
  )
  const [first] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient.id},'clinical-sessions') returning id`,
  )
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  const args = ["org_a", "clinical-sessions", patient.id] as const
  const plan = await run((tx) => createTreatmentPlan(tx, ...args, { title: "Plan", originEncounterId: first.id }))
  const item = await run((tx) =>
    addPlanItem(tx, ...args, { serviceId: service.id, planId: plan.id, sourceEncounterId: first.id, plannedSessions: 2 }),
  )

  // Sesión 1: el paciente no había respondido y el odontólogo la acepta al hacerla.
  await run((tx) => addEncounterProcedure(tx, ...args, first.id, { planItemId: item.id, acceptWhenDone: true }))
  const [afterFirst] = await ownerDb.execute<{ status: string; decision_status: string; completed_at: string | null }>(
    sql`select status, decision_status, completed_at from treatment_plan_item where id = ${item.id}`,
  )
  expect(afterFirst).toMatchObject({ status: "en_curso", decision_status: "aceptado", completed_at: null })

  await ownerDb.execute(
    sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${first.id}`,
  )
  const [second] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient.id},'clinical-sessions') returning id`,
  )
  const before = (await run((tx) => listPlanItems(tx, "org_a", patient.id))).length

  // Sesión 2: elegida del catálogo, es la misma endodoncia, no otra.
  const procedure = await run((tx) => addEncounterProcedure(tx, ...args, second.id, { serviceId: service.id }))
  expect(procedure.planItemId).toBe(item.id)
  expect((await run((tx) => listPlanItems(tx, "org_a", patient.id))).length).toBe(before)

  // Al obturar, el odontólogo la completa: no tiene presupuesto, pero se aceptó en una atención.
  await run((tx) => setPlanItemStatus(tx, ...args, item.id, { status: "realizado", encounterId: second.id }))
  const [afterSecond] = await ownerDb.execute<{ status: string }>(
    sql`select status from treatment_plan_item where id = ${item.id}`,
  )
  expect(afterSecond.status).toBe("realizado")
})

it("la misma endodoncia en otra pieza no es una sesión de la que sigue en curso, y lo en curso no vuelve a presupuestarse", async () => {
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('clinical-teeth','Clínico','clinical-teeth@example.test')`,
  )
  const [patient] = await ownerDb.execute<{ id: string }>(
    sql`with pp as (insert into contact (organization_id,display_name) values ('org_a','Paciente piezas') returning id) insert into patient (organization_id,person_id,patient_number) select 'org_a',pp.id,4 from pp returning id`,
  )
  const [service] = await ownerDb.execute<{ id: string }>(
    sql`insert into service_catalog (organization_id,name,scope,source,price_cents,currency) values ('org_a','Endodoncia anterior','tooth','custom',45000,'PEN') returning id`,
  )
  const [visit] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient.id},'clinical-teeth') returning id`,
  )
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  const args = ["org_a", "clinical-teeth", patient.id] as const
  const plan = await run((tx) => createTreatmentPlan(tx, ...args, { title: "Plan", originEncounterId: visit.id }))
  const item = await run((tx) =>
    addPlanItem(tx, ...args, { serviceId: service.id, planId: plan.id, sourceEncounterId: visit.id, toothNumber: 11, plannedSessions: 2 }),
  )
  await run((tx) => addEncounterProcedure(tx, ...args, visit.id, { planItemId: item.id, acceptWhenDone: true }))

  // La 21, del catálogo, en la misma atención: es otro tratamiento, no la sesión de la 11.
  const other = await run((tx) => addEncounterProcedure(tx, ...args, visit.id, { serviceId: service.id, toothNumber: 21 }))
  expect(other.planItemId).not.toBe(item.id)

  // La de la 11, aceptada al hacerla y en curso, ya no se cotiza.
  await expect(
    run((tx) => createBudget(tx, ...args, { planId: plan.id, itemIds: [item.id] })),
  ).rejects.toMatchObject({ code: "ITEM_CLOSED" })
})

it("aceptar al hacerlo un tratamiento de una sola sesión lo deja realizado, como hasta ahora", async () => {
  await ownerDb.execute(
    sql`insert into "user" (id,name,email) values ('clinical-single','Clínico','clinical-single@example.test')`,
  )
  const [patient] = await ownerDb.execute<{ id: string }>(
    sql`with pp as (insert into contact (organization_id,display_name) values ('org_a','Paciente una sesión') returning id) insert into patient (organization_id,person_id,patient_number) select 'org_a',pp.id,3 from pp returning id`,
  )
  const [service] = await ownerDb.execute<{ id: string }>(
    sql`insert into service_catalog (organization_id,name,scope,source,price_cents,currency) values ('org_a','Profilaxis','general','custom',12000,'PEN') returning id`,
  )
  const [encounterRow] = await ownerDb.execute<{ id: string }>(
    sql`insert into encounter (organization_id,patient_id,professional_user_id) values ('org_a',${patient.id},'clinical-single') returning id`,
  )
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  const args = ["org_a", "clinical-single", patient.id] as const
  const plan = await run((tx) => createTreatmentPlan(tx, ...args, { title: "Plan", originEncounterId: encounterRow.id }))
  const item = await run((tx) =>
    addPlanItem(tx, ...args, { serviceId: service.id, planId: plan.id, sourceEncounterId: encounterRow.id }),
  )

  await run((tx) => addEncounterProcedure(tx, ...args, encounterRow.id, { planItemId: item.id, acceptWhenDone: true }))

  const [after] = await ownerDb.execute<{ status: string; completed_at: string | null }>(
    sql`select status, completed_at from treatment_plan_item where id = ${item.id}`,
  )
  expect(after.status).toBe("realizado")
  expect(after.completed_at).not.toBeNull()
})
