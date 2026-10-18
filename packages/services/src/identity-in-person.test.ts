import { randomUUID } from "node:crypto"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { patient, patientContact, treatmentBudget } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { getAppointment } from "./appointments.js"
import { getBudgetPrintPayload } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createContact, updateContact } from "./contacts.js"
import { listConversations } from "./conversations.js"
import { createPatient, getPatient, listPatients, updatePatient } from "./patients.js"
import { listPeople, updatePersonIdentity } from "./people.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

/** La identidad vive en la persona (ADR 0044): estas pruebas la leen de la tabla, no del servicio. */
const personRow = async (id: string) => (await ownerDb.select().from(contact).where(eq(contact.id, id)))[0]!

it("crear un paciente deja la identidad en su persona y la ficha apunta a ella", async () => {
  const f = await clinicalFixture()
  const created = await f.run((tx) =>
    createPatient(tx, "org_a", f.actor, {
      displayName: "Lucía Paredes Rojas",
      givenNames: "Lucía",
      familyName: "Paredes Rojas",
      docType: "DNI",
      docNumber: "41230001",
      birthDate: "1988-04-12",
      sex: "F",
      phone: "987123001",
      email: "lucia@example.test",
      occupation: "Docente",
    }),
  )
  const person = await personRow(created.personId)
  expect(person).toMatchObject({
    displayName: "Lucía Paredes Rojas",
    givenNames: "Lucía",
    familyName: "Paredes Rojas",
    docType: "DNI",
    docNumber: "41230001",
    docCountry: "PE",
    birthDate: "1988-04-12",
    sex: "F",
    phone: "+51987123001",
    email: "lucia@example.test",
    isActive: true,
  })
  // La ficha guarda lo suyo y su vínculo propio es esa persona.
  const [record] = await ownerDb.select().from(patient).where(eq(patient.id, created.id))
  expect(record).toMatchObject({ personId: created.personId, occupation: "Docente" })
  expect(record).not.toHaveProperty("displayName")
  const self = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, created.id), eq(patientContact.relationship, "self")))
  expect(self).toEqual([{ contactId: created.personId }])
  // Quien lee la ficha la recibe como antes, con su identidad.
  expect((await f.run((tx) => getPatient(tx, "org_a", created.id))).patient).toMatchObject({
    displayName: "Lucía Paredes Rojas",
    docNumber: "41230001",
    isActive: true,
  })

  // La persona que ya tenía ese documento, sin ficha, es la misma: se adopta.
  const known = await f.run((tx) =>
    createContact(tx, "org_a", { displayName: "Marco", phone: "+51987123002", docType: "DNI", docNumber: "41230002", docCountry: "PE" }),
  )
  const adopted = await f.run((tx) =>
    createPatient(tx, "org_a", f.actor, { displayName: "Marco Salas", docType: "DNI", docNumber: "41230002" }),
  )
  expect(adopted.personId).toBe(known.id)
  expect(await personRow(known.id)).toMatchObject({ displayName: "Marco Salas", phone: "+51987123002" })
})

it("el documento es único en la persona: ni otra ficha ni otra persona lo repiten", async () => {
  const f = await clinicalFixture()
  await f.run((tx) => createPatient(tx, "org_a", f.actor, { displayName: "Elena Ruiz", docType: "DNI", docNumber: "41230010" }))
  await expect(
    f.run((tx) => createPatient(tx, "org_a", f.actor, { displayName: "Otra Elena", docType: "DNI", docNumber: "41230010" })),
  ).rejects.toMatchObject({ code: "DUPLICATE_DOCUMENT", message: "Ese DNI ya está en la página de Elena Ruiz" })
  // Con una persona propia indicada que no tiene ese documento, tampoco.
  const lead = await f.run((tx) => createContact(tx, "org_a", { displayName: "Lead" }))
  const owner = await f.run((tx) => createContact(tx, "org_a", { displayName: "Dueña del DNI", docType: "DNI", docNumber: "41230011", docCountry: "PE" }))
  await expect(
    f.run((tx) =>
      createPatient(tx, "org_a", f.actor, {
        displayName: "Lead Paciente",
        docType: "DNI",
        docNumber: "41230011",
        contacts: [{ contactId: lead.id, relationship: "self", isPreferred: true }],
      }),
    ),
  ).rejects.toMatchObject({ code: "DUPLICATE_DOCUMENT" })
  expect((await personRow(owner.id)).docNumber).toBe("41230011")
  // Cambiar el documento de la ficha al de otra persona se rechaza.
  await expect(
    f.run((tx) => updatePatient(tx, "org_a", f.actor, f.patient.id, { docType: "DNI", docNumber: "41230011" })),
  ).rejects.toMatchObject({ code: "DUPLICATE_DOCUMENT", status: 409 })
})

it("cambiar el nombre en la ficha se ve en Personas, Bandeja, Agenda y el PDF", async () => {
  const f = await clinicalFixture()
  const personId = f.patient.personId
  // Una conversación, una cita, una tarea y un presupuesto de la persona.
  const [connection] = await ownerDb
    .insert(channelConnection)
    .values({ organizationId: "org_a", channel: "telegram", provider: "telegram_bot_api", displayName: "Canal", configEncrypted: "c", webhookSecret: randomUUID(), status: "active" })
    .returning({ id: channelConnection.id })
  await ownerDb.insert(conversation).values({ organizationId: "org_a", contactId: personId, channelConnectionId: connection!.id, externalThreadId: randomUUID() })
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}` }).returning({ id: branch.id })
  const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: "org_a", branchId: site!.id, name: "Unidad 1" }).returning({ id: scheduleChair.id })
  const startsAt = new Date(Date.now() + 86_400_000)
  const [visit] = await ownerDb
    .insert(appointment)
    .values({ organizationId: "org_a", branchId: site!.id, patientId: f.patient.id, chairId: chair!.id, dentistUserId: f.actor, startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), durationMin: 30 })
    .returning({ id: appointment.id })
  const [budget] = await ownerDb
    .insert(treatmentBudget)
    .values({ organizationId: "org_a", patientId: f.patient.id, planId: f.plan.id, budgetNumber: 9001, title: "Plan", currency: "PEN", status: "presentado" })
    .returning({ id: treatmentBudget.id })

  await f.run((tx) =>
    updatePatient(tx, "org_a", f.actor, f.patient.id, { givenNames: "Rosa", familyName: "Quispe Ríos", identityConfirmed: true }),
  )
  const name = "Rosa Quispe Ríos"
  // Un solo lugar: la persona.
  expect(await personRow(personId)).toMatchObject({ displayName: name, identityNeedsReview: false })
  const everything = () => true
  expect((await f.run((tx) => listPatients(tx, "org_a", { q: "Quispe Ríos" }))).items.map((p) => p.displayName)).toContain(name)
  expect((await f.run((tx) => listPeople(tx, "org_a", { q: "Quispe Ríos" }, everything))).items.map((p) => p.displayName)).toContain(name)
  const inbox = await f.run((tx) => listConversations(tx, "org_a", { q: "Quispe Ríos" }))
  expect(inbox.items.filter((c) => c.contact.id === personId).map((c) => c.contact.displayName)).toEqual([name])
  expect((await f.run((tx) => getAppointment(tx, "org_a", visit!.id))).patientName).toBe(name)
  const pdf = await f.run((tx) => getBudgetPrintPayload(tx, "org_a", f.patient.id, budget!.id))
  expect(pdf.patient.displayName).toBe(name)

  // Y al revés: lo que se cambia desde la persona es la ficha.
  await f.run((tx) => updatePersonIdentity(tx, "org_a", { userId: f.actor }, personId, { email: "rosa@example.test" }))
  expect((await f.run((tx) => getPatient(tx, "org_a", f.patient.id))).patient.email).toBe("rosa@example.test")
})

it("el agente no cambia la identidad de quien ya es paciente, ni por la persona ni por el CRM", async () => {
  const f = await clinicalFixture()
  const personId = f.patient.personId
  await expect(
    f.run((tx) => updatePersonIdentity(tx, "org_a", { userId: null, origin: "agent" }, personId, { displayName: "Otro Nombre" })),
  ).rejects.toMatchObject({ code: "PATIENT_IDENTITY_PROTECTED", status: 409 })
  await expect(
    f.run((tx) => updateContact(tx, "org_a", personId, { birthDate: "2001-01-01" }, { userId: null, origin: "agent" })),
  ).rejects.toMatchObject({ code: "PATIENT_IDENTITY_PROTECTED", status: 409 })
  expect(await personRow(personId)).toMatchObject({ displayName: "Paciente de prueba", birthDate: null })
  // A quien aún no es paciente sí puede anotarle el nombre.
  const lead = await f.run((tx) => createContact(tx, "org_a", { displayName: "Lead" }))
  await f.run((tx) => updatePersonIdentity(tx, "org_a", { userId: null, origin: "agent" }, lead.id, { displayName: "Lead Nombre" }))
  expect((await personRow(lead.id)).displayName).toBe("Lead Nombre")
})

it("archivar es uno solo: la ficha lee el de su persona", async () => {
  const f = await clinicalFixture()
  await f.run((tx) => updatePatient(tx, "org_a", f.actor, f.patient.id, { isActive: false }))
  expect((await personRow(f.patient.personId)).isActive).toBe(false)
  expect((await f.run((tx) => getPatient(tx, "org_a", f.patient.id))).patient.isActive).toBe(false)
  expect((await f.run((tx) => listPatients(tx, "org_a", { isActive: false }))).items.map((p) => p.id)).toContain(f.patient.id)
})
