import type { Dialog, Page, Route } from "@playwright/test"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated, waitForHydration } from "./hydration"

async function failSave(page: Page, route: Route) {
  if (route.request().method() !== "PUT") return route.continue()
  await route.fulfill({
    status: 503,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": new URL(page.url()).origin,
      "access-control-allow-credentials": "true",
    },
    body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "Guardado no disponible" } }),
  })
}

async function cancelReload(page: Page) {
  const pending = page.waitForEvent("dialog")
  const reload = page.evaluate(() => window.location.reload())
  const dialog = await pending
  expect(dialog.type()).toBe("beforeunload")
  await dialog.dismiss()
  await reload
}

async function reloadClean(page: Page) {
  const dialogs: string[] = []
  const onDialog = async (dialog: Dialog) => {
    dialogs.push(dialog.type())
    await dialog.dismiss()
  }
  page.on("dialog", onDialog)
  try {
    await page.reload({ waitUntil: "domcontentloaded" })
    await waitForHydration(page)
    expect(dialogs).toEqual([])
  } finally {
    page.off("dialog", onDialog)
  }
}

test("Organización protege navegación, historial y recarga; guardar y revertir limpian el borrador", async ({ createOwner }) => {
  const { page, org } = await createOwner("page-org")
  await call(page, "PUT", "/api/org-profile", org.slug, {
    legalName: org.name,
    tradeName: "Nombre guardado",
    countryCode: "PE",
    currency: "PEN",
    timezone: "America/Lima",
    locale: "es-PE",
  })
  await gotoHydrated(page, tenant(org.slug, "/settings/channels"))
  await page.getByRole("link", { name: "Organización", exact: true }).click()
  const name = page.getByLabel("Nombre comercial", { exact: true })
  await expect(name).toHaveValue("Nombre guardado")
  await name.fill("Borrador de organización")

  await page.getByRole("link", { name: "Canales", exact: true }).click()
  const confirmation = page.getByRole("alertdialog")
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole("button", { name: "Continuar editando" }).click()
  await expect(name).toHaveValue("Borrador de organización")
  await expect(name).toBeFocused()
  await expect(page).toHaveURL(/\/settings\/?$/)

  await cancelReload(page)
  await expect(name).toHaveValue("Borrador de organización")
  // Cambiar la URL fuera del router también pasa por beforeunload.
  const nativeDialog = page.waitForEvent("dialog")
  const externalNavigation = page.evaluate((url) => window.location.assign(url), tenant(org.slug, "/branches"))
  const leave = await nativeDialog
  expect(leave.type()).toBe("beforeunload")
  await leave.dismiss()
  await externalNavigation
  await expect(name).toHaveValue("Borrador de organización")

  await page.evaluate(() => window.history.back())
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole("button", { name: "Continuar editando" }).click()
  await expect(name).toHaveValue("Borrador de organización")
  await expect(name).toBeFocused()
  await page.evaluate(() => window.history.back())
  await confirmation.getByRole("button", { name: "Descartar y salir" }).click()
  await expect(page).toHaveURL(/\/settings\/channels$/)
  // La URL cambia antes de desmontar la página: navegar el historial solo al ver el destino.
  await expect(page.getByRole("heading", { level: 1, name: "Canales" })).toBeVisible()
  await page.evaluate(() => window.history.forward())
  await expect(name).toHaveValue("Nombre guardado")

  // Adelante debe conservar el destino pendiente igual que atrás.
  await page.getByRole("link", { name: "Canales", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Canales" })).toBeVisible()
  await page.evaluate(() => window.history.back())
  await expect(name).toHaveValue("Nombre guardado")
  await name.fill("Borrador para adelante")
  await page.evaluate(() => window.history.forward())
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole("button", { name: "Continuar editando" }).click()
  await expect(name).toHaveValue("Borrador para adelante")

  // Un fallo no resetea ninguno de los campos; el siguiente envío usa el borrador.
  await page.route("**/api/org-profile", (route) => failSave(page, route))
  await page.getByLabel("Dirección fiscal", { exact: true }).fill("Dirección conservada")
  await page.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(page.getByText("No pudimos guardar los datos", { exact: true })).toBeVisible()
  await expect(name).toHaveValue("Borrador para adelante")
  await expect(page.getByLabel("Dirección fiscal", { exact: true })).toHaveValue("Dirección conservada")
  await page.getByRole("link", { name: "Contactos", exact: true }).click()
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole("button", { name: "Continuar editando" }).click()

  await page.unroute("**/api/org-profile")
  await page.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(page.getByText("Datos guardados", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeEnabled()
  await reloadClean(page)
  await expect(name).toHaveValue("Borrador para adelante")
  await page.getByRole("link", { name: "Canales", exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/channels$/)
  await expect(confirmation).toBeHidden()
  await page.getByRole("link", { name: "Organización", exact: true }).click()
  await expect(name).toHaveValue("Borrador para adelante")
  await name.fill("Cambio temporal")
  await name.fill("Borrador para adelante")
  // Revertir al valor guardado no debe preguntar aunque el campo haya sido tocado.
  await page.getByRole("link", { name: "Contactos", exact: true }).click()
  await expect(page).toHaveURL(/\/contacts\/?$/)
  await expect(confirmation).toBeHidden()
})

test("Acceso de pacientes conserva campos con auxiliares tardíos, fallo de guardado y navegación cancelada", async ({ createOwner }) => {
  const { page, org } = await createOwner("page-portal")
  const connectionsReady = Promise.withResolvers<void>()
  await page.route("**/api/channels/connections", async (route) => {
    await connectionsReady.promise
    await route.continue()
  })
  try {
    await gotoHydrated(page, tenant(org.slug, "/settings"))
    await page.getByRole("link", { name: "Acceso de pacientes", exact: true }).click()
    const ttl = page.getByLabel("Enlace de activación (minutos, 1–43200)", { exact: true })
    await expect(ttl).toBeVisible()
    const savedTtl = await ttl.inputValue()
    const nextTtl = savedTtl === "75" ? "76" : "75"
    await expect(page.getByText("Cargando conexiones…", { exact: true })).toBeVisible()
    await ttl.fill(nextTtl)
    connectionsReady.resolve()
    await expect(page.getByText("Cargando conexiones…", { exact: true })).toBeHidden()
    await expect(ttl).toHaveValue(nextTtl)

    await page.getByRole("link", { name: "Organización", exact: true }).click()
    const confirmation = page.getByRole("alertdialog")
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole("button", { name: "Continuar editando" }).click()
    await expect(ttl).toHaveValue(nextTtl)
    await expect(ttl).toBeFocused()
    await cancelReload(page)
    await expect(ttl).toHaveValue(nextTtl)

    await page.route("**/api/portal/policy", (route) => failSave(page, route))
    await page.getByRole("button", { name: "Guardar políticas", exact: true }).click()
    await expect(page.getByText("No se pudo guardar", { exact: true })).toBeVisible()
    await expect(ttl).toHaveValue(nextTtl)
    await page.evaluate(() => window.history.back())
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole("button", { name: "Continuar editando" }).click()
    await expect(ttl).toHaveValue(nextTtl)

    await page.unroute("**/api/portal/policy")
    await page.getByRole("button", { name: "Guardar políticas", exact: true }).click()
    await expect(page.getByText("Políticas guardadas.", { exact: true })).toBeVisible()
    await page.getByRole("link", { name: "Organización", exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/?$/)
    await expect(confirmation).toBeHidden()
    await page.getByRole("link", { name: "Acceso de pacientes", exact: true }).click()
    await expect(ttl).toHaveValue(nextTtl)
    await reloadClean(page)
    await expect(ttl).toHaveValue(nextTtl)
    await ttl.fill("90")
    await page.getByRole("link", { name: "Contactos", exact: true }).click()
    await confirmation.getByRole("button", { name: "Descartar y salir" }).click()
    await expect(page).toHaveURL(/\/contacts\/?$/)
    await expect(page.getByRole("heading", { level: 1, name: "Contactos" })).toBeVisible()
    await page.evaluate(() => window.history.back())
    await expect(ttl).toHaveValue(nextTtl)
  } finally {
    connectionsReady.resolve()
  }
})
