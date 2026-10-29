// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { secretsKeyFromEnv, type Storage } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createApp } from "./app.js"

/**
 * Verificación en dos pasos del equipo (ADR 0107) contra la app real: quien no
 * la tiene no opera en la clínica que la pide, la otra clínica no cambia y solo
 * quien configura el equipo la enciende. Solo se simula la sesión.
 */

const IMAGE = "dentalagent-postgres:18.6"
const ORG = "org_2fa_a"
const SLUG = "dospasos"
const OTHER_ORG = "org_2fa_b"
const OTHER_SLUG = "otra"

let container: StartedTestContainer
let ownerDb: Db
let app: Hono
const sent: Array<{ to: string; subject: string }> = []

type Who = "owner" | "ownerGoogle" | "reception" | "receptionOther"
const SESSIONS: Record<Who, { sessionId: string; userId: string; email: string; twoFactorEnabled: boolean }> = {
  // Entró con su código: la sesión lleva la marca.
  owner: { sessionId: "s-2fa-owner", userId: "u-2fa-owner", email: "u-2fa-owner@example.test", twoFactorEnabled: true },
  // La misma persona con otra sesión que no pasó el código (Google, o abierta antes de activarla).
  ownerGoogle: { sessionId: "s-2fa-owner-google", userId: "u-2fa-owner", email: "u-2fa-owner@example.test", twoFactorEnabled: true },
  reception: { sessionId: "s-2fa-reception", userId: "u-2fa-reception", email: "u-2fa-reception@example.test", twoFactorEnabled: false },
  // La misma recepcionista, en su otra clínica.
  receptionOther: { sessionId: "s-2fa-reception", userId: "u-2fa-reception", email: "u-2fa-reception@example.test", twoFactorEnabled: false },
}

const authStub = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const found = SESSIONS[headers.get("x-test-session") as Who]
      if (!found) return null
      return {
        user: { id: found.userId, email: found.email, image: null, twoFactorEnabled: found.twoFactorEnabled },
        session: { id: found.sessionId, activeOrganizationId: null },
      }
    },
  },
} as unknown as Auth

function request(who: Who, method: string, path: string, body?: unknown) {
  return app.request(`/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-session": who,
      "x-odentia-org": who === "receptionOther" ? OTHER_SLUG : SLUG,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function code(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code
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
  const host = `${container.getHost()}:${container.getMappedPort(5432)}`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}/dentalagent`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  const appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}/dentalagent`)
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at") values
      (${ORG}, 'Clínica Dos Pasos', ${SLUG}, now()),
      (${OTHER_ORG}, 'Clínica Otra', ${OTHER_SLUG}, now())`)
  await ownerDb.execute(sql`
    insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values
      (${ORG}, 'Clínica Dos Pasos', 'PE', 'PEN', 'America/Lima', 'es-PE'),
      (${OTHER_ORG}, 'Clínica Otra', 'PE', 'PEN', 'America/Lima', 'es-PE')`)
  await ownerDb.execute(sql`
    insert into "user" ("id", "name", "email", "two_factor_enabled") values
      ('u-2fa-owner', 'Olga Propietaria', 'u-2fa-owner@example.test', true),
      ('u-2fa-reception', 'Rita Recepción', 'u-2fa-reception@example.test', false)`)
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      ('m-2fa-owner', ${ORG}, 'u-2fa-owner', 'owner', now()),
      ('m-2fa-reception', ${ORG}, 'u-2fa-reception', 'reception', now()),
      ('m-2fa-reception-b', ${OTHER_ORG}, 'u-2fa-reception', 'reception', now())`)
  await ownerDb.execute(sql`
    insert into "two_factor" ("id", "user_id", "secret", "backup_codes", "verified") values ('tf-2fa-owner', 'u-2fa-owner', 's', '[]', true)`)
  await ownerDb.execute(sql`
    insert into "verification" ("id", "identifier", "value", "expires_at") values
      ('v-2fa-owner', '2fa-session-s-2fa-owner', 'u-2fa-owner', now() + interval '1 day')`)
  app = createApp({
    auth: authStub,
    db: appDb,
    ownerDb,
    secretsKey: secretsKeyFromEnv("ee".repeat(32)),
    storage: {} as unknown as Storage,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
    trustedOrigins: [],
    cookieDomain: "odentia.localhost",
    productDomains: { medical: "latidia.localhost" },
    webURL: "https://app.odentia.localhost",
    adminURL: "https://admin.odentia.localhost",
    mailer: {
      send: async (message) => {
        sent.push({ to: message.to, subject: message.subject })
      },
    },
    listenUrl: "postgres://localhost:5432/dentalagent",
  })
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("la clínica que la pide no deja operar a quien no la tiene; la otra clínica no cambia", async () => {
  // Recepción no configura el equipo.
  const denied = await request("reception", "PUT", "/team/two-factor", { required: true })
  expect(denied.status).toBe(403)
  expect(await code(denied)).toBe("FORBIDDEN")
  // Cambiar los datos de la clínica no la enciende ni la apaga por otra vía.
  expect((await request("reception", "GET", "/org-profile")).status).toBe(200)

  const on = await request("owner", "PUT", "/team/two-factor", { required: true, notify: true })
  expect(on.status).toBe(200)
  expect(((await on.json()) as { data: unknown }).data).toEqual({ required: true, missing: 1, notified: 1 })
  expect(sent).toEqual([{ to: "u-2fa-reception@example.test", subject: "Clínica Dos Pasos pide verificación en dos pasos" }])

  const blocked = await request("reception", "GET", "/org-profile")
  expect(blocked.status).toBe(403)
  expect(await code(blocked)).toBe("TWO_FACTOR_REQUIRED")
  expect((await request("owner", "GET", "/org-profile")).status).toBe(200)
  expect((await request("receptionOther", "GET", "/org-profile")).status).toBe(200)
  // La tiene, pero esta sesión no pasó el código: se le pide el código, no activarla.
  const google = await request("ownerGoogle", "GET", "/org-profile")
  expect(google.status).toBe(403)
  expect(await code(google)).toBe("TWO_FACTOR_CODE_REQUIRED")
  // Las operaciones de cobro de quien administra también lo piden.
  const cap = await request("ownerGoogle", "POST", "/account/billing/spend-cap", { orgId: ORG, capCents: 100 })
  expect(cap.status).toBe(403)

  // Mi perfil dice qué clínica la pide.
  const mine = await request("reception", "GET", "/account/two-factor")
  expect(((await mine.json()) as { data: unknown }).data).toMatchObject({ enabled: false, requiredBy: ["Clínica Dos Pasos"] })

  const team = await request("owner", "GET", "/team/two-factor")
  const view = ((await team.json()) as { data: { required: boolean; members: Array<{ userId: string; enabled: boolean }> } }).data
  expect(view.required).toBe(true)
  expect(view.members.find((member) => member.userId === "u-2fa-reception")?.enabled).toBe(false)

  expect((await request("owner", "PUT", "/team/two-factor", { required: false })).status).toBe(200)
  expect((await request("reception", "GET", "/org-profile")).status).toBe(200)
})
