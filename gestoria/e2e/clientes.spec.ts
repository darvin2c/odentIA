import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, API_PORT, STORE_ID, WEB, type Who } from "./entorno"

/**
 * Clientes (entrega 4 de «gestorIA como odentIA», tablero 8) en un navegador, contra su servidor
 * y su base de verdad:
 * - Dos pedidos de Mariela Ríos, por Instagram y por WhatsApp, abren dos fichas: el mismo nombre
 *   solo sugiere «¿Es la misma clienta?» y lo decide una persona («Sí, es la misma», con el
 *   teclado). La ficha junta sus canales y sus compras, con «Escribirle» por su WhatsApp aunque
 *   el teléfono se haya anotado sin el código del país, y su historia con «Separar».
 * - «Lo que sabemos» se edita en su cajón; «Repetir pedido» trae lo de su última compra y el
 *   pedido nuevo lleva a su ficha.
 * - «Separar» la deja sola otra vez y no se vuelve a sugerir; «Anotar un pedido» sugiere las
 *   fichas que coinciden con lo escrito, sin elegir ninguna sola.
 * Cada pantalla en escritorio y a 390 px, sin desborde. Las capturas van a `gestoria/e2e/capturas/`.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1366, height: 860 }
const PHONE = { width: 390, height: 844 }
const BASE = `/tiendas/${STORE_ID}`
const API = `http://127.0.0.1:${API_PORT}`

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
async function as(who: Who | "nadie") {
  const response = await fetch(`${ACCOUNT}/__como/${who}`, { method: "POST" })
  expect(response.ok).toBe(true)
}

/** Lo que haría la pantalla, desde aquí: con el token que firma la cuenta de mentira. */
// biome-ignore lint/suspicious/noExplicitAny: el recorrido lee respuestas JSON de forma libre
async function call(method: string, path: string, body?: unknown): Promise<any> {
  const { token } = (await (await fetch(`${ACCOUNT}/api/auth/token`)).json()) as { token: string }
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      origin: WEB,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

/** Lo que la tienda necesita para vender, y los dos pedidos de Mariela Ríos. */
async function prepare() {
  await call("GET", "/api/yo")
  const store = `/api/tiendas/${STORE_ID}`
  const yape = (
    await call("POST", `${store}/medios-de-pago`, {
      name: "Yape",
      typeCode: "68",
      collection: "comprobante",
    })
  ).method.id as string
  const shalom = (
    await call("POST", `${store}/formas-de-entrega`, {
      name: "Agencia Shalom",
      type: "ParcelService",
      cost: "fijo",
      priceCents: 1000,
    })
  ).method.id as string
  const created = await call("POST", `${store}/productos`, {
    name: "Zapatilla urbana",
    listPriceCents: 12900,
    options: [
      { name: "Color", values: ["blanca", "negra"] },
      { name: "Talla", values: ["38"] },
    ],
  })
  const variants = (await call("GET", `${store}/productos/${created.product.id}`)).product
    .variants as { id: string; optionValues: string[] }[]
  for (const v of variants)
    await call("POST", `${store}/variantes/${v.id}/movimientos`, { kind: "entrada", quantity: 5 })
  const of = (color: string) => variants.find((v) => v.optionValues[0] === color)!.id
  const order = (over: Record<string, unknown>) =>
    call("POST", `${store}/pedidos`, {
      customerName: "Mariela Ríos",
      address: "Shalom Arequipa, agencia Av. Ejército",
      deliveryMethodId: shalom,
      paymentMethodId: yape,
      ...over,
    })
  // Por Instagram, sin teléfono; después por WhatsApp, con el teléfono como lo anota el equipo.
  await order({ channel: "instagram", lines: [{ variantId: of("blanca"), quantity: 1 }] })
  await order({
    channel: "whatsapp",
    customerPhone: "987 654 321",
    lines: [{ variantId: of("negra"), quantity: 1 }],
  })
}

test.describe.configure({ mode: "serial" })

test("Clientes: una persona dice que es la misma clienta, la ficha junta todo y se puede separar", async ({
  page,
}) => {
  await as("rosa")
  await prepare()
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/clientes`)

  // Clientes está en el menú del día, después de Pedidos.
  const nav = page.getByRole("navigation", { name: "Principal" })
  await expect(nav.getByRole("link", { name: "Clientes" })).toBeVisible()
  const links = await nav.getByRole("link").allTextContents()
  expect(links.findIndex((t) => t.includes("Clientes"))).toBe(
    links.findIndex((t) => t.includes("Pedidos")) + 1,
  )
  const list = page.getByRole("region", { name: "Clientas" })
  await expect(list.getByRole("link", { name: /Mariela Ríos/ })).toHaveCount(2)
  // El mismo nombre no une: solo sugiere, y no frena ninguna venta.
  await expect(page.getByText("Dos fichas podrían ser la misma clienta.")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "clientes-lista-escritorio")

  await page.getByRole("button", { name: "Comparar" }).click()
  const compare = page.getByRole("dialog", { name: "¿Es la misma clienta?" })
  await expect(compare).toBeVisible()
  await expect(compare.getByText(/Tienen el mismo nombre\./)).toBeVisible()
  await expect(compare.getByText(/Nunca se une sola por el nombre o el teléfono/)).toBeVisible()
  await shot(page, "clientes-comparar-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "clientes-comparar-telefono")
  await page.setViewportSize(DESKTOP)
  // Con el teclado: «Sí, es la misma» se enfoca y se confirma con Enter.
  await compare.getByRole("button", { name: "Sí, es la misma" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Listo: ahora es una sola ficha")).toBeVisible()
  await expect(compare).toBeHidden()
  await expect(page.getByText("Dos fichas podrían ser la misma clienta.")).toHaveCount(0)
  await expect(list.getByRole("link", { name: /Mariela Ríos/ })).toHaveCount(1)
  await expect(list.getByText("2 compras · la última hoy")).toBeVisible()

  // La ficha: sus dos canales, su teléfono, «Escribirle» por su WhatsApp y su historia.
  await list.getByRole("link", { name: /Mariela Ríos/ }).click()
  const card = page.getByRole("article", { name: "Ficha de Mariela Ríos" })
  await expect(card).toBeVisible()
  await expect(
    card.getByText(/Instagram · WhatsApp · 987 654 321|WhatsApp · Instagram · 987 654 321/),
  ).toBeVisible()
  // Anotado sin el código: en una tienda del Perú se lee como celular del Perú.
  await expect(card.getByRole("link", { name: "Escribirle" })).toHaveAttribute(
    "href",
    "https://wa.me/51987654321",
  )
  await expect(card.getByText("2 compras", { exact: true })).toBeVisible()
  await expect(
    card.getByText(
      "Rosa Quispe dijo que «Mariela Ríos» es la misma clienta: su ficha quedó dentro de esta.",
    ),
  ).toBeVisible()
  await expect(card.getByRole("button", { name: "Separar" })).toBeVisible()

  // «Lo que sabemos»: una nota del equipo, que la clienta no ve.
  await card.getByRole("button", { name: "Editar" }).click()
  const edit = page.getByRole("dialog", { name: "Editar la ficha" })
  await edit.getByLabel("Lo que sabemos").fill("Talla 38. Prefiere Shalom.")
  await edit.getByRole("button", { name: "Guardar" }).click()
  await expect(page.getByText("Ficha guardada")).toBeVisible()
  await expect(card.getByText("Talla 38. Prefiere Shalom.")).toBeVisible()
  await expect(
    card.getByText(/Nota del equipo, la clienta no la ve · escribió Rosa hoy/),
  ).toBeVisible()
  await noSideScroll(page)
  await shot(page, "clientes-ficha-escritorio")
  // En el celular se ve la ficha sola, con «Clientes» para volver.
  await page.setViewportSize(PHONE)
  await expect(list).toBeHidden()
  await expect(page.getByRole("link", { name: "Clientes", exact: true }).last()).toBeVisible()
  await noSideScroll(page)
  await shot(page, "clientes-ficha-telefono")
  await page.setViewportSize(DESKTOP)

  // «Repetir pedido»: lo de su última compra, con los precios de hoy; el pedido nuevo va a su ficha.
  await card.getByRole("button", { name: "Repetir pedido" }).click()
  const repeat = page.getByRole("dialog", { name: "Nuevo pedido para Mariela Ríos" })
  await expect(repeat).toBeVisible()
  await expect(repeat.getByText(/el pedido va a su ficha/)).toBeVisible()
  await expect(repeat.getByText(/La vez anterior: Zapatilla urbana/)).toBeVisible()
  await shot(page, "clientes-repetir-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "clientes-repetir-telefono")
  await page.setViewportSize(DESKTOP)
  await repeat.getByRole("button", { name: "Anotar pedido" }).click()
  await expect(page.getByText("Pedido 0003 anotado")).toBeVisible()
  await expect(page).toHaveURL(/\/pedidos\?pedido=/)
  await page.getByRole("link", { name: "Ver su ficha" }).click()
  await expect(card.getByText("3 compras", { exact: true })).toBeVisible()

  // «Separar»: vuelve a ser otra ficha, con su pedido, y no se vuelve a sugerir.
  await card.getByRole("button", { name: "Separar" }).click()
  const confirm = page.getByRole("alertdialog", { name: "¿Separar «Mariela Ríos»?" })
  await expect(confirm).toBeVisible()
  await confirm.getByRole("button", { name: "Separar" }).click()
  await expect(page.getByText("Listo: volvió a ser otra ficha, con sus pedidos")).toBeVisible()
  await expect(list.getByRole("link", { name: /Mariela Ríos/ })).toHaveCount(2)
  await expect(page.getByText("Dos fichas podrían ser la misma clienta.")).toHaveCount(0)
  await expect(
    card.getByText(/Rosa Quispe separó «Mariela Ríos»: volvió a ser otra ficha\./),
  ).toBeVisible()
  await noSideScroll(page)
  await shot(page, "clientes-separada-escritorio")

  // «Anotar un pedido» sugiere las fichas que coinciden con lo escrito; elegir una es de la persona.
  await page.goto(`${BASE}/pedidos`)
  await page.getByRole("button", { name: "Anotar un pedido" }).click()
  const sheet = page.getByRole("dialog", { name: "Anotar un pedido" })
  await sheet.getByLabel("Nombre").fill("mariela")
  await expect(sheet.getByText("¿Es una de ellas?")).toBeVisible()
  const options = sheet.getByRole("list", { name: "¿Es una de ellas?" }).getByRole("button")
  await expect(options).toHaveCount(2)
  await shot(page, "clientes-anotar-sugiere-escritorio")
  await options.first().click()
  await expect(sheet.getByText(/el pedido va a su ficha/)).toBeVisible()
  await sheet.getByRole("button", { name: "Cambiar" }).click()
  await expect(sheet.getByLabel("Nombre")).toHaveValue("mariela")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "clientes-anotar-sugiere-telefono")
})
