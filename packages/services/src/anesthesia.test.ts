/**
 * La anestesia sale de datos clínicos (QA del 16 nov, E5b y E5c; ADR 0197): el servicio dice si usa
 * anestesia local (la biblioteca, y la clínica lo cambia), la atención la muestra en cuanto algo de
 * hoy la usa aunque el inventario no tenga anestésicos, la ASA se pone de un toque con su rastro y
 * la atención firmada guarda la ASA, el peso y el máximo.
 */
import {
  encounter,
  encounterPlanItem,
  patient,
  patientCondition,
  serviceCatalog,
  treatmentPlanItem,
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { anesthesiaAtSigningOf } from "./anesthesia-at-signing.js"
import { getPatientHealth, setPatientAsa } from "./clinical.js"
import { clinicalFixture, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import {
  addEncounterProcedure,
  finalizeEncounter,
  getEncounterClosing,
  updateEncounterDraft,
  voidEncounterProcedure,
} from "./encounters.js"
import { addPlanItem } from "./plan.js"
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

// QA del 18 nov (novato 10): en la segunda atención del mismo día volvía a pedir el peso.
it("sin peso en esta atención, la firma usa el anotado hoy en otra atención no anulada", async () => {
  const f = await clinicalFixture()
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
  // La de la mañana, firmada, con su peso; otra anulada después, con otro peso que ya no cuenta.
  const morningAt = new Date(Date.now() - 30 * 60_000)
  await ownerDb.insert(encounter).values([
    {
      organizationId: "org_a",
      patientId: f.patient.id,
      professionalUserId: f.actor,
      reason: "Dolor",
      vitals: { peso: 80 },
      status: "finalizada",
      startedAt: morningAt,
      endedAt: morningAt,
      finalizedAt: morningAt,
      finalizedBy: f.actor,
    },
    {
      organizationId: "org_a",
      patientId: f.patient.id,
      professionalUserId: f.actor,
      reason: "Abierta por error",
      vitals: { peso: 95 },
      status: "anulada",
      startedAt: new Date(Date.now() - 10 * 60_000),
      voidedAt: new Date(),
      voidedBy: f.actor,
      voidReason: "Abierta por error",
    },
  ])
  const signing = () =>
    f.run((tx) =>
      anesthesiaAtSigningOf(tx, "org_a", {
        patientId: f.patient.id,
        encounterId: f.encounter.id,
        uses: ["Endodoncia"],
        vitals: null,
        birthDate: "1984-05-02",
        today,
        anesthetic: "lidocaina-2-epinefrina",
        asksAsa: false,
        timeZone: "America/Lima",
      }),
    )
  expect(await signing()).toMatchObject({ weightKg: 80, dose: expect.stringContaining("80 kg") })
})

// QA del 16 nov, Q7 (Gloria): la exodoncia se registró, se anuló («se difiere por presión») y la
// atención se firmó. La firmada decía «Anestesia local · Para Exodoncia…» sobre «Anulado: se difiere».
it("Q7: el acto anulado deja de pedir la línea de anestesia y la firmada no la afirma", async () => {
  const f = await clinicalFixture()
  const exodoncia = await libraryService("Exodoncia simple", true)
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: exodoncia.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  await ownerDb.update(treatmentPlanItem).set({ decisionStatus: "aceptado" }).where(eq(treatmentPlanItem.id, item.id))
  const closing = () =>
    f.run((tx) => getEncounterClosing(tx, "org_a", f.actor, f.patient.id, f.encounter.id))
  const procedure = await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }),
  )
  expect((await closing()).health.uses).toEqual(["Exodoncia simple"])
  await f.run((tx) =>
    voidEncounterProcedure(tx, ...f.args, f.encounter.id, procedure.id, { reason: "Se difiere por presión" }),
  )
  // El tratamiento sigue traído a hoy, pero su acto se anuló: ya no hay anestesia que avisar.
  expect((await closing()).health.uses).toEqual([])
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { anesthetic: "lidocaina-2-epinefrina" }))
  const [signed] = await ownerDb.select().from(encounter).where(eq(encounter.id, f.encounter.id))
  expect(signed?.anesthesiaAtSigning).toBeNull()
})

it("Q7: lo traído a hoy pide la línea antes del acto, y sin registrarlo la firmada no dice anestesia", async () => {
  const f = await clinicalFixture()
  const endodoncia = await libraryService("Endodoncia posterior vital", true)
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: endodoncia.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  await ownerDb
    .insert(encounterPlanItem)
    .values({ organizationId: "org_a", encounterId: f.encounter.id, planItemId: item.id })
  const closing = await f.run((tx) => getEncounterClosing(tx, "org_a", f.actor, f.patient.id, f.encounter.id))
  expect(closing.health.uses).toEqual(["Endodoncia posterior vital"])
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { anesthetic: "lidocaina-2-epinefrina" }))
  const [signed] = await ownerDb.select().from(encounter).where(eq(encounter.id, f.encounter.id))
  expect(signed?.anesthesiaAtSigning).toBeNull()
})

it("sin nada de hoy con anestesia, la atención firmada no guarda anestesia", async () => {
  const f = await clinicalFixture()
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, {}))
  const [signed] = await ownerDb.select().from(encounter).where(eq(encounter.id, f.encounter.id))
  expect(signed?.anesthesiaAtSigning).toBeNull()
})

// QA del 16 nov, Q9: paciente nuevo sin antecedentes; al poner la ASA de un toque la ficha pasaba a
// decir «Lo que dijo de su salud, sin revisar» sin que nadie dijera nada.
it("Q9: poner la ASA no deja la salud «sin revisar»: nadie dijo nada", async () => {
  const f = await clinicalFixture()
  const before = await f.run((tx) => getPatientHealth(tx, "org_a", f.patient.id))
  expect(before).toMatchObject({ reviewPending: false, declared: [] })
  await f.run((tx) => setPatientAsa(tx, "org_a", f.actor, f.patient.id, { asaClass: "II", encounterId: f.encounter.id }))
  const after = await f.run((tx) =>
    setPatientAsa(tx, "org_a", f.actor, f.patient.id, { asaClass: "III", encounterId: f.encounter.id }),
  )
  expect(after).toMatchObject({ asaClass: "III", reviewPending: false, declared: [] })
  // La revisión sí avanza: Antecedentes abierto en otra pantalla recarga en vez de pisar la ASA.
  expect(after.revision).toBe(before.revision + 2)
})

// Revisión del 16 nov (R13): la ASA no se anota contra una atención que no es un borrador de este paciente.
it("R13: setPatientAsa ignora una atención que no es borrador de ese paciente", async () => {
  const f = await clinicalFixture()
  const other = await clinicalFixture()
  await f.run((tx) =>
    setPatientAsa(tx, "org_a", f.actor, f.patient.id, { asaClass: "II", encounterId: other.encounter.id }),
  )
  await f.run((tx) =>
    setPatientAsa(tx, "org_a", f.actor, f.patient.id, { asaClass: "III", encounterId: f.encounter.id }),
  )
  const trail = await ownerDb
    .select({ metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(and(eq(auditEvent.action, "patient.asa_classified"), eq(auditEvent.entityId, f.patient.id)))
    .orderBy(auditEvent.createdAt)
  expect(trail.map((row) => (row.metadata as { encounterId: string | null }).encounterId)).toEqual([
    null,
    f.encounter.id,
  ])
})

// Reglas clínicas del 18 nov, caso C2 (Rodrigo, HTA con losartán, ASA II): la firma guarda el tope
// de epinefrina solo si la presión de hoy lo pide, con la misma regla que la línea de la atención.
it("la firma no limita la epinefrina a la hipertensión controlada y sí a la presión de hoy de 165/100", async () => {
  const f = await clinicalFixture()
  await seedDiagnosisCodes([
    { code: "I10", title: "Hipertensión esencial (primaria)" },
    { code: "I48", title: "Fibrilación y aleteo auricular" },
  ])
  await ownerDb.insert(patientCondition).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    name: "Hipertensión arterial",
    diagnosisSystem: "ICD-10-PE",
    diagnosisCode: "I10",
    status: "activa",
  })
  await f.run((tx) => setPatientAsa(tx, "org_a", f.actor, f.patient.id, { asaClass: "II" }))
  const signing = (vitals: { presionSistolica: number; presionDiastolica: number } | null) =>
    f.run((tx) =>
      anesthesiaAtSigningOf(tx, "org_a", {
        patientId: f.patient.id,
        encounterId: f.encounter.id,
        uses: ["Endodoncia"],
        vitals,
        birthDate: "1984-05-02",
        today: "2026-11-18",
        anesthetic: "lidocaina-2-epinefrina",
        asksAsa: true,
      }),
    )
  expect((await signing({ presionSistolica: 130, presionDiastolica: 85 }))?.warnings).toEqual([])
  // El tope va aparte y primero, como en la atención (QA de diseño del 18 nov, H7).
  expect(await signing({ presionSistolica: 165, presionDiastolica: 100 })).toMatchObject({
    cap: "Epinefrina hasta 0,04 mg por la presión de hoy (165/100): unos 2,2 cartuchos",
    warnings: [],
  })
  expect((await signing(null))?.warnings).toEqual([
    "Con su hipertensión arterial (I10), toma la presión antes de anestesiar.",
  ])
  // Una fibrilación auricular con su código, aun con ASA II, sí lo pide.
  await ownerDb.insert(patientCondition).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    name: "Fibrilación auricular",
    diagnosisSystem: "ICD-10-PE",
    diagnosisCode: "I48",
    status: "activa",
  })
  expect((await signing({ presionSistolica: 130, presionDiastolica: 85 }))?.cap).toBe(
    "Epinefrina hasta 0,04 mg por su fibrilación auricular (I48): unos 2,2 cartuchos",
  )
})
