import { createHash, randomBytes } from "node:crypto"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { patientContact } from "@odentia/db/schema/clinical"
import { crmTask } from "@odentia/db/schema/crm"
import type { Browser, Locator, Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateTelegramInbound } from "./channels"
import { API, PANEL, tenant } from "./env"
import { call, chooseOption, expect, fillPatientNames, test, writtenDate } from "./fixtures"
import { gotoHydrated } from "./hydration"

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

/**
 * El registro es un cuestionario de una pantalla por tema: avanza hasta que
 * `target` está a la vista. Lo opcional se salta y la salud, si aparece sin
 * contestar, se responde «No»; con una respuesta puesta se sigue con
 * «Siguiente», porque «Saltar» la borraría.
 */
async function advanceTo(page: Page, target: Locator) {
  const progress = page.getByText(/^Paso \d+ de \d+$/)
  for (let step = 0; step < 12 && !(await target.isVisible()); step += 1) {
    for (const question of [/alérgic/, /alguna enfermedad/, /medicamento todos los días/]) {
      const group = page.getByRole("group", { name: question }).first()
      if ((await group.isVisible()) && (await group.locator('[aria-pressed="true"]').count()) === 0)
        await group.getByRole("button", { name: "No", exact: true }).click()
    }
    const before = await progress.textContent()
    const skip = page.getByRole("button", { name: "Saltar", exact: true })
    await ((await skip.isVisible()) ? skip : page.getByRole("button", { name: "Siguiente", exact: true })).click()
    await expect(progress).not.toHaveText(before ?? "")
  }
  await expect(target).toBeVisible()
}

/** Primera pantalla: el registro es para quien lo llena. */
async function forMe(page: Page) {
  await page.getByRole("radio", { name: "Para mí" }).click()
  await advanceTo(page, page.getByLabel(/^Nombres/))
}

/** «Tus datos»: adulto con nombre y nacimiento. */
async function fillAdultDatos(page: Page, input: { name: string; birthDate: string }) {
  await fillPatientNames(page, input.name)
  // Se escribe en el orden de la clínica (día/mes/año en Perú); se guarda en ISO.
  await page.getByLabel("Fecha de nacimiento").fill(writtenDate(input.birthDate))
}

/** «¿Cómo te contactamos?»: el celular, con el país de la clínica ya elegido. */
function ownPhone(page: Page) {
  return page.getByRole("textbox", { name: /^Tu celular/ })
}

async function fillContacto(page: Page, phone: string) {
  await advanceTo(page, ownPhone(page))
  await ownPhone(page).fill(maskedPhone(phone))
}

/** «Tu salud»: alérgico a la penicilina, «No sé» en enfermedades, «No» en medicamentos y O+. */
async function fillSalud(page: Page) {
  const allergies = page.getByRole("group", { name: /alérgic/ }).first()
  await advanceTo(page, allergies)
  await allergies.getByRole("button", { name: "Sí", exact: true }).click()
  await page.getByLabel(/^¿A qué\?/).fill("Penicilina")
  await page.getByRole("group", { name: /alguna enfermedad/ }).first().getByRole("button", { name: "No sé", exact: true }).click()
  await page.getByRole("group", { name: /medicamento todos los días/ }).first().getByRole("button", { name: "No", exact: true }).click()
  await chooseOption(page.getByRole("combobox", { name: "Grupo sanguíneo" }), { label: "O+" })
  const before = await page.getByText(/^Paso \d+ de \d+$/).textContent()
  await page.getByRole("button", { name: "Siguiente", exact: true }).click()
  await expect(page.getByText(/^Paso \d+ de \d+$/)).not.toHaveText(before ?? "")
}

/** «Antes de enviar»: acepta el aviso y envía. */
function privacyBox(page: Page) {
  return page.getByRole("checkbox", { name: /Autorizo el tratamiento de mis datos/ })
}

async function acceptAndSubmit(page: Page) {
  await advanceTo(page, privacyBox(page))
  await privacyBox(page).check()
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
  fixtureDb,
  nextEventId,
}) => {
  const owner = await createOwner("qr-desk")
  const { page, org } = owner
  await publishConfig(page, org.slug)
  // Un contacto previo con su celular: un registro por QR con ese número no lo reclama.
  const sharedPhone = phoneFromId(nextEventId())
  const ownNumber = phoneFromId(nextEventId())
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
    await expect(anon.getByRole("heading", { level: 1, name: org.name })).toBeVisible()
    await expect(anon.getByText("Registro de paciente", { exact: true })).toBeVisible()

    await forMe(anon)
    await fillAdultDatos(anon, { name: patientName, birthDate: "1990-04-11" })
    await fillContacto(anon, ownNumber)
    // Volver hasta «Tus datos» conserva el nombre, y reavanzar conserva el celular.
    const names = anon.getByLabel(/^Nombres/)
    for (let step = 0; step < 6 && !(await names.isVisible()); step += 1)
      await anon.getByRole("button", { name: "Anterior", exact: true }).click()
    await expect(names).toHaveValue(patientName.split(" ")[0] ?? "")
    await advanceTo(anon, ownPhone(anon))
    await expect(ownPhone(anon)).toHaveValue(maskedPhone(ownNumber))

    await fillSalud(anon)
    await acceptAndSubmit(anon)

    await expect(anon.getByRole("heading", { name: "Registro recibido" })).toBeVisible({ timeout: 20_000 })
    await expect(anon.getByText(new RegExp(`${org.name} ya tiene tus datos`))).toBeVisible()
    // Éxito sin sesión: no expone ficha, número clínico ni edición.
    await expect(anon).toHaveURL(/\/registro/)
    await expect(anon.locator('a[href*="/patients/"]')).toHaveCount(0)
    await expect(anon.getByText(/HC-\d{6}/)).toHaveCount(0)
  } finally {
    await anonContext.close()
  }

  // Todo paciente es una persona: la del registro es nueva.
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
    // El registro no pregunta la gravedad: queda «desconocida» hasta que la revise quien atiende.
    items: [{ substance: "Penicilina", severity: "desconocida" }],
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
      expect.objectContaining({ substance: "Penicilina", severity: "desconocida" }),
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
    page.getByLabel("Alertas clínicas").getByText(/^Alergia: Penicilina/),
  ).toBeVisible()

  // Con el celular de alguien que ya está, el QR no crea a nadie ni toca su ficha:
  // responde como siempre (sin decir de quién era) y deja a recepción decidir si es ella.
  const heldName = `Otra Persona ${org.slug}`
  const { context: heldContext, page: held } = await anonymousPage(browser)
  try {
    await gotoHydrated(held, tenant(org.slug, "/registro?via=qr"))
    await forMe(held)
    await fillAdultDatos(held, { name: heldName, birthDate: "1991-05-12" })
    await fillContacto(held, sharedPhone)
    await acceptAndSubmit(held)
    await expect(held.getByRole("heading", { name: "Registro recibido" })).toBeVisible({ timeout: 20_000 })
    await expect(held.getByText("Contacto Previo")).toHaveCount(0)
  } finally {
    await heldContext.close()
  }
  const sameName = await call<PatientListItem[]>(page, "GET", `/api/patients?q=${encodeURIComponent(heldName)}`, org.slug)
  expect(sameName.filter((item) => item.displayName === heldName)).toEqual([])
  const tasks = await fixtureDb
    .select({ title: crmTask.title, kind: crmTask.kind, status: crmTask.status })
    .from(crmTask)
    .where(and(eq(crmTask.organizationId, org.id), eq(crmTask.contactId, contactId)))
  expect(tasks).toEqual([
    { title: "Se registró por el código QR: ¿es Contacto Previo?", kind: "registro_con_documento", status: "open" },
  ])
  const stillUntouched = await call<{ patients: unknown[] }>(page, "GET", `/api/contacts/${contactId}`, org.slug)
  expect(stillUntouched.patients).toEqual([])
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
    await forMe(anon)
    await fillAdultDatos(anon, { name: patientName, birthDate: "1988-11-02" })
    await fillContacto(anon, phone)
    await fillSalud(anon)
    await acceptAndSubmit(anon)

    await expect(anon.getByRole("heading", { name: "Registro recibido" })).toBeVisible({ timeout: 20_000 })
    await expect(anon.getByText(new RegExp(`${org.name} ya tiene tus datos`))).toBeVisible()
    // En el celular nada se sale de la pantalla.
    expect(await anon.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
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
    await forMe(anon)
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
      anon.getByText("La clínica cambió el registro: revisa tus respuestas y vuelve a enviar."),
    ).toBeVisible()
    await refetched
    // Sin éxito, sin reintento automático y con el borrador intacto.
    await expect(anon.getByRole("heading", { name: "Registro recibido" })).toHaveCount(0)
    expect(publicPosts).toBe(1)
    await expect(anon.getByText(/rev\. 2/)).toBeVisible()
    await expect(
      anon.getByRole("checkbox", { name: /Autorizo el tratamiento de mis datos/ }),
    ).toBeChecked()
    // La declaración de salud se conserva al retroceder.
    const allergies = anon.getByRole("group", { name: /alérgic/ }).first()
    for (let step = 0; step < 6 && !(await allergies.isVisible()); step += 1)
      await anon.getByRole("button", { name: "Anterior", exact: true }).click()
    await expect(allergies.getByRole("button", { name: "Sí", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(anon.getByLabel(/^¿A qué\?/)).toHaveValue("Penicilina")
    // El segundo envío es manual y usa la versión vigente.
    await acceptAndSubmit(anon)
    await expect(anon.getByRole("heading", { name: "Registro recibido" })).toBeVisible({ timeout: 20_000 })
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
      minor.getByText("Ya tienes tu registro en la clínica. Aquí registras a tu hijo o a un familiar."),
    ).toBeVisible()
    // Empieza en los datos de quien se atenderá: no se le pregunta para quién es.
    await expect(minor.getByText("Datos de quien se atenderá", { exact: true })).toBeVisible()
    await expect(minor.getByRole("radio", { name: "Para mí" })).toHaveCount(0)
    const minorName = `Menor Enlace ${org.slug}`
    await fillPatientNames(minor, minorName)
    await minor.getByLabel("Fecha de nacimiento").fill("15/06/2018")
    // Quien registra a un menor queda como su representante: nombre, relación, celular y documento.
    const repName = minor.getByLabel("Tu nombre y apellidos")
    await advanceTo(minor, repName)
    await repName.fill(`Madre Enlace ${org.slug}`)
    await minor.getByRole("button", { name: "Madre, padre o tutor", exact: true }).click()
    await minor.getByRole("textbox", { name: /^Tu celular/ }).fill(maskedPhone(phoneFromId(nextEventId())))
    await minor.getByLabel(/^Tu DNI/).fill("41526374")
    const before = await minor.getByText(/^Paso \d+ de \d+$/).textContent()
    await minor.getByRole("button", { name: "Siguiente", exact: true }).click()
    await expect(minor.getByText(/^Paso \d+ de \d+$/)).not.toHaveText(before ?? "")
    await acceptAndSubmit(minor)

    await expect(minor.getByRole("heading", { name: "Registro recibido" })).toBeVisible({ timeout: 20_000 })
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
    relationshipDetail: "Madre, padre o tutor",
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
    await expect(gone.getByLabel(/^Apellidos/)).toHaveCount(0)
  } finally {
    await goneContext.close()
  }
})

test("vista previa de configuración no crea pacientes", async ({ createOwner }) => {
  const owner = await createOwner("qr-previa")
  const { page, org } = owner
  let posts = 0
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/(public\/)?patient/.test(request.url())) posts += 1
  })
  await gotoHydrated(page, tenant(org.slug, "/settings/patient-registration"))
  // La vista previa está siempre al lado, como la verá el paciente, y no guarda nada.
  const preview = page.getByRole("complementary", { name: "Así lo ve el paciente" })
  await expect(preview).toBeVisible()
  await preview.getByRole("radio", { name: "Para mí" }).click()
  await advanceTo(page, preview.getByLabel(/^Nombres/))
  await fillAdultDatos(page, { name: "Vista Previa", birthDate: "1990-01-01" })
  await fillContacto(page, phoneFromId(1))
  await acceptAndSubmit(page)
  await expect(preview.getByText("Vista previa: no se guardaron datos.")).toBeVisible()
  await expect(preview.getByRole("button", { name: "Volver a la vista previa" })).toBeVisible()
  expect(posts).toBe(0)

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
  await call(page, "POST", "/api/agenda/rooms", org.slug, { branchId: owner.branchId, name: "Unidad dental 1" }, 201)
  await call(page, "PUT", "/api/agenda/schedules", org.slug, {
    branchId: owner.branchId,
    professionalUserId: owner.user.id,
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
    await expect(anon.getByText("El DNI tiene 8 números; faltan 5")).toBeVisible()
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
  expect(detail.patient).toMatchObject({ displayName: "Carla Núñez Prado", birthDate: null, identityNeedsReview: false })
  await gotoHydrated(page, tenant(org.slug, `/patients/${rows[0]!.patientId}`))
  await expect(page.getByText("Faltan datos para atenderla").first()).toBeVisible()
  await info.attach("reserva-ficha-incompleta", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
})
