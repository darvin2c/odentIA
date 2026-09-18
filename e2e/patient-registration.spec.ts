import { type Browser, expect, type Page, test } from "@playwright/test"
import { simulateTelegramInbound } from "./channels"
import { latestLinkFor } from "./mailpit"

/**
 * Registro directo de pacientes: wizard público anónimo (QR genérico y enlace
 * contextual) con organización efímera configurada por API real, sin seed.
 *
 * Requiere el stack dev completo (API/platform/worker, Postgres, Mailpit) con
 * CHANNEL_VALIDATE_EXTERNAL=false, CHANNEL_SENDER_MODE=mock y LLM_MODEL=fake.
 * No depende de patients.spec.ts ni de datos semilla: cada prueba crea su
 * propietario verificado y su organización aislada por correo efímero.
 */

import { API, tenant, tenantPattern } from "./env"

const run = Date.now().toString(36)
let seq = 0

const nextDoc = () => String(31_000_000 + seq++)
const nextPhone = () => `+51999${String(100_000 + seq++).slice(-6)}`
/**
 * Lo que se ve en el campo de teléfono: el número nacional enmascarado
 * (`+51999123456` → `999 123 456`). El E.164 es el valor del formulario.
 */
const maskedPhone = (e164: string) => {
  const national = e164.replace(/\D/g, "").slice(2)
  return `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`
}
const uid = () => 6_000_000 + Math.floor(Math.random() * 1_000_000)

const PRIVACY = "Aviso e2e: tus datos se usan solo para tu atención clínica (demostración)."

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

async function register(page: Page, user: { name: string; email: string; password: string }) {
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

async function login(page: Page, user: { email: string; password: string }) {
  await gotoHydrated(page, "/login")
  await page.getByLabel("Correo").fill(user.email)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Ingresar" }).click()
}

// Alta real autenticada de organización vía better-auth HTTP (mismo contrato que
// el onboarding de producción) sin depender del wizard UI: crea la organización,
// la deja activa, completa perfil legal y primera sucursal, y entra al tenant.
async function onboard(page: Page, org: { name: string; slug: string }) {
  await page.evaluate(
    async ({ apiBase, org }: { apiBase: string; org: { name: string; slug: string } }) => {
      async function call(method: string, path: string, body: unknown, slug?: string) {
        const response = await fetch(`${apiBase}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(slug ? { "x-odentia-org": slug } : {}),
          },
          credentials: "include",
          body: JSON.stringify(body),
        })
        const json = (await response.json().catch(() => null)) as {
          id?: string
          data?: { id?: string }
          organization?: { id?: string }
        } | null
        if (!response.ok) {
          throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(json)}`)
        }
        return json
      }
      const created = await call("POST", "/api/auth/organization/create", {
        name: org.name,
        slug: org.slug,
      })
      const orgId = created?.data?.id ?? created?.organization?.id ?? created?.id
      if (!orgId) throw new Error(`organization.create sin id: ${JSON.stringify(created)}`)
      await call("POST", "/api/auth/organization/set-active", { organizationId: orgId })
      await call(
        "PUT",
        "/api/org-profile",
        { legalName: `${org.name} S.A.C.`, countryCode: "PE" },
        org.slug,
      )
      await call("POST", "/api/branches", { name: "Sede Central" }, org.slug)
    },
    { apiBase: API, org },
  )
  await page.goto(tenant(org.slug, "/branches"))
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

interface OwnerSetup {
  page: Page
  cleanup: () => Promise<void>
  org: { name: string; slug: string }
}

async function setupOwner(browser: Browser, tag: string): Promise<OwnerSetup> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const user = { name: `Dueña ${tag}`, email: `qr-${tag}-${run}@test.dev`, password: "secreto-123" }
  const org = { name: `Clínica QR ${tag} ${run}`, slug: `qr-${tag}-${run}` }
  await register(page, user)
  await verifyEmail(page, user.email)
  await login(page, user)
  await onboard(page, org)
  return { page, cleanup: () => context.close(), org }
}

/** Publica el formulario con los campos por defecto y devuelve la versión vigente. */
async function publishConfig(page: Page, slug: string, privacyNotice = PRIVACY) {
  const current = await api<{ data: { version: number; fields: unknown } }>(
    page,
    "GET",
    "/api/patient-registration/config",
    slug,
  )
  expect(current.status).toBe(200)
  const saved = await api<{ data: { version: number; enabled: boolean } }>(
    page,
    "PUT",
    "/api/patient-registration/config",
    slug,
    {
      enabled: true,
      fields: current.body.data.fields,
      privacyNotice,
      expectedVersion: current.body.data.version,
    },
  )
  expect(saved.status).toBe(200)
  expect(saved.body.data.enabled).toBe(true)
  return saved.body.data.version
}

async function anonymousPage(browser: Browser, viewport?: { width: number; height: number }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport })
  return { context, page: await context.newPage() }
}

/** Paso "Datos": adulto con nombre y nacimiento, y avanza al siguiente paso. */
async function fillAdultDatos(page: Page, input: { name: string; birthDate: string }) {
  await page.getByLabel("Nombre del paciente").fill(input.name)
  await page.getByLabel("Fecha de nacimiento").fill(input.birthDate)
  await page.getByRole("button", { name: "Siguiente", exact: true }).click()
}

/** Paso "Contacto y filiación": solo teléfono para la config por defecto. */
async function fillContacto(page: Page, phone: string) {
  await page.getByLabel("Teléfono", { exact: true }).fill(phone)
  await page.getByRole("button", { name: "Siguiente", exact: true }).click()
}

/** Paso "Salud": alergia declarada, O+, «No sé» en enfermedades y «No» en medicación. */
async function fillSalud(page: Page) {
  await page.getByLabel("Grupo sanguíneo").click()
  await page.getByRole("option", { name: "O+", exact: true }).click()
  await page.getByLabel("¿Tiene alergias?").click()
  await page.getByRole("option", { name: "Sí", exact: true }).click()
  // El grupo de alergias es el primero de los tres ("Agregar otra" por grupo).
  await page.getByRole("button", { name: "Agregar otra" }).first().click()
  await page.getByLabel("Sustancia").fill("Penicilina")
  await page.getByLabel("Gravedad").click()
  await page.getByRole("option", { name: "Severa", exact: true }).click()
  await page.getByLabel("¿Tiene alguna enfermedad actual?").click()
  await page.getByRole("option", { name: "No sé", exact: true }).click()
  await page.getByLabel("¿Toma medicación actualmente?").click()
  await page.getByRole("option", { name: "No", exact: true }).click()
  await page.getByRole("button", { name: "Siguiente", exact: true }).click()
}

/** Paso "Revisión": acepta el aviso y envía. */
async function acceptAndSubmit(page: Page) {
  await page.getByRole("checkbox", { name: /Autorizo el tratamiento de mis datos/ }).check()
  await page.getByRole("button", { name: "Enviar registro", exact: true }).click()
}

interface PatientListItem {
  id: string
  patientNumber: number
  displayName: string
}

interface PatientDetail {
  patient: {
    id: string
    displayName: string
    bloodGroup: string | null
    dataConsentAt: string | null
    dataConsentBy: string | null
    healthReviewedAt: string | null
    healthReviewedBy: string | null
  }
  contacts: { contactId: string; relationship: string; isPreferred: boolean }[]
  registration: {
    entryPoint: string
    respondent: string | null
    conversationId: string | null
    contextContactId: string | null
    actor: { id: string; name: string } | null
    answers: {
      demographics: Record<string, string>
      respondent: string
      representative?: {
        displayName: string
        relationship: string
        relationshipDetail?: string
      }
      privacyAccepted: boolean
      health: {
        bloodGroup: string | null
        allergies: { state: string; items: { substance: string; severity: string }[] }
        conditions: { state: string; items: unknown[] }
        medications: { state: string; items: unknown[] }
      }
    }
  } | null
  activeAllergies: { substance: string; severity: string | null }[]
}

async function findPatientByName(page: Page, slug: string, displayName: string) {
  const list = await api<{ data: PatientListItem[] }>(
    page,
    "GET",
    `/api/patients?q=${encodeURIComponent(displayName)}`,
    slug,
  )
  expect(list.status).toBe(200)
  const found = list.body.data.find((item) => item.displayName === displayName)
  expect(found).toBeDefined()
  return found!
}

async function getPatientDetail(page: Page, slug: string, patientId: string) {
  const detail = await api<{ data: PatientDetail }>(page, "GET", `/api/patients/${patientId}`, slug)
  expect(detail.status).toBe(200)
  return detail.body.data
}

test("registro público QR en escritorio: conserva borrador, declara salud y no vincula por teléfono", async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const setup = await setupOwner(browser, "desk")
  const { page, org } = setup
  try {
    await publishConfig(page, org.slug)
    const sharedPhone = nextPhone()
    const contact = await api<{ data: { id: string } }>(page, "POST", "/api/contacts", org.slug, {
      displayName: "Contacto Previo",
      phone: sharedPhone,
    })
    expect(contact.status).toBe(201)
    const contactId = contact.body.data.id

    const patientName = `Paciente QR ${run}`
    const { context: anonContext, page: anon } = await anonymousPage(browser, {
      width: 1440,
      height: 900,
    })
    try {
      await gotoHydrated(anon, tenant(org.slug, "/registro?via=qr"))
      await expect(anon.getByText(`Registro de paciente · ${org.name}`).first()).toBeVisible()

      await anon.getByLabel("Nombre del paciente").fill(patientName)
      await anon.getByLabel("Fecha de nacimiento").fill("1990-04-11")
      await anon.getByRole("button", { name: "Siguiente", exact: true }).click()
      await anon.getByLabel("Teléfono", { exact: true }).fill(sharedPhone)
      // Volver conserva el nombre y reavanzar conserva el teléfono.
      await anon.getByRole("button", { name: "Anterior", exact: true }).click()
      await expect(anon.getByLabel("Nombre del paciente")).toHaveValue(patientName)
      await anon.getByRole("button", { name: "Siguiente", exact: true }).click()
      await expect(anon.getByLabel("Teléfono", { exact: true })).toHaveValue(
        maskedPhone(sharedPhone),
      )
      await anon.getByRole("button", { name: "Siguiente", exact: true }).click()

      await fillSalud(anon)
      await acceptAndSubmit(anon)

      await expect(anon.getByText("Paciente registrado", { exact: true })).toBeVisible()
      await expect(anon.getByText(new RegExp(`recibidos por ${org.name}`))).toBeVisible()
      // Éxito sin sesión: no expone ficha, número clínico ni edición.
      await expect(anon).toHaveURL(/\/registro/)
      await expect(anon.locator('a[href*="/patients/"]')).toHaveCount(0)
      await expect(anon.getByText(/HC-\d{6}/)).toHaveCount(0)
    } finally {
      await anonContext.close()
    }

    // El teléfono coincidente no reclama el contacto existente.
    const created = await findPatientByName(page, org.slug, patientName)
    const detail = await getPatientDetail(page, org.slug, created.id)
    expect(detail.contacts).toEqual([])
    expect(detail.registration).toMatchObject({ entryPoint: "qr", respondent: "patient" })
    expect(detail.registration?.actor).toBeNull()
    expect(detail.registration?.answers.privacyAccepted).toBe(true)
    expect(detail.registration?.answers.health.bloodGroup).toBe("O+")
    expect(detail.registration?.answers.health.allergies).toMatchObject({
      state: "recorded",
      items: [{ substance: "Penicilina", severity: "severa" }],
    })
    // «No sé» se conserva distinto de «No»: desconocimiento frente a negación.
    expect(detail.registration?.answers.health.conditions.state).toBe("unknown")
    expect(detail.registration?.answers.health.medications.state).toBe("none")
    // Declaración pendiente de revisión: sin revisor ni fecha, pero con alerta activa.
    expect(detail.patient.bloodGroup).toBe("O+")
    expect(detail.patient.healthReviewedAt).toBeNull()
    expect(detail.patient.healthReviewedBy).toBeNull()
    expect(detail.patient.dataConsentAt).not.toBeNull()
    expect(detail.patient.dataConsentBy).toBeNull()
    expect(detail.activeAllergies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ substance: "Penicilina", severity: "severa" }),
      ]),
    )
    const untouched = await api<{ data: { patients: unknown[] } }>(
      page,
      "GET",
      `/api/contacts/${contactId}`,
      org.slug,
    )
    expect(untouched.body.data.patients).toEqual([])

    // La alergia declarada aparece de inmediato en la ficha interna.
    await gotoHydrated(page, tenant(org.slug, `/patients/${created.id}`))
    await expect(
      page.getByLabel("Alertas clínicas").getByText("Alergia severa: Penicilina", {
        exact: true,
      }),
    ).toBeVisible()
  } finally {
    await setup.cleanup()
  }
})

test("registro público QR en móvil: flujo completo en 390px sin cuenta", async ({ browser }) => {
  test.setTimeout(600_000)
  const setup = await setupOwner(browser, "movil")
  const { page, org } = setup
  try {
    await publishConfig(page, org.slug)
    const { context: anonContext, page: anon } = await anonymousPage(browser, {
      width: 390,
      height: 844,
    })
    try {
      await gotoHydrated(anon, tenant(org.slug, "/registro?via=qr"))
      const patientName = `Paciente Móvil ${run}`
      const phone = nextPhone()
      await fillAdultDatos(anon, { name: patientName, birthDate: "1988-11-02" })
      await fillContacto(anon, phone)
      await fillSalud(anon)
      await acceptAndSubmit(anon)

      await expect(anon.getByText("Paciente registrado", { exact: true })).toBeVisible()
      await expect(anon.getByText(new RegExp(`recibidos por ${org.name}`))).toBeVisible()
      await expect(anon).toHaveURL(/\/registro/)
      await expect(anon.locator('a[href*="/patients/"]')).toHaveCount(0)
    } finally {
      await anonContext.close()
    }

    const created = await findPatientByName(page, org.slug, `Paciente Móvil ${run}`)
    const detail = await getPatientDetail(page, org.slug, created.id)
    expect(detail.registration).toMatchObject({ entryPoint: "qr", respondent: "patient" })
    expect(detail.contacts).toEqual([])
    expect(detail.activeAllergies).toEqual(
      expect.arrayContaining([expect.objectContaining({ substance: "Penicilina" })]),
    )
  } finally {
    await setup.cleanup()
  }
})

test("cambio de configuración conserva el borrador y no reenvía solo", async ({ browser }) => {
  test.setTimeout(600_000)
  const setup = await setupOwner(browser, "version")
  const { page, org } = setup
  try {
    await publishConfig(page, org.slug)
    const { context: anonContext, page: anon } = await anonymousPage(browser)
    try {
      await gotoHydrated(anon, tenant(org.slug, "/registro?via=qr"))
      const patientName = `Paciente Versión ${run}`
      const phone = nextPhone()
      await fillAdultDatos(anon, { name: patientName, birthDate: "1992-07-19" })
      await fillContacto(anon, phone)
      await fillSalud(anon)

      let publicPosts = 0
      anon.on("request", (request) => {
        if (
          request.url().includes(`/api/public/patient-registration/${org.slug}`) &&
          request.method() === "POST"
        ) {
          publicPosts += 1
        }
      })
      // La única recarga de config tras preparar el envío es la del aviso FORM_CHANGED.
      const refetched = anon.waitForResponse(
        (response) =>
          response.url().includes(`/api/public/patient-registration/${org.slug}`) &&
          response.request().method() === "GET",
        { timeout: 30_000 },
      )
      // Publicar una revisión mientras el borrador está en revisión invalida el envío.
      await publishConfig(page, org.slug, `${PRIVACY} (rev. 2)`)
      await acceptAndSubmit(anon)

      await expect(
        anon.getByText(/El formulario cambió: recargamos la configuración vigente/),
      ).toBeVisible()
      await refetched
      // Sin éxito, sin reintento automático y con el borrador intacto.
      await expect(anon.getByText("Paciente registrado", { exact: true })).toHaveCount(0)
      expect(publicPosts).toBe(1)
      await expect(anon.getByText(/rev\. 2/)).toBeVisible()
      await expect(
        anon.getByRole("checkbox", { name: /Autorizo el tratamiento de mis datos/ }),
      ).toBeChecked()
      // La declaración de salud se conserva al retroceder.
      await anon.getByRole("button", { name: "Anterior", exact: true }).click()
      await expect(anon.getByLabel("¿Tiene alergias?")).toHaveText("Sí")
      await anon.getByRole("button", { name: "Siguiente", exact: true }).click()
      // El segundo envío es manual y usa la versión vigente.
      await acceptAndSubmit(anon)
      await expect(anon.getByText("Paciente registrado", { exact: true })).toBeVisible()
      expect(publicPosts).toBe(2)
    } finally {
      await anonContext.close()
    }

    const created = await findPatientByName(page, org.slug, `Paciente Versión ${run}`)
    const detail = await getPatientDetail(page, org.slug, created.id)
    expect(detail.registration).toMatchObject({ entryPoint: "qr", respondent: "patient" })
  } finally {
    await setup.cleanup()
  }
})

test("enlace contextual registra a un menor sin duplicar self y luego no está disponible", async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const setup = await setupOwner(browser, "enlace")
  const { page, org } = setup
  try {
    await publishConfig(page, org.slug)

    // Conversación real por Telegram simulado: contacto e identidad resueltos por ingesta.
    const tgConn = await api<{ data: { id: string; webhookSecret: string } }>(
      page,
      "POST",
      "/api/channels/connections",
      org.slug,
      {
        channel: "telegram",
        provider: "telegram_bot_api",
        displayName: "Bot E2E",
        config: { botToken: "e2e" },
      },
    )
    expect(tgConn.status).toBe(201)
    expect(
      await simulateTelegramInbound(
        page,
        API,
        tgConn.body.data.id,
        tgConn.body.data.webhookSecret,
        {
          fromId: 2001 + (seq % 997),
          chatId: 2001 + (seq % 997),
          text: "Hola, quiero registrar a mi hijo",
          updateId: uid(),
        },
      ),
    ).toBe(200)
    await expect
      .poll(
        async () =>
          (await api<{ data: unknown[] }>(page, "GET", "/api/conversations", org.slug)).body.data
            .length,
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(1)
    const convs = await api<{ data: { id: string; contact: { id: string } }[] }>(
      page,
      "GET",
      "/api/conversations",
      org.slug,
    )
    const conversationId = convs.body.data[0]?.id ?? ""
    const contactId = convs.body.data[0]?.contact.id ?? ""
    expect(conversationId).not.toBe("")

    // El contacto ya tiene ficha propia: un segundo «A mí» no debe duplicarla.
    const selfDoc = nextDoc()
    const selfPatient = await api<{ data: { id: string } }>(
      page,
      "POST",
      "/api/patients",
      org.slug,
      {
        submissionId: crypto.randomUUID(),
        answers: {
          demographics: {
            displayName: `Titular Enlace ${run}`,
            birthDate: "1985-03-20",
            docType: "DNI",
            docNumber: selfDoc,
          },
          respondent: "staff",
          privacyAccepted: false,
        },
        contacts: [{ contactId, relationship: "self", isPreferred: true }],
      },
    )
    expect(selfPatient.status).toBe(201)

    const link = await api<{ data: { url: string; expiresAt: string } }>(
      page,
      "POST",
      `/api/contacts/${contactId}/registration-links`,
      org.slug,
      { conversationId },
    )
    expect(link.status).toBe(201)
    const linkUrl = link.body.data.url
    expect(linkUrl).toContain("/registro?token=")

    // Intento duplicado como "Soy el paciente" con el mismo documento: mensaje neutro.
    const { context: dupContext, page: dup } = await anonymousPage(browser)
    try {
      await gotoHydrated(dup, linkUrl)
      await expect(
        dup.getByText("Continúa con el registro compartido por la clínica."),
      ).toBeVisible()
      await dup.getByLabel("Nombre del paciente").fill(`Duplicado Enlace ${run}`)
      await dup.getByLabel("Fecha de nacimiento").fill("1985-03-20")
      await dup.getByLabel("Tipo de documento").click()
      await dup.getByRole("option", { name: "DNI", exact: true }).click()
      await dup.getByLabel("Número de documento").fill(selfDoc)
      await dup.getByRole("button", { name: "Siguiente", exact: true }).click()
      await dup.getByLabel("Teléfono", { exact: true }).fill(nextPhone())
      await dup.getByRole("button", { name: "Siguiente", exact: true }).click()
      await dup.getByRole("button", { name: "Siguiente", exact: true }).click()
      await dup.getByRole("checkbox", { name: /Autorizo el tratamiento de mis datos/ }).check()
      await dup.getByRole("button", { name: "Enviar registro", exact: true }).click()

      await expect(
        dup.getByText("No pudimos completar el registro. Comunícate con recepción.", {
          exact: true,
        }),
      ).toBeVisible()
      await expect(dup.getByText("Paciente registrado", { exact: true })).toHaveCount(0)
      await expect(dup.getByText(/HC-\d{6}/)).toHaveCount(0)
    } finally {
      await dupContext.close()
    }
    const stillOne = await api<{ data: PatientListItem[] }>(page, "GET", "/api/patients", org.slug)
    expect(stillOne.body.data).toHaveLength(1)

    // Registro del menor como "otra persona": vínculo de tutor, sin ficha self nueva.
    const { context: minorContext, page: minor } = await anonymousPage(browser)
    try {
      await gotoHydrated(minor, linkUrl)
      await minor.getByLabel("¿Quién completa el registro?").click()
      await minor.getByRole("option", { name: "Registro a otra persona", exact: true }).click()
      const minorName = `Menor Enlace ${run}`
      await minor.getByLabel("Nombre del paciente").fill(minorName)
      await minor.getByLabel("Fecha de nacimiento").fill("2018-06-15")
      await minor.getByRole("button", { name: "Siguiente", exact: true }).click()
      // El responsable se pide en "Contacto y filiación" cuando el paciente es menor.
      await minor.getByLabel("Nombre del responsable").fill(`Madre Enlace ${run}`)
      await minor.getByLabel("Detalle de la relación").fill("Madre")
      await minor.getByLabel("Teléfono del responsable").fill(nextPhone())
      await minor.getByLabel("Teléfono", { exact: true }).fill(nextPhone())
      await minor.getByRole("button", { name: "Siguiente", exact: true }).click()
      await minor.getByRole("button", { name: "Siguiente", exact: true }).click()
      await minor.getByRole("checkbox", { name: /Autorizo el tratamiento de mis datos/ }).check()
      await minor.getByRole("button", { name: "Enviar registro", exact: true }).click()

      await expect(minor.getByText("Paciente registrado", { exact: true })).toBeVisible()
      await expect(minor.locator('a[href*="/patients/"]')).toHaveCount(0)
    } finally {
      await minorContext.close()
    }

    const minorRow = await findPatientByName(page, org.slug, `Menor Enlace ${run}`)
    const minorDetail = await getPatientDetail(page, org.slug, minorRow.id)
    expect(minorDetail.contacts).toEqual([
      expect.objectContaining({ contactId, relationship: "guardian" }),
    ])
    expect(minorDetail.registration).toMatchObject({
      respondent: "representative",
      conversationId,
      contextContactId: contactId,
    })
    expect(minorDetail.registration?.answers.representative).toMatchObject({
      displayName: `Madre Enlace ${run}`,
      relationship: "guardian",
      relationshipDetail: "Madre",
    })
    const contactDetail = await api<{
      data: { patients: { id: string; relationship: string }[] }
    }>(page, "GET", `/api/contacts/${contactId}`, org.slug)
    expect(
      contactDetail.body.data.patients.filter((entry) => entry.relationship === "self"),
    ).toHaveLength(1)
    expect(contactDetail.body.data.patients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: selfPatient.body.data.id, relationship: "self" }),
        expect.objectContaining({ id: minorRow.id, relationship: "guardian" }),
      ]),
    )

    // Enlace consumido: en otra sesión anónima ya no está disponible, sin prefills.
    const { context: goneContext, page: gone } = await anonymousPage(browser)
    try {
      await gotoHydrated(gone, linkUrl)
      await expect(gone.getByText("Enlace no disponible", { exact: true }).first()).toBeVisible()
      await expect(gone.getByLabel("Nombre del paciente")).toHaveCount(0)
    } finally {
      await goneContext.close()
    }
  } finally {
    await setup.cleanup()
  }
})

test("vista previa de configuración no crea pacientes", async ({ browser }) => {
  test.setTimeout(600_000)
  const setup = await setupOwner(browser, "previa")
  const { page, org } = setup
  try {
    await gotoHydrated(page, tenant(org.slug, "/settings/patient-registration"))
    await page.getByRole("button", { name: "Vista previa", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Vista previa del formulario" })
    await expect(dialog).toBeVisible()
    // Datos ficticios en memoria: avanzar hasta finalizar sin POST.
    await dialog.getByRole("button", { name: "Siguiente", exact: true }).click()
    await dialog.getByRole("button", { name: "Siguiente", exact: true }).click()
    await dialog.getByRole("button", { name: "Siguiente", exact: true }).click()
    await dialog.getByRole("button", { name: "Finalizar vista previa", exact: true }).click()
    await expect(dialog.getByText("Vista previa: no se guardaron datos")).toBeVisible()
    await dialog.getByRole("button", { name: "Cerrar", exact: true }).click()

    const list = await api<{ data: unknown[] }>(page, "GET", "/api/patients", org.slug)
    expect(list.body.data).toEqual([])
  } finally {
    await setup.cleanup()
  }
})
