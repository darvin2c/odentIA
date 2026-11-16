/**
 * La anestesia sale de datos clínicos (QA del 16 nov, E5b y E5c; ADR 0195): el servicio dice si usa
 * anestesia local (la biblioteca, y la clínica lo cambia), la atención la muestra en cuanto algo de
 * hoy la usa aunque el inventario no tenga anestésicos, la ASA se pone de un toque con su rastro y
 * la atención firmada guarda la ASA, el peso y el máximo.
 */
import { encounter, patient, serviceCatalog, treatmentTemplate } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { setPatientAsa } from "./clinical.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  addEncounterProcedure,
  finalizeEncounter,
  getEncounterClosing,
  updateEncounterDraft,
} from "./encounters.js"
import { getService, updateService } from "./service-catalog.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

let keySeq = 0

/** Un tratamiento de la biblioteca que usa (o no) anestesia local, y el servicio de la clínica. */
async function libraryService(name: string, localAnesthesia: boolean) {
  keySeq += 1
  const [template] = await ownerDb
    .insert(treatmentTemplate)
    .values({
      key: `prueba-anestesia-${keySeq}`,
      name: `${name} ${keySeq}`,
      kind: "endodoncia",
      scope: "general",
      localAnesthesia,
    })
    .returning()
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: "org_a",
      templateId: template!.id,
      source: "template",
      name,
      scope: "general",
      priceCents: 45_000,
      currency: "PEN",
    })
    .returning()
  return service!
}

it("el servicio usa anestesia local como dice la biblioteca, y la clínica lo cambia", async () => {
  const f = await clinicalFixture()
  const pulpectomia = await libraryService("Pulpectomía", true)
  const limpieza = await libraryService("Limpieza", false)
  expect((await f.run((tx) => getService(tx, "org_a", pulpectomia.id))).localAnesthesia).toBe(true)
  expect((await f.run((tx) => getService(tx, "org_a", limpieza.id))).localAnesthesia).toBe(false)
  // Uno propio no la usa; lo que la biblioteca no marca, la clínica lo marca.
  expect((await f.run((tx) => getService(tx, "org_a", f.service.id))).localAnesthesia).toBe(false)
  await f.run((tx) => updateService(tx, "org_a", f.actor, limpieza.id, { localAnesthesia: true }))
  expect((await f.run((tx) => getService(tx, "org_a", limpieza.id))).localAnesthesia).toBe(true)
  // B5e: la clínica la desmarca en su servicio; nulo vuelve a lo de la biblioteca.
  await f.run((tx) =>
    updateService(tx, "org_a", f.actor, pulpectomia.id, { localAnesthesia: false }),
  )
  expect((await f.run((tx) => getService(tx, "org_a", pulpectomia.id))).localAnesthesia).toBe(false)
  await f.run((tx) =>
    updateService(tx, "org_a", f.actor, pulpectomia.id, { localAnesthesia: null }),
  )
  expect(await f.run((tx) => getService(tx, "org_a", pulpectomia.id))).toMatchObject({
    localAnesthesia: true,
    ownLocalAnesthesia: null,
    libraryLocalAnesthesia: true,
  })
})

it("B5: lo de hoy con anestesia pide la línea sin materiales; la ASA de un toque queda con su rastro y en la atención firmada", async () => {
  const f = await clinicalFixture()
  const pulpectomia = await libraryService("Pulpectomía posterior, deciduo", true)
  const limpieza = await libraryService("Limpieza", false)
  const closing = () =>
    f.run((tx) => getEncounterClosing(tx, "org_a", f.actor, f.patient.id, f.encounter.id))
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: limpieza.id }),
  )
  expect((await closing()).health.uses).toEqual([])
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: pulpectomia.id }),
  )
  const before = await closing()
  expect(before.health).toMatchObject({
    uses: ["Pulpectomía posterior, deciduo"],
    anesthetics: [],
    asksAsa: true,
  })
  expect(before.health.gaps).toContain("asa")

  // La ASA con un toque: quién y cuándo en la ficha, y la de antes en la auditoría.
  await f.run((tx) =>
    setPatientAsa(tx, "org_a", f.actor, f.patient.id, {
      asaClass: "II",
      encounterId: f.encounter.id,
    }),
  )
  const [row] = await ownerDb.select().from(patient).where(eq(patient.id, f.patient.id))
  expect(row).toMatchObject({ asaClass: "II", asaClassSetBy: f.actor })
  expect(row?.asaClassSetAt).toBeInstanceOf(Date)
  // Un doble toque no deja otra marca.
  await f.run((tx) =>
    setPatientAsa(tx, "org_a", f.actor, f.patient.id, {
      asaClass: "II",
      encounterId: f.encounter.id,
    }),
  )
  const trail = await ownerDb
    .select({ metadata: auditEvent.metadata, actor: auditEvent.actorUserId })
    .from(auditEvent)
    .where(
      and(eq(auditEvent.action, "patient.asa_classified"), eq(auditEvent.entityId, f.patient.id)),
    )
  expect(trail).toHaveLength(1)
  expect(trail[0]).toMatchObject({
    actor: f.actor,
    metadata: { before: null, after: "II", encounterId: f.encounter.id },
  })
  await expect(
    f.run((tx) => setPatientAsa(tx, "org_a", f.actor, f.patient.id, { asaClass: "VII" })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  expect((await closing()).health.gaps).not.toContain("asa")

  // Mateo pesa 22 kg: la firma guarda la ASA, el peso y el máximo con el anestésico elegido.
  await f.run((tx) => updateEncounterDraft(tx, ...f.args, f.encounter.id, { vitals: { peso: 22 } }))
  await f.ready(f.encounter.id)
  await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, f.encounter.id, { anesthetic: "lidocaina-2-epinefrina" }),
  )
  const [signed] = await ownerDb.select().from(encounter).where(eq(encounter.id, f.encounter.id))
  expect(signed?.anesthesiaAtSigning).toMatchObject({
    uses: ["Pulpectomía posterior, deciduo"],
    asaClass: "II",
    asaBefore: null,
    weightKg: 22,
    anesthetic: "Lidocaína 2 % con epinefrina 1:100 000",
    dose: "Máximo para 22 kg con lidocaína 2 % con epinefrina (cartucho de 1,8 mL): 96,8 mg, unos 2,6 cartuchos",
  })
  // Es historia: no cambia después de firmar.
  await expect(
    ownerDb
      .update(encounter)
      .set({ anesthesiaAtSigning: null })
      .where(eq(encounter.id, f.encounter.id)),
  ).rejects.toThrow()
})

it("B5d: una endodoncia en un adulto sin peso: la firma guarda la ASA y ningún máximo inventado", async () => {
  const f = await clinicalFixture()
  const endodoncia = await libraryService("Endodoncia posterior vital", true)
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: endodoncia.id }),
  )
  await f.ready(f.encounter.id)
  await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, f.encounter.id, { anesthetic: "lidocaina-2-epinefrina" }),
  )
  const [signed] = await ownerDb.select().from(encounter).where(eq(encounter.id, f.encounter.id))
  expect(signed?.anesthesiaAtSigning).toMatchObject({ asaClass: null, weightKg: null, dose: null })
})

it("sin nada de hoy con anestesia, la atención firmada no guarda anestesia", async () => {
  const f = await clinicalFixture()
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, {}))
  const [signed] = await ownerDb.select().from(encounter).where(eq(encounter.id, f.encounter.id))
  expect(signed?.anesthesiaAtSigning).toBeNull()
})
