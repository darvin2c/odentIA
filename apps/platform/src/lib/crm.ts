import { canAccess } from "@odentia/auth/permissions"
import { getRouteApi } from "@tanstack/react-router"
import { useCallback } from "react"
import { activeOrgLocale } from "./locale"

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
  /** El agente atiende hoy el hilo: abierto, encendido en el hilo y en la organización. */
  agentAttending: boolean
  /** Propuestas pendientes del hilo que decide el equipo. */
  pendingTeam: number
  /** Propuestas pendientes que esperan al interlocutor. */
  pendingContact: number
  /** Prioridad más alta entre sus derivaciones sin resolver. */
  handoffPriority: "alta" | "media" | "baja" | null
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
}

/** Totales de las vistas de la bandeja para los filtros vigentes. */
export interface InboxSummary {
  all: number
  waiting: number
  withAgent: number
  handoffs: number
}

export interface ChatMessage {
  id: string
  direction: string
  senderKind: string
  contentType: string
  body: string | null
  attachments: { objectKey: string; mimeType: string; filename: string; size: number }[]
  externalId: string | null
  status: string
  error: string | null
  templateName: string | null
  templateLanguage: string | null
  templateParams: string[] | null
  createdAt: string
}

export interface ConversationDetail {
  /** Atención del hilo según el servidor (no depende de la página cargada de la lista). */
  attention?: ConversationAttention
  conversation: {
    id: string
    status: string
    agentStatus: string
    unreadCount: number
    assignedUserId: string | null
    lastMessageAt: string | null
  }
  contact: { id: string; displayName: string; isActive: boolean }
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
  messages: ChatMessage[]
  messagesCursor: string | null
}

export interface TaskItem {
  id: string
  title: string
  contactId: string | null
  conversationId: string | null
  opportunityId: string | null
  patientId: string | null
  patientName: string | null
  kind: "manual" | "opportunity_follow_up"
  contactName: string | null
  opportunityTitle: string | null
  assigneeUserId: string | null
  dueAt: string | null
  status: string
  createdBy: string
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

/** Hace cuánto (corto, formato de la clínica): "hace 5 min", "ayer", "12/03". */
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
  return new Date(iso).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "numeric" })
}

export interface ContactListItem {
  id: string
  displayName: string
  phone: string | null
  email: string | null
  preferredChannel: string | null
  isActive: boolean
  tags: string[]
  assignedUserId: string | null
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
    notes: string | null
    customFields: Record<string, unknown>
    createdAt: string
    updatedAt: string
  }
  identities: { id: string; channel: string; externalUserId: string; displayName: string | null }[]
  openTasks: { id: string; title: string; dueAt: string | null; assigneeUserId: string | null }[]
  conversations: {
    id: string
    status: string
    channel: string
    connectionId: string | null
    connectionName: string | null
    contactIdentityId: string | null
    lastMessageAt: string | null
  }[]
}

export interface Stage {
  id: string
  pipelineId: string
  name: string
  position: number
  kind: string
}

export interface Pipeline {
  id: string
  name: string
  isDefault: boolean
  stages: Stage[]
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
  stageKind: string
  status: "open" | "won" | "lost"
  amountCents: number | null
  currency: string
  interestText: string | null
  serviceName: string | null
  assignedUserId: string | null
  conversationId: string | null
  createdAt: string
  nextActionNote: string | null
  nextActionAt: string | null
  updatedAt: string
}

export interface OpportunityDetail extends OpportunityListItem {
  contactPhone: string | null
  contactEmail: string | null
  serviceId: string | null
  nextActionNote: string | null
  closedAt: string | null
  closeReason: string | null
  budgetId: string | null
  budgetTitle: string | null
  budgetStatus: string | null
  createdAt: string
  history: Array<{
    id: string
    action: string
    fromStageId: string | null
    toStageId: string | null
    actorUserId: string | null
    note: string | null
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
}

export interface AgentConfig {
  organizationId: string
  enabled: boolean
  model: string | null
  /** URL base del proveedor propio; null = el de odentIA. */
  llmBaseUrl: string | null
  /** La clave existe en el servidor; su valor nunca llega al cliente. */
  hasLlmApiKey: boolean
  dailyRunLimit: number
  /** Modelo de decisión en sombra: none | baseline | jev | openai_decisions. */
  decisionProvider: "none" | "baseline" | "jev" | "openai_decisions"
  systemPrompt: string
  handoffKeywords: string[]
  maxTurns: number
}

export interface LlmConnectionTest {
  ok: boolean
  latencyMs: number
  model: string | null
  error: string | null
}

