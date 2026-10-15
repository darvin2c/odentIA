import { randomUUID } from "node:crypto"
import { tool } from "@langchain/core/tools"
import { type Db, withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { channelConnection, conversation } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import type { AgentCaseNote, AnswerBasisItem, AnswerCheck, AnswerTraceOutcome, ProposalAction } from "@odentia/db/schema/agent"
import {
  addAgentCaseNote,
  addPersonFact,
  type AgentCaseProposal,
  buildAgentProposalKey,
  confirmProposalByContact,
  BOOKING_LINK_TTL_HOURS,
  createBookingLink,
  annotateHandoff,
  closeConversationWith,
  closurePendingReason,
  createHandoff,
  createProposal,
  createTask,
  findFreeGaps,
  getAgentPatientSummary,
  autonomyModeOf,
  getContact,
  getClinicInfoSnapshot,
  getOpportunity,
  getOrgLocale,
  formatAgentClinicData,
  formatClinicSearch,
  formatOrgMoney,
  formatZoned,
  getAgentClinicData,
  getAgentConfig,
  listAgentContextCandidates,
  listContactChannelHistory,
  listContactNotes,
  listOpportunities,
  listPaymentMethods,
  listTasks,
  noteLessonUse,
  operationAgentSchema,
  PROPOSAL_ACTION_LABEL,
  recordAnswerTrace,
  recordKnowledgeGap,
  requireContact,
  resolveAgentPatientContext,
  rankByMeaning,
  searchClinic,
  searchPublishedKnowledge,
  ServiceError,
  updateContact,
} from "@odentia/services"
import type { MeaningRank, OpportunityDetail, OrgLocale, ProposalItem, SearchEmbedder } from "@odentia/services"
import { z } from "zod"
import type { DecisionModel } from "./decision/port.js"
import { type AgentRoute, handoffFallbackNotice } from "./decision/route.js"
import { formatForChannel } from "./channel-format.js"
import { describeUnsupported, type Evidence, refusedPaymentMentions, type ReplyVerdict, verifyReply } from "./verify.js"

/** Fuente de un dato del turno, con la clase que verá el equipo en «En qué se basó». */
export interface AgentEvidence extends Evidence {
  kind: string
}

/** Cómo ve el equipo cada herramienta de lectura cuando una respuesta se apoya en ella. */
/** El canal de la conversación, leído una vez por corrida. Una prueba se ve como WhatsApp, el canal principal. */
export async function conversationChannel(ctx: AgentToolCtx): Promise<string | null> {
  if (ctx.channel !== undefined) return ctx.channel
  if (ctx.sandbox || ctx.dryRun) {
    ctx.channel = "whatsapp"
    return ctx.channel
  }
  const [row] = await withOrgContext(ctx.db, ctx.orgId, (tx) =>
    tx
      .select({ channel: channelConnection.channel })
      .from(conversation)
      .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
      .where(and(eq(conversation.id, ctx.conversationId), eq(conversation.organizationId, ctx.orgId)))
      .limit(1),
  )
  ctx.channel = row?.channel ?? null
  return ctx.channel
}

/** Lo máximo que espera una búsqueda en la conversación al proveedor de vectores. */
const QUERY_EMBED_MS = 3_000

export const TOOL_SOURCES: Record<string, { kind: string; label: string }> = {
  ver_sedes_y_servicios: { kind: "servicios", label: "Sedes, servicios y precios" },
  buscar_en_la_clinica: { kind: "servicios", label: "Búsqueda en servicios, promociones y profesionales" },
  consultar_conocimiento: { kind: "conocimiento", label: "Respuestas oficiales de la clínica" },
  buscar_huecos: { kind: "agenda", label: "Agenda: horarios disponibles" },
  ver_contexto_paciente: { kind: "persona", label: "Vínculo con el paciente" },
  ver_resumen_paciente: { kind: "persona", label: "Citas, presupuestos y saldo del paciente" },
  leer_contexto_comercial: { kind: "comercial", label: "Ficha del contacto" },
  ver_otros_canales: { kind: "otros_canales", label: "Conversaciones en otros canales" },
  listar_oportunidades: { kind: "comercial", label: "Oportunidades del contacto" },
  listar_tareas: { kind: "comercial", label: "Tareas del contacto" },
}

/**
 * Conversación de prueba: no existe hilo ni persona real. El historial lo trae
 * quien prueba y lo que el agente «propone», anota o consulta vive solo en
 * `state`, que vuelve en el turno siguiente; nada toca la base.
 */
export interface AgentSandbox {
  transcript: Array<{ role: "contact" | "agent"; text: string }>
  state: AgentSandboxState
}

export interface AgentSandboxState {
  pending: AgentCaseProposal[]
  recent: AgentCaseProposal[]
  notes: AgentCaseNote[]
  lookups: Array<{ tool: string; text: string; at: string }>
}

/** Persona ficticia de una prueba; no coincide con ninguna fila. */
export const SANDBOX_NIL_ID = "00000000-0000-4000-8000-000000000000"
export const SANDBOX_PATIENT_ID = "00000000-0000-4000-8000-0000000000aa"
export const SANDBOX_PERSON = "Paciente de prueba"

/** Lo que hizo el agente en un turno, dicho para quien prueba (no para el modelo). */
export const TOOL_ACTION_LABEL: Record<string, string> = {
  ver_sedes_y_servicios: "Consultó sedes, servicios y precios.",
  buscar_en_la_clinica: "Buscó en los servicios, promociones y profesionales de la clínica.",
  consultar_conocimiento: "Buscó en las respuestas oficiales.",
  buscar_huecos: "Buscó huecos reales en la agenda.",
  ver_contexto_paciente: "Verificó para quién es la atención.",
  ver_resumen_paciente: "Consultó las citas y el estado de cuenta del paciente.",
  proponer_cita: "Propuso reservar una cita.",
  reprogramar_cita: "Propuso mover una cita.",
  cancelar_cita: "Propuso cancelar una cita.",
  confirmar_propuesta: "Ejecutó lo que el paciente confirmó.",
  enviar_enlace_cita: "Envió un enlace para que la persona elija su cita.",
  create_opportunity: "Propuso registrar una oportunidad.",
  update_followup: "Propuso programar un seguimiento.",
  close_opportunity: "Propuso cerrar una oportunidad.",
  move_to_stage: "Propuso mover una oportunidad de etapa.",
  add_tags: "Etiquetó el contacto.",
  update_contact: "Actualizó datos del contacto.",
  create_task: "Dejó una tarea a tu equipo.",
  anotar_caso: "Anotó un dato del caso para después.",
  recordar_dato: "Guardó un dato de la persona para próximas conversaciones.",
  request_human_handoff: "Pasó el caso a una persona.",
  despedirse_y_cerrar: "Se despidió y cerró la conversación.",
}

/** Respuestas seguidas sin sustento que el agente puede intentar antes de pasar el caso a una persona. */
const MAX_UNSUPPORTED_REPLIES = 2

/**
 * Cambios de lo aprendido que valen solo para una prueba: lecciones que se
 * ignoran, lecciones todavía propuestas que se dan por activas y respuestas
 * oficiales que se ocultan (porque la lección las cambia o las creó).
 */
export interface LessonOverrides {
  skipIds?: string[]
  extra?: Array<{ id: string; kind: "respuesta_oficial" | "regla" | "ejemplo"; title: string; question: string; body: string }>
  skipEntryIds?: string[]
}

export interface AgentToolCtx {
  db: Db
  orgId: string
  conversationId: string
  contactId: string
  /** Evento durable que disparó el turno (mensaje o coordinación). */
  triggerId: string | null
  secretsKey: Buffer
  /** La herramienta de handoff lo marca; el grafo termina el turno. */
  handedOff: boolean
  /** La derivación registrada en esta corrida, para completarla con el aviso que recibió la persona. */
  handoffId?: string
  /** Simulación: las herramientas no escriben nada, solo describen. */
  dryRun: boolean
  /** Mensaje hipotético solo para simulación (no se persiste). */
  draftText?: string
  /** Conversación de prueba sin hilo real (implica `dryRun`). */
  sandbox?: AgentSandbox
  /** Probar cómo respondería con una lección aún sin aprobar, o sin una activa. */
  lessonOverrides?: LessonOverrides
  /** Camino que eligió el modelo de decisión para este turno; ausente = camino abierto. */
  route?: AgentRoute | null
  /**
   * Lo que el sistema ya sabe del turno sin preguntarle a un modelo: la persona
   * tocó un botón de un mensaje automático. Va con lo del turno, tras el camino.
   */
  routeHint?: string
  /**
   * Dirección pública de la plataforma, para armar enlaces que la persona abre
   * (reservar su cita). Sin ella el agente no tiene la herramienta del enlace.
   */
  publicUrl?: { webURL: string; cookieDomain: string }
  /**
   * Quien vectoriza para buscar por significado. Sin él, la búsqueda es solo por
   * palabras. Solo ordena: los datos se leen de la base al responder.
   */
  embedder?: SearchEmbedder
  /**
   * Canal de la conversación (`whatsapp`, `telegram`…), para el formato del
   * texto. Lo resuelve `conversationChannel`; en una prueba se usa WhatsApp.
   */
  channel?: string | null
  /** Hay una propuesta esperando el sí del interlocutor: el turno recibe todas las herramientas, sea cual sea el camino. */
  casePending?: boolean
  /** El modelo que escribe pidió el resto de herramientas en este turno. */
  widened?: boolean
  /** Herramientas que en este hilo no pueden servir; su esquema no se envía al modelo. */
  excludedTools?: readonly string[]
  /**
   * La respuesta al interlocutor quedó enviada o pendiente de decisión: el
   * grafo termina el turno sin volver a llamar al modelo.
   */
  replySettled: boolean
  /** Texto que la simulación habría enviado (no se persiste). */
  simulatedReply?: string
  /** Nombres de herramientas usadas en la corrida (supervisión). */
  toolsUsed: string[]
  /**
   * Tokens acumulados solo si el proveedor los reporta; `calls` cuenta las
   * llamadas al modelo siempre.
   */
  usage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    calls: number
    reported: boolean
    cacheReported: boolean
  }
  /**
   * Lo que el agente recibió o consultó en el turno: contra esto se comprueban
   * los precios, fechas y horas de su respuesta. Lo llenan el contexto y cada
   * herramienta de lectura.
   */
  evidence?: AgentEvidence[]
  /** Fuentes consultadas en el turno, para la traza de la respuesta. */
  basis?: AnswerBasisItem[]
  /** `false` desactiva la comprobación previa al envío (configuración de la organización). */
  verifyReplies?: boolean
  /** Medios de pago que la clínica desactivó (se leen una vez por corrida). */
  refusedPayments?: string[]
  /** Emojis de la voz de la clínica: con `no` se quitan antes de enviar. Ausente = se dejan. */
  emojis?: "no" | "pocos"
  /** Respuestas del turno que no salieron por un dato sin sustento. */
  checkFailures?: number
  /** Comprobaciones de la última respuesta (también en simulación). */
  lastChecks?: AnswerCheck[]
  /** Modelo que escribe en esta corrida, para la traza. */
  modelName?: string
  /** Lo último que escribió el interlocutor: la pregunta que queda anotada si falta conocimiento. */
  lastInboundText?: string
  /**
   * Modelo de decisión de la organización, si tiene uno: elige qué respuestas
   * oficiales viajan completas en el turno. Nunca decide un acto.
   */
  decision?: DecisionModel | null
  /** Trato de la clínica, para el aviso fijo al derivar; si falta se lee de la configuración. */
  treatment?: "tu" | "usted" | null
  /** El agente se despidió y cerró la conversación en esta corrida. */
  closed?: boolean
}

/**
 * Derivación a humano: registro estructurado (resumen, motivo, prioridad,
 * tarea), apaga el agente y avisa al equipo. Misma vía para keyword, tool y
 * maxTurns.
 */
export async function performHandoff(
  ctx: AgentToolCtx,
  reason: string,
  summary?: string,
  priority: "alta" | "media" | "baja" = "media",
): Promise<void> {
  if (ctx.dryRun) {
    ctx.handedOff = true
    return
  }
  await withOrgContext(ctx.db, ctx.orgId, async (tx) => {
    const handoff = await createHandoff(tx, ctx.orgId, null, {
      conversationId: ctx.conversationId,
      reason,
      summary: summary?.trim() ? summary : reason,
      priority,
      createdBy: "agent",
    })
    ctx.handoffId = handoff.id
  })
  ctx.handedOff = true
}

/**
 * Derivar siempre avisa (ADR 0024): si el caso pasó a una persona y la persona
 * aún no recibió nada en esta corrida, sale el aviso fijo, sin modelo, por el
 * mismo camino que cualquier respuesta. Si el canal no deja escribir, queda
 * dicho en la derivación para quien la tome.
 */
export async function noticeAfterHandoff(ctx: AgentToolCtx): Promise<void> {
  if (!ctx.handedOff || ctx.replySettled || ctx.dryRun) return
  const treatment =
    ctx.treatment !== undefined
      ? ctx.treatment
      : await withOrgContext(ctx.db, ctx.orgId, async (tx) => (await getAgentConfig(tx, ctx.orgId)).treatment).catch(() => null)
  const notify = makeAgentTools(ctx).find((item) => item.name === "request_human_handoff")
  let outcome = ""
  try {
    const result: unknown = await notify?.invoke({
      reason: "Aviso al interlocutor",
      summary: "Aviso al interlocutor",
      message: handoffFallbackNotice(treatment ?? null),
    })
    outcome = typeof result === "string" ? result : ""
  } catch (error) {
    outcome = error instanceof Error ? error.message : String(error)
  }
  if (ctx.replySettled) return
  console.error(`agent: el aviso fijo de derivación no salió (${outcome.slice(0, 200)})`)
  const handoffId = ctx.handoffId
  if (!handoffId) return
  await withOrgContext(ctx.db, ctx.orgId, (tx) =>
    annotateHandoff(tx, ctx.orgId, handoffId, {
      pending: "No se le pudo avisar que una persona del equipo continuará: escríbele tú.",
    }),
  ).catch(() => undefined)
}

/**
 * Tools del agente. NUNCA SQL ni fetch arbitrario: solo servicios dentro
 * del contexto RLS de la org (invariante). En simulación (dryRun) las
 * mutaciones devuelven vista previa sin escribir.
 */
export function makeAgentTools(ctx: AgentToolCtx) {
  const inOrg = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => withOrgContext(ctx.db, ctx.orgId, fn)

  // Configuración regional de la org, resuelta una vez por corrida: toda
  // fecha comunicada usa la zona de la sede de la cita o la de la org.
  let zonePromise: Promise<OrgLocale> | null = null
  const orgZone = (): Promise<OrgLocale> => (zonePromise ??= inOrg((tx) => getOrgLocale(tx, ctx.orgId)))

  /**
   * Ventana de WhatsApp cerrada: el modelo cambia a plantilla autorizada o
   * deriva. Llega persistida como `fallida` con `error` prefijado por el
   * código estable `WINDOW_CLOSED` y `result.errorCode` igual (pacto con
   * ProposalLifecycle, que ya no la lanza); se traduce a este texto.
   */
  const OUTSIDE_WINDOW =
    "outside_window: fuera de la ventana de 24h del canal. Si dispones de send_template, úsala con una plantilla autorizada; si no, deriva a humano."
  /**
   * Crea la propuesta comercial con clave estable por trigger + herramienta
   * + payload. En modo directo se ejecuta en el mismo acto; si exige la
   * confirmación del interlocutor, queda pendiente con su recorrido real. Los
   * errores de dominio en ejecución llegan como `fallida` con código estable
   * en `result.errorCode` y motivo prefijado en `error` (HTTP 200): se
   * reportan al modelo, nunca como aprobación. Si el hilo ya espera un «sí»
   * (PROPOSAL_PENDING_CONFIRM), se guía al modelo a pedir la confirmación.
   */
  const propose = async (
    action: string,
    payload: Record<string, unknown>,
    toolName: string,
    reason?: string,
    onProposal?: (proposal: ProposalItem) => void,
  ): Promise<string> => {
    let proposal: ProposalItem
    try {
      proposal = await inOrg((tx) =>
        createProposal(tx, ctx.orgId, {
          conversationId: ctx.conversationId,
          action,
          payload,
          reason,
          idempotencyKey: buildAgentProposalKey({
            conversationId: ctx.conversationId,
            triggerId: ctx.triggerId,
            tool: toolName,
            payload,
          }),
          secretsKey: ctx.secretsKey,
        }),
      )
      onProposal?.(proposal)
    } catch (e) {
      if (e instanceof ServiceError && e.code === "PROPOSAL_PENDING_CONFIRM") {
        return "Ya hay una propuesta esperando la confirmación del interlocutor en este hilo: pídele que confirme con un sí claro y luego usa confirmar_propuesta, no crees otra."
      }
      throw e
    }
    // Un mensaje enviado o a la espera de decisión cierra el turno; si falló
    // o expiró, el modelo aún debe cambiar a plantilla, reproponer o derivar.
    if (action === "enviar_mensaje" && proposal.status !== "fallida" && proposal.status !== "expirada") {
      ctx.replySettled = true
    }
    if (proposal.status === "ejecutada") return `Ejecutado en modo directo (propuesta ${proposal.id}).`
    if (proposal.status === "fallida") {
      const rawError = proposal.error?.trim() ?? ""
      if (rawError.startsWith("WINDOW_CLOSED") || proposal.result?.errorCode === "WINDOW_CLOSED") {
        return OUTSIDE_WINDOW
      }
      const detail = rawError ? `: ${rawError.slice(0, 300)}` : "."
      return `No se pudo ejecutar en modo directo (propuesta ${proposal.id})${detail} Ofrece una alternativa o deriva a humano.`
    }
    if (proposal.status === "expirada") {
      return `La propuesta ${proposal.id} expiró (48h): vuelve a proponer el acto con datos vigentes, no la confirmes.`
    }
    return `Propuesta ${proposal.id} creada: pide al interlocutor que confirme con un sí claro y luego usa confirmar_propuesta.`
  }

  /**
   * En una conversación de prueba el acto no se crea: queda en el estado de la
   * prueba con el mismo recorrido que tendría (ejecutado o esperando el sí del
   * interlocutor) para que el turno siguiente lo vea.
   */
  const sandboxPropose = async (action: ProposalAction, summary: string): Promise<string> => {
    const sandbox = ctx.sandbox
    if (!sandbox) return ""
    const mode = autonomyModeOf(action)
    const now = new Date()
    const proposal: AgentCaseProposal = {
      id: randomUUID(),
      action,
      label: PROPOSAL_ACTION_LABEL[action],
      summary,
      status: mode === "directo" ? "ejecutada" : "propuesta",
      detail: null,
      at: now.toISOString(),
      expiresAt: mode === "directo" ? null : new Date(now.getTime() + 48 * 3_600_000).toISOString(),
    }
    if (mode === "directo") {
      sandbox.state.recent = [proposal, ...sandbox.state.recent].slice(0, 5)
      return `[SIMULACIÓN] Ejecutado en modo directo (propuesta ${proposal.id}).`
    }
    sandbox.state.pending = [...sandbox.state.pending, proposal]
    return `[SIMULACIÓN] Propuesta ${proposal.id} creada: pide al interlocutor que confirme con un sí claro y luego usa confirmar_propuesta.`
  }

  const sandboxWhen = async (iso: string): Promise<string> => {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : formatZoned(date, await orgZone())
  }

  /**
   * Elige una oportunidad abierta del contacto de ctx. La selección explícita
   * se verifica directa (pertenencia al contacto y estado abierto) para no
   * rechazarla por truncación de la lista. Sin id y con varias abiertas,
   * devuelve el mensaje para preguntar (nunca adivina ni toca oportunidades
   * de otro interlocutor).
   */
  const chooseOpportunity = async (opportunityId?: string): Promise<{ id: string } | { message: string }> => {
    if (opportunityId) {
      let detail: OpportunityDetail | null = null
      try {
        detail = await inOrg((tx) => getOpportunity(tx, ctx.orgId, opportunityId))
      } catch (e) {
        // Solo ausente equivale a ajena o cerrada; otro fallo se propaga.
        if (!(e instanceof ServiceError && e.code === "NOT_FOUND")) throw e
      }
      if (!detail || detail.contactId !== ctx.contactId || detail.status !== "open") {
        return { message: "Esa oportunidad no es del contacto o no está abierta: pide aclaración." }
      }
      return { id: detail.id }
    }
    const { items, nextCursor } = await inOrg((tx) =>
      listOpportunities(tx, ctx.orgId, { contactId: ctx.contactId, status: "open", limit: 100 }),
    )
    if (items.length === 0) return { message: "El contacto no tiene oportunidades abiertas." }
    if (items.length > 1) {
      const shown = items
        .slice(0, 20)
        .map((o) => `- ${o.title} (id ${o.id}, etapa ${o.stageName})`)
        .join("\n")
      const more =
        nextCursor || items.length > 20
          ? "\nHay más oportunidades: usa listar_oportunidades con el cursor para verlas todas antes de elegir."
          : ""
      return { message: `El contacto tiene varias oportunidades abiertas, pregunta cuál:\n${shown}${more}` }
    }
    const only = items[0]
    if (!only) return { message: "El contacto no tiene oportunidades abiertas." }
    return { id: only.id }
  }

  /**
   * Deja constancia de en qué se basó una respuesta. Es supervisión: si falla,
   * la respuesta sale igual.
   */
  const traceAnswer = async (
    replyText: string,
    outcome: AnswerTraceOutcome,
    checks: AnswerCheck[],
    proposal: ProposalItem | null,
  ): Promise<void> => {
    if (ctx.dryRun) return
    const basis: AnswerBasisItem[] = [...(ctx.basis ?? [])]
    for (const check of checks) {
      if (!check.ok || !check.source || basis.some((item) => item.label === check.source)) continue
      const origin = ctx.evidence?.find((item) => item.source === check.source)
      basis.push({ kind: origin?.kind ?? "calculo", label: check.source })
    }
    const messageId = proposal?.result?.["messageId"]
    try {
      await inOrg((tx) =>
        recordAnswerTrace(tx, ctx.orgId, {
          conversationId: ctx.conversationId,
          triggerMessageId: ctx.triggerId,
          proposalId: proposal?.id ?? null,
          messageId: typeof messageId === "string" ? messageId : null,
          outcome,
          replyText,
          basis,
          checks,
          model: ctx.modelName ?? null,
        }),
      )
    } catch (error) {
      console.error(`agent: traza de respuesta omitida (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const traceOutcome = (proposal: ProposalItem): AnswerTraceOutcome =>
    proposal.status === "ejecutada"
      ? "enviada"
      : proposal.status === "propuesta" || proposal.status === "aprobada"
        ? "pendiente"
        : "fallida"

  /**
   * Comprueba la respuesta antes de enviarla. Si trae un precio, fecha u hora
   * que no figura en lo consultado, no sale: el modelo recibe qué dato falta
   * y puede consultarlo o quitarlo; a la segunda vez el caso pasa a una persona.
   */
  const checkReply = async (text: string): Promise<{ verdict: ReplyVerdict | null; blocked: string | null }> => {
    if (ctx.verifyReplies === false) return { verdict: null, blocked: null }
    const verdict = verifyReply(text, ctx.evidence ?? [], await orgZone())
    ctx.lastChecks = verdict.checks
    // Un medio de pago que la clínica desactivó no se ofrece: la lista del prompt no bastó (ADR 0022).
    ctx.refusedPayments ??= await inOrg(async (tx) =>
      (await listPaymentMethods(tx, ctx.orgId, { activeOnly: false })).filter((m) => !m.isActive).map((m) => m.name),
    )
    const refused = refusedPaymentMentions(text, ctx.refusedPayments)
    if (verdict.ok && refused.length > 0) {
      await traceAnswer(text, "bloqueada", verdict.checks, null)
      return {
        verdict,
        blocked: `${ctx.dryRun ? "[SIMULACIÓN] " : ""}No enviado: la clínica no acepta ${refused.join(", ")}. Di solo los medios de pago de la lista (o que ese no se acepta) y vuelve a enviar la respuesta sola en su paso.`,
      }
    }
    if (verdict.ok) return { verdict, blocked: null }
    ctx.checkFailures = (ctx.checkFailures ?? 0) + 1
    const missing = describeUnsupported(verdict)
    const prefix = ctx.dryRun ? "[SIMULACIÓN] " : ""
    await traceAnswer(text, "bloqueada", verdict.checks, null)
    if (ctx.checkFailures >= MAX_UNSUPPORTED_REPLIES) {
      await performHandoff(
        ctx,
        "El agente no pudo sustentar un dato de su respuesta",
        `Quiso responder: «${text.slice(0, 400)}». Sin sustento en lo consultado: ${missing}.`,
      )
      // La persona no queda sin respuesta: recibe el aviso fijo de que sigue una persona.
      await noticeAfterHandoff(ctx)
      return {
        verdict,
        blocked: `${prefix}No enviado: ${missing} no figura en lo consultado. El caso pasa a una persona; no envíes más mensajes.`,
      }
    }
    return {
      verdict,
      blocked: `${prefix}No enviado: ${missing} no figura en lo que consultaste ni en este contexto. Consulta la herramienta que corresponda (ver_sedes_y_servicios, consultar_conocimiento, buscar_huecos, ver_resumen_paciente) o quita ese dato, y vuelve a enviar la respuesta sola en su paso.`,
    }
  }

  const sendReply = tool(
    async ({ text: written }: { text: string }) => {
      // Las marcas de formato se ajustan al canal antes de comprobar y enviar.
      const text = formatForChannel(written, await conversationChannel(ctx), { emojis: ctx.emojis })
      const { verdict, blocked } = await checkReply(text)
      if (blocked) return blocked
      if (ctx.dryRun) {
        ctx.replySettled = true
        ctx.simulatedReply = text
        return `[SIMULACIÓN] Se enviaría al interlocutor: ${text}`
      }
      // WINDOW_CLOSED ya no lanza: llega como `fallida` y propose la traduce
      // a outside_window. Lo que sí lanza (infra 429/5xx incluida) no
      // reintenta la corrida: ToolNode lo devuelve al modelo como mensaje.
      const sent: ProposalItem[] = []
      const outcome = await propose("enviar_mensaje", { kind: "text", text }, "send_reply", undefined, (proposal) => {
        sent.push(proposal)
      })
      for (const proposal of sent) await traceAnswer(text, traceOutcome(proposal), verdict?.checks ?? [], proposal)
      return outcome
    },
    {
      name: "send_reply",
      description:
        "Envía la respuesta completa al interlocutor y cierra el turno: úsala al final, después de cualquier otra acción (queda como propuesta si la política no es directa). Si devuelve outside_window, sigue su indicación.",
      schema: z.object({ text: z.string().min(1).max(4000) }),
    },
  )

  /**
   * Cerrar al terminar (ADR 0024): la despedida sale por el mismo camino que
   * send_reply (formato del canal y comprobación) y la conversación se cierra
   * como resuelta. Con algo pendiente no cierra y se lo dice al modelo.
   */
  const farewellAndClose = tool(
    async ({ text: written }: { text: string }) => {
      if (ctx.sandbox) {
        if (ctx.sandbox.state.pending.length > 0) {
          return "[SIMULACIÓN] No se cerraría: hay una propuesta esperando el sí del interlocutor. Responde con send_reply."
        }
      }
      const pending = ctx.dryRun ? null : await inOrg((tx) => closurePendingReason(tx, ctx.orgId, ctx.conversationId))
      if (pending) return `No cerrado. ${pending}`
      const text = formatForChannel(written, await conversationChannel(ctx), { emojis: ctx.emojis })
      const { verdict, blocked } = await checkReply(text)
      if (blocked) return blocked
      if (ctx.dryRun) {
        ctx.replySettled = true
        ctx.closed = true
        ctx.simulatedReply = text
        return `[SIMULACIÓN] Se enviaría la despedida y se cerraría la conversación: ${text}`
      }
      const sent: ProposalItem[] = []
      const outcome = await propose("enviar_mensaje", { kind: "text", text }, "despedirse_y_cerrar", undefined, (proposal) => {
        sent.push(proposal)
      })
      for (const proposal of sent) await traceAnswer(text, traceOutcome(proposal), verdict?.checks ?? [], proposal)
      if (!sent.some((proposal) => proposal.status === "ejecutada")) return outcome
      await inOrg((tx) => closeConversationWith(tx, ctx.orgId, ctx.conversationId, { reason: "resuelta", byUserId: null }))
      ctx.closed = true
      return "Despedida enviada y conversación cerrada. No envíes más mensajes: si la persona vuelve a escribir, se reabre sola."
    },
    {
      name: "despedirse_y_cerrar",
      description:
        "Se despide y cierra la conversación cuando la persona agradece o se despide y no queda nada pendiente (ninguna propuesta esperando su sí, ningún caso con el equipo). En text va una sola línea cordial, en el tono de la clínica, que diga que estamos atentos si quiere volver a escribir. Úsala sola en su paso, en lugar de send_reply. Si queda algo pendiente no cierra y te dice qué.",
      schema: z.object({ text: z.string().min(1).max(600) }),
    },
  )

  const sendTemplate = tool(
    async ({ name, language, params }: { name: string; language: string; params: string[] }) => {
      if (ctx.dryRun) {
        ctx.replySettled = true
        ctx.simulatedReply = `[plantilla ${name} · ${language}]`
        return `[SIMULACIÓN] Se enviaría plantilla ${name} (${language}).`
      }
      const sent: ProposalItem[] = []
      const outcome = await propose(
        "enviar_mensaje",
        { kind: "template", name, language, params },
        "send_template",
        undefined,
        (proposal) => {
          sent.push(proposal)
        },
      )
      for (const proposal of sent) {
        await traceAnswer(`[plantilla ${name} · ${language}]`, traceOutcome(proposal), [], proposal)
      }
      return outcome
    },
    {
      name: "send_template",
      description:
        "Envía una plantilla de WhatsApp autorizada y cierra el turno (propuesta si la política no es directa; solo fuera de ventana o primer contacto).",
      schema: z.object({
        name: z.string().min(1),
        language: z.string().min(1),
        params: z.array(z.string()).default([]),
      }),
    },
  )

  const moveToStage = tool(
    async ({ stageId, opportunityId }: { stageId: string; opportunityId?: string }) => {
      if (ctx.sandbox) return sandboxPropose("mover_oportunidad", "Mover la oportunidad de etapa")
      if (ctx.dryRun) return "[SIMULACIÓN] Se propondría mover la oportunidad de etapa."
      const chosen = await chooseOpportunity(opportunityId)
      if ("message" in chosen) return chosen.message
      return propose("mover_oportunidad", { opportunityId: chosen.id, stageId }, "move_to_stage")
    },
    {
      name: "move_to_stage",
      description:
        "Mueve una oportunidad abierta del contacto a otra etapa (propuesta si la política no es directa). Si no das opportunityId y hay varias abiertas, devuelve la lista para preguntar.",
      schema: operationAgentSchema("oportunidad.mover"),
    },
  )

  const addTags = tool(
    async ({ tags }: { tags: string[] }) => {
      const contactId = ctx.contactId
      if (ctx.dryRun) return `[SIMULACIÓN] Se agregarían etiquetas: ${tags.join(", ")}.`
      const merged = await inOrg(async (tx) => {
        const current = await requireContact(tx, ctx.orgId, contactId)
        const next = [...new Set([...current.tags, ...tags])]
        await updateContact(tx, ctx.orgId, contactId, { tags: next }, { userId: null, origin: "agent" })
        return next
      })
      return `Etiquetas: ${merged.join(", ")}.`
    },
    {
      name: "add_tags",
      description: "Agrega etiquetas al contacto (p.ej. interesado-ortodoncia).",
      schema: z.object({ tags: z.array(z.string().min(1).max(40)).min(1).max(10) }),
    },
  )

  const updateContactTool = tool(
    async ({
      displayName,
      customFields,
    }: {
      displayName?: string
      customFields?: Record<string, unknown>
    }) => {
      const contactId = ctx.contactId
      if (ctx.dryRun) return "[SIMULACIÓN] Se actualizaría el contacto."
      await inOrg((tx) => updateContact(tx, ctx.orgId, contactId, { displayName, customFields }, { userId: null, origin: "agent" }))
      return "Contacto actualizado."
    },
    {
      name: "update_contact",
      description: "Actualiza nombre o campos personalizados del contacto.",
      schema: z.object({
        displayName: z.string().min(1).max(200).optional(),
        customFields: z.record(z.string(), z.unknown()).optional(),
      }),
    },
  )

  const createTaskTool = tool(
    async ({ title, dueAt }: { title: string; dueAt?: string }) => {
      const contactId = ctx.contactId
      if (ctx.dryRun) return `[SIMULACIÓN] Se crearía la tarea: ${title}.`
      const created = await inOrg((tx) =>
        createTask(tx, ctx.orgId, {
          title,
          ...(dueAt ? { dueAt } : {}),
          ...(contactId ? { contactId } : {}),
          conversationId: ctx.conversationId,
          createdBy: "agent",
          // Misma clave estable que las propuestas: reentregar el mensaje no duplica la tarea.
          idempotencyKey: buildAgentProposalKey({
            conversationId: ctx.conversationId,
            triggerId: ctx.triggerId,
            tool: "create_task",
            payload: { title, dueAt: dueAt ?? null },
          }),
        }),
      )
      return `Tarea creada (id ${created.id}).`
    },
    {
      name: "create_task",
      description: "Crea una tarea de seguimiento (llamar, confirmar, etc.).",
      schema: operationAgentSchema("tarea.crear"),
    },
  )

  const clinicInfo = tool(
    async () => {
      // Con «Informar» apagado esta herramienta sigue para Agendar, pero solo con sedes y horarios:
      // ni precios, ni promociones, ni profesionales, ni medios de pago.
      const informs = !(ctx.excludedTools ?? []).includes("buscar_en_la_clinica")
      const { snapshot, data, zone } = await inOrg(async (tx) => ({
        snapshot: await getClinicInfoSnapshot(tx, ctx.orgId),
        data: await getAgentClinicData(tx, ctx.orgId, informs),
        zone: await getOrgLocale(tx, ctx.orgId),
      }))
      const lines = [`Clínica: ${snapshot.clinicName}.`]
      for (const b of snapshot.branches) {
        lines.push(
          `- Sede ${b.name} (id ${b.id}): ${[b.address, b.phone, b.mapsUrl].filter(Boolean).join(" · ") || "sin datos"}`,
        )
      }
      lines.push(...formatAgentClinicData(data, zone))
      if (informs && snapshot.paymentMethods.length) {
        lines.push("Medios de pago aceptados por la clínica (los mismos que ofrece caja):")
        for (const m of snapshot.paymentMethods) lines.push(`- ${m.name}`)
        if (snapshot.refusedPaymentMethods.length) lines.push(`La clínica NO acepta: ${snapshot.refusedPaymentMethods.join(", ")}.`)
      }
      return lines.join("\n")
    },
    {
      name: "ver_sedes_y_servicios",
      description:
        "Sedes (con id) y su horario de atención, servicios con cómo decir su precio, promociones vigentes con sus condiciones, profesionales y medios de pago. Úsalo antes de hablar de precios, sedes, horarios, profesionales, medios, promociones o disponibilidad. Si la clínica tiene muchos servicios, búscalos con buscar_en_la_clinica.",
      schema: z.object({}),
    },
  )

  /**
   * Lo más parecido por significado. La frase se vectoriza fuera de la
   * transacción; si el proveedor falla, se busca solo por palabras.
   */
  async function meaningOf(text: string): Promise<MeaningRank | undefined> {
    const embedder = ctx.embedder
    if (!embedder) return undefined
    try {
      // En una conversación se espera poco: pasado el plazo se busca por palabras.
      const [embedding] = await Promise.race([
        embedder.embed([text]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("vectores: sin respuesta a tiempo")), QUERY_EMBED_MS)),
      ])
      if (!embedding?.length) return undefined
      return await inOrg((tx) => rankByMeaning(tx, ctx.orgId, { model: embedder.model, embedding }))
    } catch {
      return undefined
    }
  }

  const clinicSearch = tool(
    async ({ texto }: { texto: string }) => {
      const ranked = await meaningOf(texto)
      const result = await inOrg(async (tx) => {
        return {
          found: await searchClinic(tx, ctx.orgId, texto, {
            rankedServiceIds: ranked?.services,
            rankedPromotionIds: ranked?.promotions,
            rankedProfessionalIds: ranked?.professionals,
          }),
          zone: await getOrgLocale(tx, ctx.orgId),
        }
      })
      return formatClinicSearch(result.found, result.zone)
    },
    {
      name: "buscar_en_la_clinica",
      description:
        "Busca en lo que ofrece la clínica: servicios (con cómo decir su precio), promociones vigentes (precio, condiciones y fecha de fin) y profesionales por nombre o especialidad. Escribe lo que pide la persona con sus palabras («dientes amarillos», «frenillos», «ortodoncista»). Devuelve solo lo que coincide, leído en este momento.",
      schema: z.object({ texto: z.string().trim().min(2).max(200) }),
    },
  )

  const knowledgeSearch = tool(
    async ({ pregunta }: { pregunta: string }) => {
      const hidden = new Set(ctx.lessonOverrides?.skipEntryIds ?? [])
      const ranked = await meaningOf(pregunta)
      const found = (await inOrg((tx) => searchPublishedKnowledge(tx, ctx.orgId, pregunta, 5, ranked?.answers))).filter(
        (hit) => !hidden.has(hit.id),
      )
      // En una prueba, la respuesta oficial de una lección aún sin aprobar cuenta como publicada.
      const trial = (ctx.lessonOverrides?.extra ?? [])
        .filter((lesson) => lesson.kind === "respuesta_oficial")
        .map((lesson) => ({ id: lesson.id, title: lesson.title, body: lesson.body, branchName: null as string | null }))
      const hits = [...trial, ...found]
      if (found.length && !ctx.dryRun) {
        await inOrg((tx) => noteLessonUse(tx, ctx.orgId, { entryIds: found.map((hit) => hit.id) })).catch(() => null)
      }
      if (!hits.length) {
        // Lo que no supo responder queda a la vista de quien administra el
        // conocimiento, con lo que preguntó el interlocutor.
        if (!ctx.dryRun) {
          await inOrg((tx) =>
            recordKnowledgeGap(tx, ctx.orgId, {
              conversationId: ctx.conversationId,
              triggerMessageId: ctx.triggerId,
              question: ctx.lastInboundText?.trim() || pregunta,
              query: pregunta,
            }),
          ).catch(() => null)
        }
        return "Sin respuesta oficial: no inventes, ofrece derivar a humano."
      }
      return hits
        .map((h) => `- ${h.branchName ? `${h.title} (solo sede ${h.branchName})` : h.title}: ${h.body}`)
        .join("\n")
    },
    {
      name: "consultar_conocimiento",
      description:
        "Busca respuestas oficiales vigentes por el título, por cómo lo pregunta la gente o por las palabras de la pregunta; para el texto completo de una respuesta del índice o recortada pasa su título exacto. Cítalas tal cual.",
      schema: z.object({ pregunta: z.string().min(2).max(300) }),
    },
  )

  const patientContext = tool(
    async ({ patientId }: { patientId?: string }) => {
      if (ctx.sandbox) {
        return patientId
          ? `Paciente: ${SANDBOX_PERSON} (vínculo self, autorización self). Solo filiación mínima: nunca pidas ni reveles historia clínica.`
          : `- ${SANDBOX_PERSON} (id ${SANDBOX_PATIENT_ID}, vínculo: self)`
      }
      if (!patientId) {
        const candidates = await inOrg((tx) => listAgentContextCandidates(tx, ctx.orgId, ctx.contactId))
        if (!candidates.length) return "El interlocutor no está vinculado a ningún paciente: pide sus datos o deriva."
        return candidates
          .map((c) => `- ${c.displayName} (id ${c.patientId}, vínculo: ${c.relationship})`)
          .join("\n")
      }
      const found = await inOrg((tx) => resolveAgentPatientContext(tx, ctx.orgId, ctx.contactId, patientId))
      return `Paciente: ${found.displayName} (vínculo ${found.relationship}, autorización ${found.authorization}). Solo filiación mínima: nunca pidas ni reveles historia clínica.`
    },
    {
      name: "ver_contexto_paciente",
      description:
        "Sin id lista los pacientes vinculados al interlocutor; con id verifica vínculo y autorización. Nunca devuelve historia clínica.",
      schema: z.object({ patientId: z.string().uuid().optional() }),
    },
  )

  const patientSummary = tool(
    async ({ patientId }: { patientId: string }) => {
      if (ctx.sandbox) return `Paciente: ${SANDBOX_PERSON} (vínculo self).\nSin citas próximas.\nSin saldo pendiente.`
      const summary = await inOrg((tx) => getAgentPatientSummary(tx, ctx.orgId, ctx.contactId, patientId))
      const zone = await orgZone()
      const lines = [`Paciente: ${summary.context.displayName} (vínculo ${summary.context.relationship}).`]
      if (!summary.upcomingAppointments.length) {
        lines.push("Sin citas próximas.")
      }
      for (const a of summary.upcomingAppointments) {
        const cuando = formatZoned(new Date(a.startsAt), { timezone: a.branchTimezone ?? zone.timezone, locale: zone.locale })
        lines.push(
          `- Cita ${a.status} (id ${a.appointmentId}, versión ${a.version}) el ${cuando}, ${a.branchName} con ${a.dentistName}.`,
        )
      }
      for (const b of summary.budgets) {
        lines.push(`- Presupuesto N°${b.number} ${b.title}: ${b.status}.`)
      }
      if (summary.balance === null) {
        lines.push("Sin facultad para ver saldos: no los menciones ni los pidas.")
      } else if (!summary.balance.length || summary.balance.every((b) => b.outstandingCents <= 0)) {
        lines.push("Sin saldo pendiente.")
      } else {
        for (const b of summary.balance) {
          if (b.outstandingCents > 0) {
            lines.push(`- Saldo pendiente: ${formatOrgMoney(b.outstandingCents, b.currency, zone)}.`)
          }
        }
      }
      return lines.join("\n")
    },
    {
      name: "ver_resumen_paciente",
      description:
        "Próximas citas (con id y versión para reprogramar_cita/cancelar_cita) y estado de presupuestos del paciente verificado; saldo solo si el interlocutor tiene facultad económica. Nunca historia clínica.",
      schema: z.object({ patientId: z.string().uuid() }),
    },
  )

  const availability = tool(
    async (input: {
      branchId: string
      from: string
      to: string
      durationMin?: number
      dentistUserId?: string
      chairId?: string
      serviceId?: string
    }) => {
      const { gaps, truncated, timeZone } = await inOrg((tx) => findFreeGaps(tx, ctx.orgId, input))
      if (!gaps.length) return "Sin huecos en ese rango (quizá sin horario configurado): ofrece otro rango o deriva."
      const { locale } = await orgZone()
      // La hora ya va en la de la sede: el modelo la dice tal cual y nunca convierte zonas.
      const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "numeric", month: "long" })
      const clock = new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      const lines = [
        "Huecos libres, en hora local de la sede (dilos así, sin convertir horas). El dato entre corchetes es solo para proponer_cita: no lo escribas a la persona.",
        ...gaps.map((g) => {
          const start = new Date(g.startsAt)
          const end = new Date(g.endsAt)
          const chair = g.chairId ?? "sin sillón asignado: filtra por un sillón real o deriva"
          return (
            `- ${day.format(start)}, ${clock.format(start)}–${clock.format(end)}${g.dentistName ? ` con ${g.dentistName}` : ""}` +
            ` [startsAt ${g.startsAt} · sede ${input.branchId} · sillón ${chair} · profesional ${g.dentistUserId}]`
          )
        }),
        "Usa los datos exactos del hueco elegido en proponer_cita (startsAt, sede, sillón y profesional): nunca inventes IDs ni horas.",
      ]
      if (truncated) lines.push("Hay más huecos: acota el rango por días.")
      return lines.join("\n")
    },
    {
      name: "buscar_huecos",
      description:
        "Huecos reales de agenda según horario del profesional, ausencias, feriados y citas ocupantes. Usa el id exacto de la sede (branchId); from/to en hora local de la sede y sin zona (por ejemplo 2026-10-16T08:00 y 2026-10-16T13:00 para «el viernes en la mañana»). No indiques durationMin: con serviceId se usa la duración del servicio y, sin servicio, la de una cita regular en esa sede; indícala solo si el interlocutor pide otra duración. Cada hueco devuelve sede, sillón, profesional, inicio, fin, zona y duración para proponer_cita.",
      schema: z.object({
        branchId: z.string().uuid(),
        from: z.string().min(1),
        to: z.string().min(1),
        durationMin: z.number().int().min(10).max(480).optional(),
        dentistUserId: z.string().optional(),
        chairId: z.string().uuid().optional(),
        serviceId: z.string().uuid().optional(),
      }),
    },
  )

  const bookingLink = tool(
    async (input: { patientId?: string; serviceId?: string; branchId?: string }) => {
      // En una prueba no se crea ningún enlace: la marca deja ver dónde iría en el mensaje.
      if (ctx.dryRun) return "[SIMULACIÓN] Enlace para que la persona elija su cita: [enlace de reserva]. Inclúyelo tal cual en tu respuesta con send_reply y ofrece también seguir por aquí."
      const publicUrl = ctx.publicUrl
      if (!publicUrl) return "El enlace de reserva no está disponible: propón horarios por aquí con buscar_huecos. Si no tienes buscar_huecos, pasa el caso a una persona: no digas que enviaste un enlace."
      try {
        const { link, slug } = await inOrg(async (tx) => {
          const [org] = await tx.select({ slug: organization.slug }).from(organization).where(eq(organization.id, ctx.orgId)).limit(1)
          return { link: await createBookingLink(tx, ctx.orgId, { conversationId: ctx.conversationId, ...input }), slug: org?.slug ?? null }
        })
        if (!slug) return "La clínica no tiene dirección pública: propón horarios por aquí con buscar_huecos. Si no tienes buscar_huecos, pasa el caso a una persona: no digas que enviaste un enlace."
        const url = new URL(publicUrl.webURL)
        url.hostname = `${slug}.${publicUrl.cookieDomain.replace(/^\./, "")}`
        url.pathname = "/reserva"
        url.search = ""
        url.hash = ""
        url.searchParams.set("token", link.token)
        const who = link.patientName ?? "la persona"
        const data = link.needsRegistration ? " Como aún no es paciente, la página le pedirá sus datos antes de reservar: díselo." : ""
        return `Enlace para que ${who} elija su cita viendo los horarios libres (es personal y vale ${BOOKING_LINK_TTL_HOURS} horas): ${url.toString()}\nEnvíalo tal cual con send_reply, en un solo mensaje, y ofrece también seguir por aquí si lo prefiere.${data} Cuando reserve, el sistema se lo confirma en esta conversación y queda en el estado del caso: no vuelvas a proponer horarios.`
      } catch (error) {
        if (error instanceof ServiceError && error.code === "BOOKING_NEEDS_PATIENT") {
          return "La persona aún no es paciente y la clínica no tiene activo el registro de pacientes en línea: no puede reservar desde un enlace. Sigue por aquí o pasa el caso a una persona para completar sus datos."
        }
        if (error instanceof ServiceError && error.code === "BOOKING_PATIENT_AMBIGUOUS") {
          return "La persona tiene varios pacientes vinculados: pregunta para quién es la cita y vuelve a llamar con su patientId (de ver_contexto_paciente)."
        }
        if (error instanceof ServiceError) return `No se pudo crear el enlace: ${error.message}. Propón horarios por aquí. Si no tienes buscar_huecos, pasa el caso a una persona: no digas que enviaste un enlace.`
        throw error
      }
    },
    {
      name: "enviar_enlace_cita",
      description:
        "Crea un enlace personal para que la persona elija ella misma el día y la hora de su cita viendo los horarios libres, en vez de ir y venir por el chat. Sirve a quien ya es paciente y a quien recién se contacta (este completa sus datos en la misma página). Es una opción: también puedes reservar por aquí. Indica serviceId y branchId si ya se habló de un servicio o una sede (ids exactos de «Sedes» y «Servicios»); patientId solo si tiene varios pacientes vinculados. La página no muestra precios. No reserva nada por sí sola: la cita la crea la persona al elegir.",
      schema: z.object({
        patientId: z.string().uuid().optional(),
        serviceId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
      }),
    },
  )

  const proposeBooking = tool(
    async (input: {
      patientId: string
      dentistUserId: string
      chairId: string
      startsAt: string
      branchId?: string
      serviceId?: string
      durationMin?: number
      reason?: string
    }) => {
      if (ctx.sandbox) return sandboxPropose("reservar_cita", await sandboxWhen(input.startsAt))
      if (ctx.dryRun) {
        return `[SIMULACIÓN] Se propondría reservar: paciente ${input.patientId} el ${input.startsAt}.`
      }
      const { reason, ...payload } = input
      return propose("reservar_cita", payload, "proponer_cita", reason)
    },
    {
      name: "proponer_cita",
      description:
        "Propone reservar una cita con los IDs exactos de un hueco de buscar_huecos (sede, sillón, profesional, inicio). Verifica vínculo del paciente al ejecutar; queda esperando la confirmación del interlocutor (confirmar_propuesta).",
      schema: operationAgentSchema("cita.reservar"),
    },
  )

  const rescheduleAppointment = tool(
    async (input: {
      appointmentId: string
      startsAt: string
      expectedVersion: number
      dentistUserId?: string
      chairId?: string
      reason?: string
    }) => {
      if (ctx.sandbox) return sandboxPropose("reprogramar_cita", await sandboxWhen(input.startsAt))
      if (ctx.dryRun) {
        return `[SIMULACIÓN] Se propondría reprogramar la cita ${input.appointmentId} al ${input.startsAt}.`
      }
      const { reason, ...payload } = input
      return propose("reprogramar_cita", payload, "reprogramar_cita", reason)
    },
    {
      name: "reprogramar_cita",
      description:
        "Propone mover una cita existente a un nuevo inicio: nunca crea una reserva duplicada. Usa el id y la versión exactos de ver_resumen_paciente; con varias citas pregunta primero cuál corresponde y nunca actúes sobre pacientes no autorizados. Queda esperando la confirmación del interlocutor (confirmar_propuesta).",
      schema: operationAgentSchema("cita.mover"),
    },
  )

  const cancelAppointmentProposal = tool(
    async (input: { appointmentId: string; reason?: string }) => {
      if (ctx.sandbox) return sandboxPropose("cancelar_cita", "Cancelar la cita")
      if (ctx.dryRun) {
        return `[SIMULACIÓN] Se propondría cancelar la cita ${input.appointmentId}.`
      }
      const { reason, ...payload } = input
      return propose("cancelar_cita", payload, "cancelar_cita", reason)
    },
    {
      name: "cancelar_cita",
      description:
        "Propone cancelar una cita existente (nunca la borra ni crea otra). Usa el id exacto de ver_resumen_paciente; con varias citas pregunta primero cuál corresponde. Queda esperando la confirmación del interlocutor (confirmar_propuesta); la respuesta indica el estado real: pendiente, ejecutada o fallida.",
      schema: z.object({
        appointmentId: z.string().uuid(),
        reason: z.string().max(500).optional(),
      }),
    },
  )

  const confirmProposal = tool(
    async ({ proposalId }: { proposalId: string }) => {
      if (ctx.sandbox) {
        const state = ctx.sandbox.state
        const pending = state.pending.find((item) => item.id === proposalId)
        if (!pending) return "[SIMULACIÓN] Esa propuesta no está pendiente en esta prueba."
        state.pending = state.pending.filter((item) => item.id !== proposalId)
        state.recent = [{ ...pending, status: "ejecutada", at: new Date().toISOString(), expiresAt: null }, ...state.recent].slice(0, 5)
        return `[SIMULACIÓN] Confirmado y ejecutado (propuesta ${proposalId}).`
      }
      if (ctx.dryRun) return `[SIMULACIÓN] Se confirmaría la propuesta ${proposalId}.`
      let proposal: ProposalItem
      try {
        proposal = await inOrg((tx) =>
          confirmProposalByContact(tx, ctx.orgId, ctx.contactId, proposalId, { secretsKey: ctx.secretsKey }),
        )
      } catch (e) {
        if (e instanceof ServiceError && e.code === "PROPOSAL_NOT_CONTACT_CONFIRMABLE") return e.message
        throw e
      }
      if (proposal.status === "ejecutada") {
        if (proposal.action === "enviar_mensaje") ctx.replySettled = true
        return `Confirmado y ejecutado (propuesta ${proposal.id}).`
      }
      if (proposal.status === "fallida") {
        const rawError = proposal.error?.trim() ?? ""
        if (rawError.startsWith("WINDOW_CLOSED") || proposal.result?.errorCode === "WINDOW_CLOSED") return OUTSIDE_WINDOW
        const detail = rawError ? `: ${rawError.slice(0, 300)}` : "."
        return `No se pudo ejecutar al confirmar (propuesta ${proposal.id})${detail} Ofrece una alternativa o deriva a humano.`
      }
      if (proposal.status === "expirada") {
        return `La propuesta ${proposal.id} expiró (48h): pide de nuevo el acto al interlocutor para crear una nueva propuesta, no reintentes confirmar.`
      }
      return `Propuesta ${proposal.id} en estado ${proposal.status}.`
    },
    {
      name: "confirmar_propuesta",
      description:
        "Confirma un acto en modo confirmar_usuario cuando el interlocutor lo aprobó con un sí explícito.",
      schema: z.object({ proposalId: z.string().uuid() }),
    },
  )
  const noteCase = tool(
    async ({ nota }: { nota: string }) => {
      if (ctx.sandbox) {
        const text = nota.replace(/[ \t\n]+/g, " ").trim().slice(0, 300)
        const notes = ctx.sandbox.state.notes
        if (text && !notes.some((note) => note.text === text)) {
          ctx.sandbox.state.notes = [...notes, { text, at: new Date().toISOString() }].slice(-12)
        }
        return "[SIMULACIÓN] Anotado en el caso."
      }
      if (ctx.dryRun) return `[SIMULACIÓN] Se anotaría en el caso: ${nota}`
      await inOrg((tx) => addAgentCaseNote(tx, ctx.orgId, ctx.conversationId, nota))
      return "Anotado en el caso."
    },
    {
      name: "anotar_caso",
      description:
        "Guarda una nota breve del caso para tus próximos turnos: para quién es la cita, servicio y sede elegidos, preferencia de horario o lo que quedó pendiente. No anotes datos clínicos ni lo que ya figura en el estado del caso.",
      schema: z.object({ nota: z.string().min(3).max(300) }),
    },
  )

  const rememberFact = tool(
    async ({ text, replacesId }: { text: string; replacesId?: string }) => {
      if (ctx.sandbox || ctx.dryRun) return `[SIMULACIÓN] Se recordaría de esta persona: ${text}`
      try {
        const fact = await inOrg((tx) =>
          addPersonFact(tx, ctx.orgId, { userId: null, source: "agente" }, {
            contactId: ctx.contactId,
            text,
            replacesId: replacesId ?? null,
            conversationId: ctx.conversationId,
          }),
        )
        return `Guardado para próximas conversaciones (id ${fact.id}).`
      } catch (error) {
        // Un dato de salud o un tope alcanzado no son un fallo de la corrida: el modelo sigue sin guardarlo.
        if (error instanceof ServiceError) return `No se guardó: ${error.message}`
        throw error
      }
    },
    {
      name: "recordar_dato",
      description:
        "Guarda un dato práctico de la persona que servirá en otra conversación y en cualquier canal (horario que le viene bien, cómo quiere que la llamen, por quién escribe). Nunca datos de salud: esos no se guardan aquí. Si corrige un dato ya guardado, indica su id en replacesId.",
      schema: operationAgentSchema("persona.recordar"),
    },
  )

  const createOpportunityTool = tool(
    async (input: {
      title: string
      stageId?: string
      pipelineId?: string
      patientId?: string
      serviceId?: string
      interestText?: string
      amountCents?: number
      currency?: string
      nextActionAt?: string
      nextActionNote?: string
      reason?: string
    }) => {
      if (ctx.sandbox) return sandboxPropose("crear_oportunidad", `Nueva oportunidad: ${input.title}`)
      if (ctx.dryRun) return `[SIMULACIÓN] Se propondría crear la oportunidad: ${input.title}.`
      const { reason, ...payload } = input
      return propose("crear_oportunidad", payload, "create_opportunity", reason)
    },
    {
      name: "create_opportunity",
      description:
        "Crea una oportunidad para el contacto de la conversación (propuesta si la política no es directa). El título es obligatorio; la etapa nace abierta.",
      schema: operationAgentSchema("oportunidad.crear"),
    },
  )

  const updateFollowup = tool(
    async (input: { opportunityId?: string; nextActionAt?: string; nextActionNote?: string; reason?: string }) => {
      if (ctx.sandbox) return sandboxPropose("actualizar_seguimiento", input.nextActionNote?.trim() || "Nuevo seguimiento")
      if (ctx.dryRun) return "[SIMULACIÓN] Se propondría actualizar el seguimiento de la oportunidad."
      if (input.nextActionAt === undefined && input.nextActionNote === undefined) {
        return "Indica la fecha (nextActionAt ISO) o la nota (nextActionNote) del seguimiento."
      }
      const chosen = await chooseOpportunity(input.opportunityId)
      if ("message" in chosen) return chosen.message
      const payload: Record<string, unknown> = { opportunityId: chosen.id }
      if (input.nextActionAt !== undefined) payload["nextActionAt"] = input.nextActionAt
      if (input.nextActionNote !== undefined) payload["nextActionNote"] = input.nextActionNote
      return propose("actualizar_seguimiento", payload, "update_followup", input.reason)
    },
    {
      name: "update_followup",
      description:
        "Programa o actualiza el seguimiento (próxima acción) de una oportunidad del contacto (propuesta si la política no es directa). Si no das opportunityId y hay varias abiertas, devuelve la lista para preguntar.",
      schema: z.object({
        opportunityId: z.string().uuid().optional(),
        nextActionAt: z.string().optional(),
        nextActionNote: z.string().max(500).optional(),
        reason: z.string().max(500).optional(),
      }),
    },
  )

  const closeOpportunityTool = tool(
    async (input: { opportunityId?: string; outcome: "won" | "lost"; reason: string }) => {
      if (ctx.sandbox) return sandboxPropose("cerrar_oportunidad", input.outcome === "won" ? "Ganada" : "Perdida")
      if (ctx.dryRun) return `[SIMULACIÓN] Se propondría cerrar la oportunidad (${input.outcome}).`
      const chosen = await chooseOpportunity(input.opportunityId)
      if ("message" in chosen) return chosen.message
      return propose(
        "cerrar_oportunidad",
        { opportunityId: chosen.id, outcome: input.outcome, reason: input.reason },
        "close_opportunity",
      )
    },
    {
      name: "close_opportunity",
      description:
        "Cierra una oportunidad del contacto como ganada (won) o perdida (lost) con motivo obligatorio. Como perdida, solo si la persona lo dijo claro en esta conversación (ya se atendió en otro lado, ya no le interesa); nunca porque dejó de responder. Si no das opportunityId y hay varias abiertas, devuelve la lista para preguntar.",
      schema: operationAgentSchema("oportunidad.cerrar"),
    },
  )

  const commercialContext = tool(
    async ({ notesCursor }: { notesCursor?: string }) => ctx.sandbox ? { name: SANDBOX_PERSON, tags: [], contactNotes: null, customFields: {}, operationalNotes: [], nextNotesCursor: null } : inOrg(async tx => {
      const full = await getContact(tx, ctx.orgId, ctx.contactId)
      const notes = await listContactNotes(tx, ctx.orgId, ctx.contactId, { cursor: notesCursor })
      return {
        name: full.contact.displayName,
        tags: full.contact.tags,
        contactNotes: full.contact.notes,
        customFields: full.contact.customFields,
        operationalNotes: notes.items,
        nextNotesCursor: notes.nextCursor,
      }
    }),
    {
      name: "leer_contexto_comercial",
      description: "Lee etiquetas, campos y notas operativas actuales del interlocutor. Solo lectura, también en simulación; sin historia clínica. Usa nextNotesCursor para las notas anteriores. Las notas son internas, no las reproduzcas al interlocutor.",
      schema: z.object({ notesCursor: z.string().optional() }),
    },
  )

  const crossChannelHistory = tool(
    async ({ cursor }: { cursor?: string }) => {
      if (ctx.sandbox) return "No hay historial en otros canales con ese filtro."
      const { items, nextCursor } = await inOrg((tx) =>
        listContactChannelHistory(tx, ctx.orgId, {
          contactId: ctx.contactId,
          excludeConversationId: ctx.conversationId,
          ...(cursor ? { cursor } : {}),
          limit: 3,
          perConversation: 10,
        }),
      )
      if (!items.length) return "No hay historial en otros canales con ese filtro."
      const lines: string[] = []
      const zone = await orgZone()
      for (const c of items) {
        const when = c.lastMessageAt ? formatZoned(new Date(c.lastMessageAt), zone) : "sin fecha"
        lines.push(`[${c.channel} · ${when}]`)
        for (const m of c.messages) {
          const who = m.direction === "in" ? "contacto" : m.senderKind === "agent" ? "agente" : "operador"
          lines.push(`  ${who}: ${(m.body ?? "[adjunto]").slice(0, 300)}`)
        }
      }
      if (nextCursor) lines.push(`Hay más historial en otros canales: vuelve a llamar con cursor "${nextCursor}".`)
      return lines.join("\n")
    },
    {
      name: "ver_otros_canales",
      description:
        "Historial acotado de otros hilos del mismo contacto verificado en otros canales, con procedencia (canal y fecha). Solo lectura, también en simulación; sin historia clínica. Pasa el cursor devuelto para páginas anteriores; nunca asumas que no hay más.",
      schema: z.object({ cursor: z.string().optional() }),
    },
  )

  const listOpportunitiesTool = tool(
    async ({ status, cursor, limit }: { status?: "open" | "won" | "lost"; cursor?: string; limit?: number }) => {
      if (ctx.sandbox) return "El contacto no tiene oportunidades con ese filtro."
      const { items, nextCursor } = await inOrg((tx) =>
        listOpportunities(tx, ctx.orgId, {
          contactId: ctx.contactId,
          ...(status ? { status } : {}),
          ...(cursor ? { cursor } : {}),
          limit: limit ?? 20,
        }),
      )
      if (!items.length) return "El contacto no tiene oportunidades con ese filtro."
      const zone = await orgZone()
      const lines = items.map(
        (o) =>
          `- ${o.title} (id ${o.id}, etapa ${o.stageName}, estado ${o.status}${o.nextActionAt ? `, próxima acción ${formatZoned(new Date(o.nextActionAt), zone)}` : ""})`,
      )
      if (nextCursor) lines.push(`Hay más oportunidades: vuelve a llamar con cursor "${nextCursor}".`)
      return lines.join("\n")
    },
    {
      name: "listar_oportunidades",
      description:
        "Lista todas las oportunidades del contacto por páginas (el prompt solo trae las primeras). Pasa el cursor devuelto para ver más; nunca asumas que no hay más.",
      schema: z.object({
        status: z.enum(["open", "won", "lost"]).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
  )

  const listTasksTool = tool(
    async ({ status }: { status?: "open" | "done" | "cancelled" }) => {
      if (ctx.sandbox) return "El contacto no tiene tareas con ese filtro."
      const items = await inOrg((tx) =>
        listTasks(tx, ctx.orgId, { contactId: ctx.contactId, ...(status ? { status } : {}) }),
      )
      if (!items.length) return "El contacto no tiene tareas con ese filtro."
      const zone = await orgZone()
      return items
        .map(
          (t) =>
            `- ${t.title} (id ${t.id}, estado ${t.status}${t.dueAt ? `, vence ${formatZoned(new Date(t.dueAt), zone)}` : ""}${t.opportunityTitle ? `, oportunidad ${t.opportunityTitle}` : ""})`,
        )
        .join("\n")
    },
    {
      name: "listar_tareas",
      description:
        "Lista todas las tareas del contacto (el prompt solo trae un resumen). Úsala antes de afirmar que no hay seguimientos.",
      schema: z.object({ status: z.enum(["open", "done", "cancelled"]).optional() }),
    },
  )

  const requestHandoff = tool(
    async ({ reason, summary, priority, assigneeUserId, message, asks, pending }: { reason: string; summary?: string; priority?: string; assigneeUserId?: string; message?: string; asks?: string; pending?: string }) => {
      // El aviso a la persona sigue el mismo formato del canal que cualquier respuesta.
      const notice = message?.trim() ? formatForChannel(message.trim(), await conversationChannel(ctx), { emojis: ctx.emojis }) : undefined
      // Lo que queda escrito para quien toma el caso: qué pide, qué falta y el
      // aviso que de verdad salió (no el que se intentó).
      const annotate = (sent: boolean) => {
        const handoffId = ctx.handoffId
        if (!handoffId) return Promise.resolve()
        return inOrg((tx) => annotateHandoff(tx, ctx.orgId, handoffId, { asks, pending, notice: sent ? notice : null }))
      }
      if (ctx.dryRun) {
        await performHandoff(ctx, reason, summary)
        if (notice) {
          ctx.replySettled = true
          ctx.simulatedReply = notice
        }
        return `[SIMULACIÓN] Se derivaría a humano: ${reason}.`
      }
      if (ctx.handedOff) {
        // El caso ya pasó a una persona en esta corrida (lo decidió el camino):
        // no se registra otra derivación, solo sale el aviso al interlocutor.
        if (!notice) return "El caso ya pasó a una persona. Falta el aviso al interlocutor: llama de nuevo con message."
        const outcome = await propose("enviar_mensaje", { kind: "text", text: notice }, "request_human_handoff")
        await annotate(ctx.replySettled === true)
        return ctx.replySettled
          ? "Aviso al interlocutor registrado. No envíes más mensajes."
          : `El aviso al interlocutor no salió: ${outcome}`
      }
      const validPriority = priority === "alta" || priority === "baja" ? priority : "media"
      const handoff = await inOrg((tx) =>
        createHandoff(tx, ctx.orgId, null, {
          conversationId: ctx.conversationId,
          reason,
          summary: summary?.trim() ? summary : reason,
          priority: validPriority,
          ...(assigneeUserId ? { assigneeUserId } : {}),
          createdBy: "agent",
          asks,
          pending,
        }),
      )
      ctx.handedOff = true
      ctx.handoffId = handoff.id
      const destino = handoff.assigneeUserId ? "con responsable asignado" : "en la cola del equipo por recoger"
      // El aviso sale después de crear la derivación: si esta falla, no se le
      // promete al interlocutor una atención que nadie registró.
      let noticeResult = ""
      if (notice) {
        const outcome = await propose("enviar_mensaje", { kind: "text", text: notice }, "request_human_handoff")
        noticeResult = ctx.replySettled ? " Aviso al interlocutor registrado." : ` El aviso al interlocutor no salió: ${outcome}`
        if (ctx.replySettled) await annotate(true)
      }
      return `Derivado a humano (${destino}, plazo ${handoff.dueAt ?? "sin plazo"}).${noticeResult} No envíes más mensajes.`
    },
    {
      name: "request_human_handoff",
      description:
        "Deriva a un humano con motivo, resumen factual de lo conversado y prioridad (alta/media/baja); sin assigneeUserId queda en la cola del equipo con plazo según prioridad. Apaga el agente y cierra el turno: pon en message el aviso breve para el interlocutor (por ejemplo, que una persona continuará la atención), porque después no podrás enviarle nada.",
      schema: operationAgentSchema("derivacion.crear"),
    },
  )

  const tools = [
    sendReply,
    farewellAndClose,
    sendTemplate,
    moveToStage,
    createOpportunityTool,
    updateFollowup,
    closeOpportunityTool,
    listOpportunitiesTool,
    listTasksTool,
    commercialContext,
    crossChannelHistory,
    addTags,
    updateContactTool,
    createTaskTool,
    clinicInfo,
    clinicSearch,
    knowledgeSearch,
    patientContext,
    patientSummary,
    availability,
    bookingLink,
    proposeBooking,
    rescheduleAppointment,
    cancelAppointmentProposal,
    confirmProposal,
    noteCase,
    rememberFact,
    requestHandoff,
  ]
  return tools.filter(
    (candidate) =>
      !ctx.excludedTools?.includes(candidate.name) &&
      // Sin dirección pública configurada no hay página que abrir.
      (candidate.name !== "enviar_enlace_cita" || Boolean(ctx.publicUrl) || ctx.dryRun),
  )
}
