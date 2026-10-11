import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { AUTONOMY_ACTIONS, agentHandoff, agentRunLedger } from "@odentia/db/schema/agent"
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
  roleTools,
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
    expect(AGENT_ROLE_IDS.filter((id) => AGENT_ROLES[id].available)).toEqual(["recepcion", "asistente_clinico", "asesor", "ayuda"])
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
      ["buscar_huecos", "cancelar_cita", "proponer_cita", "reprogramar_cita"].sort(),
    )
    expect(toolsDisabledBy("recepcion", ["informar", "agendar"])).toContain("ver_sedes_y_servicios")
  })

  it("apagarlo todo deja lo fijo y lo que el agente tiene siempre", () => {
    const off = new Set(toolsDisabledBy("recepcion", switchableFunctions("recepcion")))
    const left = roleTools("recepcion").filter((tool) => !off.has(tool))
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
      week: { attended: 0, passed: 0, alone: 0, booked: 0 },
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
    expect(overview.week).toEqual({ attended: 2, passed: 1, alone: 1, booked: 0 })
    expect(overview.today).toEqual({ attended: 2, passed: 1, alone: 1, booked: 0 })
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
