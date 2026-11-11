import { currencyFractionDigits, formatMoney } from "@odentia/clinical"
import type { AppointmentVisit } from "./agenda"
import type { DebtRow } from "./finance-debt"

/** Lo que devuelve `/api/workspace/home`: «Te espera» ya ordenado y lo de hoy según el rol. */
/** Lo que la clínica tiene encendido, para decirlo en Inicio con su enlace para apagarlo (ADR 0141). */
export interface SetupOn {
  reception?: boolean
  admin?: boolean
  clio: boolean
  registration: boolean
  noticeSuggested: boolean
  portal: boolean
  digest: boolean
  /** Cuántas líneas de Argos están encendidas. */
  lines: number
}

export interface WorkspaceHome {
  date: string
  timezone: string
  locale: string
  access: Record<"patients" | "appointments" | "conversations" | "tasks" | "finance" | "clinical" | "crm" | "agent" | "allTasks" | "configure" | "ownAppointments", boolean> & { attends?: boolean }
  /** Hay más de una sede activa: solo entonces se ofrece elegirla. */
  multiBranch: boolean
  /** `agent`: Recepción y el Administrador encendidos; solo viaja a quien puede encenderlos. */
  setup: {
    availability: boolean
    rooms: boolean
    patients: boolean
    agent?: boolean
    /** Lo encendido de verdad (ADR 0141); Recepción y Argos, solo para quien puede encenderlos. */
    on?: SetupOn
  } | null
  activity: { recorded: boolean }
  /** Lo que necesita a una persona, en el orden en que se muestra. */
  waiting: WaitingEntry[]
  /** La agenda de la sede o las citas de quien atiende; null sin permiso de agenda. */
  today: WorkspaceToday | null
  /** La agenda de la sede en una línea, para quien hoy atiende y además ve la sede. */
  agendaLine: { branch: { id: string; name: string }; summary: WorkspaceTodaySummary } | null
  /** La caja del día de la sede; null sin permiso de caja. */
  cash: WorkspaceCash | null
}
export interface WaitingTask {
  /** Te la pasó un colega por un paciente: quién. */
  referredBy?: string | null
  /** En una derivación, de qué paciente es. */
  patientName?: string | null
  id: string
  title: string
  dueAt: string | null
  due: "overdue" | "today" | "later" | "none"
  href: string
  mine: boolean
  assigneeName: string | null
  /** Sin persona, el área que la tiene (recepción, clínico, caja). */
  area?: string | null
  /** La oportunidad de la que sale, si el rol puede verla. */
  opportunityTitle: string | null
}
export interface WaitingBudgets {
  total: number
  oldestPresentedAt: string | null
  items: Array<{ id: string; patientId: string; patientName: string; title: string; presentedAt: string | null }>
}
/** Los grupos de «Te espera»: los decide el servidor con la escala de siempre. */
export type WaitingBand = "ahora" | "hoy" | "sin_apuro"

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
  /** Una atención de otro día que quedó en borrador y lleva quien mira: el panel dice qué tiene y qué falta. */
  | {
      kind: "staleEncounter"
      id: string
      patientId: string
      patientName: string
      startedAt: string
      /** Lo que falta para cerrarla (`reason`, `diagnosis`, `evolution`, `signature`). */
      missing: string[]
      /** Sin nada registrado: se descarta de un toque. */
      empty?: boolean
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
      /** Su tarea: sin conversación, es lo que la fila abre. */
      taskId: string | null
      contactId?: string | null
      /** Nadie lo tomó todavía. */
      unclaimed: boolean
      /** Instagram o Messenger ya no dejan escribirle: se le escribe por otro canal. */
      windowClosed?: boolean
      /** Quien lo tiene, si no es quien mira. */
      assigneeName?: string | null
      /** «Ahora»: alta, o dos horas de clínica abierta esperando (decisión 1 del pulido). */
      urgent?: boolean
      /** De qué trata: cita, precio, clínico, pago u otro (R3). */
      topicKind?: string
      /** Quien mira lo responde desde aquí: responder lo toma al enviar. */
      canReply?: boolean
      /** Lo que preguntó: la fila lo dice. */
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
      personId?: string | null
      patientName: string
      phone: string | null
      startsAt: string
      branchName: string
      serviceName: string | null
    }
  /** Una cita de un día que ya terminó y nadie cerró: ¿vino o no vino? No se marca sola. */
  | {
      kind: "unclosed"
      id: string
      patientId: string
      patientName: string
      startsAt: string
      professionalUserId: string
      professionalName: string | null
      serviceName: string | null
      branchName: string
      /** Marcó «Llegó» ese día y nadie registró su atención. */
      arrived?: boolean
      version?: number
    }
  /** Las citas sin cerrar de hace más de un mes, juntas: se revisan de una vez. */
  | { kind: "unclosedOld"; count: number; oldestAt: string }
  /** Recepción la cerró con «Vino» y su profesional (quien mira) no registró lo que se hizo. */
  | {
      kind: "cameUnrecorded"
      id: string
      patientId: string
      personId?: string | null
      patientName: string
      startsAt: string
      serviceName: string | null
      markedAt: string
      markedByName: string | null
      version: number
    }
  /** Quienes tienen algo aceptado sin una cita que lo lleve: lleva a Pacientes › «Por agendar». */
  | { kind: "acceptedUnbooked"; patients: number; cents: number; currency: string }
  /** Los controles vencidos sin cita: abre la lista de la línea de Argos «Avisar un control». */
  | { kind: "overdueControls"; controls: number; patients: number; mine?: boolean }
  /** Una conversación que espera respuesta: con quién y qué pidió. */
  | {
      kind: "person"
      conversationId: string
      contactId: string
      contactName: string | null
      channel: string | null
      quote: string | null
      since: string
      urgent: boolean
      windowClosed: boolean
      /** Lo último que se le quiso decir no salió. */
      undelivered?: boolean
      /** De eso, el canal no confirmó si salió. */
      uncertain?: boolean
    }
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
      /** Solo si va en dos monedas: un total por cada una. */
      totals?: Array<{ currency: string; totalCents: number | null }>
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
      /** `registro` guardado: por qué se parece. */
      match?: "documento" | "celular"
      /** `registro` guardado: cuántos datos de lo que escribió no coinciden con lo que ya tiene. */
      differences?: number
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
  /** Los avisos que WhatsApp pasó a promoción, juntos: solo salen a quien aceptó novedades (ADR 0040). */
  | { kind: "promotions"; items: WaitingPromotion[] }
  /** `startsAt`: en «citas más sin cerrar», la primera que no cupo (la Agenda abre en su día). */
  | { kind: "more"; of: "cases" | "tasks" | "unconfirmed" | "unclosed" | "unsentBudgets" | "conversations"; count: number; startsAt?: string | null }

/** Un aviso que WhatsApp pasó a promoción y el texto solo de aviso que prepara odentIA. */
export interface WaitingPromotion {
  messageId: string
  title: string
  connectionId?: string
  noticeText?: string | null
  inReview?: boolean
  /** WhatsApp no aceptó el texto de aviso: hay que escribir otro. */
  rejected?: boolean
}

/** Una fila de la lista: su grupo y lo demás de esa persona, si su rol puede verlo. */
export type WaitingEntry = WaitingRow & { band: WaitingBand; also?: WaitingRow[] }
export interface WorkspaceAppointment {
  id: string
  patientId: string
  patientName: string
  startsAt: string
  endsAt: string
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
  /** Lo que llevaba y ya se terminó: la cita quedó sin objeto. */
  doneFor?: string | null
}
/** Cuántas citas hay hoy: en sala, en atención, atendidas y por venir (las que aún no llegan). */
export interface WorkspaceTodaySummary {
  total: number
  waiting: number
  attending: number
  attended: number
  upcoming: number
  unconfirmed: number
  /** Su hora terminó y nadie dijo si vino: con esta, las cifras suman `total`. */
  unclosed: number
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
  /** Lo cobrado en la otra moneda: va aparte, nunca sumado. Solo si la clínica la tiene. */
  secondCollected?: { currency: string; cents: number }
  /** Cobros del día: un ticket con dos medios cuenta una vez. */
  tickets: number
  /** Atendidos hoy con algo por cobrar: la misma lista de Finanzas › Caja. */
  toCollect: DebtRow[]
}

/** «Cobrado S/ 150.00 + USD 80.00 en 2 cobros»: la otra moneda, solo si se cobró algo en ella. */
export function cashCollectedText(cash: WorkspaceCash, locale: string): string {
  const second = cash.secondCollected?.cents ? cash.secondCollected : null
  const money = `${formatMoney(cash.collectedCents, cash.currency, locale)}${second ? ` + ${formatMoney(second.cents, second.currency, locale)}` : ""}`
  return `Cobrado ${money} en ${cash.tickets} ${cash.tickets === 1 ? "cobro" : "cobros"}`
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
