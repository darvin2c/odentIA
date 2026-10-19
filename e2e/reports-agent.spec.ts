import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { agentHandoff } from "@odentia/db/schema/agent"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { member } from "@odentia/db/schema/auth"
import { encounter, encounterProcedure, patient, patientCharge, patientPayment, patientPaymentApplication } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import type { Page, TestInfo } from "@playwright/test"
import { and, eq, sql } from "drizzle-orm"
import { tenant, tenantPattern } from "./env"
import { api, expect, type OwnerFixture, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Reportes › Agente: lo que hizo el agente, lo que se pagó por él con las
 * cuentas de la factura y lo cobrado en sus citas, cada uno en su moneda, y
 * cómo se respondió a quien escribió. Los datos se preparan por la base: las
 * cifras ya las prueban los servicios; aquí se recorre lo que se ve.
 */

async function observe(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await info.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
}

/** Primer instante (Lima) del mes contado hacia atrás desde el mes en curso de la clínica, más días y horas. */
function inMonth(monthsBack: number, day = 1, hour = 0): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  return new Date(Date.UTC(get("year"), get("month") - 1 - monthsBack, day, 5 + hour))
}

/** El mes pasado del agente, aislado: su plan, sus acciones cobradas, sus citas pagadas y sus conversaciones. */
async function lastMonth(db: Db, owner: OwnerFixture) {
  const organizationId = owner.org.id
  const [plan] = await db
    .insert(saasPlan)
    .values({
      code: `agente-${randomUUID().slice(0, 8)}`,
      name: "Plan odentIA",
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      consultationMicros: 400_000,
      recoveryMicros: 4_000_000,
      trialCreditCents: 5000,
      trialMaxCreditCents: 13000,
    })
    .returning()
  // El plan se activó el primer día del mes pasado: su mes coincide con el del reporte.
  await db
    .update(saasSubscription)
    .set({ planId: plan!.id, status: "activa", trialEndsAt: null, activatedAt: inMonth(1), currentPeriodStart: inMonth(0), currentPeriodEnd: inMonth(-1) })
    .where(eq(saasSubscription.organizationId, organizationId))

  const chairId = randomUUID()
  await db.insert(scheduleChair).values({ id: chairId, organizationId, branchId: owner.branchId, name: "Unidad dental de prueba" })
  const person = async (name: string, number: number) => {
    const [who] = await db.insert(contact).values({ organizationId, displayName: name }).returning({ id: contact.id })
    const [row] = await db.insert(patient).values({ organizationId, personId: who!.id, patientNumber: number }).returning({ id: patient.id })
    return row!.id
  }
  /** Una cita que ya vino, con su atención cerrada y lo que se pagó de ella. */
  const visit = async (patientId: string, source: string, day: number, cents: number) => {
    const startsAt = inMonth(1, day, 10)
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000)
    const [row] = await db
      .insert(appointment)
      .values({ organizationId, branchId: owner.branchId, patientId, chairId, dentistUserId: owner.user.id, serviceName: "Limpieza dental", startsAt, endsAt, durationMin: 30, status: "atendida", source, createdAt: inMonth(1, day - 5, 10) })
      .returning({ id: appointment.id })
    const [session] = await db
      .insert(encounter)
      .values({ organizationId, patientId, branchId: owner.branchId, dentistUserId: owner.user.id, appointmentId: row!.id, reason: "Limpieza dental", evolution: "Sin complicaciones.", startedAt: startsAt, signerName: "Ana Pruebas", signerTitle: "Cirujano dentista", signerRegistration: "12345" })
      .returning({ id: encounter.id })
    const [procedure] = await db
      .insert(encounterProcedure)
      .values({ organizationId, encounterId: session!.id, description: "Limpieza dental", quantity: 1, priceCents: cents, currency: "PEN", createdBy: owner.user.id, createdAt: endsAt })
      .returning({ id: encounterProcedure.id })
    await db.execute(sql`update encounter set status = 'finalizada', ended_at = ${endsAt.toISOString()}::timestamptz, finalized_at = ${endsAt.toISOString()}::timestamptz, finalized_by = dentist_user_id where id = ${session!.id}`)
    const [charge] = await db
      .insert(patientCharge)
      .values({ organizationId, patientId, encounterProcedureId: procedure!.id, branchId: owner.branchId, description: "Limpieza dental", amountCents: cents, currency: "PEN", createdBy: owner.user.id, createdAt: endsAt })
      .returning({ id: patientCharge.id })
    const [payment] = await db
      .insert(patientPayment)
      .values({ organizationId, patientId, branchId: owner.branchId, amountCents: cents, currency: "PEN", paidAt: endsAt, methodName: "Efectivo", methodTypeCode: "10" })
      .returning({ id: patientPayment.id })
    await db.insert(patientPaymentApplication).values({ organizationId, patientId, paymentId: payment!.id, chargeId: charge!.id, amountCents: cents, createdAt: endsAt })
    return row!.id
  }
  // El agente reservó dos que vinieron (una, recuperada); recepción, otra que no es suya.
  const recovered = await visit(await person("Rosa Quispe", 1), "agent", 10, 25_000)
  await visit(await person("Luis Paredes", 2), "enlace", 11, 18_000)
  await visit(await person("Carla Soto", 3), "recepcion", 12, 50_000)

  // Lo que contó el cobro: 60 conversaciones (las 58 primeras llenan el crédito), 2 consultas y la cita recuperada.
  const action = (kind: "conversacion" | "consulta" | "cita", at: Date, micros: number, detail: string, extra: Partial<typeof saasAction.$inferInsert> = {}) => ({
    organizationId, kind, occurredAt: at, contactId: randomUUID(), detail, currency: "USD", basePriceMicros: micros, priceMicros: micros, discountBps: 0, dedupeKey: randomUUID(), ...extra,
  })
  await db.insert(saasAction).values([
    ...Array.from({ length: 60 }, (_, index) => action("conversacion", new Date(inMonth(1, 2).getTime() + index * 3_600_000), 500_000, "Atendió una conversación por WhatsApp", { channel: "whatsapp" })),
    action("consulta", inMonth(1, 14, 3), 400_000, "Ordenó la consulta dictada por Ana Pruebas"),
    action("consulta", inMonth(1, 15, 3), 400_000, "Ordenó la consulta dictada por Ana Pruebas"),
    action("cita", inMonth(1, 10, 11), 4_000_000, "Volvió tras «Retomar un presupuesto» y reservó en la conversación", { appointmentId: recovered, channel: "agent" }),
  ])

  // Conversaciones: una la resolvió el agente solo, otra la pasó al equipo y una sigue sin respuesta.
  const channelId = randomUUID()
  await db.insert(channelConnection).values({ id: channelId, organizationId, channel: "whatsapp", provider: "prueba", displayName: "Canal controlado", configEncrypted: "no-se-usa", webhookSecret: "no-se-usa" })
  const thread = async (name: string, day: number, replies: Array<{ by: "agent" | "user"; seconds: number }>) => {
    const [who] = await db.insert(contact).values({ organizationId, displayName: name }).returning({ id: contact.id })
    const conversationId = randomUUID()
    const inboundAt = inMonth(1, day, 9)
    await db.insert(conversation).values({ id: conversationId, organizationId, contactId: who!.id, channelConnectionId: channelId, externalThreadId: randomUUID() })
    await db.insert(message).values([
      { organizationId, conversationId, direction: "in", senderKind: "contact", status: "received", createdAt: inboundAt },
      ...replies.map((reply) => {
        const sentAt = new Date(inboundAt.getTime() + reply.seconds * 1000)
        return { organizationId, conversationId, direction: "out", senderKind: reply.by, status: "sent", externalId: `proveedor-${randomUUID()}`, createdAt: sentAt, sentAt }
      }),
    ])
    return conversationId
  }
  await thread("Marta Solo Agente", 5, [{ by: "agent", seconds: 40 }])
  const passed = await thread("Pedro Pide Persona", 6, [
    { by: "agent", seconds: 60 },
    { by: "user", seconds: 900 },
  ])
  await db.insert(agentHandoff).values({ organizationId, conversationId: passed, reason: "Pide hablar con una persona", summary: "Quiere que alguien le explique el tratamiento.", createdAt: new Date(inMonth(1, 6, 9).getTime() + 3 * 60_000) })
  await thread("Nadia Sin Respuesta", 7, [])
  return { passed }
}

for (const width of [1440, 390]) {
  test(`Reportes › Agente a ${width}px: lo que hizo, lo que pagaste con las cuentas de la factura y lo cobrado en sus citas`, async ({ owner, fixtureDb }, info) => {
    const { passed } = await lastMonth(fixtureDb, owner)
    const page = owner.page
    await page.setViewportSize({ width, height: 844 })
    await gotoHydrated(page, tenant(owner.org.slug, "/reports?tab=agente&period=mes_pasado"))
    await expect(page.getByRole("heading", { name: "Agente", exact: true })).toBeVisible()

    // Lo que hizo, cada cifra con su comparación.
    const did = page.getByRole("region", { name: "Lo que hizo el agente" })
    await expect(did.getByRole("region", { name: "Conversaciones que atendió" })).toContainText("1 sin el equipo · 50 %")
    const booked = did.getByRole("region", { name: "Citas que agendó", exact: true })
    await expect(booked).toContainText("2 ya vinieron")
    await expect(did.getByRole("region", { name: "Citas recuperadas" })).toContainText("1")
    await expect(did.getByRole("region", { name: "Consultas dictadas" })).toContainText("2")

    // Lo pagado con las cuentas de la factura, en dólares; lo cobrado en sus citas, en soles. Sin convertir ni «ganó».
    const money = page.getByRole("region", { name: "Lo que pagaste por el agente y lo cobrado en sus citas" })
    await expect(money).toContainText("USD 34.80")
    // La línea que se cobra dice la regla de Facturación: no es la cifra «Conversaciones que atendió».
    await expect(money).toContainText("Recepción: 60 conversaciones atendidas")
    await expect(money).toContainText("Una por persona cada 24 horas")
    await expect(money).toContainText("USD 0.50 cada una")
    await expect(money).toContainText("El crédito del plan cubrió USD 29.00; USD 5.80 se cobraron aparte.")
    await expect(money).toContainText("Sin el IGV, que tu factura suma aparte.")
    await expect(money.getByRole("link", { name: "Ver en Plan y pagos" })).toHaveAttribute("href", /\/settings\/plan$/)
    await expect(money).toContainText("Cobrado en citas que agendó el agente")
    await expect(money).toContainText("S/ 430.00")
    await expect(money).toContainText("En la cita recuperada")
    await expect(money).toContainText("En otra cita que agendó y ya vino")
    await expect(money).not.toContainText("ganó S/")
    await observe(page, info, "agente")

    // «Ver cuáles» abre las citas que agendó, con lo pagado en cada una; Escape la cierra.
    await booked.getByRole("button", { name: "Ver cuáles" }).click()
    await expect(page).toHaveURL(/lista=agent_booked/)
    const list = page.getByRole(width === 390 ? "dialog" : "region", { name: "Citas que agendó el agente", exact: true }).or(page.getByRole("dialog", { name: "Citas que agendó el agente", exact: true })).first()
    await expect(list.getByRole("link", { name: "Rosa Quispe" })).toBeVisible()
    await expect(list.getByRole("link", { name: "Luis Paredes" })).toBeVisible()
    await expect(list.getByRole("link", { name: "Carla Soto" })).toHaveCount(0)
    await expect(list).toContainText("S/ 250.00")
    // La fecha de la fila es la de la reserva (la del filtro); la de la cita va en el texto.
    await expect(list).toContainText("Cita el")
    await expect(list.getByText("Cómo se calcula")).toBeVisible()
    await observe(page, info, "agente-citas")
    await page.keyboard.press("Escape")
    await expect(page).not.toHaveURL(/lista=/)

    // Cómo respondimos: quién primero y las que pasaron al equipo, que llevan a su conversación.
    const answers = page.getByRole("region", { name: "Cómo respondimos a quien escribió" })
    await expect(answers.getByRole("heading", { name: "Quién respondió primero" })).toBeVisible()
    await expect(answers).toContainText("3 personas escribieron por primera vez")
    await expect(answers.getByRole("link", { name: "Ver en la Bandeja" })).toBeVisible()
    await answers.getByRole("button", { name: "Ver cuáles" }).click()
    const handoffs = page.getByRole(width === 390 ? "dialog" : "region", { name: "Pasaron al equipo", exact: true }).or(page.getByRole("dialog", { name: "Pasaron al equipo", exact: true })).first()
    await expect(handoffs).toContainText("Pide hablar con una persona")
    await expect(handoffs.getByRole("link", { name: "Pedro Pide Persona" })).toHaveAttribute("href", new RegExp(`/inbox\\?conversation=${passed}`))
    await observe(page, info, "agente-pases")
    await page.keyboard.press("Escape")

    // El Resumen dice lo mismo junto a la cifra del agente.
    await page.getByRole("navigation", { name: "Secciones de Reportes" }).getByRole("link", { name: "Resumen" }).click()
    const summary = page.getByRole("region", { name: "Las seis cifras" }).getByRole("region", { name: "Citas que agendó el agente", exact: true })
    await expect(summary).toContainText("y recuperó 1 cita · S/ 430.00 cobrados en esas citas")
  })
}

test("En una cuenta demo no se dice «pagaste»: se cuenta lo mismo y se avisa, como en Facturación", async ({ owner, fixtureDb }, info) => {
  await lastMonth(fixtureDb, owner)
  await fixtureDb.update(saasSubscription).set({ isDemo: true }).where(eq(saasSubscription.organizationId, owner.org.id))
  const page = owner.page
  await page.setViewportSize({ width: 1440, height: 844 })
  await gotoHydrated(page, tenant(owner.org.slug, "/reports?tab=agente&period=mes_pasado"))
  const money = page.getByRole("region", { name: "Lo que se contó por el agente y lo cobrado en sus citas" })
  await expect(money).toContainText("Cuenta demo: se cuenta lo que hacen los agentes, pero no se cobra.")
  await expect(money).toContainText("USD 34.80")
  await expect(money).not.toContainText("Lo que pagaste")
  await expect(money).not.toContainText("se cobraron aparte")
  await observe(page, info, "agente-demo")
})

test("Agente es de quien dirige: recepción no lo ve y el servidor lo rechaza", async ({ owner, fixtureDb }) => {
  await fixtureDb.update(member).set({ role: "reception" }).where(and(eq(member.organizationId, owner.org.id), eq(member.userId, owner.user.id)))
  const page = owner.page
  await gotoHydrated(page, tenant(owner.org.slug, "/reports?tab=agente"))
  await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/home"))
  for (const section of ["agent", "list/agent_booked", "list/agent_handoffs"]) {
    const response = await api(page, "GET", `/api/reports/${section}?period=este_mes`, owner.org.slug)
    expect(response.status, section).toBe(403)
  }
})
