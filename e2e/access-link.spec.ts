import type { Page } from "@playwright/test"
import { PANEL, panelPattern } from "./env"
import { api, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { latestLinkFor } from "./mailpit"

const NEW_PASSWORD = "una-clave-nueva-larga"

async function shot(page: Page, path: string): Promise<void> {
  // La escena 3D sigue moviéndose: se espera a que el formulario esté quieto, no la escena.
  await page.waitForTimeout(400)
  await page.screenshot({ path, fullPage: true })
}

for (const viewport of [
  { name: "computadora", width: 1440, height: 900 },
  { name: "celular", width: 390, height: 844 },
]) {
  test(`acceso ${viewport.name}: recuperar con un enlace que deja adentro`, async ({
    browser,
    createOwner,
  }, info) => {
    test.setTimeout(180_000)
    const owner = await createOwner(`enlace-${viewport.width}`)
    const context = await browser.newContext({
      baseURL: PANEL,
      viewport: { width: viewport.width, height: viewport.height },
      ignoreHTTPSErrors: true,
    })
    try {
      const page = await context.newPage()
      await gotoHydrated(page, `${PANEL}/login`)
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        /Buen(os|as) (días|tardes|noches)\./,
      )
      await shot(page, info.outputPath("1-entrar.png"))

      // Contraseña equivocada: el error queda junto al campo y ofrece recuperarla.
      await page.getByLabel("Correo").fill(owner.user.email)
      await page.getByLabel("Contraseña").fill("no-es-esta")
      await page.getByRole("button", { name: "Entrar", exact: true }).click()
      await expect(page.getByRole("alert").filter({ hasText: "no coinciden" })).toBeVisible()
      await shot(page, info.outputPath("2-entrar-error.png"))

      await page.getByRole("link", { name: "¿Olvidaste tu contraseña?" }).click()
      await expect(page).toHaveURL(panelPattern("/forgot-password"))
      await expect(page.getByLabel("Correo")).toHaveValue(owner.user.email)
      await shot(page, info.outputPath("3-pedir-enlace.png"))
      await page.getByRole("button", { name: "Enviarme el enlace" }).click()
      await expect(page.getByRole("heading", { name: "Revisa tu correo" })).toBeVisible()
      await expect(page.getByRole("button", { name: /Reenviar en/ })).toBeDisabled()
      await shot(page, info.outputPath("4-revisa-tu-correo.png"))

      const link = await latestLinkFor(owner.user.email, "Tu enlace para entrar a odentIA")
      await page.goto(link)
      await expect(page).toHaveURL(panelPattern("/"))
      const dialog = page.getByRole("dialog", { name: "Crea tu nueva contraseña" })
      await expect(dialog).toBeVisible()
      // No se cierra sin guardar.
      await page.keyboard.press("Escape")
      await expect(dialog).toBeVisible()
      await dialog.getByLabel("Nueva contraseña").fill(NEW_PASSWORD)
      await shot(page, info.outputPath("5-nueva-contrasena.png"))
      await dialog.getByRole("button", { name: "Guardar y seguir" }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByText("Listo. Tu contraseña cambió.")).toBeVisible()
      await shot(page, info.outputPath("6-listo.png"))

      // La sesión que ya estaba abierta en otro equipo quedó cerrada.
      const before = await api<unknown>(owner.page, "GET", "/api/auth/get-session", undefined)
      expect(before.body).toBeNull()

      // El mismo enlace ya no sirve.
      await page.goto(link)
      await expect(page).toHaveURL(panelPattern("/forgot-password?vencido=1"))
      await expect(page.getByRole("heading", { name: "Este enlace ya no sirve" })).toBeVisible()
      await shot(page, info.outputPath("7-enlace-vencido.png"))

      // Entra con la nueva desde otro navegador; la segunda vez la pantalla la reconoce.
      const other = await browser.newContext({
        baseURL: PANEL,
        viewport: { width: viewport.width, height: viewport.height },
        ignoreHTTPSErrors: true,
      })
      try {
        const again = await other.newPage()
        await gotoHydrated(again, `${PANEL}/login`)
        await again.getByLabel("Correo").fill(owner.user.email)
        await again.getByLabel("Contraseña").fill(NEW_PASSWORD)
        await again.getByRole("button", { name: "Entrar", exact: true }).click()
        await expect(again).toHaveURL(panelPattern("/"))
        await api(again, "POST", "/api/auth/sign-out", undefined, {})
        await gotoHydrated(again, `${PANEL}/login`)
        await expect(again.getByRole("heading", { level: 1 })).toContainText(
          `, ${owner.user.firstName}.`,
        )
        await expect(again.getByLabel("Correo")).toHaveCount(0)
        await shot(again, info.outputPath("8-entrar-te-reconoce.png"))
        await again.getByRole("button", { name: "¿No eres tú?" }).click()
        await expect(again.getByLabel("Correo")).toBeVisible()

        await gotoHydrated(again, `${PANEL}/register`)
        await expect(again.getByRole("heading", { level: 1 })).toContainText("Crea tu cuenta")
        await shot(again, info.outputPath("9-crear-cuenta.png"))
      } finally {
        await other.close()
      }
    } finally {
      await context.close()
    }
  })
}
