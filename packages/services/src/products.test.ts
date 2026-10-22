import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import { requireDictatingProduct } from "./dental/encounter-dictation.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import { finalizeEncounter, getEncounterClosing, getEncounterDetail } from "./encounters.js"
import { getPatientSummary } from "./patient-history.js"
import { loadPatientRecord } from "./patient-record.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const setProduct = (product: "dental" | "medical") =>
  ownerDb.update(orgProfile).set({ product }).where(eq(orgProfile.organizationId, "org_a"))

it("cada momento de lo común pregunta al producto: una clínica médica no ve nada dental", async () => {
  const f = await clinicalFixture()
  // odentIA: el cierre informa el odontograma y el periodontograma; el resumen,
  // los diagnósticos por pieza y las encías; la copia, el odontograma vigente.
  const dental = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(dental).toHaveProperty("odontogram", null)
  expect(dental).toHaveProperty("periodontal", null)
  expect(await f.run((tx) => getPatientSummary(tx, "org_a", f.patient.id))).toHaveProperty(
    "activeDiagnoses",
    [],
  )
  expect(
    await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, f.encounter.id)),
  ).toHaveProperty("odontogramEntries", [])
  const dentalRecord = await f.run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  expect(dentalRecord.productSections.map((section) => section.title)).toEqual([
    "Odontograma vigente",
  ])

  await setProduct("medical")
  try {
    const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
    expect(closing).not.toHaveProperty("odontogram")
    expect(closing).not.toHaveProperty("periodontal")
    const summary = await f.run((tx) => getPatientSummary(tx, "org_a", f.patient.id))
    expect(summary).not.toHaveProperty("activeDiagnoses")
    expect(summary).not.toHaveProperty("periodontal")
    expect(
      await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, f.encounter.id)),
    ).not.toHaveProperty("odontogramEntries")
    expect(
      (await f.run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))).productSections,
    ).toEqual([])
    // Cerrar sigue igual en lo común, sin nada del odontograma.
    await f.ready(f.encounter.id)
    const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
    expect(closed.encounter.status).toBe("finalizada")
    expect(closed).not.toHaveProperty("odontogram")
  } finally {
    await setProduct("dental")
  }
})

it("el «dónde» lo dice el producto: odentIA guarda la pieza y una clínica médica no", async () => {
  const f = await clinicalFixture()
  await seedDiagnosisCodes([{ code: "K02.1", title: "Caries de la dentina" }])
  const dental = await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
      diagnosisCode: "K02.1",
      diagnosisType: "confirmed",
      toothNumber: 16,
      surfaces: ["occlusal"],
    }),
  )
  // Se guarda como sitio común y la API lo sigue diciendo como pieza y caras.
  expect(dental).toMatchObject({
    siteSystem: "ISO-3950",
    siteCode: "16",
    toothNumber: 16,
    surfaces: ["occlusal"],
  })
  await expect(
    f.run((tx) =>
      addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
        diagnosisCode: "K02.1",
        diagnosisType: "confirmed",
        toothNumber: 19,
      }),
    ),
  ).rejects.toMatchObject({ message: "Pieza FDI inválida: 19" })

  await setProduct("medical")
  try {
    await expect(
      f.run((tx) =>
        addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
          diagnosisCode: "K02.1",
          diagnosisType: "confirmed",
          toothNumber: 16,
        }),
      ),
    ).rejects.toMatchObject({ message: "Esta clínica no registra dónde" })
    const general = await f.run((tx) =>
      addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
        diagnosisCode: "K02.1",
        diagnosisType: "provisional",
      }),
    )
    expect(general).toMatchObject({ siteSystem: null, siteCode: null })
    expect(general).not.toHaveProperty("toothNumber")
  } finally {
    await setProduct("dental")
  }
})

it("Clío dicta solo en clínicas de un producto con su dictado: hoy, odentIA", async () => {
  const f = await clinicalFixture()
  await setProduct("medical")
  try {
    await expect(f.run((tx) => requireDictatingProduct(tx, "org_a"))).rejects.toMatchObject({
      code: "CLINICAL_ASSISTANT_UNAVAILABLE",
      message: "Clío aún no dicta en esta clínica",
    })
  } finally {
    await setProduct("dental")
  }
  await expect(f.run((tx) => requireDictatingProduct(tx, "org_a"))).resolves.toBeUndefined()
})
