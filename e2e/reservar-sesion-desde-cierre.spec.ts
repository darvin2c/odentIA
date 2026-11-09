/**
 * La próxima sesión se reserva donde termina la anterior (propuesta 2 de la QA
 * del 8 nov): al firmar la sesión 1 de una endodoncia en dos, «¿Cuándo vuelve?»
 * dice su próxima sesión sin pedir un control, «Atención finalizada» ofrece
 * «Reservar la sesión 2», el cajón «Nueva cita» llega con el tratamiento y su
 * servicio, y al reservar el aviso dice cuándo y con quién vuelve sin salir de
 * la atención. Quien atendió viene marcado aunque la agenda no lo ofrezca para
 * ese servicio, y se dice por qué (QA del 8 nov).
 */
import { randomUUID } from "node:crypto"
import { member, user as users } from "@odentia/db/schema/auth"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, createAcceptedBudget, enableAgenda, patientApiPath } from "./patients-fixture"
import { surface } from "./surface"

/** El nombre corto de las fichas de «Profesional»: las dos primeras palabras. */
const shortName = (label: string) => label.split(/\s+/).slice(0, 2).join(" ")
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

test("al firmar la sesión 1, la sesión 2 se reserva desde «Atención finalizada» con el tratamiento y su servicio", async ({ owner }, testInfo) => {
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

  // Una endodoncia de la 36 en dos sesiones, aceptada; y la agenda de quien atiende, abierta.
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  await call(page, "PATCH", `${apiPath}/plan/items/${ids.itemId}/planning`, slug, { plannedSessions: 2 })
  await createAcceptedBudget(owner, ids)
  await enableAgenda(owner)
  const item = (await call<Array<{ id: string; serviceId: string | null }>>(page, "GET", `${apiPath}/plan`, slug)).find(
    (row) => row.id === ids.itemId,
  )!

  // La sesión 1, sin cita, con su procedimiento registrado.
  const visit = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { reason: "Sesión 1 de la endodoncia" }, 201)
  await call(page, "PATCH", `${apiPath}/encounters/${visit.id}`, slug, { evolution: "Apertura y medicación intraconducto de la 36." })
  await call(page, "POST", `${apiPath}/encounters/${visit.id}/diagnoses`, slug, { diagnosisCode: "K04.0", diagnosisType: "confirmed", toothNumber: 36 }, 201)
  await call(page, "POST", `${apiPath}/encounters/${visit.id}/procedures`, slug, { planItemId: ids.itemId }, 201)
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${visit.id}`))

  // Al firmar: «¿Cuándo vuelve?» dice la sesión 2 y no pide un control aparte.
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const signing = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(signing.getByText("Sigue en curso: Endodoncia unirradicular · 36 · sesión 1 de 2", { exact: false })).toBeVisible()
  await expect(
    signing.getByText("Vuelve para Endodoncia unirradicular · 36 · sesión 2 de 2: al firmar puedes reservar su cita aquí mismo."),
  ).toBeVisible()
  await expect(signing.getByRole("button", { name: "En 1 semana" })).toHaveCount(0)
  // Si hace falta un control igual (algo terminado hoy), está a un toque.
  await expect(signing.getByRole("button", { name: "Indicar también un control" })).toBeVisible()
  await views("cierre-vuelve-a-la-sesion-2")
  await signing.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()

  // «Atención finalizada»: la sesión 2 sin cita, con su botón.
  const finalized = page.getByRole("dialog", { name: "Atención finalizada" })
  const next = finalized.getByRole("region", { name: "Próxima sesión" })
  await expect(next.getByRole("heading", { name: "Falta reservar su próxima sesión" })).toBeVisible()
  await expect(next.getByText("Endodoncia unirradicular · 36 · sesión 2 de 2 · sin cita")).toBeVisible()
  await views("finalizada-sesion-2-sin-cita")
  // Nada dejó un control aparte para la misma visita.
  const controls = await call<Array<{ id: string }>>(page, "GET", `${apiPath}/follow-ups`, slug)
  expect(controls).toEqual([])

  // Clic 1: «Reservar la sesión 2». El cajón llega con el tratamiento marcado y su servicio.
  await next.getByRole("button", { name: "Reservar la sesión 2" }).click()
  const booking = surface(page, { name: "Nueva cita" })
  await expect(booking.getByRole("checkbox", { name: "Endodoncia unirradicular · sesión 2 de 2" })).toBeChecked()
  await expect(booking.getByText("Lucía Quispe", { exact: true })).toBeVisible()
  // Una semana después el día entero está libre, sea la hora que sea hoy.
  await booking.getByRole("button", { name: "Semana siguiente" }).click()
  const reserve = booking.getByRole("button", { name: /^Reservar (hoy|mañana|el )/ })
  await expect(reserve).toBeVisible()
  await views("nueva-cita-sesion-2")
  // Clic 2: «Reservar». El cajón se cierra y el aviso sigue abierto, con la cita dicha.
  await reserve.click()
  await expect(booking).toBeHidden()
  await expect(finalized).toBeVisible()
  // Dice cuándo y con quién (QA del 8 nov: la cita había quedado con otro sin que se viera).
  const said = next.getByText(new RegExp(`^Vuelve el .+ con ${escapeRegExp(owner.user.name)} para Endodoncia unirradicular · 36 · sesión 2 de 2\\.$`))
  await expect(said).toBeVisible()
  await expect(next.getByRole("button", { name: "Reservar la sesión 2" })).toHaveCount(0)
  await expect(next.getByRole("heading", { name: "Su próxima sesión" })).toBeVisible()
  // El foco queda en lo reservado: el botón que lo abrió ya no está.
  await expect(next.getByRole("list")).toBeFocused()
  await views("finalizada-sesion-2-reservada")

  // Pasados los 10 s en que un dato sigue fresco, volver a la ventana relee la atención, que ya
  // llega firmada: el aviso y lo reservado siguen ahí (QA del 8 nov: se cerraba todo sin confirmar).
  await page.waitForTimeout(11_000)
  const reread = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url().endsWith(`/encounters/${visit.id}`) && response.ok(),
  )
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
  expect(((await (await reread).json()) as { data: { encounter: { status: string } } }).data.encounter.status).toBe("finalizada")
  await expect(finalized).toBeVisible()
  await expect(said).toBeVisible()

  // En el servidor, la cita lleva la sesión 2 del tratamiento con su servicio.
  const listed = await call<Array<{ serviceId: string | null; sessions: Array<{ planItemId: string; n: number; m: number }> }>>(
    page,
    "GET",
    `/api/appointments?branchId=${owner.branchId}&from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 40 * 86_400_000).toISOString())}`,
    slug,
  )
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({
    serviceId: item.serviceId,
    sessions: [{ planItemId: ids.itemId, n: 2, m: 2 }],
  })
  await finalized.getByRole("button", { name: "Listo" }).click()
  await expect(finalized).toBeHidden()
})


test("la sesión 2 viene con quien atendió aunque no tenga horario o no esté en la especialidad, y se dice por qué", async ({ owner, fixtureDb }, testInfo) => {
  test.setTimeout(180_000)
  const { page } = owner
  const slug = owner.org.slug
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 800 })

  // La clínica tiene su endodoncista con horario; quien atiende hoy (la dueña) no está en Endodoncia
  // y todavía no tiene horario: la QA del 8 nov vio «Cualquiera» y la cita quedó con otro.
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  await call(page, "PATCH", `${apiPath}/plan/items/${ids.itemId}/planning`, slug, { plannedSessions: 2 })
  await createAcceptedBudget(owner, ids)
  const viera = randomUUID()
  await fixtureDb.insert(users).values({ id: viera, name: "Dra. Clara Viera", email: `${viera}@example.test`, emailVerified: true })
  await fixtureDb.insert(member).values({ id: randomUUID(), organizationId: owner.org.id, userId: viera, role: "clinician", createdAt: new Date() })
  await enableAgenda(owner, viera)
  const specialties = await call<Array<{ id: string; key: string }>>(page, "GET", "/api/clinical-forms/specialties", slug)
  await call(page, "PUT", `/api/clinical-forms/specialties/${specialties.find((row) => row.key === "endodoncia")!.id}/professionals`, slug, {
    userIds: [viera],
  })

  const visit = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { reason: "Sesión 1 de la endodoncia" }, 201)
  await call(page, "PATCH", `${apiPath}/encounters/${visit.id}`, slug, { evolution: "Apertura y medicación intraconducto de la 36." })
  await call(page, "POST", `${apiPath}/encounters/${visit.id}/diagnoses`, slug, { diagnosisCode: "K04.0", diagnosisType: "confirmed", toothNumber: 36 }, 201)
  await call(page, "POST", `${apiPath}/encounters/${visit.id}/procedures`, slug, { planItemId: ids.itemId }, 201)
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${visit.id}`))
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  await page.getByRole("dialog", { name: "Finalizar y firmar" }).getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const finalized = page.getByRole("dialog", { name: "Atención finalizada" })
  const next = finalized.getByRole("region", { name: "Próxima sesión" })

  // Sin horario en la sede: viene marcada igual y se dice cómo seguir.
  await next.getByRole("button", { name: "Reservar la sesión 2" }).click()
  const booking = surface(page, { name: "Nueva cita" })
  const chips = booking.getByRole("group", { name: "Profesional" })
  const mine = chips.getByRole("button", { name: shortName(owner.user.name) })
  await expect(mine).toHaveAttribute("aria-pressed", "true")
  const first = shortName(owner.user.name)
  await expect(
    booking.getByText(
      `${owner.user.name} no tiene horario en esta sede: toca una hora y la cita queda con ${first}, fuera de su horario. En esta sede, Endodoncia la atiende Dra. Clara Viera.`,
    ),
  ).toBeVisible()
  await expect(booking.getByRole("button", { name: "Cambiar a Dra. Clara" })).toBeVisible()
  // La línea general de la especialidad no la contradice.
  await expect(booking.getByText("Solo se ofrecen las horas de quien atiende Endodoncia.")).toHaveCount(0)
  await expect(chips.getByRole("button", { name: "Cualquiera" })).toHaveAttribute("aria-pressed", "false")
  // Tocar una hora (la semana que viene, nada ya pasado) la propone fuera de su horario, con el aviso de siempre.
  await booking.getByRole("button", { name: "Semana siguiente" }).click()
  await booking.getByRole("group", { name: owner.user.name, exact: true }).click({ position: { x: 20, y: 80 } })
  await expect(booking.getByText(`Es fuera del horario de ${owner.user.name}.`)).toBeVisible()
  await expect(booking.getByRole("button", { name: "Reservar fuera de horario" })).toBeVisible()
  await shot("sesion-2-sin-horario")
  await booking.getByRole("button", { name: "Cancelar" }).click()
  await expect(booking).toBeHidden()

  // Con horario pero fuera de la especialidad: viene marcada con sus horas, y la línea dice quién la atiende.
  await enableAgenda(owner)
  await next.getByRole("button", { name: "Reservar la sesión 2" }).click()
  // Otra semana que no se miró: la disponibilidad se lee de nuevo, ya con su horario.
  await booking.getByRole("button", { name: "Semana siguiente" }).click()
  await booking.getByRole("button", { name: "Semana siguiente" }).click()
  await expect(mine).toHaveAttribute("aria-pressed", "true")
  await expect(
    booking.getByText(`La cita queda con ${owner.user.name}, aunque no figura en Endodoncia en esta sede. En esta sede, Endodoncia la atiende Dra. Clara Viera.`),
  ).toBeVisible()
  await expect(booking.getByRole("button", { name: "Cambiar a Dra. Clara" })).toBeVisible()
  // La línea general de la especialidad no se repite.
  await expect(booking.getByText("Solo se ofrecen las horas de quien atiende Endodoncia.")).toHaveCount(0)
  // «Cualquiera» es entre quienes atienden Endodoncia: el hueco no cae en quien está fuera sin decirlo.
  await chips.getByRole("button", { name: "Cualquiera" }).click()
  await expect(booking.getByText("Solo se ofrecen las horas de quien atiende Endodoncia.")).toBeVisible()
  await expect(booking.getByText("con Dra. Clara Viera", { exact: true })).toBeVisible()
  await mine.click()
  await expect(mine).toHaveAttribute("aria-pressed", "true")
  const reserve = booking.getByRole("button", { name: /^Reservar (hoy|mañana|el )/ })
  await expect(reserve).toBeVisible()
  await shot("sesion-2-fuera-de-la-especialidad")
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("sesion-2-fuera-de-la-especialidad-telefono")
  await page.setViewportSize({ width: 1280, height: 800 })
  await reserve.click()
  await expect(booking).toBeHidden()
  await expect(next.getByText(new RegExp(`^Vuelve el .+ con ${escapeRegExp(owner.user.name)} para Endodoncia unirradicular · 36 · sesión 2 de 2\\.$`))).toBeVisible()
  await shot("sesion-2-con-quien-atendio")

  const listed = await call<Array<{ professionalUserId: string }>>(
    page,
    "GET",
    `/api/appointments?branchId=${owner.branchId}&from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 40 * 86_400_000).toISOString())}`,
    slug,
  )
  expect(listed.map((row) => row.professionalUserId)).toEqual([owner.user.id])
})
