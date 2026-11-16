import { clinicalFormResponse, clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { encounterDiagnosis } from "@odentia/db/schema/clinical"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import { DENTAL_FORMS } from "./dental/forms.js"
import { getDiagnosisSuggestions } from "./diagnosis-codes.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import { getTimeline } from "./patient-history.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Estudio de la atención del 16 nov (E10b, B1 y B1b): la ficha de endodoncia llenada a mano dice
 * «Pulpitis irreversible sintomática» y «Periodontitis apical sintomática» en la 36, y la atención
 * solo tenía K04.0. Ahora la ficha lo propone con «Usar», nada entra solo, y la Historia dice el
 * término de la ficha junto al código.
 */
setupTestDb()

it("la ficha de endodoncia propone K04.0 y K04.4 en la 36; proponer no registra, y la Historia lee el término de la ficha", async () => {
  await seedDiagnosisCodes([
    { code: "K04", title: "Enfermedades de la pulpa y de los tejidos periapicales", isCategory: true },
    { code: "K04.0", title: "Pulpitis" },
    { code: "K04.4", title: "Periodontitis apical aguda originada en la pulpa" },
  ])
  const f = await clinicalFixture()
  const endodontics = DENTAL_FORMS.suggestions.find((form) => form.kind === "endodoncia")
  if (!endodontics) throw new Error("Sin la ficha de endodoncia")
  const [template] = await ownerDb
    .insert(clinicalFormTemplate)
    .values({
      organizationId: "org_a",
      key: endodontics.key,
      title: endodontics.title,
      status: "publicado",
      schema: endodontics.schema,
      publishedAt: new Date(),
    })
    .returning()
  if (!template) throw new Error("Sin plantilla")
  await ownerDb.insert(clinicalFormResponse).values({
    organizationId: "org_a",
    templateId: template.id,
    templateVersion: template.version,
    templateSnapshot: template.schema,
    templateTitle: template.title,
    patientId: f.patient.id,
    encounterId: f.encounter.id,
    answers: { pieza: 36, diagnostico_pulpar: "Pulpitis irreversible sintomática", diagnostico_apical: "Periodontitis apical sintomática" },
  })
  const suggestions = () => f.run((tx) => getDiagnosisSuggestions(tx, "org_a", { patientId: f.patient.id, encounterId: f.encounter.id }))

  const before = await suggestions()
  expect(before.fromForms.map(({ code, qualifier, toothNumber, registered }) => ({ code, qualifier, toothNumber, registered }))).toEqual([
    { code: "K04.0", qualifier: "irreversible sintomática", toothNumber: 36, registered: false },
    { code: "K04.4", qualifier: "sintomática", toothNumber: 36, registered: false },
  ])
  // También en el paso 1 del Diagnóstico, definitivas: es lo que concluyó quien llenó la ficha.
  expect(before.proposed.filter((item) => item.source === "ficha").map(({ code, diagnosisType }) => ({ code, diagnosisType }))).toEqual([
    { code: "K04.0", diagnosisType: "confirmed" },
    { code: "K04.4", diagnosisType: "confirmed" },
  ])
  // B1b: sin «Usar», nada cambió solo.
  expect(await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, f.encounter.id))).toEqual([])

  // B1: «Usar» la pulpitis la registra; la ficha dice que ya está y deja de proponerla en el Diagnóstico.
  await f.run((tx) => addEncounterDiagnosis(tx, ...f.args, f.encounter.id, { diagnosisCode: "K04.0", diagnosisType: "confirmed", toothNumber: 36 }))
  const after = await suggestions()
  expect(after.fromForms.map(({ code, registered }) => ({ code, registered }))).toEqual([
    { code: "K04.0", registered: true },
    { code: "K04.4", registered: false },
  ])
  expect(after.proposed.filter((item) => item.source === "ficha").map((item) => item.code)).toEqual(["K04.4"])

  // La Historia dice el término de la ficha junto al código, con su pieza y su tipo.
  const timeline = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["encounter"] }))
  const lines = timeline.data.find((item) => item.refId === f.encounter.id)?.diagnoses ?? []
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatch(/^Pulpitis \(.*K04\.0\) · irreversible sintomática · pieza 36 · definitivo$/)
})
