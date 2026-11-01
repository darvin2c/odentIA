import { agentAnswerTrace } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

interface Trace {
  id: string
  messageId: string | null
  outcome: string
  replyText: string
  basis: Array<{ kind: string; label: string; detail?: string }>
  checks: Array<{ kind: string; value: string; ok: boolean; source: string | null }>
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

/**
 * La respuesta la produce el recorrido real (webhook → cola → worker → envío)
 * con el modelo determinista de pruebas: acredita que la traza se registra y
 * se muestra, no la calidad de un proveedor real.
 */
test("bandeja: cada respuesta del agente dice en qué se basó", async ({ owner, fixtureDb, nextEventId }, info) => {
  const { page, org } = owner
  const tg = await call<{ id: string; webhookSecret: string }>(page, "POST", "/api/channels/connections", org.slug, {
    channel: "telegram", provider: "telegram_bot_api", displayName: "Bot E2E", config: { botToken: "e2e" },
  }, 201)
  await call(page, "PUT", "/api/agent/config", org.slug, { enabled: true })
  const user = nextEventId()
  expect(await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
    fromId: user, chatId: user, text: "Hola, ¿me ayudan con una cita?", updateId: nextEventId(),
  })).toBe(200)

  const conversations = () => call<Array<{ id: string }>>(page, "GET", "/api/conversations", org.slug)
  await expect.poll(async () => (await conversations()).length, { timeout: 30_000 }).toBe(1)
  const conversationId = (await conversations())[0]!.id
  const traces = () => call<Trace[]>(page, "GET", `/api/agent/answer-traces?conversationId=${conversationId}`, org.slug)
  await expect.poll(async () => (await traces()).length, { timeout: 45_000 }).toBe(1)
  const [real] = await traces()
  expect(real).toMatchObject({ outcome: "enviada", basis: [], checks: [] })
  expect(real?.messageId).toBeTruthy()

  // Escritorio: el enlace aparece solo en el mensaje del agente y abre su traza.
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  const link = page.getByRole("button", { name: "En qué se basó" })
  await expect(link).toHaveCount(1)
  await link.click()
  const detail = page.getByRole("dialog", { name: "En qué se basó" })
  await expect(detail).toContainText(real!.replyText)
  await expect(detail).toContainText("No consultó ninguna fuente para esta respuesta")
  await expect(detail).toContainText("no llevaba precios, fechas ni horas que comprobar")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("traza-sin-fuentes", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.keyboard.press("Escape")
  await expect(detail).toBeHidden()
  await expect(link).toBeFocused()

  // Una respuesta que consultó fuentes y llevaba un precio: se siembra la
  // traza como la registra el agente (el modelo de pruebas no usa herramientas).
  await fixtureDb.insert(agentAnswerTrace).values({
    organizationId: org.id,
    conversationId,
    messageId: real!.messageId,
    outcome: "enviada",
    replyText: real!.replyText,
    basis: [
      { kind: "servicios", label: "Sedes, servicios y precios" },
      { kind: "agenda", label: "Agenda: horarios disponibles", detail: "3 horarios" },
    ],
    checks: [
      { kind: "precio", value: "S/ 150", ok: true, source: "Sedes, servicios y precios" },
      { kind: "hora", value: "9:00 a. m.", ok: true, source: "Agenda: horarios disponibles" },
    ],
    model: "fake",
  })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  await link.click()
  const sources = detail.getByRole("listitem")
  await expect(sources.filter({ hasText: "Agenda: horarios disponibles" }).first()).toContainText("3 horarios")
  // Lo comprobado se dice como un veredicto, no dato por dato; y la ficha sigue el orden del diseño.
  await expect(detail).toContainText("Comprobado antes de enviar")
  await expect(detail).toContainText("El precio y la hora coinciden con los datos que usó.")
  await expect(detail.getByRole("heading", { level: 3 })).toHaveText(["Datos que usó", "Lecciones que aplicó", "Lo que hizo y lo que espera"])
  await expect(detail).toContainText("Envió esta respuesta.")
  await info.attach("traza-con-fuentes", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // Quien atiende conversaciones dice si estuvo bien; repetirlo no hace falta.
  await expect(detail).toContainText("¿Estuvo bien esta respuesta?")
  await detail.getByRole("button", { name: "Sí, estuvo bien" }).click()
  await expect(detail.getByRole("status")).toHaveText("Quedó marcada como una buena respuesta. Sofi sigue respondiendo igual.")
  await expect(detail.getByRole("button", { name: "Sí, estuvo bien" })).toBeHidden()
  await page.keyboard.press("Escape")

  // Teléfono: mismo contenido en una hoja inferior, con objetivo táctil suficiente.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  await expect(link).toBeVisible()
  expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await link.click()
  await expect(detail).toContainText("Comprobado antes de enviar")
  await expect(detail.getByRole("button", { name: "Corregir" })).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("traza-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await detail.getByRole("button", { name: "Cerrar" }).click()
  await expect(detail).toBeHidden()

  // Quien no puede ver conversaciones tampoco lee la traza ni el resumen del caso: lo decide el servidor.
  await fixtureDb.update(member).set({ role: "cashier" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  expect((await api(page, "GET", `/api/agent/answer-traces?conversationId=${conversationId}`, org.slug)).status).toBe(403)
  expect((await api(page, "GET", `/api/agent/case/brief?conversationId=${conversationId}`, org.slug)).status).toBe(403)
})
