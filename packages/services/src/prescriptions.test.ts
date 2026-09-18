import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import { cancelPrescription, createPrescription, getPrescriptionDetail } from "./prescriptions.js"
import { setupTestDb } from "./test-setup.js"
setupTestDb()
it("anula la receta sin alterar los dos medicamentos emitidos", async () => {
  const f = await clinicalFixture()
  const item = await f.run(tx => addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: f.service.id, sourceEncounterId: f.encounter.id }))
  const items = ["Medicamento A", "Medicamento B"].map(medicationName => ({ medicationName, dose: "Dosis prescrita", route: "Oral", frequency: "Según indicación clínica", duration: "Duración prescrita", quantity: 2 }))
  const emitted = await f.run(tx => createPrescription(tx, ...f.args, { encounterId: f.encounter.id, planItemId: item.id, items }))
  const cancelled = await f.run(tx => cancelPrescription(tx, ...f.args, emitted.id, { reason: "Corrección de prescripción" }))
  expect(cancelled).toMatchObject({ status: "anulada", cancelReason: "Corrección de prescripción", planItemId: item.id, encounterId: f.encounter.id })
  expect(cancelled.items.map(i => i.medicationName).sort()).toEqual(["Medicamento A", "Medicamento B"])
  expect((await f.run(tx => getPrescriptionDetail(tx, "org_a", f.patient.id, emitted.id))).items).toEqual(cancelled.items)
  await expect(f.run(tx => cancelPrescription(tx, ...f.args, emitted.id, { reason: "Otra corrección" }))).rejects.toMatchObject({ status: 409 })
})
