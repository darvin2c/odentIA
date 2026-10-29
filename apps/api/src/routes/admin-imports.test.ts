process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { type Storage, secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createApp } from "../app.js"

/**
 * «Cargar datos» de una clínica contra la app real (ADR 0104): solo la
 * administración, con su segundo factor, ensaya y carga por tandas; soporte
 * no ve ni escribe datos de pacientes.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const ADMIN = "https://admin.odentia.localhost"
const ORG = "org-carga"

let container: StartedTestContainer
let ownerDb: Db
let app: Hono

const authStub = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-user")
      if (!id) return null
      return {
        user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
        session: { id: `s-${id}`, createdAt: new Date() },
      }
    },
  },
} as unknown as Auth

function call(path: string, user: string, body: unknown) {
  const headers = new Headers({ "x-test-user": user, origin: ADMIN, "content-type": "application/json" })
  return app.request(`/api/admin/imports/${ORG}${path}`, { method: "POST", headers, body: JSON.stringify(body) })
}

async function staff(id: string, role: "admin" | "support") {
  await ownerDb.execute(sql`insert into "user" (id, name, email, email_verified) values (${id}, ${id}, ${`${id}@example.test`}, true)`)
  await ownerDb.insert(adminStaff).values({ userId: id, role })
  await ownerDb.insert(twoFactor).values({ id: `f-${id}`, userId: id, secret: "x", backupCodes: "[]", verified: true })
  await ownerDb.insert(adminSessionVerification).values({
    userId: id,
    sessionId: `s-${id}`,
    factorId: `f-${id}`,
    method: "totp",
    expiresAt: new Date(Date.now() + 3_600_000),
  })
}

const plan = {
  version: 1,
  countryCode: "PE",
  sources: [{ name: "pacientes.csv", sha256: "c".repeat(64) }],
  people: [
    {
      key: "1",
      patient: true,
      demographics: { displayName: "Rosa Quispe", givenNames: "Rosa", familyName: "Quispe", phone: "+51987654322", birthDate: "1990-11-15" },
      origin: { file: "pacientes.csv", row: 2 },
    },
    {
      key: "2",
      patient: true,
      demographics: { displayName: "Mateo Quispe", givenNames: "Mateo", familyName: "Quispe", birthDate: "2018-08-20" },
      guardian: { key: "1", relationship: "guardian", kinship: "MTH" },
      origin: { file: "pacientes.csv", row: 3 },
    },
  ],
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
  const url = `${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${url}`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  app = createApp({
    auth: authStub,
    db: createAppDb(`postgres://dentalagent_app:dentalagent_app@${url}`),
    ownerDb,
    secretsKey: KEY,
    storage: {} as unknown as Storage,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
    trustedOrigins: [ADMIN],
    cookieDomain: "odentia.localhost",
    webURL: "https://app.odentia.localhost",
    adminURL: ADMIN,
    mailer: { send: async () => {} },
    listenUrl: "postgres://localhost:5432/dentalagent",
  })
  await staff("u-admin", "admin")
  await staff("u-soporte", "support")
  await ownerDb.execute(sql`insert into "organization" (id, name, slug, created_at) values (${ORG}, 'Clínica Carga', 'clinica-carga', now())`)
  await ownerDb.execute(
    sql`insert into "org_profile" (organization_id, legal_name, country_code, currency, timezone, locale)
        values (${ORG}, 'Clínica Carga', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("soporte no ensaya ni carga datos de pacientes", async () => {
  expect((await call("/preview", "u-soporte", plan)).status).toBe(403)
  expect((await call("/apply", "u-soporte", { plan, from: 0 })).status).toBe(403)
})

it("un plan que no es del formato se rechaza antes de leer la base", async () => {
  const response = await call("/preview", "u-admin", { ...plan, version: 2 })
  expect(response.status).toBe(400)
})

it("la administración ensaya, carga y repetir no duplica", async () => {
  const preview = await call("/preview", "u-admin", plan)
  expect(preview.status).toBe(200)
  const { data } = (await preview.json()) as { data: { order: string[]; totals: Record<string, number> } }
  expect(data.order).toEqual(["1", "2"])
  expect(data.totals).toMatchObject({ nuevas: 2, pacientes: 2, errores: 0 })

  const first = await call("/apply", "u-admin", { plan, from: 0 })
  expect(first.status).toBe(200)
  expect(((await first.json()) as { data: unknown }).data).toMatchObject({ next: 2, total: 2, done: { creadas: 2, errores: 0 } })

  const again = await call("/apply", "u-admin", { plan, from: 0 })
  expect(((await again.json()) as { data: unknown }).data).toMatchObject({ done: { creadas: 0, yaCargadas: 2 } })

  const [count] = await ownerDb.execute<{ n: number }>(sql`select count(*)::int as n from patient where organization_id = ${ORG}`)
  expect(count?.n).toBe(2)
  const [audit] = await ownerDb.execute<{ n: number }>(
    sql`select count(*)::int as n from admin_audit where action = 'org.data_import' and organization_id = ${ORG}`,
  )
  expect(audit?.n).toBe(2)
})
