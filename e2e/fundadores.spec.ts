import { randomUUID } from "node:crypto"
import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { session } from "@odentia/db/schema/auth"
import { saasFollowUp, saasPlan, saasSubscription, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import type { Db } from "@odentia/db"
import { desc, eq } from "drizzle-orm"
import { accountClient, surface } from "./admin"
import { hostUrl, PANEL, tenant, tenantPattern } from "./env"
import { api, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { latestLinkFor } from "./mailpit"

/**
 * Fundadores (issue 165) y precio negociado con vencimiento (issue 168), de
 * punta a punta: la solicitud llega por la web y es un cliente del ARM; la
 * administración la anota e invita desde su ficha, la persona crea su cuenta
 * con el enlace del correo y abre su clínica con el plan Fundadores; en Hoy se
 * ve el precio negociado que vence pronto y lleva a su ficha.
 * El run deja el alta abierta (fixtures): la invitación sirve igual.
 */

const DAY = 86_400_000

/** Quien recorre es personal de odentIA, con su segundo factor verificado en esta sesión. */
async function makeStaff(fixtureDb: Db, userId: string): Promise<void> {
  const [current] = await fixtureDb.select({ id: session.id }).from(session).where(eq(session.userId, userId)).orderBy(desc(session.createdAt)).limit(1)
  const factorId = randomUUID()
  await fixtureDb.insert(adminStaff).values({ userId, role: "admin" })
  await fixtureDb.insert(twoFactor).values({ id: factorId, userId, secret: "e2e", backupCodes: "[]", verified: true })
  await fixtureDb.insert(adminSessionVerification).values({ userId, sessionId: current!.id, factorId, method: "totp", expiresAt: new Date(Date.now() + DAY) })
}

/** Un plan Fundadores propio del caso: sin cuota, USD 100 de regalo y 40 % menos en cada acción. */
async function foundersPlan(fixtureDb: Db, tag: string): Promise<string> {
  const [plan] = await fixtureDb
    .insert(saasPlan)
    .values({
      code: `fundadores-${tag}`,
      name: `Fundadores ${tag}`,
      currency: "USD",
      priceCents: 0,
      creditCents: 0,
      conversationMicros: 300_000,
      consultationMicros: 240_000,
      recoveryMicros: 2_400_000,
      maxDiscountBps: 0,
      sellerDiscountBps: 0,
      trialCreditCents: 10_000,
      trialMaxCreditCents: 10_000,
      trialDays: 90,
      trialMaxDays: 90,
      seatLimit: 20,
      guaranteeMonths: 12,
      // Primero en el orden: es el plan por invitación que ofrece la lista de espera.
      sortOrder: -1_000_000 + Math.floor(Math.random() * 1000),
    })
    .returning({ id: saasPlan.id })
  return plan!.id
}

test("fundadores: la administración invita y la clínica entra con su invitación", async ({ owner, fixtureDb, browser }, testInfo) => {
  test.setTimeout(240_000)
  const { page, user } = owner
  const shot = (p: typeof page, name: string) => p.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const tag = `t${randomUUID().slice(0, 5)}`
  await makeStaff(fixtureDb, user.id)
  const planId = await foundersPlan(fixtureDb, tag)
  const email = `fundadora-${tag}@test.dev`
  // La solicitud llega por la web, como la deja el formulario: con su cliente del ARM y su persona.
  const sent = await api<{ ok: boolean }>(page, "POST", "/api/public/founders/waitlist", undefined, {
    firstName: "Ana",
    lastName: `Quispe ${tag}`,
    email,
    phone: "+51987654321",
    clinicName: `Clínica Sonrisa ${tag}`,
    countryCode: "PE",
    city: "Arequipa",
    professionals: "2-3",
    currentTool: "cuaderno_excel",
  })
  expect(sent.status, JSON.stringify(sent.body)).toBe(201)
  const [request] = await fixtureDb
    .select({ id: saasWaitlistRequest.id, clientId: saasWaitlistRequest.clientId })
    .from(saasWaitlistRequest)
    .where(eq(saasWaitlistRequest.email, email))
  expect(request?.clientId).toBeTruthy()

  // La lista de espera de antes lleva a Clientes con su búsqueda: la solicitud es un cliente por vender.
  await gotoHydrated(page, hostUrl("admin", `/waitlist?q=${tag}`))
  await expect(page).toHaveURL(/\/clients\?/)
  await expect(page.getByRole("heading", { name: "Clientes", level: 1 })).toBeVisible()
  const row = page.getByRole("row").filter({ hasText: `Clínica Sonrisa ${tag}` })
  await expect(row).toBeVisible()
  await shot(page, "lista-de-espera")
  await row.click()
  await expect(page.getByRole("heading", { name: `Clínica Sonrisa ${tag}`, level: 1 })).toBeVisible()
  // En Venta, la solicitud de la web con quién pidió y su plazo.
  await page.getByRole("tablist", { name: "Secciones del cliente" }).getByRole("tab", { name: "Venta" }).click()
  const card = page.getByRole("region", { name: "La solicitud de la web" })
  await expect(card.getByText(email).first()).toBeVisible()
  await expect(card).toContainText("Plazo")
  // El seguimiento: cada contacto es una entrada con quién la anotó; se anota con «Anotar» de la ficha.
  await page.getByRole("button", { name: "Anotar", exact: true }).click()
  const annotate = surface(page, "Anotar")
  await annotate.getByLabel("¿Qué pasó?").fill("Llamada el lunes: usan WhatsApp Business.")
  await annotate.getByRole("button", { name: "Guardar como nota" }).click()
  await expect(page.getByText("Anotado en su historial")).toBeVisible()
  await expect(annotate).toHaveCount(0)
  const entries = card.getByRole("list", { name: "Entradas del seguimiento" })
  await expect(entries.getByRole("listitem").filter({ hasText: "Llamada el lunes: usan WhatsApp Business." })).toContainText(user.name)
  await shot(page, "solicitud-abierta")
  // Invitar se decide en «Decides tú», con el correo de la solicitud ya puesto.
  await page.getByRole("region", { name: "Decides tú" }).getByRole("button", { name: "Invitar", exact: true }).click()
  const invite = surface(page, "Invitar a abrir su cuenta")
  await expect(invite.getByLabel("Correo de quien abre la cuenta")).toHaveValue(email)
  await invite.getByRole("button", { name: "Invitar y enviar el correo" }).click()
  await expect(page.getByText(`Invitación enviada a ${email}`)).toBeVisible()
  const [invited] = await fixtureDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, request!.id))
  expect(invited).toMatchObject({ status: "invitada", planId, note: null })
  const followUps = await fixtureDb.select().from(saasFollowUp).where(eq(saasFollowUp.requestId, request!.id))
  expect(followUps).toEqual([
    expect.objectContaining({ authorUserId: user.id, body: "Llamada el lunes: usan WhatsApp Business.", followUpOn: null, adminOnly: false }),
  ])

  // El correo lleva a «Crea tu cuenta» con la invitación: el regalo, el correo fijo y sin cuota.
  const link = await latestLinkFor(email, "Tu lugar en odentIA Fundadores está listo")
  expect(link).toContain("/register?invitacion=")
  const context = await browser.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true })
  try {
    const visitor = await context.newPage()
    await gotoHydrated(visitor, link)
    await expect(visitor.getByText("Los primeros", { exact: false }).first()).toBeVisible()
    await expect(visitor.getByText("Sin cuota").locator("visible=true")).toBeVisible()
    await expect(visitor.getByLabel("Correo")).toHaveValue(email)
    await expect(visitor.getByLabel("Correo")).toHaveAttribute("readonly", "")
    await shot(visitor, "crear-cuenta-con-invitacion")
    await visitor.getByLabel("Nombre").fill("Ana")
    await visitor.getByLabel("Apellidos").fill(`Quispe ${tag}`)
    await visitor.getByLabel("Contraseña").fill("secreto-fundadora-123")
    await visitor.getByRole("checkbox", { name: /Acepto los Términos/ }).check()
    await visitor.getByRole("button", { name: "Crear mi cuenta" }).click()
    await expect(visitor).toHaveURL(/verify-email-sent/)

    // Verificar el correo deja adentro y sigue a «Configura tu clínica» con la invitación.
    await visitor.goto(await latestLinkFor(email, "Verifica tu correo"))
    await expect(visitor).toHaveURL(/onboarding\?invitacion=/)
    const slug = `fundadora-${tag}`
    await visitor.getByLabel("Nombre de tu clínica").fill(`Clínica Sonrisa ${tag}`)
    await visitor.getByLabel("Dirección de tu clínica en odentIA").fill(slug)
    await visitor.getByRole("button", { name: "Continuar" }).click()
    await visitor.getByLabel("Razón social").fill(`Clínica Sonrisa ${tag} S.A.C.`)
    await visitor.getByRole("button", { name: "Continuar" }).click()
    await visitor.getByLabel("Nombre de la sede").fill("Sede Centro")
    await visitor.getByRole("button", { name: "Crear organización" }).click()
    await expect(visitor).toHaveURL(tenantPattern(slug, "/home"))
  } finally {
    await context.close()
  }

  // La clínica quedó con el plan Fundadores, su prueba de 90 días y 12 meses garantizados; la invitación ya no sirve.
  const [entered] = await fixtureDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, request!.id))
  expect(entered?.status).toBe("entro")
  const [sub] = await fixtureDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, entered!.organizationId!))
  expect(sub?.planId).toBe(planId)
  expect(Math.round(((sub?.trialEndsAt?.getTime() ?? 0) - (sub?.trialStartedAt?.getTime() ?? 0)) / DAY)).toBe(90)
  expect(sub?.guaranteedUntil).not.toBeNull()

  // «Entró» de antes es «Con cuenta» en Clientes: el mismo cliente, ahora con su cuenta.
  await gotoHydrated(page, hostUrl("admin", `/waitlist?etapa=entro&q=${tag}`))
  await expect(page).toHaveURL(/vista=con_cuenta/)
  await expect(page.getByRole("row").filter({ hasText: `Clínica Sonrisa ${tag}` })).toBeVisible()
  await shot(page, "lista-entraron")
})

test("precio negociado: vence, se marca en Hoy, se renueva en su ficha y se avisa a la clínica", async ({ owner, fixtureDb }, testInfo) => {
  test.setTimeout(180_000)
  const { page, user, org } = owner
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const tag = `t${randomUUID().slice(0, 5)}`
  await makeStaff(fixtureDb, user.id)
  const planId = await foundersPlan(fixtureDb, tag)
  // Un plan con descuento negociable para su ficha; el descuento vence en 6 días.
  await fixtureDb.update(saasPlan).set({ maxDiscountBps: 6000, sellerDiscountBps: 1000, seatLimit: null }).where(eq(saasPlan.id, planId))
  await fixtureDb
    .update(saasSubscription)
    .set({ planId, discountBps: 1000, discountEndsAt: new Date(Date.now() + 6 * DAY - 60_000) })
    .where(eq(saasSubscription.organizationId, org.id))

  // Su cuenta es un cliente (lo liga Kairós): en Clientes, «Con cuenta», con su búsqueda.
  await accountClient(fixtureDb, { org, product: "dental" })
  await gotoHydrated(page, hostUrl("admin", `/clients?vista=con_cuenta&q=${encodeURIComponent(org.name)}`))
  await expect(page.getByRole("row").filter({ hasText: org.name })).toBeVisible()

  // En Hoy el precio negociado se marca con su vencimiento y lleva a renovarlo en su ficha.
  await gotoHydrated(page, hostUrl("admin", "/"))
  const soon = page.getByRole("region", { name: "Precios especiales que vencen pronto" }).or(page.locator("section").filter({ hasText: "Precios especiales que vencen pronto" }))
  const deal = soon.getByRole("listitem").filter({ hasText: org.name })
  await expect(deal).toContainText("Su precio especial termina el")
  await expect(deal).toContainText("faltan 6 días")
  await shot("inicio-vencen-pronto")
  await deal.getByRole("link", { name: "Renovar…" }).click()
  // Su ficha, en Plan y pagos: el descuento con su vencimiento y lo que paga esta clínica.
  await expect(page.getByRole("heading", { name: org.name, level: 1 })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Plan y pagos" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByLabel("Descuento en lo que se negocia (%)")).toHaveValue("10")
  await expect(page.getByRole("columnheader", { name: "Paga esta clínica" })).toBeVisible()
  await shot("clinicas-precio-negociado")
  // El enlace de antes a la ficha de la clínica abre la de su cliente.
  await gotoHydrated(page, hostUrl("admin", `/organizations?org=${org.id}`))
  await expect(page).toHaveURL(/\/clients\//)
  await expect(page.getByRole("heading", { name: org.name, level: 1 })).toBeVisible()

  // La clínica ve el aviso arriba de su espacio, con el botón a su plan.
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(page.getByText("Tu precio especial (10 % menos en cada acción) termina", { exact: false })).toBeVisible()
  await expect(page.getByRole("button", { name: "Ver mi plan" }).or(page.getByRole("link", { name: "Ver mi plan" }))).toBeVisible()
  await shot("aviso-a-la-clinica")

  // Plan y alta en Cobros y planes: los campos de Fundadores y el interruptor de alta.
  await gotoHydrated(page, hostUrl("admin", "/billing"))
  await expect(page.getByRole("heading", { name: "Cobros y planes", level: 1 })).toBeVisible()
  // Cada producto decide su alta y tiene su lista (ADR 0093).
  const alta = page.locator("#alta")
  await expect(alta.getByRole("radiogroup")).toHaveCount(CLINICAL_PRODUCTS.length)
  await expect(alta.getByRole("radio", { name: /Cualquiera abre su consultorio con el plan por defecto de latidIA/ })).toBeVisible()
  await alta.scrollIntoViewIfNeeded()
  await shot("alta-por-producto")
  await page.getByRole("heading", { name: "Planes", exact: true }).scrollIntoViewIfNeeded()
  await shot("planes-por-producto")
  await page.getByRole("listitem").filter({ hasText: `Fundadores ${tag}` }).getByRole("button", { name: "Editar" }).click()
  await expect(page.getByLabel("Condiciones garantizadas (meses)")).toHaveValue("12")
  await shot("plan-fundadores")
  await page.keyboard.press("Escape")

  // Un plan nuevo elige su producto y empieza con los precios de otro.
  await page.getByRole("button", { name: "Nuevo plan" }).first().click()
  await page.getByRole("radiogroup", { name: "Producto" }).getByRole("radio", { name: "latidIA", exact: true }).click()
  await expect(page.getByText("Plan por defecto de latidIA", { exact: true })).toBeVisible()
  await page.getByRole("combobox", { name: "Empezar con los precios de" }).click()
  await page.getByRole("option", { name: new RegExp(`Fundadores ${tag}`) }).click()
  await expect(page.getByLabel("Condiciones garantizadas (meses)")).toHaveValue("12")
  await shot("nuevo-plan-latidia")
})
