import { randomUUID } from "node:crypto"
import { LEGAL } from "@odentia/auth/legal"
import type { Db } from "@odentia/db"
import { account, member, user as users } from "@odentia/db/schema/auth"
import { product } from "@odentia/db/schema/inventory"
import type { Page } from "@playwright/test"
import { vistiaUrl } from "./env"
import { asClinicFromBefore, expect, PASSWORD, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/**
 * Venta de mostrador (ADR 0172), común a los productos; aquí, en una óptica:
 * unos lentes de sol a quien no es paciente. Se escanea el código, se dice solo
 * su nombre, se paga en efectivo con vuelto y el ticket se abre al lado con
 * «Cliente: …», sin ficha. Recepción no vende: lo dice el servidor.
 */

type Ok<T> = { status: number; body: T }

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

async function call<T>(page: Page, method: string, path: string, slug: string | undefined, body?: unknown, expected = 200): Promise<T> {
  const result = await request<{ data: T }>(page, method, path, slug, body)
  expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBe(expected)
  return result.body.data
}

async function createPerson(db: Db, passwordHash: string, firstName: string) {
  const id = randomUUID()
  const email = `mostrador-${firstName.toLowerCase()}-${id}@test.dev`
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id,
      name: `${firstName} Equipo`,
      firstName,
      lastName: "Equipo",
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

async function signIn(page: Page, email: string) {
  await gotoHydrated(page, vistiaUrl("app", "/login"))
  const signedIn = await request<{ user: { id: string } }>(page, "POST", "/api/auth/sign-in/email", undefined, { email, password: PASSWORD })
  expect(signedIn.status).toBe(200)
}

test("venta de mostrador: lentes de sol sin ficha, con vuelto, y su ticket al lado", async ({ browser, fixtureDb, passwordHash }, testInfo) => {
  test.setTimeout(180_000)
  const owner = await createPerson(fixtureDb, passwordHash, "Rocio")
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })

  await signIn(page, owner.email)
  const slug = `mostrador-${owner.id.slice(0, 8)}`
  const created = await request<{ id: string }>(page, "POST", "/api/auth/organization/create", undefined, { name: "Óptica Mostrador", slug })
  expect(created.status).toBe(200)
  const orgId = created.body.id
  expect((await request(page, "POST", "/api/auth/organization/set-active", undefined, { organizationId: orgId })).status).toBe(200)
  await call(page, "PUT", "/api/org-profile", slug, { legalName: "Óptica Mostrador S.A.C.", countryCode: "PE" })
  const branch = await call<{ id: string }>(page, "POST", "/api/branches", slug, { name: "Sede Central" }, 201)
  await asClinicFromBefore(fixtureDb, orgId)
  const methods = await call<Array<{ id: string; name: string; typeCode: string | null }>>(page, "GET", "/api/org/payment-methods", slug)
  const cashId =
    methods.find((item) => item.typeCode === "10")?.id ??
    (await call<{ id: string }>(page, "POST", "/api/org/payment-methods", slug, { name: "Efectivo", typeCode: "10" }, 201)).id
  const barcode = `775${Date.now().toString().slice(-10)}`
  const [sunglasses] = await fixtureDb.insert(product).values({
    organizationId: orgId,
    sku: `SOL-${randomUUID().slice(0, 8)}`,
    name: "Lentes de sol polarizados",
    unit: "unidad",
    usedInCare: false,
    forSale: true,
    salePriceCents: 12_000,
    saleCurrency: "PEN",
    barcode,
  }).returning({ id: product.id })

  // Finanzas › Caja: «Venta de mostrador» junto a «Cobrar».
  await gotoHydrated(page, vistiaUrl(slug, "/finance"))
  await page.getByRole("button", { name: "Venta de mostrador" }).click()
  const sale = surface(page, { name: "Venta de mostrador" })
  await expect(sale).toBeVisible()

  // El lector escribe el código y pulsa Enter: queda elegido.
  const search = sale.getByRole("combobox").first()
  await search.click()
  await search.fill(barcode)
  await search.press("Enter")
  await expect(sale.getByRole("combobox", { name: /^Producto\s*, fila 1$/ })).toHaveValue("Lentes de sol polarizados")
  // La fila siguiente queda lista para el próximo código.
  await expect(sale.getByRole("combobox", { name: /^Producto\s*, fila 2$/ })).toBeVisible()
  await expect(sale.getByText(/Total S\/\s?120[.,]00/)).toBeVisible()

  // Para quién: solo su nombre; paga en efectivo con un billete de 150.
  await sale.getByRole("group", { name: "Para quién (opcional)" }).getByRole("button", { name: "Solo su nombre" }).click()
  await sale.getByRole("textbox", { name: "Nombre" }).fill("Ana Torres")
  await sale.getByRole("group", { name: "Cómo paga" }).getByRole("button", { name: "Efectivo", exact: true }).click()
  await sale.getByRole("textbox", { name: "Recibes en efectivo" }).fill("150")
  await expect(sale.getByText(/S\/\s?30[.,]00/)).toBeVisible()
  await shot("venta-de-mostrador")
  await sale.getByRole("button", { name: /^Cobrar S\/\s?120[.,]00$/ }).click()

  // El ticket se abre al lado: «Cliente: Ana Torres», sin ficha ni «Enviar al paciente».
  await expect(page).toHaveURL(/[?&]ticket=/)
  const ticketId = new URL(page.url()).searchParams.get("ticket")!
  const ticket = surface(page, { name: /^Ticket \d{6}$/ })
  await expect(ticket.getByText("Cliente: Ana Torres")).toBeVisible()
  await expect(ticket.getByText("Paciente:")).toHaveCount(0)
  await expect(ticket.getByRole("button", { name: "Enviar al paciente" })).toHaveCount(0)
  await expect(ticket.getByText("Vuelto")).toBeVisible()
  await shot("ticket-de-mostrador")
  const opened = await call<{ patientId: string | null; ticket: { buyerName: string | null; totalCents: number; changeCents: number } }>(
    page,
    "GET",
    `/api/finance/tickets/${ticketId}`,
    slug,
  )
  expect(opened).toMatchObject({ patientId: null, ticket: { buyerName: "Ana Torres", totalCents: 12_000, changeCents: 3_000 } })

  // En el teléfono, «Venta de mostrador» está en «Más opciones».
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, vistiaUrl(slug, "/finance?tab=cobros"))
  await expect(page.getByText("Ana Torres").first()).toBeVisible()
  await page.getByRole("button", { name: "Más opciones" }).click()
  await page.getByRole("menuitem", { name: "Venta de mostrador" }).click()
  await expect(surface(page, { name: "Venta de mostrador" })).toBeVisible()
  await shot("venta-de-mostrador-telefono")

  // Recepción no vende en el mostrador: el servidor lo niega.
  const reception = await createPerson(fixtureDb, passwordHash, "Lucia")
  await fixtureDb.insert(member).values({ id: randomUUID(), organizationId: orgId, userId: reception.id, role: "reception", createdAt: new Date() })
  const other = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage()
  await signIn(other, reception.email)
  const refused = await request(other, "POST", "/api/finance/counter-sales", slug, {
    branchId: branch.id,
    requestId: randomUUID(),
    lines: [{ productId: sunglasses!.id }],
    payments: [{ paymentMethodId: cashId, amountCents: 12_000 }],
  })
  expect(refused.status).toBe(403)
  await context.close()
})
