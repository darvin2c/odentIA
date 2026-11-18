import { createAuth, emailVerificationUrl, REMINDER_VERIFICATION_TTL_SECONDS } from "@odentia/auth"
import { user } from "@odentia/db/schema/auth"
import type { MailTemplate } from "@odentia/mail"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { type AccountLifecycleOptions, type LifecycleApp, runAccountLifecycleTick } from "./account-lifecycle.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const SECRET = "secreto-de-prueba-0123456789abcdef"
const API = "https://api.odentia.test"
const PANEL = "https://app.odentia.test"
const DAY = 86_400_000

function appOn(brand: "odentia" | "latidia", api: string, panel: string): LifecycleApp {
  return {
    brand,
    onboardingUrl: `${panel}/onboarding`,
    verificationUrl: (email) =>
      emailVerificationUrl({
        secret: SECRET,
        authUrl: api,
        email,
        callbackURL: `${panel}/`,
        expiresInSeconds: REMINDER_VERIFICATION_TTL_SECONDS,
      }),
  }
}

function options(sent: Array<{ to: string } & MailTemplate>, now: Date): AccountLifecycleOptions {
  return {
    notify: {
      sendReminder: async (to, mail) => {
        sent.push({ to, ...mail })
      },
    },
    // Lo mismo que arma `index.ts` con las variables de la API: cada app en su dominio.
    apps: {
      odentia: appOn("odentia", API, PANEL),
      latidia: appOn("latidia", "https://api.latidia.test", "https://app.latidia.test"),
    },
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

it("cada aviso es de la app donde se registró, y a gestorIA no le llega «crea tu clínica»", async () => {
  // Lienzo A, tablero 12: «a un vendedor de gestorIA le llegaría eso».
  const now = new Date()
  const old = new Date(now.getTime() - 4 * DAY)
  await ownerDb.insert(user).values([
    { id: "w-rosa", name: "Rosa Paz", email: "rosa@worker.test", emailVerified: false, createdAt: old, signupApp: "latidia" },
    { id: "w-mario", name: "Mario Quispe", email: "mario@worker.test", emailVerified: true, createdAt: old, signupApp: "latidia" },
    { id: "w-ana", name: "Ana Soto", email: "ana@worker.test", emailVerified: true, createdAt: old },
    { id: "w-tienda", name: "Tienda Lima", email: "tienda@worker.test", emailVerified: true, createdAt: old, signupApp: "gestoria" },
    { id: "w-tienda-nueva", name: "Tienda Sur", email: "tienda-sur@worker.test", emailVerified: false, createdAt: old, signupApp: "gestoria" },
  ])
  const sent: Array<{ to: string } & MailTemplate> = []

  const result = await runAccountLifecycleTick(ownerDb, options(sent, now))
  expect(result.errors).toEqual([])
  const to = (email: string) => sent.find((mail) => mail.to === email)

  // latidIA: con su marca y su dominio, en los dos avisos.
  expect(to("rosa@worker.test")?.subject).toBe("Completa tu cuenta de latidIA")
  expect(to("rosa@worker.test")?.text).toMatch(/https:\/\/api\.latidia\.test\/api\/auth\/verify-email\?token=/)
  expect(to("mario@worker.test")?.subject).toBe("Tu cuenta de latidIA está verificada: crea o acepta tu clínica")
  expect(to("mario@worker.test")?.text).toContain("https://app.latidia.test/onboarding")
  // Quien se registró antes de que se guardara la app sigue con odentIA.
  expect(to("ana@worker.test")?.subject).toBe("Tu cuenta de odentIA está verificada: crea o acepta tu clínica")
  // gestorIA: ni «crea tu clínica» ni un recordatorio con la marca de otra app.
  expect(to("tienda@worker.test")).toBeUndefined()
  expect(to("tienda-sur@worker.test")).toBeUndefined()
})
