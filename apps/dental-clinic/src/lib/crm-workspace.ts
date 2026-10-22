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
  /** Hay una cita propuesta que espera el sí del interlocutor, sea cual sea el estado (`state` sigue el orden de la Bandeja). */
  awaitingContact: boolean
}

/** La próxima cita en pie de la persona o de quien ella lleva (solo para quien ve la agenda). */
export interface CrmNextAppointment {
  id: string
  patientId: string
  patientName: string
  startsAt: string
  status: string
  branchName: string
  timeZone: string
  dentistName: string
  serviceName: string | null
}

export interface CrmContactWorkspace {
  contact: ContactFull
  opportunities: { items: OpportunityListItem[]; nextCursor: string | null }
  tasks: TaskItem[]
  agent: CrmAgentStatus
  activity: { items: CrmActivityItem[]; nextCursor: string | null }
  nextAppointment: CrmNextAppointment | null
  /** Lo que aceptó recibir sin haber escrito primero; null: nunca se le preguntó. */
  messages: { recordatorio: boolean | null; seguimiento: boolean | null; novedades?: boolean | null; avisos?: boolean | null }
}

/** «Aceptó recordatorios», «No aceptó mensajes de la clínica»…, para «Contexto». */
export function messagePermissionsSaid(messages: CrmContactWorkspace["messages"]): string {
  // «Ningún mensaje» apaga también los avisos de su cita (ADR 0040): es lo primero que hay que saber.
  if (messages.avisos === false) return "No quiere ningún mensaje de la clínica"
  // Lo de su atención es parte del servicio (ADR 0030): solo se dice si se dio de baja.
  const news =
    messages.novedades === true
      ? "Acepta novedades y promociones"
      : messages.novedades === false
        ? "No quiere novedades ni promociones"
        : "Novedades y promociones: aún no se le preguntó"
  const out = [messages.recordatorio === false ? "recordatorios" : null, messages.seguimiento === false ? "seguimientos" : null].filter(Boolean)
  return out.length > 0 ? `${news} · pidió no recibir ${out.join(" ni ")}` : news
}

/** «jue 17 oct, 10:30 · Evaluación · Dra. Ruiz», con la hora de la sede. */
export function nextAppointmentSaid(next: CrmNextAppointment, locale: string | undefined, personName: string): string {
  const when = new Intl.DateTimeFormat(locale, {
    timeZone: next.timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(next.startsAt))
  const who = next.patientName === personName ? "" : `${next.patientName}: `
  return `${who}${when} · ${next.serviceName ?? "Cita"} · ${next.dentistName}`
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

/**
 * Etiqueta operativa del estado de atención (sin jerga técnica). Las
 * conversaciones las atiende el agente de recepción: se dice su nombre.
 */
export function agentStateLabel(state: CrmAgentState, receptionName: string): string {
  switch (state) {
    case "agent":
      return `La atiende ${receptionName}`
    case "human":
      return "Con el equipo"
    case "approval":
      return "Espera al paciente"
    case "handoff":
      return `Te lo pasó ${receptionName}`
    case "closed":
      return "Cerrada"
  }
}

/** Explicación breve del estado para recepción. */
export function agentStateDescription(agent: CrmAgentStatus, receptionName: string): string {
  if (agent.reason) return agent.reason
  switch (agent.state) {
    case "agent":
      return `${receptionName} responde los mensajes entrantes.`
    case "human":
      return agent.enabled
        ? `La atiende una persona: ${receptionName} no responde en este hilo.`
        : `${receptionName} no atiende este hilo.`
    case "approval":
      return agent.pendingProposalIds.length === 1
        ? `${receptionName} propuso una cita y espera su sí en la conversación.`
        : `${receptionName} propuso ${agent.pendingProposalIds.length} cambios y espera su sí en la conversación.`
    case "handoff":
      return `${receptionName} te pasó un tema: respóndelo desde la conversación.`
    case "closed":
      return "Si le escribes, la conversación se vuelve a abrir."
  }
}

/**
 * Siguientes pasos sugeridos según el estado real del agente. Solo texto
 * operativo derivado del contexto; no inventa acciones del servidor.
 */
export function agentNextSteps(agent: CrmAgentStatus, receptionName: string): string[] {
  switch (agent.state) {
    case "approval":
      return [
        `Revisa lo que propuso ${receptionName}`,
        "Si ya dijo que sí en el chat, regístralo en la franja de la conversación",
      ]
    case "handoff":
      return ["Lee qué pide y lo que se le dijo", "Responde desde el tema"]
    case "human":
      return [
        "Responde el mensaje pendiente",
        `Al responder, el tema se resuelve. ${receptionName} sigue con lo demás.`,
      ]
    case "agent":
      return ["Supervisa; interviene solo si el caso lo pide"]
    case "closed":
      return [`Si escribe de nuevo, la atiende ${receptionName}`]
  }
}

/** Etiqueta operativa de cada fuente de la bitácora. */
export function activityKindLabel(kind: CrmActivityItem["kind"], receptionName: string): string {
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
      return `Propuesta de ${receptionName}`
    case "handoff":
      return `Te lo pasó ${receptionName}`
  }
}
