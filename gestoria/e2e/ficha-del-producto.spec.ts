import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, API_PORT, STORE_ID, WEB, type Who } from "./entorno"

/**
 * La ficha del producto (lienzo «La ficha del producto», PR 3) en un navegador, contra su servidor
 * y su base de verdad:
 * - El catálogo es una tabla; al abrir una fila se abre la ficha en página completa.
 * - La cuadrícula de variantes se llena con el teclado (un número, Mayúscula y las flechas para
 *   un rango) y pegando desde una hoja (texto con tabulaciones). Se guarda sola: subir el stock es
 *   una entrada del kardex; bajarlo pide el motivo.
 * - El margen se ve al momento al cambiar el precio; «Deshacer» lo devuelve.
 * - Ventas la ve sin cambiarla, sin costos, y el servidor rechaza su cambio.
 * Escritorio y 390 px, sin desborde. Las capturas van a `gestoria/e2e/capturas/`.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const BASE = `/tiendas/${STORE_ID}`
const API = `http://127.0.0.1:${API_PORT}`
const STORE = `/api/tiendas/${STORE_ID}`

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

async function as(who: Who | "nadie") {
  const response = await fetch(`${ACCOUNT}/__como/${who}`, { method: "POST" })
  expect(response.ok).toBe(true)
}

/** Lo que haría la pantalla, desde aquí: con el token que firma la cuenta de mentira. */
// biome-ignore lint/suspicious/noExplicitAny: el recorrido lee respuestas JSON de forma libre
async function call(method: string, path: string, body?: unknown): Promise<any> {
  const { token } = (await (await fetch(`${ACCOUNT}/api/auth/token`)).json()) as { token: string }
  return fetch(`${API}${path}`, {
    method,
    headers: {
      origin: WEB,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function json(method: string, path: string, body?: unknown) {
  const response = await call(method, path, body)
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

/** Una zapatilla blanca y negra, de la 35 a la 38, con una entrada con su costo. */
async function prepare() {
  await json("GET", "/api/yo")
  const created = await json("POST", `${STORE}/productos`, {
    name: "Zapatilla de cuero",
    category: "Zapatillas",
    listPriceCents: 12900,
    minPriceCents: 9900,
    options: [
      { name: "Color", values: ["blanca", "negra"] },
      { name: "Talla", values: ["35", "36", "37", "38"] },
    ],
  })
  const id = created.product.id as string
  const variants =
    created.product.variants ?? (await json("GET", `${STORE}/productos/${id}`)).product.variants
  const first = (variants as { id: string; optionValues: string[] }[]).find(
    (v) => v.optionValues.join() === "negra,38",
  )!
  await json("POST", `${STORE}/variantes/${first.id}/movimientos`, {
    kind: "entrada",
    quantity: 1,
    unitCostCents: 6800,
  })
  return id
}

/** Una celda de la cuadrícula por su talla y su color (en el escritorio, tallas en filas). */
const cell = (page: Page, size: string, color: string) =>
  page.locator(`td[aria-label^="${size} ${color}:"]`)

async function saved(page: Page) {
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /^Guardado$/ })
      .first(),
  ).toBeVisible({
    timeout: 15_000,
  })
}

test.describe.configure({ mode: "serial" })

let productId = ""

test("la ficha: la cuadrícula con el teclado y pegando, el margen y deshacer", async ({ page }) => {
  await as("rosa")
  productId = await prepare()
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo`)
  // El catálogo es una tabla; la fila abre la ficha.
  const row = page.getByRole("row", { name: /Zapatilla de cuero/ })
  await expect(row).toBeVisible()
  await expect(row.getByText("Disponible")).toBeVisible()
  await row.click()
  await expect(page).toHaveURL(new RegExp(`/catalogo/${productId}$`))
  await expect(page.getByRole("heading", { name: "Zapatilla de cuero", level: 1 })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Lo que sabe Sofi de este producto" }),
  ).toBeVisible()
  await noSideScroll(page)

  // Un número en una celda y Enter: queda y baja a la siguiente.
  await cell(page, "35", "blanca").click()
  await page.keyboard.type("3")
  await page.keyboard.press("Enter")
  await expect(cell(page, "35", "blanca")).toHaveAttribute("aria-label", /: 3/)
  // Mayúscula y las flechas eligen un rango; un número lo llena entero.
  await cell(page, "36", "blanca").click()
  await page.keyboard.press("Shift+ArrowDown")
  await page.keyboard.press("Shift+ArrowDown")
  await page.keyboard.press("Shift+ArrowRight")
  await page.keyboard.type("2")
  await page.keyboard.press("Enter")
  for (const size of ["36", "37", "38"])
    for (const color of ["blanca", "negra"])
      await expect(cell(page, size, color)).toHaveAttribute("aria-label", /: 2/)
  await saved(page)

  // Pegar desde una hoja: filas con saltos de línea y columnas con tabulaciones.
  await cell(page, "35", "blanca").click()
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData("text/plain", "5\t4\n6\t1\n")
    document
      .querySelector('[role="grid"]')
      ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
  })
  await expect(cell(page, "35", "blanca")).toHaveAttribute("aria-label", /: 5/)
  await expect(cell(page, "35", "negra")).toHaveAttribute("aria-label", /: 4/)
  await expect(cell(page, "36", "blanca")).toHaveAttribute("aria-label", /: 6/)
  // La 36 negra baja de 2 a 1: pide el motivo antes de guardar esa parte.
  const why = page.getByRole("region", { name: /Bajaste el stock/ })
  await expect(why).toBeVisible()
  await why.getByRole("radio", { name: "Conté y corregí" }).click()
  await saved(page)
  await shot(page, "ficha-cuadricula-escritorio")

  // El kardex: la entrada de la cuadrícula y el ajuste con su motivo.
  const sheet = (await json("GET", `${STORE}/productos/${productId}`)).product
  const negra36 = sheet.variants.find(
    (v: { optionValues: string[] }) => v.optionValues.join() === "negra,36",
  )
  const kardex = await json("GET", `${STORE}/variantes/${negra36.id}/kardex`)
  expect(kardex.movements[0]).toMatchObject({
    kind: "ajuste",
    quantity: -1,
    reason: "Conté y corregí",
  })
  expect(kardex.movements[1]).toMatchObject({ kind: "entrada", quantity: 2 })

  // Deshacer lo pegado, ya guardado, devuelve el stock de verdad (bajar pide el motivo otra vez).
  const stockOf = async (combo: string) =>
    (await json("GET", `${STORE}/productos/${productId}`)).product.variants.find(
      (v: { optionValues: string[] }) => v.optionValues.join() === combo,
    ).stock as number
  await page.getByRole("button", { name: "Deshacer", exact: true }).first().click()
  await expect(cell(page, "35", "blanca")).toHaveAttribute("aria-label", /: 3/)
  await expect(cell(page, "36", "negra")).toHaveAttribute("aria-label", /: 2/)
  await why.getByRole("radio", { name: "Conté y corregí" }).click()
  await saved(page)
  expect([
    await stockOf("blanca,35"),
    await stockOf("negra,35"),
    await stockOf("negra,36"),
  ]).toEqual([3, 0, 2])

  // Pegar con los títulos de Excel: cada número va a su talla y su color, y se dice lo que no entró.
  await cell(page, "35", "blanca").click()
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData("text/plain", "Talla\tnegra\tblanca\n37\t8\t7\n44\t1\t1\n")
    document
      .querySelector('[role="grid"]')
      ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
  })
  await expect(cell(page, "37", "blanca")).toHaveAttribute("aria-label", /: 7/)
  await expect(cell(page, "37", "negra")).toHaveAttribute("aria-label", /: 8/)
  await expect(cell(page, "35", "blanca")).toHaveAttribute("aria-label", /: 3/)
  await expect(page.getByRole("alert").filter({ hasText: "No entró: talla «44»" })).toBeVisible()
  await saved(page)
  expect([await stockOf("blanca,37"), await stockOf("negra,37")]).toEqual([7, 8])
  await shot(page, "ficha-pegar-con-titulos")

  // El margen: con el costo de la última entrada, la cuenta del servidor.
  await page.getByText("Precio y ofertas de Sofi").scrollIntoViewIfNeeded()
  await expect(page.getByText(/Ganas S\/\s?61 por unidad/).first()).toBeVisible()
  const price = page.getByRole("textbox", { name: "Precio", exact: true })

  // Ctrl+Z dentro del campo es el del campo, y lo de a medias nunca se guarda.
  await price.click()
  await price.press("ControlOrMeta+a")
  await page.keyboard.type("1")
  await page.waitForTimeout(1500)
  await page.keyboard.press("ControlOrMeta+z")
  await expect(price).toHaveValue("129")
  await price.press("Tab")
  await page.waitForTimeout(1500)
  const events = (await json("GET", `${STORE}/productos/${productId}/historial`)).events as {
    changes: { field: string; to: unknown }[]
  }[]
  expect(
    events.some((e) => e.changes.some((c) => c.field === "listPriceCents" && c.to === 100)),
  ).toBe(false)

  await price.fill("139")
  // Se guarda al salir del campo; la barra se pone al día con lo guardado.
  await price.press("Tab")
  await expect(page.getByText(/Ganas S\/\s?71 por unidad/).first()).toBeVisible()
  await saved(page)
  expect((await json("GET", `${STORE}/productos/${productId}`)).product.listPriceCents).toBe(13900)
  await shot(page, "ficha-precio-escritorio")

  // Deshacer vuelve el precio de antes, y se guarda.
  await page.getByRole("button", { name: "Deshacer", exact: true }).first().click()
  await expect(page.getByText(/Ganas S\/\s?61 por unidad/).first()).toBeVisible()
  await saved(page)
  expect((await json("GET", `${STORE}/productos/${productId}`)).product.listPriceCents).toBe(12900)

  // Otra pestaña cambia el mismo precio: no se pisa sin avisar y lo escrito se queda.
  const seen = (await json("GET", `${STORE}/productos/${productId}`)).product
  await json("PATCH", `${STORE}/productos/${productId}`, {
    listPriceCents: 14900,
    version: seen.updatedAt,
  })
  await price.fill("135")
  await price.press("Tab")
  const conflict = page.getByRole("alert").filter({ hasText: "Alguien cambió esta ficha" })
  await expect(conflict).toBeVisible()
  await expect(price).toHaveValue("135")
  expect((await json("GET", `${STORE}/productos/${productId}`)).product.listPriceCents).toBe(14900)
  await shot(page, "ficha-otra-pestana")
  await conflict.getByRole("button", { name: "Guardar lo mío" }).click()
  await saved(page)
  expect((await json("GET", `${STORE}/productos/${productId}`)).product.listPriceCents).toBe(13500)

  // En el celular, una columna: los colores quedan fijos y las tallas se deslizan.
  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Zapatilla de cuero", level: 1 })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "ficha-telefono")
})

test("Ventas ve la ficha sin cambiarla y sin costos; el servidor la rechaza", async ({ page }) => {
  await as("lucia")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo/${productId}`)
  await expect(page.getByRole("heading", { name: "Zapatilla de cuero", level: 1 })).toBeVisible()
  await expect(page.getByText("Solo lectura", { exact: true })).toBeVisible()
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true")
  await expect(page.getByRole("textbox", { name: "Precio", exact: true })).toBeDisabled()
  // A Ventas ni se le dibuja el costo ni el margen.
  await expect(page.getByText(/por unidad a precio de lista/)).toHaveCount(0)
  await expect(page.getByText("De lo último que entró de cada variante")).toHaveCount(0)
  // El enlace del producto también es suyo: la ficha lo pide para ella y el producto nace con él.
  expect((await call("GET", `${STORE}/marca`)).status).toBe(200)
  expect((await json("GET", `${STORE}/productos/${productId}`)).product.web.slug).toBe(
    "zapatilla-de-cuero",
  )
  const rejected = await call("PATCH", `${STORE}/productos/${productId}`, { listPriceCents: 100 })
  expect(rejected.status).toBe(403)
  const grid = await call("POST", `${STORE}/productos/${productId}/cuadricula`, {
    rows: null,
    columns: null,
    cells: [],
  })
  expect(grid.status).toBe(403)
  await noSideScroll(page)
  await shot(page, "ficha-ventas-escritorio")
})
