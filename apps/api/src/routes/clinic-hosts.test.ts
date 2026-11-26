process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import {
  type ClinicHosts,
  type HostsFirewall,
  type Storage,
  secretsKeyFromEnv,
  syncClinicHosts,
} from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { createApp } from "../app.js"

/**
 * Solo los subdominios de clínicas reales llegan a las pantallas (ADR 0193): abrir una
 * clínica pone al día la regla de hosts permitidos de cada zona antes de responder, con
 * lo que hay en la base. Cloudflare es un doble que guarda lo que se le pidió.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ab".repeat(32))
const ODENTIA = "0123456789abcdef0123456789abcdef"
const LATIDIA = "fedcba9876543210fedcba9876543210"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

/** Lo que recibió Cloudflare, por zona: la última expresión de cada una. */
function recordingFirewall(fail: ReadonlySet<string> = new Set()) {
  const rules = new Map<string, string>()
  const putRule = vi.fn<HostsFirewall["putRule"]>(async (zoneId, rule) => {
    if (fail.has(zoneId)) throw new Error("Cloudflare respondió 503")
    rules.set(zoneId, rule.expression)
    return "cambiada"
  })
  return { rules, putRule }
}

function hostsWith(firewall: HostsFirewall): ClinicHosts {
  return {
    firewall,
    domains: {
      dental: "odentia.localhost",
      medical: "latidia.localhost",
      optical: "odentia.localhost",
    },
    zones: [
      { zoneId: ODENTIA, domain: "odentia.localhost" },
      { zoneId: LATIDIA, domain: "latidia.localhost" },
    ],
  }
}

/** La sesión de quien dice `x-test-user` (sin decirlo, la dueña) y un `handler` de Better Auth que crea la organización como él. */
const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-user") ?? "u-hosts"
      return {
        user: { id, email: `${id}@hosts.test`, emailVerified: true, name: id },
        session: { id: `s-${id}`, createdAt: new Date() },
      }
    },
  },
  handler: async (req: Request) => {
    const body = (await req.json()) as { name: string; slug: string }
    const id = `org-${body.slug}`
    await ownerDb.execute(
      sql`insert into "organization" ("id","name","slug","created_at") values (${id}, ${body.name}, ${body.slug}, now())`,
    )
    return Response.json({ id, name: body.name, slug: body.slug })
  },
} as unknown as Auth

function buildApp(clinicHosts: ClinicHosts): Hono {
  return createApp({
    auth,
    db: appDb,
    ownerDb,
    secretsKey: KEY,
    storage: {} as unknown as Storage,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
    trustedOrigins: [],
    cookieDomain: "odentia.localhost",
    webURL: "https://app.odentia.localhost",
    adminURL: "https://admin.odentia.localhost",
    mailer: { send: async () => undefined },
    listenUrl: "postgres://localhost:5432/dentalagent",
    productDomains: { medical: "latidia.localhost", optical: undefined },
    clinicHosts,
  })
}

const createOrg = (app: Hono, slug: string) =>
  app.request("/api/auth/organization/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Clínica ${slug}`, slug }),
  })

/** Una clínica que ya tiene su perfil, con su producto. */
async function insertClinic(id: string, slug: string, product: string) {
  await ownerDb.execute(
    sql`insert into "organization" ("id","name","slug","created_at") values (${id}, ${slug}, ${slug}, now())`,
  )
  await ownerDb.execute(sql`insert into "org_profile" ("organization_id","product","legal_name","country_code","currency","timezone","locale")
    values (${id}, ${product}, ${slug}, 'PE', 'PEN', 'America/Lima', 'es-PE')`)
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
  const host = container.getHost()
  const port = container.getMappedPort(5432)
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}:${port}/dentalagent`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}:${port}/dentalagent`)
  // Administración, con su segundo factor en esta sesión: pide y borra las demos.
  await ownerDb.insert(user).values({
    id: "u-admin",
    name: "Administración",
    email: "u-admin@hosts.test",
    emailVerified: true,
  })
  await ownerDb.insert(adminStaff).values({ userId: "u-admin", role: "admin" })
  await ownerDb
    .insert(twoFactor)
    .values({ id: "f-admin", userId: "u-admin", secret: "x", backupCodes: "[]", verified: true })
  await ownerDb.insert(adminSessionVerification).values({
    userId: "u-admin",
    sessionId: "s-u-admin",
    factorId: "f-admin",
    method: "totp",
    expiresAt: new Date(Date.now() + 3_600_000),
  })
  await ownerDb
    .insert(user)
    .values({ id: "u-presenta", name: "Quien presenta", email: "presenta@hosts.test" })
  await insertClinic("org-sonrisa", "sonrisa", "dental")
  await insertClinic("org-sanmartin", "sanmartin", "medical")
  // Una demo pedida: tiene su subdominio antes de que el worker arme su clínica.
  await ownerDb.execute(sql`insert into admin.saas_demo ("product","kind","size","months","country_code","name","slug","presenter_user_id","created_by","seed")
    values ('medical', 'pediatria', 'pequeno', 6, 'PE', 'Pediatría Los Olivos', 'los-olivos', 'u-presenta', 'u-presenta', 7)`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

afterEach(() => vi.restoreAllMocks())

it("abrir una clínica pone al día la regla de cada zona antes de responder", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  const { rules, putRule } = recordingFirewall()
  const res = await createOrg(buildApp(hostsWith({ putRule })), "recien-abierta")
  expect(res.status).toBe(200)
  // Las dos zonas, ya publicadas cuando llega la respuesta.
  expect(putRule).toHaveBeenCalledTimes(2)
  const odentia = rules.get(ODENTIA) ?? ""
  const latidia = rules.get(LATIDIA) ?? ""
  // Sin perfil todavía no dice su producto: entra en las dos.
  expect(odentia).toContain('"recien-abierta.odentia.localhost"')
  expect(latidia).toContain('"recien-abierta.latidia.localhost"')
  // Cada clínica con perfil, solo en el dominio de su producto; la demo pedida, también.
  expect(odentia).toContain('"sonrisa.odentia.localhost"')
  expect(odentia).not.toContain("sanmartin")
  expect(latidia).toContain('"sanmartin.latidia.localhost"')
  expect(latidia).toContain('"los-olivos.latidia.localhost"')
  expect(latidia).not.toContain("sonrisa")
})

it("si Cloudflare falla, la clínica se abre igual y lo dice el registro; la otra zona se publica", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
  const { rules, putRule } = recordingFirewall(new Set([ODENTIA]))
  const res = await createOrg(buildApp(hostsWith({ putRule })), "aunque-falle")
  expect(res.status).toBe(200)
  expect(error.mock.calls.join(" ")).toContain(
    "Cloudflare no tomó la regla de odentia.localhost; se reintenta en la reconciliación",
  )
  expect(rules.get(LATIDIA)).toContain('"aunque-falle.latidia.localhost"')
  const [row] = await ownerDb.execute<{ id: string }>(
    sql`select id from organization where slug = 'aunque-falle'`,
  )
  expect(row?.id).toBe("org-aunque-falle")
})

it("lo que no se guardó no toca Cloudflare", async () => {
  const { putRule } = recordingFirewall()
  const res = await createOrg(buildApp(hostsWith({ putRule })), "www")
  expect(res.status).toBe(400)
  expect(putRule).not.toHaveBeenCalled()
})

it("pedir una demo pone su subdominio en la regla antes de que el worker la arme", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  const { rules, putRule } = recordingFirewall()
  const res = await buildApp(hostsWith({ putRule })).request("/api/admin/demos", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://admin.odentia.localhost",
      "x-test-user": "u-admin",
    },
    body: JSON.stringify({
      product: "dental",
      kind: "general",
      size: "pequeno",
      months: 6,
      countryCode: "PE",
      name: "Demo de hosts",
      presenterUserId: "u-admin",
    }),
  })
  expect(res.status).toBe(201)
  const { data } = (await res.json()) as { data: { slug: string } }
  expect(rules.get(ODENTIA)).toContain(`"${data.slug}.odentia.localhost"`)
  expect(rules.get(LATIDIA)).not.toContain(data.slug)
})

it("el alta asistida y las demos sincronizan solo para el personal: un pedido de afuera no llega a Cloudflare", async () => {
  const { putRule } = recordingFirewall()
  const app = buildApp(hostsWith({ putRule }))
  for (const [method, path] of [
    ["POST", "/api/admin/demos"],
    ["DELETE", "/api/admin/demos/una"],
    ["POST", "/api/admin/organizations/assisted"],
  ] as const) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
  }
  expect(putRule).not.toHaveBeenCalled()
})

it("la reconciliación sigue a la clínica que cambió de subdominio", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  const { rules, putRule } = recordingFirewall()
  await ownerDb.execute(
    sql`update organization set slug = 'sonrisa-norte' where id = 'org-sonrisa'`,
  )
  const results = await syncClinicHosts(ownerDb, hostsWith({ putRule }))
  expect(results).toEqual([
    { domain: "odentia.localhost", outcome: "cambiada" },
    { domain: "latidia.localhost", outcome: "cambiada" },
  ])
  expect(rules.get(ODENTIA)).toContain('"sonrisa-norte.odentia.localhost"')
  expect(rules.get(ODENTIA)).not.toContain('"sonrisa.odentia.localhost"')
})
