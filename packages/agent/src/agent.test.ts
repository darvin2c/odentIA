process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { once } from "node:events"
import { createServer } from "node:http"
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { telegramBotApiAdapter } from "@odentia/channels"
import { createAppDb, createOwnerDb, type Db, setupAgentMemory, withOrgContext } from "@odentia/db"
import { contactIdentity, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { agentDecisionLog, agentHandoff, agentRunLedger } from "@odentia/db/schema/agent"
import {
  addContactIdentity,
  createChair,
  createConnection,
  createContact,
  decideProposal,
  createAppointment,
  moveAppointment,
  claimHandoff,
  createHandoff,
  updateTask,
  getAgentConfig,
  getAgentLlmSecrets,
  getAutonomyPolicy,
  ingestInbound,
  listHandoffs,
  createTask,
  listProposals,
  listOpportunities,
  moveContactIdentity,
  nextPatientNumber,
  secretsKeyFromEnv,
  setPatientContact,
  setProfessionalSchedule,
  updateAutonomyPolicy,
  upsertAgentConfig,
} from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { FAKE_REPLY_TEXT } from "./fake-model.js"
import { type AgentRuntime, processAgentRun } from "./run.js"
import { compileAgentGraph } from "./graph.js"
import { makeAgentTools, type AgentToolCtx } from "./tools.js"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { user } from "@odentia/db/schema/auth"
import { branch, auditEvent } from "@odentia/db/schema/org"
import { patient } from "@odentia/db/schema/clinical"
import { appointment } from "@odentia/db/schema/agenda"
import { workspaceNotification } from "@odentia/db/schema/workspace"

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

async function agentMessages(conversationId: string): Promise<string[]> {
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ body: message.body })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.senderKind, "agent"))),
  )
  return rows.map((r) => r.body ?? "")
}

async function runAgent(conversationId: string, messageId: string, readCt = 0) {
  return processAgentRun(appDb, runtime, {
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
    sql`insert into "org_profile" ("organization_id", "legal_name") values ('org_a', 'Clínica') on conflict do nothing`,
  )
  const checkpointer = PostgresSaver.fromConnString(ownerUri)
  await checkpointer.setup()
  await setupAgentMemory(ownerDb)
  runtime = { checkpointer, platform: { modelName: "fake", allowInsecureBaseUrl: true }, secretsKey: KEY }
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
  await runtime?.checkpointer.end().catch(() => {})
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
  expect(conv?.agentStatus).toBe("off")
  expect(await agentMessages(conversationId)).toEqual([])
  const tasks = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ title: crmTask.title })
      .from(crmTask)
      .where(eq(crmTask.conversationId, conversationId)),
  )
  expect(tasks.some((t) => t.title.startsWith("Derivación"))).toBe(true)
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
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0, reported: false, cacheReported: false }
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
  override bindTools(): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages)
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
    expect(await agentStatusOf(conversationId)).toBe("off")
    expect(await agentMessages(conversationId)).toEqual([])
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

it("texto sin herramienta de envío queda como sin_respuesta y avisa al equipo sin derivar", async () => {
  const stamp = Date.now()
  const receptionId = `agent-reception-${stamp}`
  await ownerDb.insert(user).values({ id: receptionId, name: "Recepción", email: `recepcion-${stamp}@example.test` })
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${receptionId}`}, 'org_a', ${receptionId}, 'reception', now())`)
  const { conversationId, messageId } = await ingestText("tg:ag-mudo", "evt-ag-mudo", "¿Atienden sábados?")
  const model = new ScriptedModel(() => new AIMessage({ content: "Sí, atendemos los sábados." }))
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(await agentMessages(conversationId)).toEqual([])
  expect(await agentStatusOf(conversationId)).toBe("on")
  expect(await ledgerRows(conversationId)).toEqual([{ status: "sin_respuesta", llmCalls: 1, toolsUsed: [] }])
  const notices = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ title: workspaceNotification.title, href: workspaceNotification.href })
      .from(workspaceNotification)
      .where(eq(workspaceNotification.userId, receptionId)),
  )
  expect(notices).toEqual([{ title: "El agente no respondió", href: `/inbox?conversation=${conversationId}` }])
  // Una corrida sin respuesta no da el mensaje por atendido: reprocesarlo
  // vuelve a llamar al modelo, y no duplica el aviso.
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(model.seen).toHaveLength(2)
  const again = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ id: workspaceNotification.id })
      .from(workspaceNotification)
      .where(eq(workspaceNotification.userId, receptionId)),
  )
  expect(again.length).toBe(1)
})

it("lo que lanza una herramienta vuelve al modelo como mensaje de error y no reintenta la corrida", async () => {
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { enabled: true, maxTurns: 10 }))
  const { conversationId, messageId } = await ingestText("tg:ag-toolerr", "evt-ag-toolerr", "Necesito ayuda")
  const model = new ScriptedModel((_messages, call) =>
    call === 1
      ? toolCall(
          "request_human_handoff",
          { reason: "Pide ayuda", summary: "Pide ayuda", priority: "media", assigneeUserId: "no-es-miembro" },
          "call-1",
        )
      : toolCall("send_reply", { text: "Enseguida te ayudamos." }, "call-2"),
  )
  expect(await runScripted(model, conversationId, messageId)).toBe("done")
  expect(model.seen.length).toBe(2)
  const second = model.seen[1] ?? []
  const last = second[second.length - 1]
  expect(last?.getType()).toBe("tool")
  expect(String(last?.content)).toContain("El responsable no es miembro de la organización")
  expect(await agentStatusOf(conversationId)).toBe("on")
  expect(await agentMessages(conversationId)).toEqual(["Enseguida te ayudamos."])
  expect(await ledgerRows(conversationId)).toEqual([
    { status: "ok", llmCalls: 2, toolsUsed: ["request_human_handoff", "send_reply"] },
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
  expect(await agentStatusOf(conversationId)).toBe("off")
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

it("el proveedor propio se guarda cifrado como par URL+clave, se audita y nunca sale a la lectura", async () => {
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      upsertAgentConfig(tx, "org_a", { llmApiKey: "sk-propia" }, { secretsKey: KEY, allowInsecureBaseUrl: true }),
    ),
  ).rejects.toThrow(/URL base/)
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      upsertAgentConfig(tx, "org_a", { llmBaseUrl: "https://10.0.0.5/v1", llmApiKey: "sk-propia" }, { secretsKey: KEY }),
    ),
  ).rejects.toThrow(/privada/)
  const saved = await withOrgContext(appDb, "org_a", (tx) =>
    upsertAgentConfig(
      tx,
      "org_a",
      { llmBaseUrl: "https://proveedor.example/v1", llmApiKey: "sk-propia", model: "modelo-propio" },
      { secretsKey: KEY, actorUserId: null },
    ),
  )
  expect(saved).toMatchObject({ llmBaseUrl: "https://proveedor.example/v1", hasLlmApiKey: true, model: "modelo-propio" })
  expect(JSON.stringify(saved)).not.toContain("sk-propia")
  const secrets = await withOrgContext(appDb, "org_a", (tx) => getAgentLlmSecrets(tx, "org_a", KEY))
  expect(secrets).toEqual({ baseUrl: "https://proveedor.example/v1", apiKey: "sk-propia" })
  const audited = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(and(eq(auditEvent.organizationId, "org_a"), eq(auditEvent.action, "agent.config_updated"))),
  )
  expect(audited.length).toBeGreaterThan(0)
  expect(JSON.stringify(audited)).not.toContain("sk-propia")
  // Cambiar la URL sin reescribir la clave se rechaza: la guardada no viaja a otro host.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      upsertAgentConfig(tx, "org_a", { llmBaseUrl: "https://otro.example/v1" }, { secretsKey: KEY }),
    ),
  ).rejects.toThrow(/vuelve a indicar su clave/)
  // Un proveedor propio sin modelo tampoco se acepta.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      upsertAgentConfig(tx, "org_a", { llmBaseUrl: "https://otro.example/v1", llmApiKey: "sk-2", model: null }, { secretsKey: KEY }),
    ),
  ).rejects.toThrow(/modelo/)
  // Quitar la URL también quita la clave: el par nunca queda a medias.
  const cleared = await withOrgContext(appDb, "org_a", (tx) =>
    upsertAgentConfig(tx, "org_a", { llmBaseUrl: null, model: null }, { secretsKey: KEY }),
  )
  expect(cleared).toMatchObject({ llmBaseUrl: null, hasLlmApiKey: false })
  expect(await withOrgContext(appDb, "org_a", (tx) => getAgentLlmSecrets(tx, "org_a", KEY))).toBeNull()
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
    await withOrgContext(appDb, "org_a", (tx) =>
      upsertAgentConfig(
        tx,
        "org_a",
        { llmBaseUrl: provider.baseUrl, llmApiKey: "clave-rechazada", model: "modelo-propio" },
        { secretsKey: KEY, allowInsecureBaseUrl: true },
      ),
    )
    const first = await ingestText("tg:ag-401", "evt-ag-401", "Hola")
    expect(await runAgent(first.conversationId, first.messageId)).toBe("done")
    expect(provider.hits()).toBe(1)
    expect(await agentStatusOf(first.conversationId)).toBe("off")
    expect(await agentMessages(first.conversationId)).toEqual([])
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
    expect(ledgerRow?.model).toBe("modelo-propio")
    // El motivo que ve recepción es fijo: nunca el cuerpo de la respuesta del proveedor.
    const [handoff] = await withOrgContext(appDb, "org_a", (tx) =>
      tx
        .select({ reason: agentHandoff.reason, summary: agentHandoff.summary })
        .from(agentHandoff)
        .where(eq(agentHandoff.conversationId, first.conversationId)),
    )
    expect(handoff?.reason).toBe("El agente no puede usar el proveedor del modelo; revisa Configuración › Agente")
    expect(handoff?.summary).not.toContain("Incorrect API key")
    // Segunda conversación el mismo día: otra derivación, pero un solo aviso.
    const second = await ingestText("tg:ag-401-b", "evt-ag-401-b", "Buenas")
    expect(await runAgent(second.conversationId, second.messageId)).toBe("done")
    const notices = await withOrgContext(appDb, "org_a", (tx) =>
      tx
        .select({ title: workspaceNotification.title, href: workspaceNotification.href })
        .from(workspaceNotification)
        .where(and(eq(workspaceNotification.userId, adminId), eq(workspaceNotification.href, "/settings/agent"))),
    )
    // Las derivaciones generan sus propios avisos; el del proveedor es uno solo.
    expect(notices).toEqual([{ title: "El agente no puede usar el modelo", href: "/settings/agent" }])
  } finally {
    await provider.close()
    await withOrgContext(appDb, "org_a", (tx) =>
      upsertAgentConfig(tx, "org_a", { llmBaseUrl: null, model: null }, { secretsKey: KEY }),
    )
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
    await withOrgContext(appDb, "org_a", (tx) =>
      upsertAgentConfig(
        tx,
        "org_a",
        { llmBaseUrl: `http://127.0.0.1:${address.port}/v1`, llmApiKey: "clave", model: "modelo-propio" },
        { secretsKey: KEY, allowInsecureBaseUrl: true },
      ),
    )
    const { conversationId, messageId } = await ingestText("tg:ag-402", "evt-ag-402", "Hola")
    expect(await runAgent(conversationId, messageId)).toBe("done")
    expect(hits).toBe(1)
    expect(await agentStatusOf(conversationId)).toBe("off")
    const [row] = await withOrgContext(appDb, "org_a", (tx) =>
      tx.select({ error: agentRunLedger.error }).from(agentRunLedger).where(eq(agentRunLedger.conversationId, conversationId)),
    )
    expect(row?.error).toMatch(/^PROVIDER_QUOTA: HTTP 402/)
    const notices = await withOrgContext(appDb, "org_a", (tx) =>
      tx
        .select({ title: workspaceNotification.title })
        .from(workspaceNotification)
        .where(and(eq(workspaceNotification.href, "/settings/agent"), eq(workspaceNotification.title, "El proveedor del agente no tiene saldo"))),
    )
    expect(notices.length).toBeGreaterThan(0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await withOrgContext(appDb, "org_a", (tx) =>
      upsertAgentConfig(tx, "org_a", { llmBaseUrl: null, model: null }, { secretsKey: KEY }),
    )
  }
})

it("el modelo de decisión en sombra registra su triaje sin cambiar la corrida", async () => {
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "baseline" }))
  try {
    const { conversationId, messageId } = await ingestText("tg:ag-sombra", "evt-ag-sombra", "Quiero hablar con una persona, me duele mucho")
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "Te paso con el equipo." }, "call-1"))
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    // La corrida es la de siempre: una llamada, respuesta enviada, agente activo.
    expect(model.seen.length).toBe(1)
    expect(await agentMessages(conversationId)).toEqual(["Te paso con el equipo."])
    expect(await agentStatusOf(conversationId)).toBe("on")
    const rows = await withOrgContext(appDb, "org_a", (tx) =>
      tx
        .select({ point: agentDecisionLog.point, provider: agentDecisionLog.provider, outcome: agentDecisionLog.outcome, stateChars: agentDecisionLog.stateChars, error: agentDecisionLog.error })
        .from(agentDecisionLog)
        .where(eq(agentDecisionLog.conversationId, conversationId)),
    )
    // Con LLM_MODEL=fake la línea base es el modelo de decisión falso.
    expect(rows).toEqual([
      expect.objectContaining({ point: "triage.v1", provider: "fake", error: null, outcome: expect.objectContaining({ wouldHandoff: true }) }),
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
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { decisionProvider: "none" }))
  }
})

it("al alcanzar el tope diario el caso pasa al equipo sin llamar al modelo", async () => {
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { dailyRunLimit: 1 }))
  try {
    // La primera corrida del día consume el tope; la segunda ya no llama al modelo.
    const first = await ingestText("tg:ag-tope-1", "evt-ag-tope-1", "Hola")
    const used = new ScriptedModel(() => toolCall("send_reply", { text: "Hola, dime." }, "call-1"))
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { dailyRunLimit: 100_000 }))
    expect(await runScripted(used, first.conversationId, first.messageId)).toBe("done")
    expect(used.seen.length).toBe(1)
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { dailyRunLimit: 1 }))
    const { conversationId, messageId } = await ingestText("tg:ag-tope", "evt-ag-tope", "Hola")
    const model = new ScriptedModel(() => toolCall("send_reply", { text: "No debería enviarse." }, "call-1"))
    expect(await runScripted(model, conversationId, messageId)).toBe("done")
    expect(model.seen.length).toBe(0)
    expect(await agentMessages(conversationId)).toEqual([])
    expect(await agentStatusOf(conversationId)).toBe("off")
    const [row] = await withOrgContext(appDb, "org_a", (tx) =>
      tx
        .select({ status: agentRunLedger.status, error: agentRunLedger.error })
        .from(agentRunLedger)
        .where(eq(agentRunLedger.conversationId, conversationId)),
    )
    expect(row).toMatchObject({ status: "error" })
    expect(row?.error).toMatch(/^DAILY_LIMIT/)
  } finally {
    await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { dailyRunLimit: 500 }))
  }
})

it("la configuración por defecto no expone la clave y el resolvedor usa la plataforma", async () => {
  const cfg = await withOrgContext(appDb, "org_a", (tx) => getAgentConfig(tx, "org_a"))
  expect(cfg).toMatchObject({ llmBaseUrl: null, hasLlmApiKey: false, dailyRunLimit: 500 })
  expect("llmApiKeyEncrypted" in cfg).toBe(false)
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
  // ejecuta; como el hilo ya tiene la respuesta, no avisa ni queda sin_respuesta.
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

it("memoria del agente aísla por prefijo de thread_id", async () => {
  const threadsA = await withOrgContext(appDb, "org_a", (tx) =>
    tx.execute(sql`select count(*)::int as n from "checkpoints"`),
  )
  const n = (threadsA as unknown as { n: number }[])[0]?.n ?? 0
  expect(n).toBeGreaterThan(0)
  const threadsB = await withOrgContext(appDb, "org_b", (tx) =>
    tx.execute(sql`select count(*)::int as n from "checkpoints"`),
  )
  expect((threadsB as unknown as { n: number }[])[0]?.n).toBe(0)
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
    triggerId: null, secretsKey: KEY, dryRun: true, handedOff: false, decisionRecorded: false, replySettled: false,
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

/** Modelo que responde texto fijo y registra los mensajes vistos por turno. */
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
    const message = new AIMessage({ content: "anotado" })
    return { generations: [{ text: "anotado", message }] }
  }
}

/** Texto del system prompt visto por el modelo en un turno grabado. */
function systemTextOf(turn: BaseMessage[]): string {
  return turn
    .filter((m) => m instanceof SystemMessage || m.constructor?.name === "SystemMessage")
    .map((m) => String(m.content))
    .join("\n")
}

it("el contexto se reemplaza entre turnos sin crecer por copia ni conservar políticas", async () => {
  const { conversationId } = await ingestText("tg:memoria-ctx", "evt-memoria-ctx", "Hola, una consulta")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  expect(conv).toBeDefined()
  const toolCtx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId: conv!.contactId,
    triggerId: null, secretsKey: KEY, dryRun: true, handedOff: false, decisionRecorded: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const model = new RecordingModel({})
  const threadId = `org_a:${conversationId}`
  toolCtx.draftText = "primer turno"
  await compileAgentGraph(model, toolCtx, runtime.checkpointer).invoke(
    { messages: [], turnCount: 0 },
    { configurable: { thread_id: threadId } },
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    upsertAgentConfig(tx, "org_a", { systemPrompt: "PROMPT-TURNO-DOS" }))
  toolCtx.draftText = "segundo turno"
  await compileAgentGraph(model, toolCtx, runtime.checkpointer).invoke(
    { messages: [], turnCount: 0 },
    { configurable: { thread_id: threadId } },
  )
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { systemPrompt: "" }))
  expect(model.seen).toHaveLength(2)
  const first = model.seen[0] ?? []
  const second = model.seen[1] ?? []
  const systems = second.filter((m) => m instanceof SystemMessage || m.constructor?.name === "SystemMessage")
  expect(systems).toHaveLength(1)
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
    triggerId: null, secretsKey: KEY, dryRun: true, handedOff: false, decisionRecorded: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const model = new RecordingModel({})
  await compileAgentGraph(model, toolCtx, runtime.checkpointer).invoke(
    { messages: [], turnCount: 0 },
    { configurable: { thread_id: `org_a:${tg.conversationId}` } },
  )
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
  await compileAgentGraph(model, toolCtx, runtime.checkpointer).invoke(
    { messages: [], turnCount: 0 },
    { configurable: { thread_id: `org_a:${tg.conversationId}` } },
  )
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
    triggerId: null, secretsKey: KEY, dryRun: true, handedOff: false, decisionRecorded: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const model = new RecordingModel({})
  await compileAgentGraph(model, toolCtx, runtime.checkpointer).invoke(
    { messages: [], turnCount: 0 },
    { configurable: { thread_id: `org_a:${current.conversationId}` } },
  )
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
  const dentistId = `agent-dentist-${stamp}`
  await ownerDb.insert(user).values([
    { id: actorId, name: "Actor Agente", email: `actor-${stamp}@example.test` },
    { id: dentistId, name: "Dentista Agente", email: `dentista-${stamp}@example.test` },
  ])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${actorId}`}, 'org_a', ${actorId}, 'owner', now()),
      (${`m-${dentistId}`}, 'org_a', ${dentistId}, 'member', now())`)
  const createdChair = await withOrgContext(appDb, "org_a", (tx) =>
    createChair(tx, "org_a", { branchId, name: "Sillón Agente" }))
  const chairId = createdChair!.id
  await withOrgContext(appDb, "org_a", (tx) =>
    setProfessionalSchedule(tx, "org_a", actorId, {
      branchId,
      dentistUserId: dentistId,
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
  const [createdPatient] = await ownerDb
    .insert(patient)
    .values({ organizationId: "org_a", displayName: "Paciente Reserva Agente", patientNumber })
    .returning({ id: patient.id })
  const patientId = createdPatient!.id
  await withOrgContext(appDb, "org_a", (tx) =>
    setPatientContact(tx, "org_a", actorId, patientId, { contactId, relationship: "self", isPreferred: true }))
  const prevPolicy = await withOrgContext(appDb, "org_a", (tx) => getAutonomyPolicy(tx, "org_a"))
  await withOrgContext(appDb, "org_a", (tx) =>
    updateAutonomyPolicy(tx, "org_a", actorId, { reservar_cita: "aprobar_equipo" }))
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId,
    triggerId: null, secretsKey: KEY, dryRun: false, handedOff: false, decisionRecorded: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const tools = makeAgentTools(ctx)
  const gaps = tools.find((t) => t.name === "buscar_huecos")
  expect(gaps).toBeDefined()
  const out = String(await gaps!.invoke({
    branchId,
    from: "2026-10-05T05:00:00Z",
    to: "2026-10-06T05:00:00Z",
    durationMin: 45,
  }))
  const firstLine = out.split("\n")[0] ?? ""
  const optionBranch = firstLine.match(/sede ([0-9a-f-]{36})/i)?.[1]
  const optionChair = firstLine.match(/sillón ([0-9a-f-]{36})/i)?.[1]
  const optionDentist = firstLine.match(/profesional (\S+)/)?.[1]
  const optionZone = firstLine.match(/zona ([^)]+)\)/)?.[1]
  const [optionStart, optionEnd] = firstLine.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/g) ?? []
  expect(optionBranch).toBe(branchId)
  expect(optionChair).toBe(chairId)
  expect(optionDentist).toBe(dentistId)
  expect(optionZone).toBe("America/Lima")
  if (!optionStart || !optionEnd || !optionDentist || !optionChair || !optionBranch) {
    throw new Error("El hueco no contiene los datos necesarios para reservar")
  }
  const durationMin = Math.round((Date.parse(optionEnd) - Date.parse(optionStart)) / 60000)
  expect(durationMin).toBe(45)
  const booking = tools.find((t) => t.name === "proponer_cita")
  expect(booking).toBeDefined()
  await booking!.invoke({
    patientId,
    dentistUserId: optionDentist,
    chairId: optionChair,
    startsAt: optionStart,
    branchId: optionBranch,
    durationMin,
  })
  const pending = await withOrgContext(appDb, "org_a", (tx) =>
    listProposals(tx, "org_a", { conversationId, status: "propuesta" }))
  expect(pending).toHaveLength(1)
  const decided = await withOrgContext(appDb, "org_a", (tx) =>
    decideProposal(tx, "org_a", actorId, pending[0]!.id, { decision: "aprobada" }))
  expect(decided.status).toBe("ejecutada")
  await withOrgContext(appDb, "org_a", (tx) =>
    updateAutonomyPolicy(tx, "org_a", actorId, { reservar_cita: prevPolicy.reservar_cita }))
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointment).where(
      and(eq(appointment.patientId, patientId), eq(appointment.chairId, chairId))))
  expect(rows).toHaveLength(1)
  const booked = rows[0]!
  expect(booked.branchId).toBe(branchId)
  expect(booked.dentistUserId).toBe(dentistId)
  expect(booked.durationMin).toBe(45)
  expect(booked.startsAt.toISOString()).toBe(optionStart)
  expect(booked.endsAt.toISOString()).toBe(optionEnd)
  expect(booked.status).toBe("programada")
})

it("reprogramar_cita y cancelar_cita actúan sobre la cita real sin duplicar reserva ni pisar cambios ajenos", async () => {
  const [createdBranch] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede Agente Reprog", timezone: "America/Lima" })
    .returning({ id: branch.id })
  const branchId = createdBranch!.id
  const stamp = Date.now()
  const actorId = `agent-actor-reprog-${stamp}`
  const dentistId = `agent-dentist-reprog-${stamp}`
  await ownerDb.insert(user).values([
    { id: actorId, name: "Actor Reprog", email: `actor-reprog-${stamp}@example.test` },
    { id: dentistId, name: "Dentista Reprog", email: `dentista-reprog-${stamp}@example.test` },
  ])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${actorId}`}, 'org_a', ${actorId}, 'owner', now()),
      (${`m-${dentistId}`}, 'org_a', ${dentistId}, 'member', now())`)
  const createdChair = await withOrgContext(appDb, "org_a", (tx) =>
    createChair(tx, "org_a", { branchId, name: "Sillón Reprog" }))
  const chairId = createdChair!.id
  await withOrgContext(appDb, "org_a", (tx) =>
    setProfessionalSchedule(tx, "org_a", actorId, {
      branchId,
      dentistUserId: dentistId,
      rules: [1, 2, 3, 4, 5].flatMap((weekday) => [
        { weekday, startMin: 9 * 60, endMin: 13 * 60 },
      ]),
    }))
  const { conversationId } = await ingestText("tg:reprog-ctx", "evt-reprog-ctx", "Necesito cambiar mi cita")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  const contactId = conv!.contactId
  const patientNumber = await withOrgContext(appDb, "org_a", (tx) => nextPatientNumber(tx, "org_a"))
  const [createdPatient] = await ownerDb
    .insert(patient)
    .values({ organizationId: "org_a", displayName: "Paciente Reprog Agente", patientNumber })
    .returning({ id: patient.id })
  const patientId = createdPatient!.id
  await withOrgContext(appDb, "org_a", (tx) =>
    setPatientContact(tx, "org_a", actorId, patientId, { contactId, relationship: "self", isPreferred: true }))
  const booked = await withOrgContext(appDb, "org_a", (tx) =>
    createAppointment(tx, "org_a", actorId, {
      patientId, dentistUserId: dentistId, chairId, branchId,
      startsAt: "2026-10-05T15:00:00Z", durationMin: 45,
    }))
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId,
    triggerId: "trig-reprog-1", secretsKey: KEY, dryRun: false, handedOff: false, decisionRecorded: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const tools = makeAgentTools(ctx)

  // Reprogramar (confirmar_usuario): propuesta → confirmación → agenda movida.
  const reprogram = tools.find((t) => t.name === "reprogramar_cita")!
  const proposed = String(await reprogram.invoke({
    appointmentId: booked.id, startsAt: "2026-10-06T16:00:00Z", expectedVersion: booked.version,
  }))
  expect(proposed).toContain("pide al interlocutor que confirme")
  const proposalId = /Propuesta ([0-9a-f-]{36})/.exec(proposed)?.[1]
  expect(proposalId).toBeTruthy()
  await ingestText("tg:reprog-ctx", "evt-reprog-si-1", "Sí, confirmo")
  const confirmed = String(await tools.find((t) => t.name === "confirmar_propuesta")!.invoke({ proposalId: proposalId! }))
  expect(confirmed).toContain("Confirmado y ejecutado")
  let rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointment).where(eq(appointment.patientId, patientId)))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.startsAt.toISOString()).toBe("2026-10-06T16:00:00.000Z")
  expect(rows[0]!.version).toBe(booked.version + 1)

  // Obsolescencia: si la cita cambió desde la propuesta, confirmar no ejecuta.
  ctx.triggerId = "trig-reprog-2"
  const staleProposal = String(await reprogram.invoke({
    appointmentId: booked.id, startsAt: "2026-10-07T15:00:00Z", expectedVersion: booked.version + 1,
  }))
  const staleId = /Propuesta ([0-9a-f-]{36})/.exec(staleProposal)?.[1]
  expect(staleId).toBeTruthy()
  await ingestText("tg:reprog-ctx", "evt-reprog-si-2", "Si confirmo")
  await withOrgContext(appDb, "org_a", (tx) =>
    moveAppointment(tx, "org_a", actorId, booked.id, {
      expectedVersion: booked.version + 1, startsAt: "2026-10-08T15:00:00Z",
    }))
  const staleConfirm = String(await tools.find((t) => t.name === "confirmar_propuesta")!.invoke({ proposalId: staleId! }))
  expect(staleConfirm).toContain("No se pudo ejecutar al confirmar")
  expect(staleConfirm).toContain("obsoleta")
  rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointment).where(eq(appointment.patientId, patientId)))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.startsAt.toISOString()).toBe("2026-10-08T15:00:00.000Z")

  // Cancelar (aprobar_equipo): la confirmación del interlocutor no basta;
  // reentregar el mismo trigger no duplica la propuesta.
  ctx.triggerId = "trig-cancel-1"
  const cancel = tools.find((t) => t.name === "cancelar_cita")!
  const pendingMsg = String(await cancel.invoke({ appointmentId: booked.id }))
  expect(pendingMsg).toContain("aprobación del equipo")
  const repeatedMsg = String(await cancel.invoke({ appointmentId: booked.id }))
  const cancelId = /Propuesta ([0-9a-f-]{36})/.exec(pendingMsg)?.[1]
  expect(cancelId).toBeTruthy()
  expect(repeatedMsg).toContain(cancelId!)
  const pendingCancels = await withOrgContext(appDb, "org_a", (tx) =>
    listProposals(tx, "org_a", { conversationId, status: "propuesta" }))
  expect(pendingCancels.filter((p) => p.action === "cancelar_cita")).toHaveLength(1)
  const confirmCancel = String(await tools.find((t) => t.name === "confirmar_propuesta")!.invoke({ proposalId: cancelId! }))
  expect(confirmCancel).toContain("exige aprobación del equipo")
  const decided = await withOrgContext(appDb, "org_a", (tx) =>
    decideProposal(tx, "org_a", actorId, cancelId!, { decision: "aprobada" }))
  expect(decided.status).toBe("ejecutada")
  rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(appointment).where(eq(appointment.patientId, patientId)))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.status).toBe("cancelada")

  // Cancelar una cita ya cancelada no produce efectos parciales.
  ctx.triggerId = "trig-cancel-2"
  const lateMsg = String(await cancel.invoke({ appointmentId: booked.id }))
  const lateId = /Propuesta ([0-9a-f-]{36})/.exec(lateMsg)?.[1]
  expect(lateId).toBeTruthy()
  const lateDecided = await withOrgContext(appDb, "org_a", (tx) =>
    decideProposal(tx, "org_a", actorId, lateId!, { decision: "aprobada" }))
  expect(lateDecided.status).toBe("fallida")
  expect(lateDecided.error ?? "").toMatch(/obsoleta|cancelada/)
})

it("proponer_cita en directo fallido no se reporta como aprobación", async () => {
  const [createdBranch] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: "Sede Agente Fallida", timezone: "America/Lima" })
    .returning({ id: branch.id })
  const branchId = createdBranch!.id
  const stamp = Date.now()
  const actorId = `agent-actor-f-${stamp}`
  const dentistId = `agent-dentist-f-${stamp}`
  await ownerDb.insert(user).values([
    { id: actorId, name: "Actor Agente F", email: `actor-f-${stamp}@example.test` },
    { id: dentistId, name: "Dentista Agente F", email: `dentista-f-${stamp}@example.test` },
  ])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${actorId}`}, 'org_a', ${actorId}, 'owner', now()),
      (${`m-${dentistId}`}, 'org_a', ${dentistId}, 'member', now())`)
  const { conversationId } = await ingestText("tg:reserva-fallida", "evt-reserva-fallida", "Quiero una cita")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  expect(conv).toBeDefined()
  const contactId = conv!.contactId
  const patientNumber = await withOrgContext(appDb, "org_a", (tx) => nextPatientNumber(tx, "org_a"))
  const [createdPatient] = await ownerDb
    .insert(patient)
    .values({ organizationId: "org_a", displayName: "Paciente Fallida Agente", patientNumber })
    .returning({ id: patient.id })
  const patientId = createdPatient!.id
  await withOrgContext(appDb, "org_a", (tx) =>
    setPatientContact(tx, "org_a", actorId, patientId, { contactId, relationship: "self", isPreferred: true }))
  const prevPolicy = await withOrgContext(appDb, "org_a", (tx) => getAutonomyPolicy(tx, "org_a"))
  await withOrgContext(appDb, "org_a", (tx) =>
    updateAutonomyPolicy(tx, "org_a", actorId, { reservar_cita: "directo" }))
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId,
    triggerId: null, secretsKey: KEY, dryRun: false, handedOff: false, decisionRecorded: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const booking = makeAgentTools(ctx).find((t) => t.name === "proponer_cita")
  expect(booking).toBeDefined()
  const result = String(await booking!.invoke({
    patientId,
    dentistUserId: dentistId,
    chairId: "00000000-0000-4000-8000-000000000000",
    startsAt: "2026-10-05T14:00:00.000Z",
    branchId,
    durationMin: 45,
  }))
  await withOrgContext(appDb, "org_a", (tx) =>
    updateAutonomyPolicy(tx, "org_a", actorId, { reservar_cita: prevPolicy.reservar_cita }))
  expect(result).not.toContain("aprobación")
  const failed = await withOrgContext(appDb, "org_a", (tx) =>
    listProposals(tx, "org_a", { conversationId, status: "fallida" }))
  expect(failed).toHaveLength(1)
  expect(failed[0]!.error).toBeTruthy()
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ id: appointment.id }).from(appointment).where(eq(appointment.patientId, patientId)))
  expect(rows).toHaveLength(0)
})

it("segunda propuesta en espera guía a confirmar en vez de romper el turno", async () => {
  const { conversationId } = await ingestText("tg:doble-si", "evt-doble-si", "Quiero confirmar")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  expect(conv).toBeDefined()
  const prevPolicy = await withOrgContext(appDb, "org_a", (tx) => getAutonomyPolicy(tx, "org_a"))
  const stamp = Date.now()
  const actorId = `agent-actor-p-${stamp}`
  await ownerDb.insert(user).values([
    { id: actorId, name: "Actor Agente P", email: `actor-p-${stamp}@example.test` },
  ])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${actorId}`}, 'org_a', ${actorId}, 'owner', now())`)
  await withOrgContext(appDb, "org_a", (tx) =>
    updateAutonomyPolicy(tx, "org_a", actorId, { enviar_mensaje: "confirmar_usuario" }))
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId: conv!.contactId,
    triggerId: null, secretsKey: KEY, dryRun: false, handedOff: false, decisionRecorded: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const sender = makeAgentTools(ctx).find((t) => t.name === "send_reply")
  expect(sender).toBeDefined()
  await sender!.invoke({ text: "Te propongo el plan de tratamiento." })
  const second = String(await sender!.invoke({ text: "Te propongo el plan alternativo." }))
  await withOrgContext(appDb, "org_a", (tx) =>
    updateAutonomyPolicy(tx, "org_a", actorId, { enviar_mensaje: prevPolicy.enviar_mensaje }))
  expect(second).toContain("confirmar_propuesta")
  const pending = await withOrgContext(appDb, "org_a", (tx) =>
    listProposals(tx, "org_a", { conversationId, status: "propuesta" }))
  expect(pending).toHaveLength(1)
})

it("en modo equipo el segundo intento y confirmar_propuesta no piden sí ni ejecutan", async () => {
  const { conversationId } = await ingestText("tg:equipo-si", "evt-equipo-si", "Quiero abrir mi caso")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  expect(conv).toBeDefined()
  const prevPolicy = await withOrgContext(appDb, "org_a", (tx) => getAutonomyPolicy(tx, "org_a"))
  const stamp = Date.now()
  const actorId = `agent-actor-e-${stamp}`
  await ownerDb.insert(user).values([
    { id: actorId, name: "Actor Equipo", email: `actor-e-${stamp}@example.test` },
  ])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      (${`m-${actorId}`}, 'org_a', ${actorId}, 'owner', now())`)
  await withOrgContext(appDb, "org_a", (tx) =>
    updateAutonomyPolicy(tx, "org_a", actorId, { crear_oportunidad: "aprobar_equipo" }))
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId: conv!.contactId,
    triggerId: null, secretsKey: KEY, dryRun: false, handedOff: false, decisionRecorded: false, replySettled: false,
    toolsUsed: [], usage: emptyUsage(),
  }
  const tools = makeAgentTools(ctx)
  const creator = tools.find((t) => t.name === "create_opportunity")
  expect(creator).toBeDefined()
  const before = await withOrgContext(appDb, "org_a", tx =>
    listOpportunities(tx, "org_a", { contactId: conv!.contactId }))
  await creator!.invoke({ title: "Caso equipo" })
  await creator!.invoke({ title: "Segundo caso equipo" })
  const pendingTeam = await withOrgContext(appDb, "org_a", (tx) =>
    listProposals(tx, "org_a", { conversationId, status: "propuesta" }))
  expect(pendingTeam).toHaveLength(1)
  await ingestText("tg:equipo-si", "evt-equipo-si-2", "Sí, confirmo")
  const confirmer = tools.find((t) => t.name === "confirmar_propuesta")
  expect(confirmer).toBeDefined()
  await confirmer!.invoke({ proposalId: pendingTeam[0]!.id })
  const stillPending = await withOrgContext(appDb, "org_a", (tx) =>
    listProposals(tx, "org_a", { conversationId, status: "propuesta" }))
  expect(stillPending).toHaveLength(1)
  const opportunities = await withOrgContext(appDb, "org_a", tx =>
    listOpportunities(tx, "org_a", { contactId: conv!.contactId }))
  expect(opportunities.items.map(row => row.id)).toEqual(before.items.map(row => row.id))
  await withOrgContext(appDb, "org_a", (tx) =>
    updateAutonomyPolicy(tx, "org_a", actorId, { crear_oportunidad: prevPolicy.crear_oportunidad }))
})

it("create_task no duplica en reentrega y las escrituras directas auditan su origen agente", async () => {
  const { conversationId } = await ingestText("tg:direct-writes", "evt-dw-1", "Recuérdame llamar")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId)))
  const contactId = conv!.contactId
  const ctx: AgentToolCtx = {
    db: appDb, orgId: "org_a", conversationId, contactId,
    triggerId: "trig-dw-1", secretsKey: KEY, dryRun: false, handedOff: false, decisionRecorded: false, replySettled: false,
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

it("la derivación tiene plazo, toma atómica de la cola y escalamiento único al vencer", async () => {
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
  expect(String((loser as PromiseRejectedResult).reason)).toContain("Otro miembro ya tomó esta derivación")
  // La tarea vinculada pasa al mismo responsable.
  const [claimedTask] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(eq(crmTask.id, handoff.taskId!)))
  expect(claimedTask!.assigneeUserId).toBe(winner)
  // Reclamar de nuevo el mismo usuario es idempotente.
  const again = await withOrgContext(appDb, "org_a", (tx) => claimHandoff(tx, "org_a", winner, handoff.id))
  expect(again.assigneeUserId).toBe(winner)

  // Vencimiento: avisa al responsable una sola vez, sin duplicar avisos.
  await ownerDb.execute(sql`update "task" set due_at = now() - interval '1 hour' where id = ${handoff.taskId!}`)
  await withOrgContext(appDb, "org_a", (tx) => listHandoffs(tx, "org_a", {}))
  const overdueNotifs = async () =>
    withOrgContext(appDb, "org_a", (tx) =>
      tx.select().from(workspaceNotification).where(
        sql`dedupe_key like ${`agent-handoff-overdue:${handoff.id}:%`}`))
  const firstWave = await overdueNotifs()
  expect(firstWave).toHaveLength(1)
  expect(firstWave[0]!.userId).toBe(winner)
  await withOrgContext(appDb, "org_a", (tx) => listHandoffs(tx, "org_a", {}))
  expect(await overdueNotifs()).toHaveLength(1)

  // La resolución registra actor y no reactiva el agente.
  await withOrgContext(appDb, "org_a", (tx) =>
    updateTask(tx, "org_a", handoff.taskId!, { status: "done", actorUserId: winner }))
  const [resolved] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(eq(crmTask.id, handoff.taskId!)))
  expect(resolved!.status).toBe("done")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ agentStatus: conversation.agentStatus }).from(conversation).where(eq(conversation.id, conversationId)))
  expect(conv!.agentStatus).toBe("off")
})
