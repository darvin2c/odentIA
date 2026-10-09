import { randomUUID } from "node:crypto"
import { agentRunLedger } from "@odentia/db/schema/agent"
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

  // Con el modelo falso, «línea base» es el modelo de decisión de demostración: la sombra queda registrada.
  await call(page, "PUT", "/api/agent/config", org.slug, { enabled: true, decisionProvider: "baseline" })
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

  // Responder cierra el turno: la corrida queda correcta con una sola llamada al modelo.
  await expect
    .poll(
      async () =>
        (
          await call<Array<{ status: string; llmCalls: number | null }>>(
            page,
            "GET",
            `/api/agent/runs?conversationId=${conversationId}`,
            org.slug,
          )
        ).map((run) => ({ status: run.status, llmCalls: run.llmCalls })),
      { timeout: 30_000 },
    )
    .toEqual([{ status: "ok", llmCalls: 1 }])
  // La simulación devuelve lo que se habría enviado, no un texto que nadie recibe.
  const simulation = await call<{ reply: string; replied: boolean }>(
    page,
    "POST",
    "/api/agent/simulate",
    org.slug,
    { conversationId, text: "¿Atienden los sábados?" },
  )
  expect(simulation).toMatchObject({ reply: FAKE_REPLY, replied: true })
  await gotoHydrated(page, tenant(org.slug, "/agent"))
  await expect(page.getByRole("columnheader", { name: "Llamadas al modelo" })).toBeVisible()
  await expect(page.getByRole("row").filter({ hasText: "Ejecución correcta" })).toContainText("send_reply")
  // La decisión en sombra se registró sin cambiar la corrida y se ve con su respuesta y confianza.
  const decisions = await call<Array<{ point: string; provider: string; error: string | null }>>(
    page,
    "GET",
    `/api/agent/decisions?conversationId=${conversationId}`,
    org.slug,
  )
  expect(decisions).toEqual([expect.objectContaining({ point: "triage.v1", provider: "fake", error: null })])
  const shadow = page.getByRole("region", { name: "Decisiones en sombra" })
  await expect(shadow).toBeVisible()
  await expect(shadow).toContainText("requires_reply: sí")
})

test("crm agente: una corrida que no respondió queda a la vista para revisión", async ({
  owner,
  fixtureDb,
}, info) => {
  const { page, org } = owner
  // Corrida real ya registrada; no hay proveedor que la produzca en este entorno.
  await fixtureDb.insert(agentRunLedger).values({
    organizationId: org.id,
    model: "controlado",
    status: "sin_respuesta",
    startedAt: new Date(),
    endedAt: new Date(),
    latencyMs: 1200,
    llmCalls: 1,
  })

  await gotoHydrated(page, tenant(org.slug, "/agent"))
  const run = page.getByRole("row").filter({ hasText: "Terminó sin responder" })
  await expect(run).toBeVisible()
  await expect(run).not.toContainText("Ejecución correcta")
  await info.attach("actividad-sin-respuesta", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  const home = await call<{ agent: { today: { runs: number; ok: number; sinRespuesta: number } } | null }>(
    page,
    "GET",
    "/api/workspace/home",
    org.slug,
  )
  expect(home.agent?.today).toMatchObject({ runs: 1, ok: 0, sinRespuesta: 1 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(page.getByRole("region", { name: "El agente hoy" })).toContainText("Necesitan revisión")
  await info.attach("inicio-sin-respuesta", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
})

test("crm derivación: recepción ve plazo y toma un caso de la cola", async ({
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
      text: "Necesito hablar con recepción",
      updateId: nextEventId(),
    }),
  ).toBe(200)
  const conversation = await waitForConversation(page, org.slug, tg.id)
  const handoff = await call<{
    id: string
    assigneeUserId: string | null
    dueAt: string | null
  }>(page, "POST", "/api/agent/handoffs", org.slug, {
    conversationId: conversation.id,
    reason: "El interlocutor pidió atención humana",
    summary: "Solicita que recepción continúe el caso.",
    priority: "alta",
  }, 201)
  expect(handoff.assigneeUserId).toBeNull()
  expect(handoff.dueAt).toBeTruthy()

  await gotoHydrated(page, tenant(org.slug, "/agent/approvals"))
  const queueItem = page.getByRole("listitem").filter({ hasText: "El interlocutor pidió atención humana" })
  await expect(queueItem).toContainText("En cola por recoger")
  await expect(queueItem).toContainText("vence")
  await queueItem.getByRole("button", { name: "Tomar caso" }).click()
  await expect(queueItem).toContainText("Responsable asignado")
  await expect(queueItem.getByRole("button", { name: "Tomar caso" })).toHaveCount(0)

  const persisted = await call<Array<{ id: string; assigneeUserId: string | null }>>(
    page,
    "GET",
    `/api/agent/handoffs?conversationId=${conversation.id}`,
    org.slug,
  )
  expect(persisted.find(item => item.id === handoff.id)?.assigneeUserId).toBeTruthy()
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
  const pipes = await call<{ stages: { id: string; name: string }[] }[]>(page, "GET", "/api/pipelines", org.slug)
  const stages = pipes.flatMap(p => p.stages)
  const nuevo = stages.find(s => s.name === "Nuevo")
  const contactado = stages.find(s => s.name === "Contactado")
  expect(nuevo).toBeDefined()
  expect(contactado).toBeDefined()

  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  await page.getByRole("button", { name: "Nueva oportunidad" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByPlaceholder("Buscar por nombre, teléfono o correo").fill(conversation.contact.displayName)
  await dialog.getByRole("button", { name: conversation.contact.displayName, exact: true }).click()
  await page.getByLabel("Título", { exact: true }).fill("Evaluación de ortodoncia")
  await page.getByRole("combobox", { name: "Etapa inicial", exact: true }).selectOption(nuevo!.id)
  await page.getByRole("button", { name: "Crear", exact: true }).click()
  const card = page.getByRole("link", { name: "Evaluación de ortodoncia", exact: true })
  await expect(card).toBeVisible()
  await call(page, "POST", "/api/opportunities", org.slug, {
    contactId,
    title: "Control preventivo",
  }, 201)
  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  const destination = page.getByRole("region", { name: "Etapa Contactado", exact: true })
  const origin = page.getByRole("region", { name: "Etapa Nuevo", exact: true })
  const handle = page.getByRole("button", { name: "Arrastrar Evaluación de ortodoncia", exact: true })
  async function dragToContacted() {
    await expect(handle).toBeEnabled()
    await handle.scrollIntoViewIfNeeded()
    await handle.hover()
    const sourceBox = await handle.boundingBox()
    const targetBox = await destination.boundingBox()
    if (!sourceBox || !targetBox) throw new Error("El tablero no ofrece un destino visible")
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 120, { steps: 20 })
    await expect(destination.getByText("Soltar en Contactado", { exact: true })).toBeVisible()
    await page.mouse.up()
  }
  const responseGate = Promise.withResolvers<void>()
  await page.route("**/api/opportunities/*/move", async route => {
    await responseGate.promise
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      headers: { "access-control-allow-origin": new URL(page.url()).origin, "access-control-allow-credentials": "true" },
      body: JSON.stringify({ error: { code: "CONFLICT", message: "La oportunidad cambió en otra sesión" } }),
    })
  })
  try {
    await dragToContacted()
    await expect(destination.getByRole("link", { name: "Evaluación de ortodoncia", exact: true })).toBeVisible()
    await expect(origin.getByRole("link", { name: "Evaluación de ortodoncia", exact: true })).toHaveCount(0)
  } finally {
    responseGate.resolve()
  }
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(origin.getByRole("link", { name: "Evaluación de ortodoncia", exact: true })).toBeVisible()
  await page.unroute("**/api/opportunities/*/move")
  const saved = page.waitForResponse(response => response.url().endsWith("/move") && response.request().method() === "POST" && response.status() === 200)
  await dragToContacted()
  await saved

  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  const contactadoCol = page.getByRole("region", { name: "Etapa Contactado", exact: true })
  await expect(contactadoCol.getByRole("link", { name: "Evaluación de ortodoncia" })).toBeVisible()
  const nuevoCol = page.getByRole("region", { name: "Etapa Nuevo", exact: true })
  await expect(nuevoCol.getByRole("link", { name: "Control preventivo" })).toBeVisible()
  const closed = await call<{ id: string }>(page, "POST", "/api/opportunities", org.slug, {
    contactId, title: "Tratamiento cerrado",
  }, 201)
  await call(page, "POST", `/api/opportunities/${closed.id}/close`, org.slug, {
    outcome: "won", reason: "El paciente confirmó el tratamiento",
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  await expect(page.getByRole("link", { name: "Tratamiento cerrado", exact: true })).toBeAttached()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.getByRole("link", { name: "Tratamiento cerrado", exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole("link", { name: "Tratamiento cerrado", exact: true })).toBeVisible()
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
