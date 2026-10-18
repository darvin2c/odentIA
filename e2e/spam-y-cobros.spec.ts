import { randomUUID } from "node:crypto"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { session } from "@odentia/db/schema/auth"
import { contact, conversation } from "@odentia/db/schema/crm"
import { saasAction, saasActionReview, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import type { Page } from "@playwright/test"
import { desc, eq } from "drizzle-orm"
import { simulateWhatsAppInbound } from "./channels"
import { API, hostUrl, PANEL, tenant } from "./env"
import { api, call, expect, type OwnerFixture, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Spam, Bloquear y «Pedir revisión» (issue 77, ADR 0054): quien repite el
 * mismo texto va solo a Spam y sale con «No es spam»; bloquear pide motivo
 * y corta la escritura en el servidor; en Plan y pagos el spam se devuelve
 * al instante y lo demás lo decide odentIA en su caso de Soporte.
 */

interface Listed {
  id: string
  preview: { body: string | null } | null
}

interface Summary {
  attend: number
  spam: number
}

async function whatsapp(owner: OwnerFixture) {
  return call<{ id: string }>(owner.page, "POST", "/api/channels/connections", owner.org.slug, {
    channel: "whatsapp",
    provider: "whatsapp_cloud_api",
    displayName: "WA E2E",
    config: { phoneNumberId: "E2E-PNID", wabaId: "E2E-WABA", accessToken: "e2e", appSecret: "e2e-secret", templates: [] },
  }, 201)
}

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

const summaryOf = (page: Page, slug: string) => call<Summary>(page, "GET", "/api/conversations/summary", slug)

test("bandeja: el mismo texto cinco veces va a Spam y «No es spam» la devuelve; bloquear pide motivo y nadie le escribe hasta desbloquear", async ({ owner }, info) => {
  test.setTimeout(180_000)
  const { page, org } = owner
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true })
  const wa = await whatsapp(owner)
  const SPAM = "GANA S/ 500 DIARIOS desde casa, escribe YA bit.ly/gana-ya"
  const THREAT = "Esto no se queda así. Voy a ir a la clínica y van a ver."
  for (let i = 0; i < 5; i += 1) await inbound(page, wa.id, "51922200001", SPAM)
  await inbound(page, wa.id, "51922200002", THREAT)

  // El quinto igual en una hora la manda a Spam: lo cuenta su botón, no las pestañas.
  await expect.poll(async () => (await summaryOf(page, org.slug)).spam, { timeout: 30_000 }).toBe(1)
  await gotoHydrated(page, tenant(org.slug, "/inbox"))
  const spamButton = page.getByRole("button", { name: /^Spam/ })
  await expect(spamButton).toContainText("1")
  await spamButton.click()
  await expect(page.getByText("Spam · últimos 30 días")).toBeVisible()
  await expect(page.getByText("Repitió el mismo texto").first()).toBeVisible()
  await shot("bandeja-spam")

  // «No es spam» la devuelve a la Bandeja y ya no cuenta como spam.
  await page.getByRole("button", { name: "No es spam" }).click()
  await expect.poll(async () => (await summaryOf(page, org.slug)).spam, { timeout: 15_000 }).toBe(0)

  // Bloquear: solo con motivo y lo que pasó; después el servidor rechaza escribirle.
  const threat = await conversationWith(page, org.slug, THREAT)
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${threat.id}`))
  await page.getByRole("button", { name: "Más acciones de la conversación" }).click()
  await page.getByRole("menuitem", { name: "Bloquear a esta persona…" }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog.getByText("Sus mensajes y su ficha se conservan", { exact: false })).toBeVisible()
  await dialog.getByRole("radio", { name: "Amenazas" }).click()
  await dialog.getByLabel("Qué pasó (obligatorio)").fill("Amenazó a recepción por el cobro de la consulta.")
  await shot("bandeja-bloquear")
  await dialog.getByRole("button", { name: "Bloquear" }).click()
  await expect(page.getByText("Bloqueado por", { exact: false }).first()).toBeVisible()
  await shot("bandeja-bloqueado")
  const blockedReply = await api<{ error?: { code?: string } }>(page, "POST", `/api/conversations/${threat.id}/messages`, org.slug, { body: "Hola" })
  expect(blockedReply.status).toBe(409)
  expect(blockedReply.body.error?.code).toBe("CONTACT_BLOCKED")

  // En Bloqueados, «Desbloquear» confirma y queda anotado.
  await gotoHydrated(page, tenant(org.slug, "/inbox?view=blocked"))
  await expect(page.getByText("Amenazas").first()).toBeVisible()
  await page.getByRole("button", { name: "Desbloquear" }).first().click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Desbloquear" }).click()
  await expect(page.getByText("Ninguna persona bloqueada", { exact: false }).or(page.getByText("Para bloquear a alguien", { exact: false }))).toBeVisible()
  await shot("bandeja-desbloqueado")
})

test("plan y pagos: el spam se devuelve al instante; lo demás lo decide odentIA en Soporte y la fila dice cómo terminó", async ({ owner, fixtureDb }, info) => {
  test.setTimeout(240_000)
  const { page, org, user } = owner
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true })
  const day = 86_400_000
  const now = Date.now()
  const [plan] = await fixtureDb
    .insert(saasPlan)
    .values({
      code: `revision-${randomUUID().slice(0, 8)}`,
      name: "Plan odentIA",
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      consultationMicros: 400_000,
      recoveryMicros: 4_000_000,
      trialCreditCents: 5000,
      trialMaxCreditCents: 13000,
    })
    .returning()
  await fixtureDb
    .update(saasSubscription)
    .set({ planId: plan!.id, status: "activa", trialEndsAt: null, activatedAt: new Date(now - 10 * day), currentPeriodStart: new Date(now - 10 * day), currentPeriodEnd: new Date(now + 20 * day) })
    .where(eq(saasSubscription.organizationId, org.id))

  // Una conversación real, para leerla con permiso, y nueve personas más.
  const wa = await whatsapp(owner)
  await inbound(page, wa.id, "51933300001", "¿Atienden los domingos?")
  const real = await conversationWith(page, org.slug, "¿Atienden los domingos?")
  const [thread] = await fixtureDb.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, real.id))
  await fixtureDb.update(contact).set({ displayName: "Carmen Huamán" }).where(eq(contact.id, thread!.contactId))
  const people = await fixtureDb
    .insert(contact)
    .values(Array.from({ length: 9 }, (_, index) => ({ organizationId: org.id, displayName: index === 0 ? "Préstamos Ya" : `Persona ${index}` })))
    .returning({ id: contact.id, name: contact.displayName })
  const row = (contactId: string, minutesAgo: number, conversationId: string | null = null) => ({
    organizationId: org.id,
    kind: "conversacion",
    occurredAt: new Date(now - minutesAgo * 60_000),
    contactId,
    conversationId,
    channel: "whatsapp",
    detail: "Atendió una conversación por WhatsApp",
    currency: "USD",
    basePriceMicros: 500_000,
    priceMicros: 500_000,
    dedupeKey: randomUUID(),
  })
  const [carmen] = await fixtureDb
    .insert(saasAction)
    .values(row(thread!.contactId, 30, real.id))
    .returning({ id: saasAction.id })
  await fixtureDb.insert(saasAction).values(people.map((person, index) => row(person.id, 60 + index * 60)))

  await gotoHydrated(page, `${PANEL}/billing/${org.id}/acciones`)
  await expect(page.getByRole("heading", { name: "Cada acción de tus agentes" })).toBeVisible()
  const rowOf = (name: string) => page.getByRole("row").filter({ hasText: name })
  await expect(rowOf("Carmen Huamán").getByRole("link", { name: "Ver conversación" })).toHaveAttribute("href", new RegExp(`conversation=${real.id}`))

  // Spam de quien no es paciente: se devuelve al instante y pasa a Spam.
  await rowOf("Préstamos Ya").getByRole("button", { name: /^Acciones de la fila/ }).click()
  await page.getByRole("menuitem", { name: "Pedir revisión" }).click()
  const drawer = page.getByRole("dialog", { name: "Pedir revisión de este cobro" })
  await drawer.getByRole("radio", { name: /Era spam/ }).click()
  await shot("panel-pedir-revision")
  await drawer.getByRole("button", { name: "Pedir revisión" }).click()
  await expect(rowOf("Préstamos Ya")).toContainText("No se cobra: era spam · lo marcó Ana")
  const [prestamos] = await fixtureDb.select({ screen: contact.screen }).from(contact).where(eq(contact.id, people[0]!.id))
  expect(prestamos?.screen).toBe("spam")

  // Lo demás va a odentIA, con lo que contó y el permiso de leer la conversación.
  await rowOf("Carmen Huamán").getByRole("button", { name: /^Acciones de la fila/ }).click()
  await page.getByRole("menuitem", { name: "Pedir revisión" }).click()
  await drawer.getByRole("radio", { name: /El agente respondió mal/ }).click()
  await drawer.getByLabel("Cuéntanos qué pasó (opcional)").fill("Le dio un horario del domingo que no tenemos.")
  await drawer.getByRole("checkbox", { name: /Dejo que odentIA lea esta conversación/ }).click()
  await drawer.getByRole("button", { name: "Pedir revisión" }).click()
  await expect(rowOf("Carmen Huamán")).toContainText("En revisión · la pediste el")
  await shot("panel-en-revision")

  // El mes anterior también se ve.
  await page.getByRole("tablist", { name: "Qué mes" }).getByRole("tab").nth(1).click()
  await expect(page.getByText("No hubo acciones ese mes")).toBeVisible()
  await page.getByRole("tablist", { name: "Qué mes" }).getByRole("tab").nth(0).click()

  // Una sola revisión por fila, también en el servidor.
  const again = await api<{ error?: { code?: string } }>(page, "POST", `/api/account/billing/actions/${carmen!.id}/review`, undefined, { orgId: org.id, reason: "otro" })
  expect(again.status).toBe(409)
  expect(again.body.error?.code).toBe("REVIEW_EXISTS")

  // odentIA: la misma persona como personal admin con su segundo factor en esta sesión.
  const [current] = await fixtureDb.select({ id: session.id }).from(session).where(eq(session.userId, user.id)).orderBy(desc(session.createdAt)).limit(1)
  const factorId = randomUUID()
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  await fixtureDb.insert(twoFactor).values({ id: factorId, userId: user.id, secret: "e2e", backupCodes: "[]", verified: true })
  await fixtureDb.insert(adminSessionVerification).values({ userId: user.id, sessionId: current!.id, factorId, method: "totp", expiresAt: new Date(now + day) })
  const [review] = await fixtureDb.select({ caseId: saasActionReview.supportCaseId }).from(saasActionReview).where(eq(saasActionReview.actionId, carmen!.id))

  await gotoHydrated(page, hostUrl("admin", `/support?caso=${review!.caseId}`))
  const panel = page.getByRole("region", { name: "Revisión de cobro" })
  await expect(panel.getByText("El agente respondió mal o no ayudó")).toBeVisible()
  await expect(panel.getByText("«Le dio un horario del domingo que no tenemos.»")).toBeVisible()
  await panel.getByRole("button", { name: "Leer la conversación" }).click()
  await expect(panel.getByText("¿Atienden los domingos?")).toBeVisible()
  await panel.getByLabel("Qué le decimos a la clínica (obligatorio)").fill("Tienen razón: el agente leyó el horario de verano. Devolvemos la conversación.")
  await shot("admin-revision")
  await panel.getByRole("button", { name: /^Devolver/ }).click()
  await expect(panel.getByText("Devuelta", { exact: false }).first()).toBeVisible()
  await expect(panel.getByText("El permiso para leerla terminó con la respuesta.")).toBeVisible()

  // La clínica ve cómo terminó y la respuesta en su fila.
  await gotoHydrated(page, `${PANEL}/billing/${org.id}/acciones`)
  await expect(rowOf("Carmen Huamán")).toContainText("No se cobra: odentIA la devolvió")
  await rowOf("Carmen Huamán").getByRole("button", { name: "ver respuesta" }).click()
  await expect(rowOf("Carmen Huamán")).toContainText("el agente leyó el horario de verano")
  await shot("panel-devuelta")
})
