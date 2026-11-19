import { withOrgContext } from "@odentia/db"
import { encounter, patientRegistration } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { expect, it, vi } from "vitest"
import { markAllergiesReviewed } from "./allergies.js"
import { getPatientHealth, initializeDeclaredPatientHealth, recordHealthDeclaration, savePatientHealth } from "./clinical.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { DocumentKit } from "./document-kit.js"
import { finalizeEncounter, getEncounterDetail } from "./encounters.js"
import { getTimeline } from "./patient-history.js"
import { loadPatientRecord, renderPatientRecordPdf } from "./patient-record.js"
import { recordResources } from "./patient-record-test-kit.js"
import { patientPersonId } from "./patients.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Auditor, 15 nov (A2): el cierre decía «Sin revisar: lo que dijo ella de su salud el 14 nov. Se
 * firma igual.», pero la atención firmada no guardaba nada de eso. Al firmar queda una foto de lo
 * que seguía sin revisar: qué, quién lo dijo y cuándo. No frena la firma y no cambia después.
 */
setupTestDb()

const ORG = "org_a"
const DAY = 86_400_000
const HER = { kind: "patient" as const, name: null, relation: null }

/** Lo que dijo ayer desde su enlace: que no tiene alergias, su presión y la warfarina. */
const SAID = {
  allergies: { state: "none" as const, items: [] },
  conditions: { state: "recorded" as const, items: [{ name: "Hipertensión" }] },
  anticoagulants: { state: "recorded" as const, detail: "Warfarina 5 mg" },
  boneMedicines: { state: "none" as const },
  medications: { state: "none" as const, items: [] },
}

it("al firmar, la atención guarda lo que dijo de su salud y seguía sin revisar, y no cambia aunque después se revise", async () => {
  const f = await clinicalFixture()
  const personId = await f.run((tx) => patientPersonId(tx, ORG, f.patient.id))
  await ownerDb.update(contact).set({ sex: "F" }).where(eq(contact.id, personId!))
  const saidAt = new Date(Date.now() - DAY)
  // Su ficha, como la de quien llega por su enlace: lo que dijo entra como su primera declaración.
  await ownerDb.insert(patientRegistration).values({ organizationId: ORG, patientId: f.patient.id, entryPoint: "platform", respondent: "staff", answers: {} })
  await f.run(async (tx) => {
    await recordHealthDeclaration(tx, ORG, f.patient.id, { via: "enlace", by: HER, health: SAID, saidAt })
    await initializeDeclaredPatientHealth(tx, ORG, f.patient.id, SAID, null)
  })
  await f.ready(f.encounter.id)
  // Firma sin revisarlo: nada lo frena.
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { nextControl: { none: true } }))

  const expected = [
    {
      by: HER,
      at: saidAt.toISOString(),
      rows: [
        { label: "Alergias", value: "dijo que no" },
        { label: "Anticoagulante", value: "Warfarina 5 mg" },
        { label: "Medicina para los huesos", value: "dijo que no" },
        { label: "Enfermedades", value: "Hipertensión" },
      ],
    },
  ]
  const [signed] = await ownerDb.select().from(encounter).where(eq(encounter.id, f.encounter.id))
  expect(signed!.healthAtSigning).toEqual(expected)
  // La atención firmada y la Historia lo traen, para quien lee la historia.
  const detail = await f.run((tx) => getEncounterDetail(tx, ORG, f.patient.id, f.encounter.id))
  expect(detail.encounter.healthAtSigning).toEqual(expected)
  const history = await f.run((tx) => getTimeline(tx, ORG, f.patient.id, { types: ["encounter"] }))
  expect(history.data.find((item) => item.id === f.encounter.id)?.born?.healthAtSigning).toEqual(expected)

  // Revisarlo después no cambia lo que quedó al firmar.
  await f.run((tx) => markAllergiesReviewed(tx, ...f.args))
  const health = await f.run((tx) => getPatientHealth(tx, ORG, f.patient.id))
  await f.run((tx) =>
    savePatientHealth(tx, ORG, f.actor, f.patient.id, {
      expectedRevision: health.revision,
      reviewStatus: health.reviewStatus,
      conditions: health.conditions.map((row) => ({ id: row.id, name: row.name, status: row.status })),
      medications: health.medications.map((row) => ({ id: row.id, name: row.name, dose: row.dose })),
    }),
  )
  expect((await f.run((tx) => getPatientHealth(tx, ORG, f.patient.id))).declared).toEqual([])
  const [still] = await ownerDb.select().from(encounter).where(eq(encounter.id, f.encounter.id))
  expect(still!.healthAtSigning).toEqual(expected)
  // Y la base no deja reescribirlo: la guarda de la atención firmada también lo cuida.
  const rewrite = await withOrgContext(appDb, ORG, (tx) =>
    tx.update(encounter).set({ healthAtSigning: [] }).where(eq(encounter.id, f.encounter.id)),
  ).then(
    () => null,
    (error: unknown) => error,
  )
  expect(constraintOf(rewrite)).toBe("encounter_finalized_immutable")
})

/** La regla de la base que rechazó algo, buscada en la cadena de causas del error. */
function constraintOf(error: unknown): string | null {
  for (let cause = error; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
    const constraint = (cause as { constraint_name?: unknown }).constraint_name
    if (typeof constraint === "string") return constraint
  }
  return null
}

// Revisión final del 15 nov (52): la copia de la historia lleva la misma constancia, en el PDF y en FHIR.
it("la copia de la historia trae lo que seguía sin revisar al firmar, con quién lo dijo y cuándo", async () => {
  const f = await clinicalFixture()
  const personId = await f.run((tx) => patientPersonId(tx, ORG, f.patient.id))
  await ownerDb.update(contact).set({ sex: "F" }).where(eq(contact.id, personId!))
  await ownerDb.insert(patientRegistration).values({ organizationId: ORG, patientId: f.patient.id, entryPoint: "platform", respondent: "staff", answers: {} })
  await f.run(async (tx) => {
    await recordHealthDeclaration(tx, ORG, f.patient.id, { via: "enlace", by: HER, health: SAID, saidAt: new Date(Date.now() - DAY) })
    await initializeDeclaredPatientHealth(tx, ORG, f.patient.id, SAID, null)
  })
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { nextControl: { none: true } }))

  const record = await f.run((tx) => loadPatientRecord(tx, ORG, f.patient.id))
  const lay = vi.spyOn(DocumentKit.prototype, "lay")
  await renderPatientRecordPdf(record, record.clinic)
  const printed = JSON.stringify(lay.mock.calls.map((call) => call[0]))
  lay.mockRestore()
  expect(printed).toContain("Lo que dijo de su salud al firmar")
  expect(printed).toMatch(/Lo dijo ella el [^"]*, sin revisar: Alergias: dijo que no; Anticoagulante: Warfarina 5 mg/)
  const observations = recordResources(record)
    .filter((resource) => String(resource.id).startsWith(`${f.encounter.id}-sin-revisar-al-firmar`))
  expect(observations).toHaveLength(1)
  expect(observations[0]).toMatchObject({
    resourceType: "Observation",
    status: "final",
    encounter: { reference: `Encounter/${f.encounter.id}` },
    valueString: expect.stringContaining("Anticoagulante: Warfarina 5 mg"),
  })
  expect(JSON.stringify(observations[0]?.note)).toMatch(/Lo dijo ella el .*, sin revisar/)
})

it("sin nada por revisar al firmar, queda dicho que no había nada", async () => {
  const f = await clinicalFixture()
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { nextControl: { none: true } }))
  const [signed] = await ownerDb.select().from(encounter).where(eq(encounter.id, f.encounter.id))
  expect(signed!.healthAtSigning).toEqual([])
})
