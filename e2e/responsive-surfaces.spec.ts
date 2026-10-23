import type { Browser, Page } from "@playwright/test"
import { tenant, tenantPattern } from "./env"
import { call, expect, type OwnerFixture, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/** La lista de Configuración: cuatro grupos con nombre y dos entradas sueltas al final. */
const SETTINGS_GROUPS: Array<[string, string[]]> = [
  ["La clínica", ["Datos de la clínica", "Sedes", "Equipo", "Horarios y ausencias", "Protección de datos"]],
  ["Atención", ["Especialidades", "Formularios y consentimientos"]],
  ["Pacientes", ["Registro de pacientes", "Portal del paciente"]],
  ["Ventas y cobros", ["Medios de pago y ticket", "Etapas de venta", "Campos de contacto"]],
  // Solo para quien ve Facturación (ADR 0065); la dueña la ve.
  ["Tu cuenta odentIA", ["Plan y pagos"]],
]
const SETTINGS_LOOSE = ["Integraciones", "Actividad del equipo"]
const SETTINGS_SECTIONS = [...SETTINGS_GROUPS.flatMap(([, items]) => items), ...SETTINGS_LOOSE]

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
    // El alta se hace en la página de la persona: «Registrar» trae lo que ya se sabe (ADR 0029).
    // La página táctil aún está en blanco (sin origen): la API se llama desde la sesión del propietario.
    const person = await call<{ id: string }>(owner.page, "POST", "/api/people", owner.org.slug, {
      givenNames: "Paciente",
      familyName: "Móvil",
    }, 201)
    await gotoHydrated(page, tenant(owner.org.slug, `/people/${person.id}`))

    await page.getByRole("button", { name: "Registrar", exact: true }).tap()
    // Registrar es una sola ventana (sin pasos) que trae lo que ya se sabe.
    const dialog = surface(page, { name: "Registrar a Paciente Móvil" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel("Apellidos")).toHaveValue("Móvil")

    // Elegir quién completa sus datos se toca con el dedo; el botón de registrar sigue a la vista.
    await dialog.getByRole("button", { name: "Yo, ahora", exact: true }).tap()
    await expect(dialog.getByRole("button", { name: "Yo, ahora", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(dialog.getByRole("button", { name: "Registrar", exact: true })).toBeInViewport()
    await expect(dialog.getByRole("button", { name: "Cancelar", exact: true })).toBeInViewport()

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

test("móvil: Configuración muestra sus apartados por grupos, legibles y navegables", async ({
  owner,
  browser,
}) => {
  await withTouchPage(browser, owner, async (page) => {
    await gotoHydrated(page, tenant(owner.org.slug, "/settings/audit"))

    const nav = page.getByRole("navigation", { name: "Configuración" })
    const picker = nav.getByRole("button", { name: /^Actividad del equipo/ })
    await expect(picker).toBeVisible()
    await picker.tap()

    const links = nav.getByRole("link")
    await expect(links).toHaveText(SETTINGS_SECTIONS)
    for (const [group, items] of SETTINGS_GROUPS) {
      await expect(nav.getByRole("group", { name: group, exact: true }).getByRole("link")).toHaveText(items)
    }
    // Las entradas sueltas no pertenecen a ningún grupo.
    for (const loose of SETTINGS_LOOSE) {
      await expect(nav.getByRole("group").getByRole("link", { name: loose, exact: true })).toHaveCount(0)
    }
    const active = nav.getByRole("link", { name: "Actividad del equipo", exact: true })
    const sectionList = page.locator(`[id="${await picker.getAttribute("aria-controls")}"]`)
    for (const size of [
      { width: 360, height: 844 },
      { width: 390, height: 844 },
      { width: 768, height: 844 },
      // Pantalla baja: la lista no cabe entera.
      { width: 390, height: 560 },
    ]) {
      await page.setViewportSize(size)
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
      // Si no cabe, se desplaza por dentro: nunca a lo ancho ni moviendo el documento.
      if (size.height < 700) expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight)
      expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0)
      await expect(picker).toBeInViewport()
      // La última entrada siempre se alcanza.
      await active.scrollIntoViewIfNeeded()
      await expect(active).toBeInViewport()
    }

    await expect(active).toHaveAttribute("aria-current", "page")

    await page.setViewportSize({ width: 390, height: 844 })
    const integrations = nav.getByRole("link", { name: "Integraciones", exact: true })
    await integrations.focus()
    await integrations.press("Enter")
    await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/settings/integrations"))
    await expect(nav.getByRole("button", { name: /^Integraciones/ })).toBeInViewport()

    await page.setViewportSize({ width: 1024, height: 844 })
    await expect(nav).toBeVisible()
    await expect(integrations).toHaveAttribute("aria-current", "page")
    // En el riel, una línea separa las entradas sueltas de los grupos.
    await expect(nav.getByRole("separator")).toBeVisible()
    // Bajo 1280 px el menú lateral queda en íconos: la cabecera cabe junto al riel (issue 220).
    await expect(page.locator("[data-slot=sidebar][data-state]").first()).toHaveAttribute("data-state", "collapsed")
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0)
  })
})
