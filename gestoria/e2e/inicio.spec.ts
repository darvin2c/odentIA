import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, API_PORT, STORE_ID, WEB, type Who } from "./entorno"

/**
 * Inicio y los primeros pasos en un navegador (lienzo «gestorIA como odentIA», tableros 5 y 16),
 * contra su servidor y su base de verdad:
 * - Carmen crea Tortas Carmen y la tienda abre en Inicio con «Tu tienda está casi lista»: cada
 *   paso se marca con lo guardado, abre su apartado con «Volver a Inicio», «No lo necesito» salta
 *   lo que no aplica y, cuando no falta ninguno, la lista se va y no vuelve.
 * - En Calzados Rosa, «Te toca»: el pago de Camila se confirma con «Ver y confirmar», que abre el
 *   pedido con su captura; lo que no se entregó lleva «Pasar a…». Ventas ve lo suyo, sin los
 *   totales de dinero.
 * Cada pantalla en escritorio y a 390 px, sin desborde. Las capturas van a `gestoria/e2e/capturas/`.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1366, height: 860 }
const PHONE = { width: 390, height: 844 }
/** Un PNG de 1 × 1: la captura del Yape de Camila. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4H8bwHwAE/wJ/l6pZhwAAAABJRU5ErkJggg==",
  "base64",
)

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

/** Lo que el recorrido arma por la API, como quien entró. */
async function call(
  storeId: string,
  method: string,
  path: string,
  body?: unknown,
  form?: FormData,
) {
  const { token } = (await (await fetch(`${ACCOUNT}/api/auth/token`)).json()) as { token: string }
  const response = await fetch(`http://127.0.0.1:${API_PORT}/api/tiendas/${storeId}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      origin: WEB,
      ...(form || body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await response.json()) as Json
  expect(response.ok, JSON.stringify(json)).toBe(true)
  return json
}

/** El día de hoy en Lima, la hora de las tiendas del recorrido. */
function todayInLima() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
}

test.describe.configure({ mode: "serial" })
// El país de la tienda nueva sale de la región del navegador, como en el teléfono.
test.use({ locale: "es-PE", timezoneId: "America/Lima" })

test("una tienda nueva abre en Inicio con sus primeros pasos, y la lista se va al terminar", async ({
  page,
}) => {
  await as("carmen")
  await page.setViewportSize(DESKTOP)
  await page.goto("/tiendas/nueva")
  await page.getByLabel("Nombre de la tienda").fill("Tortas Carmen")
  await page.getByRole("button", { name: "Crear la tienda" }).click()
  // Al crearla, abre en Inicio (tablero 16).
  await expect(page).toHaveURL(/\/tiendas\/[0-9a-f-]{36}\/?$/)
  const storeId = new URL(page.url()).pathname.split("/")[2] ?? ""
  const setup = page.getByRole("region", { name: "Tu tienda está casi lista" })
  await expect(setup).toBeVisible()
  await expect(page.getByRole("heading", { name: /, Carmen$/ })).toBeVisible()
  // Lo guardado al crearla: su país. Los chats todavía no se pueden conectar y no cuentan.
  const step = (title: string) => setup.getByRole("listitem").filter({ hasText: title })
  await expect(step("Datos de la tienda").getByText("Hecho", { exact: true })).toBeVisible()
  await expect(step("Conectar los chats").getByText("Muy pronto", { exact: true })).toBeVisible()
  await expect(setup.getByText("1 de 6", { exact: true })).toBeVisible()
  // Una tienda sin nada todavía no ve cifras en cero.
  await expect(page.getByRole("region", { name: "Las cifras de hoy" })).toHaveCount(0)
  await expect(page.getByText("Nada por ahora.")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "inicio-primeros-pasos-escritorio")

  // «No lo necesito»: trabaja sola. El paso queda saltado, no hecho.
  await step("Invitar al equipo").getByRole("button", { name: "No lo necesito" }).click()
  await expect(step("Invitar al equipo").getByText("Saltado", { exact: true })).toBeVisible()
  await expect(setup.getByText("2 de 6", { exact: true })).toBeVisible()

  // Cada paso abre su apartado y ofrece volver; se marca solo al guardar.
  await step("Medios de pago").getByRole("link", { name: "Agregar un medio" }).click()
  await expect(page).toHaveURL(/\/configuracion\/medios-de-pago\?desde=inicio$/)
  const yape = (
    await call(storeId, "POST", "/medios-de-pago", {
      name: "Yape",
      typeCode: "68",
      collection: "comprobante",
    })
  ).method.id as string
  await page.getByRole("link", { name: "Volver a Inicio" }).click()
  await expect(page).toHaveURL(/\/tiendas\/[^/]+\/?$/)
  await expect(step("Medios de pago").getByText("Hecho", { exact: true })).toBeVisible()
  await expect(step("Medios de pago").getByText("Yape", { exact: true })).toBeVisible()
  await expect(setup.getByText("3 de 6", { exact: true })).toBeVisible()

  // A 390 px, lo hecho se junta en una línea y el paso que sigue queda abierto, con su botón.
  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(setup).toBeVisible()
  await expect(setup.getByText("Datos de la tienda, Medios de pago")).toBeVisible()
  await expect(
    step("Tu catálogo").getByText("Sofi vende lo que tienes", { exact: false }),
  ).toBeVisible()
  await expect(step("Tu catálogo").getByRole("link", { name: "Agregar productos" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "inicio-primeros-pasos-telefono")

  // Con lo que falta guardado y Sofi saltada, la lista se va de Inicio y no vuelve.
  await call(storeId, "POST", "/formas-de-entrega", {
    name: "Recojo en el taller",
    type: "OnSitePickup",
    cost: "gratis",
  })
  const product = (
    await call(storeId, "POST", "/productos", { name: "Torta de chocolate", listPriceCents: 6500 })
  ).product.id as string
  const variant = (await call(storeId, "GET", `/productos/${product}`)).product.variants[0].id
  await call(storeId, "POST", `/variantes/${variant}/movimientos`, {
    kind: "entrada",
    quantity: 12,
  })
  await page.setViewportSize(DESKTOP)
  await page.reload()
  await step("Probar a Sofi").getByRole("button", { name: "No lo necesito" }).click()
  await expect(setup).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Te toca" })).toBeVisible()
  // Aunque después se apague el medio de pago, la lista no vuelve.
  await call(storeId, "PATCH", `/medios-de-pago/${yape}`, { isActive: false })
  await page.reload()
  await expect(page.getByRole("heading", { name: "Te toca" })).toBeVisible()
  await expect(setup).toHaveCount(0)
  await noSideScroll(page)
  await shot(page, "inicio-lista-escritorio")
})

test.describe("«Te toca» en Calzados Rosa", () => {
  const ids = { yape: "", efectivo: "", reparto: "", variant: "" }
  /** Los pedidos de este recorrido: se anulan al final, para no sumar a lo que miran los demás. */
  const made: string[] = []
  const store = (method: string, path: string, body?: unknown, form?: FormData) =>
    call(STORE_ID, method, path, body, form)

  test.beforeAll(async () => {
    await as("rosa")
    ids.yape = (
      await store("POST", "/medios-de-pago", {
        name: "Yape de la tienda",
        typeCode: "68",
        collection: "comprobante",
      })
    ).method.id
    ids.efectivo = (
      await store("POST", "/medios-de-pago", {
        name: "Efectivo al recibir",
        typeCode: "10",
        collection: "al_recibir",
      })
    ).method.id
    ids.reparto = (
      await store("POST", "/formas-de-entrega", {
        name: "Reparto en Lima",
        type: "DeliveryModeOwnFleet",
        cost: "fijo",
        priceCents: 1000,
        acceptsPayOnDelivery: true,
      })
    ).method.id
    const product = (
      await store("POST", "/productos", {
        name: "Botín marrón",
        listPriceCents: 13900,
        options: [{ name: "Talla", values: ["41"] }],
      })
    ).product.id as string
    ids.variant = (await store("GET", `/productos/${product}`)).product.variants[0].id
    await store("POST", `/variantes/${ids.variant}/movimientos`, { kind: "entrada", quantity: 5 })
    const order = (customerName: string, customerPhone: string, paymentMethodId: string) =>
      store("POST", "/pedidos", {
        customerName,
        customerPhone,
        channel: "whatsapp",
        address: "Av. Arequipa 1450, Lince",
        lines: [{ variantId: ids.variant, quantity: 1 }],
        deliveryMethodId: ids.reparto,
        paymentMethodId,
        deliverOn: todayInLima(),
      })
    // Camila envió su Yape: espera que alguien mire la captura.
    const camila = (await order("Camila Ríos", "+51 945 118 204", ids.yape)).order
    made.push(camila.id)
    const form = new FormData()
    form.set("amountCents", String(camila.totalCents))
    form.set("captura", new File([PNG], "captura.png", { type: "image/png" }))
    await store("POST", `/pedidos/${camila.id}/comprobante`, undefined, form)
    // Martín no contestó: volvió sin entregar y sale otra vez hoy.
    const martin = (await order("Martín Vega", "+51 987 300 451", ids.efectivo)).order
    made.push(martin.id)
    await store("POST", `/pedidos/${martin.id}/salio`, {})
    await store("POST", `/pedidos/${martin.id}/no-se-entrego`, {
      reason: "No contestó",
      deliverOn: todayInLima(),
    })
  })

  test.afterAll(async () => {
    await as("rosa")
    for (const id of made)
      await store("POST", `/pedidos/${id}/anular`, { reason: "Fin del recorrido" })
    for (const id of [ids.yape, ids.efectivo])
      await store("PATCH", `/medios-de-pago/${id}`, { isActive: false })
    await store("PATCH", `/formas-de-entrega/${ids.reparto}`, { isActive: false })
  })

  test("el Dueño confirma el pago viendo la captura, y lo que no se entregó lleva «Pasar a…»", async ({
    page,
  }) => {
    await as("rosa")
    await page.setViewportSize(DESKTOP)
    await page.goto(`/tiendas/${STORE_ID}`)
    const figures = page.getByRole("region", { name: "Las cifras de hoy" })
    for (const title of ["Cobrado hoy", "Por confirmar", "Falta cobrar", "Sale hoy"])
      await expect(figures.getByText(title, { exact: true })).toBeVisible()
    await expect(figures.getByText(/y 1 que no se entregó/)).toBeVisible()
    const toDo = page.getByRole("region", { name: "Te toca" })
    const camila = toDo.getByRole("listitem").filter({ hasText: "Camila Ríos" })
    const martin = toDo.getByRole("listitem").filter({ hasText: "Martín Vega" })
    await expect(camila).toContainText("envió su Yape de la tienda de")
    await expect(martin).toContainText("No contestó")
    await expect(martin.getByRole("button", { name: "Pasar a…" })).toBeVisible()
    await noSideScroll(page)
    await shot(page, "inicio-te-toca-escritorio")

    // «Ver y confirmar» abre el pedido con su captura: nunca se confirma a ciegas.
    await camila.getByRole("button", { name: "Ver y confirmar" }).click()
    const sheet = page.getByRole("dialog", { name: /· Camila Ríos$/ })
    await expect(sheet.getByRole("img", { name: "Captura del pago" })).toBeVisible()
    await shot(page, "inicio-ver-y-confirmar-escritorio")
    await sheet.getByRole("button", { name: "Confirmar pago" }).click()
    await expect(sheet.getByText("Nada: está pagado")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(sheet).toHaveCount(0)
    await expect(camila).toHaveCount(0)

    // «Pasar a…» desde Inicio: el mismo diálogo de Pedidos.
    await martin.getByRole("button", { name: "Pasar a…" }).click()
    await expect(page.getByRole("alertdialog", { name: /^Pasar a… · pedido/ })).toBeVisible()
    await page.keyboard.press("Escape")

    await page.setViewportSize(PHONE)
    await page.reload()
    await expect(martin.getByRole("button", { name: "Pasar a…" })).toBeVisible()
    await noSideScroll(page)
    await shot(page, "inicio-te-toca-telefono")
  })

  test("Ventas ve lo que le toca, sin los totales de dinero ni los primeros pasos", async ({
    page,
  }) => {
    await as("lucia")
    await page.setViewportSize(DESKTOP)
    await page.goto(`/tiendas/${STORE_ID}`)
    const figures = page.getByRole("region", { name: "Las cifras de hoy" })
    await expect(figures.getByText("Por confirmar", { exact: true })).toBeVisible()
    await expect(figures.getByText("Sale hoy", { exact: true })).toBeVisible()
    await expect(figures.getByText("Cobrado hoy", { exact: true })).toHaveCount(0)
    await expect(figures.getByText("Falta cobrar", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Tu tienda está casi lista" })).toHaveCount(0)
    const toDo = page.getByRole("region", { name: "Te toca" })
    await expect(
      toDo.getByRole("listitem").filter({ hasText: "Martín Vega" }).getByRole("button", {
        name: "Pasar a…",
      }),
    ).toBeVisible()
    await noSideScroll(page)
    await shot(page, "inicio-ventas-escritorio")
    await page.setViewportSize(PHONE)
    await page.reload()
    await expect(toDo).toBeVisible()
    await noSideScroll(page)
    await shot(page, "inicio-ventas-telefono")
  })
})
