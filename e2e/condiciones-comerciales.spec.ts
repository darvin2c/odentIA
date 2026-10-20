import { randomUUID } from "node:crypto"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { session } from "@odentia/db/schema/auth"
import { saasCommercialTerms } from "@odentia/db/schema/saas-billing"
import { desc, eq } from "drizzle-orm"
import { hostUrl } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Condiciones comerciales (issue 167, ADR 0074): en Cobros y planes se leen en
 * frases, se cambian por grupo con sus límites y su «desde cuándo rige», y
 * «Ver cambios» dice quién cambió qué. Cambia los meses de comisión, que ningún
 * otro recorrido usa, y al terminar deja una versión con los de antes.
 */
test("condiciones comerciales: se leen en frases, se cambian por grupo y quedan en «Ver cambios»", async ({ owner, fixtureDb }, testInfo) => {
  test.setTimeout(120_000)
  const { page, user } = owner
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const now = Date.now()

  // La misma persona, como personal de odentIA con su segundo factor verificado en esta sesión.
  const [current] = await fixtureDb.select({ id: session.id }).from(session).where(eq(session.userId, user.id)).orderBy(desc(session.createdAt)).limit(1)
  const factorId = randomUUID()
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  await fixtureDb.insert(twoFactor).values({ id: factorId, userId: user.id, secret: "e2e", backupCodes: "[]", verified: true })
  await fixtureDb.insert(adminSessionVerification).values({ userId: user.id, sessionId: current!.id, factorId, method: "totp", expiresAt: new Date(now + 86_400_000) })
  const [before] = await fixtureDb.select().from(saasCommercialTerms).orderBy(desc(saasCommercialTerms.effectiveFrom)).limit(1)

  try {
    await gotoHydrated(page, hostUrl("admin", "/billing"))
    const section = page.getByRole("region", { name: "Condiciones comerciales" })
    await expect(section.getByRole("heading", { name: "Pagos" })).toBeVisible()
    await expect(section).toContainText(`Una conversación por persona cada ${before!.conversationWindowHours} horas`)
    await expect(section).toContainText(`durante los primeros ${before!.commissionMonths} meses de la clínica`)
    await section.scrollIntoViewIfNeeded()
    await shot("seccion")

    // Un valor fuera de lo que admite se dice junto al campo y no se guarda.
    await section.getByRole("button", { name: "Cambiar: Prueba y avisos del tope" }).click()
    const warn = page.getByRole("textbox", { name: "Avisar al usar" })
    await warn.fill(String(before!.alarmPercent + 2))
    await expect(page.getByText(`El aviso va antes que la alarma: escribe menos de ${before!.alarmPercent} %.`)).toBeVisible()
    await shot("error-junto-al-campo")
    await page.getByRole("button", { name: "Guardar" }).click()
    // Sigue abierto, con el error a la vista.
    await expect(warn).toBeVisible()
    await expect(page.getByText(`El aviso va antes que la alarma: escribe menos de ${before!.alarmPercent} %.`)).toBeVisible()
    await warn.fill(String(before!.warnPercent))
    await page.getByRole("button", { name: "Cancelar" }).click()

    // Cambiar un grupo: la cifra de antes y desde cuándo rige, antes de guardar.
    await section.getByRole("button", { name: "Cambiar: Invitaciones y vendedores" }).click()
    const months = page.getByRole("textbox", { name: "El vendedor cobra comisión durante los primeros" })
    await months.fill("18")
    await expect(page.getByText(`antes ${before!.commissionMonths}`)).toBeVisible()
    await expect(page.getByText("Para las clínicas que entren desde ahora.")).toBeVisible()
    await page.getByRole("textbox", { name: "Por qué lo cambias (opcional)" }).fill("Prueba de e2e")
    await shot("cajon")
    await page.getByRole("button", { name: "Guardar" }).click()
    await expect(page.getByText("Condiciones guardadas")).toBeVisible()
    await expect(section).toContainText("durante los primeros 18 meses de la clínica")
    await expect(section).toContainText("Último cambio:")

    // «Ver cambios»: quién, antes y después, y el motivo.
    await section.getByRole("button", { name: "Ver cambios" }).click()
    // Se abre en la columna de al lado o en el cajón, según el ancho.
    await expect(page.getByRole("heading", { name: "Cambios en las condiciones" })).toBeVisible()
    // La fila del cambio (los valores iniciales también nombran la regla, sin «:»).
    const history = page.locator("li").filter({ hasText: "Meses de comisión del vendedor:" })
    await expect(history).toContainText(`Meses de comisión del vendedor: ${before!.commissionMonths} meses → 18 meses`)
    await expect(history).toContainText("«Prueba de e2e»")
    await expect(page.getByText("Valores iniciales · los que estaban en el código")).toBeVisible()
    await shot("ver-cambios")
    await page.keyboard.press("Escape")

    // En el teléfono, los grupos van uno debajo del otro y nada se sale de la pantalla.
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoHydrated(page, hostUrl("admin", "/billing"))
    await page.getByRole("region", { name: "Condiciones comerciales" }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await shot("telefono")
  } finally {
    // Las condiciones son de toda la plataforma: se deja una versión con las de antes.
    const { id: _id, effectiveFrom: _from, createdAt: _at, createdBy: _by, reason: _reason, ...values } = before!
    await fixtureDb.insert(saasCommercialTerms).values({ ...values, effectiveFrom: new Date() })
  }
})
