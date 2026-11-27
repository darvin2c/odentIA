import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, CLAVE, PEOPLE, STORE_ID, type Who } from "./entorno"

/**
 * Lo nuevo de gestorIA en un navegador (ADR 0214), contra su servidor y su base de verdad:
 * - «Plan y pagos» del Dueño: subir el comprobante de un cobro sin pagar (un archivo que no es
 *   lo que dice se rechaza con su mensaje; una imagen válida queda «por enviar»).
 * - El aviso de soporte en cada sección: «Dejar entrar» abre la tienda a soporte, solo a mirar y
 *   solo con el código del personal (ADR 0219), con su franja; «Sacar ahora» la cierra, y soporte
 *   ve «El acceso terminó» con quién lo sacó, y la tienda, quién miró y cómo terminó.
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

/** Si la sesión de soporte pasó el código del personal (llegó desde la administración). */
async function staffCode(on: boolean) {
  const response = await fetch(`${ACCOUNT}/__codigo/${on ? "si" : "no"}`, { method: "POST" })
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
  // La caja dice qué verá, desde cuándo corren los minutos y quién puede pedirlo.
  // (El mismo texto va plegado para el celular: se mira el que se ve en escritorio.)
  await expect(
    page
      .locator("span")
      .filter({ hasText: /tu equipo \(nombres, correos y roles\).*Los 30 minutos empiezan/ }),
  ).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-por-aceptar-escritorio")
  await page.setViewportSize(PHONE)
  // En el celular, el detalle se pliega en «Qué verá».
  await expect(page.getByText("Qué verá", { exact: true })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-por-aceptar-telefono")

  const accept = page.getByRole("button", { name: "Dejar entrar" })
  await accept.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByText(
      /Ana de Soporte puede mirar tu tienda hasta (el .* a )?las? .* · todavía no entró/,
    ),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Sacar ahora" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-adentro-telefono")
  await page.setViewportSize(DESKTOP)
  await shot(page, "soporte-adentro-escritorio")

  // Si entra directo con su contraseña, sin el código de la administración, no mira.
  await as("ana")
  await staffCode(false)
  await page.goto(`${BASE}/catalogo`)
  await expect(
    page.getByRole("heading", { name: "Para mirar esta tienda, ábrela desde la administración" }),
  ).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-sin-codigo-escritorio")

  // Desde la administración (con su código) mira, solo a mirar: sin pedidos, sin Sofi, sin el plan.
  await staffCode(true)
  await page.goto("/")
  // Con una sola tienda, «Tus tiendas» entra directo a ella; a soporte, por el catálogo.
  await expect(
    page.getByText(
      /Solo mirar · Estás viendo Calzados Rosa como soporte de gestorIA, hasta (el .* a )?las?/,
    ),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Salir" })).toBeVisible()
  await expect(page).toHaveURL(/\/catalogo$/)
  const nav = page.getByRole("navigation", { name: "Principal" })
  await expect(nav.getByRole("link", { name: "Catálogo" })).toBeVisible()
  await expect(nav.getByRole("link", { name: "Pedidos" })).toHaveCount(0)
  // Las clientas tampoco son suyas: sin Clientes en el menú, y su dirección lleva al catálogo.
  await expect(nav.getByRole("link", { name: "Clientes" })).toHaveCount(0)
  await page.goto(`${BASE}/clientes`)
  await expect(page).toHaveURL(/\/catalogo$/)
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
  // Ya entró: la tienda ve desde cuándo mira y quién la dejó entrar.
  await expect(page.getByText("Mirando", { exact: true })).toBeVisible()
  await expect(page.getByText(/Ana de Soporte está mirando tu tienda desde las? /)).toBeVisible()
  await expect(page.getByText(/Lo aceptaste tú\./)).toBeVisible()
  await page.getByRole("button", { name: "Sacar ahora" }).click()
  await expect(
    page.getByText(/Ana de Soporte miró tu tienda el .* · terminaste el acceso a las? /),
  ).toBeVisible()
  await noSideScroll(page)
  await shot(page, "soporte-terminado-equipo-escritorio")

  // Soporte lo sabe con su motivo, nunca «te quitaron del equipo».
  await as("ana")
  await page.goto(`${BASE}/catalogo`)
  await expect(page.getByRole("heading", { name: "El acceso terminó" })).toBeVisible()
  await expect(page.getByText(/: Rosa Quispe terminó tu acceso\./)).toBeVisible()
  await expect(page.getByText("Puede que te hayan quitado del equipo.")).toHaveCount(0)
  await noSideScroll(page)
  await shot(page, "soporte-acceso-termino-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "soporte-acceso-termino-telefono")
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
