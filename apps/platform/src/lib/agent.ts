
/**
 * La urgencia de un caso que pasó al equipo, en una palabra. La insignia
 * (`HandoffUrgency`) le suma icono y color; donde no cabe, va la palabra sola.
 */
export const URGENCY_WORDS = { alta: "Ahora", media: "Hoy", baja: "Sin apuro" } as const

export function urgencyWord(priority: string): string {
  return URGENCY_WORDS[priority as keyof typeof URGENCY_WORDS] ?? URGENCY_WORDS.media
}

/**
 * Lo que el agente le pasa al equipo tiene un solo nombre (decisión 1 de la
 * fase 2): cada fila dice «Te lo pasó el agente» (Inicio, Bandeja, panel,
 * Tareas) y la lista se llama «Casos del agente». La urgencia es siempre
 * «Ahora / Hoy / Sin apuro». En el código sigue llamándose handoff.
 */
export const AGENT_CASE_ROW = "Te lo pasó el agente"
export const AGENT_CASES_TITLE = "Casos del agente"

/** Etiquetas en español para las acciones del agente autónomo. */
export const ACTION_LABEL: Record<string, string> = {
  reservar_cita: "Reservar cita",
  reprogramar_cita: "Reprogramar cita",
  cancelar_cita: "Cancelar cita",
  enviar_mensaje: "Enviar mensaje",
  mover_oportunidad: "Cambiar etapa comercial",
  crear_oportunidad: "Crear oportunidad",
  actualizar_seguimiento: "Dejar la tarea de una oportunidad",
  cerrar_oportunidad: "Cerrar oportunidad",
  decidir_presupuesto: "Anotar la respuesta a un presupuesto",
}

export interface AgentProposal {
  id: string
  conversationId: string
  contactId: string | null
  action: string
  /** Quién dice que sí: nadie (directo) o el interlocutor en el hilo. Ninguna espera al equipo. */
  mode: "directo" | "confirmar_usuario"
  status: string
  payload: Record<string, unknown>
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
  /** Propuestas que esperan el sí del interlocutor; se ven, el equipo no las decide. */
  awaitingContact: number
  /** Citas propuestas que esperan el sí de la persona: el número de «Esperan su sí». */
  awaitingAnswer: number
  /** Casos que el agente pasó a una persona y siguen sin resolver: lo que espera al equipo. */
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

/** Permiso operativo que exige decidir cada acto, además de `agent.decide`. */
export function permissionForAction(
  action: string,
): "conversations.write" | "appointments.write" | "budgets.decide" | "crm.write" {
  if (action === "enviar_mensaje") return "conversations.write"
  // La misma regla que la API: anotar una respuesta es decidir el presupuesto.
  if (action === "decidir_presupuesto") return "budgets.decide"
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
  id: "recepcion" | "asistente_clinico" | "administrador" | "ayuda"
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
  /** Cómo trabaja hoy, de quién es lo que aprende, con qué se prueba y lo que aún no existe. */
  behaves?: string
  testedWith?: string
  learningOwner?: string
  later?: string
  learnsLater?: string
}

export interface AgentRoles {
  principles: string[]
  roles: AgentRole[]
}

export interface AgentOutcomes {
  attended: number
  /** Tres tramos que suman `attended`: corregidas, pasadas a una persona y las que llevó sola. */
  corrected: number
  passed: number
  alone: number
  booked: number
}

/** Lo aprobado en la semana que sigue vigente; `latest` es la última lección aprobada. */
export interface AgentLearned {
  officialAnswers: number
  rules: number
  examples: number
  latest: { title: string; approvedByName: string | null; approvedAt: string } | null
}

/** Clase del problema del proveedor del modelo; nunca su texto. */
export type AgentProviderProblem = "rechazado" | "sin_saldo" | "sin_configurar"

/**
 * La cuenta del modelo es de odentIA (ADR 0052): la clínica no puede
 * arreglar una clave, un saldo o un rechazo, así que nunca ve cuál fue. Se
 * dice qué pasa con los mensajes y que odentIA ya lo sabe (el caso
 * automático en Soporte lleva el motivo técnico).
 */
export const AGENT_MODEL_DOWN = {
  title: "El agente no puede responder ahora",
  body: "Los mensajes pasan a tu equipo. Ya avisamos a odentIA.",
  /** En una línea: «El agente no puede responder ahora: los mensajes pasan a tu equipo. Ya avisamos a odentIA.» */
  line: "El agente no puede responder ahora: los mensajes pasan a tu equipo. Ya avisamos a odentIA.",
} as const

/**
 * «El modelo responde» (`GET /api/agent/model`). El servidor lo guarda 10
 * minutos; nunca entrega el motivo técnico.
 */
export interface AgentModelStatus {
  responds: boolean
  checkedAt: string
}

export const MODEL_CHECK_TEXT = {
  checking: "Comprobando el modelo…",
  down: "El modelo de odentIA no responde ahora. Ya avisamos a odentIA y te escribimos cuando vuelva.",
  unreachable: "No pudimos comprobar el modelo. Revisa tu conexión y vuelve a intentarlo.",
} as const

export interface AgentOverview {
  enabled: boolean
  needsYou: { gaps: number; basicsMissing: number; review: number; lessons: number }
  today: AgentOutcomes
  week: AgentOutcomes
  learned: AgentLearned
  /** El último intento de usar el modelo falló por el proveedor (`at`: cuándo); `null` si responde. */
  provider: { problem: AgentProviderProblem | null; at: string | null }
  knows: { answers: number; servicesWithPrice: number; branches: number; basicsCovered: number; basicsTotal: number }
  readiness: { channels: string[]; receivers: string[]; sandboxTurns: number }
  usage: { runsToday: number; dailyRunLimit: number }
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
  emojis?: "no" | "pocos"
  clinicName: string
}): string {
  const who = input.personaName?.trim()
    ? `Soy ${input.personaName.trim()}, asistente virtual de ${input.clinicName}.`
    : `Soy el asistente virtual de ${input.clinicName}.`
  const formal = input.treatment === "usted"
  const emoji = input.emojis === "pocos" ? " 😊" : ""
  if (input.tone === "formal") return `Buenos días.${emoji} ${who} ¿En qué ${formal ? "puedo ayudarle" : "puedo ayudarte"}?`
  if (input.tone === "neutro") return `Hola.${emoji} ${who} ¿En qué ${formal ? "le ayudo" : "te ayudo"}?`
  return `¡Hola!${emoji} ${who} ¿En qué ${formal ? "le ayudo" : "te ayudo"}?`
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

export type ReviewReason = "equipo_tomo" | "repitio_pregunta" | "muestra" | "marcada"

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
  if (scope === "administrador") return "Solo el Administrador"
  return scope
}

/** De dónde sale una lección: una corrección o una respuesta que se dio por buena. */
export type LessonOrigin = "correccion" | "respuesta_buena"

export interface LessonItem {
  id: string
  kind: LessonKind
  scope: string
  /** El agente cuya respuesta la originó. */
  agent: string
  origin: LessonOrigin
  /** Quien recibió la respuesta que la originó. */
  contactName: string | null
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
  /** Cuántas reglas de un agente le llegan como mucho; pasado el tope, las más antiguas no le llegan. */
  ruleLimit: number
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

const AGENT_NAME: Record<string, string> = {
  recepcion: "Recepción",
  asistente_clinico: "Asistente clínico",
  clinico: "Asistente clínico",
  administrador: "Administrador",
  ayuda: "Ayuda",
}

/** Nombre del agente para la clínica; un identificador desconocido se muestra tal cual. */
export function agentName(agent: string): string {
  return AGENT_NAME[agent] ?? agent
}

/** Alcance de una lección como etiqueta corta: «Toda la clínica» o el agente. */
export function lessonScopeChip(scope: string): string {
  return scope === "clinica" ? "Toda la clínica" : agentName(scope)
}

/** Alcance de una lección como frase: «Para toda la clínica» o «Solo para Recepción». */
export function lessonScopeFor(scope: string): string {
  return scope === "clinica" ? "Para toda la clínica" : `Solo para ${agentName(scope)}`
}

const UNUSED_AFTER_MS = 30 * 86_400_000

/**
 * Cuánto se usa una lección activa. «Sin usar en 30 días» solo se dice cuando
 * las fechas lo respaldan: su último uso —o su aprobación, si nunca se usó—
 * tiene 30 días o más.
 */
export function lessonUsage(lesson: Pick<LessonItem, "kind" | "uses" | "lastUsedAt" | "approvedAt">, now = Date.now()): { text: string; stale: boolean } {
  const since = lesson.lastUsedAt ?? lesson.approvedAt
  if (since && now - Date.parse(since) >= UNUSED_AFTER_MS) return { text: "Sin usar en 30 días", stale: true }
  if (lesson.uses === 0) return { text: "Sin usar todavía", stale: false }
  const times = `${lesson.uses} ${lesson.uses === 1 ? "vez" : "veces"}`
  return { text: lesson.kind === "regla" ? `Aplicada ${times}` : lesson.kind === "ejemplo" ? `Usado ${times}` : `Usada ${times}`, stale: false }
}

/**
 * Resultado de probar una lección, contado. Solo se vuelven a responder las
 * preguntas que tocan su tema; los demás casos de prueba no reciben nada
 * distinto y cuentan como iguales.
 */
export function previewCounts(preview: LessonPreview): { total: number; same: number; changed: number; answered: number } {
  const changed = preview.cases.filter((item) => !item.same).length
  const total = preview.cases.length + Math.max(0, preview.total - preview.touched)
  return { total, same: total - changed, changed, answered: preview.cases.length }
}

/** «22 responden igual y 2 cambian.» */
export function previewSummary(counts: { same: number; changed: number }): string {
  const same = `${counts.same} ${counts.same === 1 ? "responde igual" : "responden igual"}`
  const changed = `${counts.changed} ${counts.changed === 1 ? "cambia" : "cambian"}`
  if (counts.changed === 0) return counts.same === 1 ? "Responde igual." : `Las ${counts.same} responden igual.`
  if (counts.same === 0) return counts.changed === 1 ? "Cambia." : `Las ${counts.changed} cambian.`
  return `${same} y ${changed}.`
}

/* ---------- Página de un agente: casos de prueba e indicaciones una por una ---------- */

/** Caso de prueba: una pregunta con la respuesta que una persona dio por buena. */
export interface TestCaseItem {
  id: string
  agent: string
  question: string
  expected: string
  lessonId: string | null
  status: "activo" | "retirado"
  createdAt: string
}

/** Una línea de «Lo que el agente debe saber» (decisión 24), como la entrega `/api/agent/learning/guidance`. */
export interface GuidanceItem {
  id: string
  body: string
  source: "escrita" | "aprendida"
  /** Escrita: quién la escribió. Aprendida: quién la aprobó. */
  byName: string | null
  at: string
  conversationId: string | null
  contactName: string | null
}

export interface GuidanceList {
  items: GuidanceItem[]
  counts: { all: number; escrita: number; aprendida: number }
}

export const GUIDANCE_KEY = ["agent-guidance"] as const

/** Una cita que el agente propuso y espera el sí de la persona (`/api/agent/awaiting`). */
export interface AwaitingAnswerItem {
  id: string
  conversationId: string
  contactId: string | null
  contactName: string | null
  channel: string | null
  action: "reservar_cita" | "reprogramar_cita" | "cancelar_cita"
  /** «Le propuse el jueves 22 a las 16:30 con la Dra. Rojas». */
  text: string
  createdAt: string
  /** El horario se ocupó (o la cita cambió) mientras esperaba. */
  taken: boolean
}

export interface AwaitingAnswerList {
  items: AwaitingAnswerItem[]
  total: number
}

export const AWAITING_ANSWER_KEY = ["agent-awaiting"] as const
