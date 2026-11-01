import { randomUUID } from "node:crypto"
import { member, user } from "@odentia/db/schema/auth"
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
  await dialog.getByRole("button", { name: /Crear persona con 987 654 321/ }).click()
  // Como «Nuevo contacto» (`createPerson`): nombres y apellidos, dos campos.
  await dialog.getByLabel("Nombres", { exact: true }).fill("Rosa")
  await dialog.getByLabel("Apellidos", { exact: true }).fill("Quispe")
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

  // --- «Contexto»: se pide, y entra a cada sección sin salir de la Bandeja ---
  await page.getByRole("button", { name: "Contexto", exact: true }).click()
  const context = page.getByRole("region", { name: "Contexto del contacto" })
  await expect(context.getByRole("button", { name: /^Citas/ })).toContainText("Sin próxima cita")
  // Su número con el formato de toda la aplicación; nunca «wa:».
  await expect(context).toContainText("+51 987 654 321")
  await expect(context).not.toContainText("wa:")
  await expect(context).not.toContainText("+51987654321")
  // Quien aún no es paciente no tiene plan ni clínica.
  await expect(context.getByRole("button", { name: /^Plan y presupuesto/ })).toHaveCount(0)
  await context.getByRole("button", { name: /^Datos/ }).click()
  await expect(context).toContainText("Novedades y promociones: aún no se le preguntó")
  // Con teclado no se pierde: entrar lleva al título de la sección; volver, a la fila de la que salió.
  await expect(context.getByRole("heading", { name: "Datos", exact: true })).toBeFocused()
  await context.getByRole("button", { name: "Volver al contexto" }).click()
  await expect(context.getByRole("button", { name: /^Datos/ })).toBeFocused()
  await context.getByRole("button", { name: /^Citas/ }).click()
  // Un solo «Reservar cita», que reserva al lado sin salir del hilo.
  await expect(context.getByRole("button", { name: "Reservar cita", exact: true })).toHaveCount(1)
  await expect(context.getByRole("link", { name: "Reservar cita" })).toHaveCount(0)
  await expect(context).toContainText("todavía no es paciente")
  await expect(page).toHaveURL(new RegExp(`/inbox\\?conversation=${conversationId}`))
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("hilo-nuevo-con-contexto", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // --- La Bandeja la encuentra por su teléfono ---
  await gotoHydrated(page, tenant(org.slug, "/inbox?q=987654321"))
  // Buscando, la lista recorre toda la Bandeja: no hay que adivinar en qué pestaña está.
  await expect(page.getByRole("tab", { name: /^Todas/ })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("button", { name: /Rosa Quispe/ }).first()).toBeVisible()
  await expect(page.getByRole("searchbox", { name: /Nombre, teléfono/ })).toHaveValue("987654321")

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
  await call(page, "POST", "/api/agenda/rooms", org.slug, { branchId, name: "Unidad dental 1" }, 201)
  const professional = randomUUID()
  await fixtureDb.insert(user).values({ id: professional, name: "Dra. Agenda", email: `${professional}@example.test`, emailVerified: true })
  await fixtureDb.insert(member).values({ id: randomUUID(), organizationId: org.id, userId: professional, role: "clinician", createdAt: new Date() })
  await call(page, "PUT", "/api/agenda/schedules", org.slug, {
    branchId, professionalUserId: professional,
    rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
  })
  await fixtureDb.update(member).set({ role: "reception" }).where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  const reception = page.getByRole("region", { name: "Contexto del contacto" })
  await reception.getByRole("button", { name: /^Citas/ }).click()
  await reception.getByRole("button", { name: "Reservar cita", exact: true }).click()
  // «Nueva cita» se abre al lado: la Bandeja sigue detrás, con el mismo hilo.
  await expect(page).toHaveURL(new RegExp(`/inbox\\?conversation=${conversationId}`))
  await expect(page.getByText("Rosa Quispe todavía no es paciente")).toBeVisible()
  await page.getByRole("button", { name: "Semana siguiente" }).click()
  // La pregunta de novedades y promociones no se salta: recepción anota lo que respondió.
  await page.getByRole("group", { name: /^¿Acepta recibir novedades y promociones( de .+)? por WhatsApp\?$/ }).getByRole("button", { name: "No aceptó" }).click()
  await page.getByRole("button", { name: /^Registrar y reservar / }).click()
  // Al guardar sigue en el hilo; no hace falta registrarla antes en Pacientes.
  await expect(page).toHaveURL(new RegExp(`/inbox\\?conversation=${conversationId}`))
  await expect(page.getByText(/No se pudo registrar/)).toHaveCount(0)
  // Reservar no navega: se espera a que quede guardada (la cita aparece en su Contexto, ya como paciente).
  await expect(reception.getByRole("button", { name: "Ver la cita", disabled: false })).toBeVisible()
  await expect(reception.getByRole("button", { name: "Reservar cita", exact: true })).toHaveCount(1)
  const [registered] = await call<{ id: string; displayName: string }[]>(page, "GET", "/api/patients?q=Rosa&limit=5", org.slug)
  expect(registered?.displayName).toBe("Rosa Quispe")
  const ficha = await call<{ patient: { birthDate: string | null; identityNeedsReview: boolean } }>(page, "GET", `/api/patients/${registered!.id}`, org.slug)
  expect(ficha.patient).toMatchObject({ birthDate: null, identityNeedsReview: false })
  // Su página lo dice con su acción: lo que la clínica pide y falta (los apellidos ya los dio al crearla).
  await gotoHydrated(page, tenant(org.slug, `/people/${detail.contact.id}`))
  const pendingRow = page.getByText("Faltan datos para atenderla").first()
  await expect(pendingRow).toBeVisible()
  await expect(page.getByText("Fecha de nacimiento.", { exact: true })).toBeVisible()
  await info.attach("persona-ficha-minima", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // --- Odontología no lee el CRM: sin «Nueva conversación»; de quien ya es paciente, su «Contexto» sin lo comercial ---
  await fixtureDb.update(member).set({ role: "clinician" }).where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  await expect(page.getByText("Rosa Quispe").first()).toBeVisible()
  await expect(page.getByRole("button", { name: "Nueva conversación", exact: true })).toHaveCount(0)
  const clinical = page.getByRole("region", { name: "Contexto del contacto" })
  await expect(clinical.getByRole("button", { name: /^Clínica/ })).toBeVisible()
  await expect(clinical.getByRole("button", { name: /^Oportunidades y tareas/ })).toHaveCount(0)
  expect((await api(page, "GET", `/api/crm/contacts/${detail.contact.id}/context`, org.slug)).status).toBe(403)
  const lines = await call<{ lines: Record<string, string> }>(page, "GET", `/api/conversations/${conversationId}/context`, org.slug)
  expect(lines.lines).not.toHaveProperty("ventas")
  expect(lines.lines).not.toHaveProperty("recuerda")
})

test("«Contexto» de quien lleva a un paciente: la cita que anuncia la fila también se ve al entrar", async ({ owner }) => {
  const { page, org, branchId } = owner
  await call(page, "POST", "/api/channels/connections", org.slug, {
    channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA E2E",
    config: { phoneNumberId: "E2E-PNID-LLEVA", wabaId: "E2E-WABA", accessToken: "e2e", appSecret: "e2e-secret", templates: [] },
  }, 201)
  // La madre escribe y no es paciente; su hijo sí, con cita la semana que viene.
  const mother = await call<{ id: string }>(page, "POST", "/api/people", org.slug, { givenNames: "Marta", familyName: "Salas", phone: "+51987654101" }, 201)
  const { conversationId } = await call<{ conversationId: string }>(page, "POST", `/api/contacts/${mother.id}/write`, org.slug, {})
  const son = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: randomUUID(),
    answers: { demographics: { displayName: "Lucas Salas", docType: "DNI", docNumber: "45678901" }, respondent: "staff", privacyAccepted: false },
  }, 201)
  await call(page, "PUT", `/api/patients/${son.id}/contacts/${mother.id}`, org.slug, { relationship: "guardian", isPreferred: false })
  const room = await call<{ id: string }>(page, "POST", "/api/agenda/rooms", org.slug, { branchId, name: "Unidad dental 1" }, 201)
  await call(page, "PUT", "/api/agenda/schedules", org.slug, {
    branchId, professionalUserId: owner.user.id,
    rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
  })
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  await call(page, "POST", "/api/appointments", org.slug, {
    patientId: son.id, professionalUserId: owner.user.id, roomId: room.id,
    // 15:00 en UTC son las 10:00 en Lima.
    startsAt: `${date}T15:00:00.000Z`, endsAt: `${date}T15:30:00.000Z`, reason: "Control",
  }, 201)

  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${conversationId}`))
  await page.getByRole("button", { name: "Contexto", exact: true }).click()
  const context = page.getByRole("region", { name: "Contexto del contacto" })
  await expect(context.getByRole("button", { name: /^Citas/ })).toContainText("Lucas Salas")
  await context.getByRole("button", { name: /^Citas/ }).click()

  // Se ve la cita del hijo, cada reserva bajo el nombre de quien la recibe, y sin salir de la Bandeja.
  await expect(context.getByRole("heading", { name: "Lucas Salas", exact: true })).toBeVisible()
  await expect(context.getByRole("button", { name: "Ver la cita", exact: true })).toHaveCount(1)
  await expect(context.getByRole("heading", { name: "Marta Salas", exact: true })).toBeVisible()
  await expect(context).toContainText("Marta todavía no es paciente")
  await expect(page).toHaveURL(new RegExp(`/inbox\\?conversation=${conversationId}`))
})
