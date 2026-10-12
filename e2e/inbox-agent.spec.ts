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
  attention: { pendingTeam: number; handoffPriority: string | null; agentAttending: boolean }
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
 * Dos hilos de Telegram: uno con una propuesta que decide el equipo y otro
 * con una derivación de prioridad alta. La propuesta se inserta como la
 * registra el agente (sin proveedor real no hay corrida que la genere): es el
 * límite de esta evidencia; su lógica se cubre en services.
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
  await call(page, "PUT", "/api/agent/policy", org.slug, { enviar_mensaje: "aprobar_equipo" })
  const propose = async (conversation: Conversation, text: string) => {
    const [row] = await fixtureDb.insert(agentProposal).values({
      organizationId: org.id, contactId: conversation.contact.id, conversationId: conversation.id, action: "enviar_mensaje",
      payload: { kind: "text", text }, afterSummary: `Enviar: ${text}`,
      reason: "El interlocutor escribió", idempotencyKey: randomUUID(),
    }).returning({ id: agentProposal.id })
    if (!row) throw new Error("No se pudo sembrar la propuesta")
    return row.id
  }
  await propose(waiting, "Te confirmo la cita de mañana.")
  await call(page, "POST", "/api/agent/handoffs", org.slug, {
    conversationId: derived.id, reason: "Pide hablar con una persona", summary: "Prefiere atención humana.", priority: "alta",
  }, 201)
  return { waiting, derived, propose }
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test("bandeja: el estado del agente por conversación, las vistas con su total y la banda del hilo", async ({
  owner,
  fixtureDb,
  nextEventId,
}, info) => {
  const { page, org } = owner
  const { waiting, derived, propose } = await seedThreads(owner, fixtureDb, nextEventId)

  // El servidor cuenta las vistas sobre todo lo filtrado y describe cada hilo.
  expect(await call(page, "GET", "/api/conversations/summary?status=open", org.slug)).toEqual({ all: 2, waiting: 2, withAgent: 0, handoffs: 1 })
  const listed = await call<Conversation[]>(page, "GET", "/api/conversations?view=handoff", org.slug)
  expect(listed.map((c) => c.id)).toEqual([derived.id])
  expect(listed[0]?.attention.handoffPriority).toBe("alta")
  expect((await call<{ attention: Conversation["attention"] }>(page, "GET", `/api/conversations/${waiting.id}`, org.slug)).attention.pendingTeam).toBe(1)

  await page.setViewportSize({ width: 1440, height: 900 })
  // Una vista sin chip en la URL no filtra a escondidas: queda «Todas».
  await gotoHydrated(page, tenant(org.slug, "/inbox?view=human"))
  await expect(page.getByText("2 conversaciones esperan respuesta")).toBeVisible()
  const chip = (name: string) => page.getByRole("button", { name, exact: true })
  await expect(chip("Todas · 2")).toHaveAttribute("aria-pressed", "true")
  await expect(chip("Esperan respuesta · 2")).toHaveAttribute("aria-pressed", "false")
  await expect(chip("Con el agente · 0")).toBeVisible()
  const waitingRow = page.getByRole("button").filter({ hasText: WAITING_TEXT })
  const derivedRow = page.getByRole("button").filter({ hasText: DERIVED_TEXT })
  await expect(waitingRow).toContainText("Espera tu aprobación")
  await expect(derivedRow).toContainText("Derivada · ahora")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("bandeja", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // La vista filtra en servidor y queda en la URL.
  await chip("Derivadas · 1").click()
  await expect(chip("Derivadas · 1")).toHaveAttribute("aria-pressed", "true")
  await expect(derivedRow).toBeVisible()
  await expect(waitingRow).toHaveCount(0)
  await expect(page).toHaveURL(/view=handoff/)
  await chip("Todas · 2").click()
  await expect(waitingRow).toBeVisible()

  // La banda del hilo dice qué propuso el agente y abre el panel, donde lo de
  // este hilo va primero aunque haya otra propuesta más reciente.
  await waitingRow.click()
  const band = page.getByRole("status").filter({ hasText: "El agente propuso" })
  await expect(band).toContainText("enviar mensaje")
  await expect(band).toContainText("No se ejecuta hasta que alguien lo apruebe")
  await info.attach("hilo-con-banda", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  const otherProposal = await propose(derived, "En un momento te atiende una persona.")
  const review = band.getByRole("button", { name: "Revisar" })
  await review.click()
  const panel = page.getByRole("dialog", { name: "Agente" })
  const cards = panel.getByRole("tabpanel").getByRole("listitem")
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText("De esta conversación")
  await expect(cards.first()).toContainText("Te confirmo la cita de mañana.")
  await expect(cards.first().getByRole("link", { name: /Abrir caso|Abrir conversación/ })).toHaveCount(0)
  await expect(cards.nth(1)).not.toContainText("De esta conversación")
  await expect(cards.nth(1).getByRole("link", { name: "Abrir caso" })).toBeVisible()
  await info.attach("panel-de-esta-conversacion", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // Decidir desde el panel actualiza la bandeja: desaparecen la banda y la
  // marca de la fila, y al cerrar el foco vuelve a donde se abrió.
  await cards.first().getByRole("button", { name: "Rechazar…" }).click()
  await panel.getByLabel("Motivo del rechazo").fill("Ya se le respondió por teléfono")
  await panel.getByRole("button", { name: "Confirmar rechazo" }).click()
  await expect(panel.getByRole("status")).toContainText("Propuesta rechazada")
  await page.keyboard.press("Escape")
  await expect(panel).toBeHidden()
  await expect(band).toHaveCount(0)
  await expect(waitingRow).not.toContainText("Espera tu aprobación")

  // Inicio: en escritorio todas las tarjetas; en móvil una, y el resto en el panel.
  await propose(waiting, "Te confirmo la cita de mañana.")
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const pending = page.getByRole("region", { name: "Pendiente de ti" })
  await expect(pending).toContainText("2 cambios del agente y 1 conversación derivada")
  await expect(pending.getByRole("button", { name: "Revisar y aprobar" })).toHaveCount(2)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(pending.getByRole("button", { name: "Revisar y aprobar" })).toHaveCount(1)
  await expect(pending.getByRole("button", { name: "Ver las otras 2" })).toBeVisible()
  // Con una sola propuesta, lo que queda oculto es la derivación: el enlace abre esa pestaña.
  await call(page, "POST", `/api/agent/proposals/${otherProposal}/decision`, org.slug, { decision: "rechazada", reason: "Ya se atendió" })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(pending).toContainText("1 cambio del agente y 1 conversación derivada")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("inicio-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await pending.getByRole("button", { name: "Ver la otra" }).click()
  const mobilePanel = page.getByRole("dialog", { name: "Agente" })
  await expect(mobilePanel.getByRole("tab", { name: /^Derivadas/ })).toHaveAttribute("aria-selected", "true")
  await expect(mobilePanel.getByText("Pide hablar con una persona")).toBeVisible()
  await mobilePanel.getByRole("button", { name: "Cerrar el panel del agente" }).click()
  await expect(mobilePanel).toBeHidden()

  // Bandeja en móvil: una vista por vez; con el hilo abierto ceden la pantalla vistas y filtros.
  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  await expect(chip("Derivadas · 1")).toBeVisible()
  await expect(waitingRow).toContainText("Espera tu aprobación")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("bandeja-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await waitingRow.click()
  await expect(band).toBeVisible()
  await expect(chip("Derivadas · 1")).toBeHidden()
  await expect(page.getByPlaceholder("Buscar contacto")).toHaveCount(0)
  await info.attach("hilo-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.getByRole("button", { name: "Volver" }).click()
  await expect(chip("Derivadas · 1")).toBeVisible()
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
  expect(await columnWidth()).toBe(416)
  await page.keyboard.press("End")
  // 1600 de ventana − 256 de sidebar − 848 de página.
  await expect(grip).toHaveAttribute("aria-valuenow", "496")
  expect(await columnWidth()).toBe(496)
  await page.mouse.move(1600 - 496, 450)
  await page.mouse.down()
  await page.mouse.move(1600 - 340, 450, { steps: 4 })
  await page.mouse.up()
  expect(await columnWidth()).toBe(340)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await button.click()
  expect(await columnWidth()).toBe(340)

  // No tapa la página: se navega con ella abierta y sigue ahí.
  await page.getByRole("navigation").getByRole("link", { name: "Bandeja", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Bandeja" })).toBeVisible()
  await expect(column).toBeVisible()

  // En la Bandeja ocupa el lugar de «Contexto»; lo del hilo abierto va primero.
  await page.getByRole("button").filter({ hasText: WAITING_TEXT }).click()
  const context = page.getByRole("button", { name: "Contexto", exact: true })
  await expect(context).toHaveAttribute("aria-pressed", "false")
  await expect(column.getByRole("tabpanel").getByRole("listitem").first()).toContainText("De esta conversación")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("columna-bandeja", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // La página puede pedir otra pestaña con la columna ya abierta… y pedir «Contexto» la cierra.
  await context.click()
  await expect(column).toHaveCount(0)
  await expect(context).toHaveAttribute("aria-pressed", "true")
  // «Revisar» la vuelve a abrir; Esc dentro de la columna la cierra y devuelve el foco.
  const review = page.getByRole("status").filter({ hasText: "El agente propuso" }).getByRole("button", { name: "Revisar" })
  await review.click()
  await expect(column).toBeVisible()
  await expect(context).toHaveAttribute("aria-pressed", "false")
  await page.keyboard.press("Escape")
  await expect(column).toHaveCount(0)
  await expect(review).toBeFocused()
  await expect(context).toHaveAttribute("aria-pressed", "true")

  // Estrechar la ventana con la columna abierta la convierte en cajón.
  await review.click()
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
  await fixtureDb.update(member).set({ role: "dentist" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  const waitingRow = page.getByRole("button").filter({ hasText: WAITING_TEXT })
  await expect(waitingRow).toContainText("Espera aprobación del equipo")
  await expect(page.getByRole("button").filter({ hasText: DERIVED_TEXT })).toContainText("Derivada · ahora")
  await waitingRow.click()
  const band = page.getByRole("status").filter({ hasText: "El agente propuso" })
  await expect(band).toContainText("un cambio")
  await expect(band.getByRole("button", { name: "Revisar" })).toHaveCount(0)
  await expect(page.locator("header").getByRole("button", { name: /^Agente/ })).toHaveCount(0)
  expect((await api(page, "GET", "/api/agent/proposals?status=propuesta", org.slug)).status).toBe(403)
})
