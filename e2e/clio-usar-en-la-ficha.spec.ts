import type { Page } from "@playwright/test"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

/**
 * Prueba con voz del 15 nov: lo que Clío no propuso para la ficha queda en «No lo usé»
 * con «Parece de «Percusión»», y «Usar en Percusión» lleva la frase a su pregunta en un toque. Con
 * el modelo de demostración Clío no responde fichas: el aviso sale de la red del servidor. No
 * acredita cómo oye un navegador ni lo que respondería un proveedor real.
 */
test("«No lo usé»: «Usar en Percusión» abre la pregunta con lo dictado al lado y no llena nada", async ({ owner }, info) => {
  const { page, org, user } = owner
  await call(page, "PUT", "/api/agent/config", org.slug, { clinicalAssistantEnabled: true })
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Rosa Mendoza", docType: "DNI", docNumber: "45678123" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  const encounter = await call<{ id: string }>(page, "POST", `/api/patients/${patient.id}/encounters`, org.slug, { reason: "Dolor" }, 201)
  // La clínica nace con las fichas del producto: se empieza la de endodoncia en esta atención.
  const templates = await call<Array<{ id: string; title: string }>>(page, "GET", "/api/clinical-forms/form-templates?status=publicado", org.slug)
  const endo = templates.find((template) => template.title === "Evaluación de endodoncia")
  expect(endo, "la ficha de endodoncia del producto").toBeTruthy()
  await call(page, "POST", "/api/clinical-forms/form-responses", org.slug, {
    templateId: endo?.id, patientId: patient.id, encounterId: encounter.id, professionalUserId: user.id, answers: {},
  }, 201)

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  await page.getByRole("button", { name: "¿Qué puedo decir?", exact: true }).click()
  await page.getByRole("button", { name: "Escribir en vez de dictar" }).click()
  const bar = page.getByRole("region", { name: "Dictado de la atención" })
  await bar.getByLabel("Escribe lo dictado").fill("Ya, dolor a la percusión.")
  await bar.getByRole("button", { name: "Ordenar lo dictado" }).click()

  const notice = page.getByRole("status").filter({ hasText: "No lo usé" })
  await expect(notice).toContainText("Parece de «Percusión»: revísala en la ficha.")
  const use = notice.getByRole("button", { name: "Usar «Ya, dolor a la percusión.» en «Percusión»" })
  await expect(use).toHaveText("Usar en Percusión")
  await info.attach("no-pude-usar-esto", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Con el teclado: abre la ficha en esa pregunta, con lo dictado al lado y el foco en ella.
  await use.focus()
  await page.keyboard.press("Enter")
  const said = page.getByText("«Ya, dolor a la percusión.». Elige o escribe la respuesta.")
  await expect(said).toBeVisible()
  const question = page.locator('[data-field="percusion"]')
  await expect(question).toContainText("Dictaste:")
  const select = question.getByRole("combobox")
  await expect(select).toBeFocused()
  // No llena nada: la pregunta sigue vacía hasta que la persona la elige.
  await expect(select).not.toContainText("Positiva")
  await expect(select).not.toContainText("Negativa")
  await info.attach("usar-en-percusion", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await select.click()
  await page.getByRole("option", { name: "Positiva" }).click()
  // Respondida, lo dictado ya no hace falta al lado.
  await expect(said).toHaveCount(0)
  await expect(page.getByText("Guardado", { exact: true })).toBeVisible()

  // Teléfono: el aviso y su botón caben, sin desbordar la página.
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(use).toBeVisible()
  expect((await use.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("no-pude-usar-esto-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  // En el teléfono la ficha sube como cajón y el foco va a la misma pregunta, ya con lo que se eligió.
  await use.click()
  await expect(select).toBeFocused()
  await expect(select).toContainText("Positiva")
  await info.attach("usar-en-percusion-movil", { body: await page.screenshot(), contentType: "image/png" })
})
