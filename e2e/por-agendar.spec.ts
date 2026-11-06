import { clinicalFollowUp } from "@odentia/db/schema/clinical"
import type { Page } from "@playwright/test"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, createAcceptedBudget, patientApiPath } from "./patients-fixture"
import { surface } from "./surface"

/**
 * Lo que falta agendar con una sola regla (ADR 0145) y la Actividad del equipo
 * por acción (issue #112), vistos en la pantalla real: Inicio lleva a Pacientes
 * › «Por agendar» con el mismo número, los controles vencidos abren la lista de
 * Argos y un cobro es una sola fila con la persona y su ticket.
 */
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test("lo aceptado sin cita y el control vencido llevan a su lista; un cobro es una fila con sobre qué", async ({ owner, fixtureDb }, info) => {
  test.setTimeout(150_000)
  const { page, org } = owner
  const ids = await buildClinicalBase(owner)
  const accepted = await createAcceptedBudget(owner, ids)
  await fixtureDb.insert(clinicalFollowUp).values({
    organizationId: org.id, patientId: ids.patientId, kind: "mantenimiento", title: "Control de la resina",
    dueAt: new Date(Date.now() - 10 * 86_400_000),
  })

  // --- Inicio: las dos filas (la clínica de prueba nace con Argos apagado) ---
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const waiting = page.getByRole("region", { name: "Te espera" })
  await expect(waiting).toContainText("1 persona tiene algo aceptado sin cita")
  await expect(waiting).toContainText("1 control vencido sin cita")
  await info.attach("inicio-escritorio", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // El control abre la misma lista de Argos «Avisar un control».
  await waiting.getByRole("button", { name: "Ver: 1 control vencido sin cita" }).click()
  const drawer = surface(page, { name: "Recomendación de Argos", exact: true })
  await expect(drawer).toContainText("1 control vencido de un paciente sin cita")
  await expect(drawer).toContainText("Es la misma lista de Pacientes › «Control vencido»")
  await expect(drawer.getByRole("link", { name: "Lucía Quispe" })).toBeVisible()
  await info.attach("inicio-controles", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Lo aceptado lleva a Pacientes › «Por agendar», con la misma persona y «Reservar cita».
  await waiting.getByRole("link", { name: "Ver en Pacientes: 1 persona tiene algo aceptado sin cita" }).click()
  await expect(page).toHaveURL(/\/people\?.*atajo=por_agendar/)
  await expect(page.getByText("«Por agendar»: quien tiene algo aceptado o en curso sin una cita que lo lleve")).toBeVisible()
  const list = page.getByRole("table")
  await expect(list.getByRole("row")).toHaveCount(2)
  await expect(list).toContainText("Lucía Quispe")
  await expect(list.getByRole("button", { name: /Reservar cita/ })).toBeVisible()
  await info.attach("pacientes-por-agendar", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // --- Un cobro: una sola fila en Actividad del equipo, con la persona y el ticket ---
  const apiPath = patientApiPath(ids.patientId)
  const charge = await call<{ id: string }>(page, "POST", `${apiPath}/charges`, org.slug, { budgetItemId: accepted.budgetLineId }, 201)
  const methods = await call<Array<{ id: string; typeCode: string }>>(page, "GET", "/api/org/payment-methods?activeOnly=1", org.slug)
  const cash = methods.find((method) => method.typeCode === "10")
  expect(cash, "la clínica ofrece efectivo").toBeTruthy()
  await call(page, "POST", `${apiPath}/collect`, org.slug, {
    branchId: owner.branchId,
    chargeIds: [charge.id],
    payments: [{ paymentMethodId: cash!.id, amountCents: 15000 }],
    requestId: crypto.randomUUID(),
  }, 201)
  await gotoHydrated(page, tenant(org.slug, "/settings/audit?area=cobros"))
  const rows = page.getByRole("table").getByRole("row").filter({ hasText: "Emitió un ticket" })
  await expect(rows).toHaveCount(1)
  // Lo demás que dejó el cobro va debajo, en «También»: el pago, su aplicación y el movimiento de caja.
  await expect(rows).toContainText(/También .*registró un pago/)
  await expect(rows.getByRole("link", { name: "Lucía Quispe" })).toBeVisible()
  await expect(rows.getByRole("link", { name: /^Ticket N\.º \d{6}$/ })).toBeVisible()
  // El pago y su aplicación no tienen fila propia: son la misma acción.
  await expect(page.getByRole("table").getByRole("row").filter({ hasText: /Registró un pago/ })).toHaveCount(0)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("actividad-escritorio", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // El ticket se abre donde se opera.
  await rows.getByRole("link", { name: /^Ticket N\.º/ }).click()
  await expect(page).toHaveURL(/\/finance\?.*ticket=/)

  // --- Teléfono: Inicio y la Actividad sin desbordes ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(page.getByRole("region", { name: "Te espera" })).toContainText("1 persona tiene algo aceptado sin cita")
  await expect.poll(() => overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("inicio-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await gotoHydrated(page, tenant(org.slug, "/settings/audit?area=cobros"))
  await expect(page.getByText("Emitió un ticket").first()).toBeVisible()
  await expect.poll(() => overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("actividad-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
})
