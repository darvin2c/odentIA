process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { branch } from "@odentia/db/schema/org"
import { organizationPaymentMethod } from "@odentia/db/schema/org-payments"
import { createRoom, secretsKeyFromEnv, setProfessionalSchedule } from "@odentia/services"
import { createHash } from "node:crypto"
import { encodeDemoDicom } from "@odentia/clinical"
import sharp from "sharp"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createClinicalFormsRoute } from "./clinical-forms.js"
import { createContactsRoute } from "./contacts.js"
import type { CrmDeps } from "./helpers.js"
import { createPatientsRoute } from "./patients.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("cc".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

/** Bytes subidos por clave (para verificar la huella del PDF). */
const storedBytes = new Map<string, Uint8Array>()

/** Storage de prueba: firma claves sintéticas, nunca toca S3. */
const storageStub = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no usado")
  },
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  getAttachment: async (key: string) => {
    const bytes = storedBytes.get(key)
    if (!bytes) throw new Error("No existe")
    return bytes
  },
  deleteAttachment: async () => {},
  putPatientDocument: async ({
    orgId,
    patientId,
    bytes,
    contentType,
    ext,
  }: {
    orgId: string
    patientId: string
    bytes: Uint8Array
    contentType: string
    ext: string
  }) => {
    const objectKey = `patients/${orgId}/${patientId}/docs/${crypto.randomUUID()}.${ext}`
    storedBytes.set(objectKey, bytes)
    return { objectKey, mimeType: contentType, filename: `documento.${ext}`, size: bytes.byteLength }
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

function stubOrg(role: string, orgId: string) {
  return async (c: Context, next: Next) => {
    c.set("orgId", orgId)
    c.set("userId", "u-1")
    c.set("memberRole", role)
    await next()
  }
}

function buildApp(role: string, orgId = "org_a"): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", stubOrg(role, orgId))
  app.route("/patients", createPatientsRoute(deps))
  app.route("/contacts", createContactsRoute(deps))
  app.route("/clinical-forms", createClinicalFormsRoute(deps))
  return app
}

let app: Hono

interface ErrorBody {
  error: { code: string; message: string }
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

function post(appRef: Hono, path: string, body?: unknown) {
  return appRef.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function patch(appRef: Hono, path: string, body: unknown) {
  return appRef.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function createPatient(): Promise<string> {
  const response = await post(app, "/patients", {
    submissionId: crypto.randomUUID(),
    answers: {
      demographics: { displayName: `Paciente ${crypto.randomUUID().slice(0, 8)}` },
      respondent: "staff",
      privacyAccepted: false,
    },
  })
  expect(response.status).toBe(201)
  return (await json<{ data: { id: string } }>(response)).data.id
}

/** Contacto vinculado al paciente (guardián) para responsables y pagos. */
async function linkContact(patientId: string): Promise<string> {
  const created = await post(app, "/contacts", { displayName: "Representante" })
  expect(created.status).toBe(201)
  const contactId = (await json<{ data: { id: string } }>(created)).data.id
  const linked = await app.request(`/patients/${patientId}/contacts/${contactId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      relationship: "guardian",
      relationshipDetail: "Madre",
      isPreferred: true,
    }),
  })
  expect(linked.status).toBe(200)
  return contactId
}

async function createEncounter(patientId: string, reason: string): Promise<string> {
  const created = await post(app, `/patients/${patientId}/encounters`, { reason })
  expect(created.status).toBe(201)
  return (await json<{ data: { id: string } }>(created)).data.id
}

async function finalizeEncounter(patientId: string, encounterId: string): Promise<void> {
  // El cierre exige diagnóstico CIE-10 con tipo y evolución (ADR 0003).
  const dx = await post(app, `/patients/${patientId}/encounters/${encounterId}/diagnoses`, {
    diagnosisCode: "K02.1",
    diagnosisType: "confirmed",
  })
  expect(dx.status).toBe(201)
  const proc = await post(app, `/patients/${patientId}/encounters/${encounterId}/procedures`, {
    description: "Acto de cierre",
  })
  expect(proc.status).toBe(201)
  const patched = await patch(app, `/patients/${patientId}/encounters/${encounterId}`, {
    evolution: "Evolución de cierre",
  })
  expect(patched.status).toBe(200)
  const finalized = await post(app, `/patients/${patientId}/encounters/${encounterId}/finalize`)
  expect(finalized.status).toBe(200)
}

interface AcceptedItem {
  patientId: string
  encounterId: string
  planId: string
  itemId: string
  budgetId: string
  budgetItemId: string
}

/** Paciente con una indicación aceptada, presupuesto aceptado y línea vigente. */
async function setupAcceptedItem(): Promise<AcceptedItem> {
  const patientId = await createPatient()
  const encounterId = await createEncounter(patientId, "Evaluación")
  const planResponse = await post(app, `/patients/${patientId}/plans`, {
    title: "Plan de prueba",
    originEncounterId: encounterId,
  })
  expect(planResponse.status).toBe(201)
  const planId = (await json<{ data: { id: string } }>(planResponse)).data.id
  const itemResponse = await post(app, `/patients/${patientId}/plan/items`, {
    planId,
    serviceId: "c1111111-1111-4111-8111-111111111111",
    sourceEncounterId: encounterId,
    toothNumber: 36,
  })
  expect(itemResponse.status).toBe(201)
  const itemId = (await json<{ data: { id: string } }>(itemResponse)).data.id
  const budgetResponse = await post(app, `/patients/${patientId}/budgets`, {
    planId,
    itemIds: [itemId],
    title: "Propuesta",
  })
  expect(budgetResponse.status).toBe(201)
  const budgetId = (await json<{ data: { id: string } }>(budgetResponse)).data.id
  expect((await post(app, `/patients/${patientId}/budgets/${budgetId}/deliver`)).status).toBe(200)
  const detail = await app.request(`/patients/${patientId}/budgets/${budgetId}`)
  const lines = (await json<{ data: { items: Array<{ id: string; planItemId: string }> } }>(detail))
    .data.items
  expect(lines).toHaveLength(1)
  const line = lines[0]
  if (!line) throw new Error("La propuesta presentada no tiene líneas")
  const decided = await post(app, `/patients/${patientId}/budgets/${budgetId}/decision`, {
    decisions: [{ planItemId: itemId, decision: "aceptado" }],
  })
  expect(decided.status).toBe(200)
  return { patientId, encounterId, planId, itemId, budgetId, budgetItemId: line.id }
}

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: "dentalagent_app",
    })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_cron",
      "-c",
      "cron.database_name=dentalagent",
    ])
    .start()
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(uri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(
    `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`,
  )
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_b', 'Clínica Sur', 'sur', now())`,
  )
  // Toda clínica real tiene su perfil regional: sin él no se registra dinero.
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values ('org_a', 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE'), ('org_b', 'Clínica Sur', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values ('u-1', 'Doctora', 'doc@test.dev') on conflict do nothing`,
  )
  // La doctora de las pruebas es miembro con colegiatura: puede firmar cierres.
  await ownerDb.execute(
    sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values ('m-u1-a', 'org_a', 'u-1', 'clinician', now()) on conflict do nothing`,
  )
  await ownerDb.execute(
    sql`insert into "professional_profile" ("organization_id", "user_id", "professional_title", "registration_body", "registration_number") values ('org_a', 'u-1', 'Cirujano dentista', 'COP', '12345') on conflict do nothing`,
  )
  await ownerDb.execute(
    sql`with "release" as (
      insert into "diagnosis_code_release" ("system_key", "edition", "official", "license", "code_count")
      values ('ICD-10', 'prueba', false, 'Solo pruebas', 0) on conflict do nothing
    )
    insert into "diagnosis_code" ("system_key", "code", "edition", "title", "is_dental", "search_text")
    select 'ICD-10', v.code, 'prueba', v.title, v.code like 'K%', lower(v.code || ' ' || replace(v.code, '.', '') || ' ' || v.title)
    from (values ('K02.1', 'Caries de la dentina')) as v(code, title)
    on conflict do nothing`,
  )
  await ownerDb.execute(
    sql`insert into "service_catalog" ("id", "organization_id", "source", "code", "name", "scope", "price_cents", "currency", "duration_min", "is_active") values
        ('c1111111-1111-4111-8111-111111111111', 'org_a', 'custom', 'CORONA', 'Corona cerámica', 'tooth', 90000, 'PEN', 60, true),
        ('d5555555-5555-4555-8555-555555555555', 'org_b', 'custom', 'OTRO', 'Otro servicio', 'tooth', 999, 'PEN', 15, true)
        on conflict ("id") do nothing`,
  )
  app = buildApp("owner")
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("controles: alta, programación, cierre contra atención finalizada y cancelación", async () => {
  const { patientId, encounterId, itemId } = await setupAcceptedItem()
  const created = await post(app, `/patients/${patientId}/follow-ups`, {
    kind: "tratamiento",
    planItemId: itemId,
    title: "Control post-tratamiento",
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    originEncounterId: encounterId,
  })
  expect(created.status).toBe(201)
  const followUpId = (await json<{ data: { id: string } }>(created)).data.id

  // El tipo de control y la fecha son validados por el contrato.
  const invalid = await post(app, `/patients/${patientId}/follow-ups`, {
    kind: "otro",
    title: "Control",
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  })
  expect(invalid.status).toBe(400)
  expect((await json<ErrorBody>(invalid)).error.code).toBe("VALIDATION")

  // Completar exige una atención finalizada: el borrador no basta.
  const premature = await post(app, `/patients/${patientId}/follow-ups/${followUpId}/complete`, {
    encounterId,
    outcome: "Sin hallazgos",
  })
  expect(premature.status).toBe(409)
  expect((await json<ErrorBody>(premature)).error.code).toBe("ENCOUNTER_NOT_FINALIZED")

  await ownerDb.execute(
    sql`insert into member (id, organization_id, user_id, role, created_at) values ('control-member', 'org_a', 'u-1', 'owner', now()) on conflict do nothing`,
  )
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede controles", timezone: "America/Lima" })
    .returning()
  const room = await withOrgContext(appDb, "org_a", (tx) =>
    createRoom(tx, "org_a", { branchId: site.id, name: "Control" }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    setProfessionalSchedule(tx, "org_a", "u-1", {
      branchId: site.id,
      professionalUserId: "u-1",
      rules: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        startMin: 8 * 60,
        endMin: 20 * 60,
      })),
    }),
  )
  const startsAt = `${new Date(Date.now() + 172_800_000).toISOString().slice(0, 10)}T15:00:00Z`
  const denied = await post(
    buildApp("reception"),
    `/patients/${patientId}/follow-ups/${followUpId}/schedule`,
    {
      appointment: { roomId: room.id, professionalUserId: "u-1", startsAt },
    },
  )
  expect(denied.status).toBe(403)
  const scheduled = await post(app, `/patients/${patientId}/follow-ups/${followUpId}/schedule`, {
    appointment: { roomId: room.id, professionalUserId: "u-1", startsAt },
  })
  expect(scheduled.status).toBe(200)
  const programmed = (await json<{ data: { status: string; appointmentId: string } }>(scheduled))
    .data
  expect(programmed.status).toBe("programado")
  // Programar dos veces es una transición ilegal.
  const reschedule = await post(app, `/patients/${patientId}/follow-ups/${followUpId}/schedule`, {
    appointmentId: programmed.appointmentId,
  })
  expect(reschedule.status).toBe(409)

  await finalizeEncounter(patientId, encounterId)
  const completed = await post(app, `/patients/${patientId}/follow-ups/${followUpId}/complete`, {
    encounterId,
    outcome: "Oclusión estable",
  })
  expect(completed.status).toBe(200)
  expect(await json<{ data: { status: string; outcome: string } }>(completed)).toMatchObject({
    data: { status: "realizado", outcome: "Oclusión estable" },
  })
  const cancelAfterComplete = await post(
    app,
    `/patients/${patientId}/follow-ups/${followUpId}/cancel`,
    { reason: "Ya no aplica" },
  )
  expect(cancelAfterComplete.status).toBe(409)

  const list = await app.request(`/patients/${patientId}/follow-ups?status=realizado`)
  expect(list.status).toBe(200)
  expect(await json<{ data: unknown[] }>(list)).toMatchObject({ data: [expect.any(Object)] })

  // Otro tenant no ve ni puede tocar el control.
  const foreign = buildApp("owner", "org_b")
  const isolated = await foreign.request(`/patients/${patientId}/follow-ups`)
  expect(isolated.status).toBe(404)
})

it("recetas: emisión con medicamentos, detalle y anulación con motivo", async () => {
  const { patientId, encounterId, itemId } = await setupAcceptedItem()
  const created = await post(app, `/patients/${patientId}/prescriptions`, {
    encounterId,
    planItemId: itemId,
    notes: "Solo si hay dolor",
    items: [
      {
        genericName: "ibuprofeno",
        strength: "400 mg",
        dosageForm: "tableta",
        dose: "1 tableta",
        route: "oral",
        frequency: "Cada 8 horas",
        duration: "3 días",
        quantity: 9,
      },
      {
        genericName: "clorhexidina",
        strength: "0,12 %",
        dosageForm: "colutorio",
        dose: "15 mL",
        route: "bucal tópica",
        frequency: "Cada 12 horas",
        duration: "5 días",
      },
    ],
  })
  expect(created.status).toBe(201)
  const prescriptionId = (await json<{ data: { id: string; prescriptionNumber: number } }>(created))
    .data.id

  // El detalle conserva los medicamentos recetados.
  const detail = await app.request(`/patients/${patientId}/prescriptions/${prescriptionId}`)
  expect(detail.status).toBe(200)
  const body = await json<{ data: { items: Array<{ medicationName: string }> } }>(detail)
  expect(
    body.data.items.map((item) => item.medicationName).sort((a, b) => a.localeCompare(b, "es")),
  ).toEqual(["clorhexidina 0,12 % colutorio", "ibuprofeno 400 mg tableta"])

  // La hoja impresa lleva el prescriptor con su colegiatura y el paciente.
  const print = await app.request(`/patients/${patientId}/prescriptions/${prescriptionId}/print`)
  expect(print.status).toBe(200)
  const sheet = await json<{
    data: {
      prescription: { prescriberRegistration: string | null }
      patient: { patientNumber: number }
    }
  }>(print)
  expect(sheet.data.prescription.prescriberRegistration).toMatch(/^COP /)
  expect(sheet.data.patient.patientNumber).toBeGreaterThan(0)

  // Sin DCI la receta no se emite.
  const noDci = await post(app, `/patients/${patientId}/prescriptions`, {
    items: [
      {
        medicationName: "Ibuprofeno",
        dose: "1",
        route: "oral",
        frequency: "c/8h",
        duration: "2 días",
      },
    ],
  })
  expect(noDci.status).toBe(400)

  // Sin medicamentos la receta no existe.
  const empty = await post(app, `/patients/${patientId}/prescriptions`, { items: [] })
  expect(empty.status).toBe(400)

  const cancelled = await post(
    app,
    `/patients/${patientId}/prescriptions/${prescriptionId}/cancel`,
    { reason: "Alergia registrada" },
  )
  expect(cancelled.status).toBe(200)
  expect(await json<{ data: { status: string; cancelReason: string } }>(cancelled)).toMatchObject({
    data: { status: "anulada", cancelReason: "Alergia registrada" },
  })
  const again = await post(app, `/patients/${patientId}/prescriptions/${prescriptionId}/cancel`, {
    reason: "Otra vez",
  })
  expect(again.status).toBe(409)

  const missing = await app.request(
    `/patients/${patientId}/prescriptions/11111111-1111-4111-8111-111111111111`,
  )
  expect(missing.status).toBe(404)
})

it("cuenta: concepto manual, cobro parcial, anulación, devolución y límites", async () => {
  const { patientId } = await setupAcceptedItem()
  const contactId = await linkContact(patientId)
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede caja", timezone: "America/Lima" })
    .returning()
  const [cash] = await ownerDb
    .insert(organizationPaymentMethod)
    .values({ organizationId: "org_a", name: "Efectivo", typeCode: "10", isActive: true })
    .returning()
  const requestId = () => crypto.randomUUID()

  const charge = await post(app, `/patients/${patientId}/charges`, { planItemId: "x" })
  expect(charge.status).toBe(400)
  // Concepto manual sin moneda: la toma de la clínica.
  const manual = await post(app, `/patients/${patientId}/charges`, {
    description: "Cargo manual",
    amountCents: 5000,
  })
  expect(manual.status).toBe(201)
  const manualId = (await json<{ data: { id: string } }>(manual)).data.id

  // Cobro parcial en un paso: el resto queda por cobrar.
  const collected = await post(app, `/patients/${patientId}/collect`, {
    branchId: site.id,
    chargeIds: [manualId],
    payments: [{ paymentMethodId: cash.id, amountCents: 3000 }],
    payerContactId: contactId,
    requestId: requestId(),
  })
  expect(collected.status).toBe(201)
  const ticketId = (await json<{ data: { ticket: { id: string } } }>(collected)).data.ticket.id

  // Un concepto con cobros aplicados no se anula.
  const voidCharge = await post(app, `/patients/${patientId}/charges/${manualId}/void`, {
    reason: "Error de digitación",
  })
  expect(voidCharge.status).toBe(409)
  expect((await json<ErrorBody>(voidCharge)).error.code).toBe("CHARGE_HAS_APPLICATIONS")
  // Anular el cobro revierte todo en una acción y reabre el concepto.
  const voidTicket = await post(app, `/patients/${patientId}/tickets/${ticketId}/void`, {
    reason: "Importe mal digitado",
  })
  expect(voidTicket.status).toBe(200)
  expect(
    (await post(app, `/patients/${patientId}/charges/${manualId}/void`, { reason: "Duplicado" }))
      .status,
  ).toBe(200)

  // Monedas distintas no se mezclan en un cobro.
  const soles = await post(app, `/patients/${patientId}/charges`, {
    description: "Soles",
    amountCents: 10000,
  })
  const dollars = await post(app, `/patients/${patientId}/charges`, {
    description: "Dólares",
    amountCents: 5000,
    currency: "USD",
  })
  const solesId = (await json<{ data: { id: string } }>(soles)).data.id
  const dollarsId = (await json<{ data: { id: string } }>(dollars)).data.id
  const crossCurrency = await post(app, `/patients/${patientId}/collect`, {
    branchId: site.id,
    chargeIds: [solesId, dollarsId],
    payments: [{ paymentMethodId: cash.id, amountCents: 15000 }],
    requestId: requestId(),
  })
  expect(crossCurrency.status).toBe(409)
  expect((await json<ErrorBody>(crossCurrency)).error.code).toBe("CURRENCY_MISMATCH")

  // Devolver más del saldo a favor se rechaza; el monto disponible se acepta.
  const advance = await post(app, `/patients/${patientId}/collect`, {
    branchId: site.id,
    advanceCents: 40000,
    payments: [{ paymentMethodId: cash.id, amountCents: 40000 }],
    requestId: requestId(),
  })
  expect(advance.status).toBe(201)
  const refundOver = await post(app, `/patients/${patientId}/refunds`, {
    branchId: site.id,
    amountCents: 50000,
    reason: "Devolución excesiva",
  })
  expect(refundOver.status).toBe(409)
  expect((await json<ErrorBody>(refundOver)).error.code).toBe("INSUFFICIENT_CREDIT")
  const refund = await post(app, `/patients/${patientId}/refunds`, {
    branchId: site.id,
    amountCents: 10000,
    reason: "Ajuste acordado",
  })
  expect(refund.status).toBe(201)

  const account = await app.request(`/patients/${patientId}/account`)
  expect(account.status).toBe(200)
  const balances = await json<{
    data: { byCurrency: Array<{ currency: string; porCobrar: number; pagado: number; aFavor: number }> }
  }>(account)
  // Soles: 10000 por cobrar; 40000 cobrados menos 10000 devueltos.
  expect(balances.data.byCurrency.find((row) => row.currency === "PEN")).toMatchObject({
    porCobrar: 10000,
    pagado: 30000,
    aFavor: 30000,
  })
  expect(balances.data.byCurrency.find((row) => row.currency === "USD")).toMatchObject({
    porCobrar: 5000,
    pagado: 0,
    aFavor: 0,
  })
})

it("responsables: vigencia, duplicado y revocación con motivo", async () => {
  const { patientId } = await setupAcceptedItem()
  const contactId = await linkContact(patientId)
  // Hoy en la clínica (Lima): lo vigente se cuenta con su día, no con UTC.
  const startsAt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())

  const granted = await post(app, `/patients/${patientId}/responsibilities`, {
    contactId,
    kind: "representante_legal",
    startsAt,
  })
  expect(granted.status).toBe(201)
  const responsibilityId = (await json<{ data: { id: string } }>(granted)).data.id

  // El mismo rol vigente no se duplica.
  const duplicate = await post(app, `/patients/${patientId}/responsibilities`, {
    contactId,
    kind: "representante_legal",
    startsAt,
  })
  expect(duplicate.status).toBe(409)
  expect((await json<ErrorBody>(duplicate)).error.code).toBe("RESPONSIBILITY_EXISTS")

  // Un contacto no vinculado al paciente no puede recibir roles.
  const outsider = await post(app, `/patients/${patientId}/responsibilities`, {
    contactId: "99999999-9999-4999-8999-999999999999",
    kind: "autorizado_informacion",
    startsAt,
  })
  expect(outsider.status).toBe(404)

  // «Acompañante» ya no es una responsabilidad: quien solo acompaña es una
  // persona vinculada.
  const companion = await post(app, `/patients/${patientId}/responsibilities`, {
    contactId,
    kind: "acompanante",
    startsAt,
  })
  expect(companion.status).toBe(400)
  expect((await json<ErrorBody>(companion)).error.code).toBe("VALIDATION")

  const list = await app.request(`/patients/${patientId}/responsibilities`)
  const rows = await json<{ data: Array<{ isCurrent: boolean; contactId: string }> }>(list)
  expect(rows.data).toMatchObject([{ isCurrent: true, contactId }])

  const revoked = await post(
    app,
    `/patients/${patientId}/responsibilities/${responsibilityId}/revoke`,
    { reason: "Fin de la representación" },
  )
  expect(revoked.status).toBe(200)
  const reRevoke = await post(
    app,
    `/patients/${patientId}/responsibilities/${responsibilityId}/revoke`,
    { reason: "Otra vez" },
  )
  expect(reRevoke.status).toBe(409)
  const afterRevoke = await app.request(`/patients/${patientId}/responsibilities`)
  expect(await json<{ data: Array<{ isCurrent: boolean }> }>(afterRevoke)).toMatchObject({
    data: [{ isCurrent: false }],
  })
})

it("suspendido se reanuda; sin plan la indicación va al abierto y ya no hay alternativas", async () => {
  const { patientId, planId, itemId, encounterId } = await setupAcceptedItem()

  const suspended = await post(app, `/patients/${patientId}/treatments/${itemId}/suspend`, {
    reason: "Paciente viaja",
  })
  expect(suspended.status).toBe(200)
  expect((await json<{ data: { status: string } }>(suspended)).data.status).toBe("suspendido")

  // Reanudar devuelve el tratamiento al trabajo sin repetir la aceptación.
  const resumed = await post(app, `/patients/${patientId}/treatments/${itemId}/resume`, {
    status: "programado",
  })
  expect(resumed.status).toBe(200)
  expect(
    (await json<{ data: { status: string; statusReason: string | null } }>(resumed)).data,
  ).toMatchObject({ status: "programado", statusReason: null })
  const badResume = await post(app, `/patients/${patientId}/treatments/${itemId}/resume`, {
    status: "realizado",
  })
  expect(badResume.status).toBe(400)

  // Plan abierto implícito (ADR 0034): sin `planId`, la indicación va al plan abierto.
  const second = await post(app, `/patients/${patientId}/plan/items`, {
    serviceId: "c1111111-1111-4111-8111-111111111111",
    sourceEncounterId: encounterId,
    toothNumber: 46,
  })
  expect(second.status).toBe(201)
  expect((await json<{ data: { planId: string } }>(second)).data.planId).toBe(planId)

  // Las alternativas se retiraron: son opciones dentro del presupuesto (decisión 13).
  const group = await post(app, `/patients/${patientId}/plans/${planId}/option-groups`, {
    title: "Corona o resina",
  })
  expect(group.status).toBe(404)
  const grouped = await post(app, `/patients/${patientId}/treatments/${itemId}/alternative`, {
    optionGroupId: "11111111-1111-4111-8111-111111111111",
  })
  expect(grouped.status).toBe(404)
})

it("la historia declara el contexto de cada evento del recorrido", async () => {
  const { patientId, itemId } = await setupAcceptedItem()
  const charge = await post(app, `/patients/${patientId}/charges`, {
    description: "Cargo de historia",
    amountCents: 15000,
  })
  expect(charge.status).toBe(201)
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede historia", timezone: "America/Lima" })
    .returning()
  const [cash] = await ownerDb
    .insert(organizationPaymentMethod)
    .values({ organizationId: "org_a", name: "Efectivo", typeCode: "10", isActive: true })
    .returning()
  const collected = await post(app, `/patients/${patientId}/collect`, {
    branchId: site.id,
    payments: [{ paymentMethodId: cash.id, amountCents: 15000 }],
    requestId: crypto.randomUUID(),
  })
  expect(collected.status).toBe(201)

  const timeline = await app.request(`/patients/${patientId}/timeline?limit=100`)
  expect(timeline.status).toBe(200)
  const events = (
    await json<{
      data: Array<{
        type: string
        title: string
        detail?: string | null
        status?: string
        decision?: string | null
        refId: string
        planItemId?: string | null
        planId?: string | null
        budgetId?: string | null
        prescriptionId?: string | null
      }>
    }>(timeline)
  ).data

  // Un tratamiento y un presupuesto no pueden abrirse como anamnesis: llevan su referencia.
  const plan = events.find((e) => e.type === "plan")
  expect(plan).toMatchObject({ planItemId: itemId, refId: itemId, decision: "aceptado" })
  expect(plan?.detail).toContain("Pieza 36")
  const budget = events.find((e) => e.type === "budget")
  expect(budget?.budgetId).toBeTruthy()
  expect(budget?.planId).toBeTruthy()
  expect(budget?.title).toMatch(/Presupuesto N\.º/)
  // Los movimientos económicos no son historia clínica: no aparecen en la
  // línea de tiempo; se leen en la cuenta del paciente.
  expect(events.some((e) => e.type === "payment")).toBe(false)
  const account = await app.request(`/patients/${patientId}/account`)
  expect(account.status).toBe(200)
  const { data: accountData } = await json<{
    data: { cobros: Array<{ payments: Array<{ id: string; amountCents: number }> }> }
  }>(account)
  expect(accountData.cobros.flatMap((row) => row.payments).some((row) => row.amountCents === 15000)).toBe(true)
})

it("recorrido: hallazgo de origen, sesiones y saldo del tratamiento; aislado por tenant", async () => {
  const { patientId, encounterId, itemId, planId } = await setupAcceptedItem()

  // Indicar desde un hallazgo real del odontograma.
  const finding = await post(app, `/patients/${patientId}/odontogram/entries`, {
    toothNumber: 36,
    condition: "caries",
    surfaces: ["occlusal"],
    details: { variant: "dentin" },
    encounterId,
  })
  expect(finding.status).toBe(201)
  const findings = (await json<{ data: Array<{ id: string }> }>(finding)).data
  const findingId = findings[0]?.id
  if (!findingId) throw new Error("El hallazgo no devolvió identificador")
  const linked = await post(app, `/patients/${patientId}/plan/items`, {
    planId,
    serviceId: "c1111111-1111-4111-8111-111111111111",
    sourceEncounterId: encounterId,
    toothNumber: 36,
    odontogramEntryId: findingId,
  })
  expect(linked.status).toBe(201)
  const linkedBody = await json<{ data: { id: string; odontogramEntryId: string | null } }>(linked)
  expect(linkedBody.data.odontogramEntryId).toBe(findingId)
  const linkedItemId = linkedBody.data.id

  const journey = await app.request(`/patients/${patientId}/treatments/${linkedItemId}/journey`)
  expect(journey.status).toBe(200)
  const body = await json<{
    data: {
      item: { odontogramEntryId: string | null }
      originEncounter: { id: string } | null
      originFinding: { id: string; condition: string } | null
      finance: { balances: unknown[] } | null
    }
  }>(journey)
  expect(body.data.item.odontogramEntryId).toBe(findingId)
  expect(body.data.originEncounter?.id).toBe(encounterId)
  expect(body.data.originFinding).toMatchObject({ id: findingId, condition: "caries" })
  expect(body.data.finance?.balances).toEqual([])

  // Odontología recorre el tratamiento sin caja: la ruta es clínica, pero
  // cargos, pagos y saldos solo viajan con `finance.read`.
  const clinicalOnly = await buildApp("clinician").request(
    `/patients/${patientId}/treatments/${linkedItemId}/journey`,
  )
  expect(clinicalOnly.status).toBe(200)
  const clinicalBody = await json<{ data: Record<string, unknown> }>(clinicalOnly)
  expect(clinicalBody.data.finance).toBeNull()
  expect(clinicalBody.data.originFinding).toMatchObject({ id: findingId })
  for (const key of ["charges", "payments", "applications", "refunds", "balances"]) {
    expect(clinicalBody.data).not.toHaveProperty(key)
  }

  // El hallazgo de otro paciente no puede motivar la indicación.
  const foreignFinding = await post(app, `/patients/${patientId}/plan/items`, {
    planId,
    serviceId: "c1111111-1111-4111-8111-111111111111",
    sourceEncounterId: encounterId,
    toothNumber: 36,
    odontogramEntryId: "11111111-1111-4111-8111-111111111112",
  })
  expect(foreignFinding.status).toBe(404)

  // Sesiones: el tratamiento pasa a en curso y el saldo se expone por moneda.
  const procedure = await post(app, `/patients/${patientId}/encounters/${encounterId}/procedures`, {
    planItemId: itemId,
    toothNumber: 36,
  })
  expect(procedure.status).toBe(201)
  const withSession = await app.request(`/patients/${patientId}/treatments/${itemId}/journey`)
  const sessionBody = await json<{
    data: { item: { status: string }; procedures: unknown[] }
  }>(withSession)
  expect(sessionBody.data.item.status).toBe("en_curso")
  expect(sessionBody.data.procedures).toHaveLength(1)

  // Otro tenant no ve el recorrido.
  const isolated = await buildApp("owner", "org_b").request(
    `/patients/${patientId}/treatments/${itemId}/journey`,
  )
  expect(isolated.status).toBe(404)
})

it("propuestas: revisión versionada, decisión por línea y cargo posterior", async () => {
  const { patientId, itemId, budgetId } = await setupAcceptedItem()

  // La revisión conserva el número y sube la versión.
  const revised = await post(app, `/patients/${patientId}/budgets/${budgetId}/revise`, {
    itemIds: [itemId],
    reason: "Ajuste de alcance",
  })
  expect(revised.status).toBe(201)
  const revision = await json<{
    data: { id: string; revisionNumber: number; budgetNumber: number }
  }>(revised)
  expect(revision.data.revisionNumber).toBe(2)
  // La revisión se entrega y sustituye al documento anterior.
  expect(
    (await post(app, `/patients/${patientId}/budgets/${revision.data.id}/deliver`)).status,
  ).toBe(200)
  const original = await app.request(`/patients/${patientId}/budgets/${budgetId}`)
  expect(await json<{ data: { status: string } }>(original)).toMatchObject({
    data: { status: "sustituido" },
  })

  // Decidir exige cubrir cada línea exactamente una vez.
  const incomplete = await post(
    app,
    `/patients/${patientId}/budgets/${revision.data.id}/decision`,
    {
      decisions: [],
    },
  )
  expect(incomplete.status).toBe(400)
  const decided = await post(app, `/patients/${patientId}/budgets/${revision.data.id}/decision`, {
    decisions: [{ planItemId: itemId, decision: "aceptado" }],
  })
  expect(decided.status).toBe(200)

  // Generar el cargo de la revisión aceptada es un acto explícito.
  const detail = await app.request(`/patients/${patientId}/budgets/${revision.data.id}`)
  const revisionLines = (await json<{ data: { items: Array<{ id: string }> } }>(detail)).data.items
  expect(revisionLines).toHaveLength(1)
  const lineId = revisionLines[0]?.id
  if (!lineId) throw new Error("La revisión no tiene líneas")
  const charge = await post(app, `/patients/${patientId}/charges`, { budgetItemId: lineId })
  expect(charge.status).toBe(201)
})

it("documentos: carga con vínculos clínicos y corrección versionada", async () => {
  const { patientId, itemId } = await setupAcceptedItem()
  const followUp = await post(app, `/patients/${patientId}/follow-ups`, {
    kind: "tratamiento",
    planItemId: itemId,
    title: "Control con radiografía",
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  })
  const followUpId = (await json<{ data: { id: string } }>(followUp)).data.id
  const prescription = await post(app, `/patients/${patientId}/prescriptions`, {
    planItemId: itemId,
    items: [
      {
        genericName: "ibuprofeno",
        strength: "400 mg",
        dosageForm: "tableta",
        dose: "1 tableta",
        route: "oral",
        frequency: "Cada 8 horas",
        duration: "2 días",
      },
    ],
  })
  const prescriptionId = (await json<{ data: { id: string } }>(prescription)).data.id

  const form = new FormData()
  form.append("file", new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])], { type: "image/png" }), "rx.png")
  form.append("label", "Radiografía de control")
  form.append("category", "radiografia")
  form.append("planItemId", itemId)
  form.append("followUpId", followUpId)
  form.append("prescriptionId", prescriptionId)
  form.append("toothNumbers", JSON.stringify([36]))
  form.append("imageType", "periapical")
  form.append("capturedAt", new Date(Date.now() - 3_600_000).toISOString())
  form.append("source", "Sensor intraoral · sala 2")
  // Un archivo cuyo contenido no coincide con su tipo declarado se rechaza.
  const fake = new FormData()
  fake.append("file", new Blob([new TextEncoder().encode("MZ ejecutable")], { type: "image/png" }), "rx.png")
  fake.append("label", "Falsa")
  fake.append("category", "radiografia")
  const rejected = await app.request(`/patients/${patientId}/documents`, {
    method: "POST",
    body: fake,
  })
  expect(rejected.status).toBe(400)
  // Un JPEG declarado como PNG tampoco pasa: decide el contenido.
  const mismatch = new FormData()
  mismatch.append("file", new Blob([new Uint8Array([255, 216, 255, 224, 0])], { type: "image/png" }), "rx.png")
  mismatch.append("label", "Mal declarada")
  mismatch.append("category", "radiografia")
  expect(
    (await app.request(`/patients/${patientId}/documents`, { method: "POST", body: mismatch }))
      .status,
  ).toBe(400)
  // El subtipo debe corresponder a la categoría.
  const wrongType = new FormData()
  wrongType.append("file", new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])], { type: "image/png" }), "f.png")
  wrongType.append("label", "Foto")
  wrongType.append("category", "foto_clinica")
  wrongType.append("imageType", "periapical")
  expect(
    (await app.request(`/patients/${patientId}/documents`, { method: "POST", body: wrongType }))
      .status,
  ).toBe(400)
  const uploaded = await app.request(`/patients/${patientId}/documents`, {
    method: "POST",
    body: form,
  })
  expect(uploaded.status).toBe(201)
  const created = await json<{
    data: { id: string; followUpId: string | null; prescriptionId: string | null }
  }>(uploaded)
  expect(created.data).toMatchObject({ followUpId, prescriptionId })

  // El listado expone los vínculos vigentes del documento.
  const list = await app.request(`/patients/${patientId}/documents`)
  const documents = await json<{
    data: Array<{ id: string; followUpId: string | null; planItemId: string | null }>
  }>(list)
  expect(documents.data.find((doc) => doc.id === created.data.id)).toMatchObject({
    followUpId,
    planItemId: itemId,
  })

  // La corrección versionada deja el vínculo previo intacto y suma el nuevo.
  const corrected = await post(app, `/patients/${patientId}/documents/${created.data.id}/context`, {
    expectedVersion: 1,
    prescriptionId: null,
  })
  expect(corrected.status).toBe(201)
  // Versión desactualizada: 409 sin pérdida de datos.
  const stale = await post(app, `/patients/${patientId}/documents/${created.data.id}/context`, {
    expectedVersion: 1,
  })
  expect(stale.status).toBe(409)

  // Filtros del archivo: tipo y pieza.
  const filtered = await json<{ data: Array<{ id: string; imageType: string; reportStatus: string }> }>(
    await app.request(`/patients/${patientId}/documents?imageType=periapical&tooth=36`),
  )
  expect(filtered.data.map((d) => d.id)).toEqual([created.data.id])
  expect(filtered.data[0]).toMatchObject({ imageType: "periapical", reportStatus: "pendiente" })
  const otherTooth = await json<{ data: unknown[] }>(
    await app.request(`/patients/${patientId}/documents?tooth=11`),
  )
  expect(otherTooth.data).toEqual([])
  const reported = await app.request(
    `/patients/${patientId}/documents/${created.data.id}/report`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportStatus: "informado" }),
    },
  )
  expect(reported.status).toBe(200)

  // Retirar: sin motivo no; con motivo deja traza y sale del listado.
  expect(
    (await post(app, `/patients/${patientId}/documents/${created.data.id}/retire`, { reason: "" }))
      .status,
  ).toBe(400)
  const retired = await post(app, `/patients/${patientId}/documents/${created.data.id}/retire`, {
    reason: "Subida al paciente equivocado",
  })
  expect(retired.status).toBe(200)
  expect(
    (await json<{ data: { retiredAt: string | null; retireReason: string } }>(retired)).data,
  ).toMatchObject({ retireReason: "Subida al paciente equivocado" })
  const again = await post(app, `/patients/${patientId}/documents/${created.data.id}/retire`, {
    reason: "Otra vez",
  })
  expect(again.status).toBe(409)
  const visible = await json<{ data: Array<{ id: string }> }>(
    await app.request(`/patients/${patientId}/documents`),
  )
  expect(visible.data.some((d) => d.id === created.data.id)).toBe(false)
  const withRetired = await json<{ data: Array<{ id: string }> }>(
    await app.request(`/patients/${patientId}/documents?includeRetired=true`),
  )
  expect(withRetired.data.some((d) => d.id === created.data.id)).toBe(true)
  const audits = await ownerDb.execute(
    sql`select action from audit_event where entity_id = ${created.data.id} order by created_at`,
  )
  expect(audits.map((r) => (r as { action: string }).action)).toContain("document.retired")
  // La corrección de contexto ya no aplica a un retirado.
  expect(
    (
      await post(app, `/patients/${patientId}/documents/${created.data.id}/context`, {
        expectedVersion: 2,
      })
    ).status,
  ).toBe(409)
  // La atención finalizada no admite cargas: el archivo se sube después y se vincula
  // con una revisión de contexto auditada.
  const { encounterId, patientId: owner } = await setupAcceptedItem()
  await finalizeEncounter(owner, encounterId)
  const closedForm = new FormData()
  closedForm.append("file", new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])], { type: "image/png" }), "rx2.png")
  closedForm.append("label", "Radiografía cerrada")
  closedForm.append("category", "radiografia")
  closedForm.append("encounterId", encounterId)
  const afterClose = await app.request(`/patients/${owner}/documents`, {
    method: "POST",
    body: closedForm,
  })
  expect(afterClose.status).toBe(409)
  expect((await json<ErrorBody>(afterClose)).error.code).toBe("FINALIZED")
})

it("consentimiento estructurado: firma con profesional, PDF con huella, menor y anulación", async () => {
  const sections = {
    procedure: "Extracción de la pieza 38 con anestesia local.",
    benefits: ["Eliminar el foco de infección"],
    risks: ["Dolor e inflamación", "Alveolitis"],
    alternatives: ["Control periódico"],
    consequences: "Infecciones repetidas y daño a la pieza vecina.",
  }
  const draft = await post(app, "/clinical-forms/consent-templates", {
    title: "Exodoncia",
    sections,
  })
  expect(draft.status).toBe(201)
  const draftId = (await json<{ data: { id: string } }>(draft)).data.id
  const published = await post(app, `/clinical-forms/consent-templates/${draftId}/publish`)
  expect((await json<{ data: { version: number; status: string } }>(published)).data).toMatchObject({
    version: 1,
    status: "publicado",
  })
  // Secciones incompletas: el contrato las rechaza.
  expect(
    (
      await post(app, "/clinical-forms/consent-templates", {
        title: "Incompleto",
        sections: { ...sections, risks: [] },
      })
    ).status,
  ).toBe(400)

  // Menor de edad con representante legal vigente.
  const childId = await createPatient()
  await ownerDb.execute(sql`update contact set birth_date = '2017-04-04' where id = (select person_id from patient where id = ${childId})`)
  const guardianId = await linkContact(childId)
  await ownerDb.execute(sql`update contact set doc_type = 'DNI', doc_number = '44556677' where id = ${guardianId}`)
  await post(app, `/patients/${childId}/responsibilities`, {
    contactId: guardianId,
    kind: "representante_legal",
    startsAt: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date()),
  })
  const create = async () => {
    const res = await post(app, "/clinical-forms/consents", {
      templateId: draftId,
      patientId: childId,
      procedureRef: "Exodoncia pieza 85",
    })
    expect(res.status).toBe(201)
    return (await json<{ data: { id: string } }>(res)).data.id
  }
  const strokes = { strokes: [[[10, 10], [500, 500], [900, 100]]] }
  const consentId = await create()
  // «Otra persona» no existe: sin persona vinculada no hay firma.
  const withoutSigner = await post(app, `/clinical-forms/consents/${consentId}/sign`, {
    signerKind: "representante",
    signatureData: strokes,
    professionalSignature: strokes,
    comprehensionConfirmed: true,
  })
  expect(withoutSigner.status).toBe(400)
  const child = await json<{ data: { contacts: Array<{ contactId: string; relationship: string }> } }>(
    await app.request(`/patients/${childId}`),
  )
  const selfId = child.data.contacts.find((c) => c.relationship === "self")!.contactId
  const minorSelf = await post(app, `/clinical-forms/consents/${consentId}/sign`, {
    signerKind: "paciente",
    signerContactId: selfId,
    signatureData: strokes,
    professionalSignature: strokes,
    comprehensionConfirmed: true,
  })
  expect(minorSelf.status).toBe(400)
  const signed = await post(app, `/clinical-forms/consents/${consentId}/sign`, {
    signerKind: "representante",
    signerContactId: guardianId,
    representativeRelation: "Madre",
    signatureData: strokes,
    professionalSignature: strokes,
    comprehensionConfirmed: true,
  })
  expect(signed.status).toBe(200)
  const signedBody = await json<{
    data: { status: string; pdfDocumentId: string | null; pdfSha256: string | null; informerRegistration: string }
  }>(signed)
  expect(signedBody.data).toMatchObject({ status: "firmado", informerRegistration: "COP 12345" })
  expect(signedBody.data.pdfDocumentId).toBeTruthy()
  // La huella corresponde a los bytes guardados y el PDF es un documento del paciente.
  const docs = await json<{ data: Array<{ id: string; storageKey: string; category: string }> }>(
    await app.request(`/patients/${childId}/documents`),
  )
  const pdfDoc = docs.data.find((d) => d.id === signedBody.data.pdfDocumentId)!
  expect(pdfDoc.category).toBe("consentimiento")
  const bytes = storedBytes.get(pdfDoc.storageKey)!
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-")
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(signedBody.data.pdfSha256)
  // Una segunda generación no reemplaza el PDF.
  const again = await post(app, `/clinical-forms/consents/${consentId}/pdf`)
  expect((await json<{ data: { pdfSha256: string } }>(again)).data.pdfSha256).toBe(
    signedBody.data.pdfSha256,
  )
  const print = await json<{ data: { patient: { minor: boolean }; document: { id: string } } }>(
    await app.request(`/clinical-forms/consents/${consentId}/print`),
  )
  expect(print.data.patient.minor).toBe(true)

  // Pendiente anulado con motivo; firmado se revoca, no se anula.
  const pending = await create()
  expect((await post(app, `/clinical-forms/consents/${pending}/cancel`, { reason: "" })).status).toBe(400)
  expect(
    (await post(app, `/clinical-forms/consents/${pending}/cancel`, { reason: "Duplicado" })).status,
  ).toBe(200)
  expect(
    (await post(app, `/clinical-forms/consents/${consentId}/cancel`, { reason: "x" })).status,
  ).toBe(409)
  // Revocar exige quién revoca y su firma.
  expect(
    (await post(app, `/clinical-forms/consents/${consentId}/revoke`, { reason: "Cambio" })).status,
  ).toBe(400)
  const revoked = await post(app, `/clinical-forms/consents/${consentId}/revoke`, {
    reason: "Prefiere esperar",
    revokerContactId: guardianId,
    signatureData: strokes,
  })
  expect(revoked.status).toBe(200)
  expect((await json<{ data: { status: string; revokerName: string } }>(revoked)).data.status).toBe(
    "revocado",
  )
})

it("formularios: finalizar con un obligatorio vacío responde 400 nombrando el campo", async () => {
  const draft = await post(app, "/clinical-forms/form-templates", {
    title: "Evaluación rápida",
    schema: {
      sections: [
        {
          id: "examen",
          title: "Examen",
          fields: [
            { id: "hallazgos", label: "Hallazgos", type: "texto_largo", required: true },
            { id: "pieza", label: "Pieza", type: "pieza" },
          ],
        },
      ],
    },
  })
  expect(draft.status).toBe(201)
  const draftId = (await json<{ data: { id: string } }>(draft)).data.id
  const published = await post(app, `/clinical-forms/form-templates/${draftId}/publish`)
  expect((await json<{ data: { version: number } }>(published)).data.version).toBe(1)
  const patientId = await createPatient()
  const created = await post(app, "/clinical-forms/form-responses", {
    templateId: draftId,
    patientId,
    answers: { pieza: 36 },
  })
  expect(created.status).toBe(201)
  const responseId = (await json<{ data: { id: string; templateTitle: string } }>(created)).data.id
  const finalized = await post(app, `/clinical-forms/form-responses/${responseId}/finalize`)
  expect(finalized.status).toBe(400)
  expect((await json<ErrorBody>(finalized)).error.message).toContain("Hallazgos")
  const discarded = await post(app, `/clinical-forms/form-responses/${responseId}/discard`, {
    reason: "Paciente equivocado",
  })
  expect(discarded.status).toBe(200)
})

it("órdenes: imagen con diagnóstico y hoja para imprimir; cancelar pide motivo; recepción no lee lo que pide la atención", async () => {
  const patientId = await createPatient()
  const created = await post(app, "/clinical-forms/orders", {
    kind: "imagen",
    patientId,
    recipient: "Centro de imágenes",
    title: "Radiografía panorámica",
    diagnosisCode: "K02.1",
  })
  expect(created.status).toBe(201)
  const orderId = (await json<{ data: { id: string; kind: string } }>(created)).data.id
  const sheet = await app.request(`/clinical-forms/orders/${orderId}/print`)
  expect(sheet.status).toBe(200)
  expect(
    (await json<{ data: { order: { kind: string }; diagnosisDescription: string | null } }>(sheet)).data,
  ).toMatchObject({ order: { kind: "imagen" }, diagnosisDescription: "Caries de la dentina" })
  // Sin para quién no hay orden; sin motivo no se cancela.
  const noRecipient = await post(app, "/clinical-forms/orders", { kind: "laboratorio", patientId, title: "Hemograma" })
  expect(noRecipient.status).toBe(400)
  expect((await post(app, `/clinical-forms/orders/${orderId}/status`, { toStatus: "cancelado" })).status).toBe(400)
  const cancelled = await post(app, `/clinical-forms/orders/${orderId}/status`, {
    toStatus: "cancelado",
    reason: "Ya trajo la radiografía",
  })
  expect(cancelled.status).toBe(200)
  expect((await json<{ data: { cancelReason: string } }>(cancelled)).data.cancelReason).toBe("Ya trajo la radiografía")
  // Lo que pide la atención en consentimientos es clínico: recepción no lo lee ni lo prepara.
  const reception = buildApp("reception")
  const needs = await reception.request(
    `/clinical-forms/consent-needs?patientId=${patientId}&encounterId=${crypto.randomUUID()}`,
  )
  expect(needs.status).toBe(403)
  expect(
    (await post(reception, "/clinical-forms/consent-needs/prepare", { patientId, encounterId: crypto.randomUUID() }))
      .status,
  ).toBe(403)
})

it("imágenes: la subida genera miniatura WebP y la URL la sirve con ?variant=thumb", async () => {
  const patientId = await createPatient()
  const png = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: "#777" },
  })
    .png()
    .toBuffer()
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "rx.png")
  form.append("label", "Panorámica")
  form.append("category", "radiografia")
  form.append("imageType", "panoramica")
  const uploaded = await app.request(`/patients/${patientId}/documents`, { method: "POST", body: form })
  expect(uploaded.status).toBe(201)
  const doc = (await json<{ data: { id: string; storageKey: string; thumbnailKey: string | null } }>(uploaded)).data
  expect(doc.thumbnailKey).toMatch(/\.webp$/)
  const thumbBytes = storedBytes.get(doc.thumbnailKey!)!
  const meta = await sharp(thumbBytes).metadata()
  expect(meta).toMatchObject({ format: "webp", width: 320, height: 213 })
  const thumbUrl = await json<{ data: { url: string; thumbnail: boolean } }>(
    await app.request(`/patients/${patientId}/documents/${doc.id}/url?variant=thumb`),
  )
  expect(thumbUrl.data).toMatchObject({ thumbnail: true })
  expect(thumbUrl.data.url).toContain(doc.thumbnailKey!)
  const original = await json<{ data: { url: string; thumbnail: boolean } }>(
    await app.request(`/patients/${patientId}/documents/${doc.id}/url`),
  )
  expect(original.data.url).toContain(doc.storageKey)
})

it("DICOM: se sube como archivo, la API sirve su contenido y rechaza otros formatos", async () => {
  const patientId = await createPatient()
  const pixels = new Uint16Array(16 * 8).fill(1000)
  const dicom = encodeDemoDicom({ width: 16, height: 8, pixels })
  const form = new FormData()
  // Los navegadores suelen enviar el DICOM sin tipo: decide el contenido.
  form.append("file", new Blob([dicom]), "periapical.dcm")
  form.append("label", "Periapical del sensor")
  form.append("category", "radiografia")
  form.append("imageType", "periapical")
  const uploaded = await app.request(`/patients/${patientId}/documents`, { method: "POST", body: form })
  expect(uploaded.status).toBe(201)
  const doc = (await json<{ data: { id: string; contentType: string; thumbnailKey: string | null } }>(uploaded)).data
  expect(doc).toMatchObject({ contentType: "application/dicom", thumbnailKey: null })
  const content = await app.request(`/patients/${patientId}/documents/${doc.id}/content`)
  expect(content.status).toBe(200)
  expect(content.headers.get("content-type")).toBe("application/dicom")
  expect(new Uint8Array(await content.arrayBuffer())).toEqual(dicom)

  const png = new FormData()
  png.append("file", new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], { type: "image/png" }), "a.png")
  png.append("label", "Foto")
  png.append("category", "otro")
  const pngDoc = (await json<{ data: { id: string } }>(
    await app.request(`/patients/${patientId}/documents`, { method: "POST", body: png }),
  )).data
  expect((await app.request(`/patients/${patientId}/documents/${pngDoc.id}/content`)).status).toBe(400)
  expect(
    (await app.request(`/patients/${patientId}/documents/${crypto.randomUUID()}/content`)).status,
  ).toBe(404)
})
