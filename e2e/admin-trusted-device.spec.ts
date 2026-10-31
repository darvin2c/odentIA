/**
 * Equipo reconocido de la administración (ADR 0090), en pantalla: enrolar con
 * la clave escrita, volver a entrar sin código en el mismo navegador, que desde
 * otro país se pida y diga por qué (también con la página abierta) y que
 * cerrar sesión olvide el equipo.
 */
import { createHmac } from "node:crypto"
import { adminStaff, adminTrustedDevice } from "@odentia/db/schema/admin-core"
import { user as users } from "@odentia/db/schema/auth"
import { eq } from "drizzle-orm"
import { API, hostUrl } from "./env"
import { api, expect, test } from "./fixtures"

const ADMIN = hostUrl("admin")

function totpNow(base32: string): string {
  let bits = ""
  for (const char of base32.replace(/\s|=/g, "").toUpperCase())
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char).toString(2).padStart(5, "0")
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? [])
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const mac = createHmac("sha1", key).update(counter).digest()
  const offset = (mac.at(-1) ?? 0) & 0xf
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0")
}

test("equipo reconocido: sin código en el mismo equipo; se pide desde otro país o tras cerrar sesión", async ({ owner, fixtureDb }) => {
  const { page, user } = owner
  await page.setViewportSize({ width: 1280, height: 860 })
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })

  // Enrolar desde la pantalla real.
  await page.goto(`${ADMIN}/security`)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Continuar" }).click()
  await page.getByRole("button", { name: /No puedes escanear/ }).click()
  const secret = (await page.locator("code").first().textContent()) ?? ""
  await page.getByLabel(/código de 6 dígitos/i).fill(totpNow(secret))
  await page.getByText("Los guardé en un lugar seguro").click()
  await page.getByRole("button", { name: "Entrar a la administración" }).click()
  await expect(page).not.toHaveURL(/\/security/)
  const [account] = await fixtureDb.select({ on: users.twoFactorEnabled }).from(users).where(eq(users.id, user.id))
  expect(account?.on).toBe(false)
  expect((await fixtureDb.select().from(adminTrustedDevice).where(eq(adminTrustedDevice.userId, user.id))).length).toBe(1)

  // Una sesión nueva sin haber cerrado la anterior (la que vence sola): este equipo entra sin código.
  const signIn = async () => {
    const res = await api<{ twoFactorRedirect?: boolean }>(page, "POST", "/api/auth/sign-in/email", undefined, {
      email: user.email,
      password: user.password,
    })
    expect(res.status).toBe(200)
    expect(res.body.twoFactorRedirect).toBeUndefined()
  }
  await page.context().clearCookies({ name: /session_token/ })
  await signIn()
  await page.goto(ADMIN)
  await expect(page).not.toHaveURL(/\/security/)
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  // El título ya se ve al recargar, mientras la API confirma la sesión: se espera a que la confirme.
  await expect(page.locator("[data-slot=skeleton]:visible")).toHaveCount(0, { timeout: 15_000 })

  // Desde otro país: se pide el código y dice por qué.
  // Con la página abierta: lo siguiente que pide datos lleva a poner el código.
  await page.setExtraHTTPHeaders({ "cf-ipcountry": "CL" })
  await page.getByRole("navigation").getByRole("link", { name: "Organizaciones" }).first().click()
  await expect(page).toHaveURL(/\/security/)
  // Y al cargar de nuevo, también.
  await page.goto(ADMIN)
  await expect(page).toHaveURL(/\/security/)
  await expect(page.getByText("Entras desde otro país: confirma que eres tú.", { exact: false })).toBeVisible()
  await expect(page.getByText("Después, en este equipo no te lo volveremos a pedir.")).toBeVisible()
  await page.setExtraHTTPHeaders({})

  // Cerrar sesión olvida el equipo: al volver a entrar se pide el código.
  expect((await api(page, "POST", "/api/auth/sign-out", undefined, {})).status).toBe(200)
  const [device] = await fixtureDb.select().from(adminTrustedDevice).where(eq(adminTrustedDevice.userId, user.id))
  expect(device?.revokedAt).not.toBeNull()
  await signIn()
  await page.goto(ADMIN)
  await expect(page).toHaveURL(/\/security/)
  await expect(page.getByText("Tu contraseña ya está", { exact: false })).toBeVisible()
})
