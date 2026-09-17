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

interface EncounterRow {
  id: string
  status: string
  reason: string | null
}

interface EncounterDetailBody {
  data: {
    encounter: EncounterRow
    teeth: number[]
    procedures: Array<{ id: string; planItemId: string | null }>
    notes: Array<{ id: string }>
    odontogramEntries: Array<{ id: string }>
    documents: Array<{ id: string }>
    addenda: Array<{ id: string; kind: string; note: string }>
    plannedItems: Array<{ id: string; status: string }>
    indicatedItems: Array<{ id: string; status: string }>
  }
}

interface PlanItemRow {
  id: string
  status: string
  decision: string
  planId: string
  budgetId: string | null
  sourceEncounterId: string | null
}

interface ErrorBody {
  error: { code: string; message: string }
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
  const res = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      registrationBody(`${name} ${crypto.randomUUID().slice(0, 8)}`),
    ),
  })
  expect(res.status).toBe(201)
  const body = await res.json() as { data: { id: string } }
  return body.data.id
}

async function postEncounter(app: Hono, patientId: string, payload: Record<string, unknown>) {
  return app.request(`/patients/${patientId}/encounters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
}

// Plan real antes de cotizar: borrador -> plan -> ítems -> presupuesto -> presentar -> decidir.
async function setupPlan(
  app: Hono,
  patientId: string,
): Promise<{ planId: string; encounterId: string }> {
  const created = await postEncounter(app, patientId, { reason: "Evaluación" })
  expect(created.status).toBe(201)
  const encounterId = ((await created.json()) as { data: { id: string } }).data.id
  const plan = await app.request(`/patients/${patientId}/plans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Plan", originEncounterId: encounterId }),
  })
  expect(plan.status).toBe(201)
  const planId = ((await plan.json()) as { data: { id: string } }).data.id
  return { planId, encounterId }
}
async function createBudget(
  app: Hono,
  patientId: string,
  planId: string,
  itemIds: string[],
): Promise<string> {
  const res = await app.request(`/patients/${patientId}/budgets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planId, itemIds, title: "Presupuesto" }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}
async function addPlanItem(
  app: Hono,
  patientId: string,
  ctx: { planId: string; encounterId: string },
  payload: Record<string, unknown>,
) {
  const res = await app.request(`/patients/${patientId}/plan/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, planId: ctx.planId, sourceEncounterId: ctx.encounterId }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data: PlanItemRow }).data
}

async function presentBudget(app: Hono, patientId: string, budgetId: string): Promise<void> {
  const res = await app.request(`/patients/${patientId}/budgets/${budgetId}/present`, {
    method: "POST",
  })
  expect(res.status).toBe(200)
}

async function decideBudget(
  app: Hono,
  patientId: string,
  budgetId: string,
  acceptedItemIds: string[],
): Promise<void> {
  const res = await app.request(`/patients/${patientId}/budgets/${budgetId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ acceptedItemIds, acceptedByName: "Paciente Test" }),
  })
  expect(res.status).toBe(200)
}

// Cierre con mínimos clínicos: motivo al crear + evolución antes de finalizar.
async function finalizeWithEvolution(
  app: Hono,
  patientId: string,
  encounterId: string,
): Promise<void> {
  const patched = await app.request(`/patients/${patientId}/encounters/${encounterId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ evolution: "Evolución de cierre" }),
  })
  expect(patched.status).toBe(200)
  const finalized = await app.request(`/patients/${patientId}/encounters/${encounterId}/finalize`, {
    method: "POST",
  })
  expect(finalized.status).toBe(200)
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
    sql`insert into "cie10_code" ("code", "description") values
        ('K02.1', 'Caries de la dentina'),
        ('K04.0', 'Pulpitis'),
        ('Z01.2', 'Examen dental')
        on conflict ("code") do nothing`,
  )
  await ownerDb.execute(
    sql`insert into "service_catalog" ("id", "organization_id", "source", "code", "name", "specialty", "scope", "price_cents", "currency", "duration_min", "is_active") values
        ('c1111111-1111-4111-8111-111111111111', 'org_a', 'custom', 'CORONA', 'Corona cerámica', 'protesis', 'tooth', 90000, 'PEN', 60, true),
        ('c4444444-4444-4444-8444-444444444444', 'org_a', 'custom', 'VIEJO', 'Servicio viejo', 'protesis', 'tooth', 1000, 'PEN', 30, false),
        ('d5555555-5555-4555-8555-555555555555', 'org_b', 'custom', 'OTRO', 'Otro servicio', 'protesis', 'tooth', 999, 'PEN', 15, true)
        on conflict ("id") do nothing`,
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("encounters: POST borrador 201 y segundo borrador 409 DRAFT_OPEN", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Borrador Unico")

  const first = await postEncounter(app, patientId, { reason: "Dolor molar" })
  expect(first.status).toBe(201)
  const firstBody = (await first.json()) as { data: EncounterRow }
  expect(firstBody.data.status).toBe("borrador")

  const second = await postEncounter(app, patientId, { reason: "Otro motivo" })
  expect(second.status).toBe(409)
  const err = (await second.json()) as ErrorBody
  expect(err.error.code).toBe("DRAFT_OPEN")
})

it("encounters: POST simultáneos resuelven uno 201 y otro 409 DRAFT_OPEN", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Borrador Carrera")

  const [a, b] = await Promise.all([
    postEncounter(app, patientId, { reason: "Carrera A" }),
    postEncounter(app, patientId, { reason: "Carrera B" }),
  ])
  const statuses = [a.status, b.status].sort()
  expect(statuses).toEqual([201, 409])
  const loser = a.status === 409 ? a : b
  const err = (await loser.json()) as ErrorBody
  expect(err.error.code).toBe("DRAFT_OPEN")
})

it("encounters: PATCH reason/teeth reemplaza y el detalle lo refleja", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Borrador Edicion")

  const created = await postEncounter(app, patientId, { reason: "Motivo inicial", teeth: [11] })
  expect(created.status).toBe(201)
  const createdBody = (await created.json()) as { data: EncounterRow }
  const encounterId = createdBody.data.id

  const patched = await app.request(`/patients/${patientId}/encounters/${encounterId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Motivo corregido", teeth: [36] }),
  })
  expect(patched.status).toBe(200)
  const patchedBody = (await patched.json()) as { data: EncounterRow }
  expect(patchedBody.data.reason).toBe("Motivo corregido")

  const detail = await app.request(`/patients/${patientId}/encounters/${encounterId}`)
  expect(detail.status).toBe(200)
  const detailBody = (await detail.json()) as EncounterDetailBody
  expect(detailBody.data.encounter.reason).toBe("Motivo corregido")
  expect(detailBody.data.teeth).toEqual([36])
})

it("encounters: finalize 200 y luego PATCH/procedure/nota/odontograma vinculados responden 409 FINALIZED", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Borrador Cierre")

  const created = await postEncounter(app, patientId, { reason: "Cierre" })
  const createdBody = (await created.json()) as { data: EncounterRow }
  const encounterId = createdBody.data.id

  await finalizeWithEvolution(app, patientId, encounterId)
  const done = await app.request(`/patients/${patientId}/encounters/${encounterId}`)
  expect(done.status).toBe(200)
  expect(((await done.json()) as EncounterDetailBody).data.encounter.status).toBe("finalizada")

  const patch = await app.request(`/patients/${patientId}/encounters/${encounterId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Edición tardía" }),
  })
  expect(patch.status).toBe(409)
  expect(((await patch.json()) as ErrorBody).error.code).toBe("FINALIZED")

  const proc = await app.request(`/patients/${patientId}/encounters/${encounterId}/procedures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceId: "c1111111-1111-4111-8111-111111111111" }),
  })
  expect(proc.status).toBe(409)
  expect(((await proc.json()) as ErrorBody).error.code).toBe("FINALIZED")

  const note = await app.request(`/patients/${patientId}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "Nota vinculada tardía", encounterId }),
  })
  expect(note.status).toBe(409)
  expect(((await note.json()) as ErrorBody).error.code).toBe("FINALIZED")

  const odonto = await app.request(`/patients/${patientId}/odontogram/entries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toothNumber: 36, condition: "caries", encounterId }),
  })
  expect(odonto.status).toBe(409)
  expect(((await odonto.json()) as ErrorBody).error.code).toBe("FINALIZED")
})

it("encounters: adenda en borrador 409 NOT_FINALIZED; tras finalizar 201 kind adenda visible en detalle", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Borrador Adenda")

  const created = await postEncounter(app, patientId, { reason: "Con adenda" })
  const createdBody = (await created.json()) as { data: EncounterRow }
  const encounterId = createdBody.data.id

  const early = await app.request(`/patients/${patientId}/encounters/${encounterId}/addenda`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Adenda prematura" }),
  })
  expect(early.status).toBe(409)
  expect(((await early.json()) as ErrorBody).error.code).toBe("NOT_FINALIZED")

  await finalizeWithEvolution(app, patientId, encounterId)

  const added = await app.request(`/patients/${patientId}/encounters/${encounterId}/addenda`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Corrección posterior" }),
  })
  expect(added.status).toBe(201)
  const addedBody = (await added.json()) as { data: { kind: string; note: string } }
  expect(addedBody.data.kind).toBe("adenda")

  const detail = await app.request(`/patients/${patientId}/encounters/${encounterId}`)
  const detailBody = (await detail.json()) as EncounterDetailBody
  expect(detailBody.data.addenda.map((n) => n.note)).toContain("Corrección posterior")
  expect(detailBody.data.addenda.every((n) => n.kind === "adenda")).toBe(true)
})

it("encounters: procedure con planItemId deja el plan realizado en la misma atención", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Borrador Plan")
  const ctx = await setupPlan(app, patientId)
  const encounterId = ctx.encounterId

  // El tratamiento exige presupuesto presentado y decisión aceptada en su línea.
  const item = await addPlanItem(app, patientId, ctx, {
    serviceId: "c1111111-1111-4111-8111-111111111111",
    toothNumber: 36,
  })
  const budgetId = await createBudget(app, patientId, ctx.planId, [item.id])
  await presentBudget(app, patientId, budgetId)
  await decideBudget(app, patientId, budgetId, [item.id])
  const itemId = item.id

  // Sin description: se congela desde el título del plan/servicio.
  const proc = await app.request(`/patients/${patientId}/encounters/${encounterId}/procedures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toothNumber: 36, planItemId: itemId }),
  })
  expect(proc.status).toBe(201)
  const procBody = (await proc.json()) as {
    data: { description: string; serviceId: string | null }
  }
  expect(procBody.data.description).toBe("Corona cerámica")
  expect(procBody.data.serviceId).toBe("c1111111-1111-4111-8111-111111111111")
  const duplicate = await app.request(
    `/patients/${patientId}/encounters/${encounterId}/procedures`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planItemId: itemId }),
    },
  )
  expect(duplicate.status).toBe(409)
  // Realizado es terminal: reabrir o cancelar un ejecutado se rechaza.
  const reopen = await app.request(`/patients/${patientId}/plan/items/${itemId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ encounterId, status: "pendiente" }),
  })
  expect(reopen.status).toBe(409)
  expect(((await reopen.json()) as ErrorBody).error.code).toBe("ITEM_CLOSED")

  const plan = await app.request(`/patients/${patientId}/plan`)
  expect(plan.status).toBe(200)
  const planBody = (await plan.json()) as { data: PlanItemRow[] }
  const updated = planBody.data.find((row) => row.id === itemId)
  expect(updated?.status).toBe("realizado")
  expect(updated?.decision).toBe("aceptado")
  expect(updated?.sourceEncounterId).toBe(encounterId)

  const detail = await app.request(`/patients/${patientId}/encounters/${encounterId}`)
  const detailBody = (await detail.json()) as EncounterDetailBody
  expect(detailBody.data.procedures.filter((p) => p.planItemId === itemId)).toHaveLength(1)
  expect(detailBody.data.indicatedItems.map((row) => row.id)).toContain(itemId)
})
it("encounters: referencias de otro paciente del mismo org responden 404 sin efectos", async () => {
  const app = buildApp("admin")
  const patientA = await createFreshPatient(app, "Paciente A")
  const patientB = await createFreshPatient(app, "Paciente B")

  const createdA = await postEncounter(app, patientA, { reason: "De A" })
  const bodyA = (await createdA.json()) as { data: EncounterRow }
  const encounterA = bodyA.data.id

  const ctxB = await setupPlan(app, patientB)
  const itemB = await addPlanItem(app, patientB, ctxB, {
    serviceId: "c1111111-1111-4111-8111-111111111111",
    toothNumber: 36,
  })

  const crossGet = await app.request(`/patients/${patientB}/encounters/${encounterA}`)
  expect(crossGet.status).toBe(404)
  expect(((await crossGet.json()) as ErrorBody).error.code).toBe("NOT_FOUND")

  const crossProc = await app.request(`/patients/${patientB}/encounters/${encounterA}/procedures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceId: "c1111111-1111-4111-8111-111111111111" }),
  })
  expect(crossProc.status).toBe(404)
  expect(((await crossProc.json()) as ErrorBody).error.code).toBe("NOT_FOUND")

  const crossPlan = await app.request(`/patients/${patientA}/encounters/${encounterA}/procedures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planItemId: itemB.id }),
  })
  expect(crossPlan.status).toBe(404)
  expect(((await crossPlan.json()) as ErrorBody).error.code).toBe("NOT_FOUND")

  const detailA = (await (
    await app.request(`/patients/${patientA}/encounters/${encounterA}`)
  ).json()) as EncounterDetailBody
  expect(detailA.data.procedures).toEqual([])

  const planB = (await (await app.request(`/patients/${patientB}/plan`)).json()) as {
    data: PlanItemRow[]
  }
  expect(planB.data.find((row) => row.id === itemB.id)?.status).toBe("pendiente")
})

it("encounters: finalize frente a PATCH concurrentes se serializa sin mutación cerrada", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Borrador Concurrente")

  const created = await postEncounter(app, patientId, { reason: "Concurrente" })
  const createdBody = (await created.json()) as { data: EncounterRow }
  const encounterId = createdBody.data.id
  // Mínimo de cierre previo a la carrera: la evolución ya está registrada.
  const evolved = await app.request(`/patients/${patientId}/encounters/${encounterId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ evolution: "Evolución base" }),
  })
  expect(evolved.status).toBe(200)

  const [patchRes, finalizeRes] = await Promise.all([
    app.request(`/patients/${patientId}/encounters/${encounterId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Edición concurrente" }),
    }),
    app.request(`/patients/${patientId}/encounters/${encounterId}/finalize`, { method: "POST" }),
  ])

  expect(finalizeRes.status).toBe(200)
  expect([200, 409]).toContain(patchRes.status)
  if (patchRes.status === 409) {
    expect(((await patchRes.json()) as ErrorBody).error.code).toBe("FINALIZED")
  }
})

it("encounters: procedure exige servicio o plan; inactivo u otra org no pasan", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Procedure Valida")
  const created = await postEncounter(app, patientId, { reason: "Valida" })
  const encounterId = ((await created.json()) as { data: EncounterRow }).data.id
  const post = (payload: Record<string, unknown>) =>
    app.request(`/patients/${patientId}/encounters/${encounterId}/procedures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

  // Texto libre sin servicio ni plan: ya no es sustituto válido.
  const bare = await post({ description: "Texto libre" })
  expect(bare.status).toBe(400)

  const inactive = await post({ serviceId: "c4444444-4444-4444-8444-444444444444" })
  expect(inactive.status).toBe(400)

  const foreign = await post({ serviceId: "d5555555-5555-4555-8555-555555555555" })
  expect(foreign.status).toBe(404)
  const ok = await post({ serviceId: "c1111111-1111-4111-8111-111111111111", toothNumber: 36 })
  expect(ok.status).toBe(201)
  const okBody = (await ok.json()) as { data: { description: string } }
  expect(okBody.data.description).toBe("Corona cerámica")
})

it("encounters: crear con planItemIds aceptados vincula sin marcar realizado", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Vinculo Plan")
  const ctx = await setupPlan(app, patientId)
  const first = await addPlanItem(app, patientId, ctx, {
    serviceId: "c1111111-1111-4111-8111-111111111111",
    toothNumber: 36,
  })
  const second = await addPlanItem(app, patientId, ctx, {
    serviceId: "c1111111-1111-4111-8111-111111111111",
    toothNumber: 37,
  })
  const budgetId = await createBudget(app, patientId, ctx.planId, [first.id, second.id])
  await presentBudget(app, patientId, budgetId)
  await decideBudget(app, patientId, budgetId, [first.id, second.id])
  // La atención de origen se cierra para abrir la siguiente (un solo borrador).
  const evolved = await app.request(`/patients/${patientId}/encounters/${ctx.encounterId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ evolution: "Evaluación completa" }),
  })
  expect(evolved.status).toBe(200)
  const finalized = await app.request(
    `/patients/${patientId}/encounters/${ctx.encounterId}/finalize`,
    { method: "POST" },
  )
  expect(finalized.status).toBe(200)

  const created = await postEncounter(app, patientId, {
    reason: "Con plan",
    planItemIds: [first.id, second.id],
  })
  expect(created.status).toBe(201)
  const encounterId = ((await created.json()) as { data: EncounterRow }).data.id

  const detail = await app.request(`/patients/${patientId}/encounters/${encounterId}`)
  expect(detail.status).toBe(200)
  const detailBody = (await detail.json()) as EncounterDetailBody
  expect(detailBody.data.plannedItems.map((row) => row.id).sort()).toEqual(
    [first.id, second.id].sort(),
  )

  // Abrir la atención no ejecuta el tratamiento: sigue pendiente y aceptado.
  const plan = await app.request(`/patients/${patientId}/plan`)
  const planBody = (await plan.json()) as { data: PlanItemRow[] }
  for (const id of [first.id, second.id]) {
    const row = planBody.data.find((item) => item.id === id)!
    expect(row.status).toBe("pendiente")
    expect(row.decision).toBe("aceptado")
  }
})

it("encounters: crear con planItemIds pendientes sin decidir responde 409 ITEM_NOT_ACCEPTED sin dejar borrador", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Vinculo Rechazado")
  const ctx = await setupPlan(app, patientId)
  const item = await addPlanItem(app, patientId, ctx, {
    serviceId: "c1111111-1111-4111-8111-111111111111",
    toothNumber: 36,
  })
  const budgetId = await createBudget(app, patientId, ctx.planId, [item.id])
  await presentBudget(app, patientId, budgetId)

  const denied = await postEncounter(app, patientId, {
    reason: "Sin decidir",
    planItemIds: [item.id],
  })
  expect(denied.status).toBe(409)
  expect(((await denied.json()) as ErrorBody).error.code).toBe("ITEM_NOT_ACCEPTED")

  // El rechazo no deja otro borrador: sigue solo el de origen.
  const listed = await app.request(`/patients/${patientId}/encounters`, { method: "GET" })
  const listedBody = (await listed.json()) as { data: Array<{ id: string }> }
  expect(listedBody.data.map((row) => row.id)).toEqual([ctx.encounterId])
})

it("encounters: crear con planItemIds de otro paciente responde 404", async () => {
  const app = buildApp("admin")
  const patientA = await createFreshPatient(app, "Vinculo A")
  const patientB = await createFreshPatient(app, "Vinculo B")
  const ctxB = await setupPlan(app, patientB)
  const itemB = await addPlanItem(app, patientB, ctxB, {
    serviceId: "c1111111-1111-4111-8111-111111111111",
    toothNumber: 36,
  })
  const budgetB = await createBudget(app, patientB, ctxB.planId, [itemB.id])
  await presentBudget(app, patientB, budgetB)
  await decideBudget(app, patientB, budgetB, [itemB.id])

  const cross = await postEncounter(app, patientA, { reason: "Cruce", planItemIds: [itemB.id] })
  expect(cross.status).toBe(404)
  expect(((await cross.json()) as ErrorBody).error.code).toBe("NOT_FOUND")
})

it("encounters: procedure con tratamiento no aceptado responde 409 ITEM_NOT_ACCEPTED", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Procedure Sin Aceptar")
  const ctx = await setupPlan(app, patientId)
  const item = await addPlanItem(app, patientId, ctx, {
    serviceId: "c1111111-1111-4111-8111-111111111111",
    toothNumber: 36,
  })
  const budgetId = await createBudget(app, patientId, ctx.planId, [item.id])
  await presentBudget(app, patientId, budgetId)

  const proc = await app.request(
    `/patients/${patientId}/encounters/${ctx.encounterId}/procedures`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planItemId: item.id }),
    },
  )
  expect(proc.status).toBe(409)
  expect(((await proc.json()) as ErrorBody).error.code).toBe("ITEM_NOT_ACCEPTED")

  const plan = await app.request(`/patients/${patientId}/plan`)
  const planBody = (await plan.json()) as { data: PlanItemRow[] }
  expect(planBody.data.find((row) => row.id === item.id)?.status).toBe("pendiente")
})

it("encounters: member lee 200 pero registrar procedimiento responde 403 FORBIDDEN sin efectos", async () => {
  const admin = buildApp("admin")
  const member = buildApp("member")
  const patientId = await createFreshPatient(admin, "Permisos Atencion")
  const ctx = await setupPlan(admin, patientId)
  const item = await addPlanItem(admin, patientId, ctx, {
    serviceId: "c1111111-1111-4111-8111-111111111111",
    toothNumber: 36,
  })
  const budgetId = await createBudget(admin, patientId, ctx.planId, [item.id])
  await presentBudget(admin, patientId, budgetId)
  await decideBudget(admin, patientId, budgetId, [item.id])

  const read = await member.request(`/patients/${patientId}/encounters/${ctx.encounterId}`)
  expect(read.status).toBe(200)

  const proc = await member.request(
    `/patients/${patientId}/encounters/${ctx.encounterId}/procedures`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planItemId: item.id }),
    },
  )
  expect(proc.status).toBe(403)
  expect(((await proc.json()) as ErrorBody).error.code).toBe("FORBIDDEN")

  // Sin efectos: el tratamiento sigue pendiente y sin procedimientos.
  const plan = await admin.request(`/patients/${patientId}/plan`)
  const planBody = (await plan.json()) as { data: PlanItemRow[] }
  expect(planBody.data.find((row) => row.id === item.id)?.status).toBe("pendiente")
  const detail = await admin.request(`/patients/${patientId}/encounters/${ctx.encounterId}`)
  expect(((await detail.json()) as EncounterDetailBody).data.procedures).toEqual([])
})

it("encounters: PATCH guarda el examen clínico con forma validada y lo limpia con null", async () => {
  const app = buildApp("admin")
  const patientId = await createFreshPatient(app, "Examen Clinico")
  const created = await postEncounter(app, patientId, { reason: "Control" })
  const encounterId = ((await created.json()) as { data: EncounterRow }).data.id

  const bad = await app.request(`/patients/${patientId}/encounters/${encounterId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ examination: { extraoral: { inventado: "x" } } }),
  })
  expect(bad.status).toBe(400)

  const ok = await app.request(`/patients/${patientId}/encounters/${encounterId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      examination: {
        extraoral: { atm: "Sin alteraciones", ganglios: "" },
        intraoral: { encias: "Sanas" },
        higieneOral: "buena",
      },
    }),
  })
  expect(ok.status).toBe(200)
  const detail = (await (
    await app.request(`/patients/${patientId}/encounters/${encounterId}`)
  ).json()) as {
    data: { encounter: { examination: Record<string, unknown> } }
  }
  expect(detail.data.encounter.examination).toEqual({
    extraoral: { atm: "Sin alteraciones" },
    intraoral: { encias: "Sanas" },
    higieneOral: "buena",
  })

  const cleared = await app.request(`/patients/${patientId}/encounters/${encounterId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ examination: null }),
  })
  expect(cleared.status).toBe(200)
  const clearedDetail = (await (
    await app.request(`/patients/${patientId}/encounters/${encounterId}`)
  ).json()) as {
    data: { encounter: { examination: unknown } }
  }
  expect(clearedDetail.data.encounter.examination).toBeNull()
})
