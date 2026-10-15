import type { Callbacks } from "@langchain/core/callbacks/manager"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { Runnable } from "@langchain/core/runnables"
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import { channelAdapters } from "@odentia/channels"
import { type AgentRunJob, type Db, type QueueMessage, sendAgentRun, withOrgContext } from "@odentia/db"
import { agentRunLedger, type AnswerBasisItem, type AnswerCheck } from "@odentia/db/schema/agent"
import { channelConnection, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import {
  type AgentConfig,
  countAgentModelRunsToday,
  automationReplyOf,
  getAgentConfig,
  getLesson,
  lessonImpact,
  ServiceError,
  DEFAULT_AGENT_LLM,
  getOrgLocale,
  nextAgentOpening,
  notifyAgentProviderProblem,
  type RecordRunInput,
  recordAgentRun,
  type SearchEmbedder,
  reportAgentNoReply,
  toolsDisabledBy,
} from "@odentia/services"
import { and, desc, eq, inArray, or, sql } from "drizzle-orm"
import { organization } from "@odentia/db/schema/auth"
import { createDecisionModel, type DecisionModel, type DecisionProvider, type PlatformDecisions } from "./decision/index.js"
import { BURST_HORIZON_MS, triageState } from "./decision/points.js"
import { offTopicReply, readRoute, ROUTE_QUESTIONS, routeHandoff } from "./decision/route.js"
import { decideRoute, recordShadowUnavailable, runShadowTriage } from "./decision/shadow.js"
import { compileAgentGraph } from "./graph.js"
import {
  createConfiguredChatModel,
  describeProviderProblem,
  isProviderConfigError,
  LlmConfigError,
  llmModelName,
  type LlmSpec,
  type PlatformLlm,
  resolveLlmSpec,
} from "./llm.js"
import {
  type AgentSandboxState,
  type AgentToolCtx,
  type LessonOverrides,
  makeAgentTools,
  noticeAfterHandoff,
  performHandoff,
  SANDBOX_NIL_ID,
  TOOL_ACTION_LABEL,
} from "./tools.js"
export interface AgentRuntime {
  checkpointer: PostgresSaver
  /** Cuentas de odentIA en los proveedores; la organización solo elige el modelo. */
  platform: PlatformLlm
  /** Sustituye la construcción del modelo (pruebas con un modelo guionizado). */
  createModel?: (spec: LlmSpec) => Promise<Runnable<BaseMessage[], AIMessage>>
  /** Credenciales de plataforma de los modelos de decisión (sombra). */
  decisions?: PlatformDecisions
  /** Sustituye el modelo de decisión (pruebas). */
  createDecisionModel?: (provider: DecisionProvider) => DecisionModel | null
  /**
   * Espera a que la persona termine de escribir: la corrida no empieza hasta
   * que lleva `quietMs` sin enviar nada, con un tope de `maxWaitMs` desde su
   * primer mensaje sin responder. Sin indicar, no espera.
   */
  burst?: { quietMs: number; maxWaitMs: number }
  /** Dirección pública de la plataforma, para los enlaces que el agente entrega (reservar una cita). */
  publicUrl?: { webURL: string; cookieDomain: string }
  /** Quien vectoriza para buscar por significado; sin él, se busca por palabras. */
  embedder?: SearchEmbedder
  secretsKey: Buffer
  callbacks?: Callbacks
  /** Reloj de la corrida (pruebas); sin él, la hora real. */
  now?: () => Date
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
/** La corrida se pospuso porque la persona seguía escribiendo; no deja fila en el libro. */
const BURST_WAITING = "burst-waiting"

/**
 * Herramientas que en esta organización no pueden servir: la de plantillas
 * cuando ningún canal activo las admite. Se decide por organización y no por
 * hilo a propósito: las herramientas van al principio de lo que el proveedor
 * guarda en caché, y una lista distinta por hilo partiría esa caché en
 * variantes para ahorrar un esquema.
 */
async function orgToolExclusions(tx: Db, orgId: string, cfg: AgentConfig): Promise<string[]> {
  const connections = await tx
    .select({ provider: channelConnection.provider })
    .from(channelConnection)
    .where(and(eq(channelConnection.organizationId, orgId), eq(channelConnection.status, "active")))
  const templates = connections.some(
    (row) => channelAdapters[row.provider as keyof typeof channelAdapters]?.capabilities.templates === true,
  )
  // Una función apagada en la ficha del agente se lleva sus herramientas: el
  // modelo ni las ve, no depende de que obedezca una instrucción.
  return [...(templates ? [] : ["send_template"]), ...toolsDisabledBy("recepcion", cfg.disabledFunctions)]
}

/**
 * El nombre con que la clínica se muestra al público (el de la organización),
 * no su razón social: así se presenta también el agente.
 */
async function publicClinicName(db: Db, orgId: string): Promise<string> {
  const [row] = await withOrgContext(db, orgId, (tx) =>
    tx.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId)).limit(1),
  )
  return row?.name ?? "la clínica"
}

/** Motivos en el libro de una corrida que el sistema no deja empezar por un límite de la clínica. */
const OUT_OF_CHANNEL = "canal-no-atendido"
const OUT_OF_HOURS = "fuera-de-horario"

/**
 * Límites que aplica el sistema antes de llamar al modelo: canales donde el
 * agente atiende y franja del día en que responde (en la zona de la clínica;
 * una franja puede cruzar la medianoche). Fuera de ellos el hilo queda para
 * el equipo, como cuando el agente está apagado.
 */
async function agentLimit(tx: Db, orgId: string, cfg: AgentConfig, connectionId: string, at: Date): Promise<string | null> {
  if (cfg.channels) {
    const [connection] = await tx
      .select({ channel: channelConnection.channel })
      .from(channelConnection)
      .where(and(eq(channelConnection.organizationId, orgId), eq(channelConnection.id, connectionId)))
      .limit(1)
    if (!connection || !cfg.channels.includes(connection.channel)) return OUT_OF_CHANNEL
  }
  if (cfg.activeFromMin !== null && cfg.activeUntilMin !== null) {
    const zone = await getOrgLocale(tx, orgId)
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at)
    const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
    const now = pick("hour") * 60 + pick("minute")
    const from = cfg.activeFromMin
    const until = cfg.activeUntilMin
    const inside = from < until ? now >= from && now < until : now >= from || now < until
    if (!inside) return OUT_OF_HOURS
  }
  return null
}

function baseToolCtx(
  db: Db,
  orgId: string,
  conversationId: string,
  contactId: string,
  secretsKey: Buffer,
  options: {
    triggerId?: string | null
    excludedTools?: readonly string[]
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
    replySettled: false,
    dryRun: false,
    ...(options.excludedTools?.length ? { excludedTools: options.excludedTools } : {}),
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
  const clock = runtime.now ?? (() => new Date())
  // Mensaje que la corrida atiende; con una ráfaga pasa a ser el último leído,
  // y el resto de la ráfaga se anota al terminar para que sus corridas no repitan.
  let inboundMessageId: string | null = msg.message.messageId
  let coveredMessageIds: string[] = []
  // Lo que la persona escribió seguido, del más antiguo al más reciente: es lo que recibe quien toma el caso.
  let burstTexts: string[] = []
  const startedAt = new Date()
  // Uso de la corrida en curso, para registrarlo también si termina en error.
  let runUsage: AgentToolCtx["usage"] | null = null
  // Modelo resuelto, para registrarlo aunque falle antes o después.
  let effectiveModel = llmModelName(DEFAULT_AGENT_LLM, runtime.platform)
  let configProblem: ProviderProblem | null = null
  try {
    let prepared:
      | { skip: { reason: string; model: string; silent?: boolean } }
      | { toolCtx: AgentToolCtx; spec: LlmSpec; cfg: AgentConfig; attention: number }
    // La configuración del proveedor es estado de la organización: su fallo
    // no debe reintentarse ni derivar en silencio.
    const resolveLlm = (cfg: AgentConfig): LlmSpec | null => {
      try {
        return resolveLlmSpec(cfg, runtime.platform)
      } catch (error) {
        if (!(error instanceof LlmConfigError)) throw error
        configProblem = describeProviderProblem(error)
        return null
      }
    }
    const inboundJob = msg.message
    prepared = await withOrgContext(db, orgId, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversation)
        .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
        .limit(1)
      if (!conv) return { skip: { reason: "missing-conversation", model: effectiveModel } }
      // El agente nunca responde en una conversación cerrada (ADR 0024): un entrante la reabre antes.
      if (conv.status !== "open") return { skip: { reason: "conversation-closed", model: effectiveModel } }
      if (conv.agentStatus !== "on") {
        return { skip: { reason: "agent-off", model: effectiveModel } }
      }
      const cfg = await getAgentConfig(tx, orgId)
      effectiveModel = llmModelName(cfg.llm, runtime.platform)
      if (!cfg.enabled) return { skip: { reason: "agent-disabled", model: effectiveModel } }
      const now = clock()
      const limit = await agentLimit(tx, orgId, cfg, conv.channelConnectionId, now)
      if (limit === OUT_OF_HOURS && cfg.activeFromMin !== null && cfg.activeUntilMin !== null) {
        // Fuera del horario del agente lo que escribió no se pierde: la misma
        // corrida vuelve a la cola para cuando abra y entonces atiende todo lo
        // que quedó sin responder (ADR 0024).
        const zone = await getOrgLocale(tx, orgId)
        const opensAt = nextAgentOpening(now, zone.timezone, { fromMin: cfg.activeFromMin, untilMin: cfg.activeUntilMin })
        const delaySeconds = Math.max(1, Math.ceil((opensAt.getTime() - now.getTime()) / 1000))
        await sendAgentRun(tx, { ...inboundJob, deferred: true }, { delaySeconds })
        return { skip: { reason: OUT_OF_HOURS, model: effectiveModel, silent: true } }
      }
      if (limit) return { skip: { reason: limit, model: effectiveModel } }
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
      // Una corrida pospuesta hasta la apertura del horario atiende todo lo que
      // quedó sin responder, aunque pase de la ventana de ráfaga.
      const horizon = inboundJob.deferred ? Number.NEGATIVE_INFINITY : now.getTime() - BURST_HORIZON_MS
      const pendingTail: { id: string; body: string | null; createdAt: Date }[] = []
      for (const item of recent) {
        if (item.direction !== "in" || item.createdAt.getTime() < horizon) break
        pendingTail.push(item)
      }
      // La persona sigue escribiendo: responder ahora daría una respuesta a
      // medias y otra corrida enseguida. Se vuelve a encolar esta misma
      // corrida para cuando lleve un rato en silencio, sin pasar del tope
      // desde su primer mensaje. Reencolar (y no descartar) garantiza que
      // alguna corrida atienda la ráfaga aunque no llegue nada más.
      const newest = pendingTail[0]
      const oldest = pendingTail[pendingTail.length - 1]
      if (runtime.burst && newest && oldest) {
        const sinceLast = now.getTime() - newest.createdAt.getTime()
        const waited = now.getTime() - oldest.createdAt.getTime()
        const remaining = Math.min(runtime.burst.quietMs - sinceLast, runtime.burst.maxWaitMs - waited)
        if (remaining > 0) {
          await sendAgentRun(tx, msg.message, { delaySeconds: Math.max(1, Math.ceil(remaining / 1000)) })
          return { skip: { reason: BURST_WAITING, model: effectiveModel, silent: true } }
        }
      }
      const burst = pendingTail.some((item) => item.id === trigger.id)
        ? pendingTail
        : [...pendingTail, { id: trigger.id, body: trigger.body }]
      const latestId = burst[0]?.id ?? trigger.id
      inboundMessageId = latestId
      coveredMessageIds = burst.map((item) => item.id).filter((id) => id !== latestId)
      burstTexts = [...burst].reverse().map((item) => (item.body ?? "").trim()).filter(Boolean)
      const keyword = burst.find((item) => matchesHandoff(item.body, cfg.handoffKeywords))
      if (keyword) {
        const toolCtx = baseToolCtx(db, orgId, conversationId, conv.contactId, runtime.secretsKey, {
          triggerId: latestId,
        })
        await performHandoff(toolCtx, `palabra clave en: ${(keyword.body ?? "").slice(0, 120)}`)
        // Derivar siempre avisa: la persona recibe el aviso fijo, sin modelo.
        toolCtx.treatment = cfg.treatment
        await noticeAfterHandoff(toolCtx)
        return { skip: { reason: "handoff", model: effectiveModel } }
      }
      const spec = resolveLlm(cfg)
      if (!spec) return { skip: { reason: "llm-config", model: effectiveModel } }
      return {
        toolCtx: baseToolCtx(db, orgId, conversationId, conv.contactId, runtime.secretsKey, {
          triggerId: latestId,
          excludedTools: await orgToolExclusions(tx, orgId, cfg),
        }),
        spec,
        cfg,
        attention: conv.attentionStartedAt.getTime(),
      }
    })
    if ("skip" in prepared && configProblem) {
      // Sin modelo utilizable: el interlocutor pasa a una persona y quien
      // administra el agente recibe un único aviso por problema y día.
      return finishWithProviderProblem(configProblem)
    }
    if ("skip" in prepared && prepared.skip.silent) {
      // Ya consta en el libro quién lo atendió, o la corrida quedó pospuesta: otra fila solo añadiría ruido.
      return "done"
    }
    if ("skip" in prepared) {
      await ledger(db, orgId, {
        conversationId,
        triggerMessageId: inboundMessageId,
        model: prepared.skip.model,
        status: prepared.skip.reason === "handoff" ? "handoff" : "omitida",
        startedAt,
        endedAt: new Date(),
        llmCalls: 0,
        error: prepared.skip.reason,
      })
      return "done"
    }
    const { toolCtx, spec, cfg, attention } = prepared
    effectiveModel = spec.modelName
    toolCtx.treatment = cfg.treatment
    toolCtx.modelName = spec.modelName
    toolCtx.verifyReplies = cfg.replyCheckEnabled
    toolCtx.emojis = cfg.emojis
    if (runtime.publicUrl) toolCtx.publicUrl = runtime.publicUrl
    if (runtime.embedder) toolCtx.embedder = runtime.embedder
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
    // El modelo de decisión se prepara antes del turno: elige qué conocimiento
    // llega y, al terminar, opina en sombra sobre el triaje. Que no pueda
    // construirse (sin credenciales de plataforma) no detiene la corrida.
    let decision: DecisionModel | null = null
    let decisionUnavailable: unknown = null
    if (inboundMessageId !== null && cfg.decisionProvider !== "none") {
      try {
        decision = runtime.createDecisionModel
          ? runtime.createDecisionModel(cfg.decisionProvider)
          : await createDecisionModel(cfg.decisionProvider, runtime.decisions ?? {}, spec)
      } catch (error) {
        decisionUnavailable = error
      }
    }
    toolCtx.decision = decision
    // Decidir antes de escribir: con modelo de decisión, este elige el camino
    // del turno. Si está seguro de que hace falta una persona, el caso pasa
    // sin llamar al modelo que escribe; si no, el turno sigue con el camino
    // indicado (o abierto, si duda o falla).
    const routing = decision !== null && inboundMessageId !== null && cfg.decisionRoutingEnabled
    // Un botón ya dice qué quiere la persona: si el mensaje es el toque de un
    // botón de un mensaje automático, el camino lo fija el código y no se le
    // pregunta al modelo de decisión, que solo ve el texto y no sabe en qué
    // estado quedó la cita.
    const tappedId = inboundMessageId
    const tapped = tappedId !== null
      ? await withOrgContext(db, orgId, (tx) => automationReplyOf(tx, orgId, { conversationId, messageId: tappedId })).catch(() => null)
      : null
    if (tapped?.asks) {
      const reserve = tapped.asks === "reservar"
      toolCtx.route = { path: reserve ? "cita" : "cambio_cita", intent: reserve ? "appointment_request" : "reschedule_or_cancel", handoff: null, confidence: null, urgency: null }
      toolCtx.routeHint = tapped.hint
    } else if (routing && decision && inboundMessageId !== null) {
      toolCtx.route = await decideRoute(db, orgId, decision, { conversationId, triggerMessageId: inboundMessageId })
    }
    const invokeGraph = async () => {
      const model = runtime.createModel ? await runtime.createModel(spec) : await createConfiguredChatModel(spec)
      const graph = compileAgentGraph(model, toolCtx, runtime.checkpointer)
      await graph.invoke(
        { messages: [], turnCount: 0 },
        {
          // Cada atención (desde que se abrió o reabrió) es un hilo propio del grafo.
          configurable: { thread_id: `${orgId}:${conversationId}:${attention}` },
          ...(runtime.callbacks ? { callbacks: runtime.callbacks } : {}),
        },
      )
    }
    if (toolCtx.route?.path === "derivar") {
      // Primero el equipo: el caso queda registrado al instante, con su clase,
      // su prioridad y lo que la persona escribió. Después el aviso a la
      // persona, redactado según lo que contó; si el modelo que escribe falla
      // o no lo deja, sale un aviso fijo: nunca queda sin respuesta.
      const { reason, priority } = routeHandoff(toolCtx.route)
      const said = burstTexts.slice(-8).map((text) => `«${text.slice(0, 300)}»`).join(" · ")
      await performHandoff(toolCtx, reason, said ? `Escribió: ${said}` : reason, priority)
      try {
        await invokeGraph()
      } catch (error) {
        console.error(`agent: el aviso de derivación no se pudo redactar (${error instanceof Error ? error.message : String(error)})`)
      }
      if (!toolCtx.replySettled) await noticeAfterHandoff(toolCtx)
    } else if (toolCtx.route?.path === "fuera_de_tema") {
      // Nada que ver con la clínica y el modelo de decisión muy seguro: un
      // texto fijo, sin llamar al modelo que escribe. Sale por send_reply,
      // con el mismo formato del canal y la misma comprobación.
      const clinic = await publicClinicName(db, orgId)
      const reply = makeAgentTools(toolCtx).find((item) => item.name === "send_reply")
      await reply?.invoke({ text: offTopicReply(cfg.treatment, cfg.personaName, clinic) })
    } else {
      await invokeGraph()
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
      if (decisionUnavailable) {
        // Sin credenciales de plataforma para ese proveedor: queda a la vista en Actividad.
        await recordShadowUnavailable(db, orgId, cfg.decisionProvider, shadow, decisionUnavailable).catch(() => {})
      }
      // Con el camino activo, el triaje ya se hizo antes del turno y quedó
      // registrado ahí: repetirlo en sombra sería otra llamada sin información nueva.
      if (decision && !routing) {
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
        triggerId: inboundMessageId,
      })
      await performHandoff(toolCtx, "error del agente").catch(() => {})
      await noticeAfterHandoff(toolCtx).catch(() => {})
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
      triggerId: inboundMessageId,
    })
    await performHandoff(toolCtx, handoffReasonFor(problem)).catch(() => {})
    // Sin modelo la persona igual sabe que sigue una persona: el aviso es fijo.
    await noticeAfterHandoff(toolCtx).catch(() => {})
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
  /** Fuentes que consultó en el turno. */
  basis: AnswerBasisItem[]
  /** Comprobación de precios, fechas y horas de la última respuesta que intentó enviar. */
  checks: AnswerCheck[]
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
  input: { orgId: string; conversationId: string; text: string },
): Promise<SimulationResult> {
  const { orgId, conversationId } = input
  const text = input.text.trim()
  if (!text) throw new Error("El mensaje a simular es obligatorio")
  const startedAt = new Date()
  const { contactId, spec, excludedTools, verifyReplies, emojis } = await withOrgContext(db, orgId, async (tx) => {
    const [conv] = await tx
      .select({ contactId: conversation.contactId })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (!conv) throw new Error("Conversación no encontrada")
    // Mismo resolvedor y mismas herramientas que la corrida real.
    const cfg = await getAgentConfig(tx, orgId)
    return {
      contactId: conv.contactId,
      spec: resolveLlmSpec(cfg, deps.platform),
      excludedTools: await orgToolExclusions(tx, orgId, cfg),
      verifyReplies: cfg.replyCheckEnabled,
      emojis: cfg.emojis,
    }
  })
  const modelName = spec.modelName
  const toolCtx = baseToolCtx(db, orgId, conversationId, contactId, deps.secretsKey, { excludedTools })
  toolCtx.dryRun = true
  toolCtx.verifyReplies = verifyReplies
  toolCtx.emojis = emojis
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
    basis: toolCtx.basis ?? [],
    checks: toolCtx.lastChecks ?? [],
    inputTokens: toolCtx.usage.reported ? toolCtx.usage.inputTokens : null,
    outputTokens: toolCtx.usage.reported ? toolCtx.usage.outputTokens : null,
    model: modelName,
    latencyMs,
  }
}

export interface SandboxTurn {
  role: "contact" | "agent"
  text: string
}

export interface SandboxResult extends SimulationResult {
  /** Lo que hizo en este turno, dicho para quien prueba. */
  did: string[]
  /** Lo que queda esperando tras este turno y quién lo decide. */
  waiting: string[]
  /** Estado de la prueba: se devuelve tal cual en el turno siguiente. */
  state: AgentSandboxState
}

export const EMPTY_SANDBOX_STATE: AgentSandboxState = { pending: [], recent: [], notes: [], lookups: [] }

/**
 * Un turno de una conversación de prueba: escribes como si fueras un paciente
 * y el agente responde con el modelo, las funciones, la base y el conocimiento
 * vigentes. No hay hilo ni persona real: el historial y lo que el agente dejó
 * pendiente viajan con la propia prueba, así se puede seguir varios turnos
 * (proponer una cita y confirmarla con un «sí»). No envía, no escribe en la
 * base y no deja rastro en el libro. Las lecturas (sedes, tarifas, agenda,
 * conocimiento) sí son las reales de la clínica.
 */
export async function simulateAgentSandbox(
  db: Db,
  deps: Pick<AgentRuntime, "platform" | "secretsKey" | "createModel" | "decisions" | "createDecisionModel" | "embedder">,
  input: {
    orgId: string
    transcript: SandboxTurn[]
    message: string
    state?: AgentSandboxState
    /** Probar con una lección aún sin aprobar, o sin una activa. */
    lessonOverrides?: LessonOverrides
  },
): Promise<SandboxResult> {
  const { orgId } = input
  const text = input.message.trim()
  if (!text) throw new Error("El mensaje de prueba es obligatorio")
  const startedAt = Date.now()
  const { cfg, spec, excludedTools } = await withOrgContext(db, orgId, async (tx) => {
    const cfg = await getAgentConfig(tx, orgId)
    return {
      cfg,
      spec: resolveLlmSpec(cfg, deps.platform),
      excludedTools: await orgToolExclusions(tx, orgId, cfg),
    }
  })
  const toolCtx = baseToolCtx(db, orgId, SANDBOX_NIL_ID, SANDBOX_NIL_ID, deps.secretsKey, { excludedTools })
  toolCtx.dryRun = true
  toolCtx.verifyReplies = cfg.replyCheckEnabled
  toolCtx.emojis = cfg.emojis
  toolCtx.modelName = spec.modelName
  toolCtx.draftText = text.slice(0, 4000)
  if (deps.embedder) toolCtx.embedder = deps.embedder
  const state = structuredClone(input.state ?? EMPTY_SANDBOX_STATE)
  toolCtx.sandbox = { transcript: input.transcript.slice(-40), state }
  if (input.lessonOverrides) toolCtx.lessonOverrides = input.lessonOverrides
  if (cfg.decisionProvider !== "none") {
    try {
      toolCtx.decision = deps.createDecisionModel
        ? deps.createDecisionModel(cfg.decisionProvider)
        : await createDecisionModel(cfg.decisionProvider, deps.decisions ?? {}, spec)
    } catch {
      // Sin credenciales de plataforma la prueba sigue por el camino sin modelo de decisión.
      toolCtx.decision = null
    }
  }
  if (toolCtx.decision && cfg.decisionRoutingEnabled) {
    try {
      const said = toolCtx.sandbox.transcript.filter((turn) => turn.role === "contact")
      toolCtx.route = readRoute(
        await toolCtx.decision.decide(
          triageState(said.map((turn) => ({ direction: "in" as const, body: turn.text })), text),
          ROUTE_QUESTIONS,
        ),
      )
    } catch {
      // Sin camino la prueba sigue como un turno abierto.
      toolCtx.route = null
    }
  }
  if (toolCtx.route?.path === "fuera_de_tema") {
    const clinic = await publicClinicName(db, orgId)
    return {
      reply: offTopicReply(cfg.treatment, cfg.personaName, clinic),
      replied: true,
      toolsUsed: [],
      handedOff: false,
      basis: [],
      checks: [],
      did: ["Respondió con el texto fijo para lo que no es de la clínica, sin llamar al modelo que escribe."],
      waiting: [],
      state,
      inputTokens: null,
      outputTokens: null,
      model: spec.modelName,
      latencyMs: Date.now() - startedAt,
    }
  }
  if (toolCtx.route?.path === "derivar") {
    return {
      reply: "(No respondería: pasa el caso a una persona de tu equipo.)",
      replied: false,
      toolsUsed: [],
      handedOff: true,
      basis: [],
      checks: [],
      did: ["Pasó el caso a una persona sin redactar respuesta: el mensaje lo pide o no le corresponde atenderlo."],
      waiting: [],
      state,
      inputTokens: null,
      outputTokens: null,
      model: spec.modelName,
      latencyMs: Date.now() - startedAt,
    }
  }
  const model = deps.createModel ? await deps.createModel(spec) : await createConfiguredChatModel(spec)
  const graph = compileAgentGraph(model, toolCtx)
  const result = (await graph.invoke(
    { messages: [], turnCount: 0 },
    { configurable: { thread_id: `${orgId}:prueba` } },
  )) as { messages: BaseMessage[] }
  const replies = result.messages.filter((m) => m instanceof AIMessage)
  const last = replies[replies.length - 1]
  // Lo único que queda pendiente es lo que confirma el paciente (ADR 0023).
  const waiting = state.pending.map((item) => `${item.label} (${item.summary}): espera el sí del paciente.`)
  return {
    reply: toolCtx.simulatedReply ?? ((last ? messageText(last) : "") || "(sin respuesta)"),
    replied: toolCtx.replySettled,
    toolsUsed: toolCtx.toolsUsed,
    handedOff: toolCtx.handedOff,
    basis: toolCtx.basis ?? [],
    checks: toolCtx.lastChecks ?? [],
    did: toolCtx.toolsUsed.map((name) => TOOL_ACTION_LABEL[name]).filter((label): label is string => Boolean(label)),
    waiting,
    state,
    inputTokens: toolCtx.usage.reported ? toolCtx.usage.inputTokens : null,
    outputTokens: toolCtx.usage.reported ? toolCtx.usage.outputTokens : null,
    model: spec.modelName,
    latencyMs: Date.now() - startedAt,
  }
}

export interface LessonPreviewCase {
  question: string
  /** Lo que una persona dio por bueno para esa pregunta, si es un caso de prueba. */
  expected: string | null
  /** Cómo responde hoy y cómo respondería con el cambio. */
  before: string
  after: string
  same: boolean
}

export interface LessonPreview {
  cases: LessonPreviewCase[]
  /** Casos de prueba de ese agente y cuántos tocan el tema de la lección. */
  total: number
  touched: number
  model: string
}

/** Tope de casos que se vuelven a responder: cada uno son dos conversaciones con el modelo. */
export const LESSON_PREVIEW_CASES = 3

const sameReply = (a: string, b: string) =>
  a.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase() === b.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase()

/**
 * Prueba una lección antes de decidir: responde la pregunta que la originó y
 * los casos de prueba que tocan su tema, hoy y con el cambio. Para una lección
 * propuesta el cambio es activarla; para una activa, retirarla. Solo se
 * vuelven a responder los casos que tocan el tema (comparación de textos, sin
 * modelo): los demás no reciben nada distinto. No escribe nada.
 */
export async function previewLesson(
  db: Db,
  deps: Pick<AgentRuntime, "platform" | "secretsKey" | "createModel" | "decisions" | "createDecisionModel">,
  input: { orgId: string; lessonId: string },
): Promise<LessonPreview> {
  const { orgId } = input
  const { lesson, impact } = await withOrgContext(db, orgId, async (tx) => {
    const lesson = await getLesson(tx, orgId, input.lessonId)
    return { lesson, impact: await lessonImpact(tx, orgId, lesson) }
  })
  if (lesson.status !== "propuesta" && lesson.status !== "activa") {
    throw new ServiceError("LESSON_NOT_TESTABLE", 409, "Solo se prueba una lección propuesta o activa")
  }
  const asDraft = { id: lesson.id, kind: lesson.kind, title: lesson.title, question: lesson.question, body: lesson.body }
  const entryIds = lesson.knowledgeEntryId ? [lesson.knowledgeEntryId] : []
  // Lo que había antes en el conocimiento, cuando la lección cambia una respuesta que ya existía.
  const previous =
    lesson.kind === "respuesta_oficial" && lesson.knowledgeEntry
      ? lesson.status === "propuesta"
        ? lesson.knowledgeEntry.body
        : lesson.previousBody
      : null
  const without: LessonOverrides = {
    skipIds: [lesson.id],
    skipEntryIds: entryIds,
    extra: previous ? [{ ...asDraft, kind: "respuesta_oficial", title: lesson.knowledgeEntry?.title ?? lesson.title, body: previous }] : [],
  }
  const withIt: LessonOverrides = { skipIds: [lesson.id], skipEntryIds: entryIds, extra: [asDraft] }
  const questions = [
    ...(lesson.question.trim() ? [{ question: lesson.question, expected: lesson.status === "activa" ? lesson.body : null }] : []),
    ...impact.touched.map((item) => ({ question: item.question, expected: item.expected })),
  ].slice(0, LESSON_PREVIEW_CASES)
  const cases: LessonPreviewCase[] = []
  let model = ""
  for (const item of questions) {
    const run = (lessonOverrides: LessonOverrides) =>
      simulateAgentSandbox(db, deps, { orgId, transcript: [], message: item.question, lessonOverrides })
    const before = await run(without)
    const after = await run(withIt)
    model = after.model
    // «Hoy» es sin la lección si aún no se aprobó, y con ella si ya está activa.
    const today = lesson.status === "propuesta" ? before.reply : after.reply
    const changed = lesson.status === "propuesta" ? after.reply : before.reply
    cases.push({ question: item.question, expected: item.expected, before: today, after: changed, same: sameReply(today, changed) })
  }
  return { cases, total: impact.total, touched: impact.touched.length, model }
}
