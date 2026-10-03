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
  createdAt: string
}
