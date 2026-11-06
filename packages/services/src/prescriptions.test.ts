import { randomUUID } from "node:crypto"
import { user } from "@odentia/db/schema/auth"
import { patientAllergy, patientMedication } from "@odentia/db/schema/clinical"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { addClinicalNote } from "./clinical.js"
import { clinicalFixture, makeSigner } from "./clinical-test-fixture.js"
import { createClinicalOrder } from "./clinical-forms.js"
import { takeOverEncounter } from "./encounters.js"
import { createMedicalLeave } from "./medical-leaves.js"
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
  // Si la pantalla dice lo que mostró y falta el aviso de alergia, no se emite: se muestra (ADR 0143).
  await expect(
    f.run((tx) => createPrescription(tx, ...f.args, { alertsShown: [], items: [{ ...base, genericName: "amoxicilina" }] })),
  ).rejects.toMatchObject({ code: "ALLERGY_CONFLICT" })
  // Visto el aviso, se receta sin escribir nada (ADR 0143): la receta guarda el aviso que vio.
  const seen = await f.run((tx) =>
    createPrescription(tx, ...f.args, {
      acknowledgeAllergies: true,
      allergyOverrideReason: "  ",
      items: [{ ...base, genericName: "amoxicilina" }],
    }),
  )
  expect(seen.allergyOverrideReason).toBeNull()
  expect(seen.alertsSeen).toEqual([expect.stringMatching(/^Amoxicilina: alergia severa a /)])
  // Con motivo, queda además el motivo.
  const confirmed = await f.run((tx) =>
    createPrescription(tx, ...f.args, {
      acknowledgeAllergies: true,
      allergyOverrideReason: "Tolera amoxicilina desde hace años; lo de la penicilina fue un malestar",
      items: [{ ...base, genericName: "amoxicilina" }],
    }),
  )
  expect(confirmed.items[0]).toMatchObject({ genericName: "amoxicilina", atcCode: "J01CA04" })
  expect(confirmed.allergyOverrideReason).toMatch(/^Tolera amoxicilina/)
  // Sin aviso no queda motivo, aunque se mande.
  const plain = await f.run((tx) =>
    createPrescription(tx, ...f.args, {
      allergyOverrideReason: "no aplica",
      items: [{ ...base, genericName: "paracetamol" }],
    }),
  )
  expect(plain.allergyOverrideReason).toBeNull()
  expect(plain.alertsSeen).toBeNull()
})

it("lo que ya toma, o dos veces lo mismo en la receta, se avisa por su código ATC y no frena (X2)", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(patientMedication).values({ organizationId: "org_a", patientId: f.patient.id, name: "Ibuprofeno 400 mg", genericName: "ibuprofeno", atcCode: "M01AE01" })
  const base = { strength: "50 mg", dosageForm: "tableta", dose: "1 tableta", route: "oral", frequency: "Cada 12 horas", duration: "3 días" }
  const duplicate = "Diclofenaco: ya toma Ibuprofeno 400 mg, del mismo grupo (antiinflamatorios no esteroideos)."
  // Sin pedir nada: el duplicado solo informa; queda como visto si la pantalla lo mostró.
  const issued = await f.run((tx) =>
    createPrescription(tx, ...f.args, {
      alertsShown: [duplicate],
      items: [{ ...base, genericName: "diclofenaco" }, { ...base, genericName: "paracetamol", strength: "500 mg" }],
    }),
  )
  expect(issued.alertsSeen).toEqual([duplicate])
  // Lo que no se mostró (otro cliente, el dictado sin el aviso) no se firma como visto.
  const notShown = await f.run((tx) => createPrescription(tx, ...f.args, { items: [{ ...base, genericName: "diclofenaco" }] }))
  expect(notShown.alertsSeen).toBeNull()
  // Lo que ya no toma (con fecha de fin pasada) no cuenta.
  await ownerDb.update(patientMedication).set({ endDate: "2020-01-01" }).where(eq(patientMedication.patientId, f.patient.id))
  const later = await f.run((tx) => createPrescription(tx, ...f.args, { items: [{ ...base, genericName: "diclofenaco" }] }))
  expect(later.alertsSeen).toBeNull()
})

it("avisa por el código de la alergia, se haya escrito como se haya escrito", async () => {
  const f = await clinicalFixture()
  // Elegida de la lista (grupo ATC) y escrita en mayúsculas: las dos avisan igual.
  await ownerDb.insert(patientAllergy).values([
    { organizationId: "org_a", patientId: f.patient.id, substance: "Penicilinas (grupo)", substanceSystem: "atc", substanceCode: "J01C", severity: "severa" },
  ])
  const base = {
    strength: "500 mg",
    dosageForm: "cápsula",
    dose: "1 cápsula",
    route: "oral",
    frequency: "Cada 8 horas",
    duration: "7 días",
  }
  for (const genericName of ["amoxicilina", "ampicilina", "cefalexina"]) {
    await expect(
      f.run((tx) => createPrescription(tx, ...f.args, { items: [{ ...base, genericName }] })),
      genericName,
    ).rejects.toMatchObject({ code: "ALLERGY_CONFLICT" })
  }
  // Otro grupo no avisa.
  await expect(
    f.run((tx) => createPrescription(tx, ...f.args, { items: [{ ...base, genericName: "clindamicina" }] })),
  ).resolves.toMatchObject({ status: "emitida" })
})

it("otro profesional no escribe dentro de la atención ajena sin tomar el relevo: ni receta, ni nota, ni plan (ADR 0002)", async () => {
  const f = await clinicalFixture()
  const other = randomUUID()
  await ownerDb.insert(user).values({ id: other, name: "Otro clínico", email: `${other}@example.test` })
  await makeSigner("org_a", other)
  const item = {
    genericName: "paracetamol",
    strength: "500 mg",
    dosageForm: "tableta",
    dose: "Dosis prescrita",
    route: "oral",
    frequency: "Según indicación clínica",
    duration: "Duración prescrita",
    quantity: 2,
  }
  const asOther = ["org_a", other, f.patient.id] as const
  await expect(f.run((tx) => createPrescription(tx, ...asOther, { encounterId: f.encounter.id, items: [item] }))).rejects.toMatchObject({ code: "NOT_ATTENDING" })
  await expect(f.run((tx) => addClinicalNote(tx, ...asOther, { note: "Nota ajena", encounterId: f.encounter.id }))).rejects.toMatchObject({ code: "NOT_ATTENDING" })
  await expect(
    f.run((tx) => addPlanItem(tx, ...asOther, { planId: f.plan.id, serviceId: f.service.id, sourceEncounterId: f.encounter.id })),
  ).rejects.toMatchObject({ code: "NOT_ATTENDING" })
  // Lo mismo con el descanso médico y la orden, que se escriben dentro de la atención.
  await expect(
    f.run((tx) => createMedicalLeave(tx, ...asOther, { days: 2, encounterId: f.encounter.id })),
  ).rejects.toMatchObject({ code: "NOT_ATTENDING" })
  await expect(
    f.run((tx) =>
      createClinicalOrder(tx, "org_a", other, { kind: "imagen", patientId: f.patient.id, encounterId: f.encounter.id, recipient: "Centro de imágenes", title: "Radiografía" }),
    ),
  ).rejects.toMatchObject({ code: "NOT_ATTENDING" })
  // Sin unirla a la atención, o tras tomar el relevo, sí.
  await expect(f.run((tx) => createPrescription(tx, ...asOther, { items: [item] }))).resolves.toMatchObject({ status: "emitida" })
  await f.run((tx) => takeOverEncounter(tx, "org_a", other, f.patient.id, f.encounter.id))
  await expect(f.run((tx) => createPrescription(tx, ...asOther, { encounterId: f.encounter.id, items: [item] }))).resolves.toMatchObject({ encounterId: f.encounter.id })
})
