import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, STORE_ID, type Who } from "./entorno"

/**
 * El menú del día y Configuración en un navegador (lienzo «gestorIA como odentIA», tableros 4 y
 * 10; «gestorIA · Configuración, de nuevo», tablero 3), contra su servidor y su base de verdad:
 * - El menú lleva lo diario y, al pie, Configuración; la Ayuda está en la cabecera. Configuración
 *   abre en «Lo que falta», con sus grupos de tarea y cada parte en una línea.
 * - El buscador de Configuración encuentra una parte por lo que hay dentro y la abre con Enter.
 * - En el teléfono, Configuración es un índice: una parte por pantalla, sin «Cambiar sección».
 * - El pedido de soporte sale una vez, en la franja de arriba, y se responde en Equipo.
 * - Datos de la tienda: la «Hora de la tienda» se cambia y se vuelve a la de Lima.
 * - Tu marca: un nombre reservado se dice en su campo; el color elegido pinta la app al guardar.
 * - Ventas, al abrir Configuración, llega a sus avisos al celular, y si abre otra dirección se le
 *   dice.
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

test("Configuración abre en «Lo que falta», con sus grupos y cada parte en una línea", async ({
  page,
}) => {
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
  await expect(page.getByRole("heading", { name: "Configuración", level: 1 })).toBeVisible()
  const sections = page.getByRole("navigation", { name: "Configuración" })
  for (const name of [
    "Lo que falta",
    "Datos de la tienda",
    "Tu marca",
    "Sofi",
    "Cobros",
    "Entregas",
    "Equipo y repartidores",
    "Avisos al celular",
    "Plan y pagos",
  ])
    await expect(sections.getByRole("link", { name, exact: true })).toBeVisible()
  // Lo que falta, con lo guardado: o la lista con su cuenta, o una sola línea con todo listo.
  await expect(
    page
      .getByText(
        /^(Para (que Sofi venda sola|vender) te faltan? \d+ cosas?|Tienes todo para vender)/,
      )
      .first(),
  ).toBeVisible()
  const parts = page.getByRole("region", { name: "Cómo está cada parte" })
  await expect(parts.getByRole("link", { name: /^Cobros/ })).toBeVisible()
  await expect(parts.getByRole("link", { name: /^Equipo y repartidores/ })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "configuracion-escritorio")
  // Una línea abre su parte.
  await parts.getByRole("link", { name: /^Entregas/ }).click()
  await expect(page).toHaveURL(/\/configuracion\/entregas$/)
  // La dirección de antes lleva a su lugar nuevo.
  await page.goto(`${BASE}/pagos-y-entregas`)
  await expect(page).toHaveURL(/\/configuracion\/medios-de-pago$/)
  await expect(sections.getByRole("link", { name: "Cobros", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  )
})

test("el buscador de Configuración encuentra lo que hay dentro y lo abre con el teclado", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion`)
  // En escritorio va sobre la lista de partes (el de la portada es el del teléfono).
  const search = page.getByRole("combobox", { name: "Buscar en Configuración" }).first()
  await search.fill("shalom")
  const results = page.getByRole("listbox", { name: "Resultados en Configuración" })
  const agency = results.getByRole("option", { name: /Envío por agencia/ })
  await expect(agency).toBeVisible()
  // Cada resultado dice dónde está.
  await expect(agency).toContainText("Entregas")
  await shot(page, "configuracion-buscar-escritorio")
  await search.press("ArrowDown")
  await search.press("Enter")
  await expect(page).toHaveURL(/\/configuracion\/entregas$/)
  // El foco queda en el título de la parte abierta, no perdido en la página.
  await expect(page.getByRole("heading", { level: 1, name: "Entregas" })).toBeFocused()
  // «plantilla» (la de las zonas de Lima) lleva a Entregas.
  await search.fill("plantilla")
  await expect(results.getByRole("option").first()).toContainText("Entregas")
  // Con las palabras de quien vende, sin tildes.
  await search.fill("envio gratis")
  await expect(results.getByRole("option").first()).toContainText("Envío gratis")
  await search.press("Escape")
})

test("en el teléfono, Configuración es un índice: una parte por pantalla", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(PHONE)
  await page.goto(`${BASE}/configuracion`)
  // Sin la barra flotante de secciones: la portada es el índice, con su buscador.
  await expect(page.getByRole("button", { name: /Cambiar sección/ })).toBeHidden()
  await expect(page.getByRole("navigation", { name: "Configuración" })).toBeHidden()
  await expect(page.getByRole("combobox", { name: "Buscar en Configuración" }).last()).toBeVisible()
  const parts = page.getByRole("region", { name: "Cómo está cada parte" })
  await noSideScroll(page)
  await shot(page, "configuracion-telefono")
  await parts.getByRole("link", { name: /^Datos de la tienda/ }).click()
  await expect(page).toHaveURL(/\/configuracion\/datos$/)
  await noSideScroll(page)
  await shot(page, "datos-de-la-tienda-telefono")
  // «Configuración», arriba, vuelve al índice.
  await page.getByRole("main").getByRole("link", { name: "Configuración", exact: true }).click()
  await expect(page).toHaveURL(/\/configuracion$/)
})

test("el pedido de soporte sale una vez, arriba, y se responde en Equipo y repartidores", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo`)
  const strip = page.getByRole("region", { name: "Soporte de gestorIA" })
  await expect(strip.getByText(/pide mirar tu tienda 30 minutos/)).toBeVisible()
  // Ya no hay una tarjeta de soporte en cada apartado.
  await page.goto(`${BASE}/configuracion/marca`)
  await expect(page.getByRole("button", { name: "Dejar entrar" })).toHaveCount(0)
  await strip.getByRole("link", { name: /Revisar/ }).click()
  await expect(page).toHaveURL(/\/configuracion\/equipo$/)
  await expect(page.getByRole("heading", { name: "Equipo y repartidores" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Dejar entrar" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Repartidores", exact: true })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "equipo-escritorio")
})

test("la hora de la tienda se cambia en Datos de la tienda", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/datos`)
  const zone = page.getByRole("combobox", { name: "Hora de la tienda" })
  await expect(zone).toHaveText(/Lima/)
  await zone.click()
  await page.getByRole("option", { name: /^Bogota/ }).click()
  await expect(page.getByText("Aún no se guarda")).toBeVisible()
  await page.getByRole("button", { name: "Guardar" }).click()
  await expect(page.getByText("Datos de la tienda guardados")).toBeVisible()
  await expect(zone).toHaveText(/Bogota/)
  await shot(page, "datos-de-la-tienda-escritorio")
  // Vuelve a la de Lima, con el teclado.
  await zone.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("option", { name: /^Lima/ }).press("Enter")
  await page.getByRole("button", { name: "Guardar" }).focus()
  await page.keyboard.press("Enter")
  await expect(zone).toHaveText(/Lima/)
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

test("Ventas, al abrir Configuración, llega a sus avisos al celular", async ({ page }) => {
  await as("lucia")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/pedidos`)
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible()
  // La Ayuda es el botón de la cabecera, no un enlace del menú.
  await expect(page.getByRole("button", { name: "Ayuda", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Ayuda" })).toHaveCount(0)
  // Configuración le abre lo único suyo, sin pasar por «Lo que falta».
  await page.getByRole("link", { name: "Configuración" }).click()
  await expect(page).toHaveURL(/\/configuracion\/avisos$/)
  const sections = page.getByRole("navigation", { name: "Configuración" })
  await expect(sections.getByRole("link")).toHaveText(["Avisos al celular"])
  // La entrada de Configuración la lleva a lo suyo, no a una página vacía.
  await page.goto(`${BASE}/configuracion`)
  await expect(page).toHaveURL(/\/configuracion\/avisos$/)
  await page.goto(`${BASE}/configuracion/sofi`)
  await expect(page.getByText("Esto lo cambian el Dueño y el Administrador")).toBeVisible()
  // Una línea le dice por qué solo ve lo suyo, sin una tarjeta vacía.
  await expect(page.getByText(/^Aquí ves lo que cambias tú\./)).toBeVisible()
  await expect(page.getByRole("button", { name: /Probar|Escribir/ })).toHaveCount(0)
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "configuracion-ventas-telefono")
})
