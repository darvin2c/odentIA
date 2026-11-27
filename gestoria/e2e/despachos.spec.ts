import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { ACCOUNT, API_PORT, STORE_ID, surface, WEB, type Who } from "./entorno"

/**
 * Despachos y Caja en un navegador (lienzo «gestorIA como odentIA», tableros 6, 17, 23 y 24),
 * contra su servidor y su base de verdad:
 * - El día: primero lo que no se entregó (Jorge, con su motivo y su «Cobrar»), después cada franja
 *   (Valeria, de 14 a 18 h) y «Sin franja» (Ana, con su pago por confirmar). Filtro por repartidor.
 * - «Pasar a…» con el teclado y a 390 px: Valeria pasa a mañana, de 9 a 13 h.
 * - «Salió» y «Cobrar y entregar»: lo cobrado en efectivo queda a nombre de Kevin y en Caja se
 *   recibe con «Recibí», con la diferencia escrita.
 * - El Yape de Ana se confirma en el mismo paso de entregar: sin pago confirmado no se entrega.
 * - «Avisar» abre el WhatsApp con el mensaje y queda «enviado por usted».
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

async function send(method: string, path: string, body?: unknown | FormData): Promise<Json> {
  const { token } = (await (await fetch(`${ACCOUNT}/api/auth/token`)).json()) as { token: string }
  const form = body instanceof FormData
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      origin: WEB,
      ...(body === undefined || form ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
  })
  const json = (await response.json()) as Json
  expect(response.ok, JSON.stringify(json)).toBe(true)
  return json
}

const MORNING = { start: 9 * 60, end: 13 * 60 }
const AFTERNOON = { start: 14 * 60, end: 18 * 60 }

test.describe.configure({ mode: "serial" })

const setup = { efectivo: "", yape: "", reparto: "", variant: "", today: "" }
const orders = {
  jorge: { id: "", number: "" },
  valeria: { id: "", number: "" },
  ana: { id: "", number: "" },
}

/** La fila de un pedido en Despachos. */
const rowOf = (page: Page, number: string): Locator =>
  page.getByRole("listitem").filter({ hasText: `${number} · ` })

test.beforeAll(async () => {
  await as("rosa")
  await send("PATCH", "/franjas", { slots: [MORNING, AFTERNOON] })
  setup.efectivo = (
    await send("POST", "/medios-de-pago", {
      name: "Efectivo en la puerta",
      typeCode: "10",
      collection: "al_recibir",
    })
  ).method.id
  setup.yape = (
    await send("POST", "/medios-de-pago", {
      name: "Yape a la tienda",
      typeCode: "68",
      collection: "comprobante",
    })
  ).method.id
  setup.reparto = (
    await send("POST", "/formas-de-entrega", {
      name: "Reparto propio",
      type: "DeliveryModeOwnFleet",
      cost: "fijo",
      priceCents: 1000,
      acceptsPayOnDelivery: true,
    })
  ).method.id
  const product = (
    await send("POST", "/productos", {
      name: "Botín de cuero",
      listPriceCents: 15900,
      options: [{ name: "Talla", values: ["40"] }],
    })
  ).product.id as string
  setup.variant = (await send("GET", `/productos/${product}`)).product.variants[0].id
  await send("POST", `/variantes/${setup.variant}/movimientos`, { kind: "entrada", quantity: 5 })
  setup.today = (await send("GET", "/despachos")).today
  // Botín S/ 159 + envío S/ 10 = S/ 169, en efectivo al recibir.
  const make = async (customerName: string) => {
    const order = (
      await send("POST", "/pedidos", {
        customerName,
        customerPhone: "+51 987 654 321",
        channel: "whatsapp",
        address: "Av. Sáenz Peña 820, Callao",
        lines: [{ variantId: setup.variant, quantity: 1 }],
        deliveryMethodId: setup.reparto,
        paymentMethodId: setup.efectivo,
        deliverOn: setup.today,
      })
    ).order as Json
    return { id: order.id as string, number: order.number as string }
  }
  orders.jorge = await make("Jorge Salinas")
  orders.valeria = await make("Valeria Soto")
  orders.ana = await make("Ana Torres")
  await send("POST", `/pedidos/${orders.jorge.id}/pasar-a`, {
    deliverOn: setup.today,
    slot: MORNING,
    courier: { name: "Kevin" },
  })
  await send("POST", `/pedidos/${orders.jorge.id}/salio`, {})
  await send("POST", `/pedidos/${orders.jorge.id}/no-se-entrego`, {
    reason: "No contestó",
    deliverOn: setup.today,
  })
  await send("POST", `/pedidos/${orders.valeria.id}/pasar-a`, {
    deliverOn: setup.today,
    slot: AFTERNOON,
    courier: { name: "Kevin" },
  })
  // Ana mandó su Yape al número de la tienda: espera a una persona.
  const receipt = new FormData()
  receipt.set("amountCents", "16900")
  receipt.set("methodId", setup.yape)
  await send("POST", `/pedidos/${orders.ana.id}/comprobante`, receipt)
})

test.afterAll(async () => {
  await as("rosa")
  await send("POST", `/pedidos/${orders.jorge.id}/anular`, { reason: "Fin del recorrido" })
  // Las franjas, los medios y el reparto se quitan: los demás recorridos arman los suyos.
  await send("PATCH", "/franjas", { slots: [] })
  for (const id of [setup.efectivo, setup.yape])
    await send("PATCH", `/medios-de-pago/${id}`, { isActive: false })
  await send("PATCH", `/formas-de-entrega/${setup.reparto}`, { isActive: false })
})

test("el día: primero lo que no se entregó, después cada franja, y el filtro por repartidor", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/despachos`)
  await expect(page.getByRole("heading", { name: "Despachos", level: 1 })).toBeVisible()
  const today = page.getByRole("navigation", { name: "Días de entrega" })
  await expect(today.getByRole("button", { pressed: true })).toContainText("no se entregó")

  const missed = page.getByRole("region", { name: /^No se entregó/ })
  const jorge = missed.getByRole("listitem").filter({ hasText: `${orders.jorge.number} · ` })
  await expect(jorge).toContainText("No contestó")
  await expect(jorge).toContainText("Kevin")
  await expect(jorge.getByText("Cobrar S/ 169")).toBeVisible()
  await expect(jorge.getByRole("button", { name: "Pasar a…" })).toBeVisible()
  const afternoon = page.getByRole("region", { name: /^14–18 h/ })
  await expect(afternoon.getByRole("listitem").filter({ hasText: "Valeria Soto" })).toContainText(
    "Envío",
  )
  const ana = page
    .getByRole("region", { name: /^Sin franja/ })
    .getByRole("listitem")
    .filter({ hasText: `${orders.ana.number} · ` })
  await expect(ana.getByText("Pago por confirmar")).toBeVisible()
  // Primero «No se entregó», después las franjas en su orden y al final «Sin franja».
  const titles = await page.getByRole("heading", { level: 2 }).allTextContents()
  const at = (start: string) => titles.findIndex((t) => t.startsWith(start))
  expect(at("No se entregó")).toBeGreaterThanOrEqual(0)
  expect(at("14–18 h")).toBeGreaterThan(at("No se entregó"))
  expect(at("Sin franja")).toBeGreaterThan(at("14–18 h"))
  await shot(page, "despachos-dia-escritorio")

  await page.getByRole("button", { name: "Kevin · 2" }).click()
  await expect(rowOf(page, orders.ana.number)).toHaveCount(0)
  await expect(rowOf(page, orders.valeria.number)).toBeVisible()
  await page.getByRole("button", { name: "Todos", exact: true }).click()
  await expect(rowOf(page, orders.ana.number)).toBeVisible()

  await page.setViewportSize(PHONE)
  await expect(jorge).toBeVisible()
  await noSideScroll(page)
  await shot(page, "despachos-dia-telefono")

  // Ventas entrega pero no ve Caja.
  await as("lucia")
  await page.setViewportSize(DESKTOP)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Despachos", level: 1 })).toBeVisible()
  await expect(page.getByRole("link", { name: "Caja" })).toHaveCount(0)
})

test("«Pasar a…» con el teclado, a 390 px: Valeria pasa a mañana, de 9 a 13 h", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(PHONE)
  await page.goto(`${BASE}/despachos`)
  const valeria = rowOf(page, orders.valeria.number)
  const more = valeria.getByRole("button", {
    name: `Más acciones del pedido ${orders.valeria.number}`,
  })
  await more.focus()
  await page.keyboard.press("Enter")
  const item = page.getByRole("menuitem", { name: "Pasar a…" })
  await expect(item).toBeVisible()
  await item.press("Enter")
  const move = surface(page, /^Pasar a… · /)
  await expect(move).toContainText("Valeria Soto")
  await move.getByRole("button", { name: "Mañana", exact: true }).press("Enter")
  await expect(move.getByRole("button", { name: "Mañana", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await move.getByRole("radio", { name: "9–13 h", exact: true }).press("Space")
  await expect(move.getByRole("radio", { name: "9–13 h", exact: true })).toBeChecked()
  await noSideScroll(page)
  await shot(page, "despachos-pasar-a-telefono")
  await move.getByRole("button", { name: "Pasar a mañana, 9–13 h" }).press("Enter")
  await expect(move).toHaveCount(0)
  await expect(valeria).toHaveCount(0)
  await page.getByRole("button", { name: "Día siguiente" }).click()
  await expect(
    page
      .getByRole("region", { name: /^9–13 h/ })
      .getByRole("listitem")
      .filter({
        hasText: `${orders.valeria.number} · `,
      }),
  ).toBeVisible()
  await noSideScroll(page)
  await shot(page, "despachos-manana-telefono")
})

test("«Salió», «Cobrar y entregar» y «Recibí» en Caja, con la diferencia escrita", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/despachos`)
  await page.getByRole("button", { name: "Día siguiente" }).click()
  const valeria = rowOf(page, orders.valeria.number)
  await valeria.getByRole("button", { name: "Salió" }).click()
  const ship = surface(page, `El pedido ${orders.valeria.number} salió`)
  await expect(ship).toContainText(`El pedido ${orders.valeria.number} salió`)
  await ship.getByRole("button", { name: "Salió" }).click()
  await expect(ship).toHaveCount(0)
  await expect(valeria.getByText("En camino")).toBeVisible()
  await valeria.getByRole("button", { name: "Cobrar y entregar" }).click()
  const deliver = surface(page, "Cobrar S/ 169 y entregar")
  await expect(deliver).toBeVisible()
  await expect(deliver.getByLabel("Cobraste")).toHaveValue("169")
  await expect(deliver.getByText("Suma S/ 169: es lo que falta.")).toBeVisible()
  // Menos de lo que falta no se entrega.
  await deliver.getByLabel("Cobraste").fill("150")
  await expect(deliver.getByText("Faltan S/ 19: sin todo el pago no se entrega.")).toBeVisible()
  await deliver.getByRole("button", { name: "Cobré S/ 150 y entregué" }).click()
  await expect(deliver.getByText("Lo cobrado tiene que sumar S/ 169.")).toBeVisible()
  await deliver.getByLabel("Cobraste").fill("169")
  await shot(page, "despachos-cobrar-escritorio")
  await deliver.getByRole("button", { name: "Cobré S/ 169 y entregué" }).click()
  await expect(deliver).toHaveCount(0)

  await page.goto(`${BASE}/caja`)
  await expect(page.getByRole("heading", { name: "Caja", level: 1 })).toBeVisible()
  const kevin = page.getByRole("listitem").filter({ hasText: "Kevin · te entrega S/ 169" })
  await expect(kevin).toContainText(`${orders.valeria.number} · Valeria Soto`)
  await shot(page, "caja-por-recibir-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "caja-por-recibir-telefono")
  await kevin.getByRole("button", { name: "Recibí S/ 169" }).click()
  // Lo recibido no se deshace: siempre en un cajón aparte, nunca en la columna.
  const receive = page.getByRole("dialog", { name: "Recibí de Kevin" })
  await expect(receive.getByLabel("¿Cuánto recibiste?")).toHaveValue("169")
  await receive.getByLabel("¿Cuánto recibiste?").fill("160")
  await expect(receive.getByText("Faltan S/ 9.")).toBeVisible()
  await receive.getByRole("button", { name: "Recibí S/ 160" }).click()
  await expect(receive.getByText("Escribe por qué no cuadra")).toBeVisible()
  await receive.getByLabel("¿Por qué no cuadra?").fill("Faltó el vuelto")
  await noSideScroll(page)
  await shot(page, "caja-recibi-telefono")
  await receive.getByRole("button", { name: "Recibí S/ 160" }).click()
  await expect(receive).toHaveCount(0)
  await expect(page.getByText("Kevin · te entrega")).toHaveCount(0)
  const received = page.getByRole("region", { name: "Recibido" })
  await expect(received).toContainText("Faltó S/ 9 de S/ 169")
  await expect(received).toContainText("«Faltó el vuelto»")
  await page.setViewportSize(DESKTOP)
  await noSideScroll(page)
  await shot(page, "caja-recibido-escritorio")
})

test("el Yape de Ana se confirma en el mismo paso de entregar", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(PHONE)
  await page.goto(`${BASE}/despachos`)
  const ana = rowOf(page, orders.ana.number)
  await ana.getByRole("button", { name: `Más acciones del pedido ${orders.ana.number}` }).click()
  await page.getByRole("menuitem", { name: "Entregado", exact: true }).click()
  const deliver = surface(
    page,
    new RegExp(`^(Antes de entregar · ${orders.ana.number}|El pedido ${orders.ana.number} llegó)$`),
  )
  await expect(deliver).toContainText(`Antes de entregar · ${orders.ana.number}`)
  await expect(deliver).toContainText("Yape a la tienda · S/ 169")
  await expect(deliver.getByRole("button", { name: "Entregado" })).toBeDisabled()
  await noSideScroll(page)
  await shot(page, "despachos-confirmar-pago-telefono")
  await deliver.getByRole("button", { name: "Ya me pagó: confirmar" }).click()
  await expect(deliver).toContainText(`El pedido ${orders.ana.number} llegó`)
  await deliver.getByRole("button", { name: "Entregado" }).click()
  await expect(deliver).toHaveCount(0)
  await expect(ana.getByText("Entregado", { exact: true })).toBeVisible()
  await expect(ana.getByText("Pagado")).toBeVisible()
})

test("«Avisar» abre el WhatsApp con el mensaje y queda «enviado por usted»", async ({
  page,
  context,
}) => {
  await as("rosa")
  // El WhatsApp no se abre de verdad: se contesta aquí.
  await context.route("https://wa.me/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "WhatsApp" }),
  )
  await page.setViewportSize(PHONE)
  await page.goto(`${BASE}/despachos`)
  const jorge = rowOf(page, orders.jorge.number)
  await jorge.getByRole("button", { name: "Avisar" }).click()
  const notice = surface(page, "Avisar a Jorge Salinas")
  const text = notice.getByLabel("El mensaje")
  await expect(text).toHaveValue(
    // El monto lleva el espacio que no se corta de Intl, entre «S/» y la cifra.
    new RegExp(
      String.raw`^Hola Jorge, tu pedido ${orders.jorge.number} sale hoy entre 9 y 13 h\. Te lo lleva Kevin\. Al recibir pagas S/\s169\.$`,
    ),
  )
  await noSideScroll(page)
  await shot(page, "despachos-avisar-telefono")
  const opened = context.waitForEvent("page")
  await notice.getByRole("button", { name: "Abrir WhatsApp con el aviso" }).click()
  const whatsapp = await opened
  await expect.poll(() => whatsapp.url()).toContain("https://wa.me/51987654321?text=")
  await whatsapp.close()
  await expect(notice).toHaveCount(0)

  await jorge
    .getByRole("button", { name: `Más acciones del pedido ${orders.jorge.number}` })
    .click()
  await page.getByRole("menuitem", { name: "Abrir el pedido" }).click()
  const sheet = surface(page, `Pedido ${orders.jorge.number} · Jorge Salinas`)
  await expect(sheet).toContainText("enviado por usted desde su WhatsApp")
  await expect(sheet).toContainText("Lo lleva")
  await noSideScroll(page)
  await shot(page, "despachos-avisado-telefono")
})
