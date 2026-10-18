import { agentAnswerTrace, agentLesson, agentReviewItem, agentRunLedger } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import type { Locator, Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, tenant, tenantPattern } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

interface Conversation {
  id: string
  preview: { body: string | null } | null
}

interface Overview {
  week: { attended: number; corrected: number; passed: number; alone: number }
  learned: { officialAnswers: number; rules: number; examples: number; latest: { title: string } | null }
  provider: { problem: string | null }
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

async function box(locator: Locator) {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error("El elemento no está en pantalla")
  return rect
}

/**
 * El Resumen con datos: tres conversaciones atendidas (una sola, una derivada
 * y una corregida) y tres lecciones aprobadas. Las corridas, la respuesta
 * corregida y las lecciones se insertan como las deja el sistema: sin un
 * proveedor real no hay corrida que las genere. Es el límite de esta
 * evidencia; cómo se cuentan se cubre en services.
 */
test("agente: el resumen dice cómo le fue, qué aprendió y qué pasa cuando no puede responder", async ({
  owner,
  fixtureDb,
  nextEventId,
}, info) => {
  const { page, org } = owner
  const overview = () => call<Overview>(page, "GET", "/api/agent/overview", org.slug)
  const tg = await call<{ id: string; webhookSecret: string }>(page, "POST", "/api/channels/connections", org.slug, {
    channel: "telegram", provider: "telegram_bot_api", displayName: "Bot E2E", config: { botToken: "e2e" },
  }, 201)
  const texts = ["La atendió sola", "Pidió una persona", "Hubo que corregirla"]
  for (const text of texts) {
    const user = nextEventId()
    expect(await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, { fromId: user, chatId: user, text, updateId: nextEventId() })).toBe(200)
  }
  const conversations = async () => {
    const all = await call<Conversation[]>(page, "GET", "/api/conversations", org.slug)
    return texts.map((text) => all.find((c) => c.preview?.body === text)?.id ?? "")
  }
  await expect.poll(async () => (await conversations()).every(Boolean), { timeout: 30_000 }).toBe(true)
  const [alone, passed, corrected] = await conversations()
  if (!alone || !passed || !corrected) throw new Error("No aparecieron las conversaciones")

  const now = new Date()
  await fixtureDb.insert(agentRunLedger).values(
    [alone, passed, corrected].map((conversationId) => ({ organizationId: org.id, conversationId, model: "fake", status: "ok", startedAt: now, llmCalls: 1 })),
  )
  await call(page, "POST", "/api/agent/handoffs", org.slug, {
    conversationId: passed, reason: "Pide hablar con una persona", summary: "Prefiere atención humana.", priority: "media",
  }, 201)
  const [trace] = await fixtureDb.insert(agentAnswerTrace)
    .values({ organizationId: org.id, conversationId: corrected, outcome: "enviada", replyText: "Atendemos los domingos." })
    .returning({ id: agentAnswerTrace.id })
  if (!trace) throw new Error("No se pudo sembrar la respuesta")
  await fixtureDb.insert(agentReviewItem).values({
    organizationId: org.id, conversationId: corrected, traceId: trace.id, reason: "marcada", reply: "Atendemos los domingos.",
    status: "corregida", decidedBy: owner.user.id, decidedAt: now,
  })
  const lesson = (kind: "respuesta_oficial" | "regla" | "ejemplo", title: string, minutesAgo: number) => ({
    organizationId: org.id, kind, title, body: title, status: "activa" as const, proposedBy: owner.user.id,
    approvedBy: owner.user.id, approvedAt: new Date(now.getTime() - minutesAgo * 60_000),
  })
  await fixtureDb.insert(agentLesson).values([
    lesson("respuesta_oficial", "Horario de los sábados", 30),
    lesson("respuesta_oficial", "Formas de pago", 20),
    lesson("ejemplo", "Saludo breve", 10),
    lesson("regla", "No ofrecer citas en domingo.", 1),
  ])
  await call(page, "PUT", "/api/agent/config", org.slug, { enabled: true })
  expect(await overview()).toMatchObject({
    week: { attended: 3, alone: 1, passed: 1, corrected: 1 },
    learned: { officialAnswers: 2, rules: 1, examples: 1, latest: { title: "No ofrecer citas en domingo." } },
    provider: { problem: null },
  })

  // --- Escritorio: las tres fichas, los tres agentes, la semana en tres tramos y lo aprendido ---
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agent"))
  await expect(page.getByRole("heading", { level: 1, name: "Agente" })).toBeVisible()
  const needs = page.getByRole("region", { name: "Necesita de ti" })
  const tiles = needs.getByRole("link")
  await expect(tiles).toHaveCount(3)
  for (const [index, name] of ["Respuestas por revisar", "Lecciones por aprobar", "Preguntas sin respuesta"].entries()) {
    await expect(tiles.nth(index)).toContainText(name)
  }
  // Los casos del agente se cuentan en un solo sitio, el menú (ADR 0025): el resumen no repite «Esperan su sí».
  await expect(needs.getByRole("link", { name: /Esperan su sí|Pendientes/ })).toHaveCount(0)
  const agents = page.getByRole("region", { name: "Tus agentes" })
  await expect(agents).toContainText("La base que comparten los tres")
  const rows = agents.getByRole("listitem")
  // La Ayuda viene con el sistema: no se enciende ni se configura aquí.
  await expect(rows).toHaveCount(3)
  await expect(agents).not.toContainText("Ayuda a usar odentIA")
  const reception = rows.filter({ hasText: "Recepción" })
  await expect(reception.getByRole("link", { name: "Probar" })).toBeVisible()
  await expect(reception.getByRole("link", { name: "Configurar" })).toBeVisible()
  await expect(reception.getByRole("switch", { name: "Apagar Recepción" })).toBeChecked()
  for (const name of ["Asistente clínico", "Administrador"]) {
    const row = rows.filter({ hasText: name })
    await expect(row.getByRole("link", { name: "Ver y encender" })).toBeVisible()
    await expect(row.getByRole("switch")).toHaveCount(0)
  }
  const week = page.getByRole("region", { name: "Cómo le fue esta semana" })
  await expect(week).toContainText("3 conversaciones atendidas")
  await expect(week.getByRole("img", { name: "1 las resolvió sola, 1 las pasó a una persona, 1 se las corregiste" })).toBeVisible()
  for (const label of ["Las resolvió sola", "Las pasó a una persona", "Se las corregiste"]) {
    await expect(week.getByText(label, { exact: true })).toBeVisible()
  }
  const learned = page.getByRole("region", { name: "Lo que aprendió esta semana" })
  await expect(learned.getByRole("listitem").filter({ hasText: "respuestas oficiales nuevas" })).toContainText("2")
  await expect(learned.getByRole("listitem").filter({ hasText: /^1regla$/ })).toBeVisible()
  await expect(learned.getByRole("listitem").filter({ hasText: "ejemplo de buena respuesta" })).toContainText("1")
  await expect(learned).toContainText("La más reciente")
  await expect(learned).toContainText(`«No ofrecer citas en domingo.» La aprobó ${owner.user.name} hoy.`)
  await expect(page.getByText("El agente no puede responder ahora")).toHaveCount(0)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("resumen-escritorio", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await learned.getByRole("link", { name: "Ver todo lo aprendido" }).click()
  await expect(page).toHaveURL(tenantPattern(org.slug, "/agent/learn"))

  // --- Teléfono: fichas de dos en dos, cada agente en una fila que navega y «Pendientes» al final de las pestañas ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agent"))
  await expect(tiles).toHaveCount(3)
  const tileBoxes = await Promise.all([0, 1, 2].map((index) => box(tiles.nth(index))))
  const [first, second, third] = tileBoxes
  if (!first || !second || !third) throw new Error("Faltan fichas")
  expect(Math.abs(first.y - second.y)).toBeLessThan(2)
  expect(third.y).toBeGreaterThan(first.y + first.height - 1)
  expect(Math.abs(first.x - third.x)).toBeLessThan(2)
  expect(second.x).toBeGreaterThan(first.x + first.width - 1)
  for (const tile of tileBoxes) expect(tile.height).toBeGreaterThanOrEqual(44)
  const tabs = page.getByRole("navigation", { name: "Secciones del agente" })
  const tabX = async (name: string) => (await box(tabs.getByRole("link", { name: new RegExp(`^${name}`) }))).x
  const order = [await tabX("Resumen"), await tabX("Aprender"), await tabX("Conocimiento"), await tabX("Esperan su sí")]
  expect(order).toEqual([...order].sort((a, b) => a - b))
  // Una fila por agente, sin botones sueltos ni interruptor: todo eso vive en su página.
  await expect(agents.getByRole("switch")).toHaveCount(0)
  await expect(agents.getByRole("link", { name: "Configurar" })).toHaveCount(0)
  const receptionRow = reception.getByRole("link")
  await expect(receptionRow).toHaveCount(1)
  await expect(receptionRow).toContainText("Encendido")
  expect((await box(receptionRow)).height).toBeGreaterThanOrEqual(44)
  const advisorRow = rows.filter({ hasText: "Administrador" }).getByRole("link")
  await expect(advisorRow).toContainText("Apagado · ver y encender")
  expect((await box(advisorRow)).height).toBeGreaterThanOrEqual(44)
  await expect(week.getByRole("img", { name: /1 se las corregiste/ })).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("resumen-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await advisorRow.click()
  await expect(page).toHaveURL(tenantPattern(org.slug, "/agent/administrador"))

  // --- El proveedor rechaza la conexión: lo dice arriba y lleva a donde se arregla ---
  // El aviso se va cuando el modelo vuelve a responder, y el de demostración siempre responde.
  // Se comprueba antes del fallo: lo comprobado vale 10 minutos y es anterior, así que el aviso sigue.
  expect(await call<{ responds: boolean }>(page, "GET", "/api/agent/model", org.slug)).toMatchObject({ responds: true })
  await fixtureDb.insert(agentRunLedger).values({
    organizationId: org.id, conversationId: alone, model: "fake", status: "error", startedAt: new Date(),
    error: "PROVIDER_REJECTED: HTTP 401: detalle-interno-del-proveedor",
  })
  expect((await overview()).provider.problem).toBe("rechazado")
  await gotoHydrated(page, tenant(org.slug, "/agent"))
  const problem = page.getByRole("alert").filter({ hasText: "El agente no puede responder ahora" })
  await expect(problem).toContainText("Los mensajes pasan a tu equipo. Ya avisamos a odentIA.")
  // El texto del proveedor no llega a la pantalla.
  await expect(page.getByText(/detalle-interno/)).toHaveCount(0)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("resumen-problema-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await info.attach("resumen-problema", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // La clínica no tiene nada que arreglar ni otro modelo al que cambiar: el aviso no ofrece acciones.
  await expect(problem.getByRole("link")).toHaveCount(0)
  await expect(problem.getByRole("button")).toHaveCount(0)
})

test("bandeja: con Recepción apagada lo dice, y solo quien administra puede ir a encenderla", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  await expect(page.getByRole("heading", { level: 1, name: "Bandeja" })).toBeVisible()
  const notice = page.getByRole("status").filter({ hasText: "Recepción está apagada" })
  await expect(notice).toContainText("Tu equipo responde todas las conversaciones.")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("bandeja-apagado", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(notice).toBeVisible()
  // El botón anima su alto al cambiar de ancho: se espera a que termine.
  await expect.poll(async () => (await box(notice.getByRole("link", { name: "Ver y encender" }))).height).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("bandeja-apagado-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await notice.getByRole("link", { name: "Ver y encender" }).click()
  await expect(page).toHaveURL(tenantPattern(org.slug, "/agent/recepcion"))

  // Encendida, la Bandeja no dice nada.
  await call(page, "PUT", "/api/agent/config", org.slug, { enabled: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  // El aviso depende del resumen del panel: se espera esa respuesta antes de afirmar que no está.
  const panelLoaded = page.waitForResponse((response) => response.url().includes("/api/agent/panel") && response.ok())
  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  await panelLoaded
  await expect(page.getByRole("heading", { level: 1, name: "Bandeja" })).toBeVisible()
  await expect(page.getByRole("button", { name: /^Abiertas/ })).toBeVisible()
  await expect(notice).toHaveCount(0)
  await call(page, "PUT", "/api/agent/config", org.slug, { enabled: false })

  // Recepción decide por el agente pero no lo administra: lee el aviso, sin acción.
  await fixtureDb.update(member).set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  await expect(notice).toContainText("Para encenderla, habla con quien administra la clínica.")
  await expect(notice.getByRole("link")).toHaveCount(0)
  await info.attach("bandeja-apagado-recepcion", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
})
