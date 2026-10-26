process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { adminAudit, adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { consumerComplaint } from "@odentia/db/schema/consumer-complaints"
import type { MailMessage } from "@odentia/mail"
import { type Storage, secretsKeyFromEnv, submitConsumerComplaint, trustAdminDevice } from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createApp } from "../app.js"

/**
 * Libro de Reclamaciones en la administración contra la app real
 * (`createApp`): el guard (personal, segundo factor y origen administrativo),
 * la lista, el detalle, la respuesta con su correo y su copia al buzón, el
 * conflicto de responder dos veces y el reenvío a mano si el correo falló.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const ADMIN = "https://admin.odentia.localhost"
const BASE = "/api/admin/consumer-complaints"
const COMPLAINTS_EMAIL = "reclamaciones@odentia.test"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

/** La sesión la elige la cabecera `x-test-user`: id de usuario y de sesión iguales. */
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

function recordingMailer(failFor: string[] = []) {
  const sent: MailMessage[] = []
  return {
    sent,
    fail: failFor,
    send: async (m: MailMessage) => {
      if (failFor.includes(m.to)) throw new Error("SMTP caído")
      sent.push(m)
    },
  }
}

function buildApp(mailer: { send: (m: MailMessage) => Promise<void> }): Hono {
  return createApp({
    auth: authStub,
    db: appDb,
    ownerDb,
    secretsKey: KEY,
    storage: {} as unknown as Storage,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
    trustedOrigins: [ADMIN],
    cookieDomain: "odentia.localhost",
    webURL: "https://app.odentia.localhost",
    adminURL: ADMIN,
    mailer,
    complaintsEmail: COMPLAINTS_EMAIL,
    listenUrl: "postgres://localhost:5432/dentalagent",
  })
}

function call(app: Hono, path: string, user: string, init: RequestInit = {}, origin = ADMIN) {
  const headers = new Headers(init.headers)
  headers.set("x-test-user", user)
  if (origin) headers.set("origin", origin)
  if (init.body) headers.set("content-type", "application/json")
  return app.request(`${BASE}${path}`, { ...init, headers })
}

const respond = (app: Hono, id: string, user: string, response: string, origin = ADMIN) =>
  call(app, `/${id}/response`, user, { method: "POST", body: JSON.stringify({ response }) }, origin)

/** Personal con su segundo factor verificado en la sesión (o sin verificar). */
async function staff(id: string, name: string, role: "admin" | "support", verified = true) {
  await ownerDb.execute(
    sql`insert into "user" (id, name, email, email_verified) values (${id}, ${name}, ${`${id}@example.test`}, true)`,
  )
  await ownerDb.insert(adminStaff).values({ userId: id, role })
  await ownerDb.insert(twoFactor).values({ id: `f-${id}`, userId: id, secret: "x", backupCodes: "[]", verified: true })
  if (verified) {
    await ownerDb.insert(adminSessionVerification).values({
      userId: id,
      sessionId: `s-${id}`,
      factorId: `f-${id}`,
      method: "totp",
      expiresAt: new Date(Date.now() + 3_600_000),
    })
  }
}

async function newSheet(email = "rosa@ejemplo.pe") {
  const { sheet } = await ownerDb.transaction((tx) =>
    submitConsumerComplaint(tx, {
      submissionId: crypto.randomUUID(),
      kind: "reclamo",
      consumerName: "Rosa Díaz Quispe",
      consumerAddress: "Av. Larco 123, Miraflores, Lima",
      documentType: "DNI",
      documentNumber: "45678912",
      phone: "+51 987 654 321",
      email,
      itemType: "servicio",
      itemDescription: "Suscripción mensual de odentIA",
      detail: "Me cobraron dos veces la suscripción del mes de octubre.",
      request: "Que me devuelvan el cobro duplicado.",
      privacyAccepted: true,
    }),
  )
  return sheet
}

type Err = { error: { code: string; message: string } }

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
  const host = container.getHost()
  const port = container.getMappedPort(5432)
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}:${port}/dentalagent`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}:${port}/dentalagent`)
  await staff("u-darvin", "Darvin", "admin")
  await staff("u-sofia", "Sofía", "support")
  await staff("u-sin-factor", "Sin factor", "admin", false)
  await ownerDb.execute(
    sql`insert into "user" (id, name, email, email_verified) values ('u-clinica', 'Dueña de clínica', 'u-clinica@example.test', true)`,
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("solo el personal con su segundo factor y desde la administración", async () => {
  const app = buildApp(recordingMailer())
  const sheet = await newSheet()
  expect((await call(app, "", "u-clinica")).status).toBe(403)
  const noFactor = await call(app, "", "u-sin-factor")
  expect(noFactor.status).toBe(403)
  expect(((await noFactor.json()) as Err).error.code).toBe("MFA_REQUIRED")
  const elsewhere = await respond(app, sheet.id, "u-darvin", "Respuesta desde otra página.", "https://clinica.odentia.localhost")
  expect(elsewhere.status).toBe(403)
  expect(((await elsewhere.json()) as Err).error.code).toBe("ADMIN_ORIGIN_REQUIRED")
  const [row] = await ownerDb.select().from(consumerComplaint).where(eq(consumerComplaint.id, sheet.id))
  expect(row?.status).toBe("recibido")
})

it("un equipo reconocido abre la administración sin código, salvo desde otro país (ADR 0090)", async () => {
  const app = buildApp(recordingMailer())
  // «Sin factor» tiene factor sin marca de sesión: sin equipo reconocido se le pide.
  const token = await trustAdminDevice(ownerDb, {
    userId: "u-sin-factor",
    factorId: "f-u-sin-factor",
    country: "PE",
    currentToken: null,
  })
  const fromDevice = (country: string) =>
    call(app, "", "u-sin-factor", { headers: { cookie: `odentia_admin_device=${token}`, "cf-ipcountry": country } })
  const home = await fromDevice("PE")
  expect(home.status).toBe(200)
  // Cada uso renueva la cookie del equipo por 30 días, solo para la API.
  expect(home.headers.get("set-cookie")).toMatch(/odentia_admin_device=.+Path=\/api; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax/)
  const abroad = await call(app, "", "u-sin-factor", {
    headers: { cookie: `odentia_admin_device=${token}`, "cf-ipcountry": "CL" },
  })
  expect(abroad.status).toBe(403)
  expect(((await abroad.json()) as Err).error.code).toBe("MFA_REQUIRED")
})

it("lista, resume y abre la hoja completa; abrirla queda auditado", async () => {
  const app = buildApp(recordingMailer())
  const sheet = await newSheet()
  const list = await call(app, "?status=recibido", "u-sofia")
  expect(list.status).toBe(200)
  expect(list.headers.get("cache-control")).toBe("no-store")
  const { data } = (await list.json()) as {
    data: { items: { id: string; number: string; timeline: { daysLeft: number; dueDate: string } }[]; summary: { pending: number } }
  }
  const item = data.items.find((i) => i.id === sheet.id)
  expect(item?.number).toBe(sheet.number)
  expect(item?.timeline.daysLeft).toBeGreaterThanOrEqual(14)
  expect(data.summary.pending).toBeGreaterThanOrEqual(1)

  const summary = (await (await call(app, "/summary", "u-sofia")).json()) as { data: { pending: number } }
  expect(summary.data.pending).toBe(data.summary.pending)

  const detail = await call(app, `/${sheet.id}`, "u-sofia")
  expect(detail.status).toBe(200)
  const body = (await detail.json()) as { data: { documentNumber: string; detail: string } }
  expect(body.data.documentNumber).toBe("45678912")
  const audits = await ownerDb
    .select()
    .from(adminAudit)
    .where(and(eq(adminAudit.action, "consumer_complaint.view"), eq(adminAudit.entityId, sheet.id)))
  expect(audits.map((a) => a.actorUserId)).toEqual(["u-sofia"])
  expect((await call(app, `/${crypto.randomUUID()}`, "u-sofia")).status).toBe(404)
})

it("responde, envía la respuesta a quien reclamó con copia al buzón y no deja responder dos veces", async () => {
  const mailer = recordingMailer()
  const app = buildApp(mailer)
  const sheet = await newSheet()
  const short = await respond(app, sheet.id, "u-darvin", "ok")
  expect(short.status).toBe(400)

  const res = await respond(app, sheet.id, "u-darvin", "Hola, Rosa. <b>Ya</b> pedimos la devolución del segundo cobro.")
  expect(res.status).toBe(200)
  const { data } = (await res.json()) as {
    data: { status: string; responseEmailSent: boolean; respondedByName: string; providerResponse: string }
  }
  expect(data.status).toBe("respondido")
  expect(data.responseEmailSent).toBe(true)
  expect(data.respondedByName).toBe("Darvin")
  expect(mailer.sent.map((m) => m.to)).toEqual(["rosa@ejemplo.pe", COMPLAINTS_EMAIL])
  expect(mailer.sent[0]?.subject).toContain(sheet.number)
  expect(mailer.sent[0]?.html).toContain("&lt;b&gt;Ya&lt;/b&gt;")
  expect(mailer.sent[0]?.html).not.toContain("<b>Ya</b>")

  const [row] = await ownerDb.select().from(consumerComplaint).where(eq(consumerComplaint.id, sheet.id))
  expect(row?.responseEmailSent).toBe(true)
  expect(row?.respondedByUserId).toBe("u-darvin")
  const [audit] = await ownerDb
    .select()
    .from(adminAudit)
    .where(and(eq(adminAudit.action, "consumer_complaint.respond"), eq(adminAudit.entityId, sheet.id)))
  expect(audit?.actorUserId).toBe("u-darvin")
  expect(audit?.actorRole).toBe("admin")

  const twice = await respond(app, sheet.id, "u-sofia", "Otra respuesta que no debe quedar.")
  expect(twice.status).toBe(409)
  expect(((await twice.json()) as Err).error.message).toBe("Darvin ya respondió esta hoja")
  expect(mailer.sent).toHaveLength(2)
})

it("si el correo no sale, la respuesta queda guardada y se reenvía a mano una sola vez", async () => {
  const email = "caido@ejemplo.pe"
  const sheet = await newSheet(email)
  const failing = recordingMailer([email])
  const res = await respond(buildApp(failing), sheet.id, "u-sofia", "Respuesta cuyo correo no sale la primera vez.")
  expect(res.status).toBe(200)
  expect(((await res.json()) as { data: { responseEmailSent: boolean } }).data.responseEmailSent).toBe(false)
  // No se reintenta solo: la persona no recibió nada; el buzón sí tiene su copia.
  expect(failing.sent.map((m) => m.to)).toEqual([COMPLAINTS_EMAIL])

  const working = recordingMailer()
  const app = buildApp(working)
  const resend = await call(app, `/${sheet.id}/response-email`, "u-darvin", { method: "POST" })
  expect(resend.status).toBe(200)
  expect(((await resend.json()) as { data: { responseEmailSent: boolean } }).data.responseEmailSent).toBe(true)
  // El reenvío no repite la copia al buzón.
  expect(working.sent.map((m) => m.to)).toEqual([email])
  const again = await call(app, `/${sheet.id}/response-email`, "u-darvin", { method: "POST" })
  expect(again.status).toBe(409)
  const audits = await ownerDb
    .select()
    .from(adminAudit)
    .where(and(eq(adminAudit.action, "consumer_complaint.response_email.resend"), eq(adminAudit.entityId, sheet.id)))
  expect(audits.map((a) => a.actorUserId)).toEqual(["u-darvin"])
})
