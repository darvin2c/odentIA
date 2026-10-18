import { randomUUID } from "node:crypto"
import { channelTemplate, conversation, message } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { simulateWhatsAppInbound } from "./channels"
import { API, tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Con la ventana de WhatsApp cerrada, la zona de escritura muestra los
 * mensajes aprobados para retomar. Esa zona no puede comerse el hilo: quien
 * atiende tiene que ver lo que la persona escribió antes de elegir qué
 * enviarle, en la computadora y en el celular. Antes el historial quedaba con
 * 0 px de alto. Sin proveedor: no acredita que WhatsApp entregue nada.
 */

const MESSAGES = [
  "Hola, quisiera una cita",
  "Es para una limpieza",
  "¿Tienen algo el sábado en la mañana?",
  "Gracias, quedo atenta",
]

test("con la ventana cerrada, los mensajes aprobados no tapan lo que la persona escribió", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  const wa = await call<{ id: string }>(page, "POST", "/api/channels/connections", org.slug, {
    channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA E2E",
    config: { phoneNumberId: "E2E-PNID-HIST", wabaId: "E2E-WABA", accessToken: "e2e", appSecret: "e2e-secret", templates: [] },
  }, 201)
  for (const text of MESSAGES) {
    expect(await simulateWhatsAppInbound(page, API, wa.id, "e2e-secret", {
      from: "51922200001", phoneNumberId: "E2E-PNID-HIST", text, wamid: `wamid.${randomUUID()}`,
    })).toBe(200)
  }
  const last = MESSAGES.at(-1)!
  const find = async () =>
    (await call<Array<{ id: string; preview: { body: string | null } | null }>>(page, "GET", "/api/conversations?status=open", org.slug))
      .find((c) => c.preview?.body === last)
  await expect.poll(async () => (await find())?.id ?? "", { timeout: 30_000 }).not.toBe("")
  const conversationId = (await find())!.id

  // Escribió hace dos días: la ventana de 24 horas está cerrada.
  const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000)
  const written = await fixtureDb.select({ id: message.id, body: message.body }).from(message).where(eq(message.conversationId, conversationId))
  for (const row of written) {
    // Un minuto entre mensaje y mensaje, en el orden en que los escribió.
    const minutesBefore = MESSAGES.length - 1 - MESSAGES.indexOf(row.body ?? "")
    await fixtureDb.update(message).set({ createdAt: new Date(twoDaysAgo.getTime() - minutesBefore * 60_000) }).where(eq(message.id, row.id))
  }
  await fixtureDb.update(conversation).set({ lastInboundAt: twoDaysAgo, lastMessageAt: twoDaysAgo }).where(eq(conversation.id, conversationId))
  // Varios mensajes aprobados en la cuenta, para que la lista sea larga.
  await fixtureDb.insert(channelTemplate).values(
    ["retomar_a", "retomar_b", "retomar_c", "retomar_d"].map((name) => ({
      organizationId: org.id, connectionId: wa.id, name, language: "es", status: "aprobada",
      body: "Hola, {{1}}. Te escribimos de la clínica para retomar tu consulta. ¿Seguimos por aquí?", variables: 1,
    })),
  )

  for (const [label, size] of [["computadora", { width: 1440, height: 900 }], ["celular", { width: 375, height: 812 }]] as const) {
    await page.setViewportSize(size)
    await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
    await expect(page.getByText("Elige el mensaje", { exact: true })).toBeVisible()
    // Lo último que escribió está a la vista, sin desplazar nada.
    // En la computadora el texto también está en la fila de la lista; en el hilo va después.
    const lastSaid = page.getByText(last, { exact: true }).last()
    await expect(lastSaid).toBeInViewport()
    // El botón se alcanza desplazando la zona de escritura, y el historial sigue a la vista.
    const send = page.getByRole("button", { name: "Enviar mensaje", exact: true })
    await send.scrollIntoViewIfNeeded()
    await expect(send).toBeInViewport()
    await expect(lastSaid).toBeInViewport()
    // Un mensaje de otro día dice cuándo, no solo la hora.
    const stamp = page.locator("time[datetime]").filter({ hasText: /\d/ }).last()
    await expect(stamp).toHaveAttribute("title", /\d{4}/)
    expect(await stamp.textContent()).not.toMatch(/^\s*\d{1,2}:\d{2}\s*(a|p)\.\s?m\.\s*$/)
    await info.attach(`ventana-cerrada-${label}`, { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  }
})
