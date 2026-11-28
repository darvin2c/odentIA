import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, STORE_ID, surface, type Who } from "./entorno"

/**
 * Sofi en Configuración (tablero 8 de «gestorIA · Configuración, de nuevo»; ADR 0234), contra su
 * servidor y su base de verdad, con el modelo de desarrollo (responde por reglas, sin la red):
 * - Cómo habla se elige con un ejemplo de cada tono, y la prueba dice «Por qué» con lo elegido.
 * - Lo que Sofi no supo en un chat de verdad está en «Lo que aprendió»; respondido, pasa a «Lo
 *   que sabe» y deja de proponerse. En el teléfono, lo pendiente se ve sin deslizar las pestañas.
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
  // El ancho de la laptop de la tienda: la prueba queda al lado, también con el cajón abierto.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${BASE}/configuracion/sofi`)
  await expect(page.getByRole("heading", { name: "Sofi", level: 1 })).toBeVisible()
  await expect(page.getByText("Su tono: Cercana")).toBeVisible()
  const chat = page.getByRole("region", { name: "Probar a Sofi" })
  await expect(chat).toBeInViewport()

  // Apagada: guardar cómo habla no la vuelve a encender.
  const status = page.getByRole("region", { name: "Si Sofi atiende" })
  await expect(status.getByText("Apagada")).toBeVisible()

  await page
    .getByRole("region", { name: "Cómo habla" })
    .getByRole("button", { name: "Cambiar" })
    .click()
  const talk = surface(page, "Cambiar cómo habla")
  await expect(chat).toBeInViewport()
  await talk.getByRole("radio", { name: /^Directa/ }).check()
  await talk.getByRole("radio", { name: "Usted" }).click()
  await talk.getByRole("button", { name: "Guardar" }).click()
  await expect(talk).toBeHidden()
  await expect(page.getByText("Su tono: Directa")).toBeVisible()
  await expect(page.getByText("Usted", { exact: true })).toBeVisible()
  await expect(status.getByText("Apagada")).toBeVisible()
  // Encender y pausar van aparte, y se dicen en el momento.
  await status.getByRole("button", { name: "Encender" }).click()
  await expect(status.getByText("Encendida")).toBeVisible()
  await status.getByRole("button", { name: "Pausar" }).click()
  await expect(status.getByText("Apagada")).toBeVisible()

  await chat
    .getByRole("textbox", { name: "Tu mensaje, como cliente" })
    .fill("hola, ¿tienen zapatillas?")
  await chat.getByRole("button", { name: "Enviar" }).click()
  // La demo ya trae una prueba con sus respuestas: se mira la última.
  await expect(chat.getByText("Por qué:").last()).toBeVisible()
  await expect(
    chat.getByText("Habló directa, de usted, con pocos emojis, como elegiste."),
  ).toBeVisible()
  await shot(page, "sofi-como-habla")
})

test("lo que no supo se responde una vez y pasa a «Lo que sabe»", async ({ page }) => {
  await as("rosa")
  // En el teléfono las pestañas se deslizan y «Lo que aprendió» queda al final: lo pendiente se
  // ve igual, con su botón, sin deslizar.
  await page.setViewportSize(PHONE)
  await page.goto(`${BASE}/configuracion/sofi`)
  const pending = page.getByRole("button", { name: /^1 pregunta que Sofi no supo responder/ })
  await expect(pending).toBeInViewport()
  await shot(page, "sofi-pendiente-telefono")
  await pending.click()
  await expect(page.getByText("«¿Tienen sandalias talla 38?»")).toBeVisible()
  await expect(pending).toBeHidden()
  await noSideScroll(page)

  await page.setViewportSize(DESKTOP)
  await page.goto(`${BASE}/configuracion/sofi`)
  // En la pantalla ancha caben las pestañas: el número va en la suya y la línea no se repite.
  await expect(pending).toBeHidden()
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
      /«Te paso con una persona del equipo: te escribe por aquí .*desde las 9 a\. m\.»/,
    ),
  ).toBeVisible()
  await shot(page, "sofi-cuando-te-pasa")
  await page.setViewportSize(PHONE)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Sofi", level: 1 })).toBeVisible()
  await noSideScroll(page)
  await shot(page, "sofi-telefono")
  // En el teléfono la prueba queda abajo: «Probar a Sofi», arriba, lleva a ella.
  const chat = page.getByRole("region", { name: "Probar a Sofi" })
  await expect(chat).not.toBeInViewport()
  await page.getByRole("button", { name: "Probar a Sofi" }).click()
  await expect(chat).toBeInViewport()
  await expect(chat.getByRole("textbox", { name: "Tu mensaje, como cliente" })).toBeFocused()
})
