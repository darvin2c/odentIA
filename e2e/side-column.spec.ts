import { PANEL, tenant } from "./env"
import { chooseOption, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

test("formularios: columna lateral en ventana ancha, cajón en estrecha y aviso al salir con cambios", async ({
  owner,
}) => {
  const { page, org } = owner
  const column = page.getByRole("complementary", { name: "Panel lateral" })
  const open = () => page.getByRole("button", { name: "Producto", exact: true }).click()

  // Ancha: el formulario va a la columna, a todo el alto, y la página sigue usable.
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/inventory"))
  await open()
  const form = column.getByRole("region", { name: "Nuevo producto" })
  await expect(form).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect((await column.boundingBox())?.height).toBe(900)
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()

  // Con algo escrito, navegar pregunta antes; seguir editando conserva el valor.
  const name = column.getByLabel("Nombre", { exact: true })
  await name.fill("COL-1")
  await page.getByRole("navigation").getByRole("link", { name: "Inicio", exact: true }).click()
  const leave = page.getByRole("alertdialog")
  await expect(leave).toContainText("Salir sin guardar")
  await leave.getByRole("button", { name: "Continuar editando" }).click()
  await expect(name).toHaveValue("COL-1")
  await expect(page).toHaveURL(/\/inventory/)

  // Con la columna ocupada, el agente se abre como cajón encima y no la toca.
  await page.locator("header").getByRole("button", { name: /^Agente/ }).click()
  const agent = page.getByRole("dialog", { name: "Agente" })
  await expect(agent).toBeVisible()
  await agent.getByRole("button", { name: "Cerrar el panel del agente" }).click()
  await expect(agent).toBeHidden()
  await expect(name).toHaveValue("COL-1")

  // Elegir en un desplegable también cuenta como cambio sin guardar.
  await gotoHydrated(page, tenant(org.slug, "/inventory"))
  await open()
  await chooseOption(column.getByLabel("Se usa por", { exact: true }), "caja")
  await page.getByRole("navigation").getByRole("link", { name: "Inicio", exact: true }).click()
  await expect(leave).toContainText("Salir sin guardar")
  await leave.getByRole("button", { name: "Descartar y salir" }).click()
  await expect(page).toHaveURL(/\/home/)

  // La app de cuenta tiene la misma columna: el perfil se edita al lado. Va a
  // todo el alto junto a su cabecera, no debajo: así su pie queda a la vista.
  await gotoHydrated(page, `${PANEL}/profile?edit=password`)
  await expect(column.getByRole("region", { name: "Cambiar contraseña" })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expect(await column.boundingBox()).toMatchObject({ y: 0, height: 900 })
  await expect(column.getByRole("button", { name: "Cancelar" })).toBeInViewport({ ratio: 1 })
  // Al bajar la página la columna se queda quieta: el panel no tiene franja de
  // avisos que defina su alto, y sin él no puede soltarse.
  await page.setViewportSize({ width: 1440, height: 600 })
  expect(await page.evaluate(() => (window.scrollTo(0, document.documentElement.scrollHeight), window.scrollY))).toBeGreaterThan(0)
  expect(await column.boundingBox()).toMatchObject({ y: 0, height: 600 })
  await expect(column.getByRole("button", { name: "Cancelar" })).toBeInViewport({ ratio: 1 })
  await page.setViewportSize({ width: 1440, height: 900 })

  // Estrecha: el mismo formulario es un cajón.
  await page.setViewportSize({ width: 1100, height: 800 })
  await gotoHydrated(page, tenant(org.slug, "/inventory"))
  await open()
  await expect(page.getByRole("dialog", { name: "Nuevo producto" })).toBeVisible()
  await expect(column).toHaveCount(0)
})
