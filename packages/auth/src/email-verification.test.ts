import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { describe, expect, it } from "vitest"
import { emailVerificationUrl, REMINDER_VERIFICATION_TTL_SECONDS } from "./email-verification.js"

const SECRET = "secreto-de-prueba-0123456789abcdef"

/** Better Auth con la misma verificación de correo que `createAuth`, sobre una base en memoria. */
function memoryAuth() {
  const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] }
  const auth = betterAuth({
    secret: SECRET,
    baseURL: "https://api.odentia.test",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: { sendOnSignUp: false, autoSignInAfterVerification: true, sendVerificationEmail: async () => {} },
    trustedOrigins: ["https://app.odentia.test"],
  })
  return { auth, db }
}

function link(email: string, expiresInSeconds = REMINDER_VERIFICATION_TTL_SECONDS) {
  return emailVerificationUrl({
    secret: SECRET,
    authUrl: "https://api.odentia.test/",
    email,
    callbackURL: "https://app.odentia.test/",
    expiresInSeconds,
  })
}

describe("enlace de verificación del recordatorio", () => {
  it("lo canjea la ruta de Better Auth: verifica la cuenta, abre la sesión y lleva al panel", async () => {
    const { auth, db } = memoryAuth()
    await auth.api.signUpEmail({ body: { name: "Lucía Rojas", email: "Lucia@Correo.test", password: "una-clave-larga-123" } })
    expect(db.user[0]?.emailVerified).toBe(false)

    const url = await link("Lucia@Correo.test")
    expect(url).toMatch(/^https:\/\/api\.odentia\.test\/api\/auth\/verify-email\?token=[^&]+&callbackURL=https%3A%2F%2Fapp\.odentia\.test%2F$/)
    const response = await auth.handler(new Request(url))

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("https://app.odentia.test/")
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=")
    expect(db.user[0]?.emailVerified).toBe(true)
  })

  it("con la cuenta ya verificada solo lleva al panel, sin abrir otra sesión", async () => {
    const { auth, db } = memoryAuth()
    await auth.api.signUpEmail({ body: { name: "Lucía Rojas", email: "lucia@correo.test", password: "una-clave-larga-123" } })
    const url = await link("lucia@correo.test")
    await auth.handler(new Request(url))
    const sessions = db.session.length

    const again = await auth.handler(new Request(url))
    expect(again.status).toBe(302)
    expect(again.headers.get("location")).toBe("https://app.odentia.test/")
    expect(again.headers.get("set-cookie")).toBeNull()
    expect(db.session.length).toBe(sessions)
  })

  it("vencido, no verifica y lo dice al volver al panel", async () => {
    const { auth, db } = memoryAuth()
    await auth.api.signUpEmail({ body: { name: "Lucía Rojas", email: "lucia@correo.test", password: "una-clave-larga-123" } })
    const url = await link("lucia@correo.test", -60)

    const response = await auth.handler(new Request(url))
    expect(response.headers.get("location")).toBe("https://app.odentia.test/?error=TOKEN_EXPIRED")
    expect(db.user[0]?.emailVerified).toBe(false)
  })

  it("sirve 7 días", async () => {
    const token = new URL(await link("lucia@correo.test")).searchParams.get("token") ?? ""
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { iat: number; exp: number }
    expect(payload.exp - payload.iat).toBe(7 * 24 * 60 * 60)
  })
})
