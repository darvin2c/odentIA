import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { simulateTelegramInbound, simulateWhatsAppInbound } from "./channels"
import { API, tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

const FAKE_REPLY = "Gracias por escribir. Te atiendo enseguida."

interface Conversation {
  id: string
  contact: { id: string; displayName: string }
  connection: { id: string; channel: string }
  preview: { body: string | null } | null
}

interface TelegramConnection {
  id: string
  webhookSecret: string
}

interface Message {
  senderKind: string
  body: string | null
}

async function createTelegramConnection(page: Page, slug: string): Promise<TelegramConnection> {
  return call<TelegramConnection>(page, "POST", "/api/channels/connections", slug, {
    channel: "telegram",
    provider: "telegram_bot_api",
    displayName: "Bot E2E",
    config: { botToken: "e2e" },
  }, 201)
}

async function listConversations(page: Page, slug: string): Promise<Conversation[]> {
  return call<Conversation[]>(page, "GET", "/api/conversations", slug)
}

async function findConversation(
  page: Page,
  slug: string,
  connectionId: string,
): Promise<Conversation | undefined> {
  return (await listConversations(page, slug)).find((c) => c.connection.id === connectionId)
}

async function waitForConversation(page: Page, slug: string, connectionId: string) {
  await expect
    .poll(async () => (await findConversation(page, slug, connectionId))?.id ?? "", {
      timeout: 30_000,
    })
    .not.toBe("")
  const found = await findConversation(page, slug, connectionId)
  expect(found).toBeDefined()
  return found!
}

async function waitForInboundText(
  page: Page,
  slug: string,
  conversationId: string,
  text: string,
) {
  await expect
    .poll(
      async () =>
        (
          await call<Message[]>(
            page,
            "GET",
            `/api/conversations/${conversationId}/messages`,
            slug,
          )
        ).some((m) => m.senderKind === "contact" && m.body === text),
      { timeout: 30_000 },
    )
    .toBe(true)
}

test("crm telegram: inbound crea conversación y contacto visible en bandeja", async ({
  owner,
  nextEventId,
}) => {
  const { page, org } = owner
  const tg = await createTelegramConnection(page, org.slug)
  const tgUser = nextEventId()
  expect(
    await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
      fromId: tgUser,
      chatId: tgUser,
      text: "Hola, quiero una cita",
      updateId: nextEventId(),
    }),
  ).toBe(200)
  const conversation = await waitForConversation(page, org.slug, tg.id)
  expect(conversation.contact.displayName).toContain("E2E")
  await waitForInboundText(page, org.slug, conversation.id, "Hola, quiero una cita")

  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  await expect(page.getByText("E2E Paciente").first()).toBeVisible()
  await expect(page.getByText("Hola, quiero una cita").first()).toBeVisible()

  await gotoHydrated(page, tenant(org.slug, "/contacts"))
  await expect(page.getByText("E2E Paciente").first()).toBeVisible()
})

test("crm agente: responde al segundo inbound y el operador toma el hilo", async ({
  owner,
  nextEventId,
}) => {
  const { page, org } = owner
  const tg = await createTelegramConnection(page, org.slug)
  const tgUser = nextEventId()
  expect(
    await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
      fromId: tgUser,
      chatId: tgUser,
      text: "Hola, quiero una cita",
      updateId: nextEventId(),
    }),
  ).toBe(200)
  const conversation = await waitForConversation(page, org.slug, tg.id)
  await waitForInboundText(page, org.slug, conversation.id, "Hola, quiero una cita")
  const conversationId = conversation.id

  await call(page, "PUT", "/api/agent/config", org.slug, { enabled: true })
  await call(page, "POST", `/api/conversations/${conversationId}/agent`, org.slug, {
    enabled: true,
  })
  expect(
    await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
      fromId: tgUser,
      chatId: tgUser,
      text: "¿Cuánto cuesta la limpieza?",
      updateId: nextEventId(),
    }),
  ).toBe(200)
  await waitForInboundText(page, org.slug, conversationId, "¿Cuánto cuesta la limpieza?")

  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  await expect(page.getByText(FAKE_REPLY).first()).toBeVisible({ timeout: 30_000 })

  await page.getByText("E2E Paciente").first().click()
  await expect(page.getByLabel("Mensaje")).toBeEnabled()
  await page.getByLabel("Mensaje").fill("Te ayudo por aquí mismo")
  await page.getByLabel("Mensaje").press("Enter")
  await expect(page.getByText("Te ayudo por aquí mismo").first()).toBeVisible()
  await expect(page.getByRole("button", { name: "OFF" })).toBeVisible()
})

test("crm pipeline: mover una oportunidad no mueve las otras de la misma persona", async ({
  owner,
  nextEventId,
}) => {
  const { page, org } = owner
  const tg = await createTelegramConnection(page, org.slug)
  const tgUser = nextEventId()
  expect(
    await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
      fromId: tgUser,
      chatId: tgUser,
      text: "Hola, quiero una cita",
      updateId: nextEventId(),
    }),
  ).toBe(200)
  const conversation = await waitForConversation(page, org.slug, tg.id)
  await waitForInboundText(page, org.slug, conversation.id, "Hola, quiero una cita")
  const contactId = conversation.contact.id

  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  await page.getByRole("button", { name: "Nueva oportunidad" }).click()
  await page.getByRole("combobox", { name: "Contacto", exact: true }).selectOption(contactId)
  await page.getByLabel("Título", { exact: true }).fill("Evaluación de ortodoncia")
  await page.getByRole("button", { name: "Crear", exact: true }).click()
  const card = page.getByRole("link", { name: "Evaluación de ortodoncia", exact: true })
  await expect(card).toBeVisible()
  await call(page, "POST", "/api/opportunities", org.slug, {
    contactId,
    title: "Control preventivo",
  }, 201)
  const pipes = await call<{ stages: { id: string; name: string }[] }[]>(
    page,
    "GET",
    "/api/pipelines",
    org.slug,
  )
  const contactado = pipes.flatMap((p) => p.stages).find((s) => s.name === "Contactado")
  expect(contactado).toBeDefined()
  await card.click()
  await page.getByRole("combobox", { name: "Etapa", exact: true }).selectOption(contactado!.id)
  await expect(page.getByRole("combobox", { name: "Etapa", exact: true })).toHaveValue(contactado!.id)

  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  const contactadoCol = page.locator("section", { hasText: "Contactado" }).first()
  await expect(contactadoCol.getByRole("link", { name: "Evaluación de ortodoncia" })).toBeVisible()
  const nuevoCol = page.locator("section", { hasText: "Nuevo" }).first()
  await expect(nuevoCol.getByRole("link", { name: "Control preventivo" })).toBeVisible()
})

test("crm whatsapp: firma válida crea conversación y firma inválida da 401", async ({
  owner,
}) => {
  const { page, org } = owner
  const wa = await call<{ id: string }>(
    page,
    "POST",
    "/api/channels/connections",
    org.slug,
    {
      channel: "whatsapp",
      provider: "whatsapp_cloud_api",
      displayName: "WA E2E",
      config: {
        phoneNumberId: "E2E-PNID",
        wabaId: "E2E-WABA",
        accessToken: "e2e",
        appSecret: "e2e-secret",
        templates: [],
      },
    },
    201,
  )
  const before = await listConversations(page, org.slug)
  expect(before.filter((c) => c.connection.id === wa.id)).toEqual([])

  expect(
    await simulateWhatsAppInbound(page, API, wa.id, "e2e-secret", {
      from: "51911122233",
      phoneNumberId: "E2E-PNID",
      text: "Buenos días",
      wamid: `wamid.${randomUUID()}`,
    }),
  ).toBe(200)
  const waConversation = await waitForConversation(page, org.slug, wa.id)
  expect(waConversation.connection.channel).toBe("whatsapp")
  await waitForInboundText(page, org.slug, waConversation.id, "Buenos días")
  const waConversationId = waConversation.id

  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${waConversationId}`))
  await expect(page.getByText("Buenos días").first()).toBeVisible()

  const badSig = await page.evaluate(
    async ({ apiBase, connectionId }) => {
      const response = await fetch(
        `${apiBase}/api/webhooks/channels/whatsapp_cloud_api/${connectionId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" },
          body: "{}",
        },
      )
      return response.status
    },
    { apiBase: API, connectionId: wa.id },
  )
  expect(badSig).toBe(401)
  const after = await listConversations(page, org.slug)
  expect(after.filter((c) => c.connection.id === wa.id)).toHaveLength(1)
})

test("crm aislamiento: otra organización ve bandeja y listas vacías", async ({
  owner,
  createOwner,
  nextEventId,
}) => {
  const { page, org } = owner
  const tg = await createTelegramConnection(page, org.slug)
  const tgUser = nextEventId()
  expect(
    await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
      fromId: tgUser,
      chatId: tgUser,
      text: "Hola, quiero una cita",
      updateId: nextEventId(),
    }),
  ).toBe(200)
  const conversation = await waitForConversation(page, org.slug, tg.id)
  await waitForInboundText(page, org.slug, conversation.id, "Hola, quiero una cita")

  const other = await createOwner("crm-b")
  await gotoHydrated(other.page, tenant(other.org.slug, "/inbox"))
  await expect(other.page.getByText("Sin conversaciones")).toBeVisible()
  await expect(other.page.getByText("E2E Paciente")).toHaveCount(0)
  expect(await listConversations(other.page, other.org.slug)).toEqual([])
  expect(
    await call<unknown[]>(other.page, "GET", "/api/contacts", other.org.slug),
  ).toEqual([])
})
