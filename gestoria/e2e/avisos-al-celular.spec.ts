import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { type BrowserContext, expect, type Page, test } from "@playwright/test"
import { ACCOUNT, STORE_ID, type Who } from "./entorno"

/**
 * Los avisos al celular en un navegador (lienzo «gestorIA como odentIA», tablero 15), contra su
 * servidor y su base de verdad:
 * - En Inicio, la tarjeta «Recibe los avisos en este celular», con «Ahora no» que se recuerda.
 * - Configuración › Avisos al celular: Ventas elige entre lo que su rol resuelve (sin «Lo de
 *   dinero»), con el teclado, y lo elegido queda guardado; el Dueño ve además «Lo de dinero».
 * - «Activar en este celular» y «Apagar en este celular» llegan al servidor.
 *
 * El servicio de push del navegador es de mentira (`PushManager` reemplazado antes de cargar):
 * Chromium sin pantalla no se suscribe de verdad. Esto prueba la pantalla y el servidor, no que un
 * aviso llegue a un celular. Cada pantalla en escritorio y a 390 px, sin desborde.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1366, height: 860 }
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

/**
 * El permiso y una suscripción de mentira, guardados en la pestaña como los del navegador (como
 * en `e2e/app-instalable.spec.ts` de las clínicas): Chromium sin pantalla dice «denied» siempre.
 */
async function fakePush(context: BrowserContext, who: Who) {
  await context.addInitScript((name) => {
    const KEY = "e2e:suscripcion"
    const PERMISSION = "e2e:permiso"
    Object.defineProperty(Notification, "permission", {
      get: () => (sessionStorage.getItem(PERMISSION) ?? "default") as NotificationPermission,
    })
    Notification.requestPermission = async () => {
      sessionStorage.setItem(PERMISSION, "granted")
      return "granted"
    }
    const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${name}`
    const make = () => ({
      endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint, keys: { p256dh: `B${"r".repeat(86)}`, auth: "s".repeat(22) } }),
      unsubscribe: async () => {
        sessionStorage.removeItem(KEY)
        return true
      },
    })
    const proto = PushManager.prototype as unknown as Record<string, unknown>
    proto.getSubscription = async () => (sessionStorage.getItem(KEY) ? make() : null)
    proto.subscribe = async () => {
      sessionStorage.setItem(KEY, "1")
      return make()
    }
  }, who)
}

test.describe.configure({ mode: "serial" })

test("en Inicio, la tarjeta para recibir los avisos; «Ahora no» se recuerda", async ({
  page,
  context,
}) => {
  await as("lucia")
  await fakePush(context, "lucia")
  await page.setViewportSize(DESKTOP)
  await page.goto(BASE)
  const card = page.getByRole("region", { name: "Recibe los avisos en este celular" })
  await expect(card).toBeVisible()
  await expect(
    card.getByRole("button", { name: /Instalar gestorIA|Activar los avisos/ }),
  ).toBeVisible()
  await noSideScroll(page)
  await shot(page, "avisos-tarjeta-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "avisos-tarjeta-telefono")
  await card.getByRole("button", { name: "Ahora no" }).click()
  await expect(card).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("heading", { name: /Lucía/, level: 1 })).toBeVisible()
  await expect(page.getByRole("region", { name: "Recibe los avisos en este celular" })).toHaveCount(
    0,
  )
})

test("Ventas elige qué le llega, con el teclado, y lo activa y apaga en este celular", async ({
  page,
  context,
}) => {
  await as("lucia")
  await fakePush(context, "lucia")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/avisos`)
  await expect(page.getByRole("heading", { name: "Avisos al celular" }).first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "Apagados en este celular" })).toBeVisible()
  // Lo de su rol, y los pedidos de Sofi solo si los elige. Lo de dinero no es suyo.
  await expect(page.getByRole("switch", { name: "Pagos por confirmar" })).toBeChecked()
  await expect(page.getByRole("switch", { name: "Chats que esperan a una persona" })).toBeChecked()
  await expect(page.getByRole("switch", { name: "Lo que no se entregó" })).toBeChecked()
  const sofi = page.getByRole("switch", { name: "Pedidos que armó Sofi" })
  await expect(sofi).not.toBeChecked()
  await expect(page.getByRole("switch", { name: "Lo de dinero" })).toHaveCount(0)
  await expect(
    page.getByText("El Dueño y el Administrador reciben además «Lo de dinero»."),
  ).toBeVisible()

  await sofi.focus()
  await page.keyboard.press("Space")
  await expect(page.getByText("Guardado: vale en todos tus celulares")).toBeVisible()
  await expect(sofi).toBeChecked()
  await page.reload()
  await expect(page.getByRole("switch", { name: "Pedidos que armó Sofi" })).toBeChecked()

  await page.getByRole("button", { name: "Activar en este celular" }).click()
  await expect(page.getByRole("heading", { name: "Activados en este celular" })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "avisos-configuracion-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "avisos-configuracion-telefono")
  // Con los avisos activados, Inicio ya no ofrece la tarjeta.
  await page.goto(BASE)
  await expect(page.getByRole("heading", { name: /Lucía/, level: 1 })).toBeVisible()
  await expect(page.getByRole("region", { name: "Recibe los avisos en este celular" })).toHaveCount(
    0,
  )
  await page.goto(`${BASE}/configuracion/avisos`)
  await expect(page.getByRole("heading", { name: "Activados en este celular" })).toBeVisible()
  await page.getByRole("button", { name: "Apagar en este celular" }).click()
  await expect(page.getByRole("heading", { name: "Apagados en este celular" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Activar en este celular" })).toBeVisible()
})

test("el Dueño ve además «Lo de dinero»", async ({ page, context }) => {
  await as("rosa")
  await fakePush(context, "rosa")
  await page.setViewportSize(PHONE)
  await page.goto(`${BASE}/configuracion/avisos`)
  await expect(page.getByRole("switch", { name: "Lo de dinero" })).toBeChecked()
  await expect(page.getByRole("switch", { name: "Pedidos que armó Sofi" })).toBeChecked()
  await expect(page.getByText("El Dueño y el Administrador reciben además")).toHaveCount(0)
  await noSideScroll(page)
  await shot(page, "avisos-dueno-telefono")
})
