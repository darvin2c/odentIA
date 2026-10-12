import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

const DICTATION =
  "Viene por dolor al masticar del lado derecho. En la dieciséis hay caries en dentina. En la dieciséis hacemos endodoncia. Se realizó apertura cameral sin complicaciones. Control en 6 meses."

test("asistente clínico: dictado de práctica, sugerencias que el odontólogo confirma y aviso antes de firmar", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Lucía Fernández", docType: "DNI", docNumber: "87654321" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  const apiPath = `/api/patients/${patient.id}`
  await call(page, "POST", "/api/services", org.slug, {
    name: "Endodoncia multirradicular", specialty: "endodoncia", scope: "tooth", priceCents: 65000, currency: "PEN",
  }, 201)
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, org.slug, { reason: "Consulta" }, 201)
  await call(page, "PUT", "/api/clinical-forms/professionals/me/profile", org.slug, { registrationNumber: "12345" })
  const dictationPath = `${apiPath}/encounters/${encounter.id}/dictation`
  const dictation = () => call<{ enabled: boolean; suggestions: Array<{ kind: string; status: string }> }>(page, "GET", dictationPath, org.slug)

  // --- Apagado: la atención no ofrece dictar y el servidor no acepta dictados ---
  expect(await dictation()).toEqual({ enabled: false, suggestions: [] })
  expect((await api(page, "POST", dictationPath, org.slug, { transcript: DICTATION })).status).toBe(409)
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  await expect(page.getByRole("region", { name: "Cierre de la atención" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Dictado de la atención" })).toHaveCount(0)

  // --- Página del asistente: dictado de práctica y encendido ---
  await gotoHydrated(page, tenant(org.slug, "/agent"))
  const row = page.getByRole("region", { name: "Tus agentes" }).getByRole("listitem").filter({ hasText: "Asistente clínico" })
  await expect(row).toContainText("Apagado")
  await row.getByRole("link", { name: "Ver y encender" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Asistente clínico" })).toBeVisible()
  // El mismo marco de seis apartados que los otros agentes, con lo que el catálogo dice de este.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Qué hace", "Hasta dónde llega solo", "Qué sabe", "Cómo se comporta", "Cómo se prueba", "Qué aprende, y de quién es"])
  await expect(page.getByRole("region", { name: "Qué sabe" })).toContainText("Lo que el odontólogo dicta en esa atención.")
  await expect(page.getByRole("region", { name: "Hasta dónde llega solo" })).toContainText("Escuchar sin que el odontólogo pulse «Dictar».")
  await expect(page.getByRole("region", { name: "Cómo se comporta" }).getByRole("listitem")).toHaveCount(5)
  // Lo que todavía no existe se anuncia como tal, no como hecho.
  await expect(page.getByRole("region", { name: "Qué aprende, y de quién es" })).toContainText("Hoy no aprende")
  await expect(page.getByRole("region", { name: "Qué aprende, y de quién es" })).toContainText("Más adelante: Recordar los términos de cada odontólogo")
  const practice = page.getByRole("region", { name: "Cómo se prueba" })
  await practice.getByLabel("Dictado de ejemplo").fill(DICTATION)
  await practice.getByRole("button", { name: "Ver qué sugeriría" }).click()
  await expect(practice.getByRole("listitem").filter({ hasText: "Plan de tratamiento" })).toContainText("Endodoncia multirradicular · S/ 650.00")
  await expect(practice.getByRole("listitem").filter({ hasText: "Diagnóstico" })).toContainText("K02.1")
  await expect(practice).toContainText("Modelo de demostración")
  // La práctica no deja nada en ninguna atención.
  expect((await dictation()).suggestions).toEqual([])
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("asistente-clinico", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  // Teléfono: la misma página, sin desbordes.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(practice.getByRole("button", { name: "Ver qué sugeriría" })).toBeVisible()
  // El alto cambia con una transición al estrechar la ventana: se espera a que termine.
  await expect.poll(async () => (await practice.getByRole("button", { name: "Ver qué sugeriría" }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("asistente-clinico-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole("switch", { name: "Encender el Asistente clínico" }).click()
  await expect(page.getByRole("switch", { name: "Apagar el Asistente clínico" })).toBeChecked()

  // --- En la atención: dictar, revisar y confirmar ---
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  const panel = page.getByRole("region", { name: "Dictado de la atención" })
  await expect(panel).toContainText("Nada entra a la historia hasta que confirmes.")
  await panel.getByRole("button", { name: "Escribir lo dictado" }).click()
  await panel.getByLabel("Lo dictado").fill(DICTATION)
  await panel.getByRole("button", { name: "Ordenar lo dictado" }).click()
  const suggestions = panel.getByRole("region", { name: "Sugerencias del dictado" })
  await expect(suggestions).toContainText("4 sugerencias: 4 listas. Todavía no hay nada en la historia.")
  await expect(suggestions).toContainText("K02.1 · Caries de la dentina")
  await expect(suggestions).toContainText("Endodoncia multirradicular · S/ 650.00")
  await expect(suggestions).toContainText("Lo que dijiste: «En la dieciséis hacemos endodoncia.»")
  // Todavía no hay nada en la historia.
  const detail = () => call<{ encounter: { reason: string | null; evolution: string | null; status: string }; diagnoses: Array<{ cie10Code: string; toothNumber: number | null }> }>(page, "GET", `${apiPath}/encounters/${encounter.id}`, org.slug)
  expect((await detail()).diagnoses).toEqual([])
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("dictado-sugerencias", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Editar una antes de confirmar: el control con otro nombre.
  const control = suggestions.getByRole("listitem").filter({ hasText: "Control en 6 meses" })
  await control.getByRole("button", { name: "Editar" }).click()
  await control.getByLabel("Control", { exact: true }).fill("Control de endodoncia")
  await control.getByRole("button", { name: "Guardar cambios" }).click()
  await expect(suggestions.getByRole("listitem").filter({ hasText: "Control de endodoncia" })).toBeVisible()

  await suggestions.getByRole("button", { name: "Confirmar las 4 listas" }).click()
  await expect(suggestions).toHaveCount(0)
  const saved = await detail()
  expect(saved.encounter).toMatchObject({ reason: "Viene por dolor al masticar del lado derecho.", evolution: "Se realizó apertura cameral sin complicaciones." })
  expect(saved.diagnoses).toEqual([expect.objectContaining({ cie10Code: "K02.1", toothNumber: 16 })])
  const controls = await call<Array<{ title: string; status: string }>>(page, "GET", `${apiPath}/follow-ups`, org.slug)
  expect(controls).toEqual([expect.objectContaining({ title: "Control de endodoncia", status: "pendiente" })])
  // La pantalla refleja lo confirmado sin recargar.
  await expect(page.getByRole("region", { name: "Cierre de la atención" }).getByRole("listitem").filter({ hasText: "Diagnóstico" })).toContainText("listo")

  // Teléfono: el mismo panel, tocable y sin desbordes.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  const write = panel.getByRole("button", { name: "Escribir lo dictado" })
  expect((await write.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("dictado-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))

  // --- Una sugerencia sin revisar: al firmar se avisa y, si se firma, no entra a la historia ---
  await panel.getByRole("button", { name: "Escribir lo dictado" }).click()
  await panel.getByLabel("Lo dictado").fill("En la veintiséis hay caries.")
  await panel.getByRole("button", { name: "Ordenar lo dictado" }).click()
  await expect(suggestions).toContainText("1 sugerencia: 1 lista.")
  await page.getByRole("button", { name: "Finalizar atención" }).click()
  const sign = page.getByRole("alertdialog", { name: "Finalizar y firmar la atención" })
  await expect(sign.getByRole("alert")).toContainText("Queda 1 sugerencia del dictado sin revisar.")
  await info.attach("firmar-con-sugerencias", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // «Revisar ahora» vuelve a la atención sin firmar.
  await sign.getByRole("button", { name: "Revisar ahora" }).click()
  await expect(sign).toBeHidden()
  expect((await detail()).encounter.status).toBe("borrador")
  await page.getByRole("button", { name: "Finalizar atención" }).click()
  await sign.getByRole("button", { name: "Descartar y firmar" }).click()
  await expect.poll(async () => (await detail()).encounter.status, { timeout: 30_000 }).toBe("finalizada")
  const final = await detail()
  expect(final.diagnoses).toHaveLength(1)
  expect((await dictation()).suggestions).toEqual([])

  // Recepción no dicta ni ve sugerencias: son parte de la historia clínica.
  await fixtureDb.update(member).set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  expect((await api(page, "GET", dictationPath, org.slug)).status).toBe(403)
  expect((await api(page, "POST", "/api/agent/clinical/practice", org.slug, { transcript: DICTATION })).status).toBe(403)
  // Quien no supervisa al agente no llega a su página: el layout lo devuelve a Inicio.
  await fixtureDb.update(member).set({ role: "cashier" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await gotoHydrated(page, tenant(org.slug, "/agent/asistente-clinico"))
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
})
