// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import type { Storage } from "@odentia/services"
import { secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createCommissionsRoute } from "./commissions.js"
import type { CrmDeps } from "./helpers.js"

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
  putAttachment: async () => {
    throw new Error("no usado")
  },
  attachmentUrl: async () => {
    throw new Error("no usado")
  },
  deleteAttachment: async () => {},
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

const ORG = "org_commissions_api"
const OWNER = "api-comm-owner"
const DENTIST = "api-comm-dentist"
const CASHIER = "api-comm-cashier"
const MEMBER = "api-comm-member"
const OTHER = "api-comm-other"

function stubOrg(role: string, userId: string) {
  return async (c: Context, next: Next) => {
    c.set("orgId", ORG)
    c.set("userId", userId)
    c.set("memberRole", role)
    await next()
  }
}

function buildApp(role: string, userId: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", stubOrg(role, userId))
  app.route("/commissions", createCommissionsRoute(deps))
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
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at")
    values (${ORG}, 'Clínica Comisiones API', 'comisiones-api', now())`)
  await ownerDb.execute(sql`
    insert into "org_profile" ("organization_id", "legal_name")
    values (${ORG}, 'Clínica Comisiones API')`)
  await ownerDb.execute(sql`
    insert into "user" ("id", "name", "email") values
      (${OWNER}, 'Dueña API', 'comm-owner@example.test'),
      (${DENTIST}, 'Dra. API', 'comm-dentist@example.test'),
      (${CASHIER}, 'Caja API', 'comm-cashier@example.test'),
      (${MEMBER}, 'Miembro API', 'comm-member@example.test'),
      (${OTHER}, 'Otra API', 'comm-other@example.test')`)
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      ('m-comm-owner', ${ORG}, ${OWNER}, 'owner', now()),
      ('m-comm-dentist', ${ORG}, ${DENTIST}, 'dentist', now()),
      ('m-comm-cashier', ${ORG}, ${CASHIER}, 'cashier', now()),
      ('m-comm-member', ${ORG}, ${MEMBER}, 'member', now()),
      ('m-comm-other', ${ORG}, ${OTHER}, 'dentist', now())`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("sin commissions.read no hay acceso", async () => {
  const app = buildApp("member", MEMBER)
  const monthly = await app.request("/commissions/my?year=2026&month=9&currency=PEN")
  expect(monthly.status).toBe(403)
  const result = await app.request("/commissions/monthly-result?year=2026&month=9")
  expect(result.status).toBe(403)
})

it("el odontólogo ve solo las suyas y no administra", async () => {
  const app = buildApp("dentist", DENTIST)
  const mine = await app.request("/commissions/my?year=2026&month=9&currency=PEN")
  expect(mine.status).toBe(200)
  const other = await app.request(
    `/commissions/monthly?professionalUserId=${OTHER}&year=2026&month=9&currency=PEN`,
  )
  expect(other.status).toBe(403)
  const result = await app.request("/commissions/monthly-result?year=2026&month=9")
  expect(result.status).toBe(403)
  const rate = await app.request("/commissions/rates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ professionalUserId: DENTIST, rateBps: 4000 }),
  })
  expect(rate.status).toBe(403)
  const settle = await app.request("/commissions/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ professionalUserId: DENTIST, year: 2026, month: 9, currency: "PEN" }),
  })
  expect(settle.status).toBe(403)
})

it("admin configura la tasa y caja ve el resultado sin ver comisiones ajenas", async () => {
  const admin = buildApp("admin", OWNER)
  const rate = await admin.request("/commissions/rates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ professionalUserId: DENTIST, rateBps: 4000 }),
  })
  expect(rate.status).toBe(200)
  const cashier = buildApp("cashier", CASHIER)
  const result = await cashier.request("/commissions/monthly-result?year=2026&month=9")
  expect(result.status).toBe(200)
  const commissions = await cashier.request("/commissions/my?year=2026&month=9&currency=PEN")
  expect(commissions.status).toBe(403)
})
