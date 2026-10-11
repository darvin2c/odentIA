import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface as sideSurface } from "./surface"

const FAKE_REPLY = "Gracias por escribir. Te atiendo enseguida."
const QUESTION = "¿Atienden a niños de 2 años?"
const TEAM_REPLY = "Atendemos niños desde los 3 años. Para los más pequeños te recomendamos un odontopediatra."

interface Learning {
  review: Array<{ id: string; reason: string; question: string; teamReply: string | null }>
  proposed: Array<{ id: string; kind: string; title: string; body: string; question: string }>
  learned: Array<{ id: string; title: string }>
  withdrawn: Array<{ id: string }>
  cases: number
}

interface Knowledge {
  title: string
  body: string
  state: string
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test("aprender: revisar, corregir, aprobar la lección, retirarla y aprobar un mensaje editándolo", async ({
  owner,
  fixtureDb,
  nextEventId,
}, info) => {
  const { page, org } = owner
  const learning = () => call<Learning>(page, "GET", "/api/agent/learning", org.slug)
  const knowledge = () => call<Knowledge[]>(page, "GET", "/api/agent/knowledge", org.slug)
  const tg = await call<{ id: string; webhookSecret: string }>(page, "POST", "/api/channels/connections", org.slug, {
    channel: "telegram", provider: "telegram_bot_api", displayName: "Bot E2E", config: { botToken: "e2e" },
  }, 201)
  await call(page, "PUT", "/api/agent/config", org.slug, { enabled: true })
  const send = async (from: number, text: string) =>
    expect(await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, { fromId: from, chatId: from, text, updateId: nextEventId() })).toBe(200)
  const conversations = () => call<Array<{ id: string }>>(page, "GET", "/api/conversations", org.slug)
  const traces = (conversationId: string) =>
    call<Array<{ id: string; outcome: string }>>(page, "GET", `/api/agent/answer-traces?conversationId=${conversationId}`, org.slug)

  // El agente responde y alguien del equipo retoma la conversación con otra respuesta.
  const lucia = nextEventId()
  await send(lucia, QUESTION)
  await expect.poll(async () => (await conversations()).length, { timeout: 30_000 }).toBe(1)
  const conversationId = (await conversations())[0]!.id
  await expect.poll(async () => (await traces(conversationId)).length, { timeout: 45_000 }).toBe(1)
  await call(page, "POST", `/api/conversations/${conversationId}/messages`, org.slug, { text: TEAM_REPLY }, 201)

  // --- Por revisar ---
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agent/learn"))
  const review = page.getByRole("region", { name: /^Por revisar/ })
  const toApprove = page.getByRole("region", { name: /^Lecciones por aprobar/ })
  const learned = page.getByRole("region", { name: /^Lo aprendido/ })
  await expect(review.getByRole("heading", { level: 2 })).toHaveText("Por revisar · 1")
  const item = review.getByRole("listitem").first()
  await expect(item).toContainText("El equipo tomó la conversación")
  await expect(item).toContainText(QUESTION)
  await expect(item).toContainText(FAKE_REPLY)
  await expect(toApprove).toContainText("No hay lecciones esperando")
  await expect(learned).toContainText("Todavía no aprobaste ninguna lección")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("aprender-por-revisar", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // --- Corregir: parte de lo que respondió el equipo y no cambia nada todavía ---
  await item.getByRole("button", { name: "Corregir" }).click()
  const correcting = sideSurface(page, { name: "Corregir una respuesta", exact: true })
  await expect(correcting).toContainText("Alguien de tu equipo escribió justo después")
  await expect(correcting.getByLabel("¿Cómo debió responder?")).toHaveValue(TEAM_REPLY)
  await expect(correcting).toContainText("Puse lo que respondió tu equipo.")
  // Sin decir qué falló no se puede enviar.
  await expect(correcting.getByRole("button", { name: "Enviar corrección" })).toBeDisabled()
  await correcting.getByRole("button", { name: "Le faltó un dato" }).click()
  await info.attach("corregir", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await correcting.getByRole("button", { name: "Enviar corrección" }).click()

  // --- La lección propuesta se abre para quien administra ---
  const lesson = sideSurface(page, { name: "Lección propuesta", exact: true })
  await expect(lesson).toContainText("Respuesta oficial · Toda la clínica")
  await expect(lesson).toContainText(`De una corrección a la pregunta «${QUESTION}».`)
  await expect(lesson).toContainText(FAKE_REPLY)
  await expect(lesson).toContainText(TEAM_REPLY)
  await expect(lesson).toContainText("Todavía no tienes casos de prueba")
  // Propuesta: el conocimiento sigue igual.
  expect(await knowledge()).toEqual([])
  // Probarla responde la pregunta con y sin la lección; con el modelo de demostración, lo dice.
  await lesson.getByRole("button", { name: "Ver cómo respondería con ella" }).click()
  await expect(lesson).toContainText("Responde igual", { timeout: 30_000 })
  await expect(lesson).toContainText("Modelo de demostración")
  await info.attach("leccion-propuesta", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // Editar el texto antes de aprobar.
  await lesson.getByRole("button", { name: "Editar el texto" }).click()
  await lesson.getByLabel("Título").fill("Atención a niños")
  await lesson.getByRole("button", { name: "Guardar cambios" }).click()
  await expect(lesson.getByRole("heading", { level: 3, name: "Atención a niños" })).toBeVisible()
  await lesson.getByRole("button", { name: "Aprobar y activar" }).click()
  await expect(lesson).toBeHidden()

  await expect(review.getByRole("heading", { level: 2 })).toHaveText("Por revisar")
  await expect(learned.getByRole("heading", { level: 2 })).toHaveText("Lo aprendido · 1")
  await expect(learned).toContainText("Atención a niños")
  await expect(learned).toContainText("1 caso de prueba guardado")
  expect(await knowledge()).toEqual([expect.objectContaining({ title: "Atención a niños", body: TEAM_REPLY, state: "vigente" })])
  expect(await learning()).toMatchObject({ review: [], proposed: [], cases: 1 })

  // --- Retirar la devuelve a como estaba; restaurar la vuelve a activar ---
  await learned.getByRole("button", { name: "Retirar" }).click()
  const withdrawing = sideSurface(page, { name: "Retirar «Atención a niños»", exact: true })
  await expect(withdrawing).toContainText("Deja de usarla al instante.")
  await info.attach("retirar", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await withdrawing.getByRole("button", { name: "Retirar la respuesta" }).click()
  await expect(withdrawing).toBeHidden()
  await expect(learned).toContainText("Retiradas · 1, se pueden restaurar")
  expect((await knowledge())[0]).toMatchObject({ state: "borrador" })
  await learned.getByRole("button", { name: "Restaurar" }).click()
  const restoring = sideSurface(page, { name: "Restaurar «Atención a niños»", exact: true })
  await restoring.getByRole("button", { name: "Restaurar" }).click()
  await expect(restoring).toBeHidden()
  await expect(learned.getByRole("heading", { level: 2 })).toHaveText("Lo aprendido · 1")
  expect((await knowledge())[0]).toMatchObject({ state: "vigente" })

  // --- Aprobar un mensaje editándolo: sale el texto del equipo y queda una lección por aprobar ---
  await call(page, "PUT", "/api/agent/level", org.slug, { level: "supervisado" })
  const andres = nextEventId()
  await send(andres, "¿Tienen estacionamiento?")
  await expect.poll(async () => (await conversations()).length, { timeout: 30_000 }).toBe(2)
  await gotoHydrated(page, tenant(org.slug, "/agent/approvals"))
  const draft = page.getByLabel("Mensaje que saldrá")
  await expect(draft).toHaveValue(FAKE_REPLY, { timeout: 45_000 })
  const edited = "En Miraflores tenemos estacionamiento gratis para pacientes."
  await draft.fill(edited)
  await expect(page.getByText("Lo editaste.")).toBeVisible()
  await info.attach("aprobar-con-edicion", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.getByRole("button", { name: "Revisar y aprobar" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Aprobar y ejecutar el cambio" })
  await expect(confirm).toContainText(edited)
  await confirm.getByRole("button", { name: "Aprobar y ejecutar" }).click()
  await expect(confirm).toBeHidden()
  const second = (await conversations()).find((row) => row.id !== conversationId)!.id
  await expect
    .poll(async () => {
      const rows = await call<Array<{ body: string | null; direction: string }>>(page, "GET", `/api/conversations/${second}/messages`, org.slug)
      return rows.filter((row) => row.direction === "out").map((row) => row.body)
    })
    .toEqual([edited])
  await expect.poll(async () => (await learning()).proposed.map((row) => row.body)).toEqual([edited])
  expect((await learning()).proposed[0]).toMatchObject({ kind: "respuesta_oficial", question: "¿Tienen estacionamiento?" })

  // --- Desde la Bandeja: «En qué se basó» ofrece corregir esa respuesta ---
  await call(page, "PUT", "/api/agent/level", org.slug, { level: "equilibrado" })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  await page.getByRole("button", { name: "En qué se basó" }).click()
  const trace = page.getByRole("dialog", { name: "En qué se basó" })
  // Esa respuesta ya se corrigió: el servidor lo dice al intentar otra vez.
  await trace.getByRole("button", { name: "Corregir esta respuesta" }).click()
  const fromInbox = page.getByRole("dialog", { name: "Corregir una respuesta" })
  await expect(fromInbox).toContainText(QUESTION)
  await fromInbox.getByRole("button", { name: "El tono" }).click()
  await fromInbox.getByLabel("¿Cómo debió responder?").fill("Otra respuesta")
  await fromInbox.getByRole("button", { name: "Enviar corrección" }).click()
  await expect(fromInbox).toContainText("conflicto con el estado actual")
  // Cerrar con cambios sin guardar pregunta antes.
  page.once("dialog", (dialog) => void dialog.accept())
  await fromInbox.getByRole("button", { name: "Cancelar" }).click()
  await expect(fromInbox).toBeHidden()

  // --- Teléfono ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agent/learn"))
  await expect(toApprove.getByRole("heading", { level: 2 })).toHaveText("Lecciones por aprobar · 1")
  const open = toApprove.getByRole("button", { name: "Ver y aprobar" })
  expect((await open.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("aprender-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await open.click()
  const mobileLesson = page.getByRole("dialog", { name: "Lección propuesta" })
  await expect(mobileLesson).toContainText("Tu caso de prueba no toca este tema")
  await info.attach("leccion-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await mobileLesson.getByRole("button", { name: "Cerrar" }).click()
  await expect(mobileLesson).toBeHidden()

  // Recepción revisa y corrige, pero no aprueba ni retira: lo decide el servidor.
  const [pending] = (await learning()).proposed
  const [active] = (await learning()).learned
  await fixtureDb.update(member).set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  expect((await api(page, "POST", `/api/agent/learning/lessons/${pending!.id}/approve`, org.slug)).status).toBe(403)
  expect((await api(page, "POST", `/api/agent/learning/lessons/${active!.id}/withdraw`, org.slug, {})).status).toBe(403)
  expect((await api(page, "POST", `/api/agent/learning/lessons/${pending!.id}/preview`, org.slug)).status).toBe(403)
})
