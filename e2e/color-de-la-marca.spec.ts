import type { Page } from "@playwright/test"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * El color de la marca (ADR 0157): quien configura lo elige en Datos de la clínica, se
 * guarda aparte con «Usar este color», y la app y sus páginas públicas lo muestran desde
 * el primer pintado. Un color claro conserva el relleno exacto con letra oscura.
 */

/** El HTML que entrega el servidor, pedido desde la misma página (mismo sitio y sesión). */
const serverHtml = (page: Page, url: string) =>
  page.evaluate((target) => fetch(target, { credentials: "include", cache: "no-store" }).then((r) => r.text()), url)

/** El valor del token en la raíz, ya resuelto. */
const token = (page: Page, name: string) =>
  page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name)

test("elegir el color de la marca: vista previa, guardar, primer pintado, color claro y volver al de fábrica", async ({ createOwner }, testInfo) => {
  const { page, org } = await createOwner("marca")
  await call(page, "PUT", "/api/org-profile", org.slug, {
    legalName: org.name,
    tradeName: "Sonrisa Azul",
    countryCode: "PE",
    currency: "PEN",
    timezone: "America/Lima",
    locale: "es-PE",
  })
  await gotoHydrated(page, tenant(org.slug, "/settings"))
  const block = page.getByRole("region", { name: "Color de la marca" })
  await expect(block).toBeVisible()
  // Viene con el turquesa de odentIA, elegido y sin nada por guardar.
  await expect(block.getByRole("button", { name: "Turquesa, el de odentIA" })).toHaveAttribute("aria-pressed", "true")
  await expect(block.getByRole("button", { name: "Usar este color" })).toHaveCount(0)
  expect(await token(page, "--primary-fill")).toBe("#0e7490")

  // Elegir solo cambia la vista previa: la app sigue en turquesa hasta guardar.
  await block.getByRole("button", { name: "Azul", exact: true }).click()
  await expect(block.getByText("Aún no se guarda")).toBeVisible()
  expect(await token(page, "--primary-fill")).toBe("#0e7490")
  await testInfo.attach("eleccion-escritorio", { body: await block.screenshot(), contentType: "image/png" })
  await block.getByRole("button", { name: "Usar este color" }).click()
  await expect(page.getByText("Color guardado. Tus pacientes ya lo ven.")).toBeVisible()
  await expect.poll(() => token(page, "--primary-fill")).toBe("#2563eb")
  await expect(block.getByRole("button", { name: "Volver al turquesa de odentIA" })).toBeVisible()

  // Desde el primer pintado: el HTML del servidor ya trae el color, también en una página pública.
  const settingsHtml = await serverHtml(page, tenant(org.slug, "/settings"))
  expect(settingsHtml).toContain("--primary-fill:#2563eb")
  const publicHtml = await serverHtml(page, tenant(org.slug, "/embed"))
  expect(publicHtml).toContain("--primary-fill:#2563eb")

  // Un celeste claro: el botón lo conserva exacto con letra oscura y el texto usa un tono legible.
  await block.getByRole("button", { name: "Elegir otro color" }).click()
  const code = block.getByLabel("Código, si lo tienes")
  await code.fill("#7CC4EC")
  await expect(block.getByText(/Tu color es claro/)).toBeVisible()
  await block.getByRole("button", { name: "Usar este color" }).click()
  await expect.poll(() => token(page, "--primary-fill")).toBe("#7cc4ec")
  expect(await token(page, "--primary-fill-foreground")).toBe("#0f172a")
  expect(await token(page, "--primary")).not.toBe("#7cc4ec")

  // Un código mal escrito se dice junto al campo al salir de él, y el color guardado no cambia.
  await code.fill("#7CC4E")
  await code.blur()
  await expect(block.getByText("Escribe 6 cifras o letras después de #, como #1D5FA8.")).toBeVisible()
  await expect(code).toHaveAttribute("aria-invalid", "true")
  expect(await token(page, "--primary-fill")).toBe("#7cc4ec")

  await page.setViewportSize({ width: 390, height: 844 })
  await testInfo.attach("eleccion-celular", { body: await block.screenshot(), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })
  // En oscuro el celeste también se lee: la app entera, para revisarla a ojo.
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  expect(await token(page, "--primary-fill")).toBe("#7cc4ec")
  await testInfo.attach("app-oscuro", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  await testInfo.attach("app-claro", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Volver al de fábrica quita el color: la cabecera ya no lo escribe.
  await block.getByRole("button", { name: "Volver al turquesa de odentIA" }).click()
  await expect.poll(() => token(page, "--primary-fill")).toBe("#0e7490")
  const clean = await serverHtml(page, tenant(org.slug, "/settings"))
  expect(clean).not.toContain("--primary-fill:#")
})
