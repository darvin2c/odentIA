process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

// Argos sobre las vistas del negocio (ADR 0073), de punta a punta con un modelo
// guionizado: el modelo recibe solo las vistas del rol y nunca un dato, la
// frase la llena el servidor, la base corrige al modelo una vez y cada pregunta
// queda anotada con su consulta y sin su texto.
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { patient, patientPayment } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { reportQuestion } from "@odentia/db/schema/reports"
import { prepareArgosQuestion, secretsKeyFromEnv, updateAdminSettings } from "@odentia/services"
import { eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type ArgosDeps, type ArgosPlan, askArgos } from "./argos.js"
import type { DecisionModel } from "./decision/index.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("cc".repeat(32))
const ORG = "org_argos"
const OWNER = "user_argos"
const PATIENT_NAME = "Rosa Quispe"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

/** Modelo que responde con el plan del guion en cada llamada y guarda lo que recibió. */
class ScriptedModel extends BaseChatModel {
  calls: BaseMessage[][] = []
  constructor(private readonly plans: Array<Partial<ArgosPlan> | Error>) {
    super({})
  }
  _llmType(): string {
    return "scripted-argos"
  }
  override bindTools(): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages)
    const next = this.plans[this.calls.length - 1]
    if (!next || next instanceof Error) throw next ?? new Error("sin guion")
    const args = { tipo: "consulta", sql: "", frase: "", frase_vacia: "", como: "", falta: "", sql_cercana: "", frase_cercana: "", ...next }
    const message = new AIMessage({ content: "", tool_calls: [{ name: "responder", args, id: `call-${this.calls.length}`, type: "tool_call" }] })
    return { generations: [{ text: "", message }] }
  }
  sent(): string {
    return this.calls.flat().map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))).join("\n")
  }
}

const decides = (choice: "negocio" | "ayuda" | "otro"): DecisionModel => ({
  provider: "fake",
  reportsProbabilities: false,
  decide: async (_, questions) => ({
    answers: questions.map((question) => ({ id: question.id, kind: "choice", choice, probabilities: null, confidence: null })),
    model: "guion",
    usage: null,
    latencyMs: 0,
  }),
})

function deps(model: ScriptedModel, route: "negocio" | "ayuda" | "otro" = "negocio"): ArgosDeps {
  return { platform: { fake: true }, secretsKey: KEY, createModel: async () => model, decisionModel: decides(route) }
}

const ask = (model: ScriptedModel, text: string, memberRole = "owner", route?: "negocio" | "ayuda" | "otro") =>
  askArgos(appDb, deps(model, route), { orgId: ORG, userId: OWNER, memberRole, text })

const lastQuestion = async () => (await ownerDb.select().from(reportQuestion).where(eq(reportQuestion.organizationId, ORG)).orderBy(sql`created_at desc`).limit(1))[0]

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({ POSTGRES_DB: "dentalagent", POSTGRES_USER: "dentalagent", POSTGRES_PASSWORD: "dentalagent", POSTGRES_APP_PASSWORD: "dentalagent_app" })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  const host = container.getHost()
  const port = container.getMappedPort(5432)
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}:${port}/dentalagent`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}:${port}/dentalagent`)
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Clínica Argos', 'argos', now())`)
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values (${ORG}, 'Clínica Argos', 'PE', 'PEN', 'America/Lima', 'es-PE') on conflict do nothing`,
  )
  await ownerDb.insert(user).values({ id: OWNER, name: "Dueña", email: "duena@argos.test" })
  const [person] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: PATIENT_NAME }).returning({ id: contact.id })
  const [record] = await ownerDb.insert(patient).values({ organizationId: ORG, personId: person!.id, patientNumber: 1 }).returning({ id: patient.id })
  await ownerDb.insert(patientPayment).values({ organizationId: ORG, patientId: record!.id, amountCents: 125_050, currency: "PEN", paidAt: new Date(), methodName: "Efectivo", methodTypeCode: "10" })
  await withOrgContext(appDb, ORG, (tx) => updateAdminSettings(tx, ORG, OWNER, { enabled: true }))
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

beforeEach(async () => {
  await ownerDb.delete(reportQuestion).where(eq(reportQuestion.organizationId, ORG))
})

const COBRADO: Partial<ArgosPlan> = {
  sql: "select sum(importe) as cobrado_dinero, count(*) as pagos from cobros where dia >= date_trunc('month', current_date)",
  frase: "Este mes se cobró {cobrado_dinero} en {pagos} pago.",
  frase_vacia: "Este mes no se cobró nada.",
  como: "Lo cobrado del mes: pagos menos anulaciones y devoluciones.",
}

describe("Argos sobre las vistas", () => {
  it("responde con la cifra que llena el servidor; el modelo no ve datos y la consulta queda anotada sin el texto", async () => {
    const model = new ScriptedModel([COBRADO])
    const answer = await ask(model, "¿Cuánto cobramos este mes?")
    expect(answer).toMatchObject({ kind: "respuesta", partial: false, how: COBRADO.como, query: COBRADO.sql })
    if (answer.kind !== "respuesta") throw new Error(answer.kind)
    expect(answer.text).toMatch(/^Este mes se cobró S\/\s?1[.,]?250[.,]50 en 1 pago\.$/)
    expect(answer.sentence.filter((part) => part.strong).length).toBe(2)
    expect(answer.table.columns.map((column) => column.label)).toEqual(["Cobrado", "Pagos"])
    // Al modelo le llegan la pregunta y las vistas, nunca el nombre del paciente ni el monto.
    expect(model.calls).toHaveLength(1)
    expect(model.sent()).not.toContain(PATIENT_NAME)
    expect(model.sent()).not.toMatch(/1[.,]?250/)
    expect(model.sent()).toContain("comisiones:")
    expect(await lastQuestion()).toMatchObject({ outcome: "respondida", query: COBRADO.sql, usedModel: true })
  })

  it("solo describe las vistas del rol, y la llave no deja leer lo que el rol no ve aunque el modelo lo pida", async () => {
    const model = new ScriptedModel([COBRADO])
    const answer = await ask(model, "¿Cuánto cobramos?", "reception")
    expect(model.sent()).not.toContain("cobros:")
    expect(model.sent()).toContain("citas:")
    expect(answer).toMatchObject({ kind: "sin_permiso" })
  })

  it("si la base rechaza la consulta, el modelo la corrige una vez con el error, sin datos", async () => {
    const model = new ScriptedModel([{ ...COBRADO, sql: "select sum(monto) as cobrado_dinero, count(*) as pagos from cobros" }, COBRADO])
    const answer = await ask(model, "¿Cuánto cobramos este mes?")
    expect(answer).toMatchObject({ kind: "respuesta", query: COBRADO.sql })
    expect(model.calls).toHaveLength(2)
    const correction = model.calls[1]?.at(-1)?.content
    expect(String(correction)).toContain("No se pudo usar")
    expect(String(correction)).toContain("monto")
  })

  it("una frase con un hueco que no está en el resultado también se corrige; si vuelve a fallar, lo dice", async () => {
    const wrong = { ...COBRADO, frase: "Este mes se cobró {total}." }
    const model = new ScriptedModel([wrong, wrong])
    const answer = await ask(model, "¿Cuánto cobramos este mes?")
    expect(answer).toMatchObject({ kind: "no_pudo" })
    expect(String(model.calls[1]?.at(-1)?.content)).toContain("{total}")
    expect(await lastQuestion()).toMatchObject({ outcome: "no_pudo", usedModel: true })
  })

  it("lo que no existe lo dice y ofrece lo más cercano que sí existe", async () => {
    const model = new ScriptedModel([
      {
        tipo: "no_existe",
        sql: "",
        frase: "odentIA no tiene encuestas de satisfacción.",
        falta: "Encuestas a los pacientes.",
        sql_cercana: "select count(*) as pagos from cobros",
        frase_cercana: "Lo más cercano: {pagos} pagos registrados.",
      },
    ])
    const answer = await ask(model, "¿Qué tan satisfechos están los pacientes?")
    expect(answer).toMatchObject({ kind: "no_existe", message: "odentIA no tiene encuestas de satisfacción.", missing: "Encuestas a los pacientes." })
    if (answer.kind !== "no_existe") throw new Error(answer.kind)
    expect(answer.closest?.text).toBe("Lo más cercano: 1 pagos registrados.")
    expect(await lastQuestion()).toMatchObject({ outcome: "no_sabe", query: null })

    // Sin consulta no hay con qué llenar un hueco: se dice lo que falta.
    const holes = new ScriptedModel([{ tipo: "parcial", sql: "", frase: "Hay {filas} productos.", falta: "El costo de los lotes." }])
    expect(await ask(holes, "¿Cuánto vale el inventario?")).toMatchObject({ kind: "no_existe", message: "El costo de los lotes." })
  })

  it("lo que es de la Ayuda u otra cosa no llama al modelo que escribe ni cuenta para el tope", async () => {
    const model = new ScriptedModel([])
    expect(await ask(model, "¿Cómo agrego una sede?", "owner", "ayuda")).toMatchObject({ kind: "ayuda" })
    expect(model.calls).toHaveLength(0)
    expect(await lastQuestion()).toMatchObject({ outcome: "ayuda", usedModel: false })
  })

  it("si el modelo no responde lo dice, y ese intento no cuenta para el tope", async () => {
    const before = await withOrgContext(appDb, ORG, (tx) => prepareArgosQuestion(tx, ORG))
    const answer = await ask(new ScriptedModel([new Error("proveedor caído")]), "¿Cuánto cobramos?")
    expect(answer).toMatchObject({ kind: "sin_modelo" })
    const after = await withOrgContext(appDb, ORG, (tx) => prepareArgosQuestion(tx, ORG))
    expect(after.roomLeft).toBe(before.roomLeft)
    expect(await lastQuestion()).toMatchObject({ outcome: "no_pudo" })
  })

  it("con el modelo de demostración responde lo cobrado sin proveedor", async () => {
    const answer = await askArgos(appDb, { platform: { fake: true }, secretsKey: KEY }, { orgId: ORG, userId: OWNER, memberRole: "admin", text: "¿Cuánto cobramos este mes?" })
    expect(answer).toMatchObject({ kind: "respuesta" })
  })
})
