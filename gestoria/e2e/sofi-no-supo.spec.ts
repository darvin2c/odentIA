import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ACCOUNT, API_PORT, STORE_ID, WEB, type Who } from "./entorno"

/**
 * «Sofi no supo» (lienzo «La ficha del producto», tablero 12), contra su servidor y su base de
 * verdad: dos clientas preguntan en chats de verdad algo que la ficha no dice; Sofi (el modelo de
 * desarrollo, por su misma tubería) no lo inventa y lo deja a la tienda. En Inicio, «Te toca» lo
 * muestra en una sola línea («2 clientas esperan»), se responde una vez con «Responder», Sofi se
 * lo dice a cada una y queda en la ficha, en «Preguntas respondidas».
 */

const SHOTS = resolve("capturas")
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const BASE = `/tiendas/${STORE_ID}`
const API = `http://127.0.0.1:${API_PORT}`
const STORE = `/api/tiendas/${STORE_ID}`

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) })
}

async function as(who: Who) {
  expect((await fetch(`${ACCOUNT}/__como/${who}`, { method: "POST" })).ok).toBe(true)
}

// biome-ignore lint/suspicious/noExplicitAny: el recorrido lee respuestas JSON de forma libre
async function json(method: string, path: string, body?: unknown): Promise<any> {
  const { token } = (await (await fetch(`${ACCOUNT}/api/auth/token`)).json()) as { token: string }
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      origin: WEB,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : {}
}

/** Una clienta escribe en un chat de verdad (de WhatsApp), desde un producto. */
async function customerWrites(name: string, text: string, productId: string) {
  const response = await fetch(`${ACCOUNT}/__clienta`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, text, productId }),
  })
  expect(response.ok).toBe(true)
  return (await response.json()) as { conversationId: string; status: string }
}

async function noSideScroll(page: Page) {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )
  expect(fits, "la página no se desborda a lo ancho").toBe(true)
}

test("Sofi no supo: «Te toca» en una línea, se responde una vez y queda en la ficha", async ({
  page,
}) => {
  await as("rosa")
  await json("GET", "/api/yo")
  const created = await json("POST", `${STORE}/productos`, {
    name: "Sandalia de tiras",
    category: "Sandalias",
    listPriceCents: 8900,
    options: [{ name: "Talla", values: ["36", "37"] }],
  })
  const productId = created.product.id as string
  await json("PATCH", `${STORE}/productos/${productId}`, {
    rubro: "calzado",
    rubroData: { horma: "Normal", material: "Sintético" },
  })
  // Sofi atiende los chats de verdad mientras dura este recorrido: encender va aparte (ADR 0234).
  const { settings } = await json("GET", `${STORE}/sofi`)
  await json("PATCH", `${STORE}/sofi/estado`, { enabled: true })
  try {
    const carla = await customerWrites("Carla", "¿Destiñe al lavarla?", productId)
    const valeria = await customerWrites("Valeria", "¿Destiñe al lavarla?", productId)
    expect([carla.status, valeria.status]).toEqual(["respondio", "respondio"])
    const said = await json("GET", `${STORE}/conversaciones/${carla.conversationId}`)
    const sofi = (said.conversation.messages as { author: string; text: string }[]).at(-1)!
    expect(sofi.text).toContain("No lo tengo confirmado. Le pregunto a la tienda y te escribo")

    // «Te toca»: una sola línea para las dos, con su único botón.
    await page.setViewportSize(DESKTOP)
    await page.goto(BASE)
    const toDo = page.getByRole("region", { name: "Te toca" })
    const line = toDo.getByRole("listitem").filter({ hasText: "«¿Destiñe al lavarla?»" })
    await expect(line).toHaveCount(1)
    await expect(line.getByText(/2 clientas esperan/)).toBeVisible()
    await noSideScroll(page)
    await shot(page, "sofi-no-supo-te-toca-1440")
    await line.getByRole("button", { name: "Responder" }).click()
    const form = page
      .getByRole("dialog", { name: "Responder lo que Sofi no supo" })
      .or(page.getByRole("region", { name: "Responder lo que Sofi no supo" }))
    await expect(form).toBeVisible()
    await form.getByLabel("Tu respuesta").fill("No destiñe. Lávala a mano con agua fría.")
    await expect(form.getByRole("checkbox", { name: "Que Sofi se lo diga" })).toBeChecked()
    await expect(form.getByRole("checkbox", { name: "Guardarlo en la ficha" })).toBeChecked()
    await shot(page, "sofi-no-supo-responder-1440")
    await form.getByRole("button", { name: "Responder" }).click()
    await expect(
      page.getByText("Respondido. Sofi se lo escribe a las 2 clientas, si atiende su chat."),
    ).toBeVisible()
    await expect(line).toHaveCount(0)

    // Sofi se lo dice a cada una, por la misma tubería.
    await expect
      .poll(
        async () => {
          const view = await json("GET", `${STORE}/conversaciones/${valeria.conversationId}`)
          return (view.conversation.messages as { text: string }[]).at(-1)?.text ?? ""
        },
        { timeout: 20_000 },
      )
      .toContain("No destiñe. Lávala a mano con agua fría.")

    // Queda en la ficha: la próxima vez Sofi la lee de ahí.
    await page.goto(`${BASE}/catalogo/${productId}`)
    await expect(page.getByText("No destiñe. Lávala a mano con agua fría.")).toBeVisible()
    await page.setViewportSize(PHONE)
    await page.goto(BASE)
    await noSideScroll(page)
  } finally {
    await json("PATCH", `${STORE}/sofi/estado`, { enabled: settings.enabled })
  }
})
