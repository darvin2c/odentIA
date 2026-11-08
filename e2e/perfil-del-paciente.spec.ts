/**
 * El Resumen de la ficha dice lo que pasa (QA del 6 nov): el próximo control en
 * su propia fila con «Reservar cita» aunque «Qué sigue» hable del presupuesto;
 * vencido, en «Pendientes»; y a quien ya llegó, su cita de hoy con «Llegó», no
 * «Sin cita por venir». Capturas a 1280 y 390 px.
 */
import { appointment } from "@odentia/db/schema/agenda"
import { clinicalFollowUp } from "@odentia/db/schema/clinical"
import type { Locator, Page } from "@playwright/test"
import { eq } from "drizzle-orm"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, createDraftBudget, enableAgenda, patientApiPath } from "./patients-fixture"
import { surface } from "./surface"

const DAY = 86_400_000

/** Una tarjeta del Resumen por su título. */
function card(page: Page, title: string): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) })
}

test("ficha: el próximo control en el Resumen, vencido en Pendientes, y la cita de quien ya llegó", async ({ owner, fixtureDb }, testInfo) => {
  test.setTimeout(180_000)
  const { page } = owner
  const slug = owner.org.slug
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const views = async (name: string) => {
    await shot(name)
    await page.setViewportSize({ width: 390, height: 844 })
    await shot(`${name}-telefono`)
    await page.setViewportSize({ width: 1280, height: 800 })
  }
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

  // 1. «Qué sigue» dice el presupuesto y el control va en su propia fila, con «Reservar cita».
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}`))
  await expect(page.getByText("Enviado · espera respuesta")).toBeVisible()
  const next = card(page, "Próximo control")
  await expect(next).toContainText("Profilaxis semestral")
  await expect(next).toContainText(/Toca el \d\d\/\d\d\/\d{4} · falta reservar la cita/)
  const pending = card(page, "Pendientes")
  await expect(pending).not.toContainText("Control vencido")
  await views("resumen-proximo-control")
  // «Reservar cita» abre la reserva del control ahí mismo.
  await next.getByRole("button", { name: "Reservar cita" }).click()
  const scheduling = surface(page, { name: "Programar control" })
  await expect(scheduling).toBeVisible()
  await scheduling.getByRole("button", { name: /cerrar|cancelar/i }).first().click()
  await expect(scheduling).toBeHidden()

  // 2. Vencido y sin cita: sale en «Pendientes» y ya no en su fila.
  await fixtureDb
    .update(clinicalFollowUp)
    .set({ dueAt: new Date(Date.now() - 3 * DAY), createdAt: new Date(Date.now() - 40 * DAY) })
    .where(eq(clinicalFollowUp.id, control.id))
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}`))
  await expect(pending).toContainText("Control vencido: Profilaxis semestral")
  await expect(pending).toContainText(/Tocaba el \d\d\/\d\d\/\d{4} · sin cita por venir/)
  await expect(pending.getByRole("button", { name: "Reservar cita" })).toBeVisible()
  await expect(next).toHaveCount(0)
  await views("resumen-control-vencido")

  // 3. Está en la sala de espera: su cita de hoy ya pasó su hora, pero llegó.
  const later = new Date(Date.now() + 2 * DAY)
  later.setUTCHours(16, 0, 0, 0)
  const visit = await call<{ id: string }>(page, "POST", "/api/appointments", slug, {
    patientId: ids.patientId,
    professionalUserId: owner.user.id,
    roomId,
    startsAt: later.toISOString(),
    endsAt: new Date(later.getTime() + 30 * 60_000).toISOString(),
    outsideSchedule: true,
  }, 201)
  const now = Date.now()
  await fixtureDb
    .update(appointment)
    // Llegar confirma la cita, como «Llegó» en la Agenda.
    .set({ status: "confirmada", arrivedBy: owner.user.id, startsAt: new Date(now - 90 * 60_000), endsAt: new Date(now - 60 * 60_000), arrivedAt: new Date(now - 10 * 60_000) })
    .where(eq(appointment.id, visit.id))
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}`))
  const upcoming = card(page, "Próxima cita")
  await expect(upcoming).toContainText(/Hoy \d\d:\d\d · Llegó \d\d:\d\d · espera/)
  await expect(upcoming).not.toContainText("Sin cita por venir")
  await views("resumen-en-sala-de-espera")
  // En Citas no está «Por confirmar» ni entre las anteriores: está en la clínica.
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}?tab=citas`))
  await expect(page.getByRole("heading", { name: "Próximas citas" })).toBeVisible()
  await expect(page.getByText("Llegó", { exact: true })).toBeVisible()
  await views("citas-en-sala-de-espera")

  // 4. La tarjeta del presupuesto en el teléfono: el estado no queda tapado por «¿Qué respondió?».
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}?tab=plan`))
  await expect(page.getByRole("button", { name: "¿Qué respondió?" }).first()).toBeVisible()
  await views("plan-presupuesto")
})
