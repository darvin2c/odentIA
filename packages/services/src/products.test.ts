import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import {
  finalizeEncounter,
  getEncounterClosing,
  getEncounterDetail,
  type UpdateEncounterDraftPatch,
  updateEncounterDraft,
} from "./encounters.js"
import { getPatientSummary } from "./patient-history.js"
import { loadPatientRecord, patientRecordFhirBundle } from "./patient-record.js"
import { requireDictatingProduct } from "./products.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { listPatientVitals } from "./vitals-history.js"

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

it("el examen y los signos vitales los pone el producto: la boca en odentIA, los sistemas en latidIA (issue 229)", async () => {
  const f = await clinicalFixture()
  const draft = (patch: UpdateEncounterDraftPatch) =>
    f.run((tx) => updateEncounterDraft(tx, ...f.args, f.encounter.id, patch))
  // odentIA: el examen de la boca y los ocho signos de siempre.
  await expect(draft({ examination: { sistemas: { piel: { estado: "sin_alteraciones" } } } })).rejects.toThrow(
    /no es un campo válido/,
  )
  await expect(draft({ vitals: { glucosaCapilar: 110 } })).rejects.toThrow(/Signo vital desconocido/)

  await setProduct("medical")
  try {
    await expect(draft({ examination: { extraoral: { atm: "Sin alteraciones" } } })).rejects.toThrow(
      /no tiene el campo extraoral/,
    )
    const saved = await draft({
      examination: {
        sistemas: {
          bocaGarganta: { estado: "con_hallazgos", hallazgo: " Amígdalas con placas " },
          corazon: { estado: "sin_alteraciones" },
        },
      },
      vitals: { presionSistolica: 118, presionDiastolica: 76, peso: 62, talla: 160, glucosaCapilar: 110 },
    })
    expect(saved.examination).toEqual({
      sistemas: {
        bocaGarganta: { estado: "con_hallazgos", hallazgo: "Amígdalas con placas" },
        corazon: { estado: "sin_alteraciones" },
      },
    })

    // La copia dice lo no examinado; FHIR lo exporta sin valor y con «not-performed».
    const record = await f.run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
    const mine = record.encounters.find((entry) => entry.row.id === f.encounter.id)
    expect(mine?.exam.lines).toEqual([
      "Boca y garganta: Amígdalas con placas",
      "Sin alteraciones: Corazón",
      "No examinado: Estado general, Piel, Cabeza y cuello, Tórax y pulmones, Abdomen, Genital y urinario, Extremidades, Neurológico",
    ])
    const bundle = patientRecordFhirBundle(record) as { entry: Array<{ resource: Record<string, unknown> }> }
    const byId = (id: string) => bundle.entry.map((entry) => entry.resource).find((resource) => resource.id === id)
    expect(byId(`${f.encounter.id}-examen-abdomen`)).toMatchObject({
      category: [{ coding: [{ code: "exam" }] }],
      dataAbsentReason: { coding: [{ code: "not-performed" }] },
    })
    expect(byId(`${f.encounter.id}-examen-bocaGarganta`)).toMatchObject({
      valueString: "Amígdalas con placas",
      interpretation: [{ coding: [{ code: "A" }] }],
    })
    expect(byId(`${f.encounter.id}-glucosaCapilar`)).toMatchObject({
      code: { coding: [{ code: "41653-7" }] },
      valueQuantity: { value: 110, code: "mg/dL" },
    })

    // La sección «Signos vitales» los lee en el tiempo, con la atención en curso.
    const readings = await f.run((tx) => listPatientVitals(tx, "org_a", f.patient.id))
    expect(readings.at(-1)).toMatchObject({
      encounterId: f.encounter.id,
      status: "borrador",
      vitals: { presionSistolica: 118, glucosaCapilar: 110 },
    })
  } finally {
    await setProduct("dental")
  }
})
