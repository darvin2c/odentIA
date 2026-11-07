/**
 * El control se pide al firmar (ADR 0152): «¿Cuándo vuelve?» en el diálogo de
 * firma crea el control con un clic, sin otro cajón, y la atención cerrada dice
 * qué verá recepción. Los controles que ya tocaban salen como casillas: marcada
 * la de quien firma, sin marcar la de un colega.
 */
import { randomUUID } from "node:crypto"
import { user as users } from "@odentia/db/schema/auth"
import { clinicalFollowUp, encounter as encounters } from "@odentia/db/schema/clinical"
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, patientApiPath } from "./patients-fixture"

test("al firmar, «¿Cuándo vuelve?» deja el control con un clic", async ({ owner }, testInfo) => {
  const { page } = owner
  const slug = owner.org.slug
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const views = async (name: string) => {
    await shot(name)
    await page.setViewportSize({ width: 390, height: 844 })
    await shot(`${name}-telefono`)
    await page.setViewportSize({ width: 1280, height: 800 })
  }
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  // Una atención nueva con lo mínimo para firmar.
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { reason: "Limpieza de rutina" }, 201)
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/diagnoses`, slug, { diagnosisCode: "K02.1", diagnosisType: "confirmed", toothNumber: 36 }, 201)
  await call(page, "PATCH", `${apiPath}/encounters/${encounter.id}`, slug, { evolution: "Profilaxis sin incidencias." })

  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${encounter.id}`))
  await page.getByRole("button", { name: "Finalizar y firmar" }).last().click()
  const dialog = page.getByRole("dialog").last()
  await expect(dialog.getByText("¿Cuándo vuelve?")).toBeVisible()
  await expect(dialog.getByText("No indicaste cuándo vuelve: recepción no lo verá")).toBeVisible()
  await views("firma-cuando-vuelve")
  await dialog.getByRole("radio", { name: "En 6 meses" }).or(dialog.getByRole("button", { name: "En 6 meses" })).first().click()
  await expect(dialog.getByText(/Vuelve hacia el .* · recepción lo verá para reservarlo/)).toBeVisible()
  await shot("firma-6-meses-elegido")
  await dialog.getByRole("button", { name: "Finalizar y firmar" }).click()
  await expect(page.getByText(/recepción lo verá para reservarlo\./).first()).toBeVisible()
  await views("firmada-recepcion-vera")
  // El control quedó creado para dentro de 6 meses.
  const controls = await call<Array<{ status: string; title: string }>>(page, "GET", `${apiPath}/follow-ups`, slug)
  expect(controls.map((control) => control.status)).toContain("pendiente")
})

test("al firmar, el control propio que ya tocaba viene marcado y el de un colega no", async ({ owner, fixtureDb }, testInfo) => {
  const { page } = owner
  const slug = owner.org.slug
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const views = async (name: string) => {
    await shot(name)
    await page.setViewportSize({ width: 390, height: 844 })
    await shot(`${name}-telefono`)
    await page.setViewportSize({ width: 1280, height: 800 })
  }
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  const DAY = 86_400_000
  // Una atención firmada de un colega, de hace más de un año.
  const colleagueId = randomUUID()
  await fixtureDb.insert(users).values({ id: colleagueId, name: "Luis Colega", email: `colega-${colleagueId}@test.dev`, emailVerified: true })
  const [colleagueVisit] = await fixtureDb
    .insert(encounters)
    .values({
      organizationId: owner.org.id, patientId: ids.patientId, professionalUserId: colleagueId, reason: "Control de ortodoncia",
      status: "finalizada", startedAt: new Date(Date.now() - 400 * DAY), finalizedAt: new Date(Date.now() - 400 * DAY),
      signerName: "Luis Colega", signerRegistration: "COP 54321",
    })
    .returning({ id: encounters.id })
  // Los controles se indicaron antes (la API solo indica para hoy en adelante): el propio, hace 150 días
  // en la atención firmada de la base, para dentro de 20; el del colega, vencido hace 100 días.
  const [own, colleague] = await fixtureDb
    .insert(clinicalFollowUp)
    .values([
      {
        organizationId: owner.org.id, patientId: ids.patientId, kind: "mantenimiento", title: "Control de mantenimiento",
        originEncounterId: ids.encounterId, createdBy: owner.user.id,
        createdAt: new Date(Date.now() - 150 * DAY), dueAt: new Date(Date.now() + 20 * DAY),
      },
      {
        organizationId: owner.org.id, patientId: ids.patientId, kind: "mantenimiento", title: "Control de ortodoncia",
        originEncounterId: colleagueVisit!.id, createdBy: colleagueId,
        createdAt: new Date(Date.now() - 400 * DAY), dueAt: new Date(Date.now() - 100 * DAY),
      },
    ])
    .returning({ id: clinicalFollowUp.id })
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { reason: "Control de rutina" }, 201)
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/diagnoses`, slug, { diagnosisCode: "K02.1", diagnosisType: "confirmed", toothNumber: 36 }, 201)
  await call(page, "PATCH", `${apiPath}/encounters/${encounter.id}`, slug, { evolution: "Control sin hallazgos nuevos." })

  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}/encounters/${encounter.id}`))
  await page.getByRole("button", { name: "Finalizar y firmar" }).last().click()
  const dialog = page.getByRole("dialog").last()
  const mine = dialog.getByRole("checkbox", { name: /Cumple su control de mantenimiento/ })
  const theirs = dialog.getByRole("checkbox", { name: /Cumple su control de ortodoncia/ })
  await expect(mine).toBeChecked()
  await expect(theirs).not.toBeChecked()
  // El del colega sin marcar no frena «¿Cuándo vuelve?».
  await expect(dialog.getByText("No indicaste cuándo vuelve: recepción no lo verá")).toBeVisible()
  await views("firma-controles-que-tocan")
  // Se puede desmarcar: el propio sigue pendiente y ya no se pregunta otro.
  await mine.click()
  await expect(mine).not.toBeChecked()
  await expect(dialog.getByText(/Sigue pendiente su control de mantenimiento/)).toBeVisible()
  await shot("firma-control-propio-desmarcado")
  await mine.click()
  await expect(mine).toBeChecked()
  await dialog.getByRole("button", { name: "Finalizar y firmar" }).click()
  await expect(page.getByText(/Quedó cumplido: «Control de mantenimiento»/).first()).toBeVisible()
  await views("firmada-control-cumplido")
  const controls = await call<Array<{ id: string; status: string; completedEncounterId: string | null }>>(page, "GET", `${apiPath}/follow-ups`, slug)
  expect(controls.find((control) => control.id === own!.id)).toMatchObject({ status: "realizado", completedEncounterId: encounter.id })
  expect(controls.find((control) => control.id === colleague!.id)?.status).toBe("pendiente")
})
