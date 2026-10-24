import type { Auth } from "@odentia/auth"
import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import type { Storage } from "@odentia/services"
import { describe, expect, it } from "vitest"
import { createApp } from "./app.js"

/**
 * Una instalación para los dos dominios (decisión 9 del issue 229): la sesión
 * de cada dominio pone la cookie en el suyo, y CORS acepta las clínicas de los
 * dos. Sin base de datos: estas rutas no la tocan.
 */
const sessionOf = (product: string) =>
  ({ handler: async () => new Response(product), api: { getSession: async () => null } }) as unknown as Auth

const app = createApp({
  auth: sessionOf("odentIA"),
  productAuth: { medical: sessionOf("latidIA") },
  productDomains: { medical: "latidia.test" },
  db: {} as Db,
  ownerDb: {} as Db,
  secretsKey: Buffer.alloc(32),
  storage: {} as Storage,
  validateExternal: false,
  webhookBaseUrl: "https://api.odentia.test",
  trustedOrigins: ["https://odentia.test", "https://app.odentia.test", "https://admin.odentia.test"],
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

describe("los dos dominios en la API", () => {
  it("el inicio de sesión va a la sesión del dominio de la petición", async () => {
    expect(await (await app.request("https://api.latidia.test/api/auth/get-session")).text()).toBe("latidIA")
    expect(await (await app.request("https://api.odentia.test/api/auth/get-session")).text()).toBe("odentIA")
  })

  it("CORS acepta las clínicas y el panel de los dos productos, y nada más", async () => {
    expect(await allowed("https://sanmartin.latidia.test")).toBe(true)
    expect(await allowed("https://app.latidia.test")).toBe(true)
    expect(await allowed("https://latidia.test")).toBe(true)
    expect(await allowed("https://sonrie.odentia.test")).toBe(true)
    expect(await allowed("https://evil.test")).toBe(false)
    expect(await allowed("https://latidia.test.evil.test")).toBe(false)
  })
})
