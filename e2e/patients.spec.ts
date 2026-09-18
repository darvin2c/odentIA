import { expect, type Page, test } from "@playwright/test"
import { API, tenant, tenantPattern } from "./env"
import { latestLinkFor } from "./mailpit"

const run = Date.now().toString(36)

const userA = { name: "Denta A", email: `denta-a-${run}@test.dev`, password: "secreto-123" }
const userB = { name: "Denta B", email: `denta-b-${run}@test.dev`, password: "secreto-123" }
const orgA = { name: "Clínica A", slug: `clinica-pa-${run}` }
const orgB = { name: "Clínica B", slug: `clinica-pb-${run}` }

const hasFiber = () => {
  for (const el of [document.documentElement, document.body, ...document.body.children]) {
    if (el && Object.keys(el).some((key) => key.startsWith("__reactFiber"))) return true
  }
  return false
}

async function waitForHydration(page: Page) {
  for (;;) {
    await page.waitForFunction(hasFiber, null, { timeout: 60_000 })
    await page.waitForTimeout(1_500)
    const stable = await page.evaluate(hasFiber).catch(() => false)
    if (stable) return
  }
}

async function gotoHydrated(page: Page, path: string) {
  await page.goto(path)
  await waitForHydration(page)
}

async function register(page: Page, user: typeof userA) {
  await gotoHydrated(page, "/register")
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
  await gotoHydrated(page, "/login")
  await page.getByLabel("Correo").fill(user.email)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Ingresar" }).click()
}

async function onboard(page: Page, org: typeof orgA) {
  // Alta real autenticada con la API del repo (sin tocar el onboarding de producción):
  // organization.create + set-active, y perfil/sucursal con header x-odentia-org
  // (mismo contrato que patient-registration.spec.ts). Después se navega al tenant.
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
        return { status: response.status, data: (await response.json().catch(() => null)) as unknown }
      }
      const created = await post("/api/auth/organization/create", { name: org.name, slug: org.slug })
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
      const profileData = (await profileResponse.json().catch(() => null)) as unknown
      if (!profileResponse.ok) fail("org-profile", profileResponse.status, profileData)
      const branchResponse = await fetch(`${apiBase}/api/branches`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-odentia-org": org.slug },
        credentials: "include",
        body: JSON.stringify({ name: "Sede Central" }),
      })
      const branchData = (await branchResponse.json().catch(() => null)) as unknown
      if (branchResponse.status !== 200 && branchResponse.status !== 201) {
        fail("branches", branchResponse.status, branchData)
      }
      return { ok: true as const }
    },
    { apiBase: API, org },
  )
  expect(result.ok).toBe(true)
  await gotoHydrated(page, tenant(org.slug, "/branches"))
  await expect(page).toHaveURL(tenantPattern(org.slug, "/branches"))
}

// Llamadas API desde el navegador (*.odentia.localhost no resuelve en Node/WSL).
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

test("pacientes: ficha clínica, alertas, nota CIE-10, odontograma y aislamiento", async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const contextA = await browser.newContext({ ignoreHTTPSErrors: true })
  const pageA = await contextA.newPage()
  await register(pageA, userA)
  await verifyEmail(pageA, userA.email)
  await login(pageA, userA)
  await onboard(pageA, orgA)
  const createdContact = await api<{ data: { id: string } }>(pageA, "POST", "/api/contacts", orgA.slug, { displayName: "María Pérez" })
  expect(createdContact.status).toBe(201)
  const contactId = createdContact.body.data.id

  // Registrar paciente vinculado al contacto (vínculo self declarado por personal).
  const patient = await api<{ data: { id: string; patientNumber: number } }>(
    pageA,
    "POST",
    "/api/patients",
    orgA.slug,
    {
      submissionId: crypto.randomUUID(),
      answers: {
        demographics: { displayName: "María Pérez", docType: "DNI", docNumber: "12345678" },
        respondent: "staff",
        privacyAccepted: false,
      },
      contacts: [{ contactId, relationship: "self", isPreferred: true }],
    },
  )
  expect(patient.status).toBe(201)
  const patientId = patient.body.data.id

  // El detalle expone el vínculo self y la procedencia interna.
  const linked = await api<{
    data: {
      patient: { displayName: string }
      contacts: { contactId: string; relationship: string; isPreferred: boolean }[]
      registration: { entryPoint: string; respondent: string } | null
    }
  }>(pageA, "GET", `/api/patients/${patientId}`, orgA.slug)
  expect(linked.status).toBe(200)
  expect(linked.body.data.contacts).toEqual([
    expect.objectContaining({ contactId, relationship: "self", isPreferred: true }),
  ])
  expect(linked.body.data.registration).toMatchObject({
    entryPoint: "platform",
    respondent: "staff",
  })

  // La ficha muestra el número de historia clínica asignado.
  await gotoHydrated(pageA, tenant(orgA.slug, `/patients/${patientId}`))
  await expect(pageA.getByText(/HC-\d{6}/).first()).toBeVisible({ timeout: 15_000 })
  await expect(pageA.getByText("María Pérez").first()).toBeVisible()

  // La ficha del contacto también expone al paciente vinculado como self.
  const contactDetail = await api<{
    data: { patients: { id: string; relationship: string; isPreferred: boolean }[] }
  }>(pageA, "GET", `/api/contacts/${contactId}`, orgA.slug)
  expect(contactDetail.status).toBe(200)
  expect(contactDetail.body.data.patients).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: patientId, relationship: "self", isPreferred: true }),
    ]),
  )
  // Alta de alergia severa por el agregado de salud → chip visible en Resumen.
  const allergy = await api(pageA, "PUT", `/api/patients/${patientId}/health`, orgA.slug, {
    expectedRevision: 0,
    reviewStatus: { allergies: "recorded", conditions: "none", medications: "none" },
    allergies: [{ substance: "Penicilina", severity: "severa" }],
    conditions: [],
    medications: [],
  })
  expect(allergy.status).toBe(200)
  await pageA.reload()
  await waitForHydration(pageA)
  await expect(pageA.getByText("Penicilina").first()).toBeVisible({ timeout: 15_000 })


  // Registrar una nota desde el diálogo real de Historia.
  await pageA.getByRole("tab", { name: "Historia", exact: true }).click()
  await pageA.getByRole("button", { name: "Nota rápida", exact: true }).click()
  const noteDialog = pageA.getByRole("dialog", { name: "Nota rápida" })
  await noteDialog.getByLabel("Nota clínica").fill("Se indica endodoncia")
  await noteDialog.getByLabel("Diagnóstico CIE-10").fill("K04.0")
  // El popup del Combobox se portala fuera del diálogo: se busca a nivel de página.
  await pageA.getByRole("option", { name: /K04\.0\s+Pulpitis/ }).click()
  await noteDialog.getByRole("button", { name: "Guardar nota" }).click()
  await expect(noteDialog).not.toBeVisible()
  await expect(pageA.getByText("Se indica endodoncia").first()).toBeVisible({ timeout: 15_000 })
  await expect(pageA.getByText("K04.0").first()).toBeVisible()

  // Odontograma: pieza 16 con caries en oclusal; persiste tras recargar.
  const entry = await api(
    pageA,
    "POST",
    `/api/patients/${patientId}/odontogram/entries`,
    orgA.slug,
    {
      toothNumber: 16,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "enamel" },
    },
  )
  expect(entry.status).toBe(201)
  await pageA.getByRole("tab", { name: "Odontograma", exact: true }).click()
  await pageA.reload()
  await waitForHydration(pageA)
  await pageA.getByRole("tab", { name: "Odontograma", exact: true }).click()
  const odontogram = await api<{
    data: {
      history: Array<{
        toothNumber: number
        condition: string
        surface: string
        details: { variant?: string }
      }>
    }
  }>(pageA, "GET", `/api/patients/${patientId}/odontogram`, orgA.slug)
  expect(odontogram.status).toBe(200)
  expect(odontogram.body.data.history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        toothNumber: 16,
        condition: "caries",
        surface: "occlusal",
        details: expect.objectContaining({ variant: "enamel" }),
      }),
    ]),
  )

  // Aislamiento: org B no ve el paciente (lista vacía + 404).
  const contextB = await browser.newContext({ ignoreHTTPSErrors: true })
  const pageB = await contextB.newPage()
  await register(pageB, userB)
  await verifyEmail(pageB, userB.email)
  await login(pageB, userB)
  await onboard(pageB, orgB)
  const listB = await api<{ data: unknown[] }>(pageB, "GET", "/api/patients", orgB.slug)
  expect(listB.body.data).toEqual([])
  const cross = await api(pageB, "GET", `/api/patients/${patientId}`, orgB.slug)
  expect(cross.status).toBe(404)

  await contextA.close()
  await contextB.close()
})

test("paciente plus: registro en drawer, avatar, atención, plan", async ({ page }) => {
  const user = { name: "Denta Plus", email: `denta-plus-${run}@test.dev`, password: "secreto-123" }
  const org = { name: "Clínica Plus", slug: `clinica-plus-${run}` }
  await register(page, user)
  await verifyEmail(page, user.email)
  await login(page, user)
  await onboard(page, org)

  await gotoHydrated(page, tenant(org.slug, "/patients"))
  await page.getByRole("button", { name: "Nuevo paciente", exact: true }).click()
  // En ≥1280px la ficha nueva se abre como panel lateral (MasterDetail) y en
  // ancho corto como drawer modal: en ambos casos el wizard expone los campos.
  await expect(page.getByLabel("Nombre del paciente")).toBeVisible()
  // Wizard de registro: datos → contacto → salud → odontológicos → revisión.
  await page.getByLabel("Nombre del paciente").fill("Lucía Quispe")
  await page.getByRole("combobox", { name: "Tipo de documento" }).click()
  await page.getByRole("option", { name: "DNI", exact: true }).click()
  await page.getByLabel("Número de documento").fill("87654321")
  await page.getByRole("button", { name: "Siguiente", exact: true }).click()
  await page.getByLabel("Teléfono", { exact: true }).fill("999432198")
  await page.getByLabel("Dirección", { exact: true }).fill("Av. Salud 123")
  await page.getByRole("button", { name: "Siguiente", exact: true }).click()
  // Paso salud: declarar alergia con los mismos controles de antecedentes.
  await page.getByRole("combobox", { name: "¿Tiene alergias?" }).click()
  await page.getByRole("option", { name: "Sí", exact: true }).click()
  await page.getByRole("button", { name: "Agregar otra" }).first().click()
  await page.getByLabel("Sustancia").fill("Látex")
  await page.getByRole("combobox", { name: "Gravedad" }).click()
  await page.getByRole("option", { name: "Severa", exact: true }).click()
  await page.getByRole("button", { name: "Siguiente", exact: true }).click()
  // Paso odontológico sin respuestas: se omite y se avanza a revisión.
  await page.getByRole("button", { name: "Siguiente", exact: true }).click()
  await page.getByRole("button", { name: "Registrar paciente", exact: true }).click()
  await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}(?:\?|$)/)
  const patientId = new URL(page.url()).pathname.split("/").at(-1)!
  await expect(page.getByText(/HC-\d{6}/).first()).toBeVisible()
  await expect(
    page.getByLabel("Alertas clínicas").getByText("Alergia severa: Látex", { exact: true }),
  ).toBeVisible()

  const uploaded = await page.evaluate(
    async ({ apiBase, patientId, slug }) => {
      const canvas = new OffscreenCanvas(64, 64)
      const context = canvas.getContext("2d")!
      context.fillStyle = "#0d9488"
      context.fillRect(0, 0, 64, 64)
      const form = new FormData()
      form.append("file", await canvas.convertToBlob({ type: "image/png" }), "avatar.png")
      const response = await fetch(`${apiBase}/api/patients/${patientId}/avatar`, {
        method: "POST",
        credentials: "include",
        headers: { "x-odentia-org": slug },
        body: form,
      })
      return response.status
    },
    { apiBase: API, patientId, slug: org.slug },
  )
  expect(uploaded).toBe(201)
  await page.reload()
  await waitForHydration(page)
  await expect(
    page.locator("header").getByRole("img", { name: "Foto de Lucía Quispe" }),
  ).toBeVisible()

  // Oferta real de la org vía API del repo (sin depender de seed global):
  // se reutiliza si ya existe, o se crea como prestación propia con tarifa.
  const catalog = await api<{ data: { id: string; code: string; name: string }[] }>(
    page,
    "GET",
    "/api/services",
    org.slug,
  )
  const existingService = catalog.body.data.find((service) => service.code === "ENDODONCIA")
  const endodontics =
    existingService ??
    (await (async () => {
      const createdService = await api<{ data: { id: string; code: string; name: string } }>(
        page,
        "POST",
        "/api/services",
        org.slug,
        {
          code: "ENDODONCIA",
          name: "Endodoncia unirradicular",
          specialty: "endodoncia",
          scope: "tooth",
          priceCents: 45000,
          currency: "PEN",
          durationMin: 60,
        },
      )
      expect(createdService.status).toBe(201)
      return createdService.body.data
    })())
  // La indicación nace en una atención borrador y pertenece a un plan;
  // el presupuesto se arma desde el plan con sus ítems (contrato vigente).
  const seedEncounter = await api<{ data: { id: string } }>(
    page,
    "POST",
    `/api/patients/${patientId}/encounters`,
    org.slug,
    { reason: "Evaluación inicial" },
  )
  expect(seedEncounter.status).toBe(201)
  const treatmentPlan = await api<{ data: { id: string } }>(
    page,
    "POST",
    `/api/patients/${patientId}/plans`,
    org.slug,
    { title: "Plan de Lucía", originEncounterId: seedEncounter.body.data.id },
  )
  expect(treatmentPlan.status).toBe(201)
  const plan = await api<{ data: { id: string } }>(
    page,
    "POST",
    `/api/patients/${patientId}/plan/items`,
    org.slug,
    {
      serviceId: endodontics.id,
      planId: treatmentPlan.body.data.id,
      sourceEncounterId: seedEncounter.body.data.id,
      toothNumber: 36,
      diagnosisCode: "K04.0",
    },
  )
  expect(plan.status).toBe(201)
  const budget = await api<{ data: { id: string } }>(
    page,
    "POST",
    `/api/patients/${patientId}/budgets`,
    org.slug,
    {
      planId: treatmentPlan.body.data.id,
      itemIds: [plan.body.data.id],
      title: "Rehabilitación de Lucía",
    },
  )
  expect(budget.status).toBe(201)
  // Cerrar la atención semilla: el header ofrece "Nueva atención" solo sin borrador abierto.
  const patchedSeed = await api(
    page,
    "PATCH",
    `/api/patients/${patientId}/encounters/${seedEncounter.body.data.id}`,
    org.slug,
    { evolution: "Evaluación inicial sin complicaciones" },
  )
  expect(patchedSeed.status).toBe(200)
  const finalizedSeed = await api(
    page,
    "POST",
    `/api/patients/${patientId}/encounters/${seedEncounter.body.data.id}/finalize`,
    org.slug,
    {},
  )
  expect(finalizedSeed.status).toBe(200)
  expect(
    (
      await api(
        page,
        "POST",
        `/api/patients/${patientId}/budgets/${budget.body.data.id}/present`,
        org.slug,
        {},
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await api(
        page,
        "POST",
        `/api/patients/${patientId}/budgets/${budget.body.data.id}/decision`,
        org.slug,
        {
          acceptedItemIds: [plan.body.data.id],
          acceptedByName: "Lucía Quispe",
        },
      )
    ).status,
  ).toBe(200)

  // El asistente crea la atención únicamente al confirmar, con el tratamiento aún pendiente.
  await page.getByRole("button", { name: "Nueva atención", exact: true }).first().click()
  const newEncounter = page.getByRole("dialog", { name: "Nueva atención", exact: true })
  await newEncounter.getByLabel("Motivo de la atención").fill("Tratamiento endodóntico")
  await newEncounter.getByRole("button", { name: "Continuar", exact: true }).click()
  await newEncounter.getByRole("checkbox", { name: new RegExp(endodontics.name) }).check()
  await newEncounter.getByRole("button", { name: "Continuar", exact: true }).click()
  const creatingEncounter = page.waitForResponse(
    (response) =>
      response.url() === `${API}/api/patients/${patientId}/encounters` &&
      response.request().method() === "POST",
  )
  await newEncounter.getByRole("button", { name: "Crear atención", exact: true }).click()
  const createdEncounter = await creatingEncounter
  expect(createdEncounter.status()).toBe(201)
  const encounter = (await createdEncounter.json()) as { data: { id: string } }
  const encounterPath = `/api/patients/${patientId}/encounters/${encounter.data.id}`
  await expect(page).toHaveURL(new RegExp(`/encounters/${encounter.data.id}$`))
  await waitForHydration(page)
  const linked = await api<{
    data: { plannedItems: Array<{ id: string; status: string }>; procedures: unknown[] }
  }>(page, "GET", encounterPath, org.slug)
  expect(linked.body.data.plannedItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: plan.body.data.id, status: "pendiente" }),
    ]),
  )
  expect(linked.body.data.procedures).toEqual([])

  // Regresión: el guardado explícito sin cambios no bloquea el siguiente guardado.
  const saveDraft = page.getByRole("button", { name: "Guardar borrador", exact: true })
  await saveDraft.click()
  await expect(saveDraft).toBeEnabled()
  // La evolución se edita en su pestaña y persiste tras recargar.
  await page.getByRole("tab", { name: "Evolución", exact: true }).click()
  await page.getByLabel(/Evolución \(máx/).fill("Tratamiento realizado sin complicaciones")
  const [saved] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${API}${encounterPath}` && response.request().method() === "PATCH",
    ),
    saveDraft.click(),
  ])
  expect(saved.status()).toBe(200)
  await page.reload()
  await waitForHydration(page)
  await page.getByRole("tab", { name: "Evolución", exact: true }).click()
  await expect(page.getByLabel(/Evolución \(máx/)).toHaveValue(
    "Tratamiento realizado sin complicaciones",
  )

  const procedure = await api(page, "POST", `${encounterPath}/procedures`, org.slug, {
    toothNumber: 36,
    diagnosisCode: "K04.0",
    planItemId: plan.body.data.id,
  })
  expect(procedure.status).toBe(201)
  const finalized = await api(page, "POST", `${encounterPath}/finalize`, org.slug, {})
  expect(finalized.status).toBe(200)

  await gotoHydrated(page, tenant(org.slug, `/patients/${patientId}?tab=historia`))
  await expect(page.getByText("Tratamiento endodóntico", { exact: true }).first()).toBeVisible()
  await page.locator(`button[aria-controls="encounter-detail-${encounter.data.id}"]`).click()
  await expect(page.getByText(endodontics.name, { exact: true }).first()).toBeVisible()
  await expect(
    page.getByText("Tratamiento realizado sin complicaciones", { exact: true }).first(),
  ).toBeVisible()

  // Agrupación por tratamiento: secciones por atención + generales.
  await page.getByRole("button", { name: "Atención", exact: true }).click()
  await expect(
    page
      .getByRole("heading")
      .filter({ hasText: /^Atención / })
      .first(),
  ).toBeVisible()
  await page.getByRole("button", { name: "Día", exact: true }).click()
  await expect(
    page
      .getByRole("heading")
      .filter({ hasText: /^Atención / })
      .first(),
  ).toBeHidden()

  // Subida de imagen desde la UI: drawer con dropzone y galería con Attachment.
  await page.getByRole("tab", { name: "Imágenes y documentos", exact: true }).click()
  await page.getByRole("button", { name: "Subir imagen o documento", exact: true }).click()
  const uploadDrawer = page.getByRole("dialog", { name: "Subir imágenes o documentos" })
  await uploadDrawer.locator('input[type="file"]').setInputFiles({
    name: "rx-control.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    ),
  })
  await uploadDrawer.getByLabel("Título", { exact: true }).fill("RX de control")
  await uploadDrawer.getByRole("combobox", { name: "Categoría de rx-control.png" }).click()
  await page.getByRole("option", { name: "Radiografía", exact: true }).click()
  await uploadDrawer.getByText(/^Extras: piezas/).click()
  await uploadDrawer.getByRole("button", { name: /^Pieza 36:/ }).click()
  await uploadDrawer.getByRole("button", { name: /^Pieza 46:/ }).click()
  const tags = uploadDrawer.getByRole("textbox", { name: /^Etiquetas/ })
  await tags.fill("Control 1")
  await tags.press("Enter")
  await tags.fill("CONTROL-1")
  await tags.press("Enter")
  await uploadDrawer.getByRole("button", { name: /^Subir 1$/ }).click()
  await uploadDrawer.getByRole("button", { name: "Cancelar", exact: true }).click()
  await expect(uploadDrawer).toBeHidden()
  await expect(page.getByText("RX de control", { exact: true }).first()).toBeVisible()
  const documents = await api<{
    data: Array<{ label: string; toothNumbers: number[]; tags: string[] }>
  }>(page, "GET", `/api/patients/${patientId}/documents`, org.slug)
  expect(documents.body.data.find((doc) => doc.label === "RX de control")).toMatchObject({
    toothNumbers: [36, 46],
    tags: ["control-1"],
  })
  await gotoHydrated(
    page,
    tenant(org.slug, `/patients/${patientId}?tab=plan&budgetId=${budget.body.data.id}`),
  )
  const item = page.getByRole("row").filter({ hasText: endodontics.name })
  await expect(item.first().getByText("realizado", { exact: true })).toBeVisible()
})
