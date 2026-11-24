import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { appContractRequest, saasAccount } from "@odentia/db/schema/admin-accounts"
import { session } from "@odentia/db/schema/auth"
import { saasPlan } from "@odentia/db/schema/saas-billing"
import type { Page } from "@playwright/test"
import { desc, eq } from "drizzle-orm"
import { hostUrl } from "../../e2e/env"
import { expect, test } from "../../e2e/fixtures"
import { gotoHydrated } from "../../e2e/hydration"

/**
 * Lo que la administración le pide a gestorIA (ADR 0214), en un navegador: en la página de una
 * cuenta de gestorIA se pide dejar entrar a soporte (gestorIA de mentira: «hecho») y quitar a una
 * persona («falló», con su motivo); un pedido que espera se ve «Pendiente»; y en Cobros y planes
 * se abre la cuenta de un cliente con su plan. Cada pantalla, en escritorio y a 390 px, sin
 * desborde y con el botón principal por teclado. Las capturas van a `e2e/capturas/admin/`.
 */

const SHOTS = resolve("capturas", "admin")

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true })
}

/** Sin desplazamiento de lado: lo que se ve cabe en el ancho de la pantalla. */
async function noSideScroll(page: Page) {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )
  expect(fits, "la página no se desborda a lo ancho").toBe(true)
}

/**
 * La lista de pedidos se lee al cargar la página: se recarga hasta que aparece lo que respondió la
 * app (la API lo manda en el momento; el trabajador, si no llegó).
 */
async function untilShown(page: Page, text: string) {
  await expect(async () => {
    await page.reload()
    await expect(page.getByText(text)).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
}

const DESKTOP = { width: 1366, height: 860 }
const PHONE = { width: 390, height: 844 }

test("la administración le pide a gestorIA y ve cómo quedó cada pedido", async ({
  owner,
  fixtureDb,
}) => {
  test.skip(!process.env.E2E_GESTORIA_URL, "Sin el gestorIA de mentira del arnés")
  const { page, user } = owner
  const tag = randomUUID().slice(0, 8)

  // La persona es personal de odentIA con su segundo factor verificado en esta sesión.
  const [current] = await fixtureDb
    .select({ id: session.id })
    .from(session)
    .where(eq(session.userId, user.id))
    .orderBy(desc(session.createdAt))
    .limit(1)
  const factorId = randomUUID()
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  await fixtureDb
    .insert(twoFactor)
    .values({ id: factorId, userId: user.id, secret: "e2e", backupCodes: "[]", verified: true })
  await fixtureDb.insert(adminSessionVerification).values({
    userId: user.id,
    sessionId: current!.id,
    factorId,
    method: "totp",
    expiresAt: new Date(Date.now() + 86_400_000),
  })

  // Un plan de gestorIA y una cuenta suya.
  await fixtureDb.insert(saasPlan).values({
    code: `tienda-${tag}`,
    name: `Tienda ${tag}`,
    product: "gestoria",
    currency: "USD",
    priceCents: 1900,
    creditCents: 500,
    conversationMicros: 300_000,
    trialCreditCents: 0,
    trialMaxCreditCents: 0,
  })
  const accountId = randomUUID()
  await fixtureDb.insert(saasAccount).values({
    id: accountId,
    app: "gestoria",
    externalRef: randomUUID(),
    name: `Calzados ${tag}`,
    country: "PE",
    ownerUserId: user.id,
  })
  const accountPage = hostUrl("admin", `/accounts/${accountId}`)
  await page.setViewportSize(DESKTOP)
  await gotoHydrated(page, accountPage)
  await expect(page.getByRole("heading", { name: "Lo que se le pide a su app" })).toBeVisible()
  await expect(page.getByText("Todavía no se le pidió nada a su app.")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "cuenta-escritorio-sin-pedidos")

  // Dejar entrar a soporte, con el teclado: el botón se enfoca y se abre con Enter.
  const support = page.getByRole("button", { name: "Dejar entrar a soporte" })
  await support.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { name: "Dejar entrar a soporte" })).toBeVisible()
  await page.getByLabel("Para qué").fill("Ver por qué no se ven las fotos del catálogo")
  await shot(page, "soporte-cajon-escritorio")
  await page.getByRole("button", { name: "Pedirlo" }).click()
  await expect(page.getByRole("heading", { name: "Dejar entrar a soporte" })).toHaveCount(0)
  // La API lo manda en el momento; gestorIA de mentira responde «hecho».
  await untilShown(page, "Pedido a la tienda: su Dueño o un Administrador decide si entras.")
  await expect(page.getByText("Hecho", { exact: true }).first()).toBeVisible()

  // Quitar a una persona: gestorIA responde que es el único Dueño.
  await page.getByRole("button", { name: "Quitar a una persona" }).click()
  await page.getByLabel("Correo de su cuenta").fill(user.email)
  await page.getByLabel("Motivo").fill("Lo pidió por correo")
  await page.getByRole("button", { name: "Pedirlo" }).click()
  await untilShown(page, "Es el único Dueño de la tienda: antes, la tienda tiene que tener otro Dueño.")
  await expect(page.getByText("Falló", { exact: true })).toBeVisible()
  await expect(page.getByText(`${user.email} · Lo pidió por correo`)).toBeVisible()

  // Uno que todavía no llega (sin respuesta de la app), anotado después: se ve «Pendiente».
  await fixtureDb.insert(appContractRequest).values({
    app: "gestoria",
    accountId,
    type: "soporte.entrar",
    payload: {
      type: "soporte.entrar",
      data: { staff: { name: "Equipo" }, minutes: 15, reason: "Revisar el catálogo" },
    },
    requestedBy: user.id,
    // No le toca salir todavía: se ve «Pendiente».
    nextAttemptAt: new Date(Date.now() + 86_400_000),
    attempts: 1,
    lastError: "La app no respondió a tiempo",
  })

  await page.reload()
  await expect(page.getByText("Pendiente", { exact: true })).toBeVisible()
  await expect(page.getByText("Todavía no llega: La app no respondió a tiempo")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "cuenta-escritorio-pendiente-hecho-y-fallo")

  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByText("Falló", { exact: true })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "cuenta-telefono")
  await page.getByRole("button", { name: "Dejar entrar a soporte" }).click()
  await expect(page.getByRole("heading", { name: "Dejar entrar a soporte" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-cajon-telefono")
  await page.keyboard.press("Escape")

  // Abrir la cuenta de un cliente con su plan, desde Cobros y planes.
  await page.setViewportSize(DESKTOP)
  await gotoHydrated(page, hostUrl("admin", "/billing"))
  // El botón espera a los planes: sin uno activo de gestorIA se queda apagado.
  const open = page.getByRole("button", { name: "Abrir una cuenta" })
  await open.scrollIntoViewIfNeeded()
  await expect(open).toBeEnabled()
  await open.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { name: "Abrir una cuenta de gestorIA" })).toBeVisible()
  await page.getByLabel("Nombre de la tienda").fill(`Zapatos ${tag}`)
  await page.getByLabel("Correo de su dueño").fill(user.email)
  await page.getByRole("combobox", { name: "Plan" }).click()
  await page.getByRole("option", { name: new RegExp(`Tienda ${tag}`) }).click()
  await noSideScroll(page)
  await shot(page, "abrir-cuenta-cajon-escritorio")
  await page.getByRole("button", { name: "Abrir la cuenta" }).click()
  await expect(page.getByRole("heading", { name: "Abrir una cuenta de gestorIA" })).toHaveCount(0)
  // La cuenta sale también en Suscripciones: la fila es la de «Cuentas de otras apps».
  const row = page
    .locator("section[aria-labelledby=otras-apps]")
    .getByRole("listitem")
    .filter({ hasText: `Zapatos ${tag}` })
  await expect(row).toBeVisible()
  await expect(row).toContainText(`Tienda ${tag}`)
  await shot(page, "cuentas-de-otras-apps-escritorio")
  await row.getByRole("button", { name: "Abrir" }).click()
  await untilShown(page, "Tienda abierta: su dueño ya puede entrar.")
  await expect(page.getByText("Abrir la cuenta").first()).toBeVisible()
  await shot(page, "cuenta-abierta-escritorio")

  await page.setViewportSize(PHONE)
  await gotoHydrated(page, hostUrl("admin", "/billing"))
  await page.getByRole("button", { name: "Abrir una cuenta" }).click()
  await expect(page.getByRole("heading", { name: "Abrir una cuenta de gestorIA" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "abrir-cuenta-cajon-telefono")

  // Lo que recibió gestorIA, firmado y con su clave.
  const received = (await (await fetch(`${process.env.E2E_GESTORIA_URL}/__pedidos`)).json()) as {
    type: string
  }[]
  expect(received.map((one) => one.type)).toEqual(
    expect.arrayContaining(["soporte.entrar", "equipo.quitar", "cuenta.abrir"]),
  )
})
