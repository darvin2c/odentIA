import { contact } from "@odentia/db/schema/crm"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { addPatientAllergy } from "../allergies.js"
import { getPatientHealth, savePatientHealth } from "../clinical.js"
import { clinicalFixture } from "../clinical-test-fixture.js"
import { clinicToday } from "../inventory-stock.js"
import { createPrescription, type PrescriptionMedicationInput } from "../prescriptions.js"
import { ownerDb, setupTestDb } from "../test-setup.js"

setupTestDb()

const setProduct = (product: "dental" | "medical") =>
  ownerDb.update(orgProfile).set({ product }).where(eq(orgProfile.organizationId, "org_a"))

const medication = (genericName: string): PrescriptionMedicationInput => ({
  genericName,
  strength: "10 mg",
  dosageForm: "tableta",
  dose: "1 tableta",
  route: "oral",
  frequency: "cada 24 horas",
  duration: "30 días",
})

it("la receta de latidIA: controlados, embarazo, peso de un niño y alergias de medicina general (issue 229)", async () => {
  const f = await clinicalFixture()
  const prescribe = (
    input: Partial<Parameters<typeof createPrescription>[4]> & {
      items: PrescriptionMedicationInput[]
    },
  ) => f.run((tx) => createPrescription(tx, ...f.args, input))

  // odentIA, como siempre: ni el controlado ni el peso son reglas suyas.
  const dental = await prescribe({ items: [medication("clonazepam")] })
  expect(dental.patientWeightKg).toBeNull()

  await setProduct("medical")
  try {
    // Un controlado no sale en la receta común.
    await expect(prescribe({ items: [medication("clonazepam")] })).rejects.toThrow(/receta oficial/)

    // Embarazada: lo contraindicado va con motivo, como una alergia.
    const today = await f.run((tx) => clinicToday(tx, "org_a"))
    const health = await f.run((tx) => getPatientHealth(tx, "org_a", f.patient.id))
    await f.run((tx) =>
      savePatientHealth(tx, "org_a", f.actor, f.patient.id, {
        expectedRevision: health.revision,
        reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "unknown" },
        conditions: [],
        medications: [],
        anamnesis: {
          expectedVersion: 0,
          answers: { embarazoLactancia: { embarazo: { estado: "si", fecha: today, semanas: 12 } } },
        },
      }),
    )
    await expect(prescribe({ items: [medication("enalapril")] })).rejects.toThrow(
      /IECA están contraindicados/,
    )
    const withReason = await prescribe({
      items: [medication("enalapril")],
      acknowledgeAllergies: true,
      allergyOverrideReason: "Hipertensión grave; lo decide con su obstetra",
    })
    expect(withReason.allergyOverrideReason).toBe("Hipertensión grave; lo decide con su obstetra")
    expect(withReason.items[0]?.atcCode).toBe("C09AA02")

    // Alérgica a las fluoroquinolonas: el grupo es de la lista de latidIA y el ciprofloxacino avisa.
    await f.run((tx) =>
      addPatientAllergy(tx, ...f.args, {
        substanceSystem: "atc",
        substanceCode: "J01MA",
        severity: "moderada",
      }),
    )
    await expect(prescribe({ items: [medication("ciprofloxacino")] })).rejects.toThrow(
      /fluoroquinolonas/,
    )

    // Un niño de 5 años: la receta va con su peso.
    const fiveYearsAgo = `${Number(today.slice(0, 4)) - 5}${today.slice(4)}`
    await ownerDb
      .update(contact)
      .set({ birthDate: fiveYearsAgo })
      .where(eq(contact.id, f.patient.personId))
    await expect(prescribe({ items: [medication("paracetamol")] })).rejects.toThrow(
      /escribe su peso/,
    )
    const child = await prescribe({ items: [medication("paracetamol")], patientWeightKg: 18.46 })
    expect(child.patientWeightKg).toBe("18.5")
  } finally {
    await setProduct("dental")
  }
})
