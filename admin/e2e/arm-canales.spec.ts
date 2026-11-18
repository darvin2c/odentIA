/**
 * Los canales de la administración (ADR 0189 y 0196), de punta a punta en pantalla:
 * un WhatsApp firmado como lo firma Meta llega desde el celular de un contacto
 * que ya tenemos; Hoy dice «Te toca responder» y lleva a la Bandeja, donde la
 * conversación espera «Sin cliente: elegir»; se abre con el teclado, «¿De quién
 * es?» sugiere ese contacto y «Es de …» lo liga (la fila pasa a decir su
 * cliente y su fase); la respuesta sale con su *negrita* tal cual por WhatsApp
 * («Salió») y la conversación pasa a «Respondidas». En la ficha › Historial,
 * «Le escribimos por WhatsApp» abre la misma conversación. Un Instagram sin
 * cliente se marca «No es una clínica», sale de «Te toca» y se deshace. Soporte
 * no tiene Bandeja ni conversaciones: el servidor le responde 403. A 390 px
 * nada se desborda de lado.
 *
 * Meta es la de mentira del supervisor (`meta-graph-stub.ts`): no acredita la
 * Graph API real ni la entrega en un celular.
 */
import { createHmac, randomUUID } from "node:crypto"
import { cpSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { saasChat, saasClient, saasClientContact } from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { ADMIN, enterAdmin, surface } from "../../e2e/admin"
import { API } from "../../e2e/env"
import { api, expect, test } from "../../e2e/fixtures"

/** Que la página no se recorra de lado: lo ancho va dentro de su propio desplazamiento. */
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
  // Node no resuelve los *.localhost del entorno en Windows: se envía desde el navegador, sin cookie.
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

function whatsapp(messages: unknown[], contacts: unknown[]) {
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
              contacts,
              messages,
            },
          },
        ],
      },
    ],
  }
}

const CAPTURAS = process.env.E2E_CAPTURAS_DIR

test("Canales: un WhatsApp sin cliente llega a la Bandeja, se liga y se responde ahí; Instagram «No es una clínica» con Deshacer; Soporte sin la Bandeja", async ({
  owner,
  createOwner,
  fixtureDb,
}, testInfo) => {
  test.setTimeout(300_000)
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

  // --- Una venta (sin cuenta) con su contacto, que escribe desde su celular -----------------
  const tag = randomUUID().slice(0, 6)
  const digits = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")
  const phone = `+51954${digits}`
  const clinicName = `Odontología Quispe ${tag}`
  const [client] = await fixtureDb
    .insert(saasClient)
    .values({ name: clinicName, product: "dental", ownerUserId: user.id })
    .returning({ id: saasClient.id })
  const clientId = client?.id ?? ""
  await fixtureDb.insert(saasClientContact).values({
    clientId,
    name: "Rosa Quispe",
    phone,
    roles: ["decide"],
    isPrimary: true,
  })

  // --- Llegan: el WhatsApp de Rosa (un CSV y un texto), otro número y un Instagram ----------
  const now = Math.floor(Date.now() / 1000)
  const hello = `Hola, soy Rosa. ¿Cómo empezamos con odentIA? ${tag}`
  await postMeta(
    page,
    whatsapp(
      [
        {
          id: `wamid.csv-${tag}`,
          from: phone.slice(1),
          timestamp: String(now - 60),
          type: "document",
          document: {
            id: `media-${tag}`,
            mime_type: "text/csv",
            filename: "exportacion-pacientes.csv",
          },
        },
        {
          id: `wamid.texto-${tag}`,
          from: phone.slice(1),
          timestamp: String(now),
          type: "text",
          text: { body: hello },
        },
      ],
      [{ profile: { name: "Rosa" }, wa_id: phone.slice(1) }],
    ),
  )
  const stranger = `+51955${digits}`
  const strangerText = `Hola, vi su anuncio en la feria ${tag}`
  await postMeta(
    page,
    whatsapp(
      [
        {
          id: `wamid.otro-${tag}`,
          from: stranger.slice(1),
          timestamp: String(now),
          type: "text",
          text: { body: strangerText },
        },
      ],
      [{ profile: { name: "Doctor Ruiz" }, wa_id: stranger.slice(1) }],
    ),
  )
  const igText = `¿Tienen algo para ortodoncia? ${tag}`
  await postMeta(page, {
    object: "instagram",
    entry: [
      {
        id: process.env.ADMIN_IG_ACCOUNT_ID,
        time: Date.now(),
        messaging: [
          {
            sender: { id: `igsid-${tag}` },
            recipient: { id: process.env.ADMIN_IG_ACCOUNT_ID },
            timestamp: Date.now(),
            message: { mid: `ig-${tag}`, text: igText },
          },
        ],
      },
    ],
  })
  const [rosaChat] = await fixtureDb
    .select({ id: saasChat.id, clientId: saasChat.clientId })
    .from(saasChat)
    .where(and(eq(saasChat.channel, "whatsapp"), eq(saasChat.address, phone)))
  expect(rosaChat?.clientId, "nunca se liga solo por el teléfono").toBeNull()
  const rosaChatId = rosaChat?.id ?? ""
  const [igChat] = await fixtureDb
    .select({ id: saasChat.id, displayName: saasChat.displayName })
    .from(saasChat)
    .where(and(eq(saasChat.channel, "instagram"), eq(saasChat.address, `igsid-${tag}`)))
  expect(igChat?.displayName).toBe("@dra.melissa.ortodoncia")
  const igChatId = igChat?.id ?? ""

  // --- Hoy: «Te toca responder» arriba, y de ahí a la Bandeja --------------------------------
  await page.goto(`${ADMIN}/`)
  await expect(page.getByRole("heading", { level: 1, name: "Hoy" })).toBeVisible()
  const teToca = page.getByRole("region", { name: "Te toca responder" })
  await expect(teToca).toBeVisible()
  await expect(page.getByRole("link", { name: /^Bandeja/ })).toBeVisible()
  await shot(page, "hoy-1366")
  await teToca.getByRole("link", { name: "Ver la Bandeja" }).click()
  await expect(page).toHaveURL(/\/inbox$/)
  await expect(page.getByRole("heading", { level: 1, name: "Bandeja" })).toBeVisible()

  // --- La Bandeja: las tres esperan, sin cliente; la de Rosa se abre con el teclado ---------
  const list = page.getByRole("region", { name: "Conversaciones" })
  const rosaRow = list.getByRole("listitem").filter({ hasText: hello })
  await expect(rosaRow).toContainText("Te toca")
  await expect(rosaRow).toContainText("WhatsApp")
  await expect(rosaRow).toContainText("Sin cliente: elegir")
  // Nombró odentIA: la fila dice la app y cómo se supo (A1, un solo número para todas las apps).
  await expect(rosaRow).toContainText(/odentIA\s*· lo dijo/)
  const igRow = list.getByRole("listitem").filter({ hasText: igText })
  await expect(igRow).toContainText("Instagram")
  await expect(igRow).toContainText("Sin cliente: elegir")
  await expect(list.getByRole("listitem").filter({ hasText: strangerText })).toBeVisible()
  await shot(page, "bandeja-1366")
  await rosaRow.getByRole("button").focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(new RegExp(`[?&]c=chat(:|%3A)${rosaChatId}`))
  const pane = page.getByRole("region", { name: "Conversación abierta" })
  await expect(pane).toContainText(hello)
  await expect(pane).toContainText("sin cliente todavía")
  await shot(page, "bandeja-conversacion-1366")

  // --- «¿De quién es?»: el contacto con ese celular, y «Es de Rosa Quispe» -------------------
  await pane.getByRole("button", { name: "¿De quién es?" }).click()
  const whose = surface(page, "¿De quién es este WhatsApp?")
  await expect(whose).toBeVisible()
  await expect(whose).toContainText(`Ese celular es de un contacto: Rosa Quispe, de ${clinicName}.`)
  await expect(whose.getByRole("button", { name: /Es una clínica nueva/ })).toBeVisible()
  await expect(whose).toContainText("Mientras nadie decide, se puede responder igual.")
  await shot(page, "de-quien-es-1366")
  await whose.getByRole("button", { name: /^Es de Rosa Quispe/ }).click()
  await expect(page.getByText("Listo: sus mensajes quedan en esa ficha")).toBeVisible()
  await expect(whose).toHaveCount(0)
  const [linked] = await fixtureDb
    .select({ clientId: saasChat.clientId })
    .from(saasChat)
    .where(eq(saasChat.id, rosaChatId))
  expect(linked?.clientId).toBe(clientId)
  // La fila dice ahora su cliente y su fase, sin que nadie la marque.
  await expect(rosaRow).toContainText(`${clinicName} · Por vender`)
  await expect(pane.getByRole("link", { name: `Ver la ficha de ${clinicName}` })).toBeVisible()
  const file = pane
    .getByRole("region", { name: "Archivos" })
    .getByRole("listitem")
    .filter({ hasText: "exportacion-pacientes.csv" })
  await expect(file).toContainText("Guardado en Documentos · solo Administración")
  await expect(file.getByRole("button", { name: "Es la carga de datos" })).toBeVisible()
  await expect(pane).toContainText("Puedes responder con texto libre hasta")

  // --- Responder en la Bandeja: sale por la Meta de mentira, con su *negrita* y firmado -----
  const answer = `Hola Rosa, te cuento *cómo empezamos* ${tag}`
  const reply = pane.getByRole("textbox", { name: "Respuesta", exact: true })
  await reply.fill(answer)
  await expect(pane.getByRole("button", { name: "Mejorar con Kairós" })).toBeVisible()
  await shot(page, "bandeja-respuesta-1366")
  await pane.getByRole("button", { name: "Enviar por WhatsApp" }).click()
  await expect(page.getByText("Salió por WhatsApp")).toBeVisible()
  const ours = pane.getByRole("listitem").filter({ hasText: "Hola Rosa, te cuento" })
  await expect(ours).toContainText(/· \d\d:\d\d · Salió/)
  await expect(reply).toHaveValue("")
  const graph = process.env.E2E_META_GRAPH_URL ?? ""
  const sent = (await (await fetch(`${graph}/__enviados`)).json()) as Array<{
    path: string
    body: { to?: string; text?: { body?: string } }
  }>
  const out = sent.find((entry) => entry.body?.text?.body?.startsWith(answer))
  expect(out?.body.to, "sale al celular de Rosa, sin «+»").toBe(phone.slice(1))
  expect(out?.body.text?.body, "WhatsApp recibe *negrita* tal cual, con la firma").toMatch(
    /\n\n— \S+ · odentIA$/,
  )
  // Respondida: sale de «Te toca» y está en «Respondidas».
  await expect(rosaRow).toHaveCount(0)
  await page.getByRole("tab", { name: /^Respondidas/ }).click()
  await expect(list.getByRole("listitem").filter({ hasText: hello })).toContainText("Respondida")
  await shot(page, "bandeja-respondida-1366")

  // --- Instagram: «No es una clínica», sale de «Te toca», y «Deshacer» -----------------------
  await page.getByRole("tab", { name: /^Te toca/ }).click()
  await igRow.getByRole("button").click()
  await expect(pane).toContainText(igText)
  await pane.getByRole("button", { name: "¿De quién es?" }).click()
  const igOwner = surface(page, "¿De quién es este Instagram?")
  await expect(igOwner).toBeVisible()
  await expect(igOwner).not.toContainText("Ese celular es de un contacto")
  await igOwner.getByRole("button", { name: /^No es una clínica/ }).click()
  await expect(page.getByText("Listo: no es una clínica.", { exact: false })).toBeVisible()
  await expect(igRow).toHaveCount(0)
  const marked = await api<{ data: { notClinicAt: string | null } }>(
    page,
    "GET",
    `/api/admin/chats/${igChatId}`,
    undefined,
  )
  expect(marked.body.data.notClinicAt).not.toBeNull()
  await pane.getByRole("button", { name: "Deshacer" }).click()
  await expect(page.getByText("Listo: vuelve a estar por decidir")).toBeVisible()
  const undone = await api<{ data: { notClinicAt: string | null } }>(
    page,
    "GET",
    `/api/admin/chats/${igChatId}`,
    undefined,
  )
  expect(undone.body.data.notClinicAt).toBeNull()
  await expect(igRow).toContainText("Te toca")

  // --- Soporte: sin Bandeja ni conversaciones (el servidor responde 403) ---------------------
  const support = await createOwner("soporte")
  await fixtureDb.insert(adminStaff).values({ userId: support.user.id, role: "support" })
  await support.page.setViewportSize({ width: 1366, height: 900 })
  await enterAdmin(support.page, support.user.password)
  for (const path of [
    `/api/admin/chats/${rosaChatId}`,
    `/api/admin/chats/${igChatId}`,
    "/api/admin/inbox",
    "/api/admin/inbox/count",
  ]) {
    const denied = await api(support.page, "GET", path, undefined)
    expect(denied.status, path).toBe(403)
  }
  await support.page.goto(`${ADMIN}/`)
  await expect(support.page.getByRole("heading", { level: 1, name: "Hoy" })).toBeVisible()
  await expect(support.page.getByRole("region", { name: "Te toca responder" })).toHaveCount(0)
  await expect(support.page.getByRole("link", { name: /^Bandeja/ })).toHaveCount(0)
  await expect(support.page.getByText(strangerText)).toHaveCount(0)
  await support.page.goto(`${ADMIN}/inbox`)
  await expect(support.page.getByText("La Bandeja es de Administración")).toBeVisible()
  await expect(support.page.getByText(strangerText)).toHaveCount(0)
  await shot(support.page, "soporte-bandeja-1366")

  // --- A 390 px: la Bandeja, la conversación, «¿De quién es?» y el Historial -----------------
  await page.bringToFront()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${ADMIN}/inbox`)
  const small = list.getByRole("listitem").filter({ hasText: strangerText })
  await expect(small).toBeVisible()
  await expectNoSideScroll(page, "Bandeja")
  await shot(page, "bandeja-390")
  await small.getByRole("button").click()
  await expect(pane).toContainText(strangerText)
  // A 390 px la conversación ocupa la pantalla: la lista vuelve al cerrarla.
  await expect(list).toBeHidden()
  await expectNoSideScroll(page, "Conversación en la Bandeja")
  await shot(page, "bandeja-conversacion-390")
  await pane.getByRole("button", { name: "¿De quién es?" }).click()
  const smallOwner = surface(page, "¿De quién es este WhatsApp?")
  await expect(smallOwner).toBeVisible()
  await expectNoSideScroll(page, "¿De quién es?")
  await shot(page, "de-quien-es-390")
  await page.keyboard.press("Escape")
  await expect(smallOwner).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(list).toBeVisible()
  await page.goto(`${ADMIN}/clients/${clientId}?tab=historial`)
  const history = page.getByRole("list", { name: "Historial del cliente" })
  await expect(
    history.getByRole("button", { name: /Le escribimos por WhatsApp/ }).first(),
  ).toBeVisible()
  await expectNoSideScroll(page, "Historial")
  await shot(page, "historial-390")
  // Con el teclado: la fila se alcanza y abre la misma conversación.
  await history
    .getByRole("button", { name: /Le escribimos por WhatsApp/ })
    .first()
    .focus()
  await page.keyboard.press("Enter")
  const chat = surface(page, "WhatsApp con Rosa Quispe")
  await expect(chat).toBeVisible()
  await expect(chat).toContainText("Hola Rosa, te cuento")
  await expectNoSideScroll(page, "Conversación")
  await shot(page, "conversacion-390")
})
