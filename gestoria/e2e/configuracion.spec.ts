import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, STORE_ID, type Who } from "./entorno"

/**
 * El menú del día y Configuración en un navegador (lienzo «gestorIA como odentIA», tableros 4 y
 * 10), contra su servidor y su base de verdad:
 * - El menú lleva lo diario y, al pie, Configuración; la Ayuda está en la cabecera. Configuración
 *   tiene sus grupos.
 * - Datos de la tienda: la «Hora de la tienda» se cambia y se vuelve a la de Lima.
 * - Tu marca: un nombre reservado se dice en su campo; el color elegido pinta la app al guardar.
 * - Ventas ve en Configuración solo sus avisos al celular, y si abre otra dirección se le dice.
 * Cada pantalla en escritorio y a 390 px, sin desborde. Las capturas van a `gestoria/e2e/capturas/`.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1366, height: 860 }
const PHONE = { width: 390, height: 844 }
const BASE = `/tiendas/${STORE_ID}`

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

test("el menú del día lleva Configuración al pie, con sus grupos", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/pedidos`)
  const nav = page.getByRole("navigation", { name: "Principal" })
  for (const name of ["Inicio", "Pedidos", "Catálogo", "Reportes"])
    await expect(nav.getByRole("link", { name })).toBeVisible()
  // Lo que se mudó a Configuración ya no está en el menú del día.
  for (const name of ["Sofi", "Pagos y entregas", "Equipo"])
    await expect(nav.getByRole("link", { name, exact: true })).toHaveCount(0)
  await page.getByRole("link", { name: "Configuración" }).click()
  await expect(page).toHaveURL(/\/configuracion$/)
  const sections = page.getByRole("navigation", { name: "Configuración" })
  for (const name of [
    "Datos de la tienda",
    "Tu marca",
    "Equipo",
    "Sofi",
    "Medios de pago",
    "Formas de entrega y zonas",
    "Avisos al celular",
    "Plan y pagos",
  ])
    await expect(sections.getByRole("link", { name })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "configuracion-escritorio")
  // La dirección de antes lleva a su lugar nuevo.
  await page.goto(`${BASE}/pagos-y-entregas`)
  await expect(page).toHaveURL(/\/configuracion\/medios-de-pago$/)
  await expect(page.getByRole("heading", { name: "Medios de pago" }).first()).toBeVisible()
})

test("la hora de la tienda se cambia en Datos de la tienda", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion`)
  const zone = page.getByLabel("Hora de la tienda")
  await expect(zone).toHaveValue("America/Lima")
  await zone.selectOption("America/Bogota")
  await expect(page.getByText("Aún no se guarda")).toBeVisible()
  await page.getByRole("button", { name: "Guardar" }).click()
  await expect(page.getByText("Datos de la tienda guardados")).toBeVisible()
  await expect(zone).toHaveValue("America/Bogota")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "datos-de-la-tienda-telefono")
  // Vuelve a la de Lima, con el teclado.
  await page.setViewportSize(DESKTOP)
  await zone.focus()
  await zone.selectOption("America/Lima")
  await page.getByRole("button", { name: "Guardar" }).focus()
  await page.keyboard.press("Enter")
  await expect(zone).toHaveValue("America/Lima")
  await expect(page.getByText("Aún no se guarda")).toHaveCount(0)
})

test("Tu marca: el link reservado se dice en su campo y el color pinta la app", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/marca`)
  const link = page.getByLabel("Nombre del link")
  // Se escribe como se guarda: sin tildes, mayúsculas ni espacios.
  await link.fill("Admin")
  await expect(link).toHaveValue("admin")
  await page.getByRole("button", { name: "Guardar" }).click()
  await expect(page.getByText(/Ese nombre está reservado/)).toBeVisible()
  await link.fill("Calzados Rosa")
  await link.blur()
  await expect(link).toHaveValue("calzados-rosa")
  const code = page.getByRole("textbox", { name: "Otro color" })
  await code.fill("#BE185D")
  await page.getByRole("button", { name: "Guardar" }).click()
  await expect(page.getByText("Tu marca quedó guardada")).toBeVisible()
  // El color de la tienda ya es el primario de la app.
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--primary-fill").trim(),
      ),
    )
    .not.toBe("#cc4604")
  await noSideScroll(page)
  await shot(page, "tu-marca-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "tu-marca-telefono")
  // Vuelve al naranja de gestorIA, para los demás recorridos.
  await page.setViewportSize(DESKTOP)
  await page.getByRole("button", { name: "Naranja, el de gestorIA" }).click()
  await page.getByRole("button", { name: "Guardar" }).click()
  await expect(page.getByText("Tu marca quedó guardada").first()).toBeVisible()
})

test("Ventas ve en Configuración solo sus avisos al celular", async ({ page }) => {
  await as("lucia")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/pedidos`)
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible()
  // La Ayuda es el botón de la cabecera, no un enlace del menú.
  await expect(page.getByRole("button", { name: "Ayuda", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Ayuda" })).toHaveCount(0)
  // Configuración le abre lo único suyo, sin pasar por «Datos de la tienda».
  await page.getByRole("link", { name: "Configuración" }).click()
  await expect(page).toHaveURL(/\/configuracion\/avisos$/)
  const sections = page.getByRole("navigation", { name: "Configuración" })
  await expect(sections.getByRole("link")).toHaveText(["Avisos al celular"])
  await page.goto(`${BASE}/configuracion/sofi`)
  await expect(page.getByText("Esto lo ajusta quien configura la tienda")).toBeVisible()
  await expect(page.getByRole("button", { name: /Probar|Escribir/ })).toHaveCount(0)
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "configuracion-ventas-telefono")
})
