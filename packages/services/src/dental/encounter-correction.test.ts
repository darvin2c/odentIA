/**
 * Lo que nace junto se corrige junto (QA del 16 nov, E2, casos B3 del banco): anular el
 * hallazgo trae su diagnóstico de esta atención y lo indicado hoy desde él, con un solo motivo y
 * en una sola transacción; nunca el diagnóstico de otro hallazgo.
 */
import { randomUUID } from "node:crypto"
import { encounterDiagnosis, encounterSite, serviceCatalog, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { odontogramEntry } from "@odentia/db/schema/dental"
import { and, eq, inArray } from "drizzle-orm"
import { expect, it } from "vitest"
import { createConsentTemplate } from "../clinical-forms.js"
import { clinicalFixture, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import { registerToothFinding } from "./tooth-panel.js"
import { getCorrectionPreview, voidWithCorrection } from "../encounter-correction.js"
import { getEncounterClosing } from "../encounters.js"
import { REMOVED_IN_ENCOUNTER } from "../plan.js"
import { ownerDb, setupTestDb } from "../test-setup.js"

setupTestDb()

async function setup() {
  const f = await clinicalFixture()
  await seedDiagnosisCodes([
    { code: "K02.1", title: "Caries de la dentina" },
    { code: "K02.5", title: "Caries con exposición pulpar" },
    { code: "K04.0", title: "Pulpitis" },
  ])
  const [endo] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: "org_a", name: "Endodoncia", scope: "tooth", source: "custom", priceCents: 65000, currency: "PEN" })
    .returning()
  const register = (input: Omit<Parameters<typeof registerToothFinding>[4], "encounterId">) =>
    f.run((tx) => registerToothFinding(tx, ...f.args, { encounterId: f.encounter.id, ...input }))
  const preview = (start: Parameters<typeof getCorrectionPreview>[5]) =>
    f.run((tx) => getCorrectionPreview(tx, ...f.args, f.encounter.id, start))
  return { f, endo: endo!, register, preview }
}

it("B3: la caries con pulpitis de la 47 era de la 46: se anulan el hallazgo, su diagnóstico y la endodoncia con un motivo, y la 47 sale de la atención", async () => {
  const { f, endo, register, preview } = await setup()
  const wrong = await register({
    toothNumbers: [47],
    condition: "caries",
    surfaces: ["occlusal"],
    details: { variant: "pulpal_involvement" },
    diagnosis: { diagnosisCode: "K04.0", diagnosisType: "confirmed" },
    treatment: { serviceId: endo.id },
  })
  const entryIds = wrong.entries.map((entry) => entry.id)
  const diagnosisId = wrong.diagnoses[0]!.id
  const planItemId = wrong.planItems[0]!.id

  const shown = await preview({ findingIds: entryIds })
  expect(shown.target).toMatchObject({ kind: "finding" })
  expect(shown.diagnoses).toEqual([{ ids: [diagnosisId], label: "K04.0 Pulpitis · 47", offered: true, note: null }])
  expect(shown.planItems).toMatchObject([{ ids: [planItemId], offered: true }])
  expect(shown.notices).toEqual([])

  const reason = "Pieza equivocada: era la 46"
  await f.run((tx) =>
    voidWithCorrection(tx, ...f.args, f.encounter.id, { findingIds: entryIds }, {
      reason,
      diagnosisIds: [diagnosisId],
      planItemIds: [planItemId],
    }),
  )
  const entries = await ownerDb.select().from(odontogramEntry).where(inArray(odontogramEntry.id, entryIds))
  expect(entries.every((entry) => entry.voidReason === reason)).toBe(true)
  const [diagnosis] = await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.id, diagnosisId))
  expect(diagnosis).toMatchObject({ voidReason: reason })
  const [item] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, planItemId))
  expect(item).toMatchObject({ status: "cancelado", statusReason: REMOVED_IN_ENCOUNTER })
  // La 47 ya no es de la atención, y lo que falta para firmar se recalcula: sin diagnóstico.
  const sites = await ownerDb.select().from(encounterSite).where(eq(encounterSite.encounterId, f.encounter.id))
  expect(sites.map((site) => site.siteCode)).not.toContain("47")
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.missing).toContain("diagnosis")
  // Un doble clic no anula dos veces: ya está anulado.
  await expect(
    f.run((tx) => voidWithCorrection(tx, ...f.args, f.encounter.id, { findingIds: entryIds }, { reason })),
  ).rejects.toMatchObject({ code: "ALREADY_VOIDED" })
})

it("B3b: dos caries de la 36 con el mismo código comparten el diagnóstico, que sigue mientras la otra lo use; con códigos distintos, cae solo el suyo", async () => {
  const { f, register, preview } = await setup()
  const occlusal = await register({
    toothNumbers: [36],
    condition: "caries",
    surfaces: ["occlusal"],
    details: { variant: "dentin" },
    diagnosis: { diagnosisCode: "K02.1", diagnosisType: "confirmed" },
  })
  const mesial = await register({
    toothNumbers: [36],
    condition: "caries",
    surfaces: ["mesial"],
    details: { variant: "dentin" },
    diagnosis: { diagnosisCode: "K02.1", diagnosisType: "confirmed" },
  })
  const shared = occlusal.diagnoses[0]!.id
  expect(mesial.diagnoses[0]!.id).toBe(shared)
  const shown = await preview({ findingIds: occlusal.entries.map((entry) => entry.id) })
  expect(shown.diagnoses).toEqual([
    { ids: [shared], label: "K02.1 Caries de la dentina · 36", offered: false, note: "Sigue: lo usa Lesión de caries dental · Mesial · 36" },
  ])
  // Marcarlo igual (una pantalla vieja) no pasa: el servidor no confía en la pantalla.
  await expect(
    f.run((tx) =>
      voidWithCorrection(tx, ...f.args, f.encounter.id, { findingIds: occlusal.entries.map((entry) => entry.id) }, {
        reason: "Duplicado",
        diagnosisIds: [shared],
      }),
    ),
  ).rejects.toMatchObject({ code: "CORRECTION_CHANGED" })
  await f.run((tx) =>
    voidWithCorrection(tx, ...f.args, f.encounter.id, { findingIds: occlusal.entries.map((entry) => entry.id) }, {
      reason: "Duplicado",
    }),
  )
  // Q5: el diagnóstico sigue, y dice la cara de la caries que queda, no la de la anulada. Un
  // diagnóstico registrado no se reescribe: el de «Oclusal» queda anulado diciendo por qué y el
  // K02.1 sigue registrado con «Mesial», unido a su hallazgo.
  const k021s = await ownerDb
    .select()
    .from(encounterDiagnosis)
    .where(and(eq(encounterDiagnosis.encounterId, f.encounter.id), eq(encounterDiagnosis.diagnosisCode, "K02.1")))
  const live = k021s.filter((row) => row.voidedAt === null)
  expect(live).toHaveLength(1)
  expect(live[0]).toMatchObject({ siteCode: "36", siteQualifiers: ["mesial"], diagnosisType: "confirmed" })
  expect(k021s.find((row) => row.id === shared)!.voidReason).toBe(
    "Se anuló el hallazgo de esa cara (Duplicado): el diagnóstico sigue, con la cara que queda.",
  )
  const kept = live[0]!.id
  const after = await preview({ findingIds: mesial.entries.map((entry) => entry.id) })
  expect(after.diagnoses).toEqual([{ ids: [kept], label: "K02.1 Caries de la dentina · 36", offered: true, note: null }])
  // La 36 sigue en la atención: le queda la caries mesial.
  const sites = await ownerDb.select().from(encounterSite).where(eq(encounterSite.encounterId, f.encounter.id))
  expect(sites.map((site) => site.siteCode)).toContain("36")

  // Con otro código, la distal tiene su propio diagnóstico: solo ese cae con ella.
  const distal = await register({
    toothNumbers: [36],
    condition: "caries",
    surfaces: ["distal"],
    details: { variant: "pulpal_involvement" },
    diagnosis: { diagnosisCode: "K02.5", diagnosisType: "confirmed" },
  })
  const own = await preview({ findingIds: distal.entries.map((entry) => entry.id) })
  expect(own.diagnoses).toEqual([
    { ids: [distal.diagnoses[0]!.id], label: "K02.5 Caries con exposición pulpar · 36", offered: true, note: null },
  ])
  // Desde Diagnóstico, al revés: el K02.5 trae su hallazgo, y el K02.1 trae la mesial.
  const reverse = await preview({ diagnosisId: distal.diagnoses[0]!.id })
  expect(reverse.findings).toMatchObject([{ ids: distal.entries.map((entry) => entry.id), offered: true }])
  await f.run((tx) =>
    voidWithCorrection(tx, ...f.args, f.encounter.id, { diagnosisId: distal.diagnoses[0]!.id }, {
      reason: "Era otra pieza",
      findingIds: distal.entries.map((entry) => entry.id),
    }),
  )
  const distalRows = await ownerDb
    .select()
    .from(odontogramEntry)
    .where(inArray(odontogramEntry.id, distal.entries.map((entry) => entry.id)))
  expect(distalRows.every((row) => row.voidReason === "Era otra pieza")).toBe(true)
  const [k021] = await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.id, kept))
  expect(k021!.voidedAt).toBeNull()
})

it("Q5: al anular la segunda caries, el diagnóstico compartido ya decía bien la que queda y no se toca", async () => {
  const { f, register } = await setup()
  const occlusal = await register({
    toothNumbers: [47],
    condition: "caries",
    surfaces: ["occlusal"],
    details: { variant: "dentin" },
    diagnosis: { diagnosisCode: "K02.1", diagnosisType: "confirmed" },
  })
  const mesial = await register({
    toothNumbers: [47],
    condition: "caries",
    surfaces: ["mesial"],
    details: { variant: "dentin" },
    diagnosis: { diagnosisCode: "K02.1", diagnosisType: "confirmed" },
  })
  const shared = occlusal.diagnoses[0]!.id
  await f.run((tx) =>
    voidWithCorrection(tx, ...f.args, f.encounter.id, { findingIds: mesial.entries.map((entry) => entry.id) }, {
      reason: "No era caries",
    }),
  )
  const all = await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, f.encounter.id))
  expect(all).toHaveLength(1)
  expect(all[0]).toMatchObject({ id: shared, voidedAt: null, siteQualifiers: ["occlusal"] })
})

it("B3c: con el consentimiento de la 47 ya firmado, el aviso lo nombra y el consentimiento queda como estaba", async () => {
  const { f, endo, register, preview } = await setup()
  const wrong = await register({
    toothNumbers: [47],
    condition: "caries",
    surfaces: ["occlusal"],
    details: { variant: "pulpal_involvement" },
    diagnosis: { diagnosisCode: "K04.0", diagnosisType: "confirmed" },
    treatment: { serviceId: endo.id },
  })
  const planItemId = wrong.planItems[0]!.id
  const template = await f.run((tx) =>
    createConsentTemplate(tx, "org_a", f.actor, {
      key: `t-${randomUUID().slice(0, 8)}`,
      title: "Tratamiento de conductos",
      sections: {
        procedure: "Tratamiento de conductos de la pieza con anestesia local.",
        benefits: ["Quitar el dolor"],
        risks: ["Dolor los primeros días"],
        alternatives: ["Exodoncia"],
        consequences: "La infección puede avanzar.",
      },
    }),
  )
  const [signed] = await ownerDb
    .insert(consentDocument)
    .values({
      organizationId: "org_a",
      templateId: template.id,
      templateVersion: template.version,
      bodySnapshot: "Texto",
      titleSnapshot: "Tratamiento de conductos",
      patientId: f.patient.id,
      encounterId: f.encounter.id,
      planItemId,
      signerName: "Paciente de prueba",
      status: "firmado",
      signedAt: new Date(),
    })
    .returning()
  const shown = await preview({ findingIds: wrong.entries.map((entry) => entry.id) })
  expect(shown.notices).toEqual([
    "El consentimiento «Tratamiento de conductos» ya está firmado y no se deshace: si no corresponde, revócalo aparte.",
  ])
  await f.run((tx) =>
    voidWithCorrection(tx, ...f.args, f.encounter.id, { findingIds: wrong.entries.map((entry) => entry.id) }, {
      reason: "Pieza equivocada: era la 46",
      diagnosisIds: [wrong.diagnoses[0]!.id],
      planItemIds: [planItemId],
    }),
  )
  const [still] = await ownerDb
    .select()
    .from(consentDocument)
    .where(and(eq(consentDocument.id, signed!.id), eq(consentDocument.status, "firmado")))
  expect(still).toBeTruthy()
})
