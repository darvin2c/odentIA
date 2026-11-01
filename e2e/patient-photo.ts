import type { Locator, Page } from "@playwright/test"
import { expect } from "./fixtures"
import { waitForHydration } from "./hydration"
import { surface } from "./surface"

/** Una imagen de verdad, dibujada por el navegador: el encuadre la decodifica antes de subirla. */
async function portrait(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 400
    canvas.height = 400
    const context = canvas.getContext("2d")
    if (!context) throw new Error("sin canvas")
    context.fillStyle = "#0e7490"
    context.fillRect(0, 0, 400, 400)
    return canvas.toDataURL("image/png")
  })
  return Buffer.from(url.split(",")[1] ?? "", "base64")
}

/** Elige la imagen y espera «Así se verá»: hasta ahí el recorte no le llegó al formulario. */
async function frame(drawer: Locator, buffer: Buffer): Promise<void> {
  await drawer
    .locator('input[type="file"]')
    .setInputFiles({ name: "retrato.png", mimeType: "image/png", buffer })
  await expect(drawer.locator('img[src^="data:image/png"]').first()).toBeVisible()
}

/**
 * Desde la página de la persona: sin foto no hay nada que quitar; con foto,
 * «Quitar foto» no se ofrece mientras se encuadra otra, la retira sin recargar
 * y sigue retirada al volver a entrar.
 */
export async function putAndRemovePhoto(page: Page, name: string, initials: string): Promise<void> {
  const change = page.getByRole("button", { name: `Cambiar foto de ${name}` })
  const drawer = surface(page, { name: "Foto del paciente" })
  const remove = drawer.getByRole("button", { name: "Quitar foto" })
  const image = await portrait(page)

  await change.click()
  await expect(drawer).toBeVisible()
  await expect(remove).toHaveCount(0)
  await frame(drawer, image)
  await drawer.getByRole("button", { name: "Guardar" }).click()
  await expect(drawer).toBeHidden()
  await expect(change.locator("img")).toBeVisible()

  await change.click()
  await expect(remove).toBeVisible()
  await frame(drawer, image)
  await expect(remove).toHaveCount(0)
  await drawer.getByRole("button", { name: "Volver a elegir" }).click()
  await remove.click()
  await expect(drawer).toBeHidden()
  await expect(change.locator("img")).toHaveCount(0)
  await expect(change).toContainText(initials)

  await page.reload()
  await waitForHydration(page)
  await expect(change).toContainText(initials)
  await expect(change.locator("img")).toHaveCount(0)
  await change.click()
  await expect(drawer).toBeVisible()
  await expect(remove).toHaveCount(0)
}
