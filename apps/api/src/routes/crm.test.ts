process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"
import { randomUUID } from "node:crypto"

import { telegramBotApiAdapter } from "@odentia/channels"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import {
  createConnection,
  type IngestDeps,
  ingestInbound,
  type Storage,
  secretsKeyFromEnv,
} from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createAgentRoute } from "./agent.js"
import { createAgentOpsRoute } from "./agent-ops.js"
import { createConnectionsRoute } from "./connections.js"
import { createContactsRoute } from "./contacts.js"
import { createConversationsRoute } from "./conversations.js"
import { createFieldsRoute } from "./fields.js"
import type { CrmDeps } from "./helpers.js"
import { createPipelinesRoute } from "./pipelines.js"
import { createTasksRoute } from "./tasks.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const storageStub: Storage = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async ({ orgId, conversationId, bytes, contentType }) => ({
    objectKey: `${orgId}/${conversationId}/att.bin`,
    mimeType: contentType,
    filename: "att.bin",
    size: bytes.byteLength,
  }),
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

function stubOrg(role: string) {
  return async (c: Context, next: Next) => {
    c.set("orgId", "org_a")
    c.set("userId", "u-1")
    c.set("memberRole", role)
    await next()
  }
}

function buildApp(role: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", stubOrg(role))
  app.route("/conversations", createConversationsRoute(deps))
  app.route("/contacts", createContactsRoute(deps))
  app.route("/pipelines", createPipelinesRoute(deps))
  app.route("/channels/connections", createConnectionsRoute(deps))
  app.route("/agent", createAgentRoute(deps))
  app.route("/agent", createAgentOpsRoute(deps))
  app.route("/tasks", createTasksRoute(deps))
  app.route("/fields", createFieldsRoute(deps))
  return app
}

let waConnId = ""
let conversationId = ""

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
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(uri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(
    `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`,
  )
  const wa = await withOrgContext(appDb, "org_a", (tx) =>
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
          templates: [],
        },
      },
      { fetch, validateExternal: false },
    ),
  )
  waConnId = wa.id
  const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }
  const ingested = await withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId: waConnId,
        event: {
          externalEventId: "wamid.seed",
          externalMessageId: "wamid.seed",
          externalThreadId: "wa:519",
          senderExternalId: "wa:519",
          senderDisplayName: "Luis",
          content: { type: "text", text: "Hola" },
          sentAt: new Date().toISOString(),
        },
      },
      telegramBotApiAdapter,
      deps,
    ),
  )
  conversationId = ingested.conversationId
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it.each([
  { endpoint: "decision", body: { decision: "aprobada" } },
  { endpoint: "execute", body: undefined },
  { endpoint: "confirm", body: { contactId: randomUUID() } },
])("una propuesta ausente conserva 404 en $endpoint", async ({ endpoint, body }) => {
  const response = await buildApp("owner").request(`/agent/proposals/${randomUUID()}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } })
})

it("bandeja: lista, detalle y envío dentro de ventana", async () => {
  const app = buildApp("owner")
  const list = await app.request("/conversations")
  expect(list.status).toBe(200)
  const listBody = (await list.json()) as { data: { id: string }[] }
  expect(listBody.data.map((c) => c.id)).toContain(conversationId)

  const detail = await app.request(`/conversations/${conversationId}`)
  expect(detail.status).toBe(200)

  const sent = await app.request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hola Luis" }),
  })
  expect(sent.status).toBe(201)
})

it("fuera de ventana 24h responde WINDOW_CLOSED 409", async () => {
  await ownerDb.execute(
    sql`update "conversation" set "last_inbound_at" = now() - interval '25 hours' where "id" = ${conversationId}::uuid`,
  )
  const app = buildApp("owner")
  const res = await app.request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "tarde" }),
  })
  expect(res.status).toBe(409)
  expect(await res.json()).toMatchObject({ error: { code: "WINDOW_CLOSED" } })
  await ownerDb.execute(
    sql`update "conversation" set "last_inbound_at" = now() where "id" = ${conversationId}::uuid`,
  )
})

it("mensajes media: subida 201 con nombre original; mime inválido 400; fuera de ventana 409", async () => {
  const app = buildApp("owner")
  const png = new FormData()
  png.set(
    "file",
    new File([new Uint8Array([137, 80, 78, 71])], "radiografía dental.png", {
      type: "image/png",
    }),
  )
  png.set("caption", "Mira esto")
  const uploaded = await app.request(`/conversations/${conversationId}/messages/media`, {
    method: "POST",
    body: png,
  })
  expect(uploaded.status).toBe(201)
  const uploadedBody = (await uploaded.json()) as {
    data: { contentType: string; body: string | null; attachments: { filename: string }[] }
  }
  expect(uploadedBody.data.contentType).toBe("image")
  expect(uploadedBody.data.body).toBe("Mira esto")
  expect(uploadedBody.data.attachments[0]?.filename).toBe("radiografía dental.png")

  const bad = new FormData()
  bad.set("file", new File(["texto"], "nota.txt", { type: "text/plain" }))
  expect(
    (
      await app.request(`/conversations/${conversationId}/messages/media`, {
        method: "POST",
        body: bad,
      })
    ).status,
  ).toBe(400)

  await ownerDb.execute(
    sql`update "conversation" set "last_inbound_at" = now() - interval '25 hours' where "id" = ${conversationId}::uuid`,
  )
  const late = new FormData()
  late.set("file", new File([new Uint8Array([137, 80, 78, 71])], "foto.png", { type: "image/png" }))
  const res = await app.request(`/conversations/${conversationId}/messages/media`, {
    method: "POST",
    body: late,
  })
  expect(res.status).toBe(409)
  expect(await res.json()).toMatchObject({ error: { code: "WINDOW_CLOSED" } })
  await ownerDb.execute(
    sql`update "conversation" set "last_inbound_at" = now() where "id" = ${conversationId}::uuid`,
  )
})

it("contactos: crear, validar y ver detalle", async () => {
  const app = buildApp("owner")
  const bad = await app.request("/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "" }),
  })
  expect(bad.status).toBe(400)
  const created = await app.request("/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Rosa" }),
  })
  expect(created.status).toBe(201)
  const createdBody = (await created.json()) as { data: { id: string } }
  const detail = await app.request(`/contacts/${createdBody.data.id}`)
  expect(detail.status).toBe(200)
})

it("pipelines asegura default; miembro no puede crear", async () => {
  const app = buildApp("owner")
  const list = await app.request("/pipelines")
  expect(list.status).toBe(200)
  const body = (await list.json()) as { data: { name: string }[] }
  expect(body.data[0]?.name).toBe("Ventas")

  const member = buildApp("member")
  const forbidden = await member.request("/pipelines", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Otro" }),
  })
  expect(forbidden.status).toBe(403)
})

it("conexiones listan webhookUrl sin secretos; agente con gating", async () => {
  const app = buildApp("owner")
  const list = await app.request("/channels/connections")
  const body = (await list.json()) as { data: { webhookUrl: string; externalId: null }[] }
  expect(body.data[0]?.webhookUrl).toBe(
    `https://api.example.com/api/webhooks/channels/whatsapp_cloud_api/${waConnId}`,
  )
  expect(JSON.stringify(body.data)).not.toContain("configEncrypted")

  const put = await app.request("/agent/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  })
  expect(put.status).toBe(200)
  const member = buildApp("member")
  const forbidden = await member.request("/agent/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  })
  expect(forbidden.status).toBe(403)
})

it("tareas y campos van de punta a punta", async () => {
  const app = buildApp("owner")
  const task = await app.request("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Llamar" }),
  })
  expect(task.status).toBe(201)
  const tasks = await app.request("/tasks?status=open")
  expect(tasks.status).toBe(200)

  const field = await app.request("/fields", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "sede", label: "Sede", type: "select", options: ["a"] }),
  })
  expect(field.status).toBe(201)
  const fields = await app.request("/fields")
  expect(((await fields.json()) as { data: unknown[] }).data).toHaveLength(1)
})

it("contactos: filtro isActive, alta sin isActive y PATCH con gating", async () => {
  const owner = buildApp("owner")
  const sneaky = await owner.request("/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Sneaky", isActive: false }),
  })
  expect(sneaky.status).toBe(201)
  const sneakyBody = (await sneaky.json()) as { data: { id: string; isActive: boolean } }
  expect(sneakyBody.data.isActive).toBe(true)
  const archived = await owner.request(`/contacts/${sneakyBody.data.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isActive: false }),
  })
  expect(archived.status).toBe(200)
  expect(((await archived.json()) as { data: { isActive: boolean } }).data.isActive).toBe(false)
  const def = (await (await owner.request("/contacts")).json()) as { data: { id: string }[] }
  expect(def.data.map((c) => c.id)).not.toContain(sneakyBody.data.id)
  const all = (await (await owner.request("/contacts?isActive=all")).json()) as {
    data: { id: string }[]
  }
  expect(all.data.map((c) => c.id)).toContain(sneakyBody.data.id)
  const member = buildApp("member")
  const forbiddenRead = await member.request(`/contacts/${sneakyBody.data.id}`, { method: "GET" })
  expect(forbiddenRead.status).toBe(403)
  const forbidden = await member.request(`/contacts/${sneakyBody.data.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isActive: true }),
  })
  expect(forbidden.status).toBe(403)
  const reception = buildApp("reception")
  const rename = await reception.request(`/contacts/${sneakyBody.data.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Sneaky Dos" }),
  })
  expect(rename.status).toBe(200)
})

it("identidades: alta manual, idempotencia, conflicto y permisos", async () => {
  const owner = buildApp("owner")
  const mk = async (name: string) =>
    (
      (await (
        await owner.request("/contacts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: name }),
        })
      ).json()) as { data: { id: string } }
    ).data.id
  const a = await mk("Ident A")
  const b = await mk("Ident B")
  const payload = { channel: "whatsapp", externalUserId: "+51911222334" }
  const first = await owner.request(`/contacts/${a}/identities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  expect(first.status).toBe(201)
  const firstBody = (await first.json()) as { data: { id: string; externalUserId: string } }
  expect(firstBody.data.externalUserId).toBe("wa:51911222334")
  const again = await owner.request(`/contacts/${a}/identities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  expect(again.status).toBe(201)
  expect(((await again.json()) as { data: { id: string } }).data.id).toBe(firstBody.data.id)
  const conflict = await owner.request(`/contacts/${b}/identities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ error: { code: "IDENTITY_IN_USE" } })
  const member = buildApp("member")
  const forbidden = await member.request(`/contacts/${a}/identities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "telegram", externalUserId: "tg:123" }),
  })
  expect(forbidden.status).toBe(403)
  const bad = await owner.request(`/contacts/${a}/identities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "email", externalUserId: "a@x.com" }),
  })
  expect(bad.status).toBe(400)
})

it("reasignación mueve la conversación directa y exige motivo y permiso", async () => {
  const owner = buildApp("owner")
  const mk = async (name: string) =>
    (
      (await (
        await owner.request("/contacts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: name }),
        })
      ).json()) as { data: { id: string } }
    ).data.id
  const from = await mk("Mueve Origen")
  const to = await mk("Mueve Destino")
  const identRes = await owner.request(`/contacts/${from}/identities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "whatsapp", externalUserId: "wa:51933344455" }),
  })
  const identityId = ((await identRes.json()) as { data: { id: string } }).data.id
  const started = await owner.request(`/contacts/${from}/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityId, connectionId: waConnId }),
  })
  expect(started.status).toBe(201)
  const noReason = await owner.request(`/contacts/${from}/identities/${identityId}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toContactId: to }),
  })
  expect(noReason.status).toBe(400)
  const member = buildApp("member")
  const forbidden = await member.request(`/contacts/${from}/identities/${identityId}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toContactId: to, reason: "x" }),
  })
  expect(forbidden.status).toBe(403)
  const moved = await owner.request(`/contacts/${from}/identities/${identityId}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toContactId: to, reason: "Corrige titular" }),
  })
  expect(moved.status).toBe(200)
  expect(await moved.json()).toMatchObject({
    data: { movedConversations: 1, movedTasks: 0, revokedLinks: 0 },
  })
})

it("conversaciones: identidad manual y directa con restricciones de canal", async () => {
  const owner = buildApp("owner")
  const tgConn = await withOrgContext(appDb, "org_a", (tx) =>
    createConnection(
      tx,
      "org_a",
      KEY,
      {
        channel: "telegram",
        provider: "telegram_bot_api",
        displayName: "Bot2",
        config: { botToken: "T" },
      },
      { fetch, validateExternal: false },
    ),
  )
  const mk = async (name: string) =>
    (
      (await (
        await owner.request("/contacts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: name }),
        })
      ).json()) as { data: { id: string } }
    ).data.id
  const person = await mk("Persona Canal")
  const other = await mk("Otra Persona")
  const tgIdent = (
    (await (
      await owner.request(`/contacts/${person}/identities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "telegram", externalUserId: "tg:665001" }),
      })
    ).json()) as { data: { id: string } }
  ).data.id
  const blocked = await owner.request(`/contacts/${person}/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityId: tgIdent, connectionId: tgConn.id }),
  })
  expect(blocked.status).toBe(409)
  expect(await blocked.json()).toMatchObject({ error: { code: "CHANNEL_REQUIRES_INBOUND" } })
  const ingested = await withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId: tgConn.id,
        event: {
          externalEventId: "wamid.tg665a",
          externalMessageId: "wamid.tg665a",
          externalThreadId: "tg:665001",
          senderExternalId: "tg:665001",
          senderDisplayName: "Persona Canal",
          content: { type: "text", text: "Hola" },
          sentAt: new Date().toISOString(),
        },
      },
      telegramBotApiAdapter,
      { storage: storageStub, fetch, secretsKey: KEY },
    ),
  )
  const waIdent = (
    (await (
      await owner.request(`/contacts/${other}/identities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "whatsapp", externalUserId: "wa:51944455566" }),
      })
    ).json()) as { data: { id: string } }
  ).data.id
  const member = buildApp("member")
  const forbidden = await member.request(`/conversations/${ingested.conversationId}/identity`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityId: tgIdent }),
  })
  expect(forbidden.status).toBe(403)
  const mismatch = await owner.request(`/conversations/${ingested.conversationId}/identity`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityId: waIdent }),
  })
  expect(mismatch.status).toBe(409)
  const resolved = await owner.request(`/conversations/${ingested.conversationId}/identity`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityId: tgIdent }),
  })
  expect(resolved.status).toBe(200)
  expect(await resolved.json()).toMatchObject({ data: { contactIdentityId: tgIdent } })
  const waStart = await owner.request(`/contacts/${other}/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityId: waIdent, connectionId: waConnId }),
  })
  expect(waStart.status).toBe(201)
  const waReuse = await owner.request(`/contacts/${other}/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityId: waIdent, connectionId: waConnId }),
  })
  expect(waReuse.status).toBe(200)
  expect(((await waReuse.json()) as { data: { created: boolean } }).data.created).toBe(false)
})
