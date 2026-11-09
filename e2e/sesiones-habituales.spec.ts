/**
 * Sesiones habituales (ADR 0164): la biblioteca dice con cuántas sesiones
 * suele hacerse cada tratamiento, el servicio guarda las de la clínica, el
 * plan nace con ellas y lo que se terminó al firmar porque llegó a sus
 * previstas se reabre desde el Plan con «Falta otra sesión».
 */
import { tenant } from "./env"
import { call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { buildClinicalBase, createAcceptedBudget, patientApiPath } from "./patients-fixture"
import { surface } from "./surface"

test("sesiones habituales: la biblioteca las dice, el servicio las guarda, el plan nace con ellas y lo terminado se reabre", async ({ owner }, testInfo) => {
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

  // 1. La biblioteca dice las que suele llevar: una corona, dos.
  await gotoHydrated(page, tenant(slug, "/services/biblioteca?vista=biblioteca&q=corona%20de%20porcelana"))
  const crown = page.getByRole("row").filter({ hasText: "Corona de porcelana" }).first()
  await expect(crown).toContainText("2 sesiones")
  await views("biblioteca-sesiones")

  // 2. La clínica pone las suyas en el servicio.
  const ids = await buildClinicalBase(owner)
  const apiPath = patientApiPath(ids.patientId)
  await gotoHydrated(page, tenant(slug, "/services"))
  await page.getByRole("row").filter({ hasText: "Endodoncia unirradicular" }).first().click()
  const editor = surface(page, { name: "Endodoncia unirradicular" })
  const sessionsField = editor.getByLabel("Sesiones habituales", { exact: true })
  await expect(sessionsField).toHaveValue("1")
  await expect(editor.getByText("Con cuántas nace al indicarlo; lo ya indicado no cambia.")).toBeVisible()
  // En el teléfono el detalle se vuelve a montar: se mira antes de escribir.
  await views("servicio-sesiones-habituales")
  await sessionsField.fill("2")
  await shot("servicio-sesiones-habituales-escritas")
  await editor.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(editor).toBeHidden()
  const services = await call<Array<{ id: string; usualSessions: number; ownUsualSessions: number | null }>>(page, "GET", "/api/services?limit=100", slug)
  expect(services.find((row) => row.id === ids.serviceId)).toMatchObject({ usualSessions: 2, ownUsualSessions: 2 })

  // 3. Lo que se indica desde ahora nace con ellas; lo ya indicado no cambia.
  const visit = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, slug, { reason: "Sesión de la endodoncia de la 36" }, 201)
  const indicated = await call<{ id: string; plannedSessions: number }>(page, "POST", `${apiPath}/plan/items`, slug, {
    serviceId: ids.serviceId,
    sourceEncounterId: visit.id,
    toothNumber: 46,
  }, 201)
  expect(indicated.plannedSessions).toBe(2)
  // Una corona de la biblioteca, que la clínica no tocó, nace con las 2 que sugiere.
  const templates = await call<Array<{ id: string; key: string }>>(page, "GET", "/api/services/templates?q=corona%20de%20porcelana", slug)
  const crownService = await call<{ id: string; usualSessions: number }>(page, "POST", "/api/services", slug, {
    templateId: templates.find((row) => row.key === "corona-de-porcelana")!.id,
    priceCents: 90000,
  }, 201)
  expect(crownService.usualSessions).toBe(2)
  const crownItem = await call<{ plannedSessions: number }>(page, "POST", `${apiPath}/plan/items`, slug, {
    serviceId: crownService.id,
    sourceEncounterId: visit.id,
    toothNumber: 11,
  }, 201)
  expect(crownItem.plannedSessions).toBe(2)

  // 4. La endodoncia de la 36 (indicada antes, con 1) se hace hoy y se termina al firmar sin tocar nada.
  await createAcceptedBudget(owner, ids)
  await call(page, "PATCH", `${apiPath}/encounters/${visit.id}`, slug, { evolution: "Endodoncia de la 36." })
  await call(page, "POST", `${apiPath}/encounters/${visit.id}/diagnoses`, slug, { diagnosisCode: "K04.0", diagnosisType: "confirmed", toothNumber: 36 }, 201)
  await call(page, "POST", `${apiPath}/encounters/${visit.id}/procedures`, slug, { planItemId: ids.itemId }, 201)
  // La corona indicada hoy pide su consentimiento: se firma cuando se haga.
  await call(page, "POST", `${apiPath}/encounters/${visit.id}/finalize`, slug, { consentSkipReason: "Se firma al hacer la corona" })
  const done = await call<Array<{ id: string; status: string; plannedSessions: number }>>(page, "GET", `${apiPath}/plan`, slug)
  expect(done.find((item) => item.id === ids.itemId)).toMatchObject({ status: "realizado", plannedSessions: 1 })

  // 5. En el Plan: la nueva dice «0 de 2 sesiones»; a la terminada le falta otra.
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}?tab=plan`))
  const newRow = page.getByRole("listitem").filter({ hasText: "Pieza 46" }).first()
  await expect(newRow).toContainText("0 de 2 sesiones")
  await expect(page.getByRole("listitem").filter({ hasText: "Corona de porcelana · Pieza 11" }).first()).toContainText("0 de 2 sesiones")
  const doneRow = page.getByRole("listitem").filter({ hasText: "Pieza 36" }).first()
  await expect(doneRow).not.toContainText("de 1 sesión")
  await views("plan-sesiones")
  await doneRow.getByRole("button", { name: "Falta otra sesión en «Endodoncia unirradicular · Pieza 36»", exact: true }).click()
  const confirm = page.getByRole("alertdialog", { name: "¿Le falta otra sesión?" })
  await expect(confirm).toContainText("queda la sesión 2 por agendar")
  await expect(confirm).toContainText("Reabrirlo no cobra nada: lo firmado y lo cobrado hasta hoy no cambian.")
  await views("falta-otra-sesion")
  await confirm.getByRole("button", { name: "Sí, falta otra sesión", exact: true }).click()
  await expect(confirm).toBeHidden()
  await expect(doneRow).toContainText("1 de 2 sesiones")
  const reopened = await call<Array<{ id: string; status: string; plannedSessions: number; sessionsDone: number }>>(page, "GET", `${apiPath}/plan`, slug)
  expect(reopened.find((item) => item.id === ids.itemId)).toMatchObject({ status: "en_curso", plannedSessions: 2, sessionsDone: 1 })
  await views("plan-reabierto")
})
