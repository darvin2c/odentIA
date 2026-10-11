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
