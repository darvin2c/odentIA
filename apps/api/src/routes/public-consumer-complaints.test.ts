process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { consumerComplaint } from "@odentia/db/schema/consumer-complaints"
import type { MailMessage } from "@odentia/mail"
import { type Storage, secretsKeyFromEnv } from "@odentia/services"
import { eq } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createApp } from "../app.js"

/**
 * Libro de Reclamaciones contra la app real (`createApp`): la ruta pública
 * guarda la hoja, envía la copia al consumidor y el aviso a odentIA, limita
 * por dirección (sin confiar en X-Forwarded-For), corta cuerpos grandes y es
 * idempotente por `submissionId`. Si el correo falla, la hoja queda guardada
 * y la respuesta lo dice.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const URL_PATH = "/api/public/libro-de-reclamaciones"
const COMPLAINTS_EMAIL = "reclamaciones@odentia.test"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const authStub = { api: { getSession: async () => null } } as unknown as Auth
const storageStub = {} as unknown as Storage

function buildApp(
  remoteAddress: string,
  mailer: { send: (m: MailMessage) => Promise<void> },
): Hono {
  return createApp({
    auth: authStub,
    db: appDb,
    ownerDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
    trustedOrigins: [],
    cookieDomain: "odentia.localhost",
    webURL: "https://app.odentia.localhost",
    adminURL: "https://admin.odentia.localhost",
    mailer,
    complaintsEmail: COMPLAINTS_EMAIL,
    listenUrl: "postgres://localhost:5432/dentalagent",
    registrationRemoteAddress: () => remoteAddress,
  })
}

/** Correo de prueba que guarda lo enviado. */
function recordingMailer() {
  const sent: MailMessage[] = []
  return { sent, send: async (m: MailMessage) => void sent.push(m) }
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    submissionId: crypto.randomUUID(),
    kind: "queja",
    consumerName: "Luis Pérez <b>Rojas</b>",
    consumerAddress: "Jr. Puno 456, Cercado de Lima",
    documentType: "CE",
    documentNumber: "001234567",
    phone: "987654321",
    email: "luis@ejemplo.pe",
    isMinor: false,
    itemType: "servicio",
    itemDescription: "Soporte de odentIA",
    amount: "",
    currency: null,
    detail: "Esperé tres días una respuesta de soporte sin recibir ninguna.",
    request: "Que me respondan y mejoren los tiempos de soporte.",
    privacyAccepted: true,
    ...overrides,
  }
}

function post(app: Hono, payload: unknown, headers: Record<string, string> = {}) {
  return app.request(URL_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  })
}

type Ok = { data: { number: string; createdAt: string; emailSent: boolean } }
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
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("guarda la hoja, envía la copia al consumidor y el aviso a odentIA", async () => {
  const mailer = recordingMailer()
  const res = await post(buildApp("ok", mailer), body(), {
    origin: "https://www.odentia.localhost",
  })
  expect(res.status).toBe(200)
  expect(res.headers.get("cache-control")).toBe("no-store")
  // La web vive en www.<dominio>: el CORS global la acepta como subdominio.
  expect(res.headers.get("access-control-allow-origin")).toBe("https://www.odentia.localhost")
  const { data } = (await res.json()) as Ok
  expect(data.number).toMatch(/^\d{4}-\d{6}$/)
  expect(data.emailSent).toBe(true)
  expect(Number.isNaN(Date.parse(data.createdAt))).toBe(false)

  expect(mailer.sent.map((m) => m.to)).toEqual(["luis@ejemplo.pe", COMPLAINTS_EMAIL])
  const copy = mailer.sent[0]!
  expect(copy.subject).toContain(data.number)
  expect(copy.text).toContain("Queja")
  expect(copy.html).toContain("Luis Pérez &lt;b&gt;Rojas&lt;/b&gt;")
  expect(copy.html).not.toContain("<b>Rojas</b>")

  const [row] = await ownerDb
    .select()
    .from(consumerComplaint)
    .where(eq(consumerComplaint.number, data.number))
  expect(row?.emailSent).toBe(true)
  expect(row?.kind).toBe("queja")
  expect(row?.documentNumber).toBe("001234567")
})

it("si el correo falla, la hoja queda guardada y la respuesta lo dice", async () => {
  const app = buildApp("mail-down", {
    send: async () => {
      throw new Error("SMTP caído")
    },
  })
  const res = await post(app, body())
  expect(res.status).toBe(200)
  const { data } = (await res.json()) as Ok
  expect(data.emailSent).toBe(false)
  const [row] = await ownerDb
    .select()
    .from(consumerComplaint)
    .where(eq(consumerComplaint.number, data.number))
  expect(row?.emailSent).toBe(false)
})

it("valida la hoja y responde 400 con el motivo en español", async () => {
  const mailer = recordingMailer()
  const app = buildApp("validation", mailer)
  const minor = await post(app, body({ isMinor: true, guardianName: "" }))
  expect(minor.status).toBe(400)
  const minorBody = (await minor.json()) as Err
  expect(minorBody.error.code).toBe("VALIDATION")
  expect(minorBody.error.message).toMatch(/padre, madre o apoderado/)
  expect((await post(app, body({ kind: "sugerencia" }))).status).toBe(400)
  expect((await post(app, body({ extra: "campo de más" }))).status).toBe(400)
  expect((await post(app, "{no es json")).status).toBe(400)
  expect(mailer.sent).toHaveLength(0)
})

it("reenviar el mismo submissionId devuelve la misma hoja sin repetir correos", async () => {
  const mailer = recordingMailer()
  const app = buildApp("idem", mailer)
  const payload = body()
  const first = (await (await post(app, payload)).json()) as Ok
  const again = await post(app, {
    ...payload,
    detail: "Un texto distinto que no reemplaza la hoja guardada.",
  })
  expect(again.status).toBe(200)
  const second = (await again.json()) as Ok
  expect(second.data).toEqual(first.data)
  expect(mailer.sent).toHaveLength(2)
  const rows = await ownerDb
    .select({ id: consumerComplaint.id })
    .from(consumerComplaint)
    .where(eq(consumerComplaint.submissionId, payload.submissionId))
  expect(rows).toHaveLength(1)
})

it("límite: 5 envíos por dirección cada 10 minutos, sin confiar en X-Forwarded-For", async () => {
  const app = buildApp("rate", recordingMailer())
  for (let i = 0; i < 5; i++) {
    const res = await post(
      app,
      { submissionId: "no-es-uuid" },
      { "X-Forwarded-For": `10.0.0.${i}` },
    )
    expect(res.status).toBe(400)
  }
  const limited = await post(app, body(), { "X-Forwarded-For": "99.99.99.99" })
  expect(limited.status).toBe(429)
  expect(limited.headers.get("retry-after")).toBeTruthy()
  expect(((await limited.json()) as Err).error.code).toBe("RATE_LIMITED")
  // Otra dirección sigue pudiendo reclamar.
  expect((await post(buildApp("rate-otra", recordingMailer()), body())).status).toBe(200)
})

it("un cuerpo de más de 32 KiB responde 413", async () => {
  const res = await post(
    buildApp("oversize", recordingMailer()),
    body({ detail: "x".repeat(40_000) }),
  )
  expect(res.status).toBe(413)
  expect(((await res.json()) as Err).error.code).toBe("BODY_TOO_LARGE")
})

it("es terminal: otro método u otra ruta no siguen hacia las rutas con sesión", async () => {
  const app = buildApp("terminal", recordingMailer())
  expect((await app.request(URL_PATH, { method: "GET" })).status).toBe(404)
  expect((await app.request(`${URL_PATH}/2026-000001`, { method: "GET" })).status).toBe(404)
})
