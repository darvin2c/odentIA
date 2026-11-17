process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createOwnerDb, type Db } from "@odentia/db"
import { saasConversationMark } from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { type AdminActor, ingestInboundChat, ingestInboundEmail } from "@odentia/services"
import { eq } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAdminInboxRoute } from "./admin-inbox.js"

/**
 * La Bandeja de la administración contra Postgres real (ADR 0196): la lista con sus números y
 * filtros, el hilo de un correo, «Lo atiendo yo» y «No necesita respuesta». Solo Administración:
 * Soporte recibe 403 en todo.
 */

const IMAGE = "dentalagent-postgres:18.6"
const BASE = "/api/admin/inbox"
const ADMIN = "bandeja-admin"
const SUPPORT = "bandeja-soporte"

let container: StartedTestContainer
let ownerDb: Db
let app: Hono<{ Variables: { adminActor: AdminActor } }>

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
async function email(subject: string) {
  seq += 1
  return ownerDb.transaction((tx) =>
    ingestInboundEmail(tx as Db, {
      mailbox: "hola",
      product: "dental",
      messageId: `<bandeja-${seq}@clinica.test>`,
      from: `persona${seq}@nadie.test`,
      fromName: "Rosa Mamani",
      to: "hola@odentia32.com",
      subject,
      text: "Hola,\n¿cómo empiezo?",
      receivedAt: new Date(Date.now() - 60 * 60_000),
      senderVerified: true,
    }),
  )
}

async function chat(address: string) {
  seq += 1
  return ownerDb.transaction((tx) =>
    ingestInboundChat(tx as Db, {
      channel: "whatsapp",
      address,
      externalId: `bandeja-${seq}`,
      body: "Hola",
      receivedAt: new Date(Date.now() - 60_000),
    }),
  )
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
  app.route(BASE, createAdminInboxRoute({ ownerDb }))
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

describe("la lista y su número", () => {
  it("dice lo que te toca, con sus números; los filtros se validan con su campo", async () => {
    const mail = await email("Quiero probar")
    const wa = await chat("+51922000001")
    const response = await call("GET", "?estado=te_toca&cliente=sin", ADMIN)
    await expectStatus(response, 200)
    const { data } = await json(response)
    expect(data.counts).toMatchObject({ teToca: 2, kairos: 0, sinCliente: 2 })
    expect(data.items.map((item: { kind: string; id: string }) => [item.kind, item.id])).toEqual([
      ["correo", mail.id],
      ["chat", wa.chatId],
    ])
    expect(data.items[0]).toMatchObject({
      channel: "correo",
      who: { name: "Rosa Mamani" },
      subject: "Quiero probar",
      preview: "Hola, ¿cómo empiezo?",
      state: "te_toca",
      draftReady: false,
      client: null,
      mailbox: "hola",
      attendedBy: null,
      lastOutbound: null,
    })
    expect(typeof data.items[0].lastInboundAt).toBe("string")
    const count = await call("GET", "/count", ADMIN)
    await expectStatus(count, 200)
    expect((await json(count)).data).toEqual({ teToca: 2 })
    const canal = await json(await call("GET", "?canal=whatsapp", ADMIN))
    expect(canal.data.items.map((item: { id: string }) => item.id)).toEqual([wa.chatId])

    for (const query of ["?estado=otro", "?limit=0", "?limit=101", "?cliente=x", "?fase=nada"]) {
      const bad = await call("GET", query, ADMIN)
      await expectStatus(bad, 400)
      expect((await json(bad)).error.code).toBe("VALIDATION")
    }
  })

  it("Soporte no ve la Bandeja: 403 en todas sus rutas", async () => {
    const mail = await email("Otra")
    for (const [method, path, body] of [
      ["GET", "", undefined],
      ["GET", "/count", undefined],
      ["GET", `/correo/${mail.id}`, undefined],
      ["POST", `/correo/${mail.id}/attend`, { on: true }],
      ["POST", "/settle", { kind: "correo", id: mail.id }],
      ["POST", "/unsettle", { kind: "correo", id: mail.id }],
    ] as const) {
      const response = await call(method, path, SUPPORT, body)
      await expectStatus(response, 403)
      expect((await json(response)).error.code).toBe("FORBIDDEN")
    }
  })
})

describe("el hilo y las marcas", () => {
  it("el hilo de un correo; «Lo atiendo yo» y «No necesita respuesta», con su marca", async () => {
    const mail = await email("Una duda")
    const thread = await call("GET", `/correo/${mail.id}`, ADMIN)
    await expectStatus(thread, 200)
    const { data } = await json(thread)
    expect(data).toMatchObject({
      emailId: mail.id,
      threadKey: expect.stringMatching(/^<bandeja-\d+@clinica\.test>$/),
      state: "te_toca",
      entries: [expect.objectContaining({ kind: "entro", id: mail.id, textDeleted: false })],
      reply: { emailId: mail.id, subject: "Re: Una duda", canReply: true },
      rules: { channel: "correo", maxFiles: 5 },
      draft: null,
    })
    await expectStatus(
      await call("GET", "/correo/7d2c4b1a-1111-4222-8333-444455556666", ADMIN),
      404,
    )

    await expectStatus(await call("POST", `/correo/${mail.id}/attend`, ADMIN, { on: "sí" }), 400)
    const attended = await call("POST", `/correo/${mail.id}/attend`, ADMIN, { on: true })
    await expectStatus(attended, 200)
    expect((await json(attended)).data).toMatchObject({
      threadKey: data.threadKey,
      attendedBy: { id: ADMIN, name: "Ana Admin" },
    })

    await expectStatus(await call("POST", "/settle", ADMIN, { kind: "otro", id: mail.id }), 400)
    const settled = await call("POST", "/settle", ADMIN, { kind: "correo", id: mail.id })
    await expectStatus(settled, 200)
    expect((await json(settled)).data).toMatchObject({ kind: "correo", id: mail.id })
    const [mark] = await ownerDb
      .select()
      .from(saasConversationMark)
      .where(eq(saasConversationMark.threadKey, data.threadKey))
    expect(mark).toMatchObject({ attendedBy: ADMIN, settledBy: ADMIN })
    const after = await json(await call("GET", `/correo/${mail.id}`, ADMIN))
    expect(after.data).toMatchObject({ state: "respondida", stateWhy: "No necesitaba respuesta" })
    const undone = await call("POST", "/unsettle", ADMIN, { kind: "correo", id: mail.id })
    await expectStatus(undone, 200)
    expect((await json(undone)).data).toMatchObject({ settledAt: null })

    // Un chat se marca por su id.
    const wa = await chat("+51922000002")
    await expectStatus(await call("POST", "/settle", ADMIN, { kind: "chat", id: wa.chatId }), 200)
    const list = await json(await call("GET", "?estado=respondida", ADMIN))
    expect(list.data.items).toContainEqual(
      expect.objectContaining({ kind: "chat", id: wa.chatId, stateWhy: "No necesitaba respuesta" }),
    )
  })
})
