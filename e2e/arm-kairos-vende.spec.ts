/**
 * Kairós vende y agenda (lienzo «Kairós vende»), de punta a punta en pantalla:
 * en Equipo, Administración pone su horario para presentaciones y su sala; en
 * Kairós prende «Kairós responde solo en los chats». Un WhatsApp firmado como
 * lo firma Meta llega de un número que no conocemos («¿cuánto cuesta?») y
 * Kairós responde solo con los planes; pide una presentación, dice su clínica,
 * Kairós le ofrece una hora, dice que sí y queda agendada con la sala. En el
 * cajón de la conversación lo de Kairós va con su nombre; «Lo atiendo yo» lo
 * pausa y el mensaje siguiente ya no lo responde. Una ausencia que cae en esa
 * presentación sale en Hoy («Pasar a…», «Pedir otra hora»). Soporte no ve ni
 * puede cambiar el interruptor (403 en el servidor) y no cambia el horario de
 * otra persona. A 390 px nada se desborda de lado.
 *
 * Meta es la de mentira del supervisor y el modelo es el doble por reglas
 * (`LLM_MODEL=fake`, `fakeSellerModel`): no acreditan la Graph API real ni la
 * calidad de un modelo de verdad.
 */
import { createHmac, randomUUID } from "node:crypto"
import { cpSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  kairosChatTurn,
  saasChat,
  saasClientContact,
  saasOutreach,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { saasPlan } from "@odentia/db/schema/saas-billing"
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

/** Un texto de WhatsApp desde `from` (sin «+»). */
function whatsappText(from: string, id: string, body: string) {
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
              contacts: [{ profile: { name: "Carla" }, wa_id: from }],
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

test("Kairós vende: horario y sala en Equipo, el interruptor, responde y agenda por WhatsApp, «Lo atiendo yo», la ausencia en Hoy y Soporte sin el interruptor", async ({
  owner,
  createOwner,
  fixtureDb,
}, testInfo) => {
  test.setTimeout(600_000)
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
  const room = `https://meet.example.test/sala-${tag}`
  // Un plan Fundadores publicado en la web, propio del caso: Kairós da sus precios tal como vienen.
  const planCode = `kv-${tag}`
  await fixtureDb.insert(saasPlan).values({
    code: planCode,
    name: `Fundadores ${tag}`,
    product: "dental",
    currency: "USD",
    priceCents: 0,
    creditCents: 10_000,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 2_000_000,
    trialCreditCents: 10_000,
    trialMaxCreditCents: 10_000,
    trialDays: 30,
    seatLimit: 50,
    showOnWeb: true,
  })

  try {
    // --- Equipo: su horario para presentaciones (todos los días, 9 a 13) y su sala ---------
    await page.goto(`${ADMIN}/team`)
    await expect(page.getByRole("heading", { level: 1, name: "Equipo" })).toBeVisible()
    const me = page.getByRole("listitem").filter({ hasText: user.email })
    await expect(me).toContainText("Sin horario para presentaciones: Kairós no le agenda")
    await me.getByRole("button", { name: "Horario y sala" }).click()
    const panel = surface(page, "Tu horario y tu sala")
    await expect(panel).toBeVisible()
    for (const day of ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"])
      await panel.getByRole("button", { name: `Agregar una franja el ${day}` }).click()
    await panel.getByLabel("Enlace de la sala (opcional)").fill(room)
    await shot(page, "equipo-horario-1366")
    await panel.getByRole("button", { name: "Guardar horario y sala" }).click()
    await expect(page.getByText("Guardado: Kairós ofrece presentaciones")).toBeVisible()
    await expect(me).toContainText("Presenta: Lun a dom, 9:00 a 13:00")
    await expect(me).toContainText("Con su sala de videollamada")
    const saved = await api<{ data: { meetingUrl: string | null; hours: unknown[] } }>(
      page,
      "GET",
      `/api/admin/access/team/${user.id}/schedule`,
      undefined,
    )
    expect(saved.body.data.meetingUrl).toBe(room)
    expect(saved.body.data.hours).toHaveLength(7)

    // --- Kairós: «Kairós responde solo en los chats», solo Administración ------------------
    await page.goto(`${ADMIN}/kairos`)
    const sells = page.getByRole("switch", { name: "Kairós responde solo en los chats" })
    await expect(sells).not.toBeChecked()
    await expect(
      page.getByText("Nunca ofrece descuentos. Se prende después de medirlo."),
    ).toBeVisible()
    await sells.click()
    await expect(page.getByText("Kairós responde solo en los chats de quien")).toBeVisible()
    await expect(sells).toBeChecked()
    await shot(page, "kairos-interruptor-1366")

    // --- Un WhatsApp de un número que no conocemos: «¿cuánto cuesta?» ----------------------
    const digits = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")
    const from = `51956${digits}`
    await postMeta(page, whatsappText(from, `wamid.precio-${tag}`, "Hola, ¿cuánto cuesta odentIA?"))
    const [chatRow] = await fixtureDb
      .select({ id: saasChat.id })
      .from(saasChat)
      .where(and(eq(saasChat.channel, "whatsapp"), eq(saasChat.address, `+${from}`)))
    const chatId = chatRow?.id ?? ""
    expect(chatId, "la conversación existe").not.toBe("")
    const kairosSaid = async () =>
      fixtureDb
        .select({ body: saasOutreach.body, status: saasOutreach.status })
        .from(saasOutreach)
        .where(and(eq(saasOutreach.chatId, chatId), eq(saasOutreach.byKairos, true)))
        .orderBy(asc(saasOutreach.createdAt))
    const waitKairos = async (count: number) => {
      try {
        await expect
          .poll(async () => (await kairosSaid()).length, { timeout: 120_000, intervals: [2_000] })
          .toBeGreaterThanOrEqual(count)
      } catch (error) {
        // Lo que dijo cada turno de Kairós, para saber por qué no respondió.
        const turns = await fixtureDb
          .select({ outcome: kairosChatTurn.outcome, why: kairosChatTurn.why })
          .from(kairosChatTurn)
          .where(eq(kairosChatTurn.chatId, chatId))
        throw new Error(`${String(error)}
Turnos de Kairós: ${JSON.stringify(turns)}`)
      }
      return (await kairosSaid())[count - 1]?.body ?? ""
    }
    const prices = await waitKairos(1)
    expect(prices).toContain("Hola, soy Kairós, el asistente de Sallca.")
    expect(prices).toContain(`Fundadores ${tag}`)
    expect(prices).toMatch(/— Kairós · odentIA$/)

    // --- Pide una presentación, dice su clínica, Kairós ofrece una hora y la confirma ------
    await postMeta(page, whatsappText(from, `wamid.demo-${tag}`, "Quiero una presentación"))
    expect(await waitKairos(2)).toContain("¿Cómo se llama tu clínica?")
    const clinic = `Dental Sur ${tag}`
    await postMeta(
      page,
      whatsappText(from, `wamid.clinica-${tag}`, `Mi clínica se llama ${clinic}`),
    )
    const offered = await waitKairos(3)
    expect(offered).toMatch(/Te propongo el .+ con .+\. ¿Te la confirmo\?/)
    await postMeta(page, whatsappText(from, `wamid.si-${tag}`, "Sí"))
    const confirmed = await waitKairos(4)
    expect(confirmed).toContain("Quedó agendada tu presentación de 45 minutos")
    expect(confirmed).toContain(room)
    const [linked] = await fixtureDb
      .select({ clientId: saasChat.clientId })
      .from(saasChat)
      .where(eq(saasChat.id, chatId))
    const clientId = linked?.clientId ?? ""
    expect(clientId, "la clínica que dijo quedó como cliente").not.toBe("")
    const [presentation] = await fixtureDb
      .select({ id: saasTask.id, assignee: saasTask.assigneeUserId, dueAt: saasTask.dueAt })
      .from(saasTask)
      .where(
        and(
          eq(saasTask.clientId, clientId),
          eq(saasTask.kind, "presentacion"),
          eq(saasTask.status, "abierta"),
        ),
      )
    expect(presentation?.assignee, "presenta quien tiene horario").toBe(user.id)
    const [contact] = await fixtureDb
      .select({ phone: saasClientContact.phone })
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, clientId))
    expect(contact?.phone).toBe(`+${from}`)

    // --- El cajón de la conversación: lo de Kairós con su nombre, y «Lo atiendo yo» --------
    await page.goto(`${ADMIN}/clients/${clientId}?tab=historial`)
    const history = page.getByRole("list", { name: "Historial del cliente" })
    await history
      .getByRole("button", { name: /Nos escribió por WhatsApp/ })
      .first()
      .click()
    const chat = surface(page, /^WhatsApp con /)
    await expect(chat).toBeVisible()
    await expect(chat).toContainText("Kairós atiende esta conversación")
    const kairosRow = chat.getByRole("listitem").filter({ hasText: "Hola, soy Kairós" })
    await expect(kairosRow).toContainText(/Kairós · \d\d:\d\d · Salió/)
    await expect(chat.getByRole("listitem").filter({ hasText: room })).toBeVisible()
    // Se puede escribir a mano igual: al enviar, quien escribe la atiende y Kairós se pausa.
    await expect(chat).toContainText("Si envías tú, lo atiendes tú y Kairós deja de responder")
    await expect(chat.getByLabel("Respuesta")).toBeVisible()
    await shot(page, "conversacion-kairos-1366")
    await chat.getByRole("button", { name: "Lo atiendo yo" }).click()
    await expect(page.getByText("Lo atiendes tú: Kairós no responde solo")).toBeVisible()
    await expect(chat).toContainText("Kairós está en pausa aquí")
    await expect(chat.getByRole("button", { name: "Devolver a Kairós" })).toBeVisible()
    await expect(chat.getByLabel("Respuesta")).toBeVisible()
    await shot(page, "conversacion-lo-atiendo-yo-1366")
    await postMeta(page, whatsappText(from, `wamid.despues-${tag}`, "¿Y cuánto cuesta el plan?"))
    // La pasada de Kairós corre cada 15 s tras 20 s de calma: un minuto basta para ver que no respondió.
    await page.waitForTimeout(60_000)
    expect(await kairosSaid(), "con «Lo atiendo yo», Kairós no responde").toHaveLength(4)

    // --- La presentación en la Venta: con quién, a qué hora y la sala -----------------------
    await page.goto(`${ADMIN}/clients/${clientId}?tab=venta`)
    await expect(page.getByRole("link", { name: "Entrar a la sala" }).first()).toBeVisible()
    await expect(page.getByText(/Presenta .+ · .*con su sala/).first()).toBeVisible()

    // --- Soporte: no ve el interruptor, el servidor se lo niega, y no cambia lo de otro ----
    const support = await createOwner("soporte")
    await fixtureDb.insert(adminStaff).values({ userId: support.user.id, role: "support" })
    await support.page.setViewportSize({ width: 1366, height: 900 })
    await enterAdmin(support.page, support.user.password)
    await support.page.goto(`${ADMIN}/kairos`)
    await expect(support.page.getByRole("heading", { level: 1 })).toBeVisible()
    await expect(support.page.getByRole("switch", { name: /Kairós responde solo/ })).toHaveCount(0)
    const denied = await api(support.page, "PUT", "/api/admin/kairos/sells", undefined, {
      enabled: false,
    })
    expect(denied.status).toBe(403)
    const notTheirs = await api(
      support.page,
      "PUT",
      `/api/admin/access/team/${user.id}/hours`,
      undefined,
      { hours: [] },
    )
    expect(notTheirs.status).toBe(403)
    // Lo suyo sí, desde Equipo: su horario a las mismas horas, para poder tomar la presentación.
    await support.page.goto(`${ADMIN}/team`)
    await expect(support.page.getByText("Tus presentaciones")).toBeVisible()
    await support.page.getByRole("button", { name: "Horario y sala" }).click()
    const mine = surface(support.page, "Tu horario y tu sala")
    for (const day of ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"])
      await mine.getByRole("button", { name: `Agregar una franja el ${day}` }).click()
    await mine.getByRole("button", { name: "Guardar horario y sala" }).click()
    await expect(support.page.getByText("Guardado: Kairós ofrece presentaciones")).toBeVisible()

    // --- Ausencias: una de días completos desde la pantalla (mañana, lo que viene puesto) ---
    await page.goto(`${ADMIN}/team`)
    await me.getByRole("button", { name: "Horario y sala" }).click()
    await expect(panel).toBeVisible()
    await panel.getByRole("button", { name: "Agregar ausencia" }).click()
    const add = surface(page, "Agregar ausencia")
    await expect(add).toBeVisible()
    await add.getByLabel("Motivo (opcional)").fill("Vacaciones")
    await shot(page, "equipo-ausencia-1366")
    await add.getByRole("button", { name: "Guardar ausencia" }).click()
    await expect(page.getByText(/Ausencia guardada|Choca con/).first()).toBeVisible()
    const vacation = panel.getByRole("listitem").filter({ hasText: "Vacaciones" })
    await expect(vacation).toBeVisible()
    await shot(page, "equipo-con-ausencia-1366")
    await vacation.getByRole("button", { name: /^Quitar la ausencia/ }).click()
    await expect(page.getByText("Ausencia quitada")).toBeVisible()
    await expect(vacation).toHaveCount(0)

    // --- Una ausencia que cae justo en la presentación: lo dice y queda en Hoy -------------
    const startsAt = new Date((presentation?.dueAt ?? new Date()).getTime() - 30 * 60_000)
    const endsAt = new Date(startsAt.getTime() + 2 * 3_600_000)
    const absence = await api<{ data: { conflicts: unknown[] } }>(
      page,
      "POST",
      `/api/admin/access/team/${user.id}/absences`,
      undefined,
      { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), reason: "Médico" },
    )
    expect(absence.status).toBe(201)
    expect(absence.body.data.conflicts).toHaveLength(1)

    await page.goto(`${ADMIN}/`)
    const clash = page
      .getByRole("listitem")
      .filter({ hasText: /presentaci(ón|ones) de .+ ca(e|en) en su ausencia/ })
      .filter({ hasText: clinic })
    await expect(clash).toBeVisible()
    const passTo = clash.getByRole("button", { name: /^Pasar a / })
    await expect(passTo).toBeVisible()
    await expect(clash.getByRole("button", { name: "Pedir otra hora" })).toBeVisible()
    await clash.scrollIntoViewIfNeeded()
    await shot(page, "hoy-ausencia-1366")

    // --- A 390 px: Equipo, el interruptor, la conversación y Hoy sin desbordarse -----------
    await page.setViewportSize({ width: 390, height: 844 })
    await expectNoSideScroll(page, "Hoy")
    await clash.scrollIntoViewIfNeeded()
    await shot(page, "hoy-ausencia-390")
    await page.goto(`${ADMIN}/team`)
    await expectNoSideScroll(page, "Equipo")
    await me.getByRole("button", { name: "Horario y sala" }).click()
    await expect(panel).toBeVisible()
    await expectNoSideScroll(page, "Horario y sala")
    await shot(page, "equipo-horario-390")
    await page.goto(`${ADMIN}/kairos`)
    await expect(sells).toBeVisible()
    await expectNoSideScroll(page, "Kairós")
    await shot(page, "kairos-interruptor-390")
    await page.goto(`${ADMIN}/clients/${clientId}?tab=historial`)
    await history
      .getByRole("button", { name: /WhatsApp/ })
      .first()
      .click()
    await expect(chat).toBeVisible()
    await expectNoSideScroll(page, "Conversación")
    await shot(page, "conversacion-kairos-390")

    // «Pasar a…» la cambia de persona: deja de chocar y sale de Hoy.
    await page.setViewportSize({ width: 1366, height: 900 })
    await page.goto(`${ADMIN}/`)
    await clash.getByRole("button", { name: /^Pasar a / }).click()
    await expect(page.getByText(/^Pasó a /)).toBeVisible()
    const [moved] = await fixtureDb
      .select({ assignee: saasTask.assigneeUserId })
      .from(saasTask)
      .where(eq(saasTask.id, presentation?.id ?? ""))
    expect(moved?.assignee).toBe(support.user.id)
  } finally {
    // El interruptor es de toda la administración: los demás recorridos lo esperan apagado.
    await api(page, "PUT", "/api/admin/kairos/sells", undefined, { enabled: false })
    await fixtureDb.delete(saasPlan).where(eq(saasPlan.code, planCode))
  }
})
