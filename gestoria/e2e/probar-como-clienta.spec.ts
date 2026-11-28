import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import sharp from "sharp"
import { ACCOUNT, API_PORT, STORE_ID, WEB, type Who } from "./entorno"

/**
 * «Probar como clienta» desde la ficha (lienzo «La ficha del producto», PR 6), contra su servidor
 * y su base de verdad, con el modelo de desarrollo (reglas fijas, sin red) en la misma tubería de
 * Sofi:
 * - Pregunta por la negra en 38: Sofi manda la foto de la negra (no la primera) y «Qué usó Sofi»
 *   dice de dónde salió.
 * - «¿Me haces precio?»: el valor y una sola oferta, con su plazo; «Envío gratis» la acepta y Sofi
 *   anota el pedido de prueba.
 * - «Ver y pagar» abre el mismo carrito en la vitrina, con lo acordado y su reloj; «Pagar ahora»
 *   dice «Pago de prueba: no se cobra»; al pagar, Sofi escribe una vez. El stock no se mueve.
 * - En el teléfono es un cajón, sin desborde. La vista previa: celular y web.
 * Las capturas van a `gestoria/e2e/capturas/`.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const BASE = `/tiendas/${STORE_ID}`
const API = `http://127.0.0.1:${API_PORT}`
const STORE = `/api/tiendas/${STORE_ID}`

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) })
}

async function as(who: Who) {
  expect((await fetch(`${ACCOUNT}/__como/${who}`, { method: "POST" })).ok).toBe(true)
}

// biome-ignore lint/suspicious/noExplicitAny: el recorrido lee respuestas JSON de forma libre
async function json(method: string, path: string, body?: unknown): Promise<any> {
  const { token } = (await (await fetch(`${ACCOUNT}/api/auth/token`)).json()) as { token: string }
  const binary = body instanceof Blob
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      origin: WEB,
      authorization: `Bearer ${token}`,
      ...(body === undefined || binary ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

const jpeg = (r: number, g: number, b: number) =>
  sharp({ create: { width: 900, height: 900, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 80 })
    .toBuffer()
    .then((buffer) => new Blob([new Uint8Array(buffer)], { type: "image/jpeg" }))

/**
 * La zapatilla de lona de la prueba: blanca y negra (con su hex y su foto cada una), de la 38 a
 * la 39, con mínimo, el envío como lo que Sofi puede ofrecer, datos de calzado, un medio de pago y
 * el reparto. Devuelve el producto y la variante negra 38.
 */
async function prepare() {
  await json("GET", "/api/yo")
  await json("POST", `${STORE}/medios-de-pago`, {
    name: "Yape de la prueba",
    typeCode: "68",
    collection: "comprobante",
  })
  const mine = await json("POST", `${STORE}/formas-de-entrega`, {
    name: "Reparto de la prueba",
    type: "DeliveryModeOwnFleet",
    cost: "fijo",
    priceCents: 1000,
    maxDiscountCents: 1000,
  })
  const created = await json("POST", `${STORE}/productos`, {
    name: "Zapatilla de tela",
    category: "Zapatillas",
    description: "Zapatilla de tela para el día a día. Suela gruesa.",
    listPriceCents: 11900,
    minPriceCents: 9900,
    options: [
      { name: "Color", values: ["blanca", "negra"] },
      { name: "Talla", values: ["38", "39"] },
    ],
  })
  const id = created.product.id as string
  const grid = await json("POST", `${STORE}/productos/${id}/cuadricula`, {
    rows: {
      name: "Color",
      values: [
        { value: "blanca", hex: "#ffffff" },
        { value: "negra", hex: "#1f1f1f" },
      ],
    },
    columns: { name: "Talla", values: [{ value: "38" }, { value: "39" }] },
    cells: [
      { row: "blanca", column: "38", stock: 4, priceCents: null },
      { row: "blanca", column: "39", stock: 4, priceCents: null },
      { row: "negra", column: "38", stock: 2, priceCents: null },
      { row: "negra", column: "39", stock: 3, priceCents: null },
    ],
  })
  const colors = grid.product.colors as { id: string; value: string }[]
  for (const [value, rgb] of [
    ["blanca", [245, 245, 240]],
    ["negra", [30, 30, 30]],
  ] as const) {
    const color = colors.find((c) => c.value === value)!
    await json(
      "POST",
      `${STORE}/productos/${id}/fotos?color=${color.id}`,
      await jpeg(rgb[0], rgb[1], rgb[2]),
    )
  }
  await json("PATCH", `${STORE}/productos/${id}`, {
    rubro: "calzado",
    rubroData: { horma: "Normal", material: "Lona" },
    offers: { delivery: true, discount: false, secondUnit: false, gift: null },
    web: { visible: true, slug: "zapatilla-de-tela" },
  })
  // Sofi cotiza con la primera entrega encendida: las de otros recorridos se apagan.
  const shown = await json("GET", `${STORE}/productos/${id}/vitrina`)
  for (const d of shown.store.deliveries as { id: string }[])
    if (d.id !== mine.method.id)
      await json("PATCH", `${STORE}/formas-de-entrega/${d.id}`, { isActive: false })
  const variants = (await json("GET", `${STORE}/productos/${id}`)).product.variants as {
    id: string
    optionValues: string[]
  }[]
  const negra38 = variants.find((v) => v.optionValues.join() === "negra,38")!.id
  return { id, negra38 }
}

async function noSideScroll(page: Page) {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )
  expect(fits, "la página no se desborda a lo ancho").toBe(true)
}

test.describe.configure({ mode: "serial" })

let product = { id: "", negra38: "" }

test("probar como clienta: la foto del color, la oferta, el carrito y el pago de prueba", async ({
  page,
}) => {
  await as("rosa")
  product = await prepare()
  const stock = async () =>
    (await json("GET", `${STORE}/variantes/${product.negra38}/kardex`)).stock as number
  const before = await stock()
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo/${product.id}`)
  await expect(page.getByRole("heading", { name: "Zapatilla de tela", level: 1 })).toBeVisible()
  await page.getByRole("button", { name: "Probar como clienta" }).click()
  // En una ventana ancha va en la columna lateral; si no cabe, en un cajón.
  const panel = page
    .getByRole("complementary", { name: "Panel lateral" })
    .or(page.getByRole("dialog", { name: "Probar como clienta" }))
  await expect(panel.getByRole("heading", { name: "Probar como clienta" })).toBeVisible()
  const chat = panel.getByRole("log", { name: "El chat de la prueba" })

  // Pregunta por la negra: Sofi manda su foto, con el precio y lo que queda de verdad.
  await panel
    .getByRole("textbox", { name: "Mensaje de la clienta (prueba)" })
    .fill("¿Tienes la negra en 38?")
  await panel.getByRole("button", { name: "Enviar" }).click()
  await expect(chat.getByText(/está a S\/ 119 y me quedan 2/)).toBeVisible({ timeout: 20_000 })
  await expect(chat.getByRole("img", { name: "Zapatilla de tela negra" })).toBeVisible()
  const used = panel.getByRole("list", { name: "Lo que usó Sofi" })
  await expect(used.getByText("Foto de «negra»")).toBeVisible()
  await expect(used.getByText("Stock negra 38: 2")).toBeVisible()
  await shot(panel.page(), "probar-chat-foto-1440")

  // Primero el valor y una sola oferta, con su plazo.
  await panel
    .getByRole("textbox", { name: "Mensaje de la clienta (prueba)" })
    .fill("¿Me haces precio?")
  await panel.getByRole("button", { name: "Enviar" }).click()
  await expect(chat.getByText(/te consigo el envío gratis/)).toBeVisible({ timeout: 20_000 })
  await shot(page, "probar-chat-oferta-1440")

  // La acepta: Sofi anota el pedido de prueba, con su tarjeta del carrito.
  await panel.getByRole("button", { name: "Envío gratis" }).click()
  await expect(chat.getByText(/quedó anotado: S\/ 119, con el envío gratis/)).toBeVisible({
    timeout: 20_000,
  })
  await chat.getByRole("button", { name: "Ver y pagar" }).click()

  // El mismo carrito en la vitrina: lo acordado con su reloj.
  const cart = panel.getByRole("dialog", { name: "Tu carrito" })
  await expect(cart.getByText("Envío gratis acordado con Sofi")).toBeVisible()
  await expect(cart.getByText(/^\d{2}:\d{2}:\d{2}$/)).toBeVisible()
  await shot(page, "probar-vitrina-carrito-1440")
  await cart.getByRole("button", { name: /Pagar ahora · S\/ 119/ }).click()
  const pay = panel.getByRole("dialog", { name: "Pagar" })
  await expect(pay.getByText(/Pago de prueba: no se cobra/)).toBeVisible()
  await shot(page, "probar-vitrina-pago-1440")
  // Los medios de la tienda para pagar ya, no unos fijos.
  await expect(pay.getByRole("button", { name: "Pagar con Tarjeta" })).toHaveCount(0)
  await pay.getByRole("button", { name: "Pagar con Yape de la prueba" }).click()
  const order = panel.getByRole("dialog", { name: "Tu pedido" })
  await expect(order.getByText("Pagaste")).toBeVisible({ timeout: 20_000 })
  await shot(page, "probar-vitrina-pedido-1440")

  // Sofi escribe una vez después del pago, por su misma tubería.
  await order.getByRole("button", { name: "Ver lo que te escribió Sofi" }).click()
  await expect(chat.getByText(/Pago recibido/)).toBeVisible()
  await shot(page, "probar-chat-pago-1440")
  // Es de prueba: el stock no se movió.
  expect(await stock()).toBe(before)
  await noSideScroll(page)
})

test("la vitrina anuncia lo de la variante elegida y su carrito cobra lo que arma el servidor", async ({
  page,
}) => {
  await as("rosa")
  // 2 o más a S/ 110 para todo el producto; −30 % solo en la 39, hasta un 8 de diciembre.
  await json("PATCH", `${STORE}/productos/${product.id}`, {
    quantityPrices: [{ minQuantity: 2, unitPriceCents: 11000 }],
    promotions: [
      {
        name: "Cyber",
        percentOff: 30,
        startsOn: "2020-01-01",
        endsOn: "2099-12-08",
        scope: { optionIndex: 1, optionValue: "39" },
      },
    ],
  })
  const shown = await json("GET", `${STORE}/productos/${product.id}/vitrina`)
  try {
    await page.setViewportSize(DESKTOP)
    await page.goto(`${BASE}/catalogo/${product.id}`)
    await page.getByRole("button", { name: "Probar como clienta" }).click()
    const panel = page
      .getByRole("complementary", { name: "Panel lateral" })
      .or(page.getByRole("dialog", { name: "Probar como clienta" }))
    await expect(panel.getByRole("heading", { name: "Probar como clienta" })).toBeVisible()
    await panel.getByRole("button", { name: "Empezar de nuevo" }).click()
    await panel
      .getByRole("radio", { name: "Vitrina" })
      .or(panel.getByRole("button", { name: "Vitrina" }))
      .first()
      .click()

    // La negra sin talla: la promoción es solo de la 39, así que la foto no lleva «−30 %».
    await panel.getByRole("radio", { name: "negra" }).click()
    await expect(panel.getByText("−30 %")).toHaveCount(0)
    await expect(
      panel.getByText(/Cyber: 30 % menos en la 39 hasta el 8 de diciembre/),
    ).toBeVisible()
    // En la 39 sí, y ahí no se anuncia «2 o más» (ya cuesta menos).
    await panel.getByRole("button", { name: "Talla 39" }).click()
    await expect(panel.getByText("−30 %")).toBeVisible()
    await expect(panel.getByText(/2 o más/)).toHaveCount(0)
    // En la 38: «2 o más: S/ 110», sobre su precio.
    await panel.getByRole("button", { name: "Talla 38" }).click()
    await expect(panel.getByText("−30 %")).toHaveCount(0)
    await expect(panel.getByText("2 o más: S/ 110 cada uno")).toBeVisible()
    await shot(page, "probar-vitrina-variante-1440")

    // Dos pares de la 38: el carrito dice lo que arma el servidor (2 × 110 + 10 de envío).
    await panel.getByRole("button", { name: "Lo quiero" }).click()
    await panel.getByRole("button", { name: "Lo quiero" }).click()
    await panel.getByRole("button", { name: /^Tu carrito, 2/ }).click()
    const cart = panel.getByRole("dialog", { name: "Tu carrito" })
    const payNow = cart.getByRole("button", { name: /^Pagar ahora/ })
    await expect(payNow).toHaveText("Pagar ahora · S/ 230")
    await expect(cart.getByText("S/ 220")).toBeVisible()
    await shot(page, "probar-vitrina-carrito-cantidad-1440")
    await payNow.click()

    // El foco entra a la hoja de pago (no cae al principio de la página).
    const pay = panel.getByRole("dialog", { name: "Pagar" })
    await expect(pay.getByRole("heading", { name: "Pagar S/ 230" })).toBeVisible()
    await expect(pay.getByRole("button", { name: "Cerrar" })).toBeFocused()
    // Los medios para pagar ya de la tienda, en su orden.
    const methods = await pay.getByRole("button", { name: /^Pagar con / }).allInnerTexts()
    expect(methods.map((m) => m.trim())).toEqual(
      (shown.store.payNow as { name: string }[]).map((m) => `Pagar con ${m.name}`),
    )
    await pay.getByRole("button", { name: "Pagar con Yape de la prueba" }).click()
    await expect(panel.getByRole("dialog", { name: "Tu pedido" }).getByText("Pagaste")).toBeVisible(
      {
        timeout: 20_000,
      },
    )

    // El pedido de prueba no entra a Pedidos y el servidor no lo deja salir.
    const conversation = await page.evaluate(
      ([store, id]) => window.sessionStorage.getItem(`gestoria.prueba.${store}.${id}`),
      [STORE_ID, product.id],
    )
    const { cart: tested } = await json("GET", `${STORE}/conversaciones/${conversation}/carrito`)
    expect(tested).toMatchObject({ totalCents: 23000, paid: true })
    const open = await json("GET", `${STORE}/pedidos?filtro=abiertos`)
    expect((open.orders as { id: string }[]).map((o) => o.id)).not.toContain(tested.id)
    await expect(json("POST", `${STORE}/pedidos/${tested.id}/salio`, {})).rejects.toThrow(/409/)

    // Escribir como clienta no es un dato que se pierda: salir no pregunta.
    await panel
      .getByRole("radio", { name: "WhatsApp" })
      .or(panel.getByRole("button", { name: "WhatsApp" }))
      .first()
      .click()
    await panel.getByRole("textbox", { name: "Mensaje de la clienta (prueba)" }).fill("Hola")
    await page
      .getByRole("navigation", { name: "Principal" })
      .getByRole("link", { name: "Inicio" })
      .click()
    await expect(page.getByRole("alertdialog", { name: "¿Salir sin guardar?" })).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`${BASE}/?$`))
  } finally {
    await json("PATCH", `${STORE}/productos/${product.id}`, { quantityPrices: [], promotions: [] })
  }
})

test("en el teléfono la prueba es un cajón, y la vista previa muestra celular y web", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(PHONE)
  await page.goto(`${BASE}/catalogo/${product.id}`)
  await page.getByRole("button", { name: "Probar como clienta" }).click()
  const panel = page.getByRole("dialog", { name: "Probar como clienta" })
  await expect(panel).toBeVisible()
  // La conversación tiene alto útil: más de la mitad de la pantalla.
  const log = panel.getByRole("log", { name: "El chat de la prueba" })
  const box = await log.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(PHONE.height / 2)
  await shot(page, "probar-chat-390")
  await panel
    .getByRole("radio", { name: "Vitrina" })
    .or(panel.getByRole("button", { name: "Vitrina" }))
    .first()
    .click()
  await expect(panel.getByRole("button", { name: "Lo quiero" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "probar-vitrina-390")
  await page.keyboard.press("Escape")
  await expect(panel).toHaveCount(0)

  // En el teléfono, la vista previa también muestra cómo lo manda Sofi por WhatsApp (la Ayuda lo dice).
  await page.getByRole("button", { name: "Más opciones" }).click()
  await page.getByRole("menuitem", { name: "Vista previa" }).click()
  const small = page.getByRole("dialog", { name: "Vista previa" })
  await small.getByText("En WhatsApp, cuando la piden").scrollIntoViewIfNeeded()
  await expect(small.getByText("En WhatsApp, cuando la piden")).toBeVisible()
  await expect(small.getByText("Ejemplo, con la ficha de ahora")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "vista-previa-whatsapp-390")
  await page.keyboard.press("Escape")

  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo/${product.id}`)
  await page.getByRole("button", { name: "Vista previa" }).click()
  const preview = page.getByRole("dialog", { name: "Vista previa" })
  await expect(preview.getByText("En la vitrina, por link")).toBeVisible()
  await expect(preview.getByText("En WhatsApp, cuando la piden")).toBeVisible()
  await shot(page, "vista-previa-celular-1440")
  await preview
    .getByRole("radio", { name: "Web" })
    .or(preview.getByRole("button", { name: "Web" }))
    .first()
    .click()
  await expect(preview.getByRole("heading", { name: "Zapatilla de tela", level: 1 })).toBeVisible()
  await shot(page, "vista-previa-web-1440")
})
