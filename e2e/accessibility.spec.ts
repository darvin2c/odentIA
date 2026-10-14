import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import AxeBuilder from "@axe-core/playwright"
import type { Page, TestInfo } from "@playwright/test"
import { PANEL, tenant, tenantPattern } from "./env"
import { expect, fillPatientNames, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { latestLinkFor } from "./mailpit"
import { surface } from "./surface"

// Axe mide colores computados: un panel a mitad de su animación de entrada
// produce contrastes intermedios que el usuario no ve al terminar.
async function settleAnimations(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    )
  })
}

async function audit(page: Page, info: TestInfo, surface: string) {
  await settleAnimations(page)
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze()
  const axePath = info.outputPath(`${surface}-axe.json`)
  const visualPath = info.outputPath(`${surface}.png`)
  await writeFile(axePath, JSON.stringify(results, null, 2))
  await page.screenshot({ path: visualPath, fullPage: true })
  await info.attach(`${surface}-axe`, {
    path: axePath,
    contentType: "application/json",
  })
  await info.attach(`${surface}-visual`, {
    path: visualPath,
    contentType: "image/png",
  })
  expect
    .soft(
      results.violations.filter(({ impact }) => impact === "critical" || impact === "serious"),
      surface,
    )
    .toEqual([])
  expect
    .soft(
      results.violations.filter(({ id }) => id === "region" || id.startsWith("landmark-")),
      surface,
    )
    .toEqual([])
  await expect(page.locator("main")).toHaveCount(1)
}

async function theme(page: Page, dark: boolean) {
  await page.evaluate((dark) => {
    document.documentElement.classList.toggle("dark", dark)
    document.documentElement.style.colorScheme = dark ? "dark" : "light"
  }, dark)
  await settleAnimations(page)
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  for (const dark of [false, true]) {
    test(`accesibilidad ${viewport.width}px ${dark ? "oscuro" : "claro"}: auth, onboarding y operación`, async ({
      browser,
      owner,
    }, info) => {
      test.setTimeout(300_000)
      const context = await browser.newContext({
        baseURL: PANEL,
        viewport,
        ignoreHTTPSErrors: true,
        colorScheme: dark ? "dark" : "light",
      })
      try {
        const page = await context.newPage()
        await gotoHydrated(page, `${PANEL}/login`)
        await theme(page, dark)
        await audit(page, info, "login")
        await page.getByLabel("Correo").focus()
        await page.keyboard.press("Tab")
        await expect(page.getByLabel("Contraseña")).toBeFocused()
        await page.keyboard.press("Tab")
        await expect(page.getByRole("button", { name: "Ingresar", exact: true })).toBeFocused()
        await page.keyboard.press("Enter")
        await expect(page.getByRole("alert").first()).toBeVisible()
        await audit(page, info, "login-error")

        await gotoHydrated(page, `${PANEL}/register`)
        await theme(page, dark)
        await audit(page, info, "registro")
        await page.getByLabel("Nombre", { exact: true }).focus()
        for (const label of ["Apellidos", "Correo", "Contraseña"]) {
          await page.keyboard.press("Tab")
          await expect(page.getByLabel(label, { exact: true })).toBeFocused()
        }
        const id = randomUUID()
        const email = `a11y-${id}@test.dev`
        await page.getByLabel("Nombre", { exact: true }).fill("Ana")
        await page.getByLabel("Apellidos").fill("Accesibilidad")
        await page.getByLabel("Correo").fill(email)
        await page.getByLabel("Contraseña").fill("secreto-a11y-123")
        await page.getByRole("button", { name: "Registrarme" }).click()
        await expect(page).toHaveURL(/verify-email-sent/)
        await page.goto(await latestLinkFor(email, "Verifica tu correo"))
        await gotoHydrated(page, `${PANEL}/login`)
        await page.getByLabel("Correo").fill(email)
        await page.getByLabel("Contraseña").fill("secreto-a11y-123")
        await page.getByRole("button", { name: "Ingresar", exact: true }).click()
        await expect(page).toHaveURL(/onboarding/)
        await theme(page, dark)
        await audit(page, info, "onboarding-organizacion")
        await page.getByRole("button", { name: "Continuar", exact: true }).click()
        await expect(page.getByRole("alert").first()).toBeVisible()
        await audit(page, info, "onboarding-error")
        await page.getByLabel("Nombre de la organización").fill("Clínica accesible")
        await page.getByLabel("Slug (subdominio)").fill(`a11y-${id}`)
        await page.getByRole("button", { name: "Continuar", exact: true }).click()
        await audit(page, info, "onboarding-fiscal")
        await page.getByLabel("Razón social").fill("Clínica accesible SAC")
        await page.getByRole("button", { name: "Continuar", exact: true }).click()
        await audit(page, info, "onboarding-sucursal")
        const zones = page.getByRole("button", { name: "Mostrar zonas horarias", exact: true })
        await zones.focus()
        await page.keyboard.press("Enter")
        await expect(page.getByRole("listbox")).toBeVisible()
        await audit(page, info, "onboarding-zonas")
        await page.keyboard.press("Escape")
        await expect(page.getByRole("listbox")).not.toBeVisible()
        await expect(zones).toBeFocused()
      } finally {
        await context.close()
      }

      const page = owner.page
      await page.setViewportSize(viewport)
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      // El siguiente paso es un botón que navega (`Button` con `render={<Link />}`): se localiza por su rol real.
      await expect(page.getByRole("region", { name: "Siguiente paso" }).getByRole("button").first()).toBeVisible()
      await theme(page, dark)
      await audit(page, info, "inicio")
      if (viewport.width < 768) {
        const menu = page.getByRole("button", { name: /Abrir.*menú|Alternar menú lateral/ })
        await menu.focus()
        await page.keyboard.press("Enter")
        await expect(page.getByRole("dialog", { name: "Menú de navegación" })).toBeVisible()
        await expect(
          page.getByRole("dialog").getByRole("link", { name: "Inicio", exact: true }),
        ).toBeFocused()
        await audit(page, info, "inicio-menu")
        await page.keyboard.press("Escape")
        await expect(page.getByRole("dialog")).not.toBeVisible()
        await expect(menu).toBeFocused()
      }
      await gotoHydrated(page, tenant(owner.org.slug, "/settings"))
      await theme(page, dark)
      await expect(page.getByLabel("Razón social")).toBeVisible()
      await audit(page, info, "configuracion")
      const zones = page.getByRole("button", { name: "Mostrar zonas horarias", exact: true })
      await zones.focus()
      await page.keyboard.press("Enter")
      await expect(page.getByRole("listbox")).toBeVisible()
      await audit(page, info, "configuracion-zonas")
      await page.keyboard.press("Escape")
      await expect(page.getByRole("listbox")).not.toBeVisible()
      await expect(zones).toBeFocused()

      // Integraciones: la lista por filas y el panel de un canal, con teclado.
      await gotoHydrated(page, tenant(owner.org.slug, "/settings/integrations"))
      await theme(page, dark)
      await expect(page.getByRole("region", { name: "Mensajería" }).getByRole("listitem")).toHaveCount(4)
      await expect(page.getByRole("region", { name: "Inteligencia artificial" }).getByRole("listitem")).toHaveCount(1)
      await audit(page, info, "integraciones")
      const connectTelegram = page.getByRole("button", { name: "Conectar Telegram", exact: true })
      await connectTelegram.focus()
      await page.keyboard.press("Enter")
      const telegram = surface(page, { name: "Conectar Telegram", exact: true })
      await expect(telegram.getByLabel("Clave del bot", { exact: true })).toBeVisible()
      await audit(page, info, "integraciones-telegram")
      await telegram.getByRole("button", { name: "Cancelar", exact: true }).click()
      await expect(telegram).toBeHidden()

      await gotoHydrated(page, tenant(owner.org.slug, "/patients"))
      await theme(page, dark)
      const create = page.getByRole("button", { name: "Nuevo paciente", exact: true })
      await create.focus()
      await page.keyboard.press("Enter")
      const dialog = page.getByRole(viewport.width >= 1280 ? "region" : "dialog", {
        name: "Nuevo paciente",
        exact: true,
      })
      await expect(dialog).toBeVisible()
      await audit(page, info, "alta-paciente")
      if (viewport.width >= 1280) {
        const separator = page.getByRole("separator", { name: "Redimensionar panel", exact: true })
        const beforeValue = Number(await separator.getAttribute("aria-valuenow"))
        // El formulario va en la columna lateral del layout, a todo el alto.
        const column = page.getByRole("complementary", { name: "Panel lateral", exact: true })
        const beforeWidth = await column.evaluate(
          (element) => element.getBoundingClientRect().width,
        )
        expect(await column.evaluate((element) => element.getBoundingClientRect().height)).toBe(
          viewport.height,
        )
        await separator.focus()
        await separator.press("ArrowRight")
        await expect
          .poll(() => column.evaluate((element) => element.getBoundingClientRect().width))
          .toBeLessThan(beforeWidth)
        await expect
          .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
          .toBeLessThan(beforeValue)
        await separator.press("Escape")
        await expect(dialog).not.toBeVisible()
        await expect(create).toBeFocused()
        await create.press("Enter")
        await expect(dialog).toBeVisible()
      }
      await dialog.getByRole("button", { name: "Siguiente", exact: true }).click()
      await expect(dialog.getByRole("alert").first()).toBeVisible()
      await audit(page, info, "alta-paciente-error")
      await fillPatientNames(dialog, "Paciente accesible")
      await dialog.getByRole("button", { name: "Siguiente", exact: true }).click()
      await audit(page, info, "alta-paciente-contacto")
      for (const surface of ["salud", "salud-dental", "revision"]) {
        await dialog.getByRole("button", { name: "Siguiente", exact: true }).click()
        await audit(page, info, `alta-paciente-${surface}`)
      }
      // El guard usa confirmación nativa; aceptar permite comprobar el retorno.
      page.once("dialog", (confirmation) => confirmation.accept())
      await page.keyboard.press("Escape")
      await expect(dialog).not.toBeVisible()
      await expect(create).toBeFocused()
      await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/patients"))
    })
  }
}
