import { randomUUID } from "node:crypto"
import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { agentAnswerTrace, agentCaseMemory, agentProposal } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { eq, sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import {
  addAgentCaseNote,
  CASE_LOOKUP_CHARS,
  CASE_NOTE_LIMIT,
  formatAgentCaseForPrompt,
  getAgentCaseState,
  listAnswerTraces,
  recordAgentCaseLookup,
  recordAnswerTrace,
} from "./agent-case.js"
import { createProposal, getAgentRunStats, recordAgentRun } from "./agent-operations.js"
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
  expect(state).toEqual({ topics: [], pending: [], recent: [], notes: [], lookups: [] })
  expect(formatAgentCaseForPrompt(state, ZONE)).toBeNull()
})

it("el estado dice lo que espera al interlocutor y recuerda lo que no se hizo con su motivo", async () => {
  const conversationId = await openConversation("estado")
  // Una cita es el acto que espera el sí del interlocutor en el hilo (ADR 0021).
  const booking = await run((tx) => createProposal(tx, ORG, {
    conversationId, action: "reservar_cita", idempotencyKey: "case:cita-1",
    payload: { patientId: randomUUID(), professionalUserId: OWNER, roomId: randomUUID(), startsAt: "2026-11-02T15:00:00.000Z" },
  }))
  const pending = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(pending.pending.map((item) => item.action)).toEqual(["reservar_cita"])
  const prompt = formatAgentCaseForPrompt(pending, ZONE) ?? ""
  expect(prompt).toContain("Propuesta pendiente de que el interlocutor confirme: Reservar cita — ")
  expect(prompt).toContain(`(id ${booking.id}`)

  // Al confirmarla, la agenda ya no tenía el horario: queda fallida con su motivo.
  await ownerDb.update(agentProposal).set({ status: "fallida", error: "El horario ya no está libre", executedAt: new Date() }).where(eq(agentProposal.id, booking.id))
  const after = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(after.pending).toEqual([])
  expect(after.recent).toMatchObject([{ action: "reservar_cita", status: "fallida", detail: "El horario ya no está libre" }])
  const afterPrompt = formatAgentCaseForPrompt(after, ZONE) ?? ""
  expect(afterPrompt).toContain("No se hizo: Reservar cita — ")
  expect(afterPrompt).toContain("(fallida: El horario ya no está libre;")
})

it("las notas del caso son acotadas y no se repiten", async () => {
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
  expect(formatAgentCaseForPrompt(state, ZONE)).toContain("Notas del caso")
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
  expect(formatAgentCaseForPrompt(state, ZONE)).toContain("Consultas de mensajes anteriores")

  // Pasadas unas horas la consulta ya no se muestra: la agenda pudo cambiar.
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()
  await ownerDb
    .update(agentCaseMemory)
    .set({ lookups: { buscar_huecos: { text: "vieja", at: old } } })
    .where(eq(agentCaseMemory.conversationId, conversationId))
  state = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(state.lookups).toEqual([])
})

it("el contexto avisa cuando la atención no cabe entera en lo que lee el modelo, y calla cuando la ve toda (ADR 0104)", async () => {
  const conversationId = await openConversation("largo")
  const state = await run((tx) => getAgentCaseState(tx, ORG, conversationId))
  expect(formatAgentCaseForPrompt(state, ZONE, { total: 45, omitted: 0 })).toBeNull()
  expect(formatAgentCaseForPrompt(state, ZONE, { total: 260, omitted: 70 })).toBe(
    "De esta atención no ves 70 de sus 260 mensajes, los del medio: ves cómo empezó y lo último. Apóyate en tus notas y en el estado del caso; si falta un dato, pregúntalo.",
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
    basis: [{ kind: "servicios", label: "Sedes, servicios y precios" }],
    checks: [{ kind: "precio", value: "S/ 150", ok: true, source: "Sedes, servicios y precios" }],
    model: "fake",
  }))
  const listed = await run((tx) => listAnswerTraces(tx, ORG, conversationId))
  expect(listed).toMatchObject([
    { id: traceId, messageId, basis: [{ kind: "servicios", label: "Sedes, servicios y precios" }] },
  ])

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
