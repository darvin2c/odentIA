process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { aiUsage } from "@odentia/db/schema/agent"
import { reportQuestion } from "@odentia/db/schema/reports"
import { secretsKeyFromEnv, updateAdminSettings } from "@odentia/services"
import { eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { type Context, Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import type { CrmDeps } from "./helpers.js"
import { createReportsRoute } from "./reports.js"

// POST /reports/argos (ADR 0073) sobre la API real y PostgreSQL efímero, con
// el modelo de demostración: lo pide `reports.read` (hoy, quien dirige), valida
// el cuerpo y responde con la llave del rol.

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const ORG = "org_argos_api"
const OWNER = "u-argos-owner"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

function buildApp(role: string): Hono {
  const deps: CrmDeps = { db: appDb, secretsKey: KEY, storage: {} as CrmDeps["storage"], validateExternal: false, webhookBaseUrl: "https://api.example.com" }
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", ORG)
    c.set("userId", OWNER)
    c.set("memberRole", role)
    await next()
  })
  app.route("/reports", createReportsRoute({ ...deps, llm: { fake: true } }))
  return app
}

const ask = (role: string, body: unknown) =>
  buildApp(role).request("/reports/argos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({ POSTGRES_DB: "dentalagent", POSTGRES_USER: "dentalagent", POSTGRES_PASSWORD: "dentalagent", POSTGRES_APP_PASSWORD: "dentalagent_app" })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  const host = container.getHost()
  const port = container.getMappedPort(5432)
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}:${port}/dentalagent`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}:${port}/dentalagent`)
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Clínica Argos', 'argos-api', now())`)
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values (${ORG}, 'Clínica Argos', 'PE', 'PEN', 'America/Lima', 'es-PE') on conflict do nothing`,
  )
  await ownerDb.execute(sql`insert into "user" ("id", "name", "email") values (${OWNER}, 'Dueña', 'duena@argos-api.test')`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("Argos apagado lo dice; encendido responde con la llave del rol y anota la consulta", async () => {
  const off = await ask("owner", { text: "¿Cuánto cobramos este mes?" })
  expect(off.status).toBe(200)
  expect(await off.json()).toMatchObject({ data: { kind: "apagado" } })

  await withOrgContext(appDb, ORG, (tx) => updateAdminSettings(tx, ORG, OWNER, { enabled: true }))
  const on = await ask("admin", { text: "¿Cuánto cobramos este mes?", screen: { period: "este_mes" }, previous: null })
  expect(on.status).toBe(200)
  expect(await on.json()).toMatchObject({ data: { kind: "respuesta", text: expect.stringContaining("Este mes se cobró") } })
  const [row] = await ownerDb.select().from(reportQuestion).where(eq(reportQuestion.organizationId, ORG))
  expect(row).toMatchObject({ outcome: "respondida", query: expect.stringContaining("from cobros") })
  // El modelo de demostración no se paga: no deja uso.
  expect(await ownerDb.select().from(aiUsage).where(eq(aiUsage.organizationId, ORG))).toEqual([])
})

it("solo quien ve Reportes pregunta, y el cuerpo se valida", async () => {
  for (const role of ["cashier", "reception", "dentist", "member"]) expect((await ask(role, { text: "¿Cuánto cobramos?" })).status, role).toBe(403)
  expect((await ask("owner", { text: "?" })).status).toBe(400)
  expect((await ask("owner", { text: "¿Cuánto cobramos?", sql: "select 1" })).status).toBe(400)
})
