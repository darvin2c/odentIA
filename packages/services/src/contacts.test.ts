import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type InboundMessageJob, withOrgContext } from "@odentia/db"
import { contactIdentity, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { and, eq, sql } from "drizzle-orm"
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
import { createOpportunity, getOpportunity, setOpportunityTask, updateOpportunity } from "./opportunities.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { createTask, listTasks } from "./tasks.js"
import { appDb, ownerDb, retireWhatsApp, setupTestDb } from "./test-setup.js"

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
    await retireWhatsApp(orgId)
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

it("transferencia conserva negocio en origen y desvincula el hilo movido", async () => {
  const connId = await makeWaConnection("org_a")
  const from = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Origen Negocio" }),
  )
  const to = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Destino Negocio" }),
  )
  const identity = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, from.id, { channel: "whatsapp", externalUserId: "wa:51900000555" }),
  )
  const moved = await withOrgContext(appDb, "org_a", (tx) =>
    startContactConversation(tx, "org_a", null, from.id, { identityId: identity.id, connectionId: connId }),
  )
  // Otro canal del origen que no se transfiere.
  const otherIdentity = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, from.id, { channel: "whatsapp", externalUserId: "wa:51900000556" }),
  )
  const stayed = await withOrgContext(appDb, "org_a", (tx) =>
    startContactConversation(tx, "org_a", null, from.id, { identityId: otherIdentity.id, connectionId: connId }),
  )
  await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  const opp = await withOrgContext(appDb, "org_a", (tx) =>
    createOpportunity(
      tx,
      "org_a",
      { contactId: from.id, title: "Ortodoncia", conversationId: moved.id },
      { userId: null },
    ),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    setOpportunityTask(tx, "org_a", opp.id, { title: "Llamar mañana", dueAt: new Date(Date.now() + 86_400_000).toISOString() }, { userId: null, createdBy: "user" }),
  )
  const followUps = await withOrgContext(appDb, "org_a", (tx) =>
    listTasks(tx, "org_a", { opportunityId: opp.id, status: "open" }),
  )
  expect(followUps).toHaveLength(1)
  expect(followUps[0]?.conversationId).toBe(moved.id)
  // La tarea de la oportunidad (su próxima acción) es la que acompaña al negocio.
  const commercial = followUps[0]!
  const manual = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: "Operativa", contactId: from.id, conversationId: moved.id, createdBy: "user" }),
  )
  const loose = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: "Suelta", contactId: from.id, createdBy: "user" }),
  )
  const result = await withOrgContext(appDb, "org_a", (tx) =>
    moveContactIdentity(tx, "org_a", null, identity.id, { fromContactId: from.id, toContactId: to.id, reason: "Número del hijo" }),
  )
  expect(result).toMatchObject({
    movedConversations: 1,
    movedTasks: 1,
    reconciledOpportunities: 1,
    reconciledTasks: 1,
  })
  // Hilo e identidad pasan a B con la tarea operativa.
  const detail = await withOrgContext(appDb, "org_a", (tx) =>
    getConversationDetail(tx, "org_a", moved.id),
  )
  expect(detail.contact.id).toBe(to.id)
  const [identityRow] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(contactIdentity).where(eq(contactIdentity.id, identity.id)).limit(1),
  )
  expect(identityRow?.contactId).toBe(to.id)
  const tasks = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(eq(crmTask.organizationId, "org_a")),
  )
  const byId = new Map(tasks.map((t) => [t.id, t]))
  expect(byId.get(manual.id)?.contactId).toBe(to.id)
  expect(byId.get(manual.id)?.conversationId).toBe(moved.id)
  // Negocio y paciente quedan en A sin el hilo de B.
  const kept = await withOrgContext(appDb, "org_a", (tx) => getOpportunity(tx, "org_a", opp.id))
  expect(kept.contactId).toBe(from.id)
  expect(kept.conversationId).toBeNull()
  expect(byId.get(commercial.id)?.contactId).toBe(from.id)
  expect(byId.get(commercial.id)?.conversationId).toBeNull()
  expect(byId.get(commercial.id)?.opportunityId).toBe(opp.id)
  expect(byId.get(followUps[0]!.id)?.contactId).toBe(from.id)
  expect(byId.get(followUps[0]!.id)?.conversationId).toBeNull()
  expect(byId.get(followUps[0]!.id)?.status).toBe("open")
  // Otro canal y tareas sueltas no se tocan.
  const stayedDetail = await withOrgContext(appDb, "org_a", (tx) =>
    getConversationDetail(tx, "org_a", stayed.id),
  )
  expect(stayedDetail.contact.id).toBe(from.id)
  expect(byId.get(loose.id)?.contactId).toBe(from.id)
  // Editar la oportunidad o su tarea luego no revincula la conversación antigua.
  const edited = await withOrgContext(appDb, "org_a", (tx) =>
    updateOpportunity(tx, "org_a", opp.id, { title: "Ortodoncia invisible" }, { userId: null }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    setOpportunityTask(tx, "org_a", opp.id, { title: "Llamar pasado mañana" }, { userId: null, createdBy: "user" }),
  )
  expect(edited.contactId).toBe(from.id)
  expect(edited.conversationId).toBeNull()
  const openFollowUps = await withOrgContext(appDb, "org_a", (tx) =>
    listTasks(tx, "org_a", { opportunityId: opp.id, status: "open" }),
  )
  expect(openFollowUps).toHaveLength(1)
  expect(openFollowUps[0]?.contactId).toBe(from.id)
  expect(openFollowUps[0]?.conversationId).toBeNull()
})

it("un teléfono nacional se completa con el país de la clínica; en otro país se pide con su código", async () => {
  const peruvian = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Celular nacional", phone: "987 111 222" }),
  )
  expect(peruvian.phone).toBe("+51987111222")
  // Otra clínica, en Chile: el mismo texto no es un número peruano y nadie le pone +51.
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_cl', 'Clínica Santiago', 'santiago', now()) on conflict do nothing`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values ('org_cl', 'Clínica Santiago', 'CL', 'CLP', 'America/Santiago', 'es-CL') on conflict do nothing`,
  )
  const rejected = await withOrgContext(appDb, "org_cl", (tx) =>
    createContact(tx, "org_cl", { displayName: "Sin prefijo", phone: "987 111 222" }),
  ).catch((error: unknown) => error)
  expect(rejected).toMatchObject({ status: 400 })
  expect((rejected as Error).message).not.toMatch(/\+51|9 dígitos/)
  const chilean = await withOrgContext(appDb, "org_cl", (tx) =>
    createContact(tx, "org_cl", { displayName: "Con prefijo", phone: "+56 9 8765 4321" }),
  )
  expect(chilean.phone).toBe("+56987654321")
  const edited = await withOrgContext(appDb, "org_a", (tx) =>
    updateContact(tx, "org_a", peruvian.id, { phone: "51 999-888-777" }),
  )
  expect(edited.phone).toBe("+51999888777")
})
