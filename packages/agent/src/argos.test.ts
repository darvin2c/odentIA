process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

// Argos sobre las vistas del negocio (ADR 0075), de punta a punta con un modelo
// guionizado: el modelo recibe solo las vistas del rol y nunca un dato, la
// frase la llena el servidor, la base corrige al modelo una vez y cada pregunta
// queda anotada con su consulta y sin su texto. El periodo y la sede los pone
// odentIA y se cambian sin volver a llamar al modelo (D8 a D16).
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { patient, patientPayment } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { reportQuestion } from "@odentia/db/schema/reports"
import { getArgosAllowance, getArgosAnswer, getOrgLocale, secretsKeyFromEnv, updateAdminSettings } from "@odentia/services"
import { eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ARGOS_PANEL_AWAY, type ArgosDeps, type ArgosPlan, askArgos, rerunArgos, routeArgosQuestion, showArgosAnswer } from "./argos.js"
import type { DecisionModel } from "./decision/index.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("cc".repeat(32))
const ORG = "org_argos"
const OWNER = "user_argos"
const PATIENT_NAME = "Rosa Quispe"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

/** Un turno con herramientas: buscar nombres o calcular, antes de responder (D17). */
type ToolTurn = { tools: Array<{ name: string; args: Record<string, unknown> }> }

/** Modelo que responde con el plan del guion en cada llamada y guarda lo que recibió. */
class ScriptedModel extends BaseChatModel {
  calls: BaseMessage[][] = []
  constructor(private readonly plans: Array<Partial<ArgosPlan> | ToolTurn | Error>) {
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
    if ("tools" in next) {
      const message = new AIMessage({
        content: "",
        tool_calls: next.tools.map((call, index) => ({ name: call.name, args: call.args, id: `call-${this.calls.length}-${index}`, type: "tool_call" as const })),
      })
      return { generations: [{ text: "", message }] }
    }
    const args = {
      tipo: "consulta",
      sql: "",
      frase: "",
      frase_vacia: "",
      como: "",
      falta: "",
      sql_cercana: "",
      frase_cercana: "",
      titulo: "",
      pantalla: "ninguna",
      seguir: [],
      periodo: "a_hoy",
      compara: "no",
      otro_periodo: "",
      sede: "",
      ...next,
    }
    const message = new AIMessage({ content: "", tool_calls: [{ name: "responder", args, id: `call-${this.calls.length}`, type: "tool_call" }] })
    return { generations: [{ text: "", message }] }
  }
  sent(): string {
    return this.calls.flat().map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))).join("\n")
  }
}

const decides = (choice: "negocio" | "ayuda" | "buscar" | "otro"): DecisionModel => ({
  provider: "fake",
  reportsProbabilities: false,
  decide: async (_, questions) => ({
    answers: questions.map((question) => ({ id: question.id, kind: "choice", choice, probabilities: null, confidence: null })),
    model: "guion",
    usage: null,
    latencyMs: 0,
  }),
})

function deps(model: ScriptedModel, route: "negocio" | "ayuda" | "buscar" | "otro" = "negocio"): ArgosDeps {
  return { platform: { fake: true }, secretsKey: KEY, createModel: async () => model, decisionModel: decides(route) }
}

const ask = (model: ScriptedModel, text: string, memberRole = "owner", route?: "negocio" | "ayuda" | "buscar" | "otro") =>
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

/** Lo cobrado contra el periodo anterior, con el periodo y la sede que pone odentIA. */
const COBRADO_MES: Partial<ArgosPlan> = {
  periodo: "este_mes",
  compara: "anterior",
  sql: "select coalesce(sum(importe) filter (where momento >= :desde and momento < :hasta), 0) as cobrado_dinero, coalesce(sum(importe) filter (where momento >= :desde_antes and momento < :hasta_antes), 0) as antes_dinero from cobros where (:sede is null or sede = :sede)",
  frase: "{periodo} se cobró {cobrado_dinero}; {periodo_antes}, {antes_dinero}.",
  frase_vacia: "{periodo} no se cobró nada.",
  como: "Lo cobrado {periodo}, contra lo cobrado {periodo_antes}.",
}

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

  it("las opciones para seguir ya vienen corridas y la pregunta guarda su plan, sin el texto", async () => {
    const model = new ScriptedModel([
      {
        ...COBRADO,
        titulo: "Lo cobrado este mes",
        pantalla: "finanzas",
        seguir: [
          { etiqueta: "Por medio", sql: "select medio, sum(importe) as cobrado_dinero from cobros group by medio", frase: "Por medio: {lista}.", frase_vacia: "Nada.", como: "Por medio de pago." },
          { etiqueta: "Rota", sql: "select nada from cobros", frase: "{nada}", frase_vacia: "", como: "" },
        ],
      },
    ])
    const answer = await ask(model, "¿Cuánto cobramos este mes?")
    if (answer.kind !== "respuesta") throw new Error(answer.kind)
    expect(answer).toMatchObject({ title: "Lo cobrado este mes", screen: "finanzas" })
    // La que falla no se ofrece; la que corre llega lista, sin otra llamada al modelo.
    expect(answer.options).toHaveLength(1)
    expect(answer.options[0]).toMatchObject({ index: 0, label: "Por medio", how: "Por medio de pago." })
    expect(answer.options[0]?.answer.text).toMatch(/^Por medio: Efectivo \(S\/\s?1,250\.50\)\.$/)
    expect(model.calls).toHaveLength(1)
    const row = await lastQuestion()
    expect(row).toMatchObject({ id: answer.questionId, query: COBRADO.sql })
    expect(JSON.stringify(row?.plan)).not.toContain("¿Cuánto cobramos")
    // La que no se ofreció queda vacía: no se puede fijar ni descargar.
    expect(row?.plan).toMatchObject({ titulo: "Lo cobrado este mes", seguir: [{ etiqueta: "Por medio" }, null] })
  })

  it("lo que el buscador ya decidió no se le pregunta otra vez a Jev; un nombre suelto también se responde", async () => {
    const asked: string[] = []
    const jev: DecisionModel = { ...decides("ayuda"), decide: async (text, questions) => (asked.push(text), decides("ayuda").decide(text, questions)) }
    const model = new ScriptedModel([COBRADO, COBRADO])
    const routed = await askArgos(appDb, { ...deps(model), decisionModel: jev }, { orgId: ORG, userId: OWNER, memberRole: "owner", text: "¿Cuánto cobramos?", routed: true })
    expect(routed).toMatchObject({ kind: "respuesta" })
    expect(asked).toEqual([])
    expect(await ask(model, "rosa", "owner", "buscar")).toMatchObject({ kind: "respuesta" })
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

  it("en el panel, Jev solo despide como «otra cosa» si está seguro; la Ayuda sigue siendo suya y el buscador decide igual que antes", async () => {
    const sure = (choice: "ayuda" | "otro", confidence: number): DecisionModel => ({
      ...decides(choice),
      decide: async (_, questions) => ({
        answers: questions.map((question) => ({ id: question.id, kind: "choice", choice, probabilities: null, confidence })),
        model: "guion",
        usage: null,
        latencyMs: 0,
      }),
    })
    const panel = (model: DecisionModel) => routeArgosQuestion(model, "Ticket promedio por sede", () => "negocio", ARGOS_PANEL_AWAY)
    expect(await panel(sure("otro", 0.48))).toBe("negocio")
    expect(await panel(sure("otro", 1))).toBe("otro")
    expect(await panel(sure("ayuda", 0.72))).toBe("ayuda")
    expect(await routeArgosQuestion(sure("otro", 0.48), "Ticket promedio por sede")).toBe("otro")
  })

  it("Argos sabe quién pregunta y quién del equipo atiende pacientes", async () => {
    const model = new ScriptedModel([COBRADO])
    await ask(model, "¿Cuánto cobré yo este mes?")
    expect(model.sent()).toMatch(/Quien pregunta: .+ \(propietario\)\. «Yo», «mis pacientes» o «lo que atendí» es esta persona\./)
    expect(model.sent()).toMatch(/Atienden pacientes \(tienen horario o citas como profesional, lleven o no «Dr\.»\): /)
  })

  it("si el modelo responde algo que no se lee, se le pide otra vez una sola", async () => {
    const model = new ScriptedModel([{ ...COBRADO, tipo: "otra_cosa" as ArgosPlan["tipo"] }, COBRADO])
    expect(await ask(model, "¿Cuánto cobramos?")).toMatchObject({ kind: "respuesta" })
    expect(model.calls).toHaveLength(2)
    const twice = new ScriptedModel([{ ...COBRADO, tipo: "otra_cosa" as ArgosPlan["tipo"] }, { ...COBRADO, tipo: "otra_cosa" as ArgosPlan["tipo"] }])
    expect(await ask(twice, "¿Cuánto cobramos?")).toMatchObject({ kind: "sin_modelo" })
  })

  it("si el modelo no responde lo dice, y ese intento no gasta preguntas del mes", async () => {
    const before = await withOrgContext(appDb, ORG, (tx) => getArgosAllowance(tx, ORG))
    const answer = await ask(new ScriptedModel([new Error("proveedor caído")]), "¿Cuánto cobramos?")
    expect(answer).toMatchObject({ kind: "sin_modelo" })
    const after = await withOrgContext(appDb, ORG, (tx) => getArgosAllowance(tx, ORG))
    expect(after.used).toBe(before.used)
    expect(await lastQuestion()).toMatchObject({ outcome: "no_pudo" })
  })

  it("con el modelo de demostración responde lo cobrado sin proveedor", async () => {
    const answer = await askArgos(appDb, { platform: { fake: true }, secretsKey: KEY }, { orgId: ORG, userId: OWNER, memberRole: "admin", text: "¿Cuánto cobramos este mes?" })
    expect(answer).toMatchObject({ kind: "respuesta" })
  })

  it("el periodo lo pone odentIA: la consulta corre con sus fechas, la frase lo dice y la respuesta lo trae para cambiarlo", async () => {
    const model = new ScriptedModel([COBRADO_MES])
    const answer = await ask(model, "¿Cuánto cobramos comparado con el mes anterior?")
    if (answer.kind !== "respuesta") throw new Error(answer.kind)
    expect(answer.text).toMatch(/^(Del|El) .+ se cobró S\/\s?1,250\.50; en los mismos días de .+, S\/\s?0\.00\.$/)
    // El periodo no es una cifra: no va destacado.
    expect(answer.sentence.filter((part) => part.strong).map((part) => part.text)).toHaveLength(2)
    expect(answer.how).toMatch(/^Lo cobrado (del|el) .+, contra lo cobrado en los mismos días de .+\.$/)
    expect(answer.period).toMatchObject({
      value: "este_mes",
      grain: "mes",
      compare: "anterior",
      label: expect.stringMatching(/, hasta hoy$/),
      compareLabel: expect.stringMatching(/^los mismos días de /),
      branch: null,
    })
    // Se guarda la consulta con los nombres, no con las fechas: así se vuelve a correr con otras.
    expect(await lastQuestion()).toMatchObject({ query: COBRADO_MES.sql, plan: { periodo: { periodo: "este_mes", compara: "anterior" }, sede: null } })
  })

  it("si la consulta no usa el periodo que eligió, el modelo lo corrige una vez", async () => {
    const written = { ...COBRADO_MES, sql: "select sum(importe) as cobrado_dinero, 0 as antes_dinero from cobros where dia >= date_trunc('month', current_date)" }
    const model = new ScriptedModel([written, COBRADO_MES])
    expect(await ask(model, "¿Cuánto cobramos este mes?")).toMatchObject({ kind: "respuesta", query: COBRADO_MES.sql })
    expect(String(model.calls[1]?.at(-1)?.content)).toContain(":desde y :hasta")
    const wrongPeriod = new ScriptedModel([{ ...COBRADO_MES, periodo: "la_quincena" }, COBRADO_MES])
    expect(await ask(wrongPeriod, "¿Cuánto cobramos?")).toMatchObject({ kind: "respuesta" })
    expect(String(wrongPeriod.calls[1]?.at(-1)?.content)).toContain("«la_quincena» no sirve")
  })

  it("cambiar el periodo vuelve a correr la misma consulta sin el modelo ni gastar preguntas; solo quien preguntó", async () => {
    const model = new ScriptedModel([COBRADO_MES])
    const answer = await ask(model, "¿Cuánto cobramos comparado con el mes anterior?")
    if (answer.kind !== "respuesta") throw new Error(answer.kind)
    const before = await withOrgContext(appDb, ORG, (tx) => getArgosAllowance(tx, ORG))
    const rerun = await rerunArgos(appDb, { orgId: ORG, userId: OWNER, memberRole: "owner", questionId: answer.questionId, choice: { period: "mes_pasado" } })
    expect(model.calls).toHaveLength(1)
    expect(rerun.period).toMatchObject({ value: "mes_pasado", compare: "anterior", label: expect.not.stringContaining("hasta hoy") })
    expect(rerun.text).toMatch(/^En .+ se cobró S\/\s?0\.00; en .+, S\/\s?0\.00\.$/)
    expect(rerun.how).toMatch(/^Lo cobrado en .+, contra lo cobrado en .+\.$/)
    const after = await withOrgContext(appDb, ORG, (tx) => getArgosAllowance(tx, ORG))
    expect(after.used).toBe(before.used)
    await expect(rerunArgos(appDb, { orgId: ORG, userId: "otra_persona", memberRole: "owner", questionId: answer.questionId, choice: { period: "mes_pasado" } })).rejects.toMatchObject({ status: 404 })
    await expect(rerunArgos(appDb, { orgId: ORG, userId: OWNER, memberRole: "owner", questionId: answer.questionId, choice: { period: "2999-01" } })).rejects.toMatchObject({ status: 400 })
  })

  it("lo que es a hoy no lleva periodo; fijada, una respuesta con periodo sigue el de arriba (D11 y D12)", async () => {
    const today = await ask(new ScriptedModel([COBRADO]), "¿Cuánto nos han pagado?")
    if (today.kind !== "respuesta") throw new Error(today.kind)
    expect(today.period).toMatchObject({ value: "a_hoy", grain: null, label: expect.stringMatching(/^A hoy, /) })

    const answer = await ask(new ScriptedModel([COBRADO_MES]), "¿Cuánto cobramos comparado con el mes anterior?")
    if (answer.kind !== "respuesta") throw new Error(answer.kind)
    const { stored, zone } = await withOrgContext(appDb, ORG, async (tx) => ({ stored: await getArgosAnswer(tx, ORG, OWNER, answer.questionId), zone: await getOrgLocale(tx, ORG) }))
    const pinned = await showArgosAnswer(appDb, { orgId: ORG, memberRole: "owner", answer: stored, zone, choice: { period: "mes_pasado", branchId: null } })
    expect(pinned?.period).toMatchObject({ value: "mes_pasado", compare: "anterior" })
    expect(pinned?.text).toMatch(/^En .+ se cobró/)
  })

  it("la sede la pone odentIA: la que nombra la pregunta, otra elegida o todas (D13)", async () => {
    const [surco] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Surco" }).returning({ id: branch.id })
    await ownerDb.insert(branch).values({ organizationId: ORG, name: "Miraflores" })
    try {
      const answer = await ask(new ScriptedModel([{ ...COBRADO_MES, sede: "surco" }]), "¿Cuánto cobró Surco este mes?")
      if (answer.kind !== "respuesta") throw new Error(answer.kind)
      // El pago no es de Surco: con la sede elegida no se cobró nada; con todas, sí.
      expect(answer.text).toMatch(/se cobró S\/\s?0\.00;/)
      expect(answer.period.branch).toMatchObject({ id: surco!.id, options: [{ name: "Miraflores" }, { name: "Surco" }] })
      const all = await rerunArgos(appDb, { orgId: ORG, userId: OWNER, memberRole: "owner", questionId: answer.questionId, choice: { branchId: null } })
      expect(all.text).toMatch(/se cobró S\/\s?1,250\.50;/)
      expect(all.period.branch).toMatchObject({ id: null })

      const unknown = new ScriptedModel([{ ...COBRADO_MES, sede: "Lima" }, COBRADO_MES])
      expect(await ask(unknown, "¿Cuánto cobró Lima?")).toMatchObject({ kind: "respuesta" })
      expect(String(unknown.calls[1]?.at(-1)?.content)).toContain("las sedes son «Miraflores», «Surco»")
    } finally {
      // Una sede no se borra (tiene su almacén): se desactiva, y deja de ofrecerse.
      await ownerDb.update(branch).set({ isActive: false }).where(eq(branch.organizationId, ORG))
    }
  })

  it("por pasos: pide la cifra oficial, ve el resultado sin el paciente y responde con ella, que se marca oficial (D17 a D21)", async () => {
    const model = new ScriptedModel([
      {
        tools: [
          {
            name: "calcular",
            args: {
              id: "c1",
              cifra: { clave: "cobrado", por: ["medio"], filtros: [], parte_del_total: false, limite: null, orden: "mayor" },
              sql: "",
              periodo: "este_mes",
              compara: "no",
              otro_periodo: "",
              sede: "",
            },
          },
        ],
      },
      { calculo: "c1", frase: "{periodo} se cobró así: {lista}.", frase_vacia: "{periodo} no se cobró nada.", titulo: "Lo cobrado por medio", pantalla: "finanzas" },
    ])
    const steps: string[] = []
    const asked: string[] = []
    const answer = await askArgos(
      appDb,
      { ...deps(model), onStep: (text) => steps.push(text), onQuestion: (id) => asked.push(id) },
      { orgId: ORG, userId: OWNER, memberRole: "owner", text: "¿Cómo nos pagaron este mes?" },
    )
    if (answer.kind !== "respuesta") throw new Error(answer.kind)
    // Con el id de la pregunta se guarda lo que costó (ADR 0085): llega una vez, el mismo de la respuesta.
    expect(asked).toEqual([answer.questionId])
    expect(answer.source).toBe("oficial")
    expect(answer.text).toMatch(/se cobró así: Efectivo \(S\/\s?1,250\.50\)\.$/)
    expect(answer.how).toMatch(/^Pagos del periodo menos lo anulado y lo devuelto\..* Separado por medio de pago\.$/)
    expect(steps).toEqual(["Calculé lo cobrado, por medio de pago", "Revisando el resultado"])
    // Argos ve la cifra para revisar su cuenta (D20), pero nunca al paciente.
    expect(model.calls).toHaveLength(2)
    expect(model.sent()).toMatch(/Efectivo \| 1250\.50?(\D|$)/)
    expect(model.sent()).not.toContain(PATIENT_NAME)
    expect((await lastQuestion())?.plan).toMatchObject({ fuente: "oficial", cifra: "cobrado" })
  })

  it("un filtro con un nombre que la clínica no tiene vuelve al modelo con los que sí tiene, sin calcular", async () => {
    const model = new ScriptedModel([
      {
        tools: [
          {
            name: "calcular",
            args: {
              id: "c1",
              cifra: { clave: "cobrado", por: [], filtros: [{ corte: "especialidad", valores: ["implantes"] }], parte_del_total: false, limite: null, orden: "mayor" },
              sql: "",
              periodo: "este_mes",
              compara: "no",
              otro_periodo: "",
              sede: "",
            },
          },
        ],
      },
      { tipo: "no_existe", frase: "La clínica no tiene implantes.", falta: "No hay una especialidad de implantes." },
    ])
    const answer = await ask(model, "¿Cuánto vendimos en implantes?")
    expect(answer).toMatchObject({ kind: "no_existe" })
    expect(model.sent()).toMatch(/c1: no se pudo: «implantes» no es una especialidad de la clínica/)
  })

  it("con dos pacientes que se llaman igual, la pantalla pregunta cuál; elegir no llama al modelo y solo vale uno de los ofrecidos (D23)", async () => {
    const [twin] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: PATIENT_NAME }).returning({ id: contact.id })
    await ownerDb.insert(patient).values({ organizationId: ORG, personId: twin!.id, patientNumber: 2 })
    try {
      const model = new ScriptedModel([
        { tools: [{ name: "buscar_nombres", args: { textos: [PATIENT_NAME] } }] },
        {
          tools: [
            {
              name: "calcular",
              args: {
                id: "c1",
                cifra: null,
                sql: "select coalesce(sum(importe), 0) as pagado_dinero from cobros where paciente_id = :paciente",
                periodo: "a_hoy",
                compara: "no",
                otro_periodo: "",
                sede: "",
              },
            },
          ],
        },
        { calculo: "c1", frase: "Pagó {pagado_dinero}.", frase_vacia: "No pagó nada.", titulo: "Lo que pagó" },
      ])
      const answer = await ask(model, `¿Cuánto pagó ${PATIENT_NAME}?`)
      if (answer.kind !== "respuesta") throw new Error(answer.kind)
      expect(answer.source).toBe("argos")
      expect(answer.choose?.message).toBe(`Hay 2 pacientes que se llaman ${PATIENT_NAME}. ¿De cuál?`)
      expect(answer.choose?.options.map((option) => option.label)).toEqual([expect.stringMatching(/^Paciente desde .+, sin citas atendidas$/), expect.stringMatching(/^Paciente desde .+, sin citas atendidas$/)])
      expect(model.sent()).toMatch(/hay 2 pacientes con ese nombre/)
      const [first, second] = answer.choose?.options ?? []
      const pick = (patientId: string) => rerunArgos(appDb, { orgId: ORG, userId: OWNER, memberRole: "owner", questionId: answer.questionId, choice: { patientId } })
      expect((await pick(first!.id)).text).toMatch(/^Pagó S\/\s?1,250\.50\.$/)
      expect((await pick(second!.id)).text).toMatch(/^Pagó S\/\s?0\.00\.$/)
      expect(model.calls).toHaveLength(3)
      await expect(pick("00000000-0000-0000-0000-000000000000")).rejects.toThrow(/no es uno de los que se ofrecieron/)
    } finally {
      // Sin borrar (tiene vínculos que se crean solos): deja de llamarse igual.
      await ownerDb.update(contact).set({ displayName: "Otra persona" }).where(eq(contact.id, twin!.id))
    }
  })

  it("una respuesta junta varios cálculos del mismo periodo en una sola consulta, que se vuelve a correr igual", async () => {
    const figure = (clave: string) => ({ clave, por: [], filtros: [], parte_del_total: false, limite: null, orden: "mayor" })
    const calc = (id: string, clave: string) => ({ name: "calcular", args: { id, cifra: figure(clave), sql: "", periodo: "a_hoy", compara: "no", otro_periodo: "", sede: "" } })
    const model = new ScriptedModel([
      { tools: [calc("c1", "te_deben"), calc("c2", "deuda_vencida")] },
      { tipo: "parcial", calculo: "c1, c2", frase: "Te deben {te_deben_dinero}; de eso, hace más de 30 días {c2_deuda_vencida_dinero}.", frase_vacia: "Nadie debe.", falta: "odentIA no da consejos." },
    ])
    const answer = await ask(model, "¿A quién cobro primero?")
    if (answer.kind !== "respuesta") throw new Error(answer.kind)
    expect(answer.text).toMatch(/^Te deben S\/\s?0\.00; de eso, hace más de 30 días S\/\s?0\.00\.$/)
    expect(answer.source).toBe("oficial")
    expect(answer.query).toMatch(/^with c1 as \(.+\), c2 as \(.+\) select c1\.\*, c2\.deuda_vencida_dinero as c2_deuda_vencida_dinero from c1 left join c2 on true$/)
    expect(answer.how).toMatch(/Lo que debe cada persona hoy.+más de 30 días/)
    const again = await rerunArgos(appDb, { orgId: ORG, userId: OWNER, memberRole: "owner", questionId: answer.questionId, choice: {} })
    expect(again.text).toBe(answer.text)
  })

  it("la respuesta que falla en el último turno tiene su corrección, y el id del cálculo delante de su columna se entiende", async () => {
    const figure = (clave: string) => ({ clave, por: [], filtros: [], parte_del_total: false, limite: null, orden: "mayor" })
    const calc = (id: string, clave: string) => ({ name: "calcular", args: { id, cifra: figure(clave), sql: "", periodo: "a_hoy", compara: "no", otro_periodo: "", sede: "" } })
    const model = new ScriptedModel([
      { tools: [{ name: "buscar_nombres", args: { textos: ["Surco"] } }] },
      { tools: [calc("c1", "deuda_vencida")] },
      { tools: [calc("c2", "te_deben")] },
      { calculo: "c2", frase: "Te deben {deuda}.", frase_vacia: "Nadie debe.", titulo: "Lo que te deben" },
      { calculo: "c2", frase: "Te deben {c2_te_deben_dinero}.", frase_vacia: "Nadie debe.", titulo: "Lo que te deben" },
    ])
    const answer = await ask(model, "¿Cuánto me deben?")
    if (answer.kind !== "respuesta") throw new Error(answer.kind)
    expect(answer.text).toMatch(/^Te deben S\/\s?0\.00\.$/)
    expect(model.calls).toHaveLength(5)
    expect(model.sent()).toMatch(/sus columnas son \{te_deben_dinero\}/)
  })

  it("dos listas se juntan por lo que comparten, sin volver a consultar; la columna del otro cálculo se dice sin su id", async () => {
    const sqlCalc = (id: string, sql: string) => ({ name: "calcular", args: { id, cifra: null, sql, periodo: "a_hoy", compara: "no", otro_periodo: "", sede: "" } })
    const model = new ScriptedModel([
      { tools: [sqlCalc("c1", "select medio, sum(importe) as cobrado_dinero from cobros group by medio"), sqlCalc("c2", "select medio, count(*)::int as pagos from cobros group by medio")] },
      { calculo: "c1, c2", frase: "Por medio: {lista}.", frase_vacia: "Nada.", titulo: "Por medio" },
    ])
    const answer = await ask(model, "¿Cómo nos pagan?")
    if (answer.kind !== "respuesta") throw new Error(answer.kind)
    expect(answer.text).toMatch(/^Por medio: Efectivo \(S\/\s?1,250\.50, pagos: 1\)\.$/)
    expect(answer.query).toMatch(/from c1 left join c2 using \(medio\)$/)
    expect(answer.table.columns.map((column) => column.label)).toEqual(["Medio", "Cobrado", "Pagos"])
  })

  it("un resumen de una fila y una lista se juntan con la lista de base, aunque el resumen se nombre primero", async () => {
    const sqlCalc = (id: string, sql: string) => ({ name: "calcular", args: { id, cifra: null, sql, periodo: "a_hoy", compara: "no", otro_periodo: "", sede: "" } })
    const model = new ScriptedModel([
      {
        tools: [
          sqlCalc("c1", "select sum(importe) as total_dinero from cobros"),
          sqlCalc("c2", "select medio, sum(importe) as cobrado_dinero from cobros group by medio union all select 'Yape', 0"),
        ],
      },
      { calculo: "c1, c2", frase: "Se cobró {c1_total_dinero}; el primero es {c2_medio}. Por medio: {lista}.", frase_vacia: "Nada.", titulo: "Por medio" },
    ])
    const answer = await ask(model, "¿Cómo nos pagan?")
    if (answer.kind !== "respuesta") throw new Error(answer.kind)
    // La lista va debajo, en la tabla: la frase no la repite.
    expect(answer.text).toMatch(/^Se cobró S\/\s?1,250\.50; el primero es Efectivo\. Por medio:$/)
    expect(answer.query).toMatch(/^with c2 as \(.+\), c1 as \(.+\) select c2\.\*, c1\.total_dinero as c1_total_dinero from c2 left join c1 on true$/)
  })
})
