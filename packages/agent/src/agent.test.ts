process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { telegramBotApiAdapter } from "@odentia/channels"
import { createAppDb, createOwnerDb, type Db, setupAgentMemory, withOrgContext } from "@odentia/db"
import { conversation, crmTask, message } from "@odentia/db/schema/crm"
import { agentHandoff, agentRunLedger } from "@odentia/db/schema/agent"
import {
  createConnection,
  ingestInbound,
  secretsKeyFromEnv,
  upsertAgentConfig,
} from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { FAKE_REPLY_TEXT } from "./fake-model.js"
import { type AgentRuntime, processAgentRun } from "./run.js"

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
  return withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId: tgConnId,
        event: {
          externalEventId: eventId,
          externalMessageId: eventId,
          externalThreadId: thread,
          senderExternalId: "tg:555",
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
