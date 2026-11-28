import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, choose, STORE_ID, surface, type Who } from "./entorno"

/**
 * Entregas por distrito en un navegador (lienzo «gestorIA · Configuración, de nuevo», tablero 7),
 * contra su servidor y su base de verdad:
 * - Rosa dice desde dónde despacha y usa la plantilla de Lima: el mapa se pinta con 6 zonas.
 * - En el mapa, con el teclado, pasa un distrito a «No entrego ahí».
 * - Cambia el precio de una zona en su cajón, elige quién paga el viaje fallido y agrega el recojo
 *   y la agencia.
 * En escritorio y a 390 px, sin desborde. Las capturas van a `gestoria/e2e/capturas/`.
 */

const SHOTS = resolve(process.env.CAPTURAS ?? "capturas")
const DESKTOP = { width: 1440, height: 900 }
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

async function as(who: Who) {
  const response = await fetch(`${ACCOUNT}/__como/${who}`, { method: "POST" })
  expect(response.ok).toBe(true)
}

test.describe.configure({ mode: "serial" })

test("Rosa arma sus zonas con la plantilla de Lima y las ajusta en el mapa y en cada zona", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/entregas`)
  await expect(page.getByRole("heading", { name: "Entregas", level: 1 })).toBeVisible()

  // Sin zonas: desde dónde despacha y la plantilla.
  const reparto = page.getByRole("region", { name: "Reparto" })
  const fleetStart = reparto.getByRole("button", { name: "Usar la plantilla de Lima" })
  await expect(fleetStart).toBeVisible()
  await shot(page, "entregas-empezar-escritorio")
  await choose(
    reparto.getByRole("combobox", { name: "¿Desde qué distrito despachas?" }),
    "La Victoria",
  )
  await fleetStart.click()
  const map = page.getByRole("group", { name: "Mapa de Lima y Callao por zona" })
  await expect(
    map.getByRole("button", { name: /^Lince: zona 1, Centro y Lima Moderna/ }),
  ).toBeVisible()
  await expect(map.getByRole("button", { name: /^Lurín: zona 6, Lejanos y playas/ })).toBeVisible()
  await expect(map.getByRole("button", { name: /La Victoria.*Despachas desde aquí/ })).toBeVisible()
  await expect(page.getByRole("list", { name: "Zonas" })).toContainText("6 · Lejanos y playas")
  await shot(page, "entregas-escritorio")

  // Con el teclado: de La Victoria a la derecha (San Luis), Enter y «No entrego ahí».
  await map.getByRole("button", { name: /La Victoria/ }).focus()
  await page.keyboard.press("ArrowRight")
  await expect(map.getByRole("button", { name: /^San Luis/ })).toBeFocused()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitemradio", { name: "No entrego ahí" }).click()
  await expect(map.getByRole("button", { name: "San Luis: no entregas ahí" })).toBeVisible()

  // ↓ y ↑ solo mueven: no abren el menú del distrito que se deja. Enter abre el del que tiene foco.
  const lima = map.getByRole("button", { name: /^Lima: / })
  await lima.focus()
  await page.keyboard.press("ArrowDown")
  await expect(lima).not.toBeFocused()
  await expect(page.getByRole("menu")).toHaveCount(0)
  const below = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("menu")).toContainText(below.split(":")[0] ?? "")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toHaveCount(0)

  // Una zona en su cajón: el precio de Lima Este.
  await page.getByRole("button", { name: "Editar Lima Este" }).click()
  const zone = surface(page, "Lima Este")
  await zone.getByLabel("Precio").fill("15")
  // El mapa se sigue viendo con el cajón abierto.
  await expect(map).toBeVisible()
  await shot(page, "entregas-zona-escritorio")
  await zone.getByRole("button", { name: "Guardar" }).click()
  await expect(zone).toHaveCount(0)
  const eastRow = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: "Editar Lima Este" }) })
  await expect(eastRow).toContainText("S/ 15")

  // Quién paga si la clienta no está: un toque.
  await page.getByRole("radio", { name: "Cada viaje lo paga ella" }).click()
  await expect(page.getByRole("radio", { name: "Cada viaje lo paga ella" })).toBeChecked()

  // El recojo y la agencia, en sus tarjetas.
  const pickup = page.getByRole("region", { name: "Recojo en tienda" })
  // Si otro recorrido ya los agregó, quedan como están.
  await expect(pickup.getByRole("button", { name: /Agregar recojo|Editar/ })).toBeVisible()
  if (await pickup.getByRole("button", { name: "Agregar recojo" }).isVisible()) {
    await pickup.getByRole("button", { name: "Agregar recojo" }).click()
    const form = surface(page, "Nuevo recojo en tienda")
    await form.getByLabel("Dirección").fill("Jr. Gamarra 650, La Victoria · stand 214")
    await form.getByRole("button", { name: "Guardar" }).click()
    await expect(form).toHaveCount(0)
    await expect(pickup).toContainText("Lun a sáb · 10 a. m. – 7 p. m.")
  }

  const agency = page.getByRole("region", { name: "Envío a provincia por agencia" })
  await expect(agency.getByRole("button", { name: /Agregar agencia|Editar/ })).toBeVisible()
  if (await agency.getByRole("button", { name: "Agregar agencia" }).isVisible()) {
    await agency.getByRole("button", { name: "Agregar agencia" }).click()
    const form = surface(page, "Envío a provincia")
    await form.getByLabel("Cuánto").fill("8")
    await form.getByRole("button", { name: "Guardar" }).click()
    await expect(form).toHaveCount(0)
    await expect(agency).toContainText("Lo paga la clienta al recoger")
  }

  await noSideScroll(page)
  await shot(page, "entregas-completo-escritorio")

  // En el teléfono: las zonas en una lista, sin mapa y sin desborde.
  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByRole("button", { name: "Editar Centro y Lima Moderna" })).toBeVisible()
  await expect(map).toBeHidden()
  await noSideScroll(page)
  await shot(page, "entregas-telefono")
  await page.getByRole("button", { name: "Editar Centro y Lima Moderna" }).click()
  await expect(surface(page, "Centro y Lima Moderna")).toBeVisible()
  await shot(page, "entregas-zona-telefono")
})
