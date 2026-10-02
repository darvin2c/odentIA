process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { telegramBotApiAdapter } from "@odentia/channels"
import { createAppDb, createOwnerDb, type Db, setupAgentMemory, withOrgContext } from "@odentia/db"
import { contactIdentity, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { agentHandoff, agentRunLedger } from "@odentia/db/schema/agent"
import {
  addContactIdentity,
  createChair,
  createConnection,
  createContact,
  decideProposal,
  getAutonomyPolicy,
  ingestInbound,
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
import { branch } from "@odentia/db/schema/org"
import { patient } from "@odentia/db/schema/clinical"
import { appointment } from "@odentia/db/schema/agenda"

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

async function runAgent(conversationId: string, triggerMessageId: string, readCt = 0) {
  return processAgentRun(appDb, runtime, {
    msg_id: 1,
    read_ct: readCt,
    message: { orgId: "org_a", conversationId, triggerMessageId },
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
  const checkpointer = PostgresSaver.fromConnString(ownerUri)
  await checkpointer.setup()
  await setupAgentMemory(ownerDb)
  runtime = { checkpointer, modelName: "fake", secretsKey: KEY }
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

it("trigger superseded no genera respuesta", async () => {
  const first = await ingestText("tg:ag3", "evt-ag3", "primero")
  for (let i = 0; i < 6; i++) {
    await ingestText("tg:ag3", `evt-ag3-${i}`, `mensaje ${i}`)
  }
  expect(await runAgent(first.conversationId, first.messageId)).toBe("done")
  expect(await agentMessages(first.conversationId)).toEqual([])
})

it("maxTurns deriva automáticamente", async () => {
  await withOrgContext(appDb, "org_a", (tx) =>
    upsertAgentConfig(tx, "org_a", { enabled: true, maxTurns: 1 }),
  )
  const { conversationId, messageId } = await ingestText("tg:ag4", "evt-ag4", "Hola")
  expect(await runAgent(conversationId, messageId)).toBe("done")
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ agentStatus: conversation.agentStatus })
      .from(conversation)
      .where(eq(conversation.id, conversationId)),
  )
  expect(conv?.agentStatus).toBe("off")
  await withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { maxTurns: 10 }))
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
    triggerMessageId: null, secretsKey: KEY, dryRun: true, handedOff: false,
    toolsUsed: [], usage: { inputTokens: 0, outputTokens: 0, reported: false },
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
    triggerMessageId: null, secretsKey: KEY, dryRun: true, handedOff: false,
    toolsUsed: [], usage: { inputTokens: 0, outputTokens: 0, reported: false },
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
    triggerMessageId: null, secretsKey: KEY, dryRun: true, handedOff: false,
    toolsUsed: [], usage: { inputTokens: 0, outputTokens: 0, reported: false },
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
    triggerMessageId: null, secretsKey: KEY, dryRun: true, handedOff: false,
    toolsUsed: [], usage: { inputTokens: 0, outputTokens: 0, reported: false },
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
    triggerMessageId: null, secretsKey: KEY, dryRun: false, handedOff: false,
    toolsUsed: [], usage: { inputTokens: 0, outputTokens: 0, reported: false },
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
    triggerMessageId: null, secretsKey: KEY, dryRun: false, handedOff: false,
    toolsUsed: [], usage: { inputTokens: 0, outputTokens: 0, reported: false },
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
    triggerMessageId: null, secretsKey: KEY, dryRun: false, handedOff: false,
    toolsUsed: [], usage: { inputTokens: 0, outputTokens: 0, reported: false },
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
    triggerMessageId: null, secretsKey: KEY, dryRun: false, handedOff: false,
    toolsUsed: [], usage: { inputTokens: 0, outputTokens: 0, reported: false },
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
