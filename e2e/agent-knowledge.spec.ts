import { agentKnowledgeGap } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface as sideSurface } from "./surface"

interface Entry {
  id: string
  title: string
  body: string
  state: string
  askForms: string[]
  basicKey: string | null
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

const day = (offset: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(Date.now() + offset * 86_400_000))

const QUESTION = "¿Tienen estacionamiento para bicicletas?"

test("conocimiento: lo que no supo responder, lo básico de una clínica y la vigencia de cada respuesta", async ({
  owner,
  fixtureDb,
  nextEventId,
}, info) => {
  const { page, org } = owner
  const tg = await call<{ id: string; webhookSecret: string }>(page, "POST", "/api/channels/connections", org.slug, {
    channel: "telegram", provider: "telegram_bot_api", displayName: "Bot E2E", config: { botToken: "e2e" },
  }, 201)
  const user = nextEventId()
  expect(await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, {
    fromId: user, chatId: user, text: QUESTION, updateId: nextEventId(),
  })).toBe(200)
  const conversations = () => call<Array<{ id: string }>>(page, "GET", "/api/conversations", org.slug)
  await expect.poll(async () => (await conversations()).length, { timeout: 30_000 }).toBe(1)
  const conversationId = (await conversations())[0]!.id
  // La pregunta sin respuesta se registra como lo hace el agente al buscar sin
  // resultado (el modelo de pruebas no usa herramientas); la respuesta del
  // equipo sí sale por el recorrido real.
  await fixtureDb.insert(agentKnowledgeGap).values({
    organizationId: org.id, conversationId, question: QUESTION, query: "estacionamiento bicicletas",
  })
  await call(page, "POST", `/api/conversations/${conversationId}/messages`, org.slug, { text: "Sí, hay un bicicletero en la entrada." }, 201)

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agent/knowledge"))
  const gaps = page.getByRole("region", { name: /^No supo responder/ })
  const basics = page.getByRole("region", { name: /^Lo básico de una clínica/ })
  const answers = page.getByRole("region", { name: /^Respuestas oficiales/ })
  await expect(gaps.getByRole("heading")).toHaveText("No supo responder · 1")
  await expect(gaps).toContainText(`«${QUESTION}»`)
  await expect(gaps).toContainText("Tu equipo respondió: Sí, hay un bicicletero en la entrada.")
  // La sede recién creada no tiene dirección ni hay servicios: nada básico cubierto todavía.
  await expect(basics.getByRole("heading")).toHaveText("Lo básico de una clínica · 0 de 25")
  await expect(basics.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0")
  // Sin respuestas, el vacío ofrece escribir la primera.
  await expect(answers.getByRole("button", { name: "Escribir la primera respuesta" })).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("conocimiento-inicial", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Guardar como respuesta oficial: llega con la pregunta y lo que respondió el equipo.
  await gaps.getByRole("button", { name: "Guardar como respuesta oficial" }).click()
  const answerForm = sideSurface(page, { name: "Guardar como respuesta oficial", exact: true })
  await expect(answerForm.getByLabel("La pregunta", { exact: true })).toHaveValue(QUESTION)
  await expect(answerForm.getByLabel("La respuesta", { exact: true })).toHaveValue("Sí, hay un bicicletero en la entrada.")
  await answerForm.getByLabel("La pregunta", { exact: true }).fill("Estacionamiento para bicicletas")
  await answerForm.getByRole("button", { name: "Guardar y publicar" }).click()
  await expect(answerForm).toBeHidden()
  await expect(gaps.getByRole("heading")).toHaveText("No supo responder")
  await expect(gaps).toContainText("Nada pendiente")
  const saved = answers.getByRole("listitem").filter({ hasText: "Estacionamiento para bicicletas" })
  await expect(saved).toContainText("Vigente")
  await expect(saved).toContainText(`También la encuentra como: «${QUESTION}»`)

  // Lo básico: «Responder» abre el formulario con la pregunta y, al guardar, cuenta.
  const parking = basics.getByRole("listitem").filter({ hasText: "¿Tienen estacionamiento?" })
  await parking.getByRole("button", { name: "Responder" }).click()
  const basicForm = sideSurface(page, { name: "Nueva respuesta", exact: true })
  await expect(basicForm.getByLabel("La pregunta", { exact: true })).toHaveValue("¿Tienen estacionamiento?")
  await basicForm.getByLabel("La respuesta", { exact: true }).fill("Sí, cuatro plazas para pacientes.")
  await basicForm.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(basicForm).toBeHidden()
  await expect(basics.getByRole("heading")).toHaveText("Lo básico de una clínica · 1 de 25")
  await expect(parking).toHaveCount(0)
  // Solo las primeras pendientes quedan a la vista; el resto, bajo demanda.
  await expect(basics.getByRole("button", { name: "Responder" })).toHaveCount(5)
  await basics.getByRole("button", { name: "Ver las 24 que faltan" }).click()
  await expect(basics.getByRole("button", { name: "Responder" })).toHaveCount(24)
  await basics.getByRole("button", { name: "Ver menos" }).click()
  await basics.getByRole("button", { name: "Ver la respondida" }).click()
  await expect(basics).toContainText("¿Tienen estacionamiento? · Con una respuesta oficial")

  // Vigencia: una respuesta con fecha de fin pasada queda «Vencida» y el agente no la recibe.
  await answers.getByRole("button", { name: "Nueva respuesta", exact: true }).click()
  const promoForm = sideSurface(page, { name: "Nueva respuesta", exact: true })
  await promoForm.getByLabel("La pregunta", { exact: true }).fill("Promoción de blanqueamiento")
  await promoForm.getByLabel("La respuesta", { exact: true }).fill("Dos por uno hasta fin de mes.")
  await promoForm.getByLabel("Vale hasta", { exact: true }).fill(day(-1))
  await promoForm.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(promoForm).toBeHidden()
  const promo = answers.getByRole("listitem").filter({ hasText: "Promoción de blanqueamiento" })
  await expect(promo).toContainText("Vencida")
  await expect(promo).toContainText("Hasta el")
  await answers.getByRole("button", { name: "Vencidas · 1" }).click()
  await expect(answers.getByRole("listitem")).toHaveCount(1)
  await answers.getByRole("button", { name: "Todas · 3" }).click()
  const listed = await call<Entry[]>(page, "GET", "/api/agent/knowledge", org.slug)
  expect(listed.map((entry) => `${entry.title}:${entry.state}`).sort()).toEqual([
    "Estacionamiento para bicicletas:vigente",
    "Promoción de blanqueamiento:vencida",
    "¿Tienen estacionamiento?:vigente",
  ])
  expect(listed.find((entry) => entry.title === "¿Tienen estacionamiento?")?.basicKey).toBe("estacionamiento")
  await info.attach("conocimiento-con-respuestas", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Teléfono: mismas secciones en una columna, sin desbordes y con botones tocables.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agent/knowledge"))
  await expect(basics.getByRole("heading")).toHaveText("Lo básico de una clínica · 1 de 25")
  await expect(promo).toContainText("Vencida")
  const respond = basics.getByRole("button", { name: "Responder" }).first()
  expect((await respond.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("conocimiento-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await respond.click()
  const mobileForm = page.getByRole("dialog", { name: "Nueva respuesta" })
  await expect(mobileForm.getByLabel("La respuesta", { exact: true })).toBeVisible()
  await info.attach("conocimiento-formulario-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await mobileForm.getByRole("button", { name: "Cancelar" }).click()
  await expect(mobileForm).toBeHidden()

  // Quien solo decide por el agente (recepción) no administra el conocimiento: lo decide el servidor.
  await fixtureDb.update(member).set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  expect((await api(page, "GET", "/api/agent/knowledge/gaps", org.slug)).status).toBe(403)
  expect((await api(page, "GET", "/api/agent/knowledge/basics", org.slug)).status).toBe(403)
  expect((await api(page, "POST", "/api/agent/knowledge/gaps/discard", org.slug, { ids: [listed[0]!.id] })).status).toBe(403)
})
