import { currencyFractionDigits } from "@odentia/clinical"
import type { DebtRow } from "./finance-debt"

/** Lo que devuelve `/api/workspace/home`: «Te espera» ya ordenado y lo de hoy según el rol. */
export interface WorkspaceHome {
  date: string
  timezone: string
  locale: string
  access: Record<"patients" | "appointments" | "conversations" | "tasks" | "finance" | "clinical" | "crm" | "agent" | "allTasks" | "configure" | "ownAppointments", boolean>
  /** Hay más de una sede activa: solo entonces se ofrece elegirla. */
  multiBranch: boolean
  setup: { availability: boolean; chairs: boolean; patients: boolean } | null
  activity: { recorded: boolean }
  /** Lo que necesita a una persona, en el orden en que se muestra. */
  waiting: WaitingRow[]
  /** La agenda de la sede o las citas de quien atiende; null sin permiso de agenda. */
  today: WorkspaceToday | null
  /** La caja del día de la sede; null sin permiso de caja. */
  cash: WorkspaceCash | null
}
export interface WaitingTask {
  id: string
  title: string
  dueAt: string | null
  due: "overdue" | "today" | "later" | "none"
  href: string
  mine: boolean
  assigneeName: string | null
}
export interface WaitingBudgets {
  total: number
  oldestPresentedAt: string | null
  items: Array<{ id: string; patientId: string; patientName: string; title: string; presentedAt: string | null }>
}
export type WaitingRow =
  | { kind: "case"; id: string; priority: string; reason: string; contactName: string | null; channel: string | null; createdAt: string; conversationId: string | null }
  | { kind: "proposal"; id: string; action: string; summary: string; createdAt: string; conversationId: string | null; contactName: string | null; patientName: string | null }
  | { kind: "conversations"; waiting: number; oldestAt: string | null }
  | ({ kind: "task"; more: number } & WaitingTask)
  | { kind: "advice"; key: string; title: string; detail: string; actor: "agente" | "persona" }
  /** Personas a las que el agente no pudo escribir hoy, por motivo. */
  | { kind: "unreached"; total: number; byCause: Array<{ total: number; reason: string }> }
  | ({ kind: "budgets" } & WaitingBudgets)
  | { kind: "more"; of: "cases" | "proposals" | "tasks"; count: number }
export interface WorkspaceAppointment {
  id: string
  patientId: string
  patientName: string
  startsAt: string
  status: string
  serviceName: string | null
  dentistName: string
  chairName: string
  branchName: string
  next: boolean
}
export interface WorkspaceToday {
  scope: "branch" | "mine"
  branch: { id: string; name: string } | null
  /** Zona en que se leen las horas: la de la sede o la de la clínica. */
  timezone: string
  summary: { total: number; attended: number; upcoming: number; unconfirmed: number }
  appointments: WorkspaceAppointment[]
}
export interface WorkspaceCash {
  branchId: string
  branchName: string
  currency: string
  timezone: string
  collectedCents: number
  /** Cobros del día: un ticket con dos medios cuenta una vez. */
  tickets: number
  /** Atendidos hoy con algo por cobrar: la misma lista de Finanzas › Caja. */
  toCollect: DebtRow[]
}
export interface WorkspaceNotice { id: string; title: string; body: string; href: string; createdAt: string; readAt: string | null }
/**
 * Un agregado que llega como entero (texto) en la unidad menor de su moneda,
 * como número para un gráfico o un formato: en la unidad mayor, con los
 * decimales de cada moneda (ISO 4217: ninguno en CLP o JPY, dos en PEN o USD,
 * tres en KWD).
 */
export function amountFromCents(cents: string, currency: string): number {
  return Number(BigInt(cents)) / 10 ** currencyFractionDigits(currency)
}
