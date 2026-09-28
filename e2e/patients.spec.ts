import { tenant, tenantPattern } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import {
  buildClinicalBase,
  createAcceptedBudget,
  createDraftBudget,
  setupAggregation,
} from "./patients-fixture"

test("paciente: ficha inicial y hallazgo visibles en el recorrido", async ({ owner }) => {
  const ids = await buildClinicalBase(owner)
  const { page } = owner
  const patientPath = `/patients/${ids.patientId}`

  await gotoHydrated(page, tenant(owner.org.slug, patientPath))
  await expect(page).toHaveURL(tenantPattern(owner.org.slug, patientPath))
  await expect(page.getByRole("heading", { name: "Lucía Quispe" })).toBeVisible()
  await expect(page.getByText(/HC-\d{6}/)).toBeVisible()
  await expect(page.getByText("Alergia severa: Penicilina")).toBeVisible()

  // El resumen permite consultar el mapa clínico antes de abrir una atención.
  await expect(page.getByRole("heading", { name: "Situación clínica" })).toBeVisible()

  // Recorrido clínico: qué se observó, qué se propuso, qué se decidió.
  const recorridoTab = page.getByRole("tab", { name: "Recorrido clínico", exact: true })
  await expect(recorridoTab).toBeEnabled()
  await recorridoTab.click()
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
  const responsablesTab = page.getByRole("tab", { name: "Responsables", exact: true })
  await expect(responsablesTab).toBeEnabled()
  await responsablesTab.click()
  await page.getByRole("button", { name: "Asignar responsabilidad" }).click()
  const responsibility = page.getByRole("dialog", { name: "Asignar responsabilidad" })
  await responsibility.getByLabel("Contacto vinculado", { exact: true }).selectOption(ids.contactId)
  await responsibility
    .getByLabel("Responsabilidad", { exact: true })
    .selectOption("representante_legal")
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
  await decision.getByLabel("Quién decide", { exact: true }).selectOption({
    label: "Representante legal: Madre de Lucía",
  })
  await decision.locator("select").first().selectOption("aceptado")
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
  await alternativeSelect.selectOption({ label: "Resina o corona" })
  // La agrupación se guarda y la ficha se refresca antes de marcar la recomendación.
  await expect(alternativeSelect).not.toHaveValue("")
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
  const recorridoTab = page.getByRole("tab", { name: "Recorrido clínico", exact: true })
  await expect(recorridoTab).toBeEnabled()
  await recorridoTab.click()
  await expect(
    page
      .locator("span")
      .filter({ hasText: /^Aceptado$/ })
      .first(),
  ).toBeVisible()
  const cuentaTab = page.getByRole("tab", { name: "Cuenta", exact: true })
  await expect(cuentaTab).toBeEnabled()
  await cuentaTab.click()
  await expect(page.getByText("POR COBRAR").first()).toBeVisible()
  await page.getByRole("button", { name: "Registrar pago o anticipo" }).click()
  const payment = page.getByRole("dialog", { name: "Registrar pago o anticipo" })
  await payment.getByLabel("Importe", { exact: true }).fill("200")
  await payment.getByLabel("Quién paga", { exact: true }).selectOption(ids.contactId)
  await payment.getByRole("button", { name: "Registrar pago" }).click()
  await expect(page.getByText("Disponible sin aplicar: S/ 200.00")).toBeVisible()
  await page.getByRole("button", { name: "Aplicar a un cargo" }).first().click()
  const apply = page.getByRole("dialog", { name: "Aplicar pago a un cargo" })
  await apply.getByLabel("Importe a aplicar", { exact: true }).fill("150")
  await apply.getByRole("button", { name: "Aplicar", exact: true }).click()
  await expect(page.getByText("Aplicado S/ 150.00 · pendiente S/ 300.00").first()).toBeVisible()
  await expect(page.getByText("Disponible sin aplicar: S/ 50.00")).toBeVisible()
})

test("paciente: receta vinculada al tratamiento y anulación", async ({ owner }) => {
  const ids = await buildClinicalBase(owner)
  await createAcceptedBudget(owner, ids)
  const { page } = owner
  const patientPath = `/patients/${ids.patientId}`

  await gotoHydrated(page, tenant(owner.org.slug, patientPath))
  const recetasTab = page.getByRole("tab", { name: "Recetas", exact: true })
  await expect(recetasTab).toBeEnabled()
  await recetasTab.click()
  await page.getByRole("button", { name: "Emitir receta" }).click()
  const prescription = page.getByRole("dialog", { name: "Emitir receta" })
  await prescription.getByLabel("Tratamiento", { exact: true }).selectOption(ids.itemId)
  await prescription.getByLabel("Medicamento", { exact: true }).fill("Ibuprofeno 400 mg")
  await prescription.getByLabel("Dosis", { exact: true }).fill("400 mg")
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
  const { page } = owner
  const patientPath = `/patients/${ids.patientId}`

  // Controles: indicar, programar y completar contra una atención finalizada.
  await gotoHydrated(page, tenant(owner.org.slug, patientPath))
  const controlesTab = page.getByRole("tab", { name: "Controles", exact: true })
  await expect(controlesTab).toBeEnabled()
  await controlesTab.click()
  await page.getByRole("button", { name: "Indicar control" }).click()
  const followUp = page.getByRole("dialog", { name: "Indicar control" })
  await followUp.getByLabel("Tipo de control", { exact: true }).selectOption("tratamiento")
  await followUp.getByLabel("Tratamiento", { exact: true }).selectOption(ids.itemId)
  await followUp.getByLabel("Título del control").fill("Control post-endodoncia")
  await followUp.getByRole("button", { name: "Indicar control", exact: true }).click()
  await expect(page.getByText("Control post-endodoncia")).toBeVisible()
  await page.getByRole("button", { name: "Programar cita" }).click()
  const schedule = page.getByRole("dialog", { name: "Programar cita del control" })
  await schedule.getByRole("button", { name: "Programar", exact: true }).click()
  await expect(page.getByText("Programado", { exact: true }).first()).toBeVisible()
  await page.getByRole("button", { name: "Completar control" }).click()
  const complete = page.getByRole("dialog", { name: "Completar control" })
  await complete.getByLabel("Atención finalizada", { exact: true }).selectOption(ids.encounterId)
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
  const recorridoTab = page.getByRole("tab", { name: "Recorrido clínico", exact: true })
  await expect(recorridoTab).toBeEnabled()
  await recorridoTab.click()
  await page.getByLabel("Tratamiento", { exact: true }).selectOption(ids.itemId)
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
  await page.getByRole("button", { name: "Finalizar atención", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Finalizar atención", exact: true })
    .click()
  await expect(page).toHaveURL(tenantPattern(owner.org.slug, patientPath))

  // El recorrido refleja el cierre del tratamiento y su próximo control.
  await gotoHydrated(page, tenant(owner.org.slug, `${patientPath}?tab=recorrido&itemId=${ids.itemId}`))
  await expect(page.getByText("Ejecución: realizado").first()).toBeVisible()
  await expect(page.getByText("Programar el control").first()).toBeVisible()
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
  const tratamiento = page.getByLabel("Tratamiento", { exact: true })
  await expect(tratamiento).toBeEnabled()
  await tratamiento.selectOption(ids.itemId)
  await expect(page.getByText("Motiva esta indicación el hallazgo")).toBeVisible()
  await expect(page.getByText(/Receta N.º 1/).first()).toBeVisible()
  await expect(page.getByText(/Resultado: Sin dolor/)).toBeVisible()
  await expect(page.getByText("5. Qué se pagó")).toBeVisible()
  await expect(page.getByText(/aplicado a este tratamiento S\/\s*150\.00/)).toBeVisible()

  // Historia: cada evento del recorrido se abre donde corresponde, no como anamnesis.
  const historiaTab = page.getByRole("tab", { name: "Historia", exact: true })
  await expect(historiaTab).toBeEnabled()
  await historiaTab.click()
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
