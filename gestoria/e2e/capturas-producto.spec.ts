import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, API_PORT, WEB } from "./entorno"

/**
 * Las capturas de «Probar como clienta», la vista previa y «Sofi no supo» con la demo de Calzados
 * Rosa (sus fotos y su video en el RustFS propio), a 1440 y 390, claro y oscuro: las mismas vistas
 * del prototipo aprobado (d1–d12, m1–m4). No es un recorrido: corre solo con `E2E_DEMO=1`
 * (el servidor siembra la demo) y deja las imágenes en `CAPTURAS_DIR` o `gestoria/e2e/capturas/`.
 */

const DEMO = "6a1d6b52-6f73-4a5c-9b3a-5c0a1d0e2401"
const SHOTS = resolve(process.env.CAPTURAS_DIR ?? "capturas")
const API = `http://127.0.0.1:${API_PORT}`

test.skip(process.env.E2E_DEMO !== "1", "Solo con la demo sembrada")
test.describe.configure({ mode: "serial" })
test.setTimeout(240_000)

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.waitForTimeout(600)
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) })
}

async function zapatilla() {
  await fetch(`${ACCOUNT}/__como/rosa`, { method: "POST" })
  const { token } = (await (await fetch(`${ACCOUNT}/api/auth/token`)).json()) as { token: string }
  const headers = { origin: WEB, authorization: `Bearer ${token}` }
  await fetch(`${API}/api/yo`, { headers })
  const catalog = (await (
    await fetch(`${API}/api/tiendas/${DEMO}/catalogo`, { headers })
  ).json()) as { products: { id: string; name: string }[] }
  return catalog.products.find((p) => p.name === "Zapatilla urbana")!.id
}

// La ficha con las dos cosas juntas: las propuestas ✦ de la IA (#757) y la prueba de Sofi.
for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const)
  test(`la ficha con la IA y la prueba juntas, ${width}`, async ({ page }) => {
    const id = await zapatilla()
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.setViewportSize({ width, height })
    await page.goto(`/tiendas/${DEMO}/catalogo/${id}`)
    await expect(page.getByRole("button", { name: "Probar como clienta" })).toBeVisible()
    if (width > 600) {
      await page.getByRole("button", { name: "Probar como clienta" }).click()
      await expect(page.getByRole("heading", { name: "Probar como clienta" })).toBeVisible()
    } else {
      // En el celular, la ficha arriba: la línea de Sofi con «Probar como clienta» y lo de la IA.
      await page.waitForTimeout(800)
    }
    await shot(page, `juntas-${width}`)
  })

for (const scheme of ["light", "dark"] as const) {
  const tag = scheme === "light" ? "claro" : "oscuro"

  test(`escritorio, ${tag}: probar como clienta, la vista previa y «Te toca»`, async ({ page }) => {
    const id = await zapatilla()
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/tiendas/${DEMO}`)
    await expect(page.getByRole("heading", { name: "Te toca" })).toBeVisible()
    await shot(page, `t1-te-toca-1440-${tag}`)

    await page.goto(`/tiendas/${DEMO}/catalogo/${id}`)
    await page.getByRole("button", { name: "Lo que sabe Sofi de este producto" }).click()
    await shot(page, `e4-sofi-le-falta-1440-${tag}`)
    await page.keyboard.press("Escape")

    await page.getByRole("button", { name: "Probar como clienta" }).click()
    const panel = page
      .getByRole("complementary", { name: "Panel lateral" })
      .or(page.getByRole("dialog", { name: "Probar como clienta" }))
    const chat = panel.getByRole("log", { name: "El chat de la prueba" })
    const write = async (text: string, expected: RegExp) => {
      await panel.getByRole("textbox", { name: "Mensaje de la clienta (prueba)" }).fill(text)
      await panel.getByRole("button", { name: "Enviar" }).click()
      await expect(chat.getByText(expected).last()).toBeVisible({ timeout: 30_000 })
    }
    await panel.getByRole("button", { name: "Empezar de nuevo" }).click()
    await write("¿Tienes video de la negra puesta?", /Te mando el video/)
    await shot(page, `d1-chat-video-1440-${tag}`)
    await write("¿Y la blanca en 38? ¿Me haces precio?", /te consigo el envío gratis/)
    await shot(page, `d2-chat-oferta-1440-${tag}`)
    await write("Envío gratis", /quedó anotado/)
    await shot(page, `d3-chat-acordado-1440-${tag}`)
    await chat.getByRole("button", { name: "Ver y pagar" }).last().click()
    await expect(panel.getByRole("dialog", { name: "Tu carrito" })).toBeVisible()
    await shot(page, `d4-vitrina-carrito-1440-${tag}`)
    await panel.getByRole("button", { name: /Pagar ahora ·/ }).click()
    await expect(panel.getByRole("dialog", { name: "Pagar" })).toBeVisible()
    await shot(page, `d5-vitrina-pago-1440-${tag}`)
    await panel.getByRole("button", { name: "Pagar con Yape" }).click()
    await expect(panel.getByRole("dialog", { name: "Tu pedido" })).toBeVisible({ timeout: 30_000 })
    await shot(page, `d6-vitrina-pedido-1440-${tag}`)
    await panel.getByRole("button", { name: "Ver lo que te escribió Sofi" }).click()
    await expect(chat.getByText(/Pago recibido/)).toBeVisible()
    await shot(page, `d7-chat-pago-oferta-1440-${tag}`)
    await write("Sí, súmalo", /quedó anotado/)
    await shot(page, `d8-chat-sumado-1440-${tag}`)

    await panel.getByRole("button", { name: "Empezar de nuevo" }).click()
    await panel.getByRole("button", { name: "Vitrina" }).click()
    await expect(panel.getByRole("button", { name: "Lo quiero" })).toBeVisible()
    await shot(page, `d9-vitrina-globo-1440-${tag}`)
    await panel.getByRole("radio", { name: "negra" }).click()
    await panel.getByRole("button", { name: /^Talla 35/ }).click()
    await shot(page, `d10-vitrina-refleja-precio-1440-${tag}`)
    await panel.getByRole("button", { name: "WhatsApp" }).click()
    await write("¿Destiñe al lavarla?", /No lo tengo confirmado/)
    await shot(page, `d3b-que-uso-sofi-1440-${tag}`)

    await page.getByRole("button", { name: "Vista previa" }).click()
    const preview = page.getByRole("dialog", { name: "Vista previa" })
    await expect(preview.getByText("En la vitrina, por link")).toBeVisible()
    await shot(page, `d11-previa-celular-1440-${tag}`)
    await preview.getByRole("button", { name: "Web" }).click()
    await expect(preview.getByRole("heading", { name: "Zapatilla urbana", level: 1 })).toBeVisible()
    await shot(page, `d12-previa-web-1440-${tag}`)
  })

  test(`celular, ${tag}: el chat, la vitrina y la vista previa`, async ({ page }) => {
    const id = await zapatilla()
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/tiendas/${DEMO}`)
    await expect(page.getByRole("heading", { name: "Te toca" })).toBeVisible()
    await shot(page, `t2-te-toca-390-${tag}`)
    await page.goto(`/tiendas/${DEMO}/catalogo/${id}`)
    await page.getByRole("button", { name: "Probar como clienta" }).click()
    const panel = page.getByRole("dialog", { name: "Probar como clienta" })
    await panel.getByRole("button", { name: "Empezar de nuevo" }).click()
    await panel
      .getByRole("textbox", { name: "Mensaje de la clienta (prueba)" })
      .fill("¿Tienes la negra en 38?")
    await panel.getByRole("button", { name: "Enviar" }).click()
    await expect(panel.getByText(/está a S\//).last()).toBeVisible({ timeout: 30_000 })
    await shot(page, `m1-chat-390-${tag}`)
    await panel.getByRole("button", { name: "Vitrina" }).click()
    await expect(panel.getByRole("button", { name: "Lo quiero" })).toBeVisible()
    await shot(page, `m2-vitrina-390-${tag}`)
    await page.keyboard.press("Escape")
    await page
      .getByRole("button", { name: "Más acciones" })
      .or(page.getByRole("button", { name: /⋯|Más/ }))
      .first()
      .click()
    await page.getByRole("menuitem", { name: "Vista previa" }).click()
    const preview = page.getByRole("dialog", { name: "Vista previa" })
    await expect(preview.getByText("En la vitrina, por link")).toBeVisible()
    await shot(page, `m3-previa-celular-390-${tag}`)
    await preview.getByRole("button", { name: "Web" }).click()
    await shot(page, `m4-previa-web-390-${tag}`)
  })
}
