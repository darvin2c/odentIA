import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { member } from "@odentia/db/schema/auth"
import { patient, patientPayment } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import type { Page, TestInfo } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant, tenantPattern } from "./env"
import { api, call, expect, test, type OwnerFixture } from "./fixtures"
import { gotoHydrated } from "./hydration"

async function observe(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await info.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
}

/** Un instante a media mañana (Lima) de un mes contado hacia atrás desde el mes en curso de la clínica. */
function inMonth(monthsBack: number, day: number, hour = 15): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  return new Date(Date.UTC(get("year"), get("month") - 1 - monthsBack, day, hour))
}

/** Dos meses de actividad real y aislada: citas, cobros y conversaciones. Ningún envío externo. */
async function twoMonths(db: Db, owner: OwnerFixture) {
  const organizationId = owner.org.id
  const chairId = randomUUID()
  await db.insert(scheduleChair).values({ id: chairId, organizationId, branchId: owner.branchId, name: "Sillón de prueba" })
  const people: Record<string, string> = {}
  for (const [index, name] of ["Ana Paz", "Bruno Díaz", "Carla Soto", "Diego Ruiz", "Elena Mora"].entries()) {
    people[name] = randomUUID()
    await db.insert(patient).values({ id: people[name], organizationId, displayName: name, patientNumber: index + 1 })
  }
  const visit = (name: string, startsAt: Date, status: string, source = "recepcion") =>
    db.insert(appointment).values({
      organizationId, branchId: owner.branchId, patientId: people[name]!, chairId, dentistUserId: owner.user.id,
      serviceName: "Evaluación", startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status, source,
    })
  // Mes pasado: tres atendidas, una inasistencia y una cancelación.
  await visit("Ana Paz", inMonth(1, 10), "atendida")
  await visit("Bruno Díaz", inMonth(1, 11), "atendida", "agente")
  await visit("Carla Soto", inMonth(1, 12), "atendida", "enlace")
  await visit("Diego Ruiz", inMonth(1, 13), "no_asistio")
  await visit("Elena Mora", inMonth(1, 14), "cancelada")
  // El mes anterior: dos atendidas y una inasistencia.
  await visit("Ana Paz", inMonth(2, 10), "atendida")
  await visit("Diego Ruiz", inMonth(2, 11), "atendida")
  await visit("Bruno Díaz", inMonth(2, 12), "no_asistio")
  // Quien faltó ya tiene otra cita por venir.
  await visit("Diego Ruiz", new Date(Date.now() + 7 * 86_400_000), "programada")

  await db.insert(patientPayment).values([
    { organizationId, patientId: people["Ana Paz"]!, branchId: owner.branchId, amountCents: 30000, currency: "PEN", paidAt: inMonth(1, 10, 16), method: "efectivo", methodName: "Efectivo", methodTypeCode: "10" },
    { organizationId, patientId: people["Ana Paz"]!, branchId: owner.branchId, amountCents: 20000, currency: "PEN", paidAt: inMonth(2, 10, 16), method: "efectivo", methodName: "Efectivo", methodTypeCode: "10" },
  ])

  const contactId = randomUUID()
  const channelId = randomUUID()
  await db.insert(contact).values({ id: contactId, organizationId, displayName: "Interlocutor" })
  await db.insert(channelConnection).values({ id: channelId, organizationId, channel: "whatsapp", provider: "prueba", displayName: "Canal controlado", configEncrypted: "no-se-usa", webhookSecret: "no-se-usa" })
  for (const [monthsBack, seconds] of [[1, 120], [2, 240]] as const) {
    const conversationId = randomUUID()
    const inboundAt = inMonth(monthsBack, 15)
    const sentAt = new Date(inboundAt.getTime() + seconds * 1000)
    await db.insert(conversation).values({ id: conversationId, organizationId, contactId, channelConnectionId: channelId, externalThreadId: randomUUID() })
    await db.insert(message).values([
      { organizationId, conversationId, direction: "in", senderKind: "contact", status: "received", createdAt: inboundAt },
      { organizationId, conversationId, direction: "out", senderKind: "user", status: "sent", externalId: `proveedor-${randomUUID()}`, createdAt: sentAt, sentAt },
    ])
  }
}

for (const width of [1440, 390]) {
  test.describe(`Reportes a ${width}px`, () => {
    test("una cifra por pregunta, un periodo para toda la pantalla y la lista detrás de una cifra", async ({ owner, fixtureDb }, info) => {
      await twoMonths(fixtureDb, owner)
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      await gotoHydrated(page, tenant(owner.org.slug, "/reports?period=mes_pasado"))

      const questions = page.getByRole("navigation", { name: "Preguntas" })
      await expect(questions.getByRole("link")).toHaveCount(4)
      // Cada cifra se compara con el mes anterior, con palabras.
      await expect(questions.getByRole("link", { name: /^Agenda/ })).toContainText("3")
      await expect(questions.getByRole("link", { name: /^Agenda/ })).toContainText(/50 % más que en/)
      await expect(questions.getByRole("link", { name: /^Atención/ })).toContainText(/2 min menos que en/)
      await expect(page.getByText(/^Comparado con /)).toBeVisible()

      // Dinero: lo cobrado del mes pasado frente al anterior.
      await expect(page.getByRole("heading", { name: "Dinero", exact: true })).toBeVisible()
      await expect(page.getByText(/50 % más que en/).first()).toBeVisible()
      await expect(page.getByRole("heading", { name: "Cobrado por medio de pago" })).toBeVisible()
      await observe(page, info, "dinero")

      // Agenda: los grupos suman el total.
      await questions.getByRole("link", { name: /^Agenda/ }).click()
      await expect(page).toHaveURL(/tab=agenda/)
      await expect(page.getByRole("heading", { name: /^De 5 citas de / })).toBeVisible()
      await expect(page.getByRole("heading", { name: "Cómo se reservaron" })).toBeVisible()
      await observe(page, info, "agenda")

      // La cifra abre su lista, con tantas filas como dice, y al cerrar devuelve el foco.
      const seeWho = page.getByRole("button", { name: "Ver quiénes" })
      await seeWho.click()
      await expect(page).toHaveURL(/lista=no_show/)
      const list = page.getByRole(width === 390 ? "dialog" : "region", { name: "No asistieron" }).or(page.getByRole("dialog", { name: "No asistieron" })).first()
      await expect(list.getByRole("link", { name: "Diego Ruiz" })).toBeVisible()
      await expect(list.getByText("Ya tiene otra cita")).toBeVisible()
      await expect(list.getByText("Cómo se calcula")).toBeVisible()
      await observe(page, info, "lista")
      await page.keyboard.press("Escape")
      await expect(page).not.toHaveURL(/lista=/)

      // Pacientes y ventas, y Atención.
      await questions.getByRole("link", { name: /^Pacientes y ventas/ }).click()
      await expect(page.getByRole("button", { name: "Ver los 2 pacientes nuevos" })).toBeVisible()
      await observe(page, info, "ventas")
      await questions.getByRole("link", { name: /^Atención/ }).click()
      await expect(page.getByRole("heading", { name: "Quién respondió primero" })).toBeVisible()
      await observe(page, info, "atencion")

      // Cambiar el periodo cambia toda la pantalla; con varios meses aparecen las barras y su tabla.
      await questions.getByRole("link", { name: /^Dinero/ }).click()
      await page.getByRole("button", { name: /^Periodo: / }).click()
      await observe(page, info, "periodo")
      await page.getByRole("button", { name: /^Últimos 3 meses/ }).click()
      await expect(page).toHaveURL(/period=ultimos_3_meses/)
      await expect(page.getByRole("heading", { name: "Cobrado y gastado por mes" })).toBeVisible()
      await page.getByRole("button", { name: "Ver como tabla" }).click()
      await expect(page.getByRole("columnheader", { name: "Cobrado" })).toBeVisible()
      await observe(page, info, "varios-meses")
    })

    test("el asesor acompaña a la cifra que empeoró y abre su recomendación", async ({ owner, fixtureDb }, info) => {
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      const organizationId = owner.org.id
      const chairId = randomUUID()
      const patientId = randomUUID()
      await fixtureDb.insert(scheduleChair).values({ id: chairId, organizationId, branchId: owner.branchId, name: "Sillón de prueba" })
      await fixtureDb.insert(patient).values({ id: patientId, organizationId, displayName: "Gabriel Núñez", patientNumber: 1 })
      // Faltó hace veinte minutos y no tiene otra cita.
      const startsAt = new Date(Date.now() - 20 * 60_000)
      await fixtureDb.insert(appointment).values({
        organizationId, branchId: owner.branchId, patientId, chairId, dentistUserId: owner.user.id,
        serviceName: "Limpieza dental", startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "no_asistio",
      })
      const month = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).format(startsAt)
      await gotoHydrated(page, tenant(owner.org.slug, `/reports?tab=agenda&period=${month}`))
      // Con el asesor apagado no hay aviso.
      await expect(page.getByRole("heading", { name: /^De 1 cita de / })).toBeVisible()
      await expect(page.getByRole("region", { name: "Aviso del asesor" })).toHaveCount(0)

      await call(page, "PUT", "/api/agent/advisor/settings", owner.org.slug, { enabled: true })
      await page.reload()
      const note = page.getByRole("region", { name: "Aviso del asesor" })
      await expect(note).toContainText("La inasistencia está en 100 %.")
      await expect(note).toContainText("El recordatorio de cita está apagado.")
      await expect(page.getByRole("navigation", { name: "Preguntas" }).getByRole("link", { name: /^Agenda/ })).toContainText("1 aviso del asesor")
      await observe(page, info, "asesor")

      // «Ver qué hacer» abre la recomendación de siempre: cómo se calculó, quiénes son y la acción.
      await note.getByRole("button", { name: "Ver qué hacer" }).click()
      const advice = page.getByRole("region", { name: "Recomendación del asesor" }).or(page.getByRole("dialog", { name: "Recomendación del asesor" })).first()
      await expect(advice.getByText("Cómo se calculó")).toBeVisible()
      await expect(advice.getByRole("link", { name: "Gabriel Núñez" })).toBeVisible()
      await expect(advice.getByRole("button", { name: "Encender recordatorio" })).toBeVisible()
      await observe(page, info, "asesor-recomendacion")
      await page.keyboard.press("Escape")

      // «No me interesa» lo pospone: el aviso se va sin recargar.
      await note.getByRole("button", { name: "No me interesa" }).click()
      await expect(page.getByRole("region", { name: "Aviso del asesor" })).toHaveCount(0)
    })

    test("un mes sin movimientos lo dice y ofrece volver al mes en curso", async ({ owner }, info) => {
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      await gotoHydrated(page, tenant(owner.org.slug, "/reports?period=mes_pasado"))
      await expect(page.getByText(/^Sin movimientos en /)).toBeVisible()
      await observe(page, info, "vacio")
      await page.getByRole("button", { name: "Ver este mes" }).click()
      await expect(page).not.toHaveURL(/period=/)
    })
  })
}

test("reportes es de quien dirige: recepción no entra y el servidor lo rechaza", async ({ owner, fixtureDb }) => {
  await fixtureDb.update(member).set({ role: "reception" }).where(and(eq(member.organizationId, owner.org.id), eq(member.userId, owner.user.id)))
  const page = owner.page
  await gotoHydrated(page, tenant(owner.org.slug, "/reports"))
  await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/home"))
  for (const section of ["overview", "money", "agenda", "sales", "service", "list/no_show"]) {
    const response = await api(page, "GET", `/api/reports/${section}?period=este_mes`, owner.org.slug)
    expect(response.status, section).toBe(403)
  }
})
