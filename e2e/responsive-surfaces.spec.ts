import type { Browser, Page } from "@playwright/test"
import { tenant, tenantPattern } from "./env"
import { expect, type OwnerFixture, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

const SETTINGS_SECTIONS = [
  "Organización",
  "Sucursales",
  "Equipo y permisos",
  "Servicios y tarifas",
  "Disponibilidad",
  "Especialidades",
  "Formularios y consentimientos",
  "Canales",
  "Chat web",
  "Correo",
  "Agente",
  "Pipelines",
  "Campos",
  "Registro de pacientes",
  "Acceso de pacientes",
  "Auditoría",
]

async function withTouchPage(
  browser: Browser,
  owner: OwnerFixture,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    storageState: await owner.context.storageState(),
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: true,
  })
  try {
    await run(await context.newPage())
  } finally {
    await context.close()
  }
}

test("móvil: el alta de paciente mantiene las acciones operables", async ({ owner, browser }) => {
  await withTouchPage(browser, owner, async (page) => {
    await gotoHydrated(page, tenant(owner.org.slug, "/patients"))

    await page.getByRole("button", { name: "Nuevo paciente", exact: true }).tap()
    const dialog = page.getByRole("dialog", { name: "Nuevo paciente" })
    await expect(dialog).toBeVisible()

    await dialog.getByLabel("Nombre del paciente").fill("Paciente móvil")
    const next = dialog.getByRole("button", { name: "Siguiente", exact: true })
    await expect(next).toBeInViewport()
    await next.tap()
    await expect(dialog.getByRole("button", { name: "Anterior", exact: true })).toBeVisible()

    await dialog.getByRole("button", { name: "Anterior", exact: true }).tap()
    await next.focus()
    await next.press("Enter")
    await expect(dialog.getByRole("button", { name: "Anterior", exact: true })).toBeVisible()

    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog: (() => {
        const element = document.querySelector<HTMLElement>("[data-slot='drawer-popup']")
        return element ? element.scrollWidth - element.clientWidth : -1
      })(),
    }))
    expect(overflow.document).toBeLessThanOrEqual(0)
    expect(overflow.dialog).toBeLessThanOrEqual(0)
  })
})

test("móvil: Configuración mantiene dieciséis destinos legibles y navegables", async ({
  owner,
  browser,
}) => {
  await withTouchPage(browser, owner, async (page) => {
    await gotoHydrated(page, tenant(owner.org.slug, "/settings/audit"))

    const nav = page.getByRole("navigation", { name: "Configuración" })
    const picker = nav.getByRole("button", { name: /^Auditoría/ })
    await expect(picker).toBeVisible()
    await picker.tap()

    const links = nav.getByRole("link")
    await expect(links).toHaveCount(SETTINGS_SECTIONS.length)
    await expect(links).toHaveText(SETTINGS_SECTIONS)
    const active = nav.getByRole("link", { name: "Auditoría", exact: true })
    const sectionList = nav.getByRole("list")
    for (const width of [360, 390, 768]) {
      await page.setViewportSize({ width, height: 844 })
      const targets = await links.evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect()
          return { width: rect.width, height: rect.height }
        }),
      )
      expect(targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true)

      const scroll = await sectionList.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight)
      expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0)
      await expect(picker).toBeInViewport()
    }

    await expect(active).toHaveAttribute("aria-current", "page")

    const agent = nav.getByRole("link", { name: "Agente", exact: true })
    await agent.focus()
    await agent.press("Enter")
    await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/settings/agent"))
    await expect(nav.getByRole("button", { name: /^Agente/ })).toBeInViewport()

    await page.setViewportSize({ width: 1024, height: 844 })
    await expect(nav).toBeVisible()
    await expect(agent).toHaveAttribute("aria-current", "page")
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0)
  })
})
