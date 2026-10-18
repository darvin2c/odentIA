import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type InboundMessageJob, withOrgContext } from "@odentia/db"
import { contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { createConnection } from "./connections.js"
import { addContactIdentity, createContact, moveContactIdentity, updateContact } from "./contacts.js"
import {
  applyStatus,
  getConversationDetail,
  type IngestDeps,
  ingestInbound,
  listConversations,
  listContactChannelHistory,
  listMessages,
  markRead,
  sendOutbound,
  sendTemplateOutbound,
  setAgentStatus,
} from "./conversations.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, retireWhatsApp, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

const KEY = secretsKeyFromEnv("cc".repeat(32))

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

const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }

function textEvent(over: Partial<NormalizedInbound> = {}): NormalizedInbound {
  return {
    externalEventId: "evt-1",
    externalMessageId: "ext-1",
    externalThreadId: "tg:555",
    senderExternalId: "tg:555",
    senderDisplayName: "Ana",
    content: { type: "text", text: "Hola" },
    sentAt: new Date().toISOString(),
    ...over,
  }
}

async function makeTelegramConnection(orgId: string): Promise<string> {
  return withOrgContext(appDb, orgId, async (tx) => {
    const created = await createConnection(
      tx,
      orgId,
      KEY,
      {
        channel: "telegram",
        provider: "telegram_bot_api",
        displayName: "Bot",
        config: { botToken: "T" },
      },
      { fetch, validateExternal: false },
    )
    return created.id
  })
}

async function ingest(orgId: string, connectionId: string, event: NormalizedInbound) {
  const job: InboundMessageJob = { orgId, connectionId, event }
  return withOrgContext(appDb, orgId, (tx) => ingestInbound(tx, job, stubAdapter, deps))
}

it("ingesta crea contacto, conversación y mensaje; repetida dedupea", async () => {
  const connId = await makeTelegramConnection("org_a")
  const first = await ingest("org_a", connId, textEvent())
  expect(first.created).toBe(true)
  const detail = await withOrgContext(appDb, "org_a", (tx) =>
    getConversationDetail(tx, "org_a", first.conversationId),
  )
  expect(detail.contact.displayName).toBe("Ana")
  expect(detail.messages).toHaveLength(1)
  expect(detail.messages[0]?.body).toBe("Hola")
  expect(detail.messages[0]?.status).toBe("received")

  const second = await ingest("org_a", connId, textEvent())
  expect(second.created).toBe(false)
  expect(second.messageId).toBe(first.messageId)
  const messages = await withOrgContext(appDb, "org_a", (tx) =>
    listMessages(tx, "org_a", first.conversationId, {}),
  )
  expect(messages.items).toHaveLength(1)
})

it("segundo hilo crea otra conversación; listados aíslan por org", async () => {
  const connId = await makeTelegramConnection("org_a")
  const other = await ingest(
    "org_a",
    connId,
    textEvent({ externalEventId: "evt-2", externalMessageId: "ext-2" }),
  )
  expect(other.created).toBe(true)
  const list = await withOrgContext(appDb, "org_a", (tx) => listConversations(tx, "org_a", {}))
  expect(list.items.length).toBeGreaterThanOrEqual(1)
  expect(list.items[0]?.preview?.body).toBe("Hola")
  const empty = await withOrgContext(appDb, "org_b", (tx) => listConversations(tx, "org_b", {}))
  expect(empty.items).toEqual([])
})

it("sendOutbound humano no apaga el agente (ADR 0050), marca leído y encola", async () => {
  const connId = await makeTelegramConnection("org_a")
  const { conversationId } = await ingest(
    "org_a",
    connId,
    textEvent({ externalEventId: "evt-3", externalMessageId: "ext-3" }),
  )
  const sent = await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", {
      conversationId,
      senderKind: "user",
      senderUserId: "u-1",
      content: { type: "text", text: "Te ayudo" },
    }),
  )
  expect(sent.status).toBe("queued")
  const detail = await withOrgContext(appDb, "org_a", (tx) =>
    getConversationDetail(tx, "org_a", conversationId),
  )
  // Escribir no apaga al agente: espera mientras el equipo conversa en vivo y luego vuelve solo.
  expect(detail.conversation.agentStatus).toBe("on")
  expect(detail.conversation.unreadCount).toBe(0)
  const queued = (await ownerDb.execute(
    sql`select message from pgmq.read('outbound_messages', 30, 10)`,
  )) as unknown as { message: { messageId: string } }[]
  expect(queued.map((q) => q.message.messageId)).toContain(sent.id)
  // Re-activar y marcar leído no fallan.
  await withOrgContext(appDb, "org_a", (tx) =>
    setAgentStatus(tx, "org_a", conversationId, true, "u-1"),
  )
  await withOrgContext(appDb, "org_a", (tx) => markRead(tx, "org_a", conversationId))
})

it("ventana 24h de WhatsApp bloquea texto pero permite plantilla", async () => {
  const connId = await withOrgContext(appDb, "org_a", async (tx) => {
    await retireWhatsApp("org_a")
    const created = await createConnection(
      tx,
      "org_a",
      KEY,
      {
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA",
        config: {
          phoneNumberId: "PNID",
          wabaId: "WABA",
          accessToken: "T",
          appSecret: "S",
          templates: [{ name: "t1", language: "es_PE" }],
        },
      },
      { fetch, validateExternal: false },
    )
    return created.id
  })
  const waEvent = textEvent({
    externalEventId: "evt-wa",
    externalMessageId: "wamid.1",
    externalThreadId: "wa:51911122233",
    senderExternalId: "wa:51911122233",
  })
  const { conversationId } = await ingest("org_a", connId, waEvent)
  await ownerDb.execute(
    sql`update "conversation" set "last_inbound_at" = now() - interval '25 hours' where "id" = ${conversationId}::uuid`,
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      sendOutbound(tx, "org_a", {
        conversationId,
        senderKind: "user",
        content: { type: "text", text: "hola" },
      }),
    ),
  ).rejects.toMatchObject({ code: "WINDOW_CLOSED", status: 409 })
  const tpl = await withOrgContext(appDb, "org_a", (tx) =>
    sendTemplateOutbound(tx, "org_a", KEY, {
      conversationId,
      senderKind: "agent",
      name: "t1",
      language: "es_PE",
      params: ["Ana"],
      category: "utility",
    }),
  )
  expect(tpl.contentType).toBe("template")
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      sendTemplateOutbound(tx, "org_a", KEY, {
        conversationId,
        senderKind: "agent",
        name: "otra",
        language: "es_PE",
        params: [],
        category: "utility",
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
})

it("sendOutbound con media persiste adjunto, contentType derivado y caption", async () => {
  const connId = await makeTelegramConnection("org_a")
  const { conversationId } = await ingest(
    "org_a",
    connId,
    textEvent({ externalEventId: "evt-m1", externalMessageId: "ext-m1" }),
  )
  const sent = await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", {
      conversationId,
      senderKind: "user",
      senderUserId: "u-1",
      content: {
        type: "media",
        attachment: {
          objectKey: "org_a/conv/foto.png",
          mimeType: "image/png",
          filename: "foto.png",
          size: 128,
        },
        caption: "Mira esto",
      },
    }),
  )
  expect(sent.contentType).toBe("image")
  expect(sent.body).toBe("Mira esto")
  expect(sent.status).toBe("queued")
  const atts = sent.attachments as { filename: string; mimeType: string }[]
  expect(atts).toHaveLength(1)
  expect(atts[0]?.filename).toBe("foto.png")
})

it("media saliente de WhatsApp fuera de ventana lanza WINDOW_CLOSED", async () => {
  const connId = await withOrgContext(appDb, "org_a", async (tx) => {
    await retireWhatsApp("org_a")
    const created = await createConnection(
      tx,
      "org_a",
      KEY,
      {
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA",
        config: {
          phoneNumberId: "PNID",
          wabaId: "WABA",
          accessToken: "T",
          appSecret: "S",
          templates: [],
        },
      },
      { fetch, validateExternal: false },
    )
    return created.id
  })
  const { conversationId } = await ingest(
    "org_a",
    connId,
    textEvent({
      externalEventId: "evt-wam",
      externalMessageId: "wamid.m1",
      externalThreadId: "wa:51944455566",
      senderExternalId: "wa:51944455566",
    }),
  )
  await ownerDb.execute(
    sql`update "conversation" set "last_inbound_at" = now() - interval '25 hours' where "id" = ${conversationId}::uuid`,
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      sendOutbound(tx, "org_a", {
        conversationId,
        senderKind: "user",
        content: {
          type: "media",
          attachment: {
            objectKey: "org_a/conv/foto.png",
            mimeType: "image/png",
            filename: "foto.png",
            size: 1,
          },
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "WINDOW_CLOSED", status: 409 })
})

const audioAdapter: ChannelAdapter = {
  ...stubAdapter,
  fetchMedia: async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "audio/ogg",
    filename: "nota.ogg",
  }),
}

function audioEvent(over: Partial<NormalizedInbound> = {}): NormalizedInbound {
  return textEvent({
    content: { type: "media", mediaExternalId: "m-1", mimeType: "audio/ogg" },
    ...over,
  })
}

/** Con el agente encendido en la clínica (la transcripción es para que él lea el audio). */
async function withAgentOn<T>(fn: () => Promise<T>, channels: string[] | null = null): Promise<T> {
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { enabled: true, channels }))
  try {
    return await fn()
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { enabled: false, channels: null }))
  }
}

it("nota de voz entrante se transcribe al body", async () => {
  const connId = await makeTelegramConnection("org_a")
  const job: InboundMessageJob = {
    orgId: "org_a",
    connectionId: connId,
    event: audioEvent({ externalEventId: "evt-t1", externalMessageId: "ext-t1" }),
  }
  const depsT: IngestDeps = { ...deps, transcribe: async () => "hola, quiero cita" }
  const { conversationId } = await withAgentOn(() =>
    withOrgContext(appDb, "org_a", (tx) => ingestInbound(tx, job, audioAdapter, depsT)),
  )
  const detail = await withOrgContext(appDb, "org_a", (tx) =>
    getConversationDetail(tx, "org_a", conversationId),
  )
  const msg = detail.messages[0]
  expect(msg?.contentType).toBe("audio")
  expect(msg?.body).toBe("hola, quiero cita")
  expect(msg?.error).toBeNull()
  expect(msg?.attachments).toHaveLength(1)
})

it("sin el agente que la lea, la nota de voz queda como audio y no se paga su transcripción", async () => {
  const connId = await makeTelegramConnection("org_a")
  let calls = 0
  const depsT: IngestDeps = {
    ...deps,
    transcribe: async () => {
      calls += 1
      return "no debería transcribirse"
    },
  }
  const ingestAudio = (id: string) =>
    withOrgContext(appDb, "org_a", (tx) =>
      ingestInbound(tx, { orgId: "org_a", connectionId: connId, event: audioEvent({ externalEventId: id, externalMessageId: id, externalThreadId: `tg:${id}` }) }, audioAdapter, depsT),
    )
  const bodyOf = async (conversationId: string) =>
    (await withOrgContext(appDb, "org_a", (tx) => getConversationDetail(tx, "org_a", conversationId))).messages[0]?.body
  // Agente apagado en la clínica.
  expect(await bodyOf((await ingestAudio("evt-t-off")).conversationId)).toBeNull()
  // Encendido, pero sin atender ese canal.
  expect(await withAgentOn(async () => bodyOf((await ingestAudio("evt-t-canal")).conversationId), ["whatsapp"])).toBeNull()
  // Encendido en la clínica, pero apagado en esa conversación.
  const { conversationId } = await ingestAudio("evt-t-hilo")
  await withOrgContext(appDb, "org_a", (tx) => tx.update(conversation).set({ agentStatus: "off" }).where(eq(conversation.id, conversationId)))
  const again = await withAgentOn(() =>
    withOrgContext(appDb, "org_a", (tx) =>
      ingestInbound(tx, { orgId: "org_a", connectionId: connId, event: audioEvent({ externalEventId: "evt-t-hilo-2", externalMessageId: "evt-t-hilo-2", externalThreadId: "tg:evt-t-hilo" }) }, audioAdapter, depsT),
    ),
  )
  expect(again.conversationId).toBe(conversationId)
  const detail = await withOrgContext(appDb, "org_a", (tx) => getConversationDetail(tx, "org_a", conversationId))
  expect(detail.messages.map((item) => item.body)).toEqual([null, null])
  expect(calls).toBe(0)
})

it("fallo de transcripción no pierde la ingesta del audio", async () => {
  const connId = await makeTelegramConnection("org_a")
  const job: InboundMessageJob = {
    orgId: "org_a",
    connectionId: connId,
    event: audioEvent({ externalEventId: "evt-t2", externalMessageId: "ext-t2" }),
  }
  const depsT: IngestDeps = {
    ...deps,
    transcribe: async () => {
      throw new Error("whisper caído")
    },
  }
  const { conversationId, created } = await withAgentOn(() =>
    withOrgContext(appDb, "org_a", (tx) => ingestInbound(tx, job, audioAdapter, depsT)),
  )
  expect(created).toBe(true)
  const detail = await withOrgContext(appDb, "org_a", (tx) =>
    getConversationDetail(tx, "org_a", conversationId),
  )
  const msg = detail.messages[0]
  expect(msg?.contentType).toBe("audio")
  expect(msg?.body).toBeNull()
  expect(msg?.error).toBeNull()
  expect(msg?.attachments).toHaveLength(1)
})

it("applyStatus actualiza por externalId", async () => {
  const connId = await makeTelegramConnection("org_a")
  const { conversationId } = await ingest(
    "org_a",
    connId,
    textEvent({
      externalEventId: "evt-st",
      externalMessageId: "ext-st",
      externalThreadId: "tg:999",
    }),
  )
  const out = await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", {
      conversationId,
      senderKind: "agent",
      content: { type: "text", text: "hola" },
    }),
  )
  // El out no tiene externalId aún (lo pone el worker); simularlo.
  await ownerDb.execute(
    sql`update "message" set "external_id" = 'wamid.x' where "id" = ${out.id}::uuid`,
  )
  const applied = await withOrgContext(appDb, "org_a", (tx) =>
    applyStatus(tx, "org_a", [{ externalMessageId: "wamid.x", status: "read" }]),
  )
  expect(applied).toBe(1)
  const messages = await withOrgContext(appDb, "org_a", (tx) =>
    listMessages(tx, "org_a", conversationId, {}),
  )
  expect(messages.items.find((m) => m.id === out.id)?.status).toBe("read")
  expect(await withOrgContext(appDb, "org_a", (tx) => applyStatus(tx, "org_a", []))).toBe(0)
})

it("applyStatus guarda el motivo de un envío fallido tal como lo dice el adaptador", async () => {
  const connId = await makeTelegramConnection("org_a")
  const { conversationId } = await ingest(
    "org_a",
    connId,
    textEvent({ externalEventId: "evt-fail", externalMessageId: "ext-fail", externalThreadId: "tg:998" }),
  )
  const out = await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", { conversationId, senderKind: "agent", content: { type: "text", text: "hola" } }),
  )
  await ownerDb.execute(sql`update "message" set "external_id" = 'wamid.fail' where "id" = ${out.id}::uuid`)
  const reason =
    "WhatsApp no envió el mensaje porque la cuenta de WhatsApp de la clínica no tiene una forma de pago. Agrégala en Meta (Configuración de pagos de WhatsApp Business) y vuelve a intentarlo."
  await withOrgContext(appDb, "org_a", (tx) =>
    applyStatus(tx, "org_a", [{ externalMessageId: "wamid.fail", status: "failed", error: reason }]),
  )
  const messages = await withOrgContext(appDb, "org_a", (tx) => listMessages(tx, "org_a", conversationId, {}))
  expect(messages.items.find((m) => m.id === out.id)).toMatchObject({ status: "failed", error: reason })
})

it("ingesta con conexión inexistente falla", async () => {
  await expect(
    ingest(
      "org_a",
      "00000000-0000-0000-0000-000000000000",
      textEvent({ externalEventId: "evt-zz" }),
    ),
  ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" })
})

it("listMessages pagina con cursor", async () => {
  const connId = await makeTelegramConnection("org_a")
  const { conversationId } = await ingest(
    "org_a",
    connId,
    textEvent({
      externalEventId: "evt-pg",
      externalMessageId: "ext-pg",
      externalThreadId: "tg:pag",
    }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", {
      conversationId,
      senderKind: "agent",
      content: { type: "text", text: "uno" },
    }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", {
      conversationId,
      senderKind: "agent",
      content: { type: "text", text: "dos" },
    }),
  )
  const first = await withOrgContext(appDb, "org_a", (tx) =>
    listMessages(tx, "org_a", conversationId, { limit: 2 }),
  )
  expect(first.items).toHaveLength(2)
  expect(first.nextCursor).not.toBeNull()
  const second = await withOrgContext(appDb, "org_a", (tx) =>
    listMessages(tx, "org_a", conversationId, { limit: 2, before: first.nextCursor ?? "" }),
  )
  expect(second.items).toHaveLength(1)
  expect(second.items[0]?.body).toBe("Hola")
  expect(second.nextCursor).toBeNull()
})

it("ingesta persiste contactIdentityId en la conversación creada", async () => {
  const connId = await makeTelegramConnection("org_a")
  const { conversationId } = await ingest(
    "org_a",
    connId,
    textEvent({
      externalEventId: "evt-ident-1",
      externalMessageId: "ext-ident-1",
      externalThreadId: "tg:910001",
      senderExternalId: "tg:910001",
      senderDisplayName: "Ident",
    }),
  )
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(conversation).where(eq(conversation.id, conversationId)).limit(1),
  )
  expect(conv?.contactIdentityId).not.toBeNull()
  const [ident] = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select()
      .from(contactIdentity)
      .where(eq(contactIdentity.id, conv?.contactIdentityId ?? ""))
      .limit(1),
  )
  expect(ident).toMatchObject({ channel: "telegram", externalUserId: "tg:910001" })
  expect(ident?.contactId).toBe(conv?.contactId)
})

it("hilo compartido conserva interlocutor e identidad ante otro remitente", async () => {
  const connId = await makeTelegramConnection("org_a")
  const first = await ingest(
    "org_a",
    connId,
    textEvent({
      externalEventId: "evt-shared-1",
      externalMessageId: "ext-shared-1",
      externalThreadId: "tg:920001",
      senderExternalId: "tg:920001",
      senderDisplayName: "Primera",
    }),
  )
  const second = await ingest(
    "org_a",
    connId,
    textEvent({
      externalEventId: "evt-shared-2",
      externalMessageId: "ext-shared-2",
      externalThreadId: "tg:920001",
      senderExternalId: "tg:920002",
      senderDisplayName: "Segunda",
    }),
  )
  expect(second.conversationId).toBe(first.conversationId)
  expect(second.created).toBe(true)
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(conversation).where(eq(conversation.id, first.conversationId)).limit(1),
  )
  const firstDetail = await withOrgContext(appDb, "org_a", (tx) =>
    getConversationDetail(tx, "org_a", first.conversationId),
  )
  expect(conv?.contactId).toBe(firstDetail.contact.id)
  const [ident] = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select()
      .from(contactIdentity)
      .where(eq(contactIdentity.id, conv?.contactIdentityId ?? ""))
      .limit(1),
  )
  expect(ident?.externalUserId).toBe("tg:920001")
})

it("ingesta reutiliza el contacto archivado sin crear otro", async () => {
  const connId = await makeTelegramConnection("org_a")
  const event = textEvent({
    externalEventId: "evt-arch-1",
    externalMessageId: "ext-arch-1",
    externalThreadId: "tg:930001",
    senderExternalId: "tg:930001",
    senderDisplayName: "Archivada",
  })
  const first = await ingest("org_a", connId, event)
  const before = await withOrgContext(appDb, "org_a", (tx) =>
    getConversationDetail(tx, "org_a", first.conversationId),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    updateContact(tx, "org_a", before.contact.id, { isActive: false }, { userId: null }),
  )
  const again = await ingest(
    "org_a",
    connId,
    textEvent({
      externalEventId: "evt-arch-2",
      externalMessageId: "ext-arch-2",
      externalThreadId: "tg:930001",
      senderExternalId: "tg:930001",
      senderDisplayName: "Archivada",
    }),
  )
  expect(again.conversationId).toBe(first.conversationId)
  const after = await withOrgContext(appDb, "org_a", (tx) =>
    getConversationDetail(tx, "org_a", again.conversationId),
  )
  expect(after.contact.id).toBe(before.contact.id)
  expect(after.contact.isActive).toBe(false)
  const listed = await withOrgContext(appDb, "org_a", (tx) => listConversations(tx, "org_a", {}))
  expect(listed.items.find((c) => c.id === first.conversationId)?.contact.isActive).toBe(false)
})

it("cursores manipulados de bandeja y mensajes se rechazan antes de consultar PostgreSQL", async () => {
  const connId = await makeTelegramConnection("org_a")
  const ingested = await ingest("org_a", connId, textEvent({
    externalEventId: "cursor-invalido", externalMessageId: "cursor-invalido", externalThreadId: "tg:cursor-invalido",
  }))
  for (const payload of [
    { ts: "x", id: ingested.conversationId },
    { ts: "2026-10-01T00:00:00.000000Z", id: "y" },
    { ts: "2026-02-31T00:00:00.000000Z", id: ingested.conversationId },
  ]) {
    const cursor = Buffer.from(JSON.stringify(payload)).toString("base64url")
    await expect(withOrgContext(appDb, "org_a", tx =>
      listConversations(tx, "org_a", { cursor }),
    )).rejects.toMatchObject({ code: "VALIDATION", status: 400 })
    await expect(withOrgContext(appDb, "org_a", tx =>
      listMessages(tx, "org_a", ingested.conversationId, { before: cursor }),
    )).rejects.toMatchObject({ code: "VALIDATION", status: 400 })
  }
})

it("listContactChannelHistory: procedencia, acotación, paginación, identidad y transferencia", async () => {
  const tgConn = await makeTelegramConnection("org_a")
  const waConn = await withOrgContext(appDb, "org_a", async (tx) => {
    await retireWhatsApp("org_a")
    const created = await createConnection(
      tx,
      "org_a",
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
  const waConn2 = await withOrgContext(appDb, "org_a", async (tx) => {
    await retireWhatsApp("org_a")
    const created = await createConnection(
      tx,
      "org_a",
      KEY,
      {
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA2",
        config: { phoneNumberId: "P2", wabaId: "W2", accessToken: "T", appSecret: "S", templates: [] },
      },
      { fetch, validateExternal: false },
    )
    return created.id
  })
  const person = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Multi Canal" }),
  )
  const tgIdentity = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, person.id, { channel: "telegram", externalUserId: "tg:555001" }),
  )
  const waIdentity = await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, person.id, { channel: "whatsapp", externalUserId: "wa:51999000111" }),
  )
  const insertConv = async (args: {
    connectionId: string
    identityId: string | null
    thread: string
    at: string
    bodies: { direction: string; senderKind: string; body: string }[]
    contactId?: string
  }) => {
    return withOrgContext(appDb, "org_a", async (tx) => {
      const [conv] = await tx
        .insert(conversation)
        .values({
          organizationId: "org_a",
          contactId: args.contactId ?? person.id,
          contactIdentityId: args.identityId,
          channelConnectionId: args.connectionId,
          externalThreadId: args.thread,
          createdAt: new Date(args.at),
          lastMessageAt: new Date(args.at),
        })
        .returning({ id: conversation.id })
      if (!conv) throw new Error("sin conversación")
      for (const [i, m] of args.bodies.entries()) {
        await tx.insert(message).values({
          organizationId: "org_a",
          conversationId: conv.id,
          direction: m.direction,
          senderKind: m.senderKind,
          body: m.body,
          createdAt: new Date(new Date(args.at).getTime() + i * 1000),
        })
      }
      return conv.id
    })
  }
  // Hilo antiguo de Telegram con 6 mensajes (acota a 5), hilo medio de
  // WhatsApp y hilo actual (excluido).
  const convTg = await insertConv({
    connectionId: tgConn,
    identityId: tgIdentity.id,
    thread: "tg:multi-1",
    at: "2026-09-01T10:00:00Z",
    bodies: Array.from({ length: 6 }, (_, i) => ({
      direction: "in",
      senderKind: "contact",
      body: `mensaje tg ${i + 1}`,
    })),
  })
  const convWa = await insertConv({
    connectionId: waConn,
    identityId: waIdentity.id,
    thread: "wa:51999000111",
    at: "2026-09-10T10:00:00Z",
    bodies: [
      { direction: "in", senderKind: "contact", body: "quiero mi cita del lunes" },
      { direction: "out", senderKind: "agent", body: "quedó para el lunes 9:00" },
    ],
  })
  const convActual = await insertConv({
    connectionId: tgConn,
    identityId: tgIdentity.id,
    thread: "tg:multi-1-actual",
    at: "2026-09-20T10:00:00Z",
    bodies: [{ direction: "in", senderKind: "contact", body: "hola de nuevo" }],
  })
  // Teléfono coincidente en OTRO contacto: nunca entra en el historial.
  const other = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Otra Persona" }),
  )
  const convOther = await insertConv({
    connectionId: waConn2,
    identityId: null,
    thread: "wa:51999000111",
    at: "2026-09-15T10:00:00Z",
    bodies: [{ direction: "in", senderKind: "contact", body: "mensaje de otra persona" }],
    contactId: other.id,
  })

  const first = await withOrgContext(appDb, "org_a", (tx) =>
    listContactChannelHistory(tx, "org_a", {
      contactId: person.id,
      excludeConversationId: convActual,
      limit: 1,
    }),
  )
  expect(first.items).toHaveLength(1)
  expect(first.items[0]).toMatchObject({ conversationId: convWa, channel: "whatsapp" })
  expect(first.items[0]?.messages.map((m) => m.body)).toEqual([
    "quiero mi cita del lunes",
    "quedó para el lunes 9:00",
  ])
  expect(first.nextCursor).not.toBeNull()
  const second = await withOrgContext(appDb, "org_a", (tx) =>
    listContactChannelHistory(tx, "org_a", {
      contactId: person.id,
      excludeConversationId: convActual,
      limit: 1,
      cursor: first.nextCursor ?? "",
    }),
  )
  expect(second.items.map((i) => i.conversationId)).toEqual([convTg])
  // Acotado a 5 mensajes en orden cronológico, sin corte mudo implícito.
  expect(second.items[0]?.messages.map((m) => m.body)).toEqual([
    "mensaje tg 2",
    "mensaje tg 3",
    "mensaje tg 4",
    "mensaje tg 5",
    "mensaje tg 6",
  ])
  expect(second.nextCursor).toBeNull()
  // Sin exclusión: el hilo actual aparece primero por actividad reciente.
  const all = await withOrgContext(appDb, "org_a", (tx) =>
    listContactChannelHistory(tx, "org_a", { contactId: person.id, limit: 10 }),
  )
  expect(all.items.map((i) => i.conversationId)).toEqual([convActual, convWa, convTg])
  expect(all.items.map((i) => i.conversationId)).not.toContain(convOther)
  // Aislamiento por organización.
  const otherOrg = await withOrgContext(appDb, "org_b", (tx) =>
    listContactChannelHistory(tx, "org_b", { contactId: person.id, limit: 10 }),
  )
  expect(otherOrg.items).toHaveLength(0)
  // Reasignar la identidad de WhatsApp a otro contacto mueve el hilo: deja
  // de aparecer para el origen y pasa al destino.
  await withOrgContext(appDb, "org_a", (tx) =>
    moveContactIdentity(tx, "org_a", null, waIdentity.id, {
      fromContactId: person.id,
      toContactId: other.id,
      reason: "Corrige titular",
    }),
  )
  const afterOrigin = await withOrgContext(appDb, "org_a", (tx) =>
    listContactChannelHistory(tx, "org_a", { contactId: person.id, limit: 10 }),
  )
  expect(afterOrigin.items.map((i) => i.conversationId)).not.toContain(convWa)
  const afterDest = await withOrgContext(appDb, "org_a", (tx) =>
    listContactChannelHistory(tx, "org_a", { contactId: other.id, limit: 10 }),
  )
  expect(afterDest.items.map((i) => i.conversationId)).toContain(convWa)
})

it("el detalle dice qué le falta a la paciente para que la Bandeja ofrezca su enlace", async () => {
  const connId = await makeTelegramConnection("org_a")
  const first = await ingest("org_a", connId, textEvent({ externalEventId: "evt-faltan", externalMessageId: "ext-faltan", externalThreadId: "tg:9101", senderExternalId: "tg:9101", senderDisplayName: "Rosa" }))
  const before = await withOrgContext(appDb, "org_a", (tx) => getConversationDetail(tx, "org_a", first.conversationId))
  // Aún no es paciente: no hay ficha que completar.
  expect(before.contact.isPatient).toBe(false)
  expect(before.missingData).toBeNull()

  const [ficha] = await insertTestPatients(ownerDb, { organizationId: "org_a", personId: before.contact.id, displayName: "Rosa", patientNumber: 9101 })
  const after = await withOrgContext(appDb, "org_a", (tx) => getConversationDetail(tx, "org_a", first.conversationId))
  expect(after.contact.isPatient).toBe(true)
  expect(after.missingData?.patientId).toBe(ficha!.id)
  expect(after.missingData?.missing.length).toBeGreaterThan(0)
})
