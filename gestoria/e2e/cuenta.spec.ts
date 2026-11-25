import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, CLAVE, CODIGO_TOTP, PEOPLE, STORE_ID, type Who } from "./entorno"

/**
 * La cuenta dentro de gestorIA (ADR 0216): desde el menú de la persona en la tienda, Mi perfil con
 * la marca de gestorIA y «← la tienda» para volver; cambiar la contraseña (la equivocada se dice
 * en su campo) y activar la verificación en dos pasos hasta guardar los códigos. Cerrar la cuenta
 * no se ofrece mientras sea la única con el rol de Dueño. En escritorio y a 390 px.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1366, height: 860 }
const PHONE = { width: 390, height: 844 }
const rosa = PEOPLE.rosa

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true })
}

async function noSideScroll(page: Page) {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )
  expect(fits, "la página no se desborda a lo ancho").toBe(true)
}

async function as(who: Who | "nadie") {
  const response = await fetch(`${ACCOUNT}/__como/${who}`, { method: "POST" })
  expect(response.ok).toBe(true)
}

/** Lo que pidió Mi perfil a la cuenta de mentira. */
async function asked(): Promise<Array<{ path: string; body: Record<string, unknown> }>> {
  return ((await (await fetch(`${ACCOUNT}/__cuenta`)).json()) as { asked: never[] }).asked
}

test.describe.configure({ mode: "serial" })

test("desde la tienda: cambiar la contraseña y activar los dos pasos sin salir de gestorIA", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`/tiendas/${STORE_ID}/pedidos`)

  // El menú de la persona tiene «Mi perfil» y «Cambiar contraseña», como en las clínicas.
  await page.getByRole("button", { name: `Menú de ${rosa.name}` }).click()
  await expect(page.getByRole("menuitem", { name: "Mi perfil" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: /Cerrar sesión/ })).toContainText(
    "Cierra tu sesión aquí y en las apps que abriste desde aquí",
  )
  await page.getByRole("menuitem", { name: "Cambiar contraseña" }).click()

  // Mi perfil en gestorIA, con el cajón de la contraseña abierto y el camino de vuelta.
  await expect(page).toHaveURL(/\/cuenta\?/)
  const drawer = page.getByRole("dialog", { name: "Cambiar contraseña" })
  await expect(drawer).toBeVisible()
  await expect(drawer).toContainText("Es la de tu cuenta: vale para todas tus apps.")
  await shot(page, "cuenta-contrasena-escritorio")

  // La contraseña actual equivocada se dice en su campo; con la buena, queda cambiada.
  await drawer.getByLabel("Contraseña actual").fill("no-es-esta")
  await drawer.getByLabel("Nueva contraseña", { exact: true }).fill("Una-clave-nueva-2026")
  await drawer.getByLabel("Confirma la nueva contraseña").fill("Una-clave-nueva-2026")
  await drawer.getByRole("button", { name: "Guardar" }).click()
  await expect(drawer.getByText("La contraseña no coincide. Revísala.")).toBeVisible()
  await drawer.getByLabel("Contraseña actual").fill(CLAVE)
  await drawer.getByLabel("Contraseña actual").press("Enter")
  await expect(page.getByText("Contraseña actualizada")).toBeVisible()
  await expect(drawer).toBeHidden()
  expect((await asked()).filter((a) => a.path === "/change-password").at(-1)?.body).toMatchObject({
    currentPassword: CLAVE,
    newPassword: "Una-clave-nueva-2026",
    revokeOtherSessions: true,
  })
  await expect(page.getByRole("heading", { name: "Mi perfil" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Calzados Rosa" })).toBeVisible()

  // Activar los dos pasos: la contraseña, escanear y el código, y guardar los códigos.
  await page.getByRole("link", { name: "Activar" }).click()
  const setup = page.getByRole("dialog", { name: "Activar la verificación en dos pasos" })
  await setup.getByLabel("Tu contraseña").fill(CLAVE)
  await setup.getByRole("button", { name: "Continuar" }).click()
  await expect(
    setup.getByRole("img", { name: "Código QR para agregar gestorIA a tu app" }),
  ).toBeVisible()
  await setup.getByLabel("Escribe el código de 6 dígitos que muestra la app").fill(CODIGO_TOTP)
  const codes = page.getByRole("dialog", { name: "Guarda tus códigos de respaldo" })
  await expect(codes.getByRole("list", { name: "Códigos de respaldo" })).toContainText(
    "aaaa1-bbbb1",
  )
  await codes.getByRole("button", { name: "Terminar" }).click()
  await expect(codes.getByText("Marca la casilla cuando los hayas guardado.")).toBeVisible()
  await codes.getByRole("checkbox", { name: "Los guardé en un lugar seguro" }).click()
  await codes.getByRole("button", { name: "Terminar" }).click()
  await expect(codes).toBeHidden()
  await expect(page.getByText("Activa", { exact: true })).toBeVisible()
  await expect(page.getByText("Nadie: la activaste tú")).toBeVisible()

  // Cerrar la cuenta: siendo la única con el rol de Dueño, primero tiene que dárselo a otra.
  await expect(
    page.getByText(/Eres la única persona con el rol de Dueño en Calzados Rosa/),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Cerrar mi cuenta" })).toBeDisabled()
  await noSideScroll(page)
  await shot(page, "cuenta-perfil-escritorio")
  await page.setViewportSize(PHONE)
  await noSideScroll(page)
  await shot(page, "cuenta-perfil-telefono")

  // «← Calzados Rosa» vuelve a la tienda.
  await page.setViewportSize(DESKTOP)
  await page.getByRole("link", { name: "Calzados Rosa" }).click()
  await expect(page).toHaveURL(new RegExp(`/tiendas/${STORE_ID}`))
})
