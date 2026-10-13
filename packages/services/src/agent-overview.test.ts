import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { AUTONOMY_ACTIONS, agentAnswerTrace, agentHandoff, agentLesson, agentReviewItem, agentRunLedger } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { recordAgentDecision } from "./agent-decisions.js"
import { getAgentRunStats, getAutonomyPolicy, updateAutonomyPolicy } from "./agent-operations.js"
import { getAgentOverview, noteSandboxTurn, setAgentLevel } from "./agent-overview.js"
import {
  AGENT_LEVEL_POLICY,
  AGENT_LEVELS,
  AGENT_ROLE_IDS,
  AGENT_ROLES,
  levelOfPolicy,
  switchableFunctions,
  toolsDisabledBy,
} from "./agent-roles.js"
import { getAgentConfig, upsertAgentConfig } from "./agentConfig.js"
import { createConnection } from "./connections.js"
import { type IngestDeps, ingestInbound } from "./conversations.js"
import { KNOWLEDGE_BASICS } from "./knowledge.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** Fichas de los agentes, niveles, voz y límites de la clínica, y el resumen que los reúne. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"
const OWNER = "overview-owner"
const KEY = secretsKeyFromEnv("ab".repeat(32))

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: OWNER, name: "Dueña Resumen", email: "owner@overview.test", emailVerified: true },
    { id: "overview-dentist", name: "Odontólogo", email: "dentist@overview.test", emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: `m-${OWNER}`, userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
    { id: "m-overview-dentist", userId: "overview-dentist", organizationId: ORG, role: "dentist", createdAt: new Date() },
  ])
})

function run<T>(fn: (tx: Db) => Promise<T>, org = ORG): Promise<T> {
  return withOrgContext(appDb, org, fn)
}

const stubAdapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: { templates: false, media: true, interactive: false, readReceipts: false, edit: true },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "stub-1" }),
  validateConnection: async () => ({ externalId: "bot-1", displayName: "Bot" }),
}
const unused = async (): Promise<never> => {
  throw new Error("no usado")
}
const storageStub: Storage = {
  putAvatar: unused,
  deleteByUrl: async () => {},
  putAttachment: unused,
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: unused,
  putPatientAvatar: unused,
}
const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }

async function openConversation(connectionId: string, sender: string): Promise<string> {
  const event: NormalizedInbound = {
    externalEventId: `evt-${sender}`, externalMessageId: `evt-${sender}`,
    externalThreadId: `tg:${sender}`, senderExternalId: `tg:${sender}`, senderDisplayName: sender,
    content: { type: "text", text: "Hola" }, sentAt: new Date().toISOString(),
  }
  const job: InboundMessageJob = { orgId: ORG, connectionId, event }
  return (await run((tx) => ingestInbound(tx, job, stubAdapter, deps))).conversationId
}

describe("fichas de los agentes", () => {
  it("cada agente tiene su ficha y los cuatro existen", () => {
    expect(Object.keys(AGENT_ROLES).sort()).toEqual([...AGENT_ROLE_IDS].sort())
    expect(AGENT_ROLE_IDS.filter((id) => AGENT_ROLES[id].available)).toEqual(["recepcion", "asistente_clinico", "administrador", "ayuda"])
    // Ayuda viene con el sistema: la clínica no la enciende.
    expect(AGENT_ROLES.ayuda.switchable).toBe(false)
  })

  it("las funciones fijas no se pueden apagar", () => {
    expect(switchableFunctions("recepcion")).toEqual(["informar", "agendar", "seguimiento"])
    expect(toolsDisabledBy("recepcion", ["ordenar", "derivar"])).toEqual([])
  })

  it("una herramienta compartida sigue mientras alguna función encendida la traiga", () => {
    expect(toolsDisabledBy("recepcion", ["informar"])).toEqual(["consultar_conocimiento"])
    expect(toolsDisabledBy("recepcion", ["agendar"]).sort()).toEqual(
      ["buscar_huecos", "cancelar_cita", "enviar_enlace_cita", "proponer_cita", "reprogramar_cita"].sort(),
    )
    expect(toolsDisabledBy("recepcion", ["informar", "agendar"])).toContain("ver_sedes_y_servicios")
  })

  it("apagarlo todo deja lo fijo y lo que el agente tiene siempre", () => {
    const off = new Set(toolsDisabledBy("recepcion", switchableFunctions("recepcion")))
    const ficha = AGENT_ROLES.recepcion
    const left = [...ficha.always, ...ficha.functions.flatMap((fn) => fn.tools)].filter((tool) => !off.has(tool))
    expect(left).toEqual(expect.arrayContaining(["send_reply", "request_human_handoff", "anotar_caso", "confirmar_propuesta"]))
    expect(left).not.toContain("proponer_cita")
    expect(left).not.toContain("create_opportunity")
  })
})

describe("niveles: hasta dónde llega solo", () => {
  it("cada nivel es una política completa y se reconoce a sí mismo", () => {
    for (const level of AGENT_LEVELS) {
      expect(Object.keys(AGENT_LEVEL_POLICY[level]).sort()).toEqual([...AUTONOMY_ACTIONS].sort())
      expect(levelOfPolicy(AGENT_LEVEL_POLICY[level])).toBe(level)
    }
  })

  it("supervisado no deja nada sin aprobación del equipo y autónomo nunca cancela sin el sí del paciente", () => {
    expect(new Set(Object.values(AGENT_LEVEL_POLICY.supervisado))).toEqual(new Set(["aprobar_equipo"]))
    expect(AGENT_LEVEL_POLICY.autonomo.cancelar_cita).toBe("confirmar_usuario")
  })

  it("una política retocada acto por acto es «personalizado»", () => {
    expect(levelOfPolicy({ ...AGENT_LEVEL_POLICY.equilibrado, enviar_mensaje: "aprobar_equipo" })).toBe("personalizado")
  })

  it("fijar un nivel escribe su política; uno desconocido se rechaza", async () => {
    await run((tx) => setAgentLevel(tx, ORG, OWNER, "supervisado"))
    expect(await run((tx) => getAutonomyPolicy(tx, ORG))).toEqual(AGENT_LEVEL_POLICY.supervisado)
    await expect(run((tx) => setAgentLevel(tx, ORG, OWNER, "total"))).rejects.toThrow(/Nivel desconocido/)
    await run((tx) => setAgentLevel(tx, ORG, OWNER, "equilibrado"))
  })
})

describe("voz, funciones y límites de la clínica", () => {
  it("guarda la voz y devuelve los valores por defecto donde no se dijo nada", async () => {
    const before = await run((tx) => getAgentConfig(tx, ORG))
    expect(before).toMatchObject({ personaName: null, tone: "cercano", disabledFunctions: [], channels: null })
    const saved = await run((tx) =>
      upsertAgentConfig(tx, ORG, { personaName: "  Sofi ", treatment: "usted", tone: "formal", about: "Clínica familiar." }, { actorUserId: OWNER }),
    )
    expect(saved).toMatchObject({ personaName: "Sofi", treatment: "usted", tone: "formal", about: "Clínica familiar." })
  })

  it("solo se apagan funciones apagables", async () => {
    await expect(run((tx) => upsertAgentConfig(tx, ORG, { disabledFunctions: ["derivar"] }))).rejects.toThrow()
    await expect(run((tx) => upsertAgentConfig(tx, ORG, { disabledFunctions: ["inventada"] }))).rejects.toThrow()
    const saved = await run((tx) => upsertAgentConfig(tx, ORG, { disabledFunctions: ["seguimiento", "seguimiento"] }))
    expect(saved.disabledFunctions).toEqual(["seguimiento"])
    await run((tx) => upsertAgentConfig(tx, ORG, { disabledFunctions: [] }))
  })

  it("las indicaciones por función se recortan, se limitan y las vacías se quitan", async () => {
    await expect(run((tx) => upsertAgentConfig(tx, ORG, { functionNotes: { agendar: "x".repeat(301) } }))).rejects.toThrow(/300/)
    await expect(run((tx) => upsertAgentConfig(tx, ORG, { functionNotes: { inventada: "hola" } }))).rejects.toThrow()
    const saved = await run((tx) =>
      upsertAgentConfig(tx, ORG, { functionNotes: { agendar: "  Ofrece primero las mañanas. ", informar: "   " } }),
    )
    expect(saved.functionNotes).toEqual({ agendar: "Ofrece primero las mañanas." })
  })

  it("el horario pide inicio y fin distintos, o ninguno", async () => {
    await expect(run((tx) => upsertAgentConfig(tx, ORG, { activeFromMin: 480 }))).rejects.toThrow(/horario/)
    await expect(run((tx) => upsertAgentConfig(tx, ORG, { activeFromMin: 480, activeUntilMin: 480 }))).rejects.toThrow(/horario/)
    // Una franja que cruza la medianoche es válida.
    const night = await run((tx) => upsertAgentConfig(tx, ORG, { activeFromMin: 1200, activeUntilMin: 480 }))
    expect(night).toMatchObject({ activeFromMin: 1200, activeUntilMin: 480 })
    const always = await run((tx) => upsertAgentConfig(tx, ORG, { activeFromMin: null, activeUntilMin: null }))
    expect(always).toMatchObject({ activeFromMin: null, activeUntilMin: null })
  })

  it("una lista de canales vacía vuelve a «todos»", async () => {
    const some = await run((tx) => upsertAgentConfig(tx, ORG, { channels: ["whatsapp", "whatsapp"] }))
    expect(some.channels).toEqual(["whatsapp"])
    const all = await run((tx) => upsertAgentConfig(tx, ORG, { channels: [] }))
    expect(all.channels).toBeNull()
  })
})

describe("resumen del agente", () => {
  let connectionId: string

  it("una clínica que no tocó nada: apagado, equilibrado y con lo básico por responder", async () => {
    const overview = await run((tx) => getAgentOverview(tx, OTHER), OTHER)
    expect(overview).toMatchObject({
      enabled: false,
      level: "equilibrado",
      needsYou: { approvals: 0, gaps: 0 },
      week: { attended: 0, corrected: 0, passed: 0, alone: 0, booked: 0 },
      learned: { officialAnswers: 0, rules: 0, examples: 0, latest: null },
      provider: { problem: null, at: null },
      readiness: { channels: [], receivers: [], sandboxTurns: 0 },
    })
    expect(overview.knows.basicsTotal).toBe(KNOWLEDGE_BASICS.length)
    expect(overview.needsYou.basicsMissing).toBe(overview.knows.basicsTotal - overview.knows.basicsCovered)
  })

  it("dice el nivel, quién recibe los casos, los canales conectados y si ya se probó", async () => {
    connectionId = await run((tx) =>
      createConnection(tx, ORG, KEY,
        { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
        { fetch, validateExternal: false }).then((connection) => connection.id),
    )
    await run((tx) => updateAutonomyPolicy(tx, ORG, OWNER, { enviar_mensaje: "aprobar_equipo" }))
    await run((tx) => noteSandboxTurn(tx, ORG))
    await run((tx) => noteSandboxTurn(tx, ORG))
    const overview = await run((tx) => getAgentOverview(tx, ORG))
    expect(overview.level).toBe("personalizado")
    expect(overview.readiness.channels).toEqual(["telegram"])
    // Quien atiende un caso derivado: administración y recepción, no el clínico.
    expect(overview.readiness.receivers).toContain("Dueña Resumen")
    expect(overview.readiness.receivers).not.toContain("Odontólogo")
    expect(overview.readiness.sandboxTurns).toBe(2)
    await run((tx) => setAgentLevel(tx, ORG, OWNER, "equilibrado"))
    expect((await run((tx) => getAgentOverview(tx, ORG))).level).toBe("equilibrado")
  })

  it("cuenta conversaciones, no mensajes, y separa las que pasó a una persona", async () => {
    const alone = await openConversation(connectionId, "sola")
    const passed = await openConversation(connectionId, "derivada")
    const old = await openConversation(connectionId, "antigua")
    const now = new Date()
    const ledger = (conversationId: string, status: string, startedAt = now) => ({
      organizationId: ORG, conversationId, model: "fake", status, startedAt,
    })
    await ownerDb.insert(agentRunLedger).values([
      // Tres corridas en la misma conversación siguen siendo una conversación.
      ledger(alone, "ok"), ledger(alone, "ok"), ledger(alone, "omitida"),
      ledger(passed, "handoff"),
      // Fuera de la semana y corridas que no atendieron: no cuentan.
      ledger(old, "ok", new Date(now.getTime() - 9 * 86_400_000)),
      ledger(old, "error"),
    ])
    await ownerDb.insert(agentHandoff).values({ organizationId: ORG, conversationId: passed, reason: "Pide una persona", summary: "Resumen" })
    const overview = await run((tx) => getAgentOverview(tx, ORG))
    expect(overview.week).toEqual({ attended: 2, corrected: 0, passed: 1, alone: 1, booked: 0 })
    expect(overview.today).toEqual({ attended: 2, corrected: 0, passed: 1, alone: 1, booked: 0 })
  })

  it("una conversación corregida sale de las otras dos cuentas: los tres tramos suman las atendidas", async () => {
    const fixed = await openConversation(connectionId, "corregida")
    const fixedLate = await openConversation(connectionId, "corregida-antes")
    const now = new Date()
    await ownerDb.insert(agentRunLedger).values([
      { organizationId: ORG, conversationId: fixed, model: "fake", status: "handoff", startedAt: now },
      { organizationId: ORG, conversationId: fixedLate, model: "fake", status: "ok", startedAt: now },
    ])
    // Además se derivó: cuenta como corregida, no dos veces.
    await ownerDb.insert(agentHandoff).values({ organizationId: ORG, conversationId: fixed, reason: "Pide una persona", summary: "Resumen" })
    const review = async (conversationId: string, status: string, decidedAt: Date | null) => {
      const [trace] = await ownerDb.insert(agentAnswerTrace)
        .values({ organizationId: ORG, conversationId, outcome: "enviada", replyText: "Atendemos los domingos." })
        .returning({ id: agentAnswerTrace.id })
      if (!trace) throw new Error("No se pudo sembrar la respuesta")
      await ownerDb.insert(agentReviewItem).values({
        organizationId: ORG, conversationId, traceId: trace.id, reason: "marcada", reply: "Atendemos los domingos.",
        status, decidedBy: decidedAt ? OWNER : null, decidedAt,
      })
    }
    await review(fixed, "corregida", now)
    // Una corrección de antes de la semana y una revisión que se dio por buena no cuentan.
    await review(fixedLate, "corregida", new Date(now.getTime() - 9 * 86_400_000))
    await review(fixedLate, "bien", now)
    const { week } = await run((tx) => getAgentOverview(tx, ORG))
    expect(week).toEqual({ attended: 4, corrected: 1, passed: 1, alone: 2, booked: 0 })
    expect(week.corrected + week.passed + week.alone).toBe(week.attended)
  })

  it("lo que aprendió esta semana: solo lo aprobado y vigente, por tipo, y la más reciente", async () => {
    const now = Date.now()
    const lesson = (kind: "respuesta_oficial" | "regla" | "ejemplo", title: string, status: string, approvedAt: Date | null) => ({
      organizationId: ORG, kind, title, body: title, status: status as "activa", proposedBy: OWNER,
      approvedBy: approvedAt ? OWNER : null, approvedAt,
    })
    await ownerDb.insert(agentLesson).values([
      lesson("respuesta_oficial", "Horario de sábados", "activa", new Date(now - 3 * 86_400_000)),
      lesson("regla", "No ofrecer citas en domingo.", "activa", new Date(now - 60_000)),
      lesson("ejemplo", "Saludo breve", "activa", new Date(now - 2 * 86_400_000)),
      // Aprobada hace más de una semana, retirada después de aprobarse y sin aprobar: fuera.
      lesson("regla", "Antigua", "activa", new Date(now - 10 * 86_400_000)),
      lesson("regla", "Retirada", "retirada", new Date(now - 86_400_000)),
      lesson("respuesta_oficial", "Propuesta", "propuesta", null),
    ])
    const { learned } = await run((tx) => getAgentOverview(tx, ORG))
    expect(learned).toMatchObject({ officialAnswers: 1, rules: 1, examples: 1 })
    expect(learned.latest).toMatchObject({ title: "No ofrecer citas en domingo.", approvedByName: "Dueña Resumen" })
    // Lo de otra clínica no entra.
    expect((await run((tx) => getAgentOverview(tx, OTHER), OTHER)).learned.latest).toBeNull()
  })

  it("avisa de un problema del proveedor solo si es lo último que pasó y nadie tocó la configuración", async () => {
    const provider = async () => (await run((tx) => getAgentOverview(tx, ORG))).provider
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)
    const entry = (status: string, startedAt: Date, extra: { error?: string; llmCalls?: number } = {}) =>
      ownerDb.insert(agentRunLedger).values({ organizationId: ORG, model: "fake", status, startedAt, ...extra })
    await run((tx) => upsertAgentConfig(tx, ORG, { tone: "formal" }, { actorUserId: OWNER }))
    // Las corridas sembradas arriba no llamaron al modelo, y un error que no es del proveedor no dice nada de él.
    expect(await provider()).toEqual({ problem: null, at: null })
    // El tope diario tiene su propio aviso.
    await entry("error", at(-1), { error: "DAILY_LIMIT: Se alcanzó el tope diario de 500 corridas del agente" })
    expect((await provider()).problem).toBeNull()
    const failedAt = at(-2)
    await entry("error", failedAt, { error: "PROVIDER_REJECTED: HTTP 401: clave inválida" })
    // Viaja la clase del problema y cuándo fue; nunca el texto del proveedor.
    expect(await provider()).toEqual({ problem: "rechazado", at: failedAt.toISOString() })
    await entry("error", at(-3), { error: "PROVIDER_QUOTA: HTTP 402" })
    expect((await provider()).problem).toBe("sin_saldo")
    await entry("error", at(-4), { error: "API_KEY_REQUIRED: Falta la clave" })
    expect((await provider()).problem).toBe("sin_configurar")
    // Una corrida posterior que sí llamó al modelo lo da por resuelto.
    await entry("ok", at(-5), { llmCalls: 1 })
    expect((await provider()).problem).toBeNull()
  })

  it("cambiar la configuración del agente retira el aviso hasta el siguiente intento", async () => {
    const provider = async () => (await run((tx) => getAgentOverview(tx, OTHER), OTHER)).provider
    await ownerDb.insert(agentRunLedger).values({
      organizationId: OTHER, model: "fake", status: "error", startedAt: new Date(Date.now() - 60_000), error: "PROVIDER_REJECTED: HTTP 401",
    })
    expect((await provider()).problem).toBe("rechazado")
    await run((tx) => upsertAgentConfig(tx, OTHER, { tone: "neutro" }), OTHER)
    expect((await provider()).problem).toBeNull()
  })

  it("contar una prueba no enciende el agente ni cambia su configuración", async () => {
    await run((tx) => noteSandboxTurn(tx, OTHER), OTHER)
    const cfg = await run((tx) => getAgentConfig(tx, OTHER), OTHER)
    expect(cfg.enabled).toBe(false)
    expect((await run((tx) => getAgentOverview(tx, OTHER), OTHER)).readiness.sandboxTurns).toBe(1)
  })
})

describe("gasto por camino", () => {
  it("promedia las llamadas al modelo que escribe según el camino elegido antes del turno", async () => {
    const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, OTHER, fn)
    const at = new Date()
    const route = async (path: string, llmCalls: number, status = "ok") => {
      const triggerMessageId = randomUUID()
      await ownerDb.insert(agentRunLedger).values({ organizationId: OTHER, triggerMessageId, model: "prueba", status, startedAt: at, llmCalls, inputTokens: 1000 * llmCalls })
      await run((tx) => recordAgentDecision(tx, OTHER, {
        triggerMessageId, point: "route.v2", mode: "route", provider: "fake", state: "Contact (latest): hola", answers: [], outcome: { path },
      }))
    }
    await route("informacion", 1)
    await route("informacion", 1)
    await route("derivar", 0, "handoff")
    await route("abierto", 3)
    // Sin elección de camino, y una corrida con error que no cuenta.
    await ownerDb.insert(agentRunLedger).values([
      { organizationId: OTHER, triggerMessageId: randomUUID(), model: "prueba", status: "ok", startedAt: at, llmCalls: 2, inputTokens: 2000 },
      { organizationId: OTHER, triggerMessageId: randomUUID(), model: "prueba", status: "error", startedAt: at, llmCalls: 5 },
    ])
    const stats = await run((tx) => getAgentRunStats(tx, OTHER))
    const byPath = Object.fromEntries(stats.byRoute.map((row) => [row.path, row]))
    expect(byPath["informacion"]).toEqual({ path: "informacion", runs: 2, avgLlmCalls: 1, avgInputTokens: 1000 })
    expect(byPath["derivar"]).toMatchObject({ runs: 1, avgLlmCalls: 0 })
    expect(byPath["abierto"]).toMatchObject({ runs: 1, avgLlmCalls: 3 })
    expect(byPath["sin_camino"]).toMatchObject({ runs: 1, avgLlmCalls: 2 })
  })
})
