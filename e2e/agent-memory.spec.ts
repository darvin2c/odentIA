import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

interface Memory {
  facts: Array<{ id: string; text: string; source: string }>
  derived: unknown[]
  lastTime: { wrote: { channel: string } | null; appointment: unknown; handoff: unknown }
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test("memoria de la persona: agregar, corregir y quitar un dato; la última vez; lo clínico no se guarda", async ({ owner, fixtureDb, nextEventId }, info) => {
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
  await page.getByRole("button", { name: "Lo que recuerda Sofi" }).click()
  const drawer = surface(page, { name: "Lo que recuerda Sofi" })
  await expect(drawer).toContainText("Solo esto, además de sus conversaciones. Lo puedes corregir o quitar.")
  await expect(drawer).toContainText("Todavía no recuerda nada de esta persona.")
  await expect(drawer).toContainText("Nunca guarda")
  await expect(drawer).toContainText("Síntomas, diagnósticos ni nada de la historia clínica.")
  await expect(drawer).toContainText("Uno nuevo reemplaza al anterior sin borrar la historia.")
  // «La última vez» sale de lo que el sistema ya guarda: aquí, su mensaje por Telegram.
  const lastTime = drawer.locator("section").filter({ has: page.getByRole("heading", { name: "La última vez" }) })
  await expect(lastTime).toContainText("Escribió por última vez el")
  await expect(lastTime).toContainText("por Telegram.")

  // El campo no está a la vista: lo abre «Agregar un dato».
  const addField = drawer.getByRole("textbox", { name: "Agregar un dato" })
  const openAdd = drawer.getByRole("button", { name: "Agregar un dato" })
  await expect(addField).toHaveCount(0)
  await openAdd.click()
  await expect(addField).toBeFocused()

  // Un dato de salud no entra y la pantalla dice por qué, sin perder lo escrito.
  await addField.fill("Es alérgica a la penicilina")
  await drawer.getByRole("button", { name: "Agregar", exact: true }).click()
  await expect(drawer.getByText(/Eso parece información de salud/)).toBeVisible()
  await expect(addField).toHaveAttribute("aria-invalid", "true")
  await expect(addField).toHaveValue("Es alérgica a la penicilina")
  expect((await memory()).facts).toEqual([])

  // Un dato práctico sí, con quién lo anotó y cuándo; el campo se cierra y el foco vuelve al botón.
  await addField.fill("Prefiere citas por la tarde")
  await drawer.getByRole("button", { name: "Agregar", exact: true }).click()
  const fact = drawer.getByRole("listitem").filter({ hasText: "Prefiere citas por la tarde" })
  await expect(fact).toContainText(`Lo anotó ${owner.user.name} el`)
  await expect(addField).toHaveCount(0)
  await expect(openAdd).toBeFocused()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("memoria-persona", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // Abrir el campo y cancelar no guarda nada.
  await openAdd.click()
  await addField.fill("Viaja en octubre")
  await drawer.getByRole("button", { name: "Cancelar" }).click()
  await expect(addField).toHaveCount(0)
  expect((await memory()).facts.map((item) => item.text)).toEqual(["Prefiere citas por la tarde"])

  // Corregir se abre tocando el dato y lo reemplaza; el anterior deja de mostrarse.
  await fact.getByRole("button", { name: "Corregir: Prefiere citas por la tarde" }).click()
  const fixField = drawer.getByRole("textbox", { name: "Corregir el dato" })
  await expect(fixField).toHaveValue("Prefiere citas por la tarde")
  await fixField.fill("Prefiere citas por la mañana")
  await drawer.getByRole("button", { name: "Guardar la corrección" }).click()
  await expect(drawer.getByRole("listitem").filter({ hasText: "Prefiere citas por la mañana" })).toBeVisible()
  await expect(drawer.getByRole("listitem").filter({ hasText: "Prefiere citas por la tarde" })).toHaveCount(0)
  expect((await memory()).facts.map((item) => item.text)).toEqual(["Prefiere citas por la mañana"])

  // Teléfono: el mismo cajón, con controles tocables y sin desborde horizontal.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  // En el teléfono, el contexto se abre desde el menú de la conversación.
  await page.getByRole("button", { name: "Más acciones de la conversación" }).click()
  await page.getByRole("menuitem", { name: "Contexto", exact: true }).click()
  await page.getByRole("button", { name: "Lo que recuerda Sofi" }).click()
  const remove = drawer.getByRole("button", { name: "Quitar: Prefiere citas por la mañana" })
  const removeBox = await remove.boundingBox()
  expect(removeBox?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(removeBox?.width ?? 0).toBeGreaterThanOrEqual(44)
  expect((await drawer.getByRole("button", { name: "Corregir: Prefiere citas por la mañana" }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect((await openAdd.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
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
