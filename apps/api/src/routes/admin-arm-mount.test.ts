process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { fakeKairosWriter, type KairosWriter } from "@odentia/agent"
import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { type Storage, secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { type AppDeps, createApp } from "../app.js"
import { signInboundEmail } from "./inbound-email.js"

/**
 * El ARM montado en la app real (ADR 0185): las rutas de la administración
 * detrás de su sesión, su segundo factor y su origen; el correo entrante fuera
 * de ellas, con su propia firma; y el Kairós que recibe la app es el que usan
 * las rutas.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const ADMIN = "https://admin.odentia.localhost"
const SECRET = "s".repeat(40)

let container: StartedTestContainer
let ownerDb: Db
let app: Hono
let noSecret: Hono
const annotated: string[] = []

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

/** El doble de siempre, salvo Anotar: así se ve que la app le pasa este Kairós a la ruta. */
const kairos: KairosWriter = {
  ...fakeKairosWriter,
  parseAnnotation: async (input) => {
    annotated.push(input.text)
    return fakeKairosWriter.parseAnnotation(input)
  },
}

function admin(
  method: string,
  path: string,
  user: string,
  body?: unknown,
  origin: string | null = ADMIN,
) {
  const headers = new Headers({ "x-test-user": user })
  if (origin) headers.set("origin", origin)
  if (body !== undefined) headers.set("content-type", "application/json")
  return app.request(`/api/admin${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function code(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code
}

async function staff(id: string, role: "admin" | "support") {
  await ownerDb.execute(
    sql`insert into "user" (id, name, email, email_verified) values (${id}, ${id}, ${`${id}@example.test`}, true)`,
  )
  await ownerDb.insert(adminStaff).values({ userId: id, role })
  await ownerDb
    .insert(twoFactor)
    .values({ id: `f-${id}`, userId: id, secret: "x", backupCodes: "[]", verified: true })
  await ownerDb.insert(adminSessionVerification).values({
    userId: id,
    sessionId: `s-${id}`,
    factorId: `f-${id}`,
    method: "totp",
    expiresAt: new Date(Date.now() + 3_600_000),
  })
}

function inbound(target: Hono, messageId: string, signature?: string) {
  const raw = JSON.stringify({
    mailbox: "soporte",
    product: "dental",
    messageId,
    from: "dra.ana@clinica-montaje.test",
    fromName: "Dra. Ana",
    to: "soporte@odentia32.com",
    subject: "Una consulta",
    text: "Hola.",
    receivedAt: new Date().toISOString(),
    attachments: [],
  })
  const timestamp = Math.floor(Date.now() / 1000)
  return target.request("/api/inbound/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sallca-timestamp": String(timestamp),
      "x-sallca-signature": signature ?? signInboundEmail(SECRET, raw, timestamp),
    },
    body: raw,
  })
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
  const deps: AppDeps = {
    auth: authStub,
    db: createAppDb(`postgres://dentalagent_app:dentalagent_app@${url}`),
    ownerDb,
    secretsKey: KEY,
    storage: {
      putAttachmentAt: async () => {},
      deleteAttachment: async () => {},
    } as unknown as Storage,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
    trustedOrigins: [ADMIN],
    cookieDomain: "odentia.localhost",
    webURL: "https://app.odentia.localhost",
    adminURL: ADMIN,
    mailer: { send: async () => {} },
    listenUrl: "postgres://localhost:5432/dentalagent",
  }
  app = createApp({ ...deps, kairos, inboundEmailSecret: SECRET })
  noSecret = createApp(deps)
  await staff("u-admin", "admin")
  await staff("u-soporte", "support")
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("clientes, Kairós y reportes responden detrás de la guarda de la administración", async () => {
  expect((await admin("GET", "/clients?view=todos", "u-admin")).status).toBe(200)
  const count = await admin("GET", "/kairos/count", "u-soporte")
  expect(count.status).toBe(200)
  expect(((await count.json()) as { data: { waiting: number } }).data.waiting).toBeTypeOf("number")
  expect((await admin("GET", "/reports/funnel", "u-admin")).status).toBe(200)
  // Montada, no 404: Soporte no ve Reportes.
  const denied = await admin("GET", "/reports/funnel", "u-soporte")
  expect(denied.status).toBe(403)
  expect(await code(denied)).toBe("FORBIDDEN")
  // Sin sesión, la guarda de siempre; sin el origen de la administración, nada se escribe.
  expect((await app.request("/api/admin/clients")).status).toBe(401)
  const noOrigin = await admin("POST", "/clients", "u-admin", { name: "X" }, null)
  expect(noOrigin.status).toBe(403)
  expect(await code(noOrigin)).toBe("ADMIN_ORIGIN_REQUIRED")
  expect((await admin("GET", "/nada-de-esto", "u-admin")).status).toBe(404)
})

it("Anotar usa el Kairós que recibe la app", async () => {
  const created = await admin("POST", "/clients", "u-soporte", {
    name: "Clínica Montaje (ficticia)",
    product: "dental",
    contact: { name: "Luis Mamani", email: "luis@montaje.test" },
    origin: "referido",
  })
  expect(created.status).toBe(201)
  const { id } = ((await created.json()) as { data: { id: string } }).data
  const preview = await admin("POST", `/clients/${id}/annotate/preview`, "u-soporte", {
    text: "Llamé a Luis, quiere una presentación el jueves",
  })
  expect(preview.status).toBe(200)
  expect(annotated).toEqual(["Llamé a Luis, quiere una presentación el jueves"])
})

it("el correo entrante pasa con su firma y sin secreto no se recibe", async () => {
  expect((await inbound(app, "<montaje-1@test>")).status).toBe(201)
  const forged = await inbound(app, "<montaje-2@test>", `sha256=${"0".repeat(64)}`)
  expect(forged.status).toBe(401)
  expect((await inbound(noSecret, "<montaje-3@test>")).status).toBe(503)
  expect((await app.request("/api/inbound/otra-cosa", { method: "POST" })).status).toBe(404)
})

it("Equipo: Administración corrige la dirección de una persona y su copia; Soporte no", async () => {
  const team = await admin("GET", "/access/team", "u-admin")
  expect(team.status).toBe(200)
  const { staff: people } = (
    (await team.json()) as {
      data: {
        staff: Array<{ userId: string; mailLocal: string | null; mailFirstSentAt: string | null }>
      }
    }
  ).data
  // La base les puso su dirección al crear la fila.
  expect(people.find((row) => row.userId === "u-soporte")).toMatchObject({
    mailLocal: "u.soporte",
    mailFirstSentAt: null,
  })
  const denied = await admin("POST", "/access/team/u-soporte/mail", "u-soporte", {
    mailLocal: "sofi",
  })
  expect(denied.status).toBe(403)
  const changed = await admin("POST", "/access/team/u-soporte/mail", "u-admin", {
    mailLocal: "sofia",
    copyTo: "sofia@gmail.test",
  })
  expect(changed.status).toBe(200)
  expect(((await changed.json()) as { data: { mailLocal: string } }).data.mailLocal).toBe("sofia")
  const reserved = await admin("POST", "/access/team/u-soporte/mail", "u-admin", {
    mailLocal: "hola",
  })
  expect(reserved.status).toBe(400)
  const taken = await admin("POST", "/access/team/u-soporte/mail", "u-admin", {
    mailLocal: "u.admin",
  })
  expect(taken.status).toBe(409)
  expect(await code(taken)).toBe("MAIL_LOCAL_TAKEN")
  // Después del primer correo que salió con ella, queda fija.
  await ownerDb
    .update(adminStaff)
    .set({ mailFirstSentAt: new Date() })
    .where(sql`user_id = 'u-soporte'`)
  const fixed = await admin("POST", "/access/team/u-soporte/mail", "u-admin", { mailLocal: "sofi" })
  expect(fixed.status).toBe(409)
  expect(await code(fixed)).toBe("MAIL_LOCAL_FIXED")
})
