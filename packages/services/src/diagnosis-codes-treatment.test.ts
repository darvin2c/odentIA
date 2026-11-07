import { randomUUID } from "node:crypto"
import { appointment } from "@odentia/db/schema/agenda"
import {
  clinicalFollowUp,
  encounter,
  encounterDiagnosis,
  encounterPlanItem,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { afterEach, expect, it } from "vitest"
import { createRoom } from "./appointments.js"
import { clinicalFixture, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import { getDiagnosisSuggestions } from "./diagnosis-codes.js"
import { addEncounterDiagnosis, voidEncounterDiagnosis } from "./encounter-diagnoses.js"
import { createEncounter, finalizeEncounter, updateEncounterDraft, voidEncounter } from "./encounters.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * En una sesión o un control el diagnóstico ya está en el tratamiento: se
 * ofrece con su origen y el tipo de la última vez, y nunca entra solo.
 */
setupTestDb()

afterEach(async () => {
  await ownerDb.update(orgProfile).set({ product: "dental" }).where(eq(orgProfile.organizationId, "org_a"))
})

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

async function seedLists() {
  await seedDiagnosisCodes([
    { code: "K02.1", title: "Caries de la dentina" },
    // Con subcódigos: «K04» queda como categoría y no se propone.
    { code: "K04", title: "Enfermedades de la pulpa y de los tejidos periapicales" },
    { code: "K04.0", title: "Pulpitis" },
    { code: "K04.1", title: "Necrosis de la pulpa" },
  ])
  await seedDiagnosisCodes([{ code: "DA08.0", title: "Caries dental" }], "ICD-11")
}

/** Un tratamiento de la persona con su diagnóstico y, si la tiene, su pieza. */
async function treatment(
  f: Fixture,
  input: { title: string; code: string | null; system?: string; tooth?: number | null },
) {
  const [row] = await ownerDb
    .insert(treatmentPlanItem)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      planId: f.plan.id,
      title: input.title,
      currency: "PEN",
      decisionStatus: "aceptado",
      status: "en_curso",
      diagnosisSystem: input.code ? (input.system ?? "ICD-10-PE") : null,
      diagnosisCode: input.code,
      siteSystem: input.tooth ? "ISO-3950" : null,
      siteCode: input.tooth ? String(input.tooth) : null,
    })
    .returning()
  if (!row) throw new Error("Sin tratamiento")
  return row
}

/** Une el tratamiento a la atención, como al traerlo de su cita. */
const join = (f: Fixture, planItemId: string, encounterId = f.encounter.id) =>
  ownerDb.insert(encounterPlanItem).values({ organizationId: "org_a", encounterId, planItemId })

/** Una cita para la atención del fixture, que queda unida a ella. */
async function visitFor(f: Fixture) {
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${randomUUID().slice(0, 6)}`, timezone: "America/Lima" })
    .returning()
  if (!site) throw new Error("Sin sede")
  const room = await f.run((tx) => createRoom(tx, "org_a", { branchId: site.id, name: "Unidad dental" }))
  const startsAt = new Date(Date.now() + 3_600_000)
  const [visit] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: "org_a",
      branchId: site.id,
      patientId: f.patient.id,
      professionalUserId: f.actor,
      roomId: room.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
      status: "confirmada",
    })
    .returning()
  if (!visit) throw new Error("Sin cita")
  await ownerDb.update(encounter).set({ appointmentId: visit.id }).where(eq(encounter.id, f.encounter.id))
  return visit
}

const suggestions = (f: Fixture, encounterId = f.encounter.id) =>
  f.run((tx) => getDiagnosisSuggestions(tx, "org_a", { patientId: f.patient.id, encounterId }))

it("el tratamiento unido a la atención y el del control de su cita proponen su diagnóstico, sin categorías ni otra lista", async () => {
  await seedLists()
  const f = await clinicalFixture()
  const endo = await treatment(f, { title: "Endodoncia posterior vital", code: "K04.0", tooth: 46 })
  const category = await treatment(f, { title: "Pulpotomía", code: "K04", tooth: 36 })
  const otherList = await treatment(f, { title: "Resina en otra lista", code: "DA08.0", system: "ICD-11", tooth: 26 })
  const noCode = await treatment(f, { title: "Profilaxis", code: null })
  for (const item of [endo, category, otherList, noCode]) await join(f, item.id)
  // El control reservado con la cita de la atención trae su tratamiento.
  const resin = await treatment(f, { title: "Resina compuesta", code: "K02.1", tooth: 16 })
  const visit = await visitFor(f)
  await ownerDb.insert(clinicalFollowUp).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    planItemId: resin.id,
    kind: "tratamiento",
    title: "Control de la resina",
    dueAt: visit.startsAt,
    status: "programado",
    appointmentId: visit.id,
  })
  // Uno cancelado no cuenta, aunque siga unido a la cita.
  const cancelled = await treatment(f, { title: "Endodoncia cancelada", code: "K04.1", tooth: 11 })
  await ownerDb.insert(clinicalFollowUp).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    planItemId: cancelled.id,
    kind: "tratamiento",
    title: "Control cancelado",
    dueAt: visit.startsAt,
    status: "cancelado",
    appointmentId: visit.id,
  })

  const { proposed } = await suggestions(f)
  expect(proposed).toEqual([
    expect.objectContaining({
      system: "ICD-10-PE",
      code: "K04.0",
      description: "Pulpitis",
      source: "tratamiento",
      finding: "Endodoncia posterior vital · 46",
      diagnosisType: null,
      toothNumber: 46,
    }),
    expect.objectContaining({
      code: "K02.1",
      source: "tratamiento",
      finding: "Resina compuesta · 16",
      diagnosisType: null,
      toothNumber: 16,
    }),
  ])
  // Proponer no registra nada: la atención sigue sin diagnósticos.
  expect(await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, f.encounter.id))).toEqual([])
})

it("trae el tipo de la última vez que se registró ese código y deja de proponerlo cuando ya está en la atención", async () => {
  await seedLists()
  const f = await clinicalFixture()
  // La primera consulta: la pulpitis de la 46 quedó presuntiva, se corrigió a definitiva, y se firmó.
  const first = await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, { diagnosisCode: "K04.0", diagnosisType: "provisional", toothNumber: 46 }),
  )
  await f.run((tx) =>
    voidEncounterDiagnosis(tx, ...f.args, f.encounter.id, first.id, { reason: "Se confirmó con la radiografía" }),
  )
  await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, { diagnosisCode: "K04.0", diagnosisType: "confirmed", toothNumber: 46 }),
  )
  await f.run((tx) => updateEncounterDraft(tx, ...f.args, f.encounter.id, { evolution: "Se indicó la endodoncia." }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  // La sesión siguiente continúa los tratamientos.
  const session = await f.run((tx) => createEncounter(tx, ...f.args, {}))
  const endo = await treatment(f, { title: "Endodoncia posterior vital", code: "K04.0", tooth: 46 })
  const resin = await treatment(f, { title: "Resina compuesta", code: "K02.1", tooth: 16 })
  await join(f, endo.id, session.id)
  await join(f, resin.id, session.id)

  const withType = await suggestions(f, session.id)
  expect(withType.proposed.map((item) => [item.code, item.diagnosisType])).toEqual([
    ["K04.0", "confirmed"],
    ["K02.1", null],
  ])
  // Proponer no registra nada.
  expect(await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, session.id))).toEqual([])

  // «Usar» es el alta de siempre: con eso, la pulpitis de la 46 ya no se propone.
  await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, session.id, {
      diagnosisCode: "K04.0",
      diagnosisType: "confirmed",
      toothNumber: 46,
    }),
  )
  expect((await suggestions(f, session.id)).proposed.map((item) => item.code)).toEqual(["K02.1"])
})

it("latidIA recibe solo lo que propone el tratamiento, sin pieza", async () => {
  await seedLists()
  const f = await clinicalFixture()
  await seedDiagnosisCodes([
    { code: "I10", title: "Hipertensión esencial (primaria)" },
    { code: "I10.X", title: "Hipertensión esencial (primaria)" },
  ])
  const control = await treatment(f, { title: "Control de presión", code: "I10.X" })
  await join(f, control.id)
  await ownerDb.update(orgProfile).set({ product: "medical" }).where(eq(orgProfile.organizationId, "org_a"))
  const { proposed } = await suggestions(f)
  expect(proposed).toEqual([
    expect.objectContaining({ code: "I10.X", source: "tratamiento", finding: "Control de presión", diagnosisType: null }),
  ])
  expect(proposed[0]).not.toHaveProperty("toothNumber")
})

it("un tratamiento cancelado o reemplazado no propone su diagnóstico", async () => {
  await seedLists()
  const f = await clinicalFixture()
  const endo = await treatment(f, { title: "Endodoncia posterior vital", code: "K04.0", tooth: 46 })
  const cancelled = await treatment(f, { title: "Resina cancelada", code: "K02.1", tooth: 16 })
  const replaced = await treatment(f, { title: "Necropulpectomía reemplazada", code: "K04.1", tooth: 36 })
  await ownerDb.update(treatmentPlanItem).set({ status: "cancelado" }).where(eq(treatmentPlanItem.id, cancelled.id))
  await ownerDb.update(treatmentPlanItem).set({ status: "reemplazado" }).where(eq(treatmentPlanItem.id, replaced.id))
  for (const item of [endo, cancelled, replaced]) await join(f, item.id)
  expect((await suggestions(f)).proposed.map((item) => item.finding)).toEqual(["Endodoncia posterior vital · 46"])
})

it("el tipo de la última vez es el del mismo código en la misma pieza, sin contar atenciones anuladas", async () => {
  await seedLists()
  const f = await clinicalFixture()
  // Lo firmado: la caries de la 26 definitiva, la pulpitis sin pieza presuntiva y la necrosis sin pieza definitiva.
  for (const input of [
    { diagnosisCode: "K02.1", diagnosisType: "confirmed", toothNumber: 26 },
    { diagnosisCode: "K04.0", diagnosisType: "provisional" },
    { diagnosisCode: "K04.1", diagnosisType: "confirmed" },
  ])
    await f.run((tx) => addEncounterDiagnosis(tx, ...f.args, f.encounter.id, input))
  await f.run((tx) => updateEncounterDraft(tx, ...f.args, f.encounter.id, { evolution: "Se indicó el plan." }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  // Una atención anulada: lo que tenía no cuenta.
  const voided = await f.run((tx) => createEncounter(tx, ...f.args, {}))
  for (const input of [
    { diagnosisCode: "K02.1", diagnosisType: "provisional", toothNumber: 16 },
    { diagnosisCode: "K04.1", diagnosisType: "provisional" },
  ])
    await f.run((tx) => addEncounterDiagnosis(tx, ...f.args, voided.id, input))
  await f.run((tx) => voidEncounter(tx, ...f.args, voided.id, { reason: "Se abrió por error" }))

  const session = await f.run((tx) => createEncounter(tx, ...f.args, {}))
  for (const input of [
    { title: "Resina de la 16", code: "K02.1", tooth: 16 },
    { title: "Resina de la 26", code: "K02.1", tooth: 26 },
    { title: "Endodoncia de la 46", code: "K04.0", tooth: 46 },
    { title: "Control de la necrosis", code: "K04.1", tooth: null },
  ]) {
    const item = await treatment(f, input)
    await join(f, item.id, session.id)
  }
  const types = Object.fromEntries((await suggestions(f, session.id)).proposed.map((item) => [item.finding, item.diagnosisType]))
  expect(types).toEqual({
    // En la 16 solo estaba en la atención anulada.
    "Resina de la 16 · 16": null,
    "Resina de la 26 · 26": "confirmed",
    // La pulpitis sin pieza no dice el tipo de la 46.
    "Endodoncia de la 46 · 46": null,
    // Sin pieza, la definitiva firmada; no la presuntiva de la anulada.
    "Control de la necrosis": "confirmed",
  })
})

it("un tratamiento por cuadrante propone su diagnóstico con el cuadrante, y al usarlo deja de proponerlo", async () => {
  await seedLists()
  const f = await clinicalFixture()
  const [scaling] = await ownerDb
    .insert(treatmentPlanItem)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      planId: f.plan.id,
      title: "Destartraje por cuadrante",
      currency: "PEN",
      decisionStatus: "aceptado",
      status: "en_curso",
      diagnosisSystem: "ICD-10-PE",
      diagnosisCode: "K02.1",
      siteSystem: "ISO-3950",
      siteCode: "10",
    })
    .returning()
  await join(f, scaling!.id)
  const [proposal] = (await suggestions(f)).proposed
  expect(proposal).toMatchObject({ code: "K02.1", source: "tratamiento", quadrant: 1, toothNumber: null })
  // «Usar» manda el sitio entero, como lo propuso: con el cuadrante, ya no se propone.
  const used = await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
      diagnosisCode: proposal!.code,
      diagnosisSystem: proposal!.system,
      diagnosisType: "confirmed",
      toothNumber: null,
      surfaces: [],
      quadrant: 1,
      arch: null,
    }),
  )
  expect(used).toMatchObject({ siteCode: "10", quadrant: 1 })
  expect((await suggestions(f)).proposed).toEqual([])
  // Usarlo otra vez (otra pestaña, una propuesta vieja en pantalla) no lo duplica.
  const again = await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, { diagnosisCode: "K02.1", diagnosisType: "confirmed", quadrant: 1 }),
  )
  expect(again.id).toBe(used.id)
})

it("el alta no repite el mismo código en el mismo sitio de la atención: devuelve el que está", async () => {
  await seedLists()
  const f = await clinicalFixture()
  const add = (input: { diagnosisCode: string; diagnosisType: string; toothNumber?: number | null; surfaces?: string[] }) =>
    f.run((tx) => addEncounterDiagnosis(tx, ...f.args, f.encounter.id, input))
  const first = await add({ diagnosisCode: "K02.1", diagnosisType: "provisional", toothNumber: 16, surfaces: ["occlusal"] })
  // Las caras no cuentan: la misma pieza es el mismo diagnóstico, y queda como estaba.
  const same = await add({ diagnosisCode: "k02.1", diagnosisType: "confirmed", toothNumber: 16, surfaces: ["mesial"] })
  expect(same).toMatchObject({ id: first.id, diagnosisType: "provisional", surfaces: ["occlusal"] })
  // En otra pieza, o sin pieza, es otro.
  const other = await add({ diagnosisCode: "K02.1", diagnosisType: "provisional", toothNumber: 26 })
  const noTooth = await add({ diagnosisCode: "K02.1", diagnosisType: "provisional" })
  expect(new Set([first.id, other.id, noTooth.id]).size).toBe(3)
  // Lo anulado no cuenta: se puede registrar de nuevo.
  await f.run((tx) => voidEncounterDiagnosis(tx, ...f.args, f.encounter.id, first.id, { reason: "Era otra cara" }))
  const again = await add({ diagnosisCode: "K02.1", diagnosisType: "confirmed", toothNumber: 16 })
  expect(again.id).not.toBe(first.id)
  const rows = await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, f.encounter.id))
  expect(rows.filter((row) => row.voidedAt === null)).toHaveLength(3)
})
