import type { Auth } from "@odentia/auth"
import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import type { Storage } from "@odentia/services"
import { describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import { portalOrigin } from "./lib/portal-origin.js"

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
  const appWith = (entry: Auth | null) =>
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
    })

  it("sin su entrada, nada responde en su dominio: ni la cuenta ni las clínicas", async () => {
    const off = appWith(null)
    expect((await off.request("https://api.gestoria.test/api/auth/get-session")).status).toBe(404)
    expect((await off.request("https://api.gestoria.test/api/patients")).status).toBe(404)
    expect((await off.request("https://gestoria.test/health")).status).toBe(404)
    // Las clínicas siguen igual.
    expect(await (await off.request("https://api.odentia.test/api/auth/get-session")).text()).toBe("odentIA")
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
})
