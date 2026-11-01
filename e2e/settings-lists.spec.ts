import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

type Stage = { id: string; name: string; moment: string }

test("etapas de venta: se editan al lado, con palabras y sin claves", async ({ owner }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  const stages = async () => (await call<Array<{ stages: Stage[] }>>(page, "GET", "/api/pipelines", org.slug))[0]?.stages ?? []

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
})
