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

test("atender sin motivo: ningún formulario tapa a Clío y el motivo se pide al firmar", async ({ owner }, info) => {
  const { page, org } = owner
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Cyndy Cotrina", docType: "DNI", docNumber: "45678123" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}`))
  await page.getByRole("button", { name: "Atender", exact: true }).first().click()
  await expect(page).toHaveURL(/\/encounters\//)

  const idle = page.getByRole("region", { name: "Dictado de la atención" })
  const consulta = page.getByRole("region", { name: "Consulta" }).getByRole("button", { name: "Abrir", exact: true })
  const reason = page.getByLabel("Motivo", { exact: true })
  // Con Clío apagada tampoco se abre: «Consulta» espera a que la pidan.
  await expect(consulta).toHaveAttribute("aria-expanded", "false")
  await expect(reason).toHaveCount(0)
  await expect(idle).toHaveCount(0)

  await call(page, "PUT", "/api/agent/config", org.slug, { clinicalAssistantEnabled: true })
  await gotoHydrated(page, page.url())
  await expect(idle.getByRole("button", { name: "Dictar", exact: true })).toBeVisible()
  await expect(consulta).toHaveAttribute("aria-expanded", "false")
  await expect(reason).toHaveCount(0)
  await info.attach("atender-sin-motivo", { body: await page.screenshot(), contentType: "image/png" })

  // En el teléfono tampoco se abre el cajón encima.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, page.url())
  await expect(idle.getByRole("button", { name: "Dictar", exact: true })).toBeVisible()
  await expect(page.getByRole("dialog", { name: "Consulta" })).toHaveCount(0)
  await info.attach("atender-sin-motivo-movil", { body: await page.screenshot(), contentType: "image/png" })

  // Si no lo dictó ni lo escribió, «Finalizar y firmar» lleva a su campo con el cursor ahí.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  await expect(reason).toHaveAttribute("aria-invalid", "true")
  await expect(reason).toBeFocused()
  await expect(page.getByText("Escribe el motivo: es obligatorio para cerrar")).toBeVisible()

  // Ya escrito, volver a abrir «Consulta» no lleva el cursor ahí: en el teléfono subiría el teclado.
  await reason.fill("Dolor en una muela")
  await expect(page.getByText(/^Guardado /)).toBeVisible()
  await page.getByRole("complementary", { name: "Panel lateral" }).getByRole("region", { name: "Consulta" }).getByRole("button", { name: "Cerrar" }).click()
  await expect(reason).toHaveCount(0)
  await consulta.click()
  await expect(reason).toHaveValue("Dolor en una muela")
  await expect(reason).not.toBeFocused()
})

test("asistente clínico: dictado de práctica, sugerencias dentro de cada bloque mientras se dicta, revisión y aviso antes de firmar", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Lucía Fernández", docType: "DNI", docNumber: "87654321" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  const apiPath = `/api/patients/${patient.id}`
  // La clínica nace con las especialidades de la biblioteca: el servicio apunta a la suya (ADR 0039).
  const specialties = await call<Array<{ id: string; key: string }>>(page, "GET", "/api/clinical-forms/specialties", org.slug)
  const endodontics = await call<{ id: string }>(page, "POST", "/api/services", org.slug, {
    name: "Endodoncia multirradicular", specialtyId: specialties.find((item) => item.key === "endodoncia")!.id, scope: "tooth", priceCents: 65000, currency: "PEN",
    // En el Perú cada servicio propio lleva su código CPMS (ADR 0069).
    officialCode: "D3330",
  }, 201)
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, org.slug, { reason: "Consulta" }, 201)
  await call(page, "PUT", "/api/clinical-forms/professionals/me/profile", org.slug, {
    professionalTitle: "Cirujano dentista", registrationBody: "COP", registrationNumber: "12345",
  })
  const dictationPath = `${apiPath}/encounters/${encounter.id}/dictation`
  const dictation = () => call<{ enabled: boolean; suggestions: Array<{ kind: string; status: string }> }>(page, "GET", dictationPath, org.slug)

  // --- Apagado: la atención no ofrece dictar y el servidor no acepta dictados ---
  expect(await dictation()).toEqual({ enabled: false, suggestions: [], removedByVoice: [], undoRequests: [], teeth: [], confirmed: 0, blocked: null })
  expect((await api(page, "POST", dictationPath, org.slug, { transcript: DICTATION })).status).toBe(409)
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  await expect(page.getByRole("region", { name: "Cierre de la atención" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Dictado de la atención" })).toHaveCount(0)

  // --- Página del asistente: dictado de práctica y encendido ---
  await gotoHydrated(page, tenant(org.slug, "/agent"))
  const row = page.getByRole("region", { name: "Tus agentes" }).getByRole("listitem").filter({ hasText: "Clío" })
  await expect(row).toContainText("Apagado")
  await row.getByRole("link", { name: "Ver y encender" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Clío, tu agente clínico" })).toBeVisible()
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
  await page.getByRole("switch", { name: "Encender a Clío" }).click()
  await expect(page.getByRole("switch", { name: "Apagar a Clío" })).toBeChecked()

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
  const suggested = (name: string) => page.getByRole("list", { name: `Sugerencias de Clío: ${name}` })
  const write = async (text: string, from = idle) => {
    await from.getByRole("button", { name: "Escribir en vez de dictar" }).click()
    await from.getByLabel("Escribe lo dictado").fill(text)
    await from.getByRole("button", { name: "Ordenar lo dictado" }).click()
  }
  await expect(idle).toContainText("Nada entra a la historia hasta que confirmes.")
  await write(DICTATION)
  await expect(review).toContainText("Clío dejó 4 sugerencias por revisar")
  await expect(review).toContainText("4 listas. Nada entra a la historia hasta que lo confirmes.")
  // Cada sugerencia vive en su bloque, que la cuenta en su resumen.
  await expect(suggested("Diagnóstico")).toContainText("K02.1 · Caries de la dentina")
  await expect(block("Diagnóstico")).toContainText("Sin diagnósticos confirmados · 1 sugerencia")
  await expect(suggested("Plan de tratamiento")).toContainText("Endodoncia multirradicular · S/ 650.00")
  // Indicaciones y controles se revisan en un solo bloque, «Plan y controles» (ADR 0034).
  await expect(block("Plan y controles")).toContainText("Sin indicaciones confirmadas · 2 sugerencias")
  await expect(block("Plan y controles").getByRole("list", { name: "Sugerencias de Clío: Controles" }).getByRole("listitem")).toHaveCount(1)
  await expect(suggested("Consulta")).toContainText("Viene por dolor al masticar del lado derecho.")
  // El cierre dice que el diagnóstico está sugerido, no registrado.
  const closing = page.getByRole("region", { name: "Cierre de la atención" })
  // «Finalizar y firmar» queda fijo al pie de la atención (fase 3, paso 2B), fuera del bloque de cierre.
  const signButton = page.getByRole("button", { name: "Finalizar y firmar", exact: true })
  await expect(closing).toContainText("Diagnóstico: hay uno sugerido, sin confirmar")
  // Lo que falta no apaga «Finalizar y firmar» (ADR 0113, como en patients.spec): sin abrir el cierre,
  // lleva a lo primero que falta (la evolución, sugerida pero sin confirmar) y lo marca en su campo.
  await expect(page.getByText("Faltan 2 para cerrar: diagnóstico y evolución")).toBeVisible()
  await expect(signButton).toBeEnabled()
  await signButton.click()
  const missingPanel = page.getByRole("complementary", { name: "Panel lateral" }).getByRole("region", { name: "Evolución, pronóstico e indicaciones" })
  await expect(missingPanel.getByLabel("Evolución", { exact: true })).toHaveAttribute("aria-invalid", "true")
  await expect(missingPanel.getByText("Escribe la evolución: es obligatoria para cerrar")).toBeVisible()
  await expect(page.getByRole("dialog", { name: "Finalizar y firmar" })).toHaveCount(0)
  await missingPanel.getByRole("button", { name: "Cerrar" }).click()
  await expect(missingPanel).toHaveCount(0)
  // Nada entra a la historia hasta que lo confirmes.
  const detail = () => call<{ encounter: { reason: string | null; evolution: string | null; status: string }; diagnoses: Array<{ diagnosisCode: string; toothNumber: number | null }> }>(page, "GET", `${apiPath}/encounters/${encounter.id}`, org.slug)
  expect((await detail()).diagnoses).toEqual([])
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("dictado-sugerencias", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Editar una en la superficie lateral: muestra lo que se dijo y «Guardar y confirmar» la lleva a la historia.
  await suggested("Controles").getByRole("button", { name: "Editar", exact: true }).click()
  await expect(page.getByText("Sugerencia de Clío")).toBeVisible()
  await expect(page.getByText("«Control en 6 meses.»")).toBeVisible()
  await info.attach("dictado-editar", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await page.getByLabel("Control", { exact: true }).fill("Control de endodoncia")
  await page.getByRole("button", { name: "Guardar y confirmar" }).click()
  await expect(review).toContainText("Clío dejó 3 sugerencias por revisar")
  const controls = () => call<Array<{ title: string; status: string }>>(page, "GET", `${apiPath}/follow-ups`, org.slug)
  expect(await controls()).toEqual([expect.objectContaining({ title: "Control de endodoncia", status: "pendiente" })])

  await review.getByRole("button", { name: "Confirmar las 3 listas" }).click()
  await expect(idle).toBeVisible()
  const saved = await detail()
  expect(saved.encounter).toMatchObject({ reason: "Viene por dolor al masticar del lado derecho.", evolution: "Se realizó apertura cameral sin complicaciones." })
  expect(saved.diagnoses).toEqual([expect.objectContaining({ diagnosisCode: "K02.1", toothNumber: 16 })])
  // La pantalla refleja lo confirmado sin recargar.
  await expect(closing.getByRole("listitem").filter({ hasText: "diagnóstico" })).toContainText("listo")

  // --- Mientras se dicta: las sugerencias llegan con cada pausa, sin terminar el dictado ---
  await idle.getByRole("button", { name: "Dictar", exact: true }).click()
  const live = page.getByRole("region", { name: "Dictado en curso" })
  await expect(live).toContainText("Escuchando")
  await expect(signButton).toBeDisabled()
  await expect(closing).toContainText("Termina el dictado y revisa las sugerencias para poder firmar.")
  // El respaldo queda al lado, con qué se puede decir y cómo corregir hablando (issue 109).
  const backup = page.getByRole("region", { name: "Lo dictado" })
  await expect(backup).toContainText("Qué puedo decir")
  await expect(backup).toContainText("«La 36 con caries oclusal en dentina, la 46 ausente»")
  await say("y hacemos endodoncia", false)
  await expect(live).toContainText("Lo último que oí«…y hacemos endodoncia»")
  await info.attach("dictado-oyendo", { body: await live.screenshot(), contentType: "image/png" })
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
  await expect(review).toContainText("Clío dejó 1 sugerencia por revisar")
  await expect(backup).toHaveCount(0)
  // Deshacer la corrección por voz vuelve a la pieza dictada primero.
  await suggested("Plan de tratamiento").getByRole("button", { name: "Deshacer" }).click()
  await expect(suggested("Plan de tratamiento")).toContainText("Pieza 25")
  await expect(suggested("Plan de tratamiento")).not.toContainText("corregido por voz")
  // «Quita…» la saca de lo pendiente, a la vista y tachada, con «Deshacer» (issue 135).
  await write("Quita la endodoncia.", review)
  await expect(idle).toBeVisible()
  expect((await dictation()).suggestions).toEqual([])
  const removedRow = suggested("Plan de tratamiento").getByRole("listitem").filter({ hasText: "Quitada por voz" })
  await expect(removedRow).toContainText("dijiste «Quita la endodoncia.»")
  await removedRow.getByRole("button", { name: "Deshacer" }).click()
  await expect(suggested("Plan de tratamiento")).toContainText("Pieza 25")
  await expect(suggested("Plan de tratamiento")).not.toContainText("Quitada por voz")
  // Descartarla a mano ya no se deshace: no fue la voz.
  await suggested("Plan de tratamiento").getByRole("button", { name: /^Descartar:/ }).click()
  await expect(idle).toBeVisible()
  expect((await dictation()).suggestions).toEqual([])

  // Odontograma por voz (issue 109): el hallazgo va a su bloque y, en Perú, pide la causa de la ausencia con un toque.
  await write("La cuarenta y seis está ausente.")
  const finding = suggested("Odontograma").getByRole("listitem")
  await expect(finding).toContainText("Pieza 46 · Pieza dentaria ausente")
  await expect(finding).toContainText("Por revisar")
  await finding.getByRole("button", { name: "Diente no erupcionado" }).click()
  await expect(finding).not.toContainText("Por revisar")
  await finding.getByRole("button", { name: "Confirmar", exact: true }).click()
  await expect(block("Odontograma")).toContainText("1 hallazgo en esta atención")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("dictado-odontograma", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // A una prestación le falta la pieza: no frena (ADR 0099). Avisa, ofrece las piezas que ya se
  // nombraron y se completa con un toque; también se podría confirmar así y definirla al hacerla.
  const in16 = async () =>
    (await call<Array<{ toothNumber: number | null }>>(page, "GET", `${apiPath}/plan`, org.slug)).filter((item) => item.toothNumber === 16).length
  const before16 = await in16()
  await write("Hacemos endodoncia.")
  const pendingPlan = suggested("Plan de tratamiento").getByRole("listitem")
  await expect(pendingPlan).toContainText("¿En qué pieza?")
  await expect(pendingPlan).not.toContainText("Por revisar")
  await expect(pendingPlan.getByRole("button", { name: "Confirmar", exact: true })).toBeEnabled()
  await info.attach("dictado-pieza-por-definir", { body: await pendingPlan.screenshot(), contentType: "image/png" })
  await pendingPlan.getByRole("group", { name: "Pieza" }).getByRole("button", { name: "16", exact: true }).click()
  await expect(pendingPlan).toContainText("Pieza 16")
  await expect(pendingPlan).not.toContainText("¿En qué pieza?")
  await pendingPlan.getByRole("button", { name: "Confirmar", exact: true }).click()
  await expect(idle).toBeVisible()
  expect(await in16()).toBe(before16 + 1)

  // --- Teléfono: dictar y revisar con las acciones fijas al pie, sin desbordes ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
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
  await expect(page.getByRole("dialog").getByText("Sugerencia de Clío")).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await page.getByRole("dialog").getByRole("button", { name: "Cancelar" }).click()

  // --- Una sugerencia sin confirmar: al firmar viene marcada; desmarcada, no entra a la historia ---
  // Con un consentimiento por firmar (la endodoncia de hoy pide el suyo, aún sin publicar): firmar
  // con lo dictado no pide el motivo, que no está en ese diálogo; sigue al cierre para darlo.
  const consent = await call<{ id: string }>(page, "POST", "/api/clinical-forms/consent-templates", org.slug, {
    key: `endodoncia-${crypto.randomUUID().slice(0, 8)}`,
    title: "Endodoncia",
    body: "Tratamiento de conductos de la pieza indicada, con anestesia local, en una o más citas.",
  }, 201)
  await call(page, "PUT", `/api/clinical-forms/consent-templates/${consent.id}/services`, org.slug, { serviceIds: [endodontics.id] })
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/procedures`, org.slug, { serviceId: endodontics.id, toothNumber: 26 }, 201)
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  await expect(closing).toContainText("Si quedan sugerencias sin revisar, te lo pregunta antes de firmar.")
  await signButton.click()
  const sign = page.getByRole("alertdialog", { name: "Firmar la atención" })
  const dictated = sign.getByRole("list", { name: "Lo dictado sin confirmar" })
  await expect(dictated).toContainText("K02.9")
  await expect(dictated.getByRole("checkbox")).toBeChecked()
  await expect(sign.getByRole("button", { name: "Firmar con 1 marcada" })).toBeVisible()
  await info.attach("firmar-con-sugerencias", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // «Volver» vuelve a la atención sin firmar.
  await sign.getByRole("button", { name: "Volver" }).click()
  await expect(sign).toBeHidden()
  expect((await detail()).encounter.status).toBe("borrador")
  await signButton.click()
  await dictated.getByRole("checkbox").click()
  await expect(dictated).toContainText("desmarcada: no entra")
  await sign.getByRole("button", { name: "Firmar sin lo dictado" }).click()
  const closingDialog = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(sign).toBeHidden()
  await expect(closingDialog).toContainText("Esta clínica aún no activó el consentimiento de «Endodoncia»")
  // Lo dictado ya se resolvió: lo desmarcado no entró y no se vuelve a preguntar.
  expect((await dictation()).suggestions).toEqual([])
  expect((await detail()).encounter.status).toBe("borrador")
  await closingDialog.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  await expect(closingDialog.getByText("Escribe por qué sigues sin el consentimiento, o fírmalo ahora")).toBeVisible()
  await closingDialog.getByLabel("Seguir sin él: ¿por qué?").fill("Urgencia: se firmará en la próxima cita")
  await closingDialog.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
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

test("asistente clínico: la alergia dictada y lo hecho hoy se confirman donde van", async ({ owner }, info) => {
  const { page, org } = owner
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Rosa Quispe", docType: "DNI", docNumber: "76543210" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  const apiPath = `/api/patients/${patient.id}`
  const specialties = await call<Array<{ id: string; key: string }>>(page, "GET", "/api/clinical-forms/specialties", org.slug)
  await call(page, "POST", "/api/services", org.slug, {
    name: "Endodoncia multirradicular", specialtyId: specialties.find((item) => item.key === "endodoncia")!.id, scope: "tooth", priceCents: 65000, currency: "PEN",
    officialCode: "D3330",
  }, 201)
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, org.slug, { reason: "Consulta" }, 201)
  await call(page, "PUT", "/api/clinical-forms/professionals/me/profile", org.slug, {
    professionalTitle: "Cirujano dentista", registrationBody: "COP", registrationNumber: "12345",
  })
  await call(page, "PUT", "/api/agent/config", org.slug, { clinicalAssistantEnabled: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  const idle = page.getByRole("region", { name: "Dictado de la atención" })
  const suggested = (name: string) => page.getByRole("list", { name: `Sugerencias de Clío: ${name}` })
  const write = async (text: string) => {
    await idle.getByRole("button", { name: "Escribir en vez de dictar" }).click()
    await idle.getByLabel("Escribe lo dictado").fill(text)
    await idle.getByRole("button", { name: "Ordenar lo dictado" }).click()
  }
  await write("Es alérgica a la penicilina. Le hice la endodoncia multirradicular en la dieciséis.")

  // La alergia va junto a las alertas, con su código; qué tan fuerte fue es un aviso que se toca.
  const allergy = suggested("Alergias").getByRole("listitem").first()
  await expect(allergy).toContainText("Alergia a penicilinas")
  await expect(allergy).toContainText("¿Qué tan fuerte fue?")
  await expect(allergy.getByRole("button", { name: "Confirmar", exact: true })).toBeEnabled()
  // Lo hecho hoy va en Procedimientos, de tus servicios y con su precio.
  const done = suggested("Procedimientos").getByRole("listitem").first()
  await expect(done).toContainText("Hecho hoy · Endodoncia multirradicular · S/ 650.00")
  await expect(done).toContainText("Pieza 16")
  await expect(done).toContainText("de tus servicios")
  await info.attach("alergia-y-hecho-hoy", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  await allergy.getByRole("button", { name: "Severa", exact: true }).click()
  await expect(allergy).not.toContainText("¿Qué tan fuerte fue?")
  await allergy.getByRole("button", { name: "Confirmar", exact: true }).click()
  // Confirmada, se ve al momento en la franja: severa, en rojo y primero.
  await expect(page.getByLabel("Alertas clínicas")).toContainText(/Alergia severa: penicilinas/i)
  await done.getByRole("button", { name: "Confirmar", exact: true }).click()
  await expect(suggested("Procedimientos")).toHaveCount(0)
  const detail = await call<{ procedures: Array<{ description: string; priceCents: number | null; voidedAt: string | null }> }>(page, "GET", `${apiPath}/encounters/${encounter.id}`, org.slug)
  expect(detail.procedures.filter((item) => !item.voidedAt).map((item) => [item.description, item.priceCents])).toEqual([["Endodoncia multirradicular", 65000]])

  // Ya registrada: no se propone otra vez, se avisa.
  await write("Es alérgica a la penicilina.")
  await expect(page.getByText("La alergia a penicilinas ya está en sus antecedentes.")).toBeVisible()
  await expect(suggested("Alergias")).toHaveCount(0)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
})

test("asistente clínico: la próxima cita y el presupuesto se piden por voz y se resuelven en la atención", async ({ owner }, info) => {
  const { page, org } = owner
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Rosa Quispe", docType: "DNI", docNumber: "76543211" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  const apiPath = `/api/patients/${patient.id}`
  const specialties = await call<Array<{ id: string; key: string }>>(page, "GET", "/api/clinical-forms/specialties", org.slug)
  await call(page, "POST", "/api/services", org.slug, {
    name: "Endodoncia multirradicular", specialtyId: specialties.find((item) => item.key === "endodoncia")!.id, scope: "tooth", priceCents: 65000, currency: "PEN",
    officialCode: "D3330",
  }, 201)
  // La agenda que lee Clío: una unidad dental y el horario de quien atiende, todos los días de 9 a 18.
  await call(page, "POST", "/api/agenda/rooms", org.slug, { branchId: owner.branchId, name: "Unidad dental 1" }, 201)
  await call(page, "PUT", "/api/agenda/schedules", org.slug, {
    branchId: owner.branchId,
    professionalUserId: owner.user.id,
    rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 18 * 60 })),
  }, 200)
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, org.slug, { reason: "Consulta" }, 201)
  await call(page, "PUT", "/api/clinical-forms/professionals/me/profile", org.slug, {
    professionalTitle: "Cirujano dentista", registrationBody: "COP", registrationNumber: "12345",
  })
  await call(page, "PUT", "/api/agent/config", org.slug, { clinicalAssistantEnabled: true })
  const dictationPath = `${apiPath}/encounters/${encounter.id}/dictation`
  const dictation = () => call<{ suggestions: Array<{ kind: string; status: string }>; confirmed: number }>(page, "GET", dictationPath, org.slug)
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  const idle = page.getByRole("region", { name: "Dictado de la atención" })
  const suggested = (name: string) => page.getByRole("list", { name: `Sugerencias de Clío: ${name}` })
  await idle.getByRole("button", { name: "Escribir en vez de dictar" }).click()
  await idle.getByLabel("Escribe lo dictado").fill("En la dieciséis hacemos endodoncia. Cítalo en quince días para la endodoncia. Arma el presupuesto para enseñárselo.")
  await idle.getByRole("button", { name: "Ordenar lo dictado" }).click()

  // La cita: tu primer hueco desde ese día, con otros para tocar y el aviso que recibirá.
  const booking = suggested("Próxima cita").getByRole("listitem").first()
  await expect(booking).toContainText("Cita · ")
  await expect(booking).toContainText("Endodoncia multirradicular")
  // Los huecos se nombran «Jue 12 · 10:00»; el elegido está marcado.
  const slots = booking.getByRole("group", { name: "Otros horarios libres" }).getByRole("button", { name: / · \d{2}:\d{2}$/ })
  await expect(slots).toHaveCount(3)
  await expect(booking.getByRole("group", { name: "Otros horarios libres" }).getByRole("button", { pressed: true })).toHaveCount(1)
  await expect(booking).toContainText("Rosa recibe el aviso de la cita")
  // El presupuesto: lo dictado hoy, con su precio, en borrador.
  const budget = suggested("Presupuesto").getByRole("listitem").first()
  await expect(budget).toContainText("Presupuesto · 1 tratamiento · S/ 650.00")
  await expect(budget).toContainText("dictada hoy: entra al plan")
  await info.attach("cita-y-presupuesto", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Armar confirma la indicación dictada y deja el borrador para mostrarlo sin salir.
  await budget.getByRole("button", { name: "Armar", exact: true }).click()
  await expect(page.getByText("Presupuesto armado.")).toBeVisible()
  await expect(suggested("Plan de tratamiento")).toHaveCount(0)
  await page.getByRole("button", { name: "Mostrar a Rosa" }).click()
  const shown = page.getByRole("dialog", { name: "Presupuesto para Rosa Quispe" })
  await expect(shown).toContainText("Mostrarlo no le envía nada")
  await expect(shown.locator("iframe")).toBeVisible({ timeout: 15_000 })
  await info.attach("mostrar-presupuesto", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await shown.getByRole("button", { name: "Cerrar" }).first().click()

  // Tocar otro hueco y reservar: la cita queda con quien atiende.
  await booking.getByRole("group", { name: "Otros horarios libres" }).getByRole("button", { name: / · \d{2}:\d{2}$/, pressed: false }).first().click()
  await booking.getByRole("button", { name: "Reservar", exact: true }).click()
  await expect(page.getByText("Cita reservada.")).toBeVisible()
  await expect(suggested("Próxima cita")).toHaveCount(0)
  expect((await dictation()).suggestions.filter((item) => item.kind === "cita")).toEqual([])
  expect(await overflow(page)).toBeLessThanOrEqual(0)
})

test("asistente clínico: el material dicho es el total de la atención y sale de la sede al firmar (ADR 0106)", async ({ owner }, info) => {
  const { page, org } = owner
  const product = async (name: string, unit: string, counted: number) => {
    const created = await call<{ id: string }>(page, "POST", "/api/inventory/products", org.slug, { name, usedInCare: true, unit }, 201)
    await call(page, "POST", "/api/inventory/count", org.slug, { branchId: owner.branchId, idempotencyKey: crypto.randomUUID(), items: [{ productId: created.id, counted }] })
    return created.id
  }
  const onHand = async (productId: string) =>
    (await call<{ items: Array<{ id: string; onHand: number }> }>(page, "GET", `/api/inventory/products?branchId=${owner.branchId}`, org.slug)).items.find((item) => item.id === productId)?.onHand
  const gloves = await product("Guantes de prueba", "par", 10)
  const mask = await product("Mascarilla de prueba", "unidad", 5)
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Rosa Quispe", docType: "DNI", docNumber: "76543211" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  const apiPath = `/api/patients/${patient.id}`
  const specialties = await call<Array<{ id: string; key: string }>>(page, "GET", "/api/clinical-forms/specialties", org.slug)
  const service = await call<{ id: string }>(page, "POST", "/api/services", org.slug, {
    name: "Endodoncia multirradicular", specialtyId: specialties.find((item) => item.key === "endodoncia")!.id, scope: "tooth", priceCents: 65000, currency: "PEN",
    officialCode: "D3330",
  }, 201)
  // Cada endodoncia trae 2 pares de guantes.
  await call(page, "PUT", `/api/services/${service.id}/materials`, org.slug, { items: [{ productId: gloves, quantity: 2 }] })
  const encounter = await call<{ id: string }>(page, "POST", `${apiPath}/encounters`, org.slug, { reason: "Endodoncia de la 16", branchId: owner.branchId }, 201)
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/procedures`, org.slug, { serviceId: service.id, toothNumber: 16 }, 201)
  await call(page, "PATCH", `${apiPath}/encounters/${encounter.id}`, org.slug, { evolution: "Se realiza la endodoncia de la 16." })
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/diagnoses`, org.slug, { diagnosisCode: "K02.1", diagnosisType: "confirmed", toothNumber: 16 }, 201)
  await call(page, "PUT", "/api/clinical-forms/professionals/me/profile", org.slug, {
    professionalTitle: "Cirujano dentista", registrationBody: "COP", registrationNumber: "12345",
  })
  await call(page, "PUT", "/api/agent/config", org.slug, { clinicalAssistantEnabled: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}/encounters/${encounter.id}`))
  const idle = page.getByRole("region", { name: "Dictado de la atención" })
  await idle.getByRole("button", { name: "Escribir en vez de dictar" }).click()
  await idle.getByLabel("Escribe lo dictado").fill("Usé una mascarilla. Usé cuatro pares de guantes.")
  await idle.getByRole("button", { name: "Ordenar lo dictado" }).click()

  // Van con lo hecho hoy; los guantes dicen que la endodoncia ya los trae y que no se suman.
  const materials = page.getByRole("list", { name: "Sugerencias de Clío: Materiales" })
  const maskRow = materials.getByRole("listitem").filter({ hasText: "Mascarilla de prueba" })
  const glovesRow = materials.getByRole("listitem").filter({ hasText: "Guantes de prueba" })
  await expect(maskRow).toContainText("1 unidad en total")
  await expect(maskRow).toContainText("Sale de la sede al firmar")
  await expect(glovesRow).toContainText("4 pares en total")
  await expect(glovesRow).toContainText("Endodoncia multirradicular ya trae 2 pares: vale el total, no se suma")
  await info.attach("clio-materiales", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await maskRow.getByRole("button", { name: "Confirmar", exact: true }).click()
  await expect(page.getByText("Anotado. Sale de la sede al firmar; lo ves en el cierre.").first()).toBeVisible()
  await glovesRow.getByRole("button", { name: "Confirmar", exact: true }).click()
  await expect(materials).toHaveCount(0)

  // El cierre lo anuncia: 4 pares (no 6) y la mascarilla.
  await page.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  const signing = page.getByRole("dialog", { name: "Finalizar y firmar" })
  await expect(signing).toContainText("se descuentan de Sede Central: 4 pares de guantes de prueba y 1 unidad de mascarilla de prueba.")
  await signing.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Atención finalizada" }).getByRole("region", { name: "Materiales" })).toContainText(
    "Salieron de Sede Central: 4 pares de guantes de prueba y 1 unidad de mascarilla de prueba.",
  )
  expect(await onHand(gloves)).toBe(6)
  expect(await onHand(mask)).toBe(4)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
})
