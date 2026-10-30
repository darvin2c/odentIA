import { telegramBotApiAdapter } from "@odentia/channels"
import { type OutboundMessageJob, withOrgContext } from "@odentia/db"
import { message } from "@odentia/db/schema/crm"
import { closeConversationWith, createConnection, ingestInbound, personalLinkRef, personalLinkToken, sendOutbound } from "@odentia/services"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { consumeOutbound, processOutbound, throttledDelaySeconds, WAITING_DELAY_SECONDS } from "./outbound.js"
import { appDb, KEY, ownerDb, setupTestDb, storageStub, tgConnId } from "./test-setup.js"

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

/** Un mensaje de Sofi en cola para una conversación de WhatsApp con esa dirección. */
async function queuedWhatsApp(address: string): Promise<string> {
  await ownerDb.execute(sql`update channel_connection set status = 'disabled' where organization_id = 'org_a' and channel = 'whatsapp' and status = 'active'`)
  const connection = await withOrgContext(appDb, "org_a", (tx) =>
    createConnection(
      tx,
      "org_a",
      KEY,
      { channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA", config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S" } },
      { fetch, validateExternal: false },
    ),
  )
  const id = `wamid.${Math.random()}`
  const ingested = await withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId: connection.id,
        event: { externalEventId: id, externalMessageId: id, externalThreadId: address, senderExternalId: address, content: { type: "text", text: "Quisiera una cita" }, sentAt: new Date().toISOString() },
      },
      telegramBotApiAdapter,
      { storage: storageStub, fetch, secretsKey: KEY },
    ),
  )
  const sent = await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", { conversationId: ingested.conversationId, senderKind: "agent", content: { type: "text", text: "Tengo estos horarios" } }),
  )
  return sent.id
}

it("a quien oculta su número se le responde por su BSUID (ADR 0110)", async () => {
  const messageId = await queuedWhatsApp("wa:PE.13491208655302741918")
  const seen: unknown[] = []
  const live = {
    ...deps,
    senderMode: "live" as const,
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      seen.push(typeof init?.body === "string" ? JSON.parse(init.body) : null)
      return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT1" }] }), { status: 200 })
    }) as typeof fetch,
  }
  expect(await processOutbound(appDb, live, outJob(messageId))).toBe("done")
  expect(seen[0]).toMatchObject({ recipient: "PE.13491208655302741918", type: "text" })
  expect(seen[0]).not.toHaveProperty("to")
  expect((await messageState(messageId))?.status).toBe("sent")
})

it("lo que Meta rechaza con su error queda como no entregado, con su motivo y sin reenviar", async () => {
  const messageId = await queuedWhatsApp("wa:51911100009")
  let calls = 0
  const rejecting = {
    ...deps,
    senderMode: "live" as const,
    fetch: (async () => {
      calls++
      return new Response(JSON.stringify({ error: { message: "(#131009) Parameter value is not valid", code: 131009 } }), { status: 400 })
    }) as typeof fetch,
  }
  expect(await processOutbound(appDb, rejecting, outJob(messageId))).toBe("done")
  const [row] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ status: message.status, error: message.error }).from(message).where(eq(message.id, messageId)),
  )
  expect(row).toEqual({ status: "failed", error: "WhatsApp send falló: 400 (#131009) Parameter value is not valid" })
  expect(await processOutbound(appDb, rejecting, outJob(messageId, 5))).toBe("done")
  expect(calls).toBe(1)
})

it("un límite de ritmo de Meta deja el mensaje en cola para reintentarlo más tarde; al tope, queda como no entregado", async () => {
  const messageId = await queuedWhatsApp("wa:51911100010")
  let calls = 0
  const throttled = {
    ...deps,
    senderMode: "live" as const,
    fetch: (async () => {
      calls++
      return new Response(JSON.stringify({ error: { message: "(#131056) Pair rate limit hit", code: 131056 } }), { status: 400 })
    }) as typeof fetch,
  }
  expect(await processOutbound(appDb, throttled, outJob(messageId, 1))).toBe("throttled")
  expect((await messageState(messageId))?.status).toBe("queued")
  expect(await processOutbound(appDb, throttled, outJob(messageId, 5))).toBe("done")
  const [row] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ status: message.status, error: message.error }).from(message).where(eq(message.id, messageId)),
  )
  expect(row?.status).toBe("failed")
  expect(row?.error).toContain("demasiados mensajes seguidos a esta persona")
  expect(calls).toBe(2)
  expect([1, 2, 3, 4, 9].map(throttledDelaySeconds)).toEqual([60, 120, 240, 480, 900])
})

/** Otro mensaje de Sofi en cola, en la misma conversación que `messageId`. */
async function queuedAfter(messageId: string, text: string): Promise<string> {
  const [first] = await ownerDb.select({ conversationId: message.conversationId }).from(message).where(eq(message.id, messageId))
  const sent = await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", { conversationId: first!.conversationId, senderKind: "agent", content: { type: "text", text } }),
  )
  return sent.id
}

/** El trabajo de la cola que lleva ese mensaje y cuántos segundos falta para que se vea. */
async function queueJob(messageId: string) {
  const rows = (await ownerDb.execute(
    sql`select msg_id, read_ct, extract(epoch from vt - now())::float as wait from pgmq.q_outbound_messages where message->>'messageId' = ${messageId}`,
  )) as unknown as { msg_id: number; read_ct: number; wait: number }[]
  return rows.map((row) => ({ msgId: Number(row.msg_id), readCt: Number(row.read_ct), wait: Number(row.wait) }))
}

it("los mensajes de una conversación salen en orden: el siguiente espera al que frenó un límite de ritmo", async () => {
  const first = await queuedWhatsApp("wa:51911100011")
  const second = await queuedAfter(first, "Y también este")
  const sentTexts: string[] = []
  const live = (throttle: boolean) => ({
    ...deps,
    senderMode: "live" as const,
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      if (throttle) return new Response(JSON.stringify({ error: { message: "(#131056) Pair rate limit hit", code: 131056 } }), { status: 400 })
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: { body?: string } }) : {}
      sentTexts.push(body.text?.body ?? "")
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${Math.random()}` }] }), { status: 200 })
    }) as typeof fetch,
  })
  expect(await processOutbound(appDb, live(true), outJob(first, 1))).toBe("throttled")
  // El segundo no se adelanta: espera sin llamar al proveedor.
  expect(await processOutbound(appDb, live(false), outJob(second, 1))).toBe("waiting")
  expect(sentTexts).toEqual([])
  expect((await messageState(second))?.status).toBe("queued")
  expect(await processOutbound(appDb, live(false), outJob(first, 2))).toBe("done")
  expect(await processOutbound(appDb, live(false), outJob(second, 2))).toBe("done")
  expect(sentTexts).toEqual(["Tengo estos horarios", "Y también este"])

  // Una respuesta «Por entregar» que se escribió hace horas y recién salió también va primero.
  const held = await queuedAfter(first, "La de antes")
  const next = await queuedAfter(first, "La de ahora")
  await ownerDb.update(message).set({ createdAt: sql`now() - interval '3 hours'` }).where(eq(message.id, held))
  expect(await processOutbound(appDb, live(false), outJob(next))).toBe("waiting")
  expect(await processOutbound(appDb, live(false), outJob(held))).toBe("done")
  expect(await processOutbound(appDb, live(false), outJob(next))).toBe("done")
  expect(sentTexts.slice(-2)).toEqual(["La de antes", "La de ahora"])

  // Uno que quedó en cola sin su trabajo nunca saldrá: no frena la conversación.
  const stuck = await queuedAfter(first, "Trabado")
  const after = await queuedAfter(first, "Después")
  await ownerDb.execute(sql`delete from pgmq.q_outbound_messages where message->>'messageId' = ${stuck}`)
  expect(await processOutbound(appDb, live(false), outJob(after))).toBe("done")
  expect(sentTexts.at(-1)).toBe("Después")
})

it("la cola espera lo que corresponde: el frenado, 1 minuto la primera vez; el que espera a otro vuelve a los 30 segundos sin gastar sus entregas", async () => {
  const first = await queuedWhatsApp("wa:51911100012")
  const second = await queuedAfter(first, "Y también este")
  const throttled = {
    ...deps,
    senderMode: "live" as const,
    fetch: (async () => new Response(JSON.stringify({ error: { message: "(#131056) Pair rate limit hit", code: 131056 } }), { status: 400 })) as typeof fetch,
  }
  const [firstJob] = await queueJob(first)
  await consumeOutbound(appDb, throttled, { msg_id: firstJob!.msgId, read_ct: 1, message: { orgId: "org_a", messageId: first } })
  const [firstAfter] = await queueJob(first)
  expect(firstAfter?.msgId).toBe(firstJob!.msgId)
  expect(firstAfter?.wait).toBeGreaterThan(55)
  expect(firstAfter?.wait).toBeLessThanOrEqual(60)

  const [secondJob] = await queueJob(second)
  await consumeOutbound(appDb, throttled, { msg_id: secondJob!.msgId, read_ct: 4, message: { orgId: "org_a", messageId: second } })
  const secondAfter = await queueJob(second)
  expect(secondAfter).toHaveLength(1)
  expect(secondAfter[0]?.msgId).not.toBe(secondJob!.msgId)
  expect(secondAfter[0]?.readCt).toBe(0)
  expect(secondAfter[0]?.wait).toBeGreaterThan(WAITING_DELAY_SECONDS - 5)
  expect(secondAfter[0]?.wait).toBeLessThanOrEqual(WAITING_DELAY_SECONDS)
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
