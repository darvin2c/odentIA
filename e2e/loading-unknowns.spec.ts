import { createHmac } from "node:crypto"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { contact } from "@odentia/db/schema/crm"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { hostUrl, tenant } from "./env"
import { api, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

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

/**
 * Mientras no llega el dato del que depende, la pantalla no ofrece lo que luego
 * retira: la página de quien aún no es paciente no anuncia «Clínica», y quien
 * dirige no ve «Agenda de hoy» si le toca «Mis pacientes».
 */

async function holdApi(page: import("@playwright/test").Page, matches: (url: URL) => boolean) {
  const gate = Promise.withResolvers<void>()
  await page.route(matches, async (route) => {
    await gate.promise
    await route.continue().catch(() => undefined)
  })
  return gate
}

test("la página de quien no se sabe qué es no anuncia lo de un paciente", async ({ owner, fixtureDb }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  const [person] = await fixtureDb
    .insert(contact)
    .values({ organizationId: org.id, displayName: "Rosa Contacto", phone: "+51911222333" })
    .returning({ id: contact.id })
  const seen: string[] = []
  const gate = await holdApi(page, (url) => url.pathname === `/api/people/${person.id}`)
  await gotoHydrated(page, tenant(org.slug, `/people/${person.id}`))
  const tabs = page.getByRole("tablist", { name: "Pestañas de la página" })
  await expect(tabs.getByRole("tab", { name: "Resumen" })).toBeVisible()
  for (const name of ["Clínica", "Plan", "Cobros"]) {
    if (await tabs.getByRole("tab", { name }).isVisible()) seen.push(name)
  }
  expect(seen).toEqual([])
  await expect(page.getByRole("button", { name: "Reservar cita" })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Alergias y alertas" })).toHaveCount(0)
  gate.resolve()
  await expect(page.getByRole("heading", { level: 1, name: "Rosa Contacto" })).toBeVisible()
  await expect(tabs.getByRole("tab", { name: "Clínica" })).toHaveCount(0)
})

test("desde la lista, la página de un contacto abre ya con lo suyo", async ({ owner, fixtureDb }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  const [person] = await fixtureDb
    .insert(contact)
    .values({ organizationId: org.id, displayName: "Luis Lista", phone: "+51911222334" })
    .returning({ id: contact.id })
  await gotoHydrated(page, tenant(org.slug, "/people?ver=por_registrar"))
  const link = page.getByRole("link", { name: "Luis Lista" }).first()
  await expect(link).toBeVisible()
  const gate = await holdApi(page, (url) => url.pathname === `/api/people/${person.id}`)
  await link.click()
  // Lo que ya dijo la lista: sus botones con nombre y ninguna pestaña clínica, sin esperar a la API.
  await expect(page.getByRole("button", { name: "Más acciones" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Clínica" })).toHaveCount(0)
  gate.resolve()
  await expect(page.getByRole("heading", { level: 1, name: "Luis Lista" })).toBeVisible()
})

test("Inicio de quien dirige no anticipa «Agenda de hoy»", async ({ owner }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  const gate = await holdApi(page, (url) => url.pathname.startsWith("/api/workspace/home"))
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(page.getByRole("heading", { name: "Te espera" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Agenda de hoy" })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Mis pacientes de hoy" })).toHaveCount(0)
  gate.resolve()
})

test("«Agregar medio de pago» no aparece a destiempo", async ({ owner }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  const gate = await holdApi(page, (url) => url.pathname === "/api/org/payment-methods")
  await gotoHydrated(page, tenant(org.slug, "/settings/payment-methods"))
  await expect(page.getByRole("button", { name: "Agregar medio de pago" })).toBeVisible()
  gate.resolve()
  await expect(page.locator("#payment-methods-title")).toBeVisible()
  await expect(page.getByRole("button", { name: "Agregar medio de pago" })).toBeEnabled()
})

test("la clínica pide los dos pasos con la pestaña abierta: su pantalla sale sin recargar a mano", async ({ owner, fixtureDb }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
  await fixtureDb.update(orgProfile).set({ requireTwoFactor: true }).where(eq(orgProfile.organizationId, org.id))
  expect((await api(page, "GET", "/api/org-profile", org.slug)).status).toBe(403)
  // El próximo pedido de cualquier pantalla lleva a la suya; el que sea puede adelantarse al clic.
  await page.getByRole("link", { name: "Agenda" }).first().click({ timeout: 3_000 }).catch(() => undefined)
  await expect(page.getByRole("heading", { level: 1 })).toContainText("pide verificación en dos pasos", { timeout: 15_000 })
})

test("Admin al recargar muestra su marco y el esqueleto de la pantalla abierta", async ({ owner, fixtureDb }) => {
  const { page, user } = owner
  await page.setViewportSize({ width: 1366, height: 860 })
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  await page.goto(`${ADMIN}/security`)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Continuar" }).click()
  await page.getByRole("button", { name: /No puedes escanear/ }).click()
  const secret = ((await page.locator("code").first().textContent()) ?? "").replace(/\s/g, "")
  await page.getByLabel(/código de 6 dígitos/i).fill(totpNow(secret))
  await page.getByText("Los guardé en un lugar seguro").click()
  await page.getByRole("button", { name: "Entrar a la administración" }).click()
  await expect(page).not.toHaveURL(/\/security/)
  await page.goto(`${ADMIN}/team`)
  await expect(page.getByRole("heading", { level: 1, name: /Equipo/ })).toBeVisible()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const gate = await holdApi(page, (url) => url.pathname === "/api/admin/access/session")
  await page.reload({ waitUntil: "commit" })
  // Con la sesión sin confirmar: el menú de quien entró y el título de esta pantalla, no una lista genérica.
  await expect(page.getByRole("link", { name: "Equipo y actividad" }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("heading", { level: 1, name: /Equipo/ })).toBeVisible()
  gate.resolve()
  await expect(page.locator("[data-slot=skeleton]:visible")).toHaveCount(0, { timeout: 15_000 })
  expect(errors).toEqual([])
})
