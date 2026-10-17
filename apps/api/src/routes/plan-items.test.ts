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
import { createPatientsRoute } from "./patients.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))

// Catálogo semilla del test (org_a + una fila de org_b para aislamiento).
const SVC_LIMPIEZA = "a1111111-1111-4111-8111-111111111111"
const SVC_ENDO = "a2222222-2222-4222-8222-222222222222"
const SVC_USD = "a3333333-3333-4333-8333-333333333333"
const SVC_CONSULTA = "a5555555-5555-4555-8555-555555555555"
const SVC_INACTIVO = "a4444444-4444-4444-8444-444444444444"
const SVC_OTRA_ORG = "b5555555-5555-4555-8555-555555555555"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

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

function stubOrg(role: string) {
  return async (c: Context, next: Next) => {
    c.set("orgId", "org_a")
    c.set("userId", "u-1")
    c.set("memberRole", role)
    await next()
  }
}

function buildApp(role: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", stubOrg(role))
  app.route("/patients", createPatientsRoute(deps))
  return app
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
    sql`with "release" as (
      insert into "diagnosis_code_release" ("system_key", "edition", "official", "license", "code_count")
      values ('ICD-10', 'prueba', false, 'Solo pruebas', 0) on conflict do nothing
    )
    insert into "diagnosis_code" ("system_key", "code", "edition", "title", "is_dental", "search_text")
    select 'ICD-10', v.code, 'prueba', v.title, v.code like 'K%', lower(v.code || ' ' || replace(v.code, '.', '') || ' ' || v.title)
    from (values
        ('K02.1', 'Caries de la dentina'),
        ('K04.0', 'Pulpitis'),
        ('Z01.2', 'Examen dental')) as v(code, title)
    on conflict do nothing`,
  )
  await ownerDb.execute(
    sql`insert into "service_catalog" ("id", "organization_id", "source", "code", "name", "scope", "price_cents", "currency", "duration_min", "is_active") values
        (${SVC_CONSULTA}, 'org_a', 'custom', 'CONSULTA', 'Consulta', 'general', 5000, 'PEN', 30, true),
        (${SVC_LIMPIEZA}, 'org_a', 'custom', 'LIMPIEZA', 'Limpieza dental', 'tooth', 12000, 'PEN', 45, true),
        (${SVC_ENDO}, 'org_a', 'custom', 'ENDODONCIA', 'Endodoncia', 'tooth', 45000, 'PEN', 90, true),
        (${SVC_USD}, 'org_a', 'custom', 'IMPLANTE', 'Implante', 'general', 50000, 'USD', 60, true),
        (${SVC_INACTIVO}, 'org_a', 'custom', 'VIEJO', 'Servicio viejo', 'tooth', 1000, 'PEN', 30, false),
        (${SVC_OTRA_ORG}, 'org_b', 'custom', 'OTRO', 'Otro servicio', 'tooth', 999, 'PEN', 15, true)
        on conflict ("id") do nothing`,
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

interface ErrorBody {
  error: { code: string; message: string }
}

interface PlanItem {
  id: string
  serviceId: string | null
  planId: string
  budgetId: string | null
  title: string
  detail: string | null
  toothNumber: number | null
  diagnosisCode: string | null
  priceCents: number | null
  currency: string
  status: string
  decision: string
  sourceEncounterId: string | null
}

interface BudgetLine {
  planItemId: string
  decision: string
  priceCents: number | null
}

interface BudgetTotals {
  id: string
  status: string
  currency: string
  items: BudgetLine[]
  totalCents: number | null
  acceptedCents: number | null
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function patchJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
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

async function createFreshPatient(app: Hono, name: string): Promise<string> {
  const res = await postJson(app, "/patients", registrationBody(`${name} ${crypto.randomUUID()}`))
  expect(res.status).toBe(201)
  const body = await res.json() as { data: { id: string } }
  return body.data.id
}

/** Atención borrador: origen obligatorio de planes e indicaciones. */
async function createDraftEncounter(app: Hono, patientId: string): Promise<string> {
  const res = await postJson(app, `/patients/${patientId}/encounters`, { reason: "Evaluación" })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}

async function createPlan(
  app: Hono,
  patientId: string,
  encounterId: string,
  title = "Plan",
): Promise<string> {
  const res = await postJson(app, `/patients/${patientId}/plans`, {
    title,
    originEncounterId: encounterId,
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}

/** Contexto completo de indicación: borrador + plan del mismo paciente. */
async function setupPlan(
  app: Hono,
  patientId: string,
): Promise<{ planId: string; encounterId: string }> {
  const encounterId = await createDraftEncounter(app, patientId)
  const planId = await createPlan(app, patientId, encounterId)
  return { planId, encounterId }
}

async function addItem(
  app: Hono,
  patientId: string,
  ctx: { planId: string; encounterId: string },
  item: Record<string, unknown>,
): Promise<PlanItem> {
  const res = await postJson(app, `/patients/${patientId}/plan/items`, {
    ...item,
    planId: ctx.planId,
    sourceEncounterId: ctx.encounterId,
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: PlanItem }
  return body.data
}

async function createBudget(
  app: Hono,
  patientId: string,
  planId: string,
  itemIds: string[],
  title = "Presupuesto",
): Promise<string> {
  const res = await postJson(app, `/patients/${patientId}/budgets`, { planId, itemIds, title })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}

async function deliverBudget(app: Hono, patientId: string, budgetId: string): Promise<void> {
  const res = await postJson(app, `/patients/${patientId}/budgets/${budgetId}/deliver`, {})
  expect(res.status).toBe(200)
}

async function decideBudget(
  app: Hono,
  patientId: string,
  budgetId: string,
  acceptedItemIds: string[],
): Promise<BudgetTotals> {
  const detail = await app.request(`/patients/${patientId}/budgets/${budgetId}`)
  const budget = (await detail.json()) as { data: { items: Array<{ planItemId: string }> } }
  const res = await postJson(app, `/patients/${patientId}/budgets/${budgetId}/decision`, {
    decisions: budget.data.items.map(line => ({ planItemId: line.planItemId, decision: acceptedItemIds.includes(line.planItemId) ? "aceptado" : "rechazado" })),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: BudgetTotals }
  return body.data
}

it("plan: POST 201 congela snapshot de la oferta y GET lista {data}", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Add")
  const ctx = await setupPlan(app, patientId)
  const item = await addItem(app, patientId, ctx, {
    serviceId: SVC_LIMPIEZA,
    detail: "Limpieza pieza 36",
    toothNumber: 36,
    diagnosisCode: "K02.1",
  })
  expect(item.serviceId).toBe(SVC_LIMPIEZA)
  expect(item.title).toBe("Limpieza dental")
  expect(item.detail).toBe("Limpieza pieza 36")
  expect(item.toothNumber).toBe(36)
  expect(item.diagnosisCode).toBe("K02.1")
  expect(item.priceCents).toBe(12000)
  expect(item.status).toBe("pendiente")
  expect(item.decision).toBe("pendiente")
  expect(item.budgetId).toBeNull()
  expect(item.currency).toBe("PEN")
  expect(item.sourceEncounterId).toBe(ctx.encounterId)

  const list = await app.request(`/patients/${patientId}/plan`, { method: "GET" })
  expect(list.status).toBe(200)
  const listed = (await list.json()) as { data: PlanItem[] }
  expect(listed.data.map((row) => row.id)).toContain(item.id)
})

it("plan: PATCH edita con atención borrador como contexto; cambiar oferta re-congela", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Update")
  const ctx = await setupPlan(app, patientId)
  const item = await addItem(app, patientId, ctx, {
    serviceId: SVC_LIMPIEZA,
    detail: "Detalle inicial",
    toothNumber: 36,
    diagnosisCode: "K02.1",
  })

  const res = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    encounterId: ctx.encounterId,
    detail: "Detalle editado",
    toothNumber: 37,
    diagnosisCode: "K04.0",
  })
  expect(res.status).toBe(200)
  const updated = (await res.json()) as { data: PlanItem }
  expect(updated.data.detail).toBe("Detalle editado")
  expect(updated.data.priceCents).toBe(12000)
  expect(updated.data.toothNumber).toBe(37)
  expect(updated.data.diagnosisCode).toBe("K04.0")
  expect(updated.data.status).toBe("pendiente")

  const changed = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    encounterId: ctx.encounterId,
    serviceId: SVC_ENDO,
  })
  expect(changed.status).toBe(200)
  const changedBody = (await changed.json()) as { data: PlanItem }
  expect(changedBody.data.serviceId).toBe(SVC_ENDO)
  expect(changedBody.data.title).toBe("Endodoncia")
  expect(changedBody.data.priceCents).toBe(45000)
})

it("plan: reenviar la misma oferta no actualiza el precio histórico", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Snapshot")
  const ctx = await setupPlan(app, patientId)
  const item = await addItem(app, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })

  // La oferta sube de precio después de indicar el tratamiento.
  await ownerDb.execute(
    sql`update "service_catalog" set "price_cents" = 99999 where "id" = ${SVC_LIMPIEZA}`,
  )
  try {
    const res = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
      encounterId: ctx.encounterId,
      serviceId: SVC_LIMPIEZA,
      detail: "Control sin repricing",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: PlanItem }
    expect(body.data.priceCents).toBe(12000)
    expect(body.data.detail).toBe("Control sin repricing")

    // Un cambio real de oferta sí congela el precio nuevo.
    const changed = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
      encounterId: ctx.encounterId,
      serviceId: SVC_ENDO,
    })
    expect(changed.status).toBe(200)
    const changedBody = (await changed.json()) as { data: PlanItem }
    expect(changedBody.data.priceCents).toBe(45000)
  } finally {
    await ownerDb.execute(
      sql`update "service_catalog" set "price_cents" = 12000 where "id" = ${SVC_LIMPIEZA}`,
    )
  }
})

it("plan: programar exige decisión aceptada en la línea vigente", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Programado")
  const ctx = await setupPlan(app, patientId)
  const item = await addItem(app, patientId, ctx, { serviceId: SVC_ENDO, toothNumber: 36 })

  // En borrador el contenido sigue editable (con contexto de atención).
  const edited = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    encounterId: ctx.encounterId,
    detail: "Endodoncia a programar",
  })
  expect(edited.status).toBe(200)
  expect(((await edited.json()) as { data: PlanItem }).data.detail).toBe("Endodoncia a programar")

  // Sin decisión del presupuesto no se puede programar.
  const denied = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    encounterId: ctx.encounterId,
    status: "programado",
  })
  expect(denied.status).toBe(409)
  expect(((await denied.json()) as ErrorBody).error.code).toBe("ITEM_NOT_ACCEPTED")

  const budgetId = await createBudget(app, patientId, ctx.planId, [item.id])
  await deliverBudget(app, patientId, budgetId)
  await decideBudget(app, patientId, budgetId, [item.id])

  const scheduled = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    encounterId: ctx.encounterId,
    status: "programado",
  })
  expect(scheduled.status).toBe(200)
  const scheduledBody = (await scheduled.json()) as { data: PlanItem }
  expect(scheduledBody.data.status).toBe("programado")
  expect(scheduledBody.data.decision).toBe("aceptado")
})

it("plan: realizar exige decisión aceptada y atención; manual sin atención responde 409", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Manual")
  const ctx = await setupPlan(app, patientId)
  const item = await addItem(app, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })

  const denied = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    encounterId: ctx.encounterId,
    status: "realizado",
  })
  expect(denied.status).toBe(409)
  expect(((await denied.json()) as ErrorBody).error.code).toBe("INVALID_TRANSITION")

  const budgetId = await createBudget(app, patientId, ctx.planId, [item.id])
  await deliverBudget(app, patientId, budgetId)
  await decideBudget(app, patientId, budgetId, [item.id])
  expect((await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    encounterId: ctx.encounterId, status: "programado",
  })).status).toBe(200)

  // Aceptado pero sin procedimiento en atención: el realizado manual no existe.
  const manual = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    encounterId: ctx.encounterId,
    status: "realizado",
  })
  expect(manual.status).toBe(409)
  expect(((await manual.json()) as ErrorBody).error.code).toBe("ATTENTION_REQUIRED")
})

it("plan: contenido en realizado/cancelado responde 409 ITEM_CLOSED", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Cerrado")
  const ctx = await setupPlan(app, patientId)
  const done = await addItem(app, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })
  const undone = await addItem(app, patientId, ctx, { serviceId: SVC_ENDO, toothNumber: 46 })
  const budgetId = await createBudget(app, patientId, ctx.planId, [done.id, undone.id])
  await deliverBudget(app, patientId, budgetId)
  await decideBudget(app, patientId, budgetId, [done.id])

  // El realizado siempre pasa por un procedimiento en la atención de origen.
  const realized = await postJson(
    app,
    `/patients/${patientId}/encounters/${ctx.encounterId}/procedures`,
    { planItemId: done.id },
  )
  expect(realized.status).toBe(201)
  expect((await postJson(app, `/patients/${patientId}/treatments/${done.id}/complete`, {
    encounterId: ctx.encounterId,
  })).status).toBe(200)
  // La cancelación clínica no exige aceptación, pero sí bloquea si ya está realizado.
  expect(
    (
      await patchJson(app, `/patients/${patientId}/plan/items/${undone.id}`, {
        encounterId: ctx.encounterId,
        status: "cancelado",
        statusReason: "No continuará este tratamiento",
      })
    ).status,
  ).toBe(200)

  const editDone = await patchJson(app, `/patients/${patientId}/plan/items/${done.id}`, {
    encounterId: ctx.encounterId,
    detail: "Cambio tardío",
  })
  expect(editDone.status).toBe(409)
  const editDoneBody = (await editDone.json()) as { error: { code: string } }
  expect(editDoneBody.error.code).toBe("ITEM_CLOSED")

  const editUndone = await patchJson(app, `/patients/${patientId}/plan/items/${undone.id}`, {
    encounterId: ctx.encounterId,
    detail: "Cambio tardío",
  })
  expect(editUndone.status).toBe(409)
  const editUndoneBody = (await editUndone.json()) as { error: { code: string } }
  expect(editUndoneBody.error.code).toBe("ITEM_CLOSED")
})

it("plan: realizado es terminal; reabrir o cancelar ejecutado responde 409 ITEM_CLOSED", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Terminal")
  const ctx = await setupPlan(app, patientId)
  const item = await addItem(app, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })
  const budgetId = await createBudget(app, patientId, ctx.planId, [item.id])
  await deliverBudget(app, patientId, budgetId)
  await decideBudget(app, patientId, budgetId, [item.id])
  const closed = await postJson(
    app,
    `/patients/${patientId}/encounters/${ctx.encounterId}/procedures`,
    { planItemId: item.id },
  )
  expect(closed.status).toBe(201)
  expect((await postJson(app, `/patients/${patientId}/treatments/${item.id}/complete`, {
    encounterId: ctx.encounterId,
  })).status).toBe(200)

  for (const status of ["pendiente", "programado", "cancelado"]) {
    const reopened = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
      encounterId: ctx.encounterId,
      status,
    })
    expect(reopened.status).toBe(409)
    expect(((await reopened.json()) as ErrorBody).error.code).toBe("ITEM_CLOSED")
  }

  const edited = await patchJson(app, `/patients/${patientId}/plan/items/${item.id}`, {
    encounterId: ctx.encounterId,
    detail: "Cambio tardío",
  })
  expect(edited.status).toBe(409)
  expect(((await edited.json()) as ErrorBody).error.code).toBe("ITEM_CLOSED")
})

it("plan: presupuesto exige ítems del plan con moneda única y tarifa conocida", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Moneda")
  const ctx = await setupPlan(app, patientId)
  const pen = await addItem(app, patientId, ctx, { serviceId: SVC_CONSULTA })
  const usd = await addItem(app, patientId, ctx, { serviceId: SVC_USD })

  const mixed = await postJson(app, `/patients/${patientId}/budgets`, {
    planId: ctx.planId,
    itemIds: [pen.id, usd.id],
  })
  expect(mixed.status).toBe(409)
  expect(((await mixed.json()) as ErrorBody).error.code).toBe("BUDGET_CURRENCY_MIX")

  // Cuerpo viejo sin plan se rechaza.
  const legacy = await postJson(app, `/patients/${patientId}/budgets`, { title: "Viejo" })
  expect(legacy.status).toBe(400)

  // Cambiar a una oferta de otra moneda rompe la homogeneidad del borrador.
  const budgetId = await createBudget(app, patientId, ctx.planId, [pen.id])
  const mixedPatch = await patchJson(app, `/patients/${patientId}/plan/items/${pen.id}`, {
    encounterId: ctx.encounterId,
    serviceId: SVC_USD,
  })
  expect(mixedPatch.status).toBe(409)
  expect(((await mixedPatch.json()) as ErrorBody).error.code).toBe("BUDGET_CURRENCY_MIX")

  expect(budgetId).toBeTruthy()
  expect(usd).toBeTruthy()
})

it("plan: entrada manual (title/price/currency) y sin plan responde 400", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Manual Rechazo")
  const ctx = await setupPlan(app, patientId)
  for (const payload of [
    {
      serviceId: SVC_LIMPIEZA,
      planId: ctx.planId,
      sourceEncounterId: ctx.encounterId,
      title: "Intruso",
    },
    {
      serviceId: SVC_LIMPIEZA,
      planId: ctx.planId,
      sourceEncounterId: ctx.encounterId,
      priceCents: 100,
    },
    {
      serviceId: SVC_LIMPIEZA,
      planId: ctx.planId,
      sourceEncounterId: ctx.encounterId,
      currency: "PEN",
    },
    { serviceId: SVC_LIMPIEZA },
    {
      title: "Sin servicio",
      priceCents: 100,
      planId: ctx.planId,
      sourceEncounterId: ctx.encounterId,
    },
  ]) {
    const res = await postJson(app, `/patients/${patientId}/plan/items`, payload)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("VALIDATION")
  }
})

it("plan: oferta inactiva, inexistente u otra org no crea ítem", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Servicio Malo")
  const ctx = await setupPlan(app, patientId)
  const inactive = await postJson(app, `/patients/${patientId}/plan/items`, {
    serviceId: SVC_INACTIVO,
    planId: ctx.planId,
    sourceEncounterId: ctx.encounterId,
  })
  expect(inactive.status).toBe(409)
  expect(((await inactive.json()) as ErrorBody).error.code).toBe("SERVICE_INACTIVE")

  const missing = await postJson(app, `/patients/${patientId}/plan/items`, {
    serviceId: "c0000000-0000-4000-8000-000000000000",
    planId: ctx.planId,
    sourceEncounterId: ctx.encounterId,
  })
  expect(missing.status).toBe(404)

  const foreign = await postJson(app, `/patients/${patientId}/plan/items`, {
    serviceId: SVC_OTRA_ORG,
    planId: ctx.planId,
    sourceEncounterId: ctx.encounterId,
  })
  expect(foreign.status).toBe(404)

  const missingPlan = await postJson(app, `/patients/${patientId}/plan/items`, {
    serviceId: SVC_LIMPIEZA,
    planId: "c0000000-0000-4000-8000-000000000000",
    sourceEncounterId: ctx.encounterId,
  })
  expect(missingPlan.status).toBe(404)
})

it("plan: FDI inválida y CIE10 inexistente responden 400", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Inválido")
  const ctx = await setupPlan(app, patientId)
  const cases: Record<string, unknown>[] = [
    {
      serviceId: SVC_LIMPIEZA,
      planId: ctx.planId,
      sourceEncounterId: ctx.encounterId,
      toothNumber: 99,
    },
    {
      serviceId: SVC_LIMPIEZA,
      planId: ctx.planId,
      sourceEncounterId: ctx.encounterId,
      diagnosisCode: "Z99.9",
    },
  ]
  for (const payload of cases) {
    const res = await postJson(app, `/patients/${patientId}/plan/items`, payload)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("VALIDATION")
  }
})

it("plan: ítem de otro paciente responde 404", async () => {
  const app = buildApp("admin")
  const patientA = await createFreshPatient(app, "Plan Paciente A")
  const patientB = await createFreshPatient(app, "Plan Paciente B")
  const ctxA = await setupPlan(app, patientA)
  await setupPlan(app, patientB)
  const item = await addItem(app, patientA, ctxA, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })

  const res = await patchJson(app, `/patients/${patientB}/plan/items/${item.id}`, {
    encounterId: ctxA.encounterId,
    detail: "Intruso",
  })
  expect(res.status).toBe(404)
  const body = (await res.json()) as { error: { code: string } }
  expect(body.error.code).toBe("NOT_FOUND")

  const list = await app.request(`/patients/${patientB}/plan`, { method: "GET" })
  expect(list.status).toBe(200)
  const listed = (await list.json()) as { data: PlanItem[] }
  expect(listed.data.map((row) => row.id)).not.toContain(item.id)
})

it("plan: summary separa totales por moneda sin sumar distinto dinero", async () => {
  const app = buildApp("admin")
  const mixed = await createFreshPatient(app, "Plan Mixto")
  const mixedCtx = await setupPlan(app, mixed)
  const mixedPenPlan = await createPlan(app, mixed, mixedCtx.encounterId, "Mixto PEN")
  const penItem = await addItem(
    app,
    mixed,
    { planId: mixedPenPlan, encounterId: mixedCtx.encounterId },
    { serviceId: SVC_LIMPIEZA, toothNumber: 36 },
  )
  const mixedUsdPlan = await createPlan(app, mixed, mixedCtx.encounterId, "Mixto USD")
  const usdItem = await addItem(
    app,
    mixed,
    { planId: mixedUsdPlan, encounterId: mixedCtx.encounterId },
    { serviceId: SVC_USD },
  )
  // Un solo borrador por persona: el segundo se prepara cuando el primero ya salió.
  const mixedPen = await createBudget(app, mixed, mixedPenPlan, [penItem.id])
  await deliverBudget(app, mixed, mixedPen)
  await decideBudget(app, mixed, mixedPen, [penItem.id])
  const mixedUsd = await createBudget(app, mixed, mixedUsdPlan, [usdItem.id])
  await deliverBudget(app, mixed, mixedUsd)
  await decideBudget(app, mixed, mixedUsd, [usdItem.id])

  const res = await app.request(`/patients/${mixed}/summary`, { method: "GET" })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    data: {
      planPending: {
        count: number
        totalCents: number | null
        currency: string | null
        totals: { currency: string; count: number; totalCents: number }[]
      }
    }
  }
  expect(body.data.planPending.count).toBe(2)
  expect(body.data.planPending.totalCents).toBeNull()
  expect(body.data.planPending.currency).toBeNull()
  expect(body.data.planPending.totals).toEqual([
    { currency: "PEN", count: 1, totalCents: 12000 },
    { currency: "USD", count: 1, totalCents: 50000 },
  ])

  const single = await createFreshPatient(app, "Plan Una Moneda")
  const singleCtx = await setupPlan(app, single)
  const singleA = await addItem(app, single, singleCtx, {
    serviceId: SVC_LIMPIEZA,
    toothNumber: 36,
  })
  const singleB = await addItem(app, single, singleCtx, { serviceId: SVC_ENDO, toothNumber: 46 })
  const singleBudget = await createBudget(app, single, singleCtx.planId, [singleA.id, singleB.id])
  await deliverBudget(app, single, singleBudget)
  await decideBudget(app, single, singleBudget, [singleA.id, singleB.id])
  const singleRes = await app.request(`/patients/${single}/summary`, { method: "GET" })
  expect(singleRes.status).toBe(200)
  const singleBody = (await singleRes.json()) as {
    data: {
      planPending: {
        count: number
        totalCents: number | null
        currency: string | null
        totals: { currency: string; count: number; totalCents: number }[]
      }
    }
  }
  expect(singleBody.data.planPending.totalCents).toBe(57000)
  expect(singleBody.data.planPending.currency).toBe("PEN")
  expect(singleBody.data.planPending.totals).toEqual([
    { currency: "PEN", count: 2, totalCents: 57000 },
  ])
})

it("plan batch: crea un ítem por pieza con el mismo snapshot y rechaza precio manual", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Lote")
  const ctx = await setupPlan(app, patientId)
  const res = await postJson(app, `/patients/${patientId}/plan/items/batch`, {
    serviceId: SVC_LIMPIEZA,
    planId: ctx.planId,
    sourceEncounterId: ctx.encounterId,
    toothNumbers: [36, 37, 38],
    detail: "Sellantes",
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: PlanItem[] }
  expect(body.data).toHaveLength(3)
  expect(body.data.map((row) => row.toothNumber).sort()).toEqual([36, 37, 38])
  for (const row of body.data) {
    expect(row.serviceId).toBe(SVC_LIMPIEZA)
    expect(row.title).toBe("Limpieza dental")
    expect(row.priceCents).toBe(12000)
    expect(row.currency).toBe("PEN")
  }

  const manual = await postJson(app, `/patients/${patientId}/plan/items/batch`, {
    serviceId: SVC_LIMPIEZA,
    planId: ctx.planId,
    sourceEncounterId: ctx.encounterId,
    toothNumbers: [36],
    priceCents: 100,
  })
  expect(manual.status).toBe(400)
})

it("plan batch: lote inválido hace rollback sin parciales", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Lote Rollback")
  const ctx = await setupPlan(app, patientId)
  const res = await postJson(app, `/patients/${patientId}/plan/items/batch`, {
    serviceId: SVC_LIMPIEZA,
    planId: ctx.planId,
    sourceEncounterId: ctx.encounterId,
    toothNumbers: [36, 99],
  })
  expect(res.status).toBe(400)

  const dup = await postJson(app, `/patients/${patientId}/plan/items/batch`, {
    serviceId: SVC_LIMPIEZA,
    planId: ctx.planId,
    sourceEncounterId: ctx.encounterId,
    toothNumbers: [36, 36],
  })
  expect(dup.status).toBe(400)

  const list = await app.request(`/patients/${patientId}/plan`, { method: "GET" })
  expect(list.status).toBe(200)
  const listed = (await list.json()) as { data: PlanItem[] }
  expect(listed.data).toHaveLength(0)
})

it("plan: un histórico sin tarifa no se presenta como gratuito en el resumen", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Histórico sin tarifa")
  const ctx = await setupPlan(app, patientId)
  await addItem(app, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })
  // Legado migrado: sin tarifa y sin decisión registrada, con su línea histórica.
  const planRow = (await ownerDb.execute(
    sql`insert into "treatment_plan" ("organization_id", "patient_id", "title", "is_legacy") values ('org_a', ${patientId}, 'Historial', true) returning "id"`,
  )) as unknown as Array<{ id: string }>
  const legacyPlanId = planRow[0]!.id
  const budgetRow = (await ownerDb.execute(
    sql`insert into "treatment_budget" ("organization_id", "patient_id", "plan_id", "budget_number", "title", "currency", "status") values ('org_a', ${patientId}, ${legacyPlanId}, 97, 'Histórico', 'PEN', 'borrador') returning "id"`,
  )) as unknown as Array<{ id: string }>
  const legacyBudgetId = budgetRow[0]!.id
  // Todo presupuesto tiene al menos una opción, y cada línea es de una.
  const optionRow = (await ownerDb.execute(
    sql`insert into "treatment_budget_option" ("organization_id", "patient_id", "budget_id", "position", "is_recommended") values ('org_a', ${patientId}, ${legacyBudgetId}, 1, true) returning "id"`,
  )) as unknown as Array<{ id: string }>
  const itemRow = (await ownerDb.execute(
    sql`insert into "treatment_plan_item" ("organization_id", "patient_id", "plan_id", "budget_id", "title", "price_cents", "currency", "scope", "status") values ('org_a', ${patientId}, ${legacyPlanId}, ${legacyBudgetId}, 'Tratamiento histórico', null, 'PEN', 'general', 'pendiente') returning "id"`,
  )) as unknown as Array<{ id: string }>
  await ownerDb.execute(
    sql`insert into "treatment_budget_item" ("organization_id", "patient_id", "plan_id", "budget_id", "option_id", "plan_item_id", "title", "currency", "decision") values ('org_a', ${patientId}, ${legacyPlanId}, ${legacyBudgetId}, ${optionRow[0]!.id}, ${itemRow[0]!.id}, 'Tratamiento histórico', 'PEN', 'sin_registro')`,
  )
  // El documento queda retirado (las líneas conservan su snapshot). `historico` ya
  // no existe: es «Anulado».
  await ownerDb.execute(
    sql`update "treatment_budget" set "status" = 'cancelado' where "id" = ${legacyBudgetId}`,
  )
  const response = await app.request(`/patients/${patientId}/summary`)
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    data: {
      planPending: {
        count: number
        unpricedCount: number
        totalCents: number | null
        totals: unknown[]
      }
    }
  }
  expect(body.data.planPending).toMatchObject({ count: 0, unpricedCount: 0, totalCents: 0 })
  expect(body.data.planPending.totals).toEqual([])
})

it("plan: el ítem vive en el plan; el presupuesto solo lo cotiza", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Presupuesto Nuevo")
  const ctx = await setupPlan(app, patientId)
  const item = await addItem(app, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })

  // Un solo borrador por persona (decisión 12): preparar otra vez el mismo ítem
  // devuelve el mismo borrador, sin otra línea ni otro documento.
  const first = await postJson(app, `/patients/${patientId}/budgets`, {
    planId: ctx.planId,
    itemIds: [item.id],
  })
  expect(first.status).toBe(201)
  const firstId = ((await first.json()) as { data: { id: string } }).data.id
  const second = await postJson(app, `/patients/${patientId}/budgets`, {
    planId: ctx.planId,
    itemIds: [item.id],
  })
  expect(second.status).toBe(201)
  const secondBody = (await second.json()) as { data: { id: string; items: unknown[] } }
  expect(secondBody.data.id).toBe(firstId)
  expect(secondBody.data.items).toHaveLength(1)

  // Tras cancelar, el ítem vuelve a ser elegible sin duplicarse.
  const cancel = await postJson(app, `/patients/${patientId}/budgets/${firstId}/cancel`, {})
  expect(cancel.status).toBe(200)
  const third = await postJson(app, `/patients/${patientId}/budgets`, {
    planId: ctx.planId,
    itemIds: [item.id],
  })
  expect(third.status).toBe(201)
  const thirdBody = (await third.json()) as { data: { id: string } }

  // Repetirlo no crea un segundo documento: es el mismo borrador.
  const fourth = await postJson(app, `/patients/${patientId}/budgets`, {
    planId: ctx.planId,
    itemIds: [item.id],
  })
  expect(fourth.status).toBe(201)
  expect(((await fourth.json()) as { data: { id: string } }).data.id).toBe(thirdBody.data.id)

  const detail = await app.request(`/patients/${patientId}/budgets/${thirdBody.data.id}`, {
    method: "GET",
  })
  const detailBody = (await detail.json()) as { data: BudgetTotals }
  expect(detailBody.data.items).toHaveLength(1)
  expect(detailBody.data.items[0]?.planItemId).toBe(item.id)
  expect(detailBody.data.totalCents).toBe(12000)
})

it("plan: plan de otro paciente responde 404 sin crear el ítem", async () => {
  const app = buildApp("admin")
  const patientA = await createFreshPatient(app, "Plan Budget A")
  const patientB = await createFreshPatient(app, "Plan Budget B")
  const ctxA = await setupPlan(app, patientA)
  await setupPlan(app, patientB)

  const cross = await postJson(app, `/patients/${patientB}/plan/items`, {
    serviceId: SVC_LIMPIEZA,
    planId: ctxA.planId,
    sourceEncounterId: ctxA.encounterId,
  })
  expect(cross.status).toBe(404)
  expect(((await cross.json()) as ErrorBody).error.code).toBe("NOT_FOUND")

  const list = await app.request(`/patients/${patientB}/plan`, { method: "GET" })
  expect(((await list.json()) as { data: PlanItem[] }).data).toHaveLength(0)
})

it("plan: decisión parcial congela aceptado/rechazado y el detalle totaliza", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Decisión")
  const ctx = await setupPlan(app, patientId)
  const accepted = await addItem(app, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })
  const rejected = await addItem(app, patientId, ctx, { serviceId: SVC_ENDO, toothNumber: 37 })
  const budgetId = await createBudget(app, patientId, ctx.planId, [accepted.id, rejected.id])
  await deliverBudget(app, patientId, budgetId)

  const decided = await decideBudget(app, patientId, budgetId, [accepted.id])
  expect(decided.items.find((row) => row.planItemId === accepted.id)?.decision).toBe("aceptado")
  expect(decided.items.find((row) => row.planItemId === rejected.id)?.decision).toBe("rechazado")
  expect(decided.totalCents).toBe(57000)
  expect(decided.acceptedCents).toBe(12000)

  // Solo lo aceptado se puede programar; lo rechazado se bloquea.
  const ok = await patchJson(app, `/patients/${patientId}/plan/items/${accepted.id}`, {
    encounterId: ctx.encounterId,
    status: "programado",
  })
  expect(ok.status).toBe(200)
  const no = await patchJson(app, `/patients/${patientId}/plan/items/${rejected.id}`, {
    encounterId: ctx.encounterId,
    status: "programado",
  })
  expect(no.status).toBe(409)
  expect(((await no.json()) as ErrorBody).error.code).toBe("ITEM_NOT_ACCEPTED")

  const detail = await app.request(`/patients/${patientId}/budgets/${budgetId}`, { method: "GET" })
  expect(detail.status).toBe(200)
  const detailBody = (await detail.json()) as { data: BudgetTotals }
  expect(detailBody.data.items).toHaveLength(2)
  expect(detailBody.data.totalCents).toBe(57000)
  expect(detailBody.data.acceptedCents).toBe(12000)
})

it("plan: cancelar conserva la indicación y exige motivo", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Cancelación")
  const ctx = await setupPlan(app, patientId)
  const item = await addItem(app, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })
  const cancelled = await postJson(app, `/patients/${patientId}/treatments/${item.id}/cancel`, {
    reason: "Se descarta tras reevaluación", encounterId: ctx.encounterId,
  })
  expect(cancelled.status).toBe(200)
  expect(((await cancelled.json()) as { data: PlanItem }).data.status).toBe("cancelado")
  const list = await app.request(`/patients/${patientId}/plan`)
  expect(((await list.json()) as { data: PlanItem[] }).data.map(row => row.id)).toContain(item.id)
  expect((await app.request(`/patients/${patientId}/plan/items/${item.id}`, { method: "DELETE" })).status).toBe(404)
})

it("plan: dentist lee 200, member ni lee ni muta ni decide (403 sin efectos)", async () => {
  const admin = buildApp("admin")
  const dentist = buildApp("dentist")
  const member = buildApp("member")
  const patientId = await createFreshPatient(admin, "Plan Permisos")
  const ctx = await setupPlan(admin, patientId)
  const item = await addItem(admin, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })
  const budgetId = await createBudget(admin, patientId, ctx.planId, [item.id])
  await deliverBudget(admin, patientId, budgetId)

  const read = await dentist.request(`/patients/${patientId}/plan`, { method: "GET" })
  expect(read.status).toBe(200)

  const memberRead = await member.request(`/patients/${patientId}/plan`, { method: "GET" })
  expect(memberRead.status).toBe(403)

  const write = await member.request(`/patients/${patientId}/plan/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      serviceId: SVC_ENDO,
      planId: ctx.planId,
      sourceEncounterId: ctx.encounterId,
    }),
  })
  expect(write.status).toBe(403)
  expect(((await write.json()) as ErrorBody).error.code).toBe("FORBIDDEN")

  const decide = await member.request(`/patients/${patientId}/budgets/${budgetId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ acceptedItemIds: [item.id], acceptedByName: "Miembro" }),
  })
  expect(decide.status).toBe(403)
  expect(((await decide.json()) as ErrorBody).error.code).toBe("FORBIDDEN")

  // Sin efectos: el presupuesto sigue presentado y el ítem pendiente de decisión.
  const detail = await admin.request(`/patients/${patientId}/budgets/${budgetId}`, {
    method: "GET",
  })
  const detailBody = (await detail.json()) as { data: BudgetTotals }
  expect(detailBody.data.status).toBe("presentado")
  expect(detailBody.data.items.find((row) => row.planItemId === item.id)?.decision).toBe(
    "pendiente",
  )
  const plan = await admin.request(`/patients/${patientId}/plan`, { method: "GET" })
  expect(((await plan.json()) as { data: PlanItem[] }).data).toHaveLength(1)
})

it("plan: planes del paciente con estado derivado y detalle", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Plan Listado")
  const ctx = await setupPlan(app, patientId)
  const item = await addItem(app, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })

  const listed = (await (
    await app.request(`/patients/${patientId}/plans`, { method: "GET" })
  ).json()) as {
    data: Array<{
      plan: { id: string; title: string }
      status: string
      totalItems: number
      pendingItems: number
    }>
  }
  expect(listed.data).toHaveLength(1)
  expect(listed.data[0]).toMatchObject({ status: "En curso", totalItems: 1, pendingItems: 1 })

  const detail = await app.request(`/patients/${patientId}/plans/${ctx.planId}`, { method: "GET" })
  expect(detail.status).toBe(200)
  const detailBody = (await detail.json()) as {
    data: { plan: { id: string }; status: string; items: PlanItem[]; budgetIds: string[] }
  }
  expect(detailBody.data.items).toHaveLength(1)
  expect(detailBody.data.budgetIds).toEqual([])

  const budgetId = await createBudget(app, patientId, ctx.planId, [item.id])
  const detailQuoted = (await (
    await app.request(`/patients/${patientId}/plans/${ctx.planId}`, { method: "GET" })
  ).json()) as {
    data: { budgetIds: string[] }
  }
  expect(detailQuoted.data.budgetIds).toEqual([budgetId])

  const foreign = await app.request(
    `/patients/${patientId}/plans/c0000000-0000-4000-8000-000000000000`,
    { method: "GET" },
  )
  expect(foreign.status).toBe(404)
})

it("presupuesto: en borrador se añaden y se quitan tratamientos; entregado ya no", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Borrador con casillas")
  const ctx = await setupPlan(app, patientId)
  const first = await addItem(app, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 36 })
  const second = await addItem(app, patientId, ctx, { serviceId: SVC_LIMPIEZA, toothNumber: 37 })
  const budgetId = await createBudget(app, patientId, ctx.planId, [first.id])
  const items = `/patients/${patientId}/budgets/${budgetId}/items`

  // Cuerpo inválido y rol sin permiso: sin efectos.
  expect((await postJson(app, items, { itemIds: [] })).status).toBe(400)
  expect((await postJson(buildApp("cashier"), items, { itemIds: [second.id] })).status).toBe(403)
  expect(
    (await postJson(buildApp("cashier"), `${items}/remove`, { itemIds: [first.id] })).status,
  ).toBe(403)

  const added = await postJson(app, items, { itemIds: [second.id] })
  expect(added.status).toBe(200)
  const addedBody = (await added.json()) as { data: BudgetTotals }
  expect(addedBody.data.items.map((line) => line.planItemId).sort()).toEqual(
    [first.id, second.id].sort(),
  )
  expect(addedBody.data.totalCents).toBe(24000)
  // Ya está en el borrador: no se repite.
  const again = await postJson(app, items, { itemIds: [second.id] })
  expect(again.status).toBe(409)
  expect(((await again.json()) as ErrorBody).error.code).toBe("ITEM_ALREADY_QUOTED")

  const removed = await postJson(app, `${items}/remove`, { itemIds: [first.id] })
  expect(removed.status).toBe(200)
  const removedBody = (await removed.json()) as { data: BudgetTotals }
  expect(removedBody.data.items.map((line) => line.planItemId)).toEqual([second.id])
  expect(removedBody.data.totalCents).toBe(12000)
  // Lo que no está en el borrador no se puede quitar.
  expect((await postJson(app, `${items}/remove`, { itemIds: [first.id] })).status).toBe(404)

  // Entregado, sus tratamientos ya no cambian.
  await deliverBudget(app, patientId, budgetId)
  const late = await postJson(app, `${items}/remove`, { itemIds: [second.id] })
  expect(late.status).toBe(409)
  expect(((await late.json()) as ErrorBody).error.code).toBe("BUDGET_STATUS")
  const lateAdd = await postJson(app, items, { itemIds: [first.id] })
  expect(lateAdd.status).toBe(409)
  expect(((await lateAdd.json()) as ErrorBody).error.code).toBe("BUDGET_STATUS")
})
