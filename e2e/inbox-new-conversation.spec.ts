import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Bandeja conectada (fase 2, tablero 3): «Nueva conversación» busca por nombre
 * o teléfono, crea a la persona con su número y abre su WhatsApp sin escribir
 * «wa:»; como nunca escribió, el hilo dice qué hace falta para empezar.
 * «Contexto» dice su próxima cita y lo que aceptó recibir, y ofrece reservarle
 * aunque aún no sea paciente. Sin proveedor: nada de esto acredita que
 * WhatsApp entregue un mensaje.
 */

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test("«Nueva conversación»: crea a la persona con su número, abre su WhatsApp y «Contexto» ofrece reservarle", async ({ owner, fixtureDb }, info) => {
  const { page, org, branchId } = owner
  await call(page, "POST", "/api/channels/connections", org.slug, {
    channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA E2E",
    config: { phoneNumberId: "E2E-PNID-NC", wabaId: "E2E-WABA", accessToken: "e2e", appSecret: "e2e-secret", templates: [] },
  }, 201)
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/inbox"))

  // --- Buscar por teléfono: no existe, se crea con su número ---
  await page.getByRole("button", { name: "Nueva conversación", exact: true }).first().click()
  const dialog = page.getByRole("dialog", { name: "Nueva conversación" })
  await dialog.getByPlaceholder("Buscar por nombre o teléfono").fill("987 654 321")
  await expect(dialog).toContainText("Nadie coincide con «987 654 321».")
  await dialog.getByRole("button", { name: /Crear contacto con 987 654 321/ }).click()
  await dialog.getByLabel("Nombre", { exact: true }).fill("Rosa Quispe")
  await info.attach("nueva-conversacion-crear", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await dialog.getByRole("button", { name: "Crear y escribirle", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/inbox\?conversation=/)
  const conversationId = new URL(page.url()).searchParams.get("conversation") ?? ""
  const detail = await call<{ contact: { id: string; displayName: string }; connection: { channel: string } }>(
    page, "GET", `/api/conversations/${conversationId}`, org.slug,
  )
  expect(detail).toMatchObject({ contact: { displayName: "Rosa Quispe" }, connection: { channel: "whatsapp" } })

  // Nunca escribió: el hilo dice qué falta para empezar y a quien configura le ofrece ir a los mensajes.
  // Se dice una sola vez que nunca escribió; el motivo de que no haya mensaje va aparte, con su acción.
  await expect(page.getByRole("status").filter({ hasText: "todavía no escribió por aquí" })).toHaveCount(1)
  await expect(page.getByRole("status").filter({ hasText: "Rosa Quispe todavía no escribió por aquí." })).toBeVisible()
  const none = page.getByRole("status").filter({ hasText: "para escribirle primero hace falta un mensaje aprobado" })
  await expect(none).toBeVisible()
  await expect(none.getByRole("link", { name: "Ver los mensajes", exact: true })).toBeVisible()

  // --- «Contexto»: próxima cita, permisos de mensajes y «Reservar cita» para quien aún no es paciente ---
  const context = page.getByRole("region", { name: "Contexto del contacto" })
  await expect(context).toContainText("Próxima cita")
  await expect(context).toContainText("Ninguna")
  await expect(context).toContainText("Novedades y promociones: aún no se le preguntó")
  await expect(context.getByRole("link", { name: "Reservar cita", exact: true })).toHaveAttribute("href", new RegExp(`contactId=${detail.contact.id}`))
  await expect(context).toContainText("todavía no es paciente")
  // Su número con el formato de toda la aplicación, en la cabecera y en Canales; nunca «wa:».
  await expect(context).toContainText("+51 987 654 321")
  await expect(context.getByRole("listitem").filter({ hasText: "WhatsApp" }).filter({ hasText: "+51 987 654 321" })).toHaveCount(1)
  await expect(context).not.toContainText("wa:")
  await expect(context).not.toContainText("+51987654321")
  // «Tomar», «Devolver al agente» y «Resolver» solo en la cabecera del hilo.
  await expect(context.getByRole("button", { name: /^(Tomar|Devolver al agente|Resolver)$/ })).toHaveCount(0)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("hilo-nuevo-con-contexto", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // --- La Bandeja la encuentra por su teléfono ---
  await gotoHydrated(page, tenant(org.slug, "/inbox?q=987654321"))
  await expect(page.getByRole("button", { name: /Rosa Quispe/ }).first()).toBeVisible()

  // --- Escribirle otra vez abre la misma conversación ---
  const again = await api<{ data: { conversationId: string; identityCreated: boolean } }>(page, "POST", `/api/contacts/${detail.contact.id}/write`, org.slug, {})
  expect(again.status).toBe(200)
  expect(again.body.data).toMatchObject({ conversationId, identityCreated: false })

  // --- Recepción le reserva aunque la clínica pida más datos: su ficha nace con lo mínimo ---
  // La clínica publica su registro (exige la fecha de nacimiento) y atiende todos los días de 09:00 a 13:00.
  const registration = await call<{ version: number; fields: Record<string, string> }>(page, "GET", "/api/patient-registration/config", org.slug)
  expect(registration.fields.birthDate).toBe("required")
  await call(page, "PUT", "/api/patient-registration/config", org.slug, {
    expectedVersion: registration.version, enabled: false, fields: registration.fields, privacyNotice: "Aviso de prueba.",
  })
  await call(page, "POST", "/api/agenda/chairs", org.slug, { branchId, name: "Unidad dental 1" }, 201)
  await call(page, "PUT", "/api/agenda/schedules", org.slug, {
    branchId, dentistUserId: owner.user.id,
    rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
  })
  await fixtureDb.update(member).set({ role: "reception" }).where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  await page.getByRole("region", { name: "Contexto del contacto" }).getByRole("link", { name: "Reservar cita", exact: true }).click()
  await expect(page.getByText("Rosa Quispe todavía no es paciente")).toBeVisible()
  await page.getByRole("button", { name: "Semana siguiente" }).click()
  await page.getByRole("button", { name: /^Registrar y reservar / }).click()
  // Al guardar vuelve al hilo; no hace falta registrarla antes en Pacientes.
  await expect(page).toHaveURL(new RegExp(`/inbox\\?conversation=${conversationId}`))
  await expect(page.getByText(/No se pudo registrar/)).toHaveCount(0)
  const [registered] = await call<{ id: string; displayName: string }[]>(page, "GET", "/api/patients?q=Rosa&limit=5", org.slug)
  expect(registered?.displayName).toBe("Rosa Quispe")
  const ficha = await call<{ patient: { birthDate: string | null; identityNeedsReview: boolean } }>(page, "GET", `/api/patients/${registered!.id}`, org.slug)
  expect(ficha.patient).toMatchObject({ birthDate: null, identityNeedsReview: true })
  // Su página lo dice con su acción: lo que la clínica pide y falta, y confirmar la identidad.
  await gotoHydrated(page, tenant(org.slug, `/people/${detail.contact.id}`))
  const pendingRow = page.getByText("Faltan datos para atenderla").first()
  await expect(pendingRow).toBeVisible()
  await expect(page.getByText("Fecha de nacimiento. Confirma sus apellidos.")).toBeVisible()
  await info.attach("persona-ficha-minima", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // --- Odontología escribe a las personas, pero no lee el CRM: sin «Contexto» ni «Nueva conversación» ---
  await fixtureDb.update(member).set({ role: "dentist" }).where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  await expect(page.getByText("Rosa Quispe").first()).toBeVisible()
  await expect(page.getByRole("button", { name: "Nueva conversación", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Contexto", exact: true })).toHaveCount(0)
  expect((await api(page, "GET", `/api/crm/contacts/${detail.contact.id}/context`, org.slug)).status).toBe(403)
})
