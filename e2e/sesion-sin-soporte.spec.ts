import { tenant, tenantPattern } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Lo comprobado al entrar a la clínica vale dos minutos; después, la siguiente navegación
 * vuelve a preguntar, también por la sesión de soporte de odentIA (ADR 0184). El equipo de la
 * clínica nunca la tuvo: sigue en su clínica, sin «El acceso terminó», que es solo de soporte.
 */
test("el equipo de la clínica sigue en ella al navegar pasados los dos minutos", async ({ owner }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const menu = page.getByRole("navigation", { name: "Principal" })
  await expect(menu.getByRole("link", { name: "Pacientes", exact: true })).toBeVisible()

  // Sin esperar dos minutos de verdad: el reloj de esta página se adelanta tres.
  await page.evaluate(() => {
    const now = Date.now.bind(Date)
    Date.now = () => now() + 3 * 60_000
  })

  // La pregunta por la sesión de soporte sale otra vez, y responde sin error y sin datos.
  const asked = page.waitForResponse((response) => response.url().endsWith("/api/support-session/me"))
  await menu.getByRole("link", { name: "Pacientes", exact: true }).click()
  const answer = await asked
  expect(answer.status()).toBe(200)
  expect(await answer.json()).toEqual({ data: null })

  await expect(page).toHaveURL(tenantPattern(org.slug, "/people"))
  await expect(page.getByRole("heading", { level: 1, name: "Pacientes" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "El acceso terminó" })).toHaveCount(0)

  // Y en cada navegación siguiente, igual.
  await menu.getByRole("link", { name: "Inicio", exact: true }).click()
  await expect(page).toHaveURL(tenantPattern(org.slug, "/home"))
  await expect(page.getByRole("heading", { name: "El acceso terminó" })).toHaveCount(0)
})
