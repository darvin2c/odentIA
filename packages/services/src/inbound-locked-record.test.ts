import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type InboundMessageJob, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { contact } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { createConnection } from "./connections.js"
import { getConversationDetail, type IngestDeps, ingestInbound } from "./conversations.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const KEY = secretsKeyFromEnv("dd".repeat(32))
const ORG = "org_a"

// QA ALTA-02 (ADR 0080): un mensaje de una persona con la historia bloqueada no la reactiva.
// Se guarda y queda bloqueada; Administración la reactiva a mano.
beforeAll(async () => {
  await ownerDb.insert(user).values({ id: "owner-lock", name: "Administración", email: "admin@lock.test", emailVerified: true })
  await ownerDb.insert(member).values({ id: "owner-lock-membership", userId: "owner-lock", organizationId: ORG, role: "owner", createdAt: new Date() })
})

const adapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: { templates: false, media: true, interactive: false, readReceipts: false, edit: true },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "stub-lock" }),
  validateConnection: async () => ({ externalId: "bot-lock", displayName: "Bot" }),
}

const storage = {} as unknown as Storage
const deps: IngestDeps = { storage, fetch: globalThis.fetch, secretsKey: KEY }

function textEvent(eventId: string, text: string): NormalizedInbound {
  const sender = "lock-900111"
  return {
    externalEventId: eventId,
    externalMessageId: eventId,
    externalThreadId: `tg:${sender}`,
    senderExternalId: `tg:${sender}`,
    senderDisplayName: "Lucía bloqueada",
    content: { type: "text", text },
    sentAt: new Date().toISOString(),
  }
}

it("un mensaje de una historia bloqueada se guarda sin reactivarla y avisa a Administración", async () => {
  const connection = await withOrgContext(appDb, ORG, (tx) =>
    createConnection(tx, ORG, KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot lock", config: { botToken: "T" } },
      { fetch: globalThis.fetch, validateExternal: false }).then((c) => c.id),
  )
  const job = (eventId: string, text: string): InboundMessageJob => ({ orgId: ORG, connectionId: connection, event: textEvent(eventId, text) })

  // Primer mensaje: la persona queda creada y activa.
  const first = await withOrgContext(appDb, ORG, (tx) => ingestInbound(tx, job("lock-1", "Hola"), adapter, deps))
  const contactId = await withOrgContext(appDb, ORG, async (tx) => (await getConversationDetail(tx, ORG, first.conversationId)).contact.id)

  // Su historia queda bloqueada (inactiva y con quién la bloqueó, como exige la base).
  await ownerDb
    .update(contact)
    .set({ isActive: false, recordLockedAt: new Date(), recordLockedBy: "owner-lock" })
    .where(eq(contact.id, contactId))

  // Vuelve a escribir: el mensaje entra, sin reactivarla y sin perderse.
  const again = await withOrgContext(appDb, ORG, (tx) => ingestInbound(tx, job("lock-2", "Estoy de vuelta"), adapter, deps))
  expect(again.messageId).toBeTruthy()

  const [row] = await ownerDb
    .select({ isActive: contact.isActive, recordLockedAt: contact.recordLockedAt })
    .from(contact)
    .where(eq(contact.id, contactId))
  expect(row).toMatchObject({ isActive: false })
  expect(row?.recordLockedAt).not.toBeNull()
})
