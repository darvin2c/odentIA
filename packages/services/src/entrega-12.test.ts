/**
 * Repaso final 2 de la atención y la ficha (10 nov, entrega 12): anular la atención donde se cambió
 * un tratamiento lo deja como estaba, y lo demás de los dos informes que vive en los servicios.
 */
import { treatmentPlanItem } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { getEncounterVoidPreview, voidEncounter } from "./encounters.js"
import { addPlanItem, listPlanItems, revisePlanItem } from "./plan.js"
import { encounter } from "@odentia/db/schema/clinical"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Un tratamiento aceptado, con su presupuesto aceptado. */
async function accepted(f: Fixture) {
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  return item
}

/** La atención de la fixture queda firmada: solo hay una abierta por paciente. */
async function signFirst(f: Fixture) {
  await ownerDb.execute(
    sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${f.encounter.id}`,
  )
}

async function attention(f: Fixture): Promise<string> {
  const [row] = await ownerDb
    .insert(encounter)
    .values({ organizationId: "org_a", patientId: f.patient.id, professionalUserId: f.actor, reason: "Sesión" })
    .returning({ id: encounter.id })
  await f.ready(row!.id)
  return row!.id
}

it("A1: anular la atención donde se cambió un tratamiento deshace el cambio; el anterior vuelve aceptado y el diálogo lo dice", async () => {
  const f = await clinicalFixture()
  const item = await accepted(f)
  const [before] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id))
  await signFirst(f)
  const today = await attention(f)
  const next = await f.run((tx) =>
    revisePlanItem(tx, ...f.args, item.id, { encounterId: today, reason: "Se puede conservar", serviceId: f.service.id }),
  )
  const preview = await f.run((tx) => getEncounterVoidPreview(tx, ...f.args, today))
  expect(preview.revisions).toEqual([{ restored: item.title, replacement: next.title }])
  await f.run((tx) => voidEncounter(tx, ...f.args, today, { reason: "Era de prueba" }))
  const [old] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id))
  expect(old).toMatchObject({
    status: before!.status,
    decisionStatus: "aceptado",
    statusReason: before!.statusReason,
    consentResetAt: null,
  })
  const [gone] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, next.id))
  expect(gone?.status).toBe("cancelado")
  // El Plan vuelve a listar el anterior y no el que se anuló.
  const plan = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { withoutVoided: true }))
  expect(plan.map((row) => row.id)).toContain(item.id)
  expect(plan.map((row) => row.id)).not.toContain(next.id)
  const trace = await ownerDb
    .select({ action: auditEvent.action })
    .from(auditEvent)
    .where(and(eq(auditEvent.entityId, item.id), eq(auditEvent.action, "plan.item_revision_undone")))
  expect(trace).toHaveLength(1)
})
