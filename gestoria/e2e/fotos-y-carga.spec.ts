import { mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import sharp from "sharp"
import { ACCOUNT, API_PORT, STORE_ID, WEB, type Who } from "./entorno"

/**
 * Las fotos y los videos de la ficha y «Cargar muchos» (ADR 0236) en un navegador, contra su
 * servidor, su base y un RustFS de verdad (`servidor.ts`):
 * - Subir fotos a la ficha, ordenarlas arrastrando y con Alt y las flechas, elegir la que manda
 *   Sofi de un color y subir un video corto (se prepara en el navegador para WhatsApp).
 * - «Cargar muchos»: varias fotos, cada una un producto; juntar dos, poner nombre y el precio a
 *   varios a la vez y «Crear», que recién entonces los pasa al catálogo.
 * Escritorio y 390 px, claro y oscuro. Las capturas van a `gestoria/e2e/capturas/`.
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

// biome-ignore lint/suspicious/noExplicitAny: el recorrido lee respuestas JSON de forma libre
async function json(method: string, path: string, body?: unknown): Promise<any> {
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

/** Una foto de un color liso, como sale de un celular (con lo que sea, pero foto). */
const photo = async (name: string, r: number, g: number, b: number) => ({
  name,
  mimeType: "image/jpeg",
  buffer: await sharp({
    create: { width: 1200, height: 1200, channels: 3, background: { r, g, b } },
  })
    .jpeg({ quality: 85 })
    .toBuffer(),
})

test.describe.configure({ mode: "serial" })

let productId = ""

test("la ficha: subir, ordenar, la foto de cada color y el video", async ({ page }) => {
  await as("rosa")
  await json("GET", "/api/yo")
  const created = await json("POST", `${STORE}/productos`, {
    name: "Zapatilla con fotos",
    category: "Zapatillas",
    listPriceCents: 12900,
    options: [
      { name: "Color", values: ["blanca", "negra"] },
      { name: "Talla", values: ["38", "39"] },
    ],
  })
  productId = created.product.id
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo/${productId}`)
  const card = page.locator("#fotos")
  await expect(card.getByRole("heading", { name: "Fotos y videos" })).toBeVisible()

  // Tres fotos de una vez, elegidas (como soltarlas): la primera es la portada.
  await card
    .locator('input[type="file"]:not([capture])')
    .setInputFiles([
      await photo("blanca.jpg", 245, 245, 240),
      await photo("negra.jpg", 30, 30, 30),
      await photo("caja.jpg", 200, 170, 120),
    ])
  await expect(page.getByText("Agregaste 3 fotos")).toBeVisible({ timeout: 30_000 })
  const items = card.getByRole("listitem")
  await expect(items.filter({ hasText: "Portada" })).toHaveCount(1)
  await expect(card.getByRole("listitem", { name: /^Foto \d/ })).toHaveCount(3)
  const ids = async () =>
    ((await json("GET", `${STORE}/productos/${productId}/medios`)).photos as { id: string }[]).map(
      (p) => p.id,
    )
  const [first, second, third] = await ids()

  // Con el teclado: Alt y la flecha mueven la tercera antes de la segunda.
  await card.getByRole("listitem", { name: /^Foto 3/ }).focus()
  await page.keyboard.press("Alt+ArrowLeft")
  await expect(page.getByText("Moviste la foto")).toBeVisible()
  await expect.poll(ids).toEqual([first, third, second])

  // Arrastrando: la segunda pasa a ser la portada.
  const from = await card.getByRole("listitem", { name: /^Foto 2/ }).boundingBox()
  const to = await card.getByRole("listitem", { name: /^Foto 1/ }).boundingBox()
  if (!from || !to) throw new Error("no se ven las fotos")
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 - 20, from.y + from.height / 2, { steps: 4 })
  await page.mouse.move(to.x + to.width / 3, to.y + to.height / 3, { steps: 12 })
  await page.mouse.up()
  await expect(page.getByText("Cambiaste la portada")).toBeVisible()
  await expect.poll(ids).toEqual([third, first, second])

  // La que manda Sofi cuando piden la negra: desde el menú de la foto.
  await card.getByRole("button", { name: "Opciones de la foto 3" }).click()
  await page.getByRole("menuitem", { name: /Cuando pidan «negra»/ }).click()
  await expect(card.getByRole("listitem", { name: /la que manda Sofi de negra/ })).toBeVisible()
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /^Guardado$/ })
      .first(),
  ).toBeVisible({
    timeout: 15_000,
  })

  // El video corto: se prepara en el navegador y queda con su duración.
  await card.locator('input[type="file"]:not([capture])').setInputFiles({
    name: "puesta.mp4",
    mimeType: "video/mp4",
    buffer: readFileSync(resolve("../apps/api/semilla/video-calzado.mp4")),
  })
  const video = card.getByRole("listitem", { name: /^Video de 0:0\d/ })
  await expect(page.getByText("Agregaste el video")).toBeVisible({ timeout: 60_000 })
  await expect(video).toBeVisible()
  await noSideScroll(page)
  await shot(page, "pr4-ficha-fotos-1440-claro")
  await page.emulateMedia({ colorScheme: "dark" })
  // Los colores pasan con su transición: la captura espera a que terminen.
  await page.waitForTimeout(600)
  await shot(page, "pr4-ficha-fotos-1440-oscuro")
  await page.emulateMedia({ colorScheme: "light" })

  // En el celular: arriba, para pasar con el dedo; la cámara y la galería primero.
  await page.setViewportSize(PHONE)
  await page.reload()
  await page.getByRole("button", { name: /Fotos y videos/ }).click()
  await expect(page.getByRole("button", { name: "Tomar foto" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Galería" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "pr4-ficha-fotos-390-claro")
  await page.emulateMedia({ colorScheme: "dark" })
  // Los colores pasan con su transición: la captura espera a que terminen.
  await page.waitForTimeout(600)
  await shot(page, "pr4-ficha-fotos-390-oscuro")
  await page.emulateMedia({ colorScheme: "light" })
})

test("cargar muchos: fotos, juntar, el precio a varios y «Crear»", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo`)
  await page.getByRole("button", { name: "Cargar muchos" }).click()
  await expect(page).toHaveURL(/\/catalogo\/cargar$/)
  await expect(page.getByText("Suelta aquí todas tus fotos")).toBeVisible()
  await shot(page, "pr4-cargar-vacio-1440-claro")

  await page
    .locator('input[type="file"][accept="image/*"]:not([capture])')
    .setInputFiles([
      await photo("IMG_1.jpg", 250, 200, 220),
      await photo("IMG_2.jpg", 248, 205, 225),
      await photo("IMG_3.jpg", 120, 90, 60),
    ])
  await expect(page.getByText("Subiste 3 fotos")).toBeVisible({ timeout: 30_000 })
  const rows = page.getByRole("row").filter({ has: page.getByRole("checkbox") })
  // La cabecera también tiene su casilla: tres productos y la cabecera.
  await expect(rows).toHaveCount(4)
  // Dice de quién es la carga abierta y desde cuándo.
  await expect(page.getByText(/^Abriste esta carga el /)).toBeVisible()
  // Nada pasó al catálogo todavía.
  const before = (await json("GET", `${STORE}/catalogo`)).products.length

  // Las dos primeras son la misma zapatilla: se eligen y se juntan.
  await page.getByRole("checkbox", { name: "Elegir este producto" }).nth(0).check()
  await page.getByRole("checkbox", { name: "Elegir este producto" }).nth(1).check()
  await page.getByRole("button", { name: "Juntar en uno" }).click()
  await expect(page.getByText("Juntaste las fotos en un producto")).toBeVisible()
  await expect(rows).toHaveCount(3)

  // Nombre a cada uno y el precio y las tallas a los dos a la vez.
  const names = page.getByRole("textbox", { name: "Nombre" })
  await names.nth(0).fill("Plataforma de la carga")
  await names.nth(0).press("Enter")
  await names.nth(1).fill("Sandalia de la carga")
  await names.nth(1).press("Enter")
  await expect(names.nth(1)).toHaveValue("Sandalia de la carga")
  await page.getByRole("checkbox", { name: "Elegir todos" }).check()
  await page.getByRole("textbox", { name: "Precio para los elegidos" }).fill("129")
  await page.getByRole("textbox", { name: "Tallas para los elegidos" }).fill("36 a 38")
  await page.getByRole("textbox", { name: "Stock por talla para los elegidos" }).fill("2")
  await page.getByRole("button", { name: "Poner a los 2" }).click()
  await expect(page.getByText("Listo: se aplicó a 2")).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Precio" }).nth(0)).toHaveValue(/129/)
  await noSideScroll(page)
  await shot(page, "pr4-cargar-revisar-1440-claro")
  await page.emulateMedia({ colorScheme: "dark" })
  // Los colores pasan con su transición: la captura espera a que terminen.
  await page.waitForTimeout(600)
  await shot(page, "pr4-cargar-revisar-1440-oscuro")
  await page.emulateMedia({ colorScheme: "light" })
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "pr4-cargar-revisar-390-claro")
  await page.emulateMedia({ colorScheme: "dark" })
  // Los colores pasan con su transición: la captura espera a que terminen.
  await page.waitForTimeout(600)
  await shot(page, "pr4-cargar-revisar-390-oscuro")
  await page.emulateMedia({ colorScheme: "light" })
  await page.setViewportSize(DESKTOP)
  expect((await json("GET", `${STORE}/catalogo`)).products.length).toBe(before)

  // «No crear este» tiene vuelta: «Deshacer» en el aviso y «Volver a incluir» abajo.
  const leaveOut = async () => {
    await page.getByRole("button", { name: "Opciones de Sandalia de la carga" }).click()
    await page.getByRole("menuitem", { name: "No crear este" }).click()
    await expect(rows).toHaveCount(2)
  }
  await leaveOut()
  await page.getByRole("button", { name: "Deshacer" }).click()
  await expect(rows).toHaveCount(3)
  await leaveOut()
  const apart = page.getByRole("region", { name: "Lo que no se va a crear" })
  await expect(apart).toContainText("Sandalia de la carga")
  await shot(page, "pr4-cargar-no-crear-1440-claro")
  await apart.getByRole("button", { name: "Volver a incluir" }).click()
  await expect(rows).toHaveCount(3)
  await expect(apart).toBeHidden()

  await page.getByRole("button", { name: "Crear 2 productos" }).click()
  await expect(page.getByText("Creaste 2 productos")).toBeVisible()
  await expect(page).toHaveURL(/\/catalogo$/)
  await expect(page.getByRole("row", { name: /Plataforma de la carga/ })).toBeVisible()
  const catalog = (await json("GET", `${STORE}/catalogo`)).products as {
    name: string
    id: string
    stock: number
  }[]
  const made = catalog.find((p) => p.name === "Plataforma de la carga")!
  expect(made.stock).toBe(6)
  const media = await json("GET", `${STORE}/productos/${made.id}/medios`)
  expect(media.photos).toHaveLength(2)
  // Su historial empieza con «Creó el producto», como el que se agrega solo.
  const history = await json("GET", `${STORE}/productos/${made.id}/historial`)
  expect(history.events.map((e: { action: string }) => e.action)).toContain("creado")
})

test("«Descartar la carga» pregunta antes de borrar sus fotos", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo/cargar`)
  await page
    .locator('input[type="file"][accept="image/*"]:not([capture])')
    .setInputFiles([await photo("IMG_9.jpg", 60, 120, 200)])
  await expect(page.getByText("Subiste 1 foto")).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: "Más opciones" }).click()
  await page.getByRole("menuitem", { name: "Descartar la carga" }).click()
  const ask = page.getByRole("alertdialog", { name: "¿Descartar la carga?" })
  await expect(ask).toContainText("Se borran su foto")
  await shot(page, "pr4-cargar-descartar-1440-claro")
  await ask.getByRole("button", { name: "Seguir con la carga" }).click()
  await expect(ask).toBeHidden()
  await expect(page.getByRole("textbox", { name: "Nombre" })).toHaveCount(1)
  await page.getByRole("button", { name: "Más opciones" }).click()
  await page.getByRole("menuitem", { name: "Descartar la carga" }).click()
  await ask.getByRole("button", { name: "Descartar la carga" }).click()
  await expect(page.getByText("Descartaste la carga: nada pasó al catálogo")).toBeVisible()
  await expect(page.getByText("Suelta aquí todas tus fotos")).toBeVisible()
})
