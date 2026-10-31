import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { agentProposal } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, tenant } from "./env"
import { api, call, expect, type OwnerFixture, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

interface Conversation {
  id: string
  contact: { id: string }
  preview: { body: string | null } | null
  attention: {
    pendingContact: number
    handoffPriority: string | null
    agentAttending: boolean
    awaitingPatientSince: string | null
    assignedName: string | null
  }
  closure: { reason: string; at: string; byName: string | null } | null
}

const WAITING_TEXT = "Quiero una cita para mañana"
const DERIVED_TEXT = "Necesito hablar con una persona"

async function conversationWith(page: Page, slug: string, text: string): Promise<Conversation> {
  const find = async () =>
    (await call<Conversation[]>(page, "GET", "/api/conversations", slug)).find((c) => c.preview?.body === text)
  await expect.poll(async () => (await find())?.id ?? "", { timeout: 30_000 }).not.toBe("")
  const found = await find()
  if (!found) throw new Error(`No apareció la conversación «${text}»`)
  return found
}

/**
 * Dos hilos de Telegram: en uno el agente propuso una cita que espera el sí del
 * paciente y en el otro derivó con prioridad alta. Ninguna propuesta espera al
 * equipo (ADR 0023): lo que espera a una persona es el caso derivado. Las
 * propuestas se insertan como las registraría el agente; es el límite de esta
 * evidencia y su lógica se cubre en services.
 */
async function seedThreads(owner: OwnerFixture, fixtureDb: Db, nextEventId: () => number) {
  const { page, org } = owner
  const tg = await call<{ id: string; webhookSecret: string }>(page, "POST", "/api/channels/connections", org.slug, {
    channel: "telegram", provider: "telegram_bot_api", displayName: "Bot E2E", config: { botToken: "e2e" },
  }, 201)
  for (const text of [WAITING_TEXT, DERIVED_TEXT]) {
    const user = nextEventId()
    expect(await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, { fromId: user, chatId: user, text, updateId: nextEventId() })).toBe(200)
  }
  const waiting = await conversationWith(page, org.slug, WAITING_TEXT)
  const derived = await conversationWith(page, org.slug, DERIVED_TEXT)
  // Una cita que el agente propuso en el hilo: espera el sí del paciente.
  const proposeAppointment = async (conversation: Conversation, summary: string) => {
    const [row] = await fixtureDb.insert(agentProposal).values({
      organizationId: org.id, contactId: conversation.contact.id, conversationId: conversation.id, action: "reservar_cita",
      payload: { patientId: randomUUID(), professionalUserId: owner.user.id, roomId: randomUUID(), startsAt: "2026-11-03T15:00:00.000Z" },
      afterSummary: summary, reason: "El interlocutor pidió una cita", idempotencyKey: randomUUID(),
    }).returning({ id: agentProposal.id })
    if (!row) throw new Error("No se pudo sembrar la propuesta")
    return row.id
  }
  const firstAppointment = await proposeAppointment(waiting, "Cita el martes 3 de noviembre a las 10:00")
  await call(page, "POST", "/api/agent/handoffs", org.slug, {
    conversationId: derived.id, reason: "Pide hablar con una persona", summary: "Prefiere atención humana.", priority: "alta",
  }, 201)
  return { waiting, derived, firstAppointment, proposeAppointment }
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test("bandeja: el estado del agente por conversación, las vistas con su total y la banda del hilo", async ({
  owner,
  fixtureDb,
  nextEventId,
}, info) => {
  const { page, org } = owner
  const { waiting, derived, firstAppointment, proposeAppointment } = await seedThreads(owner, fixtureDb, nextEventId)

  // El servidor cuenta las vistas sobre todo lo filtrado y describe cada hilo.
  // Cuatro vistas que no se superponen (ADR 0050): el caso derivado es un tema «Por atender»
  // y la cita propuesta espera al paciente.
  expect(await call(page, "GET", "/api/conversations/summary", org.slug)).toEqual({
    open: 2, attend: 1, agent: 0, awaitingPatient: 1, closed: 0, spam: 0,
  })
  const listed = await call<Conversation[]>(page, "GET", "/api/conversations?view=attend", org.slug)
  expect(listed.map((c) => c.id)).toEqual([derived.id])
  expect(listed[0]?.attention.handoffPriority).toBe("alta")
  expect(listed[0]?.closure).toBeNull()
  // Las vistas retiradas ya no existen: el servidor las rechaza.
  for (const retired of ["human", "approval", "handoff", "unanswered", "team"]) {
    expect((await api(page, "GET", `/api/conversations?view=${retired}`, org.slug)).status).toBe(400)
  }
  const waitingAttention = (await call<{ attention: Conversation["attention"] }>(page, "GET", `/api/conversations/${waiting.id}`, org.slug)).attention
  expect(waitingAttention).toMatchObject({ pendingContact: 1 })
  // Nada de lo que propone el agente espera al equipo.
  expect(waitingAttention).not.toHaveProperty("pendingTeam")

  await page.setViewportSize({ width: 1440, height: 900 })
  // Una vista sin pestaña en la URL no filtra a escondidas: queda «Por atender».
  const chip = (name: string) => page.getByRole("tab", { name, exact: true })
  for (const hidden of ["human", "team"]) {
    await gotoHydrated(page, tenant(org.slug, `/inbox?view=${hidden}`))
    await expect(chip("Por atender 1")).toHaveAttribute("aria-selected", "true")
  }
  await expect(chip("Las atiende Sofi 0")).toHaveAttribute("aria-selected", "false")
  await expect(chip("Esperan al paciente 1")).toBeVisible()
  await expect(chip("Cerradas 0")).toBeVisible()
  const waitingRow = page.getByRole("button").filter({ hasText: "Espera su sí" })
  const derivedRow = page.getByRole("button").filter({ hasText: DERIVED_TEXT })
  // Cada fila dice en qué está con palabras del servidor, no solo con color; con un tema, la pregunta.
  // El caso lo abrió una persona por la API: es un tema sin tomar, no «Te lo pasó Sofi».
  await expect(derivedRow).toContainText(`Ahora · «${DERIVED_TEXT}»`)
  await expect(waitingRow).toHaveCount(0)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("bandeja", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // La vista filtra en servidor y queda en la URL.
  await chip("Esperan al paciente 1").click()
  await expect(waitingRow).toBeVisible()
  await expect(waitingRow).toContainText("Espera su sí")
  await expect(derivedRow).toHaveCount(0)
  await expect(page).toHaveURL(/view=awaiting_patient/)
  await chip("Las atiende Sofi 0").click()
  await expect(page).toHaveURL(/view=agent/)
  await expect(waitingRow).toHaveCount(0)
  await expect(derivedRow).toHaveCount(0)
  await chip("Esperan al paciente 1").click()

  // La tarjeta del hilo dice qué propuso el agente y que espera el sí. El panel
  // del agente, en «Esperan al paciente», pone primero lo de este hilo.
  await waitingRow.click()
  const card = page.getByRole("article", { name: "Sofi propuso una cita" })
  await expect(card).toContainText("Espera su sí")
  await expect(card).toContainText(/Espera el sí de \S+ en esta conversación\./)
  await info.attach("hilo-con-tarjeta", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await proposeAppointment(derived, "Cita el miércoles 4 de noviembre a las 11:00")
  await page.locator("header").getByRole("button", { name: /^Agente/ }).click()
  await page.getByRole("dialog", { name: "Agente" }).getByRole("tab", { name: /^Esperan al paciente/ }).click()
  const panel = page.getByRole("dialog", { name: "Agente" })
  await expect(panel.getByRole("tab", { name: /^Esperan al paciente/ })).toHaveAttribute("aria-selected", "true")
  const cards = panel.getByRole("tabpanel").getByRole("listitem")
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText("De esta conversación")
  await expect(cards.first()).toContainText("Espera al paciente")
  await expect(cards.first()).toContainText("Cita el martes 3 de noviembre a las 10:00")
  await expect(cards.first().getByRole("link", { name: /Abrir caso|Abrir conversación/ })).toHaveCount(0)
  // Lo que espera al paciente no lo decide el equipo: el panel no ofrece aprobar ni rechazar.
  await expect(cards.first().getByRole("button")).toHaveCount(0)
  await expect(cards.nth(1)).not.toContainText("De esta conversación")
  await expect(cards.nth(1).getByRole("link", { name: "Abrir conversación" })).toBeVisible()
  await info.attach("panel-de-esta-conversacion", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.keyboard.press("Escape")
  await expect(panel).toBeHidden()
  // Sin el sí del paciente, la propuesta caduca a las 48 horas: la tarjeta dice
  // que venció. La conversación sigue esperando al paciente porque lo último lo dijo
  // el agente, hasta que el agente se despida y la cierre (ADR 0024).
  await fixtureDb.update(agentProposal).set({ createdAt: new Date(Date.now() - 49 * 3_600_000) }).where(eq(agentProposal.id, firstAppointment))
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${waiting.id}`))
  await expect(page.getByRole("article", { name: "Sofi propuso una cita" })).toContainText("Venció")
  // Vencida la cita y sin el agente atendiendo, su mensaje queda «Por atender».
  await expect(chip("Por atender 2")).toBeVisible()

  // Inicio: el caso derivado es una fila de «Te espera». Lo que espera al
  // paciente no está ahí, y no hay nada del agente que aprobar (ADR 0023).
  await proposeAppointment(waiting, "Cita el martes 3 de noviembre a las 10:00")
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const pending = page.getByRole("region", { name: "Te espera" })
  // Un caso, una fila: ni su tarea ni su conversación se repiten.
  const homeCase = pending.getByRole("listitem").filter({ hasText: "Te lo pasó Sofi" })
  await expect(homeCase).toContainText("Pide hablar con una persona")
  await expect(pending).not.toContainText("espera tu aprobación")
  await expect(pending).not.toContainText("Cita el martes 3 de noviembre")
  // En teléfono las filas son las mismas.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(homeCase).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("inicio-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  // La fila del caso abre su resumen, sin salir de Inicio.
  await homeCase.getByRole("button", { name: /Ver el caso$/ }).click()
  await expect(page.getByRole("heading", { name: "Resumen del caso" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("heading", { name: "Resumen del caso" })).toBeHidden()

  // Bandeja en móvil: una vista por vez; con el hilo abierto ceden la pantalla vistas y filtros.
  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  await expect(chip("Por atender 1")).toBeVisible()
  await expect(derivedRow).toContainText("Ahora")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("bandeja-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await derivedRow.click()
  await expect(page.getByRole("region", { name: "Lo que te toca contestar" })).toBeVisible()
  await expect(chip("Por atender 1")).toBeHidden()
  await expect(page.getByRole("searchbox", { name: /Nombre, teléfono/ })).toHaveCount(0)
  await info.attach("hilo-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.getByRole("button", { name: "Volver" }).click()
  await expect(chip("Por atender 1")).toBeVisible()
})

test("panel del agente: columna fija en pantalla grande y cajón cuando no cabe", async ({
  owner,
  fixtureDb,
  nextEventId,
}, info) => {
  const { page, org } = owner
  await seedThreads(owner, fixtureDb, nextEventId)
  const button = page.locator("header").getByRole("button", { name: /^Agente/ })
  const column = page.getByRole("complementary", { name: "Agente" })
  const drawer = page.getByRole("dialog", { name: "Agente" })

  // Pantalla grande: columna a la derecha; la página sigue en el árbol accesible y usable.
  await page.setViewportSize({ width: 1600, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await button.click()
  await expect(column).toBeVisible()
  await expect(drawer).toHaveCount(0)
  await expect(column).toBeFocused()
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
  const box = await column.boundingBox()
  expect(box?.width).toBe(384)
  expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(1600)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("columna-inicio", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // El ancho se ajusta con el tirador (teclado y arrastre) y se recuerda; el
  // tope deja a la página el ancho que tiene con la columna por defecto.
  const grip = column.getByRole("separator", { name: "Ancho del panel del agente" })
  const columnWidth = async () => Math.round((await column.boundingBox())?.width ?? 0)
  await grip.focus()
  await page.keyboard.press("ArrowLeft")
  await page.keyboard.press("ArrowLeft")
  await expect(grip).toHaveAttribute("aria-valuenow", "416")
  await expect.poll(columnWidth).toBe(416)
  await page.keyboard.press("End")
  // 1600 de ventana − 256 de sidebar − 848 de página.
  await expect(grip).toHaveAttribute("aria-valuenow", "496")
  await expect.poll(columnWidth).toBe(496)
  await page.mouse.move(1600 - 496, 450)
  await page.mouse.down()
  await page.mouse.move(1600 - 340, 450, { steps: 4 })
  await page.mouse.up()
  await expect.poll(columnWidth).toBe(340)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await button.click()
  await expect.poll(columnWidth).toBe(340)

  // No tapa la página: se navega con ella abierta y sigue ahí.
  await page.getByRole("navigation").getByRole("link", { name: "Bandeja", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Bandeja" })).toBeVisible()
  await expect(column).toBeVisible()

  // En la Bandeja ocupa el lugar de «Contexto»; en «Esperan al paciente» lo del
  // hilo abierto va primero.
  await page.getByRole("tab", { name: "Esperan al paciente 1", exact: true }).click()
  await page.getByRole("button").filter({ hasText: "Espera su sí" }).click()
  const context = page.getByRole("button", { name: "Contexto", exact: true })
  await expect(context).toHaveAttribute("aria-pressed", "false")
  await column.getByRole("tab", { name: /^Esperan al paciente/ }).click()
  await expect(column.getByRole("tabpanel").getByRole("listitem").first()).toContainText("De esta conversación")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("columna-bandeja", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // Pedir «Contexto» cierra la columna y lo abre.
  await context.click()
  await expect(column).toHaveCount(0)
  await expect(context).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("region", { name: "Contexto del contacto" })).toBeVisible()
  // El botón la vuelve a abrir; Esc dentro de la columna la cierra y devuelve el foco.
  await button.click()
  await expect(column).toBeVisible()
  await expect(context).toHaveAttribute("aria-pressed", "false")
  await page.keyboard.press("Escape")
  await expect(column).toHaveCount(0)
  await expect(button).toBeFocused()
  await expect(context).toHaveAttribute("aria-pressed", "true")

  // Estrechar la ventana con la columna abierta la convierte en cajón.
  await button.click()
  await expect(column).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(column).toHaveCount(0)
  await expect(drawer).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(drawer).toBeHidden()
})

test("bandeja: quien no decide por el agente ve el estado del hilo, no la propuesta", async ({
  owner,
  fixtureDb,
  nextEventId,
}) => {
  const { page, org } = owner
  await seedThreads(owner, fixtureDb, nextEventId)
  // Odontología conversa con pacientes pero no tiene permisos del agente.
  await fixtureDb.update(member).set({ role: "clinician" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  await expect(page.getByRole("button").filter({ hasText: DERIVED_TEXT })).toContainText("Ahora")
  await gotoHydrated(page, tenant(org.slug, "/inbox?view=awaiting_patient"))
  const waitingRow = page.getByRole("button").filter({ hasText: "Espera su sí" })
  await expect(waitingRow).toContainText("Espera su sí")
  await waitingRow.click()
  // Sabe que Sofi propuso algo, no qué: la línea no dice la cita ni ofrece registrar nada.
  await expect(page.getByText(/Sofi propuso una cita ·/)).toBeVisible()
  await expect(page.getByRole("article", { name: "Sofi propuso una cita" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Registrar confirmación" })).toHaveCount(0)
  await expect(page.locator("header").getByRole("button", { name: /^Agente/ })).toHaveCount(0)
  expect((await api(page, "GET", "/api/agent/proposals?status=propuesta", org.slug)).status).toBe(403)
})
