import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, API_PORT, choose, STORE_ID, surface, WEB, type Who } from "./entorno"

/**
 * Un pedido se corrige sin anularlo, en un navegador (lienzo «gestorIA como odentIA», tableros 6
 * y 7), contra su servidor y su base de verdad:
 * - Andrea pagó su sandalia 37 por Plin y pide la 38, con entrega en otra zona: «Cambiar» en el
 *   mismo pedido muestra el total nuevo, lo pagado y lo que falta antes de guardar; después
 *   «Pasar a…» mañana y «Deshacer» la confirmación del pago, con su motivo.
 * - Jorge no contestó: «No se entregó» vuelve el pedido a «Por salir» mañana, con su motivo.
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

const setup = { plin: "", efectivo: "", reparto: "", t37: "", t38: "" }
/** Los pedidos de este recorrido: se anulan al final, para no sumar a lo que miran los demás. */
const made: string[] = []

test.afterAll(async () => {
  await as("rosa")
  for (const id of made)
    await call("POST", `/pedidos/${id}/anular`, { reason: "Fin del recorrido" })
  // Sus medios y su reparto se apagan: los demás recorridos arman los suyos.
  for (const id of [setup.plin, setup.efectivo])
    await call("PATCH", `/medios-de-pago/${id}`, { isActive: false })
  await call("PATCH", `/formas-de-entrega/${setup.reparto}`, { isActive: false })
})

test.beforeAll(async () => {
  await as("rosa")
  setup.plin = (
    await call("POST", "/medios-de-pago", {
      name: "Plin",
      typeCode: "68",
      collection: "comprobante",
    })
  ).method.id
  setup.efectivo = (
    await call("POST", "/medios-de-pago", {
      name: "Efectivo contra entrega",
      typeCode: "10",
      collection: "al_recibir",
    })
  ).method.id
  setup.reparto = (
    await call("POST", "/formas-de-entrega", {
      name: "Reparto por zona",
      type: "DeliveryModeOwnFleet",
      cost: "por_zona",
      zones: [
        { name: "Surco", priceCents: 1000 },
        { name: "Callao", priceCents: 1500 },
      ],
      acceptsPayOnDelivery: true,
    })
  ).method.id
  const product = (
    await call("POST", "/productos", {
      name: "Sandalia beige",
      listPriceCents: 12900,
      options: [{ name: "Talla", values: ["37", "38"] }],
    })
  ).product.id as string
  const variants = (await call("GET", `/productos/${product}`)).product.variants as Json[]
  setup.t37 = variants.find((v) => v.optionValues[0] === "37")?.id
  setup.t38 = variants.find((v) => v.optionValues[0] === "38")?.id
  for (const variant of [setup.t37, setup.t38])
    await call("POST", `/variantes/${variant}/movimientos`, { kind: "entrada", quantity: 3 })
})

test("Andrea cambia a la 38 sin anular, pasa a mañana y se deshace su pago", async ({ page }) => {
  await as("rosa")
  // Sandalia 37 a S/ 129 + envío a Surco S/ 10 = S/ 139.
  const order = (
    await call("POST", "/pedidos", {
      customerName: "Andrea Castillo",
      customerPhone: "+51 987 220 114",
      channel: "whatsapp",
      address: "Av. Primavera 123, Surco",
      lines: [{ variantId: setup.t37, quantity: 1 }],
      deliveryMethodId: setup.reparto,
      zone: "Surco",
      paymentMethodId: setup.plin,
    })
  ).order as Json
  made.push(order.id)

  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/pedidos?pedido=${order.id}`)
  const sheet = surface(page, `Pedido ${order.number} · Andrea Castillo`)
  await expect(sheet).toBeVisible()
  await sheet.getByRole("button", { name: "Anotar captura del pago" }).click()
  const capture = surface(page, `Captura del pago · pedido ${order.number}`)
  await capture.getByLabel("Monto").fill("139")
  await capture.getByRole("button", { name: "Anotar captura" }).click()
  await expect(capture).toHaveCount(0)
  await sheet.getByRole("button", { name: "Confirmar pago" }).click()
  await expect(sheet.getByText("Nada: está pagado")).toBeVisible()

  // «Cambiar»: el mismo pedido, con lo que ya tiene y sin cliente ni medio de pago.
  await sheet.getByRole("button", { name: "Cambiar", exact: true }).click()
  const edit = surface(page, `Cambiar el pedido ${order.number}`)
  await expect(edit).toBeVisible()
  await expect(edit.getByText(/Andrea Castillo · paga con Plin/)).toBeVisible()
  await expect(edit.getByLabel("Medio de pago")).toHaveCount(0)
  await choose(edit.getByLabel("Producto 1"), /^Sandalia beige · 38 —/)
  await choose(edit.getByLabel("Zona"), /^Callao —/)
  // Antes de guardar: el total nuevo, lo pagado y lo que falta, del mismo saldo.
  const summary = edit.locator("section[aria-live]")
  await expect(summary.getByText("Total nuevo")).toBeVisible()
  await expect(summary.getByText("S/ 144", { exact: true })).toBeVisible()
  await expect(summary.getByText("S/ 139", { exact: true }).first()).toBeVisible()
  await expect(summary.getByText("S/ 5", { exact: true })).toBeVisible()
  await expect(summary.getByText(/Sandalia beige 37 → 38/)).toBeVisible()
  await noSideScroll(page)
  await shot(page, "corregir-cambiar-escritorio")
  await edit.getByRole("button", { name: "Guardar cambios" }).click()
  await expect(edit).toHaveCount(0)
  await expect(
    sheet.getByText("Listo para salir. Falta cobrar S/ 5: se cobra al entregar."),
  ).toBeVisible()
  await expect(sheet.getByText("Cambió el pedido")).toBeVisible()
  await expect(sheet.getByText(/Sandalia beige 37 → 38/)).toBeVisible()
  await shot(page, "corregir-cambiado-escritorio")

  // A 390 px: «Pasar a…» mañana, sin anular nada.
  await page.setViewportSize(PHONE)
  await sheet.getByRole("button", { name: "Pasar a…" }).click()
  // Abierto desde el pedido, que ya está en la columna: va en cajón.
  const move = page.getByRole("dialog", { name: `Pasar a… · ${order.number} Andrea Castillo` })
  await move.getByRole("button", { name: "Mañana", exact: true }).click()
  await expect(move.getByRole("button", { name: "Mañana", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await noSideScroll(page)
  await shot(page, "corregir-pasar-a-telefono")
  await move.getByRole("button", { name: "Pasar a mañana" }).click()
  await expect(move).toHaveCount(0)
  await expect(sheet.getByText("Lo pasó a otro día")).toBeVisible()

  // «Deshacer» la confirmación: pide motivo, y el pedido vuelve a esperar su pago.
  await sheet.getByRole("button", { name: "Deshacer" }).click()
  const undo = page.getByRole("alertdialog")
  await expect(undo.getByRole("button", { name: "Deshacer" })).toBeDisabled()
  await undo.getByRole("textbox").fill("Lo confirmé en el pedido equivocado")
  await noSideScroll(page)
  await shot(page, "corregir-deshacer-telefono")
  await undo.getByRole("button", { name: "Deshacer" }).click()
  await expect(undo).toHaveCount(0)
  await expect(
    sheet.getByText("Revisa la cuenta de la tienda y confirma el pago, o di que no coincide."),
  ).toBeVisible()
  await expect(sheet.getByText("Deshizo la confirmación del pago")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "corregir-deshecho-telefono")
})

test("Jorge no contestó: «No se entregó» lo vuelve a «Por salir» mañana", async ({ page }) => {
  await as("lucia")
  const order = (
    await call("POST", "/pedidos", {
      customerName: "Jorge Paredes",
      channel: "whatsapp",
      address: "Jr. Callao 450, Callao",
      lines: [{ variantId: setup.t37, quantity: 1 }],
      deliveryMethodId: setup.reparto,
      zone: "Callao",
      paymentMethodId: setup.efectivo,
    })
  ).order as Json
  made.push(order.id)
  await call("POST", `/pedidos/${order.id}/salio`, {})

  await page.setViewportSize(PHONE)
  await page.goto(`${BASE}/pedidos?pedido=${order.id}`)
  const sheet = surface(page, `Pedido ${order.number} · Jorge Paredes`)
  await expect(sheet).toBeVisible()
  await sheet.getByRole("button", { name: "No se entregó" }).click()
  const missed = page.getByRole("dialog", { name: `No se entregó · ${order.number} Jorge Paredes` })
  await expect(missed.getByRole("radio", { name: "No contestó" })).toBeChecked()
  await expect(missed.getByRole("button", { name: "Mañana" })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await noSideScroll(page)
  await shot(page, "corregir-no-se-entrego-telefono")
  await missed.getByRole("button", { name: "Guardar" }).click()
  await expect(missed).toHaveCount(0)
  await expect(
    sheet.getByText("Volvió sin entregar («No contestó»). Sale mañana; al entregar, cobra S/ 144."),
  ).toBeVisible()
  await expect(sheet.getByText("No se entregó", { exact: true })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "corregir-volvio-telefono")
  await page.setViewportSize(DESKTOP)
  await noSideScroll(page)
  await shot(page, "corregir-volvio-escritorio")
})
