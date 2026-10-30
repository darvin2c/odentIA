/**
 * Enlace de acceso («¿Olvidaste tu contraseña?», lienzo «Recuperar el acceso»):
 * por HTTP contra Better Auth y una base real.
 *
 * - Solo sirve el último enlace, una vez; abrirlo deja la sesión y la marca.
 * - La marca vale solo para la sesión del enlace; guardar cierra las demás.
 * - Un correo sin cuenta responde igual y no recibe nada.
 * - Crear cuenta con correo exige aceptar los documentos vigentes.
 */
import { createAuth, LEGAL_VERSION } from "@odentia/auth"
import type { MailMessage } from "@odentia/mail"
import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const API = "http://localhost:3001/api/auth"
const PANEL = "http://localhost:3000"

function makeAuth(sent: MailMessage[]) {
  return createAuth({
    db: ownerDb,
    ownerDb,
    mailer: { send: async (m) => void sent.push(m) },
    secret: "smoke-secret-que-supera-treinta-y-dos-bytes",
    baseURL: API,
    webURL: PANEL,
    cookieDomain: "localhost",
    trustedOrigins: [PANEL],
    googleClientId: "",
    googleClientSecret: "",
    passwordBreachCheck: false,
  })
}

/** Un navegador con sus cookies. */
function browser(auth: ReturnType<typeof makeAuth>) {
  const jar: Record<string, string> = {}
  const store = (res: Response) => {
    for (const setCookie of res.headers.getSetCookie()) {
      const pair = setCookie.split(";")[0] ?? ""
      const at = pair.indexOf("=")
      if (at <= 0) continue
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      if (value === "" || /max-age=0/i.test(setCookie)) delete jar[name]
      else jar[name] = value
    }
  }
  const headers = (): Record<string, string> => {
    const cookie = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ")
    return { origin: PANEL, ...(cookie ? { cookie } : {}) }
  }
  return {
    async post(path: string, body: unknown) {
      const res = await auth.handler(
        new Request(`${API}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers() },
          body: JSON.stringify(body),
        }),
      )
      store(res)
      return res
    },
    async get(url: string) {
      const res = await auth.handler(new Request(url, { headers: headers(), redirect: "manual" }))
      store(res)
      return res
    },
  }
}

const tokenOf = (mail: MailMessage | undefined) => {
  const url = mail?.text.match(/https?:\/\/\S+/)?.[0] ?? ""
  return new URL(url)
}

describe("enlace de acceso", () => {
  it("entra con el último enlace, fija la contraseña una vez y cierra las demás sesiones", async () => {
    const sent: MailMessage[] = []
    const auth = makeAuth(sent)
    const email = "carmen@sonrisa.test"
    const first = browser(auth)

    const noTerms = await first.post("/sign-up/email", {
      name: "Carmen Ruiz",
      email,
      password: "vieja-clave-1",
    })
    expect(noTerms.status).toBe(400)
    const signup = await first.post("/sign-up/email", {
      name: "Carmen Ruiz",
      firstName: "Carmen",
      email,
      password: "vieja-clave-1",
      termsVersion: LEGAL_VERSION,
    })
    expect(signup.status).toBeLessThan(300)
    const [row] = (await ownerDb.execute(
      sql`select terms_version, terms_accepted_at from "user" where email = ${email}`,
    )) as unknown as { terms_version: string; terms_accepted_at: Date | null }[]
    expect(row?.terms_version).toBe(LEGAL_VERSION)
    expect(row?.terms_accepted_at).not.toBeNull()
    await ownerDb.execute(sql`update "user" set email_verified = true where email = ${email}`)
    expect((await first.post("/sign-in/email", { email, password: "vieja-clave-1" })).status).toBe(
      200,
    )

    // Pedir dos veces: solo sirve el último.
    const phone = browser(auth)
    sent.length = 0
    expect(
      (
        await phone.post("/access-link/request", {
          email: "Carmen@Sonrisa.test",
          timeZone: "America/Lima",
        })
      ).status,
    ).toBe(200)
    expect((await phone.post("/access-link/request", { email })).status).toBe(200)
    expect(sent).toHaveLength(2)
    expect(sent[0]?.subject).toBe("Tu enlace para entrar a odentIA")
    expect(sent[0]?.text).toContain("(hora de Lima)")
    const old = tokenOf(sent[0])
    const latest = tokenOf(sent[1])

    const stale = await phone.get(old.toString())
    expect(stale.status).toBe(302)
    expect(stale.headers.get("location")).toBe(`${PANEL}/forgot-password?vencido=1`)

    const entered = await phone.get(latest.toString())
    expect(entered.status).toBe(302)
    expect(entered.headers.get("location")).toBe(`${PANEL}/`)

    // La marca es de la sesión del enlace, no de la que ya estaba abierta.
    const statusPhone = await phone.get(`${API}/access-link/status`)
    expect(await statusPhone.json()).toEqual({ pending: true, hasPassword: true })
    const statusFirst = await first.get(`${API}/access-link/status`)
    expect(await statusFirst.json()).toMatchObject({ pending: false })
    expect(
      (await first.post("/access-link/set-password", { newPassword: "nueva-clave-segura" })).status,
    ).toBe(403)

    expect((await phone.post("/access-link/set-password", { newPassword: "corta" })).status).toBe(
      400,
    )
    sent.length = 0
    expect(
      (await phone.post("/access-link/set-password", { newPassword: "nueva-clave-segura" })).status,
    ).toBe(200)
    expect(sent[0]?.subject).toBe("Tu contraseña de odentIA cambió")

    // La sesión anterior quedó cerrada; la del enlace sigue.
    expect(await (await first.get(`${API}/get-session`)).json()).toBeNull()
    expect(await (await phone.get(`${API}/get-session`)).json()).not.toBeNull()
    expect(await (await phone.get(`${API}/access-link/status`)).json()).toMatchObject({
      pending: false,
    })

    // Ya usado, el enlace no vuelve a entrar; la contraseña nueva sí.
    const reused = await browser(auth).get(latest.toString())
    expect(reused.headers.get("location")).toBe(`${PANEL}/forgot-password?vencido=1`)
    const other = browser(auth)
    expect((await other.post("/sign-in/email", { email, password: "vieja-clave-1" })).status).toBe(
      401,
    )
    expect(
      (await other.post("/sign-in/email", { email, password: "nueva-clave-segura" })).status,
    ).toBe(200)
  }, 120_000)

  it("con segundo factor el enlace no deja entrar: pide el código", async () => {
    const sent: MailMessage[] = []
    const auth = makeAuth(sent)
    const email = "luis@roma.test"
    const b = browser(auth)
    await b.post("/sign-up/email", {
      name: "Luis Herrera",
      email,
      password: "clave-de-luis-1",
      termsVersion: LEGAL_VERSION,
    })
    await ownerDb.execute(
      sql`update "user" set email_verified = true, two_factor_enabled = true where email = ${email}`,
    )
    const fresh = browser(auth)
    await fresh.post("/access-link/request", { email })
    const res = await fresh.get(tokenOf(sent.at(-1)).toString())
    expect(res.headers.get("location")).toBe(`${PANEL}/two-factor?enlace=1`)
    expect(res.headers.getSetCookie().some((c) => c.includes("two_factor="))).toBe(true)
    expect(await (await fresh.get(`${API}/get-session`)).json()).toBeNull()
  }, 60_000)

  it("un correo sin cuenta responde igual y no recibe nada; al cuarto pedido espera", async () => {
    const sent: MailMessage[] = []
    const auth = makeAuth(sent)
    const b = browser(auth)
    for (let i = 0; i < 3; i++) {
      expect((await b.post("/access-link/request", { email: "nadie@sonrisa.test" })).status).toBe(
        200,
      )
    }
    expect(sent).toHaveLength(0)
    const fourth = await b.post("/access-link/request", { email: "nadie@sonrisa.test" })
    expect(fourth.status).toBe(429)
    expect(await fourth.json()).toMatchObject({ code: "ACCESS_LINK_TOO_MANY" })
  }, 60_000)

  it("si el correo falla, responde igual que a un correo sin cuenta", async () => {
    const email = "falla@sonrisa.test"
    // El correo de verificación del alta sale; después el proveedor deja de responder.
    let down = false
    const failing = createAuth({
      db: ownerDb,
      ownerDb,
      mailer: {
        send: async () => {
          if (down) throw new Error("el proveedor de correo no responde")
        },
      },
      secret: "smoke-secret-que-supera-treinta-y-dos-bytes",
      baseURL: API,
      webURL: PANEL,
      cookieDomain: "localhost",
      trustedOrigins: [PANEL],
      googleClientId: "",
      googleClientSecret: "",
      passwordBreachCheck: false,
    })
    const b = browser(failing)
    expect(
      (
        await b.post("/sign-up/email", {
          name: "Rosa Falla",
          firstName: "Rosa",
          email,
          password: "clave-de-rosa-1",
          termsVersion: LEGAL_VERSION,
        })
      ).status,
    ).toBeLessThan(300)
    down = true
    const withAccount = await b.post("/access-link/request", { email })
    const without = await b.post("/access-link/request", { email: "nadie-falla@sonrisa.test" })
    expect([withAccount.status, without.status]).toEqual([200, 200])
    expect(await withAccount.json()).toEqual(await without.json())
  }, 60_000)
})
