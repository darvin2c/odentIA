process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createOwnerDb, type Db } from "@odentia/db"
import {
  kairosItem,
  saasChat,
  saasClient,
  saasClientContact,
  saasOpportunity,
  saasOutreach,
} from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { type AdminChannels, assignChat, ingestInboundChat, ServiceError } from "@odentia/services"
import { eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { type Context, Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { errorBody } from "../lib/error.js"
import { createAdminKairosRoute } from "./admin-kairos.js"

/**
 * El sí de un mensaje de Kairós por WhatsApp con el número de Sallca
 * configurado, contra Postgres real y un Graph de prueba: sale una vez desde
 * la conversación de esa persona (queda con su `chat_id` y en su historial),
 * fuera de las 24 h con la plantilla para retomar, un corte queda incierto y
 * no se repite, un rechazo de Meta no salió; un celular de otra clínica o lo
 * de una venta que aprueba Soporte siguen en espera (409). Sin el número, el
 * enlace wa.me como siempre.
 */

const IMAGE = "dentalagent-postgres:18.6"
const HOUR = 3_600_000
const ADMIN = "krc-admin"
const SUPPORT = "krc-soporte"

const channels: AdminChannels = {
  appSecret: "secreto",
  verifyToken: "reto",
  whatsapp: { phoneNumberId: "1111111111", accessToken: "wa-token" },
}

let container: StartedTestContainer
let ownerDb: Db
let app: Hono
let plain: Hono

let mode: "ok" | "reject" | "throw" = "ok"
const calls: { url: string; body: Record<string, unknown> }[] = []
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) })
  if (mode === "throw") throw new TypeError("fetch failed")
  if (mode === "reject")
    return Response.json({ error: { code: 100, message: "Invalid parameter" } }, { status: 400 })
  return Response.json({ messages: [{ id: `wamid.k${calls.length}` }] })
}) as typeof fetch

// biome-ignore lint/suspicious/noExplicitAny: el cuerpo de una respuesta de prueba se lee suelto
async function read(response: Response): Promise<any> {
  return response.json()
}

function decide(on: Hono, id: string, who: string) {
  return on.request(`/api/admin/kairos/items/${id}/decide`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-user": who,
      "x-test-role": who === ADMIN ? "admin" : "support",
    },
    body: JSON.stringify({ action: "aprobar" }),
  })
}

let seq = 0
/** Un cliente (con su cuenta o no) y su persona con celular. */
async function client(phone: string, organizationId: string | null = null) {
  seq += 1
  const [row] = await ownerDb
    .insert(saasClient)
    .values({
      name: `Clínica ${seq} (ficticia)`,
      product: "dental",
      origin: "web",
      ...(organizationId ? { organizationId } : {}),
    })
    .returning({ id: saasClient.id })
  if (!row) throw new Error("sin cliente")
  await ownerDb.insert(saasOpportunity).values({ clientId: row.id })
  const [person] = await ownerDb
    .insert(saasClientContact)
    .values({ clientId: row.id, name: `Rosa Persona${seq}`, phone, isPrimary: true })
    .returning({ id: saasClientContact.id })
  if (!person) throw new Error("sin persona")
  return { clientId: row.id, contactId: person.id }
}

/** El mensaje de Kairós listo, como lo deja la pasada. */
async function message(target: { clientId: string; contactId: string }, phone: string) {
  seq += 1
  const body = "Hola Rosa, ¿le acomoda una llamada mañana?"
  // Como la pasada: lo último que pasó con el cliente (al ligar su conversación, lo que escribió).
  const [last] = (await ownerDb.execute(
    sql`select to_char(max(happened_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
      from saas_follow_up where client_id = ${target.clientId}::uuid and not from_note`,
  )) as unknown as Array<{ at: string | null }>
  const [row] = await ownerDb
    .insert(kairosItem)
    .values({
      clientId: target.clientId,
      kind: "mensaje",
      title: `Mensaje ${seq}`,
      reason: "Su solicitud espera respuesta",
      payload: {
        goal: "primera_respuesta",
        channel: "whatsapp",
        contactId: target.contactId,
        to: phone,
        subject: null,
        body,
        draft: { subject: null, body },
      },
      expectedState: { lastActivityAt: last?.at ?? null },
      idempotencyKey: `prueba-chat:${seq}`,
      expiresAt: new Date(Date.now() + 48 * HOUR),
    })
    .returning({ id: kairosItem.id })
  if (!row) throw new Error("sin ítem")
  return row.id
}

/**
 * Ese celular escribió hace un rato, sin decirse de quién es; con `owner`, una
 * persona ya dijo de quién es (el celular solo no la liga).
 */
async function wrote(phone: string, owner?: { clientId: string; contactId: string }, ago = 60_000) {
  seq += 1
  const result = await ownerDb.transaction((tx) =>
    ingestInboundChat(tx as Db, {
      channel: "whatsapp",
      address: phone,
      externalId: `entrada-k${seq}`,
      body: "Hola",
      media: [],
      receivedAt: new Date(Date.now() - ago),
    }),
  )
  if (owner)
    await ownerDb.transaction((tx) =>
      assignChat(tx as Db, { userId: ADMIN, role: "admin" }, result.chatId, owner),
    )
  return result
}

async function itemOf(id: string) {
  const [row] = await ownerDb.select().from(kairosItem).where(eq(kairosItem.id, id))
  return row
}

async function outreachOf(itemId: string) {
  return ownerDb.select().from(saasOutreach).where(eq(saasOutreach.kairosItemId, itemId))
}

function appWith(deps: { channels?: AdminChannels }): Hono {
  const on = new Hono()
  on.use("*", async (c: Context, next: Next) => {
    const userId = c.req.header("x-test-user")
    if (userId) c.set("adminActor", { userId, role: c.req.header("x-test-role") })
    await next()
  })
  on.onError((err, c) => {
    if (err instanceof ServiceError)
      return c.json(errorBody(c, err.code, err.message, err.fields), err.status)
    console.error(err)
    return c.json(errorBody(c, "INTERNAL", "Error interno"), 500)
  })
  on.route(
    "/api/admin/kairos",
    createAdminKairosRoute({
      ownerDb,
      mailer: { async send() {} },
      ...deps,
      fetch: fakeFetch,
    }),
  )
  return on
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
  await ownerDb.insert(user).values([
    { id: ADMIN, name: "Ana Administración", email: "ana@kairos-chat.test" },
    { id: SUPPORT, name: "Sofía Soporte", email: "sofia@kairos-chat.test" },
  ])
  await ownerDb.insert(adminStaff).values([
    { userId: ADMIN, role: "admin" },
    { userId: SUPPORT, role: "support" },
  ])
  app = appWith({ channels })
  plain = appWith({})
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

describe("el mensaje de Kairós por el WhatsApp de Sallca", () => {
  it("dentro de las 24 h sale el texto desde su conversación, una vez, y queda en su historial", async () => {
    mode = "ok"
    const phone = "+51900000001"
    const target = await client(phone)
    await wrote(phone, target)
    const item = await message(target, phone)
    const before = calls.length
    const res = await decide(app, item, ADMIN)
    expect(res.status).toBe(200)
    const body = await read(res)
    expect(body.data).toMatchObject({
      status: "ejecutada",
      outreach: {
        channel: "whatsapp",
        to: phone,
        status: "enviado",
        whatsappUrl: null,
        template: null,
        chatId: expect.any(String),
      },
    })
    expect(calls.length - before).toBe(1)
    const [outreach] = await outreachOf(item)
    expect(outreach).toMatchObject({
      status: "enviado",
      chatId: body.data.outreach.chatId,
      externalId: `wamid.k${calls.length}`,
      template: null,
    })
    expect(calls.at(-1)?.body).toMatchObject({
      to: phone.slice(1),
      type: "text",
      biz_opaque_callback_data: outreach?.id,
    })
    expect(String((calls.at(-1)?.body.text as { body?: string })?.body)).toContain(
      "¿le acomoda una llamada mañana?",
    )
    // Ya escribió sin saberse de quién: Administración la liga al aprobar.
    const [chat] = await ownerDb.select().from(saasChat).where(eq(saasChat.address, phone))
    expect(chat).toMatchObject({ clientId: target.clientId, contactId: target.contactId })
    const activities = await ownerDb
      .select()
      .from(saasFollowUp)
      .where(eq(saasFollowUp.clientId, target.clientId))
    expect(activities.some((row) => row.direction === "salio" && row.chatId === chat?.id)).toBe(
      true,
    )
    expect((await itemOf(item))?.status).toBe("ejecutada")
  })

  it("si nunca escribió (o pasaron 24 h), sale la plantilla para retomar y lo dice", async () => {
    mode = "ok"
    const phone = "+51900000002"
    const item = await message(await client(phone), phone)
    const res = await decide(app, item, ADMIN)
    expect(res.status).toBe(200)
    const body = await read(res)
    expect(body.data.outreach).toMatchObject({
      status: "enviado",
      template: "retomar_conversacion",
    })
    expect(calls.at(-1)?.body).toMatchObject({
      type: "template",
      template: { name: "retomar_conversacion" },
    })
    const [outreach] = await outreachOf(item)
    expect(outreach).toMatchObject({ template: "retomar_conversacion", status: "enviado" })
  })

  it("un corte queda incierto y no se reintenta: decidir otra vez no lo vuelve a enviar", async () => {
    mode = "throw"
    const phone = "+51900000003"
    const target = await client(phone)
    await wrote(phone, target)
    const item = await message(target, phone)
    const before = calls.length
    const res = await decide(app, item, ADMIN)
    expect(res.status).toBe(200)
    const body = await read(res)
    expect(body.data).toMatchObject({
      status: "incierta",
      outreach: { status: "incierto", whatsappUrl: null },
    })
    expect(calls.length - before).toBe(1)
    mode = "ok"
    const again = await decide(app, item, ADMIN)
    expect(again.status).toBe(409)
    expect(calls.length - before).toBe(1)
    const rows = await outreachOf(item)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("incierto")
    expect((await itemOf(item))?.status).toBe("incierta")
  })

  it("lo que Meta rechaza no salió, con su motivo, y el ítem queda fallido", async () => {
    mode = "reject"
    const phone = "+51900000004"
    const target = await client(phone)
    await wrote(phone, target)
    const item = await message(target, phone)
    const body = await read(await decide(app, item, ADMIN))
    expect(body.data).toMatchObject({
      status: "fallida",
      outreach: { status: "no_salio", why: expect.stringContaining("Invalid parameter") },
    })
    mode = "ok"
  })

  it("un celular que ya escribe como otra clínica: 409 y el mensaje sigue en espera, sin enviar nada", async () => {
    const phone = "+51900000005"
    const other = await client("+51900000099")
    const { chatId } = await wrote(phone)
    await ownerDb
      .update(saasChat)
      .set({ clientId: other.clientId, matchedAt: new Date(), matchedByUser: ADMIN })
      .where(eq(saasChat.id, chatId))
    const item = await message(await client(phone), phone)
    const before = calls.length
    const res = await decide(app, item, ADMIN)
    expect(res.status).toBe(409)
    expect(await read(res)).toMatchObject({ error: { code: "CHAT_OTHER_CLIENT" } })
    expect(calls.length).toBe(before)
    expect((await itemOf(item))?.status).toBe("espera")
    expect(await outreachOf(item)).toHaveLength(0)
  })

  it("un celular que ya escribió sin decir de quién es: 409 con su conversación, en espera y sin ligarla", async () => {
    const phone = "+51900000008"
    const target = await client(phone)
    const { chatId } = await wrote(phone)
    const item = await message(target, phone)
    const before = calls.length
    const res = await decide(app, item, ADMIN)
    expect(res.status).toBe(409)
    expect(await read(res)).toMatchObject({
      error: { code: "CHAT_UNASSIGNED", fields: { chatId } },
    })
    expect(calls.length).toBe(before)
    expect((await itemOf(item))?.status).toBe("espera")
    const [chat] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chatId))
    expect(chat?.clientId).toBeNull()
  })

  it("Soporte no envía por el WhatsApp de la administración: 409 y sigue en espera", async () => {
    const phone = "+51900000006"
    const item = await message(await client(phone), phone)
    const res = await decide(app, item, SUPPORT)
    expect(res.status).toBe(409)
    expect(await read(res)).toMatchObject({ error: { code: "CHAT_ADMIN_ONLY" } })
    expect((await itemOf(item))?.status).toBe("espera")
  })

  it("sin el número configurado, el enlace wa.me como siempre y nada sale solo", async () => {
    const phone = "+51900000007"
    const item = await message(await client(phone), phone)
    const before = calls.length
    const body = await read(await decide(plain, item, ADMIN))
    expect(body.data).toMatchObject({
      status: "incierta",
      outreach: {
        status: "pendiente",
        chatId: null,
        whatsappUrl: expect.stringMatching(/^https:\/\/wa\.me\/51900000007\?text=/),
      },
    })
    expect(calls.length).toBe(before)
    const [outreach] = await outreachOf(item)
    expect(outreach?.chatId).toBeNull()
  })
})
