import {
  encounterDiagnosis,
  patient,
  patientContact,
  patientFamilyHistory,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import { afterEach, expect, it } from "vitest"
import { addOdontogramEntries } from "./clinical.js"
import { clinicalFixture, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import {
  getDiagnosisSuggestions,
  searchDiagnosisCodes,
  setOrgDiagnosisSystem,
} from "./diagnosis-codes.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import {
  createEncounter,
  finalizeEncounter,
  getEncounterDetail,
  updateEncounterDraft,
} from "./encounters.js"
import { updatePatient } from "./patients.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

// Cada prueba deja la clínica con la lista que recomienda Perú.
afterEach(async () => {
  await ownerDb.execute(
    sql`update "org_profile" set "diagnosis_system" = null where "organization_id" = 'org_a'`,
  )
})

async function seedLists() {
  await seedDiagnosisCodes([
    { code: "K02", title: "Caries dental" },
    { code: "K02.1", title: "Caries de la dentina" },
    { code: "K00.6", title: "Alteraciones de la erupción dentaria" },
    { code: "S02.0", title: "Fractura de la bóveda del cráneo" },
    { code: "S02.5", title: "Fractura de los dientes" },
  ])
  await seedDiagnosisCodes(
    [
      { code: "DA08.0", title: "Caries dental" },
      { code: "NA0D.01", title: "Fractura del esmalte" },
    ],
    "ICD-11",
  )
}

/** Cierra la atención con un diagnóstico presuntivo, lo mínimo que pide el cierre. */
async function closeWith(
  f: Awaited<ReturnType<typeof clinicalFixture>>,
  encounterId: string,
  code: string,
) {
  await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, encounterId, {
      diagnosisCode: code,
      diagnosisType: "provisional",
    }),
  )
  await f.run((tx) =>
    updateEncounterDraft(tx, ...f.args, encounterId, { evolution: "Evolución favorable" }),
  )
  return f.run((tx) => finalizeEncounter(tx, ...f.args, encounterId))
}

it("cierra con S02.5 (presuntivo basta) y, con la CIE-11 elegida, con un código de la CIE-11", async () => {
  await seedLists()
  const f = await clinicalFixture()
  const closed = await closeWith(f, f.encounter.id, "s02.5")
  expect(closed.encounter.status).toBe("finalizada")
  const [first] = await ownerDb
    .select()
    .from(encounterDiagnosis)
    .where(eq(encounterDiagnosis.encounterId, f.encounter.id))
  expect(first).toMatchObject({
    diagnosisSystem: "ICD-10",
    diagnosisCode: "S02.5",
    diagnosisType: "provisional",
  })

  await f.run((tx) => setOrgDiagnosisSystem(tx, "org_a", f.actor, "ICD-11"))
  const next = await f.run((tx) =>
    createEncounter(tx, ...f.args, { reason: "Golpe en el colegio" }),
  )
  // Los nuevos se eligen en la lista de la clínica: un código de la CIE-10 ya no entra.
  await expect(
    f.run((tx) =>
      addEncounterDiagnosis(tx, ...f.args, next.id, {
        diagnosisCode: "S02.5",
        diagnosisType: "provisional",
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const again = await closeWith(f, next.id, "NA0D.01")
  expect(again.encounter.status).toBe("finalizada")
  const [eleven] = await ownerDb
    .select()
    .from(encounterDiagnosis)
    .where(eq(encounterDiagnosis.encounterId, next.id))
  expect(eleven).toMatchObject({ diagnosisSystem: "ICD-11", diagnosisCode: "NA0D.01" })
})

it("cambiar de lista no reescribe lo anterior: la atención abierta conserva su código y el cambio queda en la actividad", async () => {
  await seedLists()
  const f = await clinicalFixture()
  await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
      diagnosisCode: "K02.1",
      diagnosisType: "confirmed",
    }),
  )
  await f.run((tx) => setOrgDiagnosisSystem(tx, "org_a", f.actor, "ICD-11"))
  const detail = await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, f.encounter.id))
  expect(detail.diagnoses.map((dx) => [dx.diagnosisSystem, dx.diagnosisCode])).toEqual([
    ["ICD-10", "K02.1"],
  ])
  // Se cierra con lo que ya tenía, aunque la clínica ya trabaje con la CIE-11.
  await f.run((tx) =>
    updateEncounterDraft(tx, ...f.args, f.encounter.id, { evolution: "Sin cambios" }),
  )
  expect(
    (await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))).encounter.status,
  ).toBe("finalizada")
  // Se puede volver atrás, y cada cambio queda en la actividad.
  await f.run((tx) => setOrgDiagnosisSystem(tx, "org_a", f.actor, "ICD-10"))
  const changes = await ownerDb
    .select({ metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, "org_a"),
        eq(auditEvent.action, "settings.diagnosis_system_changed"),
      ),
    )
  expect(changes.map((row) => row.metadata)).toEqual(
    expect.arrayContaining([
      { from: "ICD-10", to: "ICD-11" },
      { from: "ICD-11", to: "ICD-10" },
    ]),
  )
  await expect(
    f.run((tx) => setOrgDiagnosisSystem(tx, "org_a", f.actor, "ICD-10-PE")),
  ).rejects.toMatchObject({ status: 400 })
})

it("el buscador ignora tildes y mayúsculas, busca en la lista de la clínica y pone primero lo odontológico", async () => {
  await seedLists()
  const f = await clinicalFixture()
  const erupcion = await f.run((tx) => searchDiagnosisCodes(tx, "org_a", "ERUPCION"))
  expect(erupcion.map((row) => row.code)).toEqual(["K00.6"])
  const fractura = await f.run((tx) => searchDiagnosisCodes(tx, "org_a", "fractura"))
  expect(fractura.map((row) => row.code)).toEqual(["S02.5", "S02.0"])
  expect(
    (await f.run((tx) => searchDiagnosisCodes(tx, "org_a", "fractura diente"))).map(
      (row) => row.code,
    ),
  ).toEqual(["S02.5"])
  // El código sin punto también se encuentra; una categoría se marca.
  expect(await f.run((tx) => searchDiagnosisCodes(tx, "org_a", "k021"))).toEqual([
    { system: "ICD-10", code: "K02.1", description: "Caries de la dentina", isCategory: false },
  ])
  expect((await f.run((tx) => searchDiagnosisCodes(tx, "org_a", "K02")))[0]).toMatchObject({
    code: "K02",
    isCategory: true,
  })
  // Con la CIE-11 elegida, la CIE-10 no aparece.
  await f.run((tx) => setOrgDiagnosisSystem(tx, "org_a", f.actor, "ICD-11"))
  expect(
    (await f.run((tx) => searchDiagnosisCodes(tx, "org_a", "caries"))).map((row) => row.code),
  ).toEqual(["DA08.0"])
})

it("el odontograma propone el código del hallazgo y los más usados salen de la clínica", async () => {
  await seedLists()
  const f = await clinicalFixture()
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      encounterId: f.encounter.id,
      toothNumber: 16,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "dentin" },
    }),
  )
  const before = await f.run((tx) =>
    getDiagnosisSuggestions(tx, "org_a", { patientId: f.patient.id, encounterId: f.encounter.id }),
  )
  expect(before).toMatchObject({ system: "ICD-10", systemTitle: "CIE-10 (OMS)" })
  expect(before.proposed).toEqual([
    expect.objectContaining({
      code: "K02.1",
      description: "Caries de la dentina",
      toothNumber: 16,
      surfaces: ["occlusal"],
    }),
  ])
  // Ya diagnosticado en esta atención: deja de proponerse y pasa a los más usados.
  await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
      diagnosisCode: "K02.1",
      diagnosisType: "confirmed",
      toothNumber: 16,
    }),
  )
  const after = await f.run((tx) =>
    getDiagnosisSuggestions(tx, "org_a", { patientId: f.patient.id, encounterId: f.encounter.id }),
  )
  expect(after.proposed).toEqual([])
  expect(after.mostUsed.map((row) => row.code)).toContain("K02.1")
  // El hallazgo que se está marcando en la pieza propone en la lista de la clínica.
  await f.run((tx) => setOrgDiagnosisSystem(tx, "org_a", f.actor, "ICD-11"))
  const eleven = await f.run((tx) =>
    getDiagnosisSuggestions(tx, "org_a", {
      finding: { condition: "caries", variant: "dentin", toothNumber: 26 },
    }),
  )
  expect(eleven.proposed).toEqual([
    expect.objectContaining({ system: "ICD-11", code: "DA08.0", toothNumber: 26 }),
  ])
  // Lo más usado se arma de nuevo en la lista elegida: la CIE-10 no aparece.
  expect(eleven.mostUsed.every((row) => row.system === "ICD-11")).toBe(true)
  expect(eleven.mostUsed.map((row) => row.code)).not.toContain("K02.1")
})

it("«ya diagnosticado antes» lo marca el sistema solo dentro de la misma lista", async () => {
  await seedLists()
  const f = await clinicalFixture()
  await closeWith(f, f.encounter.id, "K02.1")
  const second = await f.run((tx) => createEncounter(tx, ...f.args, { reason: "Control" }))
  const repeated = await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, second.id, {
      diagnosisCode: "K02.1",
      diagnosisType: "confirmed",
    }),
  )
  expect(repeated.previouslyDiagnosed).toBe(true)
  const first = await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, second.id, {
      diagnosisCode: "S02.5",
      diagnosisType: "provisional",
    }),
  )
  expect(first.previouslyDiagnosed).toBe(false)
  // La caries de la CIE-11 no es «la misma» que la de la CIE-10: no se marca.
  await f.run((tx) => setOrgDiagnosisSystem(tx, "org_a", f.actor, "ICD-11"))
  const otherList = await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, second.id, {
      diagnosisCode: "DA08.0",
      diagnosisType: "confirmed",
    }),
  )
  expect(otherList.previouslyDiagnosed).toBe(false)
  // «Repetido» ya no se elige.
  await expect(
    f.run((tx) =>
      addEncounterDiagnosis(tx, ...f.args, second.id, {
        diagnosisCode: "DA08.0",
        diagnosisType: "repetido",
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
})

it("los CHECK aceptan solo códigos internacionales o la palabra del país con su prefijo", async () => {
  const f = await clinicalFixture()
  const set = (column: string, value: string) =>
    ownerDb.execute(
      sql`update "patient" set ${sql.identifier(column)} = ${value} where "id" = ${f.patient.id}`,
    )
  await expect(set("marital_status", "casado")).rejects.toThrow()
  await expect(set("marital_status", "C")).rejects.toThrow()
  await set("marital_status", "T")
  await set("marital_status", "PE:conviviente")
  await expect(set("education_level", "superior_universitaria_completa")).rejects.toThrow()
  await expect(set("education_level", "9")).rejects.toThrow()
  await set("education_level", "6")
  await expect(
    ownerDb.insert(patientFamilyHistory).values({
      organizationId: "org_a",
      patientId: f.patient.id,
      relationship: "madre",
      condition: "Diabetes",
    }),
  ).rejects.toThrow()
  await ownerDb.insert(patientFamilyHistory).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    relationship: "MGRPRN",
    condition: "Diabetes",
  })
  // La ficha tiene siempre su vínculo propio (persona única): el check se prueba con él.
  const [link] = await ownerDb
    .select({ id: patientContact.id })
    .from(patientContact)
    .where(eq(patientContact.patientId, f.patient.id))
    .limit(1)
  expect(link).toBeDefined()
  await expect(
    ownerDb.update(patientContact).set({ kinship: "madre" }).where(eq(patientContact.id, link!.id)),
  ).rejects.toThrow()
  await ownerDb
    .update(patientContact)
    .set({ kinship: "FRND" })
    .where(eq(patientContact.id, link!.id))
  // Un código que no está en su lista no entra por la FK compuesta.
  await expect(
    ownerDb.execute(
      sql`insert into "patient_condition" ("organization_id", "patient_id", "name", "diagnosis_system", "diagnosis_code") values ('org_a', ${f.patient.id}, 'X', 'ICD-11', 'K02.1')`,
    ),
  ).rejects.toThrow()
  // La lista sin código (o al revés) tampoco.
  await expect(
    ownerDb.execute(
      sql`insert into "patient_condition" ("organization_id", "patient_id", "name", "diagnosis_system") values ('org_a', ${f.patient.id}, 'X', 'ICD-10')`,
    ),
  ).rejects.toThrow()
})

it("el estado civil se valida con el perfil del país: en Perú «Conviviente», no T", async () => {
  const f = await clinicalFixture()
  await expect(
    f.run((tx) => updatePatient(tx, "org_a", f.actor, f.patient.id, { maritalStatus: "T" })),
  ).rejects.toMatchObject({
    status: 400,
  })
  await f.run((tx) =>
    updatePatient(tx, "org_a", f.actor, f.patient.id, {
      maritalStatus: "PE:conviviente",
      educationLevel: "3",
    }),
  )
  const [row] = await ownerDb.select().from(patient).where(eq(patient.id, f.patient.id))
  expect(row).toMatchObject({ maritalStatus: "PE:conviviente", educationLevel: "3" })
})
