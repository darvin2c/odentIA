import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { patientContact } from "@odentia/db/schema/clinical"
import { contact, contactIdentity, conversation } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { createConnection } from "./connections.js"
import { createContact, updateContact } from "./contacts.js"
import { createContactNote } from "./crm-workspace.js"
import { createPatient, requirePatient, setPatientContact, updatePatient } from "./patients.js"
import {
  createPerson,
  getPersonPage,
  listPeople,
  listPersonConversations,
  listPersonNotes,
  personOfPatient,
  setPersonArchived,
  updatePersonIdentity,
} from "./people.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const KEY = secretsKeyFromEnv("cd".repeat(32))
const everything = () => true
const reception = (permission: string) => !["clinical.read", "finance.read"].includes(permission)
const cashier = (permission: string) =>
  ["patients.read", "finance.read", "budgets.read"].includes(permission)

/** Una clínica nueva por prueba: así las listas no se mezclan. */
async function clinic() {
  const orgId = `org_${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const actor = randomUUID()
  await ownerDb
    .insert(user)
    .values({ id: actor, name: "Ana Recepción", email: `${actor}@example.test` })
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  return { orgId, actor, run }
}

async function personOf(patientId: string): Promise<string> {
  const [row] = await ownerDb
    .select({ id: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, patientId), eq(patientContact.relationship, "self")))
  if (!row) throw new Error("Sin persona propia")
  return row.id
}

describe("una persona, una página", () => {
  it("la página es la misma antes y después de registrarla: crece con ella", async () => {
    const c = await clinic()
    const rosa = await c.run((tx) =>
      createPerson(
        tx,
        c.orgId,
        { userId: c.actor },
        { givenNames: "Rosa", paternalSurname: "Quispe", phone: "987654100" },
      ),
    )
    const before = await c.run((tx) => getPersonPage(tx, c.orgId, rosa.id, everything))
    expect(before).toMatchObject({
      displayName: "Rosa Quispe",
      kind: "por_registrar",
      patient: null,
      phone: "+51987654100",
    })
    const registered = await c.run((tx) =>
      createPatient(tx, c.orgId, c.actor, {
        displayName: "Rosa Quispe",
        givenNames: "Rosa",
        paternalSurname: "Quispe",
        contacts: [{ contactId: rosa.id, relationship: "self", isPreferred: true }],
      }),
    )
    const after = await c.run((tx) => getPersonPage(tx, c.orgId, rosa.id, everything))
    expect(after).toMatchObject({
      id: rosa.id,
      kind: "paciente",
      patient: { id: registered.id, patientNumber: registered.patientNumber },
    })
    // Lo que solo conoce la ficha llega a la misma página.
    expect(await c.run((tx) => personOfPatient(tx, c.orgId, registered.id))).toEqual({
      personId: rosa.id,
    })
  })

  it("el responsable dice de quién es y la paciente, quién habla por ella; la conversación solo para quien la lee", async () => {
    const c = await clinic()
    const sofia = await c.run((tx) =>
      createPatient(tx, c.orgId, c.actor, { displayName: "Sofía Salas" }),
    )
    const martin = await c.run((tx) =>
      createContact(tx, c.orgId, { displayName: "Martín Salas", phone: "+51911111111" }),
    )
    await c.run((tx) =>
      setPatientContact(tx, c.orgId, c.actor, sofia.id, {
        contactId: martin.id,
        relationship: "guardian",
        relationshipDetail: "padre",
        isPreferred: true,
      }),
    )
    const connection = await c.run((tx) =>
      createConnection(
        tx,
        c.orgId,
        KEY,
        {
          channel: "whatsapp",
          provider: "whatsapp_cloud_api",
          displayName: "WA",
          config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S" },
        },
        { fetch, validateExternal: false },
      ),
    )
    const [identity] = await ownerDb
      .insert(contactIdentity)
      .values({
        organizationId: c.orgId,
        contactId: martin.id,
        channel: "whatsapp",
        externalUserId: "wa:51911111111",
      })
      .returning({ id: contactIdentity.id })
    const [thread] = await ownerDb
      .insert(conversation)
      .values({
        organizationId: c.orgId,
        contactId: martin.id,
        contactIdentityId: identity!.id,
        channelConnectionId: connection.id,
        externalThreadId: "wa:51911111111",
        lastInboundAt: new Date(),
      })
      .returning({ id: conversation.id })
    const sofiaPerson = await personOf(sofia.id)
    const guardian = await c.run((tx) => getPersonPage(tx, c.orgId, martin.id, reception))
    expect(guardian.kind).toBe("responsable")
    expect(guardian.responsibleFor).toEqual([
      expect.objectContaining({
        patientId: sofia.id,
        personId: sofiaPerson,
        displayName: "Sofía Salas",
        relationshipDetail: "padre",
      }),
    ])
    const child = await c.run((tx) => getPersonPage(tx, c.orgId, sofiaPerson, reception))
    expect(child.spokenForBy).toEqual([
      expect.objectContaining({
        personId: martin.id,
        displayName: "Martín Salas",
        conversationId: thread!.id,
      }),
    ])
    // Caja no lee conversaciones: el enlace no viaja.
    const forCashier = await c.run((tx) => getPersonPage(tx, c.orgId, sofiaPerson, cashier))
    expect(forCashier.spokenForBy[0]?.conversationId).toBeNull()
    expect(forCashier.channels).toEqual([])
    // La conversación del padre no se copia en la página de la hija.
    expect(await c.run((tx) => listPersonConversations(tx, c.orgId, sofiaPerson))).toEqual([])
    expect(
      (await c.run((tx) => listPersonConversations(tx, c.orgId, martin.id))).map((row) => row.id),
    ).toEqual([thread!.id])
  })
})

describe("un solo formulario de datos, con las reglas de la ficha", () => {
  it("una persona sin ficha con pasaporte pide su país, y cambiar el teléfono no la obliga a repetirlo", async () => {
    const c = await clinic()
    const person = await c.run((tx) => createContact(tx, c.orgId, { displayName: "Luis Pérez" }))
    await expect(
      c.run((tx) =>
        updatePersonIdentity(tx, c.orgId, { userId: c.actor }, person.id, {
          docType: "PASAPORTE",
          docNumber: "AB123456",
        }),
      ),
    ).rejects.toMatchObject({ status: 400, message: "Elige el país que emitió el documento" })
    await c.run((tx) =>
      updatePersonIdentity(tx, c.orgId, { userId: c.actor }, person.id, {
        docType: "PASAPORTE",
        docNumber: "AB123456",
        docCountry: "ve",
        sex: "I",
        givenNames: "Luis Alberto",
        paternalSurname: "Pérez",
      }),
    )
    // Antes, guardar desde Contactos reenviaba el documento sin país y fallaba siempre.
    await c.run((tx) =>
      updateContact(tx, c.orgId, person.id, { phone: "912345678" }, { userId: c.actor }),
    )
    const page = await c.run((tx) => getPersonPage(tx, c.orgId, person.id, everything))
    expect(page).toMatchObject({
      displayName: "Luis Alberto Pérez",
      docType: "PASAPORTE",
      docCountry: "VE",
      sex: "I",
      phone: "+51912345678",
    })
    await expect(
      c.run((tx) =>
        updatePersonIdentity(tx, c.orgId, { userId: c.actor }, person.id, {
          docType: "DNI",
          docNumber: "123",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it("desde el CRM también rige la regla del menor de la ficha", async () => {
    const c = await clinic()
    const adult = await c.run((tx) =>
      createPatient(tx, c.orgId, c.actor, { displayName: "Ana Torres", birthDate: "1990-01-01" }),
    )
    const person = await personOf(adult.id)
    await expect(
      c.run((tx) =>
        updateContact(tx, c.orgId, person, { birthDate: "2019-05-01" }, { userId: c.actor }),
      ),
    ).rejects.toMatchObject({ code: "REPRESENTATIVE_REQUIRED" })
    await expect(
      c.run((tx) =>
        updatePersonIdentity(tx, c.orgId, { userId: c.actor }, person, { birthDate: "2019-05-01" }),
      ),
    ).rejects.toMatchObject({ code: "REPRESENTATIVE_REQUIRED" })
    // El agente no cambia la identidad de quien ya es paciente.
    await expect(
      c.run((tx) =>
        updatePersonIdentity(tx, c.orgId, { userId: null, origin: "agent" }, person, {
          phone: "+51999999999",
        }),
      ),
    ).rejects.toMatchObject({ code: "PATIENT_IDENTITY_PROTECTED" })
  })
})

describe("un solo «Archivar»", () => {
  it("la persona y su ficha se archivan y se recuperan juntas, venga de donde venga", async () => {
    const c = await clinic()
    const p = await c.run((tx) =>
      createPatient(tx, c.orgId, c.actor, { displayName: "Carlos Mendoza" }),
    )
    const person = await personOf(p.id)
    // Un solo indicador (ADR 0044): la ficha lee el de su persona.
    const flags = async () => {
      const [row] = await ownerDb
        .select({ contactActive: contact.isActive })
        .from(contact)
        .where(eq(contact.id, person))
      const ficha = await c.run((tx) => requirePatient(tx, c.orgId, p.id))
      return { contactActive: row?.contactActive, patientActive: ficha.isActive }
    }
    await c.run((tx) => setPersonArchived(tx, c.orgId, { userId: c.actor }, person, true))
    expect(await flags()).toEqual({ contactActive: false, patientActive: false })
    expect((await c.run((tx) => getPersonPage(tx, c.orgId, person, everything))).archived).toBe(
      true,
    )
    await c.run((tx) => setPersonArchived(tx, c.orgId, { userId: c.actor }, person, false))
    expect(await flags()).toEqual({ contactActive: true, patientActive: true })
    // Las vías de antes (ficha y CRM) pasan por la misma operación.
    await c.run((tx) => updatePatient(tx, c.orgId, c.actor, p.id, { isActive: false }))
    expect(await flags()).toEqual({ contactActive: false, patientActive: false })
    await c.run((tx) => updateContact(tx, c.orgId, person, { isActive: true }, { userId: c.actor }))
    expect(await flags()).toEqual({ contactActive: true, patientActive: true })
  })
})

describe("una lista y un buscador", () => {
  it("las vistas separan pacientes, por registrar, responsables y archivados; busca por teléfono o documento", async () => {
    const c = await clinic()
    const carlos = await c.run((tx) =>
      createPatient(tx, c.orgId, c.actor, {
        displayName: "Carlos Mendoza",
        docType: "DNI",
        docNumber: "45879632",
      }),
    )
    const rosa = await c.run((tx) =>
      createContact(tx, c.orgId, { displayName: "Rosa Quispe", phone: "+51987654100" }),
    )
    const martin = await c.run((tx) => createContact(tx, c.orgId, { displayName: "Martín Salas" }))
    const sofia = await c.run((tx) =>
      createPatient(tx, c.orgId, c.actor, { displayName: "Sofía Salas" }),
    )
    await c.run((tx) =>
      setPatientContact(tx, c.orgId, c.actor, sofia.id, {
        contactId: martin.id,
        relationship: "guardian",
        isPreferred: false,
      }),
    )
    const archived = await c.run((tx) =>
      createContact(tx, c.orgId, { displayName: "Zoe Archivada" }),
    )
    await c.run((tx) => setPersonArchived(tx, c.orgId, { userId: c.actor }, archived.id, true))
    const names = async (view: string, q?: string) =>
      (await c.run((tx) => listPeople(tx, c.orgId, { view, q }, everything))).items.map(
        (row) => row.displayName,
      )
    expect(await names("pacientes")).toEqual(["Carlos Mendoza", "Sofía Salas"])
    expect(await names("por_registrar")).toEqual(["Rosa Quispe"])
    expect(await names("responsables")).toEqual(["Martín Salas"])
    expect(await names("archivados")).toEqual(["Zoe Archivada"])
    expect(await names("todos")).toHaveLength(5)
    expect(await names("todos", "987 654")).toEqual(["Rosa Quispe"])
    expect(await names("pacientes", "45879632")).toEqual(["Carlos Mendoza"])
    const page = await c.run((tx) => listPeople(tx, c.orgId, { view: "responsables" }, everything))
    expect(page.counts.porRegistrar).toBe(1)
    expect(page.items[0]).toMatchObject({
      kind: "responsable",
      responsibleFor: ["Sofía Salas"],
      responsibleCount: 1,
    })
    const patients = await c.run((tx) => listPeople(tx, c.orgId, { view: "pacientes" }, everything))
    expect(patients.items[0]).toMatchObject({
      kind: "paciente",
      patient: { id: carlos.id },
      docNumber: "45879632",
    })
    // Rosa escribió: la fecha viaja solo para quien lee conversaciones o el CRM.
    expect(rosa.id).toBeTruthy()
  })

  it("las páginas las hace el servidor y el cursor solo vale con los mismos filtros", async () => {
    const c = await clinic()
    for (const name of ["Ana", "Beto", "Carla"])
      await c.run((tx) => createContact(tx, c.orgId, { displayName: name }))
    const first = await c.run((tx) =>
      listPeople(tx, c.orgId, { view: "por_registrar", limit: 2 }, everything),
    )
    expect(first.items.map((row) => row.displayName)).toEqual(["Ana", "Beto"])
    expect(first.nextCursor).toBeTruthy()
    const second = await c.run((tx) =>
      listPeople(
        tx,
        c.orgId,
        { view: "por_registrar", limit: 2, cursor: first.nextCursor ?? "" },
        everything,
      ),
    )
    expect(second.items.map((row) => row.displayName)).toEqual(["Carla"])
    expect(second.nextCursor).toBeNull()
    await expect(
      c.run((tx) =>
        listPeople(
          tx,
          c.orgId,
          { view: "todos", limit: 2, cursor: first.nextCursor ?? "" },
          everything,
        ),
      ),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe("un sitio para las notas", () => {
  it("las notas dicen quién las escribió: una sola lista, la de `crm_note`", async () => {
    const c = await clinic()
    const person = await c.run((tx) => createContact(tx, c.orgId, { displayName: "Rosa Quispe" }))
    await c.run((tx) =>
      createContactNote(
        tx,
        c.orgId,
        person.id,
        { body: "Llamó por el precio" },
        { userId: c.actor },
      ),
    )
    const notes = await c.run((tx) => listPersonNotes(tx, c.orgId, person.id))
    expect(notes).toEqual([
      expect.objectContaining({ body: "Llamó por el precio", authorName: "Ana Recepción" }),
    ])
  })
})
