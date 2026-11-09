/**
 * El Resumen de la ficha dice lo que pasa (QA del 6 nov, su revisión del 7 y la
 * propuesta 5 de la QA del 8): «Qué sigue» es una sola lista, con su próxima
 * cita arriba y, debajo, el presupuesto y el próximo control, cada uno con su
 * botón; el control vencido va primero; a quien está hoy en la sala, su cita
 * con «Llegó» y su control cumpliéndose con la atención de hoy; una atención de
 * otro día no es «Hoy» ni tapa la reserva que viene; lo que pasó sin cerrarse
 * dice «Sin cerrar»; la cuenta dice lo devuelto; y recepción ve lo suyo.
 * Capturas a 1280 y 390 px.
 */
import { randomUUID } from "node:crypto"
import { appointment } from "@odentia/db/schema/agenda"
import { member } from "@odentia/db/schema/auth"
import { clinicalFollowUp } from "@odentia/db/schema/clinical"
import type { Locator, Page, TestInfo } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant } from "./env"
import { call, expect, type OwnerFixture, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, createDraftBudget, enableAgenda, patientApiPath } from "./patients-fixture"
import { surface } from "./surface"

const DAY = 86_400_000

/** Una tarjeta del Resumen por su título. */
function card(page: Page, title: string): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) })
}

/** Captura a 1280 y a 390 px. */
function viewsOf(page: Page, testInfo: TestInfo) {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  return async (name: string) => {
    await shot(name)
    await page.setViewportSize({ width: 390, height: 844 })
    await shot(`${name}-telefono`)
    await page.setViewportSize({ width: 1280, height: 800 })
  }
}

/** Una cita reservada por la API en un día libre, para moverla después en la base. */
async function bookAppointment(owner: OwnerFixture, patientId: string, roomId: string, daysAhead: number): Promise<{ id: string }> {
  const at = new Date(Date.now() + daysAhead * DAY)
  at.setUTCHours(16, 0, 0, 0)
  return call<{ id: string }>(owner.page, "POST", "/api/appointments", owner.org.slug, {
    patientId,
    professionalUserId: owner.user.id,
    roomId,
    startsAt: at.toISOString(),
    endsAt: new Date(at.getTime() + 30 * 60_000).toISOString(),
    outsideSchedule: true,
  }, 201)
}

test("ficha: «Qué sigue» junta la próxima cita, el presupuesto y el control; el vencido primero, y el de quien está hoy en la sala", async ({ owner, fixtureDb }, testInfo) => {
  test.setTimeout(180_000)
  const { page } = owner
  const slug = owner.org.slug
  const views = viewsOf(page, testInfo)
  await page.setViewportSize({ width: 1280, height: 800 })

  // Lucía tiene un presupuesto enviado («Qué sigue» habla de él) y un control de mantenimiento.
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  const { budgetId } = await createDraftBudget(owner, ids)
  await call(page, "POST", `${apiPath}/budgets/${budgetId}/deliver`, slug, {})
  const { roomId } = await enableAgenda(owner)
  const due = new Date(Date.now() + 10 * DAY)
  due.setUTCHours(15, 0, 0, 0)
  const control = await call<{ id: string }>(page, "POST", `${apiPath}/follow-ups`, slug, {
    kind: "mantenimiento",
    title: "Profilaxis semestral",
    dueAt: due.toISOString(),
  }, 201)
  // Indicado en su última atención: la fila dice quién y cuándo, y a quien lee la historia, el motivo.
  await fixtureDb.update(clinicalFollowUp).set({ originEncounterId: ids.encounterId }).where(eq(clinicalFollowUp.id, control.id))

  // 1. Una sola lista: arriba, que no tiene cita; debajo, el presupuesto y el control, cada uno con su botón.
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}`))
  const next = card(page, "Qué sigue")
  const rows = next.getByRole("listitem")
  await expect(next).toContainText("Sin cita por venir")
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText("Entregado · espera respuesta")
  await expect(rows.nth(1)).toContainText("Profilaxis semestral · por reservar")
  await expect(rows.nth(1)).toContainText(/Toca el \d{1,2} \S+ · lo indicó .+ el \d{1,2} \S+ en la atención por «/)
  // Ya no hay tarjetas sueltas de la cita y el control, ni un «Reservar cita» repetido.
  await expect(page.getByRole("heading", { name: "Próxima cita", exact: true })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Próximo control", exact: true })).toHaveCount(0)
  await expect(next.getByRole("button", { name: "Reservar cita", exact: true })).toHaveCount(0)
  const pending = card(page, "Pendientes")
  await expect(pending).not.toContainText("Profilaxis semestral")
  await views("resumen-que-sigue")
  // «Reservar el control» abre su reserva ahí mismo.
  await rows.nth(1).getByRole("button", { name: "Reservar el control" }).click()
  const scheduling = surface(page, { name: "Programar control" })
  await expect(scheduling).toBeVisible()
  await scheduling.getByRole("button", { name: /cerrar|cancelar/i }).first().click()
  await expect(scheduling).toBeHidden()

  // 2. Vencido y sin cita: va primero en la lista, dicho en palabras, y no en «Pendientes»; el Plan dice «Vencido».
  await fixtureDb
    .update(clinicalFollowUp)
    .set({ dueAt: new Date(Date.now() - 3 * DAY), createdAt: new Date(Date.now() - 40 * DAY) })
    .where(eq(clinicalFollowUp.id, control.id))
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}`))
  await expect(rows.nth(0)).toContainText("Profilaxis semestral · vencido")
  await expect(rows.nth(0)).toContainText(/Tocaba el \d{1,2} \S+/)
  await expect(rows.nth(0).getByRole("button", { name: "Reservar el control" })).toBeVisible()
  await expect(rows.nth(1)).toContainText("Entregado · espera respuesta")
  await expect(pending).not.toContainText("Profilaxis semestral")
  await views("resumen-control-vencido")
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}?tab=plan`))
  await expect(page.getByLabel("Controles").getByText("Vencido", { exact: true })).toBeVisible()
  await views("plan-control-vencido")

  // 3. Hoy está en la sala: su cita de hoy ya pasó su hora, pero llegó; el control vencido
  //    se cumple con su atención de hoy, sin «Reservar cita» y fuera de «vencido».
  const visit = await bookAppointment(owner, ids.patientId, roomId, 2)
  const now = Date.now()
  // Siempre dentro de hoy en Lima (UTC−5, sin horario de verano): pasada la medianoche,
  // «hace hora y media» ya sería ayer y la cita dejaría de ser de hoy.
  const limaMidnight = Math.floor((now - 5 * 3_600_000) / DAY) * DAY + 5 * 3_600_000
  const startsAt = Math.max(limaMidnight, now - 90 * 60_000)
  await fixtureDb
    .update(appointment)
    // Llegar confirma la cita, como «Llegó» en la Agenda.
    .set({
      status: "confirmada",
      arrivedBy: owner.user.id,
      startsAt: new Date(startsAt),
      endsAt: new Date(startsAt + 30 * 60_000),
      arrivedAt: new Date(Math.max(startsAt, now - 10 * 60_000)),
    })
    .where(eq(appointment.id, visit.id))
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}`))
  await expect(next).toContainText(/Su cita de hoy: Hoy \d\d:\d\d · Llegó \d\d:\d\d · espera/)
  await expect(next).not.toContainText("Sin cita por venir")
  const today = rows.filter({ hasText: "Profilaxis semestral" })
  await expect(today).toContainText(/se cumple con su atención de hoy/)
  // Su cita ya está arriba, con «Ver la cita»: la fila del control no la repite ni ofrece reservar otra.
  await expect(next.getByRole("button", { name: "Ver la cita" })).toHaveCount(1)
  await expect(today.getByRole("button")).toHaveCount(0)
  await expect(next).not.toContainText("vencido")
  await views("resumen-en-sala-con-control")
  // En Citas está entre las próximas, con «Llegó».
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}?tab=citas`))
  await expect(page.getByRole("heading", { name: "Próximas citas" })).toBeVisible()
  await expect(page.getByText("Llegó", { exact: true })).toBeVisible()
  await views("citas-en-sala-de-espera")

  // 4. La tarjeta del presupuesto en el teléfono: el estado no queda tapado por «¿Qué respondió?».
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}?tab=plan`))
  await expect(page.getByRole("button", { name: "¿Qué respondió?" }).first()).toBeVisible()
  await views("plan-presupuesto")
})

test("ficha: una atención de otro día no es «Hoy» ni tapa la reserva, y lo que pasó sin cerrarse dice «Sin cerrar»", async ({ owner, fixtureDb }, testInfo) => {
  test.setTimeout(180_000)
  const { page } = owner
  const slug = owner.org.slug
  const views = viewsOf(page, testInfo)
  await page.setViewportSize({ width: 1280, height: 800 })
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  const { roomId } = await enableAgenda(owner)

  // Una atención abierta la semana pasada desde su cita, que nadie cerró.
  const stale = await bookAppointment(owner, ids.patientId, roomId, 1)
  await call(page, "POST", `${apiPath}/encounters`, slug, { appointmentId: stale.id, reason: "Control" }, 201)
  const lastWeek = Date.now() - 7 * DAY
  await fixtureDb
    .update(appointment)
    .set({ status: "confirmada", arrivedBy: owner.user.id, arrivedAt: new Date(lastWeek - 5 * 60_000), startsAt: new Date(lastWeek), endsAt: new Date(lastWeek + 30 * 60_000) })
    .where(eq(appointment.id, stale.id))
  // Una cita de hace tres días a la que nadie le marcó «Llegó» ni «No vino».
  const unclosed = await bookAppointment(owner, ids.patientId, roomId, 3)
  const threeDaysAgo = Date.now() - 3 * DAY
  await fixtureDb
    .update(appointment)
    .set({ startsAt: new Date(threeDaysAgo), endsAt: new Date(threeDaysAgo + 30 * 60_000) })
    .where(eq(appointment.id, unclosed.id))
  // Y su reserva del mes que viene.
  await bookAppointment(owner, ids.patientId, roomId, 20)

  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}`))
  const upcoming = card(page, "Qué sigue")
  await expect(upcoming).toContainText("Próxima cita: ")
  await expect(upcoming.getByRole("button", { name: "Ver la cita" })).toBeVisible()
  await expect(upcoming).not.toContainText("Hoy")
  await expect(upcoming).not.toContainText("En atención")
  await views("resumen-atencion-de-otro-dia")
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}?tab=citas`))
  await expect(page.getByText("Sin cerrar", { exact: true })).toHaveCount(2)
  await views("citas-sin-cerrar")
})

test("ficha: la cuenta dice lo devuelto y recepción ve su Resumen y su Plan", async ({ owner, fixtureDb }, testInfo) => {
  test.setTimeout(180_000)
  const { page } = owner
  const slug = owner.org.slug
  const views = viewsOf(page, testInfo)
  await page.setViewportSize({ width: 1280, height: 800 })
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  await enableAgenda(owner)
  const due = new Date(Date.now() + 10 * DAY)
  due.setUTCHours(15, 0, 0, 0)
  await call(page, "POST", `${apiPath}/follow-ups`, slug, { kind: "mantenimiento", title: "Profilaxis semestral", dueAt: due.toISOString() }, 201)

  // Un adelanto de S/ 200 y la devolución de S/ 50 de lo que quedó a favor.
  const methods = await call<Array<{ id: string; typeCode: string }>>(page, "GET", "/api/org/payment-methods?activeOnly=1", slug)
  const cash = methods.find((method) => method.typeCode === "10")
  expect(cash, "la clínica ofrece efectivo").toBeTruthy()
  await call(page, "POST", `${apiPath}/collect`, slug, {
    branchId: owner.branchId,
    advanceCents: 20000,
    payments: [{ paymentMethodId: cash!.id, amountCents: 20000 }],
    cashReceivedCents: 20000,
    requestId: randomUUID(),
  }, 201)
  await call(page, "POST", `${apiPath}/refunds`, slug, {
    branchId: owner.branchId,
    amountCents: 5000,
    paymentMethodId: cash!.id,
    reason: "Devolución parcial del adelanto",
    requestId: randomUUID(),
  }, 201)
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}?tab=cuenta`))
  await expect(page.getByText(/Se devolvieron S\/\s*50\.00 el .* · Devolución parcial del adelanto/)).toBeVisible()
  await views("cuenta-con-devolucion")

  // Recepción: su «Qué sigue» dice el próximo control con su botón, y su Plan, los controles por reservar.
  await fixtureDb.update(member).set({ role: "reception" }).where(and(eq(member.organizationId, owner.org.id), eq(member.userId, owner.user.id)))
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}`))
  const next = card(page, "Qué sigue")
  await expect(next).toContainText("Profilaxis semestral · por reservar")
  await expect(next).toContainText("Sin cita por venir")
  await expect(next.getByRole("button", { name: "Reservar el control" })).toBeVisible()
  // El teléfono está en los datos de la persona, para todos.
  await expect(page.getByRole("region", { name: "Resumen" })).toContainText("Teléfono")
  await views("recepcion-resumen")
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}?tab=plan`))
  // En «Qué sigue» con su botón; abajo, en Controles, sin repetirlo (QA de la ficha del 8 nov).
  await expect(page.getByRole("region", { name: "Qué sigue" }).getByRole("button", { name: "Reservar el control" })).toBeVisible()
  await expect(page.getByText("Se reserva arriba, en «Qué sigue»")).toBeVisible()
  await views("recepcion-plan")
})
