import type { Callbacks } from "@langchain/core/callbacks/manager"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { Runnable } from "@langchain/core/runnables"
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { type AgentRunJob, type Db, type QueueMessage, withOrgContext } from "@odentia/db"
import { conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import {
  type AgentConfig,
  beginCommercialFollowUpCoordination,
  countAgentModelRunsToday,
  deriveCommercialFollowUpCoordination,
  getAgentConfig,
  getAgentLlmSecrets,
  notifyAgentProviderProblem,
  type RecordRunInput,
  recordAgentRun,
  reportAgentNoReply,
} from "@odentia/services"
import { and, desc, eq, sql } from "drizzle-orm"
import { compileAgentGraph } from "./graph.js"
import {
  createConfiguredChatModel,
  describeProviderProblem,
  isProviderConfigError,
  LlmConfigError,
  type LlmSpec,
  type OrgLlmSecrets,
  type PlatformLlm,
  resolveLlmSpec,
} from "./llm.js"
import { type AgentToolCtx, performHandoff } from "./tools.js"
export interface AgentRuntime {
  checkpointer: PostgresSaver
  /** Proveedor de la plataforma; la organización puede traer el suyo. */
  platform: PlatformLlm
  /** Sustituye la construcción del modelo (pruebas con un modelo guionizado). */
  createModel?: (spec: LlmSpec) => Promise<Runnable<BaseMessage[], AIMessage>>
  secretsKey: Buffer
  callbacks?: Callbacks
}

/**
 * Modelo efectivo de la organización: proveedor propio descifrado o el de la
 * plataforma. Lanza LlmConfigError si la configuración no sirve.
 */
export async function resolveOrgLlm(
  tx: Db,
  orgId: string,
  cfg: AgentConfig,
  runtime: Pick<AgentRuntime, "platform" | "secretsKey">,
  override?: string | null,
): Promise<LlmSpec> {
  let secrets: OrgLlmSecrets | null = null
  if (cfg.hasLlmApiKey) {
    try {
      secrets = await getAgentLlmSecrets(tx, orgId, runtime.secretsKey)
    } catch {
      // Clave de cifrado rotada o fila corrupta: es configuración, no un fallo transitorio.
      throw new LlmConfigError("API_KEY_UNREADABLE", "No se pudo leer la clave guardada del proveedor: vuelve a guardarla")
    }
  }
  return resolveLlmSpec(cfg, secrets, runtime.platform, override)
}

/** Problema del proveedor que no se arregla reintentando. */
type ProviderProblem = ReturnType<typeof describeProviderProblem>

/** Motivo de la derivación: fijo por tipo de problema, nunca el texto del proveedor. */
function handoffReasonFor(problem: ProviderProblem): string {
  switch (problem.code) {
    case "DAILY_LIMIT":
      return "El agente alcanzó su tope diario de corridas"
    case "PROVIDER_QUOTA":
      return "El proveedor del modelo del agente no tiene saldo o cuota"
    default:
      return "El agente no puede usar el proveedor del modelo; revisa Configuración › Agente"
  }
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
    replySettled: false,
    dryRun: false,
    ...(options.runInstruction ? { runInstruction: options.runInstruction } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.commercialCoordinationId
      ? { commercialCoordinationId: options.commercialCoordinationId }
      : {}),
    toolsUsed: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      calls: 0,
      reported: false,
      cacheReported: false,
    },
  }
}

async function ledger(db: Db, orgId: string, input: RecordRunInput): Promise<void> {
  await withOrgContext(db, orgId, (tx) => recordAgentRun(tx, orgId, input)).catch(() => {})
}

/**
 * Ejecuta una corrida del agente. Devuelve "done" (ack) o "retry".
 * Excepción → no ack (1 reintento vía vt); con read_ct>=2 audita
 * `agent.error`, deriva a humano y hace ack. Lo que lanza una herramienta
 * no llega aquí: ToolNode lo devuelve al modelo como mensaje de error.
 * Cada corrida real queda en el libro de supervisión (tokens/coste solo si
 * el proveedor los da). Una corrida por mensaje entrante que deja el hilo
 * sin respuesta ni derivación se registra `sin_respuesta` y avisa al
 * equipo: nunca cuenta como correcta.
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
  // Uso de la corrida en curso, para registrarlo también si termina en error.
  let runUsage: AgentToolCtx["usage"] | null = null
  // Modelo resuelto, para registrarlo aunque falle antes o después.
  let effectiveModel = runtime.platform.modelName
  let configProblem: ProviderProblem | null = null
  try {
    let prepared:
      | { skip: { reason: string; model: string } }
      | { toolCtx: AgentToolCtx; spec: LlmSpec; cfg: AgentConfig }
    // La configuración del proveedor es estado de la organización: su fallo
    // no debe reintentarse ni derivar en silencio.
    const resolveLlm = async (tx: Db, cfg: AgentConfig): Promise<LlmSpec | null> => {
      try {
        return await resolveOrgLlm(tx, orgId, cfg, runtime)
      } catch (error) {
        if (!(error instanceof LlmConfigError)) throw error
        configProblem = describeProviderProblem(error)
        return null
      }
    }
    if (msg.message.kind === "inbound_message") {
      const inboundJob = msg.message
      prepared = await withOrgContext(db, orgId, async (tx) => {
        const [conv] = await tx
          .select()
          .from(conversation)
          .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
          .limit(1)
        if (!conv) return { skip: { reason: "missing-conversation", model: effectiveModel } }
        if (conv.agentStatus !== "on") {
          return { skip: { reason: "agent-off", model: effectiveModel } }
        }
        const cfg = await getAgentConfig(tx, orgId)
        if (cfg.model?.trim()) effectiveModel = cfg.model.trim()
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
        const spec = await resolveLlm(tx, cfg)
        if (!spec) return { skip: { reason: "llm-config", model: effectiveModel } }
        return {
          toolCtx: baseToolCtx(db, orgId, conversationId, conv.contactId, runtime.secretsKey, {
            triggerId: inboundJob.messageId,
          }),
          spec,
          cfg,
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
        if (cfg.model?.trim()) effectiveModel = cfg.model.trim()
        if (!coordination.run) {
          return {
            skip: {
              reason: `commercial-follow-up:${coordination.status}:${coordination.reason ?? "sin motivo"}`,
              model: effectiveModel,
            },
          }
        }
        const spec = await resolveLlm(tx, cfg)
        if (!spec) return { skip: { reason: "llm-config", model: effectiveModel } }
        return {
          spec,
          cfg,
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
        }
      })
    }
    if ("skip" in prepared && configProblem) {
      // Sin modelo utilizable: el interlocutor pasa a una persona y quien
      // administra el agente recibe un único aviso por problema y día.
      return finishWithProviderProblem(configProblem)
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
        llmCalls: 0,
        error: prepared.skip.reason,
      })
      return "done"
    }
    const { toolCtx, spec, cfg } = prepared
    effectiveModel = spec.modelName
    runUsage = toolCtx.usage
    // Tope diario: acota el gasto ante ráfagas o abuso del canal público. Al
    // alcanzarlo, el caso pasa a una persona y se avisa una vez por día.
    const usedToday = await withOrgContext(db, orgId, (tx) => countAgentModelRunsToday(tx, orgId))
    if (usedToday >= cfg.dailyRunLimit) {
      return finishWithProviderProblem({
        code: "DAILY_LIMIT",
        detail: `Se alcanzó el tope diario de ${cfg.dailyRunLimit} corridas del agente`,
      })
    }
    const model = runtime.createModel ? await runtime.createModel(spec) : await createConfiguredChatModel(spec)
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
    // Sin envío ni derivación en esta corrida: se avisa al equipo salvo que
    // el hilo ya tenga una respuesta posterior al disparador (reentrega o
    // cola atrasada). Un fallo del aviso no reintenta la corrida: volvería a
    // llamar al modelo.
    const unanswered =
      inboundMessageId !== null && !toolCtx.handedOff && !toolCtx.replySettled
        ? await withOrgContext(db, orgId, (tx) =>
            reportAgentNoReply(tx, orgId, { conversationId, triggerMessageId: inboundMessageId }),
          ).catch(() => true)
        : false
    await ledger(db, orgId, {
      conversationId,
      triggerMessageId: inboundMessageId,
      model: effectiveModel,
      status: toolCtx.handedOff ? "handoff" : unanswered ? "sin_respuesta" : "ok",
      startedAt,
      endedAt: new Date(),
      latencyMs: Date.now() - startedAt.getTime(),
      inputTokens: toolCtx.usage.reported ? toolCtx.usage.inputTokens : null,
      outputTokens: toolCtx.usage.reported ? toolCtx.usage.outputTokens : null,
      cachedInputTokens: toolCtx.usage.cacheReported ? toolCtx.usage.cachedInputTokens : null,
      llmCalls: toolCtx.usage.calls,
      toolsUsed: toolCtx.toolsUsed,
    })
    return "done"
  } catch (error) {
    if (isProviderConfigError(error)) return finishWithProviderProblem(describeProviderProblem(error))
    if (msg.read_ct >= 2) {
      const detail = error instanceof Error ? error.message : String(error)
      await withOrgContext(db, orgId, (tx) =>
        tx.insert(auditEvent).values({
          organizationId: orgId,
          action: "agent.error",
          entity: "conversation",
          entityId: conversationId,
          metadata: { error: detail.slice(0, 500) },
        }),
      ).catch(() => {})
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
        inputTokens: runUsage?.reported ? runUsage.inputTokens : null,
        outputTokens: runUsage?.reported ? runUsage.outputTokens : null,
        cachedInputTokens: runUsage?.cacheReported ? runUsage.cachedInputTokens : null,
        llmCalls: runUsage?.calls ?? null,
        error: detail.slice(0, 500),
      })
      return "done"
    }
    return "retry"
  }

  /**
   * Proveedor inutilizable (configuración, credencial rechazada, tope
   * diario): no se reintenta, el caso pasa a una persona y el aviso a quien
   * administra el agente se deduplica por problema y día.
   */
  async function finishWithProviderProblem(problem: ProviderProblem): Promise<"done"> {
    await withOrgContext(db, orgId, (tx) => notifyAgentProviderProblem(tx, orgId, problem)).catch(() => {})
    const toolCtx = baseToolCtx(db, orgId, conversationId, "", runtime.secretsKey, {
      triggerId: inboundMessageId ?? coordinationId,
      ...(coordinationId ? { commercialCoordinationId: coordinationId } : {}),
    })
    await performHandoff(toolCtx, handoffReasonFor(problem)).catch(() => {})
    await ledger(db, orgId, {
      conversationId,
      triggerMessageId: inboundMessageId,
      model: effectiveModel,
      status: "error",
      startedAt,
      endedAt: new Date(),
      latencyMs: Date.now() - startedAt.getTime(),
      llmCalls: runUsage?.calls ?? 0,
      error: `${problem.code}: ${problem.detail}`.slice(0, 500),
    })
    return "done"
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
  /** Texto que se habría enviado; si `replied` es falso, lo que dijo el modelo sin enviarlo. */
  reply: string
  /** El modelo usó la herramienta de envío: en una corrida real habría respuesta. */
  replied: boolean
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
  deps: Pick<AgentRuntime, "platform" | "secretsKey">,
  input: { orgId: string; conversationId: string; text: string; model?: string },
): Promise<SimulationResult> {
  const { orgId, conversationId } = input
  const text = input.text.trim()
  if (!text) throw new Error("El mensaje a simular es obligatorio")
  const startedAt = new Date()
  const { contactId, spec } = await withOrgContext(db, orgId, async (tx) => {
    const [conv] = await tx
      .select({ contactId: conversation.contactId })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (!conv) throw new Error("Conversación no encontrada")
    // Mismo resolvedor que la corrida real; el parámetro solo cambia el nombre.
    const cfg = await getAgentConfig(tx, orgId)
    return { contactId: conv.contactId, spec: await resolveOrgLlm(tx, orgId, cfg, deps, input.model) }
  })
  const modelName = spec.modelName
  const toolCtx = baseToolCtx(db, orgId, conversationId, contactId, deps.secretsKey)
  toolCtx.dryRun = true
  toolCtx.draftText = text.slice(0, 4000)
  const model = await createConfiguredChatModel(spec)
  const graph = compileAgentGraph(model, toolCtx)
  const state = (await graph.invoke(
    { messages: [], turnCount: 0 },
    { configurable: { thread_id: `${orgId}:${conversationId}:simulacion` } },
  )) as { messages: BaseMessage[] }
  const replies = state.messages.filter((m) => m instanceof AIMessage)
  const last = replies[replies.length - 1]
  const latencyMs = Date.now() - startedAt.getTime()
  return {
    reply: toolCtx.simulatedReply ?? ((last ? messageText(last) : "") || "(sin respuesta)"),
    replied: toolCtx.replySettled,
    toolsUsed: toolCtx.toolsUsed,
    handedOff: toolCtx.handedOff,
    inputTokens: toolCtx.usage.reported ? toolCtx.usage.inputTokens : null,
    outputTokens: toolCtx.usage.reported ? toolCtx.usage.outputTokens : null,
    model: modelName,
    latencyMs,
  }
}
