// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { createWorkspaceNotification, type Storage, secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createAgentAdminRoute } from "./agent-admin.js"
import type { CrmDeps } from "./helpers.js"
import { createWorkspaceRoute } from "./workspace.js"

/**
 * La campana entrega cada aviso a quien tiene el permiso que declara (también
 * los de escritura: plantillas de WhatsApp, modelo del agente, comisiones), y
 * la fila «el agente no pudo escribirle» abre su detalle con el mismo permiso
 * con que se muestra.
 */
const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const unused = async () => {
  throw new Error("no usado")
}
const storageStub: Storage = {
  putAvatar: unused,
  deleteByUrl: async () => {},
  putAttachment: unused,
  attachmentUrl: unused,
  deleteAttachment: async () => {},
  putPatientDocument: unused,
  putPatientAvatar: unused,
}

const ORG = "org_workspace_api"
const OWNER = "api-ws-owner"
const RECEPTION = "api-ws-reception"
const DENTIST = "api-ws-dentist"

function buildApp(role: string, userId: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", ORG)
    c.set("userId", userId)
    c.set("memberRole", role)
    await next()
  })
  app.route("/workspace", createWorkspaceRoute(deps))
  app.route("/agent/admin", createAgentAdminRoute({ ...deps, llm: {} as never }))
  return app
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
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(uri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(
    `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at")
    values (${ORG}, 'Clínica Avisos API', 'avisos-api', now())`)
  await ownerDb.execute(sql`
    insert into "user" ("id", "name", "email") values
      (${OWNER}, 'Dueña API', 'ws-owner@example.test'),
      (${RECEPTION}, 'Recepción API', 'ws-reception@example.test'),
      (${DENTIST}, 'Dra. API', 'ws-dentist@example.test')`)
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      ('m-ws-owner', ${ORG}, ${OWNER}, 'owner', now()),
      ('m-ws-reception', ${ORG}, ${RECEPTION}, 'reception', now()),
      ('m-ws-dentist', ${ORG}, ${DENTIST}, 'dentist', now())`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

const notice = (userId: string, dedupeKey: string, title: string, permission: string) =>
  withOrgContext(appDb, ORG, (tx) =>
    createWorkspaceNotification(tx, ORG, { userId, dedupeKey, title, body: "", href: "/home", permission }),
  )

async function titles(app: Hono): Promise<{ titles: string[]; unread: number }> {
  const res = await app.request("/workspace/notifications")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { items: Array<{ title: string }>; unread: number } }
  return { titles: body.data.items.map((item) => item.title).sort(), unread: body.data.unread }
}

it("cada aviso llega a quien tiene el permiso que declara, también los de escritura", async () => {
  await notice(OWNER, "plantilla", "WhatsApp aprobó tu mensaje «Retomar la conversación»", "settings.write")
  await notice(OWNER, "modelo", "El agente no puede usar el modelo", "agent.write")
  await notice(DENTIST, "comision", "Se registró el pago de tu comisión", "commissions.read")
  // Un aviso que pide un permiso que el rol no tiene no se entrega.
  await notice(RECEPTION, "ajeno", "Aviso de configuración", "settings.write")
  expect((await titles(buildApp("owner", OWNER))).titles).toEqual([
    "El agente no puede usar el modelo",
    "WhatsApp aprobó tu mensaje «Retomar la conversación»",
  ])
  expect((await titles(buildApp("dentist", DENTIST))).titles).toEqual(["Se registró el pago de tu comisión"])
  expect((await titles(buildApp("reception", RECEPTION))).titles).toEqual([])
})

it("«Marcar todo leído» deja la campana sin pendientes", async () => {
  const app = buildApp("owner", OWNER)
  expect((await titles(app)).unread).toBe(2)
  const res = await app.request("/workspace/notifications/read-all", { method: "POST" })
  expect(res.status).toBe(200)
  expect(((await res.json()) as { data: { read: number } }).data.read).toBe(2)
  expect(await titles(app)).toMatchObject({ unread: 0 })
})

it("recepción abre a quién no pudo escribirle el agente con el mismo permiso con que ve la fila", async () => {
  expect((await buildApp("reception", RECEPTION).request("/agent/admin/unreached")).status).toBe(200)
  // Quien no ve la fila tampoco abre el detalle.
  expect((await buildApp("dentist", DENTIST).request("/agent/admin/unreached")).status).toBe(403)
})
