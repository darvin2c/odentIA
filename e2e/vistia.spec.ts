import { randomUUID } from "node:crypto"
import { LEGAL } from "@odentia/auth/legal"
import type { Db } from "@odentia/db"
import { account, member, user as users } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import type { Browser, Page } from "@playwright/test"
import { eq } from "drizzle-orm"
import { vistiaUrl } from "./env"
import { asClinicFromBefore, chooseDay, expect, PASSWORD, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/**
 * vistIA abre en su dominio (ADR 0168) y vende lentes con su pedido (ADR 0170):
 * la óptica se ve con su marca y tiene «Pedidos»; la receta sale del examen de la
 * vista, se vende con ella (las lunas a medida, con un adelanto en efectivo) y el
 * pedido avanza hasta «Listos». Taller ve el pedido con la copia de la receta y lo
 * avanza, pero no lo anula; Recepción lo ve sin la receta ni la caja. Los permisos
 * se prueban contra el servidor, no solo por lo que la pantalla esconde.
 */

type Ok<T> = { status: number; body: T }

/** Una llamada a la API de vistIA desde la página, con la sesión de su dominio. */
async function request<T>(page: Page, method: string, path: string, slug?: string, body?: unknown): Promise<Ok<T>> {
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
    { apiBase: vistiaUrl("api"), method, path, slug, body },
  )
}

/** Lo mismo, exigiendo el estado esperado; devuelve `data`. */
async function call<T>(page: Page, method: string, path: string, slug: string | undefined, body?: unknown, expected = 200): Promise<T> {
  const result = await request<{ data: T }>(page, method, path, slug, body)
  expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBe(expected)
  return result.body.data
}

/** Una persona con su contraseña de prueba y los términos aceptados. */
async function createPerson(db: Db, passwordHash: string, firstName: string, lastName: string) {
  const id = randomUUID()
  // Sin tildes: la dirección de correo es ASCII.
  const email = `vistia-${firstName.normalize("NFD").replace(/[^a-z]/gi, "").toLowerCase()}-${id}@test.dev`
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id,
      name: `${firstName} ${lastName}`,
      firstName,
      lastName,
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

/** Entra por la API de vistIA desde su panel: la sesión vive en su dominio. */
async function signIn(page: Page, email: string) {
  await gotoHydrated(page, vistiaUrl("app", "/login"))
  const signedIn = await request<{ user: { id: string } }>(page, "POST", "/api/auth/sign-in/email", undefined, {
    email,
    password: PASSWORD,
  })
  expect(signedIn.status).toBe(200)
}

/** Abre una óptica con una sede desde el dominio de vistIA: nace óptica. */
async function openOptica(page: Page, owner: { id: string; email: string }, db: Db) {
  await signIn(page, owner.email)
  const slug = `optica-${owner.id.slice(0, 8)}`
  const created = await request<{ id: string }>(page, "POST", "/api/auth/organization/create", undefined, {
    name: "Óptica Miraflores",
    slug,
  })
  expect(created.status).toBe(200)
  const orgId = created.body.id
  expect((await request(page, "POST", "/api/auth/organization/set-active", undefined, { organizationId: orgId })).status).toBe(200)
  await call(page, "PUT", "/api/org-profile", slug, { legalName: "Óptica Miraflores S.A.C.", countryCode: "PE" })
  const branch = await call<{ id: string }>(page, "POST", "/api/branches", slug, { name: "Sede Central" }, 201)
  // Como las demás clínicas de prueba: parte de «sin fila = apagado» (ADR 0141).
  await asClinicFromBefore(db, orgId)
  // Quien examina firma la receta con su colegiatura (en el Perú, el CTMP).
  await call(page, "PUT", "/api/clinical-forms/professionals/me/profile", slug, {
    professionalTitle: "Tecnólogo médico en optometría",
    registrationBody: "CTMP",
    registrationNumber: "12345",
  })
  return { slug, orgId, branchId: branch.id }
}

/** Una persona de la óptica, con una atención abierta a su nombre. */
async function patientWithEncounter(page: Page, slug: string, displayName: string, docNumber: string) {
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", slug, {
    submissionId: randomUUID(),
    answers: {
      demographics: { displayName, docType: "DNI", docNumber, birthDate: "1975-08-21" },
      respondent: "staff",
      privacyAccepted: false,
    },
  }, 201)
  const encounter = await call<{ id: string }>(page, "POST", `/api/patients/${patient.id}/encounters`, slug, {
    reason: "Control de la vista",
  }, 201)
  return { patientId: patient.id, encounterId: encounter.id }
}

/** El medio «Efectivo» (catálogo 59 de SUNAT: «10»); la óptica del Perú ya nace con él. */
async function cashMethod(page: Page, slug: string): Promise<string> {
  const methods = await call<Array<{ id: string; name: string; typeCode: string | null }>>(page, "GET", "/api/org/payment-methods", slug)
  const cash = methods.find((item) => item.typeCode === "10" && item.name === "Efectivo")
  if (cash) return cash.id
  return (await call<{ id: string }>(page, "POST", "/api/org/payment-methods", slug, { name: "Efectivo", typeCode: "10" }, 201)).id
}

/** Un día después de hoy en Lima (`AAAA-MM-DD`): lo que se promete al cliente. */
function limaDayIn(days: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() + days * 86_400_000),
  )
}

/** Alguien del equipo con su rol, en su propio navegador y con su sesión de vistIA. */
async function teammate(browser: Browser, db: Db, passwordHash: string, orgId: string, role: "workshop" | "reception", firstName: string) {
  const person = await createPerson(db, passwordHash, firstName, "Equipo")
  await db.insert(member).values({ id: randomUUID(), organizationId: orgId, userId: person.id, role, createdAt: new Date() })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await signIn(page, person.email)
  return { context, page }
}

interface OrderView {
  id: string
  orderNumber: number
  status: string
  dueCents: number | null
  prescription: Record<string, unknown> | null
  prescriptionHidden: boolean
  lines: Array<{ kind: string; description: string; amountCents: number | null }>
}

test("vistIA: la óptica con su marca, la receta del examen y la venta de lentes hasta «Listos»", async ({
  browser,
  fixtureDb,
  passwordHash,
}, testInfo) => {
  test.setTimeout(240_000)
  const owner = await createPerson(fixtureDb, passwordHash, "Rocío", "Salas")
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })

  // El acceso de vistIA lleva su marca.
  await gotoHydrated(page, vistiaUrl("app", "/login"))
  await expect(page.locator("html")).toHaveAttribute("data-brand", "vistia")
  const { slug, orgId } = await openOptica(page, owner, fixtureDb)
  const [profile] = await fixtureDb.select({ product: orgProfile.product }).from(orgProfile).where(eq(orgProfile.organizationId, orgId))
  expect(profile?.product).toBe("optical")
  const cashId = await cashMethod(page, slug)
  expect(cashId).toBeTruthy()

  // La óptica: su marca y «Pedidos» en el menú.
  await gotoHydrated(page, vistiaUrl(slug, "/orders"))
  await expect(page.locator("html")).toHaveAttribute("data-brand", "vistia")
  await expect(page.getByRole("navigation").getByRole("link", { name: "Pedidos" }).first()).toBeVisible()
  await expect(page.getByRole("heading", { level: 1, name: "Pedidos" })).toBeVisible()
  for (const view of ["Abiertos", "Atrasados", "Listos", "Entregados", "Anulados"]) {
    await expect(page.getByRole("tab", { name: new RegExp(`^${view}`) })).toBeVisible()
  }
  await expect(page.getByText("Sin pedidos abiertos")).toBeVisible()

  // El examen de la vista: la refracción de cada ojo, guardada sola.
  const { patientId, encounterId } = await patientWithEncounter(page, slug, "Carmen Ríos", "41223344")
  await gotoHydrated(page, vistiaUrl(slug, `/patients/${patientId}/encounters/${encounterId}`))
  await page.getByRole("button", { name: "Agregar Examen de la vista" }).click()
  await page.getByLabel("Esfera Ojo derecho").fill("-1,25")
  await page.getByLabel("Cilindro Ojo derecho").fill("-0,50")
  await page.getByLabel("Eje Ojo derecho").fill("180")
  await page.getByLabel("Esfera Ojo izquierdo").fill("-1,00")
  await expect
    .poll(async () => {
      const detail = await call<{ encounter: { examination: unknown } }>(page, "GET", `/api/patients/${patientId}/encounters/${encounterId}`, slug)
      return detail.encounter.examination
    })
    .toMatchObject({ refraccion: { od: { esfera: -1.25, cilindro: -0.5, eje: 180 }, oi: { esfera: -1 } } })
  await page.getByRole("button", { name: "Listo", exact: true }).click()

  // La receta de anteojos sale de esa refracción, con un toque.
  await page.getByRole("region", { name: "Receta de lentes", exact: true }).getByRole("button", { name: "Abrir" }).click()
  await page.getByRole("button", { name: "Emitir receta de anteojos" }).click()
  await expect(page.getByRole("button", { name: "Receta de anteojos emitida" })).toBeVisible()
  const issued = await call<{ items: Array<{ id: string; kind: string; source: string; lenses: { od?: { esfera?: number } } }> }>(
    page,
    "GET",
    `/api/patients/${patientId}/lens-prescriptions`,
    slug,
  )
  expect(issued.items).toEqual([expect.objectContaining({ kind: "anteojos", source: "examen", lenses: expect.objectContaining({ od: expect.objectContaining({ esfera: -1.25 }) }) })])
  const prescriptionId = issued.items[0]!.id

  // En la ficha, «Recetas de lentes»: la vigente, y desde ella se vende.
  const person = await call<{ personId: string }>(page, "GET", `/api/people/by-patient/${patientId}`, slug)
  await gotoHydrated(page, vistiaUrl(slug, `/people/${person.personId}?tab=recetas-de-lentes`))
  await expect(page.getByRole("heading", { name: "Recetas de lentes" })).toBeVisible()
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Anteojos" }) })
  await expect(card).toBeVisible()
  await expect(card.getByText(/^[−-]1,25 [−-]0,5/)).toBeVisible()
  await card.getByRole("link", { name: "Vender con esta receta" }).click()

  // «Vender lentes»: la persona y su receta ya elegidas; las lunas a medida con su precio y un adelanto en efectivo.
  const sale = surface(page, { name: "Vender lentes" })
  await expect(sale).toBeVisible()
  await expect(sale.getByText("Carmen Ríos")).toBeVisible()
  await expect(sale.getByRole("group", { name: "Receta" }).getByRole("button", { name: /^Receta de anteojos/ })).toHaveAttribute("aria-pressed", "true")
  await sale.getByRole("button", { name: "Agregar lunas" }).click()
  // El nombre de cada dato lleva su línea («Qué es, lunas»), solo para el lector de pantalla.
  await sale.getByRole("textbox", { name: /^Qué es\s*, lunas$/ }).fill("Lunas monofocales con antirreflejo")
  await sale.getByRole("textbox", { name: /^Precio\s*, lunas$/ }).fill("250")
  await expect(sale.getByRole("textbox", { name: "Qué es", exact: true })).toHaveValue("Lunas")
  await sale.getByRole("textbox", { name: "Quién lo hace" }).fill("Laboratorio Visión")
  await chooseDay(sale.getByLabel("Para cuándo", { exact: true }), limaDayIn(7))
  await sale.getByRole("group", { name: "Adelanto" }).getByRole("button", { name: "Efectivo", exact: true }).click()
  await sale.getByRole("textbox", { name: "Importe", exact: true }).fill("100")
  await expect(sale.getByText(/Adelanto S\/\s?100[.,]00: quedan S\/\s?150[.,]00 por pagar\./)).toBeVisible()
  await shot("venta")
  await sale.getByRole("button", { name: "Vender", exact: true }).click()

  // El pedido se abre al lado: «Por enviar» y lo que falta pagar.
  await expect(page).toHaveURL(/[?&]pedido=/)
  const orderId = new URL(page.url()).searchParams.get("pedido")!
  const sold = await call<OrderView>(page, "GET", `/api/orders/${orderId}`, slug)
  expect(sold).toMatchObject({
    status: "por_enviar",
    dueCents: 15_000,
    prescriptionHidden: false,
    prescription: expect.objectContaining({ kind: "anteojos" }),
    lines: [expect.objectContaining({ kind: "lunas", description: "Lunas monofocales con antirreflejo", amountCents: 25_000 })],
  })
  const detail = surface(page, { name: `Pedido N.º ${sold.orderNumber}` })
  await expect(detail).toBeVisible()
  await expect(detail.getByText("Por enviar").first()).toBeVisible()
  await expect(detail.getByText("Falta pagar")).toBeVisible()
  await expect(detail.getByText(/S\/\s?150[.,]00/).first()).toBeVisible()
  await expect(detail.getByText(/^OD [−-]1,25/)).toBeVisible()
  await shot("pedido")

  // Cada paso, un hecho de la óptica: al laboratorio, de vuelta, revisado.
  const steps: Array<[string, string]> = [
    ["Enviado al laboratorio", "en_laboratorio"],
    ["Llegó del laboratorio", "por_revisar"],
    ["Revisado: está listo", "listo"],
  ]
  for (const [label, status] of steps) {
    await detail.getByRole("button", { name: label, exact: true }).click()
    await expect.poll(async () => (await call<OrderView>(page, "GET", `/api/orders/${orderId}`, slug)).status).toBe(status)
  }
  await expect(detail.getByRole("button", { name: "Entregar", exact: true })).toBeVisible()
  await expect(detail.getByRole("status").filter({ hasText: "Falta pagar" })).toBeVisible()
  // «Tus lentes están listos» (entrega 5): sin WhatsApp conectado no sale, y el pedido dice por qué y ofrece enviarlo.
  await expect(detail.getByText("Aviso de que está listo")).toBeVisible()
  await expect(detail.getByText(/No salió el aviso/)).toBeVisible()
  await expect(detail.getByRole("button", { name: "Enviar el aviso", exact: true })).toBeVisible()
  const notice = (await call<OrderView & { readyNotice: { status: string } | null }>(page, "GET", `/api/orders/${orderId}`, slug)).readyNotice
  expect(notice?.status).toBe("no_salio")

  // Listo: está en «Listos».
  await detail.getByRole("button", { name: "Cerrar" }).first().click()
  await page.getByRole("tab", { name: /^Listos/ }).click()
  await expect(page).toHaveURL(/[?&]vista=listos/)
  await expect(page.getByText(`N.º ${sold.orderNumber}`, { exact: true })).toBeVisible()
  const ready = await call<Array<{ id: string }>>(page, "GET", "/api/orders?status=listo", slug)
  expect(ready.map((row) => row.id)).toEqual([orderId])
  await shot("pedidos-listos")

  // En el teléfono: la lista, el pedido y «Vender lentes».
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("pedidos-listos-telefono")
  await page.getByText(`N.º ${sold.orderNumber}`, { exact: true }).click()
  await expect(surface(page, { name: `Pedido N.º ${sold.orderNumber}` })).toBeVisible()
  await shot("pedido-telefono")
  await gotoHydrated(page, vistiaUrl(slug, "/orders?vender=1"))
  await expect(surface(page, { name: "Vender lentes" })).toBeVisible()
  await shot("venta-telefono")
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, vistiaUrl(slug, "/orders"))
  await shot("pedidos")
  await context.close()
})

test("vistIA: Taller avanza el pedido con la receta y no lo anula; Recepción lo ve sin la receta ni la caja", async ({
  browser,
  fixtureDb,
  passwordHash,
}, testInfo) => {
  test.setTimeout(180_000)
  const owner = await createPerson(fixtureDb, passwordHash, "Rocío", "Salas")
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const { slug, orgId, branchId } = await openOptica(page, owner, fixtureDb)

  // La receta sale del examen guardado y la venta la copia en el pedido, con su adelanto.
  const { patientId, encounterId } = await patientWithEncounter(page, slug, "Julio Paz", "42334455")
  await call(page, "PATCH", `/api/patients/${patientId}/encounters/${encounterId}`, slug, {
    examination: { refraccion: { od: { esfera: -2, cilindro: -0.75, eje: 90 }, oi: { esfera: -1.75 } } },
  })
  const prescription = await call<{ id: string }>(page, "POST", `/api/patients/${patientId}/lens-prescriptions`, slug, {
    encounterId,
    kind: "anteojos",
  }, 201)
  const cashId = await cashMethod(page, slug)
  const sold = await call<{ order: OrderView; ticketId: string | null }>(page, "POST", "/api/orders/sale", slug, {
    patientId,
    branchId,
    requestId: randomUUID(),
    title: "Lunas",
    maker: "Laboratorio Visión",
    promisedOn: limaDayIn(5),
    lines: [{ kind: "lunas", description: "Lunas monofocales", amountCents: 30_000 }],
    referenceId: prescription.id,
    payments: [{ paymentMethodId: cashId, amountCents: 10_000 }],
    cashReceivedCents: 10_000,
  }, 201)
  const orderId = sold.order.id
  expect(sold.ticketId).toBeTruthy()
  expect(sold.order).toMatchObject({ status: "por_enviar", dueCents: 20_000 })

  // Taller: el pedido con la copia de la receta, sin lo que falta pagar.
  const workshop = await teammate(browser, fixtureDb, passwordHash, orgId, "workshop", "Tomás")
  const seenByWorkshop = await call<OrderView>(workshop.page, "GET", `/api/orders/${orderId}`, slug)
  expect(seenByWorkshop).toMatchObject({ dueCents: null, prescriptionHidden: false, prescription: expect.objectContaining({ kind: "anteojos" }) })
  expect(seenByWorkshop.lines.every((line) => line.amountCents === null)).toBe(true)
  await gotoHydrated(workshop.page, vistiaUrl(slug, `/orders?pedido=${orderId}`))
  await expect(workshop.page.getByRole("navigation").getByRole("link", { name: "Pedidos" }).first()).toBeVisible()
  const workshopDetail = surface(workshop.page, { name: `Pedido N.º ${sold.order.orderNumber}` })
  await expect(workshopDetail.getByText(/^OD [−-]2,00 [−-]0,75 × 90°/)).toBeVisible()
  await expect(workshopDetail.getByText("Falta pagar")).toHaveCount(0)
  // Avanza: el paso queda en el servidor.
  await workshopDetail.getByRole("button", { name: "Enviado al laboratorio", exact: true }).click()
  await expect.poll(async () => (await call<OrderView>(workshop.page, "GET", `/api/orders/${orderId}`, slug)).status).toBe("en_laboratorio")
  // Anular y rehacer deciden sobre lo cobrado: no se ofrecen y el servidor los rechaza.
  await workshopDetail.getByRole("button", { name: `Más acciones del pedido N.º ${sold.order.orderNumber}` }).click()
  await expect(workshop.page.getByRole("menuitem", { name: "Marcar listo" })).toBeVisible()
  await expect(workshop.page.getByRole("menuitem", { name: "Anular" })).toHaveCount(0)
  await expect(workshop.page.getByRole("menuitem", { name: "Rehacer" })).toHaveCount(0)
  await workshop.page.keyboard.press("Escape")
  await workshop.page.screenshot({ path: testInfo.outputPath("pedido-taller.png"), fullPage: true })
  const voided = await request(workshop.page, "POST", `/api/orders/${orderId}/void`, slug, { reason: "Se equivocó de montura" })
  expect(voided.status).toBe(403)
  const remade = await request(workshop.page, "POST", `/api/orders/${orderId}/remake`, slug, {
    reason: "Se rayó",
    promisedOn: limaDayIn(9),
    requestId: randomUUID(),
  })
  expect(remade.status).toBe(403)
  expect((await call<OrderView>(page, "GET", `/api/orders/${orderId}`, slug)).status).toBe("en_laboratorio")
  await workshop.context.close()

  // Recepción: ve cómo va, sin la receta ni la caja, y no lo cambia.
  const reception = await teammate(browser, fixtureDb, passwordHash, orgId, "reception", "Lucía")
  const seenByReception = await call<OrderView>(reception.page, "GET", `/api/orders/${orderId}`, slug)
  expect(seenByReception).toMatchObject({ status: "en_laboratorio", dueCents: null, prescription: null, prescriptionHidden: true })
  expect(seenByReception.lines.every((line) => line.amountCents === null)).toBe(true)
  const list = await call<Array<{ id: string; dueCents: number | null }>>(reception.page, "GET", "/api/orders", slug)
  expect(list).toEqual([expect.objectContaining({ id: orderId, dueCents: null })])
  await gotoHydrated(reception.page, vistiaUrl(slug, `/orders?pedido=${orderId}`))
  const receptionDetail = surface(reception.page, { name: `Pedido N.º ${sold.order.orderNumber}` })
  await expect(receptionDetail.getByText("Va con el pedido; la ve quien lo hace.")).toBeVisible()
  await expect(receptionDetail.getByText(/^OD /)).toHaveCount(0)
  await expect(receptionDetail.getByText("Falta pagar")).toHaveCount(0)
  await expect(receptionDetail.getByRole("button", { name: "Llegó del laboratorio" })).toHaveCount(0)
  await expect(reception.page.getByRole("columnheader", { name: "Por pagar" })).toHaveCount(0)
  await reception.page.screenshot({ path: testInfo.outputPath("pedido-recepcion.png"), fullPage: true })
  const advanced = await request(reception.page, "POST", `/api/orders/${orderId}/advance`, slug, { status: "por_revisar" })
  expect(advanced.status).toBe(403)
  const references = await request(reception.page, "GET", `/api/orders/references?patientId=${patientId}`, slug)
  expect(references.status).toBe(403)
  await reception.context.close()
  await context.close()
})
