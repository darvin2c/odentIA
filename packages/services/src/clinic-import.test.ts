import { withOrgContext } from "@odentia/db"
import { clinicImportRow } from "@odentia/db/schema/admin-imports"
import { user } from "@odentia/db/schema/auth"
import { automationJob } from "@odentia/db/schema/automation"
import { patient, patientContact } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { orgProfile } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import { applyClinicImportBatch, CLINIC_IMPORT_BATCH, previewClinicImport } from "./clinic-import.js"
import type { ClinicImportPerson, ClinicImportPlan } from "./clinic-import-plan.js"
import { createPatient } from "./patients.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ORG = "org_a"
const admin: AdminActor = { userId: "t-import-admin", role: "admin" }
const support: AdminActor = { userId: "t-import-support", role: "support" }

function person(key: string, demographics: Partial<ClinicImportPerson["demographics"]>, extra: Partial<ClinicImportPerson> = {}): ClinicImportPerson {
  const displayName = demographics.displayName ?? [demographics.givenNames, demographics.familyName].filter(Boolean).join(" ")
  return { key, patient: true, demographics: { ...demographics, displayName }, origin: { file: "pacientes.csv", row: 2 }, ...extra }
}

function planOf(people: ClinicImportPerson[], countryCode = "PE"): ClinicImportPlan {
  return { version: 1, countryCode, sources: [{ name: "pacientes.csv", sha256: "b".repeat(64) }], people, omitted: [{ file: "pacientes.csv", row: 9, reason: "Sin nombre" }] }
}

const inOrg = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(ownerDb, ORG, fn)

beforeAll(async () => {
  for (const actor of [admin, support])
    await ownerDb.insert(user).values({ id: actor.userId, name: `Equipo ${actor.role}`, firstName: "Equipo", lastName: actor.role, email: `${actor.userId}@odentia.test`, emailVerified: true }).onConflictDoNothing()
  // Alguien que ya estaba en la clínica antes de la carga.
  await inOrg((tx) => createPatient(tx, ORG, admin.userId, { displayName: "Carla Vega", givenNames: "Carla", familyName: "Vega", docType: "DNI", docNumber: "11112222" }))
})

const plan = planOf([
  person("10", { givenNames: "Mateo", familyName: "Quispe", birthDate: "2018-08-20" }, { guardian: { key: "11", relationship: "guardian", kinship: "MTH" } }),
  person("11", { givenNames: "Rosa", familyName: "Quispe", birthDate: "1990-11-15", docType: "DNI", docNumber: "45678901", phone: "+51987654322" }),
  person("12/responsable", { givenNames: "Carmen", familyName: "Soto", phone: "+51987000999" }, { patient: false }),
  person("12", { givenNames: "Ana", familyName: "Soto", birthDate: "2015-01-01" }, { guardian: { key: "12/responsable", relationship: "guardian" } }),
  person("13", { givenNames: "Carla", familyName: "Vega", docType: "DNI", docNumber: "11112222", phone: "+51987000123" }),
  person("14", { givenNames: "Luis", familyName: "Torres", docType: "DNI", docNumber: "123" }),
])

describe("cargar los datos de una clínica", () => {
  it("el ensayo dice qué pasará con cada fila y no escribe nada", async () => {
    const preview = await inOrg((tx) => previewClinicImport(tx, ORG, admin, plan))
    expect(preview.order.indexOf("11")).toBeLessThan(preview.order.indexOf("10"))
    expect(preview.totals).toMatchObject({ nuevas: 4, pacientes: 3, responsables: 1, existen: 1, errores: 1, cargadas: 0, fuera: 1 })
    expect(preview.rows.find((row) => row.key === "13")).toMatchObject({ status: "existe", messages: [{ level: "aviso", message: "Ya está en la clínica como Carla Vega: no se toca" }] })
    expect(preview.rows.find((row) => row.key === "14")).toMatchObject({ status: "error" })
    const written = await ownerDb.select().from(clinicImportRow).where(eq(clinicImportRow.organizationId, ORG))
    expect(written).toHaveLength(0)
  })

  it("solo la administración carga, y con el país de la clínica", async () => {
    await expect(inOrg((tx) => applyClinicImportBatch(tx, ORG, support, plan, 0))).rejects.toMatchObject({ status: 403 })
    await expect(inOrg((tx) => previewClinicImport(tx, ORG, admin, planOf(plan.people, "CL")))).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("crea fichas y vínculos con las operaciones de siempre, sin mensajes, y repetir no duplica", async () => {
    const first = await inOrg((tx) => applyClinicImportBatch(tx, ORG, admin, plan, 0))
    expect(first).toMatchObject({ next: 6, total: 6, done: { creadas: 4, existentes: 1, yaCargadas: 0, errores: 1 } })
    expect(first.failed).toEqual([{ key: "14", name: "Luis Torres", message: expect.stringContaining("DNI") }])

    const [mateo] = await ownerDb
      .select({ patientId: patient.id })
      .from(patient)
      .innerJoin(contact, and(eq(contact.organizationId, patient.organizationId), eq(contact.id, patient.personId)))
      .where(and(eq(patient.organizationId, ORG), eq(contact.displayName, "Mateo Quispe")))
    const links = await ownerDb
      .select({ relationship: patientContact.relationship, kinship: patientContact.kinship, isPreferred: patientContact.isPreferred, name: contact.displayName })
      .from(patientContact)
      .innerJoin(contact, and(eq(contact.organizationId, patientContact.organizationId), eq(contact.id, patientContact.contactId)))
      .where(and(eq(patientContact.organizationId, ORG), eq(patientContact.patientId, mateo!.patientId)))
    expect(links).toContainEqual({ relationship: "guardian", kinship: "MTH", isPreferred: true, name: "Rosa Quispe" })

    const carmen = await ownerDb.select({ id: patient.id }).from(patient).innerJoin(contact, eq(contact.id, patient.personId)).where(eq(contact.displayName, "Carmen Soto"))
    expect(carmen).toHaveLength(0)
    expect(await ownerDb.select().from(automationJob).where(eq(automationJob.organizationId, ORG))).toHaveLength(0)

    // Lo que dejó la carga es de odentIA: con el rol de la aplicación, la ficha de Mateo
    // sigue pudiendo pasar a su contacto real cuando escriba.
    const [placeholder] = await withOrgContext(appDb, ORG, async (tx) => {
      const [row] = await tx
        .select({ personId: patient.personId })
        .from(patient)
        .where(and(eq(patient.organizationId, ORG), eq(patient.id, mateo!.patientId)))
      return tx.execute<{ placeholder: boolean }>(sql`select is_placeholder_person(${ORG}, ${row!.personId}::uuid, ${mateo!.patientId}::uuid) as placeholder`)
    })
    expect(placeholder?.placeholder).toBe(true)

    const again = await inOrg((tx) => applyClinicImportBatch(tx, ORG, admin, plan, 0))
    expect(again.done).toMatchObject({ creadas: 0, existentes: 0, yaCargadas: 5, errores: 1 })
    const patients = await ownerDb.select({ id: patient.id }).from(patient).where(eq(patient.organizationId, ORG))
    expect(patients).toHaveLength(4)

    const preview = await inOrg((tx) => previewClinicImport(tx, ORG, admin, plan))
    expect(preview.totals).toMatchObject({ nuevas: 0, cargadas: 5, errores: 1 })
  })

  it("una carga cortada sigue por tandas desde donde quedó", async () => {
    const many = planOf(
      Array.from({ length: CLINIC_IMPORT_BATCH + 5 }, (_, i) =>
        person(`m-${i}`, { givenNames: `Persona ${i}`, familyName: "Lote", phone: `+5198${String(i).padStart(7, "0")}` }),
      ),
    )
    const first = await inOrg((tx) => applyClinicImportBatch(tx, ORG, admin, many, 0))
    expect(first).toMatchObject({ next: CLINIC_IMPORT_BATCH, total: CLINIC_IMPORT_BATCH + 5, done: { creadas: CLINIC_IMPORT_BATCH } })
    const second = await inOrg((tx) => applyClinicImportBatch(tx, ORG, admin, many, first.next))
    expect(second).toMatchObject({ next: CLINIC_IMPORT_BATCH + 5, done: { creadas: 5 } })
  })

  it("carga igual en un consultorio de latidIA", async () => {
    await ownerDb.update(orgProfile).set({ product: "medical" }).where(eq(orgProfile.organizationId, "org_b"))
    const medical = planOf([
      person("1", { givenNames: "Elena", familyName: "Ríos", birthDate: "1975-03-03", phone: "+51987111222" }),
      person("2", { givenNames: "Tomás", familyName: "Ríos", birthDate: "2012-06-06" }, { guardian: { key: "1", relationship: "guardian", kinship: "MTH" } }),
    ])
    const result = await withOrgContext(ownerDb, "org_b", (tx) => applyClinicImportBatch(tx, "org_b", admin, medical, 0))
    expect(result.done).toMatchObject({ creadas: 2, errores: 0 })
    const patients = await ownerDb.select({ id: patient.id }).from(patient).where(eq(patient.organizationId, "org_b"))
    expect(patients).toHaveLength(2)
  })
})
