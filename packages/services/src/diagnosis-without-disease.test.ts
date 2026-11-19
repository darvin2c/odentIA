import { contact } from "@odentia/db/schema/crm"
import { encounter, encounterDiagnosis, patient, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { orgProfile } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { afterEach, expect, it } from "vitest"
import { clinicalFixture, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import { getDiagnosisSuggestions } from "./diagnosis-codes.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * «Sin enfermedad» (mesa del cierre de la atención, 19 nov 2026): la consulta en la que no hay
 * enfermedad lleva su diagnóstico del capítulo de los factores que motivan la consulta, con un
 * toque, y lo registrado así no queda como problema activo de la persona.
 */
setupTestDb()

afterEach(async () => {
  await ownerDb.update(orgProfile).set({ product: "dental" }).where(eq(orgProfile.organizationId, "org_a"))
})

async function seedLists() {
  await seedDiagnosisCodes([
    { code: "K02.1", title: "Caries de la dentina" },
    { code: "Z01.2", title: "Examen odontológico" },
    { code: "Z71.1", title: "Persona que teme estar enferma, a quien no se hace diagnóstico" },
    { code: "Z09.8", title: "Examen de seguimiento consecutivo a otro tratamiento por otras afecciones" },
    { code: "Z00.0", title: "Examen médico general" },
    { code: "Z00.1", title: "Control de salud de rutina del niño" },
  ])
}

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

const suggestions = (f: Fixture, encounterId = f.encounter.id) =>
  f.run((tx) => getDiagnosisSuggestions(tx, "org_a", { patientId: f.patient.id, encounterId }))

it("primera visita sin nada: «Chequeo» y «Sin hallazgos»; registrado, no queda activo y los atajos se van", async () => {
  await seedLists()
  const f = await clinicalFixture()
  const first = await suggestions(f)
  expect(first.withoutDisease.map((option) => [option.label, option.code, option.description])).toEqual([
    ["Chequeo", "Z01.2", "Examen odontológico"],
    ["Sin hallazgos", "Z71.1", "Persona que teme estar enferma, a quien no se hace diagnóstico"],
  ])
  // Sin tratamientos, el control no sale aunque la lista lo traiga.
  expect(first.withoutDisease.some((option) => option.key === "control")).toBe(false)

  const row = await f.run((tx) =>
    addEncounterDiagnosis(tx, "org_a", f.actor, f.patient.id, f.encounter.id, {
      diagnosisCode: "Z01.2",
      diagnosisType: "confirmed",
    }),
  )
  expect(row.status).toBe("resuelto")
  expect(row.resolvedAt).not.toBeNull()
  expect((await suggestions(f)).withoutDisease).toEqual([])
})

it("con algo activo de otra atención no ofrece «Sin enfermedad»: propone «Sigue activo» con su pieza y su tipo", async () => {
  await seedLists()
  const f = await clinicalFixture()
  // La atención de antes, con la caries de la 24, ya firmada; hoy, otra en borrador.
  await ownerDb.insert(encounterDiagnosis).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    encounterId: f.encounter.id,
    diagnosisSystem: "ICD-10-PE",
    diagnosisCode: "K02.1",
    diagnosisType: "confirmed",
    siteSystem: "ISO-3950",
    siteCode: "24",
    createdBy: f.actor,
  })
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), finalizedBy: f.actor, signerName: "Dra. Prueba", registrationSkipReason: "Prueba" })
    .where(eq(encounter.id, f.encounter.id))
  const [today] = await ownerDb
    .insert(encounter)
    .values({ organizationId: "org_a", patientId: f.patient.id, professionalUserId: f.actor, reason: "Control" })
    .returning()
  if (!today) throw new Error("Sin atención")
  const result = await suggestions(f, today.id)
  expect(result.withoutDisease).toEqual([])
  expect(result.proposed).toEqual([
    expect.objectContaining({ source: "activo", code: "K02.1", toothNumber: 24, diagnosisType: "confirmed" }),
  ])
})

it("ya tuvo un tratamiento: sale también «Control después de un tratamiento»", async () => {
  await seedLists()
  const f = await clinicalFixture()
  await ownerDb.insert(treatmentPlanItem).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    planId: f.plan.id,
    title: "Profilaxis",
    currency: "PEN",
    decisionStatus: "aceptado",
    status: "realizado",
  })
  expect((await suggestions(f)).withoutDisease.map((option) => option.code)).toEqual(["Z01.2", "Z71.1", "Z09.8"])
})

it("latidIA: a un niño de 6 años, el control de salud del niño, no el examen del adulto", async () => {
  await seedLists()
  await ownerDb.update(orgProfile).set({ product: "medical" }).where(eq(orgProfile.organizationId, "org_a"))
  const f = await clinicalFixture()
  const [row] = await ownerDb
    .select({ personId: patient.personId })
    .from(patient)
    .where(and(eq(patient.organizationId, "org_a"), eq(patient.id, f.patient.id)))
  if (!row) throw new Error("Sin paciente")
  const sixYearsAgo = new Date()
  sixYearsAgo.setUTCFullYear(sixYearsAgo.getUTCFullYear() - 6)
  await ownerDb
    .update(contact)
    .set({ birthDate: sixYearsAgo.toISOString().slice(0, 10) })
    .where(and(eq(contact.organizationId, "org_a"), eq(contact.id, row.personId)))
  expect((await suggestions(f)).withoutDisease.map((option) => [option.label, option.code])).toEqual([
    ["Control de salud del niño", "Z00.1"],
    ["Sin hallazgos", "Z71.1"],
  ])
})
