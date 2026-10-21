import { createAuth, emailVerificationUrl, REMINDER_VERIFICATION_TTL_SECONDS } from "@odentia/auth"
import { user } from "@odentia/db/schema/auth"
import type { MailTemplate } from "@odentia/mail"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { type AccountLifecycleOptions, runAccountLifecycleTick } from "./account-lifecycle.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const SECRET = "secreto-de-prueba-0123456789abcdef"
const API = "https://api.odentia.test"
const PANEL = "https://app.odentia.test"
const DAY = 86_400_000

function options(sent: Array<{ to: string } & MailTemplate>, now: Date): AccountLifecycleOptions {
  return {
    notify: {
      sendReminder: async (to, mail) => {
        sent.push({ to, ...mail })
      },
    },
    onboardingUrl: `${PANEL}/onboarding`,
    // Lo mismo que arma `index.ts` con las variables de la API.
    verificationUrl: (email) =>
      emailVerificationUrl({
        secret: SECRET,
        authUrl: API,
        email,
        callbackURL: `${PANEL}/`,
        expiresInSeconds: REMINDER_VERIFICATION_TTL_SECONDS,
      }),
    verificationDays: REMINDER_VERIFICATION_TTL_SECONDS / 86_400,
    now,
  }
}

it("a los 3 días sin verificar llega «Completa tu cuenta» con el botón, y el botón deja la cuenta verificada", async () => {
  // darvin2c/odentIA#170: Lucía borró el primer correo; el del registro ya venció (dura 1 hora).
  const now = new Date()
  await ownerDb.insert(user).values({
    id: "w-lucia",
    name: "Lucía Rojas",
    email: "lucia@worker.test",
    emailVerified: false,
    createdAt: new Date(now.getTime() - 4 * DAY),
  })
  const sent: Array<{ to: string } & MailTemplate> = []

  const result = await runAccountLifecycleTick(ownerDb, options(sent, now))
  expect(result).toMatchObject({ reminders: 1, errors: [] })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ to: "lucia@worker.test", subject: "Completa tu cuenta de odentIA" })
  expect(sent[0]!.text).toContain("Sirve durante 7 días")
  const link = /Verificar mi correo: (\S+)/.exec(sent[0]!.text)?.[1] ?? ""
  expect(link).toMatch(/^https:\/\/api\.odentia\.test\/api\/auth\/verify-email\?token=[^&]+&callbackURL=/)
  expect(sent[0]!.html).toContain(new URL(link).searchParams.get("token"))

  // El botón lo canjea el Better Auth de la API, con su configuración y su base.
  const auth = createAuth({
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
  })
  const response = await auth.handler(new Request(link))
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(`${PANEL}/`)
  expect(response.headers.get("set-cookie")).toContain("session_token=")
  const [row] = await ownerDb.select({ verified: user.emailVerified }).from(user).where(eq(user.id, "w-lucia"))
  expect(row?.verified).toBe(true)

  // Sale una sola vez.
  const again = await runAccountLifecycleTick(ownerDb, options(sent, now))
  expect(again.reminders).toBe(0)
  expect(sent).toHaveLength(1)
})
