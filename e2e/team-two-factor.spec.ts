/**
 * Verificación en dos pasos del equipo (ADR 0106), en pantalla: activarla en Mi
 * perfil con la clave escrita, pedirla a todo el equipo desde Equipo, que quien
 * no la tiene llegue a la pantalla de la clínica y vuelva tras activarla, que
 * no pueda desactivarla mientras la pidan, entrar con el código recordando el
 * navegador y restablecer la de alguien con su motivo.
 */
import { createHmac, randomUUID } from "node:crypto"
import { member, session, user as users } from "@odentia/db/schema/auth"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { PANEL, tenant } from "./env"
import { api, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

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

type Page = import("@playwright/test").Page

/** El alta en el cajón de Mi perfil (ya abierto): contraseña, clave escrita, código y códigos guardados. */
async function activate(page: Page, password: string): Promise<string> {
  const drawer = page.getByRole("dialog", { name: "Activar la verificación en dos pasos", exact: true }).or(page.getByRole("region", { name: "Activar la verificación en dos pasos", exact: true }))
  await drawer.getByLabel("Tu contraseña").fill(password)
  await drawer.getByRole("button", { name: "Continuar" }).click()
  const secret = ((await drawer.locator("code").first().textContent()) ?? "").replace(/\s/g, "")
  await expect(drawer.getByRole("img", { name: /Código QR/ })).toBeVisible()
  expect(secret.length).toBeGreaterThan(10)
  await drawer.getByLabel(/código de 6 dígitos/i).fill(totpNow(secret))
  const codes = page.getByRole("list", { name: "Códigos de respaldo" })
  await expect(codes.getByRole("listitem")).toHaveCount(10)
  await page.getByText("Los guardé en un lugar seguro").click()
  await page.getByRole("button", { name: "Terminar" }).click()
  return secret
}

test("verificación en dos pasos: activarla, pedirla al equipo, entrar con el código y restablecer a alguien", async ({ owner, createOwner, fixtureDb }, info) => {
  test.setTimeout(180_000)
  const { page, org, user } = owner
  const shot = async (target: Page, name: string) => info.attach(name, { body: await target.screenshot(), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })

  // Mi perfil: apagada, con lo que protege; se activa con la clave escrita a mano.
  await gotoHydrated(page, `${PANEL}/profile`)
  await expect(page.getByText("Apagada", { exact: true })).toBeVisible()
  await page.getByRole("link", { name: "Activar" }).click()
  // Las apps que se recomiendan, plegadas.
  await page.getByRole("button", { name: /Aún no tienes una app/ }).click()
  await expect(page.getByText(/Google Authenticator o Microsoft Authenticator/)).toBeVisible()
  const ownerSecret = await activate(page, user.password)
  await expect(page.getByText("Activa", { exact: true })).toBeVisible()
  await expect(page.getByText("Ninguna de tus clínicas: la activaste tú")).toBeVisible()
  await shot(page, "perfil-activa")
  const [ownerAccount] = await fixtureDb.select({ on: users.twoFactorEnabled }).from(users).where(eq(users.id, user.id))
  expect(ownerAccount?.on).toBe(true)

  // Una recepcionista del equipo, que además tiene su propia clínica.
  const reception = await createOwner("recepcion")
  await fixtureDb.insert(member).values({ id: randomUUID(), organizationId: org.id, userId: reception.user.id, role: "reception", createdAt: new Date() })

  // Equipo: quién la tiene y pedirla a todos, diciendo antes a quién le falta.
  await gotoHydrated(page, tenant(org.slug, "/settings/team"))
  const row = page.getByRole("row").filter({ hasText: reception.user.email })
  await expect(row).toContainText("Sin activar")
  await expect(page.getByRole("row").filter({ hasText: user.email })).toContainText("Activa")
  await page.getByRole("switch", { name: "Pedir verificación en dos pasos a todo el equipo" }).click()
  const ask = page.getByRole("dialog", { name: "Pedir verificación en dos pasos", exact: true }).or(page.getByRole("region", { name: "Pedir verificación en dos pasos", exact: true }))
  await expect(ask).toContainText("A 1 persona le falta activarla")
  await shot(page, "equipo-pedirla")
  await ask.getByRole("button", { name: "Pedirla desde ahora" }).click()
  await expect(page.getByText(/Avisamos por correo a 1 persona/)).toBeVisible()
  await expect(page.getByRole("switch", { name: "Pedir verificación en dos pasos a todo el equipo" })).toBeChecked()

  // La recepcionista: en esta clínica, su pantalla; la API lo exige, no la pantalla.
  const rp = reception.page
  await rp.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(rp, tenant(org.slug, "/home"))
  await expect(rp.getByRole("heading", { level: 1 })).toContainText("pide verificación en dos pasos")
  await rp.setViewportSize({ width: 390, height: 844 })
  await shot(rp, "clinica-la-pide-telefono")
  await rp.setViewportSize({ width: 1440, height: 900 })
  const blocked = await api(rp, "GET", "/api/org-profile", org.slug)
  expect(blocked.status).toBe(403)
  // Su otra clínica no cambia.
  expect((await api(rp, "GET", "/api/org-profile", reception.org.slug)).status).toBe(200)

  // «Activarla ahora» lleva a Mi perfil y, activada, de vuelta a la clínica.
  await rp.getByRole("link", { name: "Activarla ahora" }).click()
  await activate(rp, reception.user.password)
  await expect(rp).toHaveURL(new RegExp(`${org.slug}\\.`))
  await expect(rp.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()

  // Mientras su clínica la pida, no puede desactivarla (tampoco por la API).
  await gotoHydrated(rp, `${PANEL}/profile`)
  await expect(rp.getByRole("button", { name: "Desactivar" })).toBeDisabled()
  await expect(rp.getByText(/la pide a su equipo/).first()).toBeVisible()
  const off = await api<{ code?: string }>(rp, "POST", "/api/auth/two-factor/disable", undefined, { password: reception.user.password })
  expect(off.status).toBe(403)

  // Entrar de nuevo pide el código; recordar el navegador evita pedirlo la vez siguiente.
  await page.context().clearCookies({ name: /session_token/ })
  const signIn = await api<{ twoFactorRedirect?: boolean }>(page, "POST", "/api/auth/sign-in/email", undefined, { email: user.email, password: user.password })
  expect(signIn.body.twoFactorRedirect).toBe(true)
  await gotoHydrated(page, `${PANEL}/two-factor`)
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Escribe el código de tu app")
  await shot(page, "entrar-codigo")
  await page.getByText("Recordar este dispositivo 30 días").click()
  await page.getByLabel("Código de 6 dígitos").fill(totpNow(ownerSecret))
  await expect(page).not.toHaveURL(/two-factor/)
  // Tras el código el panel sigue a la clínica: se espera en una página quieta.
  await page.waitForLoadState("networkidle")
  await gotoHydrated(page, `${PANEL}/profile`)
  await page.context().clearCookies({ name: /session_token/ })
  const again = await api<{ twoFactorRedirect?: boolean }>(page, "POST", "/api/auth/sign-in/email", undefined, { email: user.email, password: user.password })
  expect(again.status).toBe(200)
  expect(again.body.twoFactorRedirect).toBeUndefined()

  // Restablecer a la recepcionista: pide el motivo, cierra sus sesiones y queda en la actividad.
  await gotoHydrated(page, tenant(org.slug, "/settings/team"))
  // Todas las cuentas de prueba se llaman igual: la fila se busca por su correo.
  await page.getByRole("row").filter({ hasText: reception.user.email }).getByRole("button", { name: /^Acciones de / }).click()
  await page.getByRole("menuitem", { name: "Restablecer verificación en dos pasos" }).click()
  const confirm = page.getByRole("alertdialog")
  await confirm.getByRole("button", { name: "Restablecer" }).click()
  await expect(confirm.getByText("Escribe el motivo")).toBeVisible()
  await confirm.getByLabel("Motivo").fill("Le robaron el teléfono; lo confirmó por llamada")
  await confirm.getByRole("button", { name: "Restablecer" }).click()
  await expect(confirm).toBeHidden()
  await expect(page.getByRole("row").filter({ hasText: reception.user.email })).toContainText("Sin activar")
  await shot(page, "equipo-restablecida")
  expect(await fixtureDb.select().from(session).where(eq(session.userId, reception.user.id))).toEqual([])
  const [event] = await fixtureDb
    .select({ metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(and(eq(auditEvent.organizationId, org.id), eq(auditEvent.action, "settings.two_factor_reset")))
  expect(event?.metadata).toEqual({ reason: "Le robaron el teléfono; lo confirmó por llamada" })
})
