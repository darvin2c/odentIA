import { telegramBotApiAdapter } from "@odentia/channels"
import { type OutboundMessageJob, withOrgContext } from "@odentia/db"
import { message } from "@odentia/db/schema/crm"
import { closeConversationWith, createConnection, ingestInbound, personalLinkRef, personalLinkToken, sendOutbound } from "@odentia/services"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { processOutbound } from "./outbound.js"
import { appDb, KEY, setupTestDb, storageStub, tgConnId } from "./test-setup.js"

setupTestDb()

const deps = { storage: storageStub, fetch, secretsKey: KEY, senderMode: "mock" as const }

async function seedQueuedText(): Promise<{ conversationId: string; messageId: string }> {
  const depsIngest = { storage: storageStub, fetch, secretsKey: KEY }
  const ingested = await withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId: tgConnId,
        event: {
          externalEventId: `evt-ob-${Math.random()}`,
          externalMessageId: `ext-ob-${Math.random()}`,
          externalThreadId: `tg:ob-${Math.random()}`,
          senderExternalId: "tg:777",
          senderDisplayName: "Beto",
          content: { type: "text", text: "Hola" },
          sentAt: new Date().toISOString(),
        },
      },
      telegramBotApiAdapter,
      depsIngest,
    ),
  )
  const sent = await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", {
      conversationId: ingested.conversationId,
      senderKind: "agent",
      content: { type: "text", text: "Respuesta" },
    }),
  )
  return { conversationId: ingested.conversationId, messageId: sent.id }
}

function outJob(messageId: string, readCt = 0) {
  const message: OutboundMessageJob = { orgId: "org_a", messageId }
  return { msg_id: 1, read_ct: readCt, message }
}

async function messageState(id: string) {
  const [row] = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ status: message.status, externalId: message.externalId })
      .from(message)
      .where(eq(message.id, id)),
  )
  return row
}

it("mock envía sin HTTP y marca sent con externalId", async () => {
  const { messageId } = await seedQueuedText()
  expect(await processOutbound(appDb, deps, outJob(messageId))).toBe("done")
  const state = await messageState(messageId)
  expect(state?.status).toBe("sent")
  expect(state?.externalId?.startsWith("mock-")).toBe(true)
})

it("lo que quedó en cola sale aunque la conversación ya se cerró: la despedida no se pierde", async () => {
  const { conversationId, messageId } = await seedQueuedText()
  await withOrgContext(appDb, "org_a", (tx) => closeConversationWith(tx, "org_a", conversationId, { reason: "resuelta", byUserId: null }))
  expect(await processOutbound(appDb, deps, outJob(messageId))).toBe("done")
  expect((await messageState(messageId))?.status).toBe("sent")
})

it("mensaje ya enviado hace ack sin reenviar", async () => {
  const { messageId } = await seedQueuedText()
  await processOutbound(appDb, deps, outJob(messageId))
  const before = await messageState(messageId)
  expect(await processOutbound(appDb, deps, outJob(messageId))).toBe("done")
  expect(await messageState(messageId)).toEqual(before)
})

it("fallo ambiguo live no reintenta ni duplica el envío", async () => {
  const { messageId } = await seedQueuedText()
  let calls = 0
  const liveFail = {
    ...deps,
    senderMode: "live" as const,
    fetch: (async () => {
      calls++
      throw new Error("red caída tras despachar")
    }) as typeof fetch,
  }
  expect(await processOutbound(appDb, liveFail, outJob(messageId, 0))).toBe("done")
  expect((await messageState(messageId))?.status).toBe("unknown")
  expect(await processOutbound(appDb, liveFail, outJob(messageId, 5))).toBe("done")
  expect(calls).toBe(1)
  expect((await messageState(messageId))?.status).toBe("unknown")
})

it("live con stub de proveedor marca sent", async () => {
  const { messageId } = await seedQueuedText()
  const liveOk = {
    ...deps,
    senderMode: "live" as const,
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {}
      if (typeof body.text !== "string") throw new Error("body inesperado")
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
        status: 200,
      })
    }) as typeof fetch,
  }
  expect(await processOutbound(appDb, liveOk, outJob(messageId))).toBe("done")
  const state = await messageState(messageId)
  expect(state?.status).toBe("sent")
  expect(state?.externalId?.startsWith("tg:")).toBe(true)
})

it("plantilla persiste invocación y el worker la reenvía", async () => {
  const waConn = await withOrgContext(appDb, "org_a", (tx) =>
    createConnection(
      tx,
      "org_a",
      KEY,
      {
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA",
        config: {
          phoneNumberId: "P",
          wabaId: "W",
          accessToken: "T",
          appSecret: "S",
          templates: [{ name: "t1", language: "es_PE" }],
        },
      },
      { fetch, validateExternal: false },
    ),
  )
  const ingested = await withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId: waConn.id,
        event: {
          externalEventId: "evt-tpl",
          externalMessageId: "wamid.tpl",
          externalThreadId: "wa:519",
          senderExternalId: "wa:519",
          content: { type: "text", text: "Hola" },
          sentAt: new Date().toISOString(),
        },
      },
      telegramBotApiAdapter,
      { storage: storageStub, fetch, secretsKey: KEY },
    ),
  )
  const tpl = await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", {
      conversationId: ingested.conversationId,
      senderKind: "agent",
      content: { type: "template", name: "t1", language: "es_PE", params: ["Ana"] },
    }),
  )
  expect(tpl.templateName).toBe("t1")
  const seen: unknown[] = []
  const liveTpl = {
    ...deps,
    senderMode: "live" as const,
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      seen.push(typeof init?.body === "string" ? JSON.parse(init.body) : null)
      return new Response(JSON.stringify({ messages: [{ id: "wamid.TPL1" }] }), { status: 200 })
    }) as typeof fetch,
  }
  expect(await processOutbound(appDb, liveTpl, outJob(tpl.id))).toBe("done")
  expect(seen[0]).toMatchObject({ type: "template", template: { name: "t1" } })
})

it("media sale con link firmado y caption vía sendPhoto", async () => {
  const ingested = await withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId: tgConnId,
        event: {
          externalEventId: `evt-obm-${Math.random()}`,
          externalMessageId: `ext-obm-${Math.random()}`,
          externalThreadId: `tg:obm-${Math.random()}`,
          senderExternalId: "tg:777",
          senderDisplayName: "Beto",
          content: { type: "text", text: "Hola" },
          sentAt: new Date().toISOString(),
        },
      },
      telegramBotApiAdapter,
      { storage: storageStub, fetch, secretsKey: KEY },
    ),
  )
  const sent = await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", {
      conversationId: ingested.conversationId,
      senderKind: "user",
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
  const seen: { url: string; body: unknown }[] = []
  const liveMedia = {
    ...deps,
    senderMode: "live" as const,
    fetch: (async (url: unknown, init?: { body?: unknown }) => {
      seen.push({
        url: String(url),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      })
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), {
        status: 200,
      })
    }) as typeof fetch,
  }
  expect(await processOutbound(appDb, liveMedia, outJob(sent.id))).toBe("done")
  expect(seen[0]?.url).toContain("/sendPhoto")
  expect(seen[0]?.body).toMatchObject({
    photo: "https://signed.example.com/org_a/conv/foto.png",
    caption: "Mira esto",
  })
  expect((await messageState(sent.id))?.status).toBe("sent")
})

it("«Su enlace» se guarda como referencia y sale con su token: el token solo existe al entregarlo", async () => {
  const { messageId } = await seedQueuedText()
  const linkId = "6f1c2c1e-1d2a-4c3b-9a8e-0b1c2d3e4f50"
  await withOrgContext(appDb, "org_a", (tx) =>
    tx.update(message).set({ body: `Mira aquí: https://norte.test/reserva?token=${personalLinkRef(linkId)}` }).where(eq(message.id, messageId)),
  )
  let delivered = ""
  const live = {
    ...deps,
    senderMode: "live" as const,
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {}
      delivered = body.text ?? ""
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), { status: 200 })
    }) as typeof fetch,
  }
  expect(await processOutbound(appDb, live, outJob(messageId))).toBe("done")
  expect(delivered).toBe(`Mira aquí: https://norte.test/reserva?token=${personalLinkToken(KEY, linkId)}`)
  const [stored] = await withOrgContext(appDb, "org_a", (tx) => tx.select({ body: message.body }).from(message).where(eq(message.id, messageId)))
  expect(stored?.body).not.toMatch(/[0-9a-f]{64}/)
})
