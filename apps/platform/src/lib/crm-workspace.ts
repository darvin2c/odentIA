import { apiFetch } from "./api"
import type { ContactFull, OpportunityListItem, TaskItem } from "./crm"

/**
 * Elemento de la bitácora unificada del contacto (mensajes de todos los
 * canales con procedencia, notas operativas, tareas, movimientos de
 * oportunidad y acciones del agente). Nunca incluye historia clínica.
 */
export interface CrmActivityItem {
  id: string
  kind: "message" | "note" | "task" | "opportunity" | "proposal" | "handoff"
  at: string
  title: string
  body: string | null
  actorName: string | null
  channel: string | null
  conversationId: string | null
  opportunityId: string | null
  taskId: string | null
  status: string | null
}

export type CrmAgentState = "agent" | "human" | "approval" | "handoff" | "closed"

export interface CrmAgentStatus {
  state: CrmAgentState
  enabled: boolean
  conversationId: string | null
  reason: string | null
  pendingProposalIds: string[]
}

export interface CrmContactWorkspace {
  contact: ContactFull
  opportunities: { items: OpportunityListItem[]; nextCursor: string | null }
  tasks: TaskItem[]
  agent: CrmAgentStatus
  activity: { items: CrmActivityItem[]; nextCursor: string | null }
}

/** Clave de caché del contexto del contacto (conversación opcional). */
export function crmContextQueryKey(contactId: string, conversationId?: string): string[] {
  return ["crm-context", contactId, conversationId ?? "todas"]
}

/** Clave de caché de la bitácora paginada del contacto. */
export function crmActivityQueryKey(contactId: string): string[] {
  return ["crm-activity", contactId]
}

/** GET /api/crm/contacts/:id/context — resumen operativo del contacto. */
export function fetchCrmContext(
  contactId: string,
  conversationId?: string,
): Promise<{ data: CrmContactWorkspace }> {
  const params = new URLSearchParams()
  if (conversationId) params.set("conversationId", conversationId)
  const suffix = params.toString() ? `?${params}` : ""
  return apiFetch<{ data: CrmContactWorkspace }>(
    `/api/crm/contacts/${encodeURIComponent(contactId)}/context${suffix}`,
  )
}

/** GET /api/crm/contacts/:id/activity — página de la bitácora (keyset). */
export function fetchCrmActivityPage(
  contactId: string,
  cursor: string | null,
  limit = 30,
): Promise<{ data: CrmActivityItem[]; nextCursor: string | null }> {
  const params = new URLSearchParams()
  if (cursor) params.set("cursor", cursor)
  params.set("limit", String(limit))
  return apiFetch<{ data: CrmActivityItem[]; nextCursor: string | null }>(
    `/api/crm/contacts/${encodeURIComponent(contactId)}/activity?${params}`,
  )
}

/** POST /api/crm/contacts/:id/notes — nota operativa vinculada al caso. */
export function createCrmNote(
  contactId: string,
  input: { body: string; conversationId?: string; opportunityId?: string },
): Promise<{ data: CrmActivityItem }> {
  return apiFetch<{ data: CrmActivityItem }>(
    `/api/crm/contacts/${encodeURIComponent(contactId)}/notes`,
    { method: "POST", body: JSON.stringify(input) },
  )
}

/** Etiqueta operativa del estado de atención (sin jerga técnica). */
export function agentStateLabel(state: CrmAgentState): string {
  switch (state) {
    case "agent":
      return "Atiende el agente"
    case "human":
      return "Atiende recepción"
    case "approval":
      return "Espera al interlocutor"
    case "handoff":
      return "Necesita al equipo"
    case "closed":
      return "Conversación cerrada"
  }
}

/** Explicación breve del estado para recepción. */
export function agentStateDescription(agent: CrmAgentStatus): string {
  if (agent.reason) return agent.reason
  switch (agent.state) {
    case "agent":
      return "El agente responde los mensajes entrantes."
    case "human":
      return agent.enabled
        ? "El agente está activo, pero este hilo lo atiende una persona."
        : "El agente está pausado para este hilo."
    case "approval":
      return `Hay ${agent.pendingProposalIds.length} propuesta(s) del agente esperando la confirmación del interlocutor.`
    case "handoff":
      return "El agente derivó el caso al equipo."
    case "closed":
      return "El hilo está cerrado; reábrelo para continuar."
  }
}

/**
 * Siguientes pasos sugeridos según el estado real del agente. Solo texto
 * operativo derivado del contexto; no inventa acciones del servidor.
 */
export function agentNextSteps(agent: CrmAgentStatus): string[] {
  switch (agent.state) {
    case "approval":
      return ["Revisa lo que propuso el agente", "Si confirmó en el chat, registra su confirmación"]
    case "handoff":
      return ["Lee el motivo de la derivación", "Toma la atención y responde"]
    case "human":
      return agent.enabled
        ? ["Responde el mensaje pendiente", "Devuelve al agente cuando termines"]
        : ["Responde el mensaje pendiente", "Reactiva al agente cuando termines"]
    case "agent":
      return ["Supervisa; interviene solo si el caso lo pide"]
    case "closed":
      return ["Reabre la conversación para continuar"]
  }
}

/** Etiqueta operativa de cada fuente de la bitácora. */
export function activityKindLabel(kind: CrmActivityItem["kind"]): string {
  switch (kind) {
    case "message":
      return "Mensaje"
    case "note":
      return "Nota"
    case "task":
      return "Tarea"
    case "opportunity":
      return "Oportunidad"
    case "proposal":
      return "Propuesta del agente"
    case "handoff":
      return "Derivación"
  }
}
