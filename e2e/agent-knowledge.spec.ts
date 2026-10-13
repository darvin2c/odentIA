import { agentKnowledgeGap, agentLesson } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
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
const TEAM_ANSWER = "Sí, hay un bicicletero en la entrada."

test("conocimiento: lo que no supo responder, lo básico, respuestas en filas con su detalle y lo que toma de los datos", async ({
  owner,
  fixtureDb,
  nextEventId,
}, info) => {
  test.setTimeout(240_000)
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
  // Las preguntas sin respuesta se registran como lo hace el agente al buscar
  // sin resultado (el modelo de pruebas no usa herramientas); la respuesta del
  // equipo sí sale por el recorrido real. Las que se registran después de esa
  // respuesta quedan sin nadie que las haya respondido.
  const gap = { organizationId: org.id, conversationId }
  await fixtureDb.insert(agentKnowledgeGap).values({ ...gap, question: QUESTION, query: "estacionamiento bicicletas" })
  await call(page, "POST", `/api/conversations/${conversationId}/messages`, org.slug, { text: TEAM_ANSWER }, 201)
  await fixtureDb.insert(agentKnowledgeGap).values([
    { ...gap, question: "¿Venden cepillos?", query: "cepillos" },
    { ...gap, question: "¿Tienen wifi?", query: "wifi" },
    { ...gap, question: "¿Puedo ir con mi perro?", query: "perro" },
  ])
  // Segunda sede: el filtro por sede solo tiene sentido con más de una.
  const [first] = await fixtureDb.select({ id: branch.id, name: branch.name }).from(branch).where(eq(branch.organizationId, org.id))
  await fixtureDb.insert(branch).values({ organizationId: org.id, name: "Miraflores", timezone: "America/Lima" })

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agent/knowledge"))
  const gaps = page.getByRole("region", { name: /^No supo responder/ })
  const basics = page.getByRole("region", { name: "Lo básico de una clínica" })
  const answers = page.getByRole("region", { name: /^Respuestas oficiales/ })
  const sources = page.getByRole("region", { name: "Lo que toma de tus datos" })
  const rows = answers.getByRole("listitem")
  const row = (title: string) => rows.filter({ hasText: title })

  // No supo responder: lo que el equipo ya respondió se guarda con un toque o se edita antes; lo demás se responde.
  await expect(gaps.getByRole("heading")).toHaveText("No supo responder · 4")
  const answeredGap = gaps.getByRole("listitem").filter({ hasText: QUESTION })
  await expect(answeredGap).toContainText("Tu equipo respondió")
  await expect(answeredGap).toContainText(`«${TEAM_ANSWER}»`)
  await expect(answeredGap).toContainText("1 vez esta semana")
  await expect(answeredGap.getByRole("button", { name: "Editar antes" })).toBeVisible()
  await expect(gaps.getByRole("button", { name: "Guardar como respuesta oficial" })).toHaveCount(1)
  // Solo las primeras quedan a la vista.
  await expect(gaps.getByRole("button", { name: "Responder", exact: true })).toHaveCount(2)
  await gaps.getByRole("button", { name: "Ver las 4" }).click()
  await expect(gaps.getByRole("button", { name: "Responder", exact: true })).toHaveCount(3)

  // Lo básico: cifra grande, barra, las que faltan como etiquetas y una sola acción.
  // La sede recién creada no tiene dirección ni hay servicios: de lo básico solo
  // se cubren solos los medios de pago, que la clínica ya tiene activos en caja.
  await expect(basics).toContainText("1 de 25")
  await expect(basics).toContainText("ya tienen respuesta")
  await expect(basics.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1")
  await expect(basics.getByRole("heading", { name: "Las que faltan" })).toBeVisible()
  await expect(basics.getByRole("listitem")).toHaveCount(5)
  await expect(basics).toContainText("y 20 más")
  await expect(basics.getByRole("button")).toHaveCount(1)

  // Lo que toma de tus datos: cifras del sistema y dónde se editan.
  await expect(sources.getByRole("link", { name: /Servicios y precios.*Ningún servicio con precio todavía.*Se editan en Servicios/ })).toBeVisible()
  await expect(sources.getByRole("link", { name: /Sedes y horarios.*2 sedes.*Se editan en Sucursales/ })).toBeVisible()

  // La primera vez: el vacío lleva a lo básico.
  await expect(answers).toContainText("Todavía no le has enseñado nada")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("conocimiento-inicial", { body: await page.screenshot({ fullPage: true, path: info.outputPath("conocimiento-inicial.png") }), contentType: "image/png" })
  await answers.getByRole("button", { name: "Empezar con lo básico" }).click()
  const basicForm = sideSurface(page, { name: "Responder lo básico", exact: true })
  await expect(basicForm.getByLabel("La pregunta", { exact: true })).toHaveValue("¿Cuál es el horario de atención?")
  // Se responden en el orden que se quiera, sin perder lo escrito.
  await basicForm.getByLabel("La respuesta", { exact: true }).fill("Sí, cuatro plazas para pacientes.")
  await basicForm.getByRole("combobox", { name: "Pregunta básica" }).click()
  await page.getByRole("option", { name: "¿Tienen estacionamiento?", exact: true }).click()
  await expect(basicForm.getByLabel("La pregunta", { exact: true })).toHaveValue("¿Tienen estacionamiento?")
  await expect(basicForm.getByLabel("La respuesta", { exact: true })).toHaveValue("Sí, cuatro plazas para pacientes.")
  await basicForm.getByRole("button", { name: "Guardar y seguir" }).click()
  // Al guardar pasa a la siguiente que falta, con la respuesta en blanco.
  await expect(basicForm.getByLabel("La pregunta", { exact: true })).toHaveValue("¿El local es accesible para silla de ruedas?")
  await expect(basicForm.getByLabel("La respuesta", { exact: true })).toHaveValue("")
  await basicForm.getByRole("button", { name: "Cancelar" }).click()
  await expect(basicForm).toBeHidden()
  await expect(basics).toContainText("2 de 25")
  await expect(basics).toContainText("y 19 más")
  await expect(row("¿Tienen estacionamiento?")).toContainText("Publicada")
  await basics.getByRole("button", { name: "Responder las que faltan" }).click()
  await expect(basicForm.getByLabel("La pregunta", { exact: true })).toHaveValue("¿Cuál es el horario de atención?")
  await basicForm.getByRole("button", { name: "Cancelar" }).click()
  await expect(basicForm).toBeHidden()

  // «Editar antes» abre el formulario con la pregunta y lo que respondió el equipo; guardar tal cual no pide nada más.
  await answeredGap.getByRole("button", { name: "Editar antes" }).click()
  const answerForm = sideSurface(page, { name: "Guardar como respuesta oficial", exact: true })
  await expect(answerForm.getByLabel("La pregunta", { exact: true })).toHaveValue(QUESTION)
  await expect(answerForm.getByLabel("La respuesta", { exact: true })).toHaveValue(TEAM_ANSWER)
  await expect(answerForm.getByRole("link", { name: "Ver la conversación" })).toBeVisible()
  await answerForm.getByRole("button", { name: "Cancelar" }).click()
  await expect(answerForm).toBeHidden()
  await gaps.getByRole("button", { name: "Guardar como respuesta oficial" }).click()
  await expect(gaps.getByRole("heading")).toHaveText("No supo responder · 3")
  await expect(row(QUESTION)).toContainText("Publicada")
  await expect(gaps.getByRole("button", { name: "Guardar como respuesta oficial" })).toHaveCount(0)

  // «Responder» una sin respuesta: la forma en que la preguntaron queda como otra forma de pedirla.
  await gaps.getByRole("listitem").filter({ hasText: "¿Venden cepillos?" }).getByRole("button", { name: "Responder", exact: true }).click()
  await expect(answerForm.getByLabel("La respuesta", { exact: true })).toHaveValue("")
  await answerForm.getByLabel("La pregunta", { exact: true }).fill("Venta de cepillos")
  await answerForm.getByLabel("La respuesta", { exact: true }).fill("Sí, en recepción.")
  await answerForm.getByRole("button", { name: "Guardar y publicar" }).click()
  await expect(answerForm).toBeHidden()
  await expect(row("Venta de cepillos")).toContainText("También la piden como «¿Venden cepillos?»")
  // Lo que no corresponde responder se descarta desde el mismo formulario.
  await gaps.getByRole("listitem").filter({ hasText: "¿Puedo ir con mi perro?" }).getByRole("button", { name: "Responder", exact: true }).click()
  await answerForm.getByRole("button", { name: "No hace falta responderla: descartar" }).click()
  await expect(answerForm).toBeHidden()
  await expect(gaps.getByRole("heading")).toHaveText("No supo responder · 1")

  // Nueva respuesta de una sede y ya vencida: la fila dice sede, vencimiento y estado.
  await answers.getByRole("button", { name: "Nueva respuesta", exact: true }).click()
  const promoForm = sideSurface(page, { name: "Nueva respuesta", exact: true })
  await promoForm.getByLabel("La pregunta", { exact: true }).fill("Promoción de blanqueamiento")
  await promoForm.getByLabel("La respuesta", { exact: true }).fill("Dos por uno hasta fin de mes.")
  await promoForm.getByRole("combobox", { name: "Sede" }).click()
  await page.getByRole("option", { name: "Solo Miraflores", exact: true }).click()
  await promoForm.getByLabel("Vale hasta", { exact: true }).fill(day(-1))
  await promoForm.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(promoForm).toBeHidden()
  const promo = row("Promoción de blanqueamiento")
  await expect(promo).toContainText("Miraflores")
  await expect(promo).toContainText("Venció el")
  await expect(promo).toContainText("Vencida")
  await expect(row("Venta de cepillos")).toContainText("Todas las sedes")
  await expect(row("Venta de cepillos")).toContainText("Sin vencimiento")

  // Una que vence pronto, otra en borrador y otra más: con seis, la lista se recorta.
  const create = async (body: Record<string, unknown>, publish = true) => {
    const created = await call<Entry>(page, "POST", "/api/agent/knowledge", org.slug, { kind: "faq", ...body }, 201)
    if (publish) await call(page, "POST", `/api/agent/knowledge/${created.id}/status`, org.slug, { status: "publicada" })
    return created
  }
  const campaign = await create({ title: "Campaña de limpieza", body: "Limpieza a mitad de precio.", validUntil: day(3) })
  const policy = await create({ title: "Política de cancelación", body: "Avisa con un día de anticipación." }, false)
  await create({ title: "Atención a niños", body: "Desde los tres años." })
  // «Aprender»: una corrección por aprobar sobre una respuesta y otra ya aprobada que creó la suya.
  const parking = (await call<Entry[]>(page, "GET", "/api/agent/knowledge?limit=100", org.slug)).find((entry) => entry.title === "¿Tienen estacionamiento?")!
  const lesson = { organizationId: org.id, kind: "respuesta_oficial" as const, scope: "clinica", proposedBy: owner.user.id }
  await fixtureDb.insert(agentLesson).values([
    { ...lesson, title: "Campaña de limpieza", body: "Limpieza al 30 % de descuento.", status: "propuesta", knowledgeEntryId: campaign.id },
    { ...lesson, title: "¿Tienen estacionamiento?", body: "Sí, cuatro plazas para pacientes.", status: "activa", knowledgeEntryId: parking.id, uses: 9 },
  ])
  await gotoHydrated(page, tenant(org.slug, "/agent/knowledge"))
  await expect(answers.getByRole("heading")).toHaveText("Respuestas oficiales · 7")
  await expect(rows).toHaveCount(5)
  await answers.getByRole("button", { name: "Ver las 7" }).click()
  await expect(rows).toHaveCount(7)
  await expect(row("Campaña de limpieza")).toContainText("Vence el")
  await expect(row("Campaña de limpieza")).toContainText("Cambio por aprobar")
  await expect(row("Política de cancelación")).toContainText("Todavía no la usa: está en borrador")
  await expect(row("Política de cancelación")).toContainText("Borrador")
  await expect(row("¿Tienen estacionamiento?")).toContainText("Aprendida de una corrección · usada 9 veces")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("conocimiento-con-respuestas", { body: await page.screenshot({ fullPage: true, path: info.outputPath("conocimiento-con-respuestas.png") }), contentType: "image/png" })

  // Buscar, filtrar por sede y, dentro de «Filtros», por estado.
  await answers.getByRole("searchbox", { name: "Buscar una respuesta" }).fill("cepillos")
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText("Venta de cepillos")
  await answers.getByRole("searchbox", { name: "Buscar una respuesta" }).fill("")
  await expect(rows).toHaveCount(7)
  await answers.getByRole("combobox", { name: "Sede" }).click()
  await page.getByRole("option", { name: first!.name, exact: true }).click()
  // Lo que vale en esa sede: lo de todas, sin lo que es solo de otra.
  await expect(rows).toHaveCount(6)
  await expect(promo).toHaveCount(0)
  await answers.getByRole("combobox", { name: "Sede" }).click()
  await page.getByRole("option", { name: "Todas las sedes", exact: true }).click()
  await expect(rows).toHaveCount(7)
  await answers.getByRole("button", { name: "Filtros", exact: true }).click()
  const filters = page.getByRole("dialog", { name: "Filtros" })
  await filters.getByRole("option", { name: /Vencidas/ }).click()
  await filters.getByRole("button", { name: "Cerrar", exact: true }).last().click()
  await expect(rows).toHaveCount(1)
  await expect(promo).toBeVisible()
  await answers.getByRole("button", { name: "Filtros: Vencidas" }).click()
  await filters.getByRole("button", { name: "Limpiar", exact: true }).last().click()
  await filters.getByRole("button", { name: "Cerrar", exact: true }).last().click()
  await expect(rows).toHaveCount(7)

  // La fila abre el detalle: ahí están las versiones, publicar o despublicar y editar.
  await row("Política de cancelación").getByRole("button").click()
  const detail = sideSurface(page, { name: "Respuesta oficial", exact: true })
  await expect(detail).toContainText("Avisa con un día de anticipación.")
  await detail.getByRole("button", { name: "Ver versiones · v1" }).click()
  await expect(detail.getByRole("list", { name: "Versiones" })).toContainText("Versión 1")
  await detail.getByRole("button", { name: "Publicar", exact: true }).click()
  await expect(detail.getByRole("button", { name: "Despublicar", exact: true })).toBeVisible()
  await detail.getByRole("button", { name: "Editar", exact: true }).click()
  const editForm = sideSurface(page, { name: "Editar respuesta", exact: true })
  await expect(editForm.getByLabel("La pregunta", { exact: true })).toHaveValue("Política de cancelación")
  await editForm.getByLabel("La respuesta", { exact: true }).fill("Avisa con dos días de anticipación.")
  await editForm.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(editForm).toBeHidden()
  await expect(row("Política de cancelación")).toContainText("Publicada")
  expect((await call<Entry>(page, "GET", `/api/agent/knowledge/${policy.id}`, org.slug)).body).toBe("Avisa con dos días de anticipación.")
  // Un cambio por aprobar lleva a su lección.
  await row("Campaña de limpieza").getByRole("button").click()
  await expect(detail).toContainText("Hay un cambio por aprobar.")
  await detail.getByRole("button", { name: "Ver el cambio" }).click()
  const lessonSurface = sideSurface(page, { name: /Lección/ })
  await expect(lessonSurface).toContainText("Limpieza al 30 % de descuento.")
  await page.keyboard.press("Escape")
  await expect(lessonSurface).toBeHidden()

  const listed = await call<Entry[]>(page, "GET", "/api/agent/knowledge?limit=100", org.slug)
  expect(listed.map((entry) => `${entry.title}:${entry.state}`).sort()).toEqual([
    "Atención a niños:vigente",
    "Campaña de limpieza:vigente",
    "Política de cancelación:vigente",
    "Promoción de blanqueamiento:vencida",
    "Venta de cepillos:vigente",
    `${QUESTION}:vigente`,
    "¿Tienen estacionamiento?:vigente",
  ].sort())
  expect(listed.find((entry) => entry.title === "¿Tienen estacionamiento?")?.basicKey).toBe("estacionamiento")
  expect(listed.find((entry) => entry.title === "Venta de cepillos")?.askForms).toEqual(["¿Venden cepillos?"])

  // Teléfono: «Nueva respuesta» fija al pie, lo básico en una tarjeta que se toca y filas de dos líneas, sin desbordes.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agent/knowledge"))
  await expect(basics).toContainText("2 de 25")
  const create390 = page.getByRole("button", { name: "Nueva respuesta", exact: true })
  await expect(create390).toHaveCount(1)
  await expect(create390).toBeInViewport({ ratio: 1 })
  expect((await create390.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expect(basics.getByRole("heading", { name: "Las que faltan" })).toBeHidden()
  const basicsCard = basics.getByRole("button", { name: "Faltan 23. Toca para responderlas." })
  await expect(basicsCard).toBeVisible()
  await expect(rows.first()).toContainText(/Publicada · todas las sedes|Vence el|Cambio por aprobar · todas las sedes/)
  expect((await rows.first().getByRole("button").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect((await gaps.getByRole("button", { name: "Responder", exact: true }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("conocimiento-movil", { body: await page.screenshot({ fullPage: true, path: info.outputPath("conocimiento-movil.png") }), contentType: "image/png" })
  // La tarjeta entera responde al toque, no solo su texto.
  const card = (await basics.boundingBox())!
  await page.mouse.click(card.x + card.width - 24, card.y + 16)
  const mobileBasics = page.getByRole("dialog", { name: "Responder lo básico" })
  await expect(mobileBasics.getByLabel("La respuesta", { exact: true })).toBeVisible()
  await mobileBasics.getByRole("button", { name: "Cancelar" }).click()
  await expect(mobileBasics).toBeHidden()
  // Sigue a la vista después de desplazarse hasta el final.
  await sources.scrollIntoViewIfNeeded()
  await expect(create390).toBeInViewport({ ratio: 1 })
  await info.attach("conocimiento-movil-pie", { body: await page.screenshot({ fullPage: false, path: info.outputPath("conocimiento-movil-pie.png") }), contentType: "image/png" })
  await create390.click()
  const mobileForm = page.getByRole("dialog", { name: "Nueva respuesta" })
  await expect(mobileForm.getByLabel("La respuesta", { exact: true })).toBeVisible()
  await info.attach("conocimiento-formulario-movil", { body: await page.screenshot({ fullPage: false, path: info.outputPath("conocimiento-formulario-movil.png") }), contentType: "image/png" })
  await mobileForm.getByRole("button", { name: "Cancelar" }).click()
  await expect(mobileForm).toBeHidden()

  // Quien solo decide por el agente (recepción) no administra el conocimiento: lo decide el servidor.
  await fixtureDb.update(member).set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  expect((await api(page, "GET", "/api/agent/knowledge/gaps", org.slug)).status).toBe(403)
  expect((await api(page, "GET", "/api/agent/knowledge/basics", org.slug)).status).toBe(403)
  expect((await api(page, "GET", "/api/agent/knowledge/sources", org.slug)).status).toBe(403)
  expect((await api(page, "POST", "/api/agent/knowledge/gaps/discard", org.slug, { ids: [listed[0]!.id] })).status).toBe(403)
})
