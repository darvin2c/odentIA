import { member } from "@odentia/db/schema/auth"
import { eq } from "drizzle-orm"
import { tenant } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

// Mientras los datos no llegan, cada pantalla muestra su esqueleto, sin error de hidratación
// ni desborde, en los dos anchos, y al llegar los datos el esqueleto se va.
const SCREENS = ["/home", "/agenda", "/inbox", "/tasks", "/pipeline", "/people", "/finance", "/services", "/inventory", "/reports", "/agent", "/settings/team"]

for (const [name, viewport] of [["web", { width: 1440, height: 900 }], ["teléfono", { width: 390, height: 844 }]] as const) {
  test(`esqueletos de carga en ${name}`, async ({ owner }) => {
    const { page, org } = owner
    await page.setViewportSize(viewport)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    for (const path of SCREENS) {
      const gate = Promise.withResolvers<void>()
      const held = async (route: import("@playwright/test").Route) => {
        await gate.promise
        await route.continue().catch(() => undefined)
      }
      const isApi = (url: URL) => url.pathname.startsWith("/api/")
      await page.route(isApi, held)
      await gotoHydrated(page, tenant(org.slug, path))
      await expect(page.locator("[data-slot=skeleton]:visible").first(), path).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${path} desborda`).toBeLessThanOrEqual(0)
      gate.resolve()
      await page.unroute(isApi, held)
      await expect(page.locator("[data-slot=skeleton]:visible"), `${path} sigue cargando`).toHaveCount(0, { timeout: 15_000 })
    }
    expect(errors).toEqual([])
  })
}

// Lo que se ofrece mientras llega la pantalla es lo que esa persona tendrá: caja no ve Comisiones ni un instante.
test("el esqueleto de Finanzas ofrece solo lo del rol", async ({ owner, fixtureDb }) => {
  const { page, org, user } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const [role, commissions] of [["owner", 1], ["cashier", 0]] as const) {
    await fixtureDb.update(member).set({ role }).where(eq(member.userId, user.id))
    await gotoHydrated(page, tenant(org.slug, "/home"))
    const gate = Promise.withResolvers<void>()
    const held = async (route: import("@playwright/test").Route) => {
      await gate.promise
      await route.continue().catch(() => undefined)
    }
    const heldUrls = (url: URL) => url.pathname.startsWith("/api/") || url.pathname.endsWith(".js")
    await page.route(heldUrls, held)
    await page.evaluate(() => {
      history.pushState({}, "", "/finance")
      dispatchEvent(new PopStateEvent("popstate"))
    })
    await expect(page.getByRole("tab", { name: "Caja", exact: true })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Comisiones", exact: true })).toHaveCount(commissions)
    gate.resolve()
    await page.unroute(heldUrls, held)
    await expect(page.locator("[data-slot=skeleton]:visible")).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByRole("tab", { name: "Comisiones", exact: true })).toHaveCount(commissions)
  }
})
