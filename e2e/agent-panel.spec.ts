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
      professionalUserId: owner.user.id,
      roomId: randomUUID(),
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

  // Desde Inicio: el número del caso va en el botón que abre el panel donde se toma (ADR 0118), no
  // en el menú, que cuenta lo que se resuelve dentro de Agente.
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const button = agentButton(page)
  await expect(button).toHaveAccessibleName("Agente: 1 caso por tomar")
  await expect(button).toContainText("1")
  await button.click()
  const panel = page.getByRole("dialog", { name: "Agente" })
  await expect(panel).toBeVisible()
  await expect(panel.getByText(/Activo|Pausado/)).toBeVisible()
  await expect(panel.getByRole("tab", { name: "Casos del agente", exact: true })).toBeVisible()
  await expect(panel.getByRole("tab", { name: "Esperan al paciente · 1", exact: true })).toBeVisible()
  // Issue 92: cada pestaña cabe en su caja y ninguna pisa a la siguiente.
  const tabs = await panel.getByRole("tab").evaluateAll((items) =>
    items.map((item) => {
      const box = item.getBoundingClientRect()
      return { left: box.left, right: box.right, fits: item.scrollWidth <= item.clientWidth + 1 }
    }),
  )
  expect(tabs).toHaveLength(3)
  for (const [index, tab] of tabs.entries()) {
    expect(tab.fits).toBe(true)
    if (index > 0) expect(tab.left).toBeGreaterThanOrEqual(tabs[index - 1]!.right - 1)
  }
  // La página sigue montada debajo (el cajón modal la saca del árbol accesible, no del DOM).
  await expect(page.locator("h1", { hasText: "Inicio" })).toHaveCount(1)
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toHaveCount(0)

  // Abre en «Casos del agente»: «Tomar este tema» lo deja con responsable sin sacarlo de la lista ni tomar la conversación.
  const item = panel.getByRole("listitem").filter({ hasText: "Pide hablar con una persona" })
  await expect(item).toContainText("Nadie lo ha tomado")
  await info.attach("panel-derivadas", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  })
  await item.getByRole("button", { name: "Tomar este tema", exact: true }).click()
  await expect(item).toContainText("Ya lo tomaron")
  await expect(item.getByRole("button", { name: "Tomar este tema", exact: true })).toHaveCount(0)
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

  // Issue 93: donde cabe la columna, Avisos se abre en ella como el Agente, sin tapar la
  // página; abrir uno cierra el otro y Esc devuelve el foco a la campana.
  await page.setViewportSize({ width: 1680, height: 900 })
  const bell = page.getByRole("button", { name: /^Avisos/ })
  await bell.click()
  const noticesColumn = page.getByRole("complementary", { name: "Avisos" })
  await expect(noticesColumn).toBeVisible()
  await expect(noticesColumn.getByRole("heading", { name: "Avisos" })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
  await info.attach("avisos-columna", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await button.click()
  const agentColumn = page.getByRole("complementary", { name: "Agente" })
  await expect(agentColumn).toBeVisible()
  await expect(noticesColumn).toHaveCount(0)
  await bell.click()
  await expect(noticesColumn).toBeVisible()
  await expect(agentColumn).toHaveCount(0)
  await noticesColumn.getByRole("heading", { name: "Avisos" }).click()
  await page.keyboard.press("Escape")
  await expect(noticesColumn).toHaveCount(0)
  await expect(bell).toBeFocused()
  await page.setViewportSize({ width: 1440, height: 900 })

  // Issue 105: el mismo icono de panel lateral contrae y expande, en el mismo sitio y con su atajo.
  const collapse = page.getByRole("button", { name: "Contraer el panel lateral" })
  await expect(collapse).toBeVisible()
  const before = await collapse.boundingBox()
  await collapse.click()
  const expand = page.getByRole("button", { name: "Expandir el panel lateral" })
  await expect(expand).toBeVisible()
  await expect(expand).toHaveAttribute("aria-keyshortcuts", /Control\+B/)
  await info.attach("menu-contraido", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  const after = await expand.boundingBox()
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(8)
  await page.keyboard.press("Control+b")
  await expect(collapse).toBeVisible()
  // Tomado no es resuelto: el caso sigue contando para quien lo tomó hasta que lo resuelve.
  await expect(agentButton(page)).toHaveAccessibleName("Agente: 1 caso por tomar")
  // «Te espera» trae el caso una sola vez (ni su tarea ni su conversación son otra fila);
  // no hay nada del agente que aprobar ni la cita del paciente.
  const home = page.getByRole("region", { name: /^Te espera/ })
  await expect(home.getByRole("listitem").filter({ hasText: "Te lo pasó Sofi" })).toContainText("Pide hablar con una persona")
  await expect(home.getByRole("listitem").filter({ hasText: "Pide hablar con una persona" })).toHaveCount(1)
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

  // «Esperan su sí» se retiró (ADR 0118): la cita propuesta se ve en su conversación y en
  // este panel, y la dirección vieja lleva a la Bandeja.
  await gotoHydrated(page, tenant(org.slug, "/agent/pendientes"))
  await expect(page).toHaveURL(tenantPattern(org.slug, "/inbox"))
  // Nadie decide por el paciente: no hay ruta para aprobar o rechazar.
  const decision = await api(page, "POST", `/api/agent/proposals/${randomUUID()}/decision`, org.slug, { decision: "aprobada" })
  expect(decision.status).toBe(404)

  // Móvil: el mismo cajón que los formularios (hoja inferior a casi toda la pantalla).
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  // En el teléfono «Agente» no cabe en la fila: va en el menú ⋯ (issue 220).
  await expect(agentButton(page)).toBeHidden()
  const moreButton = page.locator("header").getByRole("button", { name: "Más opciones", exact: true })
  await moreButton.click()
  // En el teléfono el número de casos va junto a la opción.
  await page.getByRole("menuitem", { name: "Agente 1 caso por tomar", exact: true }).click()
  const mobilePanel = page.getByRole("dialog", { name: "Agente" })
  await expect(mobilePanel).toBeVisible()
  const box = await mobilePanel.boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(370)
  expect(box?.height).toBeGreaterThanOrEqual(800)
  await expect(mobilePanel.getByRole("tab", { name: "Casos del agente", exact: true })).toBeVisible()
  await mobilePanel.getByRole("tab", { name: /^Esperan al paciente/ }).click()
  const cold = mobilePanel.getByRole("listitem").filter({ hasText: "Cita el jueves a las 10:00" })
  await expect(cold.getByRole("link", { name: "Abrir conversación" })).toBeVisible()
  await info.attach("panel-movil", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  })
  await mobilePanel.getByRole("button", { name: "Cerrar el panel del agente" }).click()
  await expect(mobilePanel).toBeHidden()
  await expect(moreButton).toBeFocused()
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
  await expect(panel.getByText("Ningún caso del agente espera")).toBeVisible()
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
  for (const role of ["clinician", "cashier"]) {
    await setRole(role)
    await gotoHydrated(page, tenant(org.slug, "/home"))
    await expect(agentButton(page)).toHaveCount(0)
    await expect(page.getByRole("navigation").getByRole("link", { name: "Agente", exact: true })).toHaveCount(0)
    for (const path of ["/api/agent/panel", "/api/agent/activity", "/api/agent/handoffs?open=1"]) {
      expect((await api(page, "GET", path, org.slug)).status, `${role} ${path}`).toBe(403)
    }
  }
})
