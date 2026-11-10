import type { Page } from "@playwright/test"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * La app instalable y los avisos en el equipo (ADR 0177). Lo que no se puede
 * probar aquí: la entrega real por FCM, Apple o Mozilla, la pantalla bloqueada y
 * la ventana de instalar del navegador. El servicio de push del navegador se
 * reemplaza por uno de mentira (`PushManager`): todo lo demás es real.
 */

/**
 * El servicio de push del navegador, sin red: guarda la suscripción en el equipo. Y la
 * respuesta «Permitir» de su ventana: con el certificado de la corrida, Chrome trata la
 * página como no segura y niega las notificaciones aunque se le den.
 */
const fakePushService = () => {
  // Lo que decidió queda en el equipo, como en el navegador.
  Object.defineProperty(Notification, "permission", { get: () => (localStorage.getItem("e2e-permiso") ?? "default") as NotificationPermission })
  Notification.requestPermission = async () => {
    localStorage.setItem("e2e-permiso", "granted")
    return "granted"
  }
  const fake = (endpoint: string) => ({
    endpoint,
    toJSON: () => ({
      endpoint,
      keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
    }),
    unsubscribe: async () => {
      localStorage.removeItem("e2e-push")
      return true
    },
  })
  PushManager.prototype.getSubscription = async function () {
    const endpoint = localStorage.getItem("e2e-push")
    return (endpoint ? fake(endpoint) : null) as unknown as PushSubscription
  }
  PushManager.prototype.subscribe = async function () {
    const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`
    localStorage.setItem("e2e-push", endpoint)
    return fake(endpoint) as unknown as PushSubscription
  }
}

const state = (page: Page, slug: string, endpoint: string) =>
  call<{ active: boolean }>(page, "POST", "/api/push/subscriptions/state", slug, { endpoint })

const avisosSwitch = (page: Page) => page.getByRole("switch", { name: "Recibir avisos en este equipo" })

test("la clínica se instala con su nombre y avisa en el equipo: activar, sin conexión y cerrar sesión", async ({ createOwner }, testInfo) => {
  const { page, context, org } = await createOwner("instalable")
  await context.addInitScript(fakePushService)
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))

  // Instalable con el nombre de la clínica y el ícono de su producto; el service worker no guarda nada.
  expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/app.webmanifest")
  const manifest = await page.evaluate(() => fetch("/app.webmanifest").then((r) => r.json()))
  expect(manifest).toMatchObject({ name: org.name, start_url: "/home", display: "standalone", icons: [{ src: "/pwa/odentia-192.png" }, {}, {}] })
  expect(await page.evaluate(() => fetch("/pwa/odentia-192.png").then((r) => r.headers.get("content-type")))).toContain("image/png")
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL ?? ""))
    .toMatch(/\/sw\.js$/)
  // El portal del paciente comparte el origen, pero no ofrece instalar la app del equipo.
  const embedHtml = await page.evaluate((url) => fetch(url).then((r) => r.text()), tenant(org.slug, "/embed"))
  expect(embedHtml).not.toContain('rel="manifest"')

  // En la campana: la explicación y el interruptor, apagado.
  await page.getByRole("button", { name: /^Avisos/ }).click()
  const toggle = avisosSwitch(page)
  await expect(toggle).not.toBeChecked()
  await expect(page.getByText("El aviso no dice el nombre de la persona.", { exact: false })).toBeVisible()
  await testInfo.attach("campana-apagado-1440", { body: await page.screenshot(), contentType: "image/png" })

  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(page.getByText("Activado en este equipo.", { exact: false })).toBeVisible()
  const endpoint = await page.evaluate(() => localStorage.getItem("e2e-push"))
  expect(endpoint).toMatch(/^https:\/\/fcm\.googleapis\.com\//)
  expect(await state(page, org.slug, endpoint!)).toEqual({ active: true })
  await testInfo.attach("campana-activado-1440", { body: await page.screenshot(), contentType: "image/png" })

  // Al volver, sigue activado: lo dice el servidor, no solo el navegador.
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await page.getByRole("button", { name: /^Avisos/ }).click()
  await expect(avisosSwitch(page)).toBeChecked()

  // En el teléfono, el mismo panel cabe sin desplazarse de lado.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(avisosSwitch(page)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await testInfo.attach("campana-activado-390", { body: await page.screenshot(), contentType: "image/png" })
  await page.keyboard.press("Escape")

  // Sin conexión: la franja dice la verdad y no se cierra mientras dure.
  await context.setOffline(true)
  await expect(page.getByText("Sin conexión · no recargues")).toBeVisible()
  await testInfo.attach("sin-conexion-390", { body: await page.screenshot(), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByText("Sin conexión. Lo que escribiste sigue aquí y lo que ya tocaste guardar se guarda solo al volver: no recargues la página.")).toBeVisible()
  await testInfo.attach("sin-conexion-1440", { body: await page.screenshot(), contentType: "image/png" })
  await context.setOffline(false)
  await expect(page.getByText("Sin conexión. Lo que escribiste sigue aquí", { exact: false })).toHaveCount(0)

  // Apagar desde el interruptor y volver a activar.
  await page.getByRole("button", { name: /^Avisos/ }).click()
  const again = avisosSwitch(page)
  await again.click()
  await expect(again).not.toBeChecked()
  expect(await state(page, org.slug, endpoint!)).toEqual({ active: false })
  await again.click()
  await expect(again).toBeChecked()
  expect(await page.evaluate(() => localStorage.getItem("e2e-push"))).not.toBeNull()

  // Cerrar sesión: este equipo deja de recibir los avisos de quien sale.
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: /^Menú de / }).click()
  const deleted = page.waitForResponse((response) => response.url().endsWith("/api/push/subscriptions") && response.request().method() === "DELETE")
  await page.getByRole("menuitem", { name: "Cerrar sesión" }).click()
  expect((await deleted).status()).toBe(200)
  await expect(page).toHaveURL(/\/login/)
  expect(await page.evaluate(() => localStorage.getItem("e2e-push"))).toBeNull()
})

test("con los avisos bloqueados en el navegador, el interruptor dice cómo arreglarlo y la campana sigue", async ({ createOwner }) => {
  const { page, context, org } = await createOwner("bloqueado")
  await context.addInitScript(() => {
    Object.defineProperty(Notification, "permission", { get: () => "denied" })
  })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await page.getByRole("button", { name: /^Avisos/ }).click()
  await expect(avisosSwitch(page)).toBeDisabled()
  await expect(page.getByText("El navegador los tiene bloqueados.", { exact: false })).toBeVisible()
  await expect(page.getByText("No tienes avisos")).toBeVisible()
})
