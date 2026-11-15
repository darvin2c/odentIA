process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createHmac } from "node:crypto"
import { createOwnerDb, type Db } from "@odentia/db"
import { saasChat, saasInboundMessage, saasOutreach } from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import {
  type AdminChannels,
  markChatOutreachUncertain,
  prepareChatReply,
  type Storage,
} from "@odentia/services"
import { and, eq } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAdminMetaWebhookRoute } from "./admin-meta-webhook.js"

/**
 * La dirección de Meta de la administración contra Postgres real: el reto con
 * su token, 404 sin canales, 401 con la firma de la app de las clínicas; un
 * mensaje de WhatsApp entra una vez aunque Meta lo repita, sus archivos se
 * guardan por sus bytes, Messenger e Instagram entran por su página y su
 * cuenta (sin ecos), y un estado `delivered` resuelve un envío incierto.
 */

const IMAGE = "dentalagent-postgres:18.6"
const BASE = "/api/webhooks/meta/admin"
const SECRET = "secreto-de-la-app-de-sallca"
const CLINICS_SECRET = "secreto-de-la-app-de-las-clinicas"
const PHONE_ID = "1111111111"
const PAGE_ID = "2222222222"
const IG_ID = "3333333333"
const ADMIN = "meta-admin"

const channels: AdminChannels = {
  appSecret: SECRET,
  verifyToken: "token-del-reto",
  whatsapp: { phoneNumberId: PHONE_ID, accessToken: "wa-token" },
  messenger: { pageId: PAGE_ID, accessToken: "page-token" },
  instagram: { accountId: IG_ID, pageId: PAGE_ID, accessToken: "page-token" },
}

let container: StartedTestContainer
let ownerDb: Db
let app: Hono
let off: Hono

const objects = new Map<string, Uint8Array>()
const storage: Pick<Storage, "putAttachmentAt" | "deleteAttachment"> = {
  putAttachmentAt: async (key, bytes) => {
    objects.set(key, bytes)
  },
  deleteAttachment: async (key) => {
    objects.delete(key)
  },
}

const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n")
const fetchCalls: string[] = []

/** Graph de prueba: la URL de un archivo, sus bytes y el perfil de quien escribe. */
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input)
  fetchCalls.push(url)
  if (url.includes("/media-pdf"))
    return Response.json({ url: "https://lookaside.test/pdf", mime_type: "application/pdf" })
  if (url.includes("/media-exe"))
    return Response.json({ url: "https://lookaside.test/exe", mime_type: "application/pdf" })
  if (url === "https://lookaside.test/pdf")
    return new Response(PDF, { headers: { "content-type": "application/pdf" } })
  if (url === "https://lookaside.test/exe")
    return new Response(new TextEncoder().encode("MZ\x90ejecutable"))
  if (url.startsWith("https://scontent.xx.fbcdn.net/") || url.startsWith("https://evil.test/"))
    return new Response(PDF, { headers: { "content-type": "application/pdf" } })
  if (url.includes("?fields=name,username"))
    return Response.json({ username: "clinica.sonrisa", name: "Clínica" })
  if (url.includes("?fields=name")) return Response.json({ name: "Rosa Quispe" })
  return new Response("{}", { status: 404 })
}) as typeof fetch

function sign(raw: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`
}

function post(body: unknown, opts: { secret?: string; target?: Hono } = {}) {
  const raw = JSON.stringify(body)
  return (opts.target ?? app).request(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, opts.secret) },
    body: raw,
  })
}

function whatsapp(value: Record<string, unknown>, phoneNumberId = PHONE_ID) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  }
}

function waText(id: string, from: string, body: string) {
  return whatsapp({
    contacts: [{ profile: { name: "Luis Paredes" }, wa_id: from }],
    messages: [
      { id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } },
    ],
  })
}

function messaging(object: "page" | "instagram", entryId: string, events: unknown[]) {
  return { object, entry: [{ id: entryId, time: Date.now(), messaging: events }] }
}

async function messagesOf(externalId: string) {
  return ownerDb
    .select()
    .from(saasInboundMessage)
    .where(eq(saasInboundMessage.externalId, externalId))
}

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: "dentalagent_app",
    })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_cron",
      "-c",
      "cron.database_name=dentalagent",
    ])
    .start()
  const url = `${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${url}`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  await ownerDb
    .insert(user)
    .values({ id: ADMIN, name: "Ana Admin", email: "ana@sallca.test", emailVerified: true })
  await ownerDb.insert(adminStaff).values({ userId: ADMIN, role: "admin" })
  app = new Hono().route(
    BASE,
    createAdminMetaWebhookRoute({ ownerDb, storage, channels, fetch: fakeFetch }),
  )
  off = new Hono().route(BASE, createAdminMetaWebhookRoute({ ownerDb, storage, fetch: fakeFetch }))
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

describe("la dirección", () => {
  it("el reto responde con el token de la administración y no con otro", async () => {
    const ok = await app.request(
      `${BASE}?hub.mode=subscribe&hub.verify_token=token-del-reto&hub.challenge=123`,
    )
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe("123")
    const bad = await app.request(
      `${BASE}?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=123`,
    )
    expect(bad.status).toBe(403)
  })

  it("sin canales configurados no existe: 404", async () => {
    expect(
      (await off.request(`${BASE}?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`)).status,
    ).toBe(404)
    expect((await post(waText("wamid.off", "51911111111", "Hola"), { target: off })).status).toBe(
      404,
    )
  })

  it("firmado con la app de las clínicas: 401 y no entra", async () => {
    const response = await post(waText("wamid.ajena", "51911111111", "Hola"), {
      secret: CLINICS_SECRET,
    })
    expect(response.status).toBe(401)
    expect(await messagesOf("wamid.ajena")).toHaveLength(0)
  })
})

describe("WhatsApp", () => {
  it("un texto entra una vez aunque Meta lo repita, en una conversación sin cliente", async () => {
    const body = waText("wamid.texto", "51987654321", "Hola, quiero una demo")
    expect((await post(body)).status).toBe(200)
    expect((await post(body)).status).toBe(200)
    const rows = await messagesOf("wamid.texto")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toBe("Hola, quiero una demo")
    const [chat] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, rows[0]!.chatId))
    expect(chat).toMatchObject({
      channel: "whatsapp",
      address: "+51987654321",
      clientId: null,
      displayName: "Luis Paredes",
    })
  })

  it("lo de otro número se ignora con 200", async () => {
    const response = await post(
      whatsapp(
        {
          messages: [
            {
              id: "wamid.otro",
              from: "51900000000",
              timestamp: "1",
              type: "text",
              text: { body: "x" },
            },
          ],
        },
        "9999999999",
      ),
    )
    expect(response.status).toBe(200)
    expect(await messagesOf("wamid.otro")).toHaveLength(0)
  })

  it("el documento se guarda con su nombre; lo que no es un tipo permitido, no", async () => {
    const at = String(Math.floor(Date.now() / 1000))
    await post(
      whatsapp({
        messages: [
          {
            id: "wamid.pdf",
            from: "51987654321",
            timestamp: at,
            type: "document",
            document: {
              id: "media-pdf",
              mime_type: "application/pdf",
              filename: "pacientes.pdf",
              caption: "Los pacientes",
            },
          },
          {
            id: "wamid.exe",
            from: "51987654321",
            timestamp: at,
            type: "document",
            document: { id: "media-exe", mime_type: "application/pdf", filename: "virus.pdf" },
          },
        ],
      }),
    )
    const [pdf] = await messagesOf("wamid.pdf")
    expect(pdf?.body).toBe("Los pacientes")
    expect(pdf?.media).toHaveLength(1)
    const media = pdf!.media[0]!
    expect(media).toMatchObject({
      filename: "pacientes.pdf",
      mimeType: "application/pdf",
      size: PDF.byteLength,
    })
    expect(objects.get(media.objectKey!)).toEqual(PDF)
    const [exe] = await messagesOf("wamid.exe")
    expect(exe?.media).toEqual([])
    // Solo quedó en el almacenamiento el PDF.
    expect([...objects.keys()].filter((key) => key.startsWith("inbound/"))).toEqual([
      media.objectKey,
    ])
  })

  it("un estado delivered con el id del envío resuelve uno incierto", async () => {
    const [chat] = await ownerDb
      .select()
      .from(saasChat)
      .where(and(eq(saasChat.channel, "whatsapp"), eq(saasChat.address, "+51987654321")))
    const outreachId = await ownerDb.transaction(async (tx) => {
      const reply = await prepareChatReply(tx as Db, { userId: ADMIN, role: "admin" }, chat!.id, {
        body: "Claro",
      })
      await markChatOutreachUncertain(tx as Db, reply.outreachId)
      return reply.outreachId
    })
    const response = await post(
      whatsapp({
        statuses: [
          {
            id: "wamid.respuesta",
            status: "delivered",
            timestamp: "1",
            recipient_id: "51987654321",
            biz_opaque_callback_data: outreachId,
          },
        ],
      }),
    )
    expect(response.status).toBe(200)
    const [row] = await ownerDb.select().from(saasOutreach).where(eq(saasOutreach.id, outreachId))
    expect(row).toMatchObject({ status: "enviado", externalId: "wamid.respuesta" })
  })
})

describe("Messenger e Instagram", () => {
  it("Messenger: entra lo de la persona con su nombre y su archivo; el eco no", async () => {
    const response = await post(
      messaging("page", PAGE_ID, [
        {
          sender: { id: "psid-1" },
          recipient: { id: PAGE_ID },
          timestamp: Date.now(),
          message: { mid: "m_texto", text: "Hola" },
        },
        {
          sender: { id: "psid-1" },
          recipient: { id: PAGE_ID },
          timestamp: Date.now(),
          message: {
            mid: "m_archivo",
            attachments: [
              { type: "file", payload: { url: "https://scontent.xx.fbcdn.net/v/lista.pdf?oh=1" } },
            ],
          },
        },
        {
          sender: { id: PAGE_ID },
          recipient: { id: "psid-1" },
          timestamp: Date.now(),
          message: { mid: "m_eco", text: "Respuesta", is_echo: true },
        },
      ]),
    )
    expect(response.status).toBe(200)
    const [texto] = await messagesOf("m_texto")
    expect(texto?.body).toBe("Hola")
    const [chat] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, texto!.chatId))
    expect(chat).toMatchObject({
      channel: "messenger",
      address: "psid-1",
      displayName: "Rosa Quispe",
    })
    const [archivo] = await messagesOf("m_archivo")
    expect(archivo?.media).toHaveLength(1)
    expect(archivo?.media[0]).toMatchObject({ mimeType: "application/pdf", filename: "lista.pdf" })
    expect(await messagesOf("m_eco")).toHaveLength(0)
  })

  it("Messenger: lo de otra página se ignora", async () => {
    await post(
      messaging("page", "otra-pagina", [
        {
          sender: { id: "psid-2" },
          recipient: { id: "otra-pagina" },
          timestamp: Date.now(),
          message: { mid: "m_otra", text: "x" },
        },
      ]),
    )
    expect(await messagesOf("m_otra")).toHaveLength(0)
  })

  it("Instagram: entra por la cuenta de Sallca con el @usuario", async () => {
    const response = await post(
      messaging("instagram", IG_ID, [
        {
          sender: { id: "igsid-1" },
          recipient: { id: IG_ID },
          timestamp: Date.now(),
          message: { mid: "ig_texto", text: "Info" },
        },
        {
          sender: { id: IG_ID },
          recipient: { id: "igsid-1" },
          timestamp: Date.now(),
          message: { mid: "ig_eco", text: "Hola", is_echo: true },
        },
      ]),
    )
    expect(response.status).toBe(200)
    const [row] = await messagesOf("ig_texto")
    const [chat] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, row!.chatId))
    expect(chat).toMatchObject({
      channel: "instagram",
      address: "igsid-1",
      displayName: "@clinica.sonrisa",
    })
    expect(await messagesOf("ig_eco")).toHaveLength(0)
  })
})

describe("lo que no se pudo guardar se vuelve a pedir", () => {
  it("si un mensaje no se guarda, los demás entran y la respuesta es 500; el reintento no duplica", async () => {
    const failing: Pick<Storage, "putAttachmentAt" | "deleteAttachment"> = {
      putAttachmentAt: async () => {
        throw new Error("R2 no respondió")
      },
      deleteAttachment: async () => {},
    }
    const flaky = new Hono().route(
      BASE,
      createAdminMetaWebhookRoute({ ownerDb, storage: failing, channels, fetch: fakeFetch }),
    )
    const at = String(Math.floor(Date.now() / 1000))
    const body = whatsapp({
      messages: [
        {
          id: "wamid.r-pdf",
          from: "51987650001",
          timestamp: at,
          type: "document",
          document: { id: "media-pdf", mime_type: "application/pdf", filename: "lista.pdf" },
        },
        {
          id: "wamid.r-texto",
          from: "51987650001",
          timestamp: at,
          type: "text",
          text: { body: "Hola" },
        },
      ],
    })
    expect((await post(body, { target: flaky })).status).toBe(500)
    expect(await messagesOf("wamid.r-texto")).toHaveLength(1)
    expect(await messagesOf("wamid.r-pdf")).toHaveLength(0)
    // Meta lo vuelve a mandar: entra lo que faltaba, sin repetir lo que ya entró.
    expect((await post(body)).status).toBe(200)
    expect(await messagesOf("wamid.r-texto")).toHaveLength(1)
    const [pdf] = await messagesOf("wamid.r-pdf")
    expect(pdf?.media).toHaveLength(1)
  })

  it("si la base falla, 500 también para los estados; lo que se ignora sigue con 200", async () => {
    const broken = new Proxy(ownerDb, {
      get(target, prop, receiver) {
        if (prop === "transaction") return () => Promise.reject(new Error("la base se cayó"))
        return Reflect.get(target, prop, receiver)
      },
    }) as Db
    const down = new Hono().route(
      BASE,
      createAdminMetaWebhookRoute({ ownerDb: broken, storage, channels, fetch: fakeFetch }),
    )
    expect(
      (await post(waText("wamid.caida", "51987650002", "Hola"), { target: down })).status,
    ).toBe(500)
    expect(await messagesOf("wamid.caida")).toHaveLength(0)
    const status = whatsapp({
      statuses: [
        { id: "wamid.x", status: "delivered", timestamp: "1", recipient_id: "51987650002" },
      ],
    })
    expect((await post(status, { target: down })).status).toBe(500)
    const ignored = whatsapp(
      {
        messages: [
          {
            id: "wamid.ajeno2",
            from: "51900000000",
            timestamp: "1",
            type: "text",
            text: { body: "x" },
          },
        ],
      },
      "9999999999",
    )
    expect((await post(ignored, { target: down })).status).toBe(200)
  })

  it("un mensaje que no es válido no pide reenviarlo: 200 y no entra", async () => {
    const id = `wamid.${"x".repeat(300)}`
    expect((await post(waText(id, "51987650003", "Hola"))).status).toBe(200)
    expect(await messagesOf(id)).toHaveLength(0)
  })

  it("un archivo de Messenger fuera de los servidores de Meta no se baja", async () => {
    const before = fetchCalls.length
    const response = await post(
      messaging("page", PAGE_ID, [
        {
          sender: { id: "psid-ssrf" },
          recipient: { id: PAGE_ID },
          timestamp: Date.now(),
          message: {
            mid: "m_ssrf",
            attachments: [{ type: "file", payload: { url: "https://evil.test/lista.pdf" } }],
          },
        },
      ]),
    )
    expect(response.status).toBe(200)
    const [row] = await messagesOf("m_ssrf")
    expect(row?.media).toEqual([])
    expect(fetchCalls.slice(before).some((url) => url.startsWith("https://evil.test/"))).toBe(false)
  })
})
