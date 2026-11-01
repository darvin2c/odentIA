import { randomUUID } from "node:crypto"
import { LEGAL } from "@odentia/auth/legal"
import type { Db } from "@odentia/db"
import { agentKnowledgeGap } from "@odentia/db/schema/agent"
import { account, user as users } from "@odentia/db/schema/auth"
import { encounter, patientPayment, serviceCatalog } from "@odentia/db/schema/clinical"
import { message } from "@odentia/db/schema/crm"
import { branch, orgProfile } from "@odentia/db/schema/org"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateWhatsAppInbound } from "./channels"
import { hostUrl, latidiaUrl, tenant } from "./env"
import { chooseOption, expect, PASSWORD, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { latestLinkFor } from "./mailpit"
import { surface } from "./surface"

/**
 * latidIA abre (entregas 3 y 4 del issue 229): la misma instalación sirve su
 * dominio con su sesión, su panel y su app; la clínica que nace ahí es médica,
 * se ve con su marca y dice sus palabras. Su ficha (entrega 5) tiene el examen
 * por sistemas y los signos vitales en el tiempo. Lo indicado queda aceptado
 * sin presupuesto, Reportes cuenta la consulta cobrada y un control puede
 * repetirse (entrega 7). Su catálogo es el de un consultorio (entrega 8).
 * Clío dicta la consulta de un médico (entrega 10).
 */

/** Una llamada a la API desde la página, con la sesión de su dominio. */
async function request<T>(
  page: Page,
  apiBase: string,
  method: string,
  path: string,
  slug?: string,
  body?: unknown,
) {
  return page.evaluate(
    async ({ apiBase, method, path, slug, body }) => {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (slug) headers["x-odentia-org"] = slug
      const response = await fetch(`${apiBase}${path}`, {
        method,
        headers,
        credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json()) as T }
    },
    { apiBase, method, path, slug, body },
  )
}

/** La Dra. Vela, con su contraseña de prueba y los términos aceptados. */
async function createVela(fixtureDb: Db, passwordHash: string): Promise<{ id: string; email: string }> {
  const id = randomUUID()
  const email = `latidia-${id}@test.dev`
  await fixtureDb.transaction(async (tx) => {
    await tx.insert(users).values({
      id,
      name: "Elena Vela",
      firstName: "Elena",
      lastName: "Vela",
      email,
      emailVerified: true,
      termsVersion: LEGAL.terms.version,
      termsAcceptedAt: new Date(),
      processingAgreementVersion: LEGAL.agreement.version,
      processingAgreementAcceptedAt: new Date(),
    })
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: id,
      userId: id,
      providerId: "credential",
      password: passwordHash,
      updatedAt: new Date(),
    })
  })
  return { id, email }
}

/** Entra por la API de latidIA y abre su consultorio con una sede: nace en su dominio. */
async function openConsultorio(page: Page, vela: { id: string; email: string }) {
  const api = latidiaUrl("api")
  const signedIn = await request<{ user: { id: string } }>(
    page,
    api,
    "POST",
    "/api/auth/sign-in/email",
    undefined,
    {
      email: vela.email,
      password: PASSWORD,
    },
  )
  expect(signedIn.status).toBe(200)
  const slug = `sanmartin-${vela.id.slice(0, 8)}`
  const created = await request<{ id: string }>(
    page,
    api,
    "POST",
    "/api/auth/organization/create",
    undefined,
    {
      name: "Consultorio San Martín",
      slug,
    },
  )
  expect(created.status).toBe(200)
  expect(
    (
      await request(page, api, "POST", "/api/auth/organization/set-active", undefined, {
        organizationId: created.body.id,
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await request(page, api, "PUT", "/api/org-profile", slug, {
        legalName: "Consultorio San Martín S.A.C.",
        countryCode: "PE",
      })
    ).status,
  ).toBe(200)
  expect(
    (await request(page, api, "POST", "/api/branches", slug, { name: "Sede Central" })).status,
  ).toBe(201)
  return { api, slug, orgId: created.body.id }
}

test("latidIA: su dominio, su sesión, un consultorio médico con su marca y sus palabras", async ({
  browser,
  fixtureDb,
  passwordHash,
}, testInfo) => {
  const vela = await createVela(fixtureDb, passwordHash)
  const { id, email } = vela
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) })

  // El acceso de latidIA: su marca, su título y su voz («Entra a tu consultorio»).
  await gotoHydrated(page, latidiaUrl("app", "/login"))
  await expect(page.locator("html")).toHaveAttribute("data-brand", "latidia")
  await expect(page).toHaveTitle("latidIA")
  await expect(page.getByRole("img", { name: "latidIA" }).first()).toBeVisible()
  await expect(page.getByText("Qué bueno verte. Entra a tu consultorio.")).toBeVisible()
  await shot("acceso")

  // La sesión vive en su dominio: entra por la API de latidIA.
  const { api, slug, orgId } = await openConsultorio(page, vela)

  // Nació en el dominio de latidIA: es un consultorio médico.
  const [profile] = await fixtureDb
    .select({ product: orgProfile.product })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
  expect(profile?.product).toBe("medical")

  // La invitación al equipo sale con la marca de latidIA y lleva a su panel (entrega 4b).
  const invitee = `equipo-${id}@test.dev`
  const invited = await request(page, api, "POST", "/api/auth/organization/invite-member", undefined, {
    email: invitee,
    role: "clinician",
    organizationId: orgId,
  })
  expect(invited.status).toBe(200)
  const link = await latestLinkFor(invitee, "Te invitaron a Consultorio San Martín")
  expect(link.startsWith(latidiaUrl("app", "/accept-invitation/"))).toBe(true)

  // La app de latidIA: el lila, el [72] y «sala» donde odentIA dice «unidad dental».
  await gotoHydrated(page, latidiaUrl(slug, "/agenda"))
  await expect(page.locator("html")).toHaveAttribute("data-brand", "latidia")
  await expect(page).toHaveTitle("latidIA")
  await expect(page.getByRole("img", { name: "latidIA" }).first()).toBeVisible()
  await expect(page.getByText("Esta sede aún no tiene salas")).toBeVisible()
  const primary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
  )
  expect(primary.toLowerCase()).toBe("#6d3fc0")
  await shot("agenda")
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("agenda-telefono")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await shot("agenda-oscuro")
  await page.evaluate(() => document.documentElement.classList.remove("dark"))

  // Nace con los consentimientos de un consultorio, activos: no los de odentIA.
  await gotoHydrated(page, latidiaUrl(slug, "/settings/forms"))
  await expect(page.getByRole("heading", { level: 1, name: "Consentimientos" })).toBeVisible()
  await expect(page.getByText("Procedimiento menor en consultorio")).toBeVisible()
  await expect(page.getByRole("switch", { name: /activo$/ })).toHaveCount(3)
  await expect(page.getByText("Implante dental")).toHaveCount(0)
  await shot("consentimientos")

  // En el dominio de odentIA, con su propia sesión, el consultorio se abre en el suyo.
  await gotoHydrated(page, hostUrl("app", "/login"))
  expect(
    (
      await request(page, hostUrl("api"), "POST", "/api/auth/sign-in/email", undefined, {
        email,
        password: PASSWORD,
      })
    ).status,
  ).toBe(200)
  await page.goto(tenant(slug, "/home"))
  await expect(page).toHaveURL(
    new RegExp(`^${latidiaUrl(slug, "/home").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  )
  await context.close()
})

test("latidIA: en la Bandeja cada tema se responde por su cuenta", async ({ browser, fixtureDb, passwordHash }, testInfo) => {
  const vela = await createVela(fixtureDb, passwordHash)
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await gotoHydrated(page, latidiaUrl("app", "/login"))
  const { api, slug } = await openConsultorio(page, vela)
  const connection = await request<{ data: { id: string } }>(page, api, "POST", "/api/channels/connections", slug, {
    channel: "whatsapp",
    provider: "whatsapp_cloud_api",
    displayName: "WA latidIA",
    config: { phoneNumberId: "E2E-LATIDIA", wabaId: "E2E-WABA", accessToken: "e2e", appSecret: "e2e-secret", templates: [] },
  })
  expect(connection.status).toBe(201)
  const asks = ["¿Atienden a niños?", "Y también quiero saber el costo de la consulta"]
  const threadOf = async (text: string) => {
    const listed = await request<{ data: Array<{ id: string; preview: { body: string | null } | null }> }>(page, api, "GET", "/api/conversations?status=open", slug)
    return listed.body.data.find((row) => row.preview?.body === text)?.id ?? ""
  }
  let thread = ""
  for (const [index, text] of asks.entries()) {
    expect(await simulateWhatsAppInbound(page, api, connection.body.data.id, "e2e-secret", {
      from: "51911100009", phoneNumberId: "E2E-LATIDIA", text, wamid: `wamid.${randomUUID()}`,
    })).toBe(200)
    await expect.poll(() => threadOf(text), { timeout: 30_000 }).not.toBe("")
    thread = await threadOf(text)
    const topic = await request(page, api, "POST", "/api/agent/handoffs", slug, { conversationId: thread, reason: `Tema ${index + 1}`, summary: text, priority: "media" })
    expect(topic.status).toBe(201)
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, latidiaUrl(slug, `/inbox?conversation=${thread}`))
  await expect(page.locator("html")).toHaveAttribute("data-brand", "latidia")
  const list = page.getByRole("region", { name: "Temas por atender" })
  await expect(list).toContainText("2 temas por atender")
  await page.screenshot({ path: testInfo.outputPath("varios-temas.png") })
  await list.getByRole("button", { name: `«${asks[1]}»` }).click()
  const box = page.getByRole("textbox", { name: "Mensaje" })
  await box.fill("La consulta cuesta S/ 80")
  await box.press("Enter")
  await expect(page.getByText(/^Tema resuelto\./)).toBeVisible()
  // Después de enviar la caja no elige sola, aunque quede uno: un segundo mensaje lo citaría.
  await expect(list).toContainText("1 tema por atender")
  await page.getByRole("button", { name: "Dejar pendiente" }).click()
  await expect(list).toContainText("2 temas por atender")
  await page.screenshot({ path: testInfo.outputPath("dejar-pendiente.png") })

  // Un mensaje que el canal rechazó dice por qué y qué hacer; el motivo de Meta no llega a la clínica.
  const rejected = await request<{ data: { id: string } }>(page, api, "POST", `/api/conversations/${thread}/messages`, slug, { text: "Este no sale" })
  expect(rejected.status).toBe(201)
  const rejectedId = rejected.body.data.id
  await expect.poll(async () => (await fixtureDb.select({ status: message.status }).from(message).where(eq(message.id, rejectedId)))[0]?.status, { timeout: 30_000 }).not.toBe("queued")
  await fixtureDb.update(message).set({ status: "failed", error: "WhatsApp send falló: 400 (#131009) Parameter value is not valid" }).where(eq(message.id, rejectedId))
  await gotoHydrated(page, latidiaUrl(slug, `/inbox?conversation=${thread}`))
  await expect(page.getByText(/^No se entregó: el canal no lo aceptó\./)).toBeVisible()
  await expect(page.getByText(/Parameter value/)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("no-se-entrego.png") })
  await context.close()
})

test("latidIA: lo que el agente buscó y no encontró se revisa en Aprender y se enseña con una lección", async ({ browser, fixtureDb, passwordHash }, testInfo) => {
  const vela = await createVela(fixtureDb, passwordHash)
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await gotoHydrated(page, latidiaUrl("app", "/login"))
  const { api, slug, orgId } = await openConsultorio(page, vela)
  const connection = await request<{ data: { id: string } }>(page, api, "POST", "/api/channels/connections", slug, {
    channel: "whatsapp",
    provider: "whatsapp_cloud_api",
    displayName: "WA latidIA",
    config: { phoneNumberId: "E2E-LATIDIA", wabaId: "E2E-WABA", accessToken: "e2e", appSecret: "e2e-secret", templates: [] },
  })
  expect(connection.status).toBe(201)
  const question = "¿Atienden a recién nacidos?"
  expect(await simulateWhatsAppInbound(page, api, connection.body.data.id, "e2e-secret", {
    from: "51911100010", phoneNumberId: "E2E-LATIDIA", text: question, wamid: `wamid.${randomUUID()}`,
  })).toBe(200)
  const threadOf = async () => {
    const listed = await request<{ data: Array<{ id: string; preview: { body: string | null } | null }> }>(page, api, "GET", "/api/conversations?status=open", slug)
    return listed.body.data.find((row) => row.preview?.body === question)?.id ?? ""
  }
  await expect.poll(threadOf, { timeout: 30_000 }).not.toBe("")
  const conversationId = await threadOf()
  // Lo anota el agente al buscar sin resultado y su aviso de pase no deja traza; aquí, como lo dejan ellos.
  const [asked] = await fixtureDb
    .select({ id: message.id, createdAt: message.createdAt })
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.direction, "in")))
  const reply = "Se lo confirma el equipo por aquí."
  await fixtureDb.insert(agentKnowledgeGap).values({
    organizationId: orgId, conversationId, triggerMessageId: asked!.id, question, query: "recien nacidos", createdAt: asked!.createdAt,
  })
  await fixtureDb.insert(message).values({
    organizationId: orgId, conversationId, direction: "out", senderKind: "agent", status: "sent", body: reply,
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, latidiaUrl(slug, "/agent/learn"))
  await expect(page.locator("html")).toHaveAttribute("data-brand", "latidia")
  const review = page.getByRole("region", { name: /^Por revisar/ })
  await expect(review.getByRole("heading", { level: 2 })).toHaveText("Por revisar · 1")
  const row = review.getByRole("listitem").filter({ hasText: question })
  await expect(row).toContainText("Buscó y no encontró")
  await expect(row).toContainText(reply)
  await page.screenshot({ path: testInfo.outputPath("no-encontro.png") })
  await row.getByRole("button", { name: "Corregir", exact: true }).click()
  const correcting = surface(page, { name: /^Corregir una respuesta/ })
  await correcting.getByLabel("La pregunta", { exact: true }).fill("Atención a recién nacidos")
  await correcting.getByLabel("¿Cómo debió responder?").fill("Sí, desde el primer día de vida.")
  await correcting.getByRole("button", { name: "Enviar corrección" }).click()
  const lesson = surface(page, { name: "Lección propuesta", exact: true })
  await lesson.getByRole("button", { name: "Aprobar y activar" }).click()
  await expect(lesson).toBeHidden()
  await expect(page.getByRole("region", { name: /^Lo aprendido/ })).toContainText("Atención a recién nacidos")
  const knowledge = await request<{ data: Array<{ title: string; state: string; askForms: string[] }> }>(page, api, "GET", "/api/agent/knowledge", slug)
  expect(knowledge.body.data).toEqual([expect.objectContaining({ title: "Atención a recién nacidos", state: "vigente" })])
  expect(knowledge.body.data[0]?.askForms).toContain("recien nacidos")
  await context.close()
})

test("latidIA: la ficha médica con el examen por sistemas, los signos vitales, los antecedentes y la lista de problemas", async ({
  browser,
  fixtureDb,
  passwordHash,
}, testInfo) => {
  test.setTimeout(240_000)
  const vela = await createVela(fixtureDb, passwordHash)
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  await gotoHydrated(page, latidiaUrl("app", "/login"))
  const { api, slug, orgId } = await openConsultorio(page, vela)

  // Rosa, con un control de hace dos meses ya firmado y su consulta de hoy abierta.
  const patient = await request<{ data: { id: string } }>(page, api, "POST", "/api/patients", slug, {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: "Rosa Paredes", docType: "DNI", docNumber: "40112233", birthDate: "1980-03-14" },
      respondent: "staff",
      privacyAccepted: false,
    },
  })
  expect(patient.status).toBe(201)
  const patientId = patient.body.data.id
  const before = new Date(Date.now() - 60 * 86_400_000)
  await fixtureDb.insert(encounter).values({
    organizationId: orgId,
    patientId,
    professionalUserId: vela.id,
    status: "finalizada",
    reason: "Control",
    vitals: { presionSistolica: 136, presionDiastolica: 88, peso: 64, talla: 160 },
    startedAt: before,
    endedAt: before,
    finalizedAt: before,
    finalizedBy: vela.id,
    signerName: "Elena Vela",
  })
  const opened = await request<{ data: { id: string } }>(
    page,
    api,
    "POST",
    `/api/patients/${patientId}/encounters`,
    slug,
    { reason: "Fiebre y dolor de garganta" },
  )
  expect(opened.status).toBe(201)
  const encounterId = opened.body.data.id

  // La consulta no habla de piezas: la parte del cuerpo se escribe (decisión 4).
  await gotoHydrated(page, latidiaUrl(slug, `/patients/${patientId}/encounters/${encounterId}`))
  await expect(page.getByText("Piezas vinculadas")).toHaveCount(0)

  // El examen físico: diez signos vitales, el IMC sale solo y se compara con la vez anterior.
  await page.getByRole("button", { name: "Agregar Examen físico" }).click()
  await page.getByLabel("PA sistólica (mmHg)").fill("118")
  await page.getByLabel("PA diastólica (mmHg)").fill("76")
  await page.getByLabel("Temperatura (°C)").fill("38,4")
  await page.getByLabel("Peso (kg)").fill("62")
  await page.getByLabel("Talla (cm)").fill("160")
  await expect(page.getByLabel("Glucosa capilar (mg/dL)")).toBeVisible()
  await expect(page.getByText(/IMC 24\.2 · sale del peso y la talla\. La última vez, el .+: PA 136\/88 · peso 64 kg\./)).toBeVisible()

  // Por sistemas: lo no marcado queda «No examinado»; el botón marca solo lo que falta.
  await expect(page.getByText("0 examinados · 0 con hallazgos · 10 sin examinar")).toBeVisible()
  await page.getByRole("group", { name: "Cabeza y cuello" }).getByRole("button", { name: "Con hallazgos" }).click()
  await page.getByLabel("Qué encontraste").fill("Adenopatías submandibulares en ambos lados, dolorosas, de 1 cm.")
  await page.getByRole("button", { name: "Marcar el resto sin alteraciones" }).click()
  await expect(page.getByText("10 examinados · 1 con hallazgos · 0 sin examinar")).toBeVisible()
  // Un toque más sobre lo marcado lo devuelve a «No examinado».
  await page.getByRole("group", { name: "Abdomen" }).getByRole("button", { name: "Sin alteraciones" }).click()
  await expect(page.getByText("9 examinados · 1 con hallazgos · 1 sin examinar")).toBeVisible()
  await expect
    .poll(async () => {
      const detail = await request<{ data: { encounter: { examination: unknown; vitals: unknown } } }>(
        page,
        api,
        "GET",
        `/api/patients/${patientId}/encounters/${encounterId}`,
        slug,
      )
      return detail.body.data.encounter
    })
    .toMatchObject({
      vitals: { presionSistolica: 118, presionDiastolica: 76, temperatura: 38.4, peso: 62, talla: 160 },
      examination: {
        sistemas: {
          cabezaCuello: { estado: "con_hallazgos", hallazgo: "Adenopatías submandibulares en ambos lados, dolorosas, de 1 cm." },
          piel: { estado: "sin_alteraciones" },
        },
      },
    })
  const saved = await request<{ data: { encounter: { examination: { sistemas: Record<string, unknown> } } } }>(
    page,
    api,
    "GET",
    `/api/patients/${patientId}/encounters/${encounterId}`,
    slug,
  )
  expect(saved.body.data.encounter.examination.sistemas).not.toHaveProperty("abdomen")
  await expect(page.getByText("1 sistema con hallazgos").first()).toBeVisible()
  await shot("examen")
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("examen-telefono")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await shot("examen-oscuro")
  await page.evaluate(() => document.documentElement.classList.remove("dark"))

  // En la ficha, «Signos vitales» va donde odentIA tiene el Odontograma (decisión 6).
  const person = await request<{ data: { personId: string } }>(
    page,
    api,
    "GET",
    `/api/people/by-patient/${patientId}`,
    slug,
  )
  await gotoHydrated(page, latidiaUrl(slug, `/people/${person.body.data.personId}?tab=signos-vitales`))
  await expect(page.getByRole("tab", { name: "Signos vitales" })).toHaveAttribute("aria-selected", "true")
  const latest = page.getByRole("region", { name: "Última medición" })
  await expect(latest.getByText("118/76 mmHg")).toBeVisible()
  await expect(latest.getByText("24.2")).toBeVisible()
  await expect(page.getByText("2 atenciones con signos vitales")).toBeVisible()
  await expect(page.getByRole("region", { name: "Presión arterial" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Peso" })).toBeVisible()
  await shot("signos-vitales")
  await page.getByRole("button", { name: "Ver como tabla" }).click()
  await expect(page.getByRole("cell", { name: "136" })).toBeVisible()
  await shot("signos-vitales-tabla")
  await page.getByRole("button", { name: "Ver los gráficos" }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("signos-vitales-telefono")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await shot("signos-vitales-oscuro")
  await page.evaluate(() => document.documentElement.classList.remove("dark"))

  // Antecedentes (entrega 5b): embarazo y lactancia con la fecha en que se dijo, hábitos y vacunas; nada de la boca.
  const personId = person.body.data.personId
  await gotoHydrated(page, latidiaUrl(slug, `/people/${personId}?tab=antecedentes`))
  await page.getByRole("button", { name: "Registrar antecedentes" }).first().click()
  const drawer = page.getByRole("dialog", { name: "Registrar antecedentes" })
  await expect(drawer.getByText("Odontológicos y hábitos")).toHaveCount(0)
  await drawer.getByRole("group", { name: "Embarazo" }).getByRole("button", { name: "Sí" }).click()
  await drawer.getByLabel("Semanas ese día").fill("10")
  await drawer.getByRole("group", { name: "Tabaco" }).getByRole("button", { name: "Fuma" }).click()
  await drawer.getByLabel("Cigarrillos al día").fill("5")
  await drawer.getByRole("button", { name: "Agregar vacuna" }).click()
  await drawer.getByLabel("Vacuna", { exact: true }).fill("Influenza")
  await shot("antecedentes-formulario")
  await drawer.getByRole("button", { name: "Guardar antecedentes" }).click()
  await expect(drawer).toBeHidden()
  const history = page.getByRole("region", { name: "Antecedentes médicos" })
  await expect(history.getByText(/^Embarazada, 10 semanas \(registrado el \d{2}\/\d{2}\/\d{4}\)$/)).toBeVisible()
  await expect(history.getByText("Hábitos: tabaco: fuma, 5 al día")).toBeVisible()
  await expect(history.getByText("Vacunas: Influenza")).toBeVisible()
  await shot("antecedentes")

  // En el resumen, la lista de problemas empieza por el embarazo: cambia lo que se receta.
  await gotoHydrated(page, latidiaUrl(slug, `/people/${personId}`))
  const problems = page.getByRole("region", { name: "Lista de problemas" })
  await expect(problems.getByText(/^Embarazada, 10 semanas/)).toBeVisible()
  await expect(problems.getByText(/^Sin diagnósticos activos\./)).toBeVisible()
  await shot("resumen")
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("resumen-telefono")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await shot("resumen-oscuro")
  await page.evaluate(() => document.documentElement.classList.remove("dark"))

  // La receta (entrega 6a): con el embarazo registrado, lo recuerda y lo contraindicado va con motivo;
  // un controlado no sale en la receta común.
  expect(
    (
      await request(page, api, "PUT", "/api/clinical-forms/professionals/me/profile", slug, {
        professionalTitle: "Médico cirujano",
        registrationBody: "CMP",
        registrationNumber: "045678",
      })
    ).status,
  ).toBe(200)
  await gotoHydrated(page, latidiaUrl(slug, `/people/${personId}?tab=documentos`))
  await page.getByRole("button", { name: "Nuevo", exact: true }).first().click()
  await page.getByRole("menuitem", { name: "Receta", exact: true }).click()
  const prescription = surface(page, { name: "Emitir receta" })
  const dci = prescription.getByLabel("DCI (denominación común)", { exact: true })
  await dci.fill("enalapril")
  await expect(prescription.getByText(/^Está embarazada, 10 semanas \(registrado el/)).toBeVisible()
  await expect(prescription.getByText(/^Enalapril: está embarazada \(10 semanas\) y los IECA están contraindicados/)).toBeVisible()
  await shot("receta-embarazo")
  await dci.fill("clonazepam")
  await expect(prescription.getByText(/^Clonazepam es una benzodiazepina, un medicamento controlado/)).toBeVisible()
  await dci.fill("paracetamol")
  await prescription.getByLabel("Concentración", { exact: true }).fill("500 mg")
  await chooseOption(prescription.getByLabel("Forma farmacéutica", { exact: true }), "tableta")
  await prescription.getByLabel("Dosis", { exact: true }).fill("1 tableta")
  await prescription.getByLabel("Frecuencia", { exact: true }).fill("Cada 8 horas")
  await prescription.getByLabel("Duración", { exact: true }).fill("3 días")
  await prescription.getByRole("button", { name: "Emitir receta", exact: true }).click()
  await expect(page.getByText(/Receta N.º 1/).first()).toBeVisible()

  // El descanso médico (entrega 6b), junto a la receta: días y fechas; sin autorización, sin diagnóstico.
  await page.getByRole("button", { name: "Nuevo", exact: true }).first().click()
  await page.getByRole("menuitem", { name: "Descanso médico", exact: true }).click()
  const leave = surface(page, { name: "Emitir descanso médico" })
  await leave.getByLabel("Días", { exact: true }).fill("3")
  await expect(leave.getByText(/^3 días de descanso, del /)).toBeVisible()
  await leave.getByLabel("Indicaciones (opcional)", { exact: true }).fill("Reposo relativo, sin esfuerzo físico")
  await shot("descanso-formulario")
  await leave.getByRole("button", { name: "Emitir descanso médico", exact: true }).click()
  const leaveOpened = surface(page, { name: "Descanso médico N.º 1" })
  await expect(leaveOpened.getByText("Sin diagnóstico: la persona no autorizó que figure.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Descansos médicos" })).toBeVisible()
  await shot("descanso")
  await context.close()
})

test("latidIA: lo indicado queda aceptado y se agenda sin presupuesto; Reportes cuenta la consulta cobrada", async ({
  browser,
  fixtureDb,
  passwordHash,
}, testInfo) => {
  test.setTimeout(240_000)
  const vela = await createVela(fixtureDb, passwordHash)
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const views = async (name: string) => {
    await shot(name)
    await page.setViewportSize({ width: 390, height: 844 })
    await shot(`${name}-telefono`)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.evaluate(() => document.documentElement.classList.add("dark"))
    await shot(`${name}-oscuro`)
    await page.evaluate(() => document.documentElement.classList.remove("dark"))
  }
  await gotoHydrated(page, latidiaUrl("app", "/login"))
  const { api, slug, orgId } = await openConsultorio(page, vela)
  // El catálogo médico llega en la entrega 8: aquí, un servicio propio con su tarifa.
  await fixtureDb
    .insert(serviceCatalog)
    .values({ organizationId: orgId, name: "Nebulización", scope: "general", source: "custom", priceCents: 4000, currency: "PEN" })

  const patient = await request<{ data: { id: string } }>(page, api, "POST", "/api/patients", slug, {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: "Mateo Ríos", docType: "DNI", docNumber: "71234567", birthDate: "1990-05-02" },
      respondent: "staff",
      privacyAccepted: false,
    },
  })
  expect(patient.status).toBe(201)
  const patientId = patient.body.data.id
  const opened = await request<{ data: { id: string } }>(page, api, "POST", `/api/patients/${patientId}/encounters`, slug, {
    reason: "Crisis de asma leve",
  })
  expect(opened.status).toBe(201)

  // La Dra. Vela indica 3 nebulizaciones: sin «ámbito» dental ni presupuesto que esperar (decisión 15).
  await gotoHydrated(page, latidiaUrl(slug, `/patients/${patientId}/encounters/${opened.body.data.id}`))
  await page.getByRole("button", { name: "Agregar Plan y controles" }).click()
  const block = page.getByRole("region", { name: "Plan y controles" })
  await expect(block.getByText("Lo indicado queda aceptado: se puede agendar enseguida, sin presupuesto.")).toBeVisible()
  await expect(block.getByLabel("Ámbito", { exact: true })).toHaveCount(0)
  await block.getByLabel("Tratamiento", { exact: true }).fill("Nebuli")
  await page.getByRole("option", { name: /Nebulización/ }).click()
  await block.getByLabel("Detalle", { exact: true }).fill("3 sesiones, una cada 8 horas")
  await block.getByRole("button", { name: "Añadir al plan" }).click()
  const indicated = block.getByRole("listitem").filter({ hasText: "Nebulización" })
  await expect(indicated.getByText("Aceptado", { exact: true })).toBeVisible()
  await shot("indicar")

  // En el Plan, «Qué sigue» pide su cita y el presupuesto queda como opción.
  const person = await request<{ data: { personId: string } }>(page, api, "GET", `/api/people/by-patient/${patientId}`, slug)
  await gotoHydrated(page, latidiaUrl(slug, `/people/${person.body.data.personId}?tab=plan`))
  await expect(page.getByText("Falta la cita de lo indicado")).toBeVisible()
  await expect(page.getByText("Opcional: lo indicado ya queda aceptado. Prepáralo si la persona quiere saber cuánto costará.")).toBeVisible()
  await expect(page.getByText("No hace falta para agendar ni para atender.")).toBeVisible()
  await expect(page.getByText("Todavía no tiene presupuesto")).toHaveCount(0)
  await views("plan-sin-presupuesto")
  // Sin «dónde» en un consultorio: lo indicado no dice «Boca completa» (revisión final).
  expect(await page.locator("main").innerText()).not.toMatch(/Boca completa|odontograma|Pieza/i)
  // «Reservar cita» abre «Nueva cita» al lado, con lo indicado: nadie sale del Plan.
  await page.getByRole("button", { name: "Reservar cita", exact: true }).first().click()
  await expect(surface(page, { name: "Nueva cita" })).toBeVisible()
  await expect(page).toHaveURL(/tab=plan/)
  await page.keyboard.press("Escape")

  // Mateo vino (su consulta quedó firmada) y la pagó: en Reportes «pagó» es la consulta cobrada.
  const [site] = await fixtureDb.select({ id: branch.id }).from(branch).where(eq(branch.organizationId, orgId))
  await fixtureDb.insert(encounter).values({
    organizationId: orgId,
    patientId,
    professionalUserId: vela.id,
    status: "finalizada",
    reason: "Crisis de asma leve",
    finalizedAt: new Date(),
    finalizedBy: vela.id,
    signerName: "Elena Vela",
  })
  await fixtureDb.insert(patientPayment).values({
    organizationId: orgId,
    patientId,
    branchId: site!.id,
    amountCents: 4000,
    currency: "PEN",
    paidAt: new Date(),
    methodName: "Efectivo",
  })
  await gotoHydrated(page, latidiaUrl(slug, "/reports?tab=pacientes"))
  await expect(page.getByText("Pagaron al venir")).toBeVisible()
  await expect(page.getByText("1 de 1 que vino")).toBeVisible()
  await expect(page.getByText("Vinieron y pagaron algo")).toBeVisible()
  await expect(page.getByText("Recibieron presupuesto")).toHaveCount(0)
  await expect(page.getByText("Aceptaron su presupuesto")).toHaveCount(0)
  await views("reportes-pacientes")
  await context.close()
})

test("latidIA: un control que se repite deja indicado el siguiente al completarlo, hasta que se detiene", async ({
  browser,
  fixtureDb,
  passwordHash,
}, testInfo) => {
  test.setTimeout(240_000)
  const vela = await createVela(fixtureDb, passwordHash)
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  await gotoHydrated(page, latidiaUrl("app", "/login"))
  const { api, slug, orgId } = await openConsultorio(page, vela)
  const patient = await request<{ data: { id: string } }>(page, api, "POST", "/api/patients", slug, {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: "Luis Quispe", docType: "DNI", docNumber: "08123456", birthDate: "1962-07-20" },
      respondent: "staff",
      privacyAccepted: false,
    },
  })
  expect(patient.status).toBe(201)
  const patientId = patient.body.data.id
  // Su control de hoy, ya firmado: contra él se completa el control.
  await fixtureDb.insert(encounter).values({
    organizationId: orgId,
    patientId,
    professionalUserId: vela.id,
    status: "finalizada",
    reason: "Control de presión arterial",
    finalizedAt: new Date(),
    finalizedBy: vela.id,
    signerName: "Elena Vela",
  })
  const person = await request<{ data: { personId: string } }>(page, api, "GET", `/api/people/by-patient/${patientId}`, slug)
  await gotoHydrated(page, latidiaUrl(slug, `/people/${person.body.data.personId}?tab=plan`))

  // «Control de presión cada 3 meses» (decisión 16).
  await page.getByRole("button", { name: "Indicar control" }).first().click()
  const indicate = surface(page, { name: "Indicar control" })
  await indicate.getByLabel("Título del control", { exact: true }).fill("Control de presión arterial")
  await chooseOption(indicate.getByLabel("Se repite", { exact: true }), "3")
  await expect(indicate.getByText("Al completarlo queda indicado el siguiente, hasta que lo detengas.")).toBeVisible()
  await shot("control-indicar")
  await indicate.getByRole("button", { name: "Indicar control", exact: true }).click()
  await expect(indicate).toBeHidden()
  // «Qué sigue» lo nombra enseguida, sin recargar.
  await expect(page.getByText("Control de presión arterial · por reservar")).toBeVisible()
  const controls = page.getByRole("region", { name: "Controles" })
  await expect(controls.getByText("Se repite cada 3 meses: al completarlo queda indicado el siguiente.")).toBeVisible()
  await shot("control-repite")
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("control-repite-telefono")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await shot("control-repite-oscuro")
  await page.evaluate(() => document.documentElement.classList.remove("dark"))

  // Al completarlo queda indicado el siguiente, con su repetición.
  await controls.getByRole("button", { name: "Completar control" }).click()
  const complete = surface(page, { name: "Completar control" })
  await complete.getByLabel("Resultado del control", { exact: true }).fill("PA 128/82, sigue con enalapril")
  await complete.getByRole("button", { name: "Completar", exact: true }).click()
  await expect(complete).toBeHidden()
  await expect(controls.getByText("Realizado", { exact: true })).toBeVisible()
  await expect(controls.getByText("Pendiente", { exact: true })).toBeVisible()
  await expect(controls.getByText("Se repite cada 3 meses: al completarlo queda indicado el siguiente.")).toHaveCount(1)

  // «Dejar de repetir»: el siguiente sigue en pie, pero ya no deja otro.
  await controls.getByRole("button", { name: "Dejar de repetir" }).click()
  await expect(page.getByText("Ya no se repite: al completarlo no queda indicado otro.")).toBeVisible()
  await expect(controls.getByText(/^Se repite cada/)).toHaveCount(0)
  await expect(controls.getByRole("button", { name: "Dejar de repetir" })).toHaveCount(0)
  await shot("control-detenido")
  await context.close()
})

test("latidIA: la biblioteca de un consultorio con su código CPMS, sus cinco especialidades y un servicio propio", async ({
  browser,
  fixtureDb,
  passwordHash,
}, testInfo) => {
  test.setTimeout(240_000)
  const vela = await createVela(fixtureDb, passwordHash)
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  await gotoHydrated(page, latidiaUrl("app", "/login"))
  const { slug } = await openConsultorio(page, vela)
  await page.setViewportSize({ width: 1440, height: 900 })

  // Agregar servicios: solo lo de un consultorio, cada uno con su código CPMS.
  await gotoHydrated(page, latidiaUrl(slug, "/services/biblioteca?vista=biblioteca"))
  await expect(page.getByRole("heading", { level: 1, name: "Agregar servicios" })).toBeVisible()
  await expect(page.getByRole("row").filter({ hasText: "Consulta de medicina general" }).first()).toContainText("CPMS 99201")
  await expect(page.getByText(/Profilaxis|Exodoncia/)).toHaveCount(0)
  await shot("biblioteca")
  await gotoHydrated(page, latidiaUrl(slug, "/services/biblioteca?vista=biblioteca&q=electrocardiograma"))
  await expect(page.getByRole("row").filter({ hasText: "Electrocardiograma" }).first()).toContainText("CPMS 93000")
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("biblioteca-telefono")
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await shot("biblioteca-oscuro")
  await page.evaluate(() => document.documentElement.classList.remove("dark"))

  // Un servicio propio: su especialidad y su código CPMS, sin «Dónde se hace».
  await page.getByRole("button", { name: "Crear un servicio propio" }).click()
  const own = surface(page, { name: "Servicio propio", exact: true })
  await expect(own.getByText("Dónde se hace", { exact: true })).toHaveCount(0)
  await own.getByLabel("Nombre", { exact: true }).fill("Control de hipertensión")
  await chooseOption(own.getByLabel("Especialidad", { exact: true }), { label: "Medicina interna" })
  await own.getByLabel("Precio", { exact: true }).fill("90")
  await own.getByRole("combobox", { name: "Código CPMS" }).fill("99215")
  await page.getByRole("option", { name: /^99215 / }).click()
  await shot("servicio-propio")
  await own.getByRole("button", { name: "Guardar y activar" }).click()
  await expect(own).toBeHidden()
  await expect(page.getByText("«Control de hipertensión» ya está activo entre tus servicios")).toBeVisible()

  // Servicios y precios: sin la columna «Ámbito», que en un consultorio siempre diría «General».
  await gotoHydrated(page, latidiaUrl(slug, "/services"))
  await expect(page.getByRole("row").filter({ hasText: "Control de hipertensión" })).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Ámbito" })).toHaveCount(0)

  // Nace con las cinco especialidades de latidIA (decisión 3).
  await gotoHydrated(page, latidiaUrl(slug, "/settings/specialties"))
  for (const name of ["Medicina general", "Medicina familiar", "Medicina interna", "Pediatría", "Ginecología y obstetricia"]) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible()
  }
  await shot("especialidades")
  await gotoHydrated(page, latidiaUrl(slug, "/settings"))
  const rules = page.getByRole("group", { name: "Normas de Perú" })
  await expect(rules).toContainText("CPMS, obligatoria (RM 550-2023-MINSA)")
  await expect(rules).toContainText("Lista general de latidIA")
  await context.close()
})

test("latidIA: Clío dicta la consulta, los signos vitales, el examen y el descanso, que se emite con su firma", async ({
  browser,
  fixtureDb,
  passwordHash,
}, testInfo) => {
  test.setTimeout(240_000)
  const vela = await createVela(fixtureDb, passwordHash)
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  await gotoHydrated(page, latidiaUrl("app", "/login"))
  const { api, slug } = await openConsultorio(page, vela)
  // El descanso se firma con el perfil profesional.
  expect(
    (
      await request(page, api, "PUT", "/api/clinical-forms/professionals/me/profile", slug, {
        professionalTitle: "Médico cirujano",
        registrationBody: "CMP",
        registrationNumber: "045678",
      })
    ).status,
  ).toBe(200)
  const patient = await request<{ data: { id: string } }>(page, api, "POST", "/api/patients", slug, {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: "Rosa Quispe", docType: "DNI", docNumber: "40221133", birthDate: "1991-05-02" },
      respondent: "staff",
      privacyAccepted: false,
    },
  })
  expect(patient.status).toBe(201)
  const patientId = patient.body.data.id
  const opened = await request<{ data: { id: string } }>(page, api, "POST", `/api/patients/${patientId}/encounters`, slug, { reason: "Consulta" })
  expect(opened.status).toBe(201)
  const encounterId = opened.body.data.id
  const DICTATION =
    "Viene por fiebre y dolor de garganta hace tres días. Presión 118 con 76, temperatura 38,5, pulso 96. Amígdalas aumentadas con placas blanquecinas, pulmones limpios. Parece una amigdalitis. Descanso de tres días."

  // La ficha de Clío habla del médico, y su práctica ordena una consulta de un consultorio.
  await gotoHydrated(page, latidiaUrl(slug, "/agent/asistente-clinico"))
  await expect(page.getByRole("heading", { level: 1, name: "Clío, tu agente clínico" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Qué sabe" })).toContainText("Lo que el médico dicta en esa atención.")
  expect(await page.locator("main").innerText()).not.toMatch(/odont|pieza/i)
  const practice = page.getByRole("region", { name: "Cómo se prueba" })
  await practice.getByLabel("Dictado de ejemplo").fill(DICTATION)
  await practice.getByRole("button", { name: "Ver qué sugeriría" }).click()
  await expect(practice.getByRole("listitem").filter({ hasText: "Signos vitales" })).toContainText("PA 118/76 mmHg")
  await shot("clio-ficha")
  await page.getByRole("switch", { name: "Encender a Clío" }).click()
  await expect(page.getByRole("switch", { name: "Apagar a Clío" })).toBeChecked()

  // En la atención: lo dictado va a cada bloque, también al examen físico y a los documentos.
  await gotoHydrated(page, latidiaUrl(slug, `/patients/${patientId}/encounters/${encounterId}`))
  const idle = page.getByRole("region", { name: "Dictado de la atención" })
  const review = page.getByRole("region", { name: "Sugerencias por revisar" })
  const suggested = (name: string) => page.getByRole("list", { name: `Sugerencias de Clío: ${name}` })
  const write = async (text: string, from = idle) => {
    await from.getByRole("button", { name: "Escribir en vez de dictar" }).click()
    await from.getByLabel("Escribe lo dictado").fill(text)
    await from.getByRole("button", { name: "Ordenar lo dictado" }).click()
  }
  await write(DICTATION)
  await expect(review).toContainText("Clío dejó 6 sugerencias por revisar")
  await expect(suggested("Signos vitales")).toContainText("PA 118/76 mmHg · FC 96 lpm · T 38.5 °C")
  await expect(suggested("Examen físico")).toContainText("Boca y garganta · con hallazgos")
  await expect(suggested("Examen físico")).toContainText("Tórax y pulmones · sin alteraciones")
  await expect(suggested("Diagnóstico")).toContainText("J03.9 · Amigdalitis aguda, no especificada")
  await expect(review).toContainText("5 listas")
  await expect(suggested("Descanso médico")).toContainText("Descanso médico · 3 días desde hoy")
  await shot("clio-sugerencias")
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("clio-sugerencias-telefono")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await shot("clio-sugerencias-oscuro")
  await page.evaluate(() => document.documentElement.classList.remove("dark"))

  // «No, la temperatura es 38,4»: se corrige la medida y se ve qué decía antes.
  await write("No, la temperatura es 38,4.", review)
  await expect(suggested("Signos vitales")).toContainText("T 38.4 °C")
  await expect(suggested("Signos vitales")).toContainText("corregido por voz, antes T 38.5 °C")

  // Confirmar las listas: los signos y el examen entran a la atención; el descanso espera su firma.
  await review.getByRole("button", { name: /^Confirmar las \d+ listas$/ }).click()
  await expect
    .poll(async () => {
      const detail = await request<{ data: { encounter: { examination: unknown; vitals: unknown } } }>(
        page,
        api,
        "GET",
        `/api/patients/${patientId}/encounters/${encounterId}`,
        slug,
      )
      return detail.body.data.encounter
    })
    .toMatchObject({
      vitals: { presionSistolica: 118, presionDiastolica: 76, temperatura: 38.4, frecuenciaCardiaca: 96 },
      examination: {
        sistemas: {
          bocaGarganta: { estado: "con_hallazgos", hallazgo: "Amígdalas aumentadas con placas blanquecinas" },
          toraxPulmones: { estado: "sin_alteraciones" },
        },
      },
    })
  await expect(suggested("Signos vitales")).toHaveCount(0)
  const diagnoses = await request<{ data: { diagnoses: Array<{ diagnosisCode: string; diagnosisType: string }> } }>(
    page,
    api,
    "GET",
    `/api/patients/${patientId}/encounters/${encounterId}`,
    slug,
  )
  expect(diagnoses.body.data.diagnoses).toEqual([expect.objectContaining({ diagnosisCode: "J03.9", diagnosisType: "provisional" })])

  // El descanso se emite en su formulario, ya lleno con los días dictados; el diagnóstico solo si la persona lo autoriza.
  await suggested("Descanso médico").getByRole("button", { name: "Emitir descanso" }).click()
  // En ventana ancha y sin otro bloque abierto, el formulario va a la columna lateral.
  const leave = surface(page, { name: "Emitir descanso médico" })
  await expect(leave.getByLabel("Días")).toHaveValue("3")
  await shot("clio-descanso")
  await leave.getByRole("button", { name: "Emitir descanso médico" }).click()
  await expect(leave).toBeHidden()
  await expect(suggested("Descanso médico")).toHaveCount(0)
  const leaves = await request<{ data: Array<{ days: number; showDiagnosis: boolean; encounterId: string | null }> }>(
    page,
    api,
    "GET",
    `/api/patients/${patientId}/medical-leaves`,
    slug,
  )
  expect(leaves.body.data).toEqual([expect.objectContaining({ days: 3, showDiagnosis: false, encounterId })])
  // La atención no habla de piezas ni corrige con ejemplos dentales (revisión final).
  expect(await page.locator("main").innerText()).not.toMatch(/Sin pieza|odontograma|veintiséis|endodoncia/i)
  await shot("clio-confirmado")
  await context.close()
})

test("latidIA: sin colegiatura, el cierre propone «Médico cirujano» y el CMP, la guarda y firma", async ({
  browser,
  fixtureDb,
  passwordHash,
}) => {
  const vela = await createVela(fixtureDb, passwordHash)
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await gotoHydrated(page, latidiaUrl("app", "/login"))
  const { api, slug } = await openConsultorio(page, vela)
  const patient = await request<{ data: { id: string } }>(page, api, "POST", "/api/patients", slug, {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: "Luis Gómez", docType: "DNI", docNumber: "40998877", birthDate: "1979-03-10" },
      respondent: "staff",
      privacyAccepted: false,
    },
  })
  expect(patient.status).toBe(201)
  const patientId = patient.body.data.id
  const opened = await request<{ data: { id: string } }>(page, api, "POST", `/api/patients/${patientId}/encounters`, slug, {
    reason: "Fiebre y dolor de garganta",
  })
  expect(opened.status).toBe(201)
  const path = `/api/patients/${patientId}/encounters/${opened.body.data.id}`
  expect(
    (await request(page, api, "POST", `${path}/diagnoses`, slug, { diagnosisCode: "J03.9", diagnosisType: "provisional" }))
      .status,
  ).toBe(201)
  expect((await request(page, api, "PATCH", path, slug, { evolution: "Amigdalitis; reposo e hidratación." })).status).toBe(
    200,
  )

  await gotoHydrated(page, latidiaUrl(slug, `/patients/${patientId}/encounters/${opened.body.data.id}`))
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const firma = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(firma.getByText("Falta tu colegiatura para firmar")).toBeVisible()
  await expect(firma.getByLabel("Título profesional")).toHaveValue("Médico cirujano")
  await expect(firma.getByLabel("Colegio")).toHaveValue("CMP")
  await page.screenshot({ path: test.info().outputPath("latidia-cierre-pide-colegiatura.png"), fullPage: true })
  await firma.getByLabel("Número de colegiatura").fill("045678")
  await firma.getByRole("button", { name: "Guardar y firmar", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Atención finalizada" })).toBeVisible()

  const profile = await request<{ data: { professionalTitle: string; registrationBody: string; registrationNumber: string } }>(
    page,
    api,
    "GET",
    "/api/clinical-forms/professionals/me/profile",
    slug,
  )
  expect(profile.body.data).toMatchObject({
    professionalTitle: "Médico cirujano",
    registrationBody: "CMP",
    registrationNumber: "045678",
  })
  await context.close()
})

test("latidIA: Clío anota el material dicho, al firmar se ve lo que salió del consultorio y se agrega lo que faltó sin salir", async ({
  browser,
  fixtureDb,
  passwordHash,
}, testInfo) => {
  const vela = await createVela(fixtureDb, passwordHash)
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, latidiaUrl("app", "/login"))
  const { api, slug, orgId } = await openConsultorio(page, vela)
  const [site] = await fixtureDb.select({ id: branch.id }).from(branch).where(eq(branch.organizationId, orgId))
  const product = async (name: string, unit: string, counted: number | null) => {
    const created = await request<{ data: { id: string } }>(page, api, "POST", "/api/inventory/products", slug, {
      name,
      usedInCare: true,
      unit,
    })
    expect(created.status).toBe(201)
    if (counted !== null) {
      const count = await request(page, api, "POST", "/api/inventory/count", slug, {
        branchId: site!.id,
        idempotencyKey: randomUUID(),
        items: [{ productId: created.body.data.id, counted }],
      })
      expect(count.status).toBe(200)
    }
    return created.body.data.id
  }
  const gloves = await product("Guantes de examen", "par", 10)
  const depressor = await product("Bajalengua de madera", "unidad", null)
  await product("Mascarilla quirúrgica", "unidad", 5)
  const specialties = await request<{ data: Array<{ id: string; key: string }> }>(
    page,
    api,
    "GET",
    "/api/clinical-forms/specialties",
    slug,
  )
  const service = await request<{ data: { id: string } }>(page, api, "POST", "/api/services", slug, {
    name: "Consulta de prueba",
    specialtyId: specialties.body.data[0]!.id,
    scope: "general",
    priceCents: 8000,
    currency: "PEN",
    officialCode: "99201",
  })
  expect(service.status).toBe(201)
  const serviceId = service.body.data.id
  expect(
    (
      await request(page, api, "PUT", `/api/services/${serviceId}/materials`, slug, {
        items: [
          { productId: gloves, quantity: 1 },
          { productId: depressor, quantity: 1 },
        ],
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await request(page, api, "PUT", "/api/clinical-forms/professionals/me/profile", slug, {
        professionalTitle: "Médico cirujano",
        registrationBody: "CMP",
        registrationNumber: "045678",
      })
    ).status,
  ).toBe(200)
  const patient = await request<{ data: { id: string } }>(page, api, "POST", "/api/patients", slug, {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName: "Luis Gómez", docType: "DNI", docNumber: "40998877", birthDate: "1979-03-10" },
      respondent: "staff",
      privacyAccepted: false,
    },
  })
  expect(patient.status).toBe(201)
  const patientId = patient.body.data.id
  const opened = await request<{ data: { id: string } }>(page, api, "POST", `/api/patients/${patientId}/encounters`, slug, {
    reason: "Fiebre y dolor de garganta",
    branchId: site!.id,
  })
  expect(opened.status).toBe(201)
  const path = `/api/patients/${patientId}/encounters/${opened.body.data.id}`
  expect((await request(page, api, "POST", `${path}/procedures`, slug, { serviceId })).status).toBe(201)
  expect(
    (await request(page, api, "POST", `${path}/diagnoses`, slug, { diagnosisCode: "J03.9", diagnosisType: "provisional" }))
      .status,
  ).toBe(201)
  expect((await request(page, api, "PATCH", path, slug, { evolution: "Amigdalitis; reposo e hidratación." })).status).toBe(
    200,
  )

  expect((await request(page, api, "PUT", "/api/agent/config", slug, { clinicalAssistantEnabled: true })).status).toBe(200)

  await gotoHydrated(page, latidiaUrl(slug, `/patients/${patientId}/encounters/${opened.body.data.id}`))
  // Clío anota el material dicho: el total, no se suma a lo que trae la consulta (ADR 0106).
  const idle = page.getByRole("region", { name: "Dictado de la atención" })
  await idle.getByRole("button", { name: "Escribir en vez de dictar" }).click()
  await idle.getByLabel("Escribe lo dictado").fill("Usé dos pares de guantes.")
  await idle.getByRole("button", { name: "Ordenar lo dictado" }).click()
  const dictated = page.getByRole("list", { name: "Sugerencias de Clío: Materiales" }).getByRole("listitem").first()
  await expect(dictated).toContainText("2 pares en total")
  await expect(dictated).toContainText("Consulta de prueba ya trae 1 par: vale el total, no se suma")
  await dictated.getByRole("button", { name: "Confirmar", exact: true }).click()
  await expect(page.getByRole("list", { name: "Sugerencias de Clío: Materiales" })).toHaveCount(0)

  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const signing = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(signing).toContainText("se descuentan de Sede Central: 1 unidad de bajalengua de madera y 2 pares de guantes de examen.")
  await signing.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const done = page.getByRole("dialog", { name: "Atención finalizada" })
  const materials = done.getByRole("region", { name: "Materiales" })
  await expect(materials).toContainText("Salieron de Sede Central: 1 unidad de bajalengua de madera y 2 pares de guantes de examen.")
  await expect(materials).toContainText("No había 1 unidad de bajalengua de madera: queda como faltante en Inventario.")
  await page.screenshot({ path: testInfo.outputPath("latidia-atencion-finalizada-materiales.png"), fullPage: true })

  await materials.getByRole("button", { name: "Corregir" }).click()
  const drawer = surface(page, { name: "Corregir materiales" })
  await drawer.getByRole("button", { name: "Agregar otro producto" }).click()
  await drawer.getByRole("combobox", { name: "Producto" }).click()
  await page.getByRole("option", { name: /^Mascarilla quirúrgica/ }).click()
  await drawer.getByRole("button", { name: "Guardar" }).click()
  await expect(materials).toContainText(
    "Salieron de Sede Central: 1 unidad de bajalengua de madera, 2 pares de guantes de examen y 1 unidad de mascarilla quirúrgica.",
  )
  await page.screenshot({ path: testInfo.outputPath("latidia-atencion-finalizada-corregida.png"), fullPage: true })
  await done.getByRole("button", { name: "Listo" }).click()
  await expect(page.getByRole("region", { name: "Materiales usados" })).toContainText("Mascarilla quirúrgica")
  await context.close()
})
