import { randomUUID } from "node:crypto"
import { agentProposal } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, tenant, tenantPattern } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

interface Conversation {
  id: string
  contact: { id: string; displayName: string }
  connection: { id: string }
}

async function conversationFor(
  page: Page,
  slug: string,
  connectionId: string,
): Promise<Conversation> {
  await expect
    .poll(
      async () =>
        (await call<Conversation[]>(page, "GET", "/api/conversations", slug)).find(
          (c) => c.connection.id === connectionId,
        )?.id ?? "",
      { timeout: 30_000 },
    )
    .not.toBe("")
  const found = (await call<Conversation[]>(page, "GET", "/api/conversations", slug)).find(
    (c) => c.connection.id === connectionId,
  )
  if (!found) throw new Error("La conversación del bot no apareció tras el inbound")
  return found
}

/** Botón de cabecera; el sidebar tiene otro «Agente» (grupo colapsable). */
function agentButton(page: Page) {
  return page.locator("header").getByRole("button", { name: /^Agente/ })
}

test("panel del agente: decidir, tomar derivadas y ver actividad desde cualquier pantalla", async ({
  owner,
  fixtureDb,
  nextEventId,
}, info) => {
  const { page, org } = owner
  const tg = await call<{ id: string; webhookSecret: string }>(
    page,
    "POST",
    "/api/channels/connections",
    org.slug,
    {
      channel: "telegram",
      provider: "telegram_bot_api",
      displayName: "Bot E2E",
      config: { botToken: "e2e" },
    },
    201,
  )
  const tgUser = nextEventId()
  expect(
    await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
      fromId: tgUser,
      chatId: tgUser,
      text: "Quiero una cita",
      updateId: nextEventId(),
    }),
  ).toBe(200)
  const conversation = await conversationFor(page, org.slug, tg.id)
  // Lo que espera la decisión del equipo: un seguimiento vencido sin
  // conversación (plantilla anclada al contacto), como lo deja `createProposal`
  // con `requireTeamDecision`. En un hilo los mensajes salen directo (ADR 0021).
  // La fila se inserta como la registraría el agente (proposed_by=agent); la
  // lógica de propuesta se cubre en services.
  await fixtureDb.insert(agentProposal).values({
    organizationId: org.id,
    contactId: conversation.contact.id,
    conversationId: null,
    action: "enviar_mensaje",
    payload: { kind: "template", name: "seguimiento_presupuesto", language: "es_PE" },
    afterSummary: "Plantilla seguimiento_presupuesto",
    reason: "Seguimiento vencido sin conversación.",
    idempotencyKey: randomUUID(),
  })
  // Derivación hecha por una persona: entra en Derivadas (sigue abierta) pero
  // no es actividad del agente.
  const handoff = await call<{ id: string }>(
    page,
    "POST",
    "/api/agent/handoffs",
    org.slug,
    {
      conversationId: conversation.id,
      reason: "Pide hablar con una persona",
      summary: "Prefiere atención humana.",
      priority: "alta",
    },
    201,
  )

  // Desde Inicio: botón, badge del sidebar y panel sobre la página.
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const button = agentButton(page)
  await expect(button).toHaveAccessibleName("Agente, 1 por decidir")
  const sidebarAgent = page.getByRole("navigation").getByRole("link", { name: "Agente", exact: true })
  await expect(sidebarAgent.locator("..")).toContainText("1")
  await button.click()
  const panel = page.getByRole("dialog", { name: "Agente" })
  await expect(panel).toBeVisible()
  await expect(panel.getByText(/Activo|Pausado/)).toBeVisible()
  await expect(panel.getByRole("tab", { name: "Por decidir · 1", exact: true })).toBeVisible()
  await expect(panel.getByText("Enviar mensaje", { exact: true })).toBeVisible()
  // La página sigue montada debajo (el cajón modal la saca del árbol accesible, no del DOM).
  await expect(page.locator("h1", { hasText: "Inicio" })).toHaveCount(1)
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toHaveCount(0)
  await info.attach("panel-por-decidir", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  })

  // Rechazar pide el motivo; cambiar de pestaña no lo pierde.
  await panel.getByRole("button", { name: "Rechazar…" }).click()
  const reason = panel.getByLabel("Motivo del rechazo")
  await reason.fill("Ya lo confirmó recepción por teléfono")
  await panel.getByRole("tab", { name: /^Derivadas/ }).click()
  await panel.getByRole("tab", { name: /^Por decidir/ }).click()
  await expect(reason).toHaveValue("Ya lo confirmó recepción por teléfono")
  await panel.getByRole("button", { name: "Confirmar rechazo" }).click()
  await expect(panel.getByRole("status")).toContainText("Propuesta rechazada")
  // El contador baja en la pestaña (botón y sidebar se comprueban al cerrar:
  // bajo el cajón modal quedan fuera del árbol accesible).
  await expect(panel.getByRole("tab", { name: "Por decidir", exact: true })).toBeVisible()
  await expect(panel.getByText("Nada por decidir")).toBeVisible()

  // Derivadas: solo las abiertas; tomar el caso la deja con responsable sin sacarla de la lista.
  await panel.getByRole("tab", { name: /^Derivadas/ }).click()
  const item = panel.getByRole("listitem").filter({ hasText: "Pide hablar con una persona" })
  await expect(item).toContainText("En cola por recoger")
  await item.getByRole("button", { name: "Tomar caso" }).click()
  await expect(item).toContainText("Responsable asignado")
  await expect(item.getByRole("button", { name: "Tomar caso" })).toHaveCount(0)
  const persisted = await call<Array<{ id: string; status: string }>>(
    page,
    "GET",
    "/api/agent/handoffs?open=1",
    org.slug,
  )
  expect(persisted.find((h) => h.id === handoff.id)?.status).toBe("tomada")

  // Actividad: legible, con el desenlace de la propuesta; lo humano no aparece.
  await panel.getByRole("tab", { name: "Actividad" }).click()
  const activity = panel.getByRole("tabpanel", { name: "Actividad" })
  await expect(activity.getByText("Preparó un mensaje")).toBeVisible()
  await expect(activity.getByText("rechazada", { exact: true })).toBeVisible()
  await expect(activity.getByText("Pide hablar con una persona")).toHaveCount(0)

  // Esc cierra el cajón sin cambiar de página y devuelve el foco al botón.
  await page.keyboard.press("Escape")
  await expect(panel).toBeHidden()
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
  await expect(button).toBeFocused()
  // Sin pendientes: el botón pierde el contador y el sidebar su badge.
  await expect(button).toHaveAccessibleName("Agente")
  await expect(sidebarAgent.locator("..")).not.toContainText("1")

  // La ficha de paciente no usa PageHeader: el botón sigue disponible.
  const patient = await call<{ id: string }>(
    page,
    "POST",
    "/api/patients",
    org.slug,
    {
      submissionId: randomUUID(),
      answers: {
        demographics: { displayName: "Paciente Panel" },
        respondent: "staff",
        privacyAccepted: false,
      },
      contacts: [],
    },
    201,
  )
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}`))
  await expect(agentButton(page)).toBeVisible()

  // Trabajo proactivo: propuesta sin hilo (seguimiento vencido) anclada al
  // contacto y a su oportunidad; el caso que se abre es la oportunidad. Aunque
  // en un hilo los mensajes salen directo, sin hilo decide el equipo.
  const opportunity = await call<{ id: string }>(
    page,
    "POST",
    "/api/opportunities",
    org.slug,
    { contactId: conversation.contact.id, title: "Ortodoncia sin hilo" },
    201,
  )
  await fixtureDb.insert(agentProposal).values({
    organizationId: org.id,
    contactId: conversation.contact.id,
    conversationId: null,
    action: "enviar_mensaje",
    payload: {
      kind: "template",
      name: "seguimiento_presupuesto",
      language: "es_PE",
      opportunityId: opportunity.id,
    },
    afterSummary: "Plantilla seguimiento_presupuesto",
    reason: "Seguimiento vencido sin conversación (Ortodoncia sin hilo).",
    idempotencyKey: randomUUID(),
  })
  // Inicio la ofrece al equipo, no como espera del interlocutor.
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const homeCard = page.getByRole("region", { name: "Te espera" }).getByRole("listitem").filter({ hasText: "Plantilla seguimiento_presupuesto" })
  await expect(homeCard).toContainText("El agente espera tu aprobación")
  await expect(homeCard.getByRole("button", { name: /Revisar$/ })).toBeVisible()
  // Aprobaciones permite decidirla y abre la oportunidad como caso.
  await gotoHydrated(page, tenant(org.slug, "/agent/approvals"))
  const approvalCard = page.getByRole("listitem").filter({ hasText: "Ortodoncia sin hilo" })
  await expect(approvalCard.getByRole("button", { name: "Revisar y aprobar" })).toBeVisible()
  await expect(approvalCard.getByRole("link", { name: "Abrir oportunidad" })).toBeVisible()
  // Desde el panel, «Abrir oportunidad» navega al caso y el cajón se cierra.
  await agentButton(page).click()
  const desktopCold = panel.getByRole("listitem").filter({ hasText: "Ortodoncia sin hilo" })
  await expect(desktopCold).toContainText("Espera tu aprobación")
  await desktopCold.getByRole("link", { name: "Abrir oportunidad" }).click()
  await expect(page).toHaveURL(tenantPattern(org.slug, `/opportunities/${opportunity.id}`))
  await expect(panel).toBeHidden()

  // Móvil: el mismo cajón que los formularios (hoja inferior a casi toda la pantalla).
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await agentButton(page).click()
  const mobilePanel = page.getByRole("dialog", { name: "Agente" })
  await expect(mobilePanel).toBeVisible()
  const box = await mobilePanel.boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(370)
  expect(box?.height).toBeGreaterThanOrEqual(800)
  await expect(mobilePanel.getByRole("tab", { name: "Por decidir · 1", exact: true })).toBeVisible()
  const cold = mobilePanel.getByRole("listitem").filter({ hasText: "Ortodoncia sin hilo" })
  await expect(cold).toContainText("Espera tu aprobación")
  await expect(cold.getByRole("link", { name: "Abrir oportunidad" })).toBeVisible()
  await expect(cold.getByRole("link", { name: /Abrir caso|Abrir conversación/ })).toHaveCount(0)
  await info.attach("panel-movil", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  })
  await mobilePanel.getByRole("button", { name: "Cerrar el panel del agente" }).click()
  await expect(mobilePanel).toBeHidden()
  await expect(agentButton(page)).toBeFocused()
})

test("panel del agente: recepción decide, otros roles no lo ven y el servidor lo niega", async ({
  owner,
  fixtureDb,
}) => {
  const { page, org } = owner
  const setRole = (role: string) =>
    fixtureDb
      .update(member)
      .set({ role })
      .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await page.setViewportSize({ width: 1440, height: 900 })

  // Recepción: agent.decide sin agent.read. Primero, el error de carga se dice
  // y se puede reintentar; después, el panel funciona.
  await setRole("reception")
  expect((await api(page, "GET", "/api/agent/panel", org.slug)).status).toBe(200)
  expect((await api(page, "GET", "/api/agent/activity", org.slug)).status).toBe(200)
  await page.route("**/api/agent/proposals**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  )
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await agentButton(page).click()
  const panel = page.getByRole("dialog", { name: "Agente" })
  await expect(panel.getByRole("alert")).toContainText("No pudimos cargar las propuestas")
  await page.unroute("**/api/agent/proposals**")
  await panel.getByRole("button", { name: "Volver a intentar" }).click()
  await expect(panel.getByText("Nada por decidir")).toBeVisible()
  await panel.getByRole("tab", { name: "Actividad" }).click()
  await expect(panel.getByText("Sin actividad")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(panel).toBeHidden()

  // Odontología y caja: sin botón, sin entrada en el sidebar y 403 en servidor.
  for (const role of ["dentist", "cashier"]) {
    await setRole(role)
    await gotoHydrated(page, tenant(org.slug, "/home"))
    await expect(agentButton(page)).toHaveCount(0)
    await expect(page.getByRole("navigation").getByRole("link", { name: "Agente", exact: true })).toHaveCount(0)
    for (const path of ["/api/agent/panel", "/api/agent/activity", "/api/agent/handoffs?open=1"]) {
      expect((await api(page, "GET", path, org.slug)).status, `${role} ${path}`).toBe(403)
    }
  }
})
