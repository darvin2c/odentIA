import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, STORE_ID, type Who } from "./entorno"

/**
 * Lo nuevo de gestorIA en un navegador (ADR 0213), contra su servidor y su base de verdad:
 * - «Plan y pagos» del Dueño: subir el comprobante de un cobro sin pagar (un archivo que no es
 *   lo que dice se rechaza con su mensaje; una imagen válida queda «por enviar»).
 * - El aviso de soporte en cada sección: «Dejar entrar» abre la tienda a soporte, solo a mirar,
 *   y «Sacar ahora» la cierra.
 * - La conversación que Sofi no atendió (apagada) espera a una persona con su motivo, en «Te toca».
 * Cada pantalla en escritorio y a 390 px, sin desborde y con el botón principal por teclado. Las
 * capturas van a `gestoria/e2e/capturas/`.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1366, height: 860 }
const PHONE = { width: 390, height: 844 }
const BASE = `/tiendas/${STORE_ID}`

/** Un PNG de 1×1 de verdad. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true })
}

async function noSideScroll(page: Page) {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )
  expect(fits, "la página no se desborda a lo ancho").toBe(true)
}

/** Quién entra con la cuenta de mentira. */
async function as(who: Who) {
  const response = await fetch(`${ACCOUNT}/__como/${who}`, { method: "POST" })
  expect(response.ok).toBe(true)
}

test.describe.configure({ mode: "serial" })

test("el Dueño sube el comprobante de un cobro sin pagar", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/plan`)
  await expect(page.getByRole("heading", { name: "Plan y pagos" })).toBeVisible()
  await expect(page.getByText("Lo que se te cobró")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "plan-escritorio")

  // Con el teclado: el botón del cobro se enfoca y se abre con Enter.
  const upload = page.getByRole("button", { name: "Subir comprobante" })
  await upload.focus()
  await page.keyboard.press("Enter")
  const sheet = page.getByRole("dialog", { name: "Subir comprobante" })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText("Yapea al 999 000 000 y sube la captura.")).toBeVisible()
  // Dice ser un PDF y no lo es: el servidor mira el contenido.
  await sheet.locator('input[type="file"]').setInputFiles({
    name: "comprobante.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("<html><body>no soy un pdf</body></html>"),
  })
  await sheet.getByRole("button", { name: "Subir comprobante" }).click()
  await expect(sheet.getByText("Sube el comprobante en JPG, PNG, WebP o PDF").first()).toBeVisible()
  await shot(page, "comprobante-rechazado-escritorio")

  await sheet.locator('input[type="file"]').setInputFiles({
    name: "captura.png",
    mimeType: "image/png",
    buffer: PNG,
  })
  await sheet.getByRole("button", { name: "Subir comprobante" }).click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByText("Comprobante por enviar")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "comprobante-por-enviar-escritorio")

  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByText("Comprobante por enviar")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "plan-telefono")
  await page.getByRole("button", { name: "Subir comprobante" }).click()
  await expect(page.getByRole("dialog", { name: "Subir comprobante" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "comprobante-hoja-telefono")
})

test("la tienda deja entrar a soporte, solo a mirar, y lo saca", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo`)
  await expect(page.getByText("Ana de Soporte pide mirar tu tienda 30 minutos")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-por-aceptar-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "soporte-por-aceptar-telefono")

  const accept = page.getByRole("button", { name: "Dejar entrar" })
  await accept.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText(/Ana de Soporte puede mirar tu tienda hasta el/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Sacar ahora" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-adentro-telefono")
  await page.setViewportSize(DESKTOP)
  await shot(page, "soporte-adentro-escritorio")

  // Soporte entra con su cuenta y solo mira: sin pedidos, sin Sofi, sin el plan.
  await as("ana")
  await page.goto("/")
  await page.getByRole("link", { name: /Calzados Rosa/ }).click()
  await expect(page.getByText(/Entraste como soporte de gestorIA, solo a mirar/)).toBeVisible()
  await expect(page).toHaveURL(/\/catalogo$/)
  const nav = page.getByRole("navigation", { name: /Secciones de Calzados Rosa/ })
  await expect(nav.getByRole("link", { name: "Pedidos" })).toHaveCount(0)
  await expect(nav.getByRole("link", { name: "Plan y pagos" })).toHaveCount(0)
  await noSideScroll(page)
  await shot(page, "soporte-mirando-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "soporte-mirando-telefono")

  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/equipo`)
  await expect(page.getByText("Puede mirar")).toBeVisible()
  await page.getByRole("button", { name: "Sacar ahora" }).click()
  await expect(page.getByText("Terminó")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-terminado-equipo-escritorio")
})

test("la conversación que Sofi no atendió espera a una persona, con su motivo", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/reportes`)
  await expect(page.getByText("Una conversación espera a una persona")).toBeVisible()
  await expect(page.getByText("Carla: Sofi está apagada")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "espera-a-una-persona-escritorio")
  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByText("Carla: Sofi está apagada")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "espera-a-una-persona-telefono")
})
