import { randomUUID } from "node:crypto"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { session } from "@odentia/db/schema/auth"
import { saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import type { Db } from "@odentia/db"
import { desc, eq } from "drizzle-orm"
import { accountClient } from "./admin"
import { hostUrl, tenant } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Precio negociado con vencimiento (issue 168), de punta a punta: en Hoy se ve el
 * precio negociado que vence pronto y lleva a su ficha, la clínica ve su aviso y
 * Cobros y planes muestra el plan especial con sus meses garantizados (ADR 0221).
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

/** Un plan especial propio del caso: sin cuota, USD 100 de regalo, menos en cada acción y no sale en la web. */
async function specialPlan(fixtureDb: Db, tag: string): Promise<string> {
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
      guaranteeMonths: 12,
      showOnWeb: false,
      sortOrder: -1_000_000 + Math.floor(Math.random() * 1000),
    })
    .returning({ id: saasPlan.id })
  return plan!.id
}

test("precio negociado: vence, se marca en Hoy, se renueva en su ficha y se avisa a la clínica", async ({ owner, fixtureDb }, testInfo) => {
  test.setTimeout(180_000)
  const { page, user, org } = owner
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const tag = `t${randomUUID().slice(0, 5)}`
  await makeStaff(fixtureDb, user.id)
  const planId = await specialPlan(fixtureDb, tag)
  // Un plan con descuento negociable para su ficha; el descuento vence en 6 días.
  await fixtureDb.update(saasPlan).set({ maxDiscountBps: 6000, sellerDiscountBps: 1000 }).where(eq(saasPlan.id, planId))
  await fixtureDb
    .update(saasSubscription)
    .set({ planId, discountBps: 1000, discountEndsAt: new Date(Date.now() + 6 * DAY - 60_000) })
    .where(eq(saasSubscription.organizationId, org.id))

  // Su cuenta es un cliente (lo liga Kairós): en Clientes, en «Todos» con su búsqueda.
  await accountClient(fixtureDb, { org, product: "dental" })
  await gotoHydrated(page, hostUrl("admin", `/clients?vista=todos&q=${encodeURIComponent(org.name)}`))
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

  // Cobros y planes: ya no hay interruptor de alta (ADR 0221); el plan especial dice que no sale en la web.
  await gotoHydrated(page, hostUrl("admin", "/billing"))
  await expect(page.getByRole("heading", { name: "Cobros y planes", level: 1 })).toBeVisible()
  await expect(page.locator("#alta")).toHaveCount(0)
  // La lista se dibuja otra vez al cargar los planes: se espera el encabezado, sin desplazar a mano.
  await expect(page.getByRole("heading", { name: "Planes", exact: true })).toBeVisible()
  await expect(page.getByText("no sale en la web").first()).toBeVisible()
  await shot("planes-por-producto")
  await page.getByRole("listitem").filter({ hasText: `Fundadores ${tag}` }).getByRole("button", { name: "Editar" }).click()
  await expect(page.getByLabel("Condiciones garantizadas (meses)")).toHaveValue("12")
  await shot("plan-especial")
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
