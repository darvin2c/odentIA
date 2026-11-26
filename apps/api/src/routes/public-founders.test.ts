process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { saasClient, saasClientContact, saasWebContact } from "@odentia/db/schema/admin-arm"
import { user } from "@odentia/db/schema/auth"
import { saasPlan, saasSignupPolicy, saasSubscription, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import type { MailMessage } from "@odentia/mail"
import { createSaasPlan, inviteFromWaitlist, type Storage, secretsKeyFromEnv, WEB_CONTACTS_PER_HOUR } from "@odentia/services"
import { eq, like, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../app.js"
import { createPublicFoundersRoute } from "./public-founders.js"

/**
 * Lo público de la web contra la app real (`createApp`): los precios que publica, la
 * invitación de la administración, el correo de las guías y el guard de
 * `organization/create`. El alta es libre (ADR 0221): sin invitación se abre la clínica
 * con la prueba del plan de lista; con ella, solo quien fue invitado y con su plan.
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
    productDomains: { medical: "latidia.localhost", optical: "vistia.localhost" },
    registrationRemoteAddress: () => `10.0.0.${Math.floor(Math.random() * 250)}`,
  })
}

function recordingMailer() {
  const sent: MailMessage[] = []
  return { sent, send: async (m: MailMessage) => void sent.push(m) }
}

function createOrg(app: Hono, slug: string, invitation?: string, origin = "") {
  return app.request(`${origin}/api/auth/organization/create`, {
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
  professionals: "2-3",
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
    guaranteeMonths: 12,
  })
  foundersPlanId = founders.id
  // La política vieja de alta, como la dejaba la base antes del alta libre: el guard ya no la lee.
  await ownerDb.update(saasSignupPolicy).set({ mode: "invitacion", medicalMode: "invitacion", opticalMode: "invitacion" })
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("la web ya no recibe solicitudes para la lista de espera", async () => {
  const res = await buildApp(authFor(null, { calls: 0 })).request("/api/public/founders/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://www.odentia.localhost" },
    body: JSON.stringify(request("ana@sonrisa.test")),
  })
  // La ruta ya no existe: la petición sigue al resto de la API, que pide sesión, y no se guarda nada.
  expect(res.status).toBe(401)
  expect(await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.email, "ana@sonrisa.test"))).toEqual([])
})

it("los precios publicados: solo el plan de lista y las condiciones, nunca un plan especial ni lugares", async () => {
  const res = await buildApp(authFor(null, { calls: 0 })).request("/api/public/founders/pricing")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { list: { code: string }; terms: Record<string, unknown> }
  expect(Object.keys(body).sort()).toEqual(["list", "terms"])
  expect(body.list.code).toBe("api-lista")
  expect(body.terms).not.toHaveProperty("waitlistAnswerDays")
  expect(JSON.stringify(body)).not.toMatch(/seat|fundadores|signupMode/i)
})

it("sin invitación se abre la clínica con la prueba del plan de lista, aunque la política vieja diga «solo con invitación»", async () => {
  const created = { calls: 0 }
  const res = await createOrg(buildApp(authFor("libre@clinica.test", created)), "libre")
  expect(res.status).toBe(200)
  expect(created.calls).toBe(1)
  // Nace en prueba y nunca con el plan especial: ese llega solo con la invitación.
  const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, "org-libre"))
  expect(sub?.status).toBe("prueba")
  expect(sub?.planId).not.toBe(foundersPlanId)
})

it("con la invitación de la administración, solo quien fue invitado abre una clínica, una vez y con su plan", async () => {
  const created = { calls: 0 }
  const [row] = await ownerDb
    .insert(saasWaitlistRequest)
    .values({ ...request("rosa@norte.test"), professionals: "1", currentTool: "nada", phone: "+51911111111" })
    .returning({ id: saasWaitlistRequest.id })
  const { token } = await inviteFromWaitlist(ownerDb, ADMIN, row!.id, { planId: foundersPlanId })

  const invitation = await buildApp(authFor(null, created)).request(`/api/public/founders/invitation/${token}`)
  expect(invitation.status).toBe(200)
  const missing = await buildApp(authFor(null, created)).request("/api/public/founders/invitation/otro")
  expect(missing.status).toBe(404)

  // Con la invitación de otra persona, no.
  const other = await createOrg(buildApp(authFor("pedro@gmail.test", created)), "ajena", token)
  expect(other.status).toBe(403)
  expect(((await other.json()) as { error: { code: string } }).error.code).toBe("INVITATION_OTHER_EMAIL")
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

it("cada producto tiene su lista: latidIA por su dominio y se abre sin invitación (ADR 0093)", async () => {
  await createSaasPlan(ownerDb, ADMIN.userId, {
    code: "api-lista-latidia",
    name: "Plan latidIA",
    product: "medical",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 4_000_000,
    trialCreditCents: 10_000,
    trialMaxCreditCents: 10_000,
    trialDays: 45,
    isDefault: true,
    showOnWeb: true,
  })
  const app = buildApp(authFor(null, { calls: 0 }))
  // La web la pide con `?product=` por la red interna; sin decirlo, la del dominio.
  const asked = (await (await app.request("/api/public/founders/pricing?product=medical")).json()) as { list: { code: string } }
  expect(asked.list.code).toBe("api-lista-latidia")
  const byDomain = (await (await app.request("https://api.latidia.localhost/api/public/founders/pricing")).json()) as { list: { code: string } }
  expect(byDomain.list.code).toBe("api-lista-latidia")
  expect(((await (await app.request("/api/public/founders/pricing")).json()) as { list: { code: string } }).list.code).toBe("api-lista")

  // Sin invitación, aunque la política vieja de latidIA diga «solo con invitación».
  const created = { calls: 0 }
  const medical = await createOrg(buildApp(authFor("libre@latido.test", created)), "latido", undefined, "https://api.latidia.localhost")
  expect(medical.status).toBe(200)
  // Nace con la prueba del Plan latidIA, no con la de odentIA.
  const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, "org-latido"))
  expect(Math.round(((sub?.trialEndsAt?.getTime() ?? 0) - (sub?.trialStartedAt?.getTime() ?? 0)) / 86_400_000)).toBe(45)
})

describe("las guías de la web (ADR 0216)", () => {
  const GUIDE = "/guias/como-llenar-un-odontograma"
  const post = (app: Hono, path: string, payload: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://www.odentia.localhost" },
      body: JSON.stringify(payload),
    })

  it("el aviso manda las plantillas adjuntas una vez al día, con la puerta para empezar gratis", async () => {
    const mailer = recordingMailer()
    const app = buildApp(authFor(null, { calls: 0 }), mailer)
    const body = { email: "QA.Milagros@example.com", page: GUIDE, sheets: ["odontograma", "odontograma-ninos"] }
    const res = await post(app, "/api/public/founders/contact", body)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, sent: true })
    expect(mailer.sent).toHaveLength(1)
    const mail = mailer.sent[0]!
    expect(mail.to).toBe("qa.milagros@example.com")
    expect(mail.subject).toBe("Tus plantillas para imprimir")
    expect(mail.replyTo).toBe("hola@odentia32.com")
    expect(mail.attachments?.map((file) => [file.filename, file.contentType])).toEqual([
      ["odontograma.pdf", "application/pdf"],
      ["odontograma-ninos.pdf", "application/pdf"],
    ])
    // El alta es libre: «Empieza gratis» lleva a crear la cuenta, con lo que regala el plan de lista.
    expect(mail.html).toContain("Empieza gratis")
    expect(mail.html).toContain("https://app.odentia.localhost/register")
    expect(mail.text).toContain("Empieza gratis: 30 días con USD 100 de regalo para tus agentes, sin tarjeta.")
    for (const word of ["solicitar-invitacion", "Fundadores", "Pide tus", "qa.milagros%40example.com"]) expect(mail.html).not.toContain(word)
    expect(mail.html).toContain(`https://www.odentia.localhost${GUIDE}`)
    // Lo que promete el aviso («te mostramos cómo»): la demo de la guía, sin cuenta.
    expect(mail.html).toContain(`https://www.odentia.localhost${GUIDE}#pruebalo`)
    const again = await post(app, "/api/public/founders/contact", body)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ ok: true, sent: false, reason: "reciente" })
    expect(mailer.sent).toHaveLength(1)
  })

  it("solo JSON y solo páginas de las guías; quien llena el campo trampa no guarda nada", async () => {
    const mailer = recordingMailer()
    const app = buildApp(authFor(null, { calls: 0 }), mailer)
    const form = await app.request("/api/public/founders/contact", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=qa.form%40example.com",
    })
    expect(form.status).toBe(415)
    expect((await post(app, "/api/public/founders/contact", { email: "qa.precios@example.com", page: "/precios", sheets: ["odontograma"] })).status).toBe(400)
    const trap = await post(app, "/api/public/founders/contact", {
      email: "qa.trampa@example.com",
      page: GUIDE,
      sheets: ["odontograma"],
      website: "http://spam.example",
    })
    expect(trap.status).toBe(201)
    expect(mailer.sent).toHaveLength(0)
    expect(await ownerDb.select().from(saasWebContact).where(eq(saasWebContact.email, "qa.trampa@example.com"))).toEqual([])
  })

  it("si no se confirma que salió, responde 502 sin invitar a reintentar, y el repetido no manda otro", async () => {
    let calls = 0
    const app = buildApp(authFor(null, { calls: 0 }), {
      sent: [],
      send: async () => {
        calls += 1
        throw new Error("el proveedor no respondió")
      },
    } as unknown as ReturnType<typeof recordingMailer>)
    const body = { email: "qa.dudoso@example.com", page: GUIDE, sheets: ["presupuesto"] }
    const res = await post(app, "/api/public/founders/contact", body)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: { code: "MAIL_UNCONFIRMED" } })
    const again = await post(app, "/api/public/founders/contact", body)
    expect(await again.json()).toEqual({ ok: true, sent: false, reason: "reciente" })
    expect(calls).toBe(1)
  })

  it("a quien ya es de una clínica con cuenta, el correo le abre su entrada y no le pide entrar", async () => {
    await ownerDb.execute(sql`insert into "organization" ("id","name","slug","created_at") values ('org-guias-cuenta', 'Clínica con Cuenta', 'guias-cuenta', now()) on conflict do nothing`)
    const [client] = await ownerDb
      .insert(saasClient)
      .values({ name: "Clínica con Cuenta", product: "dental", origin: "web", organizationId: "org-guias-cuenta" })
      .returning({ id: saasClient.id })
    await ownerDb.insert(saasClientContact).values({
      clientId: client!.id,
      name: "Dra. Lucía Rojas",
      email: "qa.cuenta@example.com",
      roles: [],
      rolesConfirmed: false,
      isPrimary: true,
    })
    const mailer = recordingMailer()
    const app = buildApp(authFor(null, { calls: 0 }), mailer)
    const res = await post(app, "/api/public/founders/contact", { email: "qa.cuenta@example.com", page: GUIDE, sheets: ["odontograma"] })
    expect(res.status).toBe(201)
    const html = mailer.sent[0]?.html ?? ""
    expect(html).toContain("Entrar a odentIA")
    expect(html).toContain("https://app.odentia.localhost/login")
    expect(html).not.toContain("Empieza gratis")
    expect(html).not.toContain("Fundadores")
  })

  it("sin plan de lista en la web, el correo no invita a crear la cuenta ni promete un regalo", async () => {
    await ownerDb.update(saasPlan).set({ showOnWeb: false }).where(eq(saasPlan.code, "api-lista"))
    try {
      const mailer = recordingMailer()
      const app = buildApp(authFor(null, { calls: 0 }), mailer)
      const res = await post(app, "/api/public/founders/contact", { email: "qa.sinplan@example.com", page: GUIDE, sheets: ["odontograma"] })
      expect(res.status).toBe(201)
      const mail = mailer.sent[0]!
      for (const word of ["Empieza gratis", "/register", "de regalo"]) {
        expect(mail.html).not.toContain(word)
        expect(mail.text).not.toContain(word)
      }
    } finally {
      await ownerDb.update(saasPlan).set({ showOnWeb: true }).where(eq(saasPlan.code, "api-lista"))
    }
  })

  it("cuenta por red de IPv6: cambiar de dirección dentro de la misma red no pasa el tope", async () => {
    let n = 0
    const route = createPublicFoundersRoute({ ownerDb, mailer: recordingMailer(), remoteAddress: () => `2001:db8:77:1::${(n++).toString(16)}` })
    const send = () => route.request("/contact", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(400)
    expect((await send()).status).toBe(429)
  })

  it("pasado el tope de la hora entre todos, responde 429 y no manda nada", async () => {
    const at = new Date(Date.now() - 10 * 60 * 1000)
    await ownerDb.insert(saasWebContact).values(
      Array.from({ length: WEB_CONTACTS_PER_HOUR }, (_, index) => ({
        email: `qa.tope${index}@example.com`,
        mailbox: `qa.tope${index}@example.com`,
        product: "dental",
        sourcePage: GUIDE,
        sheets: ["odontograma"],
        createdAt: at,
      })),
    )
    try {
      const mailer = recordingMailer()
      const app = buildApp(authFor(null, { calls: 0 }), mailer)
      const res = await post(app, "/api/public/founders/contact", { email: "qa.tope.otro@example.com", page: GUIDE, sheets: ["odontograma"] })
      expect(res.status).toBe(429)
      expect(mailer.sent).toHaveLength(0)
    } finally {
      await ownerDb.delete(saasWebContact).where(like(saasWebContact.email, "qa.tope%"))
    }
  })

  it("latidIA y vistIA no tienen guías: el aviso responde 404 en su dominio", async () => {
    const app = buildApp(authFor(null, { calls: 0 }))
    const res = await app.request("https://api.latidia.localhost/api/public/founders/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "qa.latidia@example.com", page: GUIDE, sheets: ["odontograma"] }),
    })
    expect(res.status).toBe(404)
  })
})
