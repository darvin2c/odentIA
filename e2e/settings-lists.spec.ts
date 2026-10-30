import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

type Stage = { id: string; name: string; moment: string }
type Field = { id: string; key: string; label: string; type: string; options: string[] | null }

test("etapas de venta y campos de contacto: se editan al lado, con palabras y sin claves", async ({ owner }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  const stages = async () => (await call<Array<{ stages: Stage[] }>>(page, "GET", "/api/pipelines", org.slug))[0]?.stages ?? []
  const fields = () => call<Field[]>(page, "GET", "/api/fields", org.slug)

  // --- Etapas de venta: cuatro pasos fijos que solo se renombran, cada uno con cuándo llega sola ---
  await gotoHydrated(page, tenant(org.slug, "/settings/pipelines"))
  await expect(page.getByRole("heading", { level: 1, name: "Etapas de venta" })).toBeVisible()
  await expect(page.getByRole("row").filter({ hasText: "Evaluación agendada" })).toContainText("Llega sola cuando la persona agenda una cita")
  // Ni crear, ni eliminar, ni códigos en pantalla.
  await expect(page.getByRole("button", { name: /Nueva etapa/ })).toHaveCount(0)
  await expect(page.getByRole("table")).not.toContainText(/(interesado|evaluacion_agendada|presupuesto_enviado|decidio)/)

  await page.getByRole("button", { name: "Acciones de Interesado", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Eliminar" })).toHaveCount(0)
  await page.getByRole("menuitem", { name: "Cambiar el nombre", exact: true }).click()
  const stageForm = surface(page, { name: "Cambiar el nombre del paso", exact: true })
  const stageName = stageForm.getByLabel("Nombre", { exact: true })
  await expect(stageName).toHaveValue("Interesado")
  await stageName.fill("Pidió precio")
  // Lo escrito no vale hasta pulsar «Guardar».
  expect((await stages()).map((stage) => stage.name)).toContain("Interesado")
  await stageForm.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(stageForm).toBeHidden()
  await expect(page.getByText("Paso «Pidió precio» guardado", { exact: true })).toBeVisible()
  await expect(page.getByRole("row").filter({ hasText: "Pidió precio" })).toBeVisible()
  expect((await stages()).map((stage) => [stage.name, stage.moment])).toEqual([
    ["Pidió precio", "interesado"],
    ["Evaluación agendada", "evaluacion_agendada"],
    ["Presupuesto enviado", "presupuesto_enviado"],
    ["Decidió", "decidio"],
  ])

  // --- Campos de contacto: el vacío trae su botón y solo se escribe el nombre ---
  await gotoHydrated(page, tenant(org.slug, "/settings/fields"))
  await expect(page.getByRole("heading", { level: 1, name: "Campos de contacto" })).toBeVisible()
  await page.getByRole("button", { name: "Agrega el primer campo", exact: true }).click()
  const newField = surface(page, { name: "Nuevo campo", exact: true })
  await expect(newField.getByText(/clave/i)).toHaveCount(0)
  await newField.getByLabel("Nombre", { exact: true }).fill("Cómo nos conoció")
  await newField.getByLabel("Tipo", { exact: true }).click()
  await page.getByRole("option", { name: "Lista de opciones", exact: true }).click()
  await newField.getByLabel("Opciones", { exact: true }).fill("Redes sociales\nRecomendación")
  await newField.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(newField).toBeHidden()
  const row = page.getByRole("row").filter({ hasText: "Cómo nos conoció" })
  await expect(row).toContainText("Lista de opciones")
  await expect(row).toContainText("Redes sociales, Recomendación")
  // La clave la generó el servidor a partir del nombre; en pantalla no aparece.
  const [created] = await fields()
  expect(created).toMatchObject({ key: "como_nos_conocio", label: "Cómo nos conoció", type: "select" })
  await expect(page.getByText("como_nos_conocio")).toHaveCount(0)

  // Un campo se edita: nombre y opciones; el tipo ya no cambia.
  await page.getByRole("button", { name: "Acciones de Cómo nos conoció", exact: true }).click()
  await page.getByRole("menuitem", { name: "Editar", exact: true }).click()
  const editField = surface(page, { name: "Editar campo", exact: true })
  await expect(editField).toContainText("No se cambia después de crear el campo")
  await editField.getByLabel("Nombre", { exact: true }).fill("Origen")
  await editField.getByLabel("Opciones", { exact: true }).fill("Redes sociales\nRecomendación\nPasó por la clínica")
  await editField.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(editField).toBeHidden()
  await expect(page.getByRole("row").filter({ hasText: "Origen" })).toContainText("Pasó por la clínica")
  expect((await fields())[0]).toMatchObject({
    id: created?.id,
    key: "como_nos_conocio",
    label: "Origen",
    options: ["Redes sociales", "Recomendación", "Pasó por la clínica"],
  })

  // Dos campos no se llaman igual: el servidor lo dice junto al Nombre y lo escrito se conserva.
  await page.getByRole("button", { name: "Nuevo campo", exact: true }).click()
  await newField.getByLabel("Nombre", { exact: true }).fill("origen")
  await newField.getByRole("button", { name: "Guardar", exact: true }).click()
  const takenName = newField.getByLabel("Nombre", { exact: true })
  await expect(takenName).toHaveAttribute("aria-invalid", "true")
  await expect(takenName).toHaveAccessibleDescription(/Ya hay un campo con ese nombre/)
  await expect(takenName).toHaveValue("origen")
  expect(await fields()).toHaveLength(1)
})
