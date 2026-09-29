export interface WorkspaceHome {
  date: string
  timezone: string
  locale: string
  access: Record<"patients" | "appointments" | "conversations" | "tasks" | "finance" | "clinical" | "crm" | "allTasks", boolean>
  appointments: Array<{ id: string; patientId: string; patientName: string; startsAt: string; status: string; branchName: string; dentistName: string }>
  appointmentCounts: Array<{ status: string; count: number }>
  tasks: Array<{ id: string; title: string; dueAt: string | null; overdue: boolean }>
  taskCount: { overdue: number; open: number } | null
  conversations: { unread: number; waiting: number; human: number } | null
  budgets: Array<{ id: string; patientId: string; patientName: string; title: string; presentedAt: string | null }>
  debt: DebtSummary[]
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
