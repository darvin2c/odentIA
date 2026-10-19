import { randomUUID } from "node:crypto"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { session } from "@odentia/db/schema/auth"
import { saasPlan, saasSubscription, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import type { Db } from "@odentia/db"
import { desc, eq } from "drizzle-orm"
import { hostUrl, PANEL, tenant, tenantPattern } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { latestLinkFor } from "./mailpit"

/**
 * Fundadores (issue 165) y precio negociado con vencimiento (issue 168), de
 * punta a punta: la administración invita desde la lista de espera, la
 * persona crea su cuenta con el enlace del correo y abre su clínica con el
 * plan Fundadores; en Clínicas se ve el precio negociado que vence pronto.
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
  const tag = randomUUID().slice(0, 6)
  await makeStaff(fixtureDb, user.id)
  const planId = await foundersPlan(fixtureDb, tag)
  const email = `fundadora-${tag}@test.dev`
  const [request] = await fixtureDb
    .insert(saasWaitlistRequest)
    .values({
      firstName: "Ana",
      lastName: `Quispe ${tag}`,
      email,
      phone: "+51987654321",
      clinicName: `Clínica Sonrisa ${tag}`,
      countryCode: "PE",
      city: "Arequipa",
      dentists: "2-3",
      currentTool: "cuaderno_excel",
    })
    .returning({ id: saasWaitlistRequest.id })

  // Lista de espera: la solicitud por revisar, con su plazo; se abre al lado y se invita con confirmación.
  await gotoHydrated(page, hostUrl("admin", `/waitlist?q=${tag}`))
  await expect(page.getByRole("heading", { name: "Lista de espera", level: 1 })).toBeVisible()
  const row = page.getByRole("row").filter({ hasText: `Clínica Sonrisa ${tag}` })
  await expect(row).toBeVisible()
  await shot(page, "lista-de-espera")
  await row.click()
  const panel = page.getByRole("region", { name: `Clínica Sonrisa ${tag}` })
  await expect(panel).toBeVisible()
  await expect(panel.getByText(email).first()).toBeVisible()
  await panel.getByLabel("Nota del equipo").fill("Llamada el lunes: usan WhatsApp Business.")
  await panel.getByRole("button", { name: "Guardar nota" }).click()
  await expect(page.getByText("Nota guardada")).toBeVisible()
  await shot(page, "solicitud-abierta")
  await panel.getByRole("button", { name: "Enviar invitación…" }).click()
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: "¿Enviar la invitación" })
  await dialog.getByRole("button", { name: "Enviar invitación" }).click()
  await expect(page.getByText(`Invitación enviada a ${email}`)).toBeVisible()
  const [invited] = await fixtureDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, request!.id))
  expect(invited).toMatchObject({ status: "invitada", planId, note: "Llamada el lunes: usan WhatsApp Business." })

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

  await gotoHydrated(page, hostUrl("admin", `/waitlist?estado=entro&q=${tag}`))
  await expect(page.getByRole("row").filter({ hasText: `Clínica Sonrisa ${tag}` })).toBeVisible()
  await shot(page, "lista-entraron")
})

test("precio negociado: vence, se marca en Clínicas y se avisa en Inicio", async ({ owner, fixtureDb }, testInfo) => {
  test.setTimeout(180_000)
  const { page, user, org } = owner
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const tag = randomUUID().slice(0, 6)
  await makeStaff(fixtureDb, user.id)
  const planId = await foundersPlan(fixtureDb, tag)
  // Un plan con descuento negociable para su ficha; el descuento vence en 6 días.
  await fixtureDb.update(saasPlan).set({ maxDiscountBps: 6000, sellerDiscountBps: 1000, seatLimit: null }).where(eq(saasPlan.id, planId))
  await fixtureDb
    .update(saasSubscription)
    .set({ planId, discountBps: 1000, discountEndsAt: new Date(Date.now() + 6 * DAY - 60_000) })
    .where(eq(saasSubscription.organizationId, org.id))

  await gotoHydrated(page, hostUrl("admin", `/organizations?org=${org.id}`))
  await page.getByRole("textbox", { name: "Buscar clínicas" }).fill(org.slug)
  await page.getByRole("button", { name: "Buscar" }).click()
  await expect(page.getByText("10 % · vence en 6 días")).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Paga esta clínica" })).toBeVisible()
  await shot("clinicas-precio-negociado")

  await gotoHydrated(page, hostUrl("admin", "/"))
  const soon = page.getByRole("region", { name: "Precios especiales que vencen pronto" }).or(page.locator("section").filter({ hasText: "Precios especiales que vencen pronto" }))
  await expect(soon.getByText(org.name)).toBeVisible()
  await expect(soon.getByRole("link", { name: "Renovar…" }).first()).toBeVisible()
  await shot("inicio-vencen-pronto")

  // La clínica ve el aviso arriba de su espacio, con el botón a su plan.
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(page.getByText("Tu precio especial (10 % menos en cada acción) termina", { exact: false })).toBeVisible()
  await expect(page.getByRole("button", { name: "Ver mi plan" }).or(page.getByRole("link", { name: "Ver mi plan" }))).toBeVisible()
  await shot("aviso-a-la-clinica")

  // Plan y alta en Cobros y planes: los campos de Fundadores y el interruptor de alta.
  await gotoHydrated(page, hostUrl("admin", "/billing"))
  await expect(page.getByRole("heading", { name: "Alta de clínicas nuevas" })).toBeVisible()
  await page.getByRole("listitem").filter({ hasText: `Fundadores ${tag}` }).getByRole("button", { name: "Editar" }).click()
  await expect(page.getByLabel("Condiciones garantizadas (meses)")).toHaveValue("12")
  await shot("plan-fundadores")
})
