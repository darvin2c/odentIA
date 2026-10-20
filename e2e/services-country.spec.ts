import { tenant } from "./env"
import { call, chooseOption, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/**
 * Servicios por país (ADR 0067, lienzo del issue 40): la biblioteca es la de
 * consultorio y cada tratamiento lleva el código de la lista del país; donde
 * la lista es obligatoria, el servicio propio elige el suyo con un buscador.
 */
test("Perú: la biblioteca con su código CPMS, el servicio propio con su código y las normas del país", async ({ owner }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })

  // --- Agregar servicios: nombres de consultorio, el código de la CPMS y sin el pie de la edición ---
  await gotoHydrated(page, tenant(org.slug, "/services/biblioteca"))
  await expect(page.getByRole("heading", { level: 1, name: "Agregar servicios" })).toBeVisible()
  const profilaxis = page.getByRole("row").filter({ hasText: "Profilaxis" }).first()
  await expect(profilaxis).toContainText("CPMS D1110")
  await expect(page.getByText("Los códigos son los de la lista CPMS, la que pide la norma de tu país (RM 550-2023-MINSA).")).toBeVisible()
  await expect(page.getByText(/505 de 505|Ver fuente oficial/)).toHaveCount(0)

  // --- Servicio propio: en el Perú no se guarda sin su código CPMS ---
  await page.getByRole("button", { name: "Crear un servicio propio" }).click()
  const own = surface(page, { name: "Servicio propio", exact: true })
  await own.getByLabel("Nombre", { exact: true }).fill("Blanqueamiento con férula para casa")
  await chooseOption(own.getByLabel("Especialidad", { exact: true }), { label: "Odontología Restauradora y Estética" })
  await own.getByLabel("Precio", { exact: true }).fill("450")
  await own.getByRole("button", { name: "Guardar y activar" }).click()
  await expect(own.getByText("Elige el código CPMS", { exact: true })).toBeVisible()
  await own.getByRole("combobox", { name: "Código CPMS" }).fill("blanqueamiento")
  await page.getByRole("option", { name: /D9972/ }).click()
  await expect(own.getByText("D9972", { exact: true })).toBeVisible()
  await own.getByRole("button", { name: "Guardar y activar" }).click()
  await expect(own).toBeHidden()
  await expect(page.getByText("«Blanqueamiento con férula para casa» ya está activo entre tus servicios")).toBeVisible()
  // `call` devuelve el `data` de la respuesta: la página del tarifario.
  const services = await call<Array<{ name: string; procedureCode: string | null; source: string }>>(
    page, "GET", "/api/services?limit=100", org.slug,
  )
  expect(services.find((row) => row.name === "Blanqueamiento con férula para casa")).toMatchObject({
    source: "custom",
    procedureCode: "D9972",
  })

  // --- La lista de servicios: sin «Heredada» ni columna de código oficial; el código, en el detalle ---
  await gotoHydrated(page, tenant(org.slug, "/services"))
  await expect(page.getByRole("heading", { level: 1, name: "Servicios y precios" })).toBeVisible()
  const row = page.getByRole("row").filter({ hasText: "Blanqueamiento con férula para casa" })
  await expect(row).toContainText("Propio de la clínica")
  await expect(page.getByRole("columnheader", { name: "Código interno" })).toHaveCount(0)
  await expect(page.getByText(/Heredada|sin código oficial/)).toHaveCount(0)
  await row.click()
  const detail = surface(page, { name: "Blanqueamiento con férula para casa" })
  await expect(detail.getByText("Código CPMS", { exact: true })).toBeVisible()
  await expect(detail).toContainText("D9972")

  // --- «Normas de tu país», de solo lectura, en Datos de la clínica ---
  await gotoHydrated(page, tenant(org.slug, "/settings"))
  const rules = page.getByRole("group", { name: "Normas de Perú" })
  await expect(rules).toContainText("CPMS, obligatoria (RM 550-2023-MINSA)")
  await expect(rules).toContainText("Las de su norma (DS 023-2020-SA)")
  await expect(rules).toContainText("NTS 188-MINSA/DGIESP-2022")
})

test("Colombia: la CUPS obligatoria y las variantes que separa; nada peruano", async ({ owner }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  await call(page, "PUT", "/api/org-profile", org.slug, { legalName: `${org.name} S.A.S.`, countryCode: "CO" })

  await gotoHydrated(page, tenant(org.slug, "/services/biblioteca?vista=biblioteca&q=exodoncia"))
  await expect(page.getByRole("heading", { level: 1, name: "Agregar servicios" })).toBeVisible()
  const variant = page.getByRole("row").filter({ hasText: "Exodoncia de diente permanente unirradicular" })
  await expect(variant).toContainText("CUPS 230101")
  // En Colombia la exodoncia va por raíces: no se ofrece la general ni aparece un código peruano.
  await expect(page.getByRole("row").filter({ hasText: /^Exodoncia simple/ })).toHaveCount(0)
  await expect(page.getByText(/CPMS/)).toHaveCount(0)
  await expect(page.getByText("Los códigos son los de la lista CUPS, la que pide la norma de tu país (Res. 2706 de 2025).")).toBeVisible()

  await gotoHydrated(page, tenant(org.slug, "/settings"))
  const rules = page.getByRole("group", { name: "Normas de Colombia" })
  await expect(rules).toContainText("CUPS, obligatoria (Res. 2706 de 2025)")
  await expect(rules).toContainText("Numeración FDI")
})
