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
  setup: { availability: boolean; rooms: boolean; patients: boolean; agent?: boolean } | null
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
  /** Terminó su registro por su enlace hoy y tiene cita hoy sin llegar: «Llegó» al entrar. */
  | {
      kind: "registrationDone"
      appointmentId: string
      patientId: string
      patientName: string
      sentAt: string
      startsAt: string
      professionalName: string | null
    }
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
      /** Nadie lo tomó todavía: la fila ofrece «Tomar este tema». */
      unclaimed: boolean
      /** «Ahora»: alta, o dos horas de clínica abierta esperando (decisión 1 del pulido). */
      urgent?: boolean
      /** De qué trata: cita, precio, clínico, pago u otro (R3). */
      topicKind?: string
      /** Quien mira lo responde aquí mismo, sin entrar a la Bandeja (R3 y decisión 3). */
      canReply?: boolean
      /** Lo que preguntó, para responderlo aquí; solo si `canReply`. */
      quote?: string | null
    }
  /**
   * Una cita que hay que confirmar llamando: sigue sin confirmar tras el primer
   * recordatorio (`sin_confirmar`) o es de mañana y no recibe recordatorios
   * (`sin_recordatorios`, ADR 0040).
   */
  | {
      kind: "unconfirmed"
      why: "sin_confirmar" | "sin_recordatorios"
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
  /**
   * Un documento escrito desde fuera ya es de otra persona y recepción revisa
   * (nunca se unen solas): el de «Su enlace» (`enlace`), el de alguien que se
   * registró en línea (`registro`, la fila es de quien tenía el documento) o
   * el representante que nombró el registro de un menor (`representante`,
   * espera su «Confirmar»).
   */
  | {
      kind: "possibleDuplicate"
      id: string
      source: "enlace" | "registro" | "representante"
      patientId: string | null
      personId: string | null
      patientName: string
      personName: string | null
      detail: string
      createdAt: string
      /** `registro`: hay lo que escribió para decidir en «¿Es la misma persona?». */
      held?: boolean
    }
  /** Pidió volver a entrar al portal: recepción le envía un enlace nuevo y le dice el código aparte. */
  | { kind: "portalReentry"; id: string; patientId: string; contactName: string; grantId: string | null; createdAt: string }
  /** Un pedido sobre sus datos que vence en 3 días o ya venció (ADR 0080). */
  | { kind: "dataRequest"; id: string; patientId: string; patientName: string; request: "copia" | "corregir" | "mensajes" | "borrar"; dueOn: string; verified: boolean }
  /** Un consentimiento que una atención pidió y la clínica aún no publicó: lo publica quien configura. */
  | { kind: "consentToPublish"; templateKey: string; title: string; requestedByName: string | null; requestedAt: string }
  /**
   * El inventario de una sede pide trabajo (ADR 0067): productos que hacen falta
   * y lotes vencidos, una fila por sede para quien pide las compras. Se va sola.
   */
  | {
      kind: "inventory"
      branchId: string
      branchName: string
      needed: number
      neededNames: string[]
      expiredLots: number
      expired: Array<{ productName: string; expiresAt: string }>
    }
  /** Un aviso que WhatsApp pasó a promoción: solo sale a quien aceptó novedades; hay que cambiarle el texto (ADR 0040). */
  | { kind: "promotion"; messageId: string; title: string }
  | { kind: "more"; of: "cases" | "tasks" | "unconfirmed" | "unsentBudgets"; count: number }
export interface WorkspaceAppointment {
  id: string
  patientId: string
  patientName: string
  startsAt: string
  status: string
  serviceName: string | null
  professionalUserId: string
  professionalName: string
  roomName: string
  branchName: string
  /** Cuándo llegó; null si nadie lo marcó. */
  arrivedAt: string | null
  /** El momento de la cita: de ahí salen la sala, «Ahora» y «Más tarde». */
  visit: AppointmentVisit
  /** La atención abierta unida a la cita: con quién y desde cuándo. */
  encounter: { id: string; startedAt: string; professionalUserId: string; professionalName: string } | null
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
