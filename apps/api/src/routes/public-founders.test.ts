process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { saasPlan, saasSignupPolicy, saasSubscription, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import type { MailMessage } from "@odentia/mail"
import { createSaasPlan, inviteFromWaitlist, type Storage, secretsKeyFromEnv } from "@odentia/services"
import { eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createApp } from "../app.js"

/**
 * Fundadores contra la app real (`createApp`, issue 165): la solicitud de la
 * web, los precios que publica, la invitación y el guard de
 * `organization/create`, que con «solo con invitación» no deja abrir una
 * clínica sin una invitación vigente de quien la abre.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const ADMIN = { userId: "founders-api-admin", role: "admin" as const }

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let foundersPlanId: string

/** Sesión fija y un `handler` de Better Auth que crea la organización como lo haría él. */
function authFor(email: string | null, created: { calls: number }): Auth {
  return {
    api: { getSession: async () => (email ? { user: { id: `u-${email}`, email }, session: {} } : null) },
    handler: async (req: Request) => {
      created.calls += 1
      const body = (await req.json()) as { name: string; slug: string }
      const id = `org-${body.slug}`
      await ownerDb.execute(sql`insert into "organization" ("id","name","slug","created_at") values (${id}, ${body.name}, ${body.slug}, now())`)
      return Response.json({ id, name: body.name, slug: body.slug })
    },
  } as unknown as Auth
}

function buildApp(auth: Auth, mailer = recordingMailer()): Hono {
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
    mailer,
    listenUrl: "postgres://localhost:5432/dentalagent",
    registrationRemoteAddress: () => `10.0.0.${Math.floor(Math.random() * 250)}`,
  })
}

function recordingMailer() {
  const sent: MailMessage[] = []
  return { sent, send: async (m: MailMessage) => void sent.push(m) }
}

function createOrg(app: Hono, slug: string, invitation?: string) {
  return app.request("/api/auth/organization/create", {
    method: "POST",
    headers: { "content-type": "application/json", ...(invitation ? { "x-odentia-invitation": invitation } : {}) },
    body: JSON.stringify({ name: `Clínica ${slug}`, slug }),
  })
}

const request = (email: string) => ({
  firstName: "Ana",
  lastName: "Quispe",
  email,
  phone: "+51 987 654 321",
  clinicName: "Clínica Sonrisa",
  countryCode: "PE",
  city: "Arequipa",
  dentists: "2-3",
  currentTool: "nada",
})

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
  await ownerDb.insert(user).values({ id: ADMIN.userId, name: "Administración", email: "admin@founders-api.test" })
  await createSaasPlan(ownerDb, ADMIN.userId, {
    code: "api-lista",
    name: "Plan odentIA",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 4_000_000,
    trialCreditCents: 10_000,
    trialMaxCreditCents: 10_000,
    isDefault: true,
    showOnWeb: true,
  })
  const founders = await createSaasPlan(ownerDb, ADMIN.userId, {
    code: "api-fundadores",
    name: "Fundadores",
    currency: "USD",
    priceCents: 0,
    conversationMicros: 300_000,
    consultationMicros: 240_000,
    recoveryMicros: 2_400_000,
    maxDiscountBps: 0,
    sellerDiscountBps: 0,
    trialCreditCents: 10_000,
    trialMaxCreditCents: 10_000,
    trialDays: 90,
    trialMaxDays: 90,
    seatLimit: 20,
    guaranteeMonths: 12,
    showOnWeb: true,
  })
  foundersPlanId = founders.id
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("la solicitud de la web se guarda, envía su copia una vez y valida lo que llega", async () => {
  const mailer = recordingMailer()
  const app = buildApp(authFor(null, { calls: 0 }), mailer)
  const send = (payload: unknown) =>
    app.request("/api/public/founders/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://www.odentia.localhost" },
      body: JSON.stringify(payload),
    })
  const res = await send(request("ana@sonrisa.test"))
  expect(res.status).toBe(201)
  expect(res.headers.get("access-control-allow-origin")).toBe("https://www.odentia.localhost")
  expect(mailer.sent.map((m) => m.to)).toEqual(["ana@sonrisa.test"])
  expect(mailer.sent[0]?.subject).toBe("Clínica Sonrisa está en la lista de odentIA")
  // Pedirlo otra vez no duplica la solicitud ni la copia.
  expect((await send(request("ana@sonrisa.test"))).status).toBe(201)
  expect(mailer.sent).toHaveLength(1)
  const bad = await send({ ...request("x@y.test"), dentists: "muchos" })
  expect(bad.status).toBe(400)
  expect(((await bad.json()) as { error: { message: string } }).error.message).toBe("Elige cuántos odontólogos atienden")
})

it("los precios publicados: solo lo que se muestra en la web y nunca los lugares", async () => {
  const res = await buildApp(authFor(null, { calls: 0 })).request("/api/public/founders/pricing")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { list: { code: string }; founders: { code: string; discountPercent: number }; signupMode: string }
  expect(body.list.code).toBe("api-lista")
  expect(body.founders).toMatchObject({ code: "api-fundadores", discountPercent: 40 })
  expect(body.signupMode).toBe("invitacion")
  expect(JSON.stringify(body)).not.toMatch(/seat/i)
})

it("con «solo con invitación», abrir una clínica pide la invitación de quien la abre", async () => {
  const created = { calls: 0 }
  const noInvite = await createOrg(buildApp(authFor("pedro@gmail.test", created)), "sin-invitacion")
  expect(noInvite.status).toBe(403)
  expect(((await noInvite.json()) as { error: { code: string } }).error.code).toBe("INVITATION_REQUIRED")
  expect(created.calls).toBe(0)

  const [row] = await ownerDb
    .insert(saasWaitlistRequest)
    .values({ ...request("rosa@norte.test"), dentists: "1", currentTool: "nada", phone: "+51911111111" })
    .returning({ id: saasWaitlistRequest.id })
  const { token } = await inviteFromWaitlist(ownerDb, ADMIN, row!.id)

  const invitation = await buildApp(authFor(null, created)).request(`/api/public/founders/invitation/${token}`)
  expect(invitation.status).toBe(200)
  const missing = await buildApp(authFor(null, created)).request("/api/public/founders/invitation/otro")
  expect(missing.status).toBe(404)

  // Con la invitación de otra persona, tampoco.
  const other = await createOrg(buildApp(authFor("pedro@gmail.test", created)), "ajena", token)
  expect(other.status).toBe(403)
  expect(created.calls).toBe(0)

  const ok = await createOrg(buildApp(authFor("rosa@norte.test", created)), "norte", token)
  expect(ok.status).toBe(200)
  expect(created.calls).toBe(1)
  const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, "org-norte"))
  expect(sub?.planId).toBe(foundersPlanId)
  const [after] = await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, row!.id))
  expect(after).toMatchObject({ status: "entro", organizationId: "org-norte" })

  // La misma invitación no abre una segunda clínica.
  const twice = await createOrg(buildApp(authFor("rosa@norte.test", created)), "norte-dos", token)
  expect(twice.status).toBe(403)
  expect(created.calls).toBe(1)
})

it("con el alta abierta, se abre sin invitación y con el plan por defecto", async () => {
  await ownerDb.update(saasSignupPolicy).set({ mode: "abierta" })
  const created = { calls: 0 }
  const res = await createOrg(buildApp(authFor("libre@clinica.test", created)), "libre")
  expect(res.status).toBe(200)
  expect(created.calls).toBe(1)
  const [plan] = await ownerDb.select().from(saasPlan).where(eq(saasPlan.code, "api-fundadores"))
  const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, "org-libre"))
  expect(sub?.planId).not.toBe(plan?.id)
  await ownerDb.update(saasSignupPolicy).set({ mode: "invitacion" })
})
