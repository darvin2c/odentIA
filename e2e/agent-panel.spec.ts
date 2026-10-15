import { randomUUID } from "node:crypto"
import { agentProposal } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, tenant } from "./env"
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

test("panel del agente: casos que esperan a una persona, citas que esperan al paciente y actividad, desde cualquier pantalla", async ({
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
  // Ninguna propuesta espera al equipo (ADR 0023): lo único pendiente es la cita
  // que el paciente confirma en su conversación. La fila se inserta como la
  // registraría el agente (proposed_by=agent); la lógica se cubre en services.
  await fixtureDb.insert(agentProposal).values({
    organizationId: org.id,
    contactId: conversation.contact.id,
    conversationId: conversation.id,
    action: "reservar_cita",
    payload: {
      patientId: randomUUID(),
      dentistUserId: owner.user.id,
      chairId: randomUUID(),
      startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    },
    afterSummary: "Cita el jueves a las 10:00",
    idempotencyKey: randomUUID(),
  })
  // Lo que espera a una persona: un caso derivado (hecho por una persona: no es
  // actividad del agente).
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

  // Desde Inicio: botón, badge del sidebar y panel sobre la página. Cuentan el caso, no la cita.
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const button = agentButton(page)
  await expect(button).toHaveAccessibleName("Agente, 1 por atender")
  const sidebarAgent = page.getByRole("navigation").getByRole("link", { name: "Agente", exact: true })
  await expect(sidebarAgent.locator("..")).toContainText("1")
  await button.click()
  const panel = page.getByRole("dialog", { name: "Agente" })
  await expect(panel).toBeVisible()
  await expect(panel.getByText(/Activo|Pausado/)).toBeVisible()
  await expect(panel.getByRole("tab", { name: "Derivadas · 1", exact: true })).toBeVisible()
  await expect(panel.getByRole("tab", { name: "Esperan al paciente · 1", exact: true })).toBeVisible()
  // La página sigue montada debajo (el cajón modal la saca del árbol accesible, no del DOM).
  await expect(page.locator("h1", { hasText: "Inicio" })).toHaveCount(1)
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toHaveCount(0)

  // Abre en Derivadas: tomar el caso lo deja con responsable sin sacarlo de la lista.
  const item = panel.getByRole("listitem").filter({ hasText: "Pide hablar con una persona" })
  await expect(item).toContainText("En cola por recoger")
  await info.attach("panel-derivadas", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  })
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

  // Esperan al paciente: la cita se ve y se abre su conversación; nadie la aprueba ni la rechaza.
  await panel.getByRole("tab", { name: /^Esperan al paciente/ }).click()
  const waiting = panel.getByRole("listitem").filter({ hasText: "Cita el jueves a las 10:00" })
  await expect(waiting).toContainText("Espera al paciente")
  await expect(waiting).toContainText("Reservar cita")
  await expect(waiting.getByRole("link", { name: "Abrir conversación" })).toBeVisible()
  await expect(panel.getByRole("button", { name: /Revisar y aprobar|Rechazar/ })).toHaveCount(0)

  // Actividad: legible, con la cita propuesta; lo humano no aparece.
  await panel.getByRole("tab", { name: "Actividad" }).click()
  const activity = panel.getByRole("tabpanel", { name: "Actividad" })
  await expect(activity.getByText("Propuso reservar una cita")).toBeVisible()
  await expect(activity.getByText("pendiente", { exact: true })).toBeVisible()
  await expect(activity.getByText("Pide hablar con una persona")).toHaveCount(0)

  // Esc cierra el cajón sin cambiar de página y devuelve el foco al botón.
  await page.keyboard.press("Escape")
  await expect(panel).toBeHidden()
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
  await expect(button).toBeFocused()
  // Tomado no es resuelto: el caso sigue contando hasta que alguien lo resuelve.
  await expect(button).toHaveAccessibleName("Agente, 1 por atender")
  // «Te espera» trae el caso; no hay nada del agente que aprobar ni la cita del paciente.
  const home = page.getByRole("region", { name: "Te espera" })
  // La derivación deja además su tarea: el caso es la fila que dice de dónde viene.
  await expect(home.getByRole("listitem").filter({ hasText: "Caso que pasó el agente" })).toContainText("Pide hablar con una persona")
  await expect(home).not.toContainText("espera tu aprobación")
  await expect(home).not.toContainText("Cita el jueves a las 10:00")

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

  // Aprobaciones: primero los casos; la cita aparte, con solo registrar la confirmación del paciente.
  await gotoHydrated(page, tenant(org.slug, "/agent/approvals"))
  await expect(page.getByRole("heading", { name: "Casos que pasó a tu equipo" })).toBeVisible()
  const approvalCard = page.getByRole("listitem").filter({ hasText: "Cita el jueves a las 10:00" })
  await expect(approvalCard).toContainText("Espera al paciente")
  await expect(approvalCard.getByRole("button", { name: "Registrar confirmación del interlocutor" })).toBeVisible()
  await expect(page.getByRole("button", { name: /Revisar y aprobar|Rechazar/ })).toHaveCount(0)
  // Nadie decide por el paciente: no hay ruta para aprobar o rechazar.
  const decision = await api(page, "POST", `/api/agent/proposals/${randomUUID()}/decision`, org.slug, { decision: "aprobada" })
  expect(decision.status).toBe(404)

  // Móvil: el mismo cajón que los formularios (hoja inferior a casi toda la pantalla).
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await agentButton(page).click()
  const mobilePanel = page.getByRole("dialog", { name: "Agente" })
  await expect(mobilePanel).toBeVisible()
  const box = await mobilePanel.boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(370)
  expect(box?.height).toBeGreaterThanOrEqual(800)
  await expect(mobilePanel.getByRole("tab", { name: "Derivadas · 1", exact: true })).toBeVisible()
  await mobilePanel.getByRole("tab", { name: /^Esperan al paciente/ }).click()
  const cold = mobilePanel.getByRole("listitem").filter({ hasText: "Cita el jueves a las 10:00" })
  await expect(cold.getByRole("link", { name: "Abrir conversación" })).toBeVisible()
  await info.attach("panel-movil", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  })
  await mobilePanel.getByRole("button", { name: "Cerrar el panel del agente" }).click()
  await expect(mobilePanel).toBeHidden()
  await expect(agentButton(page)).toBeFocused()
})

test("panel del agente: recepción lo ve, otros roles no lo ven y el servidor lo niega", async ({
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
  await expect(panel.getByText("Sin derivaciones abiertas")).toBeVisible()
  await panel.getByRole("tab", { name: /^Esperan al paciente/ }).click()
  await expect(panel.getByRole("alert")).toContainText("No pudimos cargar lo que espera al paciente")
  await page.unroute("**/api/agent/proposals**")
  await panel.getByRole("button", { name: "Volver a intentar" }).click()
  await expect(panel.getByText("Nada espera al paciente")).toBeVisible()
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
