import { currencyFractionDigits } from "@odentia/clinical"
import type { AppointmentVisit } from "./agenda"
import type { DebtRow } from "./finance-debt"

/** Lo que devuelve `/api/workspace/home`: «Te espera» ya ordenado y lo de hoy según el rol. */
export interface WorkspaceHome {
  date: string
  timezone: string
  locale: string
  access: Record<"patients" | "appointments" | "conversations" | "tasks" | "finance" | "clinical" | "crm" | "agent" | "allTasks" | "configure" | "ownAppointments", boolean> & { attends?: boolean }
  /** Hay más de una sede activa: solo entonces se ofrece elegirla. */
  multiBranch: boolean
  /** `agent`: Recepción y el Administrador encendidos; solo viaja a quien puede encenderlos. */
  setup: { availability: boolean; chairs: boolean; patients: boolean; agent?: boolean } | null
  activity: { recorded: boolean }
  /** Lo que necesita a una persona, en el orden en que se muestra. */
  waiting: WaitingRow[]
  /** La agenda de la sede o las citas de quien atiende; null sin permiso de agenda. */
  today: WorkspaceToday | null
  /** La agenda de la sede en una línea, para quien hoy atiende y además ve la sede. */
  agendaLine: { branch: { id: string; name: string }; summary: WorkspaceTodaySummary } | null
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
  /** La oportunidad de la que sale, si el rol puede verla. */
  opportunityTitle: string | null
}
export interface WaitingBudgets {
  total: number
  oldestPresentedAt: string | null
  items: Array<{ id: string; patientId: string; patientName: string; title: string; presentedAt: string | null }>
}
export type WaitingRow =
  /** Una atención de otro día que quedó en borrador y lleva quien mira: «Continuar» o «Anular con motivo». */
  | {
      kind: "staleEncounter"
      id: string
      patientId: string
      patientName: string
      startedAt: string
      /** Lo que falta para cerrarla (`reason`, `diagnosis`, `evolution`, `signature`). */
      missing: string[]
    }
  | {
      kind: "case"
      id: string
      priority: string
      reason: string
      contactName: string | null
      channel: string | null
      createdAt: string
      conversationId: string | null
      /** Nadie lo tomó todavía: la fila ofrece «Tomar». */
      unclaimed: boolean
    }
  /** Una cita sin confirmar después del primer recordatorio del agente: hay que llamar. */
  | {
      kind: "unconfirmed"
      id: string
      patientId: string
      patientName: string
      phone: string | null
      startsAt: string
      branchName: string
      serviceName: string | null
    }
  | { kind: "conversations"; waiting: number; oldestAt: string | null }
  /** Conversaciones que siguen abiertas con una persona a cargo y sin mensajes desde hace horas. */
  | { kind: "stillOpen"; total: number; conversationId: string | null; contactName: string | null; quietSince: string | null }
  | ({ kind: "task"; more: number } & WaitingTask)
  | { kind: "advice"; key: string; title: string; detail: string; actor: "agente" | "persona" }
  /** Personas a las que el agente no pudo escribir hoy, por motivo. */
  | { kind: "unreached"; total: number; byCause: Array<{ total: number; reason: string }> }
  | ({ kind: "budgets" } & WaitingBudgets)
  /**
   * Un presupuesto armado que nadie envió desde el día anterior (decisión 12):
   * «Presupuesto de Lucía Fernández sin enviar · Enviar». Se va solo al enviarlo.
   */
  | {
      kind: "unsentBudget"
      id: string
      patientId: string
      patientName: string
      since: string
      itemCount: number
      totalCents: number | null
      currency: string
      options: number
    }
  /** Un consentimiento que una atención pidió y la clínica aún no publicó: lo publica quien configura. */
  | { kind: "consentToPublish"; templateKey: string; title: string; requestedByName: string | null; requestedAt: string }
  | { kind: "more"; of: "cases" | "tasks" | "unconfirmed" | "unsentBudgets"; count: number }
export interface WorkspaceAppointment {
  id: string
  patientId: string
  patientName: string
  startsAt: string
  status: string
  serviceName: string | null
  dentistUserId: string
  dentistName: string
  chairName: string
  branchName: string
  /** Cuándo llegó; null si nadie lo marcó. */
  arrivedAt: string | null
  /** El momento de la cita: de ahí salen la sala, «Ahora» y «Más tarde». */
  visit: AppointmentVisit
  /** La atención abierta unida a la cita: con quién y desde cuándo. */
  encounter: { id: string; startedAt: string; dentistUserId: string; dentistName: string } | null
  /** La siguiente que aún no llega. */
  next: boolean
}
/** Cuántas citas hay hoy: en sala, en atención, atendidas y por venir (las que aún no llegan). */
export interface WorkspaceTodaySummary {
  total: number
  waiting: number
  attending: number
  attended: number
  upcoming: number
  unconfirmed: number
}
export interface WorkspaceToday {
  scope: "branch" | "mine"
  branch: { id: string; name: string } | null
  /** Zona en que se leen las horas: la de la sede o la de la clínica. */
  timezone: string
  summary: WorkspaceTodaySummary
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
