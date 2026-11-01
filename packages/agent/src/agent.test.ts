process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage, SystemMessage, type ToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { buildWebchatInbound, telegramBotApiAdapter, webChatAdapter } from "@odentia/channels"
import { createAppDb, createOwnerDb, type Db, sendAgentRun, withOrgContext } from "@odentia/db"
import { supportCase, supportMessage } from "@odentia/db/schema/admin-support"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { agentDecisionLog, agentHandoff, agentKnowledgeGap, agentProposal, agentRunLedger } from "@odentia/db/schema/agent"
import { user } from "@odentia/db/schema/auth"
import { automationJob } from "@odentia/db/schema/automation"
import { contact, contactIdentity, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import {
  AGENT_ROLES,
  addAgentGuidance,
  addContactIdentity,
  approveLesson,
  claimHandoff,
  closeConversationWith,
  configurePublicLinks,
  correctAnswer,
  createAppointment,
  createConnection,
  createContact,
  createHandoff,
  createKnowledgeEntry,
  createRoom,
  createTask,
  deleteProbar,
  discardLesson,
  findFreeGaps,
  getAgentCaseState,
  getAgentConfig,
  getLesson,
  getPatientRegistrationConfig,
  getProbar,
  ingestInbound,
  listAgentContextCandidates,
  listAnswerTraces,
  listAvailableSlots,
  listHandoffs,
  listOpportunities,
  listPersonFacts,
  listProposals,
  moveAppointment,
  pendingSpokenName,
  moveContactIdentity,
  nextPatientNumber,
  noteSandboxTurn,
  openProbar,
  operationAgentFields,
  professionalRef,
  READ_TOOLS,
  removePersonFact,
  reserveBookingLink,
  resolvePersonalLink,
  resolvePersonalLinkRefs,
  savePatientRegistrationConfig,
  secretsKeyFromEnv,
  sendOutbound,
  setKnowledgeStatus,
  setPatientContact,
  setProfessionalSchedule,
  TOOL_OPERATION,
  TOOLS_WITHOUT_OPERATION,
  updateTask,
  upsertAgentConfig,
  withdrawLesson,
} from "@odentia/services"
import { insertTestPatients } from "@odentia/services/test-patient"
import { and, desc, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest"
import { createFakeDecisionModel, DecisionError, type DecisionModel } from "./decision/index.js"
import { offTopicReply } from "./decision/route.js"
import { extractDictation } from "./extract-dictation.js"
import { FAKE_REPLY_TEXT } from "./fake-model.js"
import { compileAgentGraph, UNSENT_TEXT } from "./graph.js"
import { type AgentRuntime, previewLesson, processAgentRun } from "./run.js"
import { type AgentToolCtx, makeAgentTools, TOOL_SOURCES } from "./tools.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("aa".repeat(31) + "ab")

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let runtime: AgentRuntime
let tgConnId: string

export const storageStub = {
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
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

async function ingestText(thread: string, eventId: string, text: string) {
  return ingestOn(tgConnId, thread, eventId, text)
}

async function ingestOn(connectionId: string, thread: string, eventId: string, text: string) {
  return withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId,
        event: {
          externalEventId: eventId,
          externalMessageId: eventId,
          externalThreadId: thread,
          senderExternalId: thread,
          senderDisplayName: "Ana",
          content: { type: "text", text },
          sentAt: new Date().toISOString(),
        },
      },
      telegramBotApiAdapter,
      { storage: storageStub, fetch, secretsKey: KEY },
    ),
  )
}

/** Aviso fijo que recibe la persona cuando su caso pasa al equipo y nadie redactó otro. */
const HANDOFF_NOTICE = "Recibimos tu mensaje. Una persona del equipo te va a responder por aquí."

async function agentMessages(conversationId: string): Promise<string[]> {
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ body: message.body })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.senderKind, "agent"))),
  )
  return rows.map((r) => r.body ?? "")
}

async function runAgent(conversationId: string, messageId: string, readCt = 0, platform = runtime.platform) {
  return processAgentRun(appDb, { ...runtime, platform }, {
    msg_id: 1,
    read_ct: readCt,
    message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId },
  })
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
  const host = container.getHost()
  const port = container.getMappedPort(5432)
  const ownerUri = `postgres://dentalagent:dentalagent@${host}:${port}/dentalagent`
  ownerDb = createOwnerDb(ownerUri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}:${port}/dentalagent`)
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values ('org_a', 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE') on conflict do nothing`,
  )
  runtime = { platform: { fake: true }, secretsKey: KEY }
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    createConnection(
      tx,
      "org_a",
      KEY,
      {
        channel: "telegram",
        provider: "telegram_bot_api",
        displayName: "Bot",
        config: { botToken: "T" },
      },
      { fetch, validateExternal: false },
    ),
  )
  tgConnId = created.id
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { enabled: true }))
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("inbound con agente habilitado produce respuesta del agente", async () => {
  const { conversationId, messageId } = await ingestText("tg:ag1", "evt-ag1", "Hola, quiero info")
  expect(await runAgent(conversationId, messageId)).toBe("done")
  expect(await agentMessages(conversationId)).toContain(FAKE_REPLY_TEXT)
  const runs = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ status: agentRunLedger.status, model: agentRunLedger.model })
      .from(agentRunLedger)
      .where(eq(agentRunLedger.conversationId, conversationId)),
  )
  expect(runs.some((r) => r.status === "ok" && r.model === "fake")).toBe(true)
})

it("handoff por palabra clave apaga el agente y crea tarea", async () => {
  await withOrgContext(appDb, "org_a", (tx) =>
    upsertAgentConfig(tx, "org_a", { enabled: true, handoffKeywords: ["humano"] }),
  )
  const { conversationId, messageId } = await ingestText(
    "tg:ag2",
    "evt-ag2",
    "Quiero hablar con un humano",
  )
  expect(await runAgent(conversationId, messageId)).toBe("done")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ agentStatus: conversation.agentStatus })
      .from(conversation)
      .where(eq(conversation.id, conversationId)),
  )
  expect(conv?.agentStatus).toBe("on") // derivar no apaga al agente (ADR 0050)
  expect(await agentMessages(conversationId)).toEqual([HANDOFF_NOTICE])  // Derivar siempre avisa (ADR 0024).
  const tasks = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ title: crmTask.title })
      .from(crmTask)
      .where(eq(crmTask.conversationId, conversationId)),
  )
  // Un solo nombre para lo que el agente pasa al equipo, sin la prioridad en código.
  expect(tasks.some((t) => t.title.startsWith("Te lo pasó Sofi: "))).toBe(true)
  const handoffs = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({
        reason: agentHandoff.reason,
        summary: agentHandoff.summary,
        priority: agentHandoff.priority,
        taskId: agentHandoff.taskId,
      })
      .from(agentHandoff)
      .where(eq(agentHandoff.conversationId, conversationId)),
  )
  expect(handoffs.length).toBe(1)
  expect(handoffs[0]?.taskId).toBeTruthy()
  await withOrgContext(appDb, "org_a", (tx) =>
    upsertAgentConfig(tx, "org_a", { handoffKeywords: [] }),
  )
})

it("una ráfaga la atiende la primera corrida y las demás no repiten la respuesta", async () => {
  const first = await ingestText("tg:ag3", "evt-ag3", "primero")
  const rest: { conversationId: string; messageId: string }[] = []
  for (let i = 0; i < 6; i++) {
    rest.push(await ingestText("tg:ag3", `evt-ag3-${i}`, `mensaje ${i}`))
  }
  // La corrida del primer mensaje lee los siete y responde una vez.
  expect(await runAgent(first.conversationId, first.messageId)).toBe("done")
  expect(await agentMessages(first.conversationId)).toEqual([FAKE_REPLY_TEXT])
  // Las corridas del resto de la ráfaga ya están atendidas: no responden otra vez.
  for (const item of rest) expect(await runAgent(item.conversationId, item.messageId)).toBe("done")
  expect(await agentMessages(first.conversationId)).toEqual([FAKE_REPLY_TEXT])
  const runs = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ status: agentRunLedger.status })
      .from(agentRunLedger)
      .where(eq(agentRunLedger.conversationId, first.conversationId)),
  )
  expect(runs.filter((r) => r.status === "ok")).toHaveLength(1)
  expect(runs.filter((r) => r.status === "omitida")).toHaveLength(6)
})

function emptyUsage(): AgentToolCtx["usage"] {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, calls: 0, reported: false, cacheReported: false }
}

/** Modelo guionizado: decide cada respuesta a partir de los mensajes vistos. */
class ScriptedModel extends BaseChatModel {
  seen: BaseMessage[][] = []
  constructor(private readonly script: (messages: BaseMessage[], call: number) => AIMessage) {
    super({})
  }
  _llmType(): string {
    return "scripted-chat"
  }
  /** Herramientas que el grafo le ofreció en esta corrida. */
  tools: string[] = []
  override bindTools(tools: unknown[] = []): this {
    this.tools = tools.map((tool) => (tool as { name: string }).name)
    return this
  }
  /** Herramientas que tenía a la vista en cada llamada. */
  offered: string[][] = []
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages)
    this.offered.push([...this.tools])
    const message = this.script(messages, this.seen.length)
    return { generations: [{ text: String(message.content), message }] }
  }
}

function toolCall(name: string, args: Record<string, unknown>, id: string): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] })
}

async function runScripted(model: ScriptedModel, conversationId: string, messageId: string) {
  return processAgentRun(appDb, { ...runtime, createModel: async () => model }, {
    msg_id: 1,
    read_ct: 0,
    message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId },
  })
}

async function ledgerRows(conversationId: string) {
  return withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ status: agentRunLedger.status, llmCalls: agentRunLedger.llmCalls, toolsUsed: agentRunLedger.toolsUsed })
      .from(agentRunLedger)
      .where(eq(agentRunLedger.conversationId, conversationId)),
  )
}

async function agentStatusOf(conversationId: string) {
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ agentStatus: conversation.agentStatus })
      .from(conversation)
      .where(eq(conversation.id, conversationId)),
  )
  return conv?.agentStatus
}

it("maxTurns deriva cuando el modelo no llega a responder", async () => {
  await withOrgContext(appDb, "org_a", (tx) =>
    upsertAgentConfig(tx, "org_a", { enabled: true, maxTurns: 1 }),
  )
  try {
    const { conversationId, messageId } = await ingestText("tg:ag4", "evt-ag4", "Hola")
    const model = new ScriptedModel((_messages, call) => toolCall("listar_tareas", {}, `call-${call}`))
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    expect(await agentStatusOf(conversationId)).toBe("on")
    expect(await agentMessages(conversationId)).toEqual([HANDOFF_NOTICE])  // Derivar siempre avisa (ADR 0024).
    expect((await ledgerRows(conversationId)).map((r) => r.status)).toEqual(["handoff"])
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { maxTurns: 10 }))
  }
})

it("la respuesta cierra el turno: una sola llamada al modelo y sin derivar con maxTurns=1", async () => {
  await withOrgContext(appDb, "org_a", (tx) =>
    upsertAgentConfig(tx, "org_a", { enabled: true, maxTurns: 1 }),
  )
  try {
    const { conversationId, messageId } = await ingestText("tg:ag-cierre", "evt-ag-cierre", "Hola")
    const model = new ScriptedModel((_messages, call) =>
      call === 1
        ? toolCall("send_reply", { text: "Hola, ¿en qué te ayudo?" }, "call-1")
        : new AIMessage({ content: "texto que nadie recibe" }),
    )
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    expect(model.seen.length).toBe(1)
    expect(await agentMessages(conversationId)).toEqual(["Hola, ¿en qué te ayudo?"])
    expect(await agentStatusOf(conversationId)).toBe("on")
    expect(await ledgerRows(conversationId)).toEqual([{ status: "ok", llmCalls: 1, toolsUsed: ["send_reply"] }])
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { maxTurns: 10 }))
  }
})

it("texto sin herramienta de envío: un aviso; si vuelve a escribir sin enviar, pide un momento y reintenta; si vuelve a pasar, queda un tema con el aviso fijo (ADR 0050)", async () => {
  const stamp = Date.now()
  const receptionId = `agent-reception-${stamp}`
  await ownerDb.insert(user).values({ id: receptionId, name: "Recepción", email: `recepcion-${stamp}@example.test` })
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${receptionId}`}, 'org_a', ${receptionId}, 'reception', now())`)
  const { conversationId, messageId } = await ingestText("tg:ag-mudo", "evt-ag-mudo", "¿Atienden sábados?")
  const model = new ScriptedModel(() => new AIMessage({ content: "Sí, atendemos los sábados." }))
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  // El texto no salió: el modelo recibe una sola vez el aviso, tras su texto, y vuelve a escribir.
  expect(model.seen).toHaveLength(2)
  const reminded = model.seen[1] ?? []
  expect(reminded.at(-2)?.getType()).toBe("ai")
  expect(reminded.at(-1)?.getType()).toBe("human")
  expect(String(reminded.at(-1)?.content)).toBe(UNSENT_TEXT)
  // Tampoco tras el aviso: la persona no queda sin nada, un momento, y la corrida vuelve a la cola.
  expect(await agentMessages(conversationId)).toEqual(["Dame un momento, te respondo enseguida."])
  expect(await agentStatusOf(conversationId)).toBe("on")
  expect(await ledgerRows(conversationId)).toEqual([{ status: "sin_respuesta", llmCalls: 2, toolsUsed: [] }])
  const notices = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ title: workspaceNotification.title, href: workspaceNotification.href })
      .from(workspaceNotification)
      .where(eq(workspaceNotification.userId, receptionId)),
  )
  // La campana no lo repite: la conversación espera respuesta y así la muestra «Te espera».
  expect(notices).toEqual([])
  // Una corrida sin respuesta no da el mensaje por atendido: reprocesarlo
  // vuelve a llamar al modelo, y tampoco avisa en la campana.
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  // Esta vez sin aviso: el «momento» ya salió y cuenta como respuesta.
  expect(model.seen).toHaveLength(3)
  // La segunda vez con el mismo mensaje pasa a recepción como tema, con el aviso fijo.
  expect((await ledgerRows(conversationId)).map((row) => row.status)).toEqual(["sin_respuesta", "handoff"])
  // Sin orden en la consulta: se comparan los dos mensajes, no su posición.
  expect((await agentMessages(conversationId)).sort()).toEqual([
    "Dame un momento, te respondo enseguida.",
    "Recibimos tu mensaje. Una persona del equipo te va a responder por aquí.",
  ])
  const again = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ id: workspaceNotification.id })
      .from(workspaceNotification)
      .where(eq(workspaceNotification.userId, receptionId)),
  )
  expect(again.length).toBe(0)
})

it("texto sin enviar: tras el aviso, el modelo lo envía y la persona lo recibe", async () => {
  const { conversationId, messageId } = await ingestText("tg:ag-aviso", "evt-ag-aviso", "Hola")
  // Como hacía Claude 5.5 en la medición del 2026-10-17: escribe la respuesta como texto y no la envía.
  const model = new ScriptedModel((messages, call) =>
    call === 1
      ? new AIMessage({ content: "Hola, ¿en qué te ayudo?" })
      : String(messages.at(-1)?.content) === UNSENT_TEXT
        ? toolCall("send_reply", { text: "Hola, ¿en qué te ayudo?" }, "call-aviso")
        : new AIMessage({ content: "sin aviso" }),
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(model.seen).toHaveLength(2)
  expect(await agentMessages(conversationId)).toEqual(["Hola, ¿en qué te ayudo?"])
  expect(await ledgerRows(conversationId)).toEqual([{ status: "ok", llmCalls: 2, toolsUsed: ["send_reply"] }])
})

it("lo que lanza una herramienta vuelve al modelo como mensaje de error y no reintenta la corrida", async () => {
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { enabled: true, maxTurns: 10 }))
  const { conversationId, messageId } = await ingestText("tg:ag-toolerr", "evt-ag-toolerr", "Necesito ayuda")
  const model = new ScriptedModel((_messages, call) =>
    call === 1
      ? // Un paciente que no es suyo: el servicio lo rechaza y la herramienta lanza.
        toolCall("ver_resumen_paciente", { patientId: "00000000-0000-4000-8000-0000000000ff" }, "call-1")
      : toolCall("send_reply", { text: "Enseguida te ayudamos." }, "call-2"),
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(model.seen.length).toBe(2)
  const second = model.seen[1] ?? []
  const last = second[second.length - 1]
  expect(last?.getType()).toBe("tool")
  expect(String(last?.content)).toContain("Contacto activo vinculado al paciente")
  expect(await agentStatusOf(conversationId)).toBe("on")
  expect(await agentMessages(conversationId)).toEqual(["Enseguida te ayudamos."])
  expect(await ledgerRows(conversationId)).toEqual([
    { status: "ok", llmCalls: 2, toolsUsed: ["ver_resumen_paciente", "send_reply"] },
  ])
})

it("una respuesta emitida junto a otra herramienta no sale hasta ir sola en su paso", async () => {
  const { conversationId, messageId } = await ingestText("tg:ag-lote", "evt-ag-lote", "¿Tengo algo pendiente?")
  const model = new ScriptedModel((_messages, call) =>
    call === 1
      ? new AIMessage({
          content: "",
          tool_calls: [
            { name: "listar_tareas", args: {}, id: "call-1a", type: "tool_call" },
            { name: "send_reply", args: { text: "No tienes pendientes." }, id: "call-1b", type: "tool_call" },
          ],
        })
      : toolCall("send_reply", { text: "Revisé tus pendientes: no hay ninguno." }, "call-2"),
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(model.seen.length).toBe(2)
  const results = (model.seen[1] ?? []).filter((m) => m.getType() === "tool").map((m) => String(m.content))
  expect(results).toHaveLength(2)
  expect(results.filter((text) => text.startsWith("No enviado"))).toHaveLength(1)
  expect(await agentMessages(conversationId)).toEqual(["Revisé tus pendientes: no hay ninguno."])
  expect(await ledgerRows(conversationId)).toEqual([
    { status: "ok", llmCalls: 2, toolsUsed: ["listar_tareas", "send_reply"] },
  ])
})

it("lo que solo guarda lo que dijo va en el mismo paso que la respuesta: sale en una sola llamada y queda anotado (ADR 0104)", async () => {
  const { conversationId, messageId } = await ingestText("tg:ag-anota", "evt-ag-anota", "Es para mi hija Ana, prefiero en Miraflores")
  const model = new ScriptedModel(() =>
    new AIMessage({
      content: "",
      tool_calls: [
        { name: "anotar_caso", args: { para_quien: "su hija Ana", preferencia: "en Miraflores" }, id: "call-1a", type: "tool_call" },
        { name: "send_reply", args: { text: "Perfecto, te ayudo con la cita de Ana." }, id: "call-1b", type: "tool_call" },
      ],
    }),
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(model.seen).toHaveLength(1)
  expect(await agentMessages(conversationId)).toEqual(["Perfecto, te ayudo con la cita de Ana."])
  const state = await withOrgContext(appDb, "org_a", (tx) => getAgentCaseState(tx, "org_a", conversationId))
  expect(state.notes.map((note) => [note.kind, note.text])).toEqual([
    ["para_quien", "su hija Ana"],
    ["preferencia", "en Miraflores"],
  ])
  expect(await ledgerRows(conversationId)).toEqual([{ status: "ok", llmCalls: 1, toolsUsed: ["anotar_caso", "send_reply"] }])
})

it("lo que acepta la persona se confirma antes de proponer otra cosa en el mismo paso (auditoría del ADR 0104)", async () => {
  const { conversationId, messageId } = await ingestText("tg:ag-confirma-propone", "evt-ag-confirma-propone", "Sí, acepto, resérvala")
  const model = new ScriptedModel((_messages, call) =>
    call === 1
      ? new AIMessage({
          content: "",
          tool_calls: [
            { name: "confirmar_propuesta", args: { proposalId: randomUUID() }, id: "call-1a", type: "tool_call" },
            { name: "proponer_cita", args: {}, id: "call-1b", type: "tool_call" },
          ],
        })
      : toolCall("send_reply", { text: "Te ayudo con eso." }, `call-${call}`),
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  const results = (model.seen[1] ?? []).filter((m) => m.getType() === "tool").map((m) => ({ name: (m as ToolMessage).name, text: String(m.content) }))
  // La propuesta nueva no corre junto al sí: así no reemplaza lo que acababa de aceptar.
  expect(results.find((item) => item.name === "proponer_cita")?.text).toContain("No hecho: en este mismo paso confirmaste")
  expect(results.find((item) => item.name === "confirmar_propuesta")?.text).not.toContain("No hecho")
})

it("a quien escribe en inglés no le sale una respuesta en español: se le pide traducirla una vez (auditoría del ADR 0104)", async () => {
  const { conversationId, messageId } = await ingestText("tg:ag-ingles", "evt-ag-ingles", "Hi! Do you have an appointment available this week? How much is the evaluation?")
  const model = new ScriptedModel((_messages, call) =>
    call === 1
      ? toolCall("send_reply", { text: "Hola, con gusto te ayudo con la evaluación de esta semana." }, "call-1")
      : toolCall("send_reply", { text: "Hi! I'd be glad to help you with the evaluation this week." }, "call-2"),
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(systemTextOf(model.seen[0] ?? [])).toContain("La persona te escribe en inglés: respóndele en inglés")
  const first = (model.seen[1] ?? []).filter((m) => m.getType() === "tool").map((m) => String(m.content))
  expect(first.at(-1)).toContain("No enviado: la persona te escribe en inglés y tu mensaje está en español")
  expect(await agentMessages(conversationId)).toEqual(["Hi! I'd be glad to help you with the evaluation this week."])
})

it("derivar con aviso envía el mensaje y registra la derivación en una sola llamada al modelo", async () => {
  const { conversationId, messageId } = await ingestText("tg:ag-deriva", "evt-ag-deriva", "Quiero que me atienda alguien")
  const model = new ScriptedModel(() =>
    toolCall(
      "request_human_handoff",
      {
        reason: "Pide atención de una persona",
        summary: "Pide que lo atienda alguien del equipo",
        priority: "alta",
        message: "Te paso con una persona del equipo.",
      },
      "call-1",
    ),
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(model.seen.length).toBe(1)
  expect(await agentMessages(conversationId)).toEqual(["Te paso con una persona del equipo."])
  expect(await agentStatusOf(conversationId)).toBe("on")
  const handoffs = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ priority: agentHandoff.priority })
      .from(agentHandoff)
      .where(eq(agentHandoff.conversationId, conversationId)),
  )
  expect(handoffs).toEqual([{ priority: "alta" }])
  expect(await ledgerRows(conversationId)).toEqual([
    { status: "handoff", llmCalls: 1, toolsUsed: ["request_human_handoff"] },
  ])
})

it("si pasa un tema sin escribirle, el modelo responde él lo demás que preguntó; el aviso fijo no sale", async () => {
  const { conversationId, messageId } = await ingestText(
    "tg:ag-deriva-sin-aviso",
    "evt-ag-deriva-sin-aviso",
    "¿Debo tomar algo para la fiebre? ¿Y hay cita hoy?",
  )
  const model = new ScriptedModel((_messages, call) =>
    call === 1
      ? toolCall("request_human_handoff", { reason: "Pregunta qué tomar", summary: "Pregunta qué tomar para la fiebre", clinical: true }, "call-1")
      : toolCall("send_reply", { text: "Lo de la fiebre lo verá el equipo clínico. ¿Para qué hora de hoy buscas la cita?" }, "call-2"),
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(model.seen.length).toBe(2)
  const handoffResult = (model.seen[1] ?? []).filter((m) => m.getType() === "tool").map((m) => String(m.content))
  expect(handoffResult.at(-1)).toContain("Falta tu respuesta")
  expect(await agentMessages(conversationId)).toEqual(["Lo de la fiebre lo verá el equipo clínico. ¿Para qué hora de hoy buscas la cita?"])
  expect(await ledgerRows(conversationId)).toEqual([
    { status: "handoff", llmCalls: 2, toolsUsed: ["request_human_handoff", "send_reply"] },
  ])
})

/** Servidor compatible con OpenAI que siempre rechaza la credencial. */
async function rejectingProvider() {
  let hits = 0
  const server = createServer((_request, response) => {
    hits += 1
    response.writeHead(401, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("El servidor de prueba no abrió un puerto")
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    hits: () => hits,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

it("si odentIA no tiene la cuenta de OpenAI, el caso pasa al equipo sin llamar a nadie", async () => {
  const { conversationId, messageId } = await ingestText("tg:ag-sin-cuenta", "evt-ag-sin-cuenta", "Hola")
  expect(await runAgent(conversationId, messageId, 0, {})).toBe("done")
  expect(await agentStatusOf(conversationId)).toBe("on")
  const [row] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ error: agentRunLedger.error, model: agentRunLedger.model }).from(agentRunLedger).where(eq(agentRunLedger.conversationId, conversationId)),
  )
  expect(row?.error).toMatch(/^API_KEY_REQUIRED: .*LLM_OPENAI_API_KEY/)
  expect(row?.model).toBe("gpt-6-luna")
})

it("una credencial rechazada no reintenta: deriva, avisa una vez a quien administra y queda como error", async () => {
  const provider = await rejectingProvider()
  const stamp = Date.now()
  const adminId = `agent-admin-${stamp}`
  await ownerDb.insert(user).values({ id: adminId, name: "Admin", email: `admin-${stamp}@example.test` })
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${adminId}`}, 'org_a', ${adminId}, 'admin', now())`)
  try {
    const platform = { openai: { apiKey: "clave-rechazada", baseUrl: provider.baseUrl } }
    const first = await ingestText("tg:ag-401", "evt-ag-401", "Hola")
    expect(await runAgent(first.conversationId, first.messageId, 0, platform)).toBe("done")
    expect(provider.hits()).toBe(1)
    expect(await agentStatusOf(first.conversationId)).toBe("on")
    expect(await agentMessages(first.conversationId)).toEqual([HANDOFF_NOTICE])  // Derivar siempre avisa (ADR 0024).
    const rows = await ledgerRows(first.conversationId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("error")
    const [ledgerRow] = await withOrgContext(appDb, "org_a", (tx) =>
      tx
        .select({ error: agentRunLedger.error, model: agentRunLedger.model })
        .from(agentRunLedger)
        .where(eq(agentRunLedger.conversationId, first.conversationId)),
    )
    expect(ledgerRow?.error).toMatch(/^PROVIDER_REJECTED: HTTP 401: Incorrect API key provided$/)
    expect(ledgerRow?.model).toBe("gpt-6-luna")
    // El motivo que ve recepción es fijo: nunca el cuerpo de la respuesta del proveedor.
    const [handoff] = await withOrgContext(appDb, "org_a", (tx) =>
      tx
        .select({ reason: agentHandoff.reason, summary: agentHandoff.summary })
        .from(agentHandoff)
        .where(eq(agentHandoff.conversationId, first.conversationId)),
    )
    expect(handoff?.reason).toBe("Sofi no puede usar el modelo ahora; ya avisamos a odentIA")
    expect(handoff?.summary).not.toContain("Incorrect API key")
    // Segunda conversación el mismo día: otra derivación, pero un solo aviso.
    const second = await ingestText("tg:ag-401-b", "evt-ag-401-b", "Buenas")
    expect(await runAgent(second.conversationId, second.messageId, 0, platform)).toBe("done")
    const notices = await withOrgContext(appDb, "org_a", (tx) =>
      tx
        .select({ title: workspaceNotification.title, body: workspaceNotification.body, href: workspaceNotification.href })
        .from(workspaceNotification)
        .where(and(eq(workspaceNotification.userId, adminId), eq(workspaceNotification.subject, "modelo-del-agente"))),
    )
    // Las derivaciones generan sus propios avisos; el del proveedor es uno solo, sin claves ni variables, y lleva a Recepción.
    expect(notices).toEqual([
      {
        title: "Sofi no puede usar el modelo",
        body: "Sofi no puede responder ahora: los mensajes pasan a tu equipo. Ya avisamos a odentIA.",
        href: "/agent/recepcion",
      },
    ])
  } finally {
    await provider.close()
  }
})

it("una cuota agotada (402) tampoco reintenta y avisa con su propio título", async () => {
  let hits = 0
  const server = createServer((_request, response) => {
    hits += 1
    response.writeHead(402, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "Insufficient credits", code: "insufficient_quota" } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("El servidor de prueba no abrió un puerto")
  try {
    const { conversationId, messageId } = await ingestText("tg:ag-402", "evt-ag-402", "Hola")
    expect(await runAgent(conversationId, messageId, 0, { openai: { apiKey: "clave", baseUrl: `http://127.0.0.1:${address.port}/v1` } })).toBe("done")
    expect(hits).toBe(1)
    expect(await agentStatusOf(conversationId)).toBe("on")
    const [row] = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ error: agentRunLedger.error }).from(agentRunLedger).where(eq(agentRunLedger.conversationId, conversationId)),
    )
    expect(row?.error).toMatch(/^PROVIDER_QUOTA: HTTP 402/)
    const notices = await withOrgContext(appDb, "org_a", (tx) =>
      tx
        .select({ title: workspaceNotification.title })
        .from(workspaceNotification)
        .where(and(eq(workspaceNotification.href, "/agent/recepcion"), eq(workspaceNotification.title, "Sofi no puede usar el modelo"))),
    )
    expect(notices.length).toBeGreaterThan(0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

it("el modelo de decisión en sombra registra su triaje sin cambiar la corrida", async () => {
  // Con «elegir el camino» apagado, el modelo de decisión solo opina.
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "baseline", decisionRoutingEnabled: false }))
  try {
    const { conversationId, messageId } = await ingestText("tg:ag-sombra", "evt-ag-sombra", "Quiero hablar con una persona, me duele mucho")
    // Una respuesta que no dice haber pasado nada: «te paso con el equipo» sin pase se pide de
    // nuevo (`claimsOf`), y aquí se mide solo que la sombra no cambie la corrida.
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Siento que te duela. ¿Desde cuándo?" }, "call-1"))
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    // La corrida es la de siempre: una llamada, respuesta enviada, agente activo.
    expect(model.seen.length).toBe(1)
    expect(await agentMessages(conversationId)).toEqual(["Siento que te duela. ¿Desde cuándo?"])
    expect(await agentStatusOf(conversationId)).toBe("on")
    const rows = await withOrgContext(appDb, "org_a", (tx) =>
      tx
        .select({ point: agentDecisionLog.point, provider: agentDecisionLog.provider, outcome: agentDecisionLog.outcome, stateChars: agentDecisionLog.stateChars, error: agentDecisionLog.error })
        .from(agentDecisionLog)
        .where(eq(agentDecisionLog.conversationId, conversationId)),
    )
    // Con LLM_MODEL=fake la línea base es el modelo de decisión falso.
    expect(rows).toEqual([
      expect.objectContaining({ point: "triage.v6", provider: "fake", error: null, outcome: expect.objectContaining({ wouldHandoff: true }) }),
    ])
    expect(rows[0]!.stateChars).toBeGreaterThan(0)
    // Las filas no guardan el texto: solo la huella.
    const [raw] = await ownerDb.execute(sql`select state_hash, answers::text as answers from agent_decision_log where conversation_id = ${conversationId}`) as unknown as Array<{ state_hash: string; answers: string }>
    expect(raw?.state_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(raw?.answers).not.toContain("me duele")
    // Un proveedor que falla queda como fila con error, sin tocar la corrida.
    const broken = { provider: "jev" as const, reportsProbabilities: true, decide: async () => { throw new Error("caído") } }
    const second = await ingestText("tg:ag-sombra-2", "evt-ag-sombra-2", "Hola")
    expect(
      await processAgentRun(appDb, { ...runtime, createModel: async () => model, createDecisionModel: () => broken }, {
        msg_id: 2,
        read_ct: 0,
        message: { kind: "inbound_message", orgId: "org_a", conversationId: second.conversationId, messageId: second.messageId },
      }),
    ).toBe("done")
    const failed = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ error: agentDecisionLog.error }).from(agentDecisionLog).where(eq(agentDecisionLog.conversationId, second.conversationId)),
    )
    expect(failed[0]?.error).toContain("fallo inesperado")
    expect(await ledgerRows(second.conversationId)).toEqual([{ status: "ok", llmCalls: 1, toolsUsed: ["send_reply"] }])
    // Un proveedor elegido sin credenciales de plataforma también queda a la vista.
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "jev" }))
    const third = await ingestText("tg:ag-sombra-3", "evt-ag-sombra-3", "Hola")
    expect(await runScripted(model, third.conversationId, third.messageId)).toBe("done")
    const missing = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ provider: agentDecisionLog.provider, error: agentDecisionLog.error }).from(agentDecisionLog).where(eq(agentDecisionLog.conversationId, third.conversationId)),
    )
    expect(missing).toEqual([{ provider: "jev", error: expect.stringContaining("CONFIG") }])
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "none", decisionRoutingEnabled: true }))
  }
})

it("toda clínica nace con Jev; sin su clave, o con la clave rechazada, la corrida sigue y odentIA recibe el caso de Soporte", async () => {
  // Una clínica sin fila toma el valor del código; una fila que crea otra operación, el de la base.
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_jev', 'Clínica Jev', 'jev', now())`)
  expect((await withOrgContext(appDb, "org_jev", (tx) => getAgentConfig(tx, "org_jev"))).decisionProvider).toBe("jev")
  await withOrgContext(appDb, "org_jev", (tx) => noteSandboxTurn(tx, "org_jev"))
  expect((await withOrgContext(appDb, "org_jev", (tx) => getAgentConfig(tx, "org_jev"))).decisionProvider).toBe("jev")

  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "jev" }))
  // Un modelo que escribe de verdad (cuenta sintética) y el rol owner: así corre en producción.
  const live = { ...runtime, ownerDb, platform: { openai: { apiKey: "clave-sintetica" } } }
  const casesOf = (code: string) =>
    ownerDb
      .select({ id: supportCase.id, question: supportCase.question, organizationId: supportCase.organizationId })
      .from(supportCase)
      .where(eq(supportCase.dedupeKey, `modelo-sin-responder:jev:${code}`))
  try {
    // Sin JEV_API_KEY: responde el modelo que escribe, como sin modelo de decisión.
    for (const n of [1, 2]) {
      const { conversationId, messageId } = await ingestText(`tg:ag-jev-sin-clave-${n}`, `evt-ag-jev-sin-clave-${n}`, "¿Venden zapatillas?")
      const model = new ScriptedModel(() => toolCall("send_reply", { text: "Solo atendemos temas de la clínica." }, "call-1"))
      expect(await processAgentRun(appDb, { ...live, createModel: async () => model }, {
        msg_id: n,
        read_ct: 0,
        message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId },
      })).toBe("done")
      expect(await ledgerRows(conversationId)).toEqual([{ status: "ok", llmCalls: 1, toolsUsed: ["send_reply"] }])
    }
    // Un solo caso, sin clínica (ninguna lo ve), y la clínica anotada una sola vez aunque corrió dos veces.
    const missing = await casesOf("DECISION_KEY_MISSING")
    expect(missing).toEqual([{ id: expect.any(String), question: "Modelo sin responder · Clínica", organizationId: null }])
    const lines = await ownerDb.select({ body: supportMessage.body }).from(supportMessage).where(eq(supportMessage.caseId, missing[0]!.id))
    expect(lines).toEqual([{ body: expect.stringContaining("Jev (modelo de decisión) no responde desde") }])
    expect(lines[0]!.body).toContain("JEV_API_KEY")

    // Clave rechazada al llamar: el turno sigue por el camino abierto y el caso tiene su propio motivo.
    const rejected: DecisionModel = {
      provider: "jev",
      reportsProbabilities: true,
      decide: async () => {
        throw new DecisionError("CONFIG", "Jev respondió HTTP 401", 401)
      },
    }
    const { conversationId, messageId } = await ingestText("tg:ag-jev-rechazada", "evt-ag-jev-rechazada", "Hola")
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Hola, ¿en qué te ayudo?" }, "call-1"))
    expect(await processAgentRun(appDb, { ...live, createModel: async () => model, createDecisionModel: () => rejected }, {
      msg_id: 3,
      read_ct: 0,
      message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId },
    })).toBe("done")
    expect(await agentMessages(conversationId)).toEqual(["Hola, ¿en qué te ayudo?"])
    expect(await casesOf("DECISION_REJECTED")).toEqual([expect.objectContaining({ organizationId: null })])
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "none" }))
  }
})

it("la configuración no guarda modelo ni cuentas de proveedor (ADR 0052)", async () => {
  const cfg = await withOrgContext(appDb, "org_a", (tx) => getAgentConfig(tx, "org_a"))
  // Sin tope de corridas: el único límite es el presupuesto del mes (ADR 0085).
  expect(cfg).not.toHaveProperty("dailyRunLimit")
  expect(Object.keys(cfg).filter((key) => /apikey|baseurl|^model$|^llm$/i.test(key))).toEqual([])
})

it("una reentrega con el hilo ya respondido no avisa ni queda sin_respuesta", async () => {
  const { conversationId, messageId } = await ingestText("tg:ag-reentrega", "evt-ag-reentrega", "¿Abren mañana?")
  const replies = new ScriptedModel(() => toolCall("send_reply", { text: "Sí, abrimos mañana." }, "call-1"))
  expect(await runScripted(replies, conversationId, messageId)).toBe("done")
  const silent = new ScriptedModel(() => new AIMessage({ content: "Ya respondí antes." }))
  expect(await runScripted(silent, conversationId, messageId)).toBe("done")
  // El mensaje ya consta como atendido: la reentrega ni llama al modelo ni añade filas.
  expect(silent.seen).toHaveLength(0)
  expect(await agentMessages(conversationId)).toEqual(["Sí, abrimos mañana."])
  expect((await ledgerRows(conversationId)).map((r) => r.status)).toEqual(["ok"])
  // Si la corrida cayó antes de anotarse en el libro, la reentrega sí se
  // ejecuta; como el hilo ya tiene la respuesta, no avisa ni queda sin_respuesta,
  // y su texto sin enviar no recibe el aviso: la persona no recibiría dos veces lo mismo.
  await ownerDb.delete(agentRunLedger).where(eq(agentRunLedger.conversationId, conversationId))
  expect(await runScripted(silent, conversationId, messageId)).toBe("done")
  expect(silent.seen).toHaveLength(1)
  expect(await agentMessages(conversationId)).toEqual(["Sí, abrimos mañana."])
  expect((await ledgerRows(conversationId)).map((r) => r.status)).toEqual(["ok"])
  const notices = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ id: workspaceNotification.id })
      .from(workspaceNotification)
      .where(eq(workspaceNotification.href, `/inbox?conversation=${conversationId}`)),
  )
  expect(notices).toEqual([])
})

it("el agente no guarda su borrador: tras sus corridas no hay tablas del grafo (ADR 0051)", async () => {
  const runs = (await ownerDb.execute(sql`select count(*)::int as n from "agent_run_ledger"`)) as unknown as { n: number }[]
  expect(runs[0]?.n).toBeGreaterThan(0)
  const tables = (await ownerDb.execute(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename like 'checkpoint%'`,
  )) as unknown as { tablename: string }[]
  expect(tables.map((row) => row.tablename)).toEqual([])
})

it("simulación consulta seguimientos reales sin generar respuesta ni cambiar pendientes", async () => {
  const { conversationId } = await ingestText("tg:sim-context", "evt-sim-context", "Horario de evaluación")
  const [conv] = await withOrgContext(appDb, "org_a", tx =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  expect(conv).toBeDefined()
  const pending = await withOrgContext(appDb, "org_a", tx =>
    createTask(tx, "org_a", { contactId: conv!.contactId, conversationId, title: "Confirmar horario de tarde", createdBy: "user" }))
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId: conv!.contactId,
    triggerId: null, secretsKey: KEY, dryRun: true, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const reader = makeAgentTools(ctx).find(t => t.name === "listar_tareas")
  expect(reader).toBeDefined()
  expect(String(await reader!.invoke({ status: "open" }))).toContain("Confirmar horario de tarde")
  const [after] = await withOrgContext(appDb, "org_a", tx =>
    tx.select({ status: crmTask.status }).from(crmTask).where(eq(crmTask.id, pending.id)))
  expect(after?.status).toBe("open")
  expect(await agentMessages(conversationId)).toEqual([])
})

/**
 * Modelo que no responde nada y registra los mensajes vistos por turno. Sin
 * texto no hay aviso de texto sin enviar: una sola llamada por turno.
 */
class RecordingModel extends BaseChatModel {
  seen: BaseMessage[][] = []
  _llmType(): string {
    return "recording-chat"
  }
  override bindTools(): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages)
    const message = new AIMessage({ content: "" })
    return { generations: [{ text: "", message }] }
  }
}

/** Texto del system prompt visto por el modelo en un turno grabado. */
function systemTextOf(turn: BaseMessage[]): string {
  return turn
    .filter((m) => m instanceof SystemMessage || m.constructor?.name === "SystemMessage")
    .map((m) => String(m.content))
    .join("\n")
}

it("cada turno arma el contexto desde la base sin crecer por copia ni conservar políticas", async () => {
  const { conversationId } = await ingestText("tg:memoria-ctx", "evt-memoria-ctx", "Hola, una consulta")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  expect(conv).toBeDefined()
  const toolCtx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId: conv!.contactId,
    triggerId: null, secretsKey: KEY, dryRun: true, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const model = new RecordingModel({})
  toolCtx.draftText = "primer turno"
  await compileAgentGraph(model, toolCtx).invoke({ messages: [], turnCount: 0 })
  // Lo que escribe la clínica en «Lo que el agente debe saber» le llega en el turno siguiente.
  const written = await withOrgContext(appDb, "org_a", (tx) => addAgentGuidance(tx, "org_a", "u_indicaciones", "PROMPT-TURNO-DOS"))
  toolCtx.draftText = "segundo turno"
  await compileAgentGraph(model, toolCtx).invoke({ messages: [], turnCount: 0 })
  await withOrgContext(appDb, "org_a", (tx) => withdrawLesson(tx, "org_a", "u_indicaciones", written.id))
  expect(model.seen).toHaveLength(2)
  const first = model.seen[0] ?? []
  const second = model.seen[1] ?? []
  // Lo de la clínica antes del historial y lo del turno después (ADR 0104): nunca más copias.
  const systems = second.filter((m) => m instanceof SystemMessage || m.constructor?.name === "SystemMessage")
  expect(systems).toHaveLength(2)
  expect(second.length).toBeLessThanOrEqual(first.length + 1)
  const systemText = systems.map((m) => String(m.content)).join("\n")
  expect(systemText).toContain("PROMPT-TURNO-DOS")
  expect(await agentMessages(conversationId)).toEqual([])
})

it("el prompt incluye el compromiso de otro canal con procedencia y lo pierde al reasignar la identidad", async () => {
  const waConn = await withOrgContext(appDb, "org_a", async (tx) =>
    (await createConnection(
      tx,
      "org_a",
      KEY,
      {
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA Cross",
        config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S", templates: [] },
      },
      { fetch, validateExternal: false },
    )).id,
  )
  const wa = await ingestOn(waConn, "wa:51988990001", "evt-cross-wa", "Mi compromiso: prefiero cita los lunes por la mañana")
  const [waConv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, wa.conversationId)))
  expect(waConv).toBeDefined()
  const contactId = waConv!.contactId
  await withOrgContext(appDb, "org_a", (tx) =>
    addContactIdentity(tx, "org_a", null, contactId, { channel: "telegram", externalUserId: "tg:990011" }))
  // El mismo contacto continúa por Telegram: otro hilo, misma persona.
  const tg = await ingestText("tg:990011", "evt-cross-tg", "Hola, sigo desde otro canal")
  const toolCtx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId: tg.conversationId, contactId,
    triggerId: null, secretsKey: KEY, dryRun: true, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const model = new RecordingModel({})
  await compileAgentGraph(model, toolCtx).invoke({ messages: [], turnCount: 0 })
  const firstSystem = systemTextOf(model.seen[0] ?? [])
  expect(firstSystem).toContain("[whatsapp")
  expect(firstSystem).toContain("prefiero cita los lunes por la mañana")
  // Reasignar la identidad de WhatsApp a otro contacto revoca ese contexto.
  const other = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Nuevo Titular" }))
  const [waIdentity] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(contactIdentity).where(and(eq(contactIdentity.channel, "whatsapp"), eq(contactIdentity.externalUserId, "wa:51988990001"))).limit(1))
  expect(waIdentity).toBeDefined()
  await withOrgContext(appDb, "org_a", (tx) =>
    moveContactIdentity(tx, "org_a", null, waIdentity!.id, {
      fromContactId: contactId,
      toContactId: other.id,
      reason: "Corrige titular",
    }))
  await compileAgentGraph(model, toolCtx).invoke({ messages: [], turnCount: 0 })
  const secondSystem = systemTextOf(model.seen[1] ?? [])
  expect(secondSystem).not.toContain("prefiero cita los lunes por la mañana")
})

it("el prompt avisa cuando hay más historial y ver_otros_canales pagina con cursor", async () => {
  const current = await ingestText("tg:cross-pages", "evt-cross-pages", "hilo actual")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, current.conversationId)))
  const contactId = conv!.contactId
  // Cinco hilos antiguos del mismo contacto (más de la página de 3).
  await withOrgContext(appDb, "org_a", async (tx) => {
    for (let i = 1; i <= 5; i++) {
      const at = new Date(Date.now() - i * 60_000)
      const [old] = await tx
        .insert(conversation)
        .values({
          organizationId: "org_a",
          contactId,
          contactIdentityId: null,
          channelConnectionId: tgConnId,
          externalThreadId: `tg:hist-${i}`,
          createdAt: at,
          lastMessageAt: at,
        })
        .returning({ id: conversation.id })
      await tx.insert(message).values({
        organizationId: "org_a",
        conversationId: old!.id,
        direction: "in",
        senderKind: "contact",
        body: `historial viejo ${i}`,
        createdAt: at,
      })
    }
  })
  const toolCtx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId: current.conversationId, contactId,
    triggerId: null, secretsKey: KEY, dryRun: true, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const model = new RecordingModel({})
  await compileAgentGraph(model, toolCtx).invoke({ messages: [], turnCount: 0 })
  const system = systemTextOf(model.seen[0] ?? [])
  expect(system).toContain("[telegram")
  expect(system).toContain("usa ver_otros_canales")
  const reader = makeAgentTools(toolCtx).find((t) => t.name === "ver_otros_canales")
  expect(reader).toBeDefined()
  const first = String(await reader!.invoke({}))
  expect(first).toContain("[telegram")
  expect(first).toContain("historial viejo 1")
  const cursor = /cursor "([^"]+)"/.exec(first)?.[1]
  expect(cursor).toBeTruthy()
  const second = String(await reader!.invoke({ cursor }))
  expect(second).toContain("historial viejo 5")
  expect(second).not.toContain("Hay más historial")
  // Solo lectura también en simulación: no genera mensajes salientes.
  expect(await agentMessages(current.conversationId)).toEqual([])
})

it("buscar_huecos entrega una opción completa que proponer_cita ejecuta como cita real", async () => {
  const [createdBranch] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede Agente Reserva", timezone: "America/Lima" })
    .returning({ id: branch.id })
  const branchId = createdBranch!.id
  const stamp = Date.now()
  const actorId = `agent-actor-${stamp}`
  const professionalId = `agent-professional-${stamp}`
  await ownerDb.insert(user).values([
    { id: actorId, name: "Actor Agente", email: `actor-${stamp}@example.test` },
    { id: professionalId, name: "Dentista Agente", email: `dentista-${stamp}@example.test` },
  ])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${actorId}`}, 'org_a', ${actorId}, 'owner', now()),
      (${`m-${professionalId}`}, 'org_a', ${professionalId}, 'clinician', now())`)
  const createdRoom = await withOrgContext(appDb, "org_a", (tx) =>
    createRoom(tx, "org_a", { branchId, name: "Unidad dental Agente" }))
  const roomId = createdRoom!.id
  await withOrgContext(appDb, "org_a", (tx) =>
    setProfessionalSchedule(tx, "org_a", actorId, {
      branchId,
      professionalUserId: professionalId,
      rules: [1, 2, 3, 4, 5].flatMap((weekday) => [
        { weekday, startMin: 9 * 60, endMin: 13 * 60 },
      ]),
    }))
  const { conversationId } = await ingestText("tg:reserva-ctx", "evt-reserva-ctx", "Quiero una cita")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  expect(conv).toBeDefined()
  const contactId = conv!.contactId
  const patientNumber = await withOrgContext(appDb, "org_a", (tx) => nextPatientNumber(tx, "org_a"))
  const [createdPatient] = await insertTestPatients(ownerDb, { organizationId: "org_a", displayName: "Paciente Reserva Agente", patientNumber })
  const patientId = createdPatient!.id
  await withOrgContext(appDb, "org_a", (tx) =>
    setPatientContact(tx, "org_a", actorId, patientId, { contactId, relationship: "self", isPreferred: true }))
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId,
    triggerId: null, secretsKey: KEY, dryRun: false, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const tools = makeAgentTools(ctx)
  const gaps = tools.find((t) => t.name === "buscar_huecos")
  expect(gaps).toBeDefined()
  // Lunes de la semana que viene (día completo en Lima): el agente no ofrece horas pasadas.
  const monday = new Date(Date.now() + 7 * 86_400_000)
  monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7))
  const from = `${monday.toISOString().slice(0, 10)}T05:00:00Z`
  const out = String(await gaps!.invoke({
    branchId,
    from,
    to: new Date(Date.parse(from) + 86_400_000).toISOString(),
    durationMin: 45,
  }))
  // La hora va en la de la sede, para decirla tal cual; el instante exacto queda entre corchetes para reservar.
  expect(out.split("\n")[0]).toContain("hora local de la sede")
  const firstLine = out.split("\n")[1] ?? ""
  const optionBranch = firstLine.match(/sede ([0-9a-f-]{36})/i)?.[1]
  const optionRoom = firstLine.match(/unidad dental ([0-9a-f-]{36})/i)?.[1]
  const optionProfessional = firstLine.match(/profesional ([^\]\s]+)/)?.[1]
  const optionStart = firstLine.match(/startsAt (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/)?.[1]
  const [, startClock, endClock] = firstLine.match(/(\d{2}:\d{2})–(\d{2}:\d{2})/) ?? []
  expect(optionBranch).toBe(branchId)
  expect(optionRoom).toBe(roomId)
  // El agente ve la referencia del profesional, nunca su usuario.
  expect(optionProfessional).toBe(professionalRef("org_a", professionalId))
  expect(out).not.toContain(professionalId)
  if (!optionStart || !startClock || !endClock || !optionProfessional || !optionRoom || !optionBranch) {
    throw new Error("El hueco no contiene los datos necesarios para reservar")
  }
  // La hora local que lee la persona es la del instante en Lima.
  expect(new Date(optionStart).toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).toBe(startClock)
  const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3))
  const durationMin = minutesOf(endClock) - minutesOf(startClock)
  expect(durationMin).toBe(45)
  // Un rango en hora local, sin zona, es el mismo día en Lima.
  const localDay = String(await gaps!.invoke({
    branchId,
    from: `${monday.toISOString().slice(0, 10)}T00:00`,
    to: `${monday.toISOString().slice(0, 10)}T23:59`,
    durationMin: 45,
  }))
  expect(localDay.split("\n")[1]).toBe(firstLine)
  const booking = tools.find((t) => t.name === "proponer_cita")
  expect(booking).toBeDefined()
  await booking!.invoke({
    patientId,
    professionalUserId: optionProfessional,
    roomId: optionRoom,
    startsAt: optionStart,
    branchId: optionBranch,
    durationMin,
  })
  const pending = await withOrgContext(appDb, "org_a", (tx) =>
    listProposals(tx, "org_a", { conversationId, status: "propuesta" }))
  expect(pending).toHaveLength(1)
  expect(pending[0]!.mode).toBe("confirmar_usuario")
  await ingestText("tg:reserva-ctx", "evt-reserva-ctx-si", "Sí, confirmo")
  const confirmed = String(await tools.find((t) => t.name === "confirmar_propuesta")!.invoke({ proposalId: pending[0]!.id }))
  expect(confirmed).toContain("Confirmado y ejecutado")
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointment).where(
      and(eq(appointment.patientId, patientId), eq(appointment.roomId, roomId))))
  expect(rows).toHaveLength(1)
  const booked = rows[0]!
  expect(booked.branchId).toBe(branchId)
  expect(booked.professionalUserId).toBe(professionalId)
  expect(booked.durationMin).toBe(45)
  expect(booked.startsAt.toISOString()).toBe(optionStart)
  expect(booked.endsAt.toISOString()).toBe(new Date(Date.parse(optionStart) + durationMin * 60_000).toISOString())
  // La eligió la persona con su sí: nace confirmada (ADR 0109).
  expect(booked.status).toBe("confirmada")
})

/** Lo que el grafo guarda como lo consultado del turno cuando una herramienta entrega un enlace (`recordLookups`). */
const linksOf = (text: string) => ({
  kind: "sistema",
  source: "Enlace que entregó el sistema",
  text: (text.match(/\bhttps?:\/\/[^\s"<>\\^`{|}«»]+/gi) ?? []).join("\n"),
})

/** «Su enlace» con la hora elegida, tal como queda en el mensaje: con la referencia del token al final (ADR 0109). */
const PICK_LINK = /https:\/\/norte\.odentia\.test\/reserva\?sede=\S+?&token=\{\{su-enlace:[0-9a-f-]{36}\}\}/

const publicCtx = (conversationId: string, contactId: string): AgentToolCtx => ({
  db: appDb, orgId: "org_a", conversationId, contactId,
  triggerId: null, secretsKey: KEY, dryRun: false, handedOff: false, replySettled: false,
  toolsUsed: [], usage: emptyUsage(),
  publicUrl: { webURL: "https://app.odentia.test", cookieDomain: ".odentia.test" },
})

/** Los huecos del próximo lunes, como los propone el agente; la búsqueda queda como lo consultado del turno. */
async function offeredSlots(ctx: AgentToolCtx, branchId: string) {
  const day = upcomingMonday()
  const found = String(await makeAgentTools(ctx).find((t) => t.name === "buscar_huecos")!.invoke({
    branchId, from: day.toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString(), durationMin: 45,
  }))
  ctx.evidence = [...(ctx.evidence ?? []), { kind: "agenda", source: "Agenda: horarios disponibles", text: found }]
  ctx.toolsUsed.push("buscar_huecos")
  return found.split("\n").filter((line) => line.startsWith("- ")).map((line) => ({
    clock: line.match(/, (\d{2}:\d{2})–/)![1]!,
    slot: {
      branchId,
      roomId: line.match(/unidad dental ([0-9a-f-]{36})/i)![1]!,
      professionalUserId: line.match(/profesional ([^\]\s]+)/)![1]!,
      startsAt: line.match(ISO_INSTANT)![0],
      durationMin: 45,
    },
  }))
}

/** La dirección del enlace con la hora, con el token ya puesto como lo entrega el worker. */
function pickOf(sent: string): URL {
  const ref = PICK_LINK.exec(sent)?.[0]
  expect(ref, sent).toBeDefined()
  return new URL(resolvePersonalLinkRefs(ref!, KEY))
}

it("a quien aún no es paciente le da su enlace con la hora que eligió para dejar sus datos y reservar ahí; por el chat no registra a nadie (ADR 0109)", async () => {
  const seed = await ingestText("tg:nuevo-enlace-sede", "evt-nuevo-enlace-sede", "Hola")
  // La sede y el profesional del fixture; su paciente es de otra persona.
  const fx = await bookingFixture(seed.conversationId, "nuevo-enlace")
  const current = await withOrgContext(appDb, "org_a", (tx) => getPatientRegistrationConfig(tx, "org_a"))
  const saveRegistration = async (enabled: boolean, privacyNotice: string) => {
    const latest = await withOrgContext(appDb, "org_a", (tx) => getPatientRegistrationConfig(tx, "org_a"))
    await withOrgContext(appDb, "org_a", (tx) =>
      savePatientRegistrationConfig(tx, "org_a", fx.actorId, { expectedVersion: latest.version, enabled, fields: latest.fields, privacyNotice }))
  }
  // Las demás pruebas cuentan con el registro como estaba, pase lo que pase con esta.
  onTestFinished(() => saveRegistration(current.enabled, current.privacyNotice))
  const { conversationId } = await ingestText("tg:nuevo-enlace", "evt-nuevo-enlace", "Hola, quiero una cita")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  const contactId = conv!.contactId
  const ctx = publicCtx(conversationId, contactId)
  const [first] = await offeredSlots(ctx, fx.branchId)
  const book = () => makeAgentTools(ctx).find((t) => t.name === "reservar_paciente_nuevo")!.invoke(first!.slot).then(String)

  // Sin registro en línea, ni el chat ni un enlace lo registran: lo hace recepción.
  await saveRegistration(false, current.privacyNotice)
  expect(await book()).toContain("pasa el caso a recepción con request_human_handoff")

  // Con el registro encendido, su enlace con esa hora (el aviso se acepta en la página).
  await saveRegistration(true, "Usamos tus datos solo para atenderte.")
  const sent = await book()
  expect(sent).toContain("Todavía no se reservó nada")
  expect(sent).toContain("confirma tus datos aquí (1 minuto)")
  const url = pickOf(sent)
  expect(url.origin).toBe("https://norte.odentia.test")
  expect(url.pathname).toBe("/reserva")
  // Lo que lee la página para abrir la reserva ya elegida: la sede, el usuario del profesional y el inicio.
  expect(url.searchParams.get("sede")).toBe(fx.branchId)
  expect(url.searchParams.get("con")).toBe(fx.professionalId)
  expect(url.searchParams.get("hora")).toBe(new Date(first!.slot.startsAt).toISOString())
  expect(url.searchParams.get("token")).toMatch(/^[0-9a-f]{64}$/)
  // El enlace abre la reserva para alguien que aún no es paciente, en esa sede; nada quedó propuesto ni registrado.
  const links = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointmentBookingLink).where(eq(appointmentBookingLink.contactId, contactId)))
  expect(links).toMatchObject([{ booking: true, branchId: fx.branchId, patientId: null, conversationId }])
  expect(await withOrgContext(appDb, "org_a", (tx) => listProposals(tx, "org_a", { conversationId }))).toEqual([])
  const patients = await ownerDb.execute<{ n: number }>(sql`select count(*)::int as n from patient where person_id = ${contactId}`)
  expect(patients[0]?.n).toBe(0)

  // Con ese enlace ya dado en la atención, otra llamada con la misma hora no lo vuelve a armar (ronda del ADR 0109).
  ctx.pickLinks = [new Date(first!.slot.startsAt).toISOString()]
  expect(await book()).toContain("Ya le diste su enlace con esa hora en esta atención")
  ctx.pickLinks = []

  // Sale tal como lo escribe Sofi: un solo enlace (la agenda no se suma), con la referencia del token.
  ctx.evidence = [...(ctx.evidence ?? []), linksOf(sent)]
  ctx.toolsUsed.push("reservar_paciente_nuevo")
  const ref = PICK_LINK.exec(sent)![0]
  const outcome = String(await makeAgentTools(ctx).find((t) => t.name === "send_reply")!.invoke({
    text: `¡Perfecto! Para reservarte el lunes a las ${first!.clock} con Dentista nuevo-enlace, confirma tus datos aquí (1 minuto): ${ref}`,
  }))
  expect(outcome).not.toContain("No enviado")
  const [message] = await agentMessages(conversationId)
  expect(message).toContain(ref)
  expect(message!.match(/\/reserva\?/g)).toHaveLength(1)
  expect(message).not.toContain("La agenda completa")

  // Quien ya es paciente no se registra de nuevo: para ella, proponer_cita.
  const known = await ingestText("tg:nuevo-enlace-ya", "evt-nuevo-enlace-ya", "Quiero una cita")
  const fxKnown = await bookingFixture(known.conversationId, "nuevo-enlace-ya")
  const bookFor = (input: NonNullable<typeof first>["slot"] & { forOther?: boolean }) =>
    makeAgentTools(publicCtx(known.conversationId, fxKnown.contactId)).find((t) => t.name === "reservar_paciente_nuevo")!.invoke(input).then(String)
  const again = await bookFor(first!.slot)
  expect(again).toContain("Ya es paciente")
  expect(again).toContain("forOther")
  // Para su hijo, que aún no es paciente: el enlace para alguien nuevo, que no es el de ella.
  const forChild = await bookFor({ ...first!.slot, forOther: true })
  expect(forChild).toContain("confirma tus datos aquí (1 minuto)")
  const childToken = pickOf(forChild).searchParams.get("token")!
  const childLinks = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointmentBookingLink).where(and(eq(appointmentBookingLink.contactId, fxKnown.contactId), eq(appointmentBookingLink.newPerson, true))))
  expect(childLinks).toMatchObject([{ booking: true, patientId: null, newPerson: true }])
  // Abrirlo no lo une a su ficha: la página registra ahí a quien se atiende.
  const opened = await withOrgContext(appDb, "org_a", (tx) => resolvePersonalLink(tx, "org_a", childToken))
  expect(opened.patientId).toBeNull()
  expect(opened.canBook).toBe(true)
})

it("proponer_cita: si a la clínica le falta algo del paciente, su enlace con esa hora; si no, su sí en el chat; con una cita por venir, el sí y sus datos al confirmar (ADR 0109)", async () => {
  // Le faltan datos: la hora se reserva en su enlace, donde los confirma.
  const lacking = await ingestText("tg:faltan-datos", "evt-faltan-datos", "Quiero una cita")
  const fx = await bookingFixture(lacking.conversationId, "faltan", { complete: false })
  const ctx = publicCtx(lacking.conversationId, fx.contactId)
  const [first] = await offeredSlots(ctx, fx.branchId)
  // Sin la sede, la toma del hueco que se ofreció.
  const { branchId: _branch, ...withoutBranch } = first!.slot
  const sent = String(await makeAgentTools(ctx).find((t) => t.name === "proponer_cita")!.invoke({ patientId: fx.patientId, ...withoutBranch }))
  expect(sent).toContain("fecha de nacimiento")
  expect(sent).toContain("confirma tus datos aquí (1 minuto)")
  const url = pickOf(sent)
  expect(url.searchParams.get("sede")).toBe(fx.branchId)
  expect(url.searchParams.get("con")).toBe(fx.professionalId)
  expect(url.searchParams.get("hora")).toBe(new Date(first!.slot.startsAt).toISOString())
  expect(await withOrgContext(appDb, "org_a", (tx) => listProposals(tx, "org_a", { conversationId: lacking.conversationId }))).toEqual([])
  const [link] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointmentBookingLink).where(eq(appointmentBookingLink.contactId, fx.contactId)))
  expect(link).toMatchObject({ booking: true, patientId: fx.patientId, branchId: fx.branchId })

  // No le falta nada: se le reserva con su sí, como siempre.
  const complete = await ingestText("tg:datos-completos", "evt-datos-completos", "Quiero una cita")
  const fxComplete = await bookingFixture(complete.conversationId, "completos")
  const completeCtx = publicCtx(complete.conversationId, fxComplete.contactId)
  const [slotComplete] = await offeredSlots(completeCtx, fxComplete.branchId)
  const asked = String(await makeAgentTools(completeCtx).find((t) => t.name === "proponer_cita")!.invoke({ patientId: fxComplete.patientId, ...slotComplete!.slot }))
  expect(asked).toContain("Falta su sí")
  expect(asked).not.toContain("/reserva?")
  const proposals = await withOrgContext(appDb, "org_a", (tx) => listProposals(tx, "org_a", { conversationId: complete.conversationId, status: "propuesta" }))
  expect(proposals.map((item) => item.action)).toEqual(["reservar_cita"])

  // Tiene sus datos, pero la clínica escribió su aviso y aún no lo aceptó: también su enlace.
  const current = await withOrgContext(appDb, "org_a", (tx) => getPatientRegistrationConfig(tx, "org_a"))
  onTestFinished(async () => {
    const latest = await withOrgContext(appDb, "org_a", (tx) => getPatientRegistrationConfig(tx, "org_a"))
    await withOrgContext(appDb, "org_a", (tx) =>
      savePatientRegistrationConfig(tx, "org_a", fx.actorId, { expectedVersion: latest.version, enabled: current.enabled, fields: current.fields, privacyNotice: current.privacyNotice }))
  })
  await withOrgContext(appDb, "org_a", (tx) =>
    savePatientRegistrationConfig(tx, "org_a", fx.actorId, { expectedVersion: current.version, enabled: current.enabled, fields: current.fields, privacyNotice: "Usamos tus datos solo para atenderte." }))
  const notice = await ingestText("tg:sin-aviso", "evt-sin-aviso", "Quiero una cita")
  const fxNotice = await bookingFixture(notice.conversationId, "sin-aviso")
  const noticeCtx = publicCtx(notice.conversationId, fxNotice.contactId)
  const [slotNotice] = await offeredSlots(noticeCtx, fxNotice.branchId)
  const viaNotice = String(await makeAgentTools(noticeCtx).find((t) => t.name === "proponer_cita")!.invoke({ patientId: fxNotice.patientId, ...slotNotice!.slot }))
  expect(viaNotice).toContain("aceptar el aviso de privacidad")
  expect(viaNotice).toMatch(PICK_LINK)

  // Con una cita por venir su enlace le mostraría esa cita, no la reserva: la nueva va con su sí en el chat
  // y la confirmación lleva su enlace para completar lo que falta, sin «y tu salud».
  const booked = await ingestText("tg:con-cita", "evt-con-cita", "Quiero otra cita")
  const fxBooked = await bookingFixture(booked.conversationId, "con-cita", { complete: false })
  const bookedCtx = publicCtx(booked.conversationId, fxBooked.contactId)
  const slots = await offeredSlots(bookedCtx, fxBooked.branchId)
  const taken = slots[0]!.slot
  await withOrgContext(appDb, "org_a", (tx) =>
    createAppointment(tx, "org_a", fxBooked.actorId, {
      branchId: taken.branchId, patientId: fxBooked.patientId, professionalUserId: fxBooked.professionalId, roomId: taken.roomId, startsAt: taken.startsAt, durationMin: 45,
    }))
  const tools = makeAgentTools(bookedCtx)
  const proposed = String(await tools.find((t) => t.name === "proponer_cita")!.invoke({ patientId: fxBooked.patientId, ...slots.at(-1)!.slot }))
  expect(proposed).toContain("Falta su sí")
  const [pending] = await withOrgContext(appDb, "org_a", (tx) => listProposals(tx, "org_a", { conversationId: booked.conversationId, status: "propuesta" }))
  await ingestText("tg:con-cita", "evt-con-cita-si", "Sí, confirmo")
  // La dirección pública la configuran la API y el worker al arrancar.
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: ".odentia.test" })
  const confirmed = await (async () => {
    try {
      return String(await tools.find((t) => t.name === "confirmar_propuesta")!.invoke({ proposalId: pending!.id }))
    } finally {
      configurePublicLinks(null)
    }
  })()
  expect(confirmed).toContain("Confirmado y ejecutado")
  expect(confirmed).toMatch(/«Antes de venir, completa tus datos aquí \(toma 2 minutos\): https:\/\/norte\.odentia\.test\/reserva\?token=[0-9a-f]{64}»/)
  expect(confirmed).not.toContain("tu salud")
})

it("reprogramar_cita y cancelar_cita actúan sobre la cita real sin duplicar reserva ni pisar cambios ajenos", async () => {
  const [createdBranch] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede Agente Reprog", timezone: "America/Lima" })
    .returning({ id: branch.id })
  const branchId = createdBranch!.id
  const stamp = Date.now()
  const actorId = `agent-actor-reprog-${stamp}`
  const professionalId = `agent-professional-reprog-${stamp}`
  await ownerDb.insert(user).values([
    { id: actorId, name: "Actor Reprog", email: `actor-reprog-${stamp}@example.test` },
    { id: professionalId, name: "Dentista Reprog", email: `dentista-reprog-${stamp}@example.test` },
  ])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${actorId}`}, 'org_a', ${actorId}, 'owner', now()),
      (${`m-${professionalId}`}, 'org_a', ${professionalId}, 'clinician', now())`)
  const createdRoom = await withOrgContext(appDb, "org_a", (tx) =>
    createRoom(tx, "org_a", { branchId, name: "Unidad dental Reprog" }))
  const roomId = createdRoom!.id
  await withOrgContext(appDb, "org_a", (tx) =>
    setProfessionalSchedule(tx, "org_a", actorId, {
      branchId,
      professionalUserId: professionalId,
      rules: [1, 2, 3, 4, 5].flatMap((weekday) => [
        { weekday, startMin: 9 * 60, endMin: 13 * 60 },
      ]),
    }))
  const { conversationId } = await ingestText("tg:reprog-ctx", "evt-reprog-ctx", "Necesito cambiar mi cita")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  const contactId = conv!.contactId
  const patientNumber = await withOrgContext(appDb, "org_a", (tx) => nextPatientNumber(tx, "org_a"))
  const [createdPatient] = await insertTestPatients(ownerDb, { organizationId: "org_a", displayName: "Paciente Reprog Agente", patientNumber })
  const patientId = createdPatient!.id
  await withOrgContext(appDb, "org_a", (tx) =>
    setPatientContact(tx, "org_a", actorId, patientId, { contactId, relationship: "self", isPreferred: true }))
  // Fechas relativas a hoy: la regla de la cita propia exige una cita por
  // venir y a menos de 120 días. Lunes a jueves de la semana que viene o la
  // siguiente, 15:00 UTC (10:00 en Lima, dentro del horario de 9 a 13).
  const monday = new Date()
  monday.setUTCHours(15, 0, 0, 0)
  monday.setUTCDate(monday.getUTCDate() + 7 + ((8 - monday.getUTCDay()) % 7))
  const dayAt = (offset: number, hour = 15) => {
    const d = new Date(monday)
    d.setUTCDate(d.getUTCDate() + offset)
    d.setUTCHours(hour, 0, 0, 0)
    return d.toISOString().replace(".000Z", "Z")
  }
  const booked = await withOrgContext(appDb, "org_a", (tx) =>
    createAppointment(tx, "org_a", actorId, {
      patientId, professionalUserId: professionalId, roomId, branchId,
      startsAt: dayAt(0), durationMin: 45,
    }))
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId,
    triggerId: "trig-reprog-1", secretsKey: KEY, dryRun: false, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const tools = makeAgentTools(ctx)

  // Reprogramar (confirmar_usuario): propuesta → confirmación → agenda movida.
  const reprogram = tools.find((t) => t.name === "reprogramar_cita")!
  const proposed = String(await reprogram.invoke({
    appointmentId: booked.id, startsAt: dayAt(1, 16), expectedVersion: booked.version,
  }))
  // Mover se pregunta como mover, no con «¿Te la reservo?» (auditoría del ADR 0104).
  expect(proposed).toContain("pregúntale con naturalidad si se la cambias")
  const proposalId = /id ([0-9a-f-]{36})/.exec(proposed)?.[1]
  expect(proposalId).toBeTruthy()
  await ingestText("tg:reprog-ctx", "evt-reprog-si-1", "Sí, confirmo")
  const confirmed = String(await tools.find((t) => t.name === "confirmar_propuesta")!.invoke({ proposalId: proposalId! }))
  expect(confirmed).toContain("Confirmado y ejecutado")
  let rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointment).where(eq(appointment.patientId, patientId)))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.startsAt.toISOString()).toBe(dayAt(1, 16).replace("Z", ".000Z"))
  expect(rows[0]!.version).toBe(booked.version + 1)

  // Obsolescencia: si la cita cambió desde la propuesta, confirmar no ejecuta.
  ctx.triggerId = "trig-reprog-2"
  const staleProposal = String(await reprogram.invoke({
    appointmentId: booked.id, startsAt: dayAt(2), expectedVersion: booked.version + 1,
  }))
  const staleId = /id ([0-9a-f-]{36})/.exec(staleProposal)?.[1]
  expect(staleId).toBeTruthy()
  await ingestText("tg:reprog-ctx", "evt-reprog-si-2", "Si confirmo")
  await withOrgContext(appDb, "org_a", (tx) =>
    moveAppointment(tx, "org_a", actorId, booked.id, {
      expectedVersion: booked.version + 1, startsAt: dayAt(3),
    }))
  const staleConfirm = String(await tools.find((t) => t.name === "confirmar_propuesta")!.invoke({ proposalId: staleId! }))
  expect(staleConfirm).toContain("No se pudo ejecutar al confirmar")
  expect(staleConfirm).toContain("obsoleta")
  rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointment).where(eq(appointment.patientId, patientId)))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.startsAt.toISOString()).toBe(dayAt(3).replace("Z", ".000Z"))

  // Cancelar también lo confirma el paciente; reentregar el mismo trigger no
  // duplica la propuesta.
  ctx.triggerId = "trig-cancel-1"
  const cancel = tools.find((t) => t.name === "cancelar_cita")!
  const pendingMsg = String(await cancel.invoke({ appointmentId: booked.id }))
  expect(pendingMsg).toContain("Pregúntale con naturalidad si se la cancelas")
  const repeatedMsg = String(await cancel.invoke({ appointmentId: booked.id }))
  const cancelId = /id ([0-9a-f-]{36})/.exec(pendingMsg)?.[1]
  expect(cancelId).toBeTruthy()
  expect(repeatedMsg).toContain(cancelId!)
  const pendingCancels = await withOrgContext(appDb, "org_a", (tx) =>
    listProposals(tx, "org_a", { conversationId, status: "propuesta" }))
  expect(pendingCancels.filter((p) => p.action === "cancelar_cita")).toHaveLength(1)
  await ingestText("tg:reprog-ctx", "evt-cancel-si-1", "Sí")
  const confirmCancel = String(await tools.find((t) => t.name === "confirmar_propuesta")!.invoke({ proposalId: cancelId! }))
  expect(confirmCancel).toContain("Confirmado y ejecutado")
  rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointment).where(eq(appointment.patientId, patientId)))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.status).toBe("cancelada")

  // Cancelar una cita ya cancelada no produce efectos parciales.
  ctx.triggerId = "trig-cancel-2"
  const lateMsg = String(await cancel.invoke({ appointmentId: booked.id }))
  const lateId = /id ([0-9a-f-]{36})/.exec(lateMsg)?.[1]
  expect(lateId).toBeTruthy()
  await ingestText("tg:reprog-ctx", "evt-cancel-si-2", "Sí")
  const lateConfirm = String(await tools.find((t) => t.name === "confirmar_propuesta")!.invoke({ proposalId: lateId! }))
  expect(lateConfirm).toContain("No se pudo ejecutar al confirmar")
  expect(lateConfirm).toMatch(/obsoleta|cancelada/)
})

it("confirmar_cita confirma por escrito la cita de la persona, nunca la de otra, y deja la cita como fuente", async () => {
  const [createdBranch] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede Confirmar", timezone: "America/Lima" })
    .returning({ id: branch.id })
  const branchId = createdBranch!.id
  const stamp = Date.now()
  const actorId = `agent-actor-confirma-${stamp}`
  const professionalId = `agent-professional-confirma-${stamp}`
  await ownerDb.insert(user).values([
    { id: actorId, name: "Actor Confirma", email: `actor-confirma-${stamp}@example.test` },
    { id: professionalId, name: "Dra. Confirma", email: `dentista-confirma-${stamp}@example.test` },
  ])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${actorId}`}, 'org_a', ${actorId}, 'owner', now()),
      (${`m-${professionalId}`}, 'org_a', ${professionalId}, 'clinician', now())`)
  const room = await withOrgContext(appDb, "org_a", (tx) => createRoom(tx, "org_a", { branchId, name: "Unidad dental Confirma" }))
  const { conversationId } = await ingestText("tg:confirma-cita", "evt-confirma-cita", "Sí, ahí estaré")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  const contactId = conv!.contactId
  const own = async (name: string, contact: string | null) => {
    const patientNumber = await withOrgContext(appDb, "org_a", (tx) => nextPatientNumber(tx, "org_a"))
    const [row] = await insertTestPatients(ownerDb, { organizationId: "org_a", displayName: name, patientNumber })
    if (contact) {
      await withOrgContext(appDb, "org_a", (tx) =>
        setPatientContact(tx, "org_a", actorId, row!.id, { contactId: contact, relationship: "self", isPreferred: true }))
    }
    return row!.id
  }
  const mine = await own("Rosa Confirma", contactId)
  const someoneElse = await own("Otra Persona", null)
  const book = (patientId: string, inDays: number) =>
    withOrgContext(appDb, "org_a", (tx) =>
      createAppointment(tx, "org_a", actorId, {
        patientId, professionalUserId: professionalId, roomId: room!.id, branchId,
        startsAt: new Date(Date.now() + inDays * 86_400_000).toISOString(), durationMin: 30, outsideSchedule: true, notice: false,
      }))
  const booked = await book(mine, 3)
  const theirs = await book(someoneElse, 4)
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId,
    triggerId: "trig-confirma-1", secretsKey: KEY, dryRun: false, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const confirm = makeAgentTools(ctx).find((t) => t.name === "confirmar_cita")!
  // La de otra persona, nunca.
  expect(String(await confirm.invoke({ appointmentId: theirs.id }))).toContain("No se pudo confirmar")
  const said = String(await confirm.invoke({}))
  expect(said).toContain("Cita confirmada:\n- Rosa Confirma")
  expect(said).toContain("«¡Listo! Tu cita quedó confirmada. Te esperamos.»")
  expect(said).toContain("Sede Confirmar con Dra. Confirma")
  const statusOf = async (id: string) =>
    (await withOrgContext(appDb, "org_a", (tx) => tx.select({ status: appointment.status }).from(appointment).where(eq(appointment.id, id))))[0]?.status
  expect(await statusOf(booked.id)).toBe("confirmada")
  expect(await statusOf(theirs.id)).toBe("programada")
  expect(String(await confirm.invoke({}))).toContain("ya estaba confirmada")
  // Es fuente: la fecha que el agente repite se comprueba contra lo que devolvió.
  expect(TOOL_SOURCES["confirmar_cita"]).toMatchObject({ kind: "agenda" })
})

it("con una cita esperando el sí, otro acto guía a confirmar en vez de romper el turno", async () => {
  const { conversationId } = await ingestText("tg:doble-si", "evt-doble-si", "Quiero confirmar")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  expect(conv).toBeDefined()
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId: conv!.contactId,
    triggerId: null, secretsKey: KEY, dryRun: false, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const tools = makeAgentTools(ctx)
  // El agente solo conoce al profesional por su referencia: la de alguien con horario en la clínica.
  const { professionalId } = await bookingFixture(conversationId, "doble-si")
  // La cita propuesta espera el sí del interlocutor (los datos solo tienen que validar).
  const booked = String(await tools.find((t) => t.name === "proponer_cita")!.invoke({
    patientId: randomUUID(), professionalUserId: professionalRef("org_a", professionalId), roomId: randomUUID(),
    startsAt: "2026-11-02T15:00:00.000Z", branchId: randomUUID(), durationMin: 45,
  }))
  expect(booked).toContain("pregúntale con naturalidad si se la reservas")
  const before = await withOrgContext(appDb, "org_a", (tx) =>
    listOpportunities(tx, "org_a", { contactId: conv!.contactId }))
  const second = String(await tools.find((t) => t.name === "create_opportunity")!.invoke({ title: "Plan alternativo" }))
  expect(second).toContain("confirmar_propuesta")
  const pending = await withOrgContext(appDb, "org_a", (tx) =>
    listProposals(tx, "org_a", { conversationId, status: "propuesta" }))
  expect(pending.map((p) => p.action)).toEqual(["reservar_cita"])
  const after = await withOrgContext(appDb, "org_a", (tx) =>
    listOpportunities(tx, "org_a", { contactId: conv!.contactId }))
  expect(after.items.map((row) => row.id)).toEqual(before.items.map((row) => row.id))
})

it("si un paciente dice que se llama distinto, su ficha no cambia y recepción recibe una tarea para revisarla", async () => {
  const { conversationId } = await ingestText("tg:otro-nombre", "evt-otro-nombre", "Hola, te saluda Darvin")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  const contactId = conv!.contactId
  const actorId = `agent-actor-nombre-${Date.now()}`
  await ownerDb.insert(user).values({ id: actorId, name: "Recepción Nombre", email: `${actorId}@example.test` })
  await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values (${`m-${actorId}`}, 'org_a', ${actorId}, 'owner', now())`)
  const patientNumber = await withOrgContext(appDb, "org_a", (tx) => nextPatientNumber(tx, "org_a"))
  const [created] = await insertTestPatients(ownerDb, {
    organizationId: "org_a", displayName: "Paciente Prueba WhatsApp", givenNames: "Paciente", familyName: "Prueba WhatsApp", patientNumber,
  })
  await withOrgContext(appDb, "org_a", (tx) =>
    setPatientContact(tx, "org_a", actorId, created!.id, { contactId, relationship: "self", isPreferred: true }))
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId,
    triggerId: "trig-otro-nombre", secretsKey: KEY, dryRun: false, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const updateContactTool = makeAgentTools(ctx).find((t) => t.name === "update_contact")!
  const tasksOf = () => withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(and(eq(crmTask.organizationId, "org_a"), eq(crmTask.contactId, contactId))))

  // Lo que ya está en su ficha no avisa a nadie, aunque lo escriba sin tildes ni mayúsculas.
  expect(String(await updateContactTool.invoke({ givenNames: "paciente" }))).toContain("Úsalo tal como figura")
  expect(await tasksOf()).toEqual([])

  // Otro nombre: la ficha sigue igual y recepción recibe una sola tarea, aunque lo repita.
  const told = String(await updateContactTool.invoke({ givenNames: "Darvin" }))
  expect(told).toContain("quedó una tarea para que recepción la revise")
  expect(told).toContain("Háblale por el nombre que te dijo")
  await updateContactTool.invoke({ givenNames: "Darvin" })
  const tasks = await tasksOf()
  expect(tasks.map((task) => [task.title, task.area, task.patientId])).toEqual([["Revisar su nombre: Paciente Prueba WhatsApp", "recepcion", created!.id]])
  expect(tasks[0]!.reason).toContain("dijo llamarse «Darvin»")
  const [person] = await withOrgContext(appDb, "org_a", (tx) => tx.select().from(contact).where(eq(contact.id, contactId)))
  expect(person).toMatchObject({ displayName: "Paciente Prueba WhatsApp", givenNames: "Paciente" })
  // En los turnos siguientes se le sigue llamando como dijo, mientras recepción no revise su ficha.
  expect(await withOrgContext(appDb, "org_a", (tx) => pendingSpokenName(tx, "org_a", contactId))).toBe("Darvin")
  await ownerDb.update(crmTask).set({ status: "done" }).where(eq(crmTask.id, tasks[0]!.id))
  expect(await withOrgContext(appDb, "org_a", (tx) => pendingSpokenName(tx, "org_a", contactId))).toBeNull()

  // La simulación responde lo que respondería de verdad, sin dejar otra tarea ni tocar la ficha.
  const simulated = makeAgentTools({ ...ctx, dryRun: true }).find((t) => t.name === "update_contact")!
  expect(String(await simulated.invoke({ givenNames: "paciente" }))).toContain("Úsalo tal como figura")
  expect(String(await simulated.invoke({ givenNames: "Marcos" }))).toContain("[SIMULACIÓN] Es paciente y su ficha dice otro nombre")
  expect(await tasksOf()).toHaveLength(1)
})

it("update_contact guarda el apellido de quien ya dijo sus nombres y, si faltan, dice que los pida", async () => {
  const { conversationId } = await ingestText("tg:apellido", "evt-apellido", "Hola")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  const contactId = conv!.contactId
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId,
    triggerId: "trig-apellido", secretsKey: KEY, dryRun: false, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const tool = makeAgentTools(ctx).find((t) => t.name === "update_contact")!
  const simulated = makeAgentTools({ ...ctx, dryRun: true }).find((t) => t.name === "update_contact")!
  const person = async () => {
    const [row] = await withOrgContext(appDb, "org_a", (tx) => tx.select().from(contact).where(eq(contact.id, contactId)))
    return row!
  }
  const setNames = (names: { displayName: string; givenNames: string | null; familyName: string | null }) =>
    ownerDb.update(contact).set(names).where(eq(contact.id, contactId))

  // Sin nombre no se guarda nada, tampoco en la simulación.
  await setNames({ displayName: "Anita", givenNames: null, familyName: null })
  expect(String(await tool.invoke({}))).toContain("No se guardó nada")
  expect(String(await simulated.invoke({}))).toContain("No se guardó nada")

  // Sin sus nombres, el apellido no se guarda (la regla de la ficha) y lo dice: nada de fingir que se guardó.
  for (const said of [{ familyName: "Quispe" }, { displayName: "Ana Quispe", familyName: "Quispe" }]) {
    expect(String(await tool.invoke(said))).toContain("sus apellidos se guardan junto con sus nombres")
    expect(String(await simulated.invoke(said))).toContain("sus apellidos se guardan junto con sus nombres")
  }
  expect(await person()).toMatchObject({ displayName: "Anita", givenNames: null, familyName: null })

  // Con sus nombres guardados, la simulación dice lo que haría sin cambiar nada, y el apellido los completa.
  await setNames({ displayName: "Carla", givenNames: "Carla", familyName: null })
  expect(String(await simulated.invoke({ familyName: "Quispe" }))).toContain("[SIMULACIÓN] Se actualizaría")
  expect(await person()).toMatchObject({ displayName: "Carla", familyName: null })
  expect(String(await tool.invoke({ familyName: "Quispe" }))).toBe("Contacto actualizado.")
  expect(await person()).toMatchObject({ displayName: "Carla Quispe", givenNames: "Carla", familyName: "Quispe" })

  // El nombre visible con el apellido aparte: se guardan los dos.
  await setNames({ displayName: "Ana", givenNames: "Ana", familyName: null })
  expect(String(await tool.invoke({ displayName: "Ana Rojas", familyName: "Rojas" }))).toBe("Contacto actualizado.")
  expect(await person()).toMatchObject({ displayName: "Ana Rojas", familyName: "Rojas" })

  // Lo de siempre sigue igual.
  await setNames({ displayName: "Luz", givenNames: null, familyName: null })
  await tool.invoke({ givenNames: "Luz María", familyName: "Paz" })
  expect(await person()).toMatchObject({ displayName: "Luz María Paz", givenNames: "Luz María", familyName: "Paz" })
})

it("create_task no duplica en reentrega y las escrituras directas auditan su origen agente", async () => {
  const { conversationId } = await ingestText("tg:direct-writes", "evt-dw-1", "Recuérdame llamar")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  const contactId = conv!.contactId
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId,
    triggerId: "trig-dw-1", secretsKey: KEY, dryRun: false, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const tools = makeAgentTools(ctx)
  const createTaskTool = tools.find((t) => t.name === "create_task")!
  // Reentrega del mismo trigger con el mismo payload: misma tarea, sin duplicar.
  const first = String(await createTaskTool.invoke({ title: "Llamar al paciente" }))
  const second = String(await createTaskTool.invoke({ title: "Llamar al paciente" }))
  expect(second).toBe(first)
  const tasks = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(and(eq(crmTask.organizationId, "org_a"), eq(crmTask.conversationId, conversationId))))
  expect(tasks).toHaveLength(1)
  await tools.find((t) => t.name === "add_tags")!.invoke({ tags: ["interesado-limpieza"] })
  await tools.find((t) => t.name === "update_contact")!.invoke({ displayName: "Ana Actualizada" })
  const audits = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(auditEvent).where(eq(auditEvent.organizationId, "org_a")))
  const taskAudit = audits.find((a) => a.action === "task.created" && a.entityId === tasks[0]!.id)
  expect((taskAudit?.metadata as Record<string, unknown> | null)?.createdBy).toBe("agent")
  expect(taskAudit?.actorUserId).toBeNull()
  const contactAudits = audits.filter((a) => a.action === "contact.updated" && a.entityId === contactId)
  expect(contactAudits.length).toBeGreaterThanOrEqual(2)
  for (const audit of contactAudits) {
    expect((audit.metadata as Record<string, unknown> | null)?.origin).toBe("agent")
  }
  // En simulación no escribe nada.
  const dryCtx: AgentToolCtx = { ...ctx, dryRun: true, triggerId: "trig-dw-dry" }
  const dry = String(await makeAgentTools(dryCtx).find((t) => t.name === "create_task")!.invoke({ title: "No debe persistir" }))
  expect(dry).toContain("SIMULACIÓN")
  const afterDry = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(and(eq(crmTask.organizationId, "org_a"), eq(crmTask.conversationId, conversationId))))
  expect(afterDry).toHaveLength(1)
})

it("la derivación tiene plazo, toma atómica de la cola y, al vencer, no llena la campana", async () => {
  const stamp = Date.now()
  const ownerId = `ho-owner-${stamp}`
  const recepId = `ho-recep-${stamp}`
  await ownerDb.insert(user).values([
    { id: ownerId, name: "Dueña Handoff", email: `ho-owner-${stamp}@example.test` },
    { id: recepId, name: "Recepción Handoff", email: `ho-recep-${stamp}@example.test` },
  ])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${ownerId}`}, 'org_a', ${ownerId}, 'owner', now()),
      (${`m-${recepId}`}, 'org_a', ${recepId}, 'reception', now())`)
  const { conversationId } = await ingestText("tg:handoff-sla", "evt-ho-1", "Quiero hablar con una persona")
  const handoff = await withOrgContext(appDb, "org_a", (tx) =>
    createHandoff(tx, "org_a", null, {
      conversationId,
      reason: "El interlocutor pidió una persona",
      summary: "Pide atención humana sin más detalle.",
      priority: "alta",
      createdBy: "agent",
    }))
  // Sin responsable queda en la cola, con plazo visible según prioridad (alta ≈ 4h).
  expect(handoff.assigneeUserId).toBeNull()
  expect(handoff.dueAt).toBeTruthy()
  const dueInMs = Date.parse(handoff.dueAt!) - Date.now()
  expect(dueInMs).toBeGreaterThan(3 * 3_600_000)
  expect(dueInMs).toBeLessThan(5 * 3_600_000)

  // Dos miembros toman el caso a la vez: uno gana, el otro recibe 409.
  const [firstTry, secondTry] = await Promise.allSettled([
    withOrgContext(appDb, "org_a", (tx) => claimHandoff(tx, "org_a", ownerId, handoff.id)),
    withOrgContext(appDb, "org_a", (tx) => claimHandoff(tx, "org_a", recepId, handoff.id)),
  ])
  const winner = firstTry.status === "fulfilled" ? ownerId : recepId
  const loser = firstTry.status === "fulfilled" ? secondTry : firstTry
  expect(loser.status).toBe("rejected")
  expect(String((loser as PromiseRejectedResult).reason)).toContain("Otra persona ya tomó este tema")
  // La tarea vinculada pasa al mismo responsable.
  const [claimedTask] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(eq(crmTask.id, handoff.taskId!)))
  expect(claimedTask!.assigneeUserId).toBe(winner)
  // Reclamar de nuevo el mismo usuario es idempotente.
  const again = await withOrgContext(appDb, "org_a", (tx) => claimHandoff(tx, "org_a", winner, handoff.id))
  expect(again.assigneeUserId).toBe(winner)

  // Vencido sigue en «Te espera» con su urgencia; la campana no avisa ni al crearlo ni al vencer.
  await ownerDb.execute(sql`update "task" set due_at = now() - interval '1 hour' where id = ${handoff.taskId!}`)
  await withOrgContext(appDb, "org_a", (tx) => listHandoffs(tx, "org_a", {}))
  const caseNotifs = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(workspaceNotification).where(sql`dedupe_key like ${`agent-handoff%:${handoff.id}:%`}`))
  expect(caseNotifs).toHaveLength(0)

  // La resolución registra actor y no reactiva el agente.
  await withOrgContext(appDb, "org_a", (tx) =>
    updateTask(tx, "org_a", handoff.taskId!, { status: "done", actorUserId: winner }))
  const [resolved] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(eq(crmTask.id, handoff.taskId!)))
  expect(resolved!.status).toBe("done")
  // Completar el tema no cierra la conversación (ADR 0050): el agente sigue con lo demás.
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ agentStatus: conversation.agentStatus, status: conversation.status })
      .from(conversation).where(eq(conversation.id, conversationId)))
  expect(conv).toMatchObject({ status: "open", agentStatus: "on" })
})

/** Sede con unidad dental, horario y un paciente vinculado al interlocutor del hilo: lo mínimo para reservar. */
/**
 * Sede, profesional con horario y un paciente vinculado como «self» a la persona de la conversación.
 * Con `complete` (lo de siempre) el paciente tiene todo lo que la clínica pide: con su sí se le
 * reserva en el chat. Sin él le faltan sus nombres, su fecha y cómo contactarlo (ADR 0109).
 */
async function bookingFixture(conversationId: string, label: string, options: { complete?: boolean } = {}) {
  const [createdBranch] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${label}`, timezone: "America/Lima" })
    .returning({ id: branch.id })
  const branchId = createdBranch!.id
  const stamp = Date.now()
  const actorId = `actor-${label}-${stamp}`
  const professionalId = `dentista-${label}-${stamp}`
  await ownerDb.insert(user).values([
    { id: actorId, name: `Actor ${label}`, email: `actor-${label}-${stamp}@example.test` },
    { id: professionalId, name: `Dentista ${label}`, email: `dentista-${label}-${stamp}@example.test` },
  ])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${actorId}`}, 'org_a', ${actorId}, 'owner', now()),
      (${`m-${professionalId}`}, 'org_a', ${professionalId}, 'clinician', now())`)
  const room = await withOrgContext(appDb, "org_a", (tx) => createRoom(tx, "org_a", { branchId, name: `Unidad dental ${label}` }))
  await withOrgContext(appDb, "org_a", (tx) =>
    setProfessionalSchedule(tx, "org_a", actorId, {
      branchId,
      professionalUserId: professionalId,
      rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
    }))
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  const contactId = conv!.contactId
  const patientNumber = await withOrgContext(appDb, "org_a", (tx) => nextPatientNumber(tx, "org_a"))
  const complete = options.complete !== false
  const [createdPatient] = await insertTestPatients(ownerDb, {
    organizationId: "org_a",
    displayName: `Paciente ${label}`,
    patientNumber,
    ...(complete ? { givenNames: "Paciente", familyName: label, birthDate: "1990-04-12", email: `paciente-${label}-${stamp}@example.test` } : {}),
  })
  const patientId = createdPatient!.id
  await withOrgContext(appDb, "org_a", (tx) =>
    setPatientContact(tx, "org_a", actorId, patientId, { contactId, relationship: "self", isPreferred: true }))
  return { branchId, roomId: room!.id, professionalId, actorId, patientId, contactId }
}

/** Próximo lunes con al menos tres días de margen, a medianoche de Lima. */
function upcomingMonday(): Date {
  const day = new Date(Date.now() + 3 * 86_400_000)
  day.setUTCHours(5, 0, 0, 0)
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1)
  return day
}

const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/

it("el sí del interlocutor en el turno siguiente ejecuta la reserva propuesta, sin volver a buscar", async () => {
  const first = await ingestText("tg:dos-turnos", "evt-dos-turnos-1", "Quiero una cita")
  const { conversationId } = first
  const fx = await bookingFixture(conversationId, "dos-turnos")
  const day = upcomingMonday()
  const turnOne = new ScriptedModel((messages, call) => {
    if (call === 1) {
      return toolCall(
        "buscar_huecos",
        { branchId: fx.branchId, from: day.toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString(), durationMin: 45 },
        "t1-huecos",
      )
    }
    if (call === 2) {
      const line = String(messages[messages.length - 1]?.content ?? "").split("\n")[1] ?? ""
      return toolCall(
        "proponer_cita",
        {
          patientId: fx.patientId,
          professionalUserId: line.match(/profesional ([^\]\s]+)/)?.[1],
          roomId: line.match(/unidad dental ([0-9a-f-]{36})/i)?.[1],
          startsAt: line.match(ISO_INSTANT)?.[0],
          branchId: fx.branchId,
          durationMin: 45,
        },
        "t1-propuesta",
      )
    }
    if (call === 3) {
      return toolCall("anotar_caso", { nota: "La cita es para Paciente dos-turnos; prefiere las mañanas." }, "t1-nota")
    }
    return toolCall("send_reply", { text: "Tengo un espacio el lunes a las 9:00 a. m. ¿Confirmas la cita?" }, "t1-envio")
  })
  expect(await runScripted(turnOne, conversationId, first.messageId)).toBe("done")
  const pending = await withOrgContext(appDb, "org_a", (tx) =>
    listProposals(tx, "org_a", { conversationId, status: "propuesta" }))
  expect(pending.map((p) => p.action)).toEqual(["reservar_cita"])

  const second = await ingestText("tg:dos-turnos", "evt-dos-turnos-2", "Sí")
  // El modelo del segundo turno solo sabe lo que recibe: confirma si el id de
  // la propuesta pendiente está a la vista; si no, solo puede volver a preguntar.
  const turnTwo = new ScriptedModel((messages, call) => {
    if (call > 1) return toolCall("send_reply", { text: "Listo, tu cita quedó reservada." }, "t2-envio")
    const visible = messages.map((m) => String(m.content)).join("\n")
    const proposalId = /propuesta[^\n]*\bid ([0-9a-f-]{36})/i.exec(visible)?.[1]
    return proposalId
      ? toolCall("confirmar_propuesta", { proposalId }, "t2-confirma")
      : toolCall("send_reply", { text: "¿Me confirmas la cita, por favor?" }, "t2-repregunta")
  })
  // Aunque el modelo de decisión lea ese «Sí» como un saludo, con una propuesta
  // por confirmar el turno recibe todas las herramientas: sin confirmar_propuesta
  // a la vista, el sí se perdería.
  const greeting: DecisionModel = {
    provider: "fake",
    reportsProbabilities: true,
    decide: async (_state, questions) => ({
      answers: questions.map((q): Awaited<ReturnType<DecisionModel["decide"]>>["answers"][number] =>
        q.kind === "yesno"
          ? { id: q.id, kind: "yesno", probability: 0.02 }
          : q.kind === "choice"
            ? q.id === "intent"
              ? { id: q.id, kind: "choice", choice: "greeting_or_thanks", probabilities: { greeting_or_thanks: 0.95 }, confidence: 0.9 }
              : { id: q.id, kind: "choice", choice: "none", probabilities: { none: 0.95 }, confidence: 0.9 }
            : { id: q.id, kind: "score", score: 0, probabilities: null, confidence: null }),
      model: "guion",
      usage: null,
      latencyMs: 1,
    }),
  }
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "baseline" }))
  try {
    expect(await processAgentRun(appDb, { ...runtime, createModel: async () => turnTwo, createDecisionModel: () => greeting }, {
      msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId: second.messageId },
    })).toBe("done")
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "none" }))
  }
  // Ese «Sí» responde a «¿Confirmas la cita?»: no es un saludo y no recibe
  // «responde breve, sin consultar nada» (ADR 0104); va por el camino abierto.
  expect(systemTextOf(turnTwo.seen[0] ?? [])).not.toContain("Camino para este mensaje")
  expect(turnTwo.offered[0]).toContain("confirmar_propuesta")
  expect(turnTwo.offered[0]).not.toContain("ampliar_herramientas")
  // El segundo turno recibió lo que dejó el primero: la nota, la consulta de
  // agenda y cuándo escribió el interlocutor.
  const seen = turnTwo.seen[0] ?? []
  const system = systemTextOf(seen)
  expect(system).toContain("Propuesta pendiente de que el interlocutor confirme: Reservar cita")
  expect(system).toContain("- La cita es para Paciente dos-turnos; prefiere las mañanas.")
  expect(system).toContain("[buscar_huecos · ")
  // Lo último que dijo es el «Sí»; después solo va lo del turno.
  expect(String(seen[seen.length - 2]?.content)).toMatch(/^\[[^\]]+\] Sí$/)
  expect(seen[seen.length - 1]?.getType()).toBe("system")
  const booked = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ status: appointment.status }).from(appointment).where(eq(appointment.patientId, fx.patientId)))
  expect(booked).toEqual([{ status: "confirmada" }])
  const runs = await ledgerRows(conversationId)
  expect(runs[runs.length - 1]?.toolsUsed).toEqual(["confirmar_propuesta", "send_reply"])
  expect(await agentMessages(conversationId)).toContain("Listo, tu cita quedó reservada.")
  // Lo hecho queda en el estado del caso y cada respuesta dice en qué se basó.
  const state = await withOrgContext(appDb, "org_a", (tx) => getAgentCaseState(tx, "org_a", conversationId))
  expect(state.pending).toEqual([])
  expect(state.recent.map((item) => `${item.action}:${item.status}`)).toEqual(["reservar_cita:ejecutada"])
  const traces = await withOrgContext(appDb, "org_a", (tx) => listAnswerTraces(tx, "org_a", conversationId))
  expect(traces.map((trace) => trace.outcome)).toEqual(["enviada", "enviada"])
  const offered = traces[1]!
  expect(offered.basis).toEqual([{ kind: "agenda", label: "Agenda: horarios disponibles", detail: expect.stringMatching(/horarios?$/) }])
  expect(offered.checks).toEqual([{ kind: "hora", value: "9:00 a. m.", ok: true, source: "Agenda: horarios disponibles" }])
  expect(offered.messageId).toBeTruthy()
})

it("dos búsquedas de huecos en un turno se recuerdan juntas y una hora que no salió de ellas no se propone", async () => {
  const first = await ingestText("tg:dos-busquedas", "evt-dos-busquedas-1", "Quiero una cita el lunes o el martes")
  const { conversationId } = first
  const fx = await bookingFixture(conversationId, "dos-busquedas")
  const monday = upcomingMonday()
  const tuesday = new Date(monday.getTime() + 86_400_000)
  const search = (day: Date, id: string) =>
    toolCall("buscar_huecos", { branchId: fx.branchId, from: day.toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString(), durationMin: 45 }, id)
  const turnOne = new ScriptedModel((_messages, call) => {
    if (call === 1) return search(monday, "b1-lunes")
    if (call === 2) return search(tuesday, "b1-martes")
    return toolCall("send_reply", { text: "Tengo el lunes y el martes a las 9:00 a. m. ¿Cuál prefieres?" }, "b1-envio")
  })
  expect(await runScripted(turnOne, conversationId, first.messageId)).toBe("done")
  const remembered = await withOrgContext(appDb, "org_a", (tx) => getAgentCaseState(tx, "org_a", conversationId))
  const slots = remembered.lookups.find((item) => item.tool === "buscar_huecos")?.text ?? ""
  // La segunda búsqueda no borró la primera: los dos días ofrecidos siguen a la vista.
  expect(slots.match(new RegExp(ISO_INSTANT.source, "g"))?.map((iso) => new Date(iso).getUTCDay())).toEqual(expect.arrayContaining([1, 2]))

  // En el turno siguiente, una hora que no venía de ningún hueco (las 2:00 p. m.) no se propone.
  const second = await ingestText("tg:dos-busquedas", "evt-dos-busquedas-2", "Ok, el lunes")
  const invented = new Date(monday.getTime() + 14 * 3_600_000).toISOString()
  const line = slots.split("\n").find((item) => item.includes("startsAt")) ?? ""
  const turnTwo = new ScriptedModel((messages, call) => {
    if (call === 1) {
      return toolCall(
        "proponer_cita",
        {
          patientId: fx.patientId,
          professionalUserId: line.match(/profesional ([^\]\s]+)/)?.[1],
          roomId: line.match(/unidad dental ([0-9a-f-]{36})/i)?.[1],
          startsAt: invented,
          branchId: fx.branchId,
          durationMin: 45,
        },
        "b2-inventada",
      )
    }
    if (call === 2) {
      expect(String(messages[messages.length - 1]?.content)).toContain("Ese horario no está entre los huecos que consultaste")
    }
    return toolCall("send_reply", { text: "¿A qué hora del lunes te acomoda?" }, "b2-envio")
  })
  expect(await runScripted(turnTwo, conversationId, second.messageId)).toBe("done")
  expect(turnTwo.seen).toHaveLength(2)
  const proposals = await withOrgContext(appDb, "org_a", (tx) => listProposals(tx, "org_a", { conversationId }))
  expect(proposals.filter((item) => item.action === "reservar_cita")).toEqual([])
})

it("una respuesta con un precio que no está en lo consultado no sale y, a la segunda, el caso pasa a una persona", async () => {
  // Las cifras de un identificador no sustentan un precio: la referencia de
  // este profesional llega en los datos de la clínica y lleva el mismo «99»
  // del precio inventado. Con los profesionales de otras pruebas (ids con
  // Date.now) pasaba lo mismo a veces y la respuesta salía.
  const professionalId = "dentista-precio-185"
  expect(professionalRef("org_a", professionalId)).toBe("pro-99d040905f")
  const [sede] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede Precio", timezone: "America/Lima" })
    .returning({ id: branch.id })
  await ownerDb.insert(user).values({ id: professionalId, name: "Dentista Precio", email: `${professionalId}@example.test` })
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${professionalId}`}, 'org_a', ${professionalId}, 'clinician', now())`)
  const schedule = (weekdays: number[]) =>
    withOrgContext(appDb, "org_a", (tx) =>
      setProfessionalSchedule(tx, "org_a", professionalId, {
        branchId: sede!.id,
        professionalUserId: professionalId,
        rules: weekdays.map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
      }))
  await schedule([1, 2, 3, 4, 5])
  try {
    const { conversationId, messageId } = await ingestText("tg:precio-inventado", "evt-precio-1", "¿Cuánto cuesta la limpieza?")
    const model = new ScriptedModel((_messages, call) => toolCall("send_reply", { text: "La limpieza cuesta S/ 99." }, `envio-${call}`))
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    expect(systemTextOf(model.seen[0] ?? [])).toContain("pro-99d040905f")
    // Dos intentos: el primero vuelve al modelo con el dato que falta; el segundo deriva.
    expect(model.seen).toHaveLength(2)
    const feedback = String(model.seen[1]?.[model.seen[1].length - 1]?.content)
    expect(feedback).toContain("No enviado: precio «S/ 99»")
    expect(await agentMessages(conversationId)).toEqual([HANDOFF_NOTICE])  // Derivar siempre avisa (ADR 0024).
    expect(await agentStatusOf(conversationId)).toBe("on")
    expect((await ledgerRows(conversationId)).map((r) => r.status)).toEqual(["handoff"])
    const traces = await withOrgContext(appDb, "org_a", (tx) => listAnswerTraces(tx, "org_a", conversationId))
    expect(traces.map((trace) => trace.outcome)).toEqual(["bloqueada", "bloqueada"])
    expect(traces[0]?.checks).toEqual([{ kind: "precio", value: "S/ 99", ok: false, source: null }])
    expect(traces[0]?.messageId).toBeNull()
    const [handoff] = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ reason: agentHandoff.reason, summary: agentHandoff.summary }).from(agentHandoff)
        .where(eq(agentHandoff.conversationId, conversationId)))
    expect(handoff?.reason).toBe("El agente no pudo sustentar un dato de su respuesta")
    expect(handoff?.summary).toContain("S/ 99")
  } finally {
    await schedule([])
  }
})

it("un precio de una respuesta oficial sale y deja constancia de en qué se basó", async () => {
  const entry = await withOrgContext(appDb, "org_a", (tx) =>
    createKnowledgeEntry(tx, "org_a", null, { kind: "faq", title: "Precio de la profilaxis", body: "La profilaxis cuesta S/ 135.00." }))
  await withOrgContext(appDb, "org_a", (tx) => setKnowledgeStatus(tx, "org_a", null, entry.id, "publicada"))
  try {
    const { conversationId, messageId } = await ingestText("tg:precio-oficial", "evt-precio-2", "¿Cuánto cuesta la profilaxis?")
    const model = new ScriptedModel((_messages, call) =>
      call === 1
        ? toolCall("consultar_conocimiento", { pregunta: "profilaxis" }, "busca")
        : toolCall("send_reply", { text: "La profilaxis cuesta S/ 135." }, "envia"))
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    expect(await agentMessages(conversationId)).toEqual(["La profilaxis cuesta S/ 135."])
    const [trace] = await withOrgContext(appDb, "org_a", (tx) => listAnswerTraces(tx, "org_a", conversationId))
    expect(trace?.outcome).toBe("enviada")
    expect(trace?.basis).toContainEqual({
      kind: "conocimiento",
      label: "Respuestas oficiales de la clínica",
      detail: "Precio de la profilaxis",
    })
    expect(trace?.checks).toEqual([
      { kind: "precio", value: "S/ 135", ok: true, source: expect.stringContaining("clínica") },
    ])
    expect(trace?.model).toBe("fake")
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => setKnowledgeStatus(tx, "org_a", null, entry.id, "borrador"))
  }
})

it("con la comprobación apagada la respuesta sale sin revisar y la traza no afirma ninguna comprobación", async () => {
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { replyCheckEnabled: false }))
  try {
    const { conversationId, messageId } = await ingestText("tg:sin-comprobar", "evt-precio-3", "¿Cuánto cuesta?")
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Cuesta S/ 77." }, "envia"))
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    expect(await agentMessages(conversationId)).toEqual(["Cuesta S/ 77."])
    const [trace] = await withOrgContext(appDb, "org_a", (tx) => listAnswerTraces(tx, "org_a", conversationId))
    expect(trace?.outcome).toBe("enviada")
    expect(trace?.checks).toEqual([])
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { replyCheckEnabled: true }))
  }
})

it("Sofi ve la atención entera: lo que dijo al empezar sigue a la vista aunque escriba en muchos pedazos (ADR 0104)", async () => {
  const first = await ingestText("tg:atencion-entera", "evt-entera-0", "Hola, soy Carla Ríos y quiero una limpieza para mi hija Ana")
  for (let i = 1; i <= 29; i++) await ingestText("tg:atencion-entera", `evt-entera-${i}`, `pedazo ${i}`)
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, first.conversationId)))
  const toolCtx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId: first.conversationId, contactId: conv!.contactId,
    triggerId: null, secretsKey: KEY, dryRun: true, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(), draftText: "¿y para cuándo hay?",
  }
  const model = new ScriptedModel((_messages, call) => toolCall("send_reply", { text: "Te busco horarios, Carla." }, `envia-${call}`))
  await compileAgentGraph(model, toolCtx).invoke({ messages: [], turnCount: 0 })
  const seen = model.seen[0] ?? []
  // Con 20 mensajes de ventana, a los 30 pedazos el primero ya no se veía y volvía a pedir el nombre.
  expect(seen.filter((m) => m.getType() === "human").map((m) => String(m.content)).join("\n")).toContain("soy Carla Ríos y quiero una limpieza para mi hija Ana")
  expect(seen.filter((m) => m.getType() === "human")).toHaveLength(31)
  expect(systemTextOf(seen)).not.toContain("De esta atención no ves")
})

it("una atención que no cabe entera avisa de lo que no ve, conserva cómo empezó y la simulación comprueba sin dejar rastro", async () => {
  // Pedazos largos: la atención pasa del tope de lo que lee el modelo.
  const long = (i: number) => `mensaje ${i} ${"con muchos detalles de lo que necesita y de sus horarios ".repeat(25)}`
  const first = await ingestText("tg:hilo-largo", "evt-largo-0", long(0))
  for (let i = 1; i <= 22; i++) await ingestText("tg:hilo-largo", `evt-largo-${i}`, long(i))
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, first.conversationId)))
  const toolCtx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId: first.conversationId, contactId: conv!.contactId,
    triggerId: null, secretsKey: KEY, dryRun: true, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(), draftText: "¿y cuánto cuesta?",
  }
  const model = new ScriptedModel((_messages, call) =>
    call === 1
      ? toolCall("anotar_caso", { nota: "Pregunta por precios." }, "nota")
      : toolCall("send_reply", { text: "Cuesta S/ 61." }, `envia-${call}`))
  await compileAgentGraph(model, toolCtx).invoke({ messages: [], turnCount: 0 })
  expect(systemTextOf(model.seen[0] ?? [])).toMatch(/De esta atención no ves \d+ de sus 23 mensajes, los del medio/)
  const read = (model.seen[0] ?? []).filter((m) => m.getType() === "human").map((m) => String(m.content)).join("\n")
  expect(read).toContain("mensaje 0 ")
  expect(read).toContain("mensaje 22 ")
  expect(read).not.toContain("mensaje 10 ")
  expect(toolCtx.lastChecks).toEqual([{ kind: "precio", value: "S/ 61", ok: false, source: null }])
  expect(toolCtx.handedOff).toBe(true)
  // Simulación: ni nota, ni traza, ni derivación real.
  const state = await withOrgContext(appDb, "org_a", (tx) => getAgentCaseState(tx, "org_a", first.conversationId))
  expect(state.notes).toEqual([])
  expect(await withOrgContext(appDb, "org_a", (tx) => listAnswerTraces(tx, "org_a", first.conversationId))).toEqual([])
  expect(await agentStatusOf(first.conversationId)).toBe("on")
})

async function publishKnowledge(input: { title: string; body: string; validUntil?: string; askForms?: string[] }) {
  const entry = await withOrgContext(appDb, "org_a", (tx) => createKnowledgeEntry(tx, "org_a", null, { kind: "faq", ...input }))
  await withOrgContext(appDb, "org_a", (tx) => setKnowledgeStatus(tx, "org_a", null, entry.id, "publicada"))
  return entry.id
}

async function unpublishKnowledge(ids: string[]) {
  for (const id of ids) await withOrgContext(appDb, "org_a", (tx) => setKnowledgeStatus(tx, "org_a", null, id, "borrador"))
}

it("el agente recibe todas las respuestas vigentes, no la vencida, y anota lo que no supo responder", async () => {
  const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(Date.now() - 86_400_000))
  const ids: string[] = []
  for (let i = 1; i <= 14; i++) ids.push(await publishKnowledge({ title: `Tema completo ${i}`, body: `Respuesta completa ${i}.` }))
  ids.push(await publishKnowledge({ title: "Promoción vencida", body: "Dos limpiezas por una.", validUntil: yesterday }))
  try {
    const question = "¿Tienen estacionamiento para motos?"
    const { conversationId, messageId } = await ingestText("tg:conoc-todo", "evt-conoc-1", question)
    let found = ""
    const model = new ScriptedModel((messages, call) => {
      if (call === 1) return toolCall("consultar_conocimiento", { pregunta: "Promoción vencida" }, "busca-vencida")
      if (call === 2) {
        found = String(messages[messages.length - 1]?.content)
        return toolCall("consultar_conocimiento", { pregunta: "estacionamiento motos" }, "busca-motos")
      }
      return toolCall("send_reply", { text: "No tengo ese dato; lo consulto con el equipo." }, "envia")
    })
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    const system = systemTextOf(model.seen[0] ?? [])
    // Las catorce, no solo las diez más recientes.
    for (let i = 1; i <= 14; i++) expect(system).toContain(`- Tema completo ${i}: Respuesta completa ${i}.`)
    expect(system).not.toContain("Promoción vencida")
    expect(found).toContain("Sin respuesta oficial")
    const mine = await ownerDb.select().from(agentKnowledgeGap).where(eq(agentKnowledgeGap.conversationId, conversationId))
    // Una entrada por pregunta del interlocutor, aunque el agente buscara dos veces.
    expect(mine).toMatchObject([{ question, status: "abierta" }])
  } finally {
    await unpublishKnowledge(ids)
  }
})

it("con modelo de decisión el contexto lleva el índice y solo el tema elegido; si duda o falla, van todas", async () => {
  const ids = [
    await publishKnowledge({ title: "Selección: medios de pago", body: "Aceptamos efectivo y tarjeta." }),
    await publishKnowledge({ title: "Selección: atención a menores", body: "Atendemos niños desde los 3 años." }),
  ]
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "baseline" }))
  const fake = createFakeDecisionModel()
  const runWith = async (decision: DecisionModel, thread: string, eventId: string) => {
    const { conversationId, messageId } = await ingestText(thread, eventId, "¿Atienden a menores de edad?")
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Sí, atendemos niños." }, `envia-${eventId}`))
    const verdict = await processAgentRun(
      appDb,
      { ...runtime, createModel: async () => model, createDecisionModel: () => decision },
      { msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId } },
    )
    expect(verdict).toBe("done")
    const retrieval = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select().from(agentDecisionLog)
        .where(and(eq(agentDecisionLog.conversationId, conversationId), eq(agentDecisionLog.mode, "retrieval"))))
    return { conversationId, system: systemTextOf(model.seen[0] ?? []), retrieval }
  }
  try {
    // Seguro: índice en el bloque de la clínica y solo el tema elegido con su texto.
    const sure = await runWith(fake, "tg:seleccion-1", "evt-sel-1")
    expect(sure.system).toContain("Índice de las 2 respuestas oficiales")
    expect(sure.system).toContain("Respuestas oficiales que aplican a este mensaje")
    expect(sure.system).toContain("- Selección: atención a menores: Atendemos niños desde los 3 años.")
    expect(sure.system).not.toContain("- Selección: medios de pago: Aceptamos efectivo y tarjeta.")
    expect(sure.retrieval).toHaveLength(1)
    expect(sure.retrieval[0]).toMatchObject({
      point: "knowledge.v1",
      provider: "fake",
      outcome: { verdict: "seguro", picked: ["Selección: atención a menores"], candidates: 2 },
    })
    const [trace] = await withOrgContext(appDb, "org_a", (tx) => listAnswerTraces(tx, "org_a", sure.conversationId))
    expect(trace?.basis).toContainEqual({
      kind: "conocimiento",
      label: "Respuestas oficiales elegidas para este mensaje",
      detail: "Selección: atención a menores",
    })

    // Duda: probabilidades planas. Se paga más solo aquí: van todas las respuestas.
    const flat: DecisionModel = {
      ...fake,
      async decide(state, questions, opts) {
        const [first] = questions
        if (first?.id !== "topic" || first.kind !== "choice") return fake.decide(state, questions, opts)
        const options = first.options
        return {
          answers: [{
            id: "topic", kind: "choice", choice: options[0]?.value ?? "none",
            probabilities: Object.fromEntries(options.map((option) => [option.value, 1 / options.length])), confidence: 0,
          }],
          model: "plano", usage: null, latencyMs: 1,
        }
      },
    }
    const doubt = await runWith(flat, "tg:seleccion-2", "evt-sel-2")
    expect(doubt.system).toContain("Respuestas oficiales completas (no quedó claro cuál aplica")
    expect(doubt.system).toContain("- Selección: medios de pago: Aceptamos efectivo y tarjeta.")
    expect(doubt.system).toContain("- Selección: atención a menores: Atendemos niños desde los 3 años.")
    expect(doubt.retrieval[0]?.outcome).toMatchObject({ verdict: "duda" })

    // Fallo del modelo de decisión: el turno sigue, con todas las respuestas, y el fallo queda registrado.
    const broken: DecisionModel = {
      ...fake,
      async decide(state, questions, opts) {
        if (questions[0]?.id === "topic") throw new Error("proveedor caído")
        return fake.decide(state, questions, opts)
      },
    }
    const failed = await runWith(broken, "tg:seleccion-3", "evt-sel-3")
    expect(failed.system).toContain("Respuestas oficiales completas")
    expect(failed.retrieval).toMatchObject([{ error: "fallo inesperado del modelo de decisión", answers: [] }])
    expect(await agentMessages(failed.conversationId)).toEqual(["Sí, atendemos niños."])
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "none" }))
    await unpublishKnowledge(ids)
  }
})

it("la ficha de Recepción declara exactamente las herramientas que el agente tiene", async () => {
  const { conversationId } = await ingestText("tg:ficha", "evt-ficha", "Hola")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId: conv!.contactId,
    triggerId: null, secretsKey: KEY, dryRun: true, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  // Una herramienta nueva sin sitio en la ficha, o una función que nombra una
  // herramienta que no existe, rompe esta igualdad.
  const ficha = AGENT_ROLES.recepcion
  const declared = [...new Set([...ficha.always, ...ficha.functions.flatMap((fn) => fn.tools)])]
  expect(makeAgentTools(ctx).map((tool) => tool.name).sort()).toEqual(declared.sort())

  // Ninguna herramienta declara campos por su cuenta: o toma los de la
  // operación que comparte con la pantalla, o solo lee, o figura con su motivo
  // entre las excepciones. Una herramienta nueva fuera de las tres listas, o
  // cuyos campos no coincidan con la declaración, no pasa.
  for (const tool of makeAgentTools(ctx)) {
    const operation = TOOL_OPERATION[tool.name]
    if (!operation) {
      expect(READ_TOOLS.includes(tool.name) || tool.name in TOOLS_WITHOUT_OPERATION, `${tool.name} no declara de dónde salen sus campos`).toBe(true)
      continue
    }
    const shape = (tool.schema as unknown as { shape: Record<string, { description?: string }> }).shape
    const declared = operationAgentFields(operation)
    expect(Object.keys(shape).sort(), tool.name).toEqual(declared.map((field) => field.name).sort())
    for (const field of declared) expect(shape[field.name]?.description, `${tool.name}.${field.name}`).toBe(field.description)
  }
  // Y ninguna figura en dos listas a la vez.
  for (const name of Object.keys(TOOL_OPERATION)) {
    expect(READ_TOOLS.includes(name) || name in TOOLS_WITHOUT_OPERATION, name).toBe(false)
  }
})

it("apagar una función le quita sus herramientas y deja dicho qué hacer cuando se la piden", async () => {
  const all = async (thread: string, eventId: string) => {
    const { conversationId, messageId } = await ingestText(thread, eventId, "Quiero una cita")
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Con gusto te ayudo." }, `e-${eventId}`))
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    return { tools: model.tools, system: systemTextOf(model.seen[0] ?? []) }
  }
  const before = await all("tg:funciones-0", "evt-fn-0")
  expect(before.tools).toEqual(expect.arrayContaining(["buscar_huecos", "proponer_cita", "consultar_conocimiento", "create_opportunity"]))
  expect(before.system).toContain("Reserva con proponer_cita")
  // Decisión 10 del visor de tomografía: la tomografía se trae en CD, USB o ZIP, no por el chat.
  expect(before.system).toContain("dile que la traiga a su cita en CD, USB o ZIP")
  await withOrgContext(appDb, "org_a", (tx) =>
    upsertAgentConfig(tx, "org_a", {
      disabledFunctions: ["agendar", "seguimiento"],
      functionNotes: { informar: "En ortodoncia, pregunta primero si ya tiene evaluación." },
    }))
  try {
    const off = await all("tg:funciones-1", "evt-fn-1")
    for (const tool of ["buscar_huecos", "proponer_cita", "reprogramar_cita", "cancelar_cita", "create_opportunity", "move_to_stage"]) {
      expect(off.tools).not.toContain(tool)
    }
    // Lo que otra función encendida necesita, y lo fijo, se queda.
    expect(off.tools).toEqual(expect.arrayContaining(["ver_sedes_y_servicios", "consultar_conocimiento", "request_human_handoff", "anotar_caso", "send_reply"]))
    // Sin dirección pública no hay enlace de reserva: no lo manda a enviarlo, le dice que pase el caso.
    expect(off.tools).not.toContain("enviar_enlace_cita")
    expect(off.system).toContain("No reservas, mueves ni cancelas citas por el chat: si piden una cita, moverla o cancelarla, pasa el caso a una persona.")
    expect(off.system).not.toContain("buscar_huecos")
    expect(off.system).toContain("No creas ni cambias oportunidades ni sus tareas.")
    expect(off.system).not.toContain("Reserva con proponer_cita")
    expect(off.system).toContain("Indicación de la clínica para «Informar»: En ortodoncia, pregunta primero si ya tiene evaluación.")
    // Sin «Informar» tampoco recibe tarifas ni respuestas oficiales.
    const entry = await publishKnowledge({ title: "Función: horario", body: "Atendemos de 9 a 19." })
    try {
      expect((await all("tg:funciones-2", "evt-fn-2")).system).toContain("- Función: horario: Atendemos de 9 a 19.")
      await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { disabledFunctions: ["informar"] }))
      const silent = await all("tg:funciones-3", "evt-fn-3")
      expect(silent.tools).not.toContain("consultar_conocimiento")
      expect(silent.tools).toContain("ver_sedes_y_servicios")
      expect(silent.system).not.toContain("Función: horario")
      expect(silent.system).toContain("No respondes preguntas de información general")
    } finally {
      await unpublishKnowledge([entry])
    }
    // Una función fija no se puede apagar.
    await expect(withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { disabledFunctions: ["derivar"] })))
      .rejects.toMatchObject({ code: "VALIDATION" })
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { disabledFunctions: [], functionNotes: {} }))
  }
})

it("la voz de la clínica entra en el prompt solo cuando se configura; el nombre, siempre (Sofi por defecto)", async () => {
  const promptOf = async (thread: string, eventId: string) => {
    const { conversationId, messageId } = await ingestText(thread, eventId, "Hola")
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Hola." }, `e-${eventId}`))
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    return systemTextOf(model.seen[0] ?? [])
  }
  const plain = await promptOf("tg:voz-0", "evt-voz-0")
  expect(plain).toContain("Tono cercano y profesional")
  expect(plain).toContain("Responde solo con datos reales. Si no tiene el dato, lo dice.")
  expect(plain).toContain("Te llamas Sofi y eres asistente virtual de la clínica. Te presentas así solo en tu primera respuesta")
  expect(plain).not.toContain("Tratas de")
  expect(plain).toContain("No uses emojis.")
  await withOrgContext(appDb, "org_a", (tx) =>
    upsertAgentConfig(tx, "org_a", {
      personaName: "Vale", treatment: "usted", tone: "formal", emojis: "pocos",
      about: "Clínica familiar con dos sedes. No presionamos para vender tratamientos.",
    }))
  try {
    const voiced = await promptOf("tg:voz-1", "evt-voz-1")
    expect(voiced).toContain("Te llamas Vale y eres asistente virtual de la clínica.")
    expect(voiced).toContain("Tratas de usted al interlocutor.")
    expect(voiced).toContain("Tono formal y respetuoso")
    expect(voiced).toContain("Sobre la clínica: Clínica familiar con dos sedes.")
    expect(voiced).toContain("como mucho uno por mensaje")
    expect(voiced).not.toContain("No uses emojis.")
  } finally {
    await withOrgContext(appDb, "org_a", (tx) =>
      upsertAgentConfig(tx, "org_a", { personaName: null, treatment: null, tone: "cercano", emojis: "no", about: "" }))
  }
})

it("con «No usar» los emojis se quitan antes de enviar; con «Pocos» salen tal cual", async () => {
  const sent = async (thread: string, eventId: string) => {
    const { conversationId, messageId } = await ingestText(thread, eventId, "Hola")
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "¡Hola! 😊 ¿En qué te ayudo? 👍🏽" }, `e-${eventId}`))
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    return agentMessages(conversationId)
  }
  expect(await sent("tg:emoji-0", "evt-emoji-0")).toEqual(["¡Hola! ¿En qué te ayudo?"])
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { emojis: "pocos" }))
  try {
    expect(await sent("tg:emoji-1", "evt-emoji-1")).toEqual(["¡Hola! 😊 ¿En qué te ayudo? 👍🏽"])
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { emojis: "no" }))
  }
})

it("una señal de alarma no espera al equipo que conversa: pasa con prioridad alta y el aviso dice a dónde llamar (ADR 0084)", async () => {
  const first = await ingestText("tg:alarma", "evt-alarma-1", "Hola")
  await ownerDb.execute(sql`insert into "user" (id, name, email, email_verified) values ('u_agent_team', 'Carla', 'carla@team.test', true) on conflict (id) do nothing`)
  // Carla acaba de escribir: con cualquier otro mensaje el agente esperaría 15 minutos.
  await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", { conversationId: first.conversationId, senderKind: "user", senderUserId: "u_agent_team", content: { type: "text", text: "Hola, soy Carla" } }))
  await ownerDb.execute(sql`update "org_profile" set "emergency_phone" = '+5115550123' where "organization_id" = 'org_a'`)
  try {
    const alarm = await ingestText("tg:alarma", "evt-alarma-2", "Me duele mucho el pecho y no puedo respirar")
    // El modelo que escribe no responde: sale el aviso fijo, que también dice a dónde llamar.
    const model = new ScriptedModel(() => {
      throw new Error("el modelo no responde")
    })
    expect(await runScripted(model, alarm.conversationId, alarm.messageId)).toBe("done")
    const handoffs = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ reason: agentHandoff.reason, priority: agentHandoff.priority }).from(agentHandoff)
        .where(eq(agentHandoff.conversationId, alarm.conversationId)))
    expect(handoffs).toEqual([{ reason: "Urgencia clínica", priority: "alta" }])
    const said = await agentMessages(alarm.conversationId)
    expect(said).toHaveLength(1)
    // El número del país (Perú, 106) y el de la clínica van primero, antes del aviso de siempre.
    expect(said[0]).toBe(
      "Si es una emergencia, llama ahora al 106 o ve a la emergencia más cercana. También puedes llamar a la clínica al +5115550123. Recibimos tu mensaje. Una persona del equipo te va a responder por aquí.",
    )
  } finally {
    await ownerDb.execute(sql`update "org_profile" set "emergency_phone" = null where "organization_id" = 'org_a'`)
  }
})

it("una urgencia sin señal de alarma pasa con prioridad alta y el aviso da el teléfono de la clínica, no el de emergencias (ADR 0084)", async () => {
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "baseline" }))
  await ownerDb.execute(sql`update "org_profile" set "emergency_phone" = '+5115550123' where "organization_id" = 'org_a'`)
  try {
    // El modelo de decisión la marca urgente; no es una señal de alarma.
    const urgent = await ingestText("tg:urgente", "evt-urgente-1", "Tengo un dolor fuerte de muela desde ayer")
    const model = new ScriptedModel(() => {
      throw new Error("el modelo no responde")
    })
    const verdict = await processAgentRun(
      appDb,
      { ...runtime, createModel: async () => model, createDecisionModel: () => createFakeDecisionModel() },
      { msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId: urgent.conversationId, messageId: urgent.messageId } },
    )
    expect(verdict).toBe("done")
    expect(systemTextOf(model.seen[0] ?? [])).toContain("No le digas que llame al número de emergencias del país")
    const handoffs = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ reason: agentHandoff.reason, priority: agentHandoff.priority }).from(agentHandoff)
        .where(eq(agentHandoff.conversationId, urgent.conversationId)))
    expect(handoffs).toEqual([{ reason: "Urgencia", priority: "alta" }])
    // Un dolor de muela no se manda a la ambulancia: el teléfono de la clínica va primero.
    expect(await agentMessages(urgent.conversationId)).toEqual([
      "Si es urgente, puedes llamar a la clínica al +5115550123. Recibimos tu mensaje. Una persona del equipo te va a responder por aquí.",
    ])
  } finally {
    await ownerDb.execute(sql`update "org_profile" set "emergency_phone" = null where "organization_id" = 'org_a'`)
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "none", decisionRoutingEnabled: true }))
  }
})

it("probar: la conversación de prueba reserva de verdad, marcada «Prueba», sin ocupar el horario real y se va entera al borrarla", async () => {
  // La sede y su horario son reales; la persona de prueba la crea «Probar», ya registrada como paciente.
  const seed = await ingestText("tg:prueba-sede", "evt-prueba-sede", "Hola")
  const fx = await bookingFixture(seed.conversationId, "prueba")
  const inOrg = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, "org_a", fn)
  const opened = await inOrg((tx) => openProbar(tx, "org_a", fx.actorId, { secretsKey: KEY }))
  const [thread] = await inOrg((tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, opened.conversationId)))
  const [testPatient] = await inOrg((tx) => listAgentContextCandidates(tx, "org_a", thread!.contactId))
  expect(testPatient).toMatchObject({ displayName: "Paciente de prueba", relationship: "self" })
  // En el chat web no se reserva sin dónde avisarle (si la clínica puede avisar):
  // la persona de prueba ya dejó su correo.
  await ownerDb.update(contact).set({ email: "prueba@example.com" }).where(eq(contact.id, thread!.contactId))
  const write = (text: string) =>
    inOrg((tx) =>
      ingestInbound(
        tx,
        { orgId: "org_a", connectionId: opened.connectionId, event: buildWebchatInbound(opened.sessionId, { text, clientMessageId: randomUUID() }) },
        webChatAdapter,
        { storage: storageStub, fetch, secretsKey: KEY },
      ))
  const day = upcomingMonday()
  const turnOne = new ScriptedModel((messages, call) => {
    if (call === 1) {
      return toolCall(
        "buscar_huecos",
        { branchId: fx.branchId, from: day.toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString(), durationMin: 45 },
        "p1-huecos",
      )
    }
    if (call === 2) {
      const line = String(messages[messages.length - 1]?.content ?? "").split("\n")[1] ?? ""
      return toolCall(
        "proponer_cita",
        {
          patientId: testPatient!.patientId,
          professionalUserId: line.match(/profesional ([^\]\s]+)/)?.[1],
          roomId: line.match(/unidad dental ([0-9a-f-]{36})/i)?.[1],
          startsAt: line.match(ISO_INSTANT)?.[0],
          branchId: fx.branchId,
          durationMin: 45,
        },
        "p1-propuesta",
      )
    }
    return toolCall("send_reply", { text: "Tengo un espacio el lunes a las 9:00 a. m. ¿Confirmas la cita?" }, "p1-envio")
  })
  const first = await write("Quiero una cita para una limpieza")
  expect(await runScripted(turnOne, first.conversationId, first.messageId)).toBe("done")
  expect(first.conversationId).toBe(opened.conversationId)

  const turnTwo = new ScriptedModel((messages, call) => {
    if (call > 1) return toolCall("send_reply", { text: "Listo, tu cita quedó reservada." }, "p2-envio")
    const visible = messages.map((m) => String(m.content)).join("\n")
    const proposalId = /propuesta[^\n]*\bid ([0-9a-f-]{36})/i.exec(visible)?.[1]
    return proposalId
      ? toolCall("confirmar_propuesta", { proposalId }, "p2-confirma")
      : toolCall("send_reply", { text: "¿Me confirmas la cita, por favor?" }, "p2-repregunta")
  })
  const second = await write("Sí")
  expect(await runScripted(turnTwo, second.conversationId, second.messageId)).toBe("done")
  // En el chat web, lo que ya dejó para avisarle está a la vista: no se lo vuelve a pedir (ADR 0104).
  expect(systemTextOf(turnTwo.seen[0] ?? [])).toMatch(/Ya dejó dónde avisarle: [^\n]*su correo prueba@example\.com\./)

  // La cita existe de verdad, de la persona de prueba, y la base la marca «Prueba».
  const [booked] = await ownerDb.select().from(appointment).where(eq(appointment.conversationId, opened.conversationId))
  expect(booked).toMatchObject({ patientId: testPatient!.patientId, isTest: true, status: "confirmada" })
  const state = await inOrg((tx) => getProbar(tx, "org_a", fx.actorId))
  expect(state.created).toMatchObject([{ appointmentId: booked!.id }])
  expect(state.turns.map((turn) => turn.toolsUsed)).toEqual([
    ["buscar_huecos", "proponer_cita", "send_reply"],
    ["confirmar_propuesta", "send_reply"],
  ])
  // Como en real, tras reservar llega la pregunta de novedades (ADR 0030): la simulación nunca la hacía.
  expect(state.messages.map((item) => item.from)).toEqual(["paciente", "sofi", "paciente", "sofi", "sofi"])
  // Nada sale hacia afuera: ni recordatorios ni avisos de esa cita.
  expect(await ownerDb.select().from(automationJob).where(eq(automationJob.appointmentId, booked!.id))).toEqual([])

  // No ocupa el horario real: un paciente real ve ese hueco y lo reserva igual.
  const slotQuery = { branchId: fx.branchId, professionalUserId: fx.professionalId, from: day.toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString(), durationMin: 45 }
  const realSlots = await inOrg((tx) => listAvailableSlots(tx, "org_a", slotQuery))
  expect(realSlots.slots.map((slot) => slot.startsAt)).toContain(booked!.startsAt.toISOString())
  const testSlots = await inOrg((tx) => listAvailableSlots(tx, "org_a", { ...slotQuery, forTest: true }))
  expect(testSlots.slots.map((slot) => slot.startsAt)).not.toContain(booked!.startsAt.toISOString())
  // Otra prueba no la ofrece: lo que Sofi ofrece en una prueba se puede reservar.
  const testGaps = await inOrg((tx) =>
    findFreeGaps(tx, "org_a", { branchId: fx.branchId, professionalUserId: fx.professionalId, from: slotQuery.from, to: slotQuery.to, durationMin: 45, forTest: true }))
  expect(testGaps.gaps.map((gap) => gap.startsAt)).not.toContain(booked!.startsAt.toISOString())
  const real = await inOrg((tx) =>
    createAppointment(tx, "org_a", fx.actorId, {
      branchId: fx.branchId, patientId: fx.patientId, professionalUserId: fx.professionalId, roomId: booked!.roomId,
      startsAt: booked!.startsAt.toISOString(), durationMin: 45,
    }))
  expect(real.test).toBeNull()

  // «Empezar de nuevo» se lleva la conversación, la cita, la ficha y la persona de prueba.
  await inOrg((tx) => deleteProbar(tx, "org_a", fx.actorId))
  expect(await ownerDb.select().from(appointment).where(eq(appointment.id, booked!.id))).toEqual([])
  expect(await ownerDb.select().from(conversation).where(eq(conversation.id, opened.conversationId))).toEqual([])
  const [left] = await ownerDb.execute<{ people: number; patients: number }>(sql`
    select (select count(*)::int from contact where id = ${thread!.contactId}) as people,
           (select count(*)::int from patient where id = ${testPatient!.patientId}) as patients`)
  expect(left).toEqual({ people: 0, patients: 0 })
  expect((await inOrg((tx) => getProbar(tx, "org_a", fx.actorId))).conversationId).toBeNull()
})

it("en el chat web no dice que guardó su WhatsApp sin guardarlo, ni cuando guardar_contacto lo rechazó (caso 17 de latidIA, 29-oct)", async () => {
  const stamp = Date.now()
  const actors = [`u-contacto-a-${stamp}`, `u-contacto-b-${stamp}`]
  await ownerDb.insert(user).values(actors.map((id) => ({ id, name: id, email: `${id}@example.test` })))
  for (const id of actors) {
    await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values (${`m-${id}`}, 'org_a', ${id}, 'owner', now())`)
  }
  const inOrg = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, "org_a", fn)
  // Con WhatsApp conectado, el número que deja sirve para avisarle si no es de otra persona (`webchatReplyRoutes`).
  const [connected] = await ownerDb.execute<{ id: string }>(
    sql`select id from channel_connection where organization_id = 'org_a' and channel = 'whatsapp' and status = 'active' limit 1`,
  )
  if (!connected) {
    const whatsapp = await inOrg((tx) =>
      createConnection(tx, "org_a", KEY, { channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WhatsApp", config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S" } }, { fetch, validateExternal: false }),
    )
    onTestFinished(async () => {
      await ownerDb.execute(sql`delete from channel_connection where id = ${whatsapp.id}`)
    })
  }
  const writeAs = async (actor: string, text: string) => {
    const opened = await inOrg((tx) => openProbar(tx, "org_a", actor, { secretsKey: KEY }))
    return inOrg((tx) =>
      ingestInbound(
        tx,
        { orgId: "org_a", connectionId: opened.connectionId, event: buildWebchatInbound(opened.sessionId, { text, clientMessageId: randomUUID() }) },
        webChatAdapter,
        { storage: storageStub, fetch, secretsKey: KEY },
      ))
  }
  const lastToolText = (model: ScriptedModel, call: number) => String((model.seen[call] ?? []).filter((m) => m.getType() === "tool").at(-1)?.content)
  const SAVED = "Ya guardé tu WhatsApp para que puedan avisarte."

  // Sin guardarlo no sale; guardado, sí.
  const first = await writeAs(actors[0]!, "mi WhatsApp es 987 654 321")
  const saves = new ScriptedModel((_messages, call) =>
    call === 2 ? toolCall("guardar_contacto", { whatsapp: "987 654 321" }, "c-guarda") : toolCall("send_reply", { text: SAVED }, `c-envio-${call}`),
  )
  expect(await runScripted(saves, first.conversationId, first.messageId)).toBe("done")
  expect(lastToolText(saves, 1)).toContain("No enviado: dices que guardaste su WhatsApp o su correo")
  expect(lastToolText(saves, 2)).toContain("Guardado: le avisaremos por WhatsApp")
  expect(await agentMessages(first.conversationId)).toEqual([SAVED])

  // Ese número ya es de otra persona: guardar_contacto lo acepta igual y el visitante oye lo mismo
  // (decirle que no sirve le revelaría quién es de la clínica); el equipo lo ve en la Bandeja.
  const second = await writeAs(actors[1]!, "mi WhatsApp es 987 654 321")
  const held = new ScriptedModel((_messages, call) =>
    call === 1 ? toolCall("guardar_contacto", { whatsapp: "987 654 321" }, "r-guarda") : toolCall("send_reply", { text: SAVED }, `r-envio-${call}`),
  )
  expect(await runScripted(held, second.conversationId, second.messageId)).toBe("done")
  expect(lastToolText(held, 1)).toContain("Guardado: le avisaremos por WhatsApp")
  expect(await agentMessages(second.conversationId)).toEqual([SAVED])

  // Con el caso ya en el equipo (una señal de alarma lo pasa): no se le nombra guardar_contacto,
  // que ese camino no trae, y el turno vuelve al modelo en vez de cerrar con el aviso fijo.
  const actor = `u-contacto-c-${stamp}`
  await ownerDb.insert(user).values({ id: actor, name: actor, email: `${actor}@example.test` })
  await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values (${`m-${actor}`}, 'org_a', ${actor}, 'owner', now())`)
  const third = await writeAs(actor, "me duele el pecho, mi WhatsApp es 987 111 222")
  const NOTICE = "Llama ahora al 106. Una persona del equipo continuará la atención; déjanos aquí tu WhatsApp para avisarte."
  const derived = new ScriptedModel((_messages, call) =>
    toolCall(
      "request_human_handoff",
      { reason: "Aviso al interlocutor", summary: "Aviso al interlocutor", message: call === 1 ? "Llama ahora al 106. Ya guardé tu WhatsApp para avisarte." : NOTICE },
      `d-aviso-${call}`,
    ),
  )
  expect(await runScripted(derived, third.conversationId, third.messageId)).toBe("done")
  expect(derived.offered[0]).not.toContain("guardar_contacto")
  expect(lastToolText(derived, 1)).toContain("No enviado: dices que guardaste su WhatsApp o su correo")
  expect(lastToolText(derived, 1)).not.toContain("guardar_contacto")
  expect(await agentMessages(third.conversationId)).toEqual([NOTICE])
})

it("una corrección aprobada llega a la siguiente respuesta, queda en su traza y retirarla la quita", async () => {
  const stamp = Date.now()
  const adminId = `u-aprende-${stamp}`
  await ownerDb.insert(user).values({ id: adminId, name: "Carmen", email: `carmen-${stamp}@example.test` })
  const inOrg = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, "org_a", fn)
  const RULE = "No ofrezcas citas en domingo: la clínica no atiende ese día."
  const promptFor = async (thread: string, eventId: string, text: string) => {
    const { conversationId, messageId } = await ingestText(thread, eventId, text)
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "De acuerdo." }, `e-${eventId}`))
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    return { conversationId, system: systemTextOf(model.seen[0] ?? []) }
  }

  // El agente responde algo que no debía.
  const first = await ingestText("tg:aprende-1", "evt-aprende-1", "¿Tienen cita el domingo?")
  const wrong = new ScriptedModel(() => toolCall("send_reply", { text: "Sí, tengo el domingo libre." }, "ap-1"))
  expect(await runScripted(wrong, first.conversationId, first.messageId)).toBe("done")
  const [trace] = await inOrg((tx) => listAnswerTraces(tx, "org_a", first.conversationId))
  const lesson = await inOrg((tx) =>
    correctAnswer(tx, "org_a", adminId, { traceId: trace!.id, failure: "no_debio_responder", correctedReply: RULE }))
  expect(lesson).toMatchObject({ kind: "regla", status: "propuesta", question: "¿Tienen cita el domingo?" })

  // Propuesta: todavía no cambia nada.
  expect((await promptFor("tg:aprende-2", "evt-aprende-2", "¿Tienen cita para el domingo?")).system).not.toContain(RULE)

  // Aprobada: la siguiente respuesta a esa pregunta ya la recibe, y su traza lo dice.
  await inOrg((tx) => approveLesson(tx, "org_a", adminId, lesson.id))
  const taught = await promptFor("tg:aprende-3", "evt-aprende-3", "¿Tienen cita para el domingo?")
  expect(taught.system).toContain(`- ${RULE}`)
  const [taughtTrace] = await inOrg((tx) => listAnswerTraces(tx, "org_a", taught.conversationId))
  expect(taughtTrace?.basis).toContainEqual({ kind: "leccion", label: "Regla que aprobó tu clínica", detail: lesson.title, ref: lesson.id })
  expect((await inOrg((tx) => getLesson(tx, "org_a", lesson.id))).uses).toBe(1)
  // En otro tema la regla sigue en el prompt, pero no cuenta como usada.
  const other = await promptFor("tg:aprende-4", "evt-aprende-4", "¿Aceptan tarjeta?")
  expect(other.system).toContain(RULE)
  expect((await inOrg((tx) => getLesson(tx, "org_a", lesson.id))).uses).toBe(1)

  // Probar qué pasa si se retira: responde con y sin la regla, sin escribir nada.
  const deps = { platform: runtime.platform, secretsKey: KEY }
  const depends = () =>
    new ScriptedModel((messages) =>
      toolCall("send_reply", { text: systemTextOf(messages).includes(RULE) ? "Los domingos no atendemos." : "Tengo el domingo libre." }, "pv"))
  const preview = await previewLesson(appDb, { ...deps, createModel: async () => depends() }, { orgId: "org_a", userId: adminId, lessonId: lesson.id })
  expect(preview.cases[0]).toMatchObject({
    question: "¿Tienen cita el domingo?", before: "Los domingos no atendemos.", after: "Tengo el domingo libre.", same: false,
  })
  expect((await inOrg((tx) => getLesson(tx, "org_a", lesson.id))).uses).toBe(1)

  // Retirada: deja de usarse al instante.
  await inOrg((tx) => withdrawLesson(tx, "org_a", adminId, lesson.id, { withdrawCase: true }))
  expect((await promptFor("tg:aprende-5", "evt-aprende-5", "¿Tienen cita para el domingo?")).system).not.toContain(RULE)
})

it("probar una respuesta oficial propuesta la da por publicada solo en la prueba", async () => {
  const stamp = Date.now()
  const adminId = `u-aprende-b-${stamp}`
  await ownerDb.insert(user).values({ id: adminId, name: "Carmen", email: `carmen-b-${stamp}@example.test` })
  const inOrg = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, "org_a", fn)
  const ANSWER = "Sí, hay un bicicletero techado en la entrada."
  const asked = await ingestText("tg:aprende-b1", "evt-aprende-b1", "¿Tienen bicicletero?")
  const model = new ScriptedModel(() => toolCall("send_reply", { text: "No tengo ese dato." }, "apb-1"))
  expect(await runScripted(model, asked.conversationId, asked.messageId)).toBe("done")
  const [trace] = await inOrg((tx) => listAnswerTraces(tx, "org_a", asked.conversationId))
  const lesson = await inOrg((tx) => correctAnswer(tx, "org_a", adminId, { traceId: trace!.id, failure: "falto_dato", correctedReply: ANSWER }))
  expect(lesson.kind).toBe("respuesta_oficial")

  const deps = { platform: runtime.platform, secretsKey: KEY }
  const depends = () =>
    new ScriptedModel((messages) =>
      toolCall("send_reply", { text: systemTextOf(messages).includes(ANSWER) ? ANSWER : "No tengo ese dato." }, "pvb"))
  const preview = await previewLesson(appDb, { ...deps, createModel: async () => depends() }, { orgId: "org_a", userId: adminId, lessonId: lesson.id })
  expect(preview.cases).toEqual([
    { question: "¿Tienen bicicletero?", expected: null, before: "No tengo ese dato.", after: ANSWER, same: false },
  ])
  // La prueba no publicó nada: una conversación real sigue sin el dato.
  const next = await ingestText("tg:aprende-b2", "evt-aprende-b2", "¿Tienen bicicletero?")
  const real = new ScriptedModel(() => toolCall("send_reply", { text: "De acuerdo." }, "apb-2"))
  expect(await runScripted(real, next.conversationId, next.messageId)).toBe("done")
  expect(systemTextOf(real.seen[0] ?? [])).not.toContain(ANSWER)
  await inOrg((tx) => discardLesson(tx, "org_a", adminId, lesson.id))
})

it("un dato de la persona dicho hoy llega a su siguiente conversación; lo clínico no se guarda y quitarlo deja de usarlo", async () => {
  const stamp = Date.now()
  const adminId = `u-memoria-${stamp}`
  await ownerDb.insert(user).values({ id: adminId, name: "Carmen", email: `carmen-m-${stamp}@example.test` })
  const inOrg = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, "org_a", fn)
  const thread = "tg:memoria-1"

  // Hoy: la persona dice una preferencia y, de paso, algo de salud.
  const first = await ingestText(thread, "evt-memoria-1", "Prefiero las citas por la tarde. Y me duele una muela.")
  const toolReplies: string[] = []
  const listening = new ScriptedModel((messages, call) => {
    const last = messages[messages.length - 1]
    if (call > 1) toolReplies.push(String(last?.content ?? ""))
    if (call === 1) return toolCall("recordar_dato", { text: "Prefiere citas por la tarde" }, "m-1")
    if (call === 2) return toolCall("recordar_dato", { text: "Le duele una muela" }, "m-2")
    return toolCall("send_reply", { text: "Anotado. ¿Te busco un horario por la tarde?" }, "m-3")
  })
  expect(await runScripted(listening, first.conversationId, first.messageId)).toBe("done")
  expect(toolReplies[0]).toContain("Guardado para próximas conversaciones")
  // El dato de salud no entra: el modelo recibe por qué y la corrida sigue.
  expect(toolReplies[1]).toContain("No se guardó: Eso parece información de salud")
  const [conv] = await inOrg((tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, first.conversationId)))
  const facts = await inOrg((tx) => listPersonFacts(tx, "org_a", conv!.contactId))
  expect(facts.map((fact) => fact.text)).toEqual(["Prefiere citas por la tarde"])
  expect(facts[0]).toMatchObject({ source: "agente", channel: "telegram" })

  // Otro día: el contexto del turno ya trae lo que recuerda, con su origen.
  const promptOf = async (eventId: string) => {
    const next = await ingestText(thread, eventId, "Hola, quiero otra cita")
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Claro." }, `e-${eventId}`))
    expect(await runScripted(model, next.conversationId, next.messageId)).toBe("done")
    return systemTextOf(model.seen[0] ?? [])
  }
  const later = await promptOf("evt-memoria-2")
  expect(later).toContain("Lo que recuerdas de esta persona de conversaciones anteriores")
  expect(later).toContain(`- Prefiere citas por la tarde (id ${facts[0]!.id}; lo dijo por Telegram el `)
  expect(later).not.toContain("muela")

  // El equipo lo quita: el agente deja de usarlo.
  await inOrg((tx) => removePersonFact(tx, "org_a", adminId, conv!.contactId, facts[0]!.id))
  expect(await promptOf("evt-memoria-3")).not.toContain("Prefiere citas por la tarde")
})

it("el agente entrega un enlace para elegir la cita solo a quien ya es paciente, y solo si hay dirección pública", async () => {
  const withPatient = await ingestText("tg:enlace-paciente", "evt-enlace-1", "Quiero una cita")
  const fx = await bookingFixture(withPatient.conversationId, "enlace")
  const ctxFor = (conversationId: string, contactId: string, publicUrl = true): AgentToolCtx => ({
    db: appDb, orgId: "org_a", conversationId, contactId,
    triggerId: null, secretsKey: KEY, dryRun: false, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
    ...(publicUrl ? { publicUrl: { webURL: "https://app.odentia.test", cookieDomain: ".odentia.test" } } : {}),
  })
  // Sin dirección pública no existe la herramienta: no hay página que abrir.
  expect(makeAgentTools(ctxFor(withPatient.conversationId, fx.contactId, false)).map((item) => item.name)).not.toContain("enviar_enlace_cita")
  const link = makeAgentTools(ctxFor(withPatient.conversationId, fx.contactId)).find((item) => item.name === "enviar_enlace_cita")!
  const sent = String(await link.invoke({ branchId: fx.branchId }))
  // El enlace va a la dirección de la clínica, es personal y no lleva nada que la comprobación de respuestas lea como hora, fecha o precio.
  const url = /https:\/\/norte\.odentia\.test\/reserva\?token=([0-9a-f]{64})/.exec(sent)
  expect(url).not.toBeNull()
  expect(sent).toContain("Paciente enlace")
  // «Su enlace» vale una semana y es el mismo si ya tenía uno.
  expect(sent).toContain("vale 7 días")
  // Quien aún no es paciente tampoco recibe enlace mientras la clínica no active su registro en línea.
  const stranger = await ingestText("tg:enlace-nuevo", "evt-enlace-2", "Hola")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) => tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, stranger.conversationId)))
  const refused = String(await makeAgentTools(ctxFor(stranger.conversationId, conv!.contactId)).find((item) => item.name === "enviar_enlace_cita")!.invoke({}))
  expect(refused).toContain("no tiene activo el registro de pacientes en línea")
})

it("con los horarios va siempre su enlace para ver toda la agenda: lo agrega el sistema al enviar (lo pidió una clínica)", async () => {
  const { conversationId } = await ingestText("tg:agenda-entera", "evt-agenda-entera-1", "¿Tienen cita el lunes?")
  const fx = await bookingFixture(conversationId, "agenda-entera")
  // Cada corrida arma su contexto; lo que ya hizo en ella va en toolsUsed.
  const runCtx = (triggerId: string, toolsUsed: string[] = []): AgentToolCtx => ({
    db: appDb, orgId: "org_a", conversationId, contactId: fx.contactId,
    triggerId, secretsKey: KEY, dryRun: false, handedOff: false, replySettled: false,
    toolsUsed, usage: emptyUsage(),
    publicUrl: { webURL: "https://app.odentia.test", cookieDomain: ".odentia.test" },
  })
  const links = () => withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointmentBookingLink).where(eq(appointmentBookingLink.contactId, fx.contactId)))
  const withAgenda = async () => (await agentMessages(conversationId)).filter((body) => body.includes("La agenda completa"))
  const monday = upcomingMonday()
  const range = { branchId: fx.branchId, from: monday.toISOString(), to: new Date(monday.getTime() + 86_400_000).toISOString() }
  const search = async (ctx: AgentToolCtx) => {
    const found = String(await makeAgentTools(ctx).find((item) => item.name === "buscar_huecos")!.invoke(range))
    // En la corrida, el grafo guarda lo que devolvió la herramienta como lo consultado del turno.
    ctx.evidence = [{ kind: "agenda", source: "Agenda: horarios disponibles", text: found }]
    return found
  }
  const offer = async (ctx: AgentToolCtx, found: string) => {
    const [first, second] = [...found.matchAll(/, (\d{2}:\d{2})–/g)].map((match) => match[1])
    await makeAgentTools(ctx).find((item) => item.name === "send_reply")!.invoke({ text: `Tengo el lunes a las ${first} o a las ${second}. ¿Cuál prefieres?` })
  }

  const ctx = runCtx("trig-agenda-1")
  const found = await search(ctx)
  // Buscar solo lee: el enlace no llega al modelo ni se crea al buscar.
  expect(found).toContain("hasta 3 por profesional y día, repartidos en su jornada")
  expect(found).toContain("el sistema agrega al final de tu respuesta su enlace para ver toda la agenda")
  expect(found).not.toContain("/reserva?token=")
  expect(await links()).toHaveLength(0)
  await offer(ctx, found)
  // Sale con la agenda, abierta en la sede donde buscó; el mensaje guarda la referencia y el token se pone al entregarlo.
  const [sent] = await withAgenda()
  expect(sent).toMatch(/\n\nLa agenda completa, para elegir el día, la hora y con quién: https:\/\/norte\.odentia\.test\/reserva\?token=\{\{su-enlace:[0-9a-f-]{36}\}\}$/)
  expect(resolvePersonalLinkRefs(sent!, KEY)).toMatch(/\/reserva\?token=[0-9a-f]{64}$/)
  const [link] = await links()
  expect(link).toMatchObject({ booking: true, branchId: fx.branchId, serviceId: null })
  expect(sent).toContain(link!.id)

  // Con una cita propuesta en la corrida, la respuesta habla de esa cita: no lleva la agenda.
  const proposing = runCtx("trig-agenda-2")
  const again = await search(proposing)
  const line = again.split("\n").find((text) => text.startsWith("- ")) ?? ""
  await makeAgentTools(proposing).find((item) => item.name === "proponer_cita")!.invoke({
    patientId: fx.patientId,
    professionalUserId: line.match(/profesional ([^\]\s]+)/)?.[1],
    roomId: line.match(/unidad dental ([0-9a-f-]{36})/i)?.[1],
    startsAt: line.match(ISO_INSTANT)?.[0],
    branchId: fx.branchId,
  })
  const pending = () => withOrgContext(appDb, "org_a", (tx) => listProposals(tx, "org_a", { conversationId, status: "propuesta" }))
  expect((await pending()).map((item) => item.action)).toEqual(["reservar_cita"])
  proposing.toolsUsed.push("proponer_cita")
  await offer(proposing, again)
  expect(await withAgenda()).toHaveLength(1)

  // Si reserva por la agenda mientras esa cita espera su sí, la propuesta vence: su «sí» de después no reserva otra.
  const token = /token=([0-9a-f]{64})/.exec(resolvePersonalLinkRefs(sent!, KEY))![1]!
  const other = again.split("\n").filter((text) => text.startsWith("- ")).at(-1) ?? ""
  await withOrgContext(appDb, "org_a", (tx) =>
    reserveBookingLink(tx, "org_a", token, {
      branchId: fx.branchId,
      startsAt: other.match(ISO_INSTANT)![0],
      professionalUserId: fx.professionalId,
      roomId: other.match(/unidad dental ([0-9a-f-]{36})/i)![1]!,
    }, { secretsKey: KEY }))
  expect(await pending()).toHaveLength(0)

  // Con esa cita por venir, la página le mostraría la cita y no la agenda: los horarios siguientes salen sin ella.
  const later = runCtx("trig-agenda-3")
  await offer(later, await search(later))
  expect(await withAgenda()).toHaveLength(1)
})

it("mientras la persona sigue escribiendo la corrida se pospone, y el tope evita esperar de más", async () => {
  const { conversationId, messageId } = await ingestText("tg:espera", "evt-espera-1", "Hola")
  const second = await ingestText("tg:espera", "evt-espera-2", "quiero saber si atienden el viernes")
  const model = new ScriptedModel(() => toolCall("send_reply", { text: "Claro, dime." }, "espera"))
  const job = (id: string) => ({ msg_id: 1, read_ct: 0, message: { kind: "inbound_message" as const, orgId: "org_a", conversationId, messageId: id } })
  const queued = async () => {
    const rows = (await ownerDb.execute(
      sql`select count(*)::int as n from pgmq.q_agent_runs where message->>'conversationId' = ${conversationId}`,
    )) as unknown as { n: number }[]
    return rows[0]?.n ?? 0
  }
  // Acaba de escribir: ni llama al modelo ni deja fila; la corrida vuelve a la cola para después.
  const waiting = { ...runtime, createModel: async () => model, burst: { quietMs: 60_000, maxWaitMs: 300_000 } }
  expect(await processAgentRun(appDb, waiting, job(messageId))).toBe("done")
  expect(model.seen).toHaveLength(0)
  expect(await ledgerRows(conversationId)).toEqual([])
  expect(await queued()).toBe(1)
  // Pasado el tope desde el primer mensaje, responde con lo que haya: una sola respuesta para los dos.
  const capped = { ...runtime, createModel: async () => model, burst: { quietMs: 60_000, maxWaitMs: 0 } }
  expect(await processAgentRun(appDb, capped, job(second.messageId))).toBe("done")
  expect(model.seen).toHaveLength(1)
  expect(await agentMessages(conversationId)).toEqual(["Claro, dime."])
  expect((await ledgerRows(conversationId)).map((row) => row.status).sort()).toEqual(["ok", "omitida"])
  await ownerDb.execute(sql`select pgmq.purge_queue('agent_runs')`)
})

it("decidir antes de escribir: el camino se elige primero, derivar no llama al que escribe y apagado vuelve a la sombra", async () => {
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "baseline" }))
  const decision = createFakeDecisionModel()
  const turn = async (thread: string, eventId: string, text: string) => {
    const { conversationId, messageId } = await ingestText(thread, eventId, text)
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Listo." }, `e-${eventId}`))
    const verdict = await processAgentRun(
      appDb,
      { ...runtime, createModel: async () => model, createDecisionModel: () => decision },
      { msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId } },
    )
    expect(verdict).toBe("done")
    const decisions = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ point: agentDecisionLog.point, mode: agentDecisionLog.mode, outcome: agentDecisionLog.outcome, error: agentDecisionLog.error })
        .from(agentDecisionLog).where(eq(agentDecisionLog.conversationId, conversationId)))
    // El interés en un servicio (decisión 15) tiene su propia prueba: aquí solo cuenta el camino.
    const routing = decisions.filter((item) => item.point !== "interest.v1")
    return { conversationId, calls: model.seen.length, offered: model.offered, system: systemTextOf(model.seen[0] ?? []), decisions: routing, ledger: await ledgerRows(conversationId) }
  }
  try {
    // Información: el que escribe recibe el camino y resuelve en una sola llamada.
    const info = await turn("tg:camino-info", "evt-camino-info", "¿Cuánto cuesta una limpieza?")
    expect(info.system).toContain("Camino para este mensaje, elegido por lo que escribió el interlocutor: pide información.")
    expect(info.system).toContain("Si con eso basta, responde ahora con send_reply, en este mismo paso.")
    expect(info.decisions).toEqual([
      expect.objectContaining({ point: "route.v6", mode: "route", error: null, outcome: expect.objectContaining({ path: "informacion", intent: "price_or_service_info" }) }),
    ])
    expect(info.ledger).toEqual([{ status: "ok", llmCalls: 1, toolsUsed: ["send_reply"] }])
    // Con el camino elegido solo se le enseñan las herramientas de ese camino, más la que le devuelve el resto.
    expect([...(info.offered[0] ?? [])].sort()).toEqual(
      [
        "ampliar_herramientas", "anotar_respuesta_presupuesto", "buscar_en_la_clinica", "consultar_conocimiento", "elegir_mensajes",
        "enviar_comprobante", "pedir_volver_al_portal", "recordar_tema", "reenviar_presupuesto", "request_human_handoff", "send_reply", "update_contact",
        "ver_presupuesto", "ver_sedes_y_servicios",
      ],
    )

    // Si el camino no alcanza, pide el resto y lo recibe en el paso siguiente.
    const wide = await ingestText("tg:camino-ampliar", "evt-camino-ampliar", "¿Cuánto cuesta una limpieza? De paso quiero reservar")
    const widening = new ScriptedModel((_messages, call) =>
      call === 1 ? toolCall("ampliar_herramientas", { motivo: "Quiere reservar" }, "amplia") : toolCall("send_reply", { text: "Listo." }, "amplia-envio"))
    expect(await processAgentRun(appDb, { ...runtime, createModel: async () => widening, createDecisionModel: () => decision }, {
      msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId: wide.conversationId, messageId: wide.messageId },
    })).toBe("done")
    expect(widening.offered[0]).not.toContain("proponer_cita")
    expect(widening.offered[1]).toContain("proponer_cita")
    expect(widening.offered[1]).not.toContain("ampliar_herramientas")
    expect(await ledgerRows(wide.conversationId)).toEqual([{ status: "ok", llmCalls: 2, toolsUsed: ["ampliar_herramientas", "send_reply"] }])
    // El camino va al final, con lo del turno: lo estable de la organización queda delante y sigue igual.
    expect(info.system.indexOf("Camino para este mensaje")).toBeGreaterThan(info.system.indexOf("Política de autonomía"))

    // Seguro de que hace falta una persona: el caso pasa al equipo con su clase, su prioridad y lo que la
    // persona escribió, y el que escribe solo deja el aviso (no crea otra derivación ni puede hacer nada más).
    const derive = async (thread: string, eventId: string, text: string, model: ScriptedModel) => {
      const { conversationId, messageId } = await ingestText(thread, eventId, text)
      expect(await processAgentRun(appDb, { ...runtime, createModel: async () => model, createDecisionModel: () => decision }, {
        msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId },
      })).toBe("done")
      return {
        conversationId,
        handoffs: await withOrgContext(appDb, "org_a", (tx) => listHandoffs(tx, "org_a", { conversationId })),
        ledger: await ledgerRows(conversationId),
        sent: await agentMessages(conversationId),
      }
    }
    const notice = "Ana, ya pasé tu caso a una persona del equipo, que te va a responder por aquí."
    const notifier = () => new ScriptedModel(() => toolCall("request_human_handoff", {
      reason: "Aviso al interlocutor", summary: "Aviso al interlocutor", message: notice,
      asks: "Hablar con una persona por una queja", pending: "Saber de qué es la queja",
    }, "aviso"))
    const asks = notifier()
    const handoff = await derive("tg:camino-derivar", "evt-camino-derivar", "Tengo una queja y quiero hablar con una persona", asks)
    // Con el caso ya en el equipo puede leer su cita y las sedes para decirle algo concreto,
    // y hacer lo que sí puede aunque venga con la queja: que no le escriban más (ADR 0104).
    expect(asks.offered).toEqual([["ver_sedes_y_servicios", "ver_contexto_paciente", "ver_resumen_paciente", "elegir_mensajes", "request_human_handoff"]])
    expect(systemTextOf(asks.seen[0] ?? [])).toContain("el caso ya pasó a una persona del equipo y el equipo ya recibió el aviso")
    expect(handoff.ledger).toEqual([{ status: "handoff", llmCalls: 1, toolsUsed: ["request_human_handoff"] }])
    expect(await agentStatusOf(handoff.conversationId)).toBe("on")
    expect(handoff.handoffs).toHaveLength(1)
    expect(handoff.handoffs[0]).toMatchObject({
      reason: "Pide hablar con una persona",
      priority: "baja",
      summary: "Escribió: «Tengo una queja y quiero hablar con una persona»",
      // Lo que lee quien toma el caso: qué pide, qué falta y el aviso que de verdad salió.
      asks: "Hablar con una persona por una queja",
      pending: "Saber de qué es la queja",
      notice,
    })
    expect(handoff.sent).toEqual([notice])

    // Con urgencia entra como prioridad alta.
    const urgent = await derive("tg:camino-urgente", "evt-camino-urgente", "Tengo un dolor fuerte y sangra mucho, necesito a una persona", notifier())
    expect(urgent.handoffs.map((item) => [item.reason, item.priority])).toEqual([["Urgencia", "alta"]])

    // Si el que escribe no deja el aviso, sale uno fijo: la persona nunca queda sin respuesta.
    const silent = await derive("tg:camino-mudo", "evt-camino-mudo", "Quiero hablar con una persona", new ScriptedModel(() => new AIMessage({ content: "No sé qué decir." })))
    expect(silent.handoffs).toHaveLength(1)
    expect(silent.sent).toEqual(["Recibimos tu mensaje. Una persona del equipo te va a responder por aquí."])
    expect(silent.handoffs[0]).toMatchObject({ asks: null, pending: null, notice: "Recibimos tu mensaje. Una persona del equipo te va a responder por aquí." })
    const failing_writer = await derive("tg:camino-caido", "evt-camino-caido", "Quiero hablar con una persona", new ScriptedModel(() => { throw new Error("proveedor caído") }))
    expect(failing_writer.handoffs).toHaveLength(1)
    expect(failing_writer.sent).toEqual(["Recibimos tu mensaje. Una persona del equipo te va a responder por aquí."])

    // Varios mensajes seguidos: lo que importa está en el primero y el camino lo tiene en cuenta.
    await ingestText("tg:camino-rafaga", "evt-rafaga-1", "Tengo una queja y quiero hablar con una persona")
    await ingestText("tg:camino-rafaga", "evt-rafaga-2", "Buenas")
    await ingestText("tg:camino-rafaga", "evt-rafaga-3", "Sigo esperando")
    const burst = await derive("tg:camino-rafaga", "evt-rafaga-4", "¿Me ayudan?", notifier())
    // Quien toma el caso recibe todo lo que escribió, en orden, no solo lo último.
    expect(burst.handoffs.map((item) => item.summary)).toEqual([
      "Escribió: «Tengo una queja y quiero hablar con una persona» · «Buenas» · «Sigo esperando» · «¿Me ayudan?»",
    ])
    expect(burst.sent).toEqual([notice])

    // Si no reconoce la intención, el turno es el de siempre: sin indicación de camino.
    const open = await turn("tg:camino-abierto", "evt-camino-abierto", "Les escribo por lo del otro día")
    expect(open.system).not.toContain("Camino para este mensaje")
    expect(open.decisions[0]?.outcome).toMatchObject({ path: "abierto" })
    expect(open.offered[0]).toContain("proponer_cita")
    expect(open.offered[0]).not.toContain("ampliar_herramientas")

    // Un modelo de decisión que falla no detiene el turno: camino abierto y el error queda a la vista.
    const broken: DecisionModel = { provider: "jev", reportsProbabilities: true, decide: async () => { throw new Error("caído") } }
    const failing = await ingestText("tg:camino-falla", "evt-camino-falla", "¿Cuánto cuesta una limpieza?")
    const writer = new ScriptedModel(() => toolCall("send_reply", { text: "Listo." }, "e-falla"))
    expect(await processAgentRun(appDb, { ...runtime, createModel: async () => writer, createDecisionModel: () => broken }, {
      msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId: failing.conversationId, messageId: failing.messageId },
    })).toBe("done")
    expect(systemTextOf(writer.seen[0] ?? [])).not.toContain("Camino para este mensaje")
    expect(await ledgerRows(failing.conversationId)).toEqual([{ status: "ok", llmCalls: 1, toolsUsed: ["send_reply"] }])

    // Apagado: no elige camino ni deriva; su opinión queda en sombra, como antes.
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionRoutingEnabled: false }))
    const shadow = await turn("tg:camino-apagado", "evt-camino-apagado", "Tengo una queja y quiero hablar con una persona")
    expect(shadow.calls).toBe(1)
    expect(shadow.system).not.toContain("Camino para este mensaje")
    expect(shadow.decisions).toEqual([expect.objectContaining({ point: "triage.v6", mode: "shadow", outcome: expect.objectContaining({ wouldHandoff: true }) })])
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "none", decisionRoutingEnabled: true }))
  }
})

it("al cambiar una cita, el código trae antes las citas del paciente y quedan en la traza", async () => {
  const seed = await ingestText("tg:camino-cita", "evt-camino-cita-0", "Hola")
  const fx = await bookingFixture(seed.conversationId, "camino")
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "baseline" }))
  try {
    const { conversationId, messageId } = await ingestText("tg:camino-cita", "evt-camino-cita-1", "Necesito reprogramar mi cita, por favor")
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Claro, ¿qué día te viene bien?" }, "camino-cita"))
    expect(await processAgentRun(
      appDb,
      { ...runtime, createModel: async () => model, createDecisionModel: () => createFakeDecisionModel() },
      { msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId } },
    )).toBe("done")
    const system = systemTextOf(model.seen[0] ?? [])
    expect(system).toContain("Camino para este mensaje, elegido por lo que escribió el interlocutor: cambiar o cancelar una cita.")
    expect(system).toContain("Esto se consultó ahora mismo y no hace falta volver a pedirlo:")
    expect(system).toContain("Paciente: Paciente camino (vínculo")
    expect(fx.patientId).toBeTruthy()
    // Una sola llamada: no tuvo que pedir el resumen del paciente. (El «Hola» anterior queda cubierto por esta corrida.)
    expect((await ledgerRows(conversationId)).filter((row) => row.status !== "omitida")).toEqual([
      { status: "ok", llmCalls: 1, toolsUsed: ["send_reply"] },
    ])
    const [trace] = await withOrgContext(appDb, "org_a", (tx) => listAnswerTraces(tx, "org_a", conversationId))
    expect(trace?.basis).toContainEqual({ kind: "persona", label: "Citas, presupuestos y saldo del paciente", detail: "Consultado antes de responder" })
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "none" }))
  }
})

it("el asistente clínico ordena el dictado con el esquema de la atención y no inventa si el modelo no responde bien", async () => {
  const deps = { platform: runtime.platform, secretsKey: KEY }
  const seen: BaseMessage[][] = []
  const answering = (args: Record<string, unknown> | null) => ({
    bindTools(tools: Array<{ name: string }>) {
      // El esquema que recibe el modelo sale de la declaración de campos de cada operación.
      expect(tools.map((tool) => tool.name)).toEqual(["registrar_dictado"])
      return {
        invoke: async (messages: BaseMessage[]) => {
          seen.push(messages)
          return args ? toolCall("registrar_dictado", args, "dictado-1") : new AIMessage({ content: "No entendí." })
        },
      }
    },
  })
  const extract = (args: Record<string, unknown> | null) =>
    extractDictation(appDb, { ...deps, createModel: async () => answering(args) as never }, {
      orgId: "org_a",
      transcript: "Viene por dolor al masticar. En la dieciséis hay caries en dentina, le ponemos una resina.",
    })

  const ok = await extract({
    nota: { reason: "Dolor al masticar", dicho: "Viene por dolor al masticar." },
    diagnosticos: [{ diagnosisCode: "K02.1", diagnosisType: "provisional", toothNumber: 16, dicho: "En la dieciséis hay caries en dentina" }],
    indicaciones: [{ service: "resina", toothNumber: 16 }],
    controles: [],
  })
  expect(ok.drafts).toEqual([
    { kind: "nota", payload: { reason: "Dolor al masticar" }, sourceText: "Viene por dolor al masticar." },
    { kind: "diagnostico", payload: { diagnosisCode: "K02.1", diagnosisType: "provisional", toothNumber: 16 }, sourceText: "En la dieciséis hay caries en dentina" },
    { kind: "plan", payload: { service: "resina", toothNumber: 16 }, sourceText: "" },
  ])
  const system = systemTextOf(seen[0] ?? [])
  expect(system).toContain("Registra solo lo que el odontólogo dijo.")
  expect(system).toContain("No diagnostica, no receta y no decide por el profesional.")

  // Dictado en curso: recibe lo pendiente numerado y devuelve correcciones solo sobre números que existen;
  // una cita que no está en lo dictado no se conserva.
  const live = await extractDictation(appDb, {
    ...deps,
    createModel: async () =>
      answering({
        indicaciones: [{ service: "resina", dicho: "El paciente pidió una resina" }],
        correcciones: [{ sugerencia: 1, cambios: { toothNumber: 26 }, dicho: "No, es la veintiséis" }, { sugerencia: 7, cambios: { toothNumber: 11 } }],
        quitar: [{ sugerencia: 2, dicho: "Quita el control." }, { sugerencia: 3, dicho: "Quita el control." }],
      }) as never,
  }, {
    orgId: "org_a",
    transcript: "No, es la veintiséis, y le ponemos una resina. Quita el control.",
    context: "En la veinticinco hacemos endodoncia.",
    pending: [{ label: "Plan de tratamiento: Endodoncia, Pieza 25" }, { label: "Controles: Control en 6 meses" }],
  })
  expect(live.corrections).toEqual([{ index: 0, changes: { toothNumber: 26 }, sourceText: "No, es la veintiséis" }])
  expect(live.removals).toEqual([{ index: 1, sourceText: "Quita el control." }])
  expect(live.drafts).toEqual([{ kind: "plan", payload: { service: "resina" }, sourceText: "" }])
  const asked = String(seen.at(-1)?.at(-1)?.content)
  expect(asked).toContain("1. Plan de tratamiento: Endodoncia, Pieza 25")
  expect(asked).toContain("Ya ordenado antes en este dictado")
  expect(asked).toContain("Lo nuevo que dictó:")

  // El 7 (corrección) y el 3 (quitar) no son de ninguna pendiente: no se adivina, se cuenta para avisar.
  expect(live.omitted).toBe(2)

  // Un tipo de diagnóstico que no existe no bota la pausa: llega con su dato y el servicio lo deja por revisar.
  const odd = await extract({ diagnosticos: [{ diagnosisCode: "K02.1", diagnosisType: "seguro" }], controles: [] })
  expect(odd.drafts).toEqual([{ kind: "diagnostico", payload: { diagnosisCode: "K02.1", diagnosisType: "seguro" }, sourceText: "" }])
  // Sin ninguna llamada no se ordena nada: no se inventa.
  await expect(extract(null)).rejects.toMatchObject({ code: "DICTATION_UNREADABLE" })
  await expect(extractDictation(appDb, deps, { orgId: "org_a", transcript: "  " })).rejects.toMatchObject({ code: "VALIDATION" })
  // Con el modelo de demostración responde por reglas, sin proveedor.
  expect((await extractDictation(appDb, deps, { orgId: "org_a", transcript: "Control en 3 meses." })).drafts[0]).toMatchObject({ kind: "control" })
})

it("un botón de un mensaje automático fija el camino sin preguntarle al modelo de decisión", async () => {
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { enabled: true, decisionProvider: "baseline", decisionRoutingEnabled: true }))
  let asked = 0
  const fake = createFakeDecisionModel()
  const decision = { ...fake, decide: async (...args: Parameters<typeof fake.decide>) => { asked += 1; return fake.decide(...args) } }
  try {
    const first = await ingestText("tg:boton-inasistencia", "evt-boton-1", "Hola")
    const [thread] = await ownerDb.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, first.conversationId))
    // El mensaje automático por una inasistencia, con sus botones, ya salió hacia la persona.
    const jobId = "11111111-2222-4333-8444-555555555555"
    const [sent] = await ownerDb.insert(message).values({
      organizationId: "org_a", conversationId: first.conversationId, direction: "out", senderKind: "agent",
      body: "Hola. No pudimos verte en la cita del lunes. ¿Te buscamos otro horario?",
      replyButtons: [{ id: `odentia:responder:${jobId}`, title: "Sí, otro horario" }, { id: `odentia:baja:${jobId}`, title: "No enviar más" }],
      createdAt: new Date(Date.now() + 1000),
    }).returning({ id: message.id })
    await ownerDb.insert(automationJob).values({
      id: jobId, organizationId: "org_a", kind: "seguimiento_no_asistencia", dedupeKey: `seguimiento_no_asistencia:prueba-boton`,
      scheduledFor: new Date(), status: "enviado", contactId: thread!.contactId, sentMessageId: sent!.id,
    })
    const tap = await ingestText("tg:boton-inasistencia", "evt-boton-2", "Sí, otro horario")
    await ownerDb.update(message).set({ createdAt: new Date(Date.now() + 2000) }).where(eq(message.id, tap.messageId))
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Claro, te busco otro horario." }, "boton-envio"))
    expect(await processAgentRun(appDb, { ...runtime, createModel: async () => model, createDecisionModel: () => decision }, {
      msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId: tap.conversationId, messageId: tap.messageId },
    })).toBe("done")
    // Ni el camino ni el conocimiento se le preguntaron a un modelo: el botón ya lo dice.
    expect(asked).toBe(0)
    const system = systemTextOf(model.seen[0] ?? [])
    expect(system).toContain("El interlocutor tocó el botón «Sí, otro horario» del mensaje automático de la clínica por «Una persona falta a su cita».")
    expect(system).toContain("Quiere una cita nueva")
    // Recibe las herramientas de reservar, no las de mover una cita que ya no está en pie.
    expect(model.offered[0]).toEqual(expect.arrayContaining(["buscar_huecos", "proponer_cita", "send_reply", "ampliar_herramientas"]))
    expect(model.offered[0]).not.toContain("reprogramar_cita")
    expect(await agentMessages(tap.conversationId)).toContain("Claro, te busco otro horario.")

    // Un texto cualquiera en el mismo hilo sí pasa por el modelo de decisión, como siempre.
    const free = await ingestText("tg:boton-inasistencia", "evt-boton-3", "¿Cuánto cuesta una limpieza?")
    await ownerDb.update(message).set({ createdAt: new Date(Date.now() + 5000) }).where(eq(message.id, free.messageId))
    const again = new ScriptedModel(() => toolCall("send_reply", { text: "Te cuento." }, "boton-envio-2"))
    await processAgentRun(appDb, { ...runtime, createModel: async () => again, createDecisionModel: () => decision }, {
      msg_id: 2, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId: free.conversationId, messageId: free.messageId },
    })
    expect(asked).toBeGreaterThan(0)
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "none", decisionRoutingEnabled: true }))
  }
})

it("varios mensajes seguidos nunca van por el camino «saludo», aunque el modelo de decisión lo diga", async () => {
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "baseline" }))
  // Como Jev medido: con un «gracias» al final de una ráfaga, elige saludo con confianza suficiente.
  const sayGreeting: DecisionModel = {
    provider: "fake",
    reportsProbabilities: true,
    decide: async () => ({
      answers: [
        { id: "handoff", kind: "yesno", probability: 0.05 },
        { id: "intent", kind: "choice", choice: "greeting_or_thanks", probabilities: { greeting_or_thanks: 0.7, reschedule_or_cancel: 0.3 }, confidence: 0.7 },
      ],
      model: "prueba",
      usage: null,
      latencyMs: 1,
    }),
  }
  const run = async (conversationId: string, messageId: string) => {
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Listo." }, `r-${messageId}`))
    expect(await processAgentRun(appDb, { ...runtime, createModel: async () => model, createDecisionModel: () => sayGreeting }, {
      msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId },
    })).toBe("done")
    const [logged] = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ outcome: agentDecisionLog.outcome }).from(agentDecisionLog)
        .where(and(eq(agentDecisionLog.conversationId, conversationId), eq(agentDecisionLog.mode, "route")))
        .orderBy(desc(agentDecisionLog.createdAt)).limit(1))
    return { path: (logged?.outcome as { path?: string } | undefined)?.path, offered: model.offered[0] ?? [] }
  }
  try {
    // «Quiero cancelar… / Gracias»: el camino queda abierto y el que escribe tiene con qué cancelar.
    await ingestText("tg:rafaga-saludo", "evt-rafaga-1", "Quiero cancelar mi cita del viernes")
    const last = await ingestText("tg:rafaga-saludo", "evt-rafaga-2", "Gracias")
    const burst = await run(last.conversationId, last.messageId)
    expect(burst.path).toBe("abierto")
    expect(burst.offered).toContain("cancelar_cita")
    // Un «gracias» solo sigue siendo saludo: respuesta breve y barata.
    const alone = await ingestText("tg:rafaga-solo", "evt-rafaga-solo", "Gracias")
    const single = await run(alone.conversationId, alone.messageId)
    expect(single.path).toBe("saludo")
    expect(single.offered).not.toContain("cancelar_cita")
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "none" }))
  }
})

/* ---------- Ninguna conversación queda abierta (ADR 0024) ---------- */

it("el agente no corre en una conversación cerrada", async () => {
  const { conversationId, messageId } = await ingestText("tg:cerrada", "evt-cerrada-1", "Hola")
  await withOrgContext(appDb, "org_a", (tx) => closeConversationWith(tx, "org_a", conversationId, { reason: "manual", byUserId: null }))
  const model = new ScriptedModel(() => toolCall("send_reply", { text: "No debería salir." }, "call-cerrada"))
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(model.seen).toHaveLength(0)
  expect(await agentMessages(conversationId)).toEqual([])
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ status: agentRunLedger.status, error: agentRunLedger.error }).from(agentRunLedger).where(eq(agentRunLedger.conversationId, conversationId)))
  expect(rows).toEqual([{ status: "omitida", error: "conversation-closed" }])
})

it("despedirse_y_cerrar se despide y cierra como resuelta; con una propuesta esperando el sí, no cierra", async () => {
  const { conversationId, messageId } = await ingestText("tg:despedida", "evt-despedida-1", "Muchas gracias, eso era todo")
  const bye = new ScriptedModel(() => toolCall("despedirse_y_cerrar", { text: "Gracias a ti. Cuando quieras retomar, escríbenos: estamos atentos." }, "call-bye"))
  expect(await runScripted(bye, conversationId, messageId)).toBe("done")
  expect(bye.tools).toContain("despedirse_y_cerrar")
  expect(await agentMessages(conversationId)).toEqual(["Gracias a ti. Cuando quieras retomar, escríbenos: estamos atentos."])
  const [closed] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ status: conversation.status, closeReason: conversation.closeReason, closedByUserId: conversation.closedByUserId }).from(conversation).where(eq(conversation.id, conversationId)))
  expect(closed).toEqual({ status: "closed", closeReason: "resuelta", closedByUserId: null })
  expect((await ledgerRows(conversationId)).map((row) => row.status)).toEqual(["ok"])

  // Con algo pendiente, «gracias» no cierra: el modelo recibe por qué y responde.
  const pending = await ingestText("tg:despedida-pendiente", "evt-despedida-2", "Gracias")
  const [thread] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, pending.conversationId)))
  await ownerDb.insert(agentProposal).values({
    organizationId: "org_a", conversationId: pending.conversationId, contactId: thread!.contactId, action: "reservar_cita",
    payload: { startsAt: new Date(Date.now() + 86_400_000).toISOString() }, afterSummary: "Cita", idempotencyKey: randomUUID(),
  })
  const careful = new ScriptedModel((_messages, call) =>
    call === 1
      ? toolCall("despedirse_y_cerrar", { text: "Gracias, estamos atentos." }, "call-bye-1")
      : toolCall("send_reply", { text: "¡De nada! ¿Te confirmo la cita?" }, "call-bye-2"))
  expect(await runScripted(careful, pending.conversationId, pending.messageId)).toBe("done")
  expect(String(careful.seen[1]?.at(-1)?.content)).toContain("No cerrado")
  expect(await agentMessages(pending.conversationId)).toEqual(["¡De nada! ¿Te confirmo la cita?"])
  const [open] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ status: conversation.status }).from(conversation).where(eq(conversation.id, pending.conversationId)))
  expect(open?.status).toBe("open")
})

it("un error que se repite deriva y avisa a la persona con el texto fijo", async () => {
  const { conversationId, messageId } = await ingestText("tg:error-repetido", "evt-error-1", "Hola")
  const broken = processAgentRun(appDb, { ...runtime, createModel: async () => { throw new Error("modelo caído") } }, {
    msg_id: 1,
    read_ct: 2,
    message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId },
  })
  expect(await broken).toBe("done")
  expect(await agentStatusOf(conversationId)).toBe("on")
  expect(await agentMessages(conversationId)).toEqual([HANDOFF_NOTICE])
})

it("pospuesta hasta que abre su horario, la corrida atiende todo lo que quedó sin responder aunque sea antiguo", async () => {
  const first = await ingestText("tg:pospuesta", "evt-pospuesta-1", "Hola, ¿atienden mañana?")
  const second = await ingestText("tg:pospuesta", "evt-pospuesta-2", "Es para una limpieza")
  // Escribió de noche: hace cinco horas, mucho más que la ventana de ráfaga.
  await ownerDb.update(message).set({ createdAt: new Date(Date.now() - 5 * 3_600_000) }).where(eq(message.id, first.messageId))
  await ownerDb.update(message).set({ createdAt: new Date(Date.now() - 5 * 3_600_000 + 60_000) }).where(eq(message.id, second.messageId))
  const model = new ScriptedModel(() => toolCall("send_reply", { text: "Sí, mañana atendemos." }, "call-pospuesta"))
  const result = await processAgentRun(appDb, { ...runtime, createModel: async () => model }, {
    msg_id: 1,
    read_ct: 0,
    message: { kind: "inbound_message", orgId: "org_a", conversationId: first.conversationId, messageId: first.messageId, deferred: true },
  })
  expect(result).toBe("done")
  expect(await agentMessages(first.conversationId)).toEqual(["Sí, mañana atendemos."])
  // El otro mensaje quedó atendido por la misma corrida: su propia corrida no vuelve a responder.
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ trigger: agentRunLedger.triggerMessageId, status: agentRunLedger.status, error: agentRunLedger.error }).from(agentRunLedger)
      .where(eq(agentRunLedger.conversationId, first.conversationId)))
  expect(rows).toContainEqual({ trigger: first.messageId, status: "omitida", error: "burst-covered" })
  expect(rows).toContainEqual({ trigger: second.messageId, status: "ok", error: null })
})

it("buscar_huecos nunca muestra el usuario del profesional: proponer_cita recibe su referencia y el servidor la resuelve", async () => {
  const { conversationId } = await ingestText("tg:ref-profesional", "evt-ref-profesional", "Quiero una cita")
  const fx = await bookingFixture(conversationId, "ref-profesional")
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId: fx.contactId,
    triggerId: null, secretsKey: KEY, dryRun: false, handedOff: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const tools = makeAgentTools(ctx)
  const day = upcomingMonday()
  const gaps = String(await tools.find((t) => t.name === "buscar_huecos")!.invoke({
    branchId: fx.branchId, from: day.toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString(), durationMin: 45,
  }))
  expect(gaps).not.toContain(fx.professionalId)
  const line = gaps.split("\n").find((row) => row.startsWith("- "))!
  const ref = line.match(/profesional (pro-[0-9a-f]{10})\]/)?.[1]
  expect(ref).toBe(professionalRef("org_a", fx.professionalId))
  const propose = tools.find((t) => t.name === "proponer_cita")!
  const slot = { patientId: fx.patientId, roomId: fx.roomId, branchId: fx.branchId, startsAt: line.match(ISO_INSTANT)![0], durationMin: 45 }
  // Un id de usuario escrito por el modelo no sirve.
  expect(String(await propose.invoke({ ...slot, professionalUserId: fx.professionalId }))).toContain("no es de un hueco de buscar_huecos")
  await propose.invoke({ ...slot, professionalUserId: ref })
  const [proposal] = await withOrgContext(appDb, "org_a", (tx) => listProposals(tx, "org_a", { conversationId, status: "propuesta" }))
  expect(proposal?.payload).toMatchObject({ professionalUserId: fx.professionalId })
})

/** Un modelo que, mientras «redacta», deja que pase algo en la base (el equipo toma o cierra la conversación). */
class SlowScriptedModel extends ScriptedModel {
  constructor(
    script: (messages: BaseMessage[], call: number) => AIMessage,
    private readonly meanwhile: () => Promise<unknown>,
  ) {
    super(script)
  }
  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    await this.meanwhile()
    return super._generate(messages)
  }
}

it("si el equipo toma o cierra la conversación mientras el modelo escribe, lo redactado no sale ni se cobra", async () => {
  for (const [thread, meanwhile] of [
    ["tg:tomada-en-curso", (id: string) => ownerDb.update(conversation).set({ agentStatus: "off" }).where(eq(conversation.id, id))],
    ["tg:cerrada-en-curso", (id: string) => withOrgContext(appDb, "org_a", (tx) => closeConversationWith(tx, "org_a", id, { reason: "manual", byUserId: null }))],
  ] as const) {
    const { conversationId, messageId } = await ingestText(thread, `evt-${thread}`, "Hola, ¿tienen cita el lunes?")
    const model = new SlowScriptedModel(
      () => toolCall("send_reply", { text: "Sí, el lunes a primera hora." }, "call-1"),
      () => meanwhile(conversationId),
    )
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    expect(model.seen).toHaveLength(1)
    expect(await agentMessages(conversationId)).toEqual([])
    const [row] = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ status: agentRunLedger.status, error: agentRunLedger.error }).from(agentRunLedger).where(eq(agentRunLedger.conversationId, conversationId)))
    expect(row).toEqual({ status: "omitida", error: "team-took-over" })
    const [conv] = await ownerDb.select({ status: conversation.status }).from(conversation).where(eq(conversation.id, conversationId))
    expect(conv?.status).toBe(thread === "tg:cerrada-en-curso" ? "closed" : "open")
  }
})

it("si la persona sigue escribiendo mientras el modelo responde, lo redactado no sale: lo responde la corrida de su último mensaje (ADR 0097)", async () => {
  const { conversationId, messageId } = await ingestText("tg:sigue-escribiendo", "evt-sigue-1", "tengo un problema")
  const model = new SlowScriptedModel(
    () => toolCall("send_reply", { text: "¿Qué problema tienes?" }, "call-1"),
    // Mientras escribe, llega el resto: «en el diente», con su corrida en la cola como en el worker.
    async () => {
      const next = await ingestText("tg:sigue-escribiendo", "evt-sigue-2", "en el diente")
      await withOrgContext(appDb, "org_a", (tx) =>
        sendAgentRun(tx, { kind: "inbound_message", orgId: "org_a", conversationId, messageId: next.messageId }, { delaySeconds: 600 }))
      return next
    },
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(await agentMessages(conversationId)).toEqual([])
  const [row] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ status: agentRunLedger.status, error: agentRunLedger.error }).from(agentRunLedger).where(eq(agentRunLedger.conversationId, conversationId)))
  expect(row).toEqual({ status: "omitida", error: "persona-siguio-escribiendo" })
  // No queda como «sin respuesta» ni pasa a una persona: la siguiente corrida responde todo junto.
  expect(await ownerDb.select().from(agentHandoff).where(eq(agentHandoff.conversationId, conversationId))).toEqual([])
})

it("con lo que llegó mientras el modelo pensaba, no hace lo que decidió con lo de antes, pero guarda lo que dijo (auditoría del ADR 0104)", async () => {
  const { conversationId, messageId } = await ingestText("tg:sigue-antes-de-actuar", "evt-actuar-1", "mañana a las 10")
  const model = new SlowScriptedModel(
    () =>
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "anotar_caso", args: { preferencia: "mañana a las 10" }, id: "call-nota", type: "tool_call" },
          { name: "buscar_huecos", args: { branchId: "x", from: "2026-11-02" }, id: "call-huecos", type: "tool_call" },
        ],
      }),
    // Mientras piensa, la persona corrige la hora: buscar con lo de antes ya no vale.
    async () => {
      const next = await ingestText("tg:sigue-antes-de-actuar", "evt-actuar-2", "no, mejor a las 11")
      await withOrgContext(appDb, "org_a", (tx) =>
        sendAgentRun(tx, { kind: "inbound_message", orgId: "org_a", conversationId, messageId: next.messageId }, { delaySeconds: 600 }))
      return next
    },
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  const state = await withOrgContext(appDb, "org_a", (tx) => getAgentCaseState(tx, "org_a", conversationId))
  // Lo que dijo queda (la siguiente corrida anota encima lo último); la búsqueda no se hizo.
  expect(state.notes.map((note) => note.text)).toEqual(["mañana a las 10"])
  expect(state.lookups).toEqual([])
  const [row] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ status: agentRunLedger.status, error: agentRunLedger.error }).from(agentRunLedger).where(eq(agentRunLedger.conversationId, conversationId)))
  expect(row).toEqual({ status: "omitida", error: "persona-siguio-escribiendo" })
})

it("lo que llega sin corrida propia (un botón, «BAJA») no hace descartar la respuesta (ADR 0097)", async () => {
  const { conversationId, messageId } = await ingestText("tg:boton-mientras", "evt-boton-1", "¿atienden el sábado?")
  const model = new SlowScriptedModel(
    () => toolCall("send_reply", { text: "Sí, atendemos los sábados." }, "call-1"),
    // El toque de un botón lo resuelve el sistema: no encola otra corrida.
    () => ingestText("tg:boton-mientras", "evt-boton-2", "Confirmar"),
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(await agentMessages(conversationId)).toEqual(["Sí, atendemos los sábados."])
})

it("quien escribe mucho sigue atendido: no hay tope por persona ni por día (ADR 0085)", async () => {
  const { conversationId, messageId } = await ingestText("tg:sin-parar", "evt-sin-parar", "Hola otra vez")
  await ownerDb.insert(agentRunLedger).values(
    Array.from({ length: 60 }, () => ({
      organizationId: "org_a", conversationId, model: "fake", status: "ok", startedAt: new Date(), llmCalls: 1,
    })),
  )
  const model = new ScriptedModel(() => toolCall("send_reply", { text: "Hola, dime en qué te ayudo." }, "call-1"))
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(model.seen).toHaveLength(1)
  expect(await agentMessages(conversationId)).toEqual(["Hola, dime en qué te ayudo."])
})

it("lo que no es de la clínica recibe el texto fijo una sola vez al día; después, silencio sin cobro ni tema", async () => {
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "baseline", decisionRoutingEnabled: true }))
  // Muy seguro de que no es de la clínica, salvo cuando lo último que escribió pregunta por una limpieza.
  const decision: DecisionModel = {
    provider: "fake",
    reportsProbabilities: true,
    decide: async (state) => {
      const latest = state.slice(state.indexOf("Contact (latest"))
      const intent = latest.includes("limpieza") ? "price_or_service_info" : "off_topic"
      return {
        answers: [
          { id: "handoff", kind: "yesno", probability: 0.02 },
          { id: "intent", kind: "choice", choice: intent, probabilities: { [intent]: 0.97, other: 0.03 }, confidence: 0.97 },
        ],
        model: "prueba",
        usage: null,
        latencyMs: 1,
      }
    },
  }
  const writer = new ScriptedModel(() => toolCall("send_reply", { text: "Te cuento lo de la limpieza." }, "fuera-de-tema-limpieza"))
  const run = async (eventId: string, text: string) => {
    const inbound = await ingestText("tg:fuera-de-tema", eventId, text)
    expect(await processAgentRun(appDb, { ...runtime, createModel: async () => writer, createDecisionModel: () => decision }, {
      msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: "org_a", conversationId: inbound.conversationId, messageId: inbound.messageId },
    })).toBe("done")
    return inbound
  }
  // Lo que salió del agente, en el orden en que salió.
  const sent = async (conversationId: string) =>
    (await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ body: message.body }).from(message)
        .where(and(eq(message.conversationId, conversationId), eq(message.senderKind, "agent")))
        .orderBy(message.createdAt, message.id))).map((row) => row.body ?? "")
  const runOf = async (conversationId: string, trigger: string) => {
    const [row] = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ status: agentRunLedger.status, llmCalls: agentRunLedger.llmCalls, error: agentRunLedger.error }).from(agentRunLedger)
        .where(and(eq(agentRunLedger.conversationId, conversationId), eq(agentRunLedger.triggerMessageId, trigger))))
    return row
  }
  try {
    const cfg = await withOrgContext(appDb, "org_a", (tx) => getAgentConfig(tx, "org_a"))
    const fixed = offTopicReply(cfg.treatment, cfg.personaName, "Clínica", !cfg.disabledFunctions.includes("informar"))
    const first = await run("evt-fuera-1", "¿Quién ganó el partido de anoche?")
    expect(await sent(first.conversationId)).toEqual([fixed])
    expect(await runOf(first.conversationId, first.messageId)).toEqual({ status: "ok", llmCalls: 0, error: null })

    // La respuesta automática de otro negocio, o un bot, sigue escribiendo: no recibe el texto otra vez.
    const second = await run("evt-fuera-2", "Gracias por su mensaje, en breve le atenderemos.")
    expect(await sent(first.conversationId)).toEqual([fixed])
    expect(await runOf(first.conversationId, second.messageId)).toEqual({ status: "omitida", llmCalls: 0, error: "fuera-de-tema-repetido" })
    expect(writer.seen).toHaveLength(0)

    // Lo de la clínica se sigue atendiendo como siempre.
    await run("evt-fuera-3", "¿Cuánto cuesta una limpieza?")
    expect(writer.seen).toHaveLength(1)
    expect(await sent(first.conversationId)).toEqual([fixed, "Te cuento lo de la limpieza."])

    // Y lo ajeno, el mismo día, sigue sin respuesta.
    const fourth = await run("evt-fuera-4", "¿Y quién juega mañana?")
    expect(await sent(first.conversationId)).toEqual([fixed, "Te cuento lo de la limpieza."])
    expect(await runOf(first.conversationId, fourth.messageId)).toEqual({ status: "omitida", llmCalls: 0, error: "fuera-de-tema-repetido" })
    // Nada de esto es un tema para el equipo.
    const handoffs = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ id: agentHandoff.id }).from(agentHandoff).where(eq(agentHandoff.conversationId, first.conversationId)))
    expect(handoffs).toEqual([])
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "none" }))
  }
})

it("una imagen sin texto llega al modelo dicha como imagen que no puede ver, no como «[adjunto]»", async () => {
  const { conversationId } = await ingestText("tg:imagen", "evt-imagen-1", "Les mando la foto")
  const [image] = await ownerDb
    .insert(message)
    .values({
      organizationId: "org_a", conversationId, direction: "in", senderKind: "contact", status: "received",
      contentType: "image", body: null, externalId: "evt-imagen-2", createdAt: new Date(Date.now() + 1000),
    })
    .returning({ id: message.id })
  const model = new ScriptedModel(() => toolCall("send_reply", { text: "Gracias, ¿qué te molesta?" }, "call-1"))
  expect(await runScripted(model, conversationId, image!.id)).toBe("done")
  const said = model.seen[0]!.map((m) => String(m.content)).join("\n")
  expect(said).toContain("Envió una imagen que no puedes ver")
  expect(said).not.toContain("[adjunto]")
})

it("quien responde citando uno de dos avisos de cita llega al modelo con el aviso que citó, aunque sea más viejo que lo leído", async () => {
  // darvin2c/odentIA#96: Rosa cita el segundo aviso y escribe «esta no puedo».
  const { conversationId } = await ingestText("tg:cita-citada", "evt-cita-0", "Hola")
  // Los avisos y lo que siguió, antes de esta atención; la respuesta de Rosa llega ahora.
  const at = (seconds: number) => new Date(Date.now() - 3_600_000 + seconds * 1000)
  const out = (body: string, externalId: string, seconds: number) => ({
    organizationId: "org_a", conversationId, direction: "out", senderKind: "agent", status: "sent",
    contentType: "text", body, externalId, createdAt: at(seconds),
  })
  await ownerDb.insert(message).values([
    out("Tu cita de limpieza es el martes 20 a las 10:00", "tg:cita-citada:101", 1),
    out("Tu control de ortodoncia es el jueves 22 a las 15:00", "tg:cita-citada:102", 2),
    // Después se habló de otra cosa: los avisos quedan fuera de lo que lee el agente (la atención y los últimos 20).
    ...Array.from({ length: 20 }, (_, n) => out(`Te cuento lo del pago, parte ${n + 1}.`, `tg:cita-citada:${200 + n}`, 3 + n)),
  ])
  const { messageId } = await withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId: tgConnId,
        event: {
          externalEventId: "evt-cita-1",
          externalMessageId: "evt-cita-1",
          externalThreadId: "tg:cita-citada",
          senderExternalId: "tg:cita-citada",
          senderDisplayName: "Rosa",
          content: { type: "text", text: "esta no puedo" },
          replyToExternalId: "tg:cita-citada:102",
          sentAt: at(30).toISOString(),
        },
      },
      telegramBotApiAdapter,
      { storage: storageStub, fetch, secretsKey: KEY },
    ),
  )
  const model = new ScriptedModel(() => toolCall("send_reply", { text: "Entiendo, ¿movemos el control del jueves?" }, "call-1"))
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  const said = model.seen[0]!.map((m) => String(m.content)).join("\n")
  expect(said).toContain("[En respuesta a: «Tu control de ortodoncia es el jueves 22 a las 15:00»] esta no puedo")
  expect(said).not.toContain("Tu cita de limpieza es el martes 20")
})

it("un mensaje reenviado llega al modelo marcado: no lo escribió la persona (fase 7 de la Bandeja)", async () => {
  const { conversationId } = await ingestText("tg:reenvio", "evt-reenvio-0", "Hola")
  const { messageId } = await withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId: tgConnId,
        event: {
          externalEventId: "evt-reenvio-1",
          externalMessageId: "evt-reenvio-1",
          externalThreadId: "tg:reenvio",
          senderExternalId: "tg:reenvio",
          senderDisplayName: "Rosa",
          content: { type: "text", text: "Promo 2x1 en blanqueamiento hasta el viernes" },
          forwarded: true,
          sentAt: new Date().toISOString(),
        },
      },
      telegramBotApiAdapter,
      { storage: storageStub, fetch, secretsKey: KEY },
    ),
  )
  const model = new ScriptedModel(() =>
    toolCall("send_reply", { text: "Esa promoción no es nuestra." }, "call-1"),
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  const said = model.seen[0]!.map((m) => String(m.content)).join("\n")
  expect(said).toContain("[Reenviado: no lo escribió la persona.")
  expect(said).toContain("Promo 2x1 en blanqueamiento hasta el viernes")
})

/** El estado de Spam de la persona de una conversación. */
async function screenOf(conversationId: string) {
  const [row] = await ownerDb.execute<{ screen: string | null; reason: string | null; contact_id: string }>(sql`
    select c.screen, c.screen_reason as reason, c.id as contact_id from contact c
    join conversation cv on cv.contact_id = c.id where cv.id = ${conversationId}`)
  return row
}

async function runWithDecision(model: ScriptedModel, conversationId: string, messageId: string) {
  // Otras pruebas cambian la configuración: aquí el modelo de decisión elige el camino.
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { enabled: true, decisionProvider: "jev", decisionRoutingEnabled: true }))
  return processAgentRun(appDb, { ...runtime, createModel: async () => model, createDecisionModel: () => createFakeDecisionModel() }, {
    msg_id: 1,
    read_ct: 0,
    message: { kind: "inbound_message", orgId: "org_a", conversationId, messageId },
  })
}

async function ledgerErrors(conversationId: string) {
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ status: agentRunLedger.status, llmCalls: agentRunLedger.llmCalls, error: agentRunLedger.error })
      .from(agentRunLedger).where(eq(agentRunLedger.conversationId, conversationId)).orderBy(agentRunLedger.startedAt))
  return rows
}

async function chargedConversations(conversationId: string) {
  const [row] = await ownerDb.execute<{ n: number }>(sql`select count(*)::int as n from saas_action where conversation_id = ${conversationId}`)
  return row?.n ?? 0
}

it("Jev muy seguro manda a Spam el primer mensaje de publicidad: sin respuesta, sin modelo y sin cobro (ADR 0054)", async () => {
  const model = new ScriptedModel(() => toolCall("send_reply", { text: "Hola, ¿en qué te ayudo?" }, "call-1"))
  const ad = await ingestText("tg:spam-jev", "evt-spam-jev-1", "GANA DINERO desde casa 💸 entra a bit.ly/gana-ya")
  expect(await runWithDecision(model, ad.conversationId, ad.messageId)).toBe("done")
  expect(model.seen).toHaveLength(0)
  expect(await agentMessages(ad.conversationId)).toEqual([])
  expect(await ledgerErrors(ad.conversationId)).toEqual([{ status: "omitida", llmCalls: 0, error: "spam" }])
  expect(await chargedConversations(ad.conversationId)).toBe(0)
  expect(await screenOf(ad.conversationId)).toMatchObject({ screen: "spam", reason: "publicidad" })
  const decided = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ outcome: agentDecisionLog.outcome }).from(agentDecisionLog).where(eq(agentDecisionLog.conversationId, ad.conversationId)))
  expect(decided[0]?.outcome).toMatchObject({ spam: { reason: "publicidad" } })
})

it("en Spam, lo nuevo que también es spam se queda; lo que no, la saca sola y el agente responde (decisión 9a)", async () => {
  const model = new ScriptedModel(() => toolCall("send_reply", { text: "Sí, atendemos los sábados de 9 a 13." }, "call-1"))
  const ad = await ingestText("tg:spam-sale", "evt-spam-sale-1", "Préstamo al instante sin requisitos, escribe ya")
  expect(await runWithDecision(model, ad.conversationId, ad.messageId)).toBe("done")
  expect(await screenOf(ad.conversationId)).toMatchObject({ screen: "spam" })
  // Otra publicidad: se queda en Spam, sin respuesta.
  const again = await ingestText("tg:spam-sale", "evt-spam-sale-2", "Último día: préstamo con bit.ly/prestamo")
  expect(await runWithDecision(model, again.conversationId, again.messageId)).toBe("done")
  expect(await screenOf(again.conversationId)).toMatchObject({ screen: "spam" })
  expect(model.seen).toHaveLength(0)
  // Algo real: sale sola de Spam y el agente le responde.
  const real = await ingestText("tg:spam-sale", "evt-spam-sale-3", "Perdón, número equivocado. ¿Atienden el sábado?")
  expect(await runWithDecision(model, real.conversationId, real.messageId)).toBe("done")
  expect((await screenOf(real.conversationId))?.screen).toBeNull()
  expect(await agentMessages(real.conversationId)).toEqual(["Sí, atendemos los sábados de 9 a 13."])
  expect((await ledgerErrors(real.conversationId)).map((row) => row.error)).toEqual(["spam", "spam-sigue", null])
  const left = await ownerDb.execute<{ action: string }>(sql`select action from audit_event
    where entity = 'contact' and entity_id = ${(await screenOf(real.conversationId))!.contact_id} order by created_at`)
  expect(left.map((row) => row.action)).toEqual(["contact.spam_marked", "contact.spam_left"])
})

it("quien no puede ir solo a Spam (el equipo ya le escribió) recibe respuesta aunque mande publicidad", async () => {
  const model = new ScriptedModel(() => toolCall("send_reply", { text: "Hola, ¿en qué te ayudo?" }, "call-1"))
  const first = await ingestText("tg:spam-protegido", "evt-spam-prot-1", "Hola")
  await ownerDb.execute(sql`insert into "user" (id, name, email, email_verified) values ('u_agent_team', 'Carla', 'carla@team.test', true) on conflict (id) do nothing`)
  await withOrgContext(appDb, "org_a", (tx) =>
    sendOutbound(tx, "org_a", { conversationId: first.conversationId, senderKind: "user", senderUserId: "u_agent_team", content: { type: "text", text: "Hola, soy Carla" } }))
  // Escribió hace una hora: el agente ya no espera a que el equipo termine de conversar.
  await ownerDb.execute(sql`update message set created_at = now() - interval '1 hour' where conversation_id = ${first.conversationId}`)
  const ad = await ingestText("tg:spam-protegido", "evt-spam-prot-2", "GANA DINERO con bit.ly/gana")
  expect(await runWithDecision(model, ad.conversationId, ad.messageId)).toBe("done")
  expect((await screenOf(ad.conversationId))?.screen).toBeNull()
  expect(await agentMessages(ad.conversationId)).toEqual(["Hola, ¿en qué te ayudo?"])
})

it("a un bloqueado el agente no le responde, no llama al modelo y no se cobra; sin decisión, quien está en Spam se queda (ADR 0054)", async () => {
  const model = new ScriptedModel(() => toolCall("send_reply", { text: "No debería salir." }, "call-1"))
  await ownerDb.execute(sql`insert into "user" (id, name, email, email_verified) values ('u_agent_test', 'Carla', 'carla@agente.test', true) on conflict (id) do nothing`)
  const threat = await ingestText("tg:pantalla-blocked", "evt-pantalla-blocked", "Esto no se queda así")
  await ownerDb.execute(sql`update contact set screen = 'blocked', screened_at = now(), screened_by_user_id = 'u_agent_test',
    screen_reason = 'amenazas', screen_note = 'Amenazó a recepción' where id = ${(await screenOf(threat.conversationId))!.contact_id}`)
  expect(await runWithDecision(model, threat.conversationId, threat.messageId)).toBe("done")
  expect(await ledgerErrors(threat.conversationId)).toEqual([{ status: "omitida", llmCalls: 0, error: "bloqueado" }])

  const spam = await ingestText("tg:pantalla-spam", "evt-pantalla-spam", "Hola, ¿tienen cita?")
  await ownerDb.execute(sql`update contact set screen = 'spam', screened_at = now(), screen_reason = 'repeticion'
    where id = ${(await screenOf(spam.conversationId))!.contact_id}`)
  // Sin modelo de decisión que lo mire, no sale de Spam.
  expect(await processAgentRun(appDb, { ...runtime, createModel: async () => model, createDecisionModel: () => null }, {
    msg_id: 1,
    read_ct: 0,
    message: { kind: "inbound_message", orgId: "org_a", conversationId: spam.conversationId, messageId: spam.messageId },
  })).toBe("done")
  expect(await ledgerErrors(spam.conversationId)).toEqual([{ status: "omitida", llmCalls: 0, error: "spam-sin-decision" }])
  expect(model.seen).toHaveLength(0)
  expect(await chargedConversations(threat.conversationId) + await chargedConversations(spam.conversationId)).toBe(0)
})
