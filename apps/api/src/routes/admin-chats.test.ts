process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createOwnerDb, type Db } from "@odentia/db"
import { saasChat, saasClient, saasClientContact, saasOutreach } from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { type AdminActor, type AdminChannels, ingestInboundChat } from "@odentia/services"
import { eq } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAdminChatsRoute } from "./admin-chats.js"
import { createAdminKairosRoute } from "./admin-kairos.js"

/**
 * Responder desde el ARM contra Postgres real y un Graph de prueba: lo que Meta
 * acepta queda enviado con su `wamid`, lo que rechaza no salió, un corte queda
 * incierto (502) y no se repite; fuera de las 24 h, 409; Soporte no ve lo
 * comercial (404) y la plantilla solo existe en WhatsApp.
 */

const IMAGE = "dentalagent-postgres:18.6"
const BASE = "/api/admin/chats"
const ADMIN = "chats-admin"
const SUPPORT = "chats-soporte"
const DAY = 86_400_000

const channels: AdminChannels = {
  appSecret: "secreto",
  verifyToken: "reto",
  whatsapp: { phoneNumberId: "1111111111", accessToken: "wa-token" },
  messenger: { pageId: "2222222222", accessToken: "page-token" },
  instagram: { accountId: "3333333333", pageId: "2222222222", accessToken: "page-token" },
}

let container: StartedTestContainer
let ownerDb: Db
let app: Hono<{ Variables: { adminActor: AdminActor } }>

let mode: "ok" | "reject" | "throw" = "ok"
const calls: { url: string; body: Record<string, unknown> }[] = []
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) })
  if (mode === "throw") throw new TypeError("fetch failed")
  if (mode === "reject")
    return Response.json({ error: { code: 100, message: "Invalid parameter" } }, { status: 400 })
  return Response.json({
    messages: [{ id: `wamid.${calls.length}` }],
    message_id: `mid.${calls.length}`,
  })
}) as typeof fetch

function call(method: string, path: string, who: string, body?: unknown) {
  const headers = new Headers({ "x-test-user": who })
  if (body !== undefined) headers.set("content-type", "application/json")
  return app.request(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function expectStatus(response: Response, status: number) {
  if (response.status !== status)
    expect(`${response.status} ${await response.clone().text()}`).toBe(String(status))
}

// biome-ignore lint/suspicious/noExplicitAny: los cuerpos de la prueba se leen sin tipo
async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}

let seq = 0
/** Una conversación con un mensaje que llegó `ago` ms atrás. */
async function chatWith(
  channel: "whatsapp" | "instagram" | "messenger",
  address: string,
  ago = 60_000,
) {
  seq += 1
  const result = await ownerDb.transaction((tx) =>
    ingestInboundChat(tx as Db, {
      channel,
      address,
      externalId: `entrada-${seq}`,
      body: "Hola",
      receivedAt: new Date(Date.now() - ago),
    }),
  )
  return result.chatId
}

async function outreach(id: string) {
  const [row] = await ownerDb.select().from(saasOutreach).where(eq(saasOutreach.id, id))
  return row
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
  for (const [id, role, name] of [
    [ADMIN, "admin", "Ana Admin"],
    [SUPPORT, "support", "Sara Soporte"],
  ] as const) {
    await ownerDb.insert(user).values({ id, name, email: `${id}@sallca.test`, emailVerified: true })
    await ownerDb.insert(adminStaff).values({ userId: id, role })
  }
  app = new Hono<{ Variables: { adminActor: AdminActor } }>()
  // En app.ts lo pone `requireAdminContext`.
  app.use("*", async (c, next) => {
    const id = c.req.header("x-test-user") ?? ""
    c.set("adminActor", { userId: id, role: id === ADMIN ? "admin" : "support" })
    await next()
  })
  app.route(BASE, createAdminChatsRoute({ ownerDb, channels, fetch: fakeFetch }))
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

describe("responder", () => {
  it("acepta decir que se quitó «Solo administración» a propósito (`adminOnlyOverride`, ADR 0191)", async () => {
    mode = "ok"
    const chatId = await chatWith("whatsapp", "+51911000091")
    const response = await call("POST", `/${chatId}/reply`, ADMIN, {
      body: "Hola",
      adminOnly: false,
      adminOnlyOverride: true,
    })
    await expectStatus(response, 201)
    await expectStatus(
      await call("POST", `/${chatId}/reply`, ADMIN, { body: "Hola", adminOnlyOverride: "sí" }),
      400,
    )
  })

  it("Meta lo acepta: enviado con su wamid, el id del envío como callback y el número sin «+»", async () => {
    mode = "ok"
    const chatId = await chatWith("whatsapp", "+51911000001")
    const response = await call("POST", `/${chatId}/reply`, ADMIN, { body: "Claro, le cuento" })
    await expectStatus(response, 201)
    const { data } = await json(response)
    expect(data.status).toBe("enviado")
    const sent = calls.at(-1)!
    expect(sent.url).toContain("/1111111111/messages")
    expect(sent.body).toMatchObject({
      to: "51911000001",
      type: "text",
      biz_opaque_callback_data: data.outreachId,
      text: { body: "Claro, le cuento\n\n— Ana · odentIA" },
    })
    expect(await outreach(data.outreachId)).toMatchObject({
      status: "enviado",
      externalId: `wamid.${calls.length}`,
    })
  })

  it("Meta lo rechaza (4xx): no salió, con el motivo", async () => {
    mode = "reject"
    const chatId = await chatWith("whatsapp", "+51911000002")
    const response = await call("POST", `/${chatId}/reply`, ADMIN, { body: "Hola" })
    await expectStatus(response, 502)
    const { error } = await json(response)
    expect(error.code).toBe("SEND_REJECTED")
    expect((await outreach(error.outreachId))?.status).toBe("no_salio")
  })

  it("un corte: incierto, 502 SEND_UNKNOWN y nunca un segundo intento", async () => {
    mode = "throw"
    const chatId = await chatWith("whatsapp", "+51911000003")
    const before = calls.length
    const response = await call("POST", `/${chatId}/reply`, ADMIN, { body: "Hola" })
    await expectStatus(response, 502)
    const { error } = await json(response)
    expect(error.code).toBe("SEND_UNKNOWN")
    expect(calls.length).toBe(before + 1)
    expect((await outreach(error.outreachId))?.status).toBe("incierto")
    mode = "ok"
  })

  it("fuera de las 24 h: 409 sin reservar ni llamar a Meta; la plantilla sí sale", async () => {
    mode = "ok"
    const chatId = await chatWith("whatsapp", "+51911000004", 2 * DAY)
    const before = calls.length
    const response = await call("POST", `/${chatId}/reply`, ADMIN, { body: "Hola" })
    await expectStatus(response, 409)
    expect((await json(response)).error.code).toBe("CHAT_WINDOW_CLOSED")
    expect(calls.length).toBe(before)
    const rows = await ownerDb.select().from(saasOutreach).where(eq(saasOutreach.chatId, chatId))
    expect(rows).toHaveLength(0)

    const retomar = await call("POST", `/${chatId}/retomar`, ADMIN)
    await expectStatus(retomar, 201)
    expect(calls.at(-1)?.body).toMatchObject({
      type: "template",
      template: {
        name: "retomar_conversacion",
        language: { code: "es" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }],
      },
    })
  })

  it("Instagram y Messenger salen por la página; retomar en Instagram es 400", async () => {
    mode = "ok"
    const ig = await chatWith("instagram", "igsid-77")
    const response = await call("POST", `/${ig}/reply`, ADMIN, { body: "Hola" })
    await expectStatus(response, 201)
    expect(calls.at(-1)?.url).toContain("graph.facebook.com")
    expect(calls.at(-1)?.url).toContain("/2222222222/messages")
    expect(calls.at(-1)?.body).toMatchObject({ recipient: { id: "igsid-77" } })
    const retomar = await call("POST", `/${ig}/retomar`, ADMIN)
    await expectStatus(retomar, 400)
    expect((await json(retomar)).error.fields).toHaveProperty("template")

    const msgr = await chatWith("messenger", "psid-77")
    await expectStatus(await call("POST", `/${msgr}/reply`, ADMIN, { body: "Hola" }), 201)
    expect(calls.at(-1)?.body).toMatchObject({
      recipient: { id: "psid-77" },
      messaging_type: "RESPONSE",
    })
  })
})

describe("quién ve qué", () => {
  it("Soporte no ve una conversación de venta: 404 al leerla y al responderla", async () => {
    const chatId = await chatWith("whatsapp", "+51911000005")
    await expectStatus(await call("GET", `/${chatId}`, SUPPORT), 404)
    await expectStatus(await call("POST", `/${chatId}/reply`, SUPPORT, { body: "Hola" }), 404)
    await expectStatus(await call("GET", `/${chatId}`, ADMIN), 200)
  })

  it("«No es una clínica» y deshacerlo: solo Administración", async () => {
    const chatId = await chatWith("whatsapp", "+51911000006")
    await expectStatus(await call("POST", `/${chatId}/not-clinic`, SUPPORT), 403)
    await expectStatus(await call("POST", `/${chatId}/not-clinic`, ADMIN), 200)
    const [marked] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chatId))
    expect(marked?.notClinicAt).not.toBeNull()
    await expectStatus(await call("DELETE", `/${chatId}/not-clinic`, ADMIN), 200)
    const [undone] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chatId))
    expect(undone?.notClinicAt).toBeNull()
  })

  it("la configuración dice qué canales están", async () => {
    const response = await call("GET", "/config", SUPPORT)
    await expectStatus(response, 200)
    expect((await json(response)).data).toEqual({
      whatsapp: true,
      instagram: true,
      messenger: true,
    })
  })
})

describe("escribir por WhatsApp desde la ficha", () => {
  it("abre (o crea) la conversación del celular del contacto, ligada a su cliente", async () => {
    const [client] = await ownerDb
      .insert(saasClient)
      .values({ name: "Clínica Abrir (ficticia)", product: "dental" })
      .returning({ id: saasClient.id })
    const [contact] = await ownerDb
      .insert(saasClientContact)
      .values({ clientId: client!.id, name: "Rosa Quispe", phone: "+51911000007", isPrimary: true })
      .returning({ id: saasClientContact.id })
    const body = { clientId: client!.id, contactId: contact!.id, channel: "whatsapp" }
    const first = await call("POST", "/open", ADMIN, body)
    await expectStatus(first, 200)
    const opened = (await json(first)).data
    expect(opened).toMatchObject({
      created: true,
      channel: "whatsapp",
      address: "+51911000007",
      canReplyFreely: false,
    })
    expect(opened.client?.id).toBe(client!.id)
    const again = await call("POST", "/open", ADMIN, body)
    expect((await json(again)).data).toMatchObject({ id: opened.id, created: false })
    // Sin cuenta, la ficha es comercial: Soporte no la ve.
    await expectStatus(await call("POST", "/open", SUPPORT, body), 404)
  })

  it("si ese celular ya escribió sin decir de quién es, 409 con su conversación y no la liga", async () => {
    const [client] = await ownerDb
      .insert(saasClient)
      .values({ name: "Clínica Celular (ficticia)", product: "dental" })
      .returning({ id: saasClient.id })
    const [contact] = await ownerDb
      .insert(saasClientContact)
      .values({ clientId: client!.id, name: "Rosa Celular", phone: "+51911000008" })
      .returning({ id: saasClientContact.id })
    const chatId = await chatWith("whatsapp", "+51911000008")
    const res = await call("POST", "/open", ADMIN, {
      clientId: client!.id,
      contactId: contact!.id,
      channel: "whatsapp",
    })
    await expectStatus(res, 409)
    expect(await json(res)).toMatchObject({
      error: {
        code: "CHAT_UNASSIGNED",
        message: "Ese celular ya nos escribió y falta decir de quién es. Dilo primero en Hoy.",
        fields: { chatId },
      },
    })
    const [chat] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chatId))
    expect(chat?.clientId).toBeNull()
  })
})

describe("Kairós en la conversación", () => {
  it("el interruptor lo ve y lo cambia solo Administración", async () => {
    const kairos = new Hono<{ Variables: { adminActor: AdminActor } }>()
    kairos.use("*", async (c, next) => {
      const id = c.req.header("x-test-user") ?? ""
      c.set("adminActor", { userId: id, role: id === ADMIN ? "admin" : "support" })
      await next()
    })
    kairos.route("/k", createAdminKairosRoute({ ownerDb, mailer: { async send() {} } }))
    const ask = (method: string, who: string, body?: unknown) =>
      kairos.request("/k/sells", {
        method,
        headers: { "x-test-user": who, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    const off = await ask("GET", ADMIN)
    await expectStatus(off, 200)
    expect((await json(off)).data).toMatchObject({ enabled: false })
    await expectStatus(await ask("GET", SUPPORT), 403)
    await expectStatus(await ask("PUT", SUPPORT, { enabled: true }), 403)
    await expectStatus(await ask("PUT", ADMIN, { enabled: "sí" }), 400)
    const on = await ask("PUT", ADMIN, { enabled: true })
    await expectStatus(on, 200)
    expect((await json(on)).data).toMatchObject({ enabled: true, updatedBy: { userId: ADMIN } })

    // La conversación dice si Kairós la atiende; «Lo atiendo yo» la saca y «Devolver a Kairós» la vuelve.
    const chatId = await chatWith("whatsapp", "+51911000020")
    const before = await json(await call("GET", `/${chatId}`, ADMIN))
    expect(before.data).toMatchObject({ handledByKairos: true, kairosPausedAt: null })
    await expectStatus(await call("POST", `/${chatId}/kairos-pause`, SUPPORT), 404)
    await expectStatus(await call("POST", `/${chatId}/kairos-pause`, ADMIN), 200)
    const paused = await json(await call("GET", `/${chatId}`, ADMIN))
    expect(paused.data.handledByKairos).toBe(false)
    expect(paused.data.kairosPausedAt).not.toBeNull()
    const [row] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chatId))
    expect(row?.kairosPausedBy).toBe(ADMIN)
    await expectStatus(await call("DELETE", `/${chatId}/kairos-pause`, ADMIN), 200)
    expect((await json(await call("GET", `/${chatId}`, ADMIN))).data.handledByKairos).toBe(true)
    await expectStatus(await ask("PUT", ADMIN, { enabled: false }), 200)
    expect((await json(await call("GET", `/${chatId}`, ADMIN))).data.handledByKairos).toBe(false)
  })

  it("el interruptor de Ariadna (ADR 0191) es aparte, solo de Administración, y no toca lo de Kairós", async () => {
    const kairos = new Hono<{ Variables: { adminActor: AdminActor } }>()
    kairos.use("*", async (c, next) => {
      const id = c.req.header("x-test-user") ?? ""
      c.set("adminActor", { userId: id, role: id === ADMIN ? "admin" : "support" })
      await next()
    })
    kairos.route("/k", createAdminKairosRoute({ ownerDb, mailer: { async send() {} } }))
    const ask = (path: string, method: string, who: string, body?: unknown) =>
      kairos.request(`/k/${path}`, {
        method,
        headers: { "x-test-user": who, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    const off = await ask("ariadna", "GET", ADMIN)
    await expectStatus(off, 200)
    expect((await json(off)).data).toMatchObject({ enabled: false })
    await expectStatus(await ask("ariadna", "GET", SUPPORT), 403)
    await expectStatus(await ask("ariadna", "PUT", SUPPORT, { enabled: true }), 403)
    await expectStatus(await ask("ariadna", "PUT", ADMIN, { enabled: 1 }), 400)
    const on = await ask("ariadna", "PUT", ADMIN, { enabled: true })
    await expectStatus(on, 200)
    expect((await json(on)).data).toMatchObject({ enabled: true, updatedBy: { userId: ADMIN } })
    expect((await json(await ask("sells", "GET", ADMIN))).data).toMatchObject({ enabled: false })
    await expectStatus(await ask("ariadna", "PUT", ADMIN, { enabled: false }), 200)
  })
})
