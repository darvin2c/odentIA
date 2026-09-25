import { expect, type Page, test } from "@playwright/test"
import { API, PANEL, tenant, tenantPattern } from "./env"
import { gotoHydrated } from "./hydration"
import { latestLinkFor } from "./mailpit"

const run = Date.now().toString(36)

const userA = { name: "Denta A", email: `denta-a-${run}@test.dev`, password: "secreto-123" }
const userB = { name: "Denta B", email: `denta-b-${run}@test.dev`, password: "secreto-123" }
const orgA = { name: "Clínica A", slug: `clinica-pa-${run}` }
const orgB = { name: "Clínica B", slug: `clinica-pb-${run}` }

/** El alta y el acceso viven en el panel; la sesión es compartida por el dominio. */
async function register(page: Page, user: typeof userA) {
  await gotoHydrated(page, `${PANEL}/register`)
  const [first, ...rest] = user.name.split(" ")
  await page.getByLabel("Nombre").fill(first)
  await page.getByLabel("Apellidos").fill(rest.join(" "))
  await page.getByLabel("Correo").fill(user.email)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Registrarme" }).click()
  await expect(page).toHaveURL(/verify-email-sent/)
}

async function verifyEmail(page: Page, email: string) {
  const link = await latestLinkFor(email, "Verifica tu correo")
  await page.goto(link)
}

async function login(page: Page, user: typeof userA) {
  await gotoHydrated(page, `${PANEL}/login`)
  await page.getByLabel("Correo").fill(user.email)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Ingresar" }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

/** Alta real de la organización y su sucursal, con la API del repo. */
async function onboard(page: Page, org: typeof orgA) {
  const result = await page.evaluate(
    async ({ apiBase, org }) => {
      const fail = (step: string, status: number, body: unknown): never => {
        throw new Error(`onboard:${step}:${status}:${JSON.stringify(body)?.slice(0, 300)}`)
      }
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`${apiBase}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        })
        return {
          status: response.status,
          data: (await response.json().catch(() => null)) as unknown,
        }
      }
      const created = await post("/api/auth/organization/create", {
        name: org.name,
        slug: org.slug,
      })
      if (created.status !== 200 && created.status !== 201) {
        fail("organization.create", created.status, created.data)
      }
      const createdData = created.data as {
        id?: string
        data?: { id?: string }
        organization?: { id?: string }
      } | null
      const orgId = createdData?.id ?? createdData?.data?.id ?? createdData?.organization?.id
      if (orgId) {
        const active = await post("/api/auth/organization/set-active", { organizationId: orgId })
        if (active.status !== 200 && active.status !== 201) {
          fail("organization.set-active", active.status, active.data)
        }
      }
      const profileResponse = await fetch(`${apiBase}/api/org-profile`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-odentia-org": org.slug },
        credentials: "include",
        body: JSON.stringify({ legalName: `${org.name} S.A.C.`, countryCode: "PE" }),
      })
      if (!profileResponse.ok) {
        fail("org-profile", profileResponse.status, await profileResponse.json().catch(() => null))
      }
      const branchResponse = await fetch(`${apiBase}/api/branches`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-odentia-org": org.slug },
        credentials: "include",
        body: JSON.stringify({ name: "Sede Central" }),
      })
      if (!branchResponse.ok) {
        fail("branches", branchResponse.status, await branchResponse.json().catch(() => null))
      }
      return { ok: true as const }
    },
    { apiBase: API, org },
  )
  expect(result.ok).toBe(true)
  // Entrar al espacio del tenant fija la organización activa de la sesión.
  await gotoHydrated(page, tenant(org.slug, "/patients"))
  await expect(page).toHaveURL(tenantPattern(org.slug, "/patients"))
}

/** Llamadas API desde el navegador (*.odentia.localhost no resuelve en Node/WSL). */
async function api<T>(page: Page, method: string, path: string, slug: string, body?: unknown) {
  return page.evaluate(
    async ({ apiBase, method, path, slug, body }) => {
      const response = await fetch(`${apiBase}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-odentia-org": slug },
        credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json().catch(() => null)) as T }
    },
    { apiBase: API, method, path, slug, body },
  )
}

async function call<T>(
  page: Page,
  method: string,
  path: string,
  slug: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const result = await api<{ data: T }>(page, method, path, slug, body)
  expect(result.status, `${method} ${path} → ${JSON.stringify(result.body)}`).toBe(expected)
  return (result.body as { data: T }).data
}

test("paciente: recorrido clínico-económico completo en la ficha y aislamiento", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000)
  await register(page, userA)
  await verifyEmail(page, userA.email)
  await login(page, userA)
  await onboard(page, orgA)

  // Ficha creada por el registro real del repositorio (sin seed).
  const contact = await call<{ id: string }>(
    page,
    "POST",
    "/api/contacts",
    orgA.slug,
    {
      displayName: "Madre de Lucía",
    },
    201,
  )
  const patient = await call<{ id: string; patientNumber: number; organizationId: string }>(
    page,
    "POST",
    "/api/patients",
    orgA.slug,
    {
      submissionId: crypto.randomUUID(),
      answers: {
        demographics: { displayName: "Lucía Quispe", docType: "DNI", docNumber: "87654321" },
        respondent: "staff",
        privacyAccepted: false,
      },
      contacts: [
        {
          contactId: contact.id,
          relationship: "guardian",
          relationshipDetail: "Madre",
          isPreferred: true,
        },
      ],
    },
    201,
  )
  const patientPath = `/patients/${patient.id}`
  /** Rutas de la API siempre bajo /api; las de la interfaz viven en la raíz del tenant. */
  const apiPath = `/api/patients/${patient.id}`
  await call(page, "PUT", `${apiPath}/health`, orgA.slug, {
    expectedRevision: 0,
    reviewStatus: { allergies: "recorded", conditions: "none", medications: "none" },
    allergies: [{ substance: "Penicilina", severity: "severa" }],
    conditions: [],
    medications: [],
  })
  const service = await call<{ id: string }>(
    page,
    "POST",
    "/api/services",
    orgA.slug,
    {
      name: "Endodoncia unirradicular",
      specialty: "endodoncia",
      scope: "tooth",
      priceCents: 45000,
      currency: "PEN",
    },
    201,
  )
  const encounter = await call<{ id: string }>(
    page,
    "POST",
    `${apiPath}/encounters`,
    orgA.slug,
    {
      reason: "Dolor molar inferior derecho",
    },
    201,
  )
  const plan = await call<{ id: string }>(
    page,
    "POST",
    `${apiPath}/plans`,
    orgA.slug,
    {
      title: "Plan de Lucía",
      originEncounterId: encounter.id,
    },
    201,
  )
  const finding = await call<Array<{ id: string }>>(
    page,
    "POST",
    `${apiPath}/odontogram/entries`,
    orgA.slug,
    {
      toothNumber: 36,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "dentin" },
    },
    201,
  )
  // La indicación nace de un hallazgo real del odontograma.
  const item = await call<{ id: string }>(
    page,
    "POST",
    `${apiPath}/plan/items`,
    orgA.slug,
    {
      planId: plan.id,
      serviceId: service.id,
      sourceEncounterId: encounter.id,
      toothNumber: 36,
      odontogramEntryId: finding[0]?.id,
      diagnosisCode: "K02.1",
    },
    201,
  )
  await call(page, "PATCH", `${apiPath}/encounters/${encounter.id}`, orgA.slug, {
    evolution: "Se evalúa pieza 36 con caries oclusal; se indica endodoncia.",
  })
  await call(page, "POST", `${apiPath}/encounters/${encounter.id}/finalize`, orgA.slug, {})

  await gotoHydrated(page, tenant(orgA.slug, patientPath))
  await expect(page).toHaveURL(tenantPattern(orgA.slug, patientPath))
  await expect(page.getByRole("heading", { name: "Lucía Quispe" })).toBeVisible()
  await expect(page.getByText(/HC-\d{6}/)).toBeVisible()
  await expect(page.getByText("Alergia severa: Penicilina")).toBeVisible()

  // El resumen permite consultar el mapa clínico antes de abrir una atención.
  await expect(page.getByRole("heading", { name: "Situación clínica" })).toBeVisible()

  // Recorrido clínico: qué se observó, qué se propuso, qué se decidió, qué se ejecutó.
  await page.getByRole("tab", { name: "Recorrido clínico", exact: true }).click()
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

  // Propuesta, presentación y decisión por línea desde Planes de tratamiento.
  const budget = await call<{ id: string }>(
    page,
    "POST",
    `${apiPath}/budgets`,
    orgA.slug,
    {
      planId: plan.id,
      itemIds: [item.id],
      title: "Propuesta de Lucía",
    },
    201,
  )
  await gotoHydrated(
    page,
    tenant(orgA.slug, `${patientPath}?tab=plan&planId=${plan.id}&budgetId=${budget.id}`),
  )
  await page.getByRole("button", { name: "Presentar", exact: true }).click()
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
  await page.getByRole("tab", { name: "Responsables", exact: true }).click()
  await page.getByRole("button", { name: "Asignar responsabilidad" }).click()
  const responsibility = page.getByRole("dialog", { name: "Asignar responsabilidad" })
  await responsibility.getByLabel("Contacto vinculado", { exact: true }).selectOption(contact.id)
  await responsibility
    .getByLabel("Responsabilidad", { exact: true })
    .selectOption("representante_legal")
  await responsibility.getByRole("button", { name: "Asignar", exact: true }).click()
  await expect(page.getByText("Madre de Lucía", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Vigente", { exact: true }).first()).toBeVisible()

  await gotoHydrated(
    page,
    tenant(orgA.slug, `${patientPath}?tab=plan&planId=${plan.id}&budgetId=${budget.id}`),
  )
  await page.getByRole("button", { name: "Registrar decisión", exact: true }).click()
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

  // Cargo explícito desde la línea aceptada: aceptar no cobra por sí solo.
  await page.getByRole("button", { name: "Generar cargo", exact: true }).first().click()
  const charge = page.getByRole("dialog", { name: /Generar cargo/ })
  await charge.getByRole("button", { name: "Generar cargo", exact: true }).click()

  // Pago y aplicación desde la ficha.
  await page.getByRole("tab", { name: "Recorrido clínico", exact: true }).click()
  await expect(
    page
      .locator("span")
      .filter({ hasText: /^Aceptado$/ })
      .first(),
  ).toBeVisible()
  await page.getByRole("tab", { name: "Cuenta", exact: true }).click()
  await expect(page.getByText("POR COBRAR").first()).toBeVisible()
  await page.getByRole("button", { name: "Registrar pago o anticipo" }).click()
  const payment = page.getByRole("dialog", { name: "Registrar pago o anticipo" })
  await payment.getByLabel("Importe", { exact: true }).fill("200")
  await payment.getByLabel("Quién paga", { exact: true }).selectOption(contact.id)
  await payment.getByRole("button", { name: "Registrar pago" }).click()
  await expect(page.getByText("Disponible sin aplicar: S/ 200.00")).toBeVisible()
  await page.getByRole("button", { name: "Aplicar a un cargo" }).first().click()
  const apply = page.getByRole("dialog", { name: "Aplicar pago a un cargo" })
  await apply.getByLabel("Importe a aplicar", { exact: true }).fill("150")
  await apply.getByRole("button", { name: "Aplicar", exact: true }).click()
  await expect(page.getByText("Aplicado S/ 150.00 · pendiente S/ 300.00").first()).toBeVisible()

  // Recetas: emisión ligada al tratamiento y anulación con motivo.
  await page.getByRole("tab", { name: "Recetas", exact: true }).click()
  await page.getByRole("button", { name: "Emitir receta" }).click()
  const prescription = page.getByRole("dialog", { name: "Emitir receta" })
  await prescription.getByLabel("Tratamiento", { exact: true }).selectOption(item.id)
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

  // Controles: indicar, programar y completar contra una atención finalizada.
  await page.getByRole("tab", { name: "Controles", exact: true }).click()
  await page.getByRole("button", { name: "Indicar control" }).click()
  const followUp = page.getByRole("dialog", { name: "Indicar control" })
  await followUp.getByLabel("Tipo de control", { exact: true }).selectOption("tratamiento")
  await followUp.getByLabel("Tratamiento", { exact: true }).selectOption(item.id)
  await followUp.getByLabel("Título del control").fill("Control post-endodoncia")
  await followUp.getByRole("button", { name: "Indicar control", exact: true }).click()
  await expect(page.getByText("Control post-endodoncia")).toBeVisible()
  await page.getByRole("button", { name: "Programar cita" }).click()
  const schedule = page.getByRole("dialog", { name: "Programar cita del control" })
  await schedule.getByRole("button", { name: "Programar", exact: true }).click()
  await expect(page.getByText("Programado", { exact: true }).first()).toBeVisible()
  await page.getByRole("button", { name: "Completar control" }).click()
  const complete = page.getByRole("dialog", { name: "Completar control" })
  await complete.getByLabel("Atención finalizada", { exact: true }).selectOption(encounter.id)
  await complete.getByLabel("Resultado del control").fill("Sin dolor; oclusión estable")
  await complete.getByRole("button", { name: "Completar", exact: true }).click()
  await expect(page.getByText("Resultado: Sin dolor; oclusión estable")).toBeVisible()

  // El recorrido del tratamiento reúne lo observado, lo propuesto, lo decidido,
  // la sesión, el control, la receta y el cobro.
  await page.getByRole("tab", { name: "Recorrido clínico", exact: true }).click()
  await page.getByLabel("Tratamiento", { exact: true }).selectOption(item.id)
  await expect(page.getByText("Motiva esta indicación el hallazgo")).toBeVisible()
  await expect(page.getByText(/Receta N.º 1/).first()).toBeVisible()
  await expect(page.getByText(/Resultado: Sin dolor/)).toBeVisible()
  await expect(page.getByText("5. Qué se pagó")).toBeVisible()
  await expect(page.getByText(/aplicado a este tratamiento S\/\s*150\.00/)).toBeVisible()

  // Sesiones por interfaz: la atención nueva vincula el tratamiento aceptado y
  // registrarlo lo deja en curso; completarlo es una decisión explícita.
  await page.getByRole("tab", { name: "Recorrido clínico", exact: true }).click()
  await page.getByLabel("Tratamiento", { exact: true }).selectOption(item.id)
  await page.getByRole("button", { name: "Iniciar sesión", exact: true }).click()
  await expect(page.getByRole("tab", { name: "Realizado", exact: true })).toBeVisible()
  await page.getByRole("tab", { name: "Realizado", exact: true }).click()
  await page.getByRole("button", { name: "Registrar procedimiento", exact: true }).first().click()
  const procedureDrawer = page.getByRole("dialog", { name: "Registrar procedimiento" })
  await procedureDrawer.getByLabel("Tratamiento del presupuesto").click()
  await page.getByRole("option", { name: /Endodoncia unirradicular/ }).click()
  await procedureDrawer
    .getByRole("button", { name: "Registrar procedimiento", exact: true })
    .click()
  await expect(page.getByText("En curso desde", { exact: false }).first()).toBeVisible()

  // Completar el tratamiento ocurre aquí, con la atención abierta.
  await page.getByRole("button", { name: "Completar tratamiento", exact: true }).click()
  await expect(page.getByText("realizado", { exact: false }).first()).toBeVisible()
  await page.getByRole("button", { name: "Finalizar atención", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Finalizar atención", exact: true })
    .click()
  await expect(page).toHaveURL(tenantPattern(orgA.slug, patientPath))

  // El recorrido refleja el cierre del tratamiento y su próximo control.
  await gotoHydrated(page, tenant(orgA.slug, `${patientPath}?tab=recorrido&itemId=${item.id}`))
  await expect(page.getByText("Ejecución: realizado").first()).toBeVisible()
  await expect(page.getByText("Programar el control").first()).toBeVisible()

  // Historia: cada evento del recorrido se abre donde corresponde, no como anamnesis.
  await page.getByRole("tab", { name: "Historia", exact: true }).click()
  await expect(page.getByText("Presupuesto", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Pago", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Ver la propuesta", exact: true }).first().click()
  await expect(page).toHaveURL(/tab=plan/)
  await expect(page.getByText("Anamnesis no encontrado")).toHaveCount(0)

  // El formulario clínico respeta el tratamiento abierto en el recorrido.
  await gotoHydrated(page, tenant(orgA.slug, `${patientPath}?tab=recorrido&itemId=${item.id}`))
  await page.getByRole("button", { name: "Emitir receta", exact: true }).click()
  const scopedPrescription = page.getByRole("dialog", { name: "Emitir receta" })
  await expect(scopedPrescription.getByText(/^Tratamiento: /)).toBeVisible()
  await scopedPrescription.getByRole("button", { name: "Cancelar", exact: true }).click()

  await page.screenshot({ path: test.info().outputPath("recorrido-clinico.png"), fullPage: true })

  // Aislamiento: otra organización no ve la ficha ni su recorrido.
  const contextB = await browser.newContext({ ignoreHTTPSErrors: true })
  const pageB = await contextB.newPage()
  await pageB.goto(PANEL)
  await register(pageB, userB)
  await verifyEmail(pageB, userB.email)
  await login(pageB, userB)
  await onboard(pageB, orgB)
  const hidden = await api(pageB, "GET", `${apiPath}/treatments/${item.id}/journey`, orgB.slug)
  expect(hidden.status).toBe(404)
  const isolated = await api<{ data: unknown[] }>(pageB, "GET", "/api/patients", orgB.slug)
  expect(isolated.body.data).toEqual([])
  await contextB.close()
})
