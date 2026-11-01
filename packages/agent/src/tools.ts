import { createHash } from "node:crypto"
import { tool } from "@langchain/core/tools"
import { type Db, withOrgContext } from "@odentia/db"
import type { AnswerBasisItem, AnswerCheck, AnswerTraceOutcome } from "@odentia/db/schema/agent"
import { channelConnection, conversation } from "@odentia/db/schema/crm"
import type { MeaningRank, OpportunityDetail, OrgLocale, ProposalItem, PublicLinkConfig, SearchEmbedder, Storage } from "@odentia/services"
import {
  type AgentPatientBudgets,
  addAgentCaseNote,
  addPersonFact,
  agentReplyBlockedReason,
  agentTextsFor,
  annotateHandoff,
  answerGeneralPermission,
  bookedDataLink,
  bookingPickAddress,
  budgetAnswerQuestion,
  budgetLineWords,
  budgetNumberText,
  buildAgentProposalKey,
  CASE_SLOTS,
  type CaseSlot,
  type ContactAppointmentOption,
  chatBookingMissing,
  chooseMessagesInConversation,
  chosenBeforeProposalOf,
  clinicAddressOf,
  clinicOrigin,
  clinicSearchFoundNothing,
  closeConversationWith,
  closurePendingReason,
  confirmAppointmentByContact,
  confirmProposalByContact,
  createBookingLink,
  createHandoff,
  createProposal,
  createTask,
  emergencyAdviceFor,
  findFreeGaps,
  formatAgentClinicData,
  formatClinicSearch,
  formatOrgMoney,
  formatZoned,
  GAPS_PER_PROFESSIONAL_PER_DAY,
  GENERAL_PERMISSION_QUESTION,
  generalPermissionWords,
  getAgentClinicData,
  getAgentConfig,
  getAgentPatientBudgets,
  getAgentPatientSummary,
  getClinicInfoSnapshot,
  getContact,
  getOpportunity,
  getOrgLocale,
  getProposal,
  issueAgendaLink,
  latestOpenTopic,
  listAgentContextCandidates,
  reportPatientNameMismatch,
  listContactChannelHistory,
  listContactNotes,
  listOpportunities,
  listPaymentMethods,
  listPricedSubjects,
  listTasks,
  newerInboundThan,
  noteLessonUse,
  operationAgentSchema,
  PERSONAL_LINK_TTL_DAYS,
  PRICES_PER_CONVERSATION,
  type ProductAgentTexts,
  personalLinkAddress,
  personalLinkRef,
  planBudgetAnswer,
  proposalConfirmButtons,
  proposalReplyOf,
  rankByMeaning,
  recordAgentAction,
  recordAnswerTrace,
  recordKnowledgeGap,
  recordTopicAskedAgain,
  requestPortalReentry,
  requireContact,
  resendBudgetByContact,
  resolveAgentPatientContext,
  resolveProfessionalRef,
  resumeConversationBySystem,
  ServiceError,
  saveWebchatContactForConversation,
  searchClinic,
  searchPublishedKnowledge,
  sendReceiptInConversation,
  topicKindOf,
  updateContact,
  composeDisplayName,
  nameWords,
  webchatHandoffWhere,
  webchatReplyRoutes,
} from "@odentia/services"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { formulasIn, nameQuestionsIn } from "./attention.js"
import { formatForChannel } from "./channel-format.js"
import { claimsOf } from "./claims.js"
import { choseThisSlot, understoodYes } from "./confirm-intent.js"
import type { DecisionModel } from "./decision/port.js"
import { type AgentRoute, budgetNotice, handoffFallbackNotice, URGENT_SCORE } from "./decision/route.js"
import { languageOf } from "./language.js"
import { tutea } from "./treatment.js"
import { describeUnsupported, type Evidence, pricedSubjectsOf, type ReplyVerdict, refusedPaymentMentions, timesIn, verifyReply } from "./verify.js"

/** Fuente de un dato del turno, con la clase que verá el equipo en «En qué se basó». */
export interface AgentEvidence extends Evidence {
  kind: string
}

/** Cómo ve el equipo cada herramienta de lectura cuando una respuesta se apoya en ella. */
/** El canal de la conversación, leído una vez por corrida. Una simulación se ve como WhatsApp, el canal principal. */
export async function conversationChannel(ctx: AgentToolCtx): Promise<string | null> {
  if (ctx.channel !== undefined) return ctx.channel
  if (ctx.dryRun) {
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
export const QUERY_EMBED_MS = 3_000

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
  // Escribe (confirma la cita), pero lo que devuelve es la cita tal como quedó:
  // con eso se comprueban la fecha y la hora que el agente le repite a la persona.
  confirmar_cita: { kind: "agenda", label: "Cita que confirmó la persona" },
  // Los importes de un presupuesto que el agente repite salen de lo que la persona recibió.
  ver_presupuesto: { kind: "persona", label: "Presupuestos que recibió la persona" },
  // Propone (no anota), pero devuelve la lista con lo que suma lo aceptado: es lo que se le pregunta.
  anotar_respuesta_presupuesto: { kind: "persona", label: "Respuesta al presupuesto por confirmar" },
}

/** Lo que hizo el agente en un turno, dicho para quien prueba (no para el modelo). */
export const TOOL_ACTION_LABEL: Record<string, string> = {
  reservar_paciente_nuevo: "Le dio a alguien nuevo su enlace con la hora que eligió, para que deje sus datos y reserve ahí.",
  ver_sedes_y_servicios: "Consultó sedes, servicios y precios.",
  buscar_en_la_clinica: "Buscó en los servicios, promociones y profesionales de la clínica.",
  consultar_conocimiento: "Buscó en las respuestas oficiales.",
  buscar_huecos: "Buscó huecos reales en la agenda.",
  ver_contexto_paciente: "Verificó para quién es la atención.",
  ver_resumen_paciente: "Consultó las citas y el estado de cuenta del paciente.",
  proponer_cita: "Propuso reservar una cita o, si a la clínica le faltaban datos del paciente, le dio su enlace con esa hora.",
  reprogramar_cita: "Propuso mover una cita.",
  cancelar_cita: "Propuso cancelar una cita.",
  confirmar_propuesta: "Ejecutó lo que el paciente confirmó.",
  confirmar_cita: "Confirmó la cita que la persona dijo que no se perderá.",
  responder_permiso_mensajes: "Anotó si acepta que le escriban novedades y promociones.",
  elegir_mensajes: "Anotó qué mensajes quiere recibir la persona, o le dio su página para elegirlos.",
  enviar_comprobante: "Envió en la conversación el comprobante de su último pago.",
  ver_presupuesto: "Consultó los presupuestos que la persona recibió.",
  reenviar_presupuesto: "Reenvió el presupuesto a la persona (o, si no estaba listo, dejó la tarea a recepción).",
  anotar_respuesta_presupuesto: "Propuso anotar la respuesta al presupuesto; se anota con el sí de la persona.",
  enviar_enlace_cita: "Envió su enlace para que la persona elija su cita.",
  pedir_volver_al_portal: "Dejó a recepción el pedido de volver a entrar al portal.",
  create_opportunity: "Propuso registrar una oportunidad.",
  update_followup: "Dejó la tarea de una oportunidad.",
  close_opportunity: "Propuso cerrar una oportunidad.",
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

/** El profesional no es una referencia de buscar_huecos: el agente nunca escribe ids de usuario. */
const UNKNOWN_PROFESSIONAL =
  "Ese profesional no es de un hueco de buscar_huecos: usa el dato «profesional» exacto (pro-…) del hueco elegido. Nunca inventes identificadores."

/**
 * Cómo se pide el sí de lo que espera al interlocutor, según el acto: lo que lee
 * el modelo lo repite, así que nada suena hecho antes del sí (auditoría del ADR 0104).
 */
const ASK_YES: Record<string, string> = {
  reservar_cita:
    "la cita aún no está reservada. En una sola pregunta, con el día, la hora, la sede y con quién, pregúntale con naturalidad si se la reservas (por ejemplo «¿Te reservo el jueves a las 10:00 en … con …?»); no digas que ya la reservaste, que la tienes ni que quedó lista",
  reprogramar_cita:
    "la cita sigue como estaba. En una sola pregunta, con el día y la hora nuevos, pregúntale con naturalidad si se la cambias (por ejemplo «¿Te la paso al viernes a las 10:00?»); no digas que ya la cambiaste",
  cancelar_cita:
    "la cita sigue en pie. Pregúntale con naturalidad si se la cancelas, con el día y la hora de esa cita; no digas que ya la cancelaste",
}

/** Lo que guarda lo que dijo la persona: con una de ellas en la corrida, «lo anoté» es cierto. */
const CLAIM_NOTES = ["anotar_caso", "recordar_dato", "update_contact", "guardar_contacto", "elegir_mensajes"]

/** Lo que hace la corrida con una cita o su enlace: con uno de estos, la respuesta habla de esa cita y no lleva la agenda. */
const APPOINTMENT_ACTS = ["proponer_cita", "reservar_paciente_nuevo", "reprogramar_cita", "cancelar_cita", "confirmar_propuesta", "confirmar_cita", "enviar_enlace_cita"]

/**
 * La línea de la agenda: neutra en el trato (sirve con tú y con usted), en el idioma de la
 * persona y, si reserva para otra persona, a nombre de quién queda la cita.
 */
function agendaPhrase(url: string, forName: string | null, language: "es" | "en" | null | undefined): string {
  if (language === "en") return `The full schedule, to choose the day, the time and who with${forName ? ` (the appointment is booked for ${forName})` : ""}: ${url}`
  return `La agenda completa, para elegir el día, la hora y con quién${forName ? ` (la cita queda a nombre de ${forName})` : ""}: ${url}`
}

/** La hora propuesta no salió de ningún hueco consultado: el modelo la inventó o la tomó de otra cosa (un horario de atención). */
const SLOT_NOT_OFFERED =
  "Ese horario no está entre los huecos que consultaste con ese profesional: no se propuso. Si la persona aceptó una hora que le ofreciste, usa los datos exactos de ese hueco; si no los tienes a la vista o pidió una hora que no estaba entre los repartidos, vuelve a consultar con buscar_huecos desde esa hora (esa sede y ese profesional) y propone el hueco de la hora que le dijiste."

/**
 * Si un hueco con ese inicio y ese profesional salió de buscar_huecos en este
 * turno o en lo que recuerda el caso (sus líneas llevan
 * «[startsAt … · sede … · <sala> … · profesional …]»). Sin evidencia del turno
 * (una herramienta llamada fuera del grafo) no hay con qué comparar.
 */
export function slotWasOffered(
  evidence: { text: string }[] | undefined,
  input: { startsAt: string; professionalUserId: string; roomId: string },
): boolean {
  if (!evidence) return true
  const wanted = Date.parse(input.startsAt)
  if (Number.isNaN(wanted)) return false
  const professional = input.professionalUserId.trim().toLowerCase()
  const slot = /\[startsAt (\S+) · sede \S+ · (.+?) · profesional ([^\]\s]+)\]/g
  return evidence.some((item) =>
    [...item.text.matchAll(slot)].some(
      ([, startsAt = "", room = "", ref = ""]) =>
        Date.parse(startsAt) === wanted && ref.toLowerCase() === professional && room.includes(input.roomId),
    ),
  )
}

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
  /** Las palabras del producto de la clínica (`productAgentTexts`); sin ellas, las de odentIA. */
  texts?: ProductAgentTexts
  conversationId: string
  contactId: string
  /** Evento durable que disparó el turno (mensaje o coordinación). */
  triggerId: string | null
  secretsKey: Buffer
  /** La herramienta de handoff lo marca; el grafo termina el turno. */
  handedOff: boolean
  /**
   * El modelo pasó un tema al equipo sin escribirle nada a la persona: le toca
   * responder a él (quién lo verá y lo demás que preguntó) antes del aviso fijo.
   */
  handoffNeedsReply?: boolean
  /** La derivación registrada en esta corrida, para completarla con el aviso que recibió la persona. */
  handoffId?: string
  /** Simulación: las herramientas no escriben nada, solo describen. */
  dryRun: boolean
  /** Mensaje hipotético solo para simulación (no se persiste). */
  draftText?: string
  /** Probar cómo respondería con una lección aún sin aprobar, o sin una activa. */
  lessonOverrides?: LessonOverrides
  /** Conversación de prueba (ADR 0094): todo es real, pero no cuenta como uso de lo que aprendió. */
  testConversation?: boolean
  /** Camino que eligió el modelo de decisión para este turno; ausente = camino abierto. */
  route?: AgentRoute | null
  /** Lo que escribió trae una señal de alarma (`hasAlarmSignal`, ADR 0084): el aviso empieza por el número de emergencias. */
  alarm?: boolean
  /**
   * Lo que el sistema ya sabe del turno sin preguntarle a un modelo: la persona
   * tocó un botón de un mensaje automático. Va con lo del turno, tras el camino.
   */
  routeHint?: string
  /** Volvió a preguntar por un tema abierto y este pasó a urgente: se le puede decir. */
  topicRaised?: boolean
  /** Volvió sobre un tema que ya tiene el equipo: el aviso de entonces ya le llegó (ADR 0104). */
  topicAgain?: boolean
  /** El idioma en que escribe la persona, si se distingue (`languageOf`). */
  personLanguage?: "es" | "en" | null
  /** Ya se le pidió una vez en esta corrida que responda en el idioma de la persona. */
  languageNudged?: boolean
  /** Quien escribe trata de usted, si se distingue (`treatmentOf`). */
  personTreatment?: "usted" | null
  /** Ya se le pidió una vez en esta corrida que trate de usted a quien escribe así. */
  treatmentNudged?: boolean
  /** Ya se le pidió una vez en esta corrida que no pregunte su nombre dos veces en un mensaje. */
  nameNudged?: boolean
  /** Cuántas respuestas de esta atención ya usaron «Entiendo…» o «anoté que…» (`formulasIn`). */
  formulas?: { opener: number; noted: number }
  /** Las horas de los enlaces con la hora elegida que ya le dio en esta atención (`attentionProgress`). */
  pickLinks?: string[]
  /** Ya se le pidió una vez en esta corrida que no repita esas fórmulas. */
  formulaNudged?: boolean
  /** Lo que consta del caso al empezar la corrida: temas con el equipo y notas (`claimsOf`). */
  caseOnFile?: { topics: number; notes: number }
  /** Ya se le pidió una vez en esta corrida que no diga hecho lo que no hizo. */
  claimNudged?: boolean
  /**
   * En el chat web consta dónde avisarle (`claimsOf`): lo guardó guardar_contacto en esta
   * corrida, ya había por dónde (`webchatReplyRoutes`) o la clínica ya la conoce.
   */
  contactOnFile?: boolean
  /** Ya se le pidió una vez en esta corrida que no diga que tiene dónde avisarle sin tenerlo. */
  contactNudged?: boolean
  /** Las herramientas que el modelo tiene a la vista en este paso: las del camino o todas (`graph.ts`). */
  offeredTools?: ReadonlySet<string>
  /**
   * Con el caso ya en el equipo, se le pidió reescribir lo que iba a salir: el turno vuelve
   * al modelo una vez en vez de terminar con el aviso fijo (`routeAfterTools`).
   */
  rewriteAsked?: boolean
  /**
   * Dónde buscó huecos en esta corrida (si encontró): la agenda que acompaña a los horarios abre
   * en esa sede y ese servicio, o en todas si buscó en más de una.
   */
  gapsSought?: { branchId: string | null; serviceId: string | null }
  /**
   * Dirección pública de la plataforma, para armar enlaces que la persona abre
   * (reservar su cita). Sin ella el agente no tiene la herramienta del enlace.
   */
  publicUrl?: PublicLinkConfig
  /**
   * Quien vectoriza para buscar por significado. Sin él, la búsqueda es solo por
   * palabras. Solo ordena: los datos se leen de la base al responder.
   */
  embedder?: SearchEmbedder
  /**
   * Almacén de adjuntos: el presupuesto que se reenvía lleva su PDF. Sin él,
   * reenviarlo deja la tarea a recepción en vez de enviarlo.
   */
  storage?: Storage
  /**
   * Propuesta de esta corrida que espera el sí de la persona a una lista (su
   * respuesta a un presupuesto): la pregunta sale con los botones «Sí» y «No».
   */
  confirmButtonsFor?: string
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
  /**
   * Pasaron 24 horas y el sistema no pudo retomar la conversación: el caso ya
   * está con una persona y no hay por dónde avisar (`noticeAfterHandoff` no lo intenta).
   */
  windowClosed?: boolean
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
    /** Entrada escrita en la caché del proveedor (se cobra aparte). */
    cacheWriteTokens: number
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
  /** Proveedor del modelo que escribe: con `fake` no se anota uso. */
  modelProvider?: string
  /** Lo último que escribió el interlocutor: la pregunta que queda anotada si falta conocimiento. */
  lastInboundText?: string
  /**
   * Modelo de decisión de la organización, si tiene uno: elige qué respuestas
   * oficiales viajan completas en el turno y entiende si la persona dijo que sí
   * a una propuesta (`confirm-intent.ts`). Nunca decide un acto.
   */
  decision?: DecisionModel | null
  /** Trato de la clínica, para el aviso fijo al derivar; si falta se lee de la configuración. */
  treatment?: "tu" | "usted" | null
  /** El agente se despidió y cerró la conversación en esta corrida. */
  closed?: boolean
  /**
   * Mientras el modelo escribía, el equipo tomó o cerró la conversación: lo
   * redactado no sale y la corrida termina sin respuesta del agente.
   */
  takenOver?: boolean
  /**
   * La persona siguió escribiendo mientras se preparaba la respuesta: no sale
   * y la corrida de su último mensaje responde todo junto (ADR 0097).
   */
  superseded?: boolean
  /** En una prueba, los servicios cuyo precio ya dijo el agente (no hay traza que leer). */
  pricedSubjects?: string[]
}

/**
 * Tema para el equipo (ADR 0050): registro estructurado (resumen, motivo,
 * prioridad, tarea y el mensaje que lo originó). No apaga al agente: el tema
 * queda en «Por atender» y el agente sigue con lo demás. Misma vía para
 * palabra clave, herramienta y maxTurns.
 */
export async function performHandoff(
  ctx: AgentToolCtx,
  reason: string,
  summary?: string,
  priority: "alta" | "media" | "baja" = "media",
  clinical = false,
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
      sourceMessageId: ctx.triggerId,
      clinical,
    })
    ctx.handoffId = handoff.id
  })
  ctx.handedOff = true
}

/**
 * Derivar siempre avisa (ADR 0024): si el caso pasó a una persona y la persona
 * aún no recibió nada en esta corrida, sale el aviso fijo, sin modelo, por el
 * mismo camino que cualquier respuesta. Si el canal no deja escribir, queda
 * dicho en la derivación para quien la tome. `presupuesto`: la clínica llegó a
 * su presupuesto del mes y el aviso es el de la D4 (ADR 0085).
 */
export async function noticeAfterHandoff(ctx: AgentToolCtx, kind: "caso" | "presupuesto" = "caso"): Promise<void> {
  if (!ctx.handedOff || ctx.replySettled || ctx.dryRun || ctx.windowClosed) return
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
      message: await (async () => {
        const channel = await conversationChannel(ctx)
        if (kind === "presupuesto" && channel !== "webchat") {
          const clinic = await withOrgContext(ctx.db, ctx.orgId, async (tx) => (await getClinicInfoSnapshot(tx, ctx.orgId)).clinicName).catch(() => null)
          return budgetNotice(clinic || "la clínica", treatment ?? null)
        }
        const where =
          channel === "webchat"
            ? await withOrgContext(ctx.db, ctx.orgId, (tx) => webchatHandoffWhere(tx, ctx.orgId, ctx.conversationId)).catch(() => "preguntar" as const)
            : undefined
        // Una señal de alarma empieza por el número de emergencias; una urgencia
        // sin alarma, por el teléfono para urgencias de la clínica (ADR 0084).
        const level = ctx.alarm === true ? "alarma" : (ctx.route?.urgency ?? 0) >= URGENT_SCORE ? "urgente" : null
        const emergency = level
          ? await withOrgContext(ctx.db, ctx.orgId, (tx) => emergencyAdviceFor(tx, ctx.orgId, treatment ?? null, level)).catch(() => null)
          : null
        return handoffFallbackNotice(treatment ?? null, channel, where, emergency)
      })(),
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
 * Un identificador con forma de UUID que sale siempre igual de la misma clave:
 * la clave de un envío (`requestId`) es un UUID y reentregar el mensaje no
 * debe enviarlo dos veces.
 */
function stableUuid(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex")
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const BUDGET_LINE_DECISION: Record<string, string> = {
  pendiente: "sin responder",
  aceptado: "aceptado",
  pospuesto: "lo dejó para después",
  rechazado: "no lo aceptó",
  no_elegida: "no elegida",
}

/**
 * Lo que ve el agente de los presupuestos, como el documento de la persona:
 * tratamiento, pieza y precio de cada línea, total por opción y lo ya
 * respondido. Los ids van entre corchetes, para las herramientas.
 */
function formatAgentBudgets(found: AgentPatientBudgets, zone: Pick<OrgLocale, "locale">): string {
  const lines = [
    `Presupuestos de ${found.context.displayName} (vínculo ${found.context.relationship}), como los recibe la persona. Lo que va entre corchetes es solo para las herramientas: no lo escribas.`,
  ]
  if (!found.budgets.length) lines.push("No tiene presupuestos entregados.")
  for (const budget of found.budgets) {
    const money = (cents: number | null) => (cents == null ? "precio por definir" : formatOrgMoney(cents, budget.currency, zone))
    lines.push(
      `- Presupuesto ${budgetNumberText(budget.budgetNumber)}: ${budget.stateText}.${budget.answerable ? " Puede responderlo." : ""} [budgetId ${budget.budgetId}]`,
    )
    const several = budget.options.length > 1
    for (const option of budget.options) {
      const head = several
        ? `  ${option.label}${option.isRecommended ? " (recomendada)" : ""}${option.decision === "elegida" ? " (la eligió)" : option.decision === "no_elegida" ? " (no elegida)" : ""}: total ${money(option.totalCents)} [optionId ${option.id}]`
        : `  Total ${money(option.totalCents)}`
      lines.push(head)
      for (const line of option.lines) {
        const price = line.sessions
          ? `${money(line.lineTotalCents)}, ${line.sessions.count} sesiones de ${money(line.sessions.unitCents)}`
          : money(line.lineTotalCents)
        const promotion = line.promotionName ? `, con la promoción «${line.promotionName}»` : ""
        lines.push(
          `    · ${budgetLineWords(line)}: ${price}${promotion} — ${BUDGET_LINE_DECISION[line.decision] ?? line.decision} [planItemId ${line.planItemId}]`,
        )
      }
    }
  }
  if (found.olderBudgets > 0) {
    lines.push(
      `Y ${found.olderBudgets} ${found.olderBudgets === 1 ? "presupuesto anterior" : "presupuestos anteriores"} que no van aquí: si la persona habla de uno de ellos, no digas que no existe; pasa el caso a una persona.`,
    )
  }
  if (found.inPreparation) lines.push("Hay otro presupuesto que la clínica aún prepara: todavía no está listo y no se dice qué lleva.")
  return lines.join("\n")
}

/**
 * Tools del agente. NUNCA SQL ni fetch arbitrario: solo servicios dentro
 * del contexto RLS de la org (invariante). En simulación (dryRun) las
 * mutaciones devuelven vista previa sin escribir, salvo `update_contact`, que
 * corre la operación real en una transacción que se deshace.
 */
/**
 * Las palabras del producto de la corrida. Sin ellas, las de odentIA: las
 * clínicas de hoy son dentales (`orgProduct`).
 */
export function agentTexts(ctx: Pick<AgentToolCtx, "texts">): ProductAgentTexts {
  return ctx.texts ?? agentTextsFor("dental")
}

/** El recurso que se reserva con la sede y el profesional (odentIA: «unidad dental»). */
export const roomWord = (texts: ProductAgentTexts): string => texts.room || "sala"

export function makeAgentTools(ctx: AgentToolCtx) {
  const texts = agentTexts(ctx)
  const room = roomWord(texts)
  const inOrg = <T>(fn: (tx: Db) => Promise<T>): Promise<T> => withOrgContext(ctx.db, ctx.orgId, fn)

  // Configuración regional de la org, resuelta una vez por corrida: toda
  // fecha comunicada usa la zona de la sede de la cita o la de la org.
  let zonePromise: Promise<OrgLocale> | null = null
  const orgZone = (): Promise<OrgLocale> => (zonePromise ??= inOrg((tx) => getOrgLocale(tx, ctx.orgId)))

  /**
   * Ventana de WhatsApp cerrada (llega como `fallida` con `WINDOW_CLOSED`, el
   * pacto con ProposalLifecycle). El agente no elige plantillas (ADR 0040): el
   * sistema envía «Retomar la conversación» con los datos que ya conoce y el
   * turno termina. Si «Retomar» no está aprobada (o no se puede enviar), no
   * sale nada y el caso queda para una persona en «Te espera» con qué hacer.
   */
  const outsideWindow = async (): Promise<string> => {
    if (ctx.dryRun) {
      ctx.replySettled = true
      return "[SIMULACIÓN] Pasaron 24 horas: el sistema enviaría «Retomar la conversación» y aquí terminaría la respuesta."
    }
    const outcome = await inOrg((tx) => resumeConversationBySystem(tx, ctx.orgId, ctx.secretsKey, ctx.conversationId))
    if (outcome.sent) {
      ctx.replySettled = true
      return "Pasaron 24 horas desde su último mensaje: el sistema le envió «Retomar la conversación». Cuando responda, sigues. No envíes más mensajes."
    }
    await performHandoff(ctx, outcome.waiting, outcome.waiting)
    ctx.windowClosed = true
    return `No se le puede escribir: ${outcome.waiting} El caso pasó a una persona; no envíes más mensajes.`
  }
  /**
   * Justo antes de enviar: si el equipo tomó o cerró la conversación mientras
   * el modelo redactaba, no sale nada y el turno termina (`takenOver`). Con
   * una derivación de esta misma corrida el agente ya se apagó a sí mismo.
   */
  const personKeptWriting = async (): Promise<string | null> => {
    if (ctx.dryRun || !ctx.triggerId) return null
    const triggerId = ctx.triggerId
    if (!(await inOrg((tx) => newerInboundThan(tx, ctx.orgId, ctx.conversationId, triggerId)).catch(() => false))) return null
    ctx.superseded = true
    ctx.replySettled = true
    return "La persona siguió escribiendo mientras preparabas esto: no envíes nada. La respuesta saldrá con todo lo que escribió."
  }
  const teamTookOver = async (): Promise<string | null> => {
    if (ctx.dryRun || ctx.handedOff) return null
    const reason = await inOrg((tx) => agentReplyBlockedReason(tx, ctx.orgId, ctx.conversationId))
    if (!reason) return null
    ctx.takenOver = true
    ctx.replySettled = true
    return reason
  }
  /**
   * Crea la propuesta comercial con clave estable por trigger + herramienta
   * + payload. En modo directo se ejecuta en el mismo acto; si exige la
   * confirmación del interlocutor, queda pendiente con su recorrido real. Los
   * errores de dominio en ejecución llegan como `fallida` con código estable
   * en `result.errorCode` y motivo prefijado en `error` (HTTP 200): se
   * reportan al modelo, nunca como aprobación. Si el hilo ya espera un «sí»
   * (PROPOSAL_PENDING_CONFIRM), se guía al modelo a pedir la confirmación.
   */
  /**
   * Deja en el hilo lo que hizo sin propuesta, para que el equipo lo vea. Es solo
   * un registro: si falla, la corrida sigue igual y el modelo nunca lo lee.
   */
  const noteAction = async (kind: string, title: string, detail?: string): Promise<void> => {
    if (ctx.dryRun) return
    await inOrg((tx) =>
      recordAgentAction(tx, ctx.orgId, { conversationId: ctx.conversationId, triggerMessageId: ctx.triggerId, kind, title, detail }),
    ).catch(() => undefined)
  }

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
            // Un mensaje es uno por disparador y herramienta, diga lo que diga:
            // si la corrida se reintenta, el modelo redacta otro texto y, con
            // el texto en la clave, la persona recibía dos respuestas. Un envío
            // fallido no bloquea el siguiente (`createProposal` le da otra clave).
            payload: action === "enviar_mensaje" && ctx.triggerId ? { message: "reply" } : payload,
          }),
          secretsKey: ctx.secretsKey,
        }),
      )
      onProposal?.(proposal)
    } catch (e) {
      if (e instanceof ServiceError && e.code === "PROPOSAL_PENDING_CONFIRM") {
        return "Ya hay una cita esperando su sí en esta conversación: pregúntale con naturalidad si se la reservas (sin pedirle una frase exacta ni hablar de propuestas) y con su sí usa confirmar_propuesta; no crees otra."
      }
      throw e
    }
    // Un mensaje enviado o a la espera de decisión cierra el turno; si falló
    // o expiró, el modelo aún debe reproponer o derivar (fuera de las 24 horas
    // retoma el sistema: `outsideWindow`).
    if (action === "enviar_mensaje" && proposal.status !== "fallida" && proposal.status !== "expirada") {
      ctx.replySettled = true
    }
    if (proposal.status === "ejecutada") return `Ejecutado en modo directo (id ${proposal.id}).`
    if (proposal.status === "fallida") {
      const rawError = proposal.error?.trim() ?? ""
      if (rawError.startsWith("WINDOW_CLOSED") || proposal.result?.errorCode === "WINDOW_CLOSED") {
        return outsideWindow()
      }
      const detail = rawError ? `: ${rawError.slice(0, 300)}` : "."
      return `No se pudo ejecutar en modo directo (id ${proposal.id})${detail} Ofrece una alternativa o deriva a humano.`
    }
    if (proposal.status === "expirada") {
      return `La propuesta ${proposal.id} expiró (48h): vuelve a proponer el acto con datos vigentes, no la confirmes.`
    }
    // «Cita lista para su sí» salía como «dejo lista la cita… ¿Te la reservo?», y mover o
    // cancelar también se preguntaba con «¿Te la reservo?» (auditoría del ADR 0104).
    return `Falta su sí (id ${proposal.id}): ${ASK_YES[action] ?? "todavía no se hizo nada. Pregúntale con naturalidad si lo hace"}, sin pedirle una frase exacta ni hablar de propuestas. Con su sí, usa confirmar_propuesta.`
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
    const messageId = proposal?.result?.messageId
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

  // Las herramientas de este turno: lo que se le aconseja consultar sale de aquí, nunca de una lista fija.
  let toolNames: ReadonlySet<string> = new Set()
  const lookupsToTry = (): string => {
    const names = ["buscar_en_la_clinica", "ver_sedes_y_servicios", "consultar_conocimiento", "buscar_huecos", "ver_resumen_paciente", "ver_presupuesto"].filter(
      (name) => toolNames.has(name),
    )
    return names.length ? `Consulta la herramienta que corresponda (${names.join(", ")}) o quita ese dato` : "Quita ese dato"
  }

  /**
   * «Hasta tres precios por conversación» (decisión 4 de la fase 4): cuenta
   * los servicios cuyo precio ya dijo en esta atención (de su traza) y no deja
   * salir uno nuevo pasado el tope. Repetir uno ya dicho sí sale.
   */
  const priceCap = async (verdict: ReplyVerdict): Promise<string | null> => {
    const now = pricedSubjectsOf(verdict)
    if (!now.length) return null
    const before = ctx.dryRun
      ? (ctx.pricedSubjects ?? [])
      : await inOrg((tx) => listPricedSubjects(tx, ctx.orgId, ctx.conversationId)).catch(() => [] as string[])
    const fresh = now.filter((subject) => !before.includes(subject))
    if (!fresh.length || before.length + fresh.length <= PRICES_PER_CONVERSATION) {
      if (ctx.dryRun) ctx.pricedSubjects = [...before, ...fresh]
      return null
    }
    const left = Math.max(0, PRICES_PER_CONVERSATION - before.length)
    return left === 0
      ? `No enviado: en esta conversación ya diste el precio de ${PRICES_PER_CONVERSATION} servicios. No mandas el tarifario: no des el precio de otro servicio por aquí; ofrécele ${texts.visit.offer}, y vuelve a enviar la respuesta sola en su paso, sin ese precio.`
      : `No enviado: en esta conversación solo puedes dar el precio de ${left} ${left === 1 ? "servicio más" : "servicios más"} (no mandas el tarifario). Responde el que más le interese y, para el resto, ofrécele ${texts.visit.word.replace(/^la /, "una ")}; vuelve a enviar la respuesta sola en su paso.`
  }

  /**
   * Comprueba la respuesta antes de enviarla. Si trae un precio, fecha u hora
   * que no figura en lo consultado, no sale: el modelo recibe qué dato falta
   * y puede consultarlo o quitarlo; a la segunda vez el caso pasa a una persona. Pasado el tope de
   * precios por conversación tampoco sale (`priceCap`).
   */
  /**
   * La persona escribe en inglés y lo que iba a salir está en español: una vez
   * por corrida se le pide traducirlo (auditoría del ADR 0104). Vale para la
   * respuesta, la despedida y el aviso de un pase.
   */
  const wrongLanguage = (text: string): string | null => {
    if (ctx.personLanguage !== "en" || ctx.languageNudged || languageOf(text) !== "es") return null
    ctx.languageNudged = true
    return `${ctx.dryRun ? "[SIMULACIÓN] " : ""}No enviado: la persona te escribe en inglés y tu mensaje está en español. Escríbelo en inglés, traduciendo también lo que te dieron las herramientas, y vuelve a llamar a la misma herramienta sola en su paso.`
  }

  /**
   * Quien escribe trata de usted y lo que iba a salir la tutea, casi siempre en una
   * frase copiada de una herramienta (auditoría del ADR 0104). Una vez por corrida.
   */
  const wrongTreatment = (text: string): string | null => {
    if (ctx.personTreatment !== "usted" || ctx.personLanguage === "en" || ctx.treatmentNudged || !tutea(text)) return null
    ctx.treatmentNudged = true
    return `${ctx.dryRun ? "[SIMULACIÓN] " : ""}No enviado: la persona te trata de usted y tu mensaje la tutea. Escríbelo de usted, también las frases que te dieron las herramientas (por ejemplo «Al confirmar, acepta nuestro aviso…» o «complete sus datos»), y vuelve a llamar a la misma herramienta sola en su paso.`
  }

  /** Vuelve a la fórmula de antes, «Entiendo…» o «anoté que…» (auditoría del ADR 0104). Una vez por corrida. */
  const formulaAgain = (text: string): string | null => {
    if (ctx.formulaNudged || !ctx.formulas) return null
    const now = formulasIn(text)
    if (!(now.opener && ctx.formulas.opener > 0) && !(now.noted && ctx.formulas.noted > 0)) return null
    ctx.formulaNudged = true
    return `${ctx.dryRun ? "[SIMULACIÓN] " : ""}No enviado: en esta atención ya le respondiste con «Entiendo…» o «anoté que…». Respóndele directo a lo que dijo o preguntó, sin repetírselo; si no hay nada nuevo, una frase corta basta. Vuelve a llamar a la misma herramienta sola en su paso.`
  }

  /** El origen de la clínica en el dominio de su producto (odentIA o latidIA; decisión 9 del issue 229); nulo sin dirección. */
  const clinicLinkOrigin = async (tx: Db, publicUrl: PublicLinkConfig): Promise<string | null> => {
    const clinic = await clinicAddressOf(tx, ctx.orgId)
    return clinic ? clinicOrigin(clinic.slug, clinic.product, publicUrl) : null
  }

  /**
   * Lo que acompaña siempre a los horarios que ofrece (lo pidió una clínica, igual en odentIA y
   * en latidIA): su enlace para ver toda la agenda y elegir el día, la hora y con quién. Lo agrega
   * el código al enviar, no el modelo: así va cada vez y sin otra llamada, `buscar_huecos` solo
   * lee y el token no pasa por el modelo ni queda guardado (el mensaje lleva la referencia y el
   * worker pone el token al entregarlo, ADR 0037). Es una oferta la respuesta con dos o más horas
   * después de buscar huecos en la corrida. No va con la cita que se propone, mueve o confirma en
   * la corrida, con otra esperando su sí, al cambiar una cita ni a quien ya tiene una por venir
   * (`issueAgendaLink`: la página le mostraría esa cita).
   */
  const withAgenda = async (text: string): Promise<string> => {
    const sought = ctx.gapsSought
    const publicUrl = ctx.publicUrl
    if (!sought || !publicUrl || ctx.dryRun || ctx.casePending || ctx.route?.path === "cambio_cita") return text
    // Ya lleva su enlace (el de reserva, o el que trae la hora elegida: `/reserva?sede=…&token=…`): no va otro.
    if (APPOINTMENT_ACTS.some((name) => ctx.toolsUsed.includes(name)) || text.includes("/reserva?") || timesIn(text) < 2) return text
    try {
      const line = await inOrg(async (tx) => {
        const origin = await clinicLinkOrigin(tx, publicUrl)
        if (!origin) return null
        const link = await issueAgendaLink(
          tx,
          ctx.orgId,
          { conversationId: ctx.conversationId, ...(sought.branchId ? { branchId: sought.branchId } : {}), ...(sought.serviceId ? { serviceId: sought.serviceId } : {}) },
          { secretsKey: ctx.secretsKey },
        )
        return link ? agendaPhrase(personalLinkAddress(origin, personalLinkRef(link.linkId)), link.forName, ctx.personLanguage) : null
      })
      return line ? `${text}\n\n${line}` : text
    } catch {
      // La agenda acompaña: si no se puede emitir (una prueba, varios pacientes, sin registro en línea), los horarios salen igual.
      return text
    }
  }

  /** Le pregunta su nombre dos veces en el mismo mensaje (auditoría del ADR 0104). Una vez por corrida. */
  const nameTwice = (text: string): string | null => {
    if (ctx.nameNudged || nameQuestionsIn(text) < 2) return null
    ctx.nameNudged = true
    return `${ctx.dryRun ? "[SIMULACIÓN] " : ""}No enviado: le preguntas su nombre dos veces en el mismo mensaje. Deja una sola pregunta (si le pides sus nombres y apellidos para registrarla, esa es la pregunta) y vuelve a enviar la respuesta sola en su paso.`
  }

  /**
   * Dice que el equipo lo verá o que lo anotó, y no consta (auditoría del ADR 0104):
   * «recepción lo revisará» sin ningún pase, «ya lo anoté» sin ninguna nota. Una vez
   * por corrida, como el idioma: lo que hizo en este mismo paso cuenta (`toolsUsed`).
   */
  const unbackedClaim = (text: string): string | null => {
    if (ctx.claimNudged) return null
    const claims = claimsOf(text)
    if (!claims.team && !claims.note) return null
    const used = new Set(ctx.toolsUsed)
    const passed = ctx.handedOff || used.has("request_human_handoff") || used.has("recordar_tema") || (ctx.caseOnFile?.topics ?? 0) > 0
    const noted = passed || (ctx.caseOnFile?.notes ?? 0) > 0 || CLAIM_NOTES.some((name) => used.has(name))
    const prefix = ctx.dryRun ? "[SIMULACIÓN] " : ""
    if (claims.team && !passed) {
      ctx.claimNudged = true
      return `${prefix}No enviado: dices que el equipo lo verá o que se lo pasaste, y en esta conversación no hay ningún pase. Si hace falta que lo vea alguien del equipo, pásalo con request_human_handoff y pon el aviso en message; si no, no lo digas y respóndele tú. Después vuelve a enviar la respuesta sola en su paso.`
    }
    if (claims.note && !noted) {
      ctx.claimNudged = true
      return `${prefix}No enviado: dices que lo anotaste y no anotaste nada. Si lo que te dijo hará falta después, anótalo con anotar_caso en el mismo paso que tu respuesta; si no, no digas que lo anotaste.`
    }
    return null
  }

  /**
   * Lo que se pide reescribir antes de enviar. Con el caso ya en el equipo el turno terminaría
   * con el aviso fijo y se perdería lo que el modelo iba a decir: vuelve a él (`routeAfterTools`).
   */
  const askRewrite = (mismatch: string): string => {
    if (ctx.handedOff) ctx.rewriteAsked = true
    return mismatch
  }

  /**
   * En el chat web dice que guardó su WhatsApp o su correo, o que el equipo ya lo
   * tiene, y no hay por dónde avisarle (caso 17 de latidIA, 29-oct): ni lo guardó
   * en esta corrida (`guardar_contacto`) ni lo tenía de antes (`webchatReplyRoutes`).
   * Vale para la respuesta, la despedida y el aviso de un pase; una vez por corrida.
   */
  const unsavedContact = async (text: string): Promise<string | null> => {
    // En una simulación el canal es WhatsApp (`conversationChannel`): nunca llega más abajo.
    if (ctx.contactNudged || ctx.contactOnFile || !claimsOf(text).contact) return null
    if ((await conversationChannel(ctx)) !== "webchat") return null
    const routes = await inOrg((tx) => webchatReplyRoutes(tx, ctx.orgId, ctx.contactId)).catch(() => null)
    if (!routes) return null
    // Un número de otra persona (`othersPhone`) cuenta como dejado: lo decide el equipo, y
    // decirle al visitante que no sirve le revelaría quién es de la clínica.
    if (routes.whatsapp || routes.correo || routes.othersPhone) {
      ctx.contactOnFile = true
      return null
    }
    ctx.contactNudged = true
    // Solo se nombra guardar_contacto si el turno la tiene a la vista (ADR 0038): «derivar» no la trae.
    const save = (ctx.offeredTools ?? toolNames).has("guardar_contacto")
      ? "Si te lo escribió, guárdalo antes con guardar_contacto; si guardar_contacto no lo aceptó, díselo con sus palabras y pídele otro; si no te lo dio, no digas que lo tienes."
      : "No digas que lo tienes ni que se guardó; si hace falta para avisarle, pídeselo."
    return `No enviado: dices que guardaste su WhatsApp o su correo, o que el equipo ya lo tiene, y aún no hay por dónde avisarle. ${save} Después vuelve a llamar a la misma herramienta sola en su paso.`
  }

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
    if (verdict.ok) {
      const capped = await priceCap(verdict)
      if (!capped) return { verdict, blocked: null }
      await traceAnswer(text, "bloqueada", verdict.checks, null)
      return { verdict, blocked: `${ctx.dryRun ? "[SIMULACIÓN] " : ""}${capped}` }
    }
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
      blocked: `${prefix}No enviado: ${missing} no figura en lo que consultaste ni en este contexto. ${lookupsToTry()}, y vuelve a enviar la respuesta sola en su paso.`,
    }
  }

  const sendReply = tool(
    async ({ text: written }: { text: string }) => {
      // Las marcas de formato se ajustan al canal antes de comprobar y enviar.
      const text = formatForChannel(written, await conversationChannel(ctx), { emojis: ctx.emojis })
      const mismatch =
        wrongLanguage(text) ?? wrongTreatment(text) ?? unbackedClaim(text) ?? (await unsavedContact(text)) ?? nameTwice(text) ?? formulaAgain(text)
      if (mismatch) return askRewrite(mismatch)
      const { verdict, blocked } = await checkReply(text)
      if (blocked) return blocked
      if (ctx.dryRun) {
        ctx.replySettled = true
        ctx.simulatedReply = text
        return `[SIMULACIÓN] Se enviaría al interlocutor: ${text}`
      }
      // WINDOW_CLOSED ya no lanza: llega como `fallida` y propose retoma la
      // conversación con el sistema. Lo que sí lanza (infra 429/5xx incluida)
      // no reintenta la corrida: ToolNode lo devuelve al modelo como mensaje.
      const takenOver = await teamTookOver()
      if (takenOver) return takenOver
      const kept = await personKeptWriting()
      if (kept) return kept
      // Con horarios, su enlace para ver toda la agenda; se emite solo ahora, cuando sale.
      const out = await withAgenda(text)
      const sent: ProposalItem[] = []
      // La pregunta que confirma una lista (la respuesta a un presupuesto) lleva «Sí» y «No».
      const buttons = ctx.confirmButtonsFor ? { buttons: proposalConfirmButtons(ctx.confirmButtonsFor) } : {}
      const outcome = await propose("enviar_mensaje", { kind: "text", text: out, ...buttons }, "send_reply", undefined, (proposal) => {
        sent.push(proposal)
      })
      for (const proposal of sent) await traceAnswer(out, traceOutcome(proposal), verdict?.checks ?? [], proposal)
      return outcome
    },
    {
      name: "send_reply",
      description:
        "Envía la respuesta completa al interlocutor y termina con este mensaje: úsala al final, después de cualquier otra acción; en su mismo paso solo pueden ir anotar_caso, recordar_dato y update_contact. Si pasaron 24 horas desde su último mensaje, el sistema retoma la conversación por ti y te lo dice.",
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
      const pending = ctx.dryRun ? null : await inOrg((tx) => closurePendingReason(tx, ctx.orgId, ctx.conversationId))
      if (pending) return `No cerrado. ${pending}`
      const text = formatForChannel(written, await conversationChannel(ctx), { emojis: ctx.emojis })
      const mismatch = wrongLanguage(text) ?? wrongTreatment(text) ?? (await unsavedContact(text))
      if (mismatch) return askRewrite(mismatch)
      const { verdict, blocked } = await checkReply(text)
      if (blocked) return blocked
      if (ctx.dryRun) {
        ctx.replySettled = true
        ctx.closed = true
        ctx.simulatedReply = text
        return `[SIMULACIÓN] Se enviaría la despedida y se cerraría la conversación: ${text}`
      }
      const takenOver = await teamTookOver()
      if (takenOver) return takenOver
      const kept = await personKeptWriting()
      if (kept) return kept
      const sent: ProposalItem[] = []
      const outcome = await propose("enviar_mensaje", { kind: "text", text }, "despedirse_y_cerrar", undefined, (proposal) => {
        sent.push(proposal)
      })
      for (const proposal of sent) await traceAnswer(text, traceOutcome(proposal), verdict?.checks ?? [], proposal)
      if (!sent.some((proposal) => proposal.status === "ejecutada")) return outcome
      // Si escribió algo mientras salía la despedida, no se cierra: su corrida le responde.
      const closed = await inOrg((tx) =>
        closeConversationWith(tx, ctx.orgId, ctx.conversationId, { reason: "resuelta", byUserId: null, unlessInboundAfter: ctx.triggerId ?? undefined }),
      )
      if (!closed) return "Despedida enviada; la conversación sigue abierta porque la persona escribió algo nuevo y eso se responde aparte. No envíes más mensajes."
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
      await noteAction("etiquetas", tags.length === 1 ? `agregó la etiqueta «${tags[0]}»` : `agregó las etiquetas ${tags.map((tag) => `«${tag}»`).join(", ")}`)
      return `Etiquetas: ${merged.join(", ")}.`
    },
    {
      name: "add_tags",
      description: `Agrega etiquetas al contacto${texts.tagExample ? ` (p.ej. ${texts.tagExample})` : ""}.`,
      schema: z.object({ tags: z.array(z.string().min(1).max(40)).min(1).max(10) }),
    },
  )

  const updateContactTool = tool(
    async ({
      displayName,
      givenNames,
      familyName,
    }: {
      displayName?: string
      givenNames?: string
      familyName?: string
    }) => {
      const contactId = ctx.contactId
      const given = givenNames?.trim()
      const family = familyName?.trim()
      const display = displayName?.trim()
      if (!given && !family && !display) return "No se guardó nada: no venía un nombre."
      const said = composeDisplayName({ givenNames: given, familyName: family }) || display || ""
      // Se guarda lo que dijo: «Soy Carla» ya es saber con quién habla, y lo demás lo completa al registrarse (ADR 0129).
      // El nombre visible lo arma la base con sus nombres y apellidos; el suelto vale solo si no viene ninguno.
      const names = {
        ...(given ? { givenNames: given } : {}),
        ...(family ? { familyName: family } : {}),
        ...(display && !given && !family ? { displayName: display } : {}),
      }
      // La simulación corre la operación real y la deshace: así dice lo que de verdad pasaría, sin copiar sus reglas.
      const undone = Symbol("simulación")
      let outcome!: Awaited<ReturnType<typeof reportPatientNameMismatch>>
      let shown = ""
      await inOrg(async (tx) => {
        // El nombre de un paciente lo cambia el equipo en su ficha; aquí, solo el de quien aún no lo es.
        // Si dijo otro, su ficha no cambia y recepción la revisa (ADR 0116).
        outcome = await reportPatientNameMismatch(tx, ctx.orgId, { contactId, conversationId: ctx.conversationId, said })
        if (outcome === "no_es_paciente") shown = (await updateContact(tx, ctx.orgId, contactId, names, { userId: null, origin: "agent" })).contact.displayName
        if (ctx.dryRun) throw undone
      }).catch((error: unknown) => {
        if (error !== undone) throw error
      })
      if (outcome === "avisado") {
        await noteAction("datos", "avisó a recepción que su nombre no es el de su ficha")
        return `${ctx.dryRun ? "[SIMULACIÓN] " : ""}Es paciente y su ficha dice otro nombre: por aquí no se cambia y ${ctx.dryRun ? "quedaría" : "quedó"} una tarea para que recepción la revise. Háblale por el nombre que te dijo, sin decirle cómo figura en su ficha. Si le das su enlace para reservar, dile que ahí puede corregir su nombre.`
      }
      if (outcome !== "no_es_paciente") return "Es paciente: su nombre no se cambia por aquí. Úsalo tal como figura."
      // Si el nombre entero traía algo más, no se reparte («María José» no tiene apellido): lo sabe quien lo escuchó (ADR 0058).
      const kept = new Set(nameWords(shown))
      const leftOut = !!display && !!given !== !!family && nameWords(display).some((word) => !kept.has(word))
      const other = family ? "sus nombres, guárdalos en givenNames" : "sus apellidos, guárdalos en familyName"
      const told = leftOut ? ` Figura como «${shown}» y no quedó el resto de «${display}». Si ahí te dijo ${other}.` : ""
      if (ctx.dryRun) return `[SIMULACIÓN] Se actualizaría el contacto.${told}`
      await noteAction("datos", "anotó su nombre")
      return `Contacto actualizado.${told}`
    },
    {
      name: "update_contact",
      description:
        "Guarda el nombre que la persona te dijo (nombres y apellidos) si aún no es paciente. El nombre de un paciente lo cambia el equipo en su ficha.",
      schema: z.object({
        givenNames: z.string().min(1).max(120).optional().describe("Sus nombres, como los dijo."),
        familyName: z.string().min(1).max(120).optional().describe("Sus apellidos, como los dijo."),
        displayName: z.string().min(1).max(200).optional(),
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
          // Sin responsable, la tarea que deja el agente es de Recepción: si no, nadie de recepción la vería.
          area: "recepcion",
          // Misma clave estable que las propuestas: reentregar el mensaje no duplica la tarea.
          idempotencyKey: buildAgentProposalKey({
            conversationId: ctx.conversationId,
            triggerId: ctx.triggerId,
            tool: "create_task",
            payload: { title, dueAt: dueAt ?? null },
          }),
        }),
      )
      await noteAction("tarea", `dejó una tarea a recepción: ${title}`)
      return `Tarea creada para recepción (id ${created.id}).`
    },
    {
      name: "create_task",
      description: "Deja una tarea a recepción (llamar, confirmar, enviar algo que pidió la persona).",
      schema: operationAgentSchema("tarea.crear"),
    },
  )

  const clinicInfo = tool(
    async () => {
      // Con «Informar» apagado esta herramienta sigue para Agendar, pero solo con sedes, horarios y
      // servicios sin precio: ni precios, ni promociones, ni profesionales, ni medios de pago.
      const informs = !(ctx.excludedTools ?? []).includes("buscar_en_la_clinica")
      const books = !(ctx.excludedTools ?? []).includes("buscar_huecos")
      const { snapshot, data, zone } = await inOrg(async (tx) => ({
        snapshot: await getClinicInfoSnapshot(tx, ctx.orgId),
        data: await getAgentClinicData(tx, ctx.orgId, informs, books),
        zone: await getOrgLocale(tx, ctx.orgId),
      }))
      const lines = [`Clínica: ${snapshot.clinicName}.`]
      for (const b of snapshot.branches) {
        lines.push(
          `- Sede ${b.name} (id ${b.id}): ${[b.address, b.directions ? `cómo llegar: ${b.directions}` : null, b.phone].filter(Boolean).join(" · ") || "sin datos"}`,
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
      // Lo que no encontró queda a la vista de quien administra, como en consultar_conocimiento.
      if (clinicSearchFoundNothing(result.found) && !ctx.dryRun) {
        await inOrg((tx) =>
          recordKnowledgeGap(tx, ctx.orgId, {
            conversationId: ctx.conversationId,
            triggerMessageId: ctx.triggerId,
            question: ctx.lastInboundText?.trim() || texto,
            query: texto,
          }),
        ).catch(() => null)
      }
      return formatClinicSearch(result.found, result.zone)
    },
    {
      name: "buscar_en_la_clinica",
      description:
        `Busca en lo que ofrece la clínica: servicios (con cómo decir su precio), promociones vigentes (precio, condiciones y fecha de fin) y profesionales por nombre o especialidad. Escribe lo que pide la persona con sus palabras${texts.searchExamples ? ` (${texts.searchExamples})` : ""}. Devuelve solo lo que coincide, leído en este momento.`,
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
      if (found.length && !ctx.dryRun && !ctx.testConversation) {
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
      if (!patientId) {
        const candidates = await inOrg((tx) => listAgentContextCandidates(tx, ctx.orgId, ctx.contactId))
        if (!candidates.length) return "El interlocutor aún no es paciente: no le pidas documento ni datos para reservar; haz lo que dice la línea del interlocutor (su enlace o recepción)."
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
    async ({ patientId, desde }: { patientId: string; desde?: string }) => {
      const from = desde ? new Date(`${desde}T00:00:00Z`) : undefined
      const summary = await inOrg((tx) =>
        getAgentPatientSummary(tx, ctx.orgId, ctx.contactId, patientId, from && !Number.isNaN(from.getTime()) ? { from } : {}),
      )
      const zone = await orgZone()
      const lines = [`Paciente: ${summary.context.displayName} (vínculo ${summary.context.relationship}).`]
      if (!summary.upcomingAppointments.length) {
        lines.push("Sin citas próximas.")
      }
      for (const a of summary.upcomingAppointments) {
        const cuando = formatZoned(new Date(a.startsAt), { timezone: a.branchTimezone ?? zone.timezone, locale: zone.locale })
        lines.push(
          `- Cita ${a.status} (id ${a.appointmentId}, versión ${a.version}) el ${cuando}, ${a.branchName} con ${a.professionalName}.`,
        )
      }
      if (summary.moreAppointments > 0) {
        const last = summary.upcomingAppointments[summary.upcomingAppointments.length - 1]
        const after = last ? new Date(last.startsAt).toISOString().slice(0, 10) : null
        lines.push(
          `Y ${summary.moreAppointments} ${summary.moreAppointments === 1 ? "cita más" : "citas más"} después de estas: para verlas, vuelve a llamar con desde${after ? ` ${after}` : ""}. No digas que no tiene otra cita sin verlas.`,
        )
      }
      for (const b of summary.budgets) {
        lines.push(`- Presupuesto N°${b.number} ${b.title}: ${b.status}.`)
      }
      if (summary.moreBudgets > 0) {
        lines.push(`Y ${summary.moreBudgets} ${summary.moreBudgets === 1 ? "presupuesto anterior" : "presupuestos anteriores"} que no van aquí.`)
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
        "Próximas citas (con id y versión para reprogramar_cita/cancelar_cita) y estado de presupuestos del paciente verificado; saldo solo si el interlocutor tiene facultad económica. Si tiene más citas de las que caben, lo dice: pídelas con desde. Nunca historia clínica.",
      schema: z.object({
        patientId: z.string().uuid(),
        desde: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Solo las citas desde ese día (AAAA-MM-DD), cuando busca una cita más adelante o el resumen dijo que hay más."),
      }),
    },
  )

  const availability = tool(
    async (input: {
      branchId: string
      from: string
      to: string
      durationMin?: number
      profesional?: string
      roomId?: string
      serviceId?: string
    }) => {
      const { profesional, ...rest } = input
      const { gaps, truncated, timeZone, attending, professionalNotAttending } = await inOrg((tx) =>
        findFreeGaps(tx, ctx.orgId, {
          ...rest,
          ...(profesional ? { professionalRef: profesional } : {}),
          // En una prueba, los huecos descuentan las otras pruebas: lo que ofrece se puede reservar.
          ...(ctx.testConversation ? { forTest: true } : {}),
        }),
      )
      // Quién atiende ese servicio: la agenda solo ofrece sus horas (ADR 0039).
      const who = attending
        ? `Este servicio es de ${attending.specialtyName} y solo lo atiende${attending.names.length === 1 ? "" : "n"} ${attending.names.join(", ")}: la agenda solo ofrece sus horas.`
        : null
      if (professionalNotAttending) {
        return `Ese profesional no atiende este servicio en esa sede. ${who ?? ""} Díselo a la persona y ofrécele esas horas.`.trim()
      }
      if (!gaps.length) {
        return [who, "Sin huecos en ese rango (quizá sin horario configurado): ofrece otro rango o deriva."].filter(Boolean).join(" ")
      }
      const { locale } = await orgZone()
      // La hora ya va en la de la sede: el modelo la dice tal cual y nunca convierte zonas.
      const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "numeric", month: "long" })
      const clock = new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      // La agenda que acompaña a los horarios abre donde buscó: en esa sede, o en todas si buscó en
      // varias, y con el servicio que buscó (una búsqueda sin servicio no le quita el que ya tenía).
      const before = ctx.gapsSought
      ctx.gapsSought = {
        branchId: !before || before.branchId === input.branchId ? input.branchId : null,
        serviceId: input.serviceId ?? before?.serviceId ?? null,
      }
      const lines = [
        `Huecos libres, ordenados por hora, hasta ${GAPS_PER_PROFESSIONAL_PER_DAY} por profesional y día, repartidos en su jornada, en hora local de la sede (dilos así, sin convertir horas). El dato entre corchetes es solo para proponer_cita: no lo escribas a la persona.`,
        ...(who ? [who] : []),
        ...gaps.map((g) => {
          const start = new Date(g.startsAt)
          const end = new Date(g.endsAt)
          const roomId = g.roomId ?? `sin ${room} asignada: filtra por una ${room} real o deriva`
          return (
            `- ${day.format(start)}, ${clock.format(start)}–${clock.format(end)}${g.professionalName ? ` con ${g.professionalName}` : ""}` +
            ` [startsAt ${g.startsAt} · sede ${input.branchId} · ${room} ${roomId} · profesional ${g.professionalRef}]`
          )
        }),
        `Usa los datos exactos del hueco elegido en proponer_cita (startsAt, sede, ${room} y profesional): nunca inventes IDs ni horas.`,
      ]
      if (truncated) lines.push("Hay más huecos que no van aquí: acota el rango por días o pide los de un profesional.")
      if (ctx.publicUrl && !ctx.dryRun && ctx.route?.path !== "cambio_cita") {
        lines.push("Al enviar horarios, el sistema agrega al final de tu respuesta su enlace para ver toda la agenda: no lo escribas ni lo anuncies.")
      }
      return lines.join("\n")
    },
    {
      name: "buscar_huecos",
      description:
        `Huecos reales de agenda según horario del profesional, ausencias, feriados y citas ocupantes. Usa el id exacto de la sede (branchId); from/to en hora local de la sede y sin zona (por ejemplo 2026-10-16T08:00 y 2026-10-16T13:00 para «el viernes en la mañana»). No indiques durationMin: con serviceId se usa la duración del servicio y, sin servicio, la de una cita regular en esa sede; indícala solo si el interlocutor pide otra duración. Con serviceId ofrece solo a quien atiende ese servicio. Para pedir las horas de alguien en particular («con la Dra. Rojas»), pasa en profesional su identificador de la lista de profesionales. Devuelve hasta ${GAPS_PER_PROFESSIONAL_PER_DAY} huecos por profesional y día, repartidos en su jornada y por hora; cada hueco trae sede, ${room}, profesional, inicio, fin, zona y duración para proponer_cita.`,
      schema: z.object({
        branchId: z.string().uuid(),
        from: z.string().min(1),
        to: z.string().min(1),
        durationMin: z.number().int().min(10).max(480).optional(),
        profesional: z
          .string()
          .optional()
          .describe("El identificador de la lista de profesionales («pro-…»), cuando la persona pide a alguien en particular."),
        roomId: z.string().uuid().optional(),
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
        // Sin dirección de la clínica no hay página que abrir: el enlace ni se emite.
        const found = await inOrg(async (tx) => {
          const origin = await clinicLinkOrigin(tx, publicUrl)
          if (!origin) return null
          const link = await createBookingLink(tx, ctx.orgId, { conversationId: ctx.conversationId, ...input }, { secretsKey: ctx.secretsKey })
          return { link, url: personalLinkAddress(origin, link.token) }
        })
        if (!found) return "La clínica no tiene dirección pública: propón horarios por aquí con buscar_huecos. Si no tienes buscar_huecos, pasa el caso a una persona: no digas que enviaste un enlace."
        const { link, url } = found
        // Quien aún no es paciente no puede reservar por aquí: ofrecerle «seguir por aquí» lo contradecía.
        const next = link.needsRegistration
          ? " Como aún no es paciente, ahí deja sus datos y reserva: díselo en una frase y no le ofrezcas reservar por aquí. Si ya eligió una hora contigo, dile que elija esa misma en la página (por ejemplo «ahí eliges el jueves a las 8:00»), sin pedirle que vuelva a decidir."
          : " Ofrece también seguir por aquí si lo prefiere."
        await noteAction("enlace", "le envió su enlace para que elija su cita")
        return `Su enlace, para que ${link.patientName ?? "la persona"} elija su cita viendo los horarios libres (es personal y vale ${PERSONAL_LINK_TTL_DAYS} días; es el mismo si ya tenía uno): ${url}\nEnvíalo tal cual con send_reply, en un solo mensaje.${next} Cuando reserve, el sistema se lo confirma en esta conversación y queda en el estado del caso: no vuelvas a proponer horarios.`
      } catch (error) {
        if (error instanceof ServiceError && error.code === "TEST_CONVERSATION") {
          return "Es una prueba del chat web: no se envía el enlace. Dile que en la prueba no se reserva nada y ofrece seguir por aquí."
        }
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
        "Envía «Su enlace»: la página personal de la persona, para que elija ella misma el día y la hora de su cita viendo los horarios libres, en vez de ir y venir por el chat; ahí también ve lo que tiene pendiente (su cita, sus datos por completar, su presupuesto). Sirve a quien ya es paciente y a quien recién se contacta (este completa sus datos en la misma página). Úsalo también cuando la persona diga que su enlace ya no sirve: le das uno nuevo. Es una opción: también puedes reservar por aquí. Indica serviceId y branchId si ya se habló de un servicio o una sede (ids exactos de «Sedes» y «Servicios»); patientId solo si tiene varios pacientes vinculados. La página no muestra precios. No reserva nada por sí sola: la cita la crea la persona al elegir. Nunca es acceso al portal.",
      schema: z.object({
        patientId: z.string().uuid().optional(),
        serviceId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
      }),
    },
  )

  /**
   * Volver a entrar al portal (decisión 9): la persona lo pide por el chat y
   * el agente lo deja en «Te espera» de recepción, que le envía un enlace nuevo
   * y le dice el código aparte. El agente nunca envía el enlace ni el código:
   * tener el chat de alguien no prueba que sea esa persona.
   */
  const portalReentry = tool(
    async () => {
      if (ctx.dryRun) return "[SIMULACIÓN] Se dejaría a recepción el pedido de volver a entrar al portal."
      const result = await inOrg((tx) =>
        requestPortalReentry(tx, ctx.orgId, { contactId: ctx.contactId, conversationId: ctx.conversationId }),
      )
      if (result.status === "portal_apagado") {
        return "La clínica no tiene el portal encendido. Díselo con amabilidad y ofrécele lo que necesite por aquí."
      }
      if (result.status === "sin_acceso") {
        return "La persona no tiene acceso al portal. El acceso se da en la clínica, en persona y con su documento: díselo con send_reply. No envíes ningún enlace de acceso."
      }
      await noteAction("portal", "dejó a recepción su pedido de volver a entrar al portal")
      return "Listo: recepción tiene el pedido y le enviará un enlace nuevo; el código se lo dan en recepción o por llamada. Díselo con send_reply, por ejemplo: «Te damos tu código en recepción o por llamada». No envíes enlaces ni códigos: eso lo hace una persona del equipo."
    },
    {
      name: "pedir_volver_al_portal",
      description:
        "Úsala cuando la persona pida volver a entrar al portal del paciente (cambió de teléfono, perdió su acceso, el enlace venció). No envía nada: deja el pedido a recepción, que le manda un enlace nuevo y le da el código por otra vía. Nunca envíes tú un enlace o un código del portal.",
      schema: z.object({}),
    },
  )

  /** Chat web sin WhatsApp ni correo, con una clínica que podría avisar por alguno. */
  const webchatNeedsContact = async () =>
    (await conversationChannel(ctx)) === "webchat" &&
    (await inOrg((tx) => webchatHandoffWhere(tx, ctx.orgId, ctx.conversationId)).catch(() => "aqui" as const)) === "preguntar"

  /**
   * «Su enlace» con la hora que eligió en el chat (ADR 0109): para quien aún no es paciente, o para
   * el paciente al que la clínica le falta algo, la hora se reserva ahí, al confirmar sus datos. Es el
   * mismo enlace que acompaña a los horarios (`issueAgendaLink`): nulo si el paciente ya tiene una
   * cita por venir, porque la página le mostraría esa cita en vez de la reserva. El mensaje guarda la
   * referencia del enlace y el worker pone el token al entregarlo (`personalLinkRef`).
   */
  const pickLink = async (
    origin: string,
    slot: { patientId?: string; branchId: string; serviceId?: string; professionalUserId: string; startsAt: string; newPerson?: boolean },
  ) =>
    inOrg(async (tx) => {
      const { patientId, serviceId, professionalUserId, startsAt, branchId, newPerson } = slot
      const link = await issueAgendaLink(
        tx,
        ctx.orgId,
        {
          conversationId: ctx.conversationId,
          branchId,
          ...(patientId ? { patientId } : {}),
          ...(serviceId ? { serviceId } : {}),
          ...(newPerson ? { newPerson: true } : {}),
        },
        { secretsKey: ctx.secretsKey },
      )
      return link ? { link, url: bookingPickAddress(origin, personalLinkRef(link.linkId), { branchId, professionalUserId, startsAt }) } : null
    })

  /** Ya le dio en esta atención el enlace con esa misma hora: no se le manda otra vez. */
  const PICK_LINK_GIVEN =
    "Ya le diste su enlace con esa hora en esta atención: no se lo vuelvas a mandar ni le repitas la cita. Respóndele en una frase a lo que dice; si no quiere o no puede usar el enlace, pasa el caso a recepción con request_human_handoff, con esa hora, y no le digas que se reserva por aquí."
  const pickGiven = (startsAt: string): boolean => {
    const at = Date.parse(startsAt)
    return !Number.isNaN(at) && (ctx.pickLinks ?? []).some((given) => Date.parse(given) === at)
  }

  /** Lo que se le dice al modelo para enviar ese enlace: con sus palabras, como lo pidió la clínica (ADR 0109). */
  const pickLinkReply = (url: string, why: string, forName: string | null): string =>
    `Todavía no se reservó nada: ${why}. Esa hora se reserva en su enlace, que ya la trae elegida: ahí confirma sus datos y queda reservada (es personal y vale ${PERSONAL_LINK_TTL_DAYS} días): ${url}\n` +
    `Envíaselo con send_reply en un solo mensaje, con tus palabras, en su idioma y con el trato de la clínica, por ejemplo «¡Perfecto, Rosa! Para reservarte el martes 3 de noviembre a las 9:00 a. m. con el Dr. Luis Prado, confirma tus datos aquí (1 minuto): ${url}»: ` +
    `si sabes cómo se llama, empieza por su nombre; di el día, la hora y con quién del hueco que eligió${forName ? ` y que la cita es para ${forName}` : ""}, y escribe el enlace tal cual, sin cambiarlo. ` +
    "No le pidas por aquí su sí ni sus datos, no le digas que se reserva por aquí y no digas que ya quedó reservada: queda reservada cuando confirme en la página, y el sistema se lo dice en esta conversación."

  /**
   * La sede del hueco que se ofreció con ese inicio, ese profesional y esa sala: la que lleva el
   * enlace con la hora cuando el modelo no la indicó. Nula sin evidencia o sin ese hueco.
   */
  const offeredBranch = (input: { startsAt: string; professionalUserId: string; roomId: string }): string | null => {
    const wanted = Date.parse(input.startsAt)
    const professional = input.professionalUserId.trim().toLowerCase()
    for (const item of ctx.evidence ?? []) {
      for (const [, startsAt = "", branch = "", rest = "", ref = ""] of item.text.matchAll(/\[startsAt (\S+) · sede (\S+) · (.+?) · profesional ([^\]\s]+)\]/g)) {
        if (Date.parse(startsAt) === wanted && ref.toLowerCase() === professional && rest.includes(input.roomId)) return branch
      }
    }
    return null
  }

  const proposeBooking = tool(
    async (input: {
      patientId: string
      professionalUserId: string
      roomId: string
      startsAt: string
      branchId?: string
      serviceId?: string
      durationMin?: number
      reason?: string
    }) => {
      // Lo mismo en una prueba y en una conversación real: solo se propone un hueco consultado.
      if (!slotWasOffered(ctx.evidence, input)) return SLOT_NOT_OFFERED
      if (ctx.dryRun) {
        return `[SIMULACIÓN] Se propondría reservar: paciente ${input.patientId} el ${input.startsAt}.`
      }
      // El agente solo conoce al profesional por su referencia («pro-…»): el usuario lo pone el servidor.
      const professionalUserId = await inOrg((tx) => resolveProfessionalRef(tx, ctx.orgId, input.professionalUserId))
      if (!professionalUserId) return UNKNOWN_PROFESSIONAL
      // Si a la clínica le falta algo del paciente (un dato obligatorio o el aviso de privacidad), esa
      // hora se reserva en su enlace al confirmarlo, no con su sí en el chat (ADR 0109). Sin dirección
      // pública, con una cita por venir (su enlace le mostraría esa cita) o si el enlace no se puede
      // emitir, se propone aquí como siempre y la confirmación lleva el enlace para completar sus datos.
      const viaLink = await (async () => {
        const publicUrl = ctx.publicUrl
        const branchId = input.branchId ?? offeredBranch(input)
        if (!publicUrl || !branchId) return null
        if (pickGiven(input.startsAt)) return PICK_LINK_GIVEN
        try {
          const found = await inOrg(async (tx) => {
            const origin = await clinicLinkOrigin(tx, publicUrl)
            const missing = origin ? await chatBookingMissing(tx, ctx.orgId, { contactId: ctx.contactId, patientId: input.patientId }) : []
            return origin && missing.length ? { origin, missing } : null
          })
          if (!found) return null
          const issued = await pickLink(found.origin, {
            patientId: input.patientId,
            branchId,
            ...(input.serviceId ? { serviceId: input.serviceId } : {}),
            professionalUserId,
            startsAt: input.startsAt,
          })
          if (!issued) return null
          await noteAction("enlace", "le dio su enlace con la hora que eligió")
          const whose = issued.link.forName ?? "la persona"
          return pickLinkReply(issued.url, `a la clínica le falta algo de ${whose} (${found.missing.join(", ")}) y no se reserva por aquí`, issued.link.forName)
        } catch (error) {
          if (error instanceof ServiceError) return null
          throw error
        }
      })()
      if (viaLink) return viaLink
      const { reason, ...payload } = { ...input, professionalUserId }
      let created: ProposalItem | undefined
      const proposed = await propose("reservar_cita", payload, "proponer_cita", reason, (p) => {
        created = p
      })
      // En el chat web, si cierra la pestaña no le llega nada: la propuesta queda
      // creada y la reserva espera a tener dónde avisarle (se exige al confirmar).
      if (await webchatNeedsContact()) {
        return `${proposed} En el chat web, antes de reservar hace falta su WhatsApp o su correo para avisarle de la cita: pídeselo en este mismo mensaje junto con su sí.`
      }
      // Si ya pidió reservar esa misma hora, su sí está dado: no se le vuelve a pedir (ADR 0097).
      if (created?.status === "propuesta") {
        const id = created.id
        const before = await inOrg((tx) => chosenBeforeProposalOf(tx, ctx.orgId, ctx.contactId, id)).catch(() => null)
        if (before && (await choseThisSlot(ctx.decision, { proposed: before.proposed, said: before.said }))) {
          const done = await confirmById({ proposalId: id }, before.messageId)
          // Solo se dice reservada si de verdad se reservó; si no, lo que pasó tal cual.
          return done.startsWith("Confirmado y ejecutado")
            ? `Ya había pedido esta misma hora, así que no se le pregunta de nuevo. ${done} Dile que quedó reservada, con el día, la hora, la sede y con quién.`
            : `${proposed} (${done})`
        }
      }
      return proposed
    },
    {
      name: "proponer_cita",
      description:
        `Propone reservar una cita con los IDs exactos de un hueco de buscar_huecos (sede, ${room}, profesional, inicio). Verifica vínculo del paciente al ejecutar; queda esperando la confirmación del interlocutor (confirmar_propuesta). Si a la clínica le falta un dato del paciente o que acepte el aviso de privacidad, no la propone: te da su enlace con esa hora para que confirme sus datos y reserve ahí.`,
      schema: operationAgentSchema("cita.reservar", { room }),
    },
  )

  /**
   * Quien aún no es paciente reserva en su enlace (ADR 0109, que precisa la 0101): con el hueco
   * que eligió, su enlace ya trae esa hora y ahí deja sus datos (o los de su hijo, con «Para otra
   * persona») y acepta el aviso; por el chat no se registra a nadie. Si quien escribe ya tiene
   * pacientes (una madre con el suyo que pide cita para su hijo nuevo), el enlace es para alguien
   * nuevo (`newPerson`): no es el de ellos. Sin registro en línea o sin dirección pública, lo
   * registra recepción.
   */
  const bookNewPatient = tool(
    async (input: {
      professionalUserId: string
      roomId: string
      startsAt: string
      branchId?: string
      serviceId?: string
      durationMin?: number
      reason?: string
      forOther?: boolean
    }) => {
      if (!slotWasOffered(ctx.evidence, input)) return SLOT_NOT_OFFERED
      if (ctx.dryRun) return `[SIMULACIÓN] Se le daría su enlace con la hora ${input.startsAt}, para que deje sus datos y reserve ahí.`
      // Quien ya tiene pacientes vinculados recibe el enlace para alguien nuevo: su enlace de siempre abriría lo de ellos.
      const linked = await inOrg((tx) => listAgentContextCandidates(tx, ctx.orgId, ctx.contactId))
      const ownRecord = linked.some((item) => item.relationship === "self")
      if (ownRecord && input.forOther !== true) {
        return "Ya es paciente: no se registra de nuevo. Usa proponer_cita con su patientId (de ver_contexto_paciente). Si la cita es para otra persona que aún no es paciente (su hijo, por ejemplo), vuelve a llamar a reservar_paciente_nuevo con forOther."
      }
      const publicUrl = ctx.publicUrl
      const origin = publicUrl ? await inOrg((tx) => clinicLinkOrigin(tx, publicUrl)) : null
      if (!origin) {
        return "La clínica no registra pacientes por el chat. Envíale su enlace con enviar_enlace_cita para que reserve ese horario y deje sus datos."
      }
      const professionalUserId = await inOrg((tx) => resolveProfessionalRef(tx, ctx.orgId, input.professionalUserId))
      if (!professionalUserId) return UNKNOWN_PROFESSIONAL
      const branchId = input.branchId ?? offeredBranch(input)
      if (!branchId) return "Falta la sede del hueco que eligió: vuelve a llamar con su branchId exacto (el dato «sede» del hueco de buscar_huecos)."
      if (pickGiven(input.startsAt)) return PICK_LINK_GIVEN
      const toTeam = "pasa el caso a recepción con request_human_handoff, con su nombre y la hora que eligió, para que lo registre y le confirme; no le digas que quedó reservada."
      let issued: Awaited<ReturnType<typeof pickLink>>
      try {
        issued = await pickLink(origin, {
          branchId,
          ...(input.serviceId ? { serviceId: input.serviceId } : {}),
          professionalUserId,
          startsAt: input.startsAt,
          ...(linked.length > 0 ? { newPerson: true } : {}),
        })
      } catch (error) {
        if (error instanceof ServiceError && error.code === "TEST_CONVERSATION") {
          return "Es una prueba con una persona real: no se envía su enlace ni se reserva nada de verdad. Dile que en la prueba no se reserva."
        }
        if (error instanceof ServiceError && error.code === "BOOKING_NEEDS_PATIENT") {
          return `La clínica no tiene activo el registro de pacientes en línea: a quien aún no es paciente no se le reserva por aquí ni por un enlace. Por eso ${toTeam}`
        }
        if (error instanceof ServiceError) return `No se pudo preparar su enlace: ${error.message}. Por eso ${toTeam}`
        throw error
      }
      if (!issued) return `No se pudo preparar su enlace. Por eso ${toTeam}`
      await noteAction("enlace", "le dio su enlace con la hora que eligió")
      return pickLinkReply(
        issued.url,
        ownRecord
          ? "la cita es para alguien que aún no es paciente y por aquí no se registra a nadie: en la página deja los datos de esa persona"
          : "aún no es paciente y por aquí no se registra a nadie; si la cita es para otra persona (su hijo o hija, por ejemplo), en la página elige «Para otra persona» y deja sus datos",
        null,
      )
    },
    {
      name: "reservar_paciente_nuevo",
      description:
        "Para quien aún no es paciente, cuando ya eligió un hueco de buscar_huecos: te da su enlace con esa hora ya elegida, para que deje sus datos (o los de la persona para quien es la cita) y quede reservada ahí. Si quien escribe ya es paciente y la cita es para otra persona que aún no lo es (su hijo, por ejemplo), con forOther. Por aquí no se registra a nadie: no le pidas apellidos, documento ni nada de salud para esto.",
      schema: operationAgentSchema("cita.reservar", { room })
        .omit({ patientId: true })
        .extend({
          forOther: z.boolean().optional().describe("true si quien escribe ya es paciente y la cita es para otra persona que aún no lo es."),
        }),
    },
  )

  const rescheduleAppointment = tool(
    async (input: {
      appointmentId: string
      startsAt: string
      expectedVersion: number
      professionalUserId?: string
      roomId?: string
      reason?: string
    }) => {
      if (ctx.dryRun) {
        return `[SIMULACIÓN] Se propondría reprogramar la cita ${input.appointmentId} al ${input.startsAt}.`
      }
      let professionalUserId: string | undefined
      if (input.professionalUserId) {
        professionalUserId = (await inOrg((tx) => resolveProfessionalRef(tx, ctx.orgId, input.professionalUserId as string))) ?? undefined
        if (!professionalUserId) return UNKNOWN_PROFESSIONAL
      }
      const { reason, ...payload } = { ...input, ...(professionalUserId ? { professionalUserId } : {}) }
      return propose("reprogramar_cita", payload, "reprogramar_cita", reason)
    },
    {
      name: "reprogramar_cita",
      description:
        "Propone mover una cita existente a un nuevo inicio: nunca crea una reserva duplicada. Usa el id y la versión exactos de ver_resumen_paciente; con varias citas pregunta primero cuál corresponde y nunca actúes sobre pacientes no autorizados. Queda esperando la confirmación del interlocutor (confirmar_propuesta).",
      schema: operationAgentSchema("cita.mover", { room }),
    },
  )

  const cancelAppointmentProposal = tool(
    async (input: { appointmentId: string; reason?: string }) => {
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

  /**
   * La persona confirma por escrito una cita que ya tiene («sí, ahí estaré»).
   * Es la misma operación que el botón «Confirmar» del recordatorio, sin
   * propuesta: solo su propia cita (o la de quien lleva), nunca otra.
   */
  const confirmAppointment = tool(
    async ({ appointmentId }: { appointmentId?: string }) => {
      if (ctx.dryRun) return "[SIMULACIÓN] Se confirmaría la cita de la persona."
      let result: Awaited<ReturnType<typeof confirmAppointmentByContact>>
      try {
        result = await inOrg((tx) =>
          confirmAppointmentByContact(tx, ctx.orgId, {
            contactId: ctx.contactId,
            conversationId: ctx.conversationId,
            ...(appointmentId ? { appointmentId } : {}),
          }),
        )
      } catch (e) {
        if (e instanceof ServiceError) {
          return `No se pudo confirmar: ${e.message}. Pregúntale de qué cita habla o pasa el caso a una persona.`
        }
        throw e
      }
      const zone = await orgZone()
      const said = (item: ContactAppointmentOption) =>
        `${item.patientName}, el ${formatZoned(new Date(item.startsAt), { timezone: item.branchTimezone ?? zone.timezone, locale: zone.locale })}, en ${item.branchName} con ${item.professionalName}`
      if (result.outcome === "ninguna") {
        return "La persona no tiene citas por venir que confirmar. Si habla de otra cita, pregúntale cuál o pasa el caso a una persona."
      }
      if (result.outcome !== "varias") {
        // Un padre confirma las citas de quienes lleva: se le dice de quiénes son.
        const list = result.appointments
          .map((item) => `- ${said(item)}${item.was === "ya_confirmada" ? " (ya estaba confirmada)" : ""}`)
          .join("\n")
        if (result.outcome === "confirmada") await noteAction("cita", "registró que confirmó su cita", result.appointments.map((item) => said(item)).join(" · "))
        const head =
          result.outcome === "confirmada"
            ? result.appointments.length > 1 ? "Citas confirmadas:" : "Cita confirmada:"
            : result.appointments.length > 1 ? "Esas citas ya estaban confirmadas:" : "Esa cita ya estaba confirmada:"
        return `${head}\n${list}\nDíselo con send_reply, con estas palabras o parecidas: «${result.reply}»`
      }
      return `Tiene varias citas por confirmar: pregúntale cuál y vuelve a llamar con su id.\n${result.options.map((item) => `- ${said(item)} (id ${item.appointmentId})`).join("\n")}`
    },
    {
      name: "confirmar_cita",
      description:
        "Confirma una cita que la persona ya tiene cuando ella lo dice por escrito («sí, ahí estaré», «confirmo»), por ejemplo al responder un recordatorio. No es una propuesta ni pide otro sí. Sin id confirma, como el botón, las citas del último recordatorio que recibió (si escribe por sus hijos, las de ellos); si no hay recordatorio, la única cita que espera confirmación, y si tiene varias te las devuelve para que preguntes cuál. Te devuelve qué confirmó y la frase para decírselo.",
      schema: operationAgentSchema("cita.confirmar"),
    },
  )

  /**
   * La persona responde por escrito a la pregunta del permiso general que hizo
   * el sistema tras reservar («¿Te podemos escribir también…?»). Es la misma
   * operación que su botón (`answerGeneralPermission`): solo vale si se le
   * preguntó y aún no respondió; queda con origen «conversación» (ADR 0030).
   */
  const answerPermission = tool(
    async ({ granted }: { granted: boolean }) => {
      if (ctx.dryRun) return "[SIMULACIÓN] Se anotaría su respuesta sobre las novedades y promociones."
      const outcome = await inOrg((tx) => answerGeneralPermission(tx, ctx.orgId, { conversationId: ctx.conversationId, granted }))
      if (outcome === "no_preguntado") return "No se le hizo esa pregunta: no hay nada que anotar. Sigue la conversación."
      if (outcome === "ya_respondio") return "Ya había respondido antes; no cambia nada. Sigue la conversación."
      await noteAction("mensajes", granted ? "anotó que acepta novedades y promociones" : "anotó que no quiere novedades ni promociones")
      // La misma frase que el botón, con el nombre y el trato de la clínica (de usted solo si la clínica
      // trata de usted, como la pregunta): lo que deja de recibir son las novedades y promociones (ADR 0030).
      const words = await inOrg(async (tx) => {
        const treatment = ctx.treatment !== undefined ? ctx.treatment : (await getAgentConfig(tx, ctx.orgId)).treatment
        return generalPermissionWords((await getClinicInfoSnapshot(tx, ctx.orgId)).clinicName, treatment === "usted" ? "usted" : "tu")
      })
      return `Anotado. Díselo con send_reply, con estas palabras: «${granted ? words.yes : words.no}» No le digas que dejará de recibir otros mensajes: sus citas, controles y presupuestos le siguen llegando.`
    },
    {
      name: "responder_permiso_mensajes",
      description:
        `Anota la respuesta de la persona a la pregunta que le hizo la clínica tras reservar: «${GENERAL_PERMISSION_QUESTION}». Úsala solo si su último mensaje responde a esa pregunta (sí o no); nunca para confirmar una cita.`,
      schema: operationAgentSchema("mensajes.permiso"),
    },
  )

  /**
   * «Tus mensajes» por el chat (G2; ADR 0040): la persona pide dejar de recibir
   * un tipo de mensaje, volver a recibirlo o ningún mensaje, o pide su página
   * para elegir. Es la misma operación que el botón «No más recordatorios» y que
   * su página (`setMessageChoice`); la frase de respuesta es fija.
   */
  const chooseMessages = tool(
    async ({ tipo, recibir }: { tipo?: string; recibir?: boolean }) => {
      if (ctx.dryRun) {
        return tipo
          ? `[SIMULACIÓN] Se anotaría que ${recibir ? "vuelve a recibir" : "deja de recibir"} ese tipo de mensaje.`
          : "[SIMULACIÓN] Se le daría su página «Tus mensajes»."
      }
      const result = await inOrg((tx) =>
        chooseMessagesInConversation(
          tx,
          ctx.orgId,
          { conversationId: ctx.conversationId, choice: tipo ?? null, receive: recibir ?? false },
          { secretsKey: ctx.secretsKey },
        ),
      )
      if (result.changed.length > 0) await noteAction("mensajes", "cambió los mensajes que recibe")
      return `${result.changed.length > 0 ? "Anotado. " : ""}Díselo con send_reply, con estas palabras: «${result.reply}» No prometas nada más.`
    },
    {
      name: "elegir_mensajes",
      description:
        "Cuando la persona pide no recibir más un tipo de mensaje («ya no me manden recordatorios», «no quiero promociones», «no me escriban nada») o volver a recibirlo («sí, mándenme el recordatorio»), o pide elegir qué mensajes recibe. Si no queda claro qué tipo quiere dejar, pregúntale antes: los recordatorios de sus citas, los de controles y seguimiento, las novedades y promociones o ningún mensaje. «Cancelar» es cancelar una cita, nunca una baja. Sin tipo, te da su página para que elija. Te devuelve la frase para decírselo.",
      schema: operationAgentSchema("mensajes.elegir"),
    },
  )

  /**
   * Los presupuestos que la persona recibió, tal como los ve ella en su
   * documento (tratamientos, pieza, precios y opciones), de un paciente que
   * el interlocutor está autorizado a ver. Nunca diagnósticos ni notas.
   */
  const budgetsView = tool(
    async ({ patientId }: { patientId: string }) => {
      let found: AgentPatientBudgets
      try {
        found = await inOrg((tx) => getAgentPatientBudgets(tx, ctx.orgId, ctx.contactId, patientId))
      } catch (e) {
        if (e instanceof ServiceError) {
          return `No puedes ver los presupuestos de ese paciente (${e.message}). No des datos suyos: pregunta de quién habla o pasa el caso a una persona.`
        }
        throw e
      }
      return formatAgentBudgets(found, await orgZone())
    },
    {
      name: "ver_presupuesto",
      description:
        `Los presupuestos que la clínica ya entregó a la persona (o a quien ella lleva), como los recibe ella: cada tratamiento con su ${texts.site ? `${texts.site} y su ` : ""}precio, las opciones y lo que ya respondió, con los ids para reenviar_presupuesto y anotar_respuesta_presupuesto. Nunca trae diagnósticos ni la historia clínica. Úsala antes de hablar de un presupuesto o de anotar lo que responde.`,
      schema: z.object({ patientId: z.string().uuid().describe("El paciente, de ver_contexto_paciente.") }),
    },
  )

  /**
   * La persona pide su presupuesto: se le reenvía el que la clínica ya preparó
   * y entregó, por la operación de siempre. Si no está listo o no hay por dónde,
   * queda una tarea a recepción y el agente recibe la frase para la persona.
   */
  /**
   * El comprobante por WhatsApp solo si la persona lo pide en el chat
   * (decisión 20 v2): se deja en esta conversación, que está abierta porque
   * acaba de escribir, sin gastar un mensaje aprobado. Al cobrar ya salió por correo.
   */
  const sendReceipt = tool(
    async ({ patientId }: { patientId: string }) => {
      if (ctx.dryRun) return "[SIMULACIÓN] Se le enviaría aquí el comprobante de su último pago."
      if (!ctx.storage) return "No se pudo preparar el comprobante: pasa el caso a una persona."
      const storage = ctx.storage
      const sent = await inOrg((tx) =>
        sendReceiptInConversation(tx, ctx.orgId, { conversationId: ctx.conversationId, patientId }, { storage }),
      )
      if (!sent) {
        return "No hay un comprobante de los últimos 30 días que se le pueda enviar a quien escribe. Díselo y ofrece que recepción se lo entregue."
      }
      ctx.replySettled = true
      await noteAction("comprobante", "le envió su comprobante", sent.label)
      return `${sent.label} enviado en esta conversación. No envíes más mensajes.`
    },
    {
      name: "enviar_comprobante",
      description:
        "Envía aquí el comprobante (el ticket) del último pago de un paciente, cuando la persona lo pide en el chat. Solo de un paciente que el interlocutor puede ver (de ver_contexto_paciente) y de los últimos 30 días. Al cobrar ya le llegó por correo y está en su enlace, en «Tus papeles».",
      schema: z.object({ patientId: z.string().uuid() }),
    },
  )

  const resendBudget = tool(
    async ({ patientId, budgetId }: { patientId: string; budgetId?: string }) => {
      if (ctx.dryRun) {
        return "[SIMULACIÓN] Se le reenviaría el último presupuesto que la clínica le entregó; si aún no estuviera listo, quedaría una tarea a recepción para enviárselo."
      }
      // Reentregar el mismo mensaje no lo envía ni deja la tarea dos veces.
      const requestId = stableUuid(
        buildAgentProposalKey({
          conversationId: ctx.conversationId,
          triggerId: ctx.triggerId,
          tool: "reenviar_presupuesto",
          payload: { patientId, budgetId: budgetId ?? null },
        }),
      )
      let outcome: Awaited<ReturnType<typeof resendBudgetByContact>>
      try {
        outcome = await inOrg((tx) =>
          resendBudgetByContact(
            tx,
            ctx.orgId,
            { contactId: ctx.contactId, conversationId: ctx.conversationId, patientId, budgetId: budgetId ?? null, requestId },
            { storage: ctx.storage ?? null, secretsKey: ctx.secretsKey },
          ),
        )
      } catch (e) {
        if (e instanceof ServiceError) {
          return `No se pudo reenviar: ${e.message}. Si habla de otro presupuesto, míralo con ver_presupuesto; si no puede verlo, pasa el caso a una persona.`
        }
        throw e
      }
      const usted = ctx.treatment === "usted"
      if (outcome.outcome === "enviado") {
        const by = outcome.channel === "whatsapp" ? "WhatsApp" : "correo"
        const where = outcome.here
          ? outcome.via === "plantilla"
            ? "aquí mismo (le llega el aviso «Presupuesto listo» y el documento al tocar «Ver y responder»)"
            : "aquí mismo, con el documento"
          : `por ${by}`
        await noteAction("presupuesto", "reenvió su presupuesto", `Presupuesto ${budgetNumberText(outcome.budgetNumber)}`)
        const who = outcome.toInterlocutor ? "" : ` a ${outcome.recipientName} (le llega a la persona o, si es menor, a su representante legal)`
        return `Presupuesto ${budgetNumberText(outcome.budgetNumber)} reenviado${who} ${where}. Díselo en una línea con send_reply, sin repetir precios, y ofrécele ayuda si quiere responderlo.`
      }
      const said =
        outcome.outcome === "no_listo"
          ? usted
            ? "Su presupuesto todavía no está listo. Ya le avisé al equipo para que se lo envíen apenas esté."
            : "Tu presupuesto todavía no está listo. Ya le avisé al equipo para que te lo envíen apenas esté."
          : outcome.outcome === "ninguno"
            ? usted
              ? "No encuentro un presupuesto listo para enviarle. Ya le avisé al equipo para que lo revise y le escriba."
              : "No encuentro un presupuesto listo para enviarte. Ya le avisé al equipo para que lo revise y te escriba."
            : usted
              ? "No pude enviárselo por aquí. Ya le avisé al equipo para que se lo haga llegar."
              : "No pude enviártelo por aquí. Ya le avisé al equipo para que te lo haga llegar."
      await noteAction("tarea", "dejó una tarea a recepción: enviarle su presupuesto")
      const why =
        outcome.outcome === "no_listo"
          ? "El presupuesto todavía no está listo: la clínica lo está preparando. No lo envíes ni des precios de él."
          : outcome.outcome === "ninguno"
            ? "Ese paciente no tiene un presupuesto preparado."
            : "No hubo por dónde enviarlo."
      return `${why} Quedó una tarea a recepción para enviárselo. Díselo con send_reply, con estas palabras o parecidas: «${said}»`
    },
    {
      name: "reenviar_presupuesto",
      description:
        "Reenvía a la persona el presupuesto que la clínica ya preparó y entregó, cuando ella lo pide por el chat. Sale por WhatsApp (o por correo) a la persona o, si el paciente es menor, a su representante legal. Nunca cambia precios ni arma uno. Si todavía no está listo o no hay por dónde enviarlo, deja una tarea a recepción y te devuelve la frase para decírselo.",
      schema: operationAgentSchema("presupuesto.reenviar"),
    },
  )

  /**
   * La persona responde a su presupuesto por escrito. No se anota todavía: se
   * propone la lista y se le pregunta; se anota con su sí (confirmar_propuesta).
   */
  const answerBudget = tool(
    async (input: {
      patientId: string
      budgetId: string
      optionId?: string
      decisions: Array<{ planItemId: string; decision: "aceptado" | "pospuesto" | "rechazado" }>
    }) => {
      if (ctx.dryRun) return "[SIMULACIÓN] Se propondría anotar su respuesta al presupuesto; se anota solo con su sí."
      let planned: Awaited<ReturnType<typeof planBudgetAnswer>>
      try {
        planned = await inOrg((tx) => planBudgetAnswer(tx, ctx.orgId, ctx.contactId, input))
      } catch (e) {
        if (e instanceof ServiceError) {
          if (e.code === "DECISION_CONTACT_NOT_AUTHORIZED" || e.code === "NOT_FOUND") {
            return `No se puede anotar (${e.message}): su respuesta la da la persona o su representante legal. Díselo con amabilidad y, si hace falta, pasa el caso a una persona.`
          }
          return `No se anotó nada: ${e.message}.`
        }
        throw e
      }
      const made: ProposalItem[] = []
      const outcome = await propose("decidir_presupuesto", planned.payload, "anotar_respuesta_presupuesto", undefined, (proposal) => {
        made.push(proposal)
      })
      const proposal = made[0]
      if (proposal?.status !== "propuesta") return outcome
      ctx.confirmButtonsFor = proposal.id
      const question = budgetAnswerQuestion(planned.answer, await orgZone(), ctx.treatment ?? null)
      return `Propuesta ${proposal.id} creada; todavía no se anotó nada. Pregúntale con send_reply, con estas palabras o parecidas (el mensaje lleva los botones Sí y No): «${question}» Cuando diga que sí, usa confirmar_propuesta con ese id. Si corrige algo, vuelve a llamar a esta herramienta con la lista corregida: reemplaza a esta.`
    },
    {
      name: "anotar_respuesta_presupuesto",
      description:
        "Cuando la persona responde a su presupuesto por escrito («la 16 y la 26 ahora, la 36 después», «prefiero la opción de la corona»), prepara la lista para confirmarla con ella: no anota nada todavía. Con los ids de ver_presupuesto, una respuesta por cada tratamiento de la opción que eligió: aceptado, pospuesto si lo deja para después, o rechazado. Con varias opciones, indica optionId. Te devuelve la pregunta para pedirle el sí; con su sí, usa confirmar_propuesta.",
      schema: operationAgentSchema("presupuesto.respuesta"),
    },
  )

  /** Confirma con el sí de la persona: el de después de la propuesta o el que ya dio al elegir la hora. */
  const confirmById = async ({ proposalId }: { proposalId: string }, chosenMessageId?: string): Promise<string> => {
      if (ctx.dryRun) return `[SIMULACIÓN] Se confirmaría la propuesta ${proposalId}.`
      // Una cita del chat web se reserva cuando ya hay dónde avisarle; la propuesta sigue
      // esperando y se confirma esta misma, sin volver a proponerla (ADR 0097).
      if (await webchatNeedsContact()) {
        const target = await inOrg((tx) => getProposal(tx, ctx.orgId, proposalId)).catch(() => null)
        if (target?.action === "reservar_cita" && target.status === "propuesta") {
          return `Todavía no hay dónde avisarle de la cita. La propuesta ${proposalId} sigue esperando: pídele su WhatsApp o su correo. Cuando lo escriba, guárdalo con guardar_contacto y confirma esta misma propuesta con confirmar_propuesta; no la vuelvas a proponer.`
        }
      }
      // El sí se entiende por su intención (ADR 0023): «perfecto», «sí, gracias», «me sirve, ahí estaré».
      const pending = await inOrg((tx) => proposalReplyOf(tx, ctx.orgId, ctx.contactId, proposalId)).catch(() => null)
      const understoodMessageId =
        pending?.reply && (await understoodYes(ctx.decision, { proposed: pending.proposed, reply: pending.reply.body }))
          ? pending.reply.id
          : undefined
      let proposal: ProposalItem
      try {
        proposal = await inOrg((tx) =>
          confirmProposalByContact(tx, ctx.orgId, ctx.contactId, proposalId, {
            secretsKey: ctx.secretsKey,
            understoodMessageId,
            chosenMessageId,
          }),
        )
      } catch (e) {
        if (e instanceof ServiceError && e.code === "PROPOSAL_NOT_CONTACT_CONFIRMABLE") return e.message
        // Lo que el modelo lee se lo repite a la persona: nada de «confirmación explícita» ni de sistemas.
        if (e instanceof ServiceError && e.code === "PROPOSAL_NOT_CONFIRMED") {
          return "Su último mensaje no es un sí a esa cita. Pregúntale con naturalidad si se la reservas, sin hablar de confirmaciones, propuestas ni sistemas."
        }
        // Solo una cita de alguien nuevo propuesta antes del ADR 0109 (que se registraba con su sí) llega aquí.
        if (e instanceof ServiceError && e.code === "PROPOSAL_NOTICE_NOT_SENT") {
          return "Todavía no le llegó la pregunta con el aviso de privacidad: envíala con el enlace del aviso tal cual y espera su sí. No la des por reservada."
        }
        if (e instanceof ServiceError && e.code === "PROPOSAL_NOT_PENDING") {
          return "Esa cita ya no espera su sí: si ya quedó reservada, díselo con el día y la hora; si no, ofrécele horarios de nuevo. No hables de propuestas ni de sistemas."
        }
        throw e
      }
      if (proposal.status === "ejecutada") {
        if (proposal.action === "enviar_mensaje") ctx.replySettled = true
        // A quien le faltan datos se le da su enlace en la misma confirmación (no hay otro aviso de esta cita).
        // Quien se registró con este sí (ADR 0101) es el paciente que trae el resultado.
        const bookedFor = typeof proposal.payload.patientId === "string" ? proposal.payload.patientId : proposal.result?.patientId
        if (proposal.action === "reservar_cita" && typeof bookedFor === "string") {
          const patientId = bookedFor
          const appointmentId = typeof proposal.result?.appointmentId === "string" ? proposal.result.appointmentId : null
          const data = await inOrg((tx) =>
            bookedDataLink(
              tx,
              ctx.orgId,
              { contactId: ctx.contactId, patientId, appointmentId, always: proposal.result?.registered === true },
              { secretsKey: ctx.secretsKey },
            ),
          ).catch(() => null)
          if (data) {
            const why = data.missing.length ? `Al paciente le faltan datos para atenderlo (${data.missing.join(", ")})` : "Se acaba de registrar"
            return `Confirmado y ejecutado (id ${proposal.id}). ${why}: al confirmar la cita, añade en el mismo mensaje «Antes de venir, completa tus datos aquí (toma 2 minutos): ${data.url}». Escribe el enlace tal cual, sin cambiarlo.`
          }
        }
        return `Confirmado y ejecutado (id ${proposal.id}).`
      }
      if (proposal.status === "fallida") {
        const rawError = proposal.error?.trim() ?? ""
        if (rawError.startsWith("WINDOW_CLOSED") || proposal.result?.errorCode === "WINDOW_CLOSED") return outsideWindow()
        const detail = rawError ? `: ${rawError.slice(0, 300)}` : "."
        return `No se pudo ejecutar al confirmar (id ${proposal.id})${detail} Ofrece una alternativa o deriva a humano.`
      }
      if (proposal.status === "expirada") {
        return `La propuesta ${proposal.id} expiró (48h): pide de nuevo el acto al interlocutor para crear una nueva propuesta, no reintentes confirmar.`
      }
      return `Propuesta ${proposal.id} en estado ${proposal.status}.`
  }
  const confirmProposal = tool(
    (input: { proposalId: string }) => confirmById(input),
    {
      name: "confirmar_propuesta",
      description:
        "Confirma un acto en modo confirmar_usuario cuando el interlocutor lo aprobó con un sí explícito.",
      schema: z.object({ proposalId: z.string().uuid() }),
    },
  )
  // De cada cosa vale lo último que anota (ADR 0104): «mejor el jueves» reemplaza a «el martes».
  const noteCase = tool(
    async (input: Partial<Record<CaseSlot | "nota", string>>) => {
      const named = (Object.keys(CASE_SLOTS) as CaseSlot[]).filter((slot) => input[slot]?.trim())
      const free = input.nota?.trim()
      if (!named.length && !free) return "No se anotó nada: no venía ningún dato."
      if (ctx.dryRun) {
        return `[SIMULACIÓN] Se anotaría en el caso: ${[...named.map((slot) => `${CASE_SLOTS[slot]}: ${input[slot]}`), free].filter(Boolean).join(" · ")}`
      }
      await inOrg(async (tx) => {
        for (const slot of named) await addAgentCaseNote(tx, ctx.orgId, ctx.conversationId, input[slot] ?? "", slot)
        if (free) await addAgentCaseNote(tx, ctx.orgId, ctx.conversationId, free)
      })
      return "Anotado en el caso."
    },
    {
      name: "anotar_caso",
      description:
        "Anota lo que hará falta en los próximos mensajes de esta atención: para quién es, qué pide y qué prefiere. De cada cosa vale lo último que anotes: si cambia de opinión, vuelve a anotarla. Puede ir en el mismo paso que send_reply. No anotes datos clínicos ni lo que ya figura en el estado del caso.",
      schema: z.object({
        para_quien: z.string().min(2).max(160).optional().describe("Para quién es la cita o la consulta, con su nombre y vínculo si lo dijo («su hija Ana, de 8 años»)."),
        servicio: z.string().min(2).max(160).optional().describe("Qué pide, sin datos de salud («una consulta», «un control», «el precio de un servicio»)."),
        preferencia: z.string().min(2).max(160).optional().describe("Día, hora, sede o profesional que prefiere («mañanas, en Miraflores»)."),
        nota: z.string().min(3).max(300).optional().describe("Otra cosa que hará falta más adelante."),
      }),
    },
  )

  const rememberFact = tool(
    async ({ text, replacesId }: { text: string; replacesId?: string }) => {
      if (ctx.dryRun) return `[SIMULACIÓN] Se recordaría de esta persona: ${text}`
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
      patientId?: string | null
      serviceId?: string | null
      interestText?: string | null
      reason?: string
    }) => {
      if (ctx.dryRun) return `[SIMULACIÓN] Se propondría crear la oportunidad: ${input.title}.`
      const { reason, ...payload } = input
      return propose("crear_oportunidad", payload, "create_opportunity", reason)
    },
    {
      name: "create_opportunity",
      description:
        "Registra un interés concreto de la persona que no sea la pregunta por un servicio (eso lo anota el sistema solo): por ejemplo, una evaluación sin servicio definido. Nunca por un saludo. Nace en «Interesado» y, sin responsable, queda en Recepción. Si ya tiene abierta una del mismo interés, sigue con esa en vez de crear otra.",
      schema: operationAgentSchema("oportunidad.crear"),
    },
  )

  const updateFollowup = tool(
    async (input: { opportunityId?: string; nextActionAt?: string | null; nextActionNote?: string; reason?: string }) => {
      if (ctx.dryRun) return "[SIMULACIÓN] Se propondría dejar la tarea de la oportunidad."
      if (input.nextActionAt === undefined && input.nextActionNote === undefined) {
        return "Indica qué hay que hacer (nextActionNote) o cuándo (nextActionAt ISO)."
      }
      const chosen = await chooseOpportunity(input.opportunityId)
      if ("message" in chosen) return chosen.message
      const payload: Record<string, unknown> = { opportunityId: chosen.id }
      if (input.nextActionAt !== undefined) payload.nextActionAt = input.nextActionAt
      if (input.nextActionNote !== undefined) payload.nextActionNote = input.nextActionNote
      return propose("actualizar_seguimiento", payload, "update_followup", input.reason)
    },
    {
      name: "update_followup",
      description:
        "Deja o cambia la tarea de una oportunidad del contacto: su próxima acción, una sola. Si no das opportunityId y hay varias abiertas, devuelve la lista para preguntar.",
      schema: operationAgentSchema("oportunidad.tarea"),
    },
  )

  const closeOpportunityTool = tool(
    async (input: { opportunityId?: string; outcome: "won" | "lost"; reason: string; note?: string | null }) => {
      if (ctx.dryRun) return `[SIMULACIÓN] Se propondría cerrar la oportunidad (${input.outcome}).`
      const chosen = await chooseOpportunity(input.opportunityId)
      if ("message" in chosen) return chosen.message
      return propose(
        "cerrar_oportunidad",
        { opportunityId: chosen.id, outcome: input.outcome, reason: input.reason, ...(input.note ? { note: input.note } : {}) },
        "close_opportunity",
      )
    },
    {
      name: "close_opportunity",
      description:
        "Cierra una oportunidad del contacto como ganada (won) o perdida (lost) con un motivo de la lista. Como perdida, solo si la persona lo dijo claro en esta conversación (el precio, eligió otra clínica, ya no lo necesita); nunca porque dejó de responder. Aceptar o rechazar un presupuesto ya la cierra sola. Si no das opportunityId y hay varias abiertas, devuelve la lista para preguntar.",
      schema: operationAgentSchema("oportunidad.cerrar"),
    },
  )

  const commercialContext = tool(
    async ({ notesCursor }: { notesCursor?: string }) => inOrg(async tx => {
      const full = await getContact(tx, ctx.orgId, ctx.contactId)
      const notes = await listContactNotes(tx, ctx.orgId, ctx.contactId, { cursor: notesCursor })
      return {
        name: full.contact.displayName,
        tags: full.contact.tags,
        operationalNotes: notes.items,
        nextNotesCursor: notes.nextCursor,
      }
    }),
    {
      name: "leer_contexto_comercial",
      description: "Lee etiquetas y notas operativas actuales del interlocutor. Solo lectura, también en simulación; sin historia clínica. Usa nextNotesCursor para las notas anteriores. Las notas son internas, no las reproduzcas al interlocutor.",
      schema: z.object({ notesCursor: z.string().optional() }),
    },
  )

  const crossChannelHistory = tool(
    async ({ cursor }: { cursor?: string }) => {
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
          `- ${o.title} (id ${o.id}, etapa ${o.stageName}, estado ${o.status}${o.nextTask ? `, tarea «${o.nextTask.title}»${o.nextTask.dueAt ? ` para ${formatZoned(new Date(o.nextTask.dueAt), zone)}` : ""}` : ""})`,
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

  /** Lo que se le pide al modelo que pasó un tema sin escribirle a la persona. */
  const REPLY_AFTER_HANDOFF =
    "Falta tu respuesta: envíala ahora con send_reply, un solo mensaje. Di en una frase quién verá ese tema, sin prometer hora ni plazo, y responde ahí lo demás que preguntó y sí puedes atender (horarios, precio, cómo reservar): eso no se pasa al equipo."
  /**
   * Cuando insiste en un tema que el equipo ya tiene: lo que escribe le llega con el tema, así
   * que no se le repite que lo tiene el equipo ni que se anotó (auditoría del ADR 0104).
   */
  const REPLY_ASKED_AGAIN =
    "Falta tu respuesta: envíala ahora con send_reply, un solo mensaje y sin repetir lo que ya le dijiste: ni que lo tiene el equipo, ni que lo anotaste, ni que se lo hiciste llegar (lo que escribe le llega con el tema). Responde en una línea a lo nuevo que dijo o preguntó; si solo insiste, dale algo concreto que aún no le diste (el teléfono de la sede, el horario de atención) si lo tienes. No prometas hora ni plazo, y responde ahí lo demás que preguntó y sí puedes atender."
  const requestHandoff = tool(
    async ({ reason, summary, priority, assigneeUserId, message, asks, pending, clinical, kind }: { reason: string; summary?: string; priority?: string; assigneeUserId?: string; message?: string; asks?: string; pending?: string; clinical?: boolean; kind?: string }) => {
      // El aviso a la persona sigue el mismo formato del canal que cualquier respuesta.
      const notice = message?.trim() ? formatForChannel(message.trim(), await conversationChannel(ctx), { emojis: ctx.emojis }) : undefined
      // Antes de registrar nada: el aviso en otro idioma o en otro trato se vuelve a pedir.
      const mismatch = notice ? (wrongLanguage(notice) ?? wrongTreatment(notice) ?? (await unsavedContact(notice)) ?? formulaAgain(notice)) : null
      if (mismatch) return askRewrite(mismatch)
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
        const outcome = await propose("enviar_mensaje", { kind: "text", text: await withAgenda(notice) }, "request_human_handoff")
        await annotate(ctx.replySettled === true)
        return ctx.replySettled
          ? "Aviso al interlocutor registrado. No envíes más mensajes."
          : `El aviso al interlocutor no salió: ${outcome}`
      }
      const validPriority = priority === "alta" || priority === "baja" ? priority : "media"
      // Con un tema abierto en el hilo, lo que vuelve a pedir se anota en ese
      // tema y solo sale el aviso: un tema por mensaje llena la cola del equipo.
      // Abre otro solo si sube a urgente (ADR 0097).
      const open = await inOrg((tx) => latestOpenTopic(tx, ctx.orgId, ctx.conversationId, { kind: clinical === true ? "clinico" : topicKindOf(kind) }))
      if (open && !(validPriority === "alta" && open.priority !== "alta")) {
        const again = await inOrg((tx) => recordTopicAskedAgain(tx, ctx.orgId, { handoffId: open.id, messageId: ctx.triggerId ?? null }))
        ctx.handedOff = true
        ctx.handoffId = open.id
        const raised = again.raised ? " Como ya preguntó varias veces, ese tema quedó como urgente para el equipo: díselo." : ""
        if (!notice) {
          ctx.handoffNeedsReply = true
          // Lo que trae sobre qué pide o qué falta se guarda aunque el aviso salga después.
          await annotate(false)
          return `Ese tema ya lo tiene el equipo${again.noted ? " y lo que volvió a decir quedó anotado en él" : ""}.${raised} ${REPLY_ASKED_AGAIN}`
        }
        const outcome = await propose("enviar_mensaje", { kind: "text", text: await withAgenda(notice) }, "request_human_handoff")
        await annotate(ctx.replySettled === true)
        return ctx.replySettled ? `Ese tema ya lo tiene el equipo: ${again.noted ? "lo anoté en él y salió" : "salió"} el aviso. No envíes más mensajes.` : `El aviso al interlocutor no salió: ${outcome}`
      }
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
          sourceMessageId: ctx.triggerId,
          clinical: clinical === true,
          kind: topicKindOf(kind),
        }),
      )
      ctx.handedOff = true
      ctx.handoffId = handoff.id
      const destino = handoff.assigneeUserId ? "con responsable asignado" : "en la cola del equipo por recoger"
      // El aviso sale después de crear la derivación: si esta falla, no se le
      // promete al interlocutor una atención que nadie registró.
      if (!notice) {
        ctx.handoffNeedsReply = true
        return `Tema pasado al equipo (${destino}). ${REPLY_AFTER_HANDOFF}`
      }
      const outcome = await propose("enviar_mensaje", { kind: "text", text: await withAgenda(notice) }, "request_human_handoff")
      const noticeResult = ctx.replySettled ? " Aviso al interlocutor registrado." : ` El aviso al interlocutor no salió: ${outcome}`
      if (ctx.replySettled) await annotate(true)
      return `Tema pasado al equipo (${destino}).${noticeResult} No envíes nada más por este mensaje; en los siguientes sigues atendiendo todo lo demás.`
    },
    {
      name: "request_human_handoff",
      description:
        "Pasa al equipo lo que tú no puedes responder (una duda clínica, un descuento, un reclamo, que pida hablar con una persona) como un tema. No la uses porque cuente un síntoma y quiera que lo atiendan (un dolor, un sangrado, una hinchazón): eso es una cita, ofrécele los horarios más próximos. Va como un tema, con motivo, resumen factual y prioridad (alta/media/baja). No te apaga: en los siguientes mensajes sigues atendiendo todo lo demás, pero nunca respondes ese tema. Termina con este mensaje: pon en message el aviso breve de quién lo verá, sin prometer una hora ni un plazo, y, si en el mismo mensaje preguntó otra cosa que sí sabes, respóndela ahí también.",
      schema: operationAgentSchema("derivacion.crear"),
    },
  )

  const saveContact = tool(
    async ({ whatsapp, email }: { whatsapp?: string; email?: string }) => {
      if (ctx.dryRun) return "[SIMULACIÓN] Se guardaría dónde avisarle."
      if ((await conversationChannel(ctx)) !== "webchat") return "Solo sirve en el chat de la web: en este canal ya tienes cómo responderle."
      try {
        const saved = await inOrg((tx) => saveWebchatContactForConversation(tx, ctx.orgId, ctx.conversationId, { whatsapp: whatsapp ?? null, email: email ?? null }))
        ctx.contactOnFile = true
        await noteAction("datos", "guardó dónde avisarle")
        const where = [saved?.whatsapp ? `WhatsApp ${saved.whatsapp}` : null, saved?.email ? `correo ${saved.email}` : null].filter(Boolean).join(" y ")
        return `Guardado: le avisaremos por ${where || "lo que dejó"}. Si ya dijo que sí a una cita propuesta, confírmala ahora con confirmar_propuesta (la del «Estado del caso»); si no, pídele su sí.`
      } catch (error) {
        if (error instanceof ServiceError) {
          // «Ya tenemos cómo avisarte»: quien es paciente o escribe por otro canal (`saveVisitorContact`).
          // Decírselo no es afirmar algo que no consta.
          if (error.code === "WEBCHAT_CONTACT_KNOWN") ctx.contactOnFile = true
          return `No se guardó: ${error.message} Díselo con esas palabras y pídeselo de nuevo.`
        }
        throw error
      }
    },
    {
      name: "guardar_contacto",
      description:
        "En el chat de la web, guarda el WhatsApp o el correo que la persona escribió para avisarle (de su cita o de lo que tenga el equipo). Úsala apenas lo escriba; no lo inventes ni lo completes.",
      schema: z.object({
        whatsapp: z.string().max(40).optional().describe("El número tal como lo escribió, con su código de país si lo dio."),
        email: z.string().max(320).optional().describe("El correo tal como lo escribió."),
      }),
    },
  )

  const rememberTopic = tool(
    async ({ tema_id }: { tema_id: string }) => {
      if (ctx.dryRun) return "[SIMULACIÓN] Se anotaría que volvió a preguntar y se avisaría a quien tiene el tema."
      const result = await inOrg((tx) =>
        recordTopicAskedAgain(tx, ctx.orgId, { handoffId: tema_id, messageId: ctx.triggerId }),
      ).catch(() => null)
      if (!result) return "Ese tema ya no está abierto: revisa el «Estado del caso» y responde con lo que haya."
      if (!result.noted) return "No hace falta anotarlo: no pide nada nuevo. Si ya le dijiste quién tiene su consulta, no se lo repitas. Sin prometer una hora; no respondas el tema tú."
      if (result.raised) return "Anotado: como ya preguntó varias veces, su tema quedó como urgente para el equipo. Díselo en una frase, sin prometer una hora; no respondas el tema tú."
      // Lo que ya sabe no se le repite (auditoría del ADR 0104): era la falla de fluidez más común.
      return result.assigneeName
        ? `Anotado y avisado a ${result.assigneeName}. Si aún no le dijiste quién tiene su consulta, díselo; si ya se lo dijiste, no se lo repitas: reconoce en una línea lo nuevo que dijo. Sin prometer una hora; no respondas el tema tú.`
        : "Anotado: el equipo lo verá. Si ya le dijiste que lo tiene el equipo, no se lo repitas: reconoce en una línea lo nuevo que dijo y, si quiere hablar ya con alguien, dale el teléfono de la sede si figura. Sin prometer una hora; no respondas el tema tú."
    },
    {
      name: "recordar_tema",
      description:
        "Úsala cuando la persona vuelve a preguntar por un tema que tiene el equipo («¿y lo del descuento?»): lo anota en el tema y avisa a quien lo tiene. Después respóndele con send_reply sin repetirle el aviso que ya recibió: reconoce lo nuevo que dijo, sin prometer una hora y sin responder el tema. No la uses si la persona habla de otra cosa.",
      schema: z.object({ tema_id: z.string().uuid().describe("El id del tema, de «Temas con el equipo».") }),
    },
  )

  const all = [
    sendReply,
    farewellAndClose,
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
    portalReentry,
    proposeBooking,
    bookNewPatient,
    rescheduleAppointment,
    cancelAppointmentProposal,
    confirmAppointment,
    answerPermission,
    chooseMessages,
    budgetsView,
    resendBudget,
    sendReceipt,
    answerBudget,
    confirmProposal,
    noteCase,
    rememberFact,
    requestHandoff,
    rememberTopic,
    saveContact,
  ]
  const tools = all.filter(
    (candidate) =>
      !ctx.excludedTools?.includes(candidate.name) &&
      // Sin dirección pública configurada no hay página que abrir.
      (candidate.name !== "enviar_enlace_cita" || Boolean(ctx.publicUrl) || ctx.dryRun),
  )
  toolNames = new Set(tools.map((candidate) => candidate.name))
  return tools
}
