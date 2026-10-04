import type { Callbacks } from "@langchain/core/callbacks/manager"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { type AgentRunJob, type Db, type QueueMessage, withOrgContext } from "@odentia/db"
import { conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import {
  beginCommercialFollowUpCoordination,
  deriveCommercialFollowUpCoordination,
  getAgentConfig,
  type RecordRunInput,
  recordAgentRun,
} from "@odentia/services"
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
  options: {
    triggerId?: string | null
    runInstruction?: string
    allowedTools?: readonly string[]
    commercialCoordinationId?: string
  } = {},
): AgentToolCtx {
  return {
    db,
    orgId,
    conversationId,
    contactId,
    triggerId: options.triggerId ?? null,
    secretsKey,
    handedOff: false,
    decisionRecorded: false,
    dryRun: false,
    ...(options.runInstruction ? { runInstruction: options.runInstruction } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.commercialCoordinationId
      ? { commercialCoordinationId: options.commercialCoordinationId }
      : {}),
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
  const { orgId, conversationId } = msg.message
  const inboundMessageId = msg.message.kind === "inbound_message" ? msg.message.messageId : null
  const coordinationId =
    msg.message.kind === "overdue_opportunity_follow_up" ? msg.message.coordinationId : null
  const startedAt = new Date()
  try {
    let prepared:
      | { skip: { reason: string; model: string } }
      | { toolCtx: AgentToolCtx; effectiveModel: string }
    if (msg.message.kind === "inbound_message") {
      const inboundJob = msg.message
      prepared = await withOrgContext(db, orgId, async (tx) => {
        const [conv] = await tx
          .select()
          .from(conversation)
          .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
          .limit(1)
        if (!conv) return { skip: { reason: "missing-conversation", model: runtime.modelName } }
        if (conv.agentStatus !== "on") {
          return { skip: { reason: "agent-off", model: runtime.modelName } }
        }
        const cfg = await getAgentConfig(tx, orgId)
        const effectiveModel = cfg.model?.trim() ? cfg.model.trim() : runtime.modelName
        if (!cfg.enabled) return { skip: { reason: "agent-disabled", model: effectiveModel } }
        const [trigger] = await tx
          .select()
          .from(message)
          .where(and(eq(message.id, inboundJob.messageId), eq(message.organizationId, orgId)))
          .limit(1)
        if (!trigger) return { skip: { reason: "missing-trigger", model: effectiveModel } }
        if (matchesHandoff(trigger.body, cfg.handoffKeywords)) {
          const toolCtx = baseToolCtx(db, orgId, conversationId, conv.contactId, runtime.secretsKey, {
            triggerId: inboundJob.messageId,
          })
          await performHandoff(toolCtx, `palabra clave en: ${(trigger.body ?? "").slice(0, 120)}`)
          return { skip: { reason: "handoff", model: effectiveModel } }
        }
        const recent = await tx
          .select({ id: message.id })
          .from(message)
          .where(and(eq(message.conversationId, conversationId), eq(message.direction, "in")))
          .orderBy(desc(message.createdAt), desc(message.id))
          .limit(5)
        if (!recent.some((row) => row.id === inboundJob.messageId)) {
          return { skip: { reason: "superseded", model: effectiveModel } }
        }
        return {
          toolCtx: baseToolCtx(db, orgId, conversationId, conv.contactId, runtime.secretsKey, {
            triggerId: inboundJob.messageId,
          }),
          effectiveModel,
        }
      })
    } else {
      const coordinationJob = msg.message
      prepared = await withOrgContext(db, orgId, async (tx) => {
        const coordination = await beginCommercialFollowUpCoordination(
          tx,
          orgId,
          coordinationJob.coordinationId,
          new Date(),
        )
        const cfg = await getAgentConfig(tx, orgId)
        const effectiveModel = cfg.model?.trim() ? cfg.model.trim() : runtime.modelName
        if (!coordination.run) {
          return {
            skip: {
              reason: `commercial-follow-up:${coordination.status}:${coordination.reason ?? "sin motivo"}`,
              model: effectiveModel,
            },
          }
        }
        return {
          toolCtx: baseToolCtx(
            db,
            orgId,
            coordination.conversationId,
            coordination.contactId,
            runtime.secretsKey,
            {
              triggerId: coordination.triggerId,
              runInstruction: coordination.instruction,
              allowedTools: [
                "send_reply",
                "send_template",
                "leer_contexto_comercial",
                "ver_otros_canales",
                "listar_oportunidades",
                "listar_tareas",
                "request_human_handoff",
              ],
              commercialCoordinationId: coordination.coordinationId,
            },
          ),
          effectiveModel,
        }
      })
    }
    if ("skip" in prepared) {
      await ledger(db, orgId, {
        conversationId,
        triggerMessageId: inboundMessageId,
        model: prepared.skip.model,
        status: prepared.skip.reason === "handoff" || prepared.skip.reason.includes(":derivada:")
          ? "handoff"
          : "omitida",
        startedAt,
        endedAt: new Date(),
        error: prepared.skip.reason,
      })
      return "done"
    }
    const { toolCtx, effectiveModel } = prepared
    const model = createConfiguredChatModel(effectiveModel, runtime.llm)
    const graph = compileAgentGraph(model, toolCtx, runtime.checkpointer)
    await graph.invoke(
      { messages: [], turnCount: 0 },
      {
        configurable: { thread_id: `${orgId}:${conversationId}` },
        ...(runtime.callbacks ? { callbacks: runtime.callbacks } : {}),
      },
    )
    if (coordinationId && !toolCtx.decisionRecorded) {
      await withOrgContext(db, orgId, (tx) =>
        deriveCommercialFollowUpCoordination(
          tx,
          orgId,
          coordinationId,
          "El agente no registró una decisión operativa",
          "Revisa manualmente la próxima acción vencida.",
        ),
      )
      toolCtx.handedOff = true
    }
    await ledger(db, orgId, {
      conversationId,
      triggerMessageId: inboundMessageId,
      model: effectiveModel,
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
      const effectiveModel = await withOrgContext(db, orgId, async (tx) => {
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          action: "agent.error",
          entity: "conversation",
          entityId: conversationId,
          metadata: { error: detail.slice(0, 500) },
        })
        const cfg = await getAgentConfig(tx, orgId)
        return cfg.model?.trim() ? cfg.model.trim() : runtime.modelName
      }).catch(() => runtime.modelName)
      const toolCtx = baseToolCtx(db, orgId, conversationId, "", runtime.secretsKey, {
        triggerId: inboundMessageId ?? coordinationId,
        ...(coordinationId ? { commercialCoordinationId: coordinationId } : {}),
      })
      await performHandoff(toolCtx, "error del agente").catch(() => {})
      await ledger(db, orgId, {
        conversationId,
        triggerMessageId: inboundMessageId,
        model: effectiveModel,
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
 * Simula un solo turno con el modelo y las instrucciones vigentes, sin
 * efectos externos ni persistencia: sin checkpointer (grafo sin memoria),
 * las herramientas corren en dryRun (describen, no escriben), el mensaje
 * hipotético no se persiste y no se escribe el libro. Solo lecturas RLS.
 * No reproduce activaciones ni derivaciones previas ni la memoria de la
 * atención real: el resultado es orientativo, no una equivalencia total.
 */
export async function simulateAgentTurn(
  db: Db,
  deps: { secretsKey: Buffer; modelName?: string; apiKey?: string; baseUrl?: string },
  input: { orgId: string; conversationId: string; text: string; model?: string },
): Promise<SimulationResult> {
  const { orgId, conversationId } = input
  const text = input.text.trim()
  if (!text) throw new Error("El mensaje a simular es obligatorio")
  const startedAt = new Date()
  const { contactId, modelName } = await withOrgContext(db, orgId, async (tx) => {
    const [conv] = await tx
      .select({ contactId: conversation.contactId })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (!conv) throw new Error("Conversación no encontrada")
    // Modelo efectivo único: parámetro explícito, config de la org y default,
    // igual que la corrida real. Se reporta el efectivo.
    const cfg = await getAgentConfig(tx, orgId)
    const resolved = input.model?.trim() || cfg.model?.trim() || deps.modelName || "fake"
    return { contactId: conv.contactId, modelName: resolved }
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
