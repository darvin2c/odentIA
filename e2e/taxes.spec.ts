import type { Page } from "@playwright/test"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, createAcceptedBudget, patientApiPath } from "./patients-fixture"
import { surface } from "./surface"

/** Sin desplazamiento a lo ancho, y la captura para revisar la pantalla real. */
async function observe(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true })
}

test("impuestos (ADR 0083): viene el IGV del país, el ticket lo separa, Reportes no lo cuenta en lo que deja y su pago no vuelve a restar", async ({
  owner,
}) => {
  const { page } = owner
  const slug = owner.org.slug
  await page.setViewportSize({ width: 1280, height: 900 })

  // Datos de la clínica: una frase con lo que vale y «Cambiar».
  await gotoHydrated(page, tenant(slug, "/settings"))
  const taxes = page.getByRole("region", { name: "Impuestos" })
  await expect(taxes).toContainText("IGV 18 %")
  await expect(taxes).toContainText("en todo lo que cobras")
  await expect(taxes).toContainText("Es lo de Perú")
  await taxes.scrollIntoViewIfNeeded()
  await observe(page, "impuestos-cerrada")
  await taxes.getByRole("button", { name: "Cambiar" }).click()
  await expect(taxes.getByLabel("Atenciones", { exact: true })).toBeVisible()
  await expect(taxes.getByLabel("Productos", { exact: true })).toBeVisible()
  await observe(page, "impuestos-abierta")
  await page.setViewportSize({ width: 390, height: 844 })
  await observe(page, "impuestos-telefono")
  await page.setViewportSize({ width: 1280, height: 900 })

  // Un tratamiento de 450 con el IGV de hoy; se paga una parte: el ticket separa lo de hoy y dice lo que falta.
  const ids = await buildClinicalBase(owner)
  const { budgetLineId } = await createAcceptedBudget(owner, ids)
  await call(page, "POST", `${patientApiPath(ids.patientId)}/charges`, slug, { budgetItemId: budgetLineId }, 201)
  await gotoHydrated(page, tenant(slug, "/finance"))
  await page.getByRole("main").getByRole("button", { name: "Cobrar a Lucía Quispe" }).click()
  const drawer = surface(page, { name: "Cobrar", exact: true })
  await drawer.getByLabel("Importe", { exact: true }).fill("236")
  await drawer.getByRole("button", { name: /^Cobrar S\/\s*236\.00/ }).click()
  const ticket = page.getByRole("article", { name: /^Ticket / })
  await expect(ticket).toContainText("Subtotal")
  await expect(ticket).toContainText("200.00")
  await expect(ticket).toContainText("IGV 18 %")
  await expect(ticket).toContainText("36.00")
  await expect(ticket).toContainText("Le falta pagar")
  await expect(ticket).toContainText("pagó 236.00 de 450.00")
  await expect(ticket).toContainText("Recibo interno. No es un documento fiscal.")
  await observe(page, "ticket-con-igv")

  // Reportes › Finanzas: «Cobrado» dice cuánto es IGV, lo que deja no lo cuenta y «Lo que debes» lo suma.
  await gotoHydrated(page, tenant(slug, "/reports?tab=finanzas"))
  await expect(page.getByRole("region", { name: "Cobrado", exact: true })).toContainText("incluye S/ 36.00 de IGV")
  const owed = page.getByRole("region", { name: "Lo que debes" })
  await expect(owed).toContainText("IGV por pagar")
  await expect(owed).toContainText("36.00")
  await observe(page, "reportes-con-igv")
  const before = await call<{ totals: { current: { leavesCents: number; taxCents: number; cobradoCents: number } } }>(
    page,
    "GET",
    "/api/reports/finance?period=este_mes",
    slug,
  )
  expect(before.totals.current).toMatchObject({ cobradoCents: 23_600, taxCents: 3_600 })

  // Gastos › Impuestos pregunta qué impuesto se paga; el IGV no vuelve a restar de lo que deja.
  await gotoHydrated(page, tenant(slug, "/finance?tab=gastos"))
  await page.getByRole("button", { name: "Registrar gasto" }).first().click()
  const expense = surface(page, { name: "Registrar gasto", exact: true })
  await expense.getByRole("radio", { name: "Impuestos" }).click()
  await expect(expense.getByText("¿Qué impuesto pagas?")).toBeVisible()
  await expense.getByText("IGV de tus cobros").click()
  await expense.getByLabel("En qué se gastó").fill("IGV del mes")
  await expense.getByLabel("Importe", { exact: true }).fill("36")
  await observe(page, "gasto-igv")
  await expense.getByRole("button", { name: "Registrar gasto", exact: true }).click()
  await expect(expense).toBeHidden()
  const after = await call<{ totals: { current: { leavesCents: number } }; cascade: { salesTaxPaidCents: number } }>(
    page,
    "GET",
    "/api/reports/finance?period=este_mes",
    slug,
  )
  expect(after.totals.current.leavesCents).toBe(before.totals.current.leavesCents)
  expect(after.cascade.salesTaxPaidCents).toBe(3_600)
})
