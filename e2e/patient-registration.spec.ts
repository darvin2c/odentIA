import { createHash, randomBytes } from "node:crypto"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { patientContact } from "@odentia/db/schema/clinical"
import type { Browser, Page } from "@playwright/test"
import { eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, PANEL, tenant } from "./env"
import { call, expect, fillPatientNames, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/**
 * Registro directo de pacientes: wizard público anónimo (QR genérico y enlace
 * contextual) con comprobación interna autenticada. Cada caso crea su owner por
 * fixture; los formularios públicos corren en contextos anónimos sin estado.
 */

const PRIVACY = "Aviso e2e: tus datos se usan solo para tu atención clínica (demostración)."

const phoneFromId = (id: number): string => `+51999${String(100_000 + (id % 900_000))}`
const docFromId = (id: number): string => String(31_000_000 + (id % 900_000))

/**
 * Lo que se ve en el campo de teléfono: el número nacional enmascarado
 * (`+51999123456` → `999 123 456`). El E.164 es el valor del formulario.
 */
const maskedPhone = (e164: string) => {
  const national = e164.replace(/^\+51/, "")
  return `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`
}

/** Publica el formulario con los campos por defecto y devuelve la versión vigente. */
async function publishConfig(page: Page, slug: string, privacyNotice = PRIVACY) {
  const current = await call<{ version: number; fields: unknown }>(
    page,
    "GET",
    "/api/patient-registration/config",
    slug,
  )
  const saved = await call<{ version: number; enabled: boolean }>(
    page,
    "PUT",
    "/api/patient-registration/config",
    slug,
    {
      enabled: true,
      fields: current.fields,
      privacyNotice,
      expectedVersion: current.version,
    },
  )
  expect(saved.enabled).toBe(true)
  return saved.version
}

async function anonymousPage(browser: Browser, viewport?: { width: number; height: number }) {
  const context = await browser.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true, viewport })
  return { context, page: await context.newPage() }
}

/** Paso "Datos": adulto con nombre y nacimiento, y avanza al siguiente paso. */
async function fillAdultDatos(page: Page, input: { name: string; birthDate: string }) {
  await fillPatientNames(page, input.name)
  await page.getByLabel("Fecha de nacimiento").fill(input.birthDate)
  await page.getByRole("button", { name: "Siguiente", exact: true }).click()
}

/** Paso "Contacto y filiación": solo teléfono para la config por defecto. */
async function fillContacto(page: Page, phone: string) {
  await page.getByLabel(/^Teléfono(?: \*)?$/).fill(phone)
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
  const list = await call<PatientListItem[]>(
    page,
    "GET",
    `/api/patients?q=${encodeURIComponent(displayName)}`,
    slug,
  )
  const found = list.find((item) => item.displayName === displayName)
  expect(found).toBeDefined()
  return found!
}

/** La ficha administrativa; con `clinical`, la lectura clínica (lo que pide Clínica y deja traza). */
async function getPatientDetail(page: Page, slug: string, patientId: string, clinical = false) {
  return call<PatientDetail>(page, "GET", `/api/patients/${patientId}${clinical ? "?clinical=1" : ""}`, slug)
}

test("registro público QR en escritorio: conserva borrador, declara salud y no vincula por teléfono", async ({
  browser,
  createOwner,
  nextEventId,
}) => {
  const owner = await createOwner("qr-desk")
  const { page, org } = owner
  await publishConfig(page, org.slug)
  // Teléfono deliberadamente repetido: el contacto previo y el formulario
  // comparten número para probar que no se reclama la ficha existente.
  const sharedPhone = phoneFromId(nextEventId())
  const contact = await call<{ id: string }>(
    page,
    "POST",
    "/api/contacts",
    org.slug,
    { displayName: "Contacto Previo", phone: sharedPhone },
    201,
  )
  const contactId = contact.id

  const patientName = `Paciente QR ${org.slug}`
  const { context: anonContext, page: anon } = await anonymousPage(browser, {
    width: 1440,
    height: 900,
  })
  try {
    await gotoHydrated(anon, tenant(org.slug, "/registro?via=qr"))
    await expect(anon.getByText(`Registro de paciente · ${org.name}`).first()).toBeVisible()

    await fillPatientNames(anon, patientName)
    await anon.getByLabel("Fecha de nacimiento").fill("1990-04-11")
    await anon.getByRole("button", { name: "Siguiente", exact: true }).click()
    await anon.getByLabel(/^Teléfono(?: \*)?$/).fill(sharedPhone)
    // Volver conserva el nombre y reavanzar conserva el teléfono.
    await anon.getByRole("button", { name: "Anterior", exact: true }).click()
    await expect(anon.getByLabel(/^Nombres/)).toHaveValue(patientName.split(" ")[0] ?? "")
    await anon.getByRole("button", { name: "Siguiente", exact: true }).click()
    await expect(anon.getByLabel(/^Teléfono(?: \*)?$/)).toHaveValue(
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

  // El teléfono coincidente no reclama el contacto existente: la persona del
  // paciente es nueva (todo paciente es una persona).
  const created = await findPatientByName(page, org.slug, patientName)
  // Abrir la ficha no es una lectura clínica: lo administrativo del registro viaja sin la salud declarada.
  const administrative = await getPatientDetail(page, org.slug, created.id)
  expect(administrative.registration).toMatchObject({ entryPoint: "qr", respondent: "patient" })
  expect(administrative.registration?.answers).not.toHaveProperty("health")
  const detail = await getPatientDetail(page, org.slug, created.id, true)
  expect(detail.contacts).toEqual([expect.objectContaining({ relationship: "self" })])
  expect(detail.contacts[0]?.contactId).not.toBe(contactId)
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
  // El consentimiento queda en «Datos y consentimiento», por versión del aviso:
  // lo dio la persona en el formulario, sin nadie del equipo.
  const consents = await call<
    { channel: string; recordedBy: string | null; purposes: string[]; revokedAt: string | null }[]
  >(page, "GET", `/api/patients/${created.id}/data-consents`, org.slug)
  expect(consents).toEqual([
    expect.objectContaining({ channel: "formulario_publico", recordedBy: null, revokedAt: null }),
  ])
  expect(consents[0]?.purposes).toContain("atencion")
  expect(detail.activeAllergies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ substance: "Penicilina", severity: "severa" }),
    ]),
  )
  const untouched = await call<{ patients: unknown[] }>(
    page,
    "GET",
    `/api/contacts/${contactId}`,
    org.slug,
  )
  expect(untouched.patients).toEqual([])

  // La alergia declarada aparece de inmediato en la ficha interna.
  await gotoHydrated(page, tenant(org.slug, `/patients/${created.id}`))
  await expect(
    page.getByLabel("Alertas clínicas").getByText("Alergia severa: Penicilina", {
      exact: true,
    }),
  ).toBeVisible()
})

test("registro público QR en móvil: flujo completo en 390px sin cuenta", async ({
  browser,
  createOwner,
  nextEventId,
}) => {
  const owner = await createOwner("qr-movil")
  const { page, org } = owner
  await publishConfig(page, org.slug)
  const { context: anonContext, page: anon } = await anonymousPage(browser, {
    width: 390,
    height: 844,
  })
  try {
    await gotoHydrated(anon, tenant(org.slug, "/registro?via=qr"))
    const patientName = `Paciente Móvil ${org.slug}`
    const phone = phoneFromId(nextEventId())
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

  const created = await findPatientByName(page, org.slug, `Paciente Móvil ${org.slug}`)
  const detail = await getPatientDetail(page, org.slug, created.id)
  expect(detail.registration).toMatchObject({ entryPoint: "qr", respondent: "patient" })
  expect(detail.contacts).toEqual([expect.objectContaining({ relationship: "self" })])
  expect(detail.activeAllergies).toEqual(
    expect.arrayContaining([expect.objectContaining({ substance: "Penicilina" })]),
  )
})

test("cambio de configuración conserva el borrador y no reenvía solo", async ({
  browser,
  createOwner,
  nextEventId,
}) => {
  const owner = await createOwner("qr-version")
  const { page, org } = owner
  await publishConfig(page, org.slug)
  const { context: anonContext, page: anon } = await anonymousPage(browser)
  try {
    await gotoHydrated(anon, tenant(org.slug, "/registro?via=qr"))
    const patientName = `Paciente Versión ${org.slug}`
    const phone = phoneFromId(nextEventId())
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

  const created = await findPatientByName(page, org.slug, `Paciente Versión ${org.slug}`)
  const detail = await getPatientDetail(page, org.slug, created.id)
  expect(detail.registration).toMatchObject({ entryPoint: "qr", respondent: "patient" })
})

test("enlace contextual de quien ya tiene ficha registra a un menor sin ofrecerle registrarse y luego no está disponible", async ({
  browser,
  createOwner,
  nextEventId,
}, testInfo) => {
  const owner = await createOwner("qr-enlace")
  const { page, org } = owner
  await publishConfig(page, org.slug)

  // Conversación real por Telegram simulado: contacto e identidad resueltos por ingesta.
  const tgConn = await call<{ id: string; webhookSecret: string }>(
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
    201,
  )
  const tgUser = nextEventId()
  expect(
    await simulateTelegramInbound(page, API, tgConn.id, tgConn.webhookSecret, {
      fromId: tgUser,
      chatId: tgUser,
      text: "Hola, quiero registrar a mi hijo",
      updateId: nextEventId(),
    }),
  ).toBe(200)
  await expect
    .poll(
      async () =>
        (
          await call<{ connection: { id: string } }[]>(
            page,
            "GET",
            "/api/conversations",
            org.slug,
          )
        ).find((c) => c.connection.id === tgConn.id)?.connection.id ?? "",
      { timeout: 30_000 },
    )
    .toBe(tgConn.id)
  const convs = await call<{ id: string; contact: { id: string }; connection: { id: string } }[]>(
    page,
    "GET",
    "/api/conversations",
    org.slug,
  )
  const expected = convs.find((c) => c.connection.id === tgConn.id)
  expect(expected).toBeDefined()
  const conversationId = expected!.id
  const contactId = expected!.contact.id

  // El contacto ya tiene ficha propia: su enlace es para registrar a un familiar.
  const selfPatient = await call<{ id: string }>(
    page,
    "POST",
    "/api/patients",
    org.slug,
    {
      submissionId: crypto.randomUUID(),
      answers: {
        demographics: {
          displayName: `Titular Enlace ${org.slug}`,
          birthDate: "1985-03-20",
          docType: "DNI",
          docNumber: docFromId(nextEventId()),
          // La configuración publicada exige teléfono también en el alta interna.
          phone: phoneFromId(nextEventId()),
        },
        respondent: "staff",
        privacyAccepted: false,
      },
      contacts: [{ contactId, relationship: "self", isPreferred: true }],
    },
    201,
  )

  const link = await call<{ url: string; expiresAt: string }>(
    page,
    "POST",
    `/api/contacts/${contactId}/registration-links`,
    org.slug,
    { conversationId },
    201,
  )
  const linkUrl = link.url
  expect(linkUrl).toContain("/registro?token=")
  // El enlace conserva el origen público del tenant, puerto incluido.
  expect(new URL(linkUrl).origin).toBe(new URL(tenant(org.slug, "/")).origin)

  // Registro del menor como "otra persona": vínculo de tutor, sin ficha self nueva.
  // Ya tiene su ficha: el formulario no le ofrece registrarse a sí misma.
  const { context: minorContext, page: minor } = await anonymousPage(browser)
  try {
    await gotoHydrated(minor, linkUrl)
    await expect(
      minor.getByText("Ya tienes tu registro en la clínica. Aquí puedes registrar a tu hijo o a un familiar."),
    ).toBeVisible()
    await expect(minor.getByLabel("¿Quién completa el registro?")).toHaveCount(0)
    const minorName = `Menor Enlace ${org.slug}`
    await fillPatientNames(minor, minorName)
    await minor.getByLabel("Fecha de nacimiento").fill("2018-06-15")
    await minor.getByRole("button", { name: "Siguiente", exact: true }).click()
    // El responsable se pide en "Contacto y filiación" cuando el paciente es menor.
    await minor.getByLabel("Nombre del responsable").fill(`Madre Enlace ${org.slug}`)
    await minor.getByLabel("Detalle de la relación").fill("Madre")
    // El representante legal de un menor se identifica con su documento.
    await minor.getByLabel("Documento del representante", { exact: true }).fill("41526374")
    await minor.getByLabel(/^Teléfono del responsable(?: \*)?$/).fill(phoneFromId(nextEventId()))
    await minor.getByLabel(/^Teléfono(?: \*)?$/).fill(phoneFromId(nextEventId()))
    await minor.getByRole("button", { name: "Siguiente", exact: true }).click()
    await minor.getByRole("button", { name: "Siguiente", exact: true }).click()
    await minor.getByRole("checkbox", { name: /Autorizo el tratamiento de mis datos/ }).check()
    await minor.getByRole("button", { name: "Enviar registro", exact: true }).click()

    await expect(minor.getByText("Paciente registrado", { exact: true })).toBeVisible()
    await minor.screenshot({ path: testInfo.outputPath("registro-contextual.png") })
    await expect(minor.locator('a[href*="/patients/"]')).toHaveCount(0)
  } finally {
    await minorContext.close()
  }

  const minorRow = await findPatientByName(page, org.slug, `Menor Enlace ${org.slug}`)
  const minorDetail = await getPatientDetail(page, org.slug, minorRow.id)
  // El tutor conserva su vínculo; el menor recibe su propia persona.
  expect(minorDetail.contacts).toHaveLength(2)
  expect(minorDetail.contacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ contactId, relationship: "guardian" }),
      expect.objectContaining({ relationship: "self" }),
    ]),
  )
  expect(minorDetail.registration).toMatchObject({
    respondent: "representative",
    conversationId,
    contextContactId: contactId,
  })
  expect(minorDetail.registration?.answers.representative).toMatchObject({
    displayName: `Madre Enlace ${org.slug}`,
    relationship: "guardian",
    relationshipDetail: "Madre",
  })
  const contactDetail = await call<{ patients: { id: string; relationship: string }[] }>(
    page,
    "GET",
    `/api/contacts/${contactId}`,
    org.slug,
  )
  expect(
    contactDetail.patients.filter((entry) => entry.relationship === "self"),
  ).toHaveLength(1)
  expect(contactDetail.patients).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: selfPatient.id, relationship: "self" }),
      expect.objectContaining({ id: minorRow.id, relationship: "guardian" }),
    ]),
  )

  // Enlace consumido: en otra sesión anónima ya no está disponible, sin prefills.
  const { context: goneContext, page: gone } = await anonymousPage(browser)
  try {
    await gotoHydrated(gone, linkUrl)
    await expect(gone.getByText("Enlace no disponible", { exact: true }).first()).toBeVisible()
    await expect(gone.getByLabel(/^Primer apellido/)).toHaveCount(0)
  } finally {
    await goneContext.close()
  }
})

test("vista previa de configuración no crea pacientes", async ({ createOwner }) => {
  const owner = await createOwner("qr-previa")
  const { page, org } = owner
  await gotoHydrated(page, tenant(org.slug, "/settings/patient-registration"))
  await expect(page.getByRole("button", { name: "Vista previa", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Vista previa", exact: true }).click()
  const dialog = surface(page, { name: "Vista previa del formulario" })
  await expect(dialog).toBeVisible()
  // Datos ficticios en memoria: avanzar hasta finalizar sin POST.
  await dialog.getByRole("button", { name: "Siguiente", exact: true }).click()
  await dialog.getByRole("button", { name: "Siguiente", exact: true }).click()
  await dialog.getByRole("button", { name: "Siguiente", exact: true }).click()
  await dialog.getByRole("button", { name: "Finalizar vista previa", exact: true }).click()
  await expect(dialog.getByText("Vista previa: no se guardaron datos")).toBeVisible()
  // El «Cerrar» del pie; la equis del diálogo también se llama «Cerrar».
  await dialog.getByRole("button", { name: "Cerrar", exact: true }).first().click()

  expect(await call<unknown[]>(page, "GET", "/api/patients", org.slug)).toEqual([])
})

test("reserva por enlace: quien recién se contacta elige su hora, deja sus datos esenciales en una pantalla y queda reservado", async ({
  owner,
  browser,
  nextEventId,
  fixtureDb,
}, info) => {
  const { page, org } = owner
  // La clínica tiene activo su registro de pacientes: de ahí salen los datos que se piden y el aviso de privacidad.
  await publishConfig(page, org.slug)
  await call(page, "POST", "/api/agenda/chairs", org.slug, { branchId: owner.branchId, name: "Sillón 1" }, 201)
  await call(page, "PUT", "/api/agenda/schedules", org.slug, {
    branchId: owner.branchId,
    dentistUserId: owner.user.id,
    rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 7 * 60, endMin: 22 * 60 })),
  }, 200)
  const tgConn = await call<{ id: string; webhookSecret: string }>(page, "POST", "/api/channels/connections", org.slug, {
    channel: "telegram", provider: "telegram_bot_api", displayName: "Bot E2E", config: { botToken: "e2e" },
  }, 201)
  const tgUser = nextEventId()
  expect(await simulateTelegramInbound(page, API, tgConn.id, tgConn.webhookSecret, { fromId: tgUser, chatId: tgUser, text: "Hola, quiero una cita", updateId: nextEventId() })).toBe(200)
  await expect
    .poll(async () => (await call<{ connection: { id: string } }[]>(page, "GET", "/api/conversations", org.slug)).some((c) => c.connection.id === tgConn.id), { timeout: 30_000 })
    .toBe(true)
  const conversation = (await call<{ id: string; contact: { id: string }; connection: { id: string } }[]>(page, "GET", "/api/conversations", org.slug)).find((c) => c.connection.id === tgConn.id)!

  // El enlace que entrega el agente a alguien que aún no es paciente: nace sin ficha.
  const token = randomBytes(32).toString("hex")
  await fixtureDb.insert(appointmentBookingLink).values({
    organizationId: org.id,
    conversationId: conversation.id,
    contactId: conversation.contact.id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 3_600_000),
  })

  const { context, page: anon } = await anonymousPage(browser, { width: 390, height: 844 })
  try {
    await gotoHydrated(anon, tenant(org.slug, `/reserva?token=${token}`))
    await expect(anon.getByRole("heading", { name: "Elige tu cita" })).toBeVisible()
    // Tres pasos: elegir, sus datos y listo.
    await expect(anon.getByText(/paso 1 de 3/)).toBeVisible()
    // La semana siguiente siempre tiene horarios: la de hoy depende del día y la hora en que corre la prueba.
    await anon.getByRole("button", { name: "Semana siguiente", exact: true }).click()
    await anon.getByRole("group", { name: /Mañana|Tarde/ }).first().getByRole("button").first().click()
    await anon.getByRole("button", { name: "Continuar con mis datos" }).click()

    await expect(anon.getByRole("heading", { name: "Tus datos" })).toBeVisible()
    await expect(anon.getByText(/paso 2 de 3/)).toBeVisible()
    await expect(anon.getByRole("button", { name: "Cambiar horario" })).toBeVisible()
    expect(await anon.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    // Una sola pantalla: sin los pasos del registro completo ni lo que se completa en la clínica.
    await expect(anon.getByRole("button", { name: "Siguiente", exact: true })).toHaveCount(0)
    await expect(anon.getByLabel("Fecha de nacimiento")).toHaveCount(0)
    // Escribe por Telegram: no se le supone un celular ni se dice que es «el número desde el que nos escribes».
    const phone = anon.getByLabel("Celular", { exact: true })
    await expect(phone).toHaveValue("")
    await expect(anon.getByText(/número desde el que nos escribes/)).toHaveCount(0)
    const submit = anon.getByRole("button", { name: "Reservar mi cita" })
    await expect(submit).toBeInViewport()
    await info.attach("reserva-tus-datos", { body: await anon.screenshot({ fullPage: true }), contentType: "image/png" })

    // Errores por campo, y lo escrito se conserva.
    await anon.getByLabel("Nombres", { exact: true }).fill("Carla")
    await anon.getByLabel("Número", { exact: true }).fill("123")
    await submit.click()
    await expect(anon.getByText("Escribe tus apellidos")).toBeVisible()
    await expect(anon.getByText("El DNI tiene exactamente 8 dígitos")).toBeVisible()
    await expect(anon.getByText("Escribe un celular para avisarte de tu cita")).toBeVisible()
    await expect(anon.getByText("Para reservar necesitamos que aceptes el uso de estos datos")).toBeVisible()
    await expect(anon.getByLabel("Nombres", { exact: true })).toHaveValue("Carla")
    await expect(anon.getByLabel("Apellidos", { exact: true })).toBeFocused()
    expect(await anon.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    await info.attach("reserva-tus-datos-errores", { body: await anon.screenshot({ fullPage: true }), contentType: "image/png" })

    // Para otra persona pide, en la misma pantalla, solo lo que el registro exige de ella.
    await anon.getByRole("radio", { name: "Para otra persona" }).click()
    await expect(anon.getByRole("group", { name: "La persona que se va a atender" })).toBeVisible()
    await expect(anon.getByLabel("Fecha de nacimiento")).toBeVisible()
    expect(await anon.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    await info.attach("reserva-tus-datos-otra-persona", { body: await anon.screenshot({ fullPage: true }), contentType: "image/png" })
    await anon.getByRole("radio", { name: "Para mí" }).click()
    await expect(anon.getByLabel("Fecha de nacimiento")).toHaveCount(0)

    await anon.getByLabel("Apellidos", { exact: true }).fill("Núñez Prado")
    await anon.getByLabel("Número", { exact: true }).fill(docFromId(nextEventId()))
    await phone.fill(maskedPhone(phoneFromId(nextEventId())))
    // El aviso de privacidad es el del registro de la clínica.
    await anon.getByRole("button", { name: "Ver el aviso de privacidad" }).click()
    await expect(anon.getByRole("dialog", { name: "Aviso de privacidad" }).getByText(PRIVACY)).toBeVisible()
    await anon.keyboard.press("Escape")
    await anon.getByRole("checkbox", { name: /Acepto que la clínica use estos datos/ }).click()
    // Volver a cambiar de horario no borra lo escrito.
    await anon.getByRole("button", { name: "Cambiar horario" }).click()
    await anon.getByRole("button", { name: "Continuar con mis datos" }).click()
    await expect(anon.getByLabel("Apellidos", { exact: true })).toHaveValue("Núñez Prado")
    await anon.getByRole("button", { name: "Reservar mi cita" }).click()

    // Con sus datos guardados, la página reserva el horario que ya había elegido.
    await expect(anon.getByRole("heading", { name: "Tu cita quedó reservada" })).toBeVisible({ timeout: 20_000 })
    await info.attach("reserva-nuevo-lista", { body: await anon.screenshot({ fullPage: false }), contentType: "image/png" })
  } finally {
    await context.close()
  }

  // La ficha la creó el registro, vinculada a esa persona, y la cita quedó en la agenda con su origen.
  const rows = await fixtureDb.select().from(appointment).where(eq(appointment.conversationId, conversation.id))
  expect(rows.map((row) => [row.status, row.source])).toEqual([["programada", "enlace"]])
  const linked = await fixtureDb.select({ patientId: patientContact.patientId, relationship: patientContact.relationship }).from(patientContact).where(eq(patientContact.contactId, conversation.contact.id))
  expect(linked).toEqual([{ patientId: rows[0]!.patientId, relationship: "self" }])

  // Recepción ve en su página que quedó con lo esencial: faltan datos para atenderla.
  const detail = await getPatientDetail(page, org.slug, rows[0]!.patientId)
  expect(detail.patient).toMatchObject({ displayName: "Carla Núñez Prado", birthDate: null, identityNeedsReview: true })
  await gotoHydrated(page, tenant(org.slug, `/patients/${rows[0]!.patientId}`))
  await expect(page.getByText("Faltan datos para atenderla").first()).toBeVisible()
  await info.attach("reserva-ficha-incompleta", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
})
