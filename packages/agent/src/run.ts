import type { Callbacks } from "@langchain/core/callbacks/manager"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { type AgentRunJob, type Db, type QueueMessage, withOrgContext } from "@odentia/db"
import { conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { getAgentConfig, recordAgentRun, type RecordRunInput } from "@odentia/services"
import { and, desc, eq, sql } from "drizzle-orm"
import { compileAgentGraph } from "./graph.js"
import { createConfiguredChatModel, type LlmCredentials } from "./llm.js"
import { type AgentToolCtx, performHandoff } from "./tools.js"
export interface AgentRuntime {
  checkpointer: PostgresSaver
  modelName: string
  /** Credenciales del proveedor por llamada (sin entorno global). */
  llm?: LlmCredentials
  secretsKey: Buffer
  callbacks?: Callbacks
}

function matchesHandoff(text: string | null, keywords: string[]): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return keywords.some((k) => k.trim() !== "" && lower.includes(k.trim().toLowerCase()))
}

function baseToolCtx(
  db: Db,
  orgId: string,
  conversationId: string,
  contactId: string,
  secretsKey: Buffer,
): AgentToolCtx {
  return {
    db,
    orgId,
    conversationId,
    contactId,
    secretsKey,
    handedOff: false,
    dryRun: false,
    toolsUsed: [],
    usage: { inputTokens: 0, outputTokens: 0, reported: false },
  }
}

async function ledger(db: Db, orgId: string, input: RecordRunInput): Promise<void> {
  await withOrgContext(db, orgId, (tx) => recordAgentRun(tx, orgId, input)).catch(() => {})
}

/**
 * Ejecuta una corrida del agente. Devuelve "done" (ack) o "retry".
 * Excepción → no ack (1 reintento vía vt); con read_ct>=2 audita
 * `agent.error`, deriva a humano y hace ack. Cada corrida real queda en el
 * libro de supervisión (tokens/coste solo si el proveedor los da).
 */
export async function processAgentRun(
  db: Db,
  runtime: AgentRuntime,
  msg: QueueMessage<AgentRunJob>,
): Promise<"done" | "retry"> {
  const { orgId, conversationId, triggerMessageId } = msg.message
  const startedAt = new Date()
  try {
    const skip = await withOrgContext(db, orgId, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversation)
        .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
        .limit(1)
      if (!conv) return "missing-conversation"
      if (conv.agentStatus !== "on") return "agent-off"
      const cfg = await getAgentConfig(tx, orgId)
      if (!cfg.enabled) return "agent-disabled"
      const [trigger] = await tx
        .select()
        .from(message)
        .where(and(eq(message.id, triggerMessageId), eq(message.organizationId, orgId)))
        .limit(1)
      if (!trigger) return "missing-trigger"
      if (matchesHandoff(trigger.body, cfg.handoffKeywords)) {
        const toolCtx = baseToolCtx(db, orgId, conversationId, conv.contactId, runtime.secretsKey)
        await performHandoff(toolCtx, `palabra clave en: ${(trigger.body ?? "").slice(0, 120)}`)
        return "handoff"
      }
      // Ráfaga superseded: el trigger ya no está entre los últimos 5 inbound.
      const recent = await tx
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.conversationId, conversationId), eq(message.direction, "in")))
        .orderBy(desc(message.createdAt), desc(message.id))
        .limit(5)
      if (!recent.some((r) => r.id === triggerMessageId)) return "superseded"
      return null
    })
    if (skip) {
      await ledger(db, orgId, {
        conversationId,
        triggerMessageId,
        model: runtime.modelName,
        status: skip === "handoff" ? "handoff" : "omitida",
        startedAt,
        endedAt: new Date(),
        error: skip,
      })
      return "done"
    }

    const toolCtx = await withOrgContext(db, orgId, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversation)
        .where(eq(conversation.id, conversationId))
        .limit(1)
      if (!conv) throw new Error("Conversación no encontrada")
      return baseToolCtx(db, orgId, conversationId, conv.contactId, runtime.secretsKey)
    })
    const model = createConfiguredChatModel(runtime.modelName, runtime.llm)
    const graph = compileAgentGraph(model, toolCtx, runtime.checkpointer)
    await graph.invoke(
      { messages: [], turnCount: 0 },
      {
        configurable: { thread_id: `${orgId}:${conversationId}` },
        ...(runtime.callbacks ? { callbacks: runtime.callbacks } : {}),
      },
    )
    await ledger(db, orgId, {
      conversationId,
      triggerMessageId,
      model: runtime.modelName,
      status: toolCtx.handedOff ? "handoff" : "ok",
      startedAt,
      endedAt: new Date(),
      latencyMs: Date.now() - startedAt.getTime(),
      inputTokens: toolCtx.usage.reported ? toolCtx.usage.inputTokens : null,
      outputTokens: toolCtx.usage.reported ? toolCtx.usage.outputTokens : null,
      toolsUsed: toolCtx.toolsUsed,
    })
    return "done"
  } catch (error) {
    if (msg.read_ct >= 2) {
      const detail = error instanceof Error ? error.message : String(error)
      await withOrgContext(db, orgId, async (tx) => {
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          action: "agent.error",
          entity: "conversation",
          entityId: conversationId,
          metadata: { error: detail.slice(0, 500) },
        })
      }).catch(() => {})
      const toolCtx = baseToolCtx(db, orgId, conversationId, "", runtime.secretsKey)
      await performHandoff(toolCtx, "error del agente").catch(() => {})
      await ledger(db, orgId, {
        conversationId,
        triggerMessageId,
        model: runtime.modelName,
        status: "error",
        startedAt,
        endedAt: new Date(),
        latencyMs: Date.now() - startedAt.getTime(),
        error: detail.slice(0, 500),
      })
      return "done"
    }
    return "retry"
  }
}

/** Ciclo completo: corre el agente y recién entonces hace ack. */
export async function consumeAgentRun(
  db: Db,
  runtime: AgentRuntime,
  msg: QueueMessage<AgentRunJob>,
): Promise<void> {
  const verdict = await processAgentRun(db, runtime, msg)
  if (verdict === "done") {
    await db.execute(sql`select pgmq.delete('agent_runs', ${Number(msg.msg_id)}::bigint)`)
  }
}

export interface SimulationResult {
  reply: string
  toolsUsed: string[]
  handedOff: boolean
  inputTokens: number | null
  outputTokens: number | null
  model: string
  latencyMs: number
}

function messageText(msg: BaseMessage): string {
  const content = msg.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      if (typeof part === "string") {
        texts.push(part)
      } else if (part !== null && typeof part === "object" && "text" in part && typeof part.text === "string") {
        texts.push(part.text)
      }
    }
    return texts.join("\n")
  }
  return ""
}

/**
 * Simula un turno con el modelo y las instrucciones vigentes sin efectos
 * externos ni persistencia: sin checkpointer (grafo sin memoria), las
 * herramientas corren en dryRun (describen, no escriben), el mensaje
 * hipotético no se persiste y no se escribe el libro. Solo lecturas RLS.
 */
export async function simulateAgentTurn(
  db: Db,
  deps: { secretsKey: Buffer; modelName?: string; apiKey?: string; baseUrl?: string },
  input: { orgId: string; conversationId: string; text: string; model?: string },
): Promise<SimulationResult> {
  const { orgId, conversationId } = input
  const text = input.text.trim()
  if (!text) throw new Error("El mensaje a simular es obligatorio")
  const modelName = input.model?.trim() || deps.modelName || "fake"
  const startedAt = new Date()
  const contactId = await withOrgContext(db, orgId, async (tx) => {
    const [conv] = await tx
      .select({ contactId: conversation.contactId })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (!conv) throw new Error("Conversación no encontrada")
    return conv.contactId
  })
  const toolCtx = baseToolCtx(db, orgId, conversationId, contactId, deps.secretsKey)
  toolCtx.dryRun = true
  toolCtx.draftText = text.slice(0, 4000)
  const model = createConfiguredChatModel(modelName, { apiKey: deps.apiKey, baseUrl: deps.baseUrl })
  const graph = compileAgentGraph(model, toolCtx)
  const state = (await graph.invoke(
    { messages: [], turnCount: 0 },
    { configurable: { thread_id: `${orgId}:${conversationId}:simulacion` } },
  )) as { messages: BaseMessage[] }
  const replies = state.messages.filter((m) => m instanceof AIMessage)
  const last = replies[replies.length - 1]
  const latencyMs = Date.now() - startedAt.getTime()
  return {
    reply: last ? messageText(last) : "(sin respuesta)",
    toolsUsed: toolCtx.toolsUsed,
    handedOff: toolCtx.handedOff,
    inputTokens: toolCtx.usage.reported ? toolCtx.usage.inputTokens : null,
    outputTokens: toolCtx.usage.reported ? toolCtx.usage.outputTokens : null,
    model: modelName,
    latencyMs,
  }
}
