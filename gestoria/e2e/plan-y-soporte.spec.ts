import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, CLAVE, PEOPLE, STORE_ID, type Who } from "./entorno"

/**
 * Lo nuevo de gestorIA en un navegador (ADR 0214), contra su servidor y su base de verdad:
 * - «Plan y pagos» del Dueño: subir el comprobante de un cobro sin pagar (un archivo que no es
 *   lo que dice se rechaza con su mensaje; una imagen válida queda «por enviar»).
 * - El aviso de soporte en cada sección: «Dejar entrar» abre la tienda a soporte, solo a mirar,
 *   y «Sacar ahora» la cierra.
 * - La conversación que Sofi no atendió (apagada) espera a una persona con su motivo, en «Te toca».
 * - El armazón común (lienzo «Una cuenta, todas las apps»): el selector de la tienda con el rol,
 *   «Pedir ayuda» en la cabecera, el menú de la persona con Apariencia, y la entrada que recuerda
 *   a quien entró, con su correo entero y «Entrar con otra cuenta».
 * Cada pantalla en escritorio y a 390 px, sin desborde y con el botón principal por teclado. Las
 * capturas van a `gestoria/e2e/capturas/`.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1366, height: 860 }
const PHONE = { width: 390, height: 844 }
const BASE = `/tiendas/${STORE_ID}`

/** Un PNG de 1×1 de verdad. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
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
async function as(who: Who | "nadie") {
  const response = await fetch(`${ACCOUNT}/__como/${who}`, { method: "POST" })
  expect(response.ok).toBe(true)
}

test.describe.configure({ mode: "serial" })

test("el Dueño sube el comprobante de un cobro sin pagar", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/pedidos`)
  // El selector dice la tienda y el rol; «Plan y pagos» es una acción de la tienda.
  const switcher = page.getByRole("button", { name: /^Calzados Rosa, Tienda, Dueño\./ })
  await expect(switcher).toBeVisible()
  await switcher.click()
  await expect(page.getByRole("menuitem", { name: "Plan y pagos" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Crear otra tienda" })).toBeVisible()
  await page.keyboard.press("Escape")
  // «Pedir ayuda» de la cabecera lleva a la ayuda del soporte, con el foco en su primer campo.
  await page.getByRole("link", { name: "Pedir ayuda" }).click()
  await expect(page).toHaveURL(/\/plan#plan-ayuda$/)
  await expect(page.getByLabel("Sobre qué")).toBeFocused()
  await page.goto(`${BASE}/plan`)
  await expect(page.getByRole("heading", { name: "Plan y pagos" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Lo que se te cobró" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "plan-escritorio")

  // Con el teclado: el botón del cobro se enfoca y se abre con Enter.
  const upload = page.getByRole("button", { name: "Subir comprobante" })
  await upload.focus()
  await page.keyboard.press("Enter")
  const sheet = page.getByRole("dialog", { name: "Subir comprobante" })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText("Yapea al 999 000 000 y sube la captura.")).toBeVisible()
  // Dice ser un PDF y no lo es: el servidor mira el contenido.
  await sheet.locator('input[type="file"]').setInputFiles({
    name: "comprobante.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("<html><body>no soy un pdf</body></html>"),
  })
  await sheet.getByRole("button", { name: "Subir comprobante" }).click()
  await expect(sheet.getByText("Sube el comprobante en JPG, PNG, WebP o PDF").first()).toBeVisible()
  await shot(page, "comprobante-rechazado-escritorio")

  await sheet.locator('input[type="file"]').setInputFiles({
    name: "captura.png",
    mimeType: "image/png",
    buffer: PNG,
  })
  await sheet.getByRole("button", { name: "Subir comprobante" }).click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByText("Comprobante por enviar")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "comprobante-por-enviar-escritorio")

  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByText("Comprobante por enviar")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "plan-telefono")
  await page.getByRole("button", { name: "Subir comprobante" }).click()
  await expect(page.getByRole("dialog", { name: "Subir comprobante" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "comprobante-hoja-telefono")
})

test("la tienda deja entrar a soporte, solo a mirar, y lo saca", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo`)
  await expect(page.getByText("Ana de Soporte pide mirar tu tienda 30 minutos")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-por-aceptar-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "soporte-por-aceptar-telefono")

  const accept = page.getByRole("button", { name: "Dejar entrar" })
  await accept.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText(/Ana de Soporte puede mirar tu tienda hasta el/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Sacar ahora" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-adentro-telefono")
  await page.setViewportSize(DESKTOP)
  await shot(page, "soporte-adentro-escritorio")

  // Soporte entra con su cuenta y solo mira: sin pedidos, sin Sofi, sin el plan.
  await as("ana")
  await page.goto("/")
  // Con una sola tienda, «Tus tiendas» entra directo a ella; a soporte, por el catálogo.
  await expect(page.getByText(/Entraste como soporte de gestorIA, solo a mirar/)).toBeVisible()
  await expect(page).toHaveURL(/\/catalogo$/)
  const nav = page.getByRole("navigation", { name: "Principal" })
  await expect(nav.getByRole("link", { name: "Catálogo" })).toBeVisible()
  await expect(nav.getByRole("link", { name: "Pedidos" })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Pedir ayuda" })).toHaveCount(0)
  await page.getByRole("button", { name: /^Calzados Rosa, Tienda, Soporte\./ }).click()
  await expect(page.getByRole("menuitem", { name: "Plan y pagos" })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "Crear otra tienda" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await noSideScroll(page)
  await shot(page, "soporte-mirando-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "soporte-mirando-telefono")

  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/equipo`)
  await expect(page.getByText("Puede mirar", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Sacar ahora" }).click()
  await expect(page.getByText("Terminó", { exact: true })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-terminado-equipo-escritorio")
})

test("la conversación que Sofi no atendió espera a una persona, con su motivo", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/reportes`)
  await expect(page.getByText("Una conversación espera a una persona")).toBeVisible()
  await expect(page.getByText("Carla: Sofi está apagada")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "espera-a-una-persona-escritorio")
  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByText("Carla: Sofi está apagada")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "espera-a-una-persona-telefono")
})

test("la entrada recuerda a quien entró, con su correo entero, y deja entrar con otra", async ({
  page,
}) => {
  const rosa = PEOPLE.rosa
  await as("nadie")
  await page.setViewportSize(DESKTOP)
  await page.goto("/")
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole("heading", { name: "Entra a tu tienda" })).toBeVisible()
  await expect(page.getByText("Tu cuenta es la misma en todas tus apps.")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "entrada-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "entrada-telefono")

  // Con el teclado: el correo, la contraseña y Enter.
  await page.getByLabel("Correo").fill(rosa.email)
  await page.getByLabel("Contraseña", { exact: true }).fill(CLAVE)
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/tiendas\/.+\/pedidos$/)
  await expect(page.getByRole("heading", { name: "Pedidos" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "tienda-telefono")

  // En el teléfono el menú se abre desde la cabecera: el selector, las secciones y la persona.
  await page.getByRole("button", { name: "Alternar menú lateral" }).click()
  await expect(page.getByRole("button", { name: /^Calzados Rosa, Tienda, Dueño\./ })).toBeVisible()
  await shot(page, "menu-telefono")
  await page.keyboard.press("Escape")

  await page.setViewportSize(DESKTOP)
  // El menú de la persona: su nombre y su correo enteros, Apariencia y «Cerrar sesión».
  await page.getByRole("button", { name: `Menú de ${rosa.name}` }).click()
  await page.getByRole("tab", { name: "Tema oscuro" }).click()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await page.keyboard.press("Escape")
  await shot(page, "tienda-oscuro-escritorio")
  await page.getByRole("button", { name: `Menú de ${rosa.name}` }).click()
  await page.getByRole("tab", { name: "Tema claro" }).click()
  await page.getByRole("menuitem", { name: "Cerrar sesión" }).click()

  // De vuelta en la entrada: la recuerda con su correo entero y solo pide la contraseña.
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText(rosa.name, { exact: true })).toBeVisible()
  await expect(page.getByText(rosa.email, { exact: true })).toBeVisible()
  await expect(page.getByLabel("Correo")).toHaveCount(0)
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeFocused()
  await noSideScroll(page)
  await shot(page, "entrada-recuerda-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "entrada-recuerda-telefono")

  // «Entrar con otra cuenta» la olvida y vuelve a pedir el correo.
  await page.getByRole("button", { name: "Entrar con otra cuenta" }).click()
  await expect(page.getByLabel("Correo")).toHaveValue("")
  await expect(page.getByLabel("Correo")).toBeFocused()
  await page.reload()
  await expect(page.getByLabel("Correo")).toBeVisible()
  await expect(page.getByText(rosa.email, { exact: true })).toHaveCount(0)
})
