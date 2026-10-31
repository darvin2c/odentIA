import { tenant } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

test("consentimientos: nacen activos; se leen, se cambian sobre la hoja, se ve el PDF y se apagan", async ({ owner }, info) => {
  const { page, org } = owner
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await gotoHydrated(page, tenant(org.slug, "/settings/forms"))
  await expect(page.getByRole("heading", { level: 1, name: "Consentimientos" })).toBeVisible()

  // La clínica nació con lo sugerido activo: no hay pantalla vacía ni nada que publicar.
  const row = page.getByRole("listitem").filter({ hasText: "Exodoncia simple o quirúrgica" })
  await expect(row.getByText("Sin revisar")).toBeVisible()
  await expect(page.getByRole("switch", { name: /activo$/ })).toHaveCount(10)
  await expect(page.getByText("0 de 10 revisados", { exact: false })).toBeVisible()
  await shot("lista")

  // La vista previa desde la fila: el PDF real, y lo que lee el paciente.
  await row.getByRole("button", { name: "Vista previa de Exodoncia simple o quirúrgica" }).click()
  await expect(page.getByTitle("Hoja de Exodoncia simple o quirúrgica")).toHaveAttribute("src", /^blob:/)
  await shot("vista-previa-pdf")
  await page.getByRole("tab", { name: "En el teléfono del paciente" }).click()
  await expect(page.getByText("Qué te van a hacer")).toBeVisible()
  await shot("vista-previa-telefono")
  await page.getByRole("button", { name: "Cerrar" }).click()
  await expect(page.getByText("Qué te van a hacer")).toBeHidden()

  // Editar es tocar el texto sobre la hoja; Enter agrega otra línea.
  await row.getByRole("button", { name: "Editar Exodoncia simple o quirúrgica" }).click()
  const sheet = page.getByRole("article", { name: "Hoja del consentimiento" })
  const lastRisk = sheet.getByRole("textbox", { name: "Riesgos y molestias, línea 4" })
  await expect(lastRisk).toBeVisible()
  await shot("hoja")
  await lastRisk.click()
  await lastRisk.press("Enter")
  const newRisk = sheet.getByRole("textbox", { name: "Riesgos y molestias, línea 5" })
  await expect(newRisk).toBeFocused()
  await newRisk.fill("Riesgo propio de mi clínica")
  await expect(page.getByText("Cambios sin guardar")).toBeVisible()
  await shot("hoja-editando")

  // Salir con cambios pregunta; un campo vacío se dice en su lugar, sin perder lo escrito.
  await page.getByRole("button", { name: "Consentimientos", exact: true }).click()
  await page.getByRole("button", { name: "Continuar editando" }).click()
  const procedure = sheet.getByRole("textbox", { name: "Procedimiento propuesto" })
  const before = await procedure.inputValue()
  await procedure.fill("")
  await page.getByRole("button", { name: "Guardar cambios" }).click()
  await expect(sheet.getByText("Describe el procedimiento (al menos 10 caracteres)")).toBeVisible()
  await expect(newRisk).toHaveValue("Riesgo propio de mi clínica")
  await procedure.fill(before)
  await page.getByRole("button", { name: "Guardar cambios" }).click()

  // Queda en uso y revisado, sin borrador ni publicar aparte.
  await expect(page).toHaveURL(/\/settings\/forms$/)
  await expect(row.getByText("Revisado", { exact: true })).toBeVisible()
  await row.getByRole("button", { name: "Editar Exodoncia simple o quirúrgica" }).click()
  await expect(sheet.getByRole("textbox", { name: "Riesgos y molestias, línea 5" })).toHaveValue("Riesgo propio de mi clínica")
  await expect(page.getByText("Versión 2.", { exact: false })).toBeVisible()
  await page.getByRole("button", { name: "Consentimientos", exact: true }).click()

  // Apagar confirma la consecuencia; encender no pregunta.
  const implant = page.getByRole("listitem").filter({ hasText: "Implante dental" })
  await implant.getByRole("switch").click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Apagar" }).click()
  await expect(implant.getByText("Apagado", { exact: true })).toBeVisible()
  await implant.getByRole("switch").click()
  await expect(implant.getByText("Activo", { exact: true })).toBeVisible()

  // Los formularios propios quedan a un enlace, no como pestaña.
  await expect(page.getByRole("tab", { name: "Formularios clínicos" })).toHaveCount(0)
  await page.getByRole("link", { name: "Crear un formulario" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Formularios propios" })).toBeVisible()

  // En el teléfono se edita igual, sin que la hoja se salga de la pantalla.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/settings/forms?consentimiento=implante"))
  await expect(sheet).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await shot("hoja-telefono")
})
