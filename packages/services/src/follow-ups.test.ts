import { encounter } from "@odentia/db/schema/clinical"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { completeFollowUp, createFollowUp, listFollowUps, scheduleFollowUp } from "./follow-ups.js"
import { addPlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()
it("una cita sin asistencia no completa el control y exige atención finalizada", async () => {
  const f = await clinicalFixture()
  const item = await f.run(tx => addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: f.service.id, sourceEncounterId: f.encounter.id }))
  const dueAt = new Date(Date.now() + 86400000).toISOString()
  const followUp = await f.run(tx => createFollowUp(tx, ...f.args, { planItemId: item.id, kind: "tratamiento", title: "Control clínico", dueAt, originEncounterId: f.encounter.id }))
  await f.run(tx => scheduleFollowUp(tx, ...f.args, followUp.id, { scheduledAt: dueAt }))
  expect((await f.run(tx => listFollowUps(tx, "org_a", f.patient.id)))[0].status).toBe("programado")
  await expect(f.run(tx => completeFollowUp(tx, ...f.args, followUp.id, { encounterId: f.encounter.id, outcome: "Evolución favorable" }))).rejects.toMatchObject({ code: "ENCOUNTER_NOT_FINALIZED" })
  await ownerDb.update(encounter).set({ status: "finalizada", finalizedAt: new Date() }).where(eq(encounter.id, f.encounter.id))
  expect(await f.run(tx => completeFollowUp(tx, ...f.args, followUp.id, { encounterId: f.encounter.id, outcome: "Evolución favorable" }))).toMatchObject({ status: "realizado", completedEncounterId: f.encounter.id, outcome: "Evolución favorable" })
})
