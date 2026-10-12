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

test("asistente clínico: dictado de práctica, sugerencias dentro de cada bloque mientras se dicta, revisión y aviso antes de firmar", async ({ owner, fixtureDb }, info) => {
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
  expect(await dictation()).toEqual({ enabled: false, suggestions: [], confirmed: 0 })
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

  // --- En la atención: escribir lo dictado, revisar dentro de cada bloque y confirmar ---
  // El micrófono no se puede probar aquí: el navegador de la prueba recibe un reconocimiento de voz
  // simulado que entrega las frases que la prueba le pasa. No acredita cómo oye un navegador real.
  await page.addInitScript(() => {
    class FakeRecognition {
      onresult: ((event: unknown) => void) | null = null
      onend: (() => void) | null = null
      onerror: ((event: unknown) => void) | null = null
      start() {
        ;(window as unknown as { __speech: FakeRecognition }).__speech = this
      }
      stop() {
        this.onend?.()
      }
    }
    Object.assign(window, { SpeechRecognition: FakeRecognition, webkitSpeechRecognition: FakeRecognition })
  })
  const say = (text: string, final = true) =>
    page.evaluate(
      ([heard, isFinal]) => {
        const speech = (window as unknown as { __speech: { onresult: (event: unknown) => void } }).__speech
        speech.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: heard }], { isFinal })] })
      },
      [text, final] as const,
    )
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  const idle = page.getByRole("region", { name: "Dictado de la atención" })
  const review = page.getByRole("region", { name: "Sugerencias por revisar" })
  const block = (name: string) => page.locator(`section[aria-label="${name}"]`).filter({ has: page.getByRole("heading", { level: 2, name, exact: true }) })
  const suggested = (name: string) => page.getByRole("list", { name: `Sugerencias del asistente: ${name}` })
  const write = async (text: string, from = idle) => {
    await from.getByRole("button", { name: "Escribir lo dictado" }).click()
    await from.getByLabel("Escribe lo dictado").fill(text)
    await from.getByRole("button", { name: "Ordenar lo dictado" }).click()
  }
  await expect(idle).toContainText("Nada entra a la historia hasta que confirmes.")
  await write(DICTATION)
  await expect(review).toContainText("Dictado terminado: 4 sugerencias")
  await expect(review).toContainText("4 listas. Todavía no hay nada en la historia.")
  // Cada sugerencia vive en su bloque, que la cuenta en su resumen.
  await expect(suggested("Diagnóstico")).toContainText("K02.1 · Caries de la dentina")
  await expect(block("Diagnóstico")).toContainText("Sin diagnósticos confirmados · 1 sugerencia")
  await expect(suggested("Plan de tratamiento")).toContainText("Endodoncia multirradicular · S/ 650.00")
  await expect(block("Plan de tratamiento")).toContainText("Sin indicaciones confirmadas · 1 sugerencia")
  await expect(suggested("Controles").getByRole("listitem")).toHaveCount(1)
  await expect(suggested("Consulta")).toContainText("Viene por dolor al masticar del lado derecho.")
  // El cierre dice que el diagnóstico está sugerido, no registrado.
  const closing = page.getByRole("region", { name: "Cierre de la atención" })
  await expect(closing).toContainText("Diagnóstico: hay uno sugerido, sin confirmar")
  await expect(closing.getByRole("button", { name: "Finalizar y firmar" })).toBeDisabled()
  // Todavía no hay nada en la historia.
  const detail = () => call<{ encounter: { reason: string | null; evolution: string | null; status: string }; diagnoses: Array<{ cie10Code: string; toothNumber: number | null }> }>(page, "GET", `${apiPath}/encounters/${encounter.id}`, org.slug)
  expect((await detail()).diagnoses).toEqual([])
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("dictado-sugerencias", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Editar una en la superficie lateral: muestra lo que se dijo y «Guardar y confirmar» la lleva a la historia.
  await suggested("Controles").getByRole("button", { name: "Editar", exact: true }).click()
  await expect(page.getByText("Sugerencia del asistente")).toBeVisible()
  await expect(page.getByText("«Control en 6 meses.»")).toBeVisible()
  await info.attach("dictado-editar", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.getByLabel("Control", { exact: true }).fill("Control de endodoncia")
  await page.getByRole("button", { name: "Guardar y confirmar" }).click()
  await expect(review).toContainText("Dictado terminado: 3 sugerencias")
  const controls = () => call<Array<{ title: string; status: string }>>(page, "GET", `${apiPath}/follow-ups`, org.slug)
  expect(await controls()).toEqual([expect.objectContaining({ title: "Control de endodoncia", status: "pendiente" })])

  await review.getByRole("button", { name: "Confirmar las 3 listas" }).click()
  await expect(idle).toBeVisible()
  const saved = await detail()
  expect(saved.encounter).toMatchObject({ reason: "Viene por dolor al masticar del lado derecho.", evolution: "Se realizó apertura cameral sin complicaciones." })
  expect(saved.diagnoses).toEqual([expect.objectContaining({ cie10Code: "K02.1", toothNumber: 16 })])
  // La pantalla refleja lo confirmado sin recargar.
  await expect(closing.getByRole("listitem").filter({ hasText: "diagnóstico" })).toContainText("listo")

  // --- Mientras se dicta: las sugerencias llegan con cada pausa, sin terminar el dictado ---
  await idle.getByRole("button", { name: "Dictar", exact: true }).click()
  const live = page.getByRole("region", { name: "Dictado en curso" })
  await expect(live).toContainText("Escuchando")
  await expect(closing.getByRole("button", { name: "Finalizar y firmar" })).toBeDisabled()
  await expect(closing).toContainText("Termina el dictado y revisa las sugerencias para poder firmar.")
  // El respaldo queda al lado, con la ayuda para corregir hablando.
  const backup = page.getByRole("region", { name: "Lo dictado" })
  await expect(backup).toContainText("Para corregir, dilo")
  await say("y hacemos endodoncia", false)
  await expect(live).toContainText("Escuchando: «…y hacemos endodoncia»")
  await say("En la veinticinco hacemos endodoncia.")
  // Tras la pausa se ordena solo ese tramo, y el micrófono sigue encendido.
  await expect(suggested("Plan de tratamiento")).toContainText("Pieza 25", { timeout: 15_000 })
  await expect(live).toContainText("Escuchando")
  await expect(backup.locator("mark").last()).toHaveText("En la veinticinco hacemos endodoncia.")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("dictando", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  // Pausar apaga el micrófono; reanudar lo vuelve a encender.
  await live.getByRole("button", { name: "Pausar el dictado" }).click()
  await expect(live).toContainText("En pausa")
  await live.getByRole("button", { name: "Reanudar el dictado" }).click()
  await expect(live).toContainText("Escuchando")
  // Corregir hablando cambia la sugerencia pendiente y recuerda cómo estaba.
  await say("No, es la veintiséis.")
  await expect(suggested("Plan de tratamiento")).toContainText("corregido por voz, antes pieza 25", { timeout: 15_000 })
  await expect(suggested("Plan de tratamiento")).toContainText("Pieza 26")
  await live.getByRole("button", { name: "Terminar dictado" }).click()
  await expect(review).toContainText("Dictado terminado: 1 sugerencia")
  await expect(backup).toHaveCount(0)
  // Deshacer la corrección por voz vuelve a la pieza dictada primero.
  await suggested("Plan de tratamiento").getByRole("button", { name: "Deshacer" }).click()
  await expect(suggested("Plan de tratamiento")).toContainText("Pieza 25")
  await expect(suggested("Plan de tratamiento")).not.toContainText("corregido por voz")
  // «Quita…» la descarta sin tocarla.
  await write("Quita la endodoncia.", review)
  await expect(idle).toBeVisible()
  expect((await dictation()).suggestions).toEqual([])

  // Una prestación a la que le falta algo queda «Por revisar»: se completa en la superficie lateral.
  await write("Hacemos endodoncia.")
  const pendingPlan = suggested("Plan de tratamiento").getByRole("listitem")
  await expect(pendingPlan).toContainText("Por revisar")
  await expect(pendingPlan).toContainText("no dijiste cuál")
  await expect(review).toContainText("1 por revisar")
  await pendingPlan.getByRole("button", { name: "Buscar otra prestación" }).click()
  await expect(page.getByRole("combobox", { name: "Buscar otra prestación" })).toBeVisible()
  await expect(page.getByText("Precio del servicio: S/ 650.00. No se edita aquí.")).toBeVisible()
  await page.getByLabel("Pieza", { exact: true }).fill("26")
  await page.getByRole("button", { name: "Guardar y confirmar" }).click()
  await expect(idle).toBeVisible()
  const planItems = await call<Array<{ toothNumber: number | null; serviceName?: string }>>(page, "GET", `${apiPath}/plan`, org.slug)
  expect(planItems.filter((item) => item.toothNumber === 26)).toHaveLength(1)

  // --- Teléfono: dictar y revisar con las acciones fijas al pie, sin desbordes ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  // En pantalla estrecha el bloque abierto es un cajón: se cierra para ver la atención.
  const openBlock = page.getByRole("dialog", { name: "Consulta" })
  await openBlock.getByRole("button", { name: "Cancelar" }).click()
  await expect(openBlock).toBeHidden()
  const dictate = idle.getByRole("button", { name: "Dictar", exact: true })
  expect((await dictate.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await dictate.click()
  await expect(live).toContainText("Escuchando")
  await say("En la veintiséis hay caries.")
  await expect(suggested("Diagnóstico")).toContainText("K02.9", { timeout: 15_000 })
  const pause = live.getByRole("button", { name: "Pausar el dictado" })
  expect((await pause.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44)
  await expect(page.getByRole("button", { name: "Ver lo dictado" })).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("dictando-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.getByRole("button", { name: "Ver lo dictado" }).click()
  const backupDrawer = page.getByRole("dialog", { name: "Lo dictado" })
  await expect(backupDrawer).toContainText("En la veintiséis hay caries.")
  await backupDrawer.getByRole("button", { name: "Cerrar" }).click()
  await page.getByRole("button", { name: "Terminar dictado" }).click()
  await expect(review).toContainText("1 lista")
  // Revisión: confirmar y descartar son iconos con nombre; «Firmar» y «Confirmar las N listas» quedan al pie.
  const phoneRow = suggested("Diagnóstico").getByRole("listitem")
  const confirmIcon = phoneRow.getByRole("button", { name: /^Confirmar: K02\.9/ })
  expect((await confirmIcon.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expect(phoneRow.getByRole("button", { name: /^Descartar: K02\.9/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "Firmar", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Confirmar 1 lista" })).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("revision-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // Tocar la sugerencia la abre para editarla.
  await phoneRow.getByRole("button", { name: /^K02\.9/ }).click()
  await expect(page.getByRole("dialog").getByText("Sugerencia del asistente")).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await page.getByRole("dialog").getByRole("button", { name: "Cancelar" }).click()

  // --- Una sugerencia sin revisar: al firmar se nombra y, si se firma, no entra a la historia ---
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  await expect(closing).toContainText("Si quedan sugerencias sin revisar, te lo pregunta antes de firmar.")
  await closing.getByRole("button", { name: "Finalizar y firmar" }).click()
  const sign = page.getByRole("alertdialog", { name: "Queda 1 sugerencia sin revisar" })
  await expect(sign.getByRole("list", { name: "Sugerencias sin revisar" })).toContainText("Diagnóstico · falta confirmarla")
  await expect(sign).toContainText("Las otras 5 ya están confirmadas y se firman con la atención.")
  await info.attach("firmar-con-sugerencias", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // «Revisar ahora» vuelve a la atención sin firmar.
  await sign.getByRole("button", { name: "Revisar ahora" }).click()
  await expect(sign).toBeHidden()
  expect((await detail()).encounter.status).toBe("borrador")
  await closing.getByRole("button", { name: "Finalizar y firmar" }).click()
  await sign.getByRole("button", { name: "Descartarla y firmar" }).click()
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
