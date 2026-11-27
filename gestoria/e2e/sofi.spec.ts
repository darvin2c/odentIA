import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, STORE_ID, surface, type Who } from "./entorno"

/**
 * Sofi en Configuración (tablero 8 de «gestorIA · Configuración, de nuevo»; ADR 0234), contra su
 * servidor y su base de verdad, con el modelo de desarrollo (responde por reglas, sin la red):
 * - Cómo habla se elige con un ejemplo de cada tono, y la prueba dice «Por qué» con lo elegido.
 * - Lo que Sofi no supo en un chat de verdad está en «Lo que aprendió»; respondido, pasa a «Lo
 *   que sabe» y deja de proponerse.
 * - El horario del equipo se elige con días y horas, y lo dice como lo dirá Sofi.
 * En escritorio y a 390 px, sin desborde. Las capturas van a `gestoria/e2e/capturas/`.
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const BASE = `/tiendas/${STORE_ID}`

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

async function as(who: Who) {
  const response = await fetch(`${ACCOUNT}/__como/${who}`, { method: "POST" })
  expect(response.ok).toBe(true)
}

test.describe.configure({ mode: "serial" })

test("Sofi se elige con ejemplos y la prueba dice por qué respondió así", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/sofi`)
  await expect(page.getByRole("heading", { name: "Sofi", level: 1 })).toBeVisible()
  await expect(page.getByText("Su tono: Cercana")).toBeVisible()

  await page
    .getByRole("region", { name: "Cómo habla" })
    .getByRole("button", { name: "Cambiar" })
    .click()
  const talk = surface(page, "Cambiar cómo habla")
  await talk.getByRole("radio", { name: /^Directa/ }).check()
  await talk.getByRole("radio", { name: "Usted" }).click()
  await talk.getByRole("button", { name: "Guardar" }).click()
  await expect(talk).toBeHidden()
  await expect(page.getByText("Su tono: Directa")).toBeVisible()
  await expect(page.getByText("Usted", { exact: true })).toBeVisible()

  const chat = page.getByRole("region", { name: "Probar a Sofi" })
  await chat
    .getByRole("textbox", { name: "Tu mensaje, como cliente" })
    .fill("hola, ¿tienen zapatillas?")
  await chat.getByRole("button", { name: "Enviar" }).click()
  await expect(chat.getByText("Por qué:")).toBeVisible()
  await expect(
    chat.getByText("Habló directa, de usted, con pocos emojis, como elegiste."),
  ).toBeVisible()
  await shot(page, "sofi-como-habla")
})

test("lo que no supo se responde una vez y pasa a «Lo que sabe»", async ({ page }) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/sofi`)
  await page.getByRole("tab", { name: "Lo que aprendió · 1" }).click()
  await expect(page.getByText("«¿Tienen sandalias talla 38?»")).toBeVisible()
  await shot(page, "sofi-lo-que-aprendio")
  await page.getByRole("button", { name: "Responder" }).click()
  const form = surface(page, "Responder")
  await form
    .getByRole("textbox", { name: "Respuesta" })
    .fill("Por ahora no: solo zapatillas, botines y mocasines.")
  await form.getByRole("button", { name: "Guardar" }).click()
  await expect(form).toBeHidden()
  await expect(page.getByText("Nada por responder")).toBeVisible()
  await expect(page.getByRole("tab", { name: "Lo que aprendió" })).toBeVisible()
  await page.getByRole("tab", { name: "Lo que sabe" }).click()
  await expect(page.getByText("¿Tienen sandalias talla 38?")).toBeVisible()
  await expect(page.getByText("Por ahora no: solo zapatillas, botines y mocasines.")).toBeVisible()
})

test("el horario del equipo se elige con días y horas, y en el teléfono no se desborda", async ({
  page,
}) => {
  await as("rosa")
  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/sofi`)
  await page.getByRole("tab", { name: "Cuándo te pasa el chat" }).click()
  await page
    .getByRole("region", { name: "Horario de tu equipo" })
    .getByRole("button", { name: "Cambiar" })
    .click()
  const form = surface(page, "Cuándo te pasa el chat")
  await form.getByRole("switch", { name: "Tu equipo tiene horario" }).click()
  await expect(form.getByRole("button", { name: "Domingo" })).toHaveAttribute(
    "aria-pressed",
    "false",
  )
  await form.getByRole("button", { name: "Guardar" }).click()
  await expect(form).toBeHidden()
  await expect(page.getByText("Lunes a sábado, de 9 a. m. a 7 p. m.")).toBeVisible()
  await expect(
    page.getByText(
      "«Te paso con una persona del equipo: te escribe por aquí mañana desde las 9 a. m.»",
    ),
  ).toBeVisible()
  await shot(page, "sofi-cuando-te-pasa")
  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Sofi", level: 1 })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "sofi-telefono")
})
