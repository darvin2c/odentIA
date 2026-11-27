import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, API_PORT, STORE_ID, WEB, type Who } from "./entorno"

/**
 * El pago en partes en un navegador (lienzo «gestorIA como odentIA», tablero 7), contra su
 * servidor y su base de verdad:
 * - Diana pide una zapatilla de S/ 117 y paga S/ 80 por Yape: la captura se anota como una parte,
 *   se confirma sin «Pago doble», el pedido queda listo para salir con «Falta cobrar S/ 37» en el
 *   pedido, la lista y Reportes, y al entregar se cobran los S/ 37 en efectivo y queda pagado.
 * Cada pantalla en escritorio y a 390 px, sin desborde. Las capturas van a `gestoria/e2e/capturas/`.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1366, height: 860 }
const PHONE = { width: 390, height: 844 }
const BASE = `/tiendas/${STORE_ID}`
const API = `http://127.0.0.1:${API_PORT}/api/tiendas/${STORE_ID}`

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

// biome-ignore lint/suspicious/noExplicitAny: el recorrido lee respuestas JSON de forma libre
type Json = Record<string, any>

/** Lo que la tienda ya tiene armado (sus medios, su reparto, su producto), por la API. */
/** «S/ 37» como lo dice la pantalla: sin decimales cuando no los tiene. */
const soles = (cents: number) =>
  new Intl.NumberFormat("es-PE", {
    style: "currency",
    currency: "PEN",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)

async function call(method: string, path: string, body?: unknown): Promise<Json> {
  const { token } = (await (await fetch(`${ACCOUNT}/api/auth/token`)).json()) as { token: string }
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      origin: WEB,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await response.json()) as Json
  expect(response.ok, JSON.stringify(json)).toBe(true)
  return json
}

test.describe.configure({ mode: "serial" })

test("Diana paga en partes: S/ 80 por Yape y S/ 37 en efectivo al recibir", async ({ page }) => {
  await as("rosa")
  const yape = (
    await call("POST", "/medios-de-pago", {
      name: "Yape",
      typeCode: "68",
      collection: "comprobante",
    })
  ).method.id as string
  await call("POST", "/medios-de-pago", {
    name: "Efectivo al recibir",
    typeCode: "10",
    collection: "al_recibir",
  })
  const reparto = (
    await call("POST", "/formas-de-entrega", {
      name: "Reparto en Lima",
      type: "DeliveryModeOwnFleet",
      cost: "fijo",
      priceCents: 1000,
      acceptsPayOnDelivery: true,
    })
  ).method.id as string
  const product = (
    await call("POST", "/productos", {
      // Otro nombre que el de Clientes: los recorridos comparten la tienda.
      name: "Zapatilla de lona",
      listPriceCents: 12900,
      minPriceCents: 10000,
      options: [{ name: "Talla", values: ["39"] }],
    })
  ).product.id as string
  const variant = (await call("GET", `/productos/${product}`)).product.variants[0].id as string
  await call("POST", `/variantes/${variant}/movimientos`, { kind: "entrada", quantity: 3 })
  // Lo que ya faltaba cobrar en la tienda (otros recorridos dejan pedidos por pagar).
  const dueBefore = (await call("GET", "/reportes")).pending.due.cents as number
  // Zapatilla a S/ 107 (negociada) + envío S/ 10 = S/ 117.
  const order = (
    await call("POST", "/pedidos", {
      customerName: "Diana Flores",
      customerPhone: "+51 945 112 233",
      channel: "whatsapp",
      address: "Av. Caminos del Inca 1450, Surco",
      lines: [{ variantId: variant, quantity: 1, unitCents: 10700 }],
      deliveryMethodId: reparto,
      paymentMethodId: yape,
    })
  ).order as Json

  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/pedidos?pedido=${order.id}`)
  const sheet = page.getByRole("dialog", { name: `Pedido ${order.number} · Diana Flores` })
  await expect(sheet).toBeVisible()
  await sheet.getByRole("button", { name: "Anotar captura del pago" }).click()
  const capture = page.getByRole("dialog", { name: `Captura del pago · pedido ${order.number}` })
  await expect(capture.getByText("Si paga una parte, anota lo que pagó.")).toBeVisible()
  await capture.getByLabel("Monto").fill("80")
  await capture.getByRole("button", { name: "Anotar captura" }).click()
  await expect(capture).toHaveCount(0)

  // Es una parte: no sale «Pago doble», y dice cuánto faltará.
  await expect(
    sheet.getByText("Es una parte del total: después de confirmarlo, faltan S/ 37."),
  ).toBeVisible()
  await expect(sheet.getByText(/pago doble/i)).toHaveCount(0)
  await shot(page, "pago-en-partes-por-confirmar-escritorio")
  await sheet.getByRole("button", { name: "Confirmar pago" }).click()
  await expect(
    sheet.getByText("Listo para salir. Falta cobrar S/ 37: se cobra al entregar."),
  ).toBeVisible()
  await expect(sheet.getByText("Cobrado", { exact: true })).toBeVisible()
  await expect(sheet.getByText("Falta cobrar", { exact: true })).toBeVisible()
  await expect(sheet.getByRole("button", { name: "Anotar otro pago" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "pago-en-partes-falta-cobrar-escritorio")

  // La lista dice la misma cifra, y el estado no es «Pagado».
  await page.keyboard.press("Escape")
  await expect(sheet).toHaveCount(0)
  const row = page.getByRole("button", { name: new RegExp(`${order.number}.*Diana Flores`) })
  await expect(row.getByText("falta S/ 37")).toBeVisible()
  await expect(row.getByText("Por salir · falta cobrar")).toBeVisible()
  await shot(page, "pago-en-partes-lista-escritorio")
  await page.setViewportSize(PHONE)
  await expect(row.getByText("falta S/ 37")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "pago-en-partes-lista-telefono")

  // Reportes cuenta lo que falta, del mismo saldo.
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/reportes`)
  const due = page.locator("div").filter({ has: page.getByText("Falta cobrar", { exact: true }) })
  await expect(due.getByText(soles(dueBefore + 3700), { exact: true }).first()).toBeVisible()
  await shot(page, "pago-en-partes-reportes-escritorio")

  // Al entregar se cobra lo que falta, ya escrito, con su medio.
  await page.setViewportSize(PHONE)
  await page.goto(`${BASE}/pedidos?pedido=${order.id}`)
  await expect(sheet).toBeVisible()
  await sheet.getByRole("button", { name: "Entregado y cobrado" }).click()
  const deliver = page.getByRole("alertdialog")
  await expect(deliver.getByLabel("¿Cuánto cobraste?")).toHaveValue("37")
  await expect(deliver.getByText("Falta cobrar S/ 37 de S/ 117.")).toBeVisible()
  await expect(deliver.getByText("Queda anotado con Efectivo al recibir.")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "pago-en-partes-entregar-telefono")
  await deliver.getByRole("button", { name: "Entregado y cobrado" }).click()
  await expect(deliver).toHaveCount(0)
  await expect(sheet.getByText("Nada: está pagado")).toBeVisible()
  await expect(sheet.getByText("Efectivo al recibir · S/ 37")).toBeVisible()
  await expect(sheet.getByText("Yape · S/ 80")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "pago-en-partes-pagado-telefono")
})
