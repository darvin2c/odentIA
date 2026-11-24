process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { saasWebContact } from "@odentia/db/schema/admin-arm"
import { user } from "@odentia/db/schema/auth"
import { saasPlan, saasSignupPolicy, saasSubscription, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import type { MailMessage } from "@odentia/mail"
import { createSaasPlan, inviteFromWaitlist, type Storage, secretsKeyFromEnv } from "@odentia/services"
import { eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createApp } from "../app.js"
import { createPublicFoundersRoute } from "./public-founders.js"

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
  // La copia a quien pidió, que responde a hola@ de su marca, y el aviso «Cliente nuevo» a ese mismo hola@.
  expect(mailer.sent.map((m) => m.to)).toEqual(["ana@sonrisa.test", "hola@odentia32.com"])
  expect(mailer.sent[0]?.subject).toBe("Clínica Sonrisa está en la lista de odentIA")
  expect(mailer.sent[0]?.replyTo).toBe("hola@odentia32.com")
  expect(mailer.sent[1]?.subject).toContain("Cliente nuevo: Clínica Sonrisa")
  // Pedirlo otra vez no duplica la solicitud, ni la copia ni el aviso.
  expect((await send(request("ana@sonrisa.test"))).status).toBe(201)
  expect(mailer.sent).toHaveLength(2)
  const bad = await send({ ...request("x@y.test"), professionals: "muchos" })
  expect(bad.status).toBe(400)
  expect(((await bad.json()) as { error: { message: string } }).error.message).toBe("Elige cuántos odontólogos atienden")
})

describe("el aviso al equipo de cada solicitud nueva", () => {
  const TEAM = "fundadores@odentia.test"
  let ip = 0
  /** La ruta sola, con la dirección de la administración y el buzón del equipo que le pasa `createApp`. */
  function foundersRoute(mailer: { send: (m: MailMessage) => Promise<void> }, teamEmail: string | null = TEAM) {
    return createPublicFoundersRoute({
      ownerDb,
      mailer,
      // Una dirección por envío: el límite por dirección no entra en estas pruebas.
      remoteAddress: () => `10.9.${Math.floor(ip / 250)}.${ip++ % 250}`,
      adminURL: "https://admin.odentia.localhost/",
      teamEmailOf: () => teamEmail ?? undefined,
    })
  }
  const post = (route: ReturnType<typeof foundersRoute>, payload: unknown) =>
    route.request("/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
  const idOf = async (email: string) =>
    (await ownerDb.select({ id: saasWaitlistRequest.id }).from(saasWaitlistRequest).where(eq(saasWaitlistRequest.email, email)))[0]!.id
  const clientOf = async (email: string) =>
    (await ownerDb.select({ clientId: saasWaitlistRequest.clientId }).from(saasWaitlistRequest).where(eq(saasWaitlistRequest.email, email)))[0]!.clientId

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("una solicitud nueva envía la copia y el aviso de cliente nuevo, sin el correo ni el celular y con el enlace a su ficha", async () => {
    const mailer = recordingMailer()
    const res = await post(foundersRoute(mailer), request("aviso@norte.test"))
    expect(res.status).toBe(201)
    expect(mailer.sent.map((m) => m.to)).toEqual(["aviso@norte.test", TEAM])
    const notice = mailer.sent[1]!
    expect(notice.subject).toBe("Cliente nuevo: Clínica Sonrisa pidió entrar a odentIA")
    const url = `https://admin.odentia.localhost/clients/${await clientOf("aviso@norte.test")}`
    expect(notice.text).toContain(`Abrir la ficha: ${url}`)
    expect(notice.html).toContain(`href="${url}"`)
    for (const body of [notice.subject, notice.text, notice.html]) {
      expect(body).not.toContain("aviso@norte.test")
      expect(body).not.toMatch(/987\D?654\D?321/)
    }

    // La misma solicitud otra vez (el formulario enviado dos veces): ni otra copia ni otro aviso.
    expect((await post(foundersRoute(mailer), request("aviso@norte.test"))).status).toBe(201)
    expect(mailer.sent).toHaveLength(2)
  })

  it("sin el buzón del equipo, solo sale la copia", async () => {
    const mailer = recordingMailer()
    expect((await post(foundersRoute(mailer, null), request("sin-buzon@norte.test"))).status).toBe(201)
    expect(mailer.sent.map((m) => m.to)).toEqual(["sin-buzon@norte.test"])
  })

  it("si la copia no sale, el aviso sale igual; si el aviso no sale, solo su id va al registro y no se reintenta", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const sent: MailMessage[] = []
    const failing = (to: string) => ({
      send: async (m: MailMessage) => {
        if (m.to === to) throw new Error(`rebotó ${m.to}`)
        sent.push(m)
      },
    })
    expect((await post(foundersRoute(failing("rebota@tacna.test")), request("rebota@tacna.test"))).status).toBe(201)
    expect(sent.map((m) => m.to)).toEqual([TEAM])

    const res = await post(foundersRoute(failing(TEAM)), request("sin-aviso@tacna.test"))
    expect(res.status).toBe(201)
    expect(sent.map((m) => m.to)).toEqual([TEAM, "sin-aviso@tacna.test"])
    const id = await idOf("sin-aviso@tacna.test")
    const logged = errors.mock.calls.map((call) => call.join(" "))
    expect(logged).toContain(`Fundadores: no salió el aviso al equipo de la solicitud ${id}`)
    expect(logged.join("\n")).not.toContain("sin-aviso@tacna.test")
  })

  it("pasado el tope de 20 avisos por hora no sale otro, y la solicitud se guarda igual", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const mailer = recordingMailer()
    const route = foundersRoute(mailer)
    for (let n = 1; n <= 20; n++) expect((await post(route, request(`tope-${n}@lima.test`))).status).toBe(201)
    expect(mailer.sent.filter((m) => m.to === TEAM)).toHaveLength(20)

    const res = await post(route, request("tope-21@lima.test"))
    expect(res.status).toBe(201)
    expect(mailer.sent.filter((m) => m.to === TEAM)).toHaveLength(20)
    // La copia sí sale, y la solicitud queda para Inicio.
    expect(mailer.sent.at(-1)?.to).toBe("tope-21@lima.test")
    const id = await idOf("tope-21@lima.test")
    expect(errors.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(id)
  })
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
    .values({ ...request("rosa@norte.test"), professionals: "1", currentTool: "nada", phone: "+51911111111" })
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

it("cada producto tiene su lista y su alta: latidIA por su dominio (ADR 0093)", async () => {
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

  // Se abre latidIA y odentIA sigue pidiendo invitación.
  await ownerDb.update(saasSignupPolicy).set({ medicalMode: "abierta" })
  const created = { calls: 0 }
  const dental = await createOrg(buildApp(authFor("dental@clinica.test", created)), "sigue-cerrada")
  expect(dental.status).toBe(403)
  const medical = await createOrg(buildApp(authFor("libre@latido.test", created)), "latido", undefined, "https://api.latidia.localhost")
  expect(medical.status).toBe(200)
  // Nace con la prueba del Plan latidIA, no con la de odentIA.
  const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, "org-latido"))
  expect(Math.round(((sub?.trialEndsAt?.getTime() ?? 0) - (sub?.trialStartedAt?.getTime() ?? 0)) / 86_400_000)).toBe(45)
  await ownerDb.update(saasSignupPolicy).set({ medicalMode: "invitacion" })
})

describe("las guías de la web (ADR 0214)", () => {
  const GUIDE = "/guias/como-llenar-un-odontograma"
  const post = (app: Hono, path: string, payload: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://www.odentia.localhost" },
      body: JSON.stringify(payload),
    })

  it("la solicitud enviada desde una guía guarda su página y dice si salió su copia", async () => {
    const mailer = recordingMailer()
    const app = buildApp(authFor(null, { calls: 0 }), mailer)
    const res = await post(app, `/api/public/founders/waitlist?desde=${encodeURIComponent(GUIDE)}`, request("qa.guia@example.com"))
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ existing: false, copySent: true })
    const [row] = await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.email, "qa.guia@example.com"))
    expect(row?.sourcePage).toBe(GUIDE)
    // Otra vez el mismo correo: ya estaba en la lista y no sale otra copia; la pantalla lo dice.
    const again = await post(app, "/api/public/founders/waitlist", request("qa.guia@example.com"))
    expect(await again.json()).toMatchObject({ existing: true, copySent: false })
  })

  it("el aviso manda las plantillas adjuntas una vez al día, con la puerta para pedir entrar", async () => {
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
    // Con Fundadores, «Pide tus USD 100» con su correo en el fragmento: nunca en la consulta.
    expect(mail.html).toContain("Pide tus USD 100")
    expect(mail.html).toContain("https://www.odentia.localhost/solicitar-invitacion#correo=qa.milagros%40example.com")
    expect(mail.html).toContain(`https://www.odentia.localhost${GUIDE}`)
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
