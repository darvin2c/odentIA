import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, choose, STORE_ID, surface, type Who } from "./entorno"

/**
 * Cobros en un navegador (lienzo «gestorIA · Configuración, de nuevo», tablero 6), contra su
 * servidor y su base de verdad y un Mercado Pago de mentira (`mercadopago-de-prueba.ts`):
 * - Rosa agrega su Yape con su celular, su titular y su QR, y ve cómo le llega a la clienta.
 * - Agrega su transferencia del BCP: un CCI con un número equivocado se dice en su campo; con sus
 *   dígitos de control, se guarda.
 * - Conecta Mercado Pago entrando a su cuenta (sin copiar llaves) y queda en modo prueba; paga el
 *   link de S/ 1 con la tarjeta de prueba y lo ve pagado solo, sin que nadie confirme.
 * - Pasa a «Cobrar de verdad» y, al desconectar, un cajón le dice qué pasa antes.
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
  await expect(
    yape.getByText(/Puedes yapear S\/ 141 al 987 654 321 \(Rosa Quispe M\.\) o escanear este QR/),
  ).toBeVisible()
  await shot(page, "cobros-yape-1440")
  await yape.getByRole("button", { name: "Guardar" }).click()
  await expect(yape).toBeHidden()
  const rows = page.getByRole("list").filter({ hasText: "Yape" })
  await expect(rows.getByText("987 654 321 · Rosa Quispe M. · con tu QR")).toBeVisible()
  await expect(rows.getByText("Tú o Ventas, con la captura")).toBeVisible()

  await page.getByRole("button", { name: "Agregar otra forma de cobro" }).click()
  const transfer = surface(page, "Agregar forma de cobro")
  await transfer.getByRole("radio", { name: "Transferencia" }).click()
  await choose(transfer.getByLabel("Banco"), /BCP/)
  await transfer.getByLabel("Número de cuenta").fill("191-2345678-0-12")
  await transfer.getByLabel("CCI (opcional)").fill("002 191 002345678012 55")
  await expect(transfer.getByText(/no coincide con sus dígitos de control/)).toBeVisible()
  await transfer.getByLabel("A nombre de").fill("Rosa Quispe Mamani")
  await transfer.getByRole("button", { name: "Guardar" }).click()
  await expect(transfer).toBeVisible()
  await transfer.getByLabel("CCI (opcional)").fill("002 191 002345678012 53")
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
  await expect(page.getByText(/Por cada S\/ 100 recibes S\/ 94,70 al instante/)).toBeVisible()

  // El link de S/ 1 se abre aparte; se paga con la tarjeta de prueba y queda pagado solo.
  const popup = page.waitForEvent("popup")
  await page.getByRole("button", { name: "Probar con S/ 1" }).click()
  const pay = await popup
  await pay.getByRole("button", { name: "Pagar con la tarjeta de prueba" }).click()
  await expect(pay.getByText("¡Listo!")).toBeVisible()
  await pay.close()
  await expect(page.getByText(/^Pagado solo · /)).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByText(/Mercado Pago nos avisó y le preguntamos si entró: entró S\/ 1/),
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
