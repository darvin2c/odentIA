import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, API_PORT, STORE_ID, surface, WEB, type Who } from "./entorno"

/**
 * Clientes (entrega 4 de «gestorIA como odentIA», tablero 8) en un navegador, contra su servidor
 * y su base de verdad:
 * - Dos pedidos de Mariela Ríos, por Instagram y por WhatsApp, abren dos fichas: el mismo nombre
 *   solo sugiere «¿Es la misma clienta?» y lo decide una persona («Sí, es la misma», con el
 *   teclado). La ficha junta sus canales y sus compras, con «Escribirle» por su WhatsApp aunque
 *   el teléfono se haya anotado sin el código del país, y su historia con «Separar». La lista y la
 *   ficha son dos páginas: la ficha vuelve a la lista con «Clientes».
 * - «Lo que sabemos» se edita en su cajón; «Repetir pedido» trae lo de su última compra y el
 *   pedido nuevo lleva a su ficha. En el teléfono, «Repetir pedido» está en el menú ⋯.
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

/** Lo que la tienda necesita para vender y los dos pedidos de Mariela Ríos; da el número que sigue. */
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
  const last = await order({
    channel: "whatsapp",
    customerPhone: "987 654 321",
    lines: [{ variantId: of("negra"), quantity: 1 }],
  })
  // El número del pedido que sigue: los recorridos comparten la tienda y otros ya anotaron los suyos.
  return String(Number(last.order.number) + 1).padStart(4, "0")
}

test.describe.configure({ mode: "serial" })

test("Clientes: una persona dice que es la misma clienta, la ficha junta todo y se puede separar", async ({
  page,
}) => {
  await as("rosa")
  const next = await prepare()
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
  const compare = surface(page, "¿Es la misma clienta?")
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
  // Lo que debe, en lugar de sus compras: la suma del saldo de sus dos pedidos por pagar.
  await expect(list.getByText(/^Debe S\/\s278$/)).toBeVisible()

  // La ficha: sus dos canales, su teléfono, «Escribirle» por su WhatsApp y su historia.
  await list.getByRole("link", { name: /Mariela Ríos/ }).click()
  const card = page.getByRole("article", { name: "Ficha de Mariela Ríos" })
  await expect(card).toBeVisible()
  // Sus canales y su teléfono, en «Lo que sabemos» (y bajo su nombre si el servidor no arma su línea).
  await expect(
    card.getByText(/Instagram · WhatsApp · 987 654 321|WhatsApp · Instagram · 987 654 321/).first(),
  ).toBeVisible()
  // Lo que Argos calcula con sus pedidos pagados, junto a lo que sabe de ella.
  await expect(card.getByRole("region", { name: "Lo que Argos calcula" })).toBeVisible()
  // Anotado sin el código: en una tienda del Perú se lee como celular del Perú.
  await expect(card.getByRole("link", { name: "Escribirle" })).toHaveAttribute(
    "href",
    "https://wa.me/51987654321",
  )
  const purchases = card.getByRole("region", { name: "Compras" })
  await expect(purchases.getByText("2 pedidos", { exact: true })).toBeVisible()
  const owes = card.getByRole("region", { name: "Debe" })
  await expect(owes.getByText(/^S\/\s278$/)).toBeVisible()
  await expect(
    card.getByText(
      "Rosa Quispe dijo que «Mariela Ríos» es la misma clienta: su ficha quedó dentro de esta.",
    ),
  ).toBeVisible()
  await expect(card.getByRole("button", { name: "Separar" })).toBeVisible()

  // «Lo que sabemos»: una nota del equipo, que la clienta no ve.
  await card.getByRole("button", { name: "Editar" }).click()
  const edit = surface(page, "Editar la ficha")
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
  const repeat = surface(page, "Nuevo pedido para Mariela Ríos")
  await expect(repeat).toBeVisible()
  await expect(repeat.getByText(/el pedido va a su ficha/)).toBeVisible()
  await expect(repeat.getByText(/La vez anterior: Zapatilla urbana/)).toBeVisible()
  await shot(page, "clientes-repetir-escritorio")
  // En el teléfono se abre en cajón: la columna se decide al abrir, no al achicar la ventana.
  await repeat.getByRole("button", { name: "Cancelar" }).click()
  await expect(repeat).toHaveCount(0)
  await page.setViewportSize(PHONE)
  await card.getByRole("button", { name: "Más opciones" }).click()
  await page.getByRole("menuitem", { name: "Repetir pedido" }).click()
  await expect(repeat).toBeVisible()
  await noSideScroll(page)
  await shot(page, "clientes-repetir-telefono")
  await page.setViewportSize(DESKTOP)
  await repeat.getByRole("button", { name: "Anotar pedido" }).click()
  await expect(page.getByText(`Pedido ${next} anotado`)).toBeVisible()
  await expect(page).toHaveURL(/\/pedidos\?pedido=/)
  await page.getByRole("link", { name: "Ver su ficha" }).click()
  await expect(purchases.getByText("3 pedidos", { exact: true })).toBeVisible()

  // «Separar»: vuelve a ser otra ficha, con su pedido, y no se vuelve a sugerir.
  await card.getByRole("button", { name: "Separar" }).click()
  const confirm = page.getByRole("alertdialog", { name: "¿Separar «Mariela Ríos»?" })
  await expect(confirm).toBeVisible()
  await confirm.getByRole("button", { name: "Separar" }).click()
  await expect(page.getByText("Listo: volvió a ser otra ficha, con sus pedidos")).toBeVisible()
  await expect(
    card.getByText(/Rosa Quispe separó «Mariela Ríos»: volvió a ser otra ficha\./),
  ).toBeVisible()
  await noSideScroll(page)
  await shot(page, "clientes-separada-escritorio")
  // De vuelta en la lista: otra vez dos fichas, y no se vuelve a sugerir que son la misma.
  await page.getByRole("link", { name: "Clientes", exact: true }).last().click()
  await expect(list.getByRole("link", { name: /Mariela Ríos/ })).toHaveCount(2)
  await expect(page.getByText("Dos fichas podrían ser la misma clienta.")).toHaveCount(0)

  // «Anotar un pedido» sugiere las fichas que coinciden con lo escrito; elegir una es de la persona.
  await page.goto(`${BASE}/pedidos`)
  await page.getByRole("button", { name: "Anotar un pedido" }).click()
  const sheet = surface(page, "Anotar un pedido")
  await sheet.getByLabel("Nombre").fill("mariela")
  await expect(sheet.getByText("¿Es una de ellas?")).toBeVisible()
  const options = sheet.getByRole("list", { name: "¿Es una de ellas?" }).getByRole("button")
  await expect(options).toHaveCount(2)
  await shot(page, "clientes-anotar-sugiere-escritorio")
  await options.first().click()
  await expect(sheet.getByText(/el pedido va a su ficha/)).toBeVisible()
  await sheet.getByRole("button", { name: "Cambiar" }).click()
  await expect(sheet.getByLabel("Nombre")).toHaveValue("mariela")
  // En el teléfono, en cajón: la columna se decide al abrir, no al achicar la ventana.
  await page.setViewportSize(PHONE)
  await page.reload()
  await page.getByRole("button", { name: "Anotar un pedido" }).click()
  await sheet.getByLabel("Nombre").fill("mariela")
  await expect(sheet.getByText("¿Es una de ellas?")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "clientes-anotar-sugiere-telefono")
})
