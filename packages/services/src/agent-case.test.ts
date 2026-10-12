import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { agentAnswerTrace, agentCaseMemory } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { eq, sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import {
  addAgentCaseNote,
  CASE_LOOKUP_CHARS,
  CASE_NOTE_LIMIT,
  formatAgentCaseForPrompt,
  getAgentCaseState,
  getAnswerTraceForMessage,
  listAnswerTraces,
  recordAgentCaseLookup,
  recordAnswerTrace,
  removeAgentCaseNote,
} from "./agent-case.js"
import { createProposal, decideProposal, getAgentRunStats, recordAgentRun, updateAutonomyPolicy } from "./agent-operations.js"
import { createConnection } from "./connections.js"
import { getConversationDetail, type IngestDeps, ingestInbound } from "./conversations.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** Memoria del caso y traza de respuestas: lo que el agente recuerda de un hilo y en qué se basó. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"
const OWNER = "case-owner"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const ZONE = { timezone: "America/Lima", locale: "es-PE" }

beforeAll(async () => {
  await ownerDb.insert(user).values([{ id: OWNER, name: "Dueña", email: "owner@case.test", emailVerified: true }])
  await ownerDb.insert(member).values([
    { id: `m-${OWNER}`, userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
  ])
})

const stubAdapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: { templates: false, media: true, interactive: false, readReceipts: false, edit: true },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "stub-1" }),
  validateConnection: async () => ({ externalId: "bot-1", displayName: "Bot" }),
}
const storageStub: Storage = {
  putAvatar: async () => { throw new Error("no usado") },
  deleteByUrl: async () => {},
  putAttachment: async () => { throw new Error("no usado") },
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => { throw new Error("no usado") },
  putPatientAvatar: async () => { throw new Error("no usado") },
}
const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }

function run<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return withOrgContext(appDb, ORG, fn)
}

let connId: string
async function openConversation(sender: string): Promise<string> {
  connId ??= await run((tx) =>
    createConnection(tx, ORG, KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
      { fetch, validateExternal: false }).then((c) => c.id))
  const event: NormalizedInbound = {
    externalEventId: `evt-${sender}`, externalMessageId: `evt-${sender}`,
    externalThreadId: `tg:${sender}`, senderExternalId: `tg:${sender}`, senderDisplayName: sender,
    content: { type: "text", text: "Hola" }, sentAt: new Date().toISOString(),
  }
  const job: InboundMessageJob = { orgId: ORG, connectionId: connId, event }
  const { conversationId } = await run((tx) => ingestInbound(tx, job, stubAdapter, deps))
  await run((tx) => getConversationDetail(tx, ORG, conversationId))
  return conversationId
}

it("un hilo nuevo no tiene estado que contar y no gasta prompt en una sección vacía", async () => {
  const conversationId = await openConversation("vacio")
  const state = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(state).toEqual({ pending: [], recent: [], notes: [], lookups: [], totalMessages: 1 })
  expect(formatAgentCaseForPrompt(state, ZONE, 20)).toBeNull()
})

it("el estado separa lo que espera al interlocutor de lo que decide el equipo y recuerda lo rechazado con su motivo", async () => {
  const conversationId = await openConversation("estado")
  await run((tx) => updateAutonomyPolicy(tx, ORG, OWNER, { enviar_mensaje: "confirmar_usuario", crear_oportunidad: "aprobar_equipo" }))
  const message = await run((tx) => createProposal(tx, ORG, {
    conversationId, action: "enviar_mensaje", payload: { kind: "text", text: "¿Te va el jueves?" }, idempotencyKey: "case:msg-1",
  }))
  const opportunity = await run((tx) => createProposal(tx, ORG, {
    conversationId, action: "crear_oportunidad", payload: { title: "Ortodoncia" }, idempotencyKey: "case:opp-1",
  }))
  const pending = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(pending.pending.map((item) => `${item.action}:${item.decider}`).sort()).toEqual([
    "crear_oportunidad:team",
    "enviar_mensaje:contact",
  ])
  const prompt = formatAgentCaseForPrompt(pending, ZONE, 20) ?? ""
  expect(prompt).toContain(`Propuesta pendiente de que el interlocutor confirme: Enviar mensaje — ¿Te va el jueves? (id ${message.id}`)
  expect(prompt).toContain(`Propuesta pendiente de decisión del equipo: Crear oportunidad — Nueva oportunidad: Ortodoncia (id ${opportunity.id}`)
  expect(prompt).toContain("No pidas un sí")

  await run((tx) => decideProposal(tx, ORG, OWNER, opportunity.id, { decision: "rechazada", reason: "Ya tiene una abierta" }))
  const after = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(after.pending.map((item) => item.action)).toEqual(["enviar_mensaje"])
  expect(after.recent).toMatchObject([{ action: "crear_oportunidad", status: "rechazada", detail: "Ya tiene una abierta" }])
  expect(formatAgentCaseForPrompt(after, ZONE, 20)).toContain(
    "No se hizo: Crear oportunidad — Nueva oportunidad: Ortodoncia (rechazada: Ya tiene una abierta;",
  )
  await run((tx) => updateAutonomyPolicy(tx, ORG, OWNER, { enviar_mensaje: "directo" }))
})

it("las notas del caso son acotadas, no se repiten y una persona puede retirarlas", async () => {
  const conversationId = await openConversation("notas")
  await run((tx) => addAgentCaseNote(tx, ORG, conversationId, "  La cita es para su hija   Ana.  "))
  await run((tx) => addAgentCaseNote(tx, ORG, conversationId, "La cita es para su hija Ana."))
  let state = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(state.notes.map((note) => note.text)).toEqual(["La cita es para su hija Ana."])
  await expect(run((tx) => addAgentCaseNote(tx, ORG, conversationId, "   "))).rejects.toMatchObject({ code: "VALIDATION" })

  for (let i = 1; i <= CASE_NOTE_LIMIT + 2; i++) {
    await run((tx) => addAgentCaseNote(tx, ORG, conversationId, `Nota ${i}`))
  }
  state = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(state.notes).toHaveLength(CASE_NOTE_LIMIT)
  expect(state.notes[0]?.text).toBe("Nota 3")
  expect(formatAgentCaseForPrompt(state, ZONE, 20)).toContain("Notas del caso")

  const removed = state.notes[0]!
  const left = await run((tx) => removeAgentCaseNote(tx, ORG, conversationId, removed.at))
  expect(left.map((note) => note.text)).not.toContain("Nota 3")
  expect(left).toHaveLength(CASE_NOTE_LIMIT - 1)
})

it("solo se conserva la última consulta de las herramientas previstas, recortada y con caducidad", async () => {
  const conversationId = await openConversation("consultas")
  await run((tx) => recordAgentCaseLookup(tx, ORG, conversationId, { tool: "ver_sedes_y_servicios", text: "no se guarda" }))
  await run((tx) => recordAgentCaseLookup(tx, ORG, conversationId, { tool: "buscar_huecos", text: "primera" }))
  await run((tx) => recordAgentCaseLookup(tx, ORG, conversationId, { tool: "buscar_huecos", text: "x".repeat(CASE_LOOKUP_CHARS + 50) }))
  let state = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(state.lookups).toHaveLength(1)
  expect(state.lookups[0]?.tool).toBe("buscar_huecos")
  expect(state.lookups[0]?.text.endsWith("(recortado: vuelve a consultar)")).toBe(true)
  expect(formatAgentCaseForPrompt(state, ZONE, 20)).toContain("Consultas de turnos anteriores")

  // Pasadas unas horas la consulta ya no se muestra: la agenda pudo cambiar.
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()
  await ownerDb
    .update(agentCaseMemory)
    .set({ lookups: { buscar_huecos: { text: "vieja", at: old } } })
    .where(eq(agentCaseMemory.conversationId, conversationId))
  state = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(state.lookups).toEqual([])
})

it("el contexto avisa cuando el hilo tiene más mensajes de los que el modelo ve", async () => {
  const conversationId = await openConversation("largo")
  const state = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(formatAgentCaseForPrompt({ ...state, totalMessages: 45 }, ZONE, 20)).toBe(
    "Solo ves los últimos 20 mensajes de 45: lo anterior no está a la vista. Apóyate en las notas del caso y, si falta un dato, pregúntalo.",
  )
})

it("la traza de una respuesta se encuentra por su mensaje, directo o a través de la propuesta, y no se puede reescribir", async () => {
  const conversationId = await openConversation("traza")
  const sent = await run((tx) => createProposal(tx, ORG, {
    conversationId, action: "enviar_mensaje", payload: { kind: "text", text: "La limpieza cuesta S/ 150." }, idempotencyKey: "case:trace-1",
  }))
  expect(sent.status).toBe("ejecutada")
  const messageId = String(sent.result?.["messageId"])
  // Enlazada solo por la propuesta: así queda una respuesta que esperó aprobación.
  const traceId = await run((tx) => recordAnswerTrace(tx, ORG, {
    conversationId,
    proposalId: sent.id,
    outcome: "pendiente",
    replyText: "La limpieza cuesta S/ 150.",
    basis: [{ kind: "servicios", label: "Sedes, servicios y tarifas" }],
    checks: [{ kind: "precio", value: "S/ 150", ok: true, source: "Sedes, servicios y tarifas" }],
    model: "fake",
  }))
  const found = await run((tx) => getAnswerTraceForMessage(tx, ORG, messageId))
  expect(found).toMatchObject({ id: traceId, messageId, basis: [{ kind: "servicios", label: "Sedes, servicios y tarifas" }] })
  const listed = await run((tx) => listAnswerTraces(tx, ORG, conversationId))
  expect(listed.map((trace) => trace.messageId)).toEqual([messageId])

  // Una respuesta bloqueada no tiene mensaje y aun así queda registrada.
  await run((tx) => recordAnswerTrace(tx, ORG, {
    conversationId, outcome: "bloqueada", replyText: "Cuesta S/ 99.", basis: [],
    checks: [{ kind: "precio", value: "S/ 99", ok: false, source: null }],
  }))
  expect((await run((tx) => listAnswerTraces(tx, ORG, conversationId))).map((trace) => trace.outcome)).toEqual(["bloqueada", "pendiente"])
  await expect(run((tx) => recordAnswerTrace(tx, ORG, {
    conversationId, outcome: "inventada" as never, replyText: "x", basis: [], checks: [],
  }))).rejects.toMatchObject({ code: "VALIDATION" })

  // Solo anexado y aislada por organización.
  await expect(run((tx) => tx.update(agentAnswerTrace).set({ replyText: "otra" }).where(eq(agentAnswerTrace.id, traceId))))
    .rejects.toThrow()
  await expect(run((tx) => tx.delete(agentAnswerTrace).where(eq(agentAnswerTrace.id, traceId)))).rejects.toThrow()
  const fromOther = await withOrgContext(appDb, OTHER, (tx) => tx.select({ id: agentAnswerTrace.id }).from(agentAnswerTrace))
  expect(fromOther).toEqual([])
  const memoryFromOther = await withOrgContext(appDb, OTHER, (tx) => tx.execute(sql`select id from agent_case_memory`))
  expect([...memoryFromOther]).toEqual([])
  await expect(withOrgContext(appDb, OTHER, (tx) => getAgentCaseState(tx, OTHER, conversationId))).rejects.toMatchObject({ code: "NOT_FOUND" })
})

it("el gasto por conversación cuenta solo las conversaciones con llamadas al modelo", async () => {
  const first = await openConversation("gasto-1")
  const second = await openConversation("gasto-2")
  const base = await run((tx) => getAgentRunStats(tx, ORG))
  const startedAt = new Date()
  await run((tx) => recordAgentRun(tx, ORG, { conversationId: first, model: "fake", status: "ok", startedAt, llmCalls: 3, inputTokens: 900, outputTokens: 100 }))
  await run((tx) => recordAgentRun(tx, ORG, { conversationId: first, model: "fake", status: "ok", startedAt, llmCalls: 1, inputTokens: 300, outputTokens: 50 }))
  await run((tx) => recordAgentRun(tx, ORG, { conversationId: second, model: "fake", status: "omitida", startedAt, llmCalls: 0 }))
  const stats = await run((tx) => getAgentRunStats(tx, ORG))
  expect(stats.conversationsWithLlmCalls - base.conversationsWithLlmCalls).toBe(1)
  expect((stats.totalLlmCalls ?? 0) - (base.totalLlmCalls ?? 0)).toBe(4)
})
