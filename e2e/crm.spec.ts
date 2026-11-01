import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { agentHandoff, agentProposal, agentRunLedger } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { automationConsent } from "@odentia/db/schema/automation"
import { opportunityEvent } from "@odentia/db/schema/opportunities"
import type { Page } from "@playwright/test"
import { eq } from "drizzle-orm"
import { simulateTelegramInbound, simulateWhatsAppInbound } from "./channels"
import { API, tenant, tenantPattern } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

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

  // Quien escribió por primera vez está en Pacientes, en «Por registrar», con su página.
  await gotoHydrated(page, tenant(org.slug, "/people?ver=por_registrar"))
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

  // La Bandeja abre en «Por atender»; la que atiende el agente está en su pestaña.
  await gotoHydrated(page, tenant(org.slug, "/inbox?view=agent"))
  await expect(page.getByText(FAKE_REPLY).first()).toBeVisible({ timeout: 30_000 })

  await page.getByText("E2E Paciente").first().click()
  await expect(page.getByLabel("Mensaje")).toBeEnabled()
  await page.getByLabel("Mensaje").fill("Te ayudo por aquí mismo")
  await page.getByLabel("Mensaje").press("Enter")
  await expect(page.getByText("Te ayudo por aquí mismo").first()).toBeVisible()

  // Responder cierra el turno: una sola corrida correcta con una sola llamada
  // al modelo. Leyó también el primer mensaje (llegó con el agente apagado) y
  // deja constancia de haberlo atendido, sin otra llamada.
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
        )
          .map((run) => ({ status: run.status, llmCalls: run.llmCalls }))
          .sort((a, b) => a.status.localeCompare(b.status)),
      { timeout: 30_000 },
    )
    .toEqual([
      { status: "ok", llmCalls: 1 },
      { status: "omitida", llmCalls: 0 },
    ])
  // La simulación devuelve lo que se habría enviado, no un texto que nadie recibe.
  const simulation = await call<{ reply: string; replied: boolean }>(
    page,
    "POST",
    "/api/agent/simulate",
    org.slug,
    { conversationId, text: "¿Atienden los sábados?" },
  )
  expect(simulation).toMatchObject({ reply: FAKE_REPLY, replied: true })
  await gotoHydrated(page, tenant(org.slug, "/agent/registro"))
  await expect(page.getByRole("columnheader", { name: "Llamadas al modelo" })).toBeVisible()
  await expect(page.getByRole("row").filter({ hasText: "Ejecución correcta" })).toContainText("send_reply")
  // Antes de escribir, el modelo de decisión eligió el camino: quedó registrado con su respuesta y confianza.
  // Ve también los dos mensajes anteriores del interlocutor, y el primero pedía una cita.
  const decisions = await call<Array<{ point: string; mode: string; provider: string; error: string | null; outcome: { path: string } | null }>>(
    page,
    "GET",
    `/api/agent/decisions?conversationId=${conversationId}`,
    org.slug,
  )
  expect(decisions).toEqual([
    expect.objectContaining({ point: "route.v6", mode: "route", provider: "fake", error: null, outcome: expect.objectContaining({ path: "cita" }) }),
  ])
  const shadow = page.getByRole("region", { name: "Decisiones del modelo de decisión" })
  await expect(shadow).toBeVisible()
  await expect(shadow).toContainText("Camino: pedir una cita")
  await expect(shadow).toContainText("requires_reply: sí")
  // Y el gasto se puede comparar por camino.
  await expect(page.getByRole("region", { name: "Llamadas por camino" })).toContainText("Pedir una cita")
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

  await gotoHydrated(page, tenant(org.slug, "/agent/registro"))
  const run = page.getByRole("row").filter({ hasText: "Terminó sin responder" })
  await expect(run).toBeVisible()
  await expect(run).not.toContainText("Ejecución correcta")
  await info.attach("actividad-sin-respuesta", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Las cifras de corridas del agente viven en Agente; Inicio ya no las repite ni las pide.
  const home = await call<Record<string, unknown>>(page, "GET", "/api/workspace/home", org.slug)
  expect(home).not.toHaveProperty("agent")
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
  await expect(page.getByRole("region", { name: "El agente hoy" })).toHaveCount(0)
})

test("crm derivación: recepción ve plazo y toma un caso de la cola", async ({
  owner,
  nextEventId,
  fixtureDb,
}, info) => {
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
    summary: "Escribió: «Hola» · «Tengo la cara hinchada desde anoche» · «Necesito hablar con recepción»",
    priority: "alta",
  }, 201)
  expect(handoff.assigneeUserId).toBeNull()
  expect(handoff.dueAt).toBeTruthy()

  // Lo que el agente deja escrito al pasar el caso: qué pide, qué falta y el aviso que recibió la persona.
  await fixtureDb.update(agentHandoff).set({
    asks: "Que la atiendan hoy: tiene la cara hinchada desde anoche.",
    pending: "Saber si puede venir hoy y darle una hora.",
    notice: "Ya avisé al equipo como urgencia; una persona te escribe en los próximos minutos.",
  }).where(eq(agentHandoff.id, handoff.id))

  // En la Bandeja, quien abre el caso ve el resumen sin releer el hilo: qué pide, lo que ya se sabe y lo que falta.
  await call(page, "POST", `/api/contacts/${conversation.contact.id}/agent-memory`, org.slug, { text: "Prefiere citas por la tarde" }, 201)
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversation.id}`))
  // «Ver el caso» está en «…» de la conversación: el único botón principal es el del tema.
  await page.getByRole("button", { name: "Más acciones de la conversación" }).click()
  await page.getByRole("menuitem", { name: "Ver el caso" }).click()
  const brief = surface(page, { name: conversation.contact.displayName })
  await expect(brief).toContainText("Ahora")
  await expect(brief).toContainText("El interlocutor pidió atención humana")
  await expect(brief.getByRole("heading", { level: 3 })).toHaveText(["Lo que ya se sabe"])
  await expect(brief).toContainText("Que la atiendan hoy: tiene la cara hinchada desde anoche.")
  // Sus mensajes, en orden, sin releer el hilo.
  await expect(brief).toContainText("Necesito hablar con recepción")
  await expect(brief).toContainText("Prefiere citas por la tarde")
  await expect(brief).toContainText("Saber si puede venir hoy y darle una hora.")
  // Es el mismo panel de Inicio: con la caja al pie y lo demás en su menú.
  await expect(brief.getByLabel(/^Tu respuesta para/)).toBeVisible()
  await expect(brief.getByRole("button", { name: "Enviar", exact: true })).toBeVisible()
  await info.attach("resumen-del-caso", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversation.id}`))
  // «Ver el caso» está en «…» de la conversación: el único botón principal es el del tema.
  await page.getByRole("button", { name: "Más acciones de la conversación" }).click()
  await page.getByRole("menuitem", { name: "Ver el caso" }).click()
  await expect(page.getByRole("dialog", { name: conversation.contact.displayName })).toContainText("Lo que ya se sabe")
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await info.attach("resumen-del-caso-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.setViewportSize({ width: 1280, height: 720 })

  // El número del caso va en «Inicio» del menú (ADR 0123).
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(page.getByRole("navigation").getByRole("link", { name: "Inicio", exact: true }).locator("..")).toContainText(/persona/)

  // El caso vive en «Te espera» de Inicio: una fila con quién lo pasó, hace cuánto y en su grupo.
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const waiting = page.getByRole("region", { name: /^Te espera/ })
  const caseRow = waiting.getByRole("listitem").filter({ hasText: conversation.contact.displayName })
  await expect(caseRow).toHaveCount(1)
  await expect(caseRow).toContainText("Te lo pasó Sofi")
  // El grupo lo dice con palabra además de color: prioridad alta es «Ahora».
  await expect(waiting.getByRole("heading", { name: /^Ahora/ })).toBeVisible()
  await info.attach("derivacion-te-espera", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // «Responder» abre el panel sin entrar a la conversación.
  await caseRow.getByRole("button", { name: /^Responder/ }).click()
  const fromRow = surface(page, { name: conversation.contact.displayName })
  await expect(fromRow).toContainText("Saber si puede venir hoy y darle una hora.")
  await expect(fromRow.getByRole("link", { name: "Ver toda la conversación" })).toBeVisible()
  await fromRow.getByRole("button", { name: "Cerrar", exact: true }).first().click()
  await expect(fromRow).toBeHidden()
  // Tomar el tema sigue en la Bandeja: toma el tema, no la conversación.
  await call(page, "POST", `/api/workspace/topics/${handoff.id}/take`, org.slug)

  const persisted = await call<Array<{ id: string; assigneeUserId: string | null }>>(
    page,
    "GET",
    `/api/agent/handoffs?conversationId=${conversation.id}`,
    org.slug,
  )
  expect(persisted.find(item => item.id === handoff.id)?.assigneeUserId).toBeTruthy()
})

test("crm ventas: un «hola» no crea oportunidad; mover una no mueve las otras; cerrar pide el motivo de la lista", async ({
  owner,
  nextEventId,
}, info) => {
  const { page, org } = owner
  const tg = await createTelegramConnection(page, org.slug)
  const tgUser = nextEventId()
  expect(
    await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
      fromId: tgUser,
      chatId: tgUser,
      text: "Hola",
      updateId: nextEventId(),
    }),
  ).toBe(200)
  const conversation = await waitForConversation(page, org.slug, tg.id)
  await waitForInboundText(page, org.slug, conversation.id, "Hola")
  const contactId = conversation.contact.id
  const person = conversation.contact.displayName
  // Un saludo no es un interés: no hay oportunidad «Seguimiento · …».
  expect(await call<unknown[]>(page, "GET", `/api/opportunities?contactId=${contactId}`, org.slug)).toEqual([])
  const pipes = await call<{ stages: { id: string; name: string; moment: string }[] }[]>(page, "GET", "/api/pipelines", org.slug)
  expect(pipes[0]?.stages.map((stage) => stage.name)).toEqual(["Interesado", "Evaluación agendada", "Presupuesto enviado", "Decidió"])

  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  await page.getByRole("button", { name: "Nueva oportunidad" }).click()
  const dialog = surface(page, { name: "Nueva oportunidad", exact: true })
  // Un solo buscador de personas: se escribe y se elige.
  await dialog.getByRole("combobox", { name: "Persona interesada", exact: true }).fill(person)
  await page.getByRole("option", { name: new RegExp(person) }).first().click()
  await dialog.getByLabel("Qué le interesa", { exact: true }).fill("Evaluación de ortodoncia")
  await dialog.getByRole("button", { name: "Crear", exact: true }).click()
  // Al crearla se abre al lado: nace en «Interesado», en Recepción hasta que alguien la tome.
  const opened = surface(page, { name: `${person} · «Evaluación de ortodoncia»`, exact: true })
  await expect(opened).toContainText("Interesado")
  await expect(opened).toContainText("Recepción · sin persona asignada")
  await opened.getByRole("button", { name: "Cerrar", exact: true }).click()
  const cardName = `${person} · Evaluación de ortodoncia`
  await expect(page.getByRole("button", { name: cardName, exact: true })).toBeVisible()
  await call(page, "POST", "/api/opportunities", org.slug, { contactId, title: "Control preventivo" }, 201)
  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  const destination = page.getByRole("region", { name: "Paso Evaluación agendada", exact: true })
  const origin = page.getByRole("region", { name: "Paso Interesado", exact: true })
  const handle = page.getByRole("button", { name: "Arrastrar Evaluación de ortodoncia", exact: true })
  async function dragToEvaluation() {
    await expect(handle).toBeEnabled()
    await handle.scrollIntoViewIfNeeded()
    await handle.hover()
    const sourceBox = await handle.boundingBox()
    const targetBox = await destination.boundingBox()
    if (!sourceBox || !targetBox) throw new Error("El tablero no ofrece un destino visible")
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 120, { steps: 20 })
    await expect(destination.getByText("Soltar en Evaluación agendada", { exact: true })).toBeVisible()
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
    await dragToEvaluation()
    await expect(destination.getByRole("button", { name: cardName, exact: true })).toBeVisible()
    await expect(origin.getByRole("button", { name: cardName, exact: true })).toHaveCount(0)
  } finally {
    responseGate.resolve()
  }
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(origin.getByRole("button", { name: cardName, exact: true })).toBeVisible()
  await page.unroute("**/api/opportunities/*/move")
  const saved = page.waitForResponse(response => response.url().endsWith("/move") && response.request().method() === "POST" && response.status() === 200)
  await dragToEvaluation()
  await saved

  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  await expect(destination.getByRole("button", { name: cardName })).toBeVisible()
  // La tarjeta dice por qué está ahí.
  await expect(destination.getByRole("article", { name: cardName })).toContainText(/La movió .+ hoy/)
  await expect(origin.getByRole("button", { name: `${person} · Control preventivo` })).toBeVisible()

  // «Mover a…» es la vía con teclado; cerrar pide el motivo de la lista.
  await page.getByRole("button", { name: "Acciones de Control preventivo", exact: true }).click()
  await page.getByRole("menuitem", { name: "Perdida", exact: true }).click()
  const closing = page.getByRole("alertdialog", { name: "Perdida: Control preventivo" })
  // Sin motivo no se deshabilita: al confirmar, el motivo dice qué falta.
  await closing.getByRole("button", { name: "Marcar perdida" }).click()
  await expect(closing.getByText("Elige por qué se perdió.")).toBeVisible()
  await closing.getByRole("radio", { name: "Precio" }).check()
  await closing.getByRole("button", { name: "Marcar perdida" }).click()
  await expect(closing).toBeHidden()
  // «Decidió» se divide en Ganadas y Perdidas: la pérdida cae en su columna con su motivo.
  const lost = page.getByRole("region", { name: "Paso Perdidas", exact: true })
  await expect(lost.getByRole("article", { name: `${person} · Control preventivo` })).toContainText("Perdida: «Precio»")

  const closed = await call<{ id: string }>(page, "POST", "/api/opportunities", org.slug, {
    contactId, title: "Tratamiento cerrado",
  }, 201)
  await call(page, "POST", `/api/opportunities/${closed.id}/close`, org.slug, { outcome: "won", reason: "acepto" })
  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  const won = page.getByRole("region", { name: "Paso Ganadas", exact: true })
  await expect(won.getByRole("button", { name: `${person} · Tratamiento cerrado`, exact: true })).toBeVisible()
  await info.attach("tablero-ganadas-y-perdidas", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  const closedCard = page.getByRole("button", { name: `${person} · Tratamiento cerrado`, exact: true })
  await expect(closedCard).toBeAttached()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await closedCard.scrollIntoViewIfNeeded()
  await expect(closedCard).toBeVisible()
  // La ruta antigua de la oportunidad abre el tablero con ella al lado.
  await gotoHydrated(page, tenant(org.slug, `/opportunities/${closed.id}`))
  await expect(page).toHaveURL(tenantPattern(org.slug, `/pipeline?oportunidad=${closed.id}`))
  await expect(surface(page, { name: `${person} · «Tratamiento cerrado»`, exact: true })).toContainText("Ganada")
})

test("crm ventas: Ganadas y Perdidas son las dos mitades de «Decidió»; ambas se ven a la vez", async ({
  owner,
  nextEventId,
}, info) => {
  const { page, org } = owner
  const tg = await createTelegramConnection(page, org.slug)
  const tgUser = nextEventId()
  expect(
    await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
      fromId: tgUser,
      chatId: tgUser,
      text: "Hola",
      updateId: nextEventId(),
    }),
  ).toBe(200)
  const conversation = await waitForConversation(page, org.slug, tg.id)
  const contactId = conversation.contact.id
  const person = conversation.contact.displayName
  await call(page, "POST", "/api/opportunities", org.slug, { contactId, title: "Para perder" }, 201)
  await call(page, "POST", "/api/opportunities", org.slug, { contactId, title: "Para ganar" }, 201)
  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  // Cada mitad de «Decidió» está lista cuando ya cargó sus datos.
  await expect(page.getByRole("region", { name: "Paso Ganadas", exact: true }).getByText("Nada decidido en los últimos 30 días")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("region", { name: "Paso Perdidas", exact: true }).getByText("Nada decidido en los últimos 30 días")).toBeVisible({ timeout: 30_000 })

  // «Acciones» → «Perdida» pide el motivo antes de cerrar.
  await page.getByRole("button", { name: "Acciones de Para perder", exact: true }).click()
  await page.getByRole("menuitem", { name: "Perdida", exact: true }).click()
  const losing = page.getByRole("alertdialog", { name: "Perdida: Para perder" })
  await losing.getByRole("radio", { name: "Precio" }).check()
  await losing.getByRole("button", { name: "Marcar perdida" }).click()
  await expect(losing).toBeHidden()

  await page.getByRole("button", { name: "Acciones de Para ganar", exact: true }).click()
  await page.getByRole("menuitem", { name: "Ganada", exact: true }).click()
  const winning = page.getByRole("alertdialog", { name: "Ganada: Para ganar" })
  await winning.getByRole("button", { name: "Marcar ganada", exact: true }).click()
  await expect(winning).toBeHidden()

  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  const won = page.getByRole("region", { name: "Paso Ganadas", exact: true })
  const lost = page.getByRole("region", { name: "Paso Perdidas", exact: true })
  await expect(won.getByRole("article", { name: `${person} · Para ganar` })).toContainText("Ganada", { timeout: 30_000 })
  await expect(lost.getByRole("article", { name: `${person} · Para perder` })).toContainText("Perdida: «Precio»")
  // Las dos mitades están en la misma columna: se ven juntas, una arriba y otra abajo.
  await won.scrollIntoViewIfNeeded()
  await expect(won).toBeInViewport()
  await expect(lost).toBeInViewport()
  await info.attach("tablero-ganadas-y-perdidas-en-una-columna", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
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

test("reserva por enlace: la persona elige su cita viendo los horarios libres, sin precios, y queda en la agenda", async ({
  owner,
  nextEventId,
  fixtureDb,
}, info) => {
  const { page, org } = owner
  await call(page, "POST", "/api/agenda/rooms", org.slug, { branchId: owner.branchId, name: "Unidad dental 1" }, 201)
  // Ya es paciente y le falta un dato que la clínica necesita: su fecha de nacimiento (con el registro de siempre,
  // lo demás que la ficha no tiene es opcional).
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: "Eva Rojas", givenNames: "Eva", familyName: "Rojas", docType: "DNI", docNumber: "45678902", phone: "+51987650302" },
      respondent: "staff",
      privacyAccepted: false,
    },
  }, 201)
  // Tres personas atienden: con «Cualquiera», la fila de «¿Con quién?» no cabe en el teléfono y se desliza.
  const milagros = `${org.id}-milagros`
  const silvia = `${org.id}-silvia`
  const colleagues = [milagros, silvia]
  await fixtureDb.insert(user).values([
    { id: milagros, name: "Dra. Milagros Díaz", email: `${milagros}@crm.test`, emailVerified: true },
    { id: silvia, name: "Dra. Silvia Rojas", email: `${silvia}@crm.test`, emailVerified: true },
  ])
  await fixtureDb.insert(member).values(colleagues.map((userId) => ({ id: randomUUID(), organizationId: org.id, userId, role: "clinician", createdAt: new Date() })))
  for (const professionalUserId of [owner.user.id, ...colleagues]) {
    await call(page, "PUT", "/api/agenda/schedules", org.slug, {
      branchId: owner.branchId,
      professionalUserId,
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 7 * 60, endMin: 22 * 60 })),
    }, 200)
  }
  const tg = await createTelegramConnection(page, org.slug)
  const tgUser = nextEventId()
  expect(await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, { fromId: tgUser, chatId: tgUser, text: "Quiero una cita", updateId: nextEventId() })).toBe(200)
  const conversation = await waitForConversation(page, org.slug, tg.id)

  // Quien escribe ya es paciente: su ficha está vinculada a esta persona (sin ese vínculo no hay enlace).
  await call(page, "PUT", `/api/patients/${patient.id}/contacts/${conversation.contact.id}`, org.slug, { relationship: "self", isPreferred: true }, 200)
  // El enlace que entrega el agente: del enlace solo se guarda la huella.
  const token = randomBytes(32).toString("hex")
  await fixtureDb.insert(appointmentBookingLink).values({
    organizationId: org.id,
    conversationId: conversation.id,
    contactId: conversation.contact.id,
    patientId: patient.id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 3_600_000),
  })

  // Teléfono: con quién y cuándo, en una sola pantalla.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, `/reserva?token=${token}`))
  await expect(page.getByRole("heading", { level: 1, name: "Reserva tu cita" })).toBeVisible()
  // Una sola sede: dos pasos, con quién y cuándo, y revisar.
  await expect(page.getByText(/Paso 1 de 2 · Con quién y cuándo/)).toBeVisible()
  await expect(page.getByRole("heading", { name: "¿Con quién?" })).toBeVisible()
  await expect(page.getByRole("button", { name: /^Cualquiera/ })).toBeVisible()
  // Lo que no cabe se desliza dentro de su fila: la página no se ensancha.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  // Los 7 días siguientes siempre tienen horarios: los de hoy dependen de la hora en que corre la prueba.
  await page.getByRole("button", { name: "Los 7 días siguientes", exact: true }).click()
  const slots = page.getByRole("group", { name: /Mañana|Tarde/ }).first()
  await expect(slots.getByRole("button").first()).toBeVisible()
  // La página no muestra tarifas.
  expect(await page.locator("body").innerText()).not.toMatch(/S\/|precio|tarifa/i)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await slots.getByRole("button").first().click()
  // El botón que avanza queda fijo abajo y dice el horario elegido.
  const continueTo = page.getByRole("button", { name: /^Continuar · / })
  await expect(continueTo).toBeInViewport()
  await info.attach("reserva-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // Web: la misma página, con «Tu cita» al lado; se puede elegir otra hora ahí mismo.
  await page.setViewportSize({ width: 1280, height: 800 })
  const summary = page.getByRole("complementary", { name: "Tu cita" })
  await expect(summary).toContainText("Consulta")
  await page.getByRole("group", { name: /Mañana|Tarde/ }).last().getByRole("button").first().click()
  await info.attach("reserva-web", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await summary.getByRole("button", { name: "Continuar", exact: true }).click()

  // «Revisa y reserva»: lo que ya sabemos de ella (el documento abreviado) y solo lo que falta.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("heading", { name: "Revisa y reserva" })).toBeVisible()
  await expect(page.getByText(/Paso 2 de 2 · Revisa y reserva/)).toBeVisible()
  // Es para ella misma: «Para Eva» solo se dice cuando la cita es de otra persona (su hijo, por ejemplo).
  await expect(page.getByRole("region", { name: "Tu cita" })).toContainText("Consulta")
  await expect(page.getByRole("region", { name: "Tu cita" })).not.toContainText("Para Eva")
  const yourData = page.getByRole("region", { name: "Tus datos" })
  await expect(yourData).toContainText("Eva Rojas")
  await expect(yourData).toContainText("DNI ••••8902")
  await expect(yourData).not.toContainText("45678902")
  await expect(page.getByText("Nos falta un dato:", { exact: true })).toBeVisible()
  // Si el nombre de su ficha no es el suyo, lo corrige ahí mismo: con su documento entero, porque el enlace prueba su chat, no quién es.
  await yourData.getByRole("button", { name: "Corregir tu nombre" }).click()
  await expect(yourData.getByLabel("Nombres")).toHaveValue("Eva")
  await expect(yourData.getByLabel("Apellidos")).toHaveValue("Rojas")
  await yourData.getByLabel("Nombres").fill("Eva María")
  await yourData.getByLabel("Tu DNI completo").fill("45678902")
  await expect(page.getByText(/^Te escribiremos por WhatsApp al .+ sobre esta cita: la confirmación, los recordatorios y los cambios\.$/)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  // Sin lo que falta no reserva: lo dice junto a cada campo y lleva el foco al primero.
  const reserve = page.getByRole("button", { name: "Reservar mi cita", exact: true })
  await expect(reserve).toBeInViewport()
  await reserve.click()
  await expect(page.getByText("Escribe tu fecha de nacimiento")).toBeVisible()
  await expect(page.getByText("Elige una opción")).toBeVisible()
  await expect(page.getByLabel("Fecha de nacimiento")).toBeFocused()
  await page.getByLabel("Fecha de nacimiento").fill("14/02/1990")
  // Novedades y promociones: nunca respondió, se pregunta sin nada marcado.
  await expect(page.getByRole("radio", { name: "Sí, quiero" })).not.toBeChecked()
  await expect(page.getByRole("radio", { name: "No, gracias" })).not.toBeChecked()
  await page.getByRole("radio", { name: "Sí, quiero" }).click()
  await info.attach("reserva-revisa-paciente", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await reserve.click()
  // Lo que eligió ella misma queda confirmado: no se le pide «Confirmar» después.
  await expect(page.getByRole("heading", { name: "Tu cita quedó reservada" })).toBeVisible()
  await expect(page.getByText("Te lo confirmamos también por el chat.")).toBeVisible()
  await expect(page.getByRole("region", { name: "Tu cita" })).toContainText("Confirmada")
  await expect(page.getByRole("button", { name: "Confirmar", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Añadir al calendario" })).toBeVisible()
  // Ya no le falta ningún dato; su salud queda como opcional.
  await expect(page.getByRole("region", { name: "Tu salud" })).toContainText("Opcional")
  await info.attach("reserva-lista", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // Queda en la agenda como cualquier cita, con su origen, y la confirmación va a la conversación.
  const rows = await fixtureDb.select().from(appointment).where(eq(appointment.patientId, patient.id))
  expect(rows.map((row) => [row.status, row.source, row.conversationId])).toEqual([["confirmada", "enlace", conversation.id]])
  // Lo que faltaba y lo que aceptó se guardó en el mismo paso: su fecha, los mensajes de su cita y las novedades.
  const saved = await call<{ patient: { birthDate: string | null; displayName: string } }>(page, "GET", `/api/patients/${patient.id}`, org.slug)
  expect(saved.patient.birthDate).toBe("1990-02-14")
  expect(saved.patient.displayName).toBe("Eva María Rojas")
  const permissions = await fixtureDb.select().from(automationConsent).where(eq(automationConsent.contactId, conversation.contact.id))
  expect(permissions.map((row) => [row.purpose, row.status])).toEqual(
    expect.arrayContaining([
      ["recordatorio", "granted"],
      ["novedades", "granted"],
    ]),
  )
  const confirmations = await fixtureDb.select().from(agentProposal).where(eq(agentProposal.conversationId, conversation.id))
  expect(confirmations.filter((row) => row.action === "enviar_mensaje").map((row) => String((row.payload as { text?: string }).text))).toEqual([
    expect.stringMatching(/^Listo: tu cita quedó para el /),
  ])

  // «Añadir al calendario» baja el archivo que arma el servidor: el mismo evento que el del correo (issue 46).
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Añadir al calendario" }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe("cita.ics")
  const ics = (await readFile((await file.path())!, "utf8")).replace(/\r\n /g, "")
  expect(ics).toContain(`UID:${rows[0]!.id}@odentia`)
  expect(ics).toContain("SEQUENCE:0")
  expect(ics).toMatch(/\r\nDTSTART;TZID=[^:]+:\d{8}T\d{6}\r\n/)
  expect(ics).toMatch(/\r\nSUMMARY:Cita en [^\r]+\r\n/)
  expect(ics).not.toContain("Consulta")

  // El enlace no reserva dos veces: al volver es «Su enlace», con «Tu cita», y desde ahí se cambia o se cancela.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, `/reserva?token=${token}`))
  const yourAppointment = page.getByRole("region", { name: "Tu cita" })
  await expect(yourAppointment).toBeVisible()
  const firstStart = rows[0]!.startsAt.toISOString()
  await yourAppointment.getByRole("button", { name: "Cambiar", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Cambia tu cita" })).toBeVisible()
  // Una semana más allá: otra hora, siempre libre, distinta de la que tiene.
  await page.getByRole("button", { name: "Los 7 días siguientes", exact: true }).click()
  await page.getByRole("group", { name: /Mañana|Tarde/ }).first().getByRole("button").first().click()
  // En teléfono el botón que avanza queda fijo abajo y dice el horario elegido.
  const changeTo = page.getByRole("button", { name: /^Continuar · / })
  await expect(changeTo).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await info.attach("reserva-cambiar-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await changeTo.click()
  await expect(page.getByRole("heading", { name: "Revisa el cambio" })).toBeVisible()
  await expect(page.getByText("Es la misma cita en otro horario: no se crea otra.", { exact: false })).toBeVisible()
  // Ya respondió lo de novedades al reservar: no se le vuelve a preguntar.
  await expect(page.getByRole("radio", { name: "Sí, quiero" })).toHaveCount(0)
  await page.getByRole("button", { name: "Cambiar mi cita", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Tu cita quedó cambiada" })).toBeVisible()
  const movedRows = await fixtureDb.select().from(appointment).where(eq(appointment.patientId, patient.id))
  // Es la misma cita, y sigue confirmada.
  expect(movedRows.map((row) => [row.id, row.status])).toEqual([[rows[0]!.id, "confirmada"]])
  expect(movedRows[0]!.startsAt.toISOString()).not.toBe(firstStart)

  await yourAppointment.getByRole("button", { name: "Cancelar", exact: true }).click()
  await page.getByRole("alertdialog", { name: "¿Cancelar tu cita?" }).getByRole("button", { name: "Sí, cancelar" }).click()
  await expect(page.getByRole("heading", { name: "Tu cita quedó cancelada" })).toBeVisible()
  await info.attach("reserva-cancelada-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  expect((await fixtureDb.select().from(appointment).where(eq(appointment.patientId, patient.id))).map((row) => row.status)).toEqual(["cancelada"])
  await gotoHydrated(page, tenant(org.slug, `/reserva?token=${"0".repeat(64)}`))
  await expect(page.getByText("Este enlace ya no sirve")).toBeVisible()
})

test("contactos nuevos: cada fila dice cómo llegó y en qué está", async ({ owner, nextEventId }) => {
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
  const person = conversation.contact.displayName
  // Quien registró el equipo no tiene canal de entrada: la fila lo dice.
  await call(page, "POST", "/api/people", org.slug, { givenNames: "Rosa", familyName: "Quispe", phone: "+51987654100" }, 201)

  await gotoHydrated(page, tenant(org.slug, "/people"))
  await page.getByRole("tab", { name: /^Contactos nuevos/ }).click()
  for (const header of ["Cómo llegó", "En qué está", "Siguiente paso"]) {
    await expect(page.getByRole("columnheader", { name: header, exact: true })).toBeVisible()
  }
  // Quien escribió por Telegram: su canal, y «Nueva» porque llegó hace menos de una semana.
  const fromTelegram = page.getByRole("row", { name: person })
  await expect(fromTelegram).toContainText("Telegram ·")
  await expect(fromTelegram).toContainText("Nueva")
  await expect(page.getByRole("row", { name: /Rosa Quispe/ })).toContainText("Lo registró el equipo")
})

test("crm ventas: «Movidas por el agente» deja solo las que movió el agente", async ({ owner, nextEventId, fixtureDb }) => {
  const { page, org } = owner
  const tg = await createTelegramConnection(page, org.slug)
  const tgUser = nextEventId()
  expect(
    await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
      fromId: tgUser,
      chatId: tgUser,
      text: "Hola",
      updateId: nextEventId(),
    }),
  ).toBe(200)
  const conversation = await waitForConversation(page, org.slug, tg.id)
  const contactId = conversation.contact.id
  const person = conversation.contact.displayName
  await call(page, "POST", "/api/opportunities", org.slug, { contactId, title: "Hecha por la clínica" }, 201)
  const moved = await call<{ id: string }>(page, "POST", "/api/opportunities", org.slug, { contactId, title: "Movida por el agente" }, 201)
  // El agente deja su marca en el historial, como al mover una oportunidad (origen «agente»).
  await fixtureDb.insert(opportunityEvent).values({ organizationId: org.id, opportunityId: moved.id, action: "opportunity.moved", origin: "agente" })

  await gotoHydrated(page, tenant(org.slug, "/pipeline"))
  const byHand = page.getByRole("button", { name: `${person} · Hecha por la clínica`, exact: true })
  const byAgent = page.getByRole("button", { name: `${person} · Movida por el agente`, exact: true })
  await expect(byHand).toBeVisible()
  await expect(byAgent).toBeVisible()

  await page.getByRole("button", { name: /^Quién lo movió/ }).click()
  await page.getByRole("option", { name: "Movidas por el agente", exact: true }).click()
  await expect(byAgent).toBeVisible()
  await expect(byHand).toHaveCount(0)

  // Al elegir, el filtro pasa a «Más filtros»; «Limpiar» lo quita y vuelve a mostrar todas.
  await page.getByRole("button", { name: "Limpiar", exact: true }).click()
  await expect(byHand).toBeVisible()
  await expect(byAgent).toBeVisible()
})
