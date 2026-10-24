import type { WritingWeek } from "./writing-hours"
import type { QueryClient } from "@tanstack/react-query"

/** El agente Administrador tal como lo entrega `/api/agent/admin`: la interfaz no calcula nada de esto. */

export interface AdminLineView {
  key: string
  name: string
  area: string
  /** Lo que pasa: «Una persona falta a su cita». */
  trigger: string
  /** Quién lo hace con las partes que van. */
  actor: "agente" | "persona"
  description: string
  enabled: boolean
  hasAgent: boolean
  agentPart: boolean
  teamPart: boolean
  /** «el equipo de recepción». */
  team: string
  days: number | null
  defaultDays: number | null
  daysLabel: string | null
  since: string | null
  /** Prendida: su semana en una frase. */
  week: string | null
  /** Apagada: cuántos casos tendría hoy; null si este rol no puede verlos. */
  todayCases: number | null
  recommended: boolean
  noRecommend: boolean
  paused: "recepcion_apagada" | null
  /** La creó la clínica pidiéndosela con palabras: es la única que se puede eliminar. */
  custom: boolean
  hour: number | null
  hourAdjustable: boolean
  delayHours: number | null
  /** Indicación de la clínica para quien reciba la tarea. */
  taskNote: string | null
  /** Hay un pedido con palabras esperando decisión. */
  hasDraft: boolean
  /** Prendida y sin servir: lo que propone, con su cifra. */
  suggestion: string | null
}

export interface AdminDraft {
  request: string
  creates: boolean
  action: "prender" | "guardar" | "apagar"
  summary: string
  changes: Array<{ kind: "cambio" | "nueva" | "quita"; before: string | null; after: string }>
  flow: AdminFlow
  marks: Record<string, "nueva" | "cambio">
  unsupported: string[]
  test: {
    days: number
    total: number
    title: string
    rows: Array<{ route: string; total: number; label: string; detail: string }>
    how: string
  } | null
  review: Array<{ ok: boolean; text: string }>
  message: { text: string; buttons: string[] } | null
  /** Lo que el agente no hace puede quedar como indicación en la tarea, para una persona. */
  taskNote: { value: string | null; max: number; team: string } | null
  at: string
}

/** Lo que responde el Administrador a un pedido con palabras. */
export interface AdminRequestResult {
  understood: boolean
  key: string | null
  draft: boolean
  message: string | null
  confirmDelete: boolean
  /** El modelo no respondió: lo prendido sigue y los interruptores también. */
  unavailable: boolean
}

export interface AdminPage {
  enabled: boolean
  /** El «Horario de recontacto» de Agente: por día (0 = domingo), sus tramos en minutos. */
  writingHours: WritingWeek
  receptionOn: boolean
  whatsapp: boolean
  lines: AdminLineView[]
  today: { recommendations: number; done: number; yours: number }
  monthTemplates: number
  /** Prendida, pero casi no escribe: la mayoría no aceptó ese tipo de mensaje. */
  permissionGaps: Array<{ purpose: "novedades"; refused: number; total: number; asks: boolean; lineKey: string }>
  /** Llegó al presupuesto del mes: los mensajes para recuperar esperan (ADR 0085). */
  budgetHold?: { until: string; total: number; lines: Array<{ kind: string; name: string; count: number }> } | null
}

export interface AdminFlowStep {
  id: string
  kind: "inicio" | "paso" | "decision" | "fin"
  label: string
  actor: "administrador" | "recepcion" | "equipo" | null
  actorLabel: string | null
  /** Parte de la línea a la que pertenece: su interruptor lo prende o lo apaga. */
  part: "agent" | "team" | null
  always: boolean
}

export interface AdminFlow {
  main: AdminFlowStep[]
  otherwise: AdminFlowStep[] | null
}

export type AdminOutcome =
  | "programado"
  | "enviando"
  | "entregado"
  | "confirmo"
  | "respondio"
  | "reservo"
  | "no_pudo"
  | "tarea"
  | "tarea_resuelta"
  | "no_hizo_falta"

export interface AdminPersonRow {
  id: string
  personName: string
  patientId: string | null
  contactId: string | null
  conversationId: string | null
  at: string
  outcome: AdminOutcome
  text: string
  /** Cómo habilitarlo, cuando no se pudo escribir. */
  fix: string | null
  cause: string | null
}

export interface AdminLineDetail extends AdminLineView {
  flow: AdminFlow
  fullFlow: AdminFlow
  message: { text: string; buttons: string[] } | null
  noticeExample: string | null
  people: AdminPersonRow[]
  peopleTotal: number
  changes: Array<{ at: string; by: string | null; what: string }>
  draft: AdminDraft | null
}

export interface AdminCase {
  id: string
  personName: string
  line: string
  patientId: string | null
  contactId: string | null
  opportunityId: string | null
}

export interface AdminRecommendation {
  key: string
  name: string
  area: string
  title: string
  detail: string
  how: string
  total: number
  items: AdminCase[]
  computedAt: string
  actor: "agente" | "persona"
  /** Qué pasaría desde ahora si se prende. */
  description: string
  /** «Solo esta vez»; null si la línea solo tiene sentido prendida. */
  once: { label: string; detail: string } | null
  enabled: boolean
}

export interface AdminAdvice {
  enabled: boolean
  recommendations: AdminRecommendation[]
  more: number
}

export interface AdminUnreached {
  total: number
  byCause: Array<{ cause: string; total: number; reason: string; fix: string }>
  people: Array<AdminPersonRow & { lineKey: string; lineName: string }>
}

/** Lo suyo en «Resumen» del agente. */
export interface AdminOverview {
  enabled: boolean
  on: number
  byAgent: number
  byTeam: number
  recommended: number
}

export const ADMIN_PAGE_KEY = ["agent-admin"] as const
export const adminLineKey = (key: string) => ["agent-admin-line", key] as const

/** Todo lo que cambia cuando se prende, apaga o atiende algo del Administrador. */
export function refreshAdmin(queryClient: QueryClient): void {
  for (const key of ["agent-admin", "agent-admin-line", "agent-admin-advice", "agent-admin-unreached", "agent-overview", "tasks", "workspace-home", "report"]) {
    void queryClient.invalidateQueries({ queryKey: [key] })
  }
}

/** Dónde se resuelve cada línea, además de lo que se puede hacer desde su ficha. */
export const ADMIN_LINE_WHERE: Record<string, { to: string; label: string }> = {
  recordatorio_cita: { to: "/agenda", label: "Abrir la agenda" },
  recordatorio_control: { to: "/agenda", label: "Abrir la agenda" },
  seguimiento_presupuesto: { to: "/people", label: "Abrir pacientes" },
  seguimiento_comercial: { to: "/pipeline", label: "Abrir oportunidades" },
  seguimiento_no_asistencia: { to: "/agenda", label: "Abrir la agenda" },
  presupuestos_sin_cita: { to: "/agenda", label: "Abrir la agenda" },
  atenciones_sin_firmar: { to: "/people", label: "Abrir pacientes" },
  cobranza_vencida: { to: "/finance", label: "Abrir finanzas" },
  cita_cancelada: { to: "/agenda", label: "Abrir la agenda" },
}
