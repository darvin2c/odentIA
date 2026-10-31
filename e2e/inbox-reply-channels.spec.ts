import { channelConnection, conversation } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * «Responder por» ofrece solo los canales por los que sale algo: una conexión
 * apagada en Configuración deja su historial en el hilo, pero no se ofrece, y
 * el hilo abierto por ella pasa a un canal activo de la persona. Sin proveedor:
 * no acredita que Telegram entregue el mensaje.
 */
test("«Responder por» no ofrece un canal apagado y el hilo abierto por él pasa a uno activo", async ({ owner, fixtureDb }) => {
  const { page, org } = owner
  const user = 4_200_000 + Math.floor(Math.random() * 100_000)
  const bots: Record<string, string> = {}
  for (const [index, name] of ["Bot Uno", "Bot Dos", "Bot Apagado"].entries()) {
    const bot = await call<{ id: string; webhookSecret: string }>(page, "POST", "/api/channels/connections", org.slug, {
      channel: "telegram", provider: "telegram_bot_api", displayName: name, config: { botToken: `e2e-${index}` },
    }, 201)
    expect(await simulateTelegramInbound(page, API, bot.id, bot.webhookSecret, { fromId: user, chatId: user, text: `Hola por ${name}`, updateId: user + index })).toBe(200)
    bots[name] = bot.id
  }
  const offId = async () =>
    (await fixtureDb.select({ id: conversation.id }).from(conversation).where(eq(conversation.channelConnectionId, bots["Bot Apagado"]!)))[0]?.id ?? ""
  await expect.poll(offId, { timeout: 30_000 }).not.toBe("")
  const off = { id: await offId() }
  await fixtureDb.update(channelConnection).set({ status: "disabled" }).where(eq(channelConnection.id, bots["Bot Apagado"]!))

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${off.id}`))
  // Su historial sigue: lo que escribió por el bot apagado está en el hilo.
  await expect(page.getByText("Hola por Bot Apagado", { exact: true })).toBeVisible()
  // Se responde por uno activo, y el menú solo ofrece los activos.
  const trigger = page.getByRole("button", { name: /^Responder por Telegram · Bot (Uno|Dos), abierto/ })
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByRole("menuitem")).toHaveCount(2)
  await expect(page.getByRole("menuitem", { name: /Bot Apagado/ })).toHaveCount(0)
})
