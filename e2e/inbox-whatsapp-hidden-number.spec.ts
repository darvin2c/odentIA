import { randomUUID } from "node:crypto"
import { contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { simulateWhatsAppInbound } from "./channels"
import { API, tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Quien usa nombre de usuario en WhatsApp puede ocultar su número: Meta manda
 * solo su BSUID (ADR 0110). Antes la conversación quedaba en «wa:undefined» y
 * la respuesta no salía. Sin proveedor: no acredita que WhatsApp entregue nada.
 */

const PNID = "E2E-PNID-BSUID"
const BSUID = "PE.13491208655302741918"
const PHONE = "51922200077"

test("quien oculta su número entra por su BSUID, sigue en su hilo cuando llega su número, y la Bandeja dice por qué no salió una respuesta", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  const wa = await call<{ id: string }>(page, "POST", "/api/channels/connections", org.slug, {
    channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA E2E",
    config: { phoneNumberId: PNID, wabaId: "E2E-WABA", accessToken: "e2e", appSecret: "e2e-secret", templates: [] },
  }, 201)
  expect(await simulateWhatsAppInbound(page, API, wa.id, "e2e-secret", {
    userId: BSUID, name: "Cyndy E2E", phoneNumberId: PNID, text: "Quisiera agendar una cita", wamid: `wamid.${randomUUID()}`,
  })).toBe(200)
  const find = async () =>
    (await call<Array<{ id: string; preview: { body: string | null } | null }>>(page, "GET", "/api/conversations?status=open", org.slug))
      .find((c) => c.preview?.body === "Quisiera agendar una cita")
  await expect.poll(async () => (await find())?.id ?? "", { timeout: 30_000 }).not.toBe("")
  const conversationId = (await find())!.id
  const threadOf = async () => (await fixtureDb.select().from(conversation).where(eq(conversation.id, conversationId)))[0]!
  expect((await threadOf()).externalThreadId).toBe(`wa:${BSUID}`)

  // La respuesta sale hacia su BSUID; aquí Meta la rechaza con su error.
  const reply = await call<{ id: string }>(page, "POST", `/api/conversations/${conversationId}/messages`, org.slug, { text: "Tengo estos horarios" }, 201)
  await expect.poll(async () => (await fixtureDb.select({ status: message.status }).from(message).where(eq(message.id, reply.id)))[0]?.status, { timeout: 30_000 }).not.toBe("queued")
  await fixtureDb.update(message).set({ status: "failed", error: "WhatsApp send falló: 400 (#131009) Parameter value is not valid" }).where(eq(message.id, reply.id))

  // Después Meta manda su número junto al BSUID: misma persona, mismo hilo, ahora por su número.
  expect(await simulateWhatsAppInbound(page, API, wa.id, "e2e-secret", {
    from: PHONE, userId: BSUID, name: "Cyndy E2E", phoneNumberId: PNID, text: "¿Me confirman?", wamid: `wamid.${randomUUID()}`,
  })).toBe(200)
  await expect.poll(async () => (await fixtureDb.select({ id: message.id }).from(message).where(eq(message.conversationId, conversationId))).length, { timeout: 30_000 }).toBe(3)
  const thread = await threadOf()
  expect(thread.externalThreadId).toBe(`wa:${PHONE}`)
  expect(await fixtureDb.select({ externalUserId: contactIdentity.externalUserId, providerUserId: contactIdentity.providerUserId }).from(contactIdentity).where(eq(contactIdentity.contactId, thread.contactId)))
    .toEqual([{ externalUserId: `wa:${PHONE}`, providerUserId: BSUID }])

  for (const [label, size] of [["computadora", { width: 1440, height: 900 }], ["celular", { width: 375, height: 812 }]] as const) {
    await page.setViewportSize(size)
    await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
    await expect(page.getByText("¿Me confirman?", { exact: true }).last()).toBeVisible()
    // El motivo se dice en palabras; el de Meta, en inglés, no es para la clínica.
    await expect(page.getByText(/^No se entregó: el canal no lo aceptó\./)).toBeVisible()
    await expect(page.getByText(/Parameter value/)).toHaveCount(0)
    await info.attach(`sin-numero-${label}`, { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  }
})
