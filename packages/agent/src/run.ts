import type { Callbacks } from "@langchain/core/callbacks/manager"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { Runnable } from "@langchain/core/runnables"
import { type AgentRunJob, type Db, type QueueMessage, sendAgentRun, withOrgContext } from "@odentia/db"
import { agentRunLedger, type AnswerBasisItem, type AnswerCheck } from "@odentia/db/schema/agent"
import { channelConnection, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import {
  AGENT_MODEL_LABEL,
  type AgentConfig,
  autoSpamAllowed,
  BLOCKED_RUN_REASON,
  contactScreenFacts,
  leaveSpam,
  markSpamByDecision,
  SPAM_RUN_REASON,
  SPAM_STILL_RUN_REASON,
  SPAM_UNDECIDED_RUN_REASON,
  contactGotAgentTextToday,
  contactHadRunToday,
  countAgentModelRunsToday,
  countContactModelRunsToday,
  askGeneralPermissionAfterBooking,
  getAgentSpendGate,
  hasOpenConversationAction,
  automationReplyOf,
  getAgentConfig,
  getLesson,
  lessonImpact,
  ServiceError,
  assertAgentTestBudget,
  isSaasSendBlocked,
  getOrgLocale,
  nextAgentOpening,
  notifyAgentProviderProblem,
  type RecordRunInput,
  reportModelOutage,
  recordAgentRun,
  type SearchEmbedder,
  type Storage,
  reportAgentNoReply,
  sendOutbound,
  answerToTeamMember,
  TEAM_LIVE_MINUTES,
  toolsDisabledBy,
} from "@odentia/services"
import { and, desc, eq, inArray, or, sql } from "drizzle-orm"
import { organization } from "@odentia/db/schema/auth"
import { createDecisionModel, type DecisionModel, type DecisionProvider, type PlatformDecisions } from "./decision/index.js"
import { BURST_HORIZON_MS, triageState } from "./decision/points.js"
import { offTopicReply, readRoute, ROUTE_QUESTIONS, ROUTE_SPAM, routeHandoff } from "./decision/route.js"
import { type DecisionKeyProblem, decisionKeyProblem, reportDecisionOutage, watchDecisionKey } from "./decision/outage.js"
import { decideRoute, recordShadowUnavailable, runShadowTriage } from "./decision/shadow.js"
import { meterAiUse, takeAiUsage } from "./ai-usage.js"
import { compileAgentGraph } from "./graph.js"
import { noteAskedInterest } from "./interest.js"
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
  /** Cuenta de odentIA en el proveedor del modelo; la organización no elige ni trae la suya. */
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
  /**
   * Almacén de adjuntos: reenviar un presupuesto lleva su PDF. Sin él, el agente
   * no lo envía y deja la tarea a recepción.
   */
  storage?: Storage
  secretsKey: Buffer
  /**
   * Rol owner: con él, un modelo que no responde abre (o suma la clínica a)
   * el caso automático «Modelo sin responder» en Soporte de odentIA.
   */
  ownerDb?: Db
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
      return "Sofi alcanzó su tope diario de corridas"
    case "PROVIDER_QUOTA":
      return "El proveedor del modelo de Sofi no tiene saldo o cuota; ya avisamos a odentIA"
    default:
      return "Sofi no puede usar el modelo ahora; ya avisamos a odentIA"
  }
}

function matchesHandoff(text: string | null, keywords: string[]): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return keywords.some((k) => k.trim() !== "" && lower.includes(k.trim().toLowerCase()))
}

/** Motivo en el libro de un mensaje que otra corrida leyó y atendió. */
const BURST_COVERED = "burst-covered"
/** El equipo tomó o cerró la conversación mientras el modelo redactaba: nada salió. */
const TEAM_TOOK_OVER = "team-took-over"
/**
 * Corridas con modelo por persona y día. Una conversación real larga no llega:
 * cada corrida atiende una ráfaga entera de mensajes.
 */
export const CONTACT_DAILY_RUN_LIMIT = 40
/** Motivo de la derivación de quien llegó al tope por persona. */
const CONTACT_DAILY_LIMIT = "CONTACT_DAILY_LIMIT"
/** Ya pasó hoy al equipo por el tope por persona: lo que siga escribiendo se guarda sin responder. */
const CONTACT_LIMIT_SILENCED = "tope-por-persona"
/** Lo que no es de la clínica ya recibió hoy el texto fijo: no se le repite. */
const OFF_TOPIC_REPEATED = "fuera-de-tema-repetido"
/** La corrida se pospuso porque la persona seguía escribiendo; no deja fila en el libro. */
const BURST_WAITING = "burst-waiting"

/**
 * Herramientas que en esta organización no pueden servir: las de una función
 * apagada en la ficha del agente. Se decide por organización y no por hilo a
 * propósito: las herramientas van al principio de lo que el proveedor guarda
 * en caché, y una lista distinta por hilo partiría esa caché en variantes. El
 * agente no tiene herramienta de plantillas: fuera de las 24 horas retoma el
 * sistema (ADR 0040).
 */
async function orgToolExclusions(_tx: Db, _orgId: string, cfg: AgentConfig): Promise<string[]> {
  // Una función apagada en la ficha del agente se lleva sus herramientas: el
  // modelo ni las ve, no depende de que obedezca una instrucción.
  return toolsDisabledBy("recepcion", cfg.disabledFunctions)
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
      cacheWriteTokens: 0,
      calls: 0,
      reported: false,
      cacheReported: false,
    },
  }
}

/**
 * Fila del libro con lo gastado hasta ahora en la corrida (modelo que
 * escribe, modelo de decisión, vectores): queda en el mismo registro y su
 * suma es el costo de la fila. Lo que se gaste después se guarda al terminar.
 */
async function ledger(db: Db, orgId: string, input: Omit<RecordRunInput, "usage">): Promise<void> {
  const usage = takeAiUsage()
  await withOrgContext(db, orgId, (tx) => recordAgentRun(tx, orgId, { ...input, usage })).catch(() => {})
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
  // Una prueba del chat web (fase 6 del pulido) gasta como «probar», con su
  // tope de 30 días: pasado el tope, Sofi no responde la prueba.
  const test = await withOrgContext(db, orgId, async (tx) => {
    const [thread] = await tx.select({ isTest: conversation.isTest }).from(conversation).where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId))).limit(1)
    if (!thread?.isTest) return false
    await assertAgentTestBudget(tx, orgId)
    return true
  }).catch((error: unknown) => {
    if (error instanceof ServiceError && error.code === "AGENT_TEST_LIMIT") return null
    throw error
  })
  if (test === null) return "done"
  // Todo lo que la corrida gasta en IA queda con origen `recepcion` (ADR 0031),
  // también si falla o se reintenta.
  return meterAiUse(db, orgId, test ? "probar" : "recepcion", () => attendAgentRun(db, runtime, msg), conversationId)
}

async function attendAgentRun(
  db: Db,
  runtime: AgentRuntime,
  msg: QueueMessage<AgentRunJob>,
): Promise<"done" | "retry"> {
  const { orgId, conversationId } = msg.message
  // Restricción/pausa comercial: ni herramientas ni mensajes. La ingesta ya
  // quedó guardada por su propio camino; la corrida derivada se descarta con
  // traza (al reanudar, los mensajes nuevos generan corridas nuevas).
  if (await isSaasSendBlocked(db, orgId).catch(() => false)) {
    await withOrgContext(db, orgId, (tx) =>
      tx.insert(auditEvent).values({
        organizationId: orgId,
        action: "agent.updated",
        entity: "conversation",
        entityId: conversationId,
        metadata: { op: "run-skipped", reason: "saas-restricted" },
      }),
    ).catch(() => {})
    return "done"
  }
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
  let effectiveModel = llmModelName(runtime.platform)
  let configProblem: ProviderProblem | null = null
  // Spam (ADR 0054): `recheck` si ya está en Spam y escribió algo nuevo;
  // `eligible` si puede ir solo a Spam; `none` si nunca va solo.
  let screenMode = "none" as "recheck" | "eligible" | "none"
  try {
    let prepared:
      | { skip: { reason: string; model: string; silent?: boolean } }
      | { toolCtx: AgentToolCtx; spec: LlmSpec; cfg: AgentConfig }
    // La configuración del proveedor es estado de la organización: su fallo
    // no debe reintentarse ni derivar en silencio.
    const resolveLlm = (): LlmSpec | null => {
      try {
        return resolveLlmSpec(runtime.platform)
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
      // Spam y bloqueados (ADR 0054): a un bloqueado el agente no lo atiende. A
      // quien está en Spam solo se lo vuelve a mirar (el worker encola la corrida
      // únicamente si escribió algo nuevo); a quien puede ir solo, Jev lo mira.
      const facts = await contactScreenFacts(tx, orgId, conv.contactId)
      if (facts.screen === "blocked") return { skip: { reason: BLOCKED_RUN_REASON, model: effectiveModel } }
      screenMode = facts.screen === "spam" ? "recheck" : autoSpamAllowed(facts) ? "eligible" : "none"
      if (conv.agentStatus !== "on") {
        return { skip: { reason: "agent-off", model: effectiveModel } }
      }
      const cfg = await getAgentConfig(tx, orgId)
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
      // Una persona del equipo conversa en vivo (ADR 0050): el agente espera
      // hasta 15 minutos después de su último mensaje y entonces vuelve; si
      // para entonces ella ya respondió, la corrida no tiene nada que hacer.
      const [team] = await tx
        .select({ at: sql<Date | null>`max(${message.createdAt})` })
        .from(message)
        .where(
          and(
            eq(message.organizationId, orgId),
            eq(message.conversationId, conversationId),
            eq(message.direction, "out"),
            eq(message.senderKind, "user"),
          ),
        )
      const teamAt = team?.at ? new Date(team.at) : null
      const liveUntil = teamAt ? teamAt.getTime() + TEAM_LIVE_MINUTES * 60_000 : 0
      if (liveUntil > now.getTime()) {
        const delaySeconds = Math.max(1, Math.ceil((liveUntil - now.getTime()) / 1000))
        await sendAgentRun(tx, { ...inboundJob, deferred: true }, { delaySeconds })
        return { skip: { reason: "team-live", model: effectiveModel, silent: true } }
      }
      const [trigger] = await tx
        .select()
        .from(message)
        .where(and(eq(message.id, inboundJob.messageId), eq(message.organizationId, orgId)))
        .limit(1)
      if (!trigger) return { skip: { reason: "missing-trigger", model: effectiveModel } }
      // Responde citando un mensaje de una persona del equipo (ADR 0050): es
      // de su tema y el agente no se mete; se anota en su tema o se le abre uno.
      if (trigger.replyToMessageId && screenMode !== "recheck") {
        const [quoted] = await tx
          .select({ senderKind: message.senderKind, senderUserId: message.senderUserId })
          .from(message)
          .where(and(eq(message.id, trigger.replyToMessageId), eq(message.conversationId, conversationId)))
          .limit(1)
        if (quoted?.senderKind === "user" && quoted.senderUserId) {
          await answerToTeamMember(tx, orgId, { conversationId, messageId: trigger.id, userId: quoted.senderUserId })
          return { skip: { reason: "reply-to-team", model: effectiveModel, silent: true } }
        }
      }
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
      // A quien está en Spam se lo atiende solo por lo nuevo: el spam de antes no es parte de su pedido.
      const burst = screenMode === "recheck"
        ? [{ id: trigger.id, body: trigger.body }]
        : pendingTail.some((item) => item.id === trigger.id)
          ? pendingTail
          : [...pendingTail, { id: trigger.id, body: trigger.body }]
      const latestId = burst[0]?.id ?? trigger.id
      inboundMessageId = latestId
      coveredMessageIds = burst.map((item) => item.id).filter((id) => id !== latestId)
      burstTexts = [...burst].reverse().map((item) => (item.body ?? "").trim()).filter(Boolean)
      // A quien está en Spam primero lo mira Jev: una palabra de derivación no la saca sola.
      const keyword = screenMode === "recheck" ? undefined : burst.find((item) => matchesHandoff(item.body, cfg.handoffKeywords))
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
      const spec = resolveLlm()
      if (!spec) return { skip: { reason: "llm-config", model: effectiveModel } }
      return {
        toolCtx: baseToolCtx(db, orgId, conversationId, conv.contactId, runtime.secretsKey, {
          triggerId: latestId,
          excludedTools: await orgToolExclusions(tx, orgId, cfg),
        }),
        spec,
        cfg,
      }
    })
    // A quien está en Spam no se le avisa ni se le abre un tema antes de que
    // Jev mire lo nuevo (ADR 0054): pausa, topes o un modelo sin responder lo
    // dejan en Spam, sin escribirle; su siguiente mensaje se vuelve a mirar.
    const stayInSpam = async (): Promise<"done"> => {
      await ledger(db, orgId, {
        conversationId,
        triggerMessageId: inboundMessageId,
        model: effectiveModel,
        status: "omitida",
        startedAt,
        endedAt: new Date(),
        llmCalls: 0,
        error: SPAM_UNDECIDED_RUN_REASON,
      })
      return "done"
    }
    if ("skip" in prepared && configProblem && screenMode === "recheck") return stayInSpam()
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
    const { toolCtx, spec, cfg } = prepared
    effectiveModel = spec.modelName
    toolCtx.treatment = cfg.treatment
    toolCtx.modelName = spec.modelName
    toolCtx.modelProvider = spec.provider
    toolCtx.verifyReplies = cfg.replyCheckEnabled
    toolCtx.emojis = cfg.emojis
    if (runtime.publicUrl) toolCtx.publicUrl = runtime.publicUrl
    if (runtime.embedder) toolCtx.embedder = runtime.embedder
    if (runtime.storage) toolCtx.storage = runtime.storage
    runUsage = toolCtx.usage
    // Dinero (ADR 0031): sin saldo de prueba los agentes se pausan; con el tope
    // del mes alcanzado, Recepción no toma casos nuevos (quien ya conversa hoy
    // sigue: no cuesta otra conversación). La persona recibe el aviso fijo y el
    // caso pasa al equipo, sin llamar al modelo.
    const spend = await withOrgContext(db, orgId, async (tx) => {
      const gate = await getAgentSpendGate(tx, orgId)
      if (gate.trialExhausted) return "SALDO_PRUEBA" as const
      if (gate.capReached && !(await hasOpenConversationAction(tx, orgId, toolCtx.contactId))) return "TOPE_GASTO" as const
      return null
    }).catch(() => null)
    if (spend && screenMode === "recheck") return stayInSpam()
    if (spend) {
      await performHandoff(toolCtx, spend === "SALDO_PRUEBA" ? "agentes en pausa: se usó todo el saldo de prueba" : "se alcanzó el tope de gasto del mes")
      await noticeAfterHandoff(toolCtx)
      await ledger(db, orgId, {
        conversationId,
        triggerMessageId: inboundMessageId,
        model: effectiveModel,
        status: "handoff",
        startedAt,
        endedAt: new Date(),
        llmCalls: 0,
        error: spend,
      })
      return "done"
    }
    // Tope por persona: quien escribe sin parar (un bot, una cadena) pasa al
    // equipo antes de agotar el tope diario de la clínica; los demás siguen
    // atendidos. Derivar no apaga al agente en el hilo (ADR 0050) y cada
    // mensaje nuevo trae su corrida: el tema y el aviso salen una sola vez por
    // persona y día, y lo que siga escribiendo ese día queda guardado, sin
    // respuesta ni tema nuevo. Al día siguiente se la vuelve a atender.
    const contactLimit = await withOrgContext(db, orgId, async (tx) => {
      if ((await countContactModelRunsToday(tx, orgId, toolCtx.contactId)) < CONTACT_DAILY_RUN_LIMIT) return null
      const handedOff = await contactHadRunToday(tx, orgId, toolCtx.contactId, { status: "handoff", error: CONTACT_DAILY_LIMIT })
      return handedOff ? ("silencio" as const) : ("derivar" as const)
    })
    if (contactLimit && screenMode === "recheck") return stayInSpam()
    if (contactLimit === "derivar") {
      await performHandoff(toolCtx, `escribió más de ${CONTACT_DAILY_RUN_LIMIT} veces hoy; puede ser un envío automático`)
      await noticeAfterHandoff(toolCtx)
    }
    if (contactLimit) {
      await ledger(db, orgId, {
        conversationId,
        triggerMessageId: inboundMessageId,
        model: effectiveModel,
        status: contactLimit === "derivar" ? "handoff" : "omitida",
        startedAt,
        endedAt: new Date(),
        llmCalls: 0,
        error: contactLimit === "derivar" ? CONTACT_DAILY_LIMIT : CONTACT_LIMIT_SILENCED,
      })
      return "done"
    }
    // Tope diario: acota el gasto ante ráfagas o abuso del canal público. Al
    // alcanzarlo, el caso pasa a una persona y se avisa una vez por día.
    const usedToday = await withOrgContext(db, orgId, (tx) => countAgentModelRunsToday(tx, orgId))
    if (usedToday >= cfg.dailyRunLimit) {
      if (screenMode === "recheck") return stayInSpam()
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
    // Sin clave, o con la clave rechazada, lo ajeno vuelve a cobrarse: al terminar se avisa a odentIA.
    let decisionProblem: DecisionKeyProblem | null = null
    if (inboundMessageId !== null && cfg.decisionProvider !== "none") {
      try {
        const built = runtime.createDecisionModel
          ? runtime.createDecisionModel(cfg.decisionProvider)
          : await createDecisionModel(cfg.decisionProvider, runtime.decisions ?? {}, spec)
        decision = built && watchDecisionKey(built, (problem) => (decisionProblem ??= problem))
      } catch (error) {
        decisionUnavailable = error
        decisionProblem = decisionKeyProblem(error)
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
      toolCtx.route = await decideRoute(db, orgId, decision, {
        conversationId,
        triggerMessageId: inboundMessageId,
        ...(screenMode === "recheck" ? { alone: true } : {}),
      })
    }
    // Spam (ADR 0054): con Jev muy seguro, a quien puede ir solo a Spam no se le
    // responde ni se cobra. A quien ya está, se lo saca solo si lo nuevo no es
    // spam (decisión 9a), aunque lo haya marcado una persona (9b); sin decisión, se queda.
    const spamVerdict = toolCtx.route?.spam && toolCtx.route.spam.probability >= ROUTE_SPAM ? toolCtx.route.spam : null
    const spamTrigger = inboundMessageId
    if (screenMode === "recheck" && spamTrigger !== null) {
      if (!toolCtx.route || spamVerdict) {
        await ledger(db, orgId, {
          conversationId,
          triggerMessageId: spamTrigger,
          model: effectiveModel,
          status: "omitida",
          startedAt,
          endedAt: new Date(),
          llmCalls: 0,
          error: toolCtx.route ? SPAM_STILL_RUN_REASON : SPAM_UNDECIDED_RUN_REASON,
        })
        return "done"
      }
      await withOrgContext(db, orgId, (tx) => leaveSpam(tx, orgId, { contactId: toolCtx.contactId, messageId: spamTrigger }))
    } else if (screenMode === "eligible" && spamVerdict && spamTrigger !== null) {
      const marked = await withOrgContext(db, orgId, (tx) =>
        markSpamByDecision(tx, orgId, { contactId: toolCtx.contactId, reason: spamVerdict.reason, messageId: spamTrigger }),
      )
      if (marked) {
        await ledger(db, orgId, {
          conversationId,
          triggerMessageId: spamTrigger,
          model: effectiveModel,
          status: "omitida",
          startedAt,
          endedAt: new Date(),
          llmCalls: 0,
          error: SPAM_RUN_REASON,
        })
        return "done"
      }
    }
    const invokeGraph = async () => {
      const model = runtime.createModel ? await runtime.createModel(spec) : await createConfiguredChatModel(spec)
      // El grafo no guarda su estado (ADR 0051): cada corrida arma el contexto
      // desde la base y lo que debe quedar ya tiene su tabla.
      const graph = compileAgentGraph(model, toolCtx)
      await graph.invoke({ messages: [], turnCount: 0 }, runtime.callbacks ? { callbacks: runtime.callbacks } : {})
    }
    // Motivo por el que esta corrida, a propósito, no responde: queda `omitida`.
    let omitReason: string | null = null
    if (toolCtx.route?.path === "derivar") {
      // Primero el equipo: el caso queda registrado al instante, con su clase,
      // su prioridad y lo que la persona escribió. Después el aviso a la
      // persona, redactado según lo que contó; si el modelo que escribe falla
      // o no lo deja, sale un aviso fijo: nunca queda sin respuesta.
      const { reason, priority } = routeHandoff(toolCtx.route)
      const said = burstTexts.slice(-8).map((text) => `«${text.slice(0, 300)}»`).join(" · ")
      await performHandoff(toolCtx, reason, said ? `Escribió: ${said}` : reason, priority, toolCtx.route.intent === "clinical_question")
      try {
        await invokeGraph()
      } catch (error) {
        console.error(`agent: el aviso de derivación no se pudo redactar (${error instanceof Error ? error.message : String(error)})`)
      }
      if (!toolCtx.replySettled) await noticeAfterHandoff(toolCtx)
    } else if (toolCtx.route?.path === "fuera_de_tema") {
      // Nada que ver con la clínica y el modelo de decisión muy seguro: un
      // texto fijo, sin llamar al modelo que escribe. Sale por send_reply,
      // con el mismo formato del canal y la misma comprobación. Como no llama
      // al modelo no cuenta para ningún tope, así que sale como mucho una vez
      // por persona y día: si no, un bot o la respuesta automática de otro
      // negocio lo recibirían sin fin, o quedarían en bucle con él. Después,
      // silencio: lo que escribe queda guardado y la corrida, omitida.
      const clinic = await publicClinicName(db, orgId)
      const text = offTopicReply(cfg.treatment, cfg.personaName, clinic, !cfg.disabledFunctions.includes("informar"))
      if (await withOrgContext(db, orgId, (tx) => contactGotAgentTextToday(tx, orgId, toolCtx.contactId, text))) {
        omitReason = OFF_TOPIC_REPEATED
      } else {
        const reply = makeAgentTools(toolCtx).find((item) => item.name === "send_reply")
        await reply?.invoke({ text })
      }
    } else {
      await invokeGraph()
      // Quien preguntó por un servicio concreto queda anotado como oportunidad
      // en «Interesado» (decisión 15 de la fase 4): lo hace el sistema, no el
      // modelo que escribe, y solo con «Oportunidades» encendida. Un saludo o
      // una consulta clínica no son interés en un servicio. Nunca corta la corrida.
      const interestOn = !cfg.disabledFunctions.includes("seguimiento")
      const notInterest = toolCtx.route?.path === "saludo" || toolCtx.route?.path === "clinico"
      if (interestOn && !notInterest && !toolCtx.handedOff && !toolCtx.dryRun && inboundMessageId !== null) {
        await noteAskedInterest(db, orgId, {
          contactId: toolCtx.contactId,
          conversationId,
          triggerMessageId: inboundMessageId,
          said: burstTexts.join("\n"),
          decision,
          // Si Jev no se pudo preparar o falla, la misma pregunta la responde
          // el modelo que escribe. Con la línea base elegida ya respondió ese.
          ...(cfg.decisionProvider !== "none" && cfg.decisionProvider !== "baseline"
            ? {
                fallback: async () =>
                  runtime.createDecisionModel
                    ? runtime.createDecisionModel("baseline")
                    : createDecisionModel("baseline", runtime.decisions ?? {}, spec),
              }
            : {}),
        }).catch((error: unknown) => {
          console.error(`agent: interés no anotado (${error instanceof Error ? error.message : String(error)})`)
        })
      }
      // Tras reservar en esta corrida, la pregunta del permiso general, una sola
      // vez por persona y después de la respuesta (ADR 0030). Texto y botones
      // fijos, sin modelo; si no puede salir, la corrida sigue igual.
      if (toolCtx.replySettled && !toolCtx.handedOff && !toolCtx.takenOver && !toolCtx.dryRun) {
        await withOrgContext(db, orgId, (tx) =>
          askGeneralPermissionAfterBooking(tx, orgId, { conversationId, since: startedAt }),
        ).catch(() => false)
      }
    }
    // Sin envío ni derivación en esta corrida: queda como sin respuesta salvo
    // que el hilo ya tenga una respuesta posterior al disparador (reentrega o
    // cola atrasada). El equipo lo ve en «Te espera» (espera respuesta), no en
    // la campana. Un fallo al comprobarlo no reintenta la corrida: volvería a
    // llamar al modelo.
    const attendedMessageId = inboundMessageId
    const silent = attendedMessageId !== null && !toolCtx.handedOff && !toolCtx.replySettled && omitReason === null
    let unanswered =
      silent
        ? await withOrgContext(db, orgId, (tx) =>
            reportAgentNoReply(tx, orgId, { conversationId, triggerMessageId: attendedMessageId }),
          ).catch(() => true)
        : false
    // El agente nunca se calla (ADR 0050): si nada salió y nadie del equipo la
    // tomó, la primera vez se le pide un momento y se reintenta; si vuelve a
    // pasar con el mismo mensaje, queda un tema para recepción con el aviso fijo.
    // El «momento» que ya salió cuenta como respuesta para `reportAgentNoReply`: por eso se mira `silent`.
    if (silent && !toolCtx.takenOver && !toolCtx.dryRun && attendedMessageId !== null) {
      try {
        const [before] = await withOrgContext(db, orgId, (tx) =>
          tx
            .select({ n: sql<number>`count(*)::int` })
            .from(agentRunLedger)
            .where(
              and(
                eq(agentRunLedger.organizationId, orgId),
                eq(agentRunLedger.triggerMessageId, attendedMessageId),
                eq(agentRunLedger.status, "sin_respuesta"),
              ),
            ),
        )
        if ((before?.n ?? 0) === 0) {
          // Una reentrega con el hilo ya respondido no tiene nada que pedir.
          if (!unanswered) throw new SkipMoment()
          const usted = toolCtx.treatment === "usted"
          await withOrgContext(db, orgId, async (tx) => {
            await sendOutbound(tx, orgId, {
              conversationId,
              senderKind: "agent",
              content: { type: "text", text: usted ? "Deme un momento, le respondo enseguida." : "Dame un momento, te respondo enseguida." },
            })
            await sendAgentRun(tx, { ...msg.message, messageId: attendedMessageId, deferred: true }, { delaySeconds: 30 })
          })
          unanswered = true
        } else {
          await performHandoff(toolCtx, "El agente no pudo responder este mensaje", "El agente no logró responder: revisa qué preguntó y respóndele.", "media")
          await noticeAfterHandoff(toolCtx)
          unanswered = false
        }
      } catch (error) {
        if (!(error instanceof SkipMoment)) {
          console.error(`agent: no se pudo atender un mensaje sin respuesta (${error instanceof Error ? error.message : String(error)})`)
        }
      }
    }
    await ledger(db, orgId, {
      conversationId,
      triggerMessageId: inboundMessageId,
      model: effectiveModel,
      // Si el equipo la tomó o cerró mientras el modelo escribía, nada salió:
      // queda omitida (no es una conversación atendida por el agente). Lo
      // mismo cuando la corrida no responde a propósito, con su motivo.
      status: toolCtx.handedOff ? "handoff" : toolCtx.takenOver || omitReason ? "omitida" : unanswered ? "sin_respuesta" : "ok",
      ...(toolCtx.takenOver ? { error: TEAM_TOOK_OVER } : omitReason ? { error: omitReason } : {}),
      startedAt,
      endedAt: new Date(),
      latencyMs: Date.now() - startedAt.getTime(),
      inputTokens: toolCtx.usage.reported ? toolCtx.usage.inputTokens : null,
      outputTokens: toolCtx.usage.reported ? toolCtx.usage.outputTokens : null,
      cachedInputTokens: toolCtx.usage.cacheReported ? toolCtx.usage.cachedInputTokens : null,
      cacheWriteTokens: toolCtx.usage.cacheReported ? toolCtx.usage.cacheWriteTokens : null,
      llmCalls: toolCtx.usage.calls,
      toolsUsed: toolCtx.toolsUsed,
    })
    // Constancia de la ráfaga: solo si la corrida respondió, derivó o calló a
    // propósito (`omitReason`). Una que quedó sin respuesta no cubre nada y
    // las corridas del resto se ejecutan.
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
    // Clave ausente o rechazada: el caso «Modelo sin responder» de Soporte (ADR 0047). Con el
    // modelo de demostración no hay cuenta real que arreglar.
    const keyProblem = decisionProblem as DecisionKeyProblem | null
    if (keyProblem && runtime.ownerDb && spec.provider !== "fake") {
      await reportDecisionOutage(runtime.ownerDb, { orgId, provider: cfg.decisionProvider, problem: keyProblem, at: startedAt }).catch(
        (error: unknown) => {
          console.error(`agent: caso «Modelo sin responder» del modelo de decisión sin abrir (${error instanceof Error ? error.message : String(error)})`)
        },
      )
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
        cacheWriteTokens: runUsage?.cacheReported ? runUsage.cacheWriteTokens : null,
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
    // El aviso a la clínica dice «Ya avisamos a odentIA»: el caso de Soporte lleva el motivo técnico.
    if (problem.code !== "DAILY_LIMIT" && runtime.ownerDb) {
      await reportModelOutage(runtime.ownerDb, {
        orgId,
        llm: effectiveModel,
        llmLabel: AGENT_MODEL_LABEL,
        code: problem.code,
        detail: problem.detail,
        at: startedAt,
      }).catch((error: unknown) => {
        console.error(`agent: caso «Modelo sin responder» sin abrir (${error instanceof Error ? error.message : String(error)})`)
      })
    }
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
 * efectos externos ni persistencia: las herramientas corren en dryRun (describen, no escriben), el mensaje
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
      spec: resolveLlmSpec(deps.platform),
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
  toolCtx.modelName = modelName
  toolCtx.modelProvider = spec.provider
  toolCtx.draftText = text.slice(0, 4000)
  const model = await createConfiguredChatModel(spec)
  const graph = compileAgentGraph(model, toolCtx)
  const state = (await graph.invoke({ messages: [], turnCount: 0 })) as { messages: BaseMessage[] }
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
  /**
   * El modelo que escribe contestó en este turno. Los caminos que no lo llaman
   * (texto fijo, derivar sin redactar) no cuentan: «Lo probaste» solo suma
   * las pruebas que el modelo respondió.
   */
  modelAnswered: boolean
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
      spec: resolveLlmSpec(deps.platform),
      excludedTools: await orgToolExclusions(tx, orgId, cfg),
    }
  })
  const toolCtx = baseToolCtx(db, orgId, SANDBOX_NIL_ID, SANDBOX_NIL_ID, deps.secretsKey, { excludedTools })
  toolCtx.dryRun = true
  toolCtx.verifyReplies = cfg.replyCheckEnabled
  toolCtx.emojis = cfg.emojis
  toolCtx.modelName = spec.modelName
  toolCtx.modelProvider = spec.provider
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
      reply: offTopicReply(cfg.treatment, cfg.personaName, clinic, !cfg.disabledFunctions.includes("informar")),
      replied: true,
      toolsUsed: [],
      handedOff: false,
      basis: [],
      checks: [],
      did: ["Respondió con el texto fijo para lo que no es de la clínica, sin llamar al modelo que escribe."],
      modelAnswered: false,
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
      modelAnswered: false,
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
  const result = (await graph.invoke({ messages: [], turnCount: 0 })) as { messages: BaseMessage[] }
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
    modelAnswered: replies.length > 0,
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

/** La corrida no dejó respuesta pero el hilo ya la tenía (reentrega): no se pide un momento. */
class SkipMoment extends Error {}
