import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { beforeEach, describe, expect, it } from "vitest"
import { arrivalOn, PASE_COOKIE, type PaseSister, pase, paseFits } from "./pase.js"

/**
 * El pase entre dominios con dos instancias reales de Better Auth (una por dominio, la misma
 * base y el mismo secreto, como la API), sobre una base en memoria. El navegador es un frasco
 * de cookies por servidor: así se ve qué cookie llega a cada dominio y cuál no.
 */
const SECRET = "pase-test-secret-0123456789abcdef0123456789"
const ODENTIA = "odentia.test"
const LATIDIA = "latidia.test"
const sisters: PaseSister[] = [
  { domain: ODENTIA, authURL: `https://api.${ODENTIA}/api/auth` },
  { domain: LATIDIA, authURL: `https://api.${LATIDIA}/api/auth` },
]

type Db = Record<string, Record<string, unknown>[]>
let db: Db
const instance = (domain: string) =>
  betterAuth({
    secret: SECRET,
    baseURL: `https://api.${domain}`,
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, autoSignIn: false },
    advanced: { crossSubDomainCookies: { enabled: true, domain } },
    rateLimit: { enabled: false },
    plugins: [
      pase({ domain, sisters, onSessionReplaced: async (from, to) => void replaced.push([from, to]) }),
    ],
  })
let auths: Record<string, ReturnType<typeof instance>>
let replaced: [string, string][] = []

beforeEach(() => {
  replaced = []
  db = { user: [], session: [], account: [], verification: [] }
  auths = { [ODENTIA]: instance(ODENTIA), [LATIDIA]: instance(LATIDIA) }
})

/** Las cookies de un navegador, por dominio de la cookie (la de la marca, por servidor). */
class Browser {
  jar = new Map<string, Map<string, string>>()

  cookiesFor(host: string): string {
    const pairs: string[] = []
    for (const [scope, cookies] of this.jar) {
      if (host === scope || host.endsWith(`.${scope}`))
        for (const [name, value] of cookies) pairs.push(`${name}=${value}`)
    }
    return pairs.join("; ")
  }

  store(host: string, response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map((part) => part.trim())
      const [name, ...rest] = (pair ?? "").split("=")
      const value = rest.join("=")
      const domainAttr = attributes.find((attr) => attr.toLowerCase().startsWith("domain="))
      const scope = domainAttr ? domainAttr.slice(7).replace(/^\./, "") : host
      const maxAge = attributes.find((attr) => attr.toLowerCase().startsWith("max-age="))
      const cookies = this.jar.get(scope) ?? new Map<string, string>()
      if (!value || maxAge === "Max-Age=0") cookies.delete(name ?? "")
      else cookies.set(name ?? "", value)
      this.jar.set(scope, cookies)
    }
  }

  /** Un GET de navegación, sin seguir la redirección. */
  async open(url: string): Promise<Response> {
    const host = new URL(url).hostname
    const domain = host.endsWith(LATIDIA) ? LATIDIA : ODENTIA
    const response = await auths[domain]!.handler(
      new Request(url, {
        headers: { cookie: this.cookiesFor(host), "sec-fetch-mode": "navigate" },
      }),
    )
    this.store(host, response)
    return response
  }

  /** Sigue las redirecciones de la API hasta salir de ella; devuelve la dirección final. */
  async follow(url: string): Promise<string> {
    let current = url
    for (let hop = 0; hop < 6; hop++) {
      if (!new URL(current).hostname.startsWith("api.")) return current
      const response = await this.open(current)
      const location = response.headers.get("location")
      if (!location)
        throw new Error(
          `Sin redirección en ${current}: ${response.status} ${await response.text()}`,
        )
      current = location
    }
    throw new Error("Demasiados saltos")
  }

  async who(domain: string): Promise<string | null> {
    const response = await auths[domain]!.handler(
      new Request(`https://api.${domain}/api/auth/get-session`, {
        headers: { cookie: this.cookiesFor(`api.${domain}`) },
      }),
    )
    const body = (await response.json()) as { user?: { email: string } } | null
    return body?.user?.email ?? null
  }
}

async function signIn(browser: Browser, domain: string, email: string) {
  const auth = auths[domain]!
  const exists = db.user?.some((row) => row.email === email)
  if (!exists)
    await auth.api.signUpEmail({ body: { email, password: "clave-segura-123", name: email } })
  const response = await auth.handler(
    new Request(`https://api.${domain}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `https://app.${domain}` },
      body: JSON.stringify({ email, password: "clave-segura-123" }),
    }),
  )
  expect(response.status).toBe(200)
  browser.store(`api.${domain}`, response)
}

const clinic = `https://pediatria.${LATIDIA}/home`
const goTo = (target: string, from = ODENTIA) =>
  `https://api.${LATIDIA}/api/auth/pase/ir?desde=${from}&next=${encodeURIComponent(target)}`

describe("el pase entre dominios", () => {
  it("lleva la misma sesión al otro dominio, sin pedir la clave", async () => {
    const rosa = new Browser()
    await signIn(rosa, ODENTIA, "rosa@test.dev")
    expect(await rosa.who(LATIDIA)).toBeNull()
    expect(await rosa.follow(goTo(clinic))).toBe(clinic)
    expect(await rosa.who(LATIDIA)).toBe("rosa@test.dev")
    // Es la misma sesión: una sola fila.
    expect(db.session).toHaveLength(1)
    // La marca no queda en el navegador.
    expect(rosa.cookiesFor(`api.${LATIDIA}`)).not.toContain(PASE_COOKIE)
  })

  it("cerrar la sesión en un dominio la cierra en los dos", async () => {
    const rosa = new Browser()
    await signIn(rosa, ODENTIA, "rosa@test.dev")
    await rosa.follow(goTo(clinic))
    const out = await auths[LATIDIA]!.handler(
      new Request(`https://api.${LATIDIA}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          cookie: rosa.cookiesFor(`api.${LATIDIA}`),
          origin: `https://pediatria.${LATIDIA}`,
        },
      }),
    )
    expect(out.status).toBe(200)
    rosa.store(`api.${LATIDIA}`, out)
    expect(await rosa.who(ODENTIA)).toBeNull()
  })

  it("un pase sirve una sola vez", async () => {
    const rosa = new Browser()
    await signIn(rosa, ODENTIA, "rosa@test.dev")
    const toOrigin = (await rosa.open(goTo(clinic))).headers.get("location") ?? ""
    const redeem = (await rosa.open(toOrigin)).headers.get("location") ?? ""
    expect(redeem).toContain("/pase/canjear")
    // Guarda la marca para el segundo intento, como si nadie la hubiera borrado.
    const mark = rosa.jar.get(`api.${LATIDIA}`)?.get(PASE_COOKIE)
    expect((await rosa.open(redeem)).headers.get("location")).toBe(clinic)
    expect(await rosa.who(LATIDIA)).toBe("rosa@test.dev")

    const other = new Browser()
    other.jar.set(`api.${LATIDIA}`, new Map([[PASE_COOKIE, mark ?? ""]]))
    expect(await other.follow(redeem)).toBe(clinic)
    expect(await other.who(LATIDIA)).toBeNull()
  })

  it("no lo canjea otro navegador: un enlace mandado por WhatsApp no deja a nadie dentro de otra cuenta", async () => {
    const darvin = new Browser()
    await signIn(darvin, ODENTIA, "darvin@test.dev")
    const toOrigin = (await darvin.open(goTo(clinic))).headers.get("location") ?? ""
    const redeem = (await darvin.open(toOrigin)).headers.get("location") ?? ""
    // Darvin manda su enlace de canje; Rosa lo abre en su navegador, sin la marca de Darvin.
    const rosa = new Browser()
    expect(await rosa.follow(redeem)).toBe(clinic)
    expect(await rosa.who(LATIDIA)).toBeNull()
    // Ni con una marca propia: no es la de quien pidió el pase.
    await rosa.open(goTo(clinic))
    expect(await rosa.follow(redeem)).toBe(clinic)
    expect(await rosa.who(LATIDIA)).toBeNull()
    // Y el pase ya se gastó: Darvin tampoco lo usa después.
    expect(await darvin.follow(redeem)).toBe(clinic)
    expect(await darvin.who(LATIDIA)).toBeNull()
  })

  it("vencido no sirve", async () => {
    const rosa = new Browser()
    await signIn(rosa, ODENTIA, "rosa@test.dev")
    const toOrigin = (await rosa.open(goTo(clinic))).headers.get("location") ?? ""
    const redeem = (await rosa.open(toOrigin)).headers.get("location") ?? ""
    for (const row of db.verification ?? []) row.expiresAt = new Date(Date.now() - 1000)
    expect(await rosa.follow(redeem)).toBe(clinic)
    expect(await rosa.who(LATIDIA)).toBeNull()
  })

  it("si en el destino estaba otra persona, queda la que venía y la sesión anterior se cierra", async () => {
    const mostrador = new Browser()
    await signIn(mostrador, LATIDIA, "doctora@test.dev")
    expect(await mostrador.who(LATIDIA)).toBe("doctora@test.dev")
    await signIn(mostrador, ODENTIA, "rosa@test.dev")
    expect(await mostrador.follow(goTo(clinic))).toBe(clinic)
    expect(await mostrador.who(LATIDIA)).toBe("rosa@test.dev")
    const left = (db.session ?? []).map((row) => row.userId)
    const doctora = db.user?.find((row) => row.email === "doctora@test.dev")?.id
    expect(left).not.toContain(doctora)
    expect(replaced).toEqual([])
  })

  it("si en el destino estaba la misma persona con otra sesión, lo suyo pasa a la que llega", async () => {
    const rosa = new Browser()
    await signIn(rosa, LATIDIA, "rosa@test.dev")
    const before = (db.session ?? [])[0]?.id
    await signIn(rosa, ODENTIA, "rosa@test.dev")
    const arriving = (db.session ?? [])[1]?.id
    expect(await rosa.follow(goTo(clinic))).toBe(clinic)
    expect(replaced).toEqual([[before, arriving]])
    expect((db.session ?? []).map((row) => row.id)).toEqual([arriving])
  })

  it("sin sesión en el origen llega igual, sin sesión: la app pide entrar", async () => {
    const nadie = new Browser()
    expect(await nadie.follow(goTo(clinic))).toBe(clinic)
    expect(await nadie.who(LATIDIA)).toBeNull()
  })

  it("no lleva a una dirección de otro sitio ni acepta un origen ajeno", async () => {
    const rosa = new Browser()
    await signIn(rosa, ODENTIA, "rosa@test.dev")
    expect((await rosa.open(goTo("https://malo.example/robar"))).status).toBe(400)
    expect((await rosa.open(goTo(`https://pediatria.${ODENTIA}/home`))).status).toBe(400)
    // Emitir para un destino ajeno, o para uno del grupo con una dirección de otro sitio: no.
    const emit = (to: string, next: string) =>
      `https://api.${ODENTIA}/api/auth/pase/emitir?a=${to}&n=${"a".repeat(32)}&next=${encodeURIComponent(next)}`
    expect((await rosa.open(emit("malo.example", "https://malo.example/x"))).status).toBe(400)
    expect((await rosa.open(emit(LATIDIA, "https://malo.example/x"))).status).toBe(400)
    // Desde un dominio que no es del grupo, sin pase: directo a la app.
    expect(await rosa.follow(goTo(clinic, "malo.example"))).toBe(clinic)
    expect(await rosa.who(LATIDIA)).toBeNull()
    // Canjear con una dirección de otro sitio: no.
    expect(
      (
        await rosa.open(
          `https://api.${LATIDIA}/api/auth/pase/canjear?t=x&next=${encodeURIComponent("https://malo.example")}`,
        )
      ).status,
    ).toBe(400)
  })
})

describe("las reglas del pase", () => {
  it("solo deja en https del dominio o de sus subdominios", () => {
    expect(arrivalOn("https://pediatria.latidia72.com/home?x=1", ".latidia72.com")).toBe(
      "https://pediatria.latidia72.com/home?x=1",
    )
    expect(arrivalOn("https://latidia72.com.malo.example/", "latidia72.com")).toBeNull()
    expect(arrivalOn("https://malolatidia72.com/", "latidia72.com")).toBeNull()
    expect(arrivalOn("http://pediatria.latidia72.com/", "latidia72.com")).toBeNull()
    expect(arrivalOn("https://user:pass@pediatria.latidia72.com/", "latidia72.com")).toBeNull()
    expect(arrivalOn("javascript:alert(1)", "latidia72.com")).toBeNull()
    expect(arrivalOn(undefined, "latidia72.com")).toBeNull()
  })

  it("compara la marca, el dominio y el plazo", () => {
    const mark = "b".repeat(32)
    const stored = { session: "s", mark: "x", domain: "latidia72.com" }
    expect(paseFits(stored, new Date(Date.now() + 60_000), "latidia72.com", mark)).toBe(false)
    expect(
      paseFits(
        { ...stored, domain: "vistia20.com" },
        new Date(Date.now() + 60_000),
        "latidia72.com",
        mark,
      ),
    ).toBe(false)
    expect(paseFits(stored, new Date(Date.now() + 60_000), "latidia72.com", null)).toBe(false)
  })
})
