import { withOrgContext } from "@odentia/db"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { addEncounterProcedure } from "./encounters.js"
import { addPlanItem, createTreatmentPlan, listPlanItems } from "./plan.js"
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
