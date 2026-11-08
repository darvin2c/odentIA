/**
 * Un tratamiento de varias sesiones se ve como tal (QA del 6 nov): la reserva
 * ofrece la segunda sesión aunque ya tenga cita, cada cita dice «sesión 1 de 2»
 * o «sesión 2 de 2», «Hecho hoy» pide registrar la sesión antes de completar,
 * el cierre dice que sigue en curso y, en la última, «¿Terminaste?» viene en
 * «Sí, terminar»: firmar sin tocarlo lo termina (QA del 8 nov, X1).
 */
import type { Page } from "@playwright/test"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, createAcceptedBudget, enableAgenda, patientApiPath } from "./patients-fixture"
import { surface } from "./surface"

/** Abre «Nueva cita» con la persona elegida y espera el bloque ya puesto. */
async function bookingFor(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Nueva cita" }).click()
  const hours = page.getByRole("group", { name: /^Horas del/ })
  await expect(hours.getByRole("button", { name: /^De \d\d:\d\d a \d\d:\d\d con / })).toBeVisible()
  await page.getByLabel("Paciente", { exact: true }).fill(name.split(" ")[0]!)
  await page.getByRole("option", { name: new RegExp(name) }).click()
}

test("sesiones: la reserva lleva la segunda, cada cita dice cuál es, el cierre dice que sigue en curso y la última se termina al firmar", async ({ owner }, testInfo) => {
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

  // 1. Una endodoncia de la 36 con dos sesiones previstas, aceptada.
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  await call(page, "PATCH", `${apiPath}/plan/items/${ids.itemId}/planning`, slug, { plannedSessions: 2 })
  await createAcceptedBudget(owner, ids)
  await enableAgenda(owner)

  // 2. La cita 1 desde «Nueva cita»: «Para esta cita» la ofrece como su sesión 1.
  await gotoHydrated(page, tenant(slug, "/agenda"))
  await bookingFor(page, "Lucía Quispe")
  const first = page.getByRole("checkbox", { name: "Endodoncia unirradicular · sesión 1 de 2" })
  await expect(first).toBeChecked()
  await expect(page.getByText("Tratamientos aceptados con sesiones por reservar.", { exact: false })).toBeVisible()
  // Una semana después el día entero está libre, sea la hora que sea hoy.
  await page.getByRole("button", { name: "Semana siguiente" }).click()
  await views("reserva-sesion-1")
  await page.getByRole("button", { name: /^Reservar (hoy|mañana|el )/ }).click()
  const grid = page.getByRole("region", { name: /^Agenda del/ })
  await expect(grid.getByRole("button", { name: /^Cita de Lucía Quispe/ })).toHaveCount(1)
  await expect(grid.getByText("Endodoncia unirradicular · sesión 1 de 2")).toBeVisible()

  // La cita 2: ya tiene una, pero le falta la segunda sesión y se ofrece igual.
  await bookingFor(page, "Lucía Quispe")
  const second = page.getByRole("checkbox", { name: "Endodoncia unirradicular · sesión 2 de 2" })
  await expect(second).toBeChecked()
  await page.getByRole("button", { name: "Semana siguiente" }).click()
  await views("reserva-sesion-2")
  await page.getByRole("button", { name: /^Reservar (hoy|mañana|el )/ }).click()
  await expect(grid.getByText("Endodoncia unirradicular · sesión 2 de 2")).toBeVisible()

  // Las dos dicen su sesión, también en el servidor y en el cajón de la cita.
  const listed = await call<Array<{ id: string; startsAt: string; sessions: Array<{ planItemId: string; n: number; m: number }> }>>(
    page,
    "GET",
    `/api/appointments?branchId=${owner.branchId}&from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 40 * 86_400_000).toISOString())}`,
    slug,
  )
  const booked = listed.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  expect(booked.map((row) => row.sessions)).toEqual([
    [{ planItemId: ids.itemId, title: "Endodoncia unirradicular", n: 1, m: 2 }],
    [{ planItemId: ids.itemId, title: "Endodoncia unirradicular", n: 2, m: 2 }],
  ])
  await grid.getByRole("button", { name: /^Cita de Lucía Quispe/ }).first().click()
  const appointmentDrawer = surface(page, { name: /Lucía Quispe/ }).last()
  // El servicio ya dice qué es: la fila «Sesión» solo dice cuál.
  await expect(appointmentDrawer.getByText("sesión 2 de 2", { exact: true })).toBeVisible()
  await views("cita-sesion-2")

  // 3. Se atiende la cita 1: su atención trae la endodoncia y «Hecho hoy» pide registrar la sesión.
  const visit = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { appointmentId: booked[0]!.id, reason: "Sesión 1 de la endodoncia" }, 201)
  await call(page, "PATCH", `${apiPath}/encounters/${visit.id}`, slug, { evolution: "Apertura y conformación de conductos de la 36." })
  await call(page, "POST", `${apiPath}/encounters/${visit.id}/diagnoses`, slug, { diagnosisCode: "K04.0", diagnosisType: "confirmed", toothNumber: 36 }, 201)
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${visit.id}`))
  const openPlan = () =>
    page.getByRole("region", { name: "Plan y controles" }).getByRole("button", { name: "Abrir", exact: true }).click()
  await openPlan()
  // Sin la sesión de hoy no se ofrece «Completar».
  await expect(page.getByRole("button", { name: "Completar", exact: true })).toHaveCount(0)
  await views("hecho-hoy-sin-sesion")
  await page.getByRole("button", { name: "Registrar la sesión", exact: true }).click()
  const procedure = surface(page, { name: "Registrar procedimiento" })
  await expect(procedure.getByText(/queda en curso/)).toBeVisible()
  await procedure.getByRole("button", { name: "Registrar procedimiento", exact: true }).click()
  await expect(procedure).toBeHidden()
  await openPlan()
  await expect(page.getByRole("button", { name: "Completar", exact: true })).toBeVisible()
  await views("hecho-hoy-con-sesion")

  // Al firmar, la endodoncia no se termina sola: sigue en curso.
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const signing = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(signing.getByText("Sigue en curso: Endodoncia unirradicular · 36 · sesión 1 de 2")).toBeVisible()
  await views("cierre-sigue-en-curso")
  await signing.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Atención finalizada" })).toBeVisible()
  const items = await call<Array<{ id: string; status: string; sessionsDone: number }>>(page, "GET", `${apiPath}/plan`, slug)
  expect(items.find((item) => item.id === ids.itemId)).toMatchObject({ status: "en_curso", sessionsDone: 1 })

  // 4. La cita 2: con su sesión registrada llega a las previstas y el cierre pregunta «¿Terminaste?»,
  // con «Sí, terminar» ya elegido.
  const visit2 = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { appointmentId: booked[1]!.id, reason: "Sesión 2 de la endodoncia" }, 201)
  await call(page, "PATCH", `${apiPath}/encounters/${visit2.id}`, slug, { evolution: "Obturación de conductos de la 36." })
  await call(page, "POST", `${apiPath}/encounters/${visit2.id}/diagnoses`, slug, { diagnosisCode: "K04.0", diagnosisType: "confirmed", toothNumber: 36 }, 201)
  await call(page, "POST", `${apiPath}/encounters/${visit2.id}/procedures`, slug, { planItemId: ids.itemId }, 201)
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${visit2.id}`))
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const signing2 = page.getByRole("dialog", { name: "Finalizar y firmar" })
  const finished = signing2.getByRole("group", { name: /Endodoncia unirradicular · 36 · sesión 2 de 2 · ¿Terminaste\?/ })
  await expect(finished.getByRole("button", { name: "Sí, terminar" })).toHaveAttribute("aria-pressed", "true")
  await expect(finished.getByRole("button", { name: "Falta otra sesión" })).toHaveAttribute("aria-pressed", "false")
  await expect(signing2.getByText("Al firmar queda realizado.")).toBeVisible()
  await views("cierre-terminaste")
  // «Falta otra sesión» dice qué pasará; tocar otra vez la elegida no deja ninguna.
  await finished.getByRole("button", { name: "Falta otra sesión" }).click()
  await expect(signing2.getByText("Sigue en curso y se prevé una sesión más, la 3.")).toBeVisible()
  await views("cierre-falta-otra")
  await finished.getByRole("button", { name: "Falta otra sesión" }).click()
  await expect(finished.getByRole("button", { name: "Falta otra sesión" })).toHaveAttribute("aria-pressed", "true")
  // Vuelve a «Sí, terminar» y firma: queda realizado sin más.
  await finished.getByRole("button", { name: "Sí, terminar" }).click()
  await expect(signing2.getByText("Al firmar queda realizado.")).toBeVisible()
  await signing2.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Atención finalizada" })).toBeVisible()
  const after = await call<Array<{ id: string; status: string; sessionsDone: number }>>(page, "GET", `${apiPath}/plan`, slug)
  expect(after.find((item) => item.id === ids.itemId)).toMatchObject({ status: "realizado", sessionsDone: 2 })
})
