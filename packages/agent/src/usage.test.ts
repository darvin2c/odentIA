process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

// Uso del modelo por turno: cuántas corridas provoca una ráfaga de mensajes y
// qué envía cada una (herramientas, prompt, conocimiento). Se comprueba sobre
// lo que el modelo recibe de verdad, no sobre una estimación de coste.
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { convertToOpenAITool } from "@langchain/core/utils/function_calling"
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { telegramBotApiAdapter } from "@odentia/channels"
import { createAppDb, createOwnerDb, type Db, setupAgentMemory, withOrgContext } from "@odentia/db"
import { agentRunLedger, aiUsage } from "@odentia/db/schema/agent"
import { message } from "@odentia/db/schema/crm"
import { organizationPaymentMethod } from "@odentia/db/schema/org-payments"
import {
  createConnection,
  createKnowledgeEntry,
  ingestInbound,
  searchPublishedKnowledge,
  secretsKeyFromEnv,
  setConnectionStatus,
  setKnowledgeStatus,
  upsertAgentConfig,
} from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { type AgentRuntime, processAgentRun } from "./run.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("bb".repeat(32))
const ORG = "org_uso"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let runtime: AgentRuntime
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

/**
 * Modelo que registra lo que recibe. Responde con un envío salvo que el guion
 * devuelva otra cosa para esa llamada.
 */
class RecordingModel extends BaseChatModel {
  calls: BaseMessage[][] = []
  tools: unknown[] = []
  constructor(private readonly script?: (call: number) => AIMessage | null) {
    super({})
  }
  _llmType(): string {
    return "recording-chat"
  }
  override bindTools(tools: unknown[]): this {
    this.tools = tools
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages)
    const scripted = this.script?.(this.calls.length)
    if (scripted) return { generations: [{ text: String(scripted.content), message: scripted }] }
    const reply = new AIMessage({
      content: "",
      tool_calls: [{ name: "send_reply", args: { text: `Respuesta ${this.calls.length}` }, id: `call-${this.calls.length}`, type: "tool_call" }],
    })
    return { generations: [{ text: "", message: reply }] }
  }
  systemPrompt(call: number): string {
    return String(this.calls[call]?.[0]?.content ?? "")
  }
  toolsJson(): string {
    return JSON.stringify(this.tools.map((tool) => convertToOpenAITool(tool as Parameters<typeof convertToOpenAITool>[0])))
  }
}

async function ingest(thread: string, eventId: string, text: string) {
  return withOrgContext(appDb, ORG, (tx) =>
    ingestInbound(tx, {
      orgId: ORG, connectionId,
      event: {
        externalEventId: eventId, externalMessageId: eventId, externalThreadId: thread, senderExternalId: thread,
        senderDisplayName: thread, content: { type: "text", text }, sentAt: new Date().toISOString(),
      },
    }, telegramBotApiAdapter, { storage: storageStub, fetch, secretsKey: KEY }),
  )
}

function run(model: RecordingModel, conversationId: string, messageId: string) {
  return processAgentRun(appDb, { ...runtime, createModel: async () => model }, {
    msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: ORG, conversationId, messageId },
  })
}

function sharedPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

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
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Clínica Uso', 'uso', now())`)
  await ownerDb.execute(sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values (${ORG}, 'Clínica Uso', 'PE', 'PEN', 'America/Lima', 'es-PE') on conflict do nothing`)
  const checkpointer = PostgresSaver.fromConnString(ownerUri)
  await checkpointer.setup()
  await setupAgentMemory(ownerDb)
  runtime = { checkpointer, platform: { fake: true }, secretsKey: KEY }
  connectionId = (
    await withOrgContext(appDb, ORG, (tx) =>
      createConnection(tx, ORG, KEY, { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } }, { fetch, validateExternal: false }))
  ).id
  await withOrgContext(appDb, ORG, async (tx) => {
    await upsertAgentConfig(tx, ORG, { enabled: true })
    // Diez respuestas oficiales: ocho breves y dos extensas, como un protocolo pegado entero.
    for (let i = 0; i < 10; i++) {
      const long = i >= 8
      const entry = await createKnowledgeEntry(tx, ORG, null, {
        kind: "faq",
        title: `Pregunta frecuente ${i + 1}`,
        body: long
          ? `Protocolo ${i + 1}. ${"Paso detallado del procedimiento con indicaciones para el paciente. ".repeat(45)}`
          : `Respuesta oficial breve número ${i + 1} sobre horarios, pagos o preparación antes de la cita.`,
      })
      await setKnowledgeStatus(tx, ORG, null, entry.id, "publicada")
    }
  })
}, 180_000)

afterAll(async () => {
  await runtime?.checkpointer.end().catch(() => {})
  await container?.stop()
})

const toolNames = (model: RecordingModel) => model.tools.map((tool) => (tool as { name: string }).name)

async function ledgerOf(conversationId: string) {
  const rows = await withOrgContext(appDb, ORG, (tx) =>
    tx.select({ status: agentRunLedger.status }).from(agentRunLedger).where(eq(agentRunLedger.conversationId, conversationId)))
  return rows.map((row) => row.status).sort()
}

async function repliesOf(conversationId: string) {
  return withOrgContext(appDb, ORG, (tx) =>
    tx.select({ id: message.id }).from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.senderKind, "agent"))))
}

it("una ráfaga de mensajes se atiende con una sola corrida y una sola respuesta", async () => {
  // Una persona escribe tres mensajes seguidos; cada uno encola su corrida.
  const model = new RecordingModel()
  const burst = [
    await ingest("tg:uso-a", "uso-a-1", "Hola"),
    await ingest("tg:uso-a", "uso-a-2", "Quiero una limpieza"),
    await ingest("tg:uso-a", "uso-a-3", "¿Tienen turno el jueves?"),
  ]
  const conversationId = burst[0]?.conversationId ?? ""
  for (const item of burst) expect(await run(model, item.conversationId, item.messageId)).toBe("done")
  // La primera corrida leyó los tres mensajes y dejó constancia de los otros
  // dos: sus corridas no llaman al modelo ni añaden filas.
  expect(model.calls).toHaveLength(1)
  expect(model.calls[0]?.filter((m) => m._getType() === "human")).toHaveLength(3)
  expect(await repliesOf(conversationId)).toHaveLength(1)
  expect(await ledgerOf(conversationId)).toEqual(["ok", "omitida", "omitida"])
  // Una reentrega de la cola tampoco repite la respuesta.
  expect(await run(model, conversationId, burst[2]?.messageId ?? "")).toBe("done")
  expect(model.calls).toHaveLength(1)
  expect(await repliesOf(conversationId)).toHaveLength(1)
  expect(await ledgerOf(conversationId)).toEqual(["ok", "omitida", "omitida"])
  // Un mensaje posterior sí abre otra corrida.
  const later = await ingest("tg:uso-a", "uso-a-4", "¿Y el viernes?")
  expect(await run(model, conversationId, later.messageId)).toBe("done")
  expect(model.calls).toHaveLength(2)
  expect(await repliesOf(conversationId)).toHaveLength(2)
})

it("solo se omite el mensaje que una corrida leyó: ni la hora de creación ni una corrida sin respuesta lo dan por atendido", async () => {
  // Una corrida que no respondió no cubre nada: la siguiente del hilo se ejecuta.
  const silentThenReply = new RecordingModel((call) => (call === 1 ? new AIMessage({ content: "Pensando…" }) : null))
  const first = await ingest("tg:uso-s", "uso-s-1", "¿Atienden sábados?")
  const second = await ingest("tg:uso-s", "uso-s-2", "¿Y domingos?")
  expect(await run(silentThenReply, first.conversationId, first.messageId)).toBe("done")
  expect(await ledgerOf(first.conversationId)).toEqual(["sin_respuesta"])
  expect(await run(silentThenReply, second.conversationId, second.messageId)).toBe("done")
  expect(silentThenReply.calls).toHaveLength(2)
  expect(await repliesOf(first.conversationId)).toHaveLength(1)

  // Un mensaje que se confirma tarde con una hora de creación anterior a la de
  // otro ya atendido (su ingesta empezó antes: nota de voz, transcripción)
  // no lo leyó nadie: su corrida debe ejecutarse.
  const model = new RecordingModel()
  const attended = await ingest("tg:uso-l", "uso-l-2", "Mensaje corto")
  expect(await run(model, attended.conversationId, attended.messageId)).toBe("done")
  const late = await ingest("tg:uso-l", "uso-l-1", "Nota de voz transcrita")
  await ownerDb.execute(sql`
    update message set created_at = (select created_at from message where id = ${attended.messageId}) - interval '10 seconds'
    where id = ${late.messageId}`)
  expect(await run(model, late.conversationId, late.messageId)).toBe("done")
  expect(model.calls).toHaveLength(2)
  expect(model.calls[1]?.some((m) => String(m.content).includes("Nota de voz transcrita"))).toBe(true)
})

it("lo antiguo sin responder es historial, no ráfaga: ni se anota ni deriva por una palabra de hace días", async () => {
  await withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { handoffKeywords: ["humano"] }))
  try {
    const model = new RecordingModel()
    const old = await ingest("tg:uso-h", "uso-h-1", "Quería hablar con un humano")
    await ownerDb.execute(sql`update message set created_at = now() - interval '2 days' where id = ${old.messageId}`)
    const fresh = await ingest("tg:uso-h", "uso-h-2", "Hola, ¿siguen atendiendo?")
    expect(await run(model, fresh.conversationId, fresh.messageId)).toBe("done")
    // El modelo lee el mensaje antiguo como historial y responde al de hoy.
    expect(model.calls).toHaveLength(1)
    expect(model.calls[0]?.some((m) => String(m.content).includes("Quería hablar con un humano"))).toBe(true)
    expect(await ledgerOf(fresh.conversationId)).toEqual(["ok"])
    expect(await repliesOf(fresh.conversationId)).toHaveLength(1)
  } finally {
    await withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { handoffKeywords: [] }))
  }
})

it("una palabra de derivación en medio de la ráfaga deriva sin llamar al modelo", async () => {
  await withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { handoffKeywords: ["humano"] }))
  try {
    const model = new RecordingModel()
    const first = await ingest("tg:uso-k", "uso-k-1", "Hola")
    await ingest("tg:uso-k", "uso-k-2", "Prefiero hablar con un humano")
    await ingest("tg:uso-k", "uso-k-3", "Gracias")
    expect(await run(model, first.conversationId, first.messageId)).toBe("done")
    expect(model.calls).toHaveLength(0)
    expect(await ledgerOf(first.conversationId)).toEqual(["handoff"])
    // Sin modelo, pero la persona recibe el aviso fijo de que sigue una persona (ADR 0024).
    expect(await repliesOf(first.conversationId)).toHaveLength(1)
  } finally {
    await withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { handoffKeywords: [] }))
  }
})

it("el prompt pone primero lo que comparte toda la clínica y acota el conocimiento", async () => {
  const one = new RecordingModel()
  const two = new RecordingModel()
  const a = await ingest("tg:uso-p1", "uso-p1-1", "Buenas, ¿cuánto cuesta una consulta?")
  const b = await ingest("tg:uso-p2", "uso-p2-1", "Hola, quiero reprogramar")
  expect(await run(one, a.conversationId, a.messageId)).toBe("done")
  expect(await run(two, b.conversationId, b.messageId)).toBe("done")
  const promptA = one.systemPrompt(0)
  const promptB = two.systemPrompt(0)
  // Herramientas, instrucciones, política y conocimiento son idénticos entre
  // dos personas de la misma clínica y van antes de lo propio del hilo: es el
  // prefijo que el proveedor puede servir desde su caché.
  expect(one.toolsJson()).toBe(two.toolsJson())
  const shared = sharedPrefix(promptA, promptB)
  expect(shared).toBeGreaterThanOrEqual(promptA.indexOf("Interlocutor:"))
  expect(promptA.slice(0, shared)).toContain("Política de autonomía")
  expect(promptA.slice(0, shared)).toContain("Pregunta frecuente 10")
  // Lo que cambia en cada corrida va al final.
  expect(promptA.trimEnd().split("\n\n").at(-1)).toMatch(/^Fecha y hora actual/)
  // Una respuesta oficial extensa se recorta con aviso; la breve va entera.
  expect(promptA).toContain("(recortada)")
  expect(promptA).toContain("Respuesta oficial breve número 1 sobre horarios, pagos o preparación antes de la cita.")
  expect(promptA).not.toContain("Paso detallado del procedimiento con indicaciones para el paciente. ".repeat(12))
  // Y su texto completo se recupera por el título exacto, aunque otros títulos lo contengan.
  const hits = await withOrgContext(appDb, ORG, (tx) => searchPublishedKnowledge(tx, ORG, "Pregunta frecuente 1", 5))
  expect(hits[0]?.title).toBe("Pregunta frecuente 1")
  const full = await withOrgContext(appDb, ORG, (tx) => searchPublishedKnowledge(tx, ORG, "Pregunta frecuente 9", 5))
  expect(full[0]?.body.length).toBeGreaterThan(2000)
  console.log(`USO ${JSON.stringify({ promptCaracteres: promptA.length, prefijoComun: shared, herramientas: one.tools.length, herramientasCaracteres: one.toolsJson().length })}`)
})

it("la herramienta de plantillas solo viaja si algún canal activo de la clínica las admite", async () => {
  // Solo Telegram: no hay plantillas que enviar.
  const telegramOnly = new RecordingModel()
  const first = await ingest("tg:uso-t", "uso-t-1", "Hola")
  expect(await run(telegramOnly, first.conversationId, first.messageId)).toBe("done")
  expect(toolNames(telegramOnly)).toContain("send_reply")
  expect(toolNames(telegramOnly)).toContain("ver_otros_canales")
  expect(toolNames(telegramOnly)).not.toContain("send_template")
  // Con WhatsApp activo vuelve para toda la clínica: la lista no varía por hilo.
  const whatsapp = await withOrgContext(appDb, ORG, (tx) =>
    createConnection(tx, ORG, KEY, {
      channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA",
      config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S", templates: [] },
    }, { fetch, validateExternal: false }))
  try {
    const withTemplates = new RecordingModel()
    const second = await ingest("tg:uso-t2", "uso-t2-1", "Hola")
    expect(await run(withTemplates, second.conversationId, second.messageId)).toBe("done")
    expect(toolNames(withTemplates)).toContain("send_template")
  } finally {
    await withOrgContext(appDb, ORG, (tx) => setConnectionStatus(tx, ORG, whatsapp.id, "disabled"))
  }
})

it("los medios de pago activos de caja viajan en cada turno, en lo que comparte toda la clínica", async () => {
  const ask = async (thread: string, text: string) => {
    const model = new RecordingModel()
    const inbound = await ingest(thread, `${thread}-1`, text)
    expect(await run(model, inbound.conversationId, inbound.messageId)).toBe("done")
    return model.systemPrompt(0)
  }
  // Sin medios activos el agente no recibe ninguna lista: no afirma nada.
  expect(await ask("tg:uso-pago-0", "¿Aceptan tarjeta?")).not.toContain("Medios de pago que acepta la clínica")
  const methods = await ownerDb
    .insert(organizationPaymentMethod)
    .values([
      { organizationId: ORG, name: "Efectivo", typeCode: "10", sortOrder: 1 },
      { organizationId: ORG, name: "Tarjeta", typeCode: "48", sortOrder: 2 },
      { organizationId: ORG, name: "Yape", typeCode: "68", sortOrder: 3 },
    ])
    .returning({ id: organizationPaymentMethod.id, name: organizationPaymentMethod.name })
  const line = "Medios de pago que acepta la clínica (lista completa; ningún otro): Efectivo, Tarjeta, Yape."
  const promptA = await ask("tg:uso-pago-1", "¿Aceptan tarjeta?")
  const promptB = await ask("tg:uso-pago-2", "Hola")
  expect(promptA).toContain(line)
  // Una sola línea, dentro del prefijo común: va antes de lo propio del hilo.
  expect(promptA.split("\n").filter((text) => text.includes("Medios de pago que acepta"))).toHaveLength(1)
  expect(promptA.indexOf(line)).toBeLessThan(sharedPrefix(promptA, promptB))
  // Apagado en caja, el agente deja de recibirlo sin que nadie edite un texto.
  const wallet = methods.find((method) => method.name === "Yape")
  await ownerDb.update(organizationPaymentMethod).set({ isActive: false }).where(eq(organizationPaymentMethod.id, wallet!.id))
  expect(await ask("tg:uso-pago-3", "¿Aceptan tarjeta?")).toContain("(lista completa; ningún otro): Efectivo, Tarjeta.")
})

it("con Claude, la parte fija va marcada para su caché y la corrida guarda su costo por proveedor", async () => {
  await withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { llm: "claude_5_5" }))
  try {
    // El proveedor informa lo nuevo, lo leído de la caché y lo escrito en ella.
    const model = new RecordingModel(() =>
      new AIMessage({
        content: "",
        tool_calls: [{ name: "send_reply", args: { text: "Hola, ¿en qué te ayudo?" }, id: "call-claude", type: "tool_call" }],
        usage_metadata: {
          input_tokens: 3_000,
          output_tokens: 50,
          total_tokens: 3_050,
          input_token_details: { cache_read: 2_000, cache_creation: 400 },
        },
      }),
    )
    const inbound = await ingest("tg:uso-claude", "uso-claude-1", "Hola")
    const result = await processAgentRun(
      appDb,
      { ...runtime, platform: { anthropic: { apiKey: "clave-sintetica" } }, createModel: async () => model },
      { msg_id: 1, read_ct: 0, message: { kind: "inbound_message", orgId: ORG, conversationId: inbound.conversationId, messageId: inbound.messageId } },
    )
    expect(result).toBe("done")
    const system = model.calls[0]?.[0]?.content
    expect(Array.isArray(system)).toBe(true)
    const blocks = system as Array<{ type: string; text: string; cache_control?: unknown }>
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" })
    expect(blocks[1]?.cache_control).toBeUndefined()
    // Lo propio del turno (la hora) va después de la marca: no rompe la caché de lo fijo.
    expect(blocks[0]?.text).not.toContain("Fecha y hora actual")
    expect(blocks[1]?.text).toContain("Fecha y hora actual")
    const [ledgerRow] = await withOrgContext(appDb, ORG, (tx) =>
      tx.select().from(agentRunLedger).where(eq(agentRunLedger.conversationId, inbound.conversationId)))
    // 600 nuevos a 0,10 + 2.000 leídos a 0,01 + 400 escritos a 0,125 + 50 de salida a 0,50 (USD por millón).
    expect(ledgerRow).toMatchObject({ status: "ok", cachedInputTokens: 2_000, cacheWriteTokens: 400, costMicros: 155 })
    const usage = await withOrgContext(appDb, ORG, (tx) =>
      tx.select().from(aiUsage).where(eq(aiUsage.conversationId, inbound.conversationId)))
    expect(usage).toEqual([
      expect.objectContaining({ origin: "recepcion", provider: "anthropic", model: "claude-haiku-5-5", calls: 1, costMicros: 155 }),
    ])
  } finally {
    await withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { llm: "chatgpt_6" }))
  }
})
