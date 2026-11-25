import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/**
 * Mesa del 25 nov («salud y familia», entrega 1): recepción registra a Camila, de 5 años, que llega
 * con su abuela; ninguna estaba registrada. La abuela se escribe en el mismo cajón, nace con la niña,
 * le llegan sus avisos y la privacidad queda a su nombre. Como «Otro familiar», la acompaña sin
 * representarla. Antes había que salir a «Nuevo contacto» y lo escrito se perdía.
 */
test("un menor con su responsable nuevo se registra en el mismo cajón, y lo escrito no se pierde al salir", async ({ owner }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/people"))
  await page.locator("header").getByRole("button", { name: "Nuevo paciente", exact: true }).click()
  const form = surface(page, { name: "Nuevo paciente", exact: true })
  await expect(form).toBeVisible()
  await form.getByLabel("Nombres", { exact: true }).fill("Camila")
  await form.getByLabel("Apellidos", { exact: true }).fill("Quispe Rojas")
  await form.getByRole("button", { name: "Yo, ahora", exact: true }).click()
  await form.getByLabel("Fecha de nacimiento", { exact: true }).pressSequentially("12/03/2021")
  await expect(form.getByText("Es menor de edad. ¿Quién viene con él o ella?", { exact: true })).toBeVisible()

  // La abuela no está: se escribe aquí mismo.
  await form.getByRole("button", { name: "No está: registrarla aquí", exact: true }).click()
  await form.getByLabel("Sus nombres", { exact: true }).fill("Rosa")
  await form.getByLabel("Sus apellidos", { exact: true }).fill("Quispe Vega")

  // Sonó el teléfono: se cierra sin preguntar, y al volver sigue lo escrito.
  await page.keyboard.press("Escape")
  await expect(page.getByRole("alertdialog", { name: "¿Salir sin guardar?" })).toHaveCount(0)
  await expect(form).toBeHidden()
  await page.locator("header").getByRole("button", { name: "Nuevo paciente", exact: true }).click()
  await expect(form).toBeVisible()
  await expect(form.getByText("Seguías con Camila Quispe Rojas.", { exact: true })).toBeVisible()
  await expect(form.getByLabel("Sus nombres", { exact: true })).toHaveValue("Rosa")

  await form.getByLabel("Su celular", { exact: true }).fill("977555810")
  await form.getByRole("button", { name: "Otro familiar", exact: true }).click()
  await form.getByLabel("¿Qué es de Camila? (opcional)", { exact: true }).fill("abuela")
  await form.getByText(/^Le informé a Rosa cómo usamos los datos de Camila/).click()
  await form.getByRole("button", { name: "Sí, aceptó", exact: true }).click()
  await form.getByRole("button", { name: "Registrar a Camila", exact: true }).click()
  await expect(page.getByText("Camila Quispe Rojas ya es paciente", { exact: true }).first()).toBeVisible()

  // En el servidor: Rosa existe con sus nombres, le llegan los avisos y la acompaña sin representarla.
  const people = await call<Array<{ id: string; displayName: string; patient: { id: string } | null }>>(
    page,
    "GET",
    "/api/people?ver=todos&limit=10&q=Camila%20Quispe",
    org.slug,
  )
  const camila = people.find((row) => row.displayName === "Camila Quispe Rojas")
  expect(camila?.patient?.id).toBeTruthy()
  const detail = await call<{ contacts: Array<{ relationship: string; relationshipDetail: string | null; isPreferred: boolean; displayName?: string }> }>(
    page,
    "GET",
    `/api/patients/${camila!.patient!.id}`,
    org.slug,
  )
  expect(detail.contacts).toEqual(
    expect.arrayContaining([expect.objectContaining({ relationship: "family", relationshipDetail: "abuela", isPreferred: true })]),
  )
  const consents = await call<Array<{ grantedByName: string }>>(page, "GET", `/api/patients/${camila!.patient!.id}/data-consents`, org.slug)
  expect(consents[0]?.grantedByName).toBe("Rosa Quispe Vega")
})
