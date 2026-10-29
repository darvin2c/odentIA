import { randomUUID } from "node:crypto"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { session } from "@odentia/db/schema/auth"
import { saasPlan } from "@odentia/db/schema/saas-billing"
import { desc, eq } from "drizzle-orm"
import { hostUrl } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Guardar un plan en Cobros y planes no recarga la página: el cajón es un
 * formulario y, si nadie cancela su envío, el navegador lo manda y recarga a
 * mitad del guardado (el error del servidor ya no se ve). El cajón se cierra,
 * la lista muestra el cambio y lo que había en la pestaña sigue ahí.
 */
test("guardar un plan en la administración no recarga la página", async ({ owner, fixtureDb }, testInfo) => {
  const { page, user } = owner
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const tag = randomUUID().slice(0, 8)
  const [plan] = await fixtureDb
    .insert(saasPlan)
    .values({
      code: `guardar-${tag}`,
      name: `Guardar ${tag}`,
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationInformMicros: 100_000,
      conversationMicros: 500_000,
      conversationAgendaMicros: 1_000_000,
      consultationSimpleMicros: 100_000,
      consultationStandardMicros: 200_000,
      consultationMicros: 500_000,
      recoveryMicros: 2_000_000,
      argosIncludedQuestions: 300,
      argosPackQuestions: 100,
      argosPackMicros: 3_000_000,
      storageIncludedGb: 20,
      storageGbMicros: 200_000,
      // Nada se negocia: la comprobación de precios no frena el guardado, que es lo que se mira aquí.
      fixedPriceTiers: ["informa", "gestiona", "agenda", "simple", "estandar", "completa", "cita", "preguntas", "almacenamiento"],
      maxDiscountBps: 0,
      sellerDiscountBps: 0,
      trialCreditCents: 5000,
      trialMaxCreditCents: 13000,
    })
    .returning()

  // La misma persona, como personal de odentIA con su segundo factor verificado en esta sesión.
  const [current] = await fixtureDb.select({ id: session.id }).from(session).where(eq(session.userId, user.id)).orderBy(desc(session.createdAt)).limit(1)
  const factorId = randomUUID()
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  await fixtureDb.insert(twoFactor).values({ id: factorId, userId: user.id, secret: "e2e", backupCodes: "[]", verified: true })
  await fixtureDb.insert(adminSessionVerification).values({ userId: user.id, sessionId: current!.id, factorId, method: "totp", expiresAt: new Date(Date.now() + 86_400_000) })

  await page.setViewportSize({ width: 1366, height: 860 })
  await gotoHydrated(page, hostUrl("admin", "/billing"))
  const row = page.getByRole("listitem").filter({ hasText: plan!.code })
  await row.getByRole("button", { name: "Editar" }).click()
  await expect(page.getByRole("heading", { name: "Editar plan" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Comprobación antes de guardar" }).getByRole("row").filter({ hasText: "Gestiona" })).toBeVisible()
  await shot("cajon-escritorio")

  // Una marca en la pestaña: una recarga la borraría.
  await page.evaluate(() => {
    ;(window as { sinRecargar?: boolean }).sinRecargar = true
  })
  await page.locator("#plan-name").fill(`Guardado ${tag}`)
  await page.getByRole("button", { name: "Guardar" }).click()
  await expect(page.getByRole("heading", { name: "Editar plan" })).toHaveCount(0)
  await expect(row).toContainText(`Guardado ${tag}`)
  expect(await page.evaluate(() => (window as { sinRecargar?: boolean }).sinRecargar)).toBe(true)
  const [saved] = await fixtureDb.select({ name: saasPlan.name }).from(saasPlan).where(eq(saasPlan.id, plan!.id))
  expect(saved?.name).toBe(`Guardado ${tag}`)
  await shot("guardado")

  // En el teléfono el mismo cajón es la hoja de abajo, una columna.
  await page.setViewportSize({ width: 390, height: 844 })
  await row.getByRole("button", { name: "Editar" }).click()
  await expect(page.getByRole("heading", { name: "Editar plan" })).toBeVisible()
  await shot("cajon-telefono")
})
