process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { DictationExtraction } from "@odentia/agent"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { secretsKeyFromEnv, upsertAgentConfig } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { CrmDeps } from "./helpers.js"
import { createPatientsRoute } from "./patients.js"

/**
 * «Lo que se dijo» guardado con la atención (mesa del 20 nov 2026, «Clío en una consulta
 * conversada», P2). Antes lo dicho vivía solo en la pestaña: tras recargar, la pausa siguiente
 * iba sin contexto («también en la 37» movió la caries de la 36), y un tramo que no dejó
 * sugerencias se volvía a mandar al modelo (y a cobrar) al reintentarlo. El modelo es un doble:
 * aquí importa cuántas veces se le llama y qué lee.
 */
const extract = vi.hoisted(() => vi.fn())
vi.mock("@odentia/agent", async (importOriginal) => ({ ...(await importOriginal<typeof import("@odentia/agent")>()), extractDictation: extract }))

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const nothing = (transcript: string, over: Partial<DictationExtraction> = {}): DictationExtraction => ({
  drafts: [],
  corrections: [],
  removals: [],
  omitted: 0,
  unused: [],
  model: "doble",
  heard: transcript,
  ...over,
})

function buildApp(role: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: {} as CrmDeps["storage"],
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", "org_a")
    c.set("userId", "u-1")
    c.set("memberRole", role)
    await next()
  })
  app.route("/patients", createPatientsRoute({ ...deps, llm: { fake: true } }))
  return app
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

/** Una paciente con su atención en borrador, de la doctora que dicta. */
async function attention(app: Hono): Promise<{ patientId: string; base: string }> {
  const created = await app.request(
    "/patients",
    json({
      submissionId: crypto.randomUUID(),
      answers: { demographics: { displayName: `Rosa ${crypto.randomUUID().slice(0, 8)}` }, respondent: "staff", privacyAccepted: false },
    }),
  )
  expect(created.status).toBe(201)
  const patientId = ((await created.json()) as { data: { id: string } }).data.id
  const encounter = await app.request(`/patients/${patientId}/encounters`, json({ reason: "Evaluación" }))
  expect(encounter.status).toBe(201)
  const encounterId = ((await encounter.json()) as { data: { id: string } }).data.id
  return { patientId, base: `/patients/${patientId}/encounters/${encounterId}/dictation` }
}

/** Lo que leyó el modelo en la llamada `n` (desde 0). */
const read = (n: number) => extract.mock.calls[n]?.[2] as { transcript: string; context?: string }

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
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(uri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`)
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`)
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values ('org_a', 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
  await ownerDb.execute(sql`insert into "user" ("id", "name", "email") values ('u-1', 'Doctora', 'doc@test.dev')`)
  await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values ('m-u1-a', 'org_a', 'u-1', 'clinician', now())`)
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { clinicalAssistantEnabled: true }))
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

beforeEach(() => {
  extract.mockReset()
  extract.mockImplementation(async (_db: unknown, _deps: unknown, input: { transcript: string }) => nothing(input.transcript))
})

describe("cada tramo se ordena una sola vez", () => {
  it("un tramo ya ordenado no vuelve a llamar al modelo, aunque no haya dejado ninguna sugerencia", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    const segmentId = crypto.randomUUID()
    const first = await app.request(base, json({ transcript: "Buenos días, ¿encontró dónde estacionar?", segmentId }))
    expect(first.status).toBe(201)
    // El reintento automático, o una segunda pestaña, con el mismo tramo.
    const again = await app.request(base, json({ transcript: "Buenos días, ¿encontró dónde estacionar?", segmentId }))
    expect(again.status).toBe(201)
    expect(((await again.json()) as { data: { repeated: boolean } }).data.repeated).toBe(true)
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it("un tramo que falló al ordenarse sí se vuelve a intentar", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    const segmentId = crypto.randomUUID()
    extract.mockRejectedValueOnce(new Error("el proveedor no respondió"))
    const failed = await app.request(base, json({ transcript: "Le duele al tomar algo frío.", segmentId }))
    expect(failed.status).toBeGreaterThanOrEqual(500)
    const retried = await app.request(base, json({ transcript: "Le duele al tomar algo frío.", segmentId }))
    expect(retried.status).toBe(201)
    expect(((await retried.json()) as { data: { repeated: boolean } }).data.repeated).toBe(false)
    expect(extract).toHaveBeenCalledTimes(2)
  })
})

describe("la pausa lee lo dicho antes desde el servidor", () => {
  it("tras recargar, la pausa siguiente lleva el final de lo dicho antes, y no lo que mande la pestaña", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    await app.request(base, json({ transcript: "La treinta y seis tiene caries oclusal y pulpitis irreversible.", segmentId: crypto.randomUUID() }))
    // Tras recargar, la pestaña ya no tiene lo dicho: manda el tramo sin contexto.
    await app.request(base, json({ transcript: "Sí, también en la treinta y siete.", segmentId: crypto.randomUUID() }))
    expect(read(1).context).toContain("La treinta y seis tiene caries oclusal")
    // Otra pestaña con su propio texto: lo que vale es lo guardado.
    await app.request(base, json({ transcript: "Le indico resina.", segmentId: crypto.randomUUID(), context: "algo que se dijo en otra pestaña" }))
    expect(read(2).context).not.toContain("otra pestaña")
    expect(read(2).context).toContain("también en la treinta y siete")
  })

  it("si lo guardado pasa lo que la pausa acepta, el contexto toma lo último, sin cortar una palabra", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    const long = `${"Le molesta al masticar del lado izquierdo. ".repeat(260)}Anoche no la dejó dormir.`
    expect(long.length).toBeLessThanOrEqual(12_000)
    await app.request(base, json({ transcript: long, segmentId: crypto.randomUUID() }))
    await app.request(base, json({ transcript: long, segmentId: crypto.randomUUID() }))
    await app.request(base, json({ transcript: "¿Y desde cuándo?", segmentId: crypto.randomUUID() }))
    const context = read(2).context ?? ""
    expect(context.length).toBeGreaterThan(100)
    expect(context.length).toBeLessThanOrEqual(2_000)
    expect(context.endsWith("Anoche no la dejó dormir.")).toBe(true)
    // Empieza en una palabra entera.
    expect(long).toContain(context.split(" ").slice(0, 3).join(" "))
    expect(/^[A-ZÁÉÍÓÚa-záéíóúñ¿]/.test(context) && !context.startsWith("e ")).toBe(true)
  })
})

describe("«Lo que se dijo» se lee del servidor", () => {
  it("cada tramo tal cual llegó, en orden y con lo que no se usó y por qué", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    extract.mockImplementationOnce(async (_db: unknown, _deps: unknown, input: { transcript: string }) =>
      nothing(input.transcript, { omitted: 1, unused: ["Tomo losartán de cincuenta"] }),
    )
    await app.request(base, json({ transcript: "Tomo losartán de cincuenta para la presión.", segmentId: crypto.randomUUID() }))
    await app.request(base, json({ transcript: "Buenos días.", segmentId: crypto.randomUUID() }))
    const res = await app.request(`${base}/said`)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: { segments: Array<{ transcript: string; saidAt: string; organized: boolean; unused: Array<{ said: string | null; why: string }> }> }
    }
    expect(data.segments.map((item) => item.transcript)).toEqual(["Tomo losartán de cincuenta para la presión.", "Buenos días."])
    expect(data.segments.every((item) => item.organized && !Number.isNaN(Date.parse(item.saidAt)))).toBe(true)
    expect(data.segments[0]!.unused).toEqual([{ said: "Tomo losartán de cincuenta", why: "sin_lugar" }])
    expect(data.segments[1]!.unused).toEqual([])
  })

  it("recepción y caja no lo ven: no tienen permiso clínico", async () => {
    const { base } = await attention(buildApp("owner"))
    for (const role of ["reception", "cashier"]) {
      const res = await buildApp(role).request(`${base}/said`)
      expect(res.status, role).toBe(403)
    }
  })
})

/**
 * Lo de salud dicho en la conversación (mesa del 20 nov 2026, P3): se confirma con «Lo revisé
 * con…», en su propia ruta, con quién lo dijo; nunca con la confirmación de siempre.
 */
describe("«Lo revisé con…» de lo que dijo de su salud", () => {
  it("lo confirma quien atiende, con quién lo dijo; la confirmación de siempre no lo lleva y recepción no puede", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    extract.mockImplementationOnce(async (_db: unknown, _deps: unknown, input: { transcript: string }) =>
      nothing(input.transcript, {
        drafts: [{ kind: "salud", payload: { declarante: "no_se_sabe", medications: { state: "recorded", items: [{ name: "salbutamol" }] } }, sourceText: "usa salbutamol" }],
      }),
    )
    const said = await app.request(base, json({ transcript: "Usa salbutamol cuando se agita.", segmentId: crypto.randomUUID() }))
    expect(said.status).toBe(201)
    const [health] = ((await said.json()) as { data: { suggestions: Array<{ id: string; kind: string }> } }).data.suggestions
    expect(health?.kind).toBe("salud")
    expect((await app.request(`${base}/${health!.id}/confirm`, json({}))).status).toBe(409)
    expect((await buildApp("reception").request(`${base}/${health!.id}/confirm-health`, json({}))).status).toBe(403)
    const res = await app.request(`${base}/${health!.id}/confirm-health`, json({ declarante: "acompanante", vinculo: "madre" }))
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { status: string; payload: Record<string, unknown>; health: { declarations: Array<{ via: string; by: { kind: string; relation: string | null } }> } } }
    expect(data.status).toBe("confirmada")
    expect(data.payload["declarante"]).toBe("acompanante")
    expect(data.health.declarations[0]).toMatchObject({ via: "consulta", by: { kind: "representative", relation: "madre" } })
  })
})
