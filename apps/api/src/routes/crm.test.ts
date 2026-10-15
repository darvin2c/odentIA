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
import { createAgentLearningRoute } from "./agent-learning.js"
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
  const llm = { fake: true }
  app.route("/agent/learning", createAgentLearningRoute({ ...deps, llm }))
  app.route("/agent", createAgentRoute({ ...deps, llm }))
  app.route("/agent", createAgentOpsRoute({ ...deps, llm }))
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

it("ninguna propuesta espera al equipo: no hay ruta para aprobarla o rechazarla", async () => {
  const response = await buildApp("owner").request(`/agent/proposals/${randomUUID()}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "aprobada" }),
  })
  expect(response.status).toBe(404)
})

it("la API no crea propuestas sin conversación: el agente no abre hilos por su cuenta", async () => {
  const response = await buildApp("owner").request("/agent/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contactId: randomUUID(),
      action: "enviar_mensaje",
      payload: { kind: "template", name: "seguimiento_presupuesto", language: "es_PE" },
      idempotencyKey: randomUUID(),
    }),
  })
  expect(response.status).toBe(400)
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
  // El modelo es uno de los dos de odentIA; la clínica ya no trae proveedor ni lo prueba.
  const chosen = await app.request("/agent/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ llm: "claude_5_5" }),
  })
  expect(chosen.status).toBe(200)
  const chosenBody = (await chosen.json()) as { data: Record<string, unknown> }
  expect(chosenBody.data.llm).toBe("claude_5_5")
  expect(Object.keys(chosenBody.data).filter((key) => /model|baseurl|apikey/i.test(key))).toEqual([])
  const unknown = await app.request("/agent/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ llm: "gpt-4o" }),
  })
  expect(unknown.status).toBe(400)
  const probe = await app.request("/agent/config/llm/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  expect(probe.status).toBe(404)
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

it("etapas y campos: los lee y los define quien trabaja con ventas; quien atiende, no", async () => {
  const json = { "content-type": "application/json" }
  const reception = buildApp("reception")
  const dentist = buildApp("dentist")
  // Recepción los usa en el tablero y en la ficha del contacto, y también los define: es trabajo diario de ventas.
  expect((await reception.request("/pipelines")).status).toBe(200)
  expect((await reception.request("/fields")).status).toBe(200)
  for (const [path, body] of [
    ["/pipelines", { name: "Otro" }],
    ["/fields", { label: "Origen", type: "text" }],
  ] as const) {
    const denied = await dentist.request(path, { method: "POST", headers: json, body: JSON.stringify(body) })
    expect(denied.status, path).toBe(403)
  }
  const byReception = await reception.request("/fields", { method: "POST", headers: json, body: JSON.stringify({ label: "Canal preferido", type: "text" }) })
  expect(byReception.status).toBe(201)

  const owner = buildApp("owner")
  // Solo se escribe el nombre: la clave la genera el servidor.
  const created = await owner.request("/fields", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ label: "Cómo nos conoció", type: "select", options: ["Redes"] }),
  })
  expect(created.status).toBe(201)
  const field = ((await created.json()) as { data: { id: string; key: string } }).data
  expect(field.key).toBe("como_nos_conocio")
  const repeated = await owner.request("/fields", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ label: "cómo nos conoció", type: "text" }),
  })
  expect(repeated.status).toBe(409)

  // Un campo se edita: nombre y opciones; la clave no cambia.
  const edit = { label: "Origen", options: ["Redes", "Recomendación"] }
  const refused = await dentist.request(`/fields/${field.id}`, { method: "PATCH", headers: json, body: JSON.stringify(edit) })
  expect(refused.status).toBe(403)
  const edited = await owner.request(`/fields/${field.id}`, { method: "PATCH", headers: json, body: JSON.stringify(edit) })
  expect(edited.status).toBe(200)
  expect(((await edited.json()) as { data: unknown }).data).toMatchObject({ key: "como_nos_conocio", ...edit })

  const pipelines = ((await (await owner.request("/pipelines")).json()) as { data: { id: string; stages: { id: string }[] }[] }).data
  const stageId = pipelines[0]?.stages[0]?.id ?? ""
  const rename = { method: "PATCH", headers: json, body: JSON.stringify({ name: "Recién llegado" }) }
  expect((await dentist.request(`/pipelines/stages/${stageId}`, rename)).status).toBe(403)
  expect((await reception.request(`/pipelines/stages/${stageId}`, rename)).status).toBe(200)

  expect((await dentist.request(`/fields/${field.id}`, { method: "DELETE" })).status).toBe(403)
  expect((await owner.request(`/fields/${field.id}`, { method: "DELETE" })).status).toBe(200)
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

it("fichas, resumen y prueba del agente", async () => {
  const app = buildApp("owner")
  const member = buildApp("member")
  const json = { "content-type": "application/json" }

  const roles = await app.request("/agent/roles")
  expect(roles.status).toBe(200)
  const fichas = (await roles.json()) as {
    data: { principles: string[]; roles: { id: string; available: boolean }[]; levels?: unknown }
  }
  expect(fichas.data.roles.map((role) => role.id)).toEqual(["recepcion", "asistente_clinico", "administrador", "ayuda"])
  // Sin niveles (ADR 0021): quién confirma cada acción es fijo.
  expect(fichas.data.levels).toBeUndefined()
  expect(fichas.data.principles.length).toBeGreaterThan(0)
  expect((await member.request("/agent/roles")).status).toBe(403)

  // Ni nivel ni política se cambian por la API.
  expect((await app.request("/agent/level", { method: "PUT", headers: json, body: JSON.stringify({ level: "supervisado" }) })).status).toBe(404)
  expect((await app.request("/agent/policy", { method: "PUT", headers: json, body: JSON.stringify({ enviar_mensaje: "aprobar_equipo" }) })).status).toBe(404)

  // El resumen cuenta «hoy» en la zona de la clínica: necesita su perfil.
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values ('org_a', 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE') on conflict do nothing`,
  )
  const before = (await (await app.request("/agent/overview")).json()) as {
    data: { readiness: { channels: string[]; sandboxTurns: number } }
  }
  expect(before.data.readiness.channels).toContain("whatsapp")
  expect((await member.request("/agent/overview")).status).toBe(403)

  // Probar no escribe mensajes: solo cuenta que la clínica ya probó.
  const [{ count: messagesBefore }] = await ownerDb.execute<{ count: number }>(sql`select count(*)::int as count from message`)
  const sandbox = await app.request("/agent/sandbox", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ message: "Hola, ¿atienden los sábados?" }),
  })
  expect(sandbox.status).toBe(200)
  const result = (await sandbox.json()) as { data: { reply: string; state: unknown; did: string[]; waiting: string[] } }
  expect(result.data.reply.length).toBeGreaterThan(0)
  expect(result.data.state).toMatchObject({ pending: expect.any(Array), notes: expect.any(Array) })
  const [{ count: messagesAfter }] = await ownerDb.execute<{ count: number }>(sql`select count(*)::int as count from message`)
  expect(messagesAfter).toBe(messagesBefore)
  const after = (await (await app.request("/agent/overview")).json()) as { data: { readiness: { sandboxTurns: number } } }
  expect(after.data.readiness.sandboxTurns).toBe(before.data.readiness.sandboxTurns + 1)

  const empty = await app.request("/agent/sandbox", { method: "POST", headers: json, body: JSON.stringify({ message: "" }) })
  expect(empty.status).toBe(400)
  const noAccess = await member.request("/agent/sandbox", { method: "POST", headers: json, body: JSON.stringify({ message: "Hola" }) })
  expect(noAccess.status).toBe(403)

  await app.request("/agent/level", { method: "PUT", headers: json, body: JSON.stringify({ level: "equilibrado" }) })
})

it("aprender: lectura, corrección y aprobación piden permisos distintos y validan su entrada", async () => {
  const app = buildApp("owner")
  const member = buildApp("member")
  const reception = buildApp("reception")
  const json = { "content-type": "application/json" }
  const post = (target: Hono, path: string, body?: unknown) =>
    target.request(path, { method: "POST", headers: json, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

  const overview = await app.request("/agent/learning")
  expect(overview.status).toBe(200)
  expect(((await overview.json()) as { data: Record<string, unknown> }).data).toMatchObject({
    review: expect.any(Array), proposed: expect.any(Array), learned: expect.any(Array), withdrawn: expect.any(Array), cases: expect.any(Number),
  })
  expect((await member.request("/agent/learning")).status).toBe(403)

  // Una corrección nombra exactamente una respuesta y dice qué falló.
  const trace = randomUUID()
  expect((await post(app, "/agent/learning/corrections", { failure: "tono", correctedReply: "Hola" })).status).toBe(400)
  expect((await post(app, "/agent/learning/corrections", { traceId: trace, reviewItemId: trace, failure: "tono" })).status).toBe(400)
  expect((await post(app, "/agent/learning/corrections", { traceId: trace, failure: "inventado", correctedReply: "Hola" })).status).toBe(400)
  expect((await post(app, "/agent/learning/corrections", { traceId: trace, failure: "tono", correctedReply: "Hola" })).status).toBe(404)
  expect((await post(member, "/agent/learning/corrections", { traceId: trace, failure: "tono", correctedReply: "Hola" })).status).toBe(403)
  // Recepción decide por el agente: puede corregir (aquí la respuesta no existe), pero no aprobar ni retirar lecciones.
  expect((await post(reception, "/agent/learning/corrections", { traceId: trace, failure: "tono", correctedReply: "Hola" })).status).toBe(404)
  for (const action of ["approve", "discard", "withdraw", "restore", "preview"]) {
    expect((await post(reception, `/agent/learning/lessons/${trace}/${action}`, {})).status, action).toBe(403)
  }
  expect((await post(app, `/agent/learning/lessons/${trace}/approve`)).status).toBe(404)
  expect((await post(app, `/agent/learning/lessons/${trace}/preview`)).status).toBe(404)
})

it("conexiones: la lista dice cómo está cada una; el alta a mano, la clave y la prueba piden administrar", async () => {
  const app = buildApp("owner")
  const reception = buildApp("reception")
  const json = { "content-type": "application/json" }
  const list = (await (await app.request("/channels/connections")).json()) as { data: Record<string, unknown>[] }
  const wa = list.data.find((item) => item["id"] === waConnId)
  expect(wa).toMatchObject({
    webhookVerifiedAt: null,
    health: null,
    messages: { aprobados: 0, enRevision: 7, rechazados: 0, pausados: 0, retirados: 0, sinPedir: 0 },
  })
  expect(typeof wa?.["lastInboundAt"]).toBe("string")
  expect((await reception.request("/channels/connections")).status).toBe(403)

  const setup = await app.request(`/channels/connections/${waConnId}/setup`)
  expect(setup.status).toBe(200)
  expect(((await setup.json()) as { data: Record<string, unknown> }).data).toMatchObject({
    webhookUrl: `https://api.example.com/api/webhooks/channels/whatsapp_cloud_api/${waConnId}`,
    verifyToken: expect.any(String),
    webhookVerifiedAt: null,
    lastInboundAt: expect.any(String),
  })
  expect((await reception.request(`/channels/connections/${waConnId}/setup`)).status).toBe(403)

  const post = (target: Hono, path: string, body?: unknown) =>
    target.request(path, { method: "POST", headers: json, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const changed = await post(app, `/channels/connections/${waConnId}/credentials`, { config: { accessToken: "otra" } })
  expect(changed.status).toBe(200)
  expect(((await changed.json()) as { data: Record<string, unknown> }).data).toMatchObject({ id: waConnId, status: "active", account: null })
  expect(JSON.stringify(await (await app.request("/channels/connections")).json())).not.toContain("otra")
  expect((await post(app, `/channels/connections/${waConnId}/credentials`, { config: {} })).status).toBe(400)
  expect((await post(reception, `/channels/connections/${waConnId}/credentials`, { config: { accessToken: "x" } })).status).toBe(403)

  // Sin proveedor no se afirma que la conexión funcione.
  const tested = await post(app, `/channels/connections/${waConnId}/test`)
  expect(tested.status).toBe(200)
  expect(((await tested.json()) as { data: Record<string, unknown> }).data).toMatchObject({ ok: false, account: null, checkedAt: expect.any(String) })

  // El nombre es opcional: sin él queda el del canal (o el que dé el proveedor).
  const unnamed = await post(app, "/channels/connections", { channel: "telegram", provider: "telegram_bot_api", config: { botToken: "sin-nombre" } })
  expect(unnamed.status).toBe(201)
  expect(((await unnamed.json()) as { data: Record<string, unknown> }).data).toMatchObject({ displayName: "Telegram", account: null, templates: null })
  expect((await post(app, "/channels/connections", { channel: "telegram", provider: "telegram_bot_api", config: {} })).status).toBe(400)
})

it("mensajes de WhatsApp: ver es de quien abre Configuración; comprobar, cambiar, crear y eliminar, de quien la administra", async () => {
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
        values ('u-1', 'Dueña', 'u1@example.com', true, now(), now()) on conflict do nothing`,
  )
  const app = buildApp("owner")
  const reception = buildApp("reception")
  const json = { "content-type": "application/json" }
  const base = `/channels/connections/${waConnId}/messages`
  const send = (target: Hono, method: string, path: string, body?: unknown) =>
    target.request(path, { method, headers: json, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

  const listed = await app.request(base)
  expect(listed.status).toBe(200)
  const items = ((await listed.json()) as { data: { id: string; origin: string }[] }).data
  expect(items.map((item) => [item.id, item.origin])).toEqual([
    ["recordatorio_cita", "agente"],
    ["recordatorio_control", "agente"],
    ["seguimiento_presupuesto", "agente"],
    ["seguimiento_comercial", "agente"],
    ["seguimiento_no_asistencia", "agente"],
    ["cita_cancelada", "agente"],
    ["retomar_conversacion", "bandeja"],
  ])
  expect((await reception.request(base)).status).toBe(403)

  const formal = "Estimada {{persona}}: le recordamos su cita en {{lugar}}: {{citas}}. Si necesita cambiarla, responda a este mensaje."
  const checked = await send(app, "POST", `${base}/check`, { messageId: "recordatorio_cita", body: "Hola, {{persona}}." })
  expect(checked.status).toBe(200)
  const check = ((await checked.json()) as { data: { ok: boolean; checks: { ok: boolean; text: string }[]; previewParts: unknown[] } }).data
  expect(check.ok).toBe(false)
  expect(check.checks.filter((item) => !item.ok).map((item) => item.text)).toContain("Falta el dato «Clínica y sede».")
  expect(check.previewParts.length).toBeGreaterThan(0)
  expect((await send(reception, "POST", `${base}/check`, { body: "Hola" })).status).toBe(403)

  const invalid = await send(app, "PUT", `${base}/recordatorio_cita/text`, { body: "Hola, {{persona}}." })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ error: { code: "VALIDATION", message: "Falta el dato «Clínica y sede»." } })
  const saved = await send(app, "PUT", `${base}/recordatorio_cita/text`, { body: formal })
  expect(saved.status).toBe(200)
  expect(((await saved.json()) as { data: Record<string, unknown> }).data).toMatchObject({
    id: "recordatorio_cita",
    current: { body: formal, status: "en_revision", isDefault: false },
    pending: null,
    canRevert: true,
  })
  expect((await send(reception, "PUT", `${base}/recordatorio_cita/text`, { body: formal })).status).toBe(403)
  const reverted = await send(app, "POST", `${base}/recordatorio_cita/revert`)
  expect(reverted.status).toBe(200)
  expect(((await reverted.json()) as { data: Record<string, unknown> }).data).toMatchObject({ current: { isDefault: true }, canRevert: false })
  expect((await send(app, "PUT", `${base}/no_existe/text`, { body: formal })).status).toBe(404)

  const created = await send(app, "POST", base, { title: "Tu trabajo ya está listo", body: "Hola, {{persona}}. Tu trabajo ya llegó a {{clinica}}.", buttonTitle: "Quiero mi cita" })
  expect(created.status).toBe(201)
  const own = ((await created.json()) as { data: { id: string; origin: string; deletable: boolean } }).data
  expect(own).toMatchObject({ origin: "clinica", deletable: true })
  expect((await send(reception, "POST", base, { title: "Otro", body: "Hola." })).status).toBe(403)
  expect((await send(reception, "DELETE", `${base}/${own.id}`)).status).toBe(403)
  expect((await send(app, "DELETE", `${base}/retomar_conversacion`)).status).toBe(400)
  const removed = await send(app, "DELETE", `${base}/${own.id}`)
  expect(removed.status).toBe(200)
  expect(await removed.json()).toEqual({ data: { ok: true } })
  expect(((await (await app.request(base)).json()) as { data: unknown[] }).data).toHaveLength(7)
})

it("bandeja, pasadas las 24 horas: lo dice antes de escribir y ofrece el mensaje aprobado", async () => {
  await ownerDb.execute(
    sql`update "conversation" set "last_inbound_at" = now() - interval '25 hours' where "id" = ${conversationId}::uuid`,
  )
  const app = buildApp("owner")
  const reception = buildApp("reception")
  const json = { "content-type": "application/json" }
  const detail = (await (await app.request(`/conversations/${conversationId}`)).json()) as {
    data: { whatsappWindow: { open: boolean; lastInboundAt: string | null } | null }
  }
  expect(detail.data.whatsappWindow).toMatchObject({ open: false, lastInboundAt: expect.any(String) })

  type Offered = { data: { id: string; title: string }[]; none: { text: string; fixHref: string | null } | null }
  const waiting = (await (await app.request(`/conversations/${conversationId}/approved-messages`)).json()) as Offered
  expect(waiting.data).toEqual([])
  expect(waiting.none).toMatchObject({
    text: expect.stringContaining("«Retomar la conversación» está en revisión"),
    fixHref: "/settings/integrations/whatsapp",
  })
  // Recepción no abre Configuración: se le dice a quién avisar.
  const forReception = (await (await reception.request(`/conversations/${conversationId}/approved-messages`)).json()) as Offered
  expect(forReception.none).toMatchObject({ text: expect.stringContaining("Avísale a quien administra la clínica."), fixHref: null })
  expect((await buildApp("member").request(`/conversations/${conversationId}/approved-messages`)).status).toBe(403)

  const send = (target: Hono, body: unknown) =>
    target.request(`/conversations/${conversationId}/messages/approved`, { method: "POST", headers: json, body: JSON.stringify(body) })
  const early = await send(reception, { messageId: "retomar_conversacion" })
  expect(early.status).toBe(409)
  expect(await early.json()).toMatchObject({ error: { code: "APPROVED_MESSAGE_UNAVAILABLE" } })
  expect((await send(reception, {})).status).toBe(400)

  await ownerDb.execute(
    sql`update "channel_template" set "status" = 'aprobada' where "connection_id" = ${waConnId}::uuid and "name" = 'odentia_retomar_conversacion_v1'`,
  )
  const offered = (await (await reception.request(`/conversations/${conversationId}/approved-messages`)).json()) as Offered
  expect(offered.none).toBeNull()
  expect(offered.data.map((item) => [item.id, item.title])).toEqual([["retomar_conversacion", "Retomar la conversación"]])
  const sent = await send(reception, { messageId: "retomar_conversacion" })
  expect(sent.status).toBe(201)
  expect(((await sent.json()) as { data: Record<string, unknown> }).data).toMatchObject({
    contentType: "template",
    templateName: "odentia_retomar_conversacion_v1",
    body: "Hola, Luis. Te escribimos de Clínica para continuar con tu consulta. ¿Seguimos por aquí?",
  })
  // Un segundo mensaje aprobado espera a que la persona responda o a que pase un día.
  const again = await send(reception, { messageId: "retomar_conversacion" })
  expect(again.status).toBe(409)
  expect(await again.json()).toMatchObject({
    error: { code: "APPROVED_MESSAGE_UNAVAILABLE", message: expect.stringContaining("Ya se le envió un mensaje aprobado") },
  })
  await ownerDb.execute(
    sql`update "conversation" set "last_inbound_at" = now() where "id" = ${conversationId}::uuid`,
  )
})

it("bandeja: vistas nuevas, «Tomar», «Devolver», «Resolver» y cerrar sin resolver (ADR 0024)", async () => {
  await ownerDb.execute(sql`insert into "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
    values ('u-1', 'Dueña', 'u1@example.com', true, now(), now()) on conflict do nothing`)
  await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at")
    values ('m-u-1', 'org_a', 'u-1', 'owner', now()) on conflict do nothing`)
  const app = buildApp("owner")
  const json = { "content-type": "application/json" }
  for (const view of ["human", "approval", "handoff"]) {
    expect((await app.request(`/conversations?view=${view}`)).status).toBe(400)
  }
  expect((await app.request("/conversations?status=archivada")).status).toBe(400)
  expect((await app.request("/conversations?view=awaiting_patient")).status).toBe(200)
  const summary = (await (await app.request("/conversations/summary")).json()) as { data: Record<string, number> }
  expect(Object.keys(summary.data).sort()).toEqual(["awaitingPatient", "closed", "open", "team", "unanswered"])

  const ingested = await withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId: waConnId,
        event: {
          externalEventId: "wamid.cierre",
          externalMessageId: "wamid.cierre",
          externalThreadId: "wa:520",
          senderExternalId: "wa:520",
          senderDisplayName: "Marta Salas",
          content: { type: "text", text: "Muchas gracias" },
          sentAt: new Date().toISOString(),
        },
      },
      telegramBotApiAdapter,
      { storage: storageStub, fetch, secretsKey: KEY },
    ),
  )
  const id = ingested.conversationId
  expect((await app.request(`/conversations/${id}/take`, { method: "POST" })).status).toBe(200)
  const taken = (await (await app.request(`/conversations/${id}`)).json()) as { data: { conversation: { agentStatus: string }; attention: { assignedName: string | null; unanswered: boolean }; closure: unknown } }
  expect(taken.data.conversation.agentStatus).toBe("off")
  expect(taken.data.attention).toMatchObject({ assignedName: "Dueña", unanswered: true })
  expect(taken.data.closure).toBeNull()
  expect((await app.request(`/conversations/${id}/release`, { method: "POST" })).status).toBe(200)

  const preview = (await (await app.request(`/conversations/${id}/resolve-preview`)).json()) as { data: unknown }
  expect(preview.data).toEqual({
    farewell: true,
    farewellText: "Marta, cuando quieras retomar, escríbenos por aquí: estamos atentos para ayudarte.",
    handoffs: 0,
    pendingContact: 0,
  })
  const resolved = await app.request(`/conversations/${id}/resolve`, { method: "POST" })
  expect(resolved.status).toBe(200)
  const after = (await resolved.json()) as { data: { conversation: { status: string }; closure: { reason: string; byName: string | null } } }
  expect(after.data.conversation.status).toBe("closed")
  expect(after.data.closure).toMatchObject({ reason: "equipo", byName: "Dueña" })

  // Escribir a una cerrada la reabre (ya no responde CONVERSATION_CLOSED).
  const written = await app.request(`/conversations/${id}/messages`, { method: "POST", headers: json, body: JSON.stringify({ text: "Una cosa más, Marta" }) })
  expect(written.status).toBe(201)
  expect(((await (await app.request(`/conversations/${id}`)).json()) as { data: { conversation: { status: string } } }).data.conversation.status).toBe("open")
  // Cerrar sin resolver: motivo manual, sin despedida.
  expect((await app.request(`/conversations/${id}/close`, { method: "POST" })).status).toBe(200)
  const closed = (await (await app.request(`/conversations?view=closed`)).json()) as { data: Array<{ id: string; closure: { reason: string } | null }> }
  expect(closed.data.find((item) => item.id === id)?.closure).toMatchObject({ reason: "manual" })

  // Horas para cerrar por silencio: de 6 a 23.
  const put = (closeAfterHours: number) => app.request("/agent/config", { method: "PUT", headers: json, body: JSON.stringify({ closeAfterHours }) })
  expect((await put(5)).status).toBe(400)
  expect((await put(24)).status).toBe(400)
  expect((await put(12)).status).toBe(200)
  const config = (await (await app.request("/agent/config")).json()) as { data: { closeAfterHours: number } }
  expect(config.data.closeAfterHours).toBe(12)
})
