/**
 * La cuenta conoce las apps (ADR 0201, paso 2 del lienzo A), contra Better Auth y una base
 * real: recuerda la app de la entrada donde se registró cada persona, firma el token con que
 * otra app la reconoce y avisa a las apps que son otro sistema cuando se cierra una cuenta.
 */
import { createPublicKey, verify } from "node:crypto"
import { type AccountApp, createAuth, LEGAL_VERSION, verifyAccountEvent } from "@odentia/auth"
import { accountEvent, user } from "@odentia/db/schema/auth"
import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import {
  accountEventBackoffSeconds,
  accountEventSendersFromEnv,
  deliverAccountEvents,
} from "./account-events.js"
import { closeMyAccount } from "./admin-organizations.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const SECRET = "secreto-de-prueba-que-supera-treinta-y-dos"
const API = "https://api.odentia.test"
const PANEL = "https://app.odentia.test"

function makeAuth(app: AccountApp, signedTokens = false) {
  return createAuth({
    // El rol de la aplicación, como en producción: así se prueban también sus permisos.
    db: appDb,
    ownerDb,
    mailer: { send: async () => {} },
    secret: SECRET,
    baseURL: API,
    webURL: PANEL,
    cookieDomain: "odentia.test",
    trustedOrigins: [PANEL],
    googleClientId: "",
    googleClientSecret: "",
    passwordBreachCheck: false,
    app,
    signedTokens,
  })
}

async function signUp(
  auth: ReturnType<typeof makeAuth>,
  email: string,
  extra: Record<string, unknown> = {},
) {
  const response = await trySignUp(auth, email, extra)
  expect(response.status, await response.clone().text()).toBeLessThan(300)
}

function trySignUp(
  auth: ReturnType<typeof makeAuth>,
  email: string,
  extra: Record<string, unknown> = {},
) {
  return auth.handler(
    new Request(`${API}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: PANEL },
      body: JSON.stringify({
        name: "Prueba",
        email,
        password: "clave-de-prueba-1",
        termsVersion: LEGAL_VERSION,
        ...extra,
      }),
    }),
  )
}

async function signIn(auth: ReturnType<typeof makeAuth>, email: string): Promise<string> {
  await ownerDb.update(user).set({ emailVerified: true }).where(eq(user.email, email))
  const response = await auth.handler(
    new Request(`${API}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: PANEL },
      body: JSON.stringify({ email, password: "clave-de-prueba-1" }),
    }),
  )
  expect(response.status).toBe(200)
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ")
}

const signupAppOf = async (email: string) =>
  (await ownerDb.select({ app: user.signupApp }).from(user).where(eq(user.email, email)))[0]?.app

describe("la app de la entrada", () => {
  it("cada entrada anota su app al registrarse, y nadie la elige desde afuera", async () => {
    await signUp(makeAuth("latidia"), "rosa@apps.test")
    expect(await signupAppOf("rosa@apps.test")).toBe("latidia")
    const forged = await trySignUp(makeAuth("odentia"), "ana@apps.test", { signupApp: "gestoria" })
    expect(forged.status).toBe(400)
    expect(await signupAppOf("ana@apps.test")).toBeUndefined()
    await signUp(makeAuth("odentia"), "ana@apps.test")
    expect(await signupAppOf("ana@apps.test")).toBe("odentia")
  })
})

describe("el token firmado", () => {
  it("otra app verifica quién entró con la llave pública, sin leer esta base", async () => {
    const auth = makeAuth("vistia", true)
    await signUp(auth, "lucia@apps.test")
    const cookie = await signIn(auth, "lucia@apps.test")
    const tokenResponse = await auth.handler(
      new Request(`${API}/api/auth/token`, { headers: { cookie } }),
    )
    expect(tokenResponse.status).toBe(200)
    const { token } = (await tokenResponse.json()) as { token: string }
    const jwksResponse = await auth.handler(new Request(`${API}/api/auth/jwks`))
    expect(jwksResponse.status).toBe(200)
    const { keys } = (await jwksResponse.json()) as { keys: Array<Record<string, string>> }

    // Lo que haría el servidor de la otra app: la llave por su `kid` y la firma Ed25519.
    const [head = "", payload = "", signature = ""] = token.split(".")
    const header = JSON.parse(Buffer.from(head, "base64url").toString()) as {
      alg: string
      kid: string
    }
    expect(header.alg).toBe("EdDSA")
    const jwk = keys.find((key) => key.kid === header.kid)
    expect(jwk).toBeDefined()
    expect(jwk).not.toHaveProperty("d")
    const publicKey = createPublicKey({
      key: { kty: jwk!.kty, crv: jwk!.crv, x: jwk!.x },
      format: "jwk",
    })
    expect(
      verify(
        null,
        Buffer.from(`${head}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true)
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >
    const [row] = await ownerDb
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, "lucia@apps.test"))
    expect(claims).toMatchObject({
      sub: row!.id,
      aud: "vistia",
      iss: API,
      email: "lucia@apps.test",
      emailVerified: true,
    })
    expect(Number(claims.exp) - Number(claims.iat)).toBe(15 * 60)
    // Lo justo para la copia de la cuenta: nada de contraseñas, términos ni segundo factor.
    expect(Object.keys(claims).sort()).toEqual([
      "aud",
      "email",
      "emailVerified",
      "exp",
      "iat",
      "image",
      "iss",
      "name",
      "sub",
    ])
    // La llave privada queda cifrada en la base.
    const [stored] = (await ownerDb.execute(
      sql`select private_key from auth.jwks limit 1`,
    )) as unknown as { private_key: string }[]
    expect(stored?.private_key).not.toContain('"d"')
  })

  it("apagado, la sesión no firma nada", async () => {
    const auth = makeAuth("odentia")
    await signUp(auth, "mario@apps.test")
    const cookie = await signIn(auth, "mario@apps.test")
    const session = await auth.handler(
      new Request(`${API}/api/auth/get-session`, { headers: { cookie } }),
    )
    expect(session.status).toBe(200)
    expect(session.headers.get("set-auth-jwt")).toBeNull()
  })
})

describe("cerrar una cuenta avisa a las apps que son otro sistema", () => {
  const SIGNING = `whsec_${Buffer.alloc(32, 3).toString("base64")}`
  const sender = { app: "gestoria" as const, url: "https://gestoria.test/avisos", secret: SIGNING }

  it("el aviso se escribe con el cierre, sale firmado y se reintenta hasta que la app lo recibe", async () => {
    await signUp(makeAuth("odentia"), "cierra@apps.test")
    const [who] = await ownerDb
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, "cierra@apps.test"))
    await ownerDb.transaction((tx) => closeMyAccount(tx, who!.id))
    const pending = await ownerDb
      .select()
      .from(accountEvent)
      .where(eq(accountEvent.userId, who!.id))
    expect(pending).toMatchObject([
      { app: "gestoria", type: "cuenta.cerrada", attempts: 0, deliveredAt: null },
    ])

    // La app no responde: queda anotado y espera su turno.
    const received: Request[] = []
    let answer = 503
    const fakeFetch = (async (url: string, init: RequestInit) => {
      received.push(new Request(url, init))
      return new Response(null, { status: answer })
    }) as unknown as typeof fetch
    const now = new Date()
    expect(await deliverAccountEvents(ownerDb, [sender], { fetch: fakeFetch, now })).toEqual({
      delivered: 0,
      failed: 1,
    })
    const [failed] = await ownerDb
      .select()
      .from(accountEvent)
      .where(eq(accountEvent.id, pending[0]!.id))
    expect(failed).toMatchObject({
      attempts: 1,
      deliveredAt: null,
      lastError: "La app respondió 503",
    })
    expect(failed!.nextAttemptAt.getTime()).toBe(
      now.getTime() + accountEventBackoffSeconds(1) * 1000,
    )
    // Antes de su turno no vuelve a salir.
    expect(await deliverAccountEvents(ownerDb, [sender], { fetch: fakeFetch, now })).toEqual({
      delivered: 0,
      failed: 0,
    })

    // En su turno sale con el mismo id, y la app lo reconoce como de la cuenta.
    answer = 200
    const later = new Date(now.getTime() + 60_000)
    expect(await deliverAccountEvents(ownerDb, [sender], { fetch: fakeFetch, now: later })).toEqual(
      { delivered: 1, failed: 0 },
    )
    expect(received).toHaveLength(2)
    const ids = received.map((request) => request.headers.get("webhook-id"))
    expect(ids).toEqual([pending[0]!.id, pending[0]!.id])
    const last = received[1]!
    const read = verifyAccountEvent({
      secret: SIGNING,
      headers: last.headers,
      body: await last.text(),
    })
    expect(read).toMatchObject({
      id: pending[0]!.id,
      type: "cuenta.cerrada",
      data: { userId: who!.id },
    })
    // Recibido, no sale más.
    expect(
      await deliverAccountEvents(ownerDb, [sender], {
        fetch: fakeFetch,
        now: new Date(later.getTime() + 86_400_000),
      }),
    ).toEqual({
      delivered: 0,
      failed: 0,
    })
  })

  it("sin dirección ni secreto de la app, los avisos esperan; a medias, lo dice", () => {
    expect(accountEventSendersFromEnv({})).toEqual({ senders: [], problems: [] })
    expect(
      accountEventSendersFromEnv({ GESTORIA_ACCOUNT_EVENTS_URL: "https://gestoria.test/avisos" })
        .problems,
    ).toHaveLength(1)
    expect(
      accountEventSendersFromEnv({
        GESTORIA_ACCOUNT_EVENTS_URL: "http://gestoria.test/avisos",
        GESTORIA_ACCOUNT_EVENTS_SECRET: SIGNING,
      }).senders,
    ).toEqual([])
    expect(
      accountEventSendersFromEnv({
        GESTORIA_ACCOUNT_EVENTS_URL: "https://gestoria.test/avisos",
        GESTORIA_ACCOUNT_EVENTS_SECRET: "corto",
      }).senders,
    ).toEqual([])
    expect(
      accountEventSendersFromEnv({
        GESTORIA_ACCOUNT_EVENTS_URL: "https://gestoria.test/avisos",
        GESTORIA_ACCOUNT_EVENTS_SECRET: SIGNING,
      }),
    ).toEqual({ senders: [sender], problems: [] })
  })
})
