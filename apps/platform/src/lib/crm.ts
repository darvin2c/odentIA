import { canAccess } from "@odentia/auth/permissions"
import { getRouteApi } from "@tanstack/react-router"
import { useCallback } from "react"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"

const orgRouteApi = getRouteApi("/_org")

/** Tipos mínimos del CRM para la UI (la API es la fuente de verdad). */
export interface ConversationPreview {
  body: string | null
  direction: string
  senderKind: string
  createdAt: string
}

/** Lo que una conversación espera del equipo o del agente (lo calcula el servidor). */
export interface ConversationAttention {
  /** Temas sin resolver, el más urgente primero (ADR 0049). Ausente en respuestas antiguas en caché. */
  topics?: InboxTopic[]
  /** Una persona del equipo conversa en vivo: el agente espera. */
  teamLive?: boolean
  /** El agente atiende hoy el hilo: abierto, encendido en el hilo y en la organización. */
  agentAttending: boolean
  /** Propuestas pendientes que esperan al interlocutor: las únicas que quedan pendientes. */
  pendingContact: number
  /** Prioridad más alta entre sus derivaciones sin resolver. */
  handoffPriority: "alta" | "media" | "baja" | null
  /**
   * Abierta, el último mensaje es un saliente aceptado y no hay derivación
   * abierta: desde cuándo se espera al paciente.
   */
  awaitingPatientSince: string | null
  /** El agente ya le recordó en esta atención. */
  nudgedAt: string | null
  /** Escribió fuera del horario del agente y la respuesta quedó para cuando abra. */
  outOfHours: boolean
  /** Nombre de quien tiene la conversación, si alguien la tiene. */
  assignedName: string | null
  /**
   * Hay un entrante posterior al último saliente aceptado (la vista
   * «Esperan respuesta»). Fuera del contrato de cierre: mientras el servidor
   * no lo entregue, la fila no dice «Espera respuesta» salvo fuera de horario.
   */
  unanswered?: boolean
}

/** Motivos de cierre (`conversation.close_reason`). */
export type ConversationCloseReason = "resuelta" | "sin_respuesta" | "equipo" | "manual"

/** Cómo y cuándo se cerró; null si está abierta. `byName` nulo = la cerró el agente o el sistema. */
export interface ConversationClosure {
  reason: ConversationCloseReason
  at: string
  byName: string | null
}

/** Lo que pasará al pulsar «Resolver» (`GET /api/conversations/:id/resolve-preview`). */
export interface ResolvePreview {
  /** Se le envía la despedida: falso si pasaron más de 23 h de su último mensaje o el canal no deja escribir. */
  farewell: boolean
  farewellText: string | null
  /** Derivaciones abiertas del hilo, que quedan resueltas. */
  handoffs: number
  /** Citas propuestas que esperan su sí, que vencen. */
  pendingContact: number
}

export interface ConversationListItem {
  id: string
  status: string
  agentStatus: string
  unreadCount: number
  assignedUserId: string | null
  lastMessageAt: string | null
  contact: { id: string; displayName: string }
  connection: { id: string; channel: string; provider: string; displayName: string }
  preview: ConversationPreview | null
  /** Ausente en respuestas antiguas en caché: tratar como sin estado. */
  attention?: ConversationAttention
  /** Cómo se cerró; null si está abierta. Ausente en respuestas antiguas en caché. */
  closure?: ConversationClosure | null
}

/** Totales de los chips de la Bandeja para los filtros vigentes (sin `status`). */
/** Totales de las cuatro pestañas de la Bandeja, que no se superponen (ADR 0049). */
export interface InboxSummary {
  open: number
  /** «Por atender»: piden a una persona. */
  attend: number
  /** Las atiende el agente. */
  agent: number
  awaitingPatient: number
  closed: number
}

/** Un tema que tiene que contestar una persona del equipo (ADR 0049). */
export interface InboxTopic {
  id: string
  reason: string
  priority: "alta" | "media" | "baja"
  /** «Ahora»: prioridad alta o más de dos horas sin resolverse. */
  urgent: boolean
  assigneeUserId: string | null
  assigneeName: string | null
  createdBy: "agent" | "user"
  createdAt: string
  dueAt: string | null
  taskId: string | null
  /** El mensaje de la persona que se responde, citado. */
  source: { id: string; body: string | null; createdAt: string } | null
  /** Mensajes en que volvió a preguntar por el tema. */
  askedMessageIds: string[]
  askedAgainAt: string | null
}

export interface ChatMessage {
  id: string
  direction: string
  senderKind: string
  /** Quién del equipo lo escribió; nulo si no fue una persona del equipo. */
  senderUserId?: string | null
  contentType: string
  body: string | null
  attachments: { objectKey: string; mimeType: string; filename: string; size: number }[]
  externalId: string | null
  status: string
  error: string | null
  templateName: string | null
  templateLanguage: string | null
  templateParams: string[] | null
  /** Lo envió una línea del Administrador: cuál. Nulo en los demás mensajes. */
  automatic?: { key: string; name: string } | null
  /** Mensaje de la misma conversación al que responde, citado. */
  replyToMessageId?: string | null
  createdAt: string
}

export interface ConversationDetail {
  /** Atención del hilo según el servidor (no depende de la página cargada de la lista). */
  attention?: ConversationAttention
  /** Cómo se cerró; null si está abierta. */
  closure?: ConversationClosure | null
  conversation: {
    id: string
    status: string
    agentStatus: string
    unreadCount: number
    assignedUserId: string | null
    lastMessageAt: string | null
    /** Por si el servidor lo entrega dentro de la conversación en vez de junto a `attention`. */
    closure?: ConversationClosure | null
  }
  /** `isPatient`: su página la abre también quien solo ve pacientes (caja, odontología). */
  contact: { id: string; displayName: string; isActive: boolean; isPatient?: boolean }
  connection: {
    id: string
    channel: string
    provider: string
    displayName: string
    capabilities: {
      templates: boolean
      media: boolean
      interactive: boolean
      readReceipts: boolean
      edit: boolean
    } | null
  }
  /**
   * La ventana de 24 horas de WhatsApp: cerrada, solo se le envía un mensaje
   * aprobado. Nulo en los demás canales; ausente en respuestas antiguas en caché.
   */
  whatsappWindow?: { open: boolean; lastInboundAt: string | null } | null
  messages: ChatMessage[]
  messagesCursor: string | null
}

export interface TaskItem {
  id: string
  title: string
  contactId: string | null
  conversationId: string | null
  /** La oportunidad de la que es la próxima acción (una sola tarea abierta por oportunidad). */
  opportunityId: string | null
  patientId: string | null
  patientName: string | null
  contactName: string | null
  opportunityTitle: string | null
  assigneeUserId: string | null
  dueAt: string | null
  status: string
  /** Quién la dejó: una persona (`user`), Recepción (`agent`) o el Administrador (`admin`). */
  createdBy: string
  /** A qué parte del equipo va cuando no tiene responsable. */
  area: "recepcion" | "caja" | "clinico" | "administracion" | null
  /** Por qué se creó, cuando la deja el Administrador. */
  reason: string | null
  /** Por qué se cerró sola («Rosa confirmó su cita»); nula si la cerró una persona. */
  settledReason?: string | null
  createdAt?: string
  updatedAt?: string
  /**
   * Es la tarea de un caso que pasó el agente («Te lo pasó el agente»), con su
   * urgencia. Completarla puede resolver la conversación: antes se muestra lo
   * mismo que «Resolver» (`useCompleteTask`).
   */
  agentCase?: { priority: string } | null
}

/** A quién va una tarea sin responsable, con las palabras de la pantalla. */
export const TASK_AREA_LABEL: Record<NonNullable<TaskItem["area"]>, string> = {
  recepcion: "Equipo de recepción",
  caja: "Caja",
  clinico: "Equipo clínico",
  administracion: "Administración",
}

/** Rol del usuario en la org actual (fuente: membresía de la sesión). */
export function useMyRole(): string {
  const { org, session } = orgRouteApi.useRouteContext()
  return org.members.find((m) => m.userId === session.userId)?.role ?? "member"
}

/**
 * ¿Puede el usuario ejercer `permission` (p. ej. `clinical.write`)? Solo
 * gating visual: la API aplica la matriz con `canAccess` y devuelve 403.
 */
export function usePermission(permission: string): boolean {
  return canAccess(useMyRole(), permission)
}

/** Comprobador de permisos del usuario para decisiones que dependen de varios a la vez. */
export function useCan(): (permission: string) => boolean {
  const role = useMyRole()
  return useCallback((permission: string) => canAccess(role, permission), [role])
}

export function useMyUserId(): string {
  const { session } = orgRouteApi.useRouteContext()
  return session.userId
}

/** Miembros de la org con usuario (selector de profesional, asignaciones). */
export function useOrgMembers(): Array<{ userId: string; role: string; user: { name: string } }> {
  const { org } = orgRouteApi.useRouteContext()
  return org.members
}

/**
 * Nombre de un miembro por su usuario. Quien ya no pertenece a la organización
 * no se muestra con un identificador: se dice que ya no forma parte del equipo.
 */
export function useMemberName(): (userId: string) => string {
  const members = useOrgMembers()
  return (userId) =>
    members.find((member) => member.userId === userId)?.user.name ?? "Profesional fuera del equipo"
}

/**
 * Hace cuánto (corto, formato y zona de la clínica): "hace 5 min", "ayer",
 * "12/3" y, si fue otro año, "12/3/2025".
 */
export function timeAgo(iso: string | null): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff) || diff < 0) return ""
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "ahora"
  if (min < 60) return `hace ${min} min`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.floor(hours / 24)
  if (days === 1) return "ayer"
  if (days < 7) return `hace ${days} días`
  const timeZone = activeOrgTimeZone()
  const year = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(date)
  const date = new Date(iso)
  return date.toLocaleDateString(activeOrgLocale(), {
    day: "numeric",
    month: "numeric",
    ...(year(date) !== year(new Date()) ? { year: "numeric" as const } : {}),
    timeZone,
  })
}

export interface ContactListItem {
  id: string
  displayName: string
  phone: string | null
  email: string | null
  preferredChannel: string | null
  isActive: boolean
  tags: string[]
  lastInteractionAt: string | null
  channels: string[]
  openOpportunityCount: number
}

export interface ContactPatientLink {
  id: string
  patientNumber: number
  displayName: string
  isActive: boolean
  relationship: "self" | "guardian" | "family" | "other"
  relationshipDetail: string | null
  isPreferred: boolean
}

export interface ContactFull {
  patients: ContactPatientLink[]
  contact: ContactListItem & {
    docType: string | null
    docNumber: string | null
    birthDate: string | null
    sex: string | null
    customFields: Record<string, unknown>
    createdAt: string
    updatedAt: string
  }
  identities: { id: string; channel: string; externalUserId: string; displayName: string | null }[]
  openTasks: { id: string; title: string; dueAt: string | null; assigneeUserId: string | null }[]
  conversations: {
    id: string
    status: string
    /** Cómo se cerró, si el servidor lo entrega en la ficha; sin él se dice solo «Cerrada». */
    closure?: ConversationClosure | null
    channel: string
    connectionId: string | null
    connectionName: string | null
    contactIdentityId: string | null
    lastMessageAt: string | null
  }[]
}

/** Los cuatro pasos fijos de una venta (ADR 0028): la clínica los renombra, no los cambia. */
export type SaleMoment = "interesado" | "evaluacion_agendada" | "presupuesto_enviado" | "decidio"

export interface Stage {
  id: string
  pipelineId: string
  name: string
  position: number
  moment: SaleMoment
}

/** Qué hace avanzar sola a una oportunidad en cada paso, para Configuración. */
export const SALE_MOMENT_HINT: Record<SaleMoment, string> = {
  interesado: "La persona pidió algo concreto: un precio, un tratamiento o una evaluación.",
  evaluacion_agendada: "Llega sola cuando la persona agenda una cita.",
  presupuesto_enviado: "Llega sola cuando se le presenta un presupuesto.",
  decidio: "Llega sola cuando acepta o rechaza el presupuesto, o cuando el equipo la cierra con su motivo.",
}

/** Motivos de cierre con sus palabras (las claves las valida el servidor). */
export type CloseReason =
  | "precio"
  | "otra_clinica"
  | "no_responde"
  | "no_lo_necesita"
  | "otro"
  | "rechazo_presupuesto"
  | "acepto"
  | "acepto_presupuesto"

export const CLOSE_REASON_LABEL: Record<CloseReason, string> = {
  precio: "Precio",
  otra_clinica: "Eligió otra clínica",
  no_responde: "No responde",
  no_lo_necesita: "Ya no lo necesita",
  otro: "Otro",
  rechazo_presupuesto: "Rechazó el presupuesto",
  acepto: "Aceptó",
  acepto_presupuesto: "Aceptó el presupuesto",
}

/** Los que elige una persona al perderla, en su orden. */
export const LOST_REASONS = ["precio", "otra_clinica", "no_responde", "no_lo_necesita", "otro"] as const satisfies readonly CloseReason[]

export interface Pipeline {
  id: string
  name: string
  isDefault: boolean
  stages: Stage[]
}

/** La tarea abierta de una oportunidad: su próxima acción, una sola. */
export interface OpportunityTask {
  id: string
  title: string
  dueAt: string | null
  assigneeUserId: string | null
  area: string | null
}

export interface OpportunityListItem {
  id: string
  title: string
  contactId: string
  contactName: string
  patientId: string | null
  patientName: string | null
  pipelineId: string
  stageId: string
  stageName: string
  moment: SaleMoment
  status: "open" | "won" | "lost"
  amountCents: number | null
  currency: string
  interestText: string | null
  serviceId: string | null
  serviceName: string | null
  /** Sin responsable, la oportunidad es de Recepción hasta que alguien la toma. */
  assignedUserId: string | null
  conversationId: string | null
  budgetId: string | null
  closedAt: string | null
  closeReason: CloseReason | null
  closeNote: string | null
  /** Por qué está donde está, dicho por el servidor con la fecha de la clínica. */
  why: string | null
  nextTask: OpportunityTask | null
  createdAt: string
  updatedAt: string
}

export interface OpportunityDetail extends OpportunityListItem {
  contactPhone: string | null
  contactEmail: string | null
  amountFromPriceList: boolean
  /** El valor es el total del presupuesto que se le presentó. */
  amountFromBudget: boolean
  budgetTitle: string | null
  budgetNumber: number | null
  budgetStatus: string | null
  /** Próxima cita de la persona, dicha por el servidor; solo para quien ve la agenda. */
  nextAppointment: { startsAt: string; text: string } | null
  /** Lo que la hará avanzar sola. */
  after: string | null
  history: Array<{
    id: string
    action: string
    /** El nombre, «El agente» o «Automático». */
    who: string
    origin: "persona" | "agente" | "automatico"
    what: string
    createdAt: string
  }>
}

export interface FieldDef {
  id: string
  key: string
  label: string
  type: string
  options: string[] | null
  position: number
}

export interface ConnectionItem {
  id: string
  channel: string
  provider: string
  displayName: string
  externalId: string | null
  status: string
  capabilities: {
    templates: boolean
    media: boolean
    interactive: boolean
    readReceipts: boolean
    edit: boolean
  } | null
  webhookUrl: string
  createdAt: string
  updatedAt: string
  /**
   * Lo que sigue lo añade el servidor por conexión. Mientras una versión no lo
   * entregue llega ausente, y la pantalla omite ese dato en vez de suponerlo.
   */
  /** Cuándo entró el último mensaje por esta conexión; `null` si aún ninguno. */
  lastInboundAt?: string | null
  /** Cuándo el proveedor verificó la dirección de avisos; `null` si aún no. */
  webhookVerifiedAt?: string | null
  /** Lo último que el proveedor dijo de la cuenta; cada dato que no entrega queda nulo. */
  health?: {
    quality?: "alta" | "media" | "baja" | null
    dailyLimit?: number | null
    /** El proveedor no pone tope diario. */
    unlimited?: boolean
    number?: string | null
    name?: string | null
    checkedAt?: string
  } | null
  /** Mensajes de la cuenta por el estado que les da el proveedor (hoy, solo WhatsApp). */
  messages?: {
    aprobados?: number
    enRevision?: number
    rechazados?: number
    pausados?: number
    retirados?: number
    sinPedir?: number
  } | null
  /**
   * Solo en una conexión hecha con «Conectar con Facebook»: lo que falta para
   * terminarla, con las palabras del servidor. Nulo en las hechas a mano.
   */
  signup?: {
    grantedAt: string
    subscribedAt: string | null
    registeredAt: string | null
    pending: { step: string; title: string; problem: string | null }[]
  } | null
}

export interface AgentConfig {
  organizationId: string
  enabled: boolean
  /** Con qué modelo trabaja el agente; la cuenta la pone odentIA (ADR 0022). */
  llm: AgentLlm
  dailyRunLimit: number
  /** Modelo de decisión en sombra: none | baseline | jev | openai_decisions. */
  decisionProvider: "none" | "baseline" | "jev" | "openai_decisions"
  handoffKeywords: string[]
  maxTurns: number
  /** Comprueba precios, fechas y horas de cada respuesta antes de enviarla. */
  replyCheckEnabled: boolean
  /** Con modelo de decisión, este elige el camino del turno antes de que escriba el otro. */
  decisionRoutingEnabled: boolean
  /** Asistente clínico: dictado en la atención. */
  clinicalAssistantEnabled: boolean
  /** La voz de la clínica. */
  personaName: string | null
  treatment: "tu" | "usted" | null
  tone: "cercano" | "neutro" | "formal"
  /** `no`: el servidor los quita antes de enviar; `pocos`: uno como mucho, nunca en lo delicado. */
  emojis: "no" | "pocos"
  about: string
  /** Funciones de Recepción apagadas e indicación de la clínica por función. */
  disabledFunctions: string[]
  functionNotes: Record<string, string>
  /** Límites: franja en minutos del día (nulos = a toda hora) y canales (nulo = todos). */
  activeFromMin: number | null
  activeUntilMin: number | null
  channels: string[] | null
  /** Horas sin respuesta del paciente tras las que el agente se despide y cierra (6 a 23). */
  closeAfterHours: number
}

/** Los dos modelos que odentIA validó, con el nombre que ve la clínica. El modelo exacto lo decide el servidor. */
export const AGENT_LLMS = [
  { id: "chatgpt_6", label: "ChatGPT 6" },
  { id: "claude_5_5", label: "Claude 5.5" },
] as const
export type AgentLlm = (typeof AGENT_LLMS)[number]["id"]

export function agentLlmLabel(llm: AgentLlm): string {
  return AGENT_LLMS.find((item) => item.id === llm)?.label ?? "ChatGPT 6"
}

