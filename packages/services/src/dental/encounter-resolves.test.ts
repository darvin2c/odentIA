/**
 * Lo que una atención firmada deja resuelto (QA del repaso de la atención, 9 nov):
 * la caries de dos caras es una lesión y se trata entera con el tratamiento que
 * la motivó (o solo las caras que cubre una resina); el diagnóstico de esa pieza
 * pasa a «resuelto» salvo que quien firma lo desmarque; y si nada sigue en curso,
 * vuelve para lo aceptado sin empezar (la corona), no a un control genérico.
 */
import { withOrgContext } from "@odentia/db"
import { encounterDiagnosis, serviceCatalog, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { odontogramEntry } from "@odentia/db/schema/dental"
import { and, eq, inArray } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import { addOdontogramEntries } from "./odontogram.js"
import { orgDiagnosisSystem } from "../diagnosis-codes.js"
import { addEncounterDiagnosis } from "../encounter-diagnoses.js"
import { addEncounterProcedure, finalizeEncounter, getEncounterClosing } from "../encounters.js"
import { appDb, ownerDb, setupTestDb } from "../test-setup.js"

setupTestDb()

async function toothService(scope: "tooth" | "surfaces", name: string) {
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: "org_a", name, scope, source: "custom", priceCents: 50_000, currency: "PEN" })
    .returning()
  return service!
}

async function cariesDO(f: Awaited<ReturnType<typeof clinicalFixture>>) {
  return f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 46,
      condition: "caries",
      surfaces: ["occlusal", "distal"],
      details: { variant: "dentin" },
      encounterId: f.encounter.id,
    }),
  )
}

const resolvedOf = async (ids: string[]) =>
  new Map(
    (await ownerDb.select().from(odontogramEntry).where(inArray(odontogramEntry.id, ids))).map((row) => [
      row.surface,
      row.resolvedAt !== null,
    ]),
  )

it("la caries de dos caras queda tratada entera con el tratamiento de la pieza que la motivó", async () => {
  const f = await clinicalFixture()
  const rows = await cariesDO(f)
  expect(rows).toHaveLength(2)
  const endodoncia = await toothService("tooth", "Endodoncia posterior vital")
  // Se vincula a una sola cara (la primera), como el panel de la pieza.
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, {
      serviceId: endodoncia.id,
      toothNumber: 46,
      odontogramEntryId: rows[0]!.id,
    }),
  )
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const resolved = await resolvedOf(rows.map((row) => row.id))
  expect(resolved.get("occlusal")).toBe(true)
  expect(resolved.get("distal")).toBe(true)
})

it("una resina solo trata las caras que cubre: la otra cara de la caries sigue vigente", async () => {
  const f = await clinicalFixture()
  const rows = await cariesDO(f)
  const resina = await toothService("surfaces", "Resina, 1 superficie")
  // Vinculada a la oclusal (la primera), pero cubre la distal.
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, {
      serviceId: resina.id,
      toothNumber: 46,
      surfaces: ["distal"],
      odontogramEntryId: rows[0]!.id,
    }),
  )
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const resolved = await resolvedOf(rows.map((row) => row.id))
  expect(resolved.get("distal")).toBe(true)
  expect(resolved.get("occlusal")).toBe(false)
})

async function pulpitis46(f: Awaited<ReturnType<typeof clinicalFixture>>) {
  const system = await withOrgContext(appDb, "org_a", (tx) => orgDiagnosisSystem(tx, "org_a"))
  const code = system === "ICD-11" ? "DA09.0" : "K04.0"
  await seedDiagnosisCodes([{ code, title: "Pulpitis" }], system)
  const diagnosis = await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
      diagnosisCode: code,
      diagnosisType: "confirmed",
      toothNumber: 46,
    }),
  )
  const endodoncia = await toothService("tooth", "Endodoncia posterior vital")
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, {
      serviceId: endodoncia.id,
      toothNumber: 46,
      diagnosisCode: code,
    }),
  )
  return diagnosis
}

it("al firmar, el diagnóstico de la pieza que resuelve el tratamiento terminado pasa a resuelto", async () => {
  const f = await clinicalFixture()
  const diagnosis = await pulpitis46(f)
  await f.ready(f.encounter.id)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.resolvable).toHaveLength(1)
  expect(closing.resolvable[0]!.diagnosisIds).toContain(diagnosis.id)
  expect(closing.resolvable[0]!.site).toBe("pieza 46")
  // Lo que la pantalla mostró marcado es lo que se resuelve.
  await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, f.encounter.id, { resolveDiagnosisIds: closing.resolvable[0]!.diagnosisIds }),
  )
  const [row] = await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.id, diagnosis.id))
  expect(row?.status).toBe("resuelto")
  expect(row?.resolvedAt).not.toBeNull()
})

it("lo que quien firma desmarca (o lo que no se mostró) sigue activo", async () => {
  const f = await clinicalFixture()
  const diagnosis = await pulpitis46(f)
  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const [row] = await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.id, diagnosis.id))
  expect(row?.status).toBe("activo")
})

it("sin nada en curso, vuelve para lo aceptado sin empezar y el cierre lo deja por reservar", async () => {
  const f = await clinicalFixture()
  const corona = await toothService("tooth", "Corona metal-cerámica")
  const endodoncia = await toothService("tooth", "Endodoncia posterior vital")
  // Hoy se termina la endodoncia de la 46.
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: endodoncia.id, toothNumber: 46 }))
  // Una corona aceptada en otra atención, aún sin sesiones.
  const [accepted] = await ownerDb
    .insert(treatmentPlanItem)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      planId: f.plan.id,
      serviceId: corona.id,
      title: corona.name,
      scope: "tooth",
      siteSystem: "ISO-3950",
      siteCode: "46",
      plannedSessions: 2,
      priceCents: corona.priceCents,
      currency: "PEN",
      status: "pendiente",
      decisionStatus: "aceptado",
    })
    .returning()
  await f.ready(f.encounter.id)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.sessions.accepted.map((session) => session.planItemId)).toEqual([accepted!.id])
  const done = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(done.nextSessions.map((session) => session.planItemId)).toEqual([accepted!.id])
  expect(done.nextSessions[0]?.toBook).toEqual({ n: 1, m: 2 })
  // Lo de otra pieza o sin pieza no cambia el cierre (un blanqueamiento aceptado hace un año).
  // Queda como estaba: nada se acepta ni se empieza solo.
  const [after] = await ownerDb
    .select()
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.id, accepted!.id)))
  expect(after?.status).toBe("pendiente")
})

it("una resina de una cara no resuelve la caries de dos caras: el cierre no lo propone", async () => {
  const f = await clinicalFixture()
  const system = await withOrgContext(appDb, "org_a", (tx) => orgDiagnosisSystem(tx, "org_a"))
  const code = system === "ICD-11" ? "DA08.0" : "K02.1"
  await seedDiagnosisCodes([{ code, title: "Caries" }], system)
  await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
      diagnosisCode: code,
      diagnosisType: "confirmed",
      toothNumber: 46,
      surfaces: ["occlusal", "distal"],
    }),
  )
  const resina = await toothService("surfaces", "Resina, 1 superficie")
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, {
      serviceId: resina.id,
      toothNumber: 46,
      surfaces: ["occlusal"],
      diagnosisCode: code,
    }),
  )
  await f.ready(f.encounter.id)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.resolvable.filter((found) => found.label.includes(code))).toEqual([])
})

it("lo aceptado de otra pieza no es a lo que vuelve: el cierre sigue preguntando el control", async () => {
  const f = await clinicalFixture()
  const corona = await toothService("tooth", "Corona metal-cerámica")
  const endodoncia = await toothService("tooth", "Endodoncia posterior vital")
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: endodoncia.id, toothNumber: 36 }))
  await ownerDb.insert(treatmentPlanItem).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    planId: f.plan.id,
    serviceId: corona.id,
    title: corona.name,
    scope: "tooth",
    siteSystem: "ISO-3950",
    siteCode: "46",
    plannedSessions: 2,
    priceCents: corona.priceCents,
    currency: "PEN",
    status: "pendiente",
    decisionStatus: "aceptado",
  })
  await f.ready(f.encounter.id)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.sessions.accepted).toEqual([])
})
