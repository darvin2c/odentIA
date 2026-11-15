/**
 * Ariadna en los chats (lienzo «Ariadna en los chats», ADR 0191), de punta a
 * punta en pantalla: en Kairós, Administración prende «Ariadna responde en los
 * chats de las clínicas con app», junto al de Kairós. Una clínica que ya tiene
 * su app (su conversación ya ligada a su cliente) escribe por WhatsApp
 * «¿cómo anulo una cita?» y Ariadna responde con la guía y el enlace a la
 * Agenda; en el cajón «Ariadna atiende esta conversación» y lo suyo va con su
 * nombre. «No me deja…» recibe la oferta de la Ayuda de la app o Soporte; con
 * el «sí» pasa a Soporte, que lo ve en Hoy. «Me cobraron dos veces» pasa a
 * Administración: Soporte no lo ve. A 390 px nada se desborda de lado.
 *
 * Meta es la de mentira del supervisor y los modelos son los dobles
 * (`LLM_MODEL=fake`): no acreditan la Graph API real ni la calidad de Jev.
 */
import { createHmac, randomUUID } from "node:crypto"
import { cpSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { kairosChatTurn, saasChat, saasClient, saasOutreach } from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import type { Page } from "@playwright/test"
import { and, asc, eq } from "drizzle-orm"
import { ADMIN, enterAdmin, surface } from "./admin"
import { API } from "./env"
import { api, expect, test } from "./fixtures"

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

/** Un texto de WhatsApp desde `from` (sin «+»), con el nombre de su perfil. */
function whatsappText(from: string, name: string, id: string, body: string) {
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
              contacts: [{ profile: { name }, wa_id: from }],
              messages: [
                {
                  id,
                  from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body },
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

test("Ariadna en los chats: el interruptor, responde con el enlace, «no me deja» pasa a Soporte con el sí y los cobros solo los ve Administración", async ({
  owner,
  createOwner,
  fixtureDb,
}, testInfo) => {
  test.setTimeout(600_000)
  const { page, user, org } = owner
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

  // La clínica del caso ya tiene su app: su cliente en el ARM, ligado a su organización.
  const clientName = `Clínica con app ${tag}`
  const [existing] = await fixtureDb
    .select({ id: saasClient.id })
    .from(saasClient)
    .where(eq(saasClient.organizationId, org.id))
  const clientId =
    existing?.id ??
    (
      await fixtureDb
        .insert(saasClient)
        .values({ name: clientName, product: "dental", organizationId: org.id })
        .returning({ id: saasClient.id })
    )[0]?.id ??
    ""
  if (existing)
    await fixtureDb.update(saasClient).set({ name: clientName }).where(eq(saasClient.id, clientId))
  expect(clientId).not.toBe("")
  /** Una conversación que una persona ya ligó a la clínica (nunca por el teléfono). */
  const linkedChat = async (from: string) => {
    const [row] = await fixtureDb
      .insert(saasChat)
      .values({ channel: "whatsapp", address: `+${from}`, clientId })
      .returning({ id: saasChat.id })
    return row?.id ?? ""
  }
  const ariadnaSaid = (chatId: string) =>
    fixtureDb
      .select({ body: saasOutreach.body, adminOnly: saasOutreach.adminOnly })
      .from(saasOutreach)
      .where(and(eq(saasOutreach.chatId, chatId), eq(saasOutreach.byAriadna, true)))
      .orderBy(asc(saasOutreach.createdAt))
  const waitAriadna = async (chatId: string, count: number) => {
    try {
      await expect
        .poll(async () => (await ariadnaSaid(chatId)).length, {
          timeout: 120_000,
          intervals: [2_000],
        })
        .toBeGreaterThanOrEqual(count)
    } catch (error) {
      const turns = await fixtureDb
        .select({
          agent: kairosChatTurn.agent,
          outcome: kairosChatTurn.outcome,
          why: kairosChatTurn.why,
        })
        .from(kairosChatTurn)
        .where(eq(kairosChatTurn.chatId, chatId))
      throw new Error(`${String(error)}\nTurnos: ${JSON.stringify(turns)}`)
    }
    return (await ariadnaSaid(chatId))[count - 1]
  }
  const digits = () => String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")

  try {
    // --- Kairós: el interruptor de Ariadna, junto al de Kairós, solo Administración --------
    await page.goto(`${ADMIN}/kairos`)
    const ariadna = page.getByRole("switch", {
      name: "Ariadna responde en los chats de las clínicas con app",
    })
    await expect(
      page.getByRole("switch", { name: "Kairós responde solo en los chats" }),
    ).toBeVisible()
    await expect(ariadna).not.toBeChecked()
    await expect(page.getByText("No ve los datos de la clínica.")).toBeVisible()
    await ariadna.click()
    await expect(
      page.getByText("Ariadna responde en los chats de las clínicas que ya tienen su app"),
    ).toBeVisible()
    await expect(ariadna).toBeChecked()
    await shot(page, "kairos-interruptores-1366")

    // --- Caso 1: «¿cómo anulo una cita?» → la guía y el enlace a la Agenda -----------------
    const from = `51957${digits()}`
    const chatId = await linkedChat(from)
    await postMeta(
      page,
      whatsappText(from, "Carla", `wamid.anular-${tag}`, "¿cómo anulo una cita?"),
    )
    const first = await waitAriadna(chatId, 1)
    expect(first?.body).toMatch(
      /^Soy Ariadna, la Ayuda de odentIA\.\s+Abre la cita y pulsa «Cancelar cita»/,
    )
    expect(first?.body).toMatch(new RegExp(`https://${org.slug}\\.[^\\s]+/agenda`))
    expect(first?.body).toMatch(/— Ariadna · odentIA$/)
    expect(first?.adminOnly).toBe(false)

    // --- El cajón: «Ariadna atiende esta conversación», lo suyo con su nombre ---------------
    await page.goto(`${ADMIN}/clients/${clientId}?tab=historial`)
    const history = page.getByRole("list", { name: "Historial del cliente" })
    await history
      .getByRole("button", { name: /Nos escribió por WhatsApp/ })
      .first()
      .click()
    const chat = surface(page, /^WhatsApp con /)
    await expect(chat).toBeVisible()
    await expect(chat).toContainText("Ariadna atiende esta conversación")
    await expect(chat.getByRole("listitem").filter({ hasText: "Soy Ariadna" })).toContainText(
      /Ariadna · \d\d:\d\d · Salió/,
    )
    // Se puede escribir a mano igual: al enviar, quien escribe la atiende y Ariadna se pausa.
    await expect(chat).toContainText("Si envías tú, lo atiendes tú y Ariadna deja de responder")
    await expect(chat.getByLabel("Respuesta")).toBeVisible()
    // En el historial del cliente, lo suyo va con su nombre.
    await expect(history.getByText("Ariadna", { exact: true }).first()).toBeVisible()
    await shot(page, "conversacion-ariadna-1366")
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${ADMIN}/clients/${clientId}?tab=historial`)
    await history
      .getByRole("button", { name: /Nos escribió por WhatsApp/ })
      .first()
      .click()
    await expect(chat).toContainText("Ariadna atiende esta conversación")
    await expectNoSideScroll(page, "Conversación con Ariadna")
    await shot(page, "conversacion-ariadna-390")
    await page.goto(`${ADMIN}/kairos`)
    await expect(ariadna).toBeVisible()
    await expectNoSideScroll(page, "Kairós con sus dos interruptores")
    await shot(page, "kairos-interruptores-390")
    await page.setViewportSize({ width: 1366, height: 900 })

    // --- Caso 2: «no me deja» → la oferta → «sí» → pasa a Soporte --------------------------
    const blocked = `51958${digits()}`
    const blockedChat = await linkedChat(blocked)
    await postMeta(
      page,
      whatsappText(blocked, "Beto", `wamid.nodeja-${tag}`, "no me deja cobrar a un paciente"),
    )
    const offer = await waitAriadna(blockedChat, 1)
    expect(offer?.body).toContain("¿quieres que te pase?")
    await postMeta(page, whatsappText(blocked, "Beto", `wamid.si-${tag}`, "sí, por favor"))
    const handed = await waitAriadna(blockedChat, 2)
    expect(handed?.body).toContain("te paso con Soporte")

    // --- Caso 4: «me cobraron dos veces» → Administración -----------------------------------
    const billing = `51959${digits()}`
    const billingChat = await linkedChat(billing)
    await postMeta(
      page,
      whatsappText(billing, "Dora", `wamid.cobro-${tag}`, "¿por qué me cobraron dos veces?"),
    )
    const toAdmin = await waitAriadna(billingChat, 1)
    expect(toAdmin?.body).toContain("Eso lo ve Administración")
    expect(toAdmin?.adminOnly).toBe(true)

    // Hoy se arma con la pasada de Kairós: una a pedido, para no esperar la del worker.
    const run = await api(page, "POST", "/api/admin/kairos/run", undefined, {})
    expect(run.status).toBe(200)
    await page.goto(`${ADMIN}/`)
    await expect(page.getByText(`Beto · ${clientName}`).first()).toBeVisible()
    await expect(page.getByText(`Dora · ${clientName}`).first()).toBeVisible()
    await page.goto(`${ADMIN}/clients/${clientId}?tab=historial`)
    await history
      .getByRole("listitem")
      .filter({ hasText: "¿por qué me cobraron dos veces?" })
      .getByRole("button", { name: /Nos escribió por WhatsApp/ })
      .first()
      .click()
    await expect(chat).toContainText("Ariadna se la pasó a Administración")
    await expect(chat.getByRole("checkbox", { name: "Solo administración" })).toBeChecked()
    await shot(page, "conversacion-administracion-1366")

    // --- Soporte: ve en Hoy lo que Ariadna le pasó, no lo de cobros ------------------------
    const support = await createOwner("soporte")
    await fixtureDb.insert(adminStaff).values({ userId: support.user.id, role: "support" })
    await support.page.setViewportSize({ width: 1366, height: 900 })
    await enterAdmin(support.page, support.user.password)
    await support.page.goto(`${ADMIN}/`)
    const toSupport = support.page.getByRole("listitem").filter({ hasText: `Beto · ${clientName}` })
    await expect(toSupport.first()).toBeVisible()
    await expect(toSupport.first()).toContainText("Ariadna se lo pasó a Soporte")
    await expect(support.page.getByText(`Dora · ${clientName}`)).toHaveCount(0)
    await toSupport.first().scrollIntoViewIfNeeded()
    await shot(support.page, "hoy-soporte-1366")
    await support.page.setViewportSize({ width: 390, height: 844 })
    await expectNoSideScroll(support.page, "Hoy de Soporte")
    await shot(support.page, "hoy-soporte-390")
    // El servidor tampoco le deja cambiar el interruptor.
    const denied = await api(support.page, "PUT", "/api/admin/kairos/ariadna", undefined, {
      enabled: false,
    })
    expect(denied.status).toBe(403)
  } finally {
    // El interruptor es de toda la administración: los demás recorridos lo esperan apagado.
    await api(page, "PUT", "/api/admin/kairos/ariadna", undefined, { enabled: false })
  }
})
