process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import type { CrmDeps } from "./helpers.js"
import { createContactsRoute } from "./contacts.js"
import { createPatientsRoute } from "./patients.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("cc".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

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
  }) => ({
    objectKey: `patients/${orgId}/${patientId}/docs/${crypto.randomUUID()}.${ext}`,
    mimeType: contentType,
    filename: `documento.${ext}`,
    size: bytes.byteLength,
  }),
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
  // El cierre exige un acto registrado y la evolución clínica.
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
  expect((await post(app, `/patients/${patientId}/budgets/${budgetId}/present`)).status).toBe(200)
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
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values ('u-1', 'Doctora', 'doc@test.dev') on conflict do nothing`,
  )
  await ownerDb.execute(
    sql`insert into "service_catalog" ("id", "organization_id", "source", "code", "name", "specialty", "scope", "price_cents", "currency", "duration_min", "is_active") values
        ('c1111111-1111-4111-8111-111111111111', 'org_a', 'custom', 'CORONA', 'Corona cerámica', 'protesis', 'tooth', 90000, 'PEN', 60, true),
        ('d5555555-5555-4555-8555-555555555555', 'org_b', 'custom', 'OTRO', 'Otro servicio', 'protesis', 'tooth', 999, 'PEN', 15, true)
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

  const scheduled = await post(app, `/patients/${patientId}/follow-ups/${followUpId}/schedule`, {
    scheduledAt: new Date(Date.now() + 172_800_000).toISOString(),
  })
  expect(scheduled.status).toBe(200)
  expect((await json<{ data: { status: string } }>(scheduled)).data.status).toBe("programado")
  // Programar dos veces es una transición ilegal.
  const reschedule = await post(app, `/patients/${patientId}/follow-ups/${followUpId}/schedule`, {
    scheduledAt: new Date(Date.now() + 200_000_000).toISOString(),
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
        medicationName: "Ibuprofeno 400 mg",
        dose: "400 mg",
        route: "Oral",
        frequency: "Cada 8 horas",
        duration: "3 días",
        quantity: 9,
      },
      {
        medicationName: "Clorhexidina 0.12%",
        dose: "15 ml",
        route: "Enjuague",
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
  ).toEqual(["Clorhexidina 0.12%", "Ibuprofeno 400 mg"])

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

it("cuenta: cargo desde línea aceptada, pago, aplicación, devolución y límites", async () => {
  const { patientId, itemId } = await setupAcceptedItem()
  const contactId = await linkContact(patientId)

  const charge = await post(app, `/patients/${patientId}/charges`, { planItemId: itemId })
  expect(charge.status).toBe(400)
  // Describir el concepto no sustituye a la fuente: sigue faltando importe y moneda.
  const manual = await post(app, `/patients/${patientId}/charges`, {
    description: "Cargo manual",
    amountCents: 5000,
    currency: "PEN",
  })
  expect(manual.status).toBe(201)

  const accepted = await (async () => {
    const detail = await app.request(`/patients/${patientId}/budgets`)
    const budgets = await json<{ data: Array<{ id: string; items: Array<{ id: string }> }> }>(
      detail,
    )
    const line = budgets.data[0]?.items[0]
    if (!line) throw new Error("El presupuesto aceptado no tiene líneas")
    return line.id
  })()
  // Primero un cargo parcial: la línea conserva 50 000 centavos por generar.
  const partial = await post(app, `/patients/${patientId}/charges`, {
    budgetItemId: accepted,
    amountCents: 40000,
  })
  expect(partial.status).toBe(201)
  // Superar el importe pendiente de la línea se rechaza con su código propio.
  const over = await post(app, `/patients/${patientId}/charges`, {
    budgetItemId: accepted,
    amountCents: 60000,
  })
  expect(over.status).toBe(409)
  expect((await json<ErrorBody>(over)).error.code).toBe("CHARGE_EXCEEDS_BUDGET")
  const fromLine = await post(app, `/patients/${patientId}/charges`, { budgetItemId: accepted })
  expect(fromLine.status).toBe(201)
  const fromLineBody = await json<{ data: { id: string; amountCents: number } }>(fromLine)
  expect(fromLineBody.data.amountCents).toBe(50000)
  const chargeId = fromLineBody.data.id
  // Agotado el importe del tratamiento, otro cargo no tiene nada que generar:
  // el contrato lo dice con su código propio, no con un error genérico.
  const exhausted = await post(app, `/patients/${patientId}/charges`, { budgetItemId: accepted })
  expect(exhausted.status).toBe(409)
  expect((await json<ErrorBody>(exhausted)).error.code).toBe("CHARGE_EXCEEDS_BUDGET")

  const payment = await post(app, `/patients/${patientId}/payments`, {
    amountCents: 40000,
    currency: "PEN",
    paidAt: new Date().toISOString(),
    method: "efectivo",
    payerContactId: contactId,
  })
  expect(payment.status).toBe(201)
  const paymentId = (await json<{ data: { id: string } }>(payment)).data.id

  // Sobregiro real: no puede aplicarse más de lo pendiente del cargo.
  const excessive = await post(app, `/patients/${patientId}/payments/${paymentId}/applications`, {
    chargeId,
    amountCents: 50000,
  })
  expect(excessive.status).toBe(409)
  expect((await json<ErrorBody>(excessive)).error.code).toBe("INSUFFICIENT_BALANCE")

  const applied = await post(app, `/patients/${patientId}/payments/${paymentId}/applications`, {
    chargeId,
    amountCents: 30000,
  })
  expect(applied.status).toBe(200)
  const applicationId = (await json<{ data: { id: string } }>(applied)).data.id

  // Un pago en otra moneda no se aplica a un cargo en soles.
  const dollars = await post(app, `/patients/${patientId}/payments`, {
    amountCents: 1000,
    currency: "USD",
    paidAt: new Date().toISOString(),
    method: "tarjeta",
  })
  const crossCurrency = await post(
    app,
    `/patients/${patientId}/payments/${(await json<{ data: { id: string } }>(dollars)).data.id}/applications`,
    { chargeId, amountCents: 100 },
  )
  expect(crossCurrency.status).toBe(409)
  expect((await json<ErrorBody>(crossCurrency)).error.code).toBe("CURRENCY_MISMATCH")

  // Devolver más de lo no aplicado se rechaza; el excedente exacto se acepta.
  const refundOver = await post(app, `/patients/${patientId}/payments/${paymentId}/refunds`, {
    amountCents: 20000,
    reason: "Devolución excesiva",
  })
  expect(refundOver.status).toBe(409)
  const refund = await post(app, `/patients/${patientId}/payments/${paymentId}/refunds`, {
    amountCents: 10000,
    reason: "Ajuste acordado",
  })
  expect(refund.status).toBe(200)

  // Un cargo con aplicación activa no se anula.
  const voidCharge = await post(app, `/patients/${patientId}/charges/${chargeId}/void`, {
    reason: "Error de digitación",
  })
  expect(voidCharge.status).toBe(409)
  // Anular la aplicación reabre el saldo y permite anular el cargo.
  expect(
    (
      await post(app, `/patients/${patientId}/payment-applications/${applicationId}/void`, {
        reason: "Corrección de aplicación",
      })
    ).status,
  ).toBe(200)
  expect(
    (await post(app, `/patients/${patientId}/charges/${chargeId}/void`, { reason: "Duplicado" }))
      .status,
  ).toBe(200)

  const account = await app.request(`/patients/${patientId}/account`)
  expect(account.status).toBe(200)
  const balances = await json<{
    data: { byCurrency: Array<{ currency: string; chargedCents: number; paidCents: number }> }
  }>(account)
  expect(balances.data.byCurrency.find((row) => row.currency === "PEN")).toMatchObject({
    chargedCents: 45000,
    paidCents: 40000,
  })
  expect(balances.data.byCurrency.find((row) => row.currency === "USD")).toMatchObject({
    chargedCents: 0,
    paidCents: 1000,
  })
})

it("responsables: vigencia, duplicado y revocación con motivo", async () => {
  const { patientId } = await setupAcceptedItem()
  const contactId = await linkContact(patientId)
  const startsAt = new Date().toISOString().slice(0, 10)

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
    kind: "acompanante",
    startsAt,
  })
  expect(outsider.status).toBe(404)

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

it("suspendido se reanuda y las alternativas se agrupan con recomendación", async () => {
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

  // Alternativas: se agrupan después de indicarlas y solo una queda recomendada.
  const group = await post(app, `/patients/${patientId}/plans/${planId}/option-groups`, {
    title: "Corona o resina",
  })
  expect(group.status).toBe(201)
  const groupId = (await json<{ data: { id: string } }>(group)).data.id
  const second = await post(app, `/patients/${patientId}/plan/items`, {
    planId,
    serviceId: "c1111111-1111-4111-8111-111111111111",
    sourceEncounterId: encounterId,
    toothNumber: 36,
  })
  expect(second.status).toBe(201)
  const secondId = (await json<{ data: { id: string } }>(second)).data.id

  const grouped = await post(app, `/patients/${patientId}/treatments/${itemId}/alternative`, {
    optionGroupId: groupId,
    isRecommended: true,
  })
  expect(grouped.status).toBe(200)
  expect(
    (await json<{ data: { optionGroupId: string; isRecommended: boolean } }>(grouped)).data,
  ).toMatchObject({ optionGroupId: groupId, isRecommended: true })
  const other = await post(app, `/patients/${patientId}/treatments/${secondId}/alternative`, {
    optionGroupId: groupId,
    isRecommended: true,
  })
  expect(other.status).toBe(200)
  const journey = await app.request(`/patients/${patientId}/treatments/${itemId}/journey`)
  const alternatives = (
    await json<{
      data: {
        optionGroup: {
          title: string
          alternatives: Array<{ id: string; isRecommended: boolean }>
        } | null
      }
    }>(journey)
  ).data.optionGroup
  expect(alternatives?.title).toBe("Corona o resina")
  expect(alternatives?.alternatives.filter((a) => a.isRecommended)).toHaveLength(1)

  const foreignGroup = await post(app, `/patients/${patientId}/treatments/${itemId}/alternative`, {
    optionGroupId: "11111111-1111-4111-8111-111111111111",
  })
  expect(foreignGroup.status).toBe(404)
})

it("la historia declara el contexto de cada evento del recorrido", async () => {
  const { patientId, itemId } = await setupAcceptedItem()
  const charge = await post(app, `/patients/${patientId}/charges`, {
    planItemId: itemId,
    description: "Cargo de historia",
    amountCents: 15000,
    currency: "PEN",
  })
  expect(charge.status).toBe(201)
  const payment = await post(app, `/patients/${patientId}/payments`, {
    amountCents: 15000,
    currency: "PEN",
    paidAt: new Date().toISOString(),
    method: "efectivo",
  })
  expect(payment.status).toBe(201)

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
    data: { payments: Array<{ id: string; amountCents: number }> }
  }>(account)
  expect(accountData.payments.some((row) => row.amountCents === 15000)).toBe(true)
})

it("recorrido: hallazgo de origen, sesiones y saldo del tratamiento; aislado por tenant", async () => {
  const { patientId, encounterId, itemId, planId } = await setupAcceptedItem()

  // Indicar desde un hallazgo real del odontograma.
  const finding = await post(app, `/patients/${patientId}/odontogram/entries`, {
    toothNumber: 36,
    condition: "caries",
    surfaces: ["occlusal"],
    details: { variant: "dentin" },
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
      balances: unknown[]
    }
  }>(journey)
  expect(body.data.item.odontogramEntryId).toBe(findingId)
  expect(body.data.originEncounter?.id).toBe(encounterId)
  expect(body.data.originFinding).toMatchObject({ id: findingId, condition: "caries" })

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
  // La revisión se presenta y sustituye al documento anterior.
  expect(
    (await post(app, `/patients/${patientId}/budgets/${revision.data.id}/present`)).status,
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
        medicationName: "Ibuprofeno",
        dose: "400 mg",
        route: "Oral",
        frequency: "Cada 8 horas",
        duration: "2 días",
      },
    ],
  })
  const prescriptionId = (await json<{ data: { id: string } }>(prescription)).data.id

  const form = new FormData()
  form.append("file", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }), "rx.png")
  form.append("label", "Radiografía de control")
  form.append("category", "radiografia")
  form.append("planItemId", itemId)
  form.append("followUpId", followUpId)
  form.append("prescriptionId", prescriptionId)
  form.append("toothNumbers", JSON.stringify([36]))
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
  // La atención finalizada no admite cargas: el archivo se sube después y se vincula
  // con una revisión de contexto auditada.
  const { encounterId, patientId: owner } = await setupAcceptedItem()
  await finalizeEncounter(owner, encounterId)
  const closedForm = new FormData()
  closedForm.append("file", new Blob([new Uint8Array([1])], { type: "image/png" }), "rx2.png")
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
