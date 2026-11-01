import { randomUUID } from "node:crypto"
import { agentProposal } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, tenant, tenantPattern } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

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

test("agente sin panel: el caso en Inicio, la cita en «Esperan su sí» y lo hecho en Actividad", async ({
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

  // Desde Inicio: el único número del menú va aquí (cuenta el caso, no la cita) y no hay botón «Agente» en la cabecera.
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(page.locator("header").getByRole("button", { name: /^Agente/ })).toHaveCount(0)
  const nav = page.getByRole("navigation")
  const homeEntry = nav.getByRole("link", { name: "Inicio", exact: true }).locator("..")
  await expect(homeEntry).toContainText("1 persona espera")
  await expect(nav.getByRole("link", { name: "Agente", exact: true }).locator("..")).not.toContainText("1")
  await info.attach("inicio-con-numero", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // «Te espera» trae el caso una sola vez (ni su tarea ni su conversación son otra fila);
  // no hay nada del agente que aprobar ni la cita del paciente.
  const home = page.getByRole("region", { name: /^Te espera/ })
  const caseRow = home.getByRole("listitem").filter({ hasText: "Pide hablar con una persona" })
  await expect(caseRow).toHaveCount(1)
  await expect(caseRow).toContainText("Te lo pasó Sofi")
  await expect(home).not.toContainText("espera tu aprobación")
  await expect(home).not.toContainText("Cita el jueves a las 10:00")

  // «Tomar este tema» se hace en la fila, sin salir de Inicio.
  await caseRow.getByRole("button", { name: /^Tomar este tema/ }).click()
  await expect(caseRow.getByRole("button", { name: /^Tomar este tema/ })).toHaveCount(0)
  await expect
    .poll(async () => {
      const open = await call<Array<{ id: string; status: string }>>(page, "GET", "/api/agent/handoffs?open=1", org.slug)
      return open.find((h) => h.id === handoff.id)?.status
    })
    .toBe("tomada")
  // Tomado no es resuelto: el caso sigue en la lista y contando para quien lo tomó hasta que lo resuelve.
  await expect(caseRow).toHaveCount(1)
  await expect(homeEntry).toContainText("1 persona espera")

  // Issue 93: donde cabe la columna, Avisos se abre en ella sin tapar la página y Esc devuelve el foco a la campana.
  await page.setViewportSize({ width: 1680, height: 900 })
  const bell = page.getByRole("button", { name: /^Avisos/ })
  await bell.click()
  const noticesColumn = page.getByRole("complementary", { name: "Avisos" })
  await expect(noticesColumn).toBeVisible()
  await expect(noticesColumn.getByRole("heading", { name: "Avisos" })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
  await info.attach("avisos-columna", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
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
  // Con el menú en íconos el número no cabe: queda un punto sobre el icono de Inicio.
  const dot = homeEntry.locator("span[aria-hidden]")
  await expect(dot).toBeVisible()
  await info.attach("menu-contraido", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  const after = await expand.boundingBox()
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(8)
  await page.keyboard.press("Control+b")
  await expect(collapse).toBeVisible()
  await expect(dot).toBeHidden()

  // Actividad: una pestaña de Agente, legible, con la cita propuesta; lo humano no aparece.
  await nav.getByRole("link", { name: "Agente", exact: true }).click()
  const tabs = page.getByRole("navigation", { name: "Secciones del agente" })
  await tabs.getByRole("link", { name: "Actividad", exact: true }).click()
  await expect(page).toHaveURL(/\/agent\/actividad/)
  await expect(page.getByText("Propuso reservar una cita")).toBeVisible()
  await expect(page.getByRole("listitem").filter({ hasText: "Propuso reservar una cita" }).getByText("pendiente", { exact: true })).toBeVisible()
  await expect(page.getByText("Pide hablar con una persona")).toHaveCount(0)
  await info.attach("actividad", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // La ficha de paciente no usa PageHeader: en el teléfono el número sigue sobre el icono del menú.
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
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}`))
  await expect(page.locator("main").getByText("1 persona espera")).toBeAttached()
  await page.setViewportSize({ width: 1440, height: 900 })

  // «Esperan su sí» se retiró (ADR 0118): la cita propuesta se ve en su conversación, y la dirección vieja lleva a la Bandeja.
  await gotoHydrated(page, tenant(org.slug, "/agent/pendientes"))
  await expect(page).toHaveURL(tenantPattern(org.slug, "/inbox"))
  // Nadie decide por el paciente: no hay ruta para aprobar o rechazar.
  const decision = await api(page, "POST", `/api/agent/proposals/${randomUUID()}/decision`, org.slug, { decision: "aprobada" })
  expect(decision.status).toBe(404)

  // Móvil: el número va sobre el icono del menú, que plegado es lo único que se ve.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const menu = page.getByRole("button", { name: "Alternar menú lateral" })
  const menuBox = await menu.boundingBox()
  const number = page.locator("main").getByText("1 persona espera")
  await expect(number).toBeVisible()
  const numberBox = await number.boundingBox()
  expect(numberBox!.x).toBeGreaterThanOrEqual(menuBox!.x - 1)
  expect(numberBox!.x + numberBox!.width).toBeLessThanOrEqual(menuBox!.x + menuBox!.width + 1)
  expect(numberBox!.y).toBeGreaterThanOrEqual(menuBox!.y - 1)
  expect(numberBox!.y + numberBox!.height).toBeLessThanOrEqual(menuBox!.y + menuBox!.height + 1)
  // El menú ⋯ ya no trae «Agente».
  await page.locator("header").getByRole("button", { name: "Más opciones", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Agente", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await info.attach("numero-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // Un caso se pasa o se resuelve desde su resumen, sin ir a la Bandeja.
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await caseRow.getByRole("button").first().click()
  const brief = surface(page, { name: "Resumen del caso" })
  await expect(brief).toBeVisible()
  await expect(page).toHaveURL(/\/home/)
  // Dice lo mismo que su fila y quién lo tiene.
  await expect(brief).toContainText("Ahora")
  await expect(brief).toContainText("Lo tienes tú")
  await brief.getByRole("button", { name: "Pasar este tema a…" }).click()
  await expect(page.getByRole("dialog", { name: "Pasar este tema a…" })).toContainText("Pide hablar con una persona")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Pasar este tema a…" })).toBeHidden()
  await brief.getByRole("button", { name: "Marcar resuelto" }).click()
  await expect(brief).toBeHidden()
  await expect(page).toHaveURL(/\/home/)
  await expect(caseRow).toHaveCount(0)
  const stillOpen = await call<Array<{ id: string }>>(page, "GET", "/api/agent/handoffs?open=1", org.slug)
  expect(stillOpen.map((h) => h.id)).not.toContain(handoff.id)
})

test("Actividad del agente: recepción la ve, otros roles no y el servidor lo niega", async ({
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
  // y se puede reintentar; después, la pestaña funciona.
  await setRole("reception")
  expect((await api(page, "GET", "/api/agent/summary", org.slug)).status).toBe(200)
  expect((await api(page, "GET", "/api/agent/activity", org.slug)).status).toBe(200)
  await page.route("**/api/agent/activity**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  )
  await gotoHydrated(page, tenant(org.slug, "/agent/actividad"))
  // La consulta reintenta sola ante un 503 antes de decirlo.
  await expect(page.getByRole("alert")).toContainText("No pudimos cargar la información", { timeout: 20_000 })
  await page.unroute("**/api/agent/activity**")
  await page.getByRole("button", { name: "Reintentar" }).click()
  await expect(page.getByText("Sin actividad")).toBeVisible()
  const tabs = page.getByRole("navigation", { name: "Secciones del agente" })
  await expect(tabs.getByRole("link")).toHaveText(["Actividad"])

  // Odontología y caja: sin entrada en el sidebar y 403 en servidor; el número de Inicio sí les responde.
  for (const role of ["clinician", "cashier"]) {
    await setRole(role)
    await gotoHydrated(page, tenant(org.slug, "/home"))
    expect((await api(page, "GET", "/api/workspace/waiting", org.slug)).status).toBe(200)
    await expect(page.getByRole("navigation").getByRole("link", { name: "Agente", exact: true })).toHaveCount(0)
    for (const path of ["/api/agent/summary", "/api/agent/activity", "/api/agent/handoffs?open=1"]) {
      expect((await api(page, "GET", path, org.slug)).status, `${role} ${path}`).toBe(403)
    }
  }
})
