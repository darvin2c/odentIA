/** Etiquetas en español para las acciones del agente autónomo. */
export const ACTION_LABEL: Record<string, string> = {
  reservar_cita: "Reservar cita",
  reprogramar_cita: "Reprogramar cita",
  cancelar_cita: "Cancelar cita",
  enviar_mensaje: "Enviar mensaje",
  mover_oportunidad: "Cambiar etapa comercial",
  crear_oportunidad: "Crear oportunidad",
  actualizar_seguimiento: "Programar seguimiento",
  cerrar_oportunidad: "Cerrar oportunidad",
}

export interface AgentProposal {
  id: string
  conversationId: string | null
  contactId: string | null
  action: string
  mode: "directo" | "confirmar_usuario" | "aprobar_equipo"
  status: string
  payload: Record<string, unknown>
  /** Texto que el equipo aprobó cuando cambió el borrador de un mensaje. */
  editedText?: string | null
  reason: string | null
  result: Record<string, unknown> | null
  error: string | null
  decidedAt: string | null
  executedAt: string | null
  createdAt: string
  context: {
    contactName: string | null
    patientName: string | null
    channel: string | null
    branchName: string | null
    dentistName: string | null
    opportunityTitle: string | null
    beforeSummary: string | null
    afterSummary: string
    /** Foto vigente del caso según ProposalLifecycle; null si ya no aplica. */
    currentSummary?: string | null
    /** La foto al proponer quedó obsoleta frente al estado del caso. */
    isStale?: boolean
  }
}

/**
 * Mensaje legible del fallo de una propuesta: quita el prefijo `CODE: ` solo
 * cuando `result.errorCode` lo acredita; el resto del texto llega tal cual.
 */
export function proposalErrorMessage(proposal: Pick<AgentProposal, "error" | "result">): string | null {
  const { error, result } = proposal
  if (!error) return null
  const code = result !== null && typeof result.errorCode === "string" ? result.errorCode : null
  if (code !== null && error.startsWith(`${code}: `)) return error.slice(code.length + 2)
  return error
}

export interface AgentHandoff {
  id: string
  conversationId: string | null
  contactName: string | null
  channel: string | null
  reason: string
  summary: string
  priority: string
  /** Qué pide la persona, en una frase, si quien derivó lo dejó escrito. */
  asks: string | null
  /** Lo que falta preguntar o hacer. */
  pending: string | null
  /** El aviso que recibió la persona al pasar su caso. */
  notice: string | null
  assigneeUserId: string | null
  taskId: string | null
  /** Plazo de recogida/resolución según la prioridad. */
  dueAt: string | null
  /** abierta | tomada | resuelta (derivado de su tarea). */
  status: "abierta" | "tomada" | "resuelta"
  createdAt: string
}

/** Resumen ligero del panel del agente (legible con agent.decide). */
export interface AgentPanelSummary {
  enabled: boolean
  /** Pendientes que el equipo puede decidir. */
  pendingProposals: number
  /** Pendientes que esperan al interlocutor; se ven, no se deciden. */
  awaitingContact: number
  openHandoffs: number
  /** Corridas de hoy que respondieron o derivaron. */
  interventionsToday: number
  /** Corridas de hoy con error o sin respuesta. */
  failedToday: number
  locale: string
  timezone: string
}

/** Actividad legible del agente: qué envió, propuso o derivó. */
export interface AgentActivityItem {
  id: string
  kind: "mensaje" | "propuesta" | "derivacion"
  at: string
  conversationId: string | null
  contactName: string | null
  title: string
  detail: string | null
  /** Estado de la propuesta/derivación o, en mensajes, de su entrega. */
  status: string | null
}

/**
 * Desenlace de una aprobación, para no afirmar más de lo ocurrido: ejecutar
 * `enviar_mensaje` solo encola el mensaje; su entrega se ve en el hilo.
 */
export function approvalOutcomeMessage(proposal: Pick<AgentProposal, "status" | "result">): string {
  if (proposal.status === "ejecutada") {
    return typeof proposal.result?.messageId === "string"
      ? "Aprobado. El mensaje quedó encolado; revisa su entrega en el hilo."
      : "Cambio aprobado y ejecutado."
  }
  if (proposal.status === "aprobada") return "Aprobado; pendiente de ejecutar. Sigue su estado en Aprobaciones."
  return `La propuesta quedó ${proposal.status}.`
}

/** Permiso operativo que exige decidir cada acto, además de `agent.decide`. */
export function permissionForAction(
  action: string,
): "conversations.write" | "appointments.write" | "crm.write" {
  if (action === "enviar_mensaje") return "conversations.write"
  if (["reservar_cita", "reprogramar_cita", "cancelar_cita"].includes(action))
    return "appointments.write"
  return "crm.write"
}

/** De dónde salió un dato de una respuesta del agente. */
export interface AnswerBasisItem {
  kind: string
  label: string
  detail?: string
  /** Id de lo consultado cuando se puede abrir (la lección aplicada). */
  ref?: string
}

/** Comprobación de un precio, fecha u hora de la respuesta contra lo consultado. */
export interface AnswerCheck {
  kind: "precio" | "hora" | "fecha"
  value: string
  ok: boolean
  source: string | null
}

/** En qué se basó una respuesta del agente. */
export interface AnswerTrace {
  id: string
  conversationId: string
  /** Mensaje del hilo al que corresponde; nulo si la respuesta no llegó a salir. */
  messageId: string | null
  proposalId: string | null
  agent: string
  outcome: "enviada" | "pendiente" | "bloqueada" | "fallida"
  /** Lo que escribió la persona y originó la respuesta. */
  question: string | null
  replyText: string
  basis: AnswerBasisItem[]
  checks: AnswerCheck[]
  model: string | null
  createdAt: string
}

export const ANSWER_CHECK_LABEL: Record<AnswerCheck["kind"], string> = {
  precio: "Precio",
  hora: "Hora",
  fecha: "Fecha",
}

/* ---------- Fichas de los agentes, niveles y resumen ---------- */

export interface AgentFunction {
  id: string
  label: string
  description: string
  fixed: boolean
  tools: string[]
  steps?: string[]
  whenOff?: string
  offNote?: string
  /** Operaciones que la función puede llenar, con sus campos (misma declaración que la pantalla). */
  fills: Array<{ operation: string; label: string; fields: Array<{ name: string; label: string; description: string; required: boolean }> }>
}

export interface AgentRole {
  id: "recepcion" | "asistente_clinico" | "asesor" | "ayuda"
  name: string
  audience: string
  role: string
  available: boolean
  switchable: boolean
  functions: AgentFunction[]
  sees: string
  notSees: string
  never: string
  confirms: string
  learnsFrom: string
}

export type AgentLevelId = "supervisado" | "equilibrado" | "autonomo"

export interface AgentLevel {
  id: AgentLevelId
  label: string
  summary: string
}

export interface AgentRoles {
  principles: string[]
  roles: AgentRole[]
  levels: AgentLevel[]
}

export interface AgentOutcomes {
  attended: number
  passed: number
  alone: number
  booked: number
}

export interface AgentOverview {
  enabled: boolean
  level: AgentLevelId | "personalizado"
  needsYou: { approvals: number; gaps: number; basicsMissing: number; review: number; lessons: number }
  today: AgentOutcomes
  week: AgentOutcomes
  knows: { answers: number; servicesWithPrice: number; branches: number; basicsCovered: number; basicsTotal: number }
  readiness: { channels: string[]; receivers: string[]; sandboxTurns: number }
  usage: { runsToday: number; dailyRunLimit: number }
}

export const LEVEL_LABEL: Record<AgentOverview["level"], string> = {
  supervisado: "Supervisado",
  equilibrado: "Equilibrado",
  autonomo: "Autónomo",
  personalizado: "Personalizado",
}

/** Estado de una conversación de prueba; el servidor lo devuelve y vuelve tal cual en el turno siguiente. */
export type SandboxState = Record<string, unknown>

export interface SandboxResult {
  reply: string
  replied: boolean
  handedOff: boolean
  toolsUsed: string[]
  basis: AnswerBasisItem[]
  checks: AnswerCheck[]
  did: string[]
  waiting: string[]
  state: SandboxState
  model: string
  latencyMs: number
}

/** Cómo sonaría el saludo con la voz configurada: una vista previa, no una respuesta del modelo. */
export function voicePreview(input: {
  personaName: string | null
  treatment: "tu" | "usted" | null
  tone: "cercano" | "neutro" | "formal"
  clinicName: string
}): string {
  const who = input.personaName?.trim()
    ? `Soy ${input.personaName.trim()}, asistente virtual de ${input.clinicName}.`
    : `Soy el asistente virtual de ${input.clinicName}.`
  const formal = input.treatment === "usted"
  if (input.tone === "formal") return `Buenos días. ${who} ¿En qué ${formal ? "puedo ayudarle" : "puedo ayudarte"}?`
  if (input.tone === "neutro") return `Hola. ${who} ¿En qué ${formal ? "le ayudo" : "te ayudo"}?`
  return `¡Hola! ${who} ¿En qué ${formal ? "le ayudo" : "te ayudo"}?`
}

/** Minutos del día ↔ «HH:MM», para el horario en que responde el agente. */
export function minutesToClock(minutes: number): string {
  const safe = Math.max(0, Math.min(1440, minutes)) % 1440
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`
}

export function clockToMinutes(clock: string): number | null {
  const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(clock.trim())
  if (!match) return null
  const minutes = Number(match[1]) * 60 + Number(match[2])
  return minutes >= 0 && minutes < 1440 ? minutes : null
}

/* ---------- Aprender: por revisar, lecciones y casos de prueba ---------- */

export type ReviewReason = "equipo_tomo" | "repitio_pregunta" | "muestra" | "marcada" | "editada"

export interface ReviewItem {
  id: string
  agent: string
  conversationId: string
  traceId: string
  reason: ReviewReason
  question: string
  reply: string
  teamReply: string | null
  status: "pendiente" | "bien" | "corregida"
  contactName: string | null
  channel: string | null
  basis: AnswerBasisItem[]
  checks: AnswerCheck[]
  createdAt: string
}

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  equipo_tomo: "El equipo tomó la conversación",
  repitio_pregunta: "El paciente repitió la pregunta",
  muestra: "Muestra al azar",
  marcada: "La marcó alguien de tu equipo",
  editada: "El equipo cambió el borrador",
}

export type CorrectionFailure = "dato_equivocado" | "falto_dato" | "tono" | "no_debio_responder" | "otra_cosa"

export const FAILURE_OPTIONS: Array<{ value: CorrectionFailure; label: string }> = [
  { value: "dato_equivocado", label: "Dato equivocado" },
  { value: "falto_dato", label: "Le faltó un dato" },
  { value: "tono", label: "El tono" },
  { value: "no_debio_responder", label: "No debió responder" },
  { value: "otra_cosa", label: "Debió hacer otra cosa" },
]

export type LessonKind = "respuesta_oficial" | "regla" | "ejemplo"

export const LESSON_KIND_LABEL: Record<LessonKind, string> = {
  respuesta_oficial: "Respuesta oficial",
  regla: "Regla",
  ejemplo: "Ejemplo",
}

/** A quién se aplica una lección, dicho para la clínica. */
export function lessonScopeLabel(scope: string): string {
  if (scope === "clinica") return "Toda la clínica"
  if (scope === "recepcion") return "Solo Recepción"
  if (scope === "asistente_clinico") return "Solo el Asistente clínico"
  if (scope === "asesor") return "Solo el Asesor"
  return scope
}

export interface LessonItem {
  id: string
  kind: LessonKind
  scope: string
  title: string
  question: string
  body: string
  failure: CorrectionFailure | null
  originalReply: string
  status: "propuesta" | "activa" | "retirada" | "descartada"
  conversationId: string | null
  knowledgeEntryId: string | null
  knowledgeEntry: { title: string; body: string } | null
  previousBody: string | null
  uses: number
  lastUsedAt: string | null
  proposedByName: string | null
  approvedByName: string | null
  approvedAt: string | null
  withdrawnAt: string | null
  createdAt: string
}

export interface LessonImpact {
  total: number
  touched: Array<{ id: string; question: string; expected: string }>
}

export interface LearningOverview {
  review: ReviewItem[]
  proposed: Array<LessonItem & { impact: LessonImpact }>
  learned: LessonItem[]
  withdrawn: LessonItem[]
  cases: number
}

export interface LessonPreview {
  cases: Array<{ question: string; expected: string | null; before: string; after: string; same: boolean }>
  total: number
  touched: number
  model: string
}

/** «23 quedan igual y 1 puede cambiar», a partir de a cuántos casos toca la lección. */
export function impactSummary(impact: LessonImpact): string {
  if (impact.total === 0) return "Todavía no tienes casos de prueba: este será de los primeros."
  const touched = impact.touched.length
  const rest = impact.total - touched
  if (impact.total === 1) return touched === 0 ? "Tu caso de prueba no toca este tema: queda igual." : "Tu caso de prueba toca este tema y puede cambiar."
  if (touched === 0) return `Ninguno de tus ${impact.total} casos de prueba toca este tema: quedan igual.`
  return `De tus ${impact.total} casos de prueba, ${touched} ${touched === 1 ? "toca este tema y puede cambiar" : "tocan este tema y pueden cambiar"}; ${rest} ${rest === 1 ? "queda igual" : "quedan igual"}.`
}
