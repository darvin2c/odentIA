import type { Callbacks } from "@langchain/core/callbacks/manager"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { Runnable } from "@langchain/core/runnables"
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { channelAdapters } from "@odentia/channels"
import { type AgentRunJob, type Db, type QueueMessage, withOrgContext } from "@odentia/db"
import { agentRunLedger } from "@odentia/db/schema/agent"
import { channelConnection, conversation, message } from "@odentia/db/schema/crm"
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
import { and, desc, eq, inArray, or, sql } from "drizzle-orm"
import { createDecisionModel, type DecisionModel, type DecisionProvider, type PlatformDecisions } from "./decision/index.js"
import { recordShadowUnavailable, runShadowTriage } from "./decision/shadow.js"
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
  /** Credenciales de plataforma de los modelos de decisión (sombra). */
  decisions?: PlatformDecisions
  /** Sustituye el modelo de decisión (pruebas). */
  createDecisionModel?: (provider: DecisionProvider) => DecisionModel | null
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

/** Motivo en el libro de un mensaje que otra corrida leyó y atendió. */
const BURST_COVERED = "burst-covered"
/** Antigüedad máxima de un entrante sin responder para contar como parte de la ráfaga. */
const BURST_HORIZON_MS = 30 * 60_000

/**
 * Herramientas que en esta organización no pueden servir: la de plantillas
 * cuando ningún canal activo las admite. Se decide por organización y no por
 * hilo a propósito: las herramientas van al principio de lo que el proveedor
 * guarda en caché, y una lista distinta por hilo partiría esa caché en
 * variantes para ahorrar un esquema.
 */
async function orgToolExclusions(tx: Db, orgId: string): Promise<string[]> {
  const connections = await tx
    .select({ provider: channelConnection.provider })
    .from(channelConnection)
    .where(and(eq(channelConnection.organizationId, orgId), eq(channelConnection.status, "active")))
  const templates = connections.some(
    (row) => channelAdapters[row.provider as keyof typeof channelAdapters]?.capabilities.templates === true,
  )
  return templates ? [] : ["send_template"]
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
    excludedTools?: readonly string[]
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
    ...(options.excludedTools?.length ? { excludedTools: options.excludedTools } : {}),
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
  // Mensaje que la corrida atiende; con una ráfaga pasa a ser el último leído,
  // y el resto de la ráfaga se anota al terminar para que sus corridas no repitan.
  let inboundMessageId = msg.message.kind === "inbound_message" ? msg.message.messageId : null
  let coveredMessageIds: string[] = []
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
      | { skip: { reason: string; model: string; silent?: boolean } }
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
        // ¿Este mensaje ya quedó atendido? Lo está si una corrida respondió o
        // derivó con él como disparador, o si lo dejó anotado entre los que
        // leyó (resto de una ráfaga). También cubre la reentrega de la cola.
        // Es constancia explícita por mensaje: no se deduce de fechas, así que
        // un mensaje que ninguna corrida leyó nunca se da por atendido.
        const [attended] = await tx
          .select({ id: agentRunLedger.id })
          .from(agentRunLedger)
          .where(
            and(
              eq(agentRunLedger.organizationId, orgId),
              eq(agentRunLedger.conversationId, conversationId),
              eq(agentRunLedger.triggerMessageId, trigger.id),
              or(
                inArray(agentRunLedger.status, ["ok", "handoff"]),
                and(eq(agentRunLedger.status, "omitida"), eq(agentRunLedger.error, BURST_COVERED)),
              ),
            ),
          )
          .limit(1)
        if (attended) return { skip: { reason: BURST_COVERED, model: effectiveModel, silent: true } }
        // Ráfaga: los entrantes recientes sin responder al final del hilo,
        // dentro de la misma ventana que lee el contexto. La corrida los
        // atiende todos y su disparador efectivo es el más reciente. Lo
        // antiguo sin responder (un hilo donde el agente estuvo apagado) lo
        // lee el modelo como historial, pero no es ráfaga: ni se anota ni
        // dispara una palabra de derivación de hace días. Acotar solo puede
        // hacer que una corrida se ejecute de más, nunca de menos.
        const recent = await tx
          .select({
            id: message.id,
            direction: message.direction,
            body: message.body,
            createdAt: message.createdAt,
          })
          .from(message)
          .where(and(eq(message.organizationId, orgId), eq(message.conversationId, conversationId)))
          .orderBy(desc(message.createdAt), desc(message.id))
          .limit(20)
        const horizon = Date.now() - BURST_HORIZON_MS
        const pendingTail: { id: string; body: string | null }[] = []
        for (const item of recent) {
          if (item.direction !== "in" || item.createdAt.getTime() < horizon) break
          pendingTail.push(item)
        }
        const burst = pendingTail.some((item) => item.id === trigger.id)
          ? pendingTail
          : [...pendingTail, { id: trigger.id, body: trigger.body }]
        const latestId = burst[0]?.id ?? trigger.id
        inboundMessageId = latestId
        coveredMessageIds = burst.map((item) => item.id).filter((id) => id !== latestId)
        const keyword = burst.find((item) => matchesHandoff(item.body, cfg.handoffKeywords))
        if (keyword) {
          const toolCtx = baseToolCtx(db, orgId, conversationId, conv.contactId, runtime.secretsKey, {
            triggerId: latestId,
          })
          await performHandoff(toolCtx, `palabra clave en: ${(keyword.body ?? "").slice(0, 120)}`)
          return { skip: { reason: "handoff", model: effectiveModel } }
        }
        const spec = await resolveLlm(tx, cfg)
        if (!spec) return { skip: { reason: "llm-config", model: effectiveModel } }
        return {
          toolCtx: baseToolCtx(db, orgId, conversationId, conv.contactId, runtime.secretsKey, {
            triggerId: latestId,
            excludedTools: await orgToolExclusions(tx, orgId),
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
                // El conocimiento del prompt va recortado: sin esta lectura no
                // habría forma de citar entera una respuesta oficial.
                "consultar_conocimiento",
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
    if ("skip" in prepared && prepared.skip.silent) {
      // Ya consta en el libro quién lo atendió: otra fila solo añadiría ruido.
      return "done"
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
    const attendedMessageId = inboundMessageId
    const unanswered =
      attendedMessageId !== null && !toolCtx.handedOff && !toolCtx.replySettled
        ? await withOrgContext(db, orgId, (tx) =>
            reportAgentNoReply(tx, orgId, { conversationId, triggerMessageId: attendedMessageId }),
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
    // Constancia de la ráfaga: solo si la corrida respondió o derivó. Una que
    // quedó sin respuesta no cubre nada y las corridas del resto se ejecutan.
    if (toolCtx.handedOff || !unanswered) {
      for (const coveredId of coveredMessageIds) {
        await ledger(db, orgId, {
          conversationId,
          triggerMessageId: coveredId,
          model: effectiveModel,
          status: "omitida",
          startedAt,
          endedAt: new Date(),
          llmCalls: 0,
          error: BURST_COVERED,
        })
      }
    }
    // Sombra: el modelo de decisión opina sobre el mensaje disparador después
    // de la corrida y solo se registra; nunca cambia el turno ni lo reintenta.
    if (inboundMessageId !== null && cfg.decisionProvider !== "none") {
      const shadow = { conversationId, triggerMessageId: inboundMessageId }
      let decision: DecisionModel | null = null
      try {
        decision = runtime.createDecisionModel
          ? runtime.createDecisionModel(cfg.decisionProvider)
          : await createDecisionModel(cfg.decisionProvider, runtime.decisions ?? {}, spec)
      } catch (error) {
        // Sin credenciales de plataforma para ese proveedor: queda a la vista en Actividad.
        await recordShadowUnavailable(db, orgId, cfg.decisionProvider, shadow, error).catch(() => {})
      }
      if (decision) {
        await runShadowTriage(db, orgId, decision, shadow).catch((error: unknown) => {
          console.error(`agent: sombra de decisión omitida (${error instanceof Error ? error.message : String(error)})`)
        })
      }
    }
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
  const { contactId, spec, excludedTools } = await withOrgContext(db, orgId, async (tx) => {
    const [conv] = await tx
      .select({ contactId: conversation.contactId })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (!conv) throw new Error("Conversación no encontrada")
    // Mismo resolvedor y mismas herramientas que la corrida real; el parámetro solo cambia el nombre.
    const cfg = await getAgentConfig(tx, orgId)
    return {
      contactId: conv.contactId,
      spec: await resolveOrgLlm(tx, orgId, cfg, deps, input.model),
      excludedTools: await orgToolExclusions(tx, orgId),
    }
  })
  const modelName = spec.modelName
  const toolCtx = baseToolCtx(db, orgId, conversationId, contactId, deps.secretsKey, { excludedTools })
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
