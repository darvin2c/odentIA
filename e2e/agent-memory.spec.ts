import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

interface Memory {
  facts: Array<{ id: string; text: string; source: string }>
  derived: unknown[]
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test("memoria de la persona: agregar, corregir y quitar un dato; lo clínico no se guarda", async ({ owner, fixtureDb, nextEventId }, info) => {
  const { page, org } = owner
  const tg = await call<{ id: string; webhookSecret: string }>(page, "POST", "/api/channels/connections", org.slug, {
    channel: "telegram", provider: "telegram_bot_api", displayName: "Bot E2E", config: { botToken: "e2e" },
  }, 201)
  const user = nextEventId()
  expect(await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
    fromId: user, chatId: user, text: "Hola, prefiero las citas por la tarde", updateId: nextEventId(),
  })).toBe(200)
  const conversations = () => call<Array<{ id: string; contact: { id: string } }>>(page, "GET", "/api/conversations", org.slug)
  await expect.poll(async () => (await conversations()).length, { timeout: 30_000 }).toBe(1)
  const [thread] = await conversations()
  const conversationId = thread!.id
  const contactId = thread!.contact.id
  const memory = () => call<Memory>(page, "GET", `/api/contacts/${contactId}/agent-memory`, org.slug)

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  await page.getByRole("button", { name: "Lo que recuerda el agente" }).click()
  const drawer = page.getByRole("dialog", { name: "Lo que recuerda el agente" })
  await expect(drawer).toContainText("Todavía no recuerda nada de esta persona.")
  await expect(drawer).toContainText("Nunca guarda síntomas, diagnósticos ni nada de la historia clínica.")

  // Un dato de salud no entra y la pantalla dice por qué.
  await drawer.getByLabel("Agregar un dato").fill("Es alérgica a la penicilina")
  await drawer.getByRole("button", { name: "Agregar" }).click()
  await expect(drawer.getByRole("alert")).toContainText("Eso parece información de salud")
  expect((await memory()).facts).toEqual([])

  // Un dato práctico sí, con quién lo anotó y cuándo.
  await drawer.getByLabel("Agregar un dato").fill("Prefiere citas por la tarde")
  await drawer.getByRole("button", { name: "Agregar" }).click()
  const fact = drawer.getByRole("listitem").filter({ hasText: "Prefiere citas por la tarde" })
  await expect(fact).toContainText(`Lo anotó ${owner.user.name} el`)
  await expect(drawer.getByLabel("Agregar un dato")).toHaveValue("")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("memoria-persona", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // Corregir reemplaza el dato; el anterior deja de mostrarse.
  await fact.getByRole("button", { name: "Corregir: Prefiere citas por la tarde" }).click()
  await expect(drawer.getByLabel("Corregir el dato")).toHaveValue("Prefiere citas por la tarde")
  await drawer.getByLabel("Corregir el dato").fill("Prefiere citas por la mañana")
  await drawer.getByRole("button", { name: "Guardar la corrección" }).click()
  await expect(drawer.getByRole("listitem").filter({ hasText: "Prefiere citas por la mañana" })).toBeVisible()
  await expect(drawer.getByRole("listitem").filter({ hasText: "Prefiere citas por la tarde" })).toHaveCount(0)
  expect((await memory()).facts.map((item) => item.text)).toEqual(["Prefiere citas por la mañana"])

  // Teléfono: el mismo cajón, con controles tocables.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  await page.getByRole("button", { name: "Contexto", exact: true }).click()
  await page.getByRole("button", { name: "Lo que recuerda el agente" }).click()
  const remove = drawer.getByRole("button", { name: "Quitar: Prefiere citas por la mañana" })
  expect((await remove.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("memoria-persona-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await remove.click()
  await expect(drawer).toContainText("Todavía no recuerda nada de esta persona.")
  expect((await memory()).facts).toEqual([])

  // Caja no atiende conversaciones ni lleva el CRM: no lee ni cambia la memoria.
  await fixtureDb.update(member).set({ role: "cashier" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  expect((await api(page, "GET", `/api/contacts/${contactId}/agent-memory`, org.slug)).status).toBe(403)
  expect((await api(page, "POST", `/api/contacts/${contactId}/agent-memory`, org.slug, { text: "Paga con tarjeta" })).status).toBe(403)
})
