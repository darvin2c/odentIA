import { createHmac } from "node:crypto"
import type { Page } from "@playwright/test"

/**
 * Simuladores de inbound de proveedor para dev/e2e y uso manual.
 * Corren el fetch EN EL NAVEGADOR (page.evaluate): el contexto de
 * Playwright en Node no resuelve *.odentia.localhost en WSL.
 */

export async function simulateTelegramInbound(
  page: Page,
  apiBase: string,
  connectionId: string,
  secret: string,
  input: { fromId: number; chatId: number; text: string; updateId: number; messageId?: number },
): Promise<number> {
  const body = {
    update_id: input.updateId,
    message: {
      message_id: input.messageId ?? input.updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: input.chatId, type: "private" },
      from: { id: input.fromId, first_name: "E2E", last_name: "Paciente" },
      text: input.text,
    },
  }
  return page.evaluate(
    async ({ apiBase, connectionId, secret, body }) => {
      const response = await fetch(
        `${apiBase}/api/webhooks/channels/telegram_bot_api/${connectionId}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": secret,
          },
          body: JSON.stringify(body),
        },
      )
      return response.status
    },
    { apiBase, connectionId, secret, body },
  )
}

export async function simulateWhatsAppInbound(
  page: Page,
  apiBase: string,
  connectionId: string,
  appSecret: string,
  // Sin `from`, como manda Meta a quien oculta su número: solo su BSUID (`userId`, ADR 0108).
  input: { from?: string; userId?: string; name?: string; phoneNumberId: string; text: string; wamid: string },
): Promise<number> {
  const rawBody = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-E2E",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: input.phoneNumberId },
              contacts: [{ profile: { name: input.name ?? "E2E Paciente" }, wa_id: input.from, user_id: input.userId }],
              messages: [
                {
                  from: input.from,
                  from_user_id: input.userId,
                  id: input.wamid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: input.text },
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  })
  const signature = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`
  return page.evaluate(
    async ({ apiBase, connectionId, signature, rawBody }) => {
      const response = await fetch(
        `${apiBase}/api/webhooks/channels/whatsapp_cloud_api/${connectionId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": signature },
          body: rawBody,
        },
      )
      return response.status
    },
    { apiBase, connectionId, signature, rawBody },
  )
}
