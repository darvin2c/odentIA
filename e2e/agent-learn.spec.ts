import { agentKnowledgeGap } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import { message } from "@odentia/db/schema/crm"
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
  review: Array<{ id: string; reason: string; question: string; query: string | null; teamReply: string | null }>
  proposed: Array<{ id: string; kind: string; title: string; body: string; question: string }>
  learned: Array<{ id: string; title: string }>
  withdrawn: Array<{ id: string }>
  cases: number
}

interface Knowledge {
  id: string
  title: string
  body: string
  state: string
  askForms: string[]
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test("aprender: revisar, corregir, aprobar la lección, retirarla y corregir desde la Bandeja", async ({
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
  // Las pestañas dicen cuánto espera: una respuesta por revisar.
  const tabs = page.getByRole("navigation", { name: "Secciones del agente" })
  await expect(tabs.getByRole("link", { name: /^Aprender/ })).toHaveText(/Aprender · 1 pendiente/)
  // Lo que espera el sí de la persona está en la Bandeja, no aquí (ADR 0118).
  await expect(tabs.getByRole("link", { name: /Esperan su sí/ })).toHaveCount(0)
  // Lo que se aprende es de Sofi: no hay de qué agente elegir.
  await expect(page.getByRole("tablist", { name: "De qué agente" })).toHaveCount(0)
  // La fila decide con dos botones; lo demás queda en su menú.
  await expect(item.getByRole("button")).toHaveText(["", "Estuvo bien", "Corregir"])
  await item.getByRole("button", { name: /^Más acciones/ }).click()
  await expect(page.getByRole("menuitem", { name: "Abrir la conversación" })).toBeVisible()
  await page.keyboard.press("Escape")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("aprender-por-revisar", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // --- Teléfono: la tarjeta y la corrección, con lo justo ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agent/learn"))
  await expect(item).toContainText("El equipo tomó la conversación")
  for (const name of ["Estuvo bien", "Corregir"]) {
    expect((await item.getByRole("button", { name, exact: true }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  // Las otras dos secciones son filas que se abren.
  await expect(toApprove.getByRole("button", { name: /^Lecciones por aprobar/ })).toHaveAttribute("aria-expanded", "false")
  await expect(learned.getByRole("button", { name: /^Lo aprendido/ })).toHaveAttribute("aria-expanded", "false")
  await expect(toApprove.getByText("No hay lecciones esperando")).toBeHidden()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("aprender-movil-por-revisar", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await item.getByRole("button", { name: "Corregir", exact: true }).click()
  const mobileCorrecting = page.getByRole("dialog", { name: "Corregir una respuesta de Sofi" })
  await expect(mobileCorrecting).toContainText(QUESTION)
  await expect(mobileCorrecting).toContainText("Sofi respondió")
  await expect(mobileCorrecting).toContainText("En qué se basó")
  // Lo que escribió el equipo se ofrece; no viene puesto.
  await expect(mobileCorrecting.getByLabel("¿Cómo debió responder?")).toHaveValue("")
  await expect(mobileCorrecting.getByRole("button", { name: "Usar este texto" })).toBeVisible()
  await expect(mobileCorrecting).not.toContainText("Por qué está aquí")
  await expect(mobileCorrecting.getByRole("button", { name: "Estuvo bien, quitar de la lista" })).toHaveCount(0)
  const mobileSend = mobileCorrecting.getByRole("button", { name: "Enviar corrección" })
  // Enviar queda a la vista sin desplazar, encima de «Cancelar».
  await expect(mobileCorrecting.getByRole("button", { name: "Cancelar" })).toBeInViewport({ ratio: 1 })
  await expect(mobileSend).toBeInViewport({ ratio: 1 })
  expect((await mobileSend.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect((await mobileCorrecting.getByRole("button", { name: "El tono" }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("corregir-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await mobileCorrecting.getByRole("button", { name: "Cancelar" }).click()
  await expect(mobileCorrecting).toBeHidden()

  // --- Corregir: se puede partir de lo que respondió el equipo y no cambia nada todavía ---
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agent/learn"))
  await item.getByRole("button", { name: "Corregir", exact: true }).click()
  const correcting = sideSurface(page, { name: "Corregir una respuesta de Sofi", exact: true })
  await expect(correcting).toContainText(QUESTION)
  await expect(correcting.getByRole("heading", { level: 3, name: "Por qué está aquí" })).toBeVisible()
  await expect(correcting).toContainText("Alguien de tu equipo escribió justo después")
  await expect(correcting).toContainText("No había precio, fecha ni hora que verificar.")
  await expect(correcting).toContainText("No usó ninguna lección tuya.")
  await expect(correcting.getByLabel("¿Cómo debió responder?")).toHaveValue("")
  await correcting.getByRole("button", { name: "Usar este texto" }).click()
  await expect(correcting.getByLabel("¿Cómo debió responder?")).toHaveValue(TEAM_REPLY)
  await expect(correcting).toContainText("Puse lo que escribió tu equipo.")
  // La fila abierta se marca y deja de ofrecer sus botones.
  await expect(item).toContainText("Abierta al lado")
  await expect(item.getByRole("button", { name: "Corregir", exact: true })).toHaveCount(0)
  await expect(correcting.getByRole("button", { name: "Estuvo bien, quitar de la lista" })).toBeVisible()
  // Sin decir qué falló no se envía: el grupo dice qué falta.
  await correcting.getByRole("button", { name: "Enviar corrección" }).click()
  await expect(correcting.getByRole("group", { name: "¿Qué falló?" })).toContainText("Elige qué falló")
  await correcting.getByRole("button", { name: "Le faltó un dato" }).click()
  await expect(correcting.getByRole("button", { name: "Le faltó un dato" })).toHaveAttribute("aria-pressed", "true")
  // El pie dice en qué se convierte antes de enviarla.
  await expect(correcting).toContainText("Se propone como respuesta oficial")
  await info.attach("corregir", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await correcting.getByRole("button", { name: "Enviar corrección" }).click()

  // --- La lección propuesta se abre para quien administra ---
  const lesson = sideSurface(page, { name: "Lección propuesta", exact: true })
  await expect(lesson.getByRole("heading", { level: 3, name: QUESTION })).toBeVisible()
  await expect(lesson.getByRole("heading", { level: 4, name: "De dónde sale" })).toBeVisible()
  await expect(lesson).toContainText("De una corrección de hoy")
  await expect(lesson).toContainText("a una respuesta de Sofi")
  await expect(lesson).toContainText("Respuesta oficial")
  await expect(lesson).toContainText(FAKE_REPLY)
  await expect(lesson).toContainText(TEAM_REPLY)
  await expect(lesson).toContainText("Todavía no tienes casos de prueba")
  await expect(lesson).toContainText("queda guardada como caso de prueba")
  // Propuesta: el conocimiento sigue igual.
  expect(await knowledge()).toEqual([])
  // La prueba no corre sola: se pide. Responde la pregunta con y sin la lección; con el modelo de demostración, lo dice.
  await expect(lesson.getByRole("img")).toHaveCount(0)
  await lesson.getByRole("button", { name: "Ver cómo respondería con ella" }).click()
  await expect(lesson).toContainText("Lo probé con 1 pregunta", { timeout: 30_000 })
  await expect(lesson.getByRole("img", { name: "1 igual y 0 que cambian" })).toBeVisible()
  await expect(lesson).toContainText("Responde igual")
  await expect(lesson).toContainText("Modelo de demostración")
  // Las decisiones quedan a la vista aunque el contenido se desplace.
  for (const name of ["Aprobar y activar", "Editar el texto", "Descartar"]) {
    await expect(lesson.getByRole("button", { name })).toBeInViewport({ ratio: 1 })
  }
  await info.attach("leccion-propuesta", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // Editar el texto antes de aprobar.
  await lesson.getByRole("button", { name: "Editar el texto" }).click()
  await lesson.getByLabel("Título").fill("Atención a niños")
  await lesson.getByRole("button", { name: "Guardar cambios" }).click()
  await expect(lesson.getByRole("heading", { level: 3, name: "Atención a niños" })).toBeVisible()
  await lesson.getByRole("button", { name: "Aprobar y activar" }).click()
  await expect(lesson).toBeHidden()

  await expect(review.getByRole("heading", { level: 2 })).toHaveText("Por revisar")
  // Vacío con su salida: corregir también se puede desde la Bandeja.
  await expect(review.getByRole("button", { name: "Ir a la Bandeja" })).toBeVisible()
  await expect(learned.getByRole("heading", { level: 2 })).toHaveText("Lo aprendido · 1")
  await expect(learned).toContainText("Atención a niños")
  await expect(learned).toContainText("Sin usar todavía")
  await expect(learned).toContainText("1 caso de prueba guardado")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("aprender-lo-aprendido", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  expect(await knowledge()).toEqual([expect.objectContaining({ title: "Atención a niños", body: TEAM_REPLY, state: "vigente" })])
  expect(await learning()).toMatchObject({ review: [], proposed: [], cases: 1 })

  // --- Retirar se confirma en un diálogo y la devuelve a como estaba; restaurar la vuelve a activar ---
  await learned.getByRole("button", { name: "Retirar" }).click()
  const withdrawing = page.getByRole("alertdialog", { name: "Retirar «Atención a niños»" })
  await expect(withdrawing).toContainText("La aprobó")
  await expect(withdrawing).toContainText("sin usar todavía")
  await expect(withdrawing).toContainText("Deja de usarla al instante.")
  // Su caso de prueba se retira con ella salvo que se desmarque.
  await expect(withdrawing.getByRole("checkbox", { name: /Retirar también su caso de prueba/ })).toBeChecked()
  await expect(withdrawing.getByRole("button", { name: "Cancelar" })).toBeVisible()
  await info.attach("retirar", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await withdrawing.getByRole("button", { name: "Retirar la respuesta" }).click()
  await expect(withdrawing).toBeHidden()
  expect((await knowledge())[0]).toMatchObject({ state: "borrador" })
  expect(await learning()).toMatchObject({ learned: [], cases: 0 })
  // Las retiradas no ocupan la pantalla: se abren desde el pie de «Lo aprendido».
  const retired = learned.getByRole("button", { name: "Retiradas · 1, se pueden restaurar" })
  await expect(retired).toHaveAttribute("aria-expanded", "false")
  await expect(learned.getByRole("button", { name: /^Restaurar/ })).toHaveCount(0)
  await retired.click()
  await expect(retired).toHaveAttribute("aria-expanded", "true")
  await info.attach("aprender-retiradas", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await learned.getByRole("button", { name: /^Restaurar/ }).click()
  const restoring = sideSurface(page, { name: "Restaurar «Atención a niños»", exact: true })
  await restoring.getByRole("button", { name: "Restaurar" }).click()
  await expect(restoring).toBeHidden()
  await expect(learned.getByRole("heading", { level: 2 })).toHaveText("Lo aprendido · 1")
  expect((await knowledge())[0]).toMatchObject({ state: "vigente" })
  expect(await learning()).toMatchObject({ cases: 1 })

  // --- Desde la Bandeja: corregir otra respuesta deja una lección por aprobar ---
  const andres = nextEventId()
  await send(andres, "¿Tienen estacionamiento?")
  await expect.poll(async () => (await conversations()).length, { timeout: 30_000 }).toBe(2)
  const second = (await conversations()).find((row) => row.id !== conversationId)!.id
  await expect.poll(async () => (await traces(second)).length, { timeout: 45_000 }).toBe(1)
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${second}`))
  await page.getByRole("button", { name: "En qué se basó" }).click()
  await page.getByRole("dialog", { name: "En qué se basó" }).getByRole("button", { name: "Corregir", exact: true }).click()
  const parking = page.getByRole("dialog", { name: "Corregir una respuesta" })
  await expect(parking).toContainText("¿Tienen estacionamiento?")
  await parking.getByRole("button", { name: "Le faltó un dato" }).click()
  const corrected = "En Miraflores tenemos estacionamiento gratis para pacientes."
  await parking.getByLabel("¿Cómo debió responder?").fill(corrected)
  await info.attach("corregir-desde-bandeja", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await parking.getByRole("button", { name: "Enviar corrección" }).click()
  await expect(parking).toBeHidden()
  // Nada cambió por sí solo: el agente sigue sabiendo lo mismo hasta que se apruebe.
  await expect.poll(async () => (await learning()).proposed.map((row) => row.body)).toEqual([corrected])
  expect((await learning()).proposed[0]).toMatchObject({ kind: "respuesta_oficial", question: "¿Tienen estacionamiento?" })
  expect(await knowledge()).toHaveLength(1)

  // --- Una respuesta ya corregida no se corrige dos veces ---
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  await page.getByRole("button", { name: "En qué se basó" }).click()
  const trace = page.getByRole("dialog", { name: "En qué se basó" })
  // Esa respuesta ya se corrigió: el servidor lo dice al intentar otra vez.
  await trace.getByRole("button", { name: "Corregir", exact: true }).click()
  const fromInbox = page.getByRole("dialog", { name: "Corregir una respuesta" })
  await expect(fromInbox).toContainText(QUESTION)
  await fromInbox.getByRole("button", { name: "El tono" }).click()
  await fromInbox.getByLabel("¿Cómo debió responder?").fill("Otra respuesta")
  await fromInbox.getByRole("button", { name: "Enviar corrección" }).click()
  await expect(fromInbox).toContainText("Esa respuesta ya se revisó")
  // Cerrar con cambios sin guardar pregunta antes.
  await fromInbox.getByRole("button", { name: "Cancelar" }).click()
  const leave = page.getByRole("alertdialog", { name: "¿Salir sin guardar?" })
  await leave.getByRole("button", { name: "Descartar y salir", exact: true }).click()
  await expect(fromInbox).toBeHidden()

  // --- Teléfono: pestañas en píldoras y secciones que se abren ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agent/learn"))
  await expect(tabs.getByRole("link", { name: /^Aprender/ })).toHaveText(/Aprender · 1 pendiente/)
  expect((await tabs.getByRole("link", { name: /^Aprender/ }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expect(toApprove.getByRole("heading", { level: 2 })).toHaveText("Lecciones por aprobar · 1")
  const open = toApprove.getByRole("button", { name: /^Ver y aprobar/ })
  await expect(open).toBeHidden()
  await toApprove.getByRole("button", { name: /^Lecciones por aprobar/ }).click()
  await expect(toApprove).toContainText("De una corrección de hoy.")
  expect((await open.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await learned.getByRole("button", { name: /^Lo aprendido/ }).click()
  await expect(learned.getByRole("button", { name: /^Retirar/ })).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("aprender-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await open.click()
  const mobileLesson = page.getByRole("dialog", { name: "Lección propuesta" })
  await expect(mobileLesson).toContainText("Tu caso de prueba no toca este tema")
  await expect(mobileLesson.getByRole("button", { name: "Cerrar" })).toBeInViewport({ ratio: 1 })
  await expect(mobileLesson.getByRole("button", { name: "Aprobar y activar" })).toBeInViewport({ ratio: 1 })
  expect((await mobileLesson.getByRole("button", { name: "Aprobar y activar" }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
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

test("aprender: lo que buscó y no encontró se revisa aquí y se decide como cualquier otra respuesta", async ({
  owner,
  fixtureDb,
  nextEventId,
}, info) => {
  test.setTimeout(240_000)
  const { page, org } = owner
  const learning = () => call<Learning>(page, "GET", "/api/agent/learning", org.slug)
  const knowledge = () => call<Knowledge[]>(page, "GET", "/api/agent/knowledge", org.slug)
  const tg = await call<{ id: string; webhookSecret: string }>(page, "POST", "/api/channels/connections", org.slug, {
    channel: "telegram", provider: "telegram_bot_api", displayName: "Bot E2E", config: { botToken: "e2e" },
  }, 201)
  await call(page, "PUT", "/api/agent/config", org.slug, { enabled: true })
  const conversations = () => call<Array<{ id: string }>>(page, "GET", "/api/conversations", org.slug)
  // El modelo de pruebas no usa herramientas: lo que no encontró se anota como lo hace el
  // agente al buscar sin resultado; la pregunta y su respuesta salen por el recorrido real.
  const ask = async (text: string, query: string) => {
    const before = (await conversations()).map((row) => row.id)
    const from = nextEventId()
    expect(await simulateTelegramInbound(page, API, tg.id, tg.webhookSecret, { fromId: from, chatId: from, text, updateId: nextEventId() })).toBe(200)
    await expect.poll(async () => (await conversations()).length, { timeout: 30_000 }).toBe(before.length + 1)
    const conversationId = (await conversations()).find((row) => !before.includes(row.id))!.id
    await expect
      .poll(async () => (await call<Array<{ id: string }>>(page, "GET", `/api/agent/answer-traces?conversationId=${conversationId}`, org.slug)).length, { timeout: 45_000 })
      .toBe(1)
    const [asked] = await fixtureDb
      .select({ id: message.id, createdAt: message.createdAt })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.direction, "in")))
    await fixtureDb.insert(agentKnowledgeGap).values({
      organizationId: org.id, conversationId, triggerMessageId: asked!.id, question: text, query, createdAt: asked!.createdAt,
    })
  }
  await ask("¿Trabajan con alineadores invisibles?", "alineadores invisibles")
  await ask("¿Tienen alineadores invisibles?", "alineadores invisibles")
  await ask("¿Tienen wifi para pacientes?", "wifi")
  await ask("¿Dónde dejo mi bici?", "dejar bicicleta")

  // El número ya está al día sin haber abierto la lista: lo mismo en el resumen, la pestaña y la sección.
  const needsYou = () => call<{ needsYou: { review: number; lessons: number } }>(page, "GET", "/api/agent/overview", org.slug).then((row) => row.needsYou)
  expect(await needsYou()).toEqual({ review: 3, lessons: 0 })
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agent/learn"))
  const review = page.getByRole("region", { name: /^Por revisar/ })
  const toApprove = page.getByRole("region", { name: /^Lecciones por aprobar/ })
  const learned = page.getByRole("region", { name: /^Lo aprendido/ })
  const tabs = page.getByRole("navigation", { name: "Secciones del agente" })
  await expect(review.getByRole("heading", { level: 2 })).toHaveText("Por revisar · 3")
  await expect(tabs.getByRole("link", { name: /^Aprender/ })).toHaveText(/Aprender · 3 pendientes/)
  await expect(tabs.getByRole("link", { name: /^Conocimiento/ })).toHaveText("Conocimiento")
  expect(await needsYou()).toEqual({ review: 3, lessons: 0 })

  // La fila dice lo que escribió, lo que buscó, lo que respondió y cuántas veces lo preguntaron.
  const rowOf = (query: string) => review.getByRole("listitem").filter({ hasText: query })
  const aligners = rowOf("alineadores invisibles")
  await expect(aligners).toHaveCount(1)
  await expect(aligners).toContainText("Buscó y no encontró")
  await expect(aligners).toContainText("2 veces esta semana")
  await expect(aligners).toContainText(FAKE_REPLY)
  await expect(aligners.getByRole("button")).toHaveText(["", "Estuvo bien", "Corregir"])
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("no-encontro-fila", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // «Estuvo bien» dice que nada cambia y se puede deshacer; se guarda como ejemplo desde su aviso.
  await aligners.getByRole("button", { name: "Estuvo bien", exact: true }).click()
  await expect(review.getByRole("heading", { level: 2 })).toHaveText("Por revisar · 2")
  const notice = review.getByRole("status").filter({ hasText: "alineadores invisibles" })
  await expect(notice).toContainText("Sofi sigue respondiendo igual.")
  await info.attach("no-encontro-estuvo-bien", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await notice.getByRole("button", { name: "Deshacer" }).click()
  await expect(review.getByRole("heading", { level: 2 })).toHaveText("Por revisar · 3")
  await expect(aligners.getByRole("button", { name: "Estuvo bien", exact: true })).toBeVisible()
  await expect(notice).toHaveCount(0)
  await aligners.getByRole("button", { name: "Estuvo bien", exact: true }).click()
  await notice.getByRole("button", { name: "Guardar como ejemplo" }).click()
  await expect(notice).toContainText("quedó como ejemplo por aprobar")
  await expect(toApprove.getByRole("heading", { level: 2 })).toHaveText("Lecciones por aprobar · 1")
  expect((await learning()).proposed).toEqual([expect.objectContaining({ kind: "ejemplo" })])

  // Corregir: la conversación arriba, qué falló ya elegido y la pregunta para que se encuentre.
  await rowOf("dejar bicicleta").getByRole("button", { name: "Corregir", exact: true }).click()
  const correcting = sideSurface(page, { name: "Corregir una respuesta de Sofi", exact: true })
  await expect(correcting.getByRole("region", { name: "La conversación" })).toContainText("¿Dónde dejo mi bici?")
  await expect(correcting.getByRole("region", { name: "La conversación" })).toContainText(FAKE_REPLY)
  await expect(correcting).toContainText("Buscó «dejar bicicleta» y no encontró nada.")
  await expect(correcting.getByRole("button", { name: "Le faltó un dato" })).toHaveAttribute("aria-pressed", "true")
  await expect(correcting.getByLabel("La pregunta", { exact: true })).toHaveValue("dejar bicicleta")
  await correcting.getByLabel("La pregunta", { exact: true }).fill("Dónde dejar la bicicleta")
  await correcting.getByLabel("¿Cómo debió responder?").fill("Hay un bicicletero en la entrada.")
  await expect(correcting).toContainText("Se propone como respuesta oficial")
  await info.attach("no-encontro-corregir", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await correcting.getByRole("button", { name: "Enviar corrección" }).click()

  // Nada se publica hasta aprobarla; aprobada, se retira desde «Lo aprendido».
  const lesson = sideSurface(page, { name: "Lección propuesta", exact: true })
  await expect(lesson.getByRole("heading", { level: 3, name: "Dónde dejar la bicicleta" })).toBeVisible()
  await expect(lesson).not.toContainText("A quién se aplica")
  expect(await knowledge()).toEqual([])
  await lesson.getByRole("button", { name: "Aprobar y activar" }).click()
  await expect(lesson).toBeHidden()
  await expect.poll(async () => (await knowledge()).map((entry) => [entry.title, entry.state, entry.askForms])).toEqual([
    ["Dónde dejar la bicicleta", "vigente", ["dejar bicicleta"]],
  ])
  await learned.getByRole("button", { name: "Retirar «Dónde dejar la bicicleta»" }).click()
  const withdrawing = page.getByRole("alertdialog", { name: "Retirar «Dónde dejar la bicicleta»" })
  await withdrawing.getByRole("button", { name: "Retirar la respuesta" }).click()
  await expect(withdrawing).toBeHidden()
  await expect.poll(async () => (await knowledge())[0]?.state).toBe("borrador")
  await learned.getByRole("button", { name: "Retiradas · 1, se pueden restaurar" }).click()
  await learned.getByRole("button", { name: "Restaurar «Dónde dejar la bicicleta»" }).click()
  const restoring = sideSurface(page, { name: "Restaurar «Dónde dejar la bicicleta»", exact: true })
  await restoring.getByRole("button", { name: "Restaurar" }).click()
  await expect(restoring).toBeHidden()
  await expect.poll(async () => (await knowledge())[0]?.state).toBe("vigente")

  // Sumarla a una respuesta que ya existe no cambia su texto ni deja otra lección.
  await gotoHydrated(page, tenant(org.slug, "/agent/learn"))
  await rowOf("wifi").getByRole("button", { name: "Corregir", exact: true }).click()
  await correcting.getByRole("combobox", { name: "¿Ya tienes una respuesta para esto?" }).click()
  await page.getByRole("option", { name: "Dónde dejar la bicicleta", exact: true }).click()
  await expect(correcting.getByLabel("¿Cómo debió responder?")).toHaveCount(0)
  await expect(correcting).toContainText("Su texto no cambia.")
  // Otra falla no suma: lo elegido no queda oculto y activo.
  await correcting.getByRole("button", { name: "El tono" }).click()
  await expect(correcting.getByRole("button", { name: "Enviar corrección" })).toBeVisible()
  await correcting.getByRole("button", { name: "Le faltó un dato" }).click()
  await expect(correcting.getByRole("button", { name: "Enviar corrección" })).toBeVisible()
  await correcting.getByRole("combobox", { name: "¿Ya tienes una respuesta para esto?" }).click()
  await page.getByRole("option", { name: "Dónde dejar la bicicleta", exact: true }).click()
  await correcting.getByRole("button", { name: "Sumar a esa respuesta" }).click()
  await expect(correcting).toBeHidden()
  await expect(review.getByRole("status").filter({ hasText: "wifi" })).toContainText("se sumó a «Dónde dejar la bicicleta»")
  await expect(review.getByRole("heading", { level: 2 })).toHaveText("Por revisar")
  await expect.poll(async () => (await knowledge())[0]).toMatchObject({
    body: "Hay un bicicletero en la entrada.",
    askForms: ["dejar bicicleta", "¿Tienen wifi para pacientes?", "wifi"],
  })
  expect((await learning()).proposed).toHaveLength(1)
  // Lo que ya no está por revisar no se vuelve a contar.
  expect(await needsYou()).toEqual({ review: 0, lessons: 1 })

  // Teléfono: la fila entra sin desbordes, con botones que se tocan bien.
  await ask("¿Hacen carillas de porcelana?", "carillas porcelana")
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agent/learn"))
  const mobile = rowOf("carillas porcelana")
  await expect(mobile).toContainText("Buscó y no encontró · 1 vez esta semana")
  for (const name of ["Estuvo bien", "Corregir"]) {
    expect((await mobile.getByRole("button", { name, exact: true }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("no-encontro-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await mobile.getByRole("button", { name: "Corregir", exact: true }).click()
  const mobileCorrecting = page.getByRole("dialog", { name: "Corregir una respuesta de Sofi" })
  await expect(mobileCorrecting.getByRole("button", { name: "Enviar corrección" })).toBeInViewport({ ratio: 1 })
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("no-encontro-corregir-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await mobileCorrecting.getByRole("button", { name: "Cancelar" }).click()
  await expect(mobileCorrecting).toBeHidden()

  // Recepción lee la conversación y corrige, pero no suma a una respuesta: lo decide el servidor.
  const [pending] = (await learning()).review
  await fixtureDb.update(member).set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  expect((await api(page, "GET", `/api/agent/learning/review/${pending!.id}/conversation`, org.slug)).status).toBe(200)
  expect((await api(page, "POST", `/api/agent/learning/review/${pending!.id}/add-to-answer`, org.slug, { entryId: pending!.id })).status).toBe(403)
  expect((await api(page, "POST", "/api/agent/learning/guidance/check", org.slug, { body: "Una regla." })).status).toBe(403)
})
