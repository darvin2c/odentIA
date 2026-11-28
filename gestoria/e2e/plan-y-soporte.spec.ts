import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { ACCOUNT, CLAVE, PEOPLE, STORE_ID, surface, type Who } from "./entorno"

/**
 * Lo nuevo de gestorIA en un navegador (ADR 0214), contra su servidor y su base de verdad:
 * - «Plan y pagos» del Dueño: subir el comprobante de un cobro sin pagar (un archivo que no es
 *   lo que dice se rechaza con su mensaje; una imagen válida queda «por enviar»).
 * - El aviso de soporte en cada sección: «Dejar entrar» abre la tienda a soporte, solo a mirar y
 *   solo con el código del personal (ADR 0219), con su franja; «Sacar ahora» la cierra, y soporte
 *   ve «El acceso terminó» con quién lo sacó, y la tienda, quién miró y cómo terminó.
 * - La conversación que Sofi no atendió (apagada) espera a una persona con su motivo: Inicio la
 *   cuenta para la Bandeja.
 * - El armazón común (lienzo «Una cuenta, todas las apps»): el selector de la tienda con el rol,
 *   «Ayuda» en la cabecera, el menú de la persona con Apariencia, y la entrada que recuerda a
 *   quien entró, con su correo entero y «Entrar con otra cuenta».
 * - La Ayuda, la misma de las clínicas (ADR 0227): Ariadna responde con la guía para el rol de
 *   quien pregunta y lleva a su pantalla si la abre; «Escribir a soporte de gestorIA» sale con la
 *   pantalla y el rol y queda en «Tus casos con soporte». En el teléfono, en el menú ⋯.
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
  // La Ayuda de la cabecera se abre al lado; escribir a soporte dice la pantalla y el rol.
  await page.getByRole("button", { name: "Ayuda", exact: true }).click()
  const help = surface(page, "Ayuda")
  await help.getByRole("button", { name: "Escribir a soporte de gestorIA" }).click()
  const asking = help.getByRole("region", { name: "Escribir a soporte de gestorIA" })
  await expect(asking.getByLabel("Tu mensaje para gestorIA")).toBeFocused()
  await expect(asking.getByText("Pantalla: Pedidos")).toBeVisible()
  await expect(asking.getByText("Tu rol: Dueño · Calzados Rosa")).toBeVisible()
  await help.getByRole("button", { name: "Cerrar", exact: true }).click()
  await expect(help).toHaveCount(0)
  await page.goto(`${BASE}/plan`)
  await expect(page.getByRole("heading", { name: "Plan y pagos" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Lo que se te cobró" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "plan-escritorio")

  // Con el teclado: el botón del cobro se enfoca y se abre con Enter.
  const upload = page.getByRole("button", { name: "Subir comprobante" })
  await upload.focus()
  await page.keyboard.press("Enter")
  const sheet = surface(page, "Subir comprobante")
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
  await expect(surface(page, "Subir comprobante")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "comprobante-hoja-telefono")
})

test("la tienda deja entrar a soporte, solo a mirar, y lo saca", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/catalogo`)
  // El pedido sale una sola vez, en la franja de arriba, y se responde en Equipo y repartidores.
  const strip = page.getByRole("region", { name: "Soporte de gestorIA" })
  await expect(strip.getByText("Ana de Soporte pide mirar tu tienda 30 minutos")).toBeVisible()
  await strip.getByRole("link", { name: "Revisar" }).click()
  await expect(page).toHaveURL(/\/configuracion\/equipo$/)
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
  // Soporte pregunta a la guía, pero no se escribe a sí mismo ni tiene casos.
  await page.getByRole("button", { name: "Ayuda", exact: true }).click()
  const help = surface(page, "Ayuda")
  await expect(help.getByText("Estás en Catálogo")).toBeVisible()
  await expect(help.getByRole("button", { name: /Escribir a soporte/ })).toHaveCount(0)
  await expect(help.getByRole("region", { name: "Tus casos con soporte" })).toHaveCount(0)
  await help.getByRole("button", { name: "Cerrar", exact: true }).click()
  await page.getByRole("button", { name: /^Calzados Rosa, Tienda, Soporte\./ }).click()
  await expect(page.getByRole("menuitem", { name: "Plan y pagos" })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "Crear otra tienda" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await noSideScroll(page)
  await shot(page, "soporte-mirando-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "soporte-mirando-telefono")
  // En Tu marca solo mira: no se le ofrece soltar ni pegar con Ctrl + V.
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/marca`)
  await expect(page.getByRole("heading", { name: "Tu marca" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Portada" })).toBeVisible()
  await expect(page.getByText(/Ctrl \+ V/)).toHaveCount(0)
  await expect(page.getByText(/Suelta/)).toHaveCount(0)
  await shot(page, "soporte-marca-escritorio")

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

/** Pregunta a Ariadna en el panel de la Ayuda y espera su respuesta. */
async function askHelp(help: Locator, question: string) {
  await help.getByLabel("Tu pregunta", { exact: true }).fill(question)
  await help.getByRole("button", { name: "Preguntar", exact: true }).click()
  const last = help
    .getByRole("list", { name: "Preguntas y respuestas" })
    .locator(":scope > li")
    .last()
  await expect(last).toContainText(question)
  await expect(last).toContainText("¿Te sirvió?")
  return last
}

test("la Ayuda responde con la guía para tu rol, y lo que escribes a soporte queda en tus casos", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/pedidos`)
  // En la cabecera, para todos; se abre al lado de la página y sabe dónde estás.
  await page.getByRole("button", { name: "Ayuda", exact: true }).click()
  const help = surface(page, "Ayuda")
  await expect(help.getByText("Estás en Pedidos")).toBeVisible()
  await expect(
    help.getByRole("region", { name: "En esta pantalla suelen preguntar" }),
  ).toBeVisible()
  // Ariadna responde con la guía: la respuesta, de dónde sale y su pantalla.
  const stock = await askHelp(help, "¿Cómo cambio el stock?")
  await expect(stock).toContainText("El stock solo cambia con un movimiento.")
  await expect(stock).toContainText("La guía de gestorIA: Catálogo.")
  await expect(stock.getByRole("link", { name: "Llévame a Catálogo" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "ayuda-escritorio")

  // Escribir a soporte: lo que se envía, con la pantalla y el rol, y queda en sus casos.
  await help.getByRole("button", { name: "Escribir a soporte de gestorIA" }).click()
  const asking = help.getByRole("region", { name: "Escribir a soporte de gestorIA" })
  await asking
    .getByLabel("Tu mensaje para gestorIA")
    .fill("No encuentro dónde cambiar el nombre de la tienda")
  await asking.getByRole("button", { name: "Enviar a gestorIA" }).click()
  await expect(help.getByText(/^Enviado\. Te respondemos aquí/)).toBeVisible()
  const mine = help.getByRole("region", { name: "Tus casos con soporte" })
  await expect(mine.getByText("No encuentro dónde cambiar el nombre de la tienda")).toBeVisible()
  await expect(mine.getByText("Por enviar")).toBeVisible()
  await shot(page, "ayuda-pregunta-escritorio")
  await help.getByRole("button", { name: "Cerrar", exact: true }).click()

  // En el teléfono, la Ayuda va en el menú ⋯ de la cabecera.
  await page.setViewportSize(PHONE)
  await page.goto(`${BASE}/pedidos`)
  await page.getByRole("button", { name: "Más opciones", exact: true }).click()
  await page.getByRole("menuitem", { name: "Ayuda", exact: true }).click()
  const sheet = page.getByRole("dialog", { name: "Ayuda" })
  await expect(sheet.getByText("Estás en Pedidos")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "ayuda-telefono")
})

test("a Ventas la Ayuda le dice lo que su rol no hace, y solo ve sus propios casos", async ({
  page,
}) => {
  await as("lucia")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/pedidos`)
  await page.getByRole("button", { name: "Ayuda", exact: true }).click()
  const help = surface(page, "Ayuda")
  const plan = await askHelp(help, "¿Dónde veo mi plan y lo que se me cobró?")
  await expect(plan).toContainText(
    "Con tu rol (Ventas) no se puede: pídeselo a quien sí puede. Lo puede hacer: Dueño.",
  )
  // No la lleva a una pantalla que su rol no abre.
  await expect(plan.getByRole("link", { name: /^Llévame/ })).toHaveCount(0)
  await noSideScroll(page)
  await shot(page, "ayuda-ventas-escritorio")
  // Lo que sí hace la lleva a su pantalla.
  const confirm = await askHelp(help, "¿Sofi confirma pagos?")
  await expect(confirm.getByRole("link", { name: "Llévame a Pedidos" })).toBeVisible()
  // Lo que escribió la Dueña no le llega.
  const mine = help.getByRole("region", { name: "Tus casos con soporte" })
  await expect(mine.getByText(/^Aún no tienes casos/)).toBeVisible()
  await expect(page.getByText("No encuentro dónde cambiar el nombre de la tienda")).toHaveCount(0)
})

test("la conversación que Sofi no atendió espera a una persona, con su motivo", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  // Inicio la cuenta para la Bandeja, que la dibujará con «Abrir Bandeja»: mientras no existe, no
  // se dibuja una línea sin su botón (tablero 5).
  const inicio = page.waitForResponse((r) => r.url().endsWith(`/api/tiendas/${STORE_ID}/inicio`))
  await page.goto(BASE)
  const home = (await (await inicio).json()) as {
    waiting: { chats: { customer: string | null; reason: string | null }[] }
  }
  expect(home.waiting.chats).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ customer: "Carla", reason: "Sofi está apagada" }),
    ]),
  )
  await expect(page.getByRole("heading", { name: "Te toca" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "inicio-escritorio")
  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Te toca" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "inicio-telefono")
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
  // La tienda abre en Inicio (tablero 5), con lo que le toca.
  await expect(page).toHaveURL(/\/tiendas\/[^/]+\/?$/)
  await expect(page.getByRole("heading", { name: "Te toca" })).toBeVisible()
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
