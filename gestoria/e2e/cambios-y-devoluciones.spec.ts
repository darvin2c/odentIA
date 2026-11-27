import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, API_PORT, STORE_ID, WEB, type Who } from "./entorno"

/**
 * Cambiar o devolver después de entregar, en un navegador (lienzo «gestorIA como odentIA», tablero
 * 17), contra su servidor y su base de verdad:
 * - Andrea recibió la sandalia 38 y le quedó chica: «Cambio o devolución» crea el cambio por la 39,
 *   enlazado al entregado, con el envío por su cuenta y por cobrar al entregar. El entregado no
 *   cambia su total ni su pago.
 * - Fiorella devuelve la suya porque llegó fallada, con el envío de la tienda: el cambio dice cuánto
 *   falta devolver y «Anotar la devolución» lo deja con su medio.
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

/** Un pedido a la API, con la sesión de quien entró. */
async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const { token } = (await (await fetch(`${ACCOUNT}/api/auth/token`)).json()) as { token: string }
  return fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      origin: WEB,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** Lo que la tienda ya tiene armado (sus medios, su reparto, su producto), por la API. */
async function call(method: string, path: string, body?: unknown): Promise<Json> {
  const response = await send(method, path, body)
  const json = (await response.json()) as Json
  expect(response.ok, JSON.stringify(json)).toBe(true)
  return json
}

test.describe.configure({ mode: "serial" })

const setup = { yape: "", efectivo: "", reparto: "", t38: "", t39: "" }
/** Los cambios de este recorrido que todavía se pueden anular: se anulan al final. */
const made: string[] = []

test.afterAll(async () => {
  await as("rosa")
  // Lo entregado y lo que ya tiene dinero devuelto no se anula: queda, con otros nombres que los
  // que miran los demás recorridos.
  for (const id of made)
    await send("POST", `/pedidos/${id}/anular`, { reason: "Fin del recorrido" })
  // Sus medios y su reparto se apagan: los demás recorridos arman los suyos.
  for (const id of [setup.yape, setup.efectivo])
    await call("PATCH", `/medios-de-pago/${id}`, { isActive: false })
  await call("PATCH", `/formas-de-entrega/${setup.reparto}`, { isActive: false })
})

test.beforeAll(async () => {
  await as("rosa")
  setup.yape = (
    await call("POST", "/medios-de-pago", {
      name: "Yape de la tienda",
      typeCode: "68",
      collection: "comprobante",
    })
  ).method.id
  setup.efectivo = (
    await call("POST", "/medios-de-pago", {
      name: "Efectivo en la puerta",
      typeCode: "10",
      collection: "al_recibir",
    })
  ).method.id
  setup.reparto = (
    await call("POST", "/formas-de-entrega", {
      name: "Reparto de cambios",
      type: "DeliveryModeOwnFleet",
      cost: "por_zona",
      zones: [{ name: "San Isidro", priceCents: 1000 }],
      acceptsPayOnDelivery: true,
    })
  ).method.id
  const product = (
    await call("POST", "/productos", {
      name: "Sandalia de cambio",
      listPriceCents: 12900,
      options: [{ name: "Talla", values: ["38", "39"] }],
    })
  ).product.id as string
  const variants = (await call("GET", `/productos/${product}`)).product.variants as Json[]
  setup.t38 = variants.find((v) => v.optionValues[0] === "38")?.id
  setup.t39 = variants.find((v) => v.optionValues[0] === "39")?.id
  for (const variant of [setup.t38, setup.t39])
    await call("POST", `/variantes/${variant}/movimientos`, { kind: "entrada", quantity: 3 })
})

/** Un pedido entregado de la 38, cobrado en la puerta: S/ 129 + envío S/ 10. */
async function delivered(customerName: string): Promise<Json> {
  const order = (
    await call("POST", "/pedidos", {
      customerName,
      customerPhone: "+51 987 330 221",
      channel: "whatsapp",
      address: "Av. Rivera Navarrete 501, San Isidro",
      lines: [{ variantId: setup.t38, quantity: 1 }],
      deliveryMethodId: setup.reparto,
      zone: "San Isidro",
      paymentMethodId: setup.efectivo,
    })
  ).order as Json
  await call("POST", `/pedidos/${order.id}/entregado`, { collectedCents: order.totalCents })
  return order
}

test("Andrea cambia la 38 por la 39 con un pedido nuevo, sin tocar el entregado", async ({
  page,
}) => {
  await as("lucia")
  const order = await delivered("Andrea Castillo")

  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/pedidos?pedido=${order.id}`)
  const sheet = page.getByRole("dialog", { name: `Pedido ${order.number} · Andrea Castillo` })
  await expect(sheet).toBeVisible()
  await sheet.getByRole("button", { name: "Cambio o devolución" }).click()
  const form = page.getByRole("dialog", { name: `Cambio o devolución · ${order.number}` })
  await expect(form).toBeVisible()
  // Lo único que llevó ya va marcado; falta el motivo y lo que se lleva.
  await expect(form.getByRole("checkbox", { name: /Sandalia de cambio 38/ })).toBeChecked()
  await form.getByLabel("¿Por qué?").selectOption("Le quedó chica")
  await form.getByLabel("Se lleva", { exact: true }).selectOption(setup.t39)
  await expect(form.getByText("De la 39 quedan 3.")).toBeVisible()
  const summary = form.locator("section[aria-live]")
  await expect(summary.getByText(/Diferencia S\/\s0/)).toBeVisible()
  await expect(summary.getByText(/S\/\s10 · al entregar/)).toBeVisible()
  // El WhatsApp se abriría en otra pestaña; el recorrido no sale a internet.
  await form.getByRole("checkbox", { name: "Abrir WhatsApp con el aviso del cambio" }).uncheck()
  await noSideScroll(page)
  await shot(page, "cambio-formulario-escritorio")
  await form.getByRole("button", { name: "Crear el cambio" }).click()
  await expect(form).toHaveCount(0)

  // El cambio: un pedido nuevo, enlazado, con lo que vuelve y lo que falta cobrar.
  const change = page.getByRole("dialog", { name: /· Andrea Castillo$/ })
  await expect(change.getByText(`Cambio del ${order.number}.`, { exact: false })).toBeVisible()
  await expect(change.getByText("Vuelve: Sandalia de cambio 38")).toBeVisible()
  await expect(change.getByText("Le quedó chica", { exact: false }).first()).toBeVisible()
  await expect(change.getByRole("button", { name: "Cambiar", exact: true })).toHaveCount(0)
  const id = new URL(page.url()).searchParams.get("pedido")
  if (id) made.push(id)
  await noSideScroll(page)
  await shot(page, "cambio-creado-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "cambio-creado-telefono")

  // El entregado sigue igual, y dice en qué pedido está su cambio.
  await change.getByRole("link", { name: order.number }).click()
  const original = page.getByRole("dialog", { name: `Pedido ${order.number} · Andrea Castillo` })
  await expect(original.getByText(/Cambio en el \d+/)).toBeVisible()
  await expect(original.getByText("S/ 139", { exact: true }).first()).toBeVisible()
  await noSideScroll(page)
  await shot(page, "cambio-entregado-telefono")
})

test("Fiorella devuelve la suya y la tienda anota lo que le devolvió", async ({ page }) => {
  await as("lucia")
  const order = await delivered("Fiorella Quispe")

  await page.setViewportSize(PHONE)
  await page.goto(`${BASE}/pedidos?pedido=${order.id}`)
  const sheet = page.getByRole("dialog", { name: `Pedido ${order.number} · Fiorella Quispe` })
  await sheet.getByRole("button", { name: "Cambio o devolución" }).click()
  const form = page.getByRole("dialog", { name: `Cambio o devolución · ${order.number}` })
  await form.getByLabel("¿Por qué?").selectOption("Llegó fallado")
  await form.getByRole("radio", { name: "Nada: es una devolución" }).click()
  await form.getByRole("radio", { name: "Lo paga la tienda" }).click()
  const summary = form.locator("section[aria-live]")
  await expect(summary.getByText("Le devuelves")).toBeVisible()
  await expect(summary.getByText("S/ 129", { exact: true })).toBeVisible()
  await form.getByRole("checkbox", { name: "Abrir WhatsApp con el aviso del cambio" }).uncheck()
  await noSideScroll(page)
  await shot(page, "devolucion-formulario-telefono")
  await form.getByRole("button", { name: "Crear la devolución" }).click()
  await expect(form).toHaveCount(0)

  const refund = page.getByRole("dialog", { name: /· Fiorella Quispe$/ })
  await expect(refund.getByText("Es una devolución: no se lleva nada.")).toBeVisible()
  await expect(refund.getByText("Falta devolver S/ 129.", { exact: false }).first()).toBeVisible()
  await refund.getByRole("button", { name: "Anotar la devolución" }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog.getByLabel("Devolver")).toHaveValue("129")
  await dialog.getByLabel("Medio").selectOption(setup.yape)
  await noSideScroll(page)
  await shot(page, "devolucion-anotar-telefono")
  await dialog.getByRole("button", { name: "Anotar la devolución" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(refund.getByText(/Devuelto · Yape de la tienda/)).toBeVisible()
  await expect(refund.getByText("Anotó lo que devolvió")).toBeVisible()
  // Ya devuelto, no dice «Pagado»: falta recoger lo que vuelve.
  await expect(refund.getByText("Listo para salir: recoge lo que vuelve.")).toBeVisible()
  await page.setViewportSize(DESKTOP)
  await noSideScroll(page)
  await shot(page, "devolucion-anotada-escritorio")
})
