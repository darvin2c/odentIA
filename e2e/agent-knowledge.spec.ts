import { agentLesson } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant } from "./env"
import { api, call, chooseDay, expect, test } from "./fixtures"
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

test("conocimiento: lo que solo tú sabes, respuestas en filas con su detalle y lo que toma de los datos", async ({
  owner,
  fixtureDb,
}, info) => {
  test.setTimeout(240_000)
  const { page, org } = owner
  // Segunda sede: el filtro por sede solo tiene sentido con más de una.
  const [first] = await fixtureDb.select({ id: branch.id, name: branch.name }).from(branch).where(eq(branch.organizationId, org.id))
  await fixtureDb.insert(branch).values({ organizationId: org.id, name: "Miraflores", timezone: "America/Lima" })

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agent/knowledge"))
  const basics = page.getByRole("region", { name: "Lo que solo tú sabes" })
  const answers = page.getByRole("region", { name: /^Respuestas oficiales/ })
  const sources = page.getByRole("region", { name: "Lo que toma de tus datos" })
  const rows = answers.getByRole("listitem")
  const row = (title: string) => rows.filter({ hasText: title })

  // Conocimiento es de Sofi (ADR 0120), y solo muestra lo que sabe: lo que no encontró se revisa en Aprender (ADR 0123).
  await expect(page.getByRole("region", { name: /^No supo responder/ })).toHaveCount(0)
  await expect(page.getByText("Es lo que usa para responder a pacientes. Clío y Argos no lo usan.")).toBeVisible()

  // Lo que solo tú sabes: ocho preguntas opcionales, cada una dice si tiene respuesta, y una sola acción.
  // Lo que está en los datos (horario, medios de pago…) no está aquí: se muestra abajo.
  await expect(basics).toContainText("0 de 8")
  await expect(basics).toContainText("ya tienen respuesta")
  await expect(basics.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0")
  await expect(basics.getByRole("list", { name: "Preguntas" }).getByRole("listitem")).toHaveCount(8)
  await expect(basics.getByRole("listitem").filter({ hasText: "Pago en cuotas" })).toContainText("sin respuesta")
  await expect(basics).not.toContainText("horario")
  await expect(basics.getByRole("button")).toHaveCount(1)
  await expect(basics.getByRole("button", { name: "Responder las 8 que faltan" })).toBeVisible()

  // Lo que toma de tus datos: lo mismo que recibe Sofi, dónde se edita y, en ámbar y con su texto, lo que falta.
  // La sede recién creada no tiene dirección y no hay servicios ni horarios del equipo.
  await expect(sources.getByRole("link", { name: /^Horario de atención.*Nadie del equipo tiene horario/ })).toHaveAttribute("href", /\/settings\/availability$/)
  await expect(sources.getByRole("link", { name: /^Servicios y precios.*Ningún servicio activo/ })).toHaveAttribute("href", /\/services$/)
  await expect(sources.getByRole("link", { name: /^Sedes.*2 sedes.*sin dirección/ })).toHaveAttribute("href", /\/settings\/branches$/)
  await expect(sources.getByRole("link", { name: /^Medios de pago/ })).toHaveAttribute("href", /\/settings\/payment-methods$/)
  await expect(sources.getByRole("link", { name: /^Teléfono de urgencias.*Falta/ })).toBeVisible()
  await expect(sources.getByRole("link")).toHaveCount(8)
  await expect(sources).toContainText("Nada de su historia clínica.")

  // La primera vez: el vacío lleva a lo que solo tú sabes.
  await expect(answers).toContainText("Todavía no le has enseñado nada")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("conocimiento-inicial", { body: await page.screenshot({ fullPage: true, path: info.outputPath("conocimiento-inicial.png") }), contentType: "image/png" })
  await answers.getByRole("button", { name: "Responder lo que solo tú sabes" }).click()
  const basicForm = sideSurface(page, { name: "Responder lo que solo tú sabes", exact: true })
  await expect(basicForm.getByLabel("La pregunta", { exact: true })).toHaveValue("¿Tienen estacionamiento?")
  // Recuerda lo que ya sabe por los datos, para no escribirlo dos veces.
  await expect(basicForm).toContainText("Esto ya lo sabe por tus datos")
  // Se responden en el orden que se quiera, sin perder lo escrito.
  await basicForm.getByLabel("La respuesta", { exact: true }).fill("Sí, cuatro plazas para pacientes.")
  await basicForm.getByRole("combobox", { name: "Pregunta" }).click()
  await page.getByRole("option", { name: "¿Se puede pagar en cuotas?", exact: true }).click()
  await expect(basicForm.getByLabel("La pregunta", { exact: true })).toHaveValue("¿Se puede pagar en cuotas?")
  await expect(basicForm.getByLabel("La respuesta", { exact: true })).toHaveValue("Sí, cuatro plazas para pacientes.")
  await basicForm.getByRole("combobox", { name: "Pregunta" }).click()
  await page.getByRole("option", { name: "¿Tienen estacionamiento?", exact: true }).click()
  await basicForm.getByRole("button", { name: "Guardar y seguir" }).click()
  // Al guardar pasa a la siguiente que falta, con la respuesta en blanco.
  await expect(basicForm.getByLabel("La pregunta", { exact: true })).toHaveValue("¿El local es accesible para silla de ruedas?")
  await expect(basicForm.getByLabel("La respuesta", { exact: true })).toHaveValue("")
  await info.attach("lo-que-solo-tu-sabes", { body: await page.screenshot({ fullPage: false, path: info.outputPath("lo-que-solo-tu-sabes.png") }), contentType: "image/png" })
  await basicForm.getByRole("button", { name: "Cancelar" }).click()
  await expect(basicForm).toBeHidden()
  await expect(basics).toContainText("1 de 8")
  await expect(basics.getByRole("listitem").filter({ hasText: "Estacionamiento" })).toContainText("con respuesta")
  await expect(row("¿Tienen estacionamiento?")).toContainText("Publicada")
  await basics.getByRole("button", { name: "Responder las 7 que faltan" }).click()
  await expect(basicForm.getByLabel("La pregunta", { exact: true })).toHaveValue("¿El local es accesible para silla de ruedas?")
  await basicForm.getByRole("button", { name: "Cancelar" }).click()
  await expect(basicForm).toBeHidden()

  // Dos respuestas nuevas: para todas las sedes y sin vencimiento.
  const promoForm = sideSurface(page, { name: "Nueva respuesta", exact: true })
  for (const [title, body] of [[QUESTION, TEAM_ANSWER], ["Venta de cepillos", "Sí, en recepción."]] as const) {
    await answers.getByRole("button", { name: "Nueva respuesta", exact: true }).click()
    await promoForm.getByLabel("La pregunta", { exact: true }).fill(title)
    await promoForm.getByLabel("La respuesta", { exact: true }).fill(body)
    await promoForm.getByRole("button", { name: "Guardar", exact: true }).click()
    await expect(promoForm).toBeHidden()
    await expect(row(title)).toContainText("Publicada")
  }

  // Nueva respuesta de una sede y ya vencida: la fila dice sede, vencimiento y estado.
  await answers.getByRole("button", { name: "Nueva respuesta", exact: true }).click()
  await promoForm.getByLabel("La pregunta", { exact: true }).fill("Promoción de blanqueamiento")
  await promoForm.getByLabel("La respuesta", { exact: true }).fill("Dos por uno hasta fin de mes.")
  await promoForm.getByRole("combobox", { name: "Sede" }).click()
  await page.getByRole("option", { name: "Solo Miraflores", exact: true }).click()
  await chooseDay(promoForm.getByLabel("Vale hasta", { exact: true }), day(-1))
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

  // Teléfono: «Nueva respuesta» fija al pie, lo que solo tú sabes con su acción a todo el ancho y filas de dos líneas, sin desbordes.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agent/knowledge"))
  await expect(basics).toContainText("1 de 8")
  const create390 = page.getByRole("button", { name: "Nueva respuesta", exact: true })
  await expect(create390).toHaveCount(1)
  await expect(create390).toBeInViewport({ ratio: 1 })
  expect((await create390.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  const basicsButton = basics.getByRole("button", { name: "Responder las 7 que faltan" })
  await expect(basicsButton).toBeVisible()
  expect((await basicsButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expect(rows.first()).toContainText(/Publicada · todas las sedes|Vence el|Cambio por aprobar · todas las sedes/)
  expect((await rows.first().getByRole("button").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("conocimiento-movil", { body: await page.screenshot({ fullPage: true, path: info.outputPath("conocimiento-movil.png") }), contentType: "image/png" })
  // Cada fila de datos se toca entera.
  expect((await sources.getByRole("link").first().boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await basicsButton.click()
  const mobileBasics = page.getByRole("dialog", { name: "Responder lo que solo tú sabes" })
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
  expect((await api(page, "GET", "/api/agent/knowledge/basics", org.slug)).status).toBe(403)
  expect((await api(page, "GET", "/api/agent/knowledge/sources", org.slug)).status).toBe(403)
})
