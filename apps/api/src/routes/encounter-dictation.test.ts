process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { DictationExtraction, DictationReviewExtraction } from "@odentia/agent"
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
const review = vi.hoisted(() => vi.fn())
vi.mock("@odentia/agent", async (importOriginal) => ({ ...(await importOriginal<typeof import("@odentia/agent")>()), extractDictation: extract, reviewDictation: review }))

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

const reviewed = (over: Partial<DictationReviewExtraction> = {}): DictationReviewExtraction => ({
  drafts: [],
  omitted: 0,
  unused: [],
  outOfPlace: [],
  turns: [],
  turnsRejected: [],
  model: "doble",
  heard: "",
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
  review.mockReset()
  review.mockImplementation(async () => reviewed())
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

/**
 * Revisión del 21 nov 2026 (C1 y C3): dos pedidos del mismo tramo a la vez (el reintento tras un
 * corte, otra pestaña) no pagan dos veces al modelo; «Intentar otra vez» una frase no la guarda
 * como otro tramo.
 */
describe("un tramo o un repaso en curso", () => {
  /** Una llamada al modelo que no termina hasta que se la suelta. */
  function held<T>(value: T) {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return { release: () => release(), answer: async () => (await gate, value) }
  }

  it("el segundo pedido del mismo tramo, mientras Clío lo ordena, no llama otra vez al modelo", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    const segmentId = crypto.randomUUID()
    const slow = held(nothing("Me duele al masticar."))
    extract.mockImplementationOnce(slow.answer)
    const first = app.request(base, json({ transcript: "Me duele al masticar.", segmentId }))
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
    const second = await app.request(base, json({ transcript: "Me duele al masticar.", segmentId }))
    expect(second.status).toBe(201)
    expect(((await second.json()) as { data: { inProgress?: boolean } }).data.inProgress).toBe(true)
    slow.release()
    expect((await first).status).toBe(201)
    expect(extract).toHaveBeenCalledTimes(1)
    // Ya ordenado, el mismo pedido dice que está repetido, sin llamar al modelo.
    const again = await app.request(base, json({ transcript: "Me duele al masticar.", segmentId }))
    expect(((await again.json()) as { data: { repeated: boolean; inProgress?: boolean } }).data).toMatchObject({ repeated: true })
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it("dos repasos a la vez pagan uno; si falla, se puede pedir otra vez enseguida", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    await app.request(base, json({ transcript: "Te veo la próxima semana.", segmentId: crypto.randomUUID() }))
    const slow = held(reviewed())
    review.mockImplementationOnce(slow.answer)
    const first = app.request(`${base}/review`, json({}))
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1))
    const second = await app.request(`${base}/review`, json({}))
    expect(((await second.json()) as { data: { reviewed: boolean; inProgress?: boolean } }).data).toMatchObject({ reviewed: false, inProgress: true })
    slow.release()
    expect((await first).status).toBe(200)
    expect(review).toHaveBeenCalledTimes(1)

    await app.request(base, json({ transcript: "Gracias, doctora.", segmentId: crypto.randomUUID() }))
    review.mockRejectedValueOnce(new Error("el proveedor no respondió"))
    expect((await app.request(`${base}/review`, json({}))).status).toBeGreaterThanOrEqual(500)
    expect((await app.request(`${base}/review`, json({}))).status).toBe(200)
    expect(review).toHaveBeenCalledTimes(3)
  })

  it("«Intentar otra vez» relee la frase con lo dicho antes de su tramo, sin guardarla como otro tramo", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    const segmentId = crypto.randomUUID()
    await app.request(base, json({ transcript: "Le duele la treinta y seis.", segmentId: crypto.randomUUID() }))
    extract.mockImplementationOnce(async (_db: unknown, _deps: unknown, input: { transcript: string }) => nothing(input.transcript, { omitted: 1, unused: ["y algo de la tiroides"] }))
    await app.request(base, json({ transcript: "Buenos días, y algo de la tiroides.", segmentId }))
    const res = await app.request(base, json({ transcript: "y algo de la tiroides", segmentId: crypto.randomUUID(), retryOf: segmentId }))
    expect(res.status).toBe(201)
    expect(read(2)).toMatchObject({ transcript: "y algo de la tiroides", context: "Le duele la treinta y seis." })
    const { data } = (await (await app.request(`${base}/said`)).json()) as { data: { segments: Array<{ transcript: string; unused: unknown[] }> } }
    // Antes la frase quedaba dos veces en «Lo que se dijo», con otra hora.
    expect(data.segments.map((item) => item.transcript)).toEqual(["Le duele la treinta y seis.", "Buenos días, y algo de la tiroides."])
    // Clío tampoco la usó esta vez: la frase sigue en «No lo usé» de su tramo, con su motivo (QA del
    // 21 nov: antes desaparecía sin quedar en ninguna parte).
    expect(data.segments[1]?.unused).toEqual([{ said: "y algo de la tiroides", why: "sin_lugar" }])
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

  it("lo que dijo de su salud en una atención firmada solo lo revisa o lo descarta quien escribe en la historia", async () => {
    const { patientId } = await attention(buildApp("owner"))
    const id = crypto.randomUUID()
    for (const role of ["reception", "cashier"])
      for (const action of ["confirm", "discard"]) {
        const res = await buildApp(role).request(`/patients/${patientId}/health/said/${id}/${action}`, json({}))
        expect(res.status, `${role} ${action}`).toBe(403)
      }
    expect((await buildApp("owner").request(`/patients/${patientId}/health/said/${id}/discard`, json({}))).status).toBe(404)
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

  /**
   * «Corregir algo» (mesa del 20 nov 2026, P5): lo que se corrigió en Antecedentes sale de la
   * propuesta con un PATCH de esos grupos en nulo, y «Lo revisé con…» ya no lo vuelve a sumar.
   * La pantalla la lee con lo de la entrevista puesto con sus claves.
   */
  it("«Corregir algo»: los grupos en nulo salen de la propuesta, lo demás queda y se confirma sin ellos", async () => {
    const app = buildApp("owner")
    const { patientId, base } = await attention(app)
    extract.mockImplementationOnce(async (_db: unknown, _deps: unknown, input: { transcript: string }) =>
      nothing(input.transcript, {
        drafts: [
          {
            kind: "salud",
            payload: {
              declarante: "paciente",
              medications: { state: "recorded", items: [{ name: "metformina" }] },
              anticoagulants: { state: "recorded", detail: "apixabán" },
              dental: { ansiedadDental: "alta" },
            },
            sourceText: "tomo metformina y apixabán, y le tengo miedo al dentista",
          },
        ],
      }),
    )
    const said = await app.request(base, json({ transcript: "Tomo metformina y apixabán, y le tengo miedo al dentista.", segmentId: crypto.randomUUID() }))
    expect(said.status).toBe(201)
    const listed = (await (await app.request(base)).json()) as { data: { suggestions: Array<{ id: string; kind: string; interview?: Record<string, unknown> }> } }
    const health = listed.data.suggestions.find((item) => item.kind === "salud")
    // Lo de la entrevista, ya con las claves de la entrevista de odentIA.
    expect(health?.interview).toEqual({ antecedentesOdontologicos: { ansiedadDental: "alta" } })
    const patch = (body: unknown) =>
      app.request(`${base}/${health!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const res = await patch({ medications: null, anticoagulants: null })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { status: string; payload: Record<string, unknown>; summary: string } }
    expect(data.status).toBe("lista")
    const { quien: _who, ...shown } = data.payload
    expect(shown).toEqual({ declarante: "paciente", dental: { ansiedadDental: "alta" } })
    expect(data.summary).not.toContain("metformina")
    // Sin nada de su salud, la propuesta no se guarda vacía: la pantalla la descarta.
    expect((await patch({ dental: null })).status).toBe(400)
    const confirmed = await app.request(`${base}/${health!.id}/confirm-health`, json({}))
    expect(confirmed.status).toBe(200)
    const after = (await (await app.request(`/patients/${patientId}/health`)).json()) as { data: { medications: Array<{ name: string }> } }
    expect(after.data.medications.map((row) => row.name)).toEqual([])
  })
})

describe("lo resaltado de lo que se dijo", () => {
  it("trae las frases de lo pendiente y de lo confirmado, no de lo descartado; sigue al recargar", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    extract.mockImplementationOnce(async (_db: unknown, _deps: unknown, input: { transcript: string }) =>
      nothing(input.transcript, {
        drafts: [
          { kind: "nota", payload: { reason: "Dolor con el frío" }, sourceText: "me duele con el frío" },
          { kind: "salud", payload: { declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" } }, sourceText: "tomo apixabán" },
          { kind: "control", payload: { title: "Control", dueInDays: 30 }, sourceText: "control en un mes" },
        ],
      }),
    )
    const said = await app.request(base, json({ transcript: "Me duele con el frío, tomo apixabán, control en un mes.", segmentId: crypto.randomUUID() }))
    expect(said.status).toBe(201)
    const items = ((await said.json()) as { data: { suggestions: Array<{ id: string; kind: string }> } }).data.suggestions
    const note = items.find((item) => item.kind === "nota")!
    const control = items.find((item) => item.kind === "control")
    expect((await app.request(`${base}/${note.id}/confirm`, json({}))).status).toBe(200)
    if (control) expect((await app.request(`${base}/${control.id}/discard`, json({}))).status).toBe(200)
    const res = await app.request(`${base}/said`)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { used: Array<{ kind: string; said: string }> } }
    expect(data.used).toEqual(
      expect.arrayContaining([
        { kind: "nota", said: "me duele con el frío" },
        { kind: "salud", said: "tomo apixabán" },
      ]),
    )
    expect(data.used.some((item) => item.said === "control en un mes")).toBe(false)
  })
})

/**
 * El repaso al terminar (mesa del 20 nov 2026, P4): una lectura de toda la conversación guardada,
 * con lo que ya quedó de ella. Aquí importa cuándo se llama al modelo, qué lee y qué queda.
 */
describe("el repaso al terminar", () => {
  type Reviewed = { reviewed: boolean; suggestions: Array<{ id: string; kind: string; payload: Record<string, unknown> }>; turnsSaved: string[]; turnsRejected: string[]; turnsUnsplit: string[]; unused: Array<{ said: string | null; detail?: string }> }
  const ask = (n: number) =>
    review.mock.calls[n]?.[2] as { segments: Array<{ number: number; transcript: string; needsTurns: boolean }>; pending: string[]; discarded: string[]; earlierLeftOut: boolean }

  it("lee toda la conversación una vez, con lo pendiente y lo descartado; sin tramos nuevos no vuelve a llamar al modelo", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    const first = crypto.randomUUID()
    extract.mockImplementationOnce(async (_db: unknown, _deps: unknown, input: { transcript: string }) =>
      nothing(input.transcript, { drafts: [{ kind: "nota", payload: { reason: "Dolor de muela" }, sourceText: "me duele una muela" }] }),
    )
    await app.request(base, json({ transcript: "Doctora, me duele una muela.", segmentId: first }))
    const second = crypto.randomUUID()
    await app.request(base, json({ transcript: "Bueno, te veo la próxima semana para la otra resina.", segmentId: second }))
    review.mockImplementationOnce(async () =>
      reviewed({
        drafts: [{ kind: "control", payload: { title: "Control: la otra resina", dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }, sourceText: "te veo la próxima semana para la otra resina" }],
        turns: [{ number: 1, turns: [{ quien: "paciente", texto: "Doctora, me duele una muela." }] }],
        outOfPlace: [{ said: "te veo", why: "otro" }],
      }),
    )
    const res = await app.request(`${base}/review`, json({}))
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: Reviewed }
    expect(data.reviewed).toBe(true)
    expect(data.suggestions.map((item) => [item.kind, item.payload["title"]])).toEqual([["control", "Control: la otra resina"]])
    expect(data.turnsSaved).toEqual([first])
    // El tramo del que Clío no dijo quién habló queda en un turno de «No se sabe», y la respuesta lo dice (UX-1).
    expect(data.turnsUnsplit).toEqual([second])
    expect(review).toHaveBeenCalledTimes(1)
    expect(ask(0).segments.map((item) => [item.number, item.transcript, item.needsTurns])).toEqual([
      [1, "Doctora, me duele una muela.", true],
      [2, "Bueno, te veo la próxima semana para la otra resina.", true],
    ])
    expect(ask(0).pending.some((label) => label.includes("Dolor de muela"))).toBe(true)

    // «Lo que se dijo» trae los turnos del tramo.
    const said = (await (await app.request(`${base}/said`)).json()) as { data: { segments: Array<{ turns: unknown[] | null }> } }
    expect(said.data.segments.map((item) => item.turns)).toEqual([
      [{ quien: "paciente", texto: "Doctora, me duele una muela." }],
      [{ quien: "no_se_sabe", texto: "Bueno, te veo la próxima semana para la otra resina." }],
    ])

    // Terminar otra vez sin haber dicho nada: no llama al modelo.
    const again = await app.request(`${base}/review`, json({}))
    expect(((await again.json()) as { data: Reviewed }).data.reviewed).toBe(false)
    expect(review).toHaveBeenCalledTimes(1)

    // Con algo nuevo, sí; lo que ya tiene turnos no los pide otra vez.
    await app.request(base, json({ transcript: "Gracias, doctora.", segmentId: crypto.randomUUID() }))
    await app.request(`${base}/review`, json({}))
    expect(review).toHaveBeenCalledTimes(2)
    expect(ask(1).segments.map((item) => item.needsTurns)).toEqual([false, false, true])
  })

  it("cambiar quién habló en un turno: quien lleva la atención, con un toque; recepción no puede", async () => {
    const app = buildApp("owner")
    const { base } = await attention(app)
    const segmentId = crypto.randomUUID()
    await app.request(base, json({ transcript: "Tiene asma, usa salbutamol.", segmentId }))
    review.mockImplementationOnce(async () => reviewed({ turns: [{ number: 1, turns: [{ quien: "no_se_sabe", texto: "Tiene asma, usa salbutamol." }] }] }))
    await app.request(`${base}/review`, json({}))
    const turn = `${base}/said/${segmentId}/turns/0`
    const patch = (body: unknown): RequestInit => ({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    expect((await buildApp("reception").request(turn, patch({ quien: "acompanante", vinculo: "madre" }))).status).toBe(403)
    expect((await app.request(turn, patch({ quien: "asistente" }))).status).toBe(400)
    const res = await app.request(turn, patch({ quien: "acompanante", vinculo: "madre" }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { turns: unknown[] } }).data.turns).toEqual([{ quien: "acompanante", vinculo: "madre", texto: "Tiene asma, usa salbutamol." }])
    expect((await app.request(`${base}/said/${segmentId}/turns/3`, patch({ quien: "dra" }))).status).toBe(404)
  })
})
