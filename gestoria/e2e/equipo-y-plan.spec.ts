import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, STORE_ID, surface, type Who } from "./entorno"

/**
 * Equipo y repartidores, Plan y pagos y la tarjeta de los avisos (lienzo «gestorIA ·
 * Configuración, de nuevo», tableros 9, 10 y 11), contra su servidor y su base de verdad:
 * - Invitar al equipo con nombre, celular, correo y rol; «Enviar por WhatsApp» abre el WhatsApp con
 *   el mensaje y la lista dice «Enviada por ti por WhatsApp», nunca que llegó.
 * - Agregar a un repartidor con lo que se le paga por entrega; cambiar su pago y sacarlo.
 * - Plan y pagos dice primero lo que se debe y cuándo vence; después el saldo y el tope y, sin
 *   movimientos en el acuerdo, qué se verá; sin formulario de ayuda en la página.
 * - La tarjeta para instalar la app va en Inicio, no en Pedidos.
 * Cada pantalla en escritorio y a 390 px, sin desborde. Las capturas van a `gestoria/e2e/capturas/`
 * (o a `CAPTURAS`).
 */

const SHOTS = process.env.CAPTURAS ?? resolve("capturas")
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const BASE = `/tiendas/${STORE_ID}`

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

test.describe.configure({ mode: "serial" })

test("Rosa invita a Carla por WhatsApp y queda «enviada por ti»", async ({ page, context }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  // El WhatsApp no se abre de verdad: se mira a dónde iba.
  await context.route("https://wa.me/**", (route) => route.fulfill({ body: "WhatsApp" }))
  await page.goto(`${BASE}/configuracion/equipo`)
  await expect(page.getByRole("heading", { name: "Equipo y repartidores" })).toBeVisible()
  await expect(page.getByText("Todo, también el plan y los pagos a gestorIA.")).toBeVisible()
  await shot(page, "equipo-escritorio")

  await page.getByRole("button", { name: "Invitar", exact: true }).click()
  const form = surface(page, "Invitar al equipo")
  await form.getByLabel("Nombre").fill("Carla Vega")
  await form.getByLabel("Celular").fill("912345678")
  await form.getByLabel("Correo con el que entrará").fill("carla.vega@gmail.test")
  await form.getByRole("radio", { name: "Administrador" }).click()
  await expect(form.getByText("Todo menos el plan. No toca al Dueño.")).toBeVisible()
  await shot(page, "equipo-invitar-escritorio")
  await form.getByRole("button", { name: "Crear la invitación" }).click()

  const share = surface(page, "Envía la invitación a Carla")
  await expect(share.getByText(/^Hola Carla, te invito a atender Calzados Rosa/)).toBeVisible()
  const whatsapp = share.getByRole("link", { name: "Enviar por WhatsApp" })
  await expect(whatsapp).toHaveAttribute(
    "href",
    /^https:\/\/wa\.me\/51912345678\?text=Hola%20Carla/,
  )
  await shot(page, "equipo-enviar-escritorio")
  const popup = context.waitForEvent("page")
  await whatsapp.click()
  await (await popup).close()
  await expect(share.getByText(/Queda como enviada por ti/)).toBeVisible()
  await share.getByRole("button", { name: "Listo" }).click()

  const row = page.getByRole("listitem").filter({ hasText: "Carla Vega" })
  await expect(row).toContainText("Administrador · Enviada por ti por WhatsApp")
  await expect(row.getByRole("button", { name: "Reenviar" })).toBeVisible()
  await noSideScroll(page)
})

test("Rosa corrige el correo de una invitación sin escribir todo de nuevo, y anular pide confirmar", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/equipo`)
  await page.getByRole("button", { name: "Invitar", exact: true }).click()
  const form = surface(page, "Invitar al equipo")
  await form.getByLabel("Nombre").fill("Ana Torres")
  await form.getByLabel("Celular").fill("912000111")
  await form.getByLabel("Correo con el que entrará").fill("ana.tores@gmail.test")
  await form.getByRole("button", { name: "Crear la invitación" }).click()
  await surface(page, "Envía la invitación a Ana").getByRole("button", { name: "Listo" }).click()

  // «Corregir» abre el cajón con lo que ya tenía: solo se cambia el correo.
  await page.getByRole("button", { name: "Corregir la invitación de Ana Torres" }).click()
  const fix = surface(page, "Corregir la invitación")
  await expect(fix.getByLabel("Nombre")).toHaveValue("Ana Torres")
  await expect(fix.getByLabel("Correo con el que entrará")).toHaveValue("ana.tores@gmail.test")
  await shot(page, "equipo-corregir-escritorio")
  await fix.getByLabel("Correo con el que entrará").fill("ana.torres@gmail.test")
  await fix.getByRole("button", { name: "Crear la invitación" }).click()
  const share = surface(page, "Envía la invitación a Ana")
  await expect(share.getByText(/ana\.torres@gmail\.test/).first()).toBeVisible()
  await share.getByRole("button", { name: "Listo" }).click()
  // Queda una sola, la nueva.
  await expect(page.getByRole("listitem").filter({ hasText: "Ana Torres" })).toHaveCount(1)

  // «Anular» pregunta antes; «Cancelar» la deja como estaba.
  await page.getByRole("button", { name: "Anular la invitación de Ana Torres" }).click()
  const confirm = page.getByRole("alertdialog")
  await expect(confirm).toContainText("¿Anular la invitación de Ana Torres?")
  await shot(page, "equipo-anular-escritorio")
  await confirm.getByRole("button", { name: "Cancelar" }).click()
  await expect(page.getByRole("listitem").filter({ hasText: "Ana Torres" })).toHaveCount(1)
  await page.getByRole("button", { name: "Anular la invitación de Ana Torres" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Anular la invitación" }).click()
  await expect(page.getByRole("listitem").filter({ hasText: "Ana Torres" })).toHaveCount(0)
})

test("Rosa suma a Kevin con su pago por entrega, lo cambia y lo saca", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/equipo`)
  const couriers = page.getByRole("region", { name: "Repartidores" })
  await couriers.getByRole("button", { name: "Agregar repartidor" }).click()
  const form = surface(page, "Agregar repartidor")
  await form.getByLabel("Nombre").fill("Kevin Ramos")
  await form.getByLabel("Celular").fill("955101202")
  await form.getByLabel("Le pagas por entrega").fill("8")
  await form.getByRole("radio", { name: "No se le paga" }).click()
  await shot(page, "repartidor-invitar-escritorio")
  await form.getByRole("button", { name: "Agregar repartidor" }).click()

  const done = surface(page, "Kevin Ramos ya reparte para tu tienda")
  await expect(done.getByText(/Te pago S\/\s8 por entrega/)).toBeVisible()
  await done.getByRole("button", { name: "Listo" }).click()
  const kevin = couriers.getByRole("listitem").filter({ hasText: "Kevin Ramos" })
  await expect(kevin).toContainText("el viaje fallido no se paga")
  await shot(page, "equipo-con-repartidor-escritorio")

  await kevin.getByRole("button", { name: "Cambiar a Kevin Ramos" }).click()
  const edit = surface(page, "Kevin Ramos")
  await edit.getByLabel("Le pagas por entrega").fill("9.50")
  await edit.getByRole("button", { name: "Guardar" }).click()
  await expect(kevin).toContainText(/S\/\s9\.50 por entrega/)

  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "equipo-telefono")

  await kevin.getByRole("button", { name: "Cambiar a Kevin Ramos" }).click()
  await surface(page, "Kevin Ramos").getByRole("button", { name: "Sacar" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Sacar" }).click()
  await expect(couriers.getByRole("listitem").filter({ hasText: "Kevin Ramos" })).toHaveCount(0)
})

test("Plan y pagos: primero lo que se debe, después el saldo y el tope, y qué se verá de cada venta", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/plan`)
  // Lo primero es lo que se debe, con su vencimiento; el precio del plan no es la cifra del mes.
  const owed = page.getByRole("heading", { name: /^Por pagar USD/ })
  await expect(owed).toBeVisible()
  await expect(page.getByText(/^Vence el /)).toBeVisible()
  await expect(page.getByRole("heading", { name: /^Pagas / })).toHaveCount(0)
  const balance = page.getByRole("heading", { name: "Plan Tienda" })
  const [owedBox, balanceBox] = [await owed.boundingBox(), await balance.boundingBox()]
  expect(owedBox && balanceBox && owedBox.y < balanceBox.y, "lo que se debe va primero").toBe(true)
  await expect(page.getByText(/^Usaste .* de tu saldo de /)).toBeVisible()
  // Con la administración conectada está el botón, y solo entonces la página lo nombra.
  await expect(page.getByRole("button", { name: "Subir comprobante" })).toBeVisible()
  await expect(page.getByText("Y subes el comprobante arriba, en «Por pagar».")).toBeVisible()
  await expect(page.getByText("Aquí verás cada venta de tu cobro", { exact: true })).toBeVisible()
  // Se pregunta desde la Ayuda de arriba: la página no lleva su propio formulario. «Pedir otro
  // tope» abre la Ayuda con el mensaje a soporte ya escrito; no se envía solo.
  await expect(page.getByLabel("Tu pregunta")).toHaveCount(0)
  await page.getByRole("button", { name: /^Pedir (otro|un) tope$/ }).click()
  const help = surface(page, "Ayuda")
  const asking = help.getByRole("region", { name: "Escribir a soporte de gestorIA" })
  const message = asking.getByLabel("Tu mensaje para gestorIA")
  await expect(message).toHaveValue(/^Quiero (cambiar|poner) (mi|un) tope del mes/)
  await shot(page, "plan-pedir-tope-escritorio")
  await message.fill("")
  await help.getByRole("button", { name: "Cerrar", exact: true }).click()
  await expect(help).toHaveCount(0)
  await noSideScroll(page)
  await shot(page, "plan-escritorio")
  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByRole("heading", { name: /^Por pagar USD/ })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "plan-telefono")
  // En el teléfono, lo mismo: la Ayuda se abre encima, con el mensaje ya escrito.
  await page.getByRole("button", { name: /^Pedir (otro|un) tope$/ }).click()
  const phoneMessage = surface(page, "Ayuda").getByLabel("Tu mensaje para gestorIA")
  await expect(phoneMessage).toHaveValue(/^Quiero (cambiar|poner) (mi|un) tope del mes/)
  await noSideScroll(page)
  await shot(page, "plan-pedir-tope-telefono")
})
