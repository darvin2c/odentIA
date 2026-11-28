import { mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, API_PORT, STORE_ID, WEB, type Who } from "./entorno"

/**
 * La IA de fotos en un navegador, con el modelo de desarrollo (`fakePhotosModel`: sin red, propone
 * un nombre de muestra y pregunta lo que la plantilla necesita), contra su servidor, su base y su
 * RustFS (`servidor.ts`):
 * - «Agregar desde fotos»: elegir fotos reales, «Mirar», lo punteado (✦), el precio que pone la
 *   persona, «Ver cómo queda» y «Guardar y abrir la ficha».
 * - En la ficha, «Completar»: la pregunta en amarillo se responde a un toque y queda guardada.
 * - «Cargar muchos»: «Juntar con IA» dice lo que vio, sin frenar nada.
 * - Ventas ve la ficha sin propuestas para usar.
 * Escritorio y 390 px, claro y oscuro. Las capturas van a `gestoria/e2e/capturas/`.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const BASE = `/tiendas/${STORE_ID}`
const API = `http://127.0.0.1:${API_PORT}`
const STORE = `/api/tiendas/${STORE_ID}`
const PHOTOS = resolve("../apps/api/eval/fotos")

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true })
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

const real = (name: string) => ({
  name: `${name}.jpg`,
  mimeType: "image/jpeg",
  buffer: readFileSync(resolve(PHOTOS, `${name}.jpg`)),
})

test.describe.configure({ mode: "serial" })

let productId = ""

test("«Agregar desde fotos»: la IA propone, el precio lo pone la persona y se abre la ficha", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo`)
  await page.getByRole("button", { name: "Agregar desde fotos" }).first().click()
  const drawer = page
    .getByRole("dialog", { name: "Agregar desde fotos" })
    .or(page.getByRole("region", { name: "Agregar desde fotos" }))
  await expect(drawer.getByText("Suelta o elige tus fotos")).toBeVisible()
  await drawer
    .locator('input[type="file"]')
    .first()
    .setInputFiles([real("negra2"), real("negra3")])
  await expect(drawer.getByRole("img", { name: "Foto 2" })).toBeVisible()
  await shot(page, "ia-1-elegir-1440")
  await drawer.getByRole("button", { name: "Mirar 2 fotos" }).click()

  // Lo propuesto va punteado, con ✦ y «Usar»; el precio, vacío: lo pone la persona.
  const name = drawer.getByLabel("Nombre", { exact: true })
  await expect(name).toHaveValue("Zapatilla de lona", { timeout: 30_000 })
  // El foco va a lo que vio la IA, no al principio de la página.
  const results = drawer.getByRole("group", { name: "Lo que vio la IA" })
  await expect(results).toBeFocused()
  await expect(drawer.getByLabel("Categoría", { exact: true })).toHaveValue("Zapatillas")
  await expect(drawer.getByText(/La IA propone \d+ cosas y pregunta lo que no ve/)).toBeVisible()
  await expect(drawer.getByRole("listitem").filter({ hasText: /^negra/ })).toBeVisible()
  await expect(drawer.getByText("Lo pones tú. La IA nunca propone precios.")).toBeVisible()
  // Lo que no se ve, en amarillo y con sus opciones; el material que se ve, propuesto.
  const fit = drawer.getByRole("group", { name: "¿Cómo calza? No se ve en las fotos." })
  await expect(fit).toBeVisible()
  await shot(page, "ia-2-propuesta-1440")
  await fit.getByRole("button", { name: "Normal" }).click()
  await expect(fit.getByText(/Respondiste «Normal»/)).toBeVisible()
  await drawer.getByRole("button", { name: "Aplicar todos" }).click()
  // La barra se va con «Aplicar todos»: el foco no cae al principio, vuelve a lo que vio la IA.
  await expect(results).toBeFocused()
  await name.fill("Zapatilla de lona negra")
  await drawer.getByLabel("Precio").fill("129")
  await drawer.getByLabel(/Tallas/).fill("38 a 40")

  await drawer.getByRole("button", { name: "Ver cómo queda" }).click()
  const preview = page.getByRole("dialog", { name: "Así quedaría en tu vitrina" })
  await expect(preview.getByText("Zapatilla de lona negra").first()).toBeVisible()
  await expect(preview.getByText(/S\/\s?129/).first()).toBeVisible()
  await shot(page, "ia-3-ver-como-queda-1440")
  await page.keyboard.press("Escape")

  await drawer.getByRole("button", { name: "Guardar y abrir la ficha" }).click()
  await expect(page).toHaveURL(/\/catalogo\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  productId = page.url().split("/").pop()!
  await expect(page.getByRole("heading", { name: "Zapatilla de lona negra" })).toBeVisible()
  const sheet = await json("GET", `${STORE}/productos/${productId}`)
  expect(sheet.product).toMatchObject({ name: "Zapatilla de lona negra", listPriceCents: 12900 })
  expect(sheet.product.photos).toHaveLength(2)
  // Lo usado y lo respondido, en la ficha; el color con su hex y sus fotos.
  expect(sheet.product).toMatchObject({
    category: "Zapatillas",
    rubro: "calzado",
    rubroData: { horma: "Normal", material: "Lona" },
  })
  expect(sheet.product.colors).toMatchObject([{ value: "negra", hex: "#1f1f1f" }])
  // Lo que Rosa respondió (cómo calza) queda a su nombre, no como «Propuesta de la IA».
  const { events } = await json("GET", `${STORE}/productos/${productId}/historial`)
  type Change = { field: string; from: { horma?: unknown } | null; to: { horma?: unknown } | null }
  const answered = (events as { changes: Change[]; reason: string | null }[]).find((e) =>
    e.changes.some(
      (c) => c.field === "rubroData" && c.to?.horma === "Normal" && c.from?.horma !== "Normal",
    ),
  )
  expect(answered).toMatchObject({ reason: null })
  expect(events.map((e: { action: string }) => e.action)).toContain("creado")
})

test("en la ficha, «Completar» vuelve a mirar y pregunta lo que falta", async ({ page }) => {
  await as("rosa")
  await json("PATCH", `${STORE}/productos/${productId}`, { rubroData: { horma: null } })
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo/${productId}`)
  await page.locator("#texto").getByRole("button", { name: "Completar" }).click()
  const question = page.getByRole("group", { name: "¿Cómo calza? No se ve en las fotos." })
  await expect(question).toBeVisible({ timeout: 30_000 })
  await shot(page, "ia-4-ficha-pregunta-1440")
  // Se responde en el campo de siempre; la pregunta se va sola.
  await page.locator("#dato-horma").getByRole("radio", { name: "Chico" }).click()
  await expect(question).toBeHidden({ timeout: 15_000 })
  await expect
    .poll(async () => (await json("GET", `${STORE}/productos/${productId}`)).product.rubroData, {
      timeout: 15_000,
    })
    .toMatchObject({ horma: "Chico" })
  // El nombre que vuelve a proponer se descarta: la ficha queda como está.
  const texto = page.locator("#texto")
  await texto.getByRole("button", { name: "Descartar" }).first().click()
  await expect(page.getByRole("heading", { name: "Zapatilla de lona negra" })).toBeVisible()

  // En oscuro y en el celular.
  await page.emulateMedia({ colorScheme: "dark" })
  await shot(page, "ia-5-ficha-oscuro-1440")
  await page.emulateMedia({ colorScheme: "light" })
  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Zapatilla de lona negra" })).toBeVisible()
  await shot(page, "ia-6-ficha-390")
})

test("«Cargar muchos»: «Juntar con IA» propone y Rosa confirma el grupo", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  const { load } = await json("POST", `${STORE}/cargas`)
  for (const name of ["blanca1", "blanca2", "botin1"]) {
    const bytes = readFileSync(resolve(PHOTOS, `${name}.jpg`))
    const { token } = (await (await fetch(`${ACCOUNT}/api/auth/token`)).json()) as {
      token: string
    }
    const sent = await fetch(`${API}${STORE}/cargas/${load.id}/fotos?archivo=${name}.jpg`, {
      method: "POST",
      headers: { origin: WEB, authorization: `Bearer ${token}`, "content-type": "image/jpeg" },
      body: bytes,
    })
    expect(sent.status).toBe(201)
  }
  await page.goto(`${BASE}/catalogo/cargar`)
  await page.getByRole("button", { name: "Juntar con IA" }).click()
  // Las dos blancas son el mismo producto; el botín va solo. Rosa confirma el grupo.
  const group = page
    .getByRole("group")
    .filter({ hasText: "Estas 2 fotos parecen del mismo producto" })
  await expect(group).toBeVisible({ timeout: 30_000 })
  await shot(page, "ia-7-cargar-muchos-1440")
  await group.getByRole("button", { name: "Juntar" }).click()
  await expect(group).toBeHidden()
  await expect
    .poll(async () => (await json("GET", `${STORE}/cargas/${load.id}`)).items.length)
    .toBe(2)
  // Sin fotos sueltas que juntar, lo dice y queda escrito, en neutro: no es un error que se va.
  await page.getByRole("button", { name: "Juntar con IA" }).click()
  const none = page.getByRole("status").filter({ hasText: "No hay fotos sueltas para juntar." })
  await expect(none).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(6_000)
  await expect(none).toBeVisible()
  await shot(page, "ia-8-juntar-sin-grupos-1440")
  await json("DELETE", `${STORE}/cargas/${load.id}`)
})

test("Ventas ve la ficha y no tiene propuestas para usar", async ({ page }) => {
  await as("lucia")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo/${productId}`)
  await expect(page.getByRole("heading", { name: "Zapatilla de lona negra" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Completar" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Aplicar todos" })).toHaveCount(0)
  await as("rosa")
})
