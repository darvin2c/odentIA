/**
 * La clínica nace con sus consentimientos activos y unidos a sus servicios; se
 * editan guardando una sola vez, se apagan sin tocar lo firmado y lo apagado deja
 * de pedirse. Revisar avisa, no bloquea.
 */
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { SUGGESTED_CONSENT_TEMPLATES } from "@odentia/clinical"
import { type Db, withOrgContext } from "@odentia/db"
import { appointmentBookingLink } from "@odentia/db/schema/agenda"
import { serviceCatalog, treatmentTemplate } from "@odentia/db/schema/clinical"
import { consentTemplate, consentTemplateService } from "@odentia/db/schema/clinical-forms"
import { and, eq, sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { savePatientHealth } from "./clinical.js"
import {
  createConsentDocument,
  createConsentTemplate,
  ensureClinicConsents,
  getEncounterConsentNeeds,
  linkServicesToSuggestedConsents,
  listConsentsToPublish,
  listConsentTemplates,
  markConsentTemplateReviewed,
  parseConsentDraft,
  saveConsentTemplate,
  setConsentTemplateActive,
  setConsentTemplateServices,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { renderConsentPreviewPdf } from "./consent-pdf.js"
import { loadDocumentClinic } from "./document-clinic.js"
import { addEncounterProcedure } from "./encounters.js"
import { patientHealthToAsk } from "./patient-registration.js"
import { createPatient } from "./patients.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ACTOR = "u-consentimientos"
const sections = {
  procedure: "Extracción de la pieza dentaria con anestesia local.",
  benefits: ["Quitar el dolor y la infección"],
  risks: ["Sangrado y dolor los primeros días"],
  alternatives: ["Conservar la pieza con una endodoncia"],
  consequences: "Puede seguir la infección y el dolor.",
}

beforeAll(async () => {
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values (${ACTOR}, 'Dra. Revisa', 'revisa@example.com')
        on conflict ("id") do nothing`,
  )
})

/** Una clínica nueva, para que lo de una prueba no se mezcle con otra. */
async function newClinic() {
  const orgId = `org_${randomUUID().slice(0, 8)}`
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values (${orgId}, ${orgId}, ${orgId}, now())`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "product", "legal_name", "country_code", "currency", "timezone", "locale")
        values (${orgId}, 'dental', 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  return { orgId, run }
}

/** Un servicio de la biblioteca (con su clave) o uno propio. */
async function service(orgId: string, name: string, libraryKey: string | null) {
  let templateId: string | null = null
  if (libraryKey) {
    const key = `${libraryKey}${randomUUID().slice(0, 6)}`
    const [template] = await ownerDb
      .insert(treatmentTemplate)
      .values({ key, name, kind: "general", scope: "general", product: "dental" })
      .returning()
    templateId = template!.id
  }
  const [row] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: orgId,
      templateId,
      source: libraryKey ? "template" : "custom",
      name,
      scope: "general",
      priceCents: 1000,
      currency: "PEN",
    })
    .returning()
  return row!
}

const linkedKeys = async (orgId: string, serviceId: string) =>
  (
    await ownerDb
      .select({ key: consentTemplateService.templateKey })
      .from(consentTemplateService)
      .where(and(eq(consentTemplateService.organizationId, orgId), eq(consentTemplateService.serviceId, serviceId)))
  ).map((row) => row.key)

it("una clínica nace con lo sugerido activo, sin revisar y unido a sus servicios de la biblioteca", async () => {
  const { orgId, run } = await newClinic()
  const extraction = await service(orgId, "Extracción", "exodoncia-prueba-")
  const cleaning = await service(orgId, "Limpieza", "profilaxis-prueba-")
  const own = await service(orgId, "Extracción de la casa", null)
  const created = await run((tx) => ensureClinicConsents(tx, orgId, ACTOR))
  expect(created.map((row) => row.key).sort()).toEqual(SUGGESTED_CONSENT_TEMPLATES.map((row) => row.key).sort())
  expect(created.every((row) => row.status === "publicado" && !row.reviewedAt)).toBe(true)
  expect(await linkedKeys(orgId, extraction.id)).toEqual(["exodoncia"])
  // Lo que no está en la regla no pide consentimiento, y uno propio se elige a mano.
  expect(await linkedKeys(orgId, cleaning.id)).toEqual([])
  expect(await linkedKeys(orgId, own.id)).toEqual([])
  // Un servicio que llega después también queda unido.
  const later = await service(orgId, "Implante", "colocacion-de-implante-prueba-")
  await run((tx) => linkServicesToSuggestedConsents(tx, orgId, ACTOR, { serviceIds: [later.id] }))
  expect(await linkedKeys(orgId, later.id)).toEqual(["implante"])
})

it("lo que la clínica apagó o cambió no se vuelve a crear, y lo que ella unió no se toca", async () => {
  const { orgId, run } = await newClinic()
  const created = await run((tx) => ensureClinicConsents(tx, orgId, ACTOR))
  const implant = created.find((row) => row.key === "implante")!
  await run((tx) => setConsentTemplateActive(tx, orgId, ACTOR, implant.id, false))
  expect(await run((tx) => ensureClinicConsents(tx, orgId, ACTOR))).toEqual([])
  const rows = await run((tx) => listConsentTemplates(tx, orgId))
  expect(rows.filter((row) => row.key === "implante").map((row) => row.status)).toEqual(["archivado"])
})

it("guardar crea la versión y la deja en uso; lo firmado conserva su texto", async () => {
  const { orgId, run } = await newClinic()
  const [first] = await run((tx) => ensureClinicConsents(tx, orgId, ACTOR))
  const key = first!.key
  const patient = await run((tx) => createPatient(tx, orgId, ACTOR, { displayName: "Ana Prueba" }))
  const doc = await run((tx) => createConsentDocument(tx, orgId, ACTOR, { templateId: first!.id, patientId: patient.id, procedureRef: "Extracción" }))
  const saved = await run((tx) => saveConsentTemplate(tx, orgId, ACTOR, { key, title: "Texto de mi clínica", sections }))
  expect(saved).toMatchObject({ version: 2, status: "publicado", title: "Texto de mi clínica", reviewedBy: ACTOR })
  const rows = await run((tx) => listConsentTemplates(tx, orgId))
  expect(rows.filter((row) => row.key === key).map((row) => row.status).sort()).toEqual(["archivado", "publicado"])
  expect(doc.titleSnapshot).toBe(first!.title)
  // Guardar sin cambios no crea otra versión.
  const again = await run((tx) => saveConsentTemplate(tx, orgId, ACTOR, { key, title: "Texto de mi clínica", sections }))
  expect(again.version).toBe(2)
  // Uno nuevo no puede pisar a otro por llamarse igual.
  await expect(
    run((tx) => saveConsentTemplate(tx, orgId, ACTOR, { title: "Texto de mi clínica", sections: { ...sections } })).then(() =>
      run((tx) => saveConsentTemplate(tx, orgId, ACTOR, { title: "Texto de mi clínica", sections: { ...sections } })),
    ),
  ).rejects.toMatchObject({ fields: { title: "Ya hay un consentimiento con ese título" } })
})

it("uno apagado sigue apagado al guardarlo y vuelve a su última versión al encenderlo", async () => {
  const { orgId, run } = await newClinic()
  const [first] = await run((tx) => ensureClinicConsents(tx, orgId, ACTOR))
  await run((tx) => setConsentTemplateActive(tx, orgId, ACTOR, first!.id, false))
  const saved = await run((tx) => saveConsentTemplate(tx, orgId, ACTOR, { key: first!.key, title: "Cambiado", sections }))
  expect(saved.status).toBe("archivado")
  const back = await run((tx) => setConsentTemplateActive(tx, orgId, ACTOR, first!.id, true))
  expect(back).toMatchObject({ status: "publicado", version: 2, title: "Cambiado" })
  // Encender dos veces no cambia nada.
  expect((await run((tx) => setConsentTemplateActive(tx, orgId, ACTOR, first!.id, true))).id).toBe(back.id)
})

it("revisar no crea otra versión, y el texto publicado sigue sin poder cambiarse", async () => {
  const { orgId, run } = await newClinic()
  const [first] = await run((tx) => ensureClinicConsents(tx, orgId, ACTOR))
  const reviewed = await run((tx) => markConsentTemplateReviewed(tx, orgId, ACTOR, first!.id))
  expect(reviewed).toMatchObject({ version: 1, status: "publicado", reviewedBy: ACTOR })
  expect(reviewed.reviewedAt).toBeTruthy()
  const rows = await run((tx) => listConsentTemplates(tx, orgId))
  expect(rows.find((row) => row.id === first!.id)?.reviewerName).toBe("Dra. Revisa")
  await expect(
    ownerDb.update(consentTemplate).set({ body: "Otro texto" }).where(eq(consentTemplate.id, first!.id)),
  ).rejects.toThrow()
})

it("la atención no pide uno que la clínica apagó, ni «Te espera» se lo recuerda", async () => {
  const v = await clinicalFixture()
  const orgId = "org_a"
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const extraction = await service(orgId, "Extracción apagada", null)
  const template = await run((tx) =>
    createConsentTemplate(tx, orgId, v.actor, { key: `apagado-${randomUUID().slice(0, 8)}`, title: "Apagado", sections }),
  )
  await run((tx) => setConsentTemplateServices(tx, orgId, v.actor, template.id, [extraction.id]))
  await run((tx) => setConsentTemplateActive(tx, orgId, v.actor, template.id, true))
  await run((tx) =>
    addEncounterProcedure(tx, orgId, v.actor, v.patient.id, v.encounter.id, { serviceId: extraction.id }),
  )
  const asked = await run((tx) => getEncounterConsentNeeds(tx, orgId, v.patient.id, v.encounter.id))
  expect(asked.map((need) => need.templateKey)).toContain(template.key)
  await run((tx) => setConsentTemplateActive(tx, orgId, v.actor, template.id, false))
  const after = await run((tx) => getEncounterConsentNeeds(tx, orgId, v.patient.id, v.encounter.id))
  expect(after.map((need) => need.templateKey)).not.toContain(template.key)
  const waiting = await run((tx) => listConsentsToPublish(tx, orgId))
  expect(waiting.map((item) => item.templateKey)).not.toContain(template.key)
})

it("la vista previa sale del mismo generador y un dato incompleto se dice en su campo", async () => {
  const { orgId, run } = await newClinic()
  const clinic = await run((tx) => loadDocumentClinic(tx, orgId))
  const bytes = await renderConsentPreviewPdf(clinic, {
    ...parseConsentDraft({ title: "Exodoncia", sections }),
    version: 1,
  })
  expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-")
  expect(() => parseConsentDraft({ title: "Exodoncia", sections: { ...sections, risks: [] } })).toThrow(/Riesgos/)
})

it("las clínicas de hoy quedan igual que una nueva, sin tocar lo que ya decidieron", async () => {
  const { orgId, run } = await newClinic()
  const extraction = await service(orgId, "Extracción", "exodoncia-migra-")
  // Ya publicó su implante, con su propio texto, y dejó sin tocar el borrador sugerido de exodoncia.
  const own = await run((tx) =>
    createConsentTemplate(tx, orgId, ACTOR, { key: "implante", title: "Mi implante", sections }),
  )
  await run((tx) => setConsentTemplateActive(tx, orgId, ACTOR, own.id, true))
  const suggested = SUGGESTED_CONSENT_TEMPLATES.find((row) => row.key === "exodoncia")!
  await run((tx) =>
    createConsentTemplate(tx, orgId, ACTOR, { key: "exodoncia", title: suggested.title, sections: suggested.sections }),
  )
  const file = readFileSync(new URL("../../db/drizzle/0028_consentimientos_activos.sql", import.meta.url), "utf8")
  await ownerDb.transaction(async (tx) => {
    for (const statement of file.split("--> statement-breakpoint")) await tx.execute(sql.raw(statement))
  })
  const rows = await run((tx) => listConsentTemplates(tx, orgId))
  const byKey = new Map(rows.map((row) => [row.key, row]))
  expect(byKey.size).toBe(SUGGESTED_CONSENT_TEMPLATES.length)
  expect(byKey.get("implante")).toMatchObject({ title: "Mi implante", version: 1, status: "publicado" })
  expect(byKey.get("implante")?.reviewedAt).toBeTruthy()
  expect(byKey.get("exodoncia")).toMatchObject({ status: "publicado", reviewedAt: null })
  expect(byKey.get("endodoncia")).toMatchObject({ status: "publicado", reviewedAt: null })
  expect(await linkedKeys(orgId, extraction.id)).toEqual(["exodoncia"])
})

it("hay que preguntarle su salud mientras nadie la registró y no envió «Tus datos»", async () => {
  const { orgId, run } = await newClinic()
  const patient = await run((tx) => createPatient(tx, orgId, ACTOR, { displayName: "Sin Salud" }))
  expect(await run((tx) => patientHealthToAsk(tx, orgId, patient.id))).toBe(true)
  // Envió sus datos dejando la salud en blanco, que es opcional: no se le insiste.
  await ownerDb.insert(appointmentBookingLink).values({
    organizationId: orgId,
    patientId: patient.id,
    contactId: patient.personId,
    tokenHash: randomUUID(),
    expiresAt: new Date(Date.now() + 86_400_000),
    dataSubmittedAt: new Date(),
  } as typeof appointmentBookingLink.$inferInsert)
  expect(await run((tx) => patientHealthToAsk(tx, orgId, patient.id))).toBe(false)
  // Y a quien ya tiene su salud registrada tampoco.
  const other = await run((tx) => createPatient(tx, orgId, ACTOR, { displayName: "Con Salud" }))
  await run((tx) =>
    savePatientHealth(tx, orgId, ACTOR, other.id, {
      expectedRevision: 0,
      reviewStatus: { allergies: "none", conditions: "none", medications: "none" },
      allergies: [],
      conditions: [],
      medications: [],
    }),
  )
  expect(await run((tx) => patientHealthToAsk(tx, orgId, other.id))).toBe(false)
})
