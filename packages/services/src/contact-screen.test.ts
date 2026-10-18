import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type InboundMessageJob, withOrgContext } from "@odentia/db"
import { sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { createConnection } from "./connections.js"
import {
  blockContact,
  contactOfConversation,
  getContactScreenView,
  leaveSpam,
  markSpam,
  redactOldSpam,
  SPAM_KEEP_DAYS,
  SPAM_REPEAT_COUNT,
  unblockContact,
} from "./contact-screen.js"
import { screenInbound, sendToSpam, takeOutOfSpam } from "./contact-screen-actions.js"
import { type IngestDeps, ingestInbound, listConversations, sendOutbound } from "./conversations.js"
import { summarizeInbox } from "./inbox.js"
import { mayWriteFirst } from "./message-permission.js"
import { createPatient } from "./patients.js"
import { listPeople } from "./people.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Spam y bloqueados (issue 77, ADR 0054): quién va a Spam y quién nunca, qué
 * deja de ver la Bandeja, «No es spam», bloquear y lo que se borra a los 90
 * días. La corrida del agente (no responder, Jev) se prueba en el agente.
 */
setupTestDb()

const ORG = "org_a"
const USER = "u_recepcion_spam"
const KEY = secretsKeyFromEnv("cd".repeat(32))

const stubAdapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: { templates: false, media: true, interactive: false, readReceipts: false, edit: true },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "stub-1" }),
  validateConnection: async () => ({ externalId: "bot-spam", displayName: "Bot" }),
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
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }
let connectionId = ""
let counter = 0

beforeAll(async () => {
  await ownerDb.execute(
    sql`insert into "user" (id, name, email, email_verified) values (${USER}, 'Carla', 'carla@spam.test', true) on conflict (id) do nothing`,
  )
  connectionId = await withOrgContext(appDb, ORG, async (tx) => {
    const created = await createConnection(
      tx,
      ORG,
      KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
      { fetch, validateExternal: false },
    )
    return created.id
  })
})

const run = <T>(fn: (tx: Parameters<Parameters<typeof withOrgContext>[2]>[0]) => Promise<T>) => withOrgContext(appDb, ORG, fn)

/** Un mensaje de `sender` con `text`, guardado y pasado por la regla del worker. */
async function write(sender: string, text: string) {
  counter += 1
  const event: NormalizedInbound = {
    externalEventId: `spam-evt-${counter}`,
    externalMessageId: `spam-ext-${counter}`,
    externalThreadId: `tg:${sender}`,
    senderExternalId: `tg:${sender}`,
    senderDisplayName: `Persona ${sender}`,
    content: { type: "text", text },
    sentAt: new Date().toISOString(),
  }
  const job: InboundMessageJob = { orgId: ORG, connectionId, event }
  const ingested = await run((tx) => ingestInbound(tx, job, stubAdapter, deps))
  const screen = await run((tx) => screenInbound(tx, ORG, { conversationId: ingested.conversationId, messageId: ingested.messageId }))
  return { ...ingested, screen }
}

it("el mismo texto 5 veces en una hora va a Spam y sale de las pestañas; 4 veces, no", async () => {
  let last = await write("900", "GANA S/ 500 DIARIOS desde casa")
  for (let i = 1; i < SPAM_REPEAT_COUNT - 1; i += 1) last = await write("900", "  gana s/ 500 diarios   desde casa ")
  expect(last.screen.screen).toBeNull()
  last = await write("900", "GANA S/ 500 DIARIOS desde casa")
  expect(last.screen.screen).toBe("spam")
  const view = await run((tx) => getContactScreenView(tx, ORG, last.screen.contactId))
  expect(view).toMatchObject({ screen: "spam", reason: "repeticion", byName: null })
  const inTabs = await run((tx) => listConversations(tx, ORG, { view: "agent" }))
  const inAttend = await run((tx) => listConversations(tx, ORG, { view: "attend" }))
  const inSpam = await run((tx) => listConversations(tx, ORG, { view: "spam" }))
  expect([...inTabs.items, ...inAttend.items].map((item) => item.id)).not.toContain(last.conversationId)
  expect(inSpam.items.find((item) => item.id === last.conversationId)?.contact).toMatchObject({ screen: "spam", screenReason: "repeticion" })
  const summary = await run((tx) => summarizeInbox(tx, ORG, {}))
  expect(summary.spam).toBeGreaterThanOrEqual(1)
  // A quien está en Spam lo automático no le escribe.
  expect(await run((tx) => mayWriteFirst(tx, ORG, last.screen.contactId, "recordatorio"))).toBe(false)
  // Lo repetido no se vuelve a mirar; un texto nuevo, sí.
  expect((await write("900", "GANA S/ 500 DIARIOS desde casa")).screen.recheck).toBe(false)
  expect((await write("900", "perdón, número equivocado, ¿atienden el sábado?")).screen.recheck).toBe(true)
})

it("a quien el equipo ya le escribió, o es paciente, nunca va solo a Spam", async () => {
  const first = await write("901", "hola")
  await run((tx) => sendOutbound(tx, ORG, { conversationId: first.conversationId, senderKind: "user", senderUserId: USER, content: { type: "text", text: "Hola, ¿en qué te ayudo?" } }))
  let last = first
  for (let i = 0; i < SPAM_REPEAT_COUNT + 1; i += 1) last = await write("901", "hola")
  expect(last.screen.screen).toBeNull()

  const patient = await run((tx) => createPatient(tx, ORG, USER, { displayName: "Rosa Quispe" }))
  await expect(run((tx) => markSpam(tx, ORG, { contactId: patient.personId, reason: "equipo", userId: USER }))).rejects.toMatchObject({
    code: "PATIENT_NOT_SPAM",
  })
  expect(await run((tx) => markSpam(tx, ORG, { contactId: patient.personId, reason: "publicidad", userId: null }))).toBe(false)
})

it("«No es spam» la devuelve, la protege y el agente le responde si la atiende", async () => {
  let last = await write("902", "reenvía esto a 10 contactos")
  for (let i = 1; i < SPAM_REPEAT_COUNT; i += 1) last = await write("902", "reenvía esto a 10 contactos")
  expect(last.screen.screen).toBe("spam")
  // Con el agente apagado: vuelve a la Bandeja y ya sale en «Por atender», sin tema.
  expect(await run((tx) => takeOutOfSpam(tx, ORG, { contactId: last.screen.contactId, userId: USER }))).toEqual({ agentReplies: false, topic: false })
  for (let i = 0; i < SPAM_REPEAT_COUNT; i += 1) last = await write("902", "reenvía esto a 10 contactos")
  expect(last.screen.screen).toBeNull()

  // Con el agente encendido y sin ventana (Telegram): el agente le responde ya.
  await run((tx) => sendToSpam(tx, ORG, { contactId: last.screen.contactId, userId: USER }))
  await run((tx) => upsertAgentConfig(tx, ORG, { enabled: true, channels: null }))
  try {
    const before = await ownerDb.execute<{ n: number }>(sql`select count(*)::int as n from pgmq.q_agent_runs`)
    expect(await run((tx) => takeOutOfSpam(tx, ORG, { contactId: last.screen.contactId, userId: USER }))).toEqual({ agentReplies: true, topic: false })
    const after = await ownerDb.execute<{ n: number }>(sql`select count(*)::int as n from pgmq.q_agent_runs`)
    expect((after[0]?.n ?? 0) - (before[0]?.n ?? 0)).toBe(1)
  } finally {
    await run((tx) => upsertAgentConfig(tx, ORG, { enabled: false, channels: null }))
  }
})

it("salir sola de Spam queda dicho, con quién la había marcado", async () => {
  const first = await write("903", "Hola, somos una agencia de páginas web")
  await run((tx) => sendToSpam(tx, ORG, { contactId: first.screen.contactId, userId: USER }))
  const next = await write("903", "perdón, ¿cuánto cuesta una limpieza?")
  expect(next.screen).toMatchObject({ screen: "spam", recheck: true })
  expect(await run((tx) => leaveSpam(tx, ORG, { contactId: next.screen.contactId, messageId: next.messageId }))).toBe(true)
  const view = await run((tx) => getContactScreenView(tx, ORG, next.screen.contactId))
  expect(view.screen).toBeNull()
  expect(view.leftSpam).toMatchObject({ messageId: next.messageId, markedByName: "Carla" })
})

it("bloquear: nunca a un paciente; nadie le escribe; desbloquear lo devuelve", async () => {
  const patient = await run((tx) => createPatient(tx, ORG, USER, { displayName: "Pedro Ríos" }))
  await expect(
    run((tx) => blockContact(tx, ORG, { contactId: patient.personId, userId: USER, reason: "acoso", note: "Insultó al equipo" })),
  ).rejects.toMatchObject({ code: "PATIENT_NOT_BLOCKABLE" })

  const first = await write("904", "Esto no se queda así")
  const contactId = await run((tx) => contactOfConversation(tx, ORG, first.conversationId))
  await expect(run((tx) => blockContact(tx, ORG, { contactId, userId: USER, reason: "amenazas", note: "  " }))).rejects.toMatchObject({
    code: "VALIDATION",
  })
  await run((tx) => blockContact(tx, ORG, { contactId, userId: USER, reason: "amenazas", note: "Amenazó a recepción" }))
  expect(await run((tx) => getContactScreenView(tx, ORG, contactId))).toMatchObject({
    screen: "blocked",
    reason: "amenazas",
    byName: "Carla",
    note: "Amenazó a recepción",
  })
  await expect(
    run((tx) => sendOutbound(tx, ORG, { conversationId: first.conversationId, senderKind: "user", senderUserId: USER, content: { type: "text", text: "Hola" } })),
  ).rejects.toMatchObject({ code: "CONTACT_BLOCKED" })
  expect((await write("904", "¿Me escuchan?")).screen.screen).toBe("blocked")
  const blockedList = await run((tx) => listConversations(tx, ORG, { view: "blocked" }))
  expect(blockedList.items.map((item) => item.id)).toContain(first.conversationId)

  await run((tx) => unblockContact(tx, ORG, { contactId, userId: USER }))
  expect((await run((tx) => getContactScreenView(tx, ORG, contactId))).screen).toBeNull()
  const audit = await ownerDb.execute<{ action: string }>(
    sql`select action from audit_event where entity = 'contact' and entity_id = ${contactId} order by created_at`,
  )
  expect(audit.map((row) => row.action)).toEqual(["contact.blocked", "contact.unblocked"])
})

it("lo que sigue en Spam se borra a los 90 días; lo de un bloqueado, no; «Por registrar» no los muestra", async () => {
  let spam = await write("905", "Préstamos al instante")
  for (let i = 1; i < SPAM_REPEAT_COUNT; i += 1) spam = await write("905", "Préstamos al instante")
  const blocked = await write("906", "Te voy a denunciar")
  const blockedContact = await run((tx) => contactOfConversation(tx, ORG, blocked.conversationId))
  await run((tx) => blockContact(tx, ORG, { contactId: blockedContact, userId: USER, reason: "acoso", note: "Insultos" }))
  await ownerDb.execute(sql`update message set created_at = now() - make_interval(days => ${SPAM_KEEP_DAYS + 5})
    where conversation_id in (${spam.conversationId}::uuid, ${blocked.conversationId}::uuid)`)

  const result = await run((tx) => redactOldSpam(tx, ORG))
  expect(result.redacted).toBe(SPAM_REPEAT_COUNT)
  const rows = await ownerDb.execute<{ conversation_id: string; body: string | null; redacted: boolean }>(
    sql`select conversation_id, body, redacted_at is not null as redacted from message
      where conversation_id in (${spam.conversationId}::uuid, ${blocked.conversationId}::uuid)`,
  )
  expect(rows.filter((row) => row.conversation_id === spam.conversationId).every((row) => row.redacted && row.body === null)).toBe(true)
  expect(rows.filter((row) => row.conversation_id === blocked.conversationId).every((row) => !row.redacted && row.body)).toBe(true)

  const toRegister = await run((tx) => listPeople(tx, ORG, { view: "por_registrar", limit: 100 }, () => true))
  const ids = toRegister.items.map((item) => item.id)
  expect(ids).not.toContain(spam.screen.contactId)
  expect(ids).not.toContain(blockedContact)
  const everyone = await run((tx) => listPeople(tx, ORG, { view: "todos", limit: 100 }, () => true))
  expect(everyone.items.find((item) => item.id === blockedContact)?.screen).toBe("blocked")
})
