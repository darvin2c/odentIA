/** Contratos de la agenda con la API (`/api/agenda` y `/api/appointments`). */
import { sessionWords } from "@odentia/clinical"
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
      // Equipo cuenta las citas por venir de cada persona.
      "team-attendance",
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
  | "sin_cerrar"
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
  /**
   * Solo al reservar, mover o cancelar: si el agente le avisará a la persona y, si no le llegará,
   * por qué (`why`, una frase sin punto) y si hay que avisarle a mano (`byHand`).
   */
  notice?: { queued: boolean; why?: string; byHand?: boolean; to?: string }
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
  /** En qué sesión va cada tratamiento de varias que la cita lleva (calculado por el servidor). */
  sessions?: AppointmentSession[]
  /** Todo lo que se le sumó y aún no se hizo, también lo de una sesión (la resina sumada a su consulta). */
  brings?: Array<{ planItemId: string; title: string }>
  /** Solo al reservar: los controles pedidos que no se sumaron porque su día no cae en su ventana. */
  controlsLeftOut?: Array<{ id: string; title: string; from: string }>
  /** Los minutos que suele pedir lo que lleva, si son más que los reservados; null si alcanza. */
  needsMinutes?: number | null
  /** Lo que llevaba y ya se terminó, si no le queda nada por hacer: la cita quedó sin objeto. */
  doneFor?: string | null
  /** Su servicio era el de un tratamiento ya terminado: no se nombra como lo que viene a hacer. */
  serviceDone?: boolean
}

/** «Era para Corona, que ya se terminó»: la cita quedó sin objeto (QA del 10 nov, M1). */
export function doneForWords(appointment: Pick<AgendaAppointment, "doneFor">): string | null {
  return appointment.doneFor ? `era para ${appointment.doneFor}, que ya se terminó` : null
}

/** «Reservada 30 min; lo que lleva suele necesitar unos 90»: solo cuando no alcanza. */
export function appointmentShortWords(
  appointment: Pick<AgendaAppointment, "startsAt" | "endsAt" | "needsMinutes">,
): string | null {
  if (!appointment.needsMinutes) return null
  const reserved = Math.round(
    (new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60_000,
  )
  return `Reservada ${reserved} min; lo que lleva suele necesitar unos ${appointment.needsMinutes}`
}

/** «Endodoncia · sesión 2 de 2»: lo que la cita viene a hacer de un tratamiento de varias sesiones. */
export interface AppointmentSession {
  planItemId: string
  title: string
  n: number
  m: number
}

/**
 * Lo que la cita dice de sus sesiones. Si lleva una sola y es del servicio de la
 * cita, basta «sesión 2 de 2»; si no, cada una con su nombre.
 */
export function appointmentSessionsText(
  sessions: AppointmentSession[] | undefined,
  serviceName: string | null = null,
): string | null {
  if (!sessions?.length) return null
  if (sessions.length === 1 && sessions[0]!.title === serviceName) return sessionWords(sessions[0]!.n, sessions[0]!.m)
  return sessions.map((session) => `${session.title} · ${sessionWords(session.n, session.m)}`).join(" · ")
}

/** El estado de cada momento como lo entiende la rejilla (`ScheduleState`). */
const VISIT_STATE: Record<AppointmentVisit, ScheduleState> = {
  por_confirmar: "programada",
  confirmada: "confirmada",
  sin_cerrar: "sin_cerrar",
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

/**
 * Su hora pasó sin llegada ni atención: «Sin cerrar». Lo dice el servidor
 * (`sin_cerrar`); `now` cubre la cita que terminó mientras la pantalla seguía
 * abierta. Nadie la marca sola.
 */
export function isUnclosed(item: { visit: AppointmentVisit; endsAt: string }, now: string): boolean {
  if (item.visit === "sin_cerrar") return true
  return (item.visit === "por_confirmar" || item.visit === "confirmada") && Date.parse(item.endsAt) <= Date.parse(now)
}


/** El estado para el icono y el color de la rejilla, la lista y el cajón. */
export function visitState(visit: AppointmentVisit): ScheduleState {
  return VISIT_STATE[visit]
}

/** Llegó, está en atención o quedó sin cerrar: lo que la rejilla y la lista dicen por encima del estado guardado. */
export function visitStage(visit: AppointmentVisit): ScheduleStage | undefined {
  return visit === "llego" || visit === "en_atencion" || visit === "sin_cerrar" ? visit : undefined
}

/** «la Dra. Ana», «el Dr. Luis» o «Ana»: cómo se nombra en una frase a quien atiende. */
export function professionalSaid(name: string, options: { full?: boolean } = {}): string {
  const said = options.full ? name : name.split(/\s+/).slice(0, 2).join(" ")
  if (/^dra\.?\s/i.test(name)) return `la ${said}`
  if (/^dr\.?\s/i.test(name)) return `el ${said}`
  return said
}

/** «de la Dra. Ana», «del Dr. Luis» o «de Ana»: «de» y quien atiende, con su contracción. */
export function ofProfessional(name: string, options: { full?: boolean } = {}): string {
  const said = professionalSaid(name, options)
  return said.startsWith("el ") ? `del ${said.slice(3)}` : `de ${said}`
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
  /** Atendida con «Vino» (sin atención): quién lo marcó y cuándo. */
  came?: { byName: string | null; at: string } | null
  confirmation: { askAt: string | null; askedAt: string | null } | null
  /** «Faltan datos para atenderla», del servidor; null para quien no edita los datos. */
  missingData: Array<{ key: string; label: string }> | null
  /** Para que la frase concuerde con el paciente («atenderlo»); null sin registrar o sin permiso. */
  patientSex?: string | null
}

export interface AgendaResources {
  branchId: string
  branchName: string
  timeZone: string
  /** Quienes pueden atender (ADR 0128); `role` separa a quien atiende de oficio de quien dirige. */
  professionals: { id: string; label: string; role: string }[]
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
    /** Se pidió al abrir y no está entre quienes atienden el servicio: viene igual, y se dice. */
    outsideService?: true
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
 * Agenda, su cajón e Inicio:
 * - hoy, pasada su hora (`tarde`): quien llega tarde es lo común, así que
 *   «Llegó» primero, y después «Registrar la atención» o «No vino»;
 * - otro día, pasada su hora (`cerrar`): «¿Vino?», con «Vino», «Registrar la
 *   atención» o «No vino»;
 * - hoy, cerca de la hora, «Llegó»; y antes, confirmarla.
 */
export function stepBeforeArrival(
  item: { visit: AppointmentVisit; startsAt: string; endsAt: string },
  now: string,
  isToday: boolean,
): "tarde" | "cerrar" | "llego" | "confirmar" | null {
  if (item.visit !== "por_confirmar" && item.visit !== "confirmada" && item.visit !== "sin_cerrar") return null
  if (item.visit === "sin_cerrar" || Date.parse(item.endsAt) <= Date.parse(now)) return isToday ? "tarde" : "cerrar"
  const soon = isToday && Date.parse(item.startsAt) - Date.parse(now) <= ARRIVAL_WINDOW_MS
  if (item.visit === "por_confirmar" && !soon) return "confirmar"
  return isToday ? "llego" : null
}

/**
 * Lo que dice el aviso tras mover una cita, además de adónde fue: si se quitó su llegada o quedó
 * por confirmar (confirmó el otro día), si «Deshacer» le devolvió la llegada o la confirmación y
 * si el agente le avisa a la persona.
 */
export function movedNote(
  before: Pick<AgendaAppointment, "status" | "arrivedAt">,
  after: Pick<AgendaAppointment, "status" | "arrivedAt" | "notice">,
): string | undefined {
  const unconfirmed = before.status === "confirmada" && after.status === "programada"
  const notes = [
    before.arrivedAt && !after.arrivedAt
      ? unconfirmed
        ? "Se quitó «Llegó» y queda por confirmar."
        : "Se quitó «Llegó»."
      : unconfirmed
        ? "Queda por confirmar: confirmó el otro día."
        : null,
    !before.arrivedAt && after.arrivedAt
      ? "Vuelve a figurar que llegó."
      : before.status === "programada" && after.status === "confirmada"
        ? "Vuelve a quedar confirmada."
        : null,
    noticeLine(after.notice, "El agente le avisa la nueva fecha."),
  ]
  return notes.filter(Boolean).join(" ") || undefined
}

/**
 * Lo que el aviso flotante dice del aviso a la persona: `sent` si va en camino; si no le llegará,
 * por qué, sin pedir nada cuando lo decidió la clínica o quedó una tarea. Lo que hay que avisarle
 * a mano va aparte y fijo (`noticeWarning`): un aviso que sale siempre deja de leerse (mesa del 11 nov).
 */
export function noticeLine(notice: AgendaAppointment["notice"], sent: string): string | null {
  if (!notice || notice.byHand) return null
  if (notice.why) return notice.queued ? `${notice.why}.` : `No se le avisa. ${notice.why}.`
  return notice.queued ? sent : null
}

/** De qué cambio habla el aviso que no le llegará: así no se confunde con otro (QA del 11 nov). */
export interface NoticeChange {
  change: "reservada" | "movida" | "cancelada"
  /** El día y la hora de la cita, como los dice la Agenda («mañana a las 10:00», `whenSaid`); sin ella, no se nombra. */
  when?: string
  /** Al reservar: tampoco le llegará el recordatorio, y se dice en el mismo aviso, con una sola orden. */
  reminderToo?: boolean
}

/** `whose`: «su cita», o «la cita de Sofía Salas» cuando el aviso es para quien recibe los de ella. */
const NOTICE_ABOUT: Record<NoticeChange["change"], (whose: string, when: string | undefined) => string> = {
  reservada: (whose, when) => (when ? `de ${whose}, reservada para ${when}` : `de ${whose}, que se reservó`),
  movida: (whose, when) => (when ? `de que ${whose} ahora es ${when}` : `de que ${whose} cambió`),
  cancelada: (whose, when) => (when ? `de que se canceló ${whose}, que era ${when}` : `de que se canceló ${whose}`),
}

/** El aviso que no le llegará por algo de la persona, para avisarle a mano: queda a la vista hasta cerrarlo. */
export function noticeWarning(appointment: Pick<AgendaAppointment, "notice" | "patientName">, about: NoticeChange): string | null {
  const notice = appointment.notice
  if (!notice?.byHand || !notice.why) return null
  // A quien recibe sus avisos, si no es el paciente (su madre): la cita se nombra por el paciente.
  const who = notice.to ?? appointment.patientName
  const what = NOTICE_ABOUT[about.change](notice.to ? `la cita de ${appointment.patientName}` : "su cita", about.when)
  return about.reminderToo
    ? `${who} no recibirá el aviso ${what}, ni el recordatorio. ${notice.why}. Avísale tú ahora y un día antes.`
    : `${who} no recibirá el aviso ${what}. ${notice.why}. Avísale tú.`
}
