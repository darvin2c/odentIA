/**
 * Quien escribe por WhatsApp con su número visible no lo tiene en `contact.phone`
 * (ese es el dato declarado, ADR 0027): se deriva de su identidad al leer, para
 * mostrarlo y para no pedirle un teléfono. El BSUID (ADR 0110) no es un número.
 */
import type { NormalizedInbound } from "@odentia/channels"
import { withOrgContext } from "@odentia/db"
import { contact, contactIdentity } from "@odentia/db/schema/crm"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createConnection } from "./connections.js"
import { whatsappNumberOf } from "./contacts.js"
import { getConversationContext } from "./conversation-context.js"
import { type IngestDeps, ingestInbound } from "./conversations.js"
import { getPatientMissingData, patientsMissingData } from "./patient-registration.js"
import { setPatientContact } from "./patients.js"
import type { Can } from "./plan-next.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, retireWhatsApp, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

const ORG = "org_a"
const KEY = secretsKeyFromEnv("cc".repeat(32))
const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, ORG, fn)
const only = (...allowed: string[]): Can => (permission) => allowed.includes(permission)
// Lo que se pide siempre, menos el teléfono.
const COMPLETE = { givenNames: "Rosa", familyName: "Quispe", birthDate: "1990-05-04" }

const adapter = {
  provider: "whatsapp_cloud_api",
  capabilities: { templates: true, media: true, interactive: true, readReceipts: true, edit: false },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "stub-1" }),
  validateConnection: async () => ({ externalId: "PNID", displayName: "WA" }),
} as unknown as Parameters<typeof ingestInbound>[2]
const deps: IngestDeps = { storage: {} as Storage, fetch, secretsKey: KEY }

let connectionId: string | null = null
async function whatsappConnection(): Promise<string> {
  if (connectionId) return connectionId
  await retireWhatsApp(ORG)
  const created = await run((tx) =>
    createConnection(
      tx,
      ORG,
      KEY,
      {
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA",
        config: { phoneNumberId: "PNID", wabaId: "WABA", accessToken: "T", appSecret: "S", templates: [] },
      },
      { fetch, validateExternal: false },
    ),
  )
  connectionId = created.id
  return created.id
}

/** Un mensaje que entra por WhatsApp: con número, `wa:<dígitos>`; sin él, su BSUID. */
async function writes(address: string, senderUserId?: string): Promise<{ conversationId: string; contactId: string }> {
  const event: NormalizedInbound = {
    externalEventId: `evt-${address}`,
    externalMessageId: `wamid-${address}`,
    externalThreadId: address,
    senderExternalId: address,
    senderDisplayName: "Rosa Quispe",
    ...(senderUserId ? { senderUserId } : {}),
    content: { type: "text", text: "Hola" },
    sentAt: new Date().toISOString(),
  }
  const connection = await whatsappConnection()
  const { conversationId } = await run((tx) => ingestInbound(tx, { orgId: ORG, connectionId: connection, event }, adapter, deps))
  const [identity] = await ownerDb
    .select({ contactId: contactIdentity.contactId })
    .from(contactIdentity)
    .where(eq(contactIdentity.externalUserId, address))
  return { conversationId, contactId: identity!.contactId }
}

async function declaredPhoneOf(contactId: string): Promise<string | null> {
  const [person] = await ownerDb.select({ phone: contact.phone }).from(contact).where(eq(contact.id, contactId))
  return person!.phone
}

it("«Contexto» de quien escribe con su número lo muestra y dice «Aún no es paciente», sin guardarlo en la ficha", async () => {
  const { conversationId, contactId } = await writes("wa:51911000001")
  const context = await run((tx) => getConversationContext(tx, ORG, conversationId, only("crm.read")))
  expect(context.phone).toBe("+51911000001")
  expect(context.lines.datos).toBe("Aún no es paciente")
  // Lo que «Reservar cita» trae escrito y guarda sigue siendo solo lo declarado.
  expect(context.declaredPhone).toBeNull()
  expect(await declaredPhoneOf(contactId)).toBeNull()
})

it("quien no lee el CRM no ve el número de quien aún no es paciente; el de un paciente sí", async () => {
  const { conversationId, contactId } = await writes("wa:51911000002")
  const before = await run((tx) => getConversationContext(tx, ORG, conversationId, only("patients.read", "conversations.read")))
  expect(before.phone).toBeNull()
  await insertTestPatients(ownerDb, { organizationId: ORG, personId: contactId, ...COMPLETE, patientNumber: 97002 })
  const after = await run((tx) => getConversationContext(tx, ORG, conversationId, only("patients.read", "conversations.read")))
  expect(after.phone).toBe("+51911000002")
})

it("a quien Sofi registró en el chat ya no le falta teléfono, y las dos funciones de faltantes coinciden", async () => {
  const { conversationId, contactId } = await writes("wa:51911000003")
  const [ficha] = await insertTestPatients(ownerDb, { organizationId: ORG, personId: contactId, ...COMPLETE, patientNumber: 97003 })
  expect(await run((tx) => getPatientMissingData(tx, ORG, ficha!.id))).toEqual([])
  const batch = await run((tx) => patientsMissingData(tx, ORG, [ficha!.id]))
  expect(batch.has(ficha!.id)).toBe(false)
  const context = await run((tx) => getConversationContext(tx, ORG, conversationId, only("patients.read")))
  expect(context.lines.datos).toBe("Completos")
  // Cuenta sin escribirse: el celular que declare después sigue teniendo dónde guardarse.
  expect(await declaredPhoneOf(contactId)).toBeNull()
})

it("quien escribe con su BSUID sigue sin teléfono, en «Contexto» y en los faltantes", async () => {
  const bsuid = "PE.1349000000000000000004"
  const { conversationId, contactId } = await writes(`wa:${bsuid}`, bsuid)
  expect(await run((tx) => whatsappNumberOf(tx, ORG, contactId))).toBeNull()
  const context = await run((tx) => getConversationContext(tx, ORG, conversationId, only("crm.read")))
  expect(context.phone).toBeNull()
  expect(context.lines.datos).toBe("Sin datos de contacto")
  const [ficha] = await insertTestPatients(ownerDb, { organizationId: ORG, personId: contactId, ...COMPLETE, patientNumber: 97004 })
  const missing = await run((tx) => getPatientMissingData(tx, ORG, ficha!.id))
  expect(missing.map((item) => item.key)).toEqual(["phone"])
  expect((await run((tx) => patientsMissingData(tx, ORG, [ficha!.id]))).has(ficha!.id)).toBe(true)
})

it("el número de quien habla por ella cuenta; uno que WhatsApp rechazó, no", async () => {
  await ownerDb.execute(
    sql`insert into "user" ("id","name","email") values ('u-numero','Ana','ana-numero@example.test') on conflict do nothing`,
  )
  const madre = await writes("wa:51911000005")
  const [hijo] = await insertTestPatients(ownerDb, { organizationId: ORG, ...COMPLETE, givenNames: "Lucas", patientNumber: 97005 })
  const missingKeys = async () => (await run((tx) => getPatientMissingData(tx, ORG, hijo!.id))).map((item) => item.key)
  const inBatch = async () => (await run((tx) => patientsMissingData(tx, ORG, [hijo!.id]))).has(hijo!.id)
  expect(await missingKeys()).toEqual(["phone"])
  expect(await inBatch()).toBe(true)

  await run((tx) =>
    setPatientContact(tx, ORG, "u-numero", hijo!.id, { contactId: madre.contactId, relationship: "family", isPreferred: false }),
  )
  expect(await missingKeys()).toEqual([])
  expect(await inBatch()).toBe(false)

  await ownerDb.update(contactIdentity).set({ noWhatsappAt: new Date() }).where(eq(contactIdentity.externalUserId, "wa:51911000005"))
  expect(await run((tx) => whatsappNumberOf(tx, ORG, madre.contactId))).toBeNull()
  expect(await missingKeys()).toEqual(["phone"])
  expect(await inBatch()).toBe(true)
})

it("de varias identidades, la principal primero; un BSUID principal cede ante un número", async () => {
  const numbered = await writes("wa:51911000006")
  await ownerDb.insert(contactIdentity).values({
    organizationId: ORG,
    contactId: numbered.contactId,
    channel: "whatsapp",
    externalUserId: "wa:51911000066",
    isPrimary: false,
  })
  expect(await run((tx) => whatsappNumberOf(tx, ORG, numbered.contactId))).toBe("+51911000006")

  const bsuid = "PE.1349000000000000000007"
  const hidden = await writes(`wa:${bsuid}`, bsuid)
  await ownerDb.insert(contactIdentity).values({
    organizationId: ORG,
    contactId: hidden.contactId,
    channel: "whatsapp",
    externalUserId: "wa:51911000007",
    isPrimary: false,
  })
  expect(await run((tx) => whatsappNumberOf(tx, ORG, hidden.contactId))).toBe("+51911000007")
})
