import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, choose, MP_PORT, STORE_ID, surface, type Who } from "./entorno"
import { KEYS_REAL, KEYS_TEST, PAY_ORIGIN } from "./mercadopago-de-prueba"

/**
 * Cobros en un navegador (lienzo «gestorIA · Configuración, de nuevo», tablero 6), contra su
 * servidor y su base de verdad y un Mercado Pago de mentira (`mercadopago-de-prueba.ts`):
 * - Rosa agrega su Yape con su celular, su titular y su QR, y ve cómo le llega a la clienta.
 * - Agrega su transferencia del BCP: un CCI con un número equivocado se dice en su campo; con sus
 *   dígitos de control, se guarda.
 * - Conecta Mercado Pago entrando a su cuenta (sin copiar llaves) y queda en modo prueba; paga el
 *   link de S/ 1 con la tarjeta de prueba y lo ve pagado solo, sin que nadie confirme.
 * - Pasa a «Cobrar de verdad» y, al desconectar, un cajón le dice qué pasa antes.
 * - Sin la aplicación de gestorIA en Mercado Pago, conecta con sus propias claves: pega la Public
 *   Key por error y se le dice en el campo; «Probar» le dice de qué cuenta es; empieza en prueba y
 *   «Cobrar de verdad» no acepta el de prueba. Con la aplicación, las claves son la otra puerta.
 * Cada pantalla en escritorio y a 390 px, sin desborde. Las capturas van a `gestoria/e2e/capturas/`
 * (o a `CAPTURAS`).
 */

const SHOTS = resolve(process.env.CAPTURAS ?? "capturas")
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const COBROS = `/tiendas/${STORE_ID}/configuracion/medios-de-pago`

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

async function as(who: Who) {
  const response = await fetch(`${ACCOUNT}/__como/${who}`, { method: "POST" })
  expect(response.ok).toBe(true)
}

/** Un QR de mentira: un PNG de 1 × 1. */
const QR = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

test.describe.configure({ mode: "serial" })

test("Yape con su QR y la transferencia con su CCI revisado", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(COBROS)
  await expect(page.getByRole("heading", { name: "Cobros", level: 1 })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Con link: «Pagar ahora»" })).toBeVisible()
  await expect(page.getByText("Lo confirma la pasarela, sola")).toBeVisible()
  await expect(page.getByText("Los confirma una persona")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Quién confirma cada pago" })).toBeVisible()
  await shot(page, "cobros-vacio-1440")

  await page.getByRole("button", { name: "Agregar otra forma de cobro" }).click()
  const yape = surface(page, "Agregar forma de cobro")
  await expect(yape.getByRole("radio", { name: "Yape" })).toBeChecked()
  await yape.getByLabel("Celular").fill("987654321")
  await yape.getByLabel("A nombre de").fill("Rosa Quispe M.")
  await yape.locator('input[type="file"]').setInputFiles({
    name: "qr-yape-rosa.png",
    mimeType: "image/png",
    buffer: QR,
  })
  await expect(yape.getByRole("img", { name: "Tu QR" })).toBeVisible()
  // El QR se guarda, pero la vista previa no lo promete: hoy ningún canal manda la imagen.
  await expect(
    yape.getByText(
      /Puedes yapear S\/\s141 al 987 654 321 \(Rosa Quispe M\.\)\. Mándame la captura/,
    ),
  ).toBeVisible()
  await expect(yape.getByText(/escanear/)).toHaveCount(0)
  await expect(
    yape.getByText(
      "Tu QR queda guardado: Sofi lo enviará cuando el chat por WhatsApp esté conectado.",
    ),
  ).toBeVisible()
  await shot(page, "cobros-yape-1440")
  await yape.getByRole("button", { name: "Guardar" }).click()
  await expect(yape).toBeHidden()
  // Los otros recorridos dejan sus propios medios en la tienda: se mira la fila de este Yape.
  const row = page
    .getByRole("listitem")
    .filter({ hasText: "987 654 321 · Rosa Quispe M. · con tu QR" })
  await expect(row).toHaveCount(1)
  await expect(row.getByText("Tú o Ventas, con la captura")).toBeVisible()

  await page.getByRole("button", { name: "Agregar otra forma de cobro" }).click()
  const transfer = surface(page, "Agregar forma de cobro")
  await transfer.getByRole("radio", { name: "Transferencia" }).click()
  await choose(transfer.getByLabel("Banco"), /BCP/)
  await transfer.getByLabel("Número de cuenta").fill("191-2345678-0-12")
  // Un CCI con un número mal: error del campo al completarlo, sin esperar a guardar.
  const cci = transfer.getByLabel("CCI (opcional)")
  await cci.fill("002 191 002345678012 55")
  await expect(transfer.getByText(/no coincide con sus dígitos de control/)).toBeVisible()
  await expect(cci).toHaveAttribute("aria-invalid", "true")
  await transfer.getByLabel("A nombre de").fill("Rosa Quispe Mamani")
  await transfer.getByRole("button", { name: "Guardar" }).click()
  await expect(transfer).toBeVisible()
  // Un CCI de Interbank (con sus dígitos bien) en una cuenta del BCP: también se dice al escribirlo.
  await cci.fill("003 200 003012345678 39")
  await expect(
    transfer.getByText("Ese CCI es de Interbank, no de BCP: revisa el banco o el CCI."),
  ).toBeVisible()
  await expect(cci).toHaveAttribute("aria-invalid", "true")
  await expect(transfer.getByText("20 números, con sus dígitos de control revisados.")).toHaveCount(
    0,
  )
  await shot(page, "cobros-cci-otro-banco-1440")
  await cci.fill("002 191 002345678012 53")
  await expect(cci).not.toHaveAttribute("aria-invalid", "true")
  await expect(
    transfer.getByText("20 números, con sus dígitos de control revisados."),
  ).toBeVisible()
  await shot(page, "cobros-transferencia-1440")
  await transfer.getByRole("button", { name: "Guardar" }).click()
  await expect(transfer).toBeHidden()
  await expect(page.getByText("Transferencia BCP")).toBeVisible()
  await expect(
    page.getByText(/cuenta 191-2345678-0-12 · CCI 002 191 002345678012 53/),
  ).toBeVisible()
  await noSideScroll(page)
})

test("Mercado Pago entrando a la cuenta: modo prueba con S/ 1, cobrar de verdad y desconectar", async ({
  page,
}) => {
  await as("rosa")
  // El link de Mercado Pago (https) se abre en el Mercado Pago de mentira.
  await page.context().route(`${PAY_ORIGIN}/**`, async (route) => {
    const url = route.request().url().replace(PAY_ORIGIN, `http://127.0.0.1:${MP_PORT}`)
    await route.fulfill({ response: await route.fetch({ url }) })
  })
  await page.setViewportSize(DESKTOP)
  await page.goto(COBROS)
  await page.getByRole("button", { name: "Conectar con Mercado Pago" }).click()
  // La página de Mercado Pago (de mentira): Rosa da el permiso y vuelve a gestorIA.
  await expect(
    page.getByRole("heading", { name: "gestorIA quiere cobrar en tu nombre" }),
  ).toBeVisible()
  await page.getByRole("link", { name: "Permitir" }).click()
  await expect(page).toHaveURL(/\/configuracion\/medios-de-pago\?mp=prueba$/)
  await expect(page.getByText("Modo prueba", { exact: true })).toBeVisible()
  await expect(page.getByText(/Cuenta rosa\.quispe@… · Yape y tarjeta en el link/)).toBeVisible()
  await expect(page.getByText(/Por cada S\/\s100 recibes S\/\s94[.,]70 al instante/)).toBeVisible()

  // El link de S/ 1 se abre aparte; se paga con la tarjeta de prueba y queda pagado solo.
  await page.getByRole("button", { name: /Probar con S\/\s1/ }).click()
  // Cierra el link sin pagar y recarga: el link sigue esperando el pago, a la vista.
  const unpaid = page.waitForEvent("popup")
  await page.getByRole("link", { name: "Abrir el link de prueba" }).click()
  await (await unpaid).close()
  await page.reload()
  await expect(page.getByText("Esperando el pago", { exact: true })).toBeVisible()
  const popup = page.waitForEvent("popup")
  await page.getByRole("link", { name: "Abrir el link de prueba" }).click()
  const pay = await popup
  await pay.getByRole("button", { name: "Pagar con la tarjeta de prueba" }).click()
  await expect(pay.getByText("¡Listo!")).toBeVisible()
  await pay.close()
  await expect(page.getByText(/^Pagado solo · /)).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByText(/Mercado Pago nos avisó y le preguntamos si entró: entró S\/\s1/),
  ).toBeVisible()
  await shot(page, "cobros-prueba-1440")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "cobros-prueba-390")
  await page.setViewportSize(DESKTOP)

  await page.getByRole("button", { name: "Cobrar de verdad" }).click()
  await page.getByRole("link", { name: "Permitir" }).click()
  await expect(page).toHaveURL(/\?mp=real$/)
  await expect(page.getByText("Cobrando de verdad")).toBeVisible()
  await expect(page.getByText(/Sofi ofrece el link primero/)).toBeVisible()
  await shot(page, "cobros-real-1440")

  await page.getByRole("button", { name: "Desconectar Mercado Pago" }).click()
  const confirm = surface(page, "Desconectar Mercado Pago")
  await expect(confirm.getByText("No hay links enviados esperando pago.")).toBeVisible()
  await shot(page, "cobros-desconectar-1440")
  await confirm.getByRole("button", { name: "Desconectar" }).click()
  await expect(page.getByRole("button", { name: "Conectar con Mercado Pago" })).toBeVisible()
})

test("en el teléfono, Cobros y su formulario caben sin desborde", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(PHONE)
  await page.goto(COBROS)
  await expect(page.getByText("987 654 321 · Rosa Quispe M. · con tu QR")).toBeVisible()
  await noSideScroll(page)
  await shot(page, "cobros-390")
  await page.getByRole("button", { name: /^Yape.{0,2}987 654 321/ }).click()
  const form = surface(page, "Yape")
  await expect(form.getByLabel("A nombre de")).toHaveValue("Rosa Quispe M.")
  await expect(form.getByRole("img", { name: "Tu QR" })).toBeVisible()
  await shot(page, "cobros-yape-390")
})

test("Mercado Pago con tus claves: sin la aplicación de gestorIA, probar, prueba y cobrar de verdad", async ({
  page,
}) => {
  await as("rosa")
  // Producción hoy: gestorIA no tiene su aplicación en Mercado Pago. El servidor del recorrido sí
  // la tiene; la respuesta se cambia solo en eso (que el servidor no la ofrezca lo prueba la API).
  await page.route(/\/api\/tiendas\/[^/]+\/link-de-pago$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: { ...body, accountDoor: false } })
  })
  await page.setViewportSize(DESKTOP)
  await page.goto(COBROS)
  await expect(page.getByRole("button", { name: "Conectar con mis claves" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Conectar con Mercado Pago" })).toHaveCount(0)
  await expect(page.getByText(/te guiamos paso a paso/)).toBeVisible()
  await expect(page.getByText(/aplicación de gestorIA/)).toHaveCount(0)
  await shot(page, "mp-claves-tarjeta-sin-aplicacion-1440")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "mp-claves-tarjeta-sin-aplicacion-390")
  await page.setViewportSize(DESKTOP)

  await page.getByRole("button", { name: "Conectar con mis claves" }).click()
  const form = surface(page, "Conectar con tus claves")
  await expect(form.getByText("«Tus integraciones»", { exact: false })).toBeVisible()
  await expect(form.getByRole("link", { name: "Abrir mi panel" })).toHaveAttribute(
    "href",
    "https://www.mercadopago.com.pe/developers/panel/app",
  )
  await shot(page, "mp-claves-formulario-vacio-1440")
  // Pegó la Public Key: se dice en su campo, sin guardar nada.
  const token = form.getByLabel("Access Token de prueba")
  await token.fill("APP_USR-9f8e7d6c-1a2b-4c3d-8e9f-0a1b2c3d4e5f")
  await form.getByRole("button", { name: "Probar" }).click()
  await expect(form.getByText(/Esa es la «Public Key»/)).toBeVisible()
  await expect(token).toHaveAttribute("aria-invalid", "true")
  await shot(page, "mp-claves-formulario-error-1440")
  await token.fill(KEYS_TEST)
  await form.getByRole("button", { name: "Probar" }).click()
  await expect(form.getByText("Sirve: es la cuenta test_user_4512@…")).toBeVisible()
  await expect(token).not.toHaveAttribute("aria-invalid", "true")
  await shot(page, "mp-claves-formulario-probado-1440")
  await form.getByRole("button", { name: "Conectar en modo prueba" }).click()
  await expect(form).toBeHidden()
  await expect(page.getByText("Modo prueba", { exact: true })).toBeVisible()
  await expect(page.getByText(/Conectada con tus claves · Cuenta test_user_4512@…/)).toBeVisible()
  await expect(page.getByRole("button", { name: /Probar con S\/\s1/ })).toBeVisible()
  await shot(page, "mp-claves-conectada-prueba-1440")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "mp-claves-conectada-prueba-390")
  await page.setViewportSize(DESKTOP)

  // «Cobrar de verdad» pide el Access Token de producción: el de prueba no pasa.
  await page.getByRole("button", { name: "Cobrar de verdad" }).click()
  const real = surface(page, "Cobrar de verdad con tus claves")
  await expect(real.getByText(/elige «Producción»/)).toBeVisible()
  const production = real.getByLabel("Access Token de producción")
  await production.fill(KEYS_TEST)
  await real.getByRole("button", { name: "Cobrar de verdad" }).click()
  await expect(real.getByText(/Ese es de una cuenta de prueba/)).toBeVisible()
  await production.fill(KEYS_REAL)
  await real.getByRole("button", { name: "Cobrar de verdad" }).click()
  await expect(real).toBeHidden()
  await expect(page.getByText("Cobrando de verdad")).toBeVisible()
  await expect(page.getByText(/Conectada con tus claves · Cuenta rosa\.quispe@…/)).toBeVisible()
  await expect(page.getByText(/Sofi ofrece el link primero/)).toBeVisible()
  await shot(page, "mp-claves-conectada-real-1440")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "mp-claves-conectada-real-390")
  await page.setViewportSize(DESKTOP)

  await page.getByRole("button", { name: "Desconectar Mercado Pago" }).click()
  await surface(page, "Desconectar Mercado Pago")
    .getByRole("button", { name: "Desconectar" })
    .click()
  await expect(page.getByRole("button", { name: "Conectar con mis claves" })).toBeVisible()

  // Con la aplicación de gestorIA: el botón de siempre y, debajo, la otra puerta.
  await page.unrouteAll({ behavior: "wait" })
  await page.reload()
  await expect(page.getByRole("button", { name: "Conectar con Mercado Pago" })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "¿Prefieres usar tus propias claves?" }),
  ).toBeVisible()
  await shot(page, "mp-claves-tarjeta-con-aplicacion-1440")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "mp-claves-tarjeta-con-aplicacion-390")
  await page.getByRole("button", { name: "¿Prefieres usar tus propias claves?" }).click()
  const phone = surface(page, "Conectar con tus claves")
  await expect(phone).toBeVisible()
  await shot(page, "mp-claves-formulario-vacio-390")
  await phone.getByLabel("Access Token de prueba").fill(KEYS_TEST)
  await phone.getByRole("button", { name: "Probar" }).click()
  await expect(phone.getByText("Sirve: es la cuenta test_user_4512@…")).toBeVisible()
  await shot(page, "mp-claves-formulario-probado-390")
})
