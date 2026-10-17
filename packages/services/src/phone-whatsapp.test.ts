/**
 * Un teléfono que todavía no es su WhatsApp (decisión 23, versión 2). El
 * número de «Teléfono» pasa a ser su WhatsApp solo por decisión del equipo
 * (ADR 0027), nunca por coincidencia de un mensaje que entra.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { channelConnection, contact, contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { confirmPhoneMatch, phoneMatchOf, phoneWhatsAppState, usePhoneAsWhatsApp } from "./contacts.js"
import { applyStatus } from "./conversations.js"
import { createPerson } from "./people.js"
import { appDb, insertOrg, ownerDb, retireWhatsApp, setupTestDb } from "./test-setup.js"

setupTestDb()

async function clinic() {
  const orgId = `org_${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  await retireWhatsApp(orgId)
  const [connection] = await ownerDb
    .insert(channelConnection)
    .values({ organizationId: orgId, channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA", configEncrypted: "x", webhookSecret: "y" })
    .returning({ id: channelConnection.id })
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  return { orgId, connectionId: connection!.id, run }
}

it("caso 2: el teléfono de la ficha aún no es su WhatsApp hasta que alguien del equipo lo usa como tal", async () => {
  const c = await clinic()
  const carmen = await c.run((tx) =>
    createPerson(tx, c.orgId, { userId: null }, { givenNames: "Carmen", paternalSurname: "Ruiz", phone: "+51987650101" }),
  )
  expect(await c.run((tx) => phoneWhatsAppState(tx, c.orgId, carmen.id))).toMatchObject({ state: "aun_no", canUse: true })
  const used = await c.run((tx) => usePhoneAsWhatsApp(tx, c.orgId, null, carmen.id))
  expect(used.state).toBe("es_su_whatsapp")
  // Sin teléfono no hay nada que usar.
  const sin = await c.run((tx) => createPerson(tx, c.orgId, { userId: null }, { givenNames: "Sin", paternalSurname: "Teléfono" }))
  expect((await c.run((tx) => phoneWhatsAppState(tx, c.orgId, sin.id))).state).toBe("sin_telefono")
})

it("caso 1: si WhatsApp rechaza el mensaje porque el número no tiene WhatsApp, la ficha lo dice; volver a marcarlo lo reintenta", async () => {
  const c = await clinic()
  const carmen = await c.run((tx) =>
    createPerson(tx, c.orgId, { userId: null }, { givenNames: "Carmen", paternalSurname: "Sin WhatsApp", phone: "+51987650202" }),
  )
  await c.run((tx) => usePhoneAsWhatsApp(tx, c.orgId, null, carmen.id))
  const [identity] = await ownerDb.select().from(contactIdentity).where(eq(contactIdentity.contactId, carmen.id))
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: c.orgId, contactId: carmen.id, contactIdentityId: identity!.id,
      channelConnectionId: c.connectionId, externalThreadId: "wa:51987650202",
    })
    .returning({ id: conversation.id })
  const externalId = `wamid.${randomUUID()}`
  await ownerDb.insert(message).values({
    organizationId: c.orgId, conversationId: thread!.id, direction: "out", senderKind: "agent", status: "sent", externalId,
  })
  // Un rechazo por otro motivo no la marca.
  await c.run((tx) => applyStatus(tx, c.orgId, [{ externalMessageId: externalId, status: "failed", error: "131042: pago" }]))
  expect((await c.run((tx) => phoneWhatsAppState(tx, c.orgId, carmen.id))).state).toBe("es_su_whatsapp")
  await c.run((tx) =>
    applyStatus(tx, c.orgId, [{ externalMessageId: externalId, status: "failed", error: "No tiene WhatsApp", notOnWhatsApp: true }]),
  )
  expect((await c.run((tx) => phoneWhatsAppState(tx, c.orgId, carmen.id))).state).toBe("no_tiene")
  // Recepción lo vuelve a marcar como su WhatsApp (ya lo instaló): se intenta de nuevo.
  expect((await c.run((tx) => usePhoneAsWhatsApp(tx, c.orgId, null, carmen.id))).state).toBe("es_su_whatsapp")
})

it("caso 3: un mensaje desde el teléfono de una ficha pregunta «¿Es ella?» y solo se une con «Sí, es Carmen»", async () => {
  const c = await clinic()
  const carmen = await c.run((tx) =>
    createPerson(tx, c.orgId, { userId: null }, { givenNames: "Carmen", paternalSurname: "Ruiz Tello", phone: "+51987650303" }),
  )
  // Escribe desde ese número: la ingesta crea su persona provisional, como siempre.
  const [provisional] = await ownerDb
    .insert(contact)
    .values({ organizationId: c.orgId, displayName: "51987650303" })
    .returning({ id: contact.id })
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: c.orgId, contactId: provisional!.id, channel: "whatsapp", externalUserId: "wa:51987650303", isPrimary: true })
    .returning({ id: contactIdentity.id })
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: c.orgId, contactId: provisional!.id, contactIdentityId: identity!.id,
      channelConnectionId: c.connectionId, externalThreadId: "wa:51987650303", lastInboundAt: new Date(),
    })
    .returning({ id: conversation.id })
  // Nunca se une sola: solo se sugiere.
  const suggestion = await c.run((tx) => phoneMatchOf(tx, c.orgId, thread!.id))
  expect(suggestion).toMatchObject({ personId: carmen.id, personName: "Carmen Ruiz Tello" })
  const [still] = await ownerDb.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, thread!.id))
  expect(still?.contactId).toBe(provisional!.id)
  // «Sí, es Carmen»: la conversación pasa a su página y el número queda como su WhatsApp.
  await c.run((tx) => confirmPhoneMatch(tx, c.orgId, null, thread!.id, carmen.id))
  const [moved] = await ownerDb.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, thread!.id))
  expect(moved?.contactId).toBe(carmen.id)
  expect((await c.run((tx) => phoneWhatsAppState(tx, c.orgId, carmen.id))).state).toBe("es_su_whatsapp")
  expect(await c.run((tx) => phoneMatchOf(tx, c.orgId, thread!.id))).toBeNull()
})

it("caso 3: un teléfono que figura en dos fichas no sugiere a nadie", async () => {
  const c = await clinic()
  for (const name of ["Ana", "Luis"])
    await c.run((tx) => createPerson(tx, c.orgId, { userId: null }, { givenNames: name, paternalSurname: "Compartido", phone: "+51987650404" }))
  const [provisional] = await ownerDb.insert(contact).values({ organizationId: c.orgId, displayName: "Desconocido" }).returning({ id: contact.id })
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: c.orgId, contactId: provisional!.id, channel: "whatsapp", externalUserId: "wa:51987650404" })
    .returning({ id: contactIdentity.id })
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: c.orgId, contactId: provisional!.id, contactIdentityId: identity!.id,
      channelConnectionId: c.connectionId, externalThreadId: "wa:51987650404",
    })
    .returning({ id: conversation.id })
  expect(await c.run((tx) => phoneMatchOf(tx, c.orgId, thread!.id))).toBeNull()
})
