/**
 * De qué app le hablan (A1 del lienzo «Una sola administración», ADR 0201), en
 * pantalla: el Grupo Sallca vende todas sus apps por un solo WhatsApp. Un
 * mensaje que llega desde un anuncio que nadie ató aparece en Hoy, «Anuncios
 * por atar», con su título; se ata a latidIA con el teclado y su conversación
 * pasa a decir «latidIA · por el anuncio». Otro que llega con el mensaje ya
 * escrito del botón de vistIA dice «vistIA · por el enlace», y uno que no dice
 * nada, «App por saber», que Administración elige en el cajón. Soporte no ve
 * los anuncios ni elige la app: el servidor le responde 403. A 390 px nada se
 * desborda de lado.
 *
 * Meta es la de mentira del supervisor: no acredita el `referral` de un
 * anuncio real.
 */
import { createHmac, randomUUID } from "node:crypto"
import { cpSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { saasChat } from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { ADMIN, enterAdmin } from "../../e2e/admin"
import { API } from "../../e2e/env"
import { api, expect, test } from "../../e2e/fixtures"

async function expectNoSideScroll(page: Page, what: string): Promise<void> {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }))
  expect(scroll, `${what}: ancho de la página ${scroll} > ${inner}`).toBeLessThanOrEqual(inner)
}

/** Un aviso de Meta firmado con la app de la administración, desde el origen de la API. */
async function postMeta(page: Page, body: unknown): Promise<void> {
  const raw = JSON.stringify(body)
  const secret = process.env.ADMIN_META_APP_SECRET ?? ""
  expect(secret, "el entorno trae ADMIN_META_APP_SECRET").not.toBe("")
  const signature = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`
  const sender = await page.context().newPage()
  await sender.goto(`${API}/health`)
  const result = await sender.evaluate(
    async ({ raw, signature }) => {
      const response = await fetch("/api/webhooks/meta/admin", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body: raw,
      })
      return { status: response.status, text: await response.text() }
    },
    { raw, signature },
  )
  await sender.close()
  expect(result.status, result.text).toBe(200)
}

function whatsappText(from: string, id: string, body: string, referral?: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-e2e",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: process.env.ADMIN_WA_PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Persona de prueba" }, wa_id: from }],
              messages: [
                {
                  id,
                  from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body },
                  ...(referral ? { referral } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

const CAPTURAS = process.env.E2E_CAPTURAS_DIR

test("La app de la conversación: el anuncio se ata en Hoy, el botón de la web la dice y Administración la elige en el cajón", async ({
  owner,
  createOwner,
  fixtureDb,
}, testInfo) => {
  test.setTimeout(240_000)
  const { page, user } = owner
  const shot = async (p: Page, name: string) => {
    const path = testInfo.outputPath(`${name}.png`)
    await p.screenshot({ path, fullPage: true })
    if (CAPTURAS) {
      mkdirSync(CAPTURAS, { recursive: true })
      cpSync(path, join(CAPTURAS, `${name}.png`))
    }
  }
  await page.setViewportSize({ width: 1366, height: 900 })
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  await enterAdmin(page, user.password)

  const tag = randomUUID().slice(0, 6)
  const digits = String(Math.floor(Math.random() * 100_000)).padStart(5, "0")
  const fromAd = `51957${digits}1`
  const fromLink = `51957${digits}2`
  const silent = `51957${digits}3`
  const headline = `Tu consultorio en orden ${tag}`
  const adText = `Vi su anuncio ${tag}`
  const linkText = "Hola, quiero información de vistIA"
  const silentText = `Hola, ¿qué venden? ${tag}`
  await postMeta(
    page,
    whatsappText(fromAd, `wamid.anuncio-${tag}`, adText, {
      source_url: "https://fb.me/anuncio-de-prueba",
      source_id: `ad-${tag}`,
      source_type: "ad",
      headline,
      body: "Agenda y recetas en un solo lugar",
    }),
  )
  await postMeta(page, whatsappText(fromLink, `wamid.enlace-${tag}`, linkText))
  await postMeta(page, whatsappText(silent, `wamid.nada-${tag}`, silentText))
  const chatOf = async (address: string) => {
    const [row] = await fixtureDb
      .select({ id: saasChat.id, product: saasChat.product, source: saasChat.productSource })
      .from(saasChat)
      .where(and(eq(saasChat.channel, "whatsapp"), eq(saasChat.address, `+${address}`)))
    return row
  }
  expect(await chatOf(fromLink)).toMatchObject({ product: "optical", source: "enlace" })
  expect(await chatOf(fromAd)).toMatchObject({ product: null })

  // --- Hoy: el anuncio por atar, con su título; se ata con el teclado ------------------------
  await page.goto(`${ADMIN}/`)
  const ads = page.getByRole("region", { name: "Anuncios por atar" })
  await expect(ads).toBeVisible()
  const adRow = ads.getByRole("listitem").filter({ hasText: headline })
  await expect(adRow).toContainText("1 conversación espera su app")
  await expect(adRow.getByRole("link", { name: "Ver el anuncio" })).toHaveAttribute(
    "href",
    "https://fb.me/anuncio-de-prueba",
  )
  await shot(page, "hoy-anuncios-1366")
  await adRow.getByRole("button", { name: "¿De qué app es?" }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: /latidIA · consultorio médico/ }).click()
  await expect(
    page.getByText(/Anuncio atado a latidIA: su conversación pasó a esa app/),
  ).toBeVisible()
  await expect(adRow).toHaveCount(0)
  expect(await chatOf(fromAd)).toMatchObject({ product: "medical", source: "anuncio" })

  // --- La Bandeja: cada conversación dice su app y cómo se supo -------------------------------
  await page.goto(`${ADMIN}/inbox`)
  const list = page.getByRole("region", { name: "Conversaciones" })
  await expect(list.getByRole("listitem").filter({ hasText: adText })).toContainText(
    /latidIA\s*· por el anuncio/,
  )
  await expect(list.getByRole("listitem").filter({ hasText: linkText }).first()).toContainText(
    /vistIA\s*· por el enlace/,
  )
  const silentRow = list.getByRole("listitem").filter({ hasText: silentText })
  await expect(silentRow).toContainText("App por saber")
  await shot(page, "bandeja-apps-1366")

  // --- En el cajón: «Elegir la app» de la que no dice nada -----------------------------------
  await silentRow.getByRole("button").click()
  const pane = page.getByRole("region", { name: "Conversación abierta" })
  await expect(pane).toContainText(silentText)
  await expect(pane).toContainText("App por saber")
  await pane.getByRole("button", { name: "Elegir la app" }).click()
  await page.getByRole("menuitem", { name: /odentIA · clínica dental/ }).click()
  await expect(
    page.getByText("La conversación es de odentIA: Kairós sigue con esa app"),
  ).toBeVisible()
  await expect(pane).toContainText(/odentIA\s*· la eligió el equipo/)
  await expect(pane.getByRole("button", { name: "Cambiar" })).toBeVisible()
  expect(await chatOf(silent)).toMatchObject({ product: "dental", source: "persona" })
  await shot(page, "cajon-app-elegida-1366")

  // --- Soporte: ni los anuncios ni elegir la app (403) ---------------------------------------
  const support = await createOwner("soporte")
  await fixtureDb.insert(adminStaff).values({ userId: support.user.id, role: "support" })
  await enterAdmin(support.page, support.user.password)
  const silentChat = await chatOf(silent)
  expect((await api(support.page, "GET", "/api/admin/chats/ads/to-tie", undefined)).status).toBe(
    403,
  )
  expect(
    (
      await api(support.page, "POST", `/api/admin/chats/${silentChat?.id}/app`, {
        product: "optical",
      })
    ).status,
  ).toBe(403)
  await support.page.goto(`${ADMIN}/`)
  await expect(support.page.getByRole("heading", { level: 1, name: "Hoy" })).toBeVisible()
  await expect(support.page.getByRole("region", { name: "Anuncios por atar" })).toHaveCount(0)

  // --- A 390 px: el cajón con su app, sin desbordarse --------------------------------------
  await page.bringToFront()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${ADMIN}/inbox`)
  await list.getByRole("listitem").filter({ hasText: silentText }).getByRole("button").click()
  await expect(pane.getByRole("button", { name: "Cambiar" })).toBeVisible()
  await expectNoSideScroll(page, "Conversación con su app")
  await shot(page, "cajon-app-390")
})
