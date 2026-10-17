import { randomUUID } from "node:crypto"
import { member } from "@odentia/db/schema/auth"
import { conversation, message } from "@odentia/db/schema/crm"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateWhatsAppInbound } from "./channels"
import { API, tenant, tenantPattern } from "./env"
import { api, call, expect, type OwnerFixture, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

interface Closure {
  reason: "resuelta" | "sin_respuesta" | "equipo" | "manual"
  at: string
  byName: string | null
}

interface Listed {
  id: string
  status: string
  connection: { id: string }
  preview: { body: string | null } | null
  closure: Closure | null
}

interface Detail {
  closure: Closure | null
  conversation: { id: string; status: string; agentStatus: string; assignedUserId: string | null; closure?: Closure | null }
}

const FRESH_TEXT = "Hola, quiero una limpieza"
const OLD_TEXT = "¿Atienden los sábados?"
const SILENT_TEXT = "Gracias, lo pienso"

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

/** El cierre de una conversación, esté junto a `attention` o dentro de la conversación. */
const closureOf = (detail: Detail) => detail.closure ?? detail.conversation.closure ?? null

async function whatsapp(owner: OwnerFixture) {
  return call<{ id: string }>(owner.page, "POST", "/api/channels/connections", owner.org.slug, {
    channel: "whatsapp",
    provider: "whatsapp_cloud_api",
    displayName: "WA E2E",
    config: { phoneNumberId: "E2E-PNID", wabaId: "E2E-WABA", accessToken: "e2e", appSecret: "e2e-secret", templates: [] },
  }, 201)
}

/** Un mensaje del paciente por WhatsApp: la vía de prueba que usan los demás recorridos. */
async function inbound(page: Page, connectionId: string, from: string, text: string): Promise<void> {
  expect(await simulateWhatsAppInbound(page, API, connectionId, "e2e-secret", {
    from, phoneNumberId: "E2E-PNID", text, wamid: `wamid.${randomUUID()}`,
  })).toBe(200)
}

async function conversationWith(page: Page, slug: string, text: string): Promise<Listed> {
  const find = async () =>
    (await call<Listed[]>(page, "GET", "/api/conversations?status=open", slug)).find((c) => c.preview?.body === text)
  await expect.poll(async () => (await find())?.id ?? "", { timeout: 30_000 }).not.toBe("")
  const found = await find()
  if (!found) throw new Error(`No apareció la conversación «${text}»`)
  return found
}

const detailOf = (page: Page, slug: string, id: string) => call<Detail>(page, "GET", `/api/conversations/${id}`, slug)

test("bandeja: tomar, devolver, resolver con su confirmación, cerrar sin resolver y un entrante que la reabre", async ({
  owner,
  fixtureDb,
}, info) => {
  const { page, org } = owner
  const wa = await whatsapp(owner)
  await inbound(page, wa.id, "51911100001", FRESH_TEXT)
  await inbound(page, wa.id, "51911100002", OLD_TEXT)
  const fresh = await conversationWith(page, org.slug, FRESH_TEXT)
  const old = await conversationWith(page, org.slug, OLD_TEXT)
  // El último mensaje de este paciente es de hace 30 horas: ya no se le puede escribir.
  const longAgo = new Date(Date.now() - 30 * 3_600_000)
  await fixtureDb.update(message).set({ createdAt: longAgo }).where(eq(message.conversationId, old.id))
  await fixtureDb.update(conversation).set({ lastInboundAt: longAgo, lastMessageAt: longAgo }).where(eq(conversation.id, old.id))

  await page.setViewportSize({ width: 1440, height: 900 })
  const chip = (name: string) => page.getByRole("button", { name, exact: true })
  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  await expect(chip("Abiertas · 2")).toHaveAttribute("aria-pressed", "true")
  await expect(chip("Cerradas · 0")).toBeVisible()

  // --- Tomar: un solo verbo; la conversación queda a nombre de quien la toma y el agente deja de responder ---
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${fresh.id}`))
  // Las acciones viven solo en la cabecera del hilo: «Contexto» no las repite.
  const header = page.getByTestId("hilo")
  await expect(
    page.getByRole("region", { name: "Contexto del contacto" }).getByRole("button", { name: /^(Tomar|Devolver al agente|Resolver)$/ }),
  ).toHaveCount(0)
  const take = header.getByRole("button", { name: "Tomar", exact: true })
  const release = header.getByRole("button", { name: "Devolver al agente", exact: true })
  const resolve = header.getByRole("button", { name: "Resolver", exact: true })
  await expect(page.getByRole("button", { name: /Tomar atención|Reactivar agente|^Reabrir$|^Cerrar$/ })).toHaveCount(0)
  await take.click()
  await expect(release).toBeVisible()
  await expect(take).toHaveCount(0)
  await expect(page.getByText(`Con el equipo · la atiende ${owner.user.name}`).first()).toBeVisible()
  expect((await detailOf(page, org.slug, fresh.id)).conversation).toMatchObject({ assignedUserId: owner.user.id, agentStatus: "off" })

  // --- Devolver al agente: sin persona a cargo y con el agente encendido ---
  await release.click()
  await expect(take).toBeVisible()
  expect((await detailOf(page, org.slug, fresh.id)).conversation).toMatchObject({ assignedUserId: null, agentStatus: "on" })

  // --- Resolver: confirma con lo que dice el servidor (con despedida) ---
  await resolve.click()
  const confirmResolve = page.getByRole("alertdialog", { name: "¿Resolver la conversación?" })
  await expect(confirmResolve).toContainText(
    "se le enviará la despedida de la clínica y el agente volverá a atenderla si escribe de nuevo.",
  )
  await info.attach("resolver-con-despedida", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // Cancelar no cierra nada y devuelve el foco al botón.
  await confirmResolve.getByRole("button", { name: "Cancelar" }).click()
  await expect(confirmResolve).toBeHidden()
  await expect(resolve).toBeFocused()
  expect((await detailOf(page, org.slug, fresh.id)).conversation.status).toBe("open")
  await resolve.click()
  await confirmResolve.getByRole("button", { name: "Resolver", exact: true }).click()
  await expect(confirmResolve).toBeHidden()

  // --- Hilo cerrado: la franja dice cómo y cuándo; escribir la reabre ---
  const band = page.getByText(new RegExp(`^Resuelta por ${owner.user.name} · hoy`))
  await expect(band).toBeVisible()
  const resolved = await detailOf(page, org.slug, fresh.id)
  expect(resolved.conversation.status).toBe("closed")
  expect(closureOf(resolved)).toMatchObject({ reason: "equipo", byName: owner.user.name })
  await expect(page.getByText("Reábrela para responder")).toHaveCount(0)
  await expect(page.getByText("Está cerrada: si le escribes, se vuelve a abrir.")).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Mensaje" })).toBeEditable()
  await expect(resolve).toHaveCount(0)
  await expect(chip("Cerradas · 1")).toBeVisible()
  await info.attach("hilo-resuelto", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // --- Un mensaje del paciente reabre la conversación ---
  await inbound(page, wa.id, "51911100001", "Una pregunta más")
  await expect.poll(async () => (await detailOf(page, org.slug, fresh.id)).conversation.status, { timeout: 30_000 }).toBe("open")
  expect(closureOf(await detailOf(page, org.slug, fresh.id))).toBeNull()
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${fresh.id}`))
  await expect(band).toHaveCount(0)
  await expect(resolve).toBeVisible()
  await expect(chip("Cerradas · 0")).toBeVisible()

  // --- Resolver sin despedida: pasaron más de 23 horas desde su último mensaje ---
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${old.id}`))
  await resolve.click()
  await expect(confirmResolve).toContainText(
    "no se le puede escribir: pasaron más de 23 horas desde su último mensaje. Se cerrará sin enviarle nada.",
  )
  await info.attach("resolver-sin-despedida", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await confirmResolve.getByRole("button", { name: "Cancelar" }).click()
  await expect(confirmResolve).toBeHidden()

  // --- Cerrar sin resolver: en el menú de acciones, diciendo qué se cierra ---
  await call(page, "POST", "/api/agent/handoffs", org.slug, {
    conversationId: old.id, reason: "Pregunta por los sábados", summary: "Quiere venir el sábado.", priority: "media",
  }, 201)
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${old.id}`))
  await page.getByRole("button", { name: "Más acciones de la conversación" }).click()
  await page.getByRole("menuitem", { name: "Cerrar sin resolver" }).click()
  const confirmClose = page.getByRole("alertdialog", { name: "¿Cerrar sin resolver?" })
  await expect(confirmClose).toContainText("sin enviarle nada")
  await expect(confirmClose).toContainText("También se cerrará sin resolver el caso que te pasó el agente.")
  await confirmClose.getByRole("button", { name: "Cerrar sin resolver", exact: true }).click()
  await expect(confirmClose).toBeHidden()
  await expect(page.getByText(new RegExp(`^Cerrada por ${owner.user.name} · hoy`))).toBeVisible()
  expect(closureOf(await detailOf(page, org.slug, old.id))).toMatchObject({ reason: "manual", byName: owner.user.name })
  const handoffs = await call<Array<{ conversationId: string | null; status: string }>>(
    page, "GET", `/api/agent/handoffs?conversationId=${old.id}`, org.slug,
  )
  expect(handoffs.filter((handoff) => handoff.status !== "resuelta")).toEqual([])

  // --- Cerradas: cada fila dice cómo se cerró ---
  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  await chip("Cerradas · 1").click()
  await expect(page).toHaveURL(/view=closed/)
  await expect(page.getByRole("button").filter({ hasText: OLD_TEXT })).toContainText(`Cerrada por ${owner.user.name}`)
  await expect(page.getByRole("button").filter({ hasText: "Una pregunta más" })).toHaveCount(0)

  // --- Teléfono: las acciones del hilo se tocan con el dedo y nada desborda ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${fresh.id}`))
  // En teléfono el hilo ocupa la pantalla y su cabecera es la única con estas acciones.
  const phoneTake = page.getByRole("button", { name: "Tomar", exact: true })
  const phoneResolve = page.getByRole("button", { name: "Resolver", exact: true })
  await expect(phoneTake).toHaveCount(1)
  for (const control of [phoneTake, phoneResolve, page.getByRole("button", { name: "Más acciones de la conversación" })]) {
    expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("hilo-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
})

test("bandeja: lo que cerró el agente se dice en la fila y en la franja del hilo", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  const wa = await whatsapp(owner)
  await inbound(page, wa.id, "51911100003", SILENT_TEXT)
  const silent = await conversationWith(page, org.slug, SILENT_TEXT)
  // Como lo deja el agente al despedirse por silencio: sin persona y con el motivo.
  const yesterday = new Date(Date.now() - 26 * 3_600_000)
  await fixtureDb
    .update(conversation)
    .set({ status: "closed", closedAt: yesterday, closedByUserId: null, closeReason: "sin_respuesta" })
    .where(eq(conversation.id, silent.id))
  expect(closureOf(await detailOf(page, org.slug, silent.id))).toMatchObject({ reason: "sin_respuesta", byName: null })

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/inbox?view=closed"))
  const row = page.getByRole("button").filter({ hasText: SILENT_TEXT })
  await expect(row).toContainText("Cerrada por el agente · sin respuesta del paciente")
  await row.click()
  await expect(page.getByText(/^Cerrada por el agente · sin respuesta del paciente · /)).toBeVisible()
  await info.attach("cerrada-por-el-agente", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
})

test("agente: «Esperan su sí» reemplaza a «Aprobaciones» y la dirección vieja lleva ahí", async ({ owner, fixtureDb }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  // La dirección vieja redirige conservando la búsqueda.
  await gotoHydrated(page, tenant(org.slug, "/agent/approvals?status=ejecutada"))
  await expect(page).toHaveURL(tenantPattern(org.slug, "/agent/pendientes?status=ejecutada"))
  const tabs = page.getByRole("navigation", { name: "Secciones del agente" })
  await expect(tabs.getByRole("link", { name: /^Esperan su sí/ })).toHaveAttribute("aria-current", "page")
  await expect(tabs.getByRole("link", { name: /Aprobaciones/ })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Esperan su sí" })).toBeVisible()

  // Recepción decide por el agente sin supervisarlo: entra igual que antes.
  await fixtureDb.update(member).set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await gotoHydrated(page, tenant(org.slug, "/agent/pendientes"))
  await expect(page.getByRole("heading", { name: "Esperan su sí" })).toBeVisible()
  await page.getByRole("navigation").getByRole("link", { name: "Agente", exact: true }).click()
  await expect(page).toHaveURL(tenantPattern(org.slug, "/agent/pendientes"))
})

test("agente: Límites guarda cuántas horas espera antes de cerrar por silencio", async ({ owner }, info) => {
  const { page, org } = owner
  const config = () => call<{ closeAfterHours: number }>(page, "GET", "/api/agent/config", org.slug)
  expect((await config()).closeAfterHours).toBe(22)
  // El servidor también rechaza lo que la pantalla no deja guardar.
  for (const hours of [5, 24]) {
    expect((await api(page, "PUT", "/api/agent/config", org.slug, { closeAfterHours: hours })).status).toBe(400)
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agent/recepcion"))
  const limits = page.getByRole("region", { name: "Límites" })
  const row = limits.getByRole("button", { name: /^Cerrar la conversación/ })
  await expect(row).toContainText("A las 22 horas sin respuesta")
  await row.click()
  const form = surface(page, { name: "Cerrar si el paciente no responde", exact: true })
  const hours = form.getByLabel("Cerrar la conversación si el paciente no responde")
  await expect(hours).toHaveValue("22")
  await expect(form).toContainText("Entre 6 y 23 horas. Antes de cerrar, el agente se despide dentro del horario para escribir.")
  const save = form.getByRole("button", { name: "Guardar" })
  for (const wrong of ["5", "24"]) {
    await hours.fill(wrong)
    await expect(save).toBeDisabled()
    await expect(form.getByText("Escribe un número de horas entre 6 y 23.")).toBeVisible()
  }
  await hours.fill("12")
  await expect(save).toBeEnabled()
  await info.attach("limites-cierre", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await save.click()
  await expect(form).toBeHidden()
  await expect(row).toContainText("A las 12 horas sin respuesta")
  expect((await config()).closeAfterHours).toBe(12)
})
