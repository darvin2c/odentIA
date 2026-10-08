import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant, tenantPattern } from "./env"
import { api, call, chooseOption, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import {
  buildClinicalBase,
  createAcceptedBudget,
  createDraftBudget,
  enableAgenda,
  grantLegalRepresentative,
  patientApiPath,
  setupAggregation,
} from "./patients-fixture"

/** Abre una sección de la ficha por su navegación: área, sección y, si aplica, tipo. */
async function openSection(page: Page, ...names: string[]): Promise<void> {
  for (const name of names) {
    const tab = page.getByRole("tab", { name, exact: true })
    await expect(tab).toBeEnabled()
    await tab.click()
  }
}

/** Abre un tratamiento del plan por fases (queda «Abierto abajo»). */
async function openTreatment(page: Page, title: string) {
  const row = page.getByRole("listitem").filter({ hasText: title }).first()
  const open = row.getByRole("button", { name: /^(Ver|Abierto abajo)$/ })
  await expect(open).toBeEnabled()
  if ((await open.textContent())?.trim() === "Ver") await open.click()
  await expect(row.getByRole("button", { name: "Abierto abajo" })).toBeVisible()
}

test("paciente: ficha inicial y hallazgo visibles en el recorrido", async ({ owner }) => {
  const ids = await buildClinicalBase(owner)
  const { page } = owner
  const patientPath = `/patients/${ids.patientId}`

  await gotoHydrated(page, tenant(owner.org.slug, patientPath))
  await expect(page).toHaveURL(tenantPattern(owner.org.slug, patientPath))
  await expect(page.getByRole("heading", { name: "Lucía Quispe" })).toBeVisible()
  await expect(page.getByText(/HC-\d{6}/)).toBeVisible()
  await expect(page.getByText("Alergia severa: Penicilina")).toBeVisible()

  // El resumen abre con lo pendiente; el mapa clínico vive en Clínica junto al plan.
  await expect(page.getByRole("heading", { name: "Pendientes" })).toBeVisible()
  await openSection(page, "Clínica")
  await expect(page.getByRole("heading", { name: "Odontograma", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Plan de tratamiento" })).toBeVisible()
  // En el arco la pieza va girada: mesial debe quedar del lado del vecino mesial
  // también en la arcada superior (16 → hacia 15), no del distal (17).
  const center = async (selector: string) => {
    const box = await page.locator(selector).first().boundingBox()
    if (!box) throw new Error(`sin geometría para ${selector}`)
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y)
  for (const [tooth, mesialNeighbor, distalNeighbor] of [
    [16, 15, 17],
    [36, 35, 37],
  ]) {
    const zone = await center(`[data-tooth="${tooth}"] [data-surface="mesial"]`)
    expect(
      distance(zone, await center(`[data-tooth="${mesialNeighbor}"]`)),
      `mesial de la pieza ${tooth} mira a la ${mesialNeighbor}`,
    ).toBeLessThan(distance(zone, await center(`[data-tooth="${distalNeighbor}"]`)))
  }

  // La indicación abierta señala su pieza y la selecciona en el odontograma.
  await page.getByRole("button", { name: "Ver pieza 36" }).click()
  await expect(page.locator('[data-tooth="36"][aria-pressed="true"]')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("pieza-seleccionada.png"), fullPage: true })

  // Tratamientos: qué se observó, qué se propuso, qué se decidió.
  await openSection(page, "Tratamientos")
  const recorrido = page.locator("body")
  await expect(recorrido.getByText("1. Qué se observó")).toBeVisible()
  await expect(recorrido.getByText(/caries/).first()).toBeVisible()
  await expect(recorrido.getByText("2. Qué se propuso")).toBeVisible()
  await expect(
    recorrido.getByText("Este tratamiento aún no está en ninguna propuesta."),
  ).toBeVisible()
  await expect(recorrido.getByText("3. Qué se decidió")).toBeVisible()
  await expect(
    page
      .locator("span")
      .filter({ hasText: /^Pendiente de decisión$/ })
      .first(),
  ).toBeVisible()
})

test("paciente: responsabilidad y decisión de la propuesta", async ({ owner }) => {
  const ids = await buildClinicalBase(owner)
  // Solo borrador: la responsabilidad la asigna este caso por UI.
  const { budgetId } = await createDraftBudget(owner, ids)
  const { page } = owner
  const patientPath = `/patients/${ids.patientId}`

  await gotoHydrated(
    page,
    tenant(owner.org.slug, `${patientPath}?tab=plan&planId=${ids.planId}&budgetId=${budgetId}`),
  )
  const presentar = page.getByRole("button", { name: "Presentar", exact: true })
  await expect(presentar).toBeEnabled()
  await presentar.click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Presentar", exact: true })
    .click()
  await expect(
    page
      .locator("span")
      .filter({ hasText: /^Presentado$/ })
      .first(),
  ).toBeVisible()

  // Responsables: el rol vigente habilita registrar quién decide la propuesta.
  await openSection(page, "Datos", "Responsables")
  await page.getByRole("button", { name: "Asignar responsabilidad" }).click()
  const responsibility = page.getByRole("dialog", { name: "Asignar responsabilidad" })
  await chooseOption(responsibility.getByLabel("Contacto vinculado", { exact: true }), ids.contactId)
  await chooseOption(
    responsibility.getByLabel("Responsabilidad", { exact: true }),
    "representante_legal",
  )
  await responsibility.getByRole("button", { name: "Asignar", exact: true }).click()
  await expect(page.getByText("Madre de Lucía", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Vigente", { exact: true }).first()).toBeVisible()

  await gotoHydrated(
    page,
    tenant(owner.org.slug, `${patientPath}?tab=plan&planId=${ids.planId}&budgetId=${budgetId}`),
  )
  const registrarDecision = page.getByRole("button", { name: "Registrar decisión", exact: true })
  await expect(registrarDecision).toBeEnabled()
  await registrarDecision.click()
  const decision = page.locator('[aria-label="Registrar decisión"]')
  await chooseOption(decision.getByLabel("Quién decide", { exact: true }), {
    label: "Representante legal: Madre de Lucía",
  })
  await chooseOption(decision.getByRole("combobox").first(), "aceptado")
  await decision.getByRole("button", { name: "Registrar", exact: true }).click()
  await expect(
    page
      .locator("span")
      .filter({ hasText: /^Aceptado$/ })
      .first(),
  ).toBeVisible()

  // Alternativas: la agrupación y la recomendación se registran desde la ficha.
  await page.getByRole("button", { name: "Crear agrupación", exact: true }).click()
  const groupDrawer = page.getByRole("dialog", { name: "Crear agrupación de alternativas" })
  await groupDrawer.getByLabel("Título de la agrupación").fill("Resina o corona")
  await groupDrawer.getByRole("button", { name: "Crear agrupación", exact: true }).click()
  await expect(page.getByText("Resina o corona").first()).toBeVisible()
  const alternativeSelect = page.getByLabel(/^Alternativa de /).first()
  await chooseOption(alternativeSelect, { label: "Resina o corona" })
  // La agrupación se guarda y la ficha se refresca antes de marcar la recomendación.
  await expect(alternativeSelect).toHaveText(/Resina o corona/)
  const recommended = page.getByLabel("Recomendada", { exact: true }).first()
  await expect(recommended).toBeEnabled()
  // El estado lo confirma el servidor: se espera la recarga de la ficha.
  await recommended.click()
  await expect(recommended).toBeChecked()
})

test("paciente: cuenta con cargo, pago y aplicación", async ({ owner }) => {
  const ids = await buildClinicalBase(owner)
  const { budgetId } = await createAcceptedBudget(owner, ids)
  const { page } = owner
  const patientPath = `/patients/${ids.patientId}`

  // Cargo explícito desde la línea aceptada: aceptar no cobra por sí solo.
  await gotoHydrated(
    page,
    tenant(owner.org.slug, `${patientPath}?tab=plan&planId=${ids.planId}&budgetId=${budgetId}`),
  )
  const generarCargo = page.getByRole("button", { name: "Generar cargo", exact: true }).first()
  await expect(generarCargo).toBeEnabled()
  await generarCargo.click()
  const charge = page.getByRole("dialog", { name: /Generar cargo/ })
  await charge.getByRole("button", { name: "Generar cargo", exact: true }).click()

  // Pago y aplicación desde la ficha.
  await openSection(page, "Tratamientos")
  await expect(
    page
      .locator("span")
      .filter({ hasText: /^Aceptado$/ })
      .first(),
  ).toBeVisible()
  await openSection(page, "Cuenta")
  await expect(page.getByText("POR COBRAR").first()).toBeVisible()
  await page.getByRole("button", { name: "Registrar pago o anticipo" }).click()
  const payment = page.getByRole("dialog", { name: "Registrar pago o anticipo" })
  await payment.getByLabel("Importe", { exact: true }).fill("200")
  await chooseOption(payment.getByLabel("Quién paga", { exact: true }), ids.contactId)
  await payment.getByRole("button", { name: "Registrar pago" }).click()
  // Cargos y pagos usan la tabla común: se leen por su sección.
  const chargesTable = page.getByRole("table").first()
  const paymentsTable = page.getByRole("table").nth(1)
  await expect(paymentsTable).toContainText("S/ 200.00")
  await page.getByRole("button", { name: "Aplicar a un cargo" }).first().click()
  const apply = page.getByRole("dialog", { name: "Aplicar pago a un cargo" })
  await apply.getByLabel("Importe a aplicar", { exact: true }).fill("150")
  await apply.getByRole("button", { name: "Aplicar", exact: true }).click()
  await expect(chargesTable).toContainText("S/ 150.00")
  await expect(chargesTable).toContainText("S/ 300.00")
  await expect(paymentsTable).toContainText("S/ 50.00")
  await expect(paymentsTable).toContainText("S/ 150.00 a")
})

test("paciente: receta vinculada al tratamiento y anulación", async ({ owner }) => {
  const ids = await buildClinicalBase(owner)
  await createAcceptedBudget(owner, ids)
  const { page } = owner
  const patientPath = `/patients/${ids.patientId}`

  await gotoHydrated(page, tenant(owner.org.slug, patientPath))
  await openSection(page, "Clínica", "Documentos", "Recetas")
  await page.getByRole("button", { name: "Emitir receta" }).click()
  const prescription = page.getByRole("dialog", { name: "Emitir receta" })
  await chooseOption(prescription.getByLabel("Tratamiento", { exact: true }), ids.itemId)
  await prescription.getByLabel("DCI (denominación común)", { exact: true }).fill("ibuprofeno")
  await prescription.getByLabel("Concentración", { exact: true }).fill("400 mg")
  await chooseOption(prescription.getByLabel("Forma farmacéutica", { exact: true }), "tableta")
  await prescription.getByLabel("Dosis", { exact: true }).fill("1 tableta")
  await prescription.getByLabel("Frecuencia", { exact: true }).fill("Cada 8 horas")
  await prescription.getByLabel("Duración", { exact: true }).fill("3 días")
  await prescription.getByRole("button", { name: "Emitir receta", exact: true }).click()
  await expect(page.getByText(/Receta N.º 1/).first()).toBeVisible()
  await page
    .getByText(/Receta N.º 1/)
    .first()
    .click()
  await page.getByRole("button", { name: "Anular receta" }).click()
  const cancel = page.getByRole("dialog", { name: "Anular receta" })
  await cancel.getByLabel("Motivo de anulación", { exact: true }).fill("Alergia registrada")
  await cancel.getByRole("button", { name: "Anular receta", exact: true }).click()
  await expect(page.getByText(/Anulada/).first()).toBeVisible()
})

test("paciente: control indicado, programado y completado", async ({ owner }) => {
  const ids = await buildClinicalBase(owner)
  await enableAgenda(owner)
  const { page } = owner
  const patientPath = `/patients/${ids.patientId}`

  // Controles: indicar, programar y completar contra una atención finalizada.
  await gotoHydrated(page, tenant(owner.org.slug, patientPath))
  await openSection(page, "Clínica", "Controles")
  await page.getByRole("button", { name: "Indicar control" }).click()
  const followUp = page.getByRole("dialog", { name: "Indicar control" })
  await chooseOption(followUp.getByLabel("Tipo de control", { exact: true }), "tratamiento")
  await chooseOption(followUp.getByLabel("Tratamiento", { exact: true }), ids.itemId)
  await followUp.getByLabel("Título del control").fill("Control post-endodoncia")
  await followUp.getByRole("button", { name: "Indicar control", exact: true }).click()
  await expect(page.getByText("Control post-endodoncia")).toBeVisible()
  // Programar reserva un hueco real del profesional y lo vincula al control.
  await page.getByRole("button", { name: "Programar control" }).first().click()
  const schedule = page.getByRole("dialog", { name: "Programar control" })
  const slot = schedule.getByRole("button", { name: "Seleccionar" }).first()
  await expect(slot).toBeVisible({ timeout: 15_000 })
  await slot.click()
  await schedule.getByRole("button", { name: "Reservar y vincular control" }).click()
  await expect(page.getByText(/Cita reservada/)).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "Completar control" }).click()
  const complete = page.getByRole("dialog", { name: "Completar control" })
  await chooseOption(complete.getByLabel("Atención finalizada", { exact: true }), ids.encounterId)
  await complete.getByLabel("Resultado del control").fill("Sin dolor; oclusión estable")
  await complete.getByRole("button", { name: "Completar", exact: true }).click()
  await expect(page.getByText("Resultado: Sin dolor; oclusión estable")).toBeVisible()
})

test("paciente: ejecución de la sesión y cierre del tratamiento", async ({ owner }) => {
  const ids = await buildClinicalBase(owner)
  const { budgetId } = await createAcceptedBudget(owner, ids)
  const { page } = owner
  const patientPath = `/patients/${ids.patientId}`

  // Sesiones por interfaz: la atención nueva vincula el tratamiento aceptado y
  // registrarlo lo deja en curso; completarlo es una decisión explícita.
  await gotoHydrated(
    page,
    tenant(owner.org.slug, `${patientPath}?tab=plan&planId=${ids.planId}&budgetId=${budgetId}`),
  )
  await openSection(page, "Tratamientos")
  // El plan se lee por fases; abrir un tratamiento muestra su recorrido debajo.
  await openTreatment(page, "Endodoncia unirradicular")
  const iniciarSesion = page.getByRole("button", { name: "Iniciar sesión", exact: true })
  await expect(iniciarSesion).toBeEnabled()
  await iniciarSesion.click()
  // Iniciar sesión crea la atención y navega a su página: el registro del
  // procedimiento y el cierre ocurren allí, no en una pestaña del paciente.
  await expect(page).toHaveURL(/\/encounters\//)
  const agregarServicios = page.getByRole("button", { name: "Agregar Servicios realizados" })
  await expect(
    agregarServicios.or(
      page.getByRole("button", { name: "Registrar procedimiento", exact: true }),
    ),
  ).toBeVisible()
  if ((await agregarServicios.count()) > 0) {
    await agregarServicios.click()
  }
  const registrar = page.getByRole("button", { name: "Registrar procedimiento", exact: true }).first()
  await expect(registrar).toBeEnabled()
  await registrar.click()
  const procedureDrawer = page.getByRole("dialog", { name: "Registrar procedimiento" })
  await expect(procedureDrawer).toBeVisible()
  await procedureDrawer.getByLabel("Tratamiento del presupuesto").click()
  await page.getByRole("option", { name: /Endodoncia unirradicular/ }).click()
  await expect(procedureDrawer.getByText(/queda en curso/)).toBeVisible()
  await procedureDrawer
    .getByRole("button", { name: "Registrar procedimiento", exact: true })
    .click()
  await expect(page.getByText("En curso desde", { exact: false }).first()).toBeVisible()

  // Completar el tratamiento ocurre aquí, con la atención abierta.
  await page.getByRole("button", { name: "Completar tratamiento", exact: true }).click()
  await expect(page.getByText(/Completado el/).first()).toBeVisible()
  // Sin diagnóstico ni evolución la lista de cierre bloquea la firma.
  await expect(page.getByRole("button", { name: "Finalizar atención", exact: true })).toBeDisabled()
  const encounterId = page.url().split("/encounters/")[1]?.split(/[?#]/)[0] ?? ""
  const apiPath = `/api/patients/${ids.patientId}/encounters/${encounterId}`
  await call(page, "POST", `${apiPath}/diagnoses`, owner.org.slug, {
    cie10Code: "K04.0",
    diagnosisType: "definitivo",
    toothNumber: 36,
  }, 201)
  await call(page, "PATCH", apiPath, owner.org.slug, {
    evolution: "Endodoncia de la pieza 36 sin complicaciones.",
  })
  await page.reload()
  await page.getByRole("button", { name: "Finalizar atención", exact: true }).click()
  const firma = page.getByRole("alertdialog")
  await expect(firma.getByText(/COP 12345/)).toBeVisible()
  await firma.getByRole("button", { name: "Finalizar y firmar", exact: true }).click()
  // Al finalizar se permanece en la atención, con su cierre y relevo a la vista.
  await expect(page).toHaveURL(/\/encounters\//)
  await expect(page.getByRole("heading", { name: "Cierre y relevo" })).toBeVisible()
  await expect(page.getByText(/1 acto\(s\) realizado\(s\)/)).toBeVisible()
  await expect(page.getByText("Solo lectura", { exact: true })).toBeVisible()
  // El relevo nombra a quién le toca lo siguiente: aquí, caja con el saldo generado.
  await expect(page.getByText(/Cobrar S\/\s450\.00/)).toBeVisible()
  await expect(page.getByText("Ir a la cuenta", { exact: true })).toBeVisible()
  // La atención se lee con nombres, no con identificadores.
  await expect(page.getByText("Ana Pruebas", { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Tratamiento del plan: Endodoncia unirradicular/)).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("cierre-y-relevo.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("heading", { name: "Cierre y relevo" })).toBeVisible()
  await page.screenshot({
    path: test.info().outputPath("cierre-y-relevo-movil.png"),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1280, height: 720 })

  // El recorrido refleja el cierre del tratamiento y su próximo control.
  await gotoHydrated(page, tenant(owner.org.slug, `${patientPath}?tab=recorrido&itemId=${ids.itemId}`))
  await expect(page.getByText("Ejecución: realizado").first()).toBeVisible()
  await expect(page.getByText("Revisar el control").first()).toBeVisible()
})

test("paciente: agregación del recorrido, historia y aislamiento", async ({ createOwner }) => {
  const owner = await createOwner("owner")
  const ids = await buildClinicalBase(owner)
  await setupAggregation(owner, ids)
  const { page } = owner
  const patientPath = `/patients/${ids.patientId}`
  const apiPath = `/api/patients/${ids.patientId}`

  // El recorrido del tratamiento reúne lo observado, lo propuesto, lo decidido,
  // la sesión, el control, la receta y el cobro.
  await gotoHydrated(page, tenant(owner.org.slug, `${patientPath}?tab=recorrido&itemId=${ids.itemId}`))
  await openTreatment(page, "Endodoncia unirradicular")
  await expect(page.getByText("Motiva esta indicación el hallazgo")).toBeVisible()
  await expect(page.getByText(/Receta N.º 1/).first()).toBeVisible()
  await expect(page.getByText(/Resultado: Sin dolor/)).toBeVisible()
  await expect(page.getByText("5. Qué se pagó")).toBeVisible()
  await expect(page.getByText(/aplicado a este tratamiento S\/\s*150\.00/)).toBeVisible()

  // Historia: cada evento del recorrido se abre donde corresponde, no como anamnesis.
  await openSection(page, "Historia")
  await expect(page.getByText("Presupuesto", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Pago", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Ver la propuesta", exact: true }).first().click()
  await expect(page).toHaveURL(/tab=plan/)
  await expect(page.getByText("Anamnesis no encontrado")).toHaveCount(0)

  // El formulario clínico respeta el tratamiento abierto en el recorrido.
  await gotoHydrated(page, tenant(owner.org.slug, `${patientPath}?tab=recorrido&itemId=${ids.itemId}`))
  await page.getByRole("button", { name: "Emitir receta", exact: true }).click()
  const scopedPrescription = page.getByRole("dialog", { name: "Emitir receta" })
  await expect(scopedPrescription.getByText(/^Tratamiento: /)).toBeVisible()
  await scopedPrescription.getByRole("button", { name: "Cancelar", exact: true }).click()

  await page.screenshot({ path: test.info().outputPath("recorrido-clinico.png"), fullPage: true })

  // Aislamiento: otra organización no ve la ficha ni su recorrido.
  const other = await createOwner("aislado")
  const hidden = await api(other.page, "GET", `${apiPath}/treatments/${ids.itemId}/journey`, other.org.slug)
  expect(hidden.status).toBe(404)
  const isolated = await call<unknown[]>(other.page, "GET", "/api/patients", other.org.slug)
  expect(isolated).toEqual([])
})
/** Fecha de nacimiento que da la edad pedida hoy (calendario local). */
function bornYearsAgo(years: number): string {
  const date = new Date()
  date.setFullYear(date.getFullYear() - years)
  date.setMonth(date.getMonth() - 1)
  return date.toISOString().slice(0, 10)
}

for (const role of ["reception", "dentist", "cashier"] as const) {
  test(`ficha por rol: ${role} entra a su área y solo ve lo que su permiso autoriza`, async ({
    owner,
    fixtureDb,
  }, info) => {
    const ids = await buildClinicalBase(owner)
    const { page } = owner
    const slug = owner.org.slug
    const apiPath = patientApiPath(ids.patientId)
    // Menor de 8 años con representante legal: dentición mixta y decisión delegada.
    await call(page, "PATCH", apiPath, slug, { birthDate: bornYearsAgo(8) })
    await grantLegalRepresentative(owner, ids)
    await fixtureDb
      .update(member)
      .set({ role })
      .where(and(eq(member.organizationId, owner.org.id), eq(member.userId, owner.user.id)))

    await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}`))
    await expect(page.getByRole("heading", { name: "Lucía Quispe" })).toBeVisible()
    await expect(page.getByText("Menor de edad", { exact: true })).toBeVisible()
    await expect(page.getByText("Representante legal:")).toBeVisible()
    await expect(page.getByText("Madre de Lucía").first()).toBeVisible()

    const areas = page.getByRole("tablist", { name: "Áreas de la ficha" }).getByRole("tab")
    const allergy = page.getByText("Alergia severa: Penicilina")
    const health = await api(page, "GET", `${apiPath}/health`, slug)
    const account = await api(page, "GET", `${apiPath}/account`, slug)

    if (role === "reception") {
      await expect(areas).toHaveText(["Resumen", "Relación", "Datos"])
      await expect(page.getByRole("heading", { name: "Pendientes" })).toBeVisible()
      // Única excepción clínica: la alerta de alergia, sin el resto de la ficha.
      await expect(allergy).toBeVisible()
      expect(health.status).toBe(403)
      expect(account.status).toBe(403)
      await expect(page.locator("a", { hasText: "Agendar cita" }).first()).toBeVisible()
      await expect(page.getByRole("button", { name: "Nueva atención" })).toHaveCount(0)
      await openSection(page, "Relación", "Citas")
      await expect(page.getByText("Sin citas", { exact: true })).toBeVisible()
      await openSection(page, "Datos")
      await expect(page.getByRole("heading", { name: "Filiación" })).toBeVisible()
    }
    if (role === "dentist") {
      await expect(areas).toHaveText(["Resumen", "Clínica", "Relación", "Datos"])
      // Entra por el resumen clínico; el odontograma queda a un clic, en la dentición de su edad.
      await expect(page.getByRole("heading", { name: "Alertas clínicas" })).toBeVisible()
      await page
        .getByRole("navigation", { name: "Accesos clínicos" })
        .getByRole("button", { name: "Odontograma", exact: true })
        .click()
      await expect(page.getByRole("heading", { name: "Odontograma", exact: true })).toBeVisible()
      await expect(page.getByRole("heading", { name: "Plan de tratamiento" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Mixta", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      )
      await expect(page.locator('[data-tooth="36"]')).toBeVisible()
      await expect(page.locator('[data-tooth="75"]')).toBeVisible()
      await expect(allergy).toBeVisible()
      expect(health.status).toBe(200)
      expect(account.status).toBe(403)
      await expect(page.getByRole("button", { name: "Nueva atención" })).toBeVisible()
    }
    if (role === "cashier") {
      await expect(areas).toHaveText(["Resumen", "Cuenta", "Datos"])
      await expect(page.getByRole("button", { name: "Registrar pago o anticipo" })).toBeVisible()
      await expect(allergy).toHaveCount(0)
      expect(health.status).toBe(403)
      expect(account.status).toBe(200)
      const detail = await call<{ activeAllergies: unknown[] }>(page, "GET", apiPath, slug)
      expect(detail.activeAllergies).toEqual([])
    }
    await page.screenshot({ path: info.outputPath(`ficha-${role}.png`), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole("heading", { name: "Lucía Quispe" })).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "la ficha no desborda en horizontal a 390px",
    ).toBe(true)
    await page.screenshot({ path: info.outputPath(`ficha-${role}-movil.png`), fullPage: true })
  })
}
test("recepción coordina el control sin leer la ficha clínica", async ({ owner, fixtureDb }) => {
  const ids = await buildClinicalBase(owner)
  await enableAgenda(owner)
  const { page } = owner
  const slug = owner.org.slug
  const apiPath = patientApiPath(ids.patientId)
  await call(
    page,
    "POST",
    `${apiPath}/follow-ups`,
    slug,
    {
      kind: "tratamiento",
      planItemId: ids.itemId,
      originEncounterId: ids.encounterId,
      title: "Control de evolución",
      instructions: "Indicación clínica reservada",
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    201,
  )
  await fixtureDb
    .update(member)
    .set({ role: "reception" })
    .where(and(eq(member.organizationId, owner.org.id), eq(member.userId, owner.user.id)))

  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}`))
  // El pendiente llega al resumen de recepción y lleva a la coordinación.
  await expect(page.getByText("Control por reservar: Control de evolución")).toBeVisible()
  await page.getByRole("button", { name: "Reservar", exact: true }).click()
  await expect(page).toHaveURL(/tab=coordinacion/)
  await expect(page.getByRole("heading", { name: "Controles", exact: true })).toBeVisible()
  await expect(page.getByText("Endodoncia unirradicular")).toBeVisible()
  // Sin detalle clínico: ni instrucciones, ni pieza, ni diagnóstico, ni importes.
  await expect(page.getByText("Indicación clínica reservada")).toHaveCount(0)
  await expect(page.getByText(/Pieza 36|K02\.1|450\.00/)).toHaveCount(0)
  const coordination = await api<{ data: unknown }>(page, "GET", `${apiPath}/coordination`, slug)
  expect(coordination.status).toBe(200)
  expect(JSON.stringify(coordination.body)).not.toMatch(/instructions|toothNumber|priceCents/)
  expect((await api(page, "GET", `${apiPath}/follow-ups`, slug)).status).toBe(403)

  // Reserva un hueco real: misma operación que la vía clínica.
  await page.getByRole("button", { name: "Reservar control" }).click()
  const dialog = page.getByRole("dialog", { name: "Programar control" })
  const slot = dialog.getByRole("button", { name: "Seleccionar" }).first()
  await expect(slot).toBeVisible({ timeout: 15_000 })
  await slot.click()
  await dialog.getByRole("button", { name: "Reservar y vincular control" }).click()
  await expect(page.getByText("Con cita", { exact: true })).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: test.info().outputPath("coordinacion-recepcion.png"), fullPage: true })
  await openSection(page, "Citas")
  await expect(page.getByRole("heading", { name: "Próximas citas" })).toBeVisible()
  await expect(page.getByText("Programada", { exact: true })).toBeVisible()
})

test("documentos: un solo índice cronológico que abre la gestión de cada tipo", async ({ owner }) => {
  const ids = await buildClinicalBase(owner)
  await setupAggregation(owner, ids)
  const { page } = owner
  await gotoHydrated(page, tenant(owner.org.slug, `/patients/${ids.patientId}`))
  await openSection(page, "Clínica", "Documentos")
  await expect(page).toHaveURL(/tab=documentos/)
  await expect(page.getByText("Receta N.º 1")).toBeVisible()
  await expect(page.getByText("Anulada", { exact: true })).toBeVisible()
  // Nada pendiente de firma, resultado o cierre: el filtro no ofrece resultados vacíos.
  await expect(page.getByRole("button", { name: "Requieren acción (0)" })).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath("documentos.png"), fullPage: true })
  // Cada fila abre su panel de gestión.
  await page.getByRole("button", { name: "Abrir en recetas" }).click()
  await expect(page).toHaveURL(/tab=recetas/)
  await expect(page.getByRole("button", { name: "Emitir receta" })).toBeVisible()
})
test("persona única: la ficha y la persona comparten identidad y actividad", async ({ owner }) => {
  const ids = await buildClinicalBase(owner)
  const { page } = owner
  const slug = owner.org.slug
  const apiPath = patientApiPath(ids.patientId)
  type Detail = {
    patient: { displayName: string; docNumber: string | null; birthDate: string | null }
    contacts: { contactId: string; relationship: string; displayName: string }[]
  }
  const before = await call<Detail>(page, "GET", apiPath, slug)
  const own = before.contacts.find((link) => link.relationship === "self")
  expect(own, "todo paciente tiene su propia persona").toBeTruthy()
  expect(own?.contactId).not.toBe(ids.contactId)

  // La identidad se edita en la persona y llega a la ficha.
  await gotoHydrated(page, tenant(slug, `/contacts/${own?.contactId}`))
  await expect(page.getByText("Esta persona es paciente", { exact: false })).toBeVisible()
  await expect(page.getByText("DNI 87654321")).toBeVisible()
  await page.getByRole("button", { name: "Editar datos" }).click()
  const edit = page.getByRole("dialog", { name: "Editar datos" })
  await edit.getByLabel("Fecha de nacimiento").fill("1990-04-05")
  await edit.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(page.getByText("1990-04-05")).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("persona.png"), fullPage: true })
  const after = await call<Detail>(page, "GET", apiPath, slug)
  expect(after.patient.birthDate).toBe("1990-04-05")

  // Desde la ficha: actividad unificada, seguimiento comercial y tareas del paciente.
  await gotoHydrated(page, tenant(slug, `/patients/${ids.patientId}`))
  await page.getByRole("button", { name: "Nueva tarea" }).click()
  const task = page.getByRole("dialog", { name: "Nueva tarea" })
  await task.getByLabel("Qué hay que hacer").fill("Llamar por el laboratorio")
  await task.getByRole("button", { name: "Crear tarea" }).click()
  await expect(page.getByText("Tarea: Llamar por el laboratorio")).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("resumen-con-tarea.png"), fullPage: true })
  await openSection(page, "Relación")
  await expect(page).toHaveURL(/tab=actividad/)
  await expect(page.getByText("Atención", { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("actividad.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByText("Atención", { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("actividad-movil.png"), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })
  await openSection(page, "Seguimiento")
  await expect(page.getByRole("region", { name: "Contexto del contacto" })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("seguimiento.png"), fullPage: true })
  // La propia persona no se desvincula; la tutora sí conserva sus acciones.
  await openSection(page, "Interlocutores")
  await page.getByRole("button", { name: /^Acciones del contacto Lucía Quispe/ }).click()
  await expect(page.getByRole("menuitem", { name: "Desvincular" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  // Quien audita ve quién consultó la historia.
  await openSection(page, "Datos", "Consultas a la historia")
  await expect(page.getByRole("heading", { name: "Consultas a la historia clínica" })).toBeVisible()
  await expect(page.getByRole("cell", { name: "Ana Pruebas" }).first()).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("consultas-historia.png"), fullPage: true })
})
