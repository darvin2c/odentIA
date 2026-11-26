import type { Auth } from "@odentia/auth"
import { signAccountEvent } from "@odentia/auth/account-events"
import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import type { Storage } from "@odentia/services"
import { describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import { portalOrigin } from "./lib/portal-origin.js"
import { visitCountryNow } from "./lib/visit.js"

/**
 * Una instalación para los dominios de cada producto (decisión 9 del issue 229):
 * la sesión de cada dominio pone la cookie en el suyo, y CORS acepta las clínicas
 * de todos. Sin base de datos: estas rutas no la tocan.
 */
const sessionOf = (product: string) =>
  ({
    handler: async () => new Response(product),
    api: { getSession: async () => null },
  }) as unknown as Auth

const app = createApp({
  auth: sessionOf("odentIA"),
  productAuth: { medical: sessionOf("latidIA"), optical: sessionOf("vistIA") },
  productDomains: { medical: "latidia.test", optical: "vistia.test" },
  db: {} as Db,
  ownerDb: {} as Db,
  secretsKey: Buffer.alloc(32),
  storage: {} as Storage,
  validateExternal: false,
  webhookBaseUrl: "https://api.odentia.test",
  trustedOrigins: [
    "https://odentia.test",
    "https://app.odentia.test",
    "https://admin.odentia.test",
  ],
  cookieDomain: "odentia.test",
  webURL: "https://app.odentia.test",
  adminURL: "https://admin.odentia.test",
  mailer: { send: async () => {} } as unknown as Mailer,
  listenUrl: "postgres://localhost:5432/dentalagent",
})

const allowed = async (origin: string) => {
  const response = await app.request("https://api.odentia.test/api/patients", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
  })
  return response.headers.get("access-control-allow-origin") === origin
}

describe("los dominios de cada producto en la API", () => {
  it("el inicio de sesión va a la sesión del dominio de la petición", async () => {
    expect(await (await app.request("https://api.latidia.test/api/auth/get-session")).text()).toBe(
      "latidIA",
    )
    expect(await (await app.request("https://api.odentia.test/api/auth/get-session")).text()).toBe(
      "odentIA",
    )
    expect(await (await app.request("https://api.vistia.test/api/auth/get-session")).text()).toBe(
      "vistIA",
    )
  })

  it("CORS acepta las clínicas y el panel de cada producto, y nada más", async () => {
    expect(await allowed("https://claridad.vistia.test")).toBe(true)
    expect(await allowed("https://app.vistia.test")).toBe(true)
    expect(await allowed("https://vistia.test.evil.test")).toBe(false)
    expect(await allowed("https://sanmartin.latidia.test")).toBe(true)
    expect(await allowed("https://app.latidia.test")).toBe(true)
    expect(await allowed("https://latidia.test")).toBe(true)
    expect(await allowed("https://sonrie.odentia.test")).toBe(true)
    expect(await allowed("https://evil.test")).toBe(false)
    expect(await allowed("https://latidia.test.evil.test")).toBe(false)
  })
})

it("el enlace y la llave del portal van en el dominio del producto de la clínica", () => {
  // `app` fija los dominios al crearse: sin eso, una clínica de latidIA abriría en odentIA.
  expect(app).toBeDefined()
  const config = { webURL: "https://app.odentia.test" }
  expect(portalOrigin(config, { slug: "sanmartin", product: "medical" })).toBe(
    "https://sanmartin.latidia.test",
  )
  expect(portalOrigin(config, { slug: "sonrisa", product: "dental" })).toBe(
    "https://sonrisa.odentia.test",
  )
  expect(portalOrigin(config, { slug: "claridad", product: "optical" })).toBe(
    "https://claridad.vistia.test",
  )
})

describe("el dominio de una app que es otro sistema (gestorIA, ADR 0201)", () => {
  const appWith = (entry: Auth, more: Partial<Parameters<typeof createApp>[0]> = {}) =>
    createApp({
      auth: sessionOf("odentIA"),
      externalApps: [
        { app: "gestoria", domain: "gestoria.test", auth: entry, trustedOrigins: ["https://app.gestoria.test"] },
      ],
      db: {} as Db,
      ownerDb: {} as Db,
      secretsKey: Buffer.alloc(32),
      storage: {} as Storage,
      validateExternal: false,
      webhookBaseUrl: "https://api.odentia.test",
      trustedOrigins: ["https://app.odentia.test", "https://admin.odentia.test"],
      cookieDomain: "odentia.test",
      webURL: "https://app.odentia.test",
      adminURL: "https://admin.odentia.test",
      mailer: { send: async () => {} } as unknown as Mailer,
      listenUrl: "postgres://localhost:5432/dentalagent",
      ...more,
    })

  it("en su dominio no responde nada de las clínicas, y las clínicas siguen igual", async () => {
    const app = appWith(sessionOf("gestorIA"))
    expect((await app.request("https://api.gestoria.test/api/patients")).status).toBe(404)
    expect((await app.request("https://gestoria.test/health")).status).toBe(404)
    expect(await (await app.request("https://api.odentia.test/api/auth/get-session")).text()).toBe("odentIA")
  })

  it("su cuenta conoce el país de la visita mientras atiende, para el código del personal (ADR 0219)", async () => {
    const entry = {
      handler: async () => Response.json(visitCountryNow() ?? "fuera"),
      api: { getSession: async () => null },
    } as unknown as Auth
    const on = appWith(entry)
    const country = async (header?: string) =>
      (
        await on.request("https://api.gestoria.test/api/auth/token", {
          headers: header ? { "cf-ipcountry": header } : {},
        })
      ).json()
    expect(await country("pe")).toEqual({ country: "PE" })
    // Sin la cabecera de Cloudflare, nulo: solo vale una marca puesta también sin país.
    expect(await country()).toEqual({ country: null })
    // Fuera de esa petición no hay país: quien decide con él lo niega.
    expect(visitCountryNow()).toBeUndefined()
  })

  it("con su entrada, solo responde la cuenta, sin las organizaciones de las clínicas", async () => {
    const on = appWith(sessionOf("gestorIA"))
    expect(await (await on.request("https://api.gestoria.test/api/auth/get-session")).text()).toBe("gestorIA")
    expect(
      (await on.request("https://api.gestoria.test/api/auth/organization/create", { method: "POST" })).status,
    ).toBe(404)
    expect((await on.request("https://api.gestoria.test/api/patients")).status).toBe(404)
    expect((await on.request("https://api.gestoria.test/api/admin/overview")).status).toBe(404)
    // Un dominio que solo lo imita no entra.
    expect(await (await on.request("https://api.gestoria.test.evil.test/api/auth/get-session")).text()).toBe(
      "odentIA",
    )
    const preflight = (origin: string) =>
      on.request("https://api.gestoria.test/api/auth/get-session", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
      })
    expect((await preflight("https://app.gestoria.test")).headers.get("access-control-allow-origin")).toBe(
      "https://app.gestoria.test",
    )
    expect((await preflight("https://app.odentia.test")).headers.get("access-control-allow-origin")).toBeNull()
  })

  it("la cuenta de la persona también responde ahí, sin sus clínicas y solo desde sus pantallas (ADR 0218)", async () => {
    const on = appWith(sessionOf("gestorIA"))
    const at = (path: string, init?: RequestInit) =>
      on.request(`https://api.gestoria.test${path}`, init)
    // Lo de la persona pide su sesión (la de su dominio, que aquí no hay).
    expect((await at("/api/account/two-factor")).status).toBe(401)
    expect((await at("/api/account/support/cases")).status).toBe(401)
    // Sus clínicas, sus invitaciones y lo que es de una clínica no existen en ese dominio.
    expect((await at("/api/account/organizations")).status).toBe(404)
    expect((await at("/api/account/invitations/pending")).status).toBe(404)
    expect(
      (
        await at("/api/account/organizations/org-1/leave", {
          method: "POST",
          headers: { origin: "https://app.gestoria.test" },
        })
      ).status,
    ).toBe(404)
    expect((await at("/api/account/billing/notices")).status).toBe(404)
    expect((await at("/api/account/admin-access")).status).toBe(404)
    // Una escritura que no viene de sus pantallas no entra, ni con la sesión.
    const close = (origin?: string) =>
      at("/api/account/close", {
        method: "POST",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify({ confirm: true }),
      })
    expect((await close()).status).toBe(403)
    expect((await close("https://app.odentia.test")).status).toBe(403)
    expect((await close("https://app.gestoria.test")).status).toBe(401)
    expect(
      (
        await at("/api/uploads/avatar", {
          method: "POST",
          headers: { origin: "https://app.gestoria.test" },
        })
      ).status,
    ).toBe(401)
    const preflight = (origin: string) =>
      at("/api/account/two-factor", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
      })
    expect(
      (await preflight("https://app.gestoria.test")).headers.get("access-control-allow-origin"),
    ).toBe("https://app.gestoria.test")
    expect(
      (await preflight("https://app.odentia.test")).headers.get("access-control-allow-origin"),
    ).toBeNull()
  })

  describe("la revisión diaria de su copia de las cuentas", () => {
    const SECRET = `whsec_${Buffer.alloc(32, 5).toString("base64")}`
    const asked: string[][] = []
    // Se arma dentro de cada prueba: `createApp` fija los dominios de todo el proceso, y la
    // prueba del portal (arriba) lee los del primero.
    const reviewing = () => appWith(sessionOf("gestorIA"), {
      accountEventSenders: [{ app: "gestoria", url: "https://servidor.gestoria.test/avisos/cuenta", secret: SECRET }],
      reviewAccounts: async (ids) => {
        asked.push(ids)
        return ids.map((userId) => ({
          userId,
          found: true,
          blocked: false,
          name: "Rosa",
          email: "rosa@gestoria.test",
          emailVerified: true,
          image: null,
        }))
      },
    })
    const ask = (target: ReturnType<typeof createApp>, body: string, secret = SECRET, host = "api.gestoria.test") =>
      target.request(`https://${host}/api/account-apps/review`, {
        method: "POST",
        headers: { "content-type": "application/json", ...signAccountEvent({ secret, id: "rev-1", body }) },
        body,
      })

    it("responde lo vigente solo a quien firma con el secreto de sus avisos", async () => {
      const withReview = reviewing()
      const body = JSON.stringify({ userIds: ["u-1"] })
      const response = await ask(withReview, body)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        accounts: [expect.objectContaining({ userId: "u-1", name: "Rosa", blocked: false })],
      })
      expect(asked).toEqual([["u-1"]])
      // Otro secreto, o el cuerpo cambiado: no.
      expect((await ask(withReview, body, `whsec_${Buffer.alloc(32, 6).toString("base64")}`)).status).toBe(401)
      const tampered = await withReview.request("https://api.gestoria.test/api/account-apps/review", {
        method: "POST",
        headers: { "content-type": "application/json", ...signAccountEvent({ secret: SECRET, id: "rev-2", body }) },
        body: JSON.stringify({ userIds: ["u-2"] }),
      })
      expect(tampered.status).toBe(401)
      expect(asked).toHaveLength(1)
    })

    it("no existe sin el secreto de la app, ni en el dominio de las clínicas", async () => {
      const withReview = reviewing()
      const body = JSON.stringify({ userIds: ["u-1"] })
      expect((await ask(appWith(sessionOf("gestorIA")), body)).status).toBe(404)
      expect((await ask(withReview, body, SECRET, "api.odentia.test")).status).not.toBe(200)
      expect((await withReview.request("https://api.gestoria.test/api/account-apps/review")).status).toBe(404)
    })
  })
  describe("el acuerdo con la administración (ADR 0211)", () => {
    const SECRET = `whsec_${Buffer.alloc(32, 8).toString("base64")}`
    const EVENTS_SECRET = `whsec_${Buffer.alloc(32, 5).toString("base64")}`
    const received: string[] = []
    // La base de prueba solo registra la transacción del aviso: la regla del acuerdo se prueba en services.
    const ownerDb = {
      transaction: async () => {
        received.push("aviso")
        return { repeated: true }
      },
    } as unknown as Db
    const contract = () =>
      appWith(sessionOf("gestorIA"), {
        ownerDb,
        appContractPeers: [{ app: "gestoria", secret: SECRET }],
        accountEventSenders: [{ app: "gestoria", url: "https://servidor.gestoria.test/avisos/cuenta", secret: EVENTS_SECRET }],
      })
    const usage = JSON.stringify({
      type: "uso.contado",
      timestamp: "2026-11-22T12:00:00.000Z",
      data: { account: "tienda-1", kind: "conversacion", outcome: "atendida", conversation: "c-1", occurredAt: "2026-11-22T12:00:00.000Z" },
    })
    const send = (target: ReturnType<typeof createApp>, body: string, secret = SECRET, host = "api.gestoria.test", path = "/api/contract/events") =>
      target.request(`https://${host}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...signAccountEvent({ secret, id: "aviso-1", body }) },
        body,
      })

    it("acepta solo lo firmado con el secreto del acuerdo y lo que cumple el acuerdo", async () => {
      const app = contract()
      const ok = await send(app, usage)
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ data: { received: true, repeated: true } })
      expect(received).toEqual(["aviso"])
      // El secreto de los avisos de la cuenta no sirve para hablarle a la administración.
      expect((await send(app, usage, EVENTS_SECRET)).status).toBe(401)
      const tampered = await app.request("https://api.gestoria.test/api/contract/events", {
        method: "POST",
        headers: { "content-type": "application/json", ...signAccountEvent({ secret: SECRET, id: "aviso-2", body: usage }) },
        body: usage.replace("atendida", "pedido"),
      })
      expect(tampered.status).toBe(401)
      // Un precio o un tipo que no es del acuerdo no pasa.
      expect((await send(app, usage.replace("atendida", "cita"))).status).toBe(400)
      expect((await send(app, "no es json")).status).toBe(400)
      // Un aviso puede traer un comprobante (hasta 1,5 MB en base64); una pregunta, no.
      expect((await send(app, JSON.stringify({ account: "x".repeat(2_200_000) }))).status).toBe(413)
      expect(
        (await send(app, JSON.stringify({ account: "x".repeat(70_000) }), SECRET, "api.gestoria.test", "/api/contract/state"))
          .status,
      ).toBe(413)
      expect(received).toEqual(["aviso"])
    })

    it("no existe sin su secreto, ni en el dominio de las clínicas", async () => {
      expect((await send(appWith(sessionOf("gestorIA")), usage)).status).toBe(404)
      expect((await send(contract(), usage, SECRET, "api.odentia.test")).status).not.toBe(200)
      expect((await contract().request("https://api.gestoria.test/api/contract/state")).status).toBe(404)
      expect(received).toEqual(["aviso"])
    })
  })
})
