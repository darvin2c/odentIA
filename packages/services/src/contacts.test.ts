import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type InboundMessageJob, withOrgContext } from "@odentia/db"
import { contactIdentity, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createConnection } from "./connections.js"
import {
  addContactIdentity,
  createContact,
  getContact,
  listContacts,
  moveContactIdentity,
  updateContact,
} from "./contacts.js"
import {
  getConversationDetail,
  type IngestDeps,
  ingestInbound,
  resolveConversationIdentity,
  startContactConversation,
} from "./conversations.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { createTask } from "./tasks.js"
import { appDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const KEY = secretsKeyFromEnv("dd".repeat(32))

const stubAdapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: {
    templates: false,
    media: true,
    interactive: false,
    readReceipts: false,
    edit: true,
  },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "stub-1" }),
  validateConnection: async () => ({ externalId: "bot-1", displayName: "Bot" }),
}

const storageStub: Storage = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async ({ orgId, conversationId, bytes, contentType }) => ({
    objectKey: `${orgId}/${conversationId}/f.bin`,
    mimeType: contentType,
    filename: "f.bin",
    size: bytes.byteLength,
  }),
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async ({ orgId, patientId, bytes, contentType }) => ({
    objectKey: `patients/${orgId}/${patientId}/f.bin`,
    mimeType: contentType,
    filename: "f.bin",
    size: bytes.byteLength,
  }),
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

const ingestDeps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }

async function makeWaConnection(orgId: string): Promise<string> {
  return withOrgContext(appDb, orgId, async (tx) => {
    const created = await createConnection(
      tx,
      orgId,
      KEY,
      {
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA",
        config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S", templates: [] },
      },
      { fetch, validateExternal: false },
    )
    return created.id
  })
}

async function makeTgConnection(orgId: string): Promise<string> {
  return withOrgContext(appDb, orgId, async (tx) => {
    const created = await createConnection(
      tx,
      orgId,
      KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
      { fetch, validateExternal: false },
    )
    return created.id
  })
}

function tgEvent(over: Partial<NormalizedInbound> = {}): NormalizedInbound {
  return {
    externalEventId: `evt-${Math.random()}`,
    externalMessageId: `ext-${Math.random()}`,
    externalThreadId: "tg:555",
    senderExternalId: "tg:555",
    senderDisplayName: "Ana",
    content: { type: "text", text: "Hola" },
    sentAt: new Date().toISOString(),
    ...over,
  }
}

async function ingest(orgId: string, connectionId: string, event: NormalizedInbound) {
  const job: InboundMessageJob = { orgId, connectionId, event }
  return withOrgContext(appDb, orgId, (tx) => ingestInbound(tx, job, stubAdapter, ingestDeps))
}

it("lista por defecto solo activos; false y all filtran explícito", async () => {
  const active = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Activa Filtro" }),
  )
  const archived = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Archivada Filtro" }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    updateContact(tx, "org_a", archived.id, { isActive: false }, { userId: null }),
  )
  const def = await withOrgContext(appDb, "org_a", (tx) => listContacts(tx, "org_a", {}))
  expect(def.items.map((c) => c.id)).toContain(active.id)
  expect(def.items.map((c) => c.id)).not.toContain(archived.id)
  const onlyArchived = await withOrgContext(appDb, "org_a", (tx) =>
    listContacts(tx, "org_a", { isActive: false }),
  )
  expect(onlyArchived.items.map((c) => c.id)).toContain(archived.id)
  expect(onlyArchived.items.map((c) => c.id)).not.toContain(active.id)
  const all = await withOrgContext(appDb, "org_a", (tx) =>
    listContacts(tx, "org_a", { isActive: "all" }),
  )
  expect(all.items.map((c) => c.id)).toEqual(
    expect.arrayContaining([active.id, archived.id]),
  )
  const back = await withOrgContext(appDb, "org_a", (tx) =>
    updateContact(tx, "org_a", archived.id, { isActive: true }, { userId: null }),
  )
  expect(back.isActive).toBe(true)
})

it("alta manual normaliza, es idempotente y conflicta en otro contacto", async () => {
  const a = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Origen Identidad" }),
  )
  const b = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Destino Identidad" }),
  )
  const first = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, a.id, { channel: "whatsapp", externalUserId: "+51 911-222-333" }),
  )
  expect(first.externalUserId).toBe("wa:51911222333")
  const again = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, a.id, { channel: "whatsapp", externalUserId: "wa:51911222333" }),
  )
  expect(again.id).toBe(first.id)
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addContactIdentity(tx, "org_a", null, b.id, { channel: "whatsapp", externalUserId: "wa:51911222333" }),
    ),
  ).rejects.toMatchObject({ code: "IDENTITY_IN_USE", status: 409 })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addContactIdentity(tx, "org_a", null, a.id, { channel: "telegram", externalUserId: "@usuario" }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION", status: 400 })
  const tg = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, a.id, { channel: "telegram", externalUserId: "tg:777001" }),
  )
  expect(tg.externalUserId).toBe("tg:777001")
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addContactIdentity(tx, "org_a", null, a.id, { channel: "email", externalUserId: "a@x.com" }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION", status: 400 })
})

it("transferencia mueve conversación resuelta y tarea doble, conserva mensajes y resto", async () => {
  const connId = await makeWaConnection("org_a")
  const from = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Origen Transfiere" }),
  )
  const to = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Destino Transfiere" }),
  )
  const identity = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, from.id, { channel: "whatsapp", externalUserId: "wa:51900000111" }),
  )
  const started = await withOrgContext(appDb, "org_a", (tx) =>
    startContactConversation(tx, "org_a", null, from.id, { identityId: identity.id, connectionId: connId }),
  )
  expect(started.created).toBe(true)
  await withOrgContext(appDb, "org_a", (tx) =>
    tx.insert(message).values({
      organizationId: "org_a",
      conversationId: started.id,
      direction: "out",
      senderKind: "user",
      contentType: "text",
      body: "Hola, soy recepción",
      status: "queued",
    }),
  )
  const linked = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: "Seguimiento", contactId: from.id, conversationId: started.id, createdBy: "user" }),
  )
  const loose = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: "Suelta", contactId: from.id, createdBy: "user" }),
  )
  const result = await withOrgContext(appDb, "org_a", (tx) =>
    moveContactIdentity(tx, "org_a", null, identity.id, { fromContactId: from.id, toContactId: to.id, reason: "Número del hijo" }),
  )
  expect(result.movedConversations).toBe(1)
  expect(result.movedTasks).toBe(1)
  const detail = await withOrgContext(appDb, "org_a", (tx) =>
    getConversationDetail(tx, "org_a", started.id),
  )
  expect(detail.contact.id).toBe(to.id)
  expect(detail.messages.map((m) => m.body)).toContain("Hola, soy recepción")
  const [identityRow] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(contactIdentity).where(eq(contactIdentity.id, identity.id)).limit(1),
  )
  expect(identityRow?.contactId).toBe(to.id)
  const tasks = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(eq(crmTask.organizationId, "org_a")),
  )
  expect(tasks.find((t) => t.id === linked.id)?.contactId).toBe(to.id)
  expect(tasks.find((t) => t.id === loose.id)?.contactId).toBe(from.id)
})

it("historia ambigua bloquea la transferencia hasta la resolución manual", async () => {
  const connId = await makeWaConnection("org_a")
  const from = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Origen Ambiguo" }),
  )
  const to = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Destino Ambiguo" }),
  )
  const identity = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, from.id, { channel: "whatsapp", externalUserId: "wa:51900000222" }),
  )
  const [legacy] = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .insert(conversation)
      .values({
        organizationId: "org_a",
        contactId: from.id,
        contactIdentityId: null,
        channelConnectionId: connId,
        externalThreadId: "wa:51900000999",
      })
      .returning({ id: conversation.id }),
  )
  if (!legacy) throw new Error("sin conversación legada")
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      moveContactIdentity(tx, "org_a", null, identity.id, { fromContactId: from.id, toContactId: to.id, reason: "Corrige titular" }),
    ),
  ).rejects.toMatchObject({ code: "AMBIGUOUS_CHANNEL_HISTORY", status: 409 })
  const legacyIdentity = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, from.id, { channel: "whatsapp", externalUserId: "wa:51900000999" }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    resolveConversationIdentity(tx, "org_a", legacy.id, { identityId: legacyIdentity.id }, { userId: null }),
  )
  const retry = await withOrgContext(appDb, "org_a", (tx) =>
    moveContactIdentity(tx, "org_a", null, identity.id, { fromContactId: from.id, toContactId: to.id, reason: "Corrige titular" }),
  )
  expect(retry.movedConversations).toBe(0)
})

it("hilos grupales no bloquean ni se trasladan", async () => {
  const connId = await makeTgConnection("org_a")
  const from = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Origen Grupo" }),
  )
  const to = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Destino Grupo" }),
  )
  const identity = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, from.id, { channel: "telegram", externalUserId: "tg:888001" }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    tx.insert(conversation).values({
      organizationId: "org_a",
      contactId: from.id,
      contactIdentityId: null,
      channelConnectionId: connId,
      externalThreadId: "tg:-123456",
    }),
  )
  const direct = await ingest("org_a", connId, tgEvent({ externalThreadId: "tg:888001", senderExternalId: "tg:888001" }))
  const [groupBefore] = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select()
      .from(conversation)
      .where(and(eq(conversation.organizationId, "org_a"), eq(conversation.externalThreadId, "tg:-123456")))
      .limit(1),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      resolveConversationIdentity(tx, "org_a", groupBefore?.id ?? "", { identityId: identity.id }, { userId: null }),
    ),
  ).rejects.toMatchObject({ code: "GROUP_THREAD", status: 409 })
  const moved = await withOrgContext(appDb, "org_a", (tx) =>
    moveContactIdentity(tx, "org_a", null, identity.id, { fromContactId: from.id, toContactId: to.id, reason: "Cambio de titular" }),
  )
  expect(moved.movedConversations).toBe(1)
  const [group] = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select()
      .from(conversation)
      .where(and(eq(conversation.organizationId, "org_a"), eq(conversation.externalThreadId, "tg:-123456")))
      .limit(1),
  )
  expect(group?.contactId).toBe(from.id)
  expect(group?.contactIdentityId).toBeNull()
  const directDetail = await withOrgContext(appDb, "org_a", (tx) =>
    getConversationDetail(tx, "org_a", direct.conversationId),
  )
  expect(directDetail.contact.id).toBe(to.id)
})
it("inicio directo valida canal, exige inbound en Telegram y contacto activo", async () => {
  const waConn = await makeWaConnection("org_a")
  const tgConn = await makeTgConnection("org_a")
  const person = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Persona Directa" }),
  )
  const waIdentity = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, person.id, { channel: "whatsapp", externalUserId: "wa:51900000333" }),
  )
  const tgIdentity = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, person.id, { channel: "telegram", externalUserId: "tg:999002" }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      startContactConversation(tx, "org_a", null, person.id, { identityId: tgIdentity.id, connectionId: tgConn }),
    ),
  ).rejects.toMatchObject({ code: "CHANNEL_REQUIRES_INBOUND", status: 409 })
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    startContactConversation(tx, "org_a", null, person.id, { identityId: waIdentity.id, connectionId: waConn }),
  )
  expect(created.created).toBe(true)
  const reused = await withOrgContext(appDb, "org_a", (tx) =>
    startContactConversation(tx, "org_a", null, person.id, { identityId: waIdentity.id, connectionId: waConn }),
  )
  expect(reused).toMatchObject({ id: created.id, created: false })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      startContactConversation(tx, "org_a", null, person.id, { identityId: waIdentity.id, connectionId: tgConn }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION", status: 400 })
  await withOrgContext(appDb, "org_a", (tx) =>
    updateContact(tx, "org_a", person.id, { isActive: false }, { userId: null }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      startContactConversation(tx, "org_a", null, person.id, { identityId: waIdentity.id, connectionId: waConn }),
    ),
  ).rejects.toMatchObject({ code: "CONTACT_ARCHIVED", status: 409 })
})

it("transferencia no cruza organizaciones", async () => {
  const a = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Local A" }),
  )
  const b = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Local B" }),
  )
  const foreign = await withOrgContext(appDb, "org_b", (tx) =>
    createContact(tx, "org_b", { displayName: "Foráneo" }),
  )
  const identity = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, a.id, { channel: "whatsapp", externalUserId: "wa:51900000444" }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      moveContactIdentity(tx, "org_a", null, identity.id, { fromContactId: a.id, toContactId: foreign.id, reason: "Intento ajeno" }),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      moveContactIdentity(tx, "org_b", null, identity.id, { fromContactId: a.id, toContactId: b.id, reason: "Intento ajeno" }),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
})
