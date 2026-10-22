process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

/**
 * Prueba real de consumo de Argos (el agente administrador): un mes de una clínica de prueba,
 * sin escribirle a nadie. Uso:
 *
 *   pnpm --filter @odentia/agent eval:month
 *
 * Qué hace:
 *  1. Arma una clínica inventada (pacientes, citas, inasistencias, cancelaciones,
 *     presupuestos y controles de 30 días) en una base efímera.
 *  2. Corre el ciclo real del Administrador hora por hora durante ese mes. Los
 *     mensajes quedan en la cola: no hay proveedor que los envíe. «¿Ya avisó
 *     algo?» lo responde el modelo de decisión real y se cuentan sus tokens.
 *  3. Hace responder con texto a una persona de cada línea y deja que Recepción
 *     siga la conversación con el modelo real; los tokens se leen del libro de
 *     corridas, que ya los guarda por llamada.
 *  4. Proyecta el mes: veces que ocurre cada cosa × tokens de esa cosa, separado
 *     en el modelo de decisión y el que escribe.
 *
 * Las veces del paso 2 las cuenta el motor; cuántas personas responden con
 * texto es un supuesto (`REPLY_RATE`), porque depende de cada clínica. Con
 * `LLM_MODEL=fake` es un ensayo del guion: no mide nada.
 *
 * Es evidencia de esta clínica inventada y de estos guiones, no de una real.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { AIMessage, BaseMessage } from "@langchain/core/messages"
import { whatsappCloudApiAdapter } from "@odentia/channels"
import { createAppDb, createOwnerDb, type Db, seedProcedureCodes, withOrgContext } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { agentDecisionLog, agentRunLedger } from "@odentia/db/schema/agent"
import { automationConsent, automationJob, automationRule } from "@odentia/db/schema/automation"
import { clinicalFollowUp, patientContact, treatmentBudget, treatmentPlan } from "@odentia/db/schema/clinical"
import { orgSpecialty, professionalSpecialty } from "@odentia/db/schema/clinical-forms"
import { contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent, branch } from "@odentia/db/schema/org"
import {
  ADMIN_LINES,
  adminLineOf,
  AUTOMATION_MESSAGES,
  createRoom,
  createConnection,
  createKnowledgeEntry,
  createPaymentMethod,
  createService,
  CUSTOM_LINES,
  ingestInbound,
  replyId,
  secretsKeyFromEnv,
  setAppointmentStatus,
  setKnowledgeStatus,
  setLine,
  setProfessionalSchedule,
  tickAutomations,
  updateAdminSettings,
  upsertAgentConfig,
  librarySpecialtyIds,
} from "@odentia/services"
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, it } from "vitest"
import { ALREADY_TOLD_MIN, ALREADY_TOLD_QUESTION, alreadyToldState } from "./admin.js"
import { createJevDecisionModel, type DecisionModel } from "./decision/index.js"
import { UNSENT_TEXT } from "./graph.js"
import { AGENT_MODEL, platformLlmFromEnv } from "./llm.js"
import { type AgentRuntime, processAgentRun } from "./run.js"
import { insertTestPatients } from "@odentia/services/test-patient"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("cc".repeat(32))
const ORG = "org_mes"
const HOUR = 3_600_000
const DAY = 24 * HOUR
const env = process.env
const REAL = (env.LLM_MODEL ?? "fake") !== "fake"

/** La clínica inventada: mediana, una sede, un mes. */
const CLINIC = {
  days: 30,
  patients: 400,
  appointmentsPerDay: 20,
  noShow: 0.08,
  cancelledByPerson: 0.05,
  budgets: 40,
  budgetsDecidedSoon: 0.3,
  controls: 60,
  acceptsReminders: 0.7,
  acceptsOtherMessages: 0.6,
  hasWhatsApp: 0.9,
  /** De quienes entran a un seguimiento, cuántos le escribieron a la clínica poco antes. */
  wroteBefore: 0.25,
}

/**
 * Supuestos, no mediciones: de cada cien personas que reciben el mensaje,
 * cuántas responden con texto (lo demás es silencio o un botón que no pasa por
 * ningún modelo). Cambian con cada clínica; aquí solo sirven para proyectar.
 */
const REPLY_RATE: Record<string, number> = {
  recordatorio_cita: 0.1,
  recordatorio_control: 0.3,
  seguimiento_presupuesto: 0.3,
  seguimiento_no_asistencia: 0.3,
  cita_cancelada: 0.3,
}
/** Pedidos con palabras al mes, y lo que costó entender uno con Jev (`eval:admin`, 2026-10-12). */
const REQUESTS_PER_MONTH = 10
const REQUEST_TOKENS = 1_525

/** Lo que la persona escribiría al responder, por línea. El primero es el botón que toca. */
const SCRIPTS: Array<{ kind: string; label: string; button: "responder" | null; turns: string[] }> = [
  { kind: "recordatorio_cita", label: "no podrá ir y pide otra fecha", button: "responder", turns: ["No podré ir", "¿Me la pueden pasar para la próxima semana, de preferencia en la mañana?", "El primer horario está bien, gracias"] },
  { kind: "recordatorio_control", label: "quiere agendar su control", button: "responder", turns: ["Quiero agendar", "¿Qué horarios tienen la próxima semana?", "El primero está bien"] },
  { kind: "seguimiento_presupuesto", label: "pregunta y quiere empezar", button: "responder", turns: ["Quiero retomarlo", "¿Se puede pagar en partes?", "Ok, quiero una cita para empezar la próxima semana", "El primer horario está bien"] },
  { kind: "seguimiento_no_asistencia", label: "reprograma", button: "responder", turns: ["Sí, otro horario", "¿Tienen algo la próxima semana por la mañana?", "El primero está bien"] },
  { kind: "cita_cancelada", label: "pide otra fecha", button: "responder", turns: ["Sí, otra fecha", "La próxima semana por la tarde, si se puede", "El primero está bien"] },
  { kind: "seguimiento_no_asistencia", label: "responde corto", button: null, turns: ["Gracias, yo les aviso"] },
]

/**
 * Preguntas de alguien que escribe por primera vez, como las escribe la gente:
 * con jerga («yapear», «plinear»), sin tildes y con faltas. Sirven para ver si
 * el agente encuentra lo que la clínica sí tiene (medios de pago, servicios,
 * quién atiende cada especialidad) cuando no se le pregunta con sus palabras.
 */
const QUESTIONS: Array<{ label: string; turns: string[] }> = [
  { label: "medio de pago, con su nombre", turns: ["aceptan yape?"] },
  { label: "medio de pago, como verbo", turns: ["te puedo yapear o plinear la inicial??"] },
  { label: "servicio mal escrito y quién lo atiende", turns: ["trabajan con endodocias?", "y quien es el especialista? quiero cita con el"] },
  { label: "todo mal escrito", turns: ["ola kiero saber si asen endodonsia y cuanto sale"] },
]

/**
 * Con `CATALOGO=grande` la clínica tiene un tarifario como el de una clínica
 * real (decenas de prestaciones por especialidad) en vez de cinco servicios, y
 * se pregunta por dos que quedan al final del orden alfabético. Sirve para ver
 * qué pasa cuando los servicios no caben en lo que el agente lee.
 */
const BIG_CATALOG = env.CATALOGO === "grande"
/**
 * En el Perú cada servicio propio lleva su código CPMS (ADR 0069). Aquí no se
 * mide el código: basta uno vigente por tipo de tratamiento.
 */
const CPMS_OF_KIND: Record<string, string> = {
  diagnostico: "D0150",
  prevencion: "D1110",
  restauradora: "D2391",
  endodoncia: "D3310",
  periodoncia: "D4341",
  cirugia: "D7140",
  protesis: "D2740",
  implantologia: "D6010",
  ortodoncia: "D8670",
  odontopediatria: "D1351",
  estetica: "D9972",
  disfuncion: "D9940",
}
const CATALOG: Array<[string, string, string[]]> = [
  ["diagnostico", "general", ["Radiografía periapical", "Radiografía panorámica", "Radiografía bite wing", "Tomografía cone beam", "Modelos de estudio", "Fotografías clínicas", "Interconsulta"]],
  ["prevencion", "general", ["Profilaxis", "Aplicación de flúor barniz", "Aplicación de flúor gel", "Instrucción de higiene", "Destartraje supragingival"]],
  ["restauradora", "tooth", ["Resina simple anterior", "Resina simple posterior", "Resina compuesta anterior", "Resina compuesta posterior", "Resina compleja", "Incrustación de resina", "Incrustación de cerámica", "Ionómero de vidrio", "Reconstrucción de muñón", "Carilla de resina", "Carilla de porcelana"]],
  ["endodoncia", "tooth", ["Endodoncia unirradicular", "Endodoncia birradicular", "Endodoncia multirradicular", "Retratamiento de conducto unirradicular", "Retratamiento de conducto multirradicular", "Pulpotomía", "Pulpectomía", "Apicectomía", "Apexificación"]],
  ["periodoncia", "general", ["Raspado y alisado radicular por cuadrante", "Gingivectomía por sextante", "Injerto gingival", "Alargamiento de corona", "Curetaje a campo abierto", "Mantenimiento periodontal", "Ferulización"]],
  ["cirugia", "tooth", ["Extracción simple", "Extracción compleja", "Extracción de tercera molar erupcionada", "Extracción de tercera molar semiimpactada", "Extracción de tercera molar impactada", "Frenectomía", "Biopsia", "Drenaje de absceso", "Regularización de reborde"]],
  ["protesis", "general", ["Corona metal porcelana", "Corona de zirconio", "Corona de disilicato de litio", "Corona provisional", "Puente fijo por pieza", "Prótesis total superior", "Prótesis total inferior", "Prótesis parcial removible acrílica", "Prótesis parcial removible metálica", "Prótesis flexible", "Perno de fibra de vidrio", "Perno colado", "Rebase de prótesis", "Reparación de prótesis"]],
  ["implantologia", "tooth", ["Implante dental", "Corona sobre implante", "Elevación de seno maxilar", "Injerto óseo", "Pilar de cicatrización", "Sobredentadura sobre implantes"]],
  ["ortodoncia", "general", ["Ortodoncia con brackets metálicos", "Ortodoncia con brackets estéticos", "Ortodoncia con autoligado", "Ortodoncia con alineadores", "Retenedor fijo", "Retenedor removible", "Reposición de bracket"]],
  ["odontopediatria", "tooth", ["Sellante por pieza", "Corona de acero", "Mantenedor de espacio", "Pulpotomía en diente de leche", "Adaptación del niño a la consulta"]],
  ["estetica", "general", ["Blanqueamiento en consultorio", "Blanqueamiento casero", "Blanqueamiento interno", "Diseño de sonrisa", "Microabrasión"]],
  ["disfuncion", "general", ["Férula de descarga", "Ajuste oclusal", "Placa miorrelajante"]],
]

/** Lo que alguien pudo haberle escrito a la clínica antes: unas veces del asunto, otras no. */
const WROTE = {
  about: [
    "No voy a poder ir, se me complicó el trabajo",
    "¿Me pueden dar otra fecha? No alcancé a llegar",
    "Lo estuve pensando y por ahora no voy a hacerme el tratamiento",
    "Cancelé porque estoy de viaje, les escribo cuando vuelva",
    "Me parece caro, ¿tienen facilidades de pago?",
  ],
  other: ["Hola, ¿cuánto cuesta una limpieza?", "¿Atienden los sábados?", "Gracias", "¿Tienen estacionamiento?", "Buenas tardes"],
}

// Números repetibles: la misma clínica en cada corrida.
let seed = 20261012
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const chance = (p: number) => random() < p
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let runtime: AgentRuntime
let decider: DecisionModel | null = null
let connectionId: string

const storageStub = {
  putAvatar: async () => { throw new Error("no usado") },
  deleteByUrl: async () => {},
  putAttachment: async () => { throw new Error("no usado") },
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => { throw new Error("no usado") },
  putPatientAvatar: async () => { throw new Error("no usado") },
}

const inOrg = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, ORG, fn)

/** Una llamada al modelo que escribe, tal como salió: qué se le mandó y qué cobró el proveedor. */
interface ModelCall {
  tools: string[]
  toolsChars: number
  system: string
  messages: number
  /** Todo lo enviado, en el orden en que viaja: herramientas, sistema e historial. */
  prompt: string
  input: number
  cached: number
  output: number
  did: string
}
const modelCalls: ModelCall[] = []
const started = new Map<string, ModelCall>()
const textOf = (item: BaseMessage) => (typeof item.content === "string" ? item.content : JSON.stringify(item.content))
/** Lo que el modelo escribió como texto, sin pensamiento ni llamadas. */
const writtenOf = (item: BaseMessage) =>
  typeof item.content === "string"
    ? item.content
    : item.content.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("")
/** Registra cada llamada sin tocarla: solo lee lo que el grafo ya envía. */
const recorder = BaseCallbackHandler.fromMethods({
  handleChatModelStart(_llm, batches, runId, _parent, extra) {
    const list = batches[0] ?? []
    const tools = ((extra?.invocation_params as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools ?? [])
    const toolsJson = JSON.stringify(tools)
    const system = list[0] ? textOf(list[0]) : ""
    const rest = list.slice(1).map((item) => `${item.getType()}:${textOf(item)}${JSON.stringify((item as AIMessage).tool_calls ?? "")}`).join("\n")
    // La llamada que sigue al aviso de texto sin enviar lo dice en el paso a paso.
    const reminded = list.at(-1)?.content === UNSENT_TEXT
    started.set(runId, {
      tools: tools.map((item) => item.function?.name ?? "?"), toolsChars: toolsJson.length, system, messages: list.length,
      prompt: `${toolsJson}\n${system}\n${rest}`, input: 0, cached: 0, output: 0, did: reminded ? "tras el aviso: " : "",
    })
  },
  handleLLMEnd(output, runId) {
    const call = started.get(runId)
    if (!call) return
    started.delete(runId)
    const reply = (output.generations[0]?.[0] as { message?: AIMessage } | undefined)?.message
    const usage = reply?.usage_metadata
    call.input = usage?.input_tokens ?? 0
    call.output = usage?.output_tokens ?? 0
    call.cached = usage?.input_token_details?.cache_read ?? 0
    call.did += reply?.tool_calls?.length
      ? reply.tool_calls.map((item) => item.name).join(" + ")
      : `texto, sin herramienta: «${(reply ? writtenOf(reply) : "").replace(/\s+/g, " ").trim().slice(0, 160)}»`
    modelCalls.push(call)
  },
})
function sharedPrefix(a: string, b: string): number {
  let index = 0
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1
  return index
}
/** Guiones a correr: todos, o solo las líneas de `GUIONES` (separadas por coma). */
const ONLY = (env.GUIONES ?? "").split(",").map((item) => item.trim()).filter(Boolean)

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({ POSTGRES_DB: "dentalagent", POSTGRES_USER: "dentalagent", POSTGRES_PASSWORD: "dentalagent", POSTGRES_APP_PASSWORD: "dentalagent_app" })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  const host = container.getHost()
  const port = container.getMappedPort(5432)
  const ownerUri = `postgres://dentalagent:dentalagent@${host}:${port}/dentalagent`
  ownerDb = createOwnerDb(ownerUri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}:${port}/dentalagent`)
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Clínica Sonríe', 'mes', now())`)
  await ownerDb.execute(sql`insert into "org_profile" ("organization_id", "legal_name", "trade_name", "country_code", "currency", "timezone", "locale") values (${ORG}, 'Clínica Sonríe', 'Clínica Sonríe', 'PE', 'PEN', 'America/Lima', 'es-PE') on conflict do nothing`)
  const decisions = {
    ...(env.JEV_API_KEY ? { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL } } : {}),
    timeoutMs: Number(env.DECISIONS_TIMEOUT_MS ?? 8000),
  }
  runtime = {
    // La clínica inventada usa el modelo de toda clínica (`chatgpt_6`) con las cuentas del entorno.
    platform: REAL ? { ...platformLlmFromEnv(env), timeoutMs: 120_000, maxRetries: 2 } : { fake: true },
    decisions,
    secretsKey: KEY,
    callbacks: [recorder],
  }
  if (REAL && decisions.jev) decider = createJevDecisionModel({ ...decisions.jev, timeoutMs: decisions.timeoutMs })
}, 300_000)

afterAll(async () => {
  await container?.stop().catch(() => {})
})

interface Person {
  patientId: string
  contactId: string
  phone: string | null
  identityId: string | null
}

it("un mes de una clínica de prueba: cuántos tokens gasta cada modelo", async () => {
  const end = new Date()
  end.setUTCMinutes(0, 0, 0)
  const start = new Date(end.getTime() - CLINIC.days * DAY)
  const owner = "owner-mes"
  // Ids neutros: un id que dijera «especialista» le soplaría al modelo algo que el sistema no le entrega.
  const professional = "usuario-mes-2"
  const specialist = "usuario-mes-3"

  // ---------------------------------------------------------------- la clínica ---
  await ownerDb.execute(sql`insert into "user" ("id", "name", "email", "email_verified") values
    (${owner}, 'Ana Ruiz', 'ana@mes.test', true), (${professional}, 'Dra. Carla Ríos', 'carla@mes.test', true)`)
  await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
    ('m-owner-mes', ${ORG}, ${owner}, 'owner', now()), ('m-usuario-mes-2', ${ORG}, ${professional}, 'clinician', now())`)
  const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const branchId = site!.id
  const room = await inOrg((tx) => createRoom(tx, ORG, { branchId, name: "Unidad dental 1" }))
  await inOrg((tx) =>
    setProfessionalSchedule(tx, ORG, owner, {
      branchId,
      professionalUserId: professional,
      rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 18 * 60 })),
    }))
  // Un segundo profesional, adscrito a Endodoncia, que atiende dos días: lo que
  // la clínica sabe sobre quién hace cada cosa.
  await ownerDb.execute(sql`insert into "user" ("id", "name", "email", "email_verified") values (${specialist}, 'Dr. Luis Peña', 'luis@mes.test', true)`)
  await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values ('m-usuario-mes-3', ${ORG}, ${specialist}, 'clinician', now())`)
  const [endo] = await ownerDb.insert(orgSpecialty).values({ organizationId: ORG, key: "endodoncia", name: "Endodoncia" }).returning({ id: orgSpecialty.id })
  await ownerDb.insert(professionalSpecialty).values({ organizationId: ORG, specialtyId: endo!.id, userId: specialist })
  await inOrg((tx) => createRoom(tx, ORG, { branchId, name: "Unidad dental 2" }))
  await inOrg((tx) =>
    setProfessionalSchedule(tx, ORG, owner, {
      branchId,
      professionalUserId: specialist,
      rules: [2, 4].map((weekday) => ({ weekday, startMin: 15 * 60, endMin: 19 * 60 })),
    }))
  await seedProcedureCodes(ownerDb)
  await inOrg(async (tx) => {
    // Cada servicio va a la especialidad de la clínica con esa clave de la biblioteca (ADR 0039).
    const specialtyOf = await librarySpecialtyIds(tx, ORG, CATALOG.map(([key]) => key).concat(["diagnostico", "prevencion", "endodoncia", "estetica", "ortodoncia"]))
    for (const { specialty, ...service } of [
      { name: "Consulta de evaluación", specialty: "diagnostico", scope: "general", priceCents: 5000, durationMin: 30 },
      { name: "Limpieza dental", specialty: "prevencion", scope: "general", priceCents: 12000, durationMin: 40 },
      { name: "Endodoncia (tratamiento de conducto)", specialty: "endodoncia", scope: "tooth", priceCents: 45000, durationMin: 60 },
      { name: "Blanqueamiento", specialty: "estetica", scope: "general", priceCents: 60000, durationMin: 60 },
      { name: "Control de ortodoncia", specialty: "ortodoncia", scope: "general", priceCents: 8000, durationMin: 20 },
    ]) await createService(tx, ORG, owner, { ...service, specialtyId: specialtyOf.get(specialty), officialCode: CPMS_OF_KIND[specialty] })
    if (BIG_CATALOG) {
      let price = 4000
      for (const [specialty, scope, names] of CATALOG) {
        for (const name of names) {
          price += 1500
          await createService(tx, ORG, owner, { name, specialtyId: specialtyOf.get(specialty), scope, priceCents: price, durationMin: 30, officialCode: CPMS_OF_KIND[specialty] })
        }
      }
    }
    for (const [name, typeCode] of [["Efectivo", "10"], ["Tarjeta", "48"], ["Transferencia", "30"], ["Yape", "68"], ["Plin", "68"]] as const) {
      await createPaymentMethod(tx, ORG, owner, { name, typeCode })
    }
  })
  connectionId = (
    await inOrg((tx) =>
      createConnection(tx, ORG, KEY, {
        channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WhatsApp de prueba",
        config: {
          phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S",
          // Todos sus mensajes aprobados: es el caso en que más escribe.
          templates: Object.values(AUTOMATION_MESSAGES).map((spec) => ({ name: spec.template, language: "es" })),
        },
      }, { fetch, validateExternal: false }))
  ).id
  await inOrg(async (tx) => {
    await upsertAgentConfig(tx, ORG, { enabled: true, ...(decider ? { decisionProvider: "jev" as const, decisionRoutingEnabled: true } : {}) })
    await updateAdminSettings(tx, ORG, owner, { enabled: true })
    for (const [title, body] of [
      ["Horario de atención", "Atendemos de lunes a sábado, de 9:00 a 18:00."],
      ["Pago en partes", "Los tratamientos largos se pueden pagar en partes, con una inicial. Los medios de pago son los que acepta caja."],
      ["Estacionamiento", "Hay estacionamiento para pacientes en el sótano del edificio."],
      ["Cambiar o cancelar una cita", "Puedes cambiar o cancelar tu cita hasta con 24 horas de anticipación, respondiendo por este medio."],
      ["Primera cita", "La primera cita es una evaluación; trae tu documento de identidad."],
      ["Controles", "Los controles de ortodoncia son una vez al mes y duran unos 20 minutos."],
    ] as const) {
      const entry = await createKnowledgeEntry(tx, ORG, null, { kind: "faq", title, body })
      await setKnowledgeStatus(tx, ORG, null, entry.id, "publicada")
    }
  })

  // ------------------------------------------------------------------ personas ---
  const names = ["Lucía", "Jorge", "Rosa", "Tomás", "Mariana", "Diego", "Elena", "Pablo", "Carmen", "Luis"]
  const surnames = ["Paredes", "Salas", "Medina", "Rivas", "Soto", "Vega", "Campos", "Núñez", "Flores", "Quispe"]
  const created = await insertTestPatients(ownerDb, 
      Array.from({ length: CLINIC.patients }, (_, index) => {
        const given = names[index % names.length]!
        return { organizationId: ORG, displayName: `${given} ${surnames[Math.floor(index / names.length) % surnames.length]} ${index + 1}`, givenNames: given, patientNumber: index + 1 }
      }),
    )
  const links = await ownerDb.select({ patientId: patientContact.patientId, contactId: patientContact.contactId }).from(patientContact).where(eq(patientContact.organizationId, ORG))
  const contactOf = new Map(links.map((row) => [row.patientId, row.contactId]))
  const people: Person[] = created.map((row, index) => ({
    patientId: row.id,
    contactId: contactOf.get(row.id)!,
    phone: chance(CLINIC.hasWhatsApp) ? `5199${String(index).padStart(7, "0")}` : null,
    identityId: null,
  }))
  const identities = await ownerDb
    .insert(contactIdentity)
    .values(people.filter((person) => person.phone).map((person) => ({ organizationId: ORG, contactId: person.contactId, channel: "whatsapp", externalUserId: person.phone!, isPrimary: true })))
    .returning({ id: contactIdentity.id, contactId: contactIdentity.contactId })
  const identityOf = new Map(identities.map((row) => [row.contactId, row.id]))
  for (const person of people) person.identityId = identityOf.get(person.contactId) ?? null
  await ownerDb.insert(automationConsent).values(
    people.flatMap((person) => [
      ...(chance(CLINIC.acceptsReminders) ? [{ organizationId: ORG, contactId: person.contactId, purpose: "recordatorio", status: "granted", source: "registro" }] : []),
      ...(chance(CLINIC.acceptsOtherMessages) ? [{ organizationId: ORG, contactId: person.contactId, purpose: "seguimiento", status: "granted", source: "registro" }] : []),
    ]),
  )

  // ------------------------------------------------------- lo que pasa en el mes ---
  type Event =
    | { at: number; type: "cancel"; appointmentId: string }
    | { at: number; type: "wrote"; person: Person; text: string }
  const events: Event[] = []
  const wroteBefore = (person: Person, at: number) => {
    if (person.phone && chance(CLINIC.wroteBefore)) events.push({ at, type: "wrote", person, text: pick(chance(0.4) ? WROTE.about : WROTE.other) })
  }
  const plan: Array<{ startsAt: Date; endsAt: Date; outcome: "atendida" | "no_asistio" | "cancelada"; person: Person }> = []
  for (let day = 1; day <= CLINIC.days; day += 1) {
    // 9:00 de Lima son las 14:00 UTC; una cita cada diez minutos.
    const first = new Date(start.getTime() + day * DAY)
    first.setUTCHours(14, 0, 0, 0)
    for (let slot = 0; slot < CLINIC.appointmentsPerDay; slot += 1) {
      const startsAt = new Date(first.getTime() + slot * 10 * 60_000)
      const roll = random()
      const outcome = roll < CLINIC.noShow ? "no_asistio" : roll < CLINIC.noShow + CLINIC.cancelledByPerson ? "cancelada" : "atendida"
      plan.push({ startsAt, endsAt: new Date(startsAt.getTime() + 10 * 60_000), outcome, person: pick(people) })
    }
  }
  // La agenda sigue después de hoy, como en una clínica de verdad. Sin el día de
  // mañana, el último recordatorio sería de una cita que ya pasó cuando Rosa
  // responde, y Recepción tendría razón al no encontrarla (darvin2c/odentIA#132).
  // Estas citas no terminan dentro del mes y no sacan números al azar: lo demás
  // del mes sale igual que antes; solo se suman sus recordatorios de hoy.
  const tomorrow = new Date(start.getTime() + (CLINIC.days + 1) * DAY)
  tomorrow.setUTCHours(14, 0, 0, 0)
  for (let slot = 0; slot < CLINIC.appointmentsPerDay; slot += 1) {
    const startsAt = new Date(tomorrow.getTime() + slot * 10 * 60_000)
    plan.push({ startsAt, endsAt: new Date(startsAt.getTime() + 10 * 60_000), outcome: "atendida", person: people[slot % people.length]! })
  }
  const appointments = await ownerDb
    .insert(appointment)
    .values(plan.map((item) => ({
      organizationId: ORG, branchId, patientId: item.person.patientId, professionalUserId: professional, roomId: room.id,
      startsAt: item.startsAt, endsAt: item.endsAt, durationMin: 10, status: "programada",
    })))
    .returning({ id: appointment.id })
  const outcomes = plan.map((item, index) => ({ ...item, id: appointments[index]!.id, done: false }))
  for (const item of outcomes) {
    if (item.outcome === "cancelada") {
      const at = item.startsAt.getTime() - (6 + Math.floor(random() * 24)) * HOUR
      events.push({ at, type: "cancel", appointmentId: item.id })
      wroteBefore(item.person, at - 30 * 60_000)
    }
    if (item.outcome === "no_asistio") wroteBefore(item.person, item.startsAt.getTime() - Math.floor(random() * 20) * HOUR)
  }
  for (let index = 0; index < CLINIC.budgets; index += 1) {
    const person = pick(people)
    const presentedAt = new Date(start.getTime() + (1 + random() * (CLINIC.days - 5)) * DAY)
    const decided = chance(CLINIC.budgetsDecidedSoon)
    const [treatment] = await ownerDb.insert(treatmentPlan).values({ organizationId: ORG, patientId: person.patientId, title: "Plan" }).returning({ id: treatmentPlan.id })
    await ownerDb.insert(treatmentBudget).values({
      organizationId: ORG, patientId: person.patientId, planId: treatment!.id, budgetNumber: index + 1, title: pick(["Ortodoncia", "Implante", "Blanqueamiento", "Rehabilitación"]), currency: "PEN",
      status: decided ? "aceptado" : "presentado", presentedAt, ...(decided ? { decidedAt: new Date(presentedAt.getTime() + 20 * HOUR) } : {}),
    })
    if (!decided) wroteBefore(person, presentedAt.getTime() + 30 * HOUR)
  }
  await ownerDb.insert(clinicalFollowUp).values(
    Array.from({ length: CLINIC.controls }, () => ({
      organizationId: ORG, patientId: pick(people).patientId, kind: "mantenimiento", title: "Control de ortodoncia",
      dueAt: new Date(start.getTime() + (2 + random() * (CLINIC.days - 2)) * DAY),
    })),
  )
  events.sort((a, b) => a.at - b.at)

  // Las líneas, prendidas al empezar el mes: actúan sobre lo que pase desde entonces.
  // La clínica inventada no tiene oportunidades: «Retomar una oportunidad» queda prendida y sin casos.
  const lines = [...ADMIN_LINES, ...CUSTOM_LINES]
  await inOrg(async (tx) => {
    for (const line of lines) await setLine(tx, ORG, owner, line.key, { enabled: true })
  })
  await ownerDb.update(automationRule).set({ enabledAt: start }).where(eq(automationRule.organizationId, ORG))

  const threadOf = async (person: Person, at: Date): Promise<string> => {
    const [existing] = await ownerDb.select({ id: conversation.id }).from(conversation)
      .where(and(eq(conversation.organizationId, ORG), eq(conversation.contactId, person.contactId), eq(conversation.channelConnectionId, connectionId)))
      .limit(1)
    if (existing) {
      await ownerDb.update(conversation).set({ lastInboundAt: at, status: "open" }).where(eq(conversation.id, existing.id))
      return existing.id
    }
    const [row] = await ownerDb.insert(conversation).values({
      organizationId: ORG, contactId: person.contactId, contactIdentityId: person.identityId!, channelConnectionId: connectionId,
      externalThreadId: person.phone!, lastInboundAt: at,
    }).returning({ id: conversation.id })
    return row!.id
  }

  // --------------------------------------------- el ciclo real, hora por hora ---
  const told = { calls: 0, input: 0, output: 0, yes: 0, failed: 0, byKind: new Map<string, number>() }
  const alreadyTold = async (_orgId: string, input: { kind: string; reason: string; messages: string[] }) => {
    if (!decider) return false
    told.calls += 1
    told.byKind.set(input.kind, (told.byKind.get(input.kind) ?? 0) + 1)
    try {
      const result = await decider.decide(alreadyToldState(input), [ALREADY_TOLD_QUESTION])
      told.input += result.usage?.inputTokens ?? 0
      told.output += result.usage?.outputTokens ?? 0
      const answer = result.answers.find((item) => item.id === "ya_aviso")
      const yes = answer?.kind === "yesno" && answer.probability >= ALREADY_TOLD_MIN
      if (yes) told.yes += 1
      return yes
    } catch (error) {
      told.failed += 1
      throw error
    }
  }
  let cursor = 0
  for (let t = start.getTime(); t <= end.getTime(); t += HOUR) {
    const now = new Date(t)
    while (cursor < events.length && events[cursor]!.at <= t) {
      const event = events[cursor]!
      cursor += 1
      const at = new Date(event.at)
      if (event.type === "cancel") {
        await inOrg((tx) => setAppointmentStatus(tx, ORG, null, event.appointmentId, "cancelada", { cancelReason: "paciente", via: "enlace-publico" }))
        await ownerDb.update(auditEvent).set({ createdAt: at }).where(and(eq(auditEvent.organizationId, ORG), eq(auditEvent.entityId, event.appointmentId), eq(auditEvent.action, "appointment.status_cancelada")))
        const found = outcomes.find((item) => item.id === event.appointmentId)
        if (found) found.done = true
      } else {
        const conversationId = await threadOf(event.person, at)
        await ownerDb.insert(message).values({ organizationId: ORG, conversationId, direction: "in", senderKind: "contact", body: event.text, createdAt: at })
      }
    }
    const finished = outcomes.filter((item) => !item.done && item.endsAt.getTime() <= t)
    for (const status of ["atendida", "no_asistio"] as const) {
      const ids = finished.filter((item) => item.outcome === status).map((item) => item.id)
      if (ids.length > 0) await ownerDb.update(appointment).set({ status }).where(inArray(appointment.id, ids))
    }
    for (const item of finished) item.done = true
    await tickAutomations(ownerDb, appDb, now, { secretsKey: KEY, publicBaseUrl: "https://clinica.test", limit: 500, alreadyTold })
  }

  // ------------------------------------------------ lo que el motor hizo en el mes ---
  const counts = await ownerDb.execute<{ kind: string; status: string; via: string | null; cause: string | null; n: number; people: number }>(sql`
    select kind, status, via, cause, count(*)::int as n, count(distinct contact_id)::int as people
    from automation_job where organization_id = ${ORG} group by kind, status, via, cause order by kind, status`)
  const sentBy = new Map<string, { messages: number; cases: number }>()
  const reminded = await ownerDb.execute<{ n: number }>(sql`
    select count(distinct appointment_id)::int as n from automation_job
    where organization_id = ${ORG} and kind = 'recordatorio_cita' and status = 'enviado'`)
  for (const line of lines) {
    const rows = counts.filter((row) => row.kind === line.key && row.status === "enviado")
    const messages = rows.reduce((sum, row) => sum + Number(row.n), 0)
    // Un recordatorio son dos avisos de la misma cita: quien responde, responde una vez por cita.
    sentBy.set(line.key, { messages, cases: line.key === "recordatorio_cita" ? Number(reminded[0]?.n ?? 0) : messages })
  }

  console.log("\n=== Prueba real de consumo · un mes de una clínica de prueba ===")
  console.log(REAL ? `Modelo que escribe: ${AGENT_MODEL.modelName} · modelo de decisión: ${decider ? `Jev (${env.JEV_MODEL ?? "por defecto"})` : "ninguno"}` : "ENSAYO con el modelo de demostración: no mide nada.")
  console.log(`Clínica: ${CLINIC.patients} pacientes, ${plan.length - CLINIC.appointmentsPerDay} citas en el mes y ${CLINIC.appointmentsPerDay} mañana (${outcomes.filter((item) => item.outcome === "no_asistio").length} inasistencias, ${outcomes.filter((item) => item.outcome === "cancelada").length} cancelaciones), ${CLINIC.budgets} presupuestos, ${CLINIC.controls} controles.`)
  console.log("\n1. Lo que hizo Argos en el mes (lo cuenta el motor; ningún mensaje salió de la cola)")
  for (const line of lines) {
    const mine = counts.filter((row) => row.kind === line.key)
    const of = (status: string) => mine.filter((row) => row.status === status).reduce((sum, row) => sum + Number(row.n), 0)
    const cannot = mine.filter((row) => row.cause).reduce((sum, row) => sum + Number(row.n), 0)
    const quiet = mine.filter((row) => row.status === "cancelado").reduce((sum, row) => sum + Number(row.n), 0)
    console.log(`  ${line.name.padEnd(42)} mensajes ${String(of("enviado")).padStart(4)} · no pudo ${String(cannot).padStart(4)} · tareas ${String(of("tarea")).padStart(4)} · no hizo falta ${String(quiet).padStart(4)} · «¿ya avisó?» ${String(told.byKind.get(line.key) ?? 0).padStart(3)}`)
  }
  const perTold = told.calls > 0 ? Math.round((told.input + told.output) / told.calls) : 0
  console.log(`\n2. «¿Ya avisó algo?» (modelo de decisión): ${told.calls} llamadas, ${told.input + told.output} tokens (${perTold} por llamada); dijo que sí en ${told.yes}; sin respuesta en ${told.failed}.`)

  // ------------------------------ 3. una persona de cada línea responde con texto ---
  console.log("\n3. Cuando la persona responde con texto, Sofi sigue la conversación (modelo que escribe)")
  const measured = new Map<string, { llm: number; decision: number; turns: number; label: string }>()
  /** La primera llamada de cada conversación: con ellas se mide cuánto del sistema es igual entre personas distintas. */
  const openers: ModelCall[] = []
  let sequence = 0
  for (const script of SCRIPTS.filter((item) => ONLY.length === 0 || ONLY.includes(item.kind))) {
    // Quien responde a un recordatorio de cita responde antes de su cita: la cita
    // de ese recordatorio todavía está por venir cuando empieza la conversación.
    const upcoming = script.kind === "recordatorio_cita"
      ? sql`exists (select 1 from appointment a where a.id = ${automationJob.appointmentId}
          and a.starts_at > now() and a.status in ('programada', 'confirmada'))`
      : undefined
    const [job] = await ownerDb.select().from(automationJob)
      .where(and(eq(automationJob.organizationId, ORG), eq(automationJob.kind, script.kind), eq(automationJob.status, "enviado"), eq(automationJob.via, "plantilla"), upcoming))
      .orderBy(desc(automationJob.updatedAt))
      .offset(script.button ? 0 : 1)
      .limit(1)
    const person = job ? people.find((candidate) => candidate.contactId === job.contactId) : undefined
    if (!job || !person?.phone) {
      console.log(`  ${adminLineOf(script.kind)?.name ?? script.kind} · ${script.label}: no hubo ningún mensaje en el mes con qué probar.`)
      continue
    }
    const since = new Date()
    const opener = modelCalls.length
    let conversationId = ""
    const replies: string[] = []
    const detail: string[] = []
    if (job.appointmentId) {
      // Para leer en la respuesta si Recepción nombra esta cita y ofrece cambiarla.
      const [booked] = await ownerDb.select({ startsAt: appointment.startsAt, status: appointment.status }).from(appointment).where(eq(appointment.id, job.appointmentId))
      if (booked) detail.push(`      Cita del recordatorio: ${booked.startsAt.toLocaleString("es-PE", { timeZone: "America/Lima", dateStyle: "full", timeStyle: "short" })} (${booked.status})`)
    }
    for (const [index, text] of script.turns.entries()) {
      const firstCall = modelCalls.length
      sequence += 1
      const eventId = `mes-${sequence}`
      const ingested = await inOrg((tx) =>
        ingestInbound(tx, {
          orgId: ORG, connectionId,
          event: {
            externalEventId: eventId, externalMessageId: eventId, externalThreadId: person.phone!, senderExternalId: person.phone!,
            senderDisplayName: "Persona de prueba", sentAt: new Date().toISOString(),
            content: { type: "text", text, ...(index === 0 && script.button ? { replyId: replyId(script.button, job.id) } : {}) },
          },
        }, whatsappCloudApiAdapter, { storage: storageStub, fetch, secretsKey: KEY }))
      conversationId = ingested.conversationId
      const before = new Date()
      await processAgentRun(appDb, runtime, { msg_id: sequence, read_ct: 0, message: { kind: "inbound_message", orgId: ORG, conversationId, messageId: ingested.messageId } })
      const out = await ownerDb.select({ body: message.body }).from(message)
        .where(and(eq(message.conversationId, conversationId), eq(message.direction, "out"), gte(message.createdAt, before)))
        .orderBy(asc(message.createdAt))
      replies.push(out.map((row) => (row.body ?? "").replace(/\s+/g, " ").slice(0, 110)).join(" / ") || "(sin mensaje: quedó para una persona)")
      // Paso a paso: qué decidió el modelo de decisión y qué recibió el que escribe en cada llamada.
      const decided = await ownerDb.select().from(agentDecisionLog)
        .where(and(eq(agentDecisionLog.conversationId, conversationId), gte(agentDecisionLog.createdAt, before)))
        .orderBy(asc(agentDecisionLog.createdAt))
      detail.push(`      «${text}»`)
      for (const row of decided) {
        detail.push(`        decide (${row.point}, ${row.mode}): ${JSON.stringify(row.outcome ?? {})}${row.error ? ` · ERROR ${row.error}` : ""} · ${(row.inputTokens ?? 0) + (row.outputTokens ?? 0)} tokens`)
      }
      for (const [position, call] of modelCalls.slice(firstCall).entries()) {
        const earlier = modelCalls.slice(0, firstCall + position)
        const same = earlier.reduce((best, other) => Math.max(best, sharedPrefix(call.prompt, other.prompt)), 0)
        detail.push(
          `        escribe ${position + 1}: ${call.tools.length} herramientas (${call.toolsChars} car.) · sistema ${call.system.length} car. · ${call.messages} mensajes · ` +
            `entrada ${call.input} (de caché ${call.cached}) · salida ${call.output} · igual a una llamada anterior ${Math.round((same / call.prompt.length) * 100)} % → ${call.did}`,
        )
      }
    }
    const runs = await ownerDb.select().from(agentRunLedger).where(and(eq(agentRunLedger.conversationId, conversationId), gte(agentRunLedger.startedAt, since)))
    const decisionsUsed = await ownerDb.select().from(agentDecisionLog).where(and(eq(agentDecisionLog.conversationId, conversationId), gte(agentDecisionLog.createdAt, since)))
    const llmIn = runs.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0)
    const llmOut = runs.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0)
    const llm = llmIn + llmOut
    const cached = runs.reduce((sum, row) => sum + (row.cachedInputTokens ?? 0), 0)
    const calls = runs.reduce((sum, row) => sum + (row.llmCalls ?? 0), 0)
    const decision = decisionsUsed.reduce((sum, row) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0), 0)
    const key = `${script.kind}:${script.label}`
    measured.set(key, { llm, decision, turns: script.turns.length, label: script.label })
    console.log(`  ${adminLineOf(script.kind)?.name ?? script.kind} · ${script.label}: ${script.turns.length} mensajes de la persona → ${llm} tokens del modelo que escribe (${llmIn} de entrada y ${llmOut} de salida; ${calls} llamadas, ${cached} de entrada desde caché) y ${decision} del de decisión. Corridas: ${runs.map((row) => row.status).join(", ")}`)
    for (const [index, text] of script.turns.entries()) console.log(`      «${text}» → ${replies[index]}`)
    if (modelCalls[opener]) openers.push(modelCalls[opener])
    console.log("    Paso a paso:")
    for (const line of detail) console.log(line)
  }
  // ---------------------------- 3b. preguntas escritas como las escribe la gente ---
  if (ONLY.length === 0 || ONLY.includes("preguntas")) {
    console.log("\n3b. Preguntas de alguien nuevo, con jerga y faltas (la clínica tiene Yape y Plin en caja, el servicio de endodoncia y un profesional adscrito a Endodoncia)")
    const asked = BIG_CATALOG
      ? [
          ...QUESTIONS,
          { label: "servicio del final del tarifario (P)", turns: ["cuanto cuesta una protesis total?"] },
          { label: "servicio del final del tarifario (S)", turns: ["hacen sellantes para niños? cuanto sale"] },
          { label: "servicio del principio del tarifario (C)", turns: ["cuanto esta la corona de zirconio"] },
        ]
      : QUESTIONS
    for (const [number, question] of asked.entries()) {
      const phone = `5198${String(number).padStart(7, "0")}`
      console.log(`  ${question.label}`)
      for (const text of question.turns) {
        sequence += 1
        const eventId = `pregunta-${sequence}`
        const firstCall = modelCalls.length
        const ingested = await inOrg((tx) =>
          ingestInbound(tx, {
            orgId: ORG, connectionId,
            event: {
              externalEventId: eventId, externalMessageId: eventId, externalThreadId: phone, senderExternalId: phone,
              senderDisplayName: "Persona nueva", sentAt: new Date().toISOString(), content: { type: "text", text },
            },
          }, whatsappCloudApiAdapter, { storage: storageStub, fetch, secretsKey: KEY }))
        const before = new Date()
        await processAgentRun(appDb, runtime, { msg_id: sequence, read_ct: 0, message: { kind: "inbound_message", orgId: ORG, conversationId: ingested.conversationId, messageId: ingested.messageId } })
        const out = await ownerDb.select({ body: message.body }).from(message)
          .where(and(eq(message.conversationId, ingested.conversationId), eq(message.direction, "out"), gte(message.createdAt, before)))
          .orderBy(asc(message.createdAt))
        const decided = await ownerDb.select().from(agentDecisionLog)
          .where(and(eq(agentDecisionLog.conversationId, ingested.conversationId), gte(agentDecisionLog.createdAt, before)))
          .orderBy(asc(agentDecisionLog.createdAt))
        const [run] = await ownerDb.select().from(agentRunLedger)
          .where(and(eq(agentRunLedger.conversationId, ingested.conversationId), gte(agentRunLedger.startedAt, before)))
        console.log(`      «${text}»`)
        for (const row of decided) console.log(`        decide (${row.point}): ${JSON.stringify(row.outcome ?? {})}${row.error ? ` · ERROR ${row.error}` : ""}`)
        console.log(`        escribe: ${modelCalls.slice(firstCall).map((call) => call.did).join(" → ") || "no se llamó"} · ${(run?.inputTokens ?? 0) + (run?.outputTokens ?? 0)} tokens · corrida ${run?.status ?? "?"}`)
        console.log(`        responde: ${out.map((row) => (row.body ?? "").replace(/\s+/g, " ").slice(0, 600)).join(" / ") || "(sin mensaje: quedó para una persona)"}`)
      }
    }
  }
  if (modelCalls.length > 1) {
    const totalIn = modelCalls.reduce((sum, call) => sum + call.input, 0)
    const totalCached = modelCalls.reduce((sum, call) => sum + call.cached, 0)
    const totalOut = modelCalls.reduce((sum, call) => sum + call.output, 0)
    // Cuánto del prompt de cada llamada ya había viajado igual en una anterior: lo que una caché de prefijo podría servir.
    const repeatable = modelCalls.reduce((sum, call, index) => {
      const same = modelCalls.slice(0, index).reduce((best, other) => Math.max(best, sharedPrefix(call.prompt, other.prompt)), 0)
      return sum + same / Math.max(call.prompt.length, 1)
    }, 0) / modelCalls.length
    const stable = openers.length > 1 ? openers.slice(1).reduce((min, call) => Math.min(min, sharedPrefix(call.system, openers[0]!.system)), Number.MAX_SAFE_INTEGER) : 0
    console.log(`\n  Memoria (caché) del modelo que escribe, en ${modelCalls.length} llamadas: entrada ${totalIn} tokens, de caché ${totalCached} (${Math.round((totalCached / Math.max(totalIn, 1)) * 100)} %), salida ${totalOut}.`)
    console.log(`  En promedio, el ${Math.round(repeatable * 100)} % de cada envío era idéntico, desde el principio, a uno anterior: eso es lo que una caché de prefijo podría servir.`)
    console.log(`  Listas de herramientas distintas: ${new Set(modelCalls.map((call) => call.tools.join(","))).size}. Parte del sistema igual entre personas distintas: ${stable} de ${openers[0]?.system.length ?? 0} caracteres.`)
  }

  // ----------------------------------------------------------- 4. la cuenta del mes ---
  console.log("\n4. La cuenta del mes: veces × tokens (las veces de respuesta con texto son un supuesto)")
  const scriptOf = (kind: string) => SCRIPTS.find((script) => script.kind === kind && script.button)
  const project = (kinds: string[]) => {
    let llm = 0
    let decision = 0
    const rows: string[] = []
    for (const kind of kinds) {
      const script = scriptOf(kind)
      const cost = script ? measured.get(`${kind}:${script.label}`) : undefined
      const sent = sentBy.get(kind)
      if (!sent || !cost) continue
      const repliers = Math.round(sent.cases * (REPLY_RATE[kind] ?? 0))
      llm += repliers * cost.llm
      decision += repliers * cost.decision
      rows.push(`    ${(adminLineOf(kind)?.name ?? kind).padEnd(42)} ${String(sent.messages).padStart(4)} mensajes${sent.cases === sent.messages ? "" : ` por ${sent.cases} citas`} · ${String(repliers).padStart(3)} responden con texto (${Math.round((REPLY_RATE[kind] ?? 0) * 100)} %) × ${cost.llm} = ${repliers * cost.llm} tokens del que escribe`)
    }
    const toldTokens = kinds.reduce((sum, kind) => sum + (told.byKind.get(kind) ?? 0) * perTold, 0)
    return { llm, decision: decision + toldTokens + REQUESTS_PER_MONTH * REQUEST_TOKENS, rows, toldTokens }
  }
  const writers = lines.filter((line) => line.agent).map((line) => line.key)
  for (const [title, kinds] of [
    ["Con todas las líneas prendidas", writers],
    ["Con solo las tres más comunes (recordar la cita, inasistencia, presupuesto)", ["recordatorio_cita", "seguimiento_no_asistencia", "seguimiento_presupuesto"]],
  ] as const) {
    const result = project([...kinds])
    console.log(`  ${title}`)
    for (const row of result.rows) console.log(row)
    console.log(`    → modelo que escribe: ${result.llm} tokens al mes`)
    console.log(`    → modelo de decisión: ${result.decision} tokens al mes («¿ya avisó?» ${result.toldTokens}, conversaciones de Sofi ${result.decision - result.toldTokens - REQUESTS_PER_MONTH * REQUEST_TOKENS}, ${REQUESTS_PER_MONTH} pedidos con palabras ${REQUESTS_PER_MONTH * REQUEST_TOKENS})`)
  }
  console.log("  Las líneas que solo dejan tareas al equipo y los botones «Confirmar» y «No enviar más» no gastan tokens.\n")
}, 3_600_000)
