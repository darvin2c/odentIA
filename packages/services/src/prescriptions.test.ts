import { patientAllergy } from "@odentia/db/schema/clinical"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import { cancelPrescription, createPrescription, getPrescriptionDetail } from "./prescriptions.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()
it("anula la receta sin alterar los dos medicamentos emitidos", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      planId: f.plan.id,
      serviceId: f.service.id,
      sourceEncounterId: f.encounter.id,
    }),
  )
  const items = ["paracetamol", "clorhexidina"].map((genericName) => ({
    genericName,
    strength: "500 mg",
    dosageForm: "tableta",
    dose: "Dosis prescrita",
    route: "oral",
    frequency: "Según indicación clínica",
    duration: "Duración prescrita",
    quantity: 2,
  }))
  const emitted = await f.run((tx) =>
    createPrescription(tx, ...f.args, { encounterId: f.encounter.id, planItemId: item.id, items }),
  )
  const cancelled = await f.run((tx) =>
    cancelPrescription(tx, ...f.args, emitted.id, { reason: "Corrección de prescripción" }),
  )
  expect(cancelled).toMatchObject({
    status: "anulada",
    cancelReason: "Corrección de prescripción",
    planItemId: item.id,
    encounterId: f.encounter.id,
  })
  expect(cancelled.items.map((i) => i.medicationName).sort()).toEqual([
    "clorhexidina 500 mg tableta",
    "paracetamol 500 mg tableta",
  ])
  // La receta guarda la firma de quien prescribe.
  expect(cancelled.prescriberRegistration).toBe("COP 12345")
  expect(
    (await f.run((tx) => getPrescriptionDetail(tx, "org_a", f.patient.id, emitted.id))).items,
  ).toEqual(cancelled.items)
  await expect(
    f.run((tx) => cancelPrescription(tx, ...f.args, emitted.id, { reason: "Otra corrección" })),
  ).rejects.toMatchObject({ status: 409 })
})

it("exige DCI y vía reconocida, y avisa la alergia antes de prescribir", async () => {
  const f = await clinicalFixture()
  await ownerDb
    .insert(patientAllergy)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      substance: "Penicilina",
      severity: "severa",
    })
  const base = {
    strength: "500 mg",
    dosageForm: "cápsula",
    dose: "1 cápsula",
    route: "oral",
    frequency: "Cada 8 horas",
    duration: "7 días",
    quantity: 21,
  }
  await expect(
    f.run((tx) => createPrescription(tx, ...f.args, { items: [{ ...base, genericName: " " }] })),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    f.run((tx) =>
      createPrescription(tx, ...f.args, {
        items: [{ ...base, genericName: "amoxicilina", route: "Oral" }],
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    f.run((tx) =>
      createPrescription(tx, ...f.args, { items: [{ ...base, genericName: "amoxicilina" }] }),
    ),
  ).rejects.toMatchObject({ code: "ALLERGY_CONFLICT" })
  const confirmed = await f.run((tx) =>
    createPrescription(tx, ...f.args, {
      acknowledgeAllergies: true,
      items: [{ ...base, genericName: "amoxicilina" }],
    }),
  )
  expect(confirmed.items[0]).toMatchObject({ genericName: "amoxicilina", atcCode: "J01CA04" })
})
