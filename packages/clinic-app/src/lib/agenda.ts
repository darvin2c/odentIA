/** Contratos de la agenda con la API (`/api/agenda` y `/api/appointments`). */
import {
  dayMinutesIn,
  hourLabel,
  SCHEDULE_STATE_LABELS,
  type ScheduleStage,
  type ScheduleState,
} from "@odentia/ui-patterns"
import type { QueryClient } from "@tanstack/react-query"
import type { PhoneWhatsApp } from "./phone-whatsapp"

/** Una cita afecta disponibilidad y seguimiento, también en superficies no montadas. */
export async function invalidateAppointmentQueries(client: QueryClient): Promise<void> {
  await Promise.all(
    [
      "agenda",
      "agenda-appointment",
      "agenda-availability",
      "agenda-resources",
      "agenda-search",
      "follow-up-appointments",
      "follow-ups",
      "patient-appointments",
      "patient-summary",
      // «Qué sigue» y la lista de Pacientes cambian al reservar desde la ficha.
      "plan-next",
      "people",
      "treatment-coordination",
      "treatment-journey",
      "workspace-home",
    ].map((key) => client.invalidateQueries({ queryKey: [key] })),
  )
}

export type AppointmentStatus =
  | "programada"
  | "confirmada"
  | "atendida"
  | "no_asistio"
  | "cancelada"

/**
 * El momento de la cita que calcula el servidor (ADR 0032): sale del estado, de
 * la hora de llegada y de la atención unida. Los nombres los pone `visitName`.
 */
export type AppointmentVisit =
  | "por_confirmar"
  | "confirmada"
  | "llego"
  | "en_atencion"
  | "atendida"
  | "no_vino"
  | "cancelada"

/** La atención unida a la cita, sin nada de la historia: quién la lleva y desde cuándo. */
export interface AppointmentEncounterRef {
  id: string
  status: "borrador" | "finalizada"
  startedAt: string
  endedAt: string | null
  professionalUserId: string
  professionalName: string
}

export interface AgendaAppointment {
  id: string
  patientId: string
  patientName: string
  professionalUserId: string
  professionalName: string
  roomId: string
  roomName: string
  branchId: string
  serviceId: string | null
  serviceName: string | null
  status: AppointmentStatus
  startsAt: string
  endsAt: string
  reason: string | null
  version: number
  /** De dónde salió la cita: recepción, una conversación, el agente o el enlace de reserva. */
  source?: string
  conversationId?: string | null
  /** Solo al reservar, mover o cancelar: si el agente le avisará a la persona. */
  notice?: { queued: boolean }
  /** Cuándo llegó; null si nadie lo marcó. */
  arrivedAt: string | null
  visit: AppointmentVisit
  /** La atención unida (abierta o firmada); null sin atención. */
  encounter: AppointmentEncounterRef | null
  /**
   * Cita de prueba (ADR 0094): de qué prueba salió, quién la hizo en «Probar»
   * (nulo en la del chat web) y cuándo se borra sola. Null en una cita real.
   */
  test?: { conversationId: string | null; byUserId: string | null; byName: string | null; deletesAt: string | null } | null
}

/** El estado de cada momento como lo entiende la rejilla (`ScheduleState`). */
const VISIT_STATE: Record<AppointmentVisit, ScheduleState> = {
  por_confirmar: "programada",
  confirmada: "confirmada",
  llego: "llego",
  en_atencion: "en_atencion",
  atendida: "atendida",
  no_vino: "no_asistio",
  cancelada: "cancelada",
}

/** El nombre del momento, el mismo en toda la aplicación («Por confirmar», «Llegó», «No vino»…). */
export function visitName(visit: AppointmentVisit): string {
  return SCHEDULE_STATE_LABELS[VISIT_STATE[visit]]
}

/** El estado para el icono y el color de la rejilla, la lista y el cajón. */
export function visitState(visit: AppointmentVisit): ScheduleState {
  return VISIT_STATE[visit]
}

/** Llegó o está en atención: lo que la rejilla y la lista dicen por encima del estado guardado. */
export function visitStage(visit: AppointmentVisit): ScheduleStage | undefined {
  return visit === "llego" || visit === "en_atencion" ? visit : undefined
}

/** «la Dra. Ana», «el Dr. Luis» o «Ana»: cómo se nombra en una frase a quien atiende. */
export function professionalSaid(name: string, options: { full?: boolean } = {}): string {
  const said = options.full ? name : name.split(/\s+/).slice(0, 2).join(" ")
  if (/^dra\.?\s/i.test(name)) return `la ${said}`
  if (/^dr\.?\s/i.test(name)) return `el ${said}`
  return said
}

/** Más de una hora se dice en horas: «espera 388 min» no se entiende. */
function waitWords(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const rest = minutes % 60
  return rest > 0 ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`
}

/** Minutos enteros de espera desde la llegada, nunca negativos. */
export function waitMinutes(arrivedAt: string, now: string): number {
  return Math.max(0, Math.floor((Date.parse(now) - Date.parse(arrivedAt)) / 60_000))
}

/**
 * El momento de la cita con su hora, en palabras: «Llegó 10:00 · espera 6 min»,
 * «En atención · con la Dra. Ana desde 10:06», «Atendida · 10:35» o el nombre
 * del estado. Así se dice en la Agenda, en el cajón y en Inicio.
 */
export function visitLabel(
  appointment: Pick<AgendaAppointment, "visit" | "arrivedAt" | "encounter">,
  context: { now: string; timeZone: string },
): string {
  const clock = (iso: string) => hourLabel(dayMinutesIn(iso, context.timeZone))
  if (appointment.visit === "llego" && appointment.arrivedAt) {
    return `Llegó ${clock(appointment.arrivedAt)} · espera ${waitWords(waitMinutes(appointment.arrivedAt, context.now))}`
  }
  if (appointment.visit === "en_atencion" && appointment.encounter) {
    return `En atención · con ${professionalSaid(appointment.encounter.professionalName)} desde ${clock(appointment.encounter.startedAt)}`
  }
  if (appointment.visit === "atendida" && appointment.encounter?.endedAt) {
    return `Atendida · ${clock(appointment.encounter.endedAt)}`
  }
  return visitName(appointment.visit)
}

/** Lo que el cajón de la cita dice además de la cita (`GET /api/appointments/:id/context`). */
export interface AppointmentContext {
  person: {
    contactId: string
    name: string
    phone: string | null
    relationship: string
    /** Si su teléfono es su WhatsApp, aún no o no tiene (decisión 23). */
    whatsapp: PhoneWhatsApp
  } | null
  origin: { source: string; conversationId: string | null; channel: string | null; at: string }
  confirmation: { askAt: string | null; askedAt: string | null } | null
  /** «Faltan datos para atenderla», del servidor; null para quien no edita los datos. */
  missingData: Array<{ key: string; label: string }> | null
}

export interface AgendaResources {
  branchId: string
  branchName: string
  timeZone: string
  professionals: { id: string; label: string }[]
  rooms: { id: string; label: string }[]
  /** Lo que dura una cita regular en la sede, en minutos. */
  defaultDurationMin: number
}

/** Una unidad dental en Configuración (`GET /api/agenda/rooms`): también las desactivadas. */
export interface RoomSetting {
  id: string
  name: string
  isActive: boolean
  /** Citas en pie que aún no terminan en esa unidad dental: no se mueven solas al desactivarla. */
  upcomingAppointments: number
}

export interface AgendaServiceOption {
  id: string
  name: string
  durationMin: number | null
}

export interface ScheduleRule {
  id: string
  weekday: number
  startMin: number
  endMin: number
  isActive: boolean
}

export interface ProfessionalSchedule {
  branchId: string
  professionalUserId: string
  timeZone: string
  rules: ScheduleRule[]
  /** Desde qué día vale el horario de hoy (ADR 0060); nulo sin horario. */
  validFrom: string | null
}

export interface ScheduleBlock {
  id: string
  branchId: string
  professionalUserId: string | null
  professionalName: string | null
  roomId: string | null
  kind: "bloqueo" | "ausencia"
  reason: string | null
  startsAt: string
  endsAt: string
}

/** Lo que la agenda pinta como reservable (`GET /api/agenda/availability`). */
export interface AgendaAvailability {
  branchId: string
  timeZone: string
  professionals: {
    id: string
    label: string
    nextFree: { startsAt: string; endsAt: string; roomId: string | null } | null
  }[]
  defaultDurationMin: number
  open: { professionalUserId: string; startsAt: string; endsAt: string }[]
  /** Tramos en que cada profesional puede recibir una cita: su horario menos lo ocupado. */
  free: { professionalUserId: string; startsAt: string; endsAt: string }[]
  blocks: ScheduleBlock[]
  /** Con servicio: si alguien lo atiende en la sede, solo esas personas (ADR 0039). */
  attending?: { specialtyName: string; professionalUserIds: string[] } | null
}

/** Persona encontrada al buscar una cita, con sus próximas citas en pie. */
export interface AgendaSearchPerson {
  patientId: string
  patientName: string
  appointments: AgendaAppointment[]
}

export const WEEKDAY_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]

/** Minutos → "HH:MM" para los turnos del horario semanal. */
export function minutesLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}

/** «Confirmar cita» deja paso a «Llegó» desde una hora antes de la cita. */
const ARRIVAL_WINDOW_MS = 60 * 60_000

/**
 * El paso de una cita que aún no llega, con la misma regla en la lista de la
 * Agenda, su cajón e Inicio: pasada su hora se cierra («Registrar la atención»
 * o «No vino»); hoy, cerca de la hora, «Llegó»; y antes, confirmarla.
 */
export function stepBeforeArrival(
  item: { visit: AppointmentVisit; startsAt: string; endsAt: string },
  now: string,
  isToday: boolean,
): "cerrar" | "llego" | "confirmar" | null {
  if (item.visit !== "por_confirmar" && item.visit !== "confirmada") return null
  if (Date.parse(item.endsAt) <= Date.parse(now)) return "cerrar"
  const soon = isToday && Date.parse(item.startsAt) - Date.parse(now) <= ARRIVAL_WINDOW_MS
  if (item.visit === "por_confirmar" && !soon) return "confirmar"
  return isToday ? "llego" : null
}
