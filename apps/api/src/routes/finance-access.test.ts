process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import {
  addPlanItem,
  createBudget,
  createEncounter,
  createPaymentMethod,
  createTreatmentPlan,
  deliverBudget,
  secretsKeyFromEnv,
  updatePaymentMethod,
} from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { z } from "zod"
import { createCommissionsRoute } from "./commissions.js"
import { createFinanceRoute } from "./finance.js"
import { createFinancialDocumentsRoute } from "./financial-documents.js"
import type { CrmDeps } from "./helpers.js"
import { createPatientsRoute } from "./patients.js"
import { createPaymentMethodsRoute } from "./payment-methods.js"

// Matriz de acceso económico (P2) sobre API real con PostgreSQL efímero.
// reception no lee caja/cuenta/importes ni configura métodos; cashier cobra,
// cierra y decide presupuestos pero no configura métodos ni comisiones;
// dentist presupuestos propios sin caja y comisiones propias sin ajenas.
// Tenants aislados (org_fin_a vs org_fin_b) con appDb (RLS).
// Montaje del test: /patients (incluye patient-budgets y patient-payments),
// /finance, /org/payment-methods, /commissions.
// NOTA integrador: app.ts hoy no monta /commissions ni /promotions
// (verificado en src/app.ts); este test monta createCommissionsRoute
// directo. Sin `deliverBudget` no hay `presentBudget` (CobrosCaja nombraba
// presentBudget: no existe, es deliverBudget borrador→presentado).

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("dd".repeat(32))

const ORG_A = "org_fin_a"
const ORG_B = "org_fin_b"
const OWNER = "u-fin-owner"
const ADMIN = "u-fin-admin"
const ADMIN_B = "u-fin-admin-b"
const RECEP = "u-fin-recep"
const DENT1 = "u-fin-dent-1"
const DENT2 = "u-fin-dent-2"
const CASH = "u-fin-cash"
const MEMBER = "u-fin-member"

// Respuestas JSON del propio API: se validan con esquema, nunca con cast.
const IdData = z.object({ data: z.object({ id: z.string() }).passthrough() })
const IdList = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) })
const NamedList = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
})
const TicketData = z.object({
  data: z.object({ ticket: z.object({ id: z.string() }).passthrough() }).passthrough(),
})

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const BRANCH_A = crypto.randomUUID()
const BRANCH_B = crypto.randomUUID()
const SVC_A = crypto.randomUUID()
const SVC_B = crypto.randomUUID()

let CASH_A = ""
let CARD_A = ""
let OFF_A = ""
let CASH_B = ""
let PAT_A = ""
let PAT_B = ""
let PLAN_A = ""
let ITEM1 = ""
let ITEM2 = ""
let ITEM3 = ""
let BUDGET1 = ""

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
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async ({
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
    objectKey: `patients/${orgId}/${patientId}/avatar/${crypto.randomUUID()}.${ext}`,
    mimeType: contentType,
    filename: `avatar.${ext}`,
    size: bytes.byteLength,
  }),
}

function stubOrg(role: string, userId: string, orgId = ORG_A) {
  return async (c: Context, next: Next) => {
    c.set("orgId", orgId)
    c.set("userId", userId)
    c.set("memberRole", role)
    await next()
  }
}

function buildApp(role: string, userId: string, orgId = ORG_A): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", stubOrg(role, userId, orgId))
  // Mismo orden que `app.ts`: los documentos financieros van antes de la ficha.
  app.route("/patients", createFinancialDocumentsRoute(deps))
  app.route("/patients", createPatientsRoute(deps))
  app.route("/finance", createFinanceRoute(deps))
  app.route("/org/payment-methods", createPaymentMethodsRoute(deps))
  app.route("/commissions", createCommissionsRoute(deps))
  return app
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function patchJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function registrationBody(displayName: string) {
  return {
    submissionId: crypto.randomUUID(),
    answers: {
      demographics: { displayName },
      respondent: "staff",
      privacyAccepted: false,
    },
  }
}

async function createPatientViaApi(role: string, userId: string, orgId: string): Promise<string> {
  const app = buildApp(role, userId, orgId)
  const res = await postJson(app, "/patients", registrationBody(`Acceso ${crypto.randomUUID()}`))
  expect(res.status).toBe(201)
  return IdData.parse(await res.json()).data.id
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
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at") values
      (${ORG_A}, 'Clínica Acceso', 'acceso', now()),
      (${ORG_B}, 'Clínica Acceso Sur', 'acceso-sur', now())`)
  await ownerDb.execute(sql`
    insert into "org_profile"
      ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values
      (${ORG_A}, 'Clínica Acceso', 'PE', 'PEN', 'America/Lima', 'es-PE'),
      (${ORG_B}, 'Clínica Acceso Sur', 'PE', 'PEN', 'America/Lima', 'es-PE')`)
  await ownerDb.execute(sql`
    insert into "user" ("id", "name", "email") values
      (${OWNER}, 'Dueña', 'fin-owner@example.test'),
      (${ADMIN}, 'Admin', 'fin-admin@example.test'),
      (${ADMIN_B}, 'Admin Sur', 'fin-admin-b@example.test'),
      (${RECEP}, 'Recepción', 'fin-recep@example.test'),
      (${DENT1}, 'Odontóloga Uno', 'fin-dent-1@example.test'),
      (${DENT2}, 'Odontólogo Dos', 'fin-dent-2@example.test'),
      (${CASH}, 'Caja', 'fin-cash@example.test'),
      (${MEMBER}, 'Miembro', 'fin-member@example.test')`)
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      ('m-fin-owner', ${ORG_A}, ${OWNER}, 'owner', now()),
      ('m-fin-admin', ${ORG_A}, ${ADMIN}, 'admin', now()),
      ('m-fin-admin-b', ${ORG_B}, ${ADMIN_B}, 'admin', now()),
      ('m-fin-recep', ${ORG_A}, ${RECEP}, 'reception', now()),
      ('m-fin-dent-1', ${ORG_A}, ${DENT1}, 'dentist', now()),
      ('m-fin-dent-2', ${ORG_A}, ${DENT2}, 'dentist', now()),
      ('m-fin-cash', ${ORG_A}, ${CASH}, 'cashier', now()),
      ('m-fin-member', ${ORG_A}, ${MEMBER}, 'member', now())`)
  await ownerDb.execute(sql`
    insert into "branch" ("id", "organization_id", "name") values
      (${BRANCH_A}, ${ORG_A}, 'Miraflores'),
      (${BRANCH_B}, ${ORG_B}, 'Surco')`)
  await ownerDb.execute(sql`
    insert into "service_catalog" ("id", "organization_id", "source", "code", "name", "specialty", "scope", "price_cents", "currency", "is_active") values
      (${SVC_A}, ${ORG_A}, 'custom', 'FIN-ACC', 'Resina acceso', 'restauradora', 'general', 33000, 'PEN', true),
      (${SVC_B}, ${ORG_B}, 'custom', 'FIN-ACC', 'Resina acceso', 'restauradora', 'general', 33000, 'PEN', true)`)
  // Medios reales por servicio (no seed): efectivo, tarjeta y uno apagado.
  const cash = await withOrgContext(appDb, ORG_A, (tx) =>
    createPaymentMethod(tx, ORG_A, ADMIN, { name: "Efectivo", typeCode: "10" }),
  )
  const card = await withOrgContext(appDb, ORG_A, (tx) =>
    createPaymentMethod(tx, ORG_A, ADMIN, { name: "Tarjeta", typeCode: "48" }),
  )
  const off = await withOrgContext(appDb, ORG_A, (tx) =>
    createPaymentMethod(tx, ORG_A, ADMIN, { name: "Yape", typeCode: "68" }),
  )
  await withOrgContext(appDb, ORG_A, (tx) =>
    updatePaymentMethod(tx, ORG_A, ADMIN, off.id, { isActive: false }),
  )
  const cashB = await withOrgContext(appDb, ORG_B, (tx) =>
    createPaymentMethod(tx, ORG_B, ADMIN_B, { name: "Efectivo", typeCode: "10" }),
  )
  CASH_A = cash.id
  CARD_A = card.id
  OFF_A = off.id
  CASH_B = cashB.id
  // Pacientes reales vía API (misma ruta que producción).
  PAT_A = await createPatientViaApi("admin", ADMIN, ORG_A)
  PAT_B = await createPatientViaApi("admin", ADMIN_B, ORG_B)
  // Plan propio de DENT1 con 3 indicaciones; presupuesto 1 presentado.
  const encounter = await withOrgContext(appDb, ORG_A, (tx) =>
    createEncounter(tx, ORG_A, DENT1, PAT_A, { reason: "Evaluación" }),
  )
  const plan = await withOrgContext(appDb, ORG_A, (tx) =>
    createTreatmentPlan(tx, ORG_A, DENT1, PAT_A, {
      title: "Plan acceso",
      originEncounterId: encounter.id,
    }),
  )
  PLAN_A = plan.id
  const itemIds: string[] = []
  for (let i = 0; i < 3; i++) {
    const item = await withOrgContext(appDb, ORG_A, (tx) =>
      addPlanItem(tx, ORG_A, DENT1, PAT_A, {
        serviceId: SVC_A,
        planId: PLAN_A,
        sourceEncounterId: encounter.id,
      }),
    )
    itemIds.push(item.id)
  }
  ;[ITEM1, ITEM2, ITEM3] = itemIds as [string, string, string]
  const budget = await withOrgContext(appDb, ORG_A, (tx) =>
    createBudget(tx, ORG_A, DENT1, PAT_A, { planId: PLAN_A, itemIds: [ITEM1] }, { memberRole: "dentist" }),
  )
  await withOrgContext(appDb, ORG_A, (tx) =>
    deliverBudget(tx, ORG_A, DENT1, PAT_A, budget.id, { memberRole: "dentist" }),
  )
  BUDGET1 = budget.id
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("métodos: activeOnly filtra y configurar exige settings.write", async () => {
  const admin = buildApp("admin", ADMIN)
  const all = NamedList.parse(await (await admin.request("/org/payment-methods?activeOnly=0")).json())
  expect(all.data.map((m) => m.id)).toContain(OFF_A)
  const active = IdList.parse(await (await admin.request("/org/payment-methods?activeOnly=1")).json())
  expect(active.data.map((m) => m.id)).toContain(CASH_A)
  expect(active.data.map((m) => m.id)).not.toContain(OFF_A)
  const fallback = IdList.parse(await (await admin.request("/org/payment-methods")).json())
  expect(fallback.data.map((m) => m.id)).not.toContain(OFF_A)

  // Cuerpos válidos: el 403 viene del permiso, no de la validación.
  const validCreate = { name: "Plin", typeCode: "68" }
  expect((await postJson(buildApp("reception", RECEP), "/org/payment-methods", validCreate)).status).toBe(403)
  expect((await postJson(buildApp("cashier", CASH), "/org/payment-methods", validCreate)).status).toBe(403)
  expect((await postJson(buildApp("dentist", DENT1), "/org/payment-methods", validCreate)).status).toBe(403)
  expect((await patchJson(buildApp("reception", RECEP), `/org/payment-methods/${CARD_A}`, { isActive: false })).status).toBe(403)
  expect((await patchJson(buildApp("cashier", CASH), `/org/payment-methods/${CARD_A}`, { isActive: false })).status).toBe(403)

  const created = await postJson(admin, "/org/payment-methods", validCreate)
  expect(created.status).toBe(201)
  const createdId = IdData.parse(await created.json()).data.id
  const patched = await patchJson(admin, `/org/payment-methods/${createdId}`, { isActive: false })
  expect(patched.status).toBe(200)
})

it("caja: reception/dentist sin finance.read; cashier lee y cierra", async () => {
  const cashPath = `/finance/cash?branchId=${BRANCH_A}`
  expect((await buildApp("reception", RECEP).request(cashPath)).status).toBe(403)
  expect((await buildApp("dentist", DENT1).request(cashPath)).status).toBe(403)
  expect((await buildApp("member", MEMBER).request(cashPath)).status).toBe(403)
  expect((await buildApp("cashier", CASH).request(cashPath)).status).toBe(200)
  expect((await buildApp("admin", ADMIN).request(cashPath)).status).toBe(200)

  const closuresPath = `/finance/closures?branchId=${BRANCH_A}`
  expect((await buildApp("reception", RECEP).request(closuresPath)).status).toBe(403)
  expect((await buildApp("cashier", CASH).request(closuresPath)).status).toBe(200)

  // Cierre con importes válidos (cero sobre ventana vacía: 0+0=0). La sede
  // aún no tenía caja: se afirma con `shiftId: null`.
  const closeBody = { branchId: BRANCH_A, shiftId: null, countedCents: 0, retainedCents: 0, deliveredCents: 0 }
  expect((await postJson(buildApp("reception", RECEP), "/finance/closures", closeBody)).status).toBe(403)
  expect((await postJson(buildApp("dentist", DENT1), "/finance/closures", closeBody)).status).toBe(403)
  const closed = await postJson(buildApp("cashier", CASH), "/finance/closures", closeBody)
  expect(closed.status).toBe(201)
  const shiftId = ((await closed.json()) as { data: { id: string } }).data.id
  // Reenviar el mismo cierre no abre otro: con la ventana vista devuelve el
  // mismo; afirmando que no había caja, pide volver a contar.
  const again = await postJson(buildApp("cashier", CASH), "/finance/closures", { ...closeBody, shiftId })
  expect(again.status).toBe(201)
  expect(((await again.json()) as { data: { id: string } }).data.id).toBe(shiftId)
  const stale = await postJson(buildApp("cashier", CASH), "/finance/closures", closeBody)
  expect(stale.status).toBe(409)
  expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("CASH_WINDOW_CHANGED")
  // Sin decir qué ventana se contó no hay cierre.
  const { shiftId: _omit, ...withoutShift } = closeBody
  expect((await postJson(buildApp("cashier", CASH), "/finance/closures", withoutShift)).status).toBe(400)
})

it("finanzas: cada ruta rechaza a quien no es caja ni administración", async () => {
  const id = "00000000-0000-4000-8000-000000000000"
  const reads = [
    `/finance/cash?branchId=${BRANCH_A}`,
    `/finance/closures?branchId=${BRANCH_A}`,
    `/finance/closures/${id}`,
    `/finance/debts?branchId=${BRANCH_A}`,
    `/finance/movements?branchId=${BRANCH_A}&day=2026-01-15`,
    `/finance/expenses?branchId=${BRANCH_A}`,
  ]
  const writes: Array<[string, unknown]> = [
    ["/finance/cash/movements", { branchId: BRANCH_A, kind: "aporte", amountCents: 1000, concept: "Fondo" }],
    [`/finance/movements/${id}/void`, { reason: "x" }],
    ["/finance/expenses", { branchId: BRANCH_A, concept: "Útiles", amountCents: 1000 }],
    [`/finance/expenses/${id}/void`, { reason: "x" }],
    ["/finance/closures", { branchId: BRANCH_A, shiftId: null, countedCents: 0, retainedCents: 0, deliveredCents: 0 }],
  ]
  for (const [role, userId] of [["reception", RECEP], ["dentist", DENT1], ["member", MEMBER]] as const) {
    for (const path of reads)
      expect((await buildApp(role, userId).request(path)).status, `${role} GET ${path}`).toBe(403)
    for (const [path, body] of writes)
      expect((await postJson(buildApp(role, userId), path, body)).status, `${role} POST ${path}`).toBe(403)
  }
})

it("cuenta y cobro: reception/dentist 403, cashier cobra con ticket, tenancy", async () => {
  const accountPath = `/patients/${PAT_A}/account`
  expect((await buildApp("reception", RECEP).request(accountPath)).status).toBe(403)
  expect((await buildApp("dentist", DENT1).request(accountPath)).status).toBe(403)
  expect((await buildApp("cashier", CASH).request(accountPath)).status).toBe(200)
  // Tenant: la cuenta de org_fin_a no existe en org_fin_b.
  expect((await buildApp("admin", ADMIN_B, ORG_B).request(accountPath)).status).toBe(404)

  // Adelanto con medios válidos: el 403 de rol no lo mascara la validación.
  const collectBody = (methodId: string) => ({
    branchId: BRANCH_A,
    advanceCents: 5000,
    payments: [{ paymentMethodId: methodId, amountCents: 5000 }],
    requestId: crypto.randomUUID(),
  })
  expect((await postJson(buildApp("reception", RECEP), `/patients/${PAT_A}/collect`, collectBody(CASH_A))).status).toBe(403)
  expect((await postJson(buildApp("dentist", DENT1), `/patients/${PAT_A}/collect`, collectBody(CASH_A))).status).toBe(403)
  const collected = await postJson(buildApp("cashier", CASH), `/patients/${PAT_A}/collect`, collectBody(CASH_A))
  expect(collected.status).toBe(201)
  expect(TicketData.parse(await collected.json()).data.ticket.id).toBeTruthy()
})

it("presupuestos: reception fuera, cashier decide sin escribir, dentist solo plan propio", async () => {
  const listPath = `/patients/${PAT_A}/budgets`
  const detailPath = `/patients/${PAT_A}/budgets/${BUDGET1}`
  expect((await buildApp("reception", RECEP).request(listPath)).status).toBe(403)
  expect((await buildApp("reception", RECEP).request(detailPath)).status).toBe(403)
  expect((await buildApp("cashier", CASH).request(listPath)).status).toBe(200)
  expect((await buildApp("cashier", CASH).request(detailPath)).status).toBe(200)
  expect((await buildApp("dentist", DENT1).request(listPath)).status).toBe(200)
  // Plan de DENT1: DENT2 no ve ajenos en lista (200 filtrada a planes propios:
  // vacía, sin importes de otro) ni lee detalle aunque tenga budgets.*.
  const dent2List = await buildApp("dentist", DENT2).request(listPath)
  expect(dent2List.status).toBe(200)
  const dent2Budgets = IdList.parse(await dent2List.json())
  expect(dent2Budgets.data).toEqual([])
  expect(dent2Budgets.data.map((b) => b.id)).not.toContain(BUDGET1)
  expect((await buildApp("dentist", DENT2).request(detailPath)).status).toBe(403)

  // La hoja en PDF y las opciones de envío respetan la misma frontera que la
  // pantalla: un odontólogo no obtiene el presupuesto de un plan ajeno.
  const pdfPath = `/patients/${PAT_A}/financial-document-pdf?documentType=budget&documentId=${BUDGET1}`
  const optionsPath = `/patients/${PAT_A}/financial-document-options?documentType=budget&documentId=${BUDGET1}`
  expect((await buildApp("dentist", DENT2).request(pdfPath)).status).toBe(403)
  expect((await buildApp("dentist", DENT2).request(optionsPath)).status).toBe(403)
  expect((await buildApp("reception", RECEP).request(pdfPath)).status).toBe(403)
  const ownPdf = await buildApp("dentist", DENT1).request(pdfPath)
  expect(ownPdf.status).toBe(200)
  expect(ownPdf.headers.get("content-type")).toBe("application/pdf")
  expect(Buffer.from(await ownPdf.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe("%PDF-")

  // Caja recibe el presupuesto como documento económico: precio y decisión,
  // sin pieza, superficies ni códigos de procedimiento.
  const forCashier = (await (await buildApp("cashier", CASH).request(detailPath)).json()) as {
    data: { totalCents: number | null; items: Array<{ title: string; priceCents: number | null; toothNumber: number | null; surfaces: string[]; codings: unknown[] }> }
  }
  expect(forCashier.data.items.length).toBeGreaterThan(0)
  expect(forCashier.data.items.every((line) => line.title.length > 0 && line.priceCents !== null)).toBe(true)
  expect(
    forCashier.data.items.every(
      (line) => line.toothNumber === null && line.surfaces.length === 0 && line.codings.length === 0,
    ),
  ).toBe(true)

  // Escritura: reception y cashier 403 con cuerpo válido; DENT2 403 sobre plan ajeno.
  const createBody = { planId: PLAN_A, itemIds: [ITEM3] }
  expect((await postJson(buildApp("reception", RECEP), listPath, createBody)).status).toBe(403)
  expect((await postJson(buildApp("cashier", CASH), listPath, createBody)).status).toBe(403)
  expect((await postJson(buildApp("dentist", DENT2), listPath, createBody)).status).toBe(403)

  // Servicio real al comprobar propio: DENT1 crea sobre su plan.
  const own = await postJson(buildApp("dentist", DENT1), listPath, createBody)
  expect(own.status).toBe(201)
  const ownId = IdData.parse(await own.json()).data.id

  // Decisión sobre presupuesto presentado (ITEM1): reception y plan ajeno 403.
  const decisionPath = `/patients/${PAT_A}/budgets/${BUDGET1}/decision`
  const decisionBody = { decisions: [{ planItemId: ITEM1, decision: "aceptado" }] }
  expect((await postJson(buildApp("reception", RECEP), decisionPath, decisionBody)).status).toBe(403)
  expect((await postJson(buildApp("dentist", DENT2), decisionPath, decisionBody)).status).toBe(403)
  // Cashier decide sin clínica (budgets.decide) con servicio real.
  expect((await postJson(buildApp("cashier", CASH), decisionPath, decisionBody)).status).toBe(200)

  // DENT1 decide su propio presupuesto de punta a punta vía API.
  const deliverPath = `/patients/${PAT_A}/budgets/${ownId}/deliver`
  expect((await postJson(buildApp("dentist", DENT1), deliverPath, {})).status).toBe(200)
  const ownDecision = await postJson(buildApp("dentist", DENT1), `/patients/${PAT_A}/budgets/${ownId}/decision`, {
    decisions: [{ planItemId: ITEM3, decision: "aceptado" }],
  })
  expect(ownDecision.status).toBe(200)
})

it("comisiones: dentist propias sin ajenas ni resultado; cashier sin commissions.read; admin configura", async () => {
  const month = "year=2026&month=9&currency=PEN"
  expect((await buildApp("member", MEMBER).request(`/commissions/my?${month}`)).status).toBe(403)
  expect((await buildApp("reception", RECEP).request(`/commissions/my?${month}`)).status).toBe(403)

  const dent2 = buildApp("dentist", DENT2)
  expect((await dent2.request(`/commissions/my?${month}`)).status).toBe(200)
  expect((await dent2.request(`/commissions/monthly?professionalUserId=${DENT1}&${month}`)).status).toBe(403)
  expect((await dent2.request(`/commissions/monthly-result?year=2026&month=9`)).status).toBe(403)
  const rateBody = { professionalUserId: DENT2, rateBps: 4000 }
  expect((await dent2.request("/commissions/rates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rateBody),
  })).status).toBe(403)
  const payBody = { professionalUserId: DENT2, year: 2026, month: 9, branchId: BRANCH_A }
  expect((await postJson(dent2, "/commissions/pay", payBody)).status).toBe(403)
  // El mes de toda la clínica y los pagos de otro son de administración.
  expect((await dent2.request(`/commissions/month?${month}`)).status).toBe(403)
  expect((await dent2.request(`/commissions/payments?professionalUserId=${DENT1}`)).status).toBe(403)
  expect((await dent2.request("/commissions/payments")).status).toBe(200)

  // Caja no ve comisiones ni el resultado del mes, que es de quien dirige la clínica.
  const cashier = buildApp("cashier", CASH)
  expect((await cashier.request(`/commissions/monthly-result?year=2026&month=9`)).status).toBe(403)
  expect((await cashier.request(`/commissions/my?${month}`)).status).toBe(403)
  expect((await cashier.request(`/commissions/month?${month}`)).status).toBe(403)
  expect((await cashier.request("/commissions/rates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rateBody),
  })).status).toBe(403)
  expect((await postJson(cashier, "/commissions/pay", { ...payBody, professionalUserId: DENT1 })).status).toBe(403)

  const admin = buildApp("admin", ADMIN)
  expect((await admin.request("/commissions/rates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ professionalUserId: DENT1, rateBps: 4000 }),
  })).status).toBe(200)
  expect((await admin.request(`/commissions/month?${month}`)).status).toBe(200)
  expect((await admin.request(`/commissions/monthly-result?year=2026&month=9`)).status).toBe(200)
  // Sin cobros no hay nada que pagar: se rechaza sin registrar un gasto.
  const nothing = await postJson(admin, "/commissions/pay", { ...payBody, professionalUserId: DENT1 })
  expect(nothing.status).toBe(409)
})

it("tenancy: medios, caja y presupuestos aislados por organización", async () => {
  const appB = buildApp("admin", ADMIN_B, ORG_B)
  const methodsB = IdList.parse(await (await appB.request("/org/payment-methods?activeOnly=0")).json())
  const idsB = methodsB.data.map((m) => m.id)
  expect(idsB).toContain(CASH_B)
  expect(idsB).not.toContain(CASH_A)
  expect(idsB).not.toContain(CARD_A)
  // PATCH cruzado: el medio de org_fin_a no existe en org_fin_b.
  expect((await appB.request(`/org/payment-methods/${CASH_A}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Intruso" }),
  })).status).toBe(404)
  // Caja con sede ajena: la sede de org_fin_a no existe en org_fin_b.
  expect((await appB.request(`/finance/cash?branchId=${BRANCH_A}`)).status).toBe(404)
  // Presupuesto ajeno: el paciente de org_fin_a no existe en org_fin_b.
  expect((await appB.request(`/patients/${PAT_A}/budgets`)).status).toBe(404)
  expect(PAT_B).toBeTruthy()
  expect(ITEM2).toBeTruthy()
})
