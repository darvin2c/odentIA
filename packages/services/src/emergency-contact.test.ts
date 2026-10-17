/**
 * El contacto de emergencia es una marca sobre una persona vinculada
 * (decisión 25), con su parentesco HL7; ya no son tres campos de la ficha.
 */
import { withOrgContext } from "@odentia/db"
import { patientContact } from "@odentia/db/schema/clinical"
import { and, eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createPerson } from "./people.js"
import { createPatient, getPatient, setPatientContact, updatePatient } from "./patients.js"
import { getPatientMissingData } from "./patient-registration.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ORG = "org_a"
const ACTOR = null
const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, ORG, fn)

it("lo declarado como contacto de emergencia se vuelve una persona vinculada con la marca, sin repetirla", async () => {
  // Quien registra en la clínica.
  await ownerDb.execute(
    sql`insert into "user" ("id","name","email") values ('u-emergencia','Ana','ana-emergencia@example.test') on conflict do nothing`,
  )
  const created = await run((tx) =>
    createPatient(tx, ORG, "u-emergencia", {
      displayName: "Lucía Paredes",
      emergencyContactName: "Carlos Paredes",
      emergencyContactPhone: "+51912345678",
      emergencyContactRelationship: "SPS",
    }),
  )
  const detail = await run((tx) => getPatient(tx, ORG, created.id))
  expect(detail.contacts.filter((link) => link.isEmergency)).toEqual([
    expect.objectContaining({ displayName: "Carlos Paredes", phone: "+51912345678", kinship: "SPS", relationship: "family" }),
  ])
  // Ya no falta el contacto de emergencia: lo cuenta la persona marcada.
  const missing = await run((tx) => getPatientMissingData(tx, ORG, created.id))
  expect(missing.map((item) => item.key)).not.toContain("emergencyContactName")
  // Declararlo otra vez igual (por «Tus datos») no crea otra persona.
  await run((tx) => updatePatient(tx, ORG, ACTOR, created.id, { emergencyContactName: "Carlos Paredes" }))
  const again = await run((tx) => getPatient(tx, ORG, created.id))
  expect(again.contacts.filter((link) => link.displayName === "Carlos Paredes")).toHaveLength(1)

  // La marca se pone y se quita sobre una persona ya vinculada.
  const hija = await run((tx) => createPerson(tx, ORG, { userId: null }, { givenNames: "Rosa", paternalSurname: "Paredes" }))
  await run((tx) =>
    setPatientContact(tx, ORG, "u-emergencia", created.id, {
      contactId: hija.id, relationship: "family", kinship: "CHILD", isPreferred: false, isEmergency: true,
    }),
  )
  const marked = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, created.id), eq(patientContact.isEmergency, true)))
  expect(marked.map((row) => row.contactId)).toContain(hija.id)
  // Cambiar la relación sin decir nada de la marca la conserva.
  await run((tx) =>
    setPatientContact(tx, ORG, "u-emergencia", created.id, { contactId: hija.id, relationship: "family", isPreferred: false }),
  )
  const kept = await run((tx) => getPatient(tx, ORG, created.id))
  expect(kept.contacts.find((link) => link.contactId === hija.id)?.isEmergency).toBe(true)
  // La propia persona no es su contacto de emergencia.
  const self = kept.contacts.find((link) => link.relationship === "self")!
  await expect(
    run((tx) =>
      setPatientContact(tx, ORG, "u-emergencia", created.id, {
        contactId: self.contactId, relationship: "self", isPreferred: true, isEmergency: true,
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
})
