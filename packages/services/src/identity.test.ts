import { patientContact } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { patientRegistrationConfig } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { getMessagePermissions, hasConsent, mayWriteFirst, setConsent } from "./automation.js"
import { getPatientHealth, savePatientHealth } from "./clinical.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { updateContact } from "./contacts.js"
import { grantDataConsent, listDataConsents, revokeDataConsent } from "./data-consents.js"
import { updatePatient } from "./patients.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function ownPerson(patientId: string) {
  const [row] = await ownerDb
    .select({ id: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, patientId), eq(patientContact.relationship, "self")))
  if (!row) throw new Error("Sin persona propia")
  return row.id
}

it("el nombre separado deriva el visible, el teléfono queda en E.164 y la persona lo recibe", async () => {
  const f = await clinicalFixture()
  const updated = await f.run((tx) =>
    updatePatient(tx, "org_a", f.actor, f.patient.id, {
      givenNames: "Rosa María",
      paternalSurname: "Quispe",
      maternalSurname: "Huamán",
      phone: "987 654 321",
      docType: "PASAPORTE",
      docNumber: "AB123456",
      docCountry: "ve",
      maritalStatus: "M",
      identityConfirmed: true,
    }),
  )
  expect(updated).toMatchObject({
    displayName: "Rosa María Quispe Huamán",
    phone: "+51987654321",
    docCountry: "VE",
    identityNeedsReview: false,
  })
  const [person] = await ownerDb
    .select()
    .from(contact)
    .where(eq(contact.id, await ownPerson(f.patient.id)))
  expect(person).toMatchObject({
    displayName: "Rosa María Quispe Huamán",
    givenNames: "Rosa María",
  })
  // Un departamento fuera de la lista del Perú y un catálogo inválido se rechazan.
  await expect(
    f.run((tx) => updatePatient(tx, "org_a", f.actor, f.patient.id, { addressRegion: "Lima" })),
  ).rejects.toMatchObject({ status: 400 })
  const withRegion = await f.run((tx) =>
    updatePatient(tx, "org_a", f.actor, f.patient.id, { address: "Jr. Las Begonias 120", addressRegion: "PE-LMA" }),
  )
  // La dirección toma el país de la clínica si no se eligió otro.
  expect(withRegion).toMatchObject({ addressRegion: "PE-LMA", addressCountry: "PE" })
  // Solo cambiar el número no le quita su país emisor al pasaporte.
  const renumbered = await f.run((tx) =>
    updatePatient(tx, "org_a", f.actor, f.patient.id, { docNumber: "AB654321" }),
  )
  expect(renumbered).toMatchObject({ docType: "PASAPORTE", docCountry: "VE" })
  await expect(
    f.run((tx) =>
      updatePatient(tx, "org_a", f.actor, f.patient.id, { maritalStatus: "unión libre" }),
    ),
  ).rejects.toMatchObject({ status: 400 })
})

it("un paciente que pasa a menor exige representante legal; Contactos valida el DNI", async () => {
  const f = await clinicalFixture()
  await expect(
    f.run((tx) => updatePatient(tx, "org_a", f.actor, f.patient.id, { birthDate: "2018-05-01" })),
  ).rejects.toMatchObject({ code: "REPRESENTATIVE_REQUIRED" })
  const personId = await ownPerson(f.patient.id)
  await expect(
    f.run((tx) => updateContact(tx, "org_a", personId, { docType: "DNI", docNumber: "123" })),
  ).rejects.toMatchObject({ status: 400 })
})

it("el consentimiento de datos guarda la versión del aviso y revocarlo da de baja lo comercial", async () => {
  const f = await clinicalFixture()
  await ownerDb
    .insert(patientRegistrationConfig)
    .values({
      organizationId: "org_a",
      version: 3,
      enabled: true,
      fields: {} as never,
      privacyNotice: "Aviso de privacidad v3",
    })
    .onConflictDoUpdate({
      target: patientRegistrationConfig.organizationId,
      set: { version: 3, privacyNotice: "Aviso de privacidad v3" },
    })
  const personId = await ownPerson(f.patient.id)
  await f.run((tx) =>
    setConsent(tx, "org_a", f.actor, personId, {
      purpose: "recordatorio",
      granted: true,
    }),
  )
  await expect(
    f.run((tx) =>
      grantDataConsent(tx, "org_a", f.actor, f.patient.id, {
        purposes: ["recordatorios"],
        grantedByContactId: personId,
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const granted = await f.run((tx) =>
    grantDataConsent(tx, "org_a", f.actor, f.patient.id, {
      purposes: ["atencion", "comunicaciones"],
      grantedByContactId: personId,
    }),
  )
  expect(granted).toMatchObject({ noticeVersion: 3, noticeText: "Aviso de privacidad v3" })
  // Lo aceptado en el consentimiento es el permiso de mensajes, sin otro paso:
  // «comunicaciones» concede novedades y promociones, lo único que pide permiso
  // (ADR 0030); lo de su atención no se pregunta y no se toca.
  expect(await f.run((tx) => getMessagePermissions(tx, "org_a", personId))).toMatchObject([
    { purpose: "recordatorio", granted: true },
    { purpose: "seguimiento", granted: null },
    { purpose: "novedades", granted: true, source: "presencial" },
    { purpose: "avisos", granted: null },
  ])
  await f.run((tx) =>
    revokeDataConsent(tx, "org_a", f.actor, f.patient.id, granted.id, { reason: "Lo pidió" }),
  )
  const [row] = await f.run((tx) => listDataConsents(tx, "org_a", f.patient.id))
  expect(row?.revokeReason).toBe("Lo pidió")
  expect(await f.run((tx) => hasConsent(tx, "org_a", personId, "recordatorio"))).toBe(false)
  // Revocar el consentimiento de datos apaga todos sus mensajes, también los
  // de su atención y los avisos, que no tenían fila (ADR 0040).
  expect(await f.run((tx) => getMessagePermissions(tx, "org_a", personId))).toMatchObject([
    { purpose: "recordatorio", granted: false, source: "revocacion_datos" },
    { purpose: "seguimiento", granted: false, source: "revocacion_datos" },
    { purpose: "novedades", granted: false, source: "revocacion_datos" },
    { purpose: "avisos", granted: false, source: "revocacion_datos" },
  ])
  expect(await f.run((tx) => mayWriteFirst(tx, "org_a", personId, "avisos"))).toBe(false)
  // Revocar no borra la historia: el consentimiento sigue, con quién lo revocó.
  expect(await f.run((tx) => listDataConsents(tx, "org_a", f.patient.id))).toEqual([
    expect.objectContaining({ id: granted.id, revokedAt: expect.any(Date), revokedBy: f.actor }),
  ])
})

it("antecedentes: gravedad ausente es desconocida, familiares por parentesco y ASA", async () => {
  const f = await clinicalFixture()
  const health = await f.run((tx) =>
    savePatientHealth(tx, "org_a", f.actor, f.patient.id, {
      expectedRevision: 0,
      reviewStatus: { allergies: "recorded", conditions: "unknown", medications: "unknown" },
      allergies: [{ substance: "Látex", kind: "alergia", criticality: "alta" }],
      conditions: [],
      medications: [],
      familyHistory: [{ relationship: "MTH", condition: "Diabetes" }],
      asaClass: "II",
    }),
  )
  expect(health.allergies[0]).toMatchObject({
    severity: "desconocida",
    criticality: "alta",
    verification: "no_confirmada",
  })
  const read = await f.run((tx) => getPatientHealth(tx, "org_a", f.patient.id))
  expect(read).toMatchObject({ asaClass: "II", familyHistory: [{ relationship: "MTH" }] })
  await expect(
    f.run((tx) =>
      savePatientHealth(tx, "org_a", f.actor, f.patient.id, {
        expectedRevision: 1,
        reviewStatus: { allergies: "none", conditions: "unknown", medications: "unknown" },
        allergies: [],
        conditions: [],
        medications: [],
        familyHistory: [{ relationship: "vecino", condition: "Asma" }],
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
})
