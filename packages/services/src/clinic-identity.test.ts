/**
 * Un solo nombre visible (decisión 19): el nombre comercial, en «Su enlace»,
 * en WhatsApp y en la cuenta. La razón social solo respalda datos viejos.
 */
import { randomUUID } from "node:crypto"
import { brandPalette } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, eq, like } from "drizzle-orm"
import { expect, it } from "vitest"
import { findClinicName } from "./automation-routing.js"
import { clinicNameOf } from "./booking-links.js"
import { clinicDisplayName, getClinicBrandColor, setClinicBrandColor } from "./clinic-identity.js"
import { getOdontogramPrint } from "./dental/odontogram.js"
import { loadDocumentClinic, loadDocumentLetterhead } from "./document-clinic.js"
import { nextPatientNumber } from "./patients.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("«Su enlace», WhatsApp y la cuenta dicen el nombre comercial; vacío, la razón social", async () => {
  const orgId = `org_${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  await ownerDb
    .update(orgProfile)
    .set({ legalName: "Dental Sonrisa S.A.C.", tradeName: "Sonrisa" })
    .where(eq(orgProfile.organizationId, orgId))
  // La página que abre el botón del WhatsApp («Su enlace») y el WhatsApp dicen lo mismo.
  expect(await run((tx) => clinicNameOf(tx, orgId))).toBe("Sonrisa")
  expect(await run((tx) => findClinicName(tx, orgId))).toBe("Sonrisa")
  expect(await run((tx) => clinicDisplayName(tx, orgId))).toBe("Sonrisa")
  // La cuenta (chat web, registro, pantallas) lee la misma copia.
  const [account] = await ownerDb.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId))
  expect(account?.name).toBe("Sonrisa")
  // Sin nombre comercial (datos viejos), la base pone la razón social.
  await ownerDb.update(orgProfile).set({ tradeName: "  " }).where(eq(orgProfile.organizationId, orgId))
  expect(await run((tx) => clinicNameOf(tx, orgId))).toBe("Dental Sonrisa S.A.C.")
  const [after] = await ownerDb.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId))
  expect(after?.name).toBe("Dental Sonrisa S.A.C.")
})

it("el color de la marca: se guarda normalizado, el de fábrica es volver a como viene y queda en la actividad", async () => {
  const orgId = `org_${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  expect(await run((tx) => getClinicBrandColor(tx, orgId))).toEqual({ brandColor: null, product: "dental" })

  expect(await run((tx) => setClinicBrandColor(tx, orgId, "user_1", "#1D5FA8"))).toEqual({ brandColor: "#1d5fa8" })
  expect((await run((tx) => getClinicBrandColor(tx, orgId))).brandColor).toBe("#1d5fa8")
  // Un rojo vale igual; la actividad guarda que se avisó.
  await run((tx) => setClinicBrandColor(tx, orgId, "user_1", "e11d48"))
  // El turquesa de odentIA es el de fábrica: elegirlo deja la clínica como viene.
  expect(await run((tx) => setClinicBrandColor(tx, orgId, "user_1", "#0e7490"))).toEqual({ brandColor: null })
  await expect(run((tx) => setClinicBrandColor(tx, orgId, "user_1", "#12"))).rejects.toMatchObject({
    code: "VALIDATION",
    fields: { color: expect.any(String) },
  })

  const events = await ownerDb
    .select({ action: auditEvent.action, metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(and(eq(auditEvent.organizationId, orgId), like(auditEvent.action, "org_profile.brand_color%")))
    .orderBy(auditEvent.createdAt)
  expect(events).toEqual([
    { action: "org_profile.brand_color_set", metadata: { color: "#1d5fa8" } },
    { action: "org_profile.brand_color_set", metadata: { color: "#e11d48", warnedReddish: true } },
    { action: "org_profile.brand_color_removed", metadata: {} },
  ])
  // La base no acepta un color mal escrito aunque alguien se salte el servicio.
  await expect(
    ownerDb.update(orgProfile).set({ brandColor: "azul" }).where(eq(orgProfile.organizationId, orgId)),
  ).rejects.toThrow()
})

it("el papel lleva el tono legible del color en la línea del membrete; sin color, tinta", async () => {
  const orgId = `org_${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  expect((await run((tx) => loadDocumentClinic(tx, orgId))).brandInk).toBeNull()
  expect((await run((tx) => loadDocumentLetterhead(tx, orgId))).brandInk).toBeNull()
  // Un celeste claro se oscurece para el papel; el elegido se guarda igual.
  await run((tx) => setClinicBrandColor(tx, orgId, "user_1", "#7cc4ec"))
  const ink = (await run((tx) => loadDocumentClinic(tx, orgId))).brandInk
  expect(ink).toBe(brandPalette("#7cc4ec").paper)
  expect(ink).not.toBe("#7cc4ec")
  expect((await run((tx) => loadDocumentLetterhead(tx, orgId))).brandInk).toBe(ink)
})

it("la hoja del odontograma lleva la línea en el mismo tono que los demás papeles; sin color, gris", async () => {
  const orgId = `org_${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const [patient] = await insertTestPatients(ownerDb, {
    organizationId: orgId,
    displayName: "Rosa Díaz",
    patientNumber: await nextPatientNumber(ownerDb, orgId),
  })
  const sheet = () => run((tx) => getOdontogramPrint(tx, orgId, patient!.id))
  expect((await sheet()).establishment?.brandInk).toBeNull()
  await run((tx) => setClinicBrandColor(tx, orgId, "user_1", "#ea580c"))
  expect((await sheet()).establishment?.brandInk).toBe((await run((tx) => loadDocumentClinic(tx, orgId))).brandInk)
  // El color elegido no viaja crudo en la hoja: solo el tono legible del papel.
  expect((await sheet()).establishment).not.toHaveProperty("brandColor")
})
