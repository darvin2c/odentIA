import type { AgentProposal } from "./agent"

export interface WorkspaceHome {
  date: string
  timezone: string
  locale: string
  access: Record<"patients" | "appointments" | "conversations" | "tasks" | "finance" | "clinical" | "crm" | "agent" | "allTasks" | "configure", boolean>
  setup: { availability: boolean; chairs: boolean; patients: boolean } | null
  activity: { recorded: boolean; completedToday: boolean }
  appointments: Array<{ id: string; patientId: string; patientName: string; startsAt: string; status: string; branchName: string; dentistName: string; serviceName: string | null; multiBranch: boolean }>
  appointmentCounts: Array<{ status: string; count: number }>
  tasks: Array<{ id: string; title: string; dueAt: string | null; overdue: boolean; href: string }>
  taskCount: { overdue: number; open: number } | null
  conversations: { unread: number; waiting: number; human: number } | null
  budgets: Array<{ id: string; patientId: string; patientName: string; title: string; presentedAt: string | null }>
  debt: DebtSummary[]
  /** Resumen del agente autónomo; null sin permiso `agent.read` ni `agent.decide`. */
  agent: WorkspaceAgentHome | null
}
export interface WorkspaceAgentHome {
  pendingProposals: number
  /** Conversaciones con una derivación sin resolver (misma cuenta que la bandeja). */
  derivedConversations: number
  proposals: Array<{ id: string; action: string; summary: string; createdAt: string; conversationId: string | null; mode: string; context: AgentProposal["context"] }>
  recentHandoffs: Array<{ id: string; reason: string; priority: string; createdAt: string; conversationId: string | null; contactName: string | null; channel: string | null }>
  today: { runs: number; ok: number; handoff: number; error: number; omitida: number; sinRespuesta: number }
}
/** Foto agregada de los últimos 30 días; cada sección es null sin su permiso. */
export interface WorkspacePulse {
  funnel: Array<{ stage: string; count: number; amountCents: string; currency: string }> | null
  channels: Array<{ channel: string; count: number }> | null
  execution: Array<{ day: string; ok: number; handoff: number; error: number; sinRespuesta: number }> | null
  collections: Array<{ day: string; currency: string; amountCents: string }> | null
  performance: CrmPerformance
}
export interface DebtSummary { currency: string; outstandingCents: string; overdueCents: string; patients: number }
export interface WorkspaceNotice { id: string; title: string; body: string; href: string; createdAt: string; readAt: string | null }
export interface ManagementReport {
  from: string; to: string; timezone: string; locale: string
  appointments: Array<{ status: string; count: number }>
  production: Array<{ userId: string; name: string; attended: number; total: number }>
  budgets: Array<{ status: string; count: number }>
  collections: Array<{ currency: string; receivedCents: string; refundedCents: string; netCents: string }>
  debt: DebtSummary[]
  clinicalProduction: Array<{ name: string; currency: string | null; procedures: number; amountCents: string }>
  opportunities: Array<{ status: string; currency: string; count: number; amountCents: string }>
  aging: Array<{ currency: string; bucket: string; amountCents: string }>
  performance: CrmPerformance
}
export interface CrmPerformance {
  responses: { conversations: number; responded: number; timedResponses: number; avgFirstResponseSeconds: number | null } | null
  followUps: { open: number; overdue: number; unassigned: number } | null
  conversations: { closed: number; waiting: number } | null
  bookings: Array<{ source: string; count: number; active: number }> | null
  conversion: Array<{ channel: string | null; assigneeUserId: string | null; assigneeName: string | null; created: number; won: number; lost: number; open: number; wonRate: number | null }> | null
  proposals: { executed: number; failed: number; pending: number } | null
  handoffs: { cohort: number; collected: number; resolved: number; cancelled: number; open: number; unknown: number } | null
  clinicalControls: { cohort: number; realized: number; cancelled: number; pending: number; unknown: number } | null
  taskTimeliness: { cohort: number; onTime: number; late: number; cancelled: number; open: number; unknown: number } | null
}
export const stateLabel: Record<string, string> = {
  programada: "Programada", confirmada: "Confirmada", atendida: "Atendida", no_asistio: "No asistió", cancelada: "Cancelada",
  borrador: "Borrador", presentado: "Presentado", aceptado: "Aceptado", parcial: "Aceptación parcial", rechazado: "Rechazado",
  pospuesto: "Pospuesto", cancelado: "Cancelado", sustituido: "Sustituido", historico: "Histórico",
  open: "Abierta", won: "Ganada", lost: "Perdida",
}
/** Los agregados llegan como enteros decimales para no redondear dinero en JSON. */
export function moneyFromCents(cents: string, currency: string, locale = "es-PE") {
  const value = BigInt(cents)
  const negative = value < 0n
  const absolute = negative ? -value : value
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === "decimal")?.value ?? "."
  return `${negative ? "−" : ""}${currency} ${(absolute / 100n).toLocaleString(locale)}${decimal}${(absolute % 100n).toString().padStart(2, "0")}`
}
