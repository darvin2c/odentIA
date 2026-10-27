/**
 * Contrato del dominio de agenda. La cita llega resuelta: instantes ISO con
 * zona y un estado del negocio. El patrón la coloca en pantalla, la mueve y
 * anuncia; quién valida el hueco, persiste y confirma es trabajo del servicio
 * (`packages/services`), nunca del componente.
 */

/** Estados de la cita tal como los guarda el servicio. */
export type ScheduleStatus = "programada" | "confirmada" | "atendida" | "no_asistio" | "cancelada"

/**
 * Lo que pasa con la persona en una cita en pie, que no es un estado guardado:
 * llegó y espera, o ya la están atendiendo (ADR 0032). El servicio lo calcula.
 */
export type ScheduleStage = "llego" | "en_atencion"

/** El estado que se dice en pantalla: el guardado o, si lo hay, el momento de la persona. */
export type ScheduleState = ScheduleStatus | ScheduleStage

export interface ScheduleEntry {
  id: string
  /** Recurso dueño de la cita (profesional, unidad dental): la columna donde se pinta. */
  columnId: string
  /** Instant exacto, ISO 8601 con zona («2026-09-21T13:00:00.000Z»). */
  start: string
  end: string
  status: ScheduleStatus
  /** Llegó o está en atención: manda sobre `status` al decir el estado y al ordenar la lista. */
  stage?: ScheduleStage
  /** El estado con su hora, ya en palabras («Llegó 10:00 · espera 6 min»); sin él, el nombre del estado. */
  stateLabel?: string
  /** Lo que se lee primero: la persona. */
  title: string
  /** Lo segundo: el motivo («Limpieza»). */
  subtitle?: string
  /** Etiqueta breve de la asignación complementaria a la fila. */
  resourceLabel?: string
  /** Conflicto calculado por el consumidor sobre todas las reservas, antes de filtrar. */
  warning?: string
  /** Cita de prueba: se ve rayada y marcada, y no ocupa el horario de nadie. */
  test?: boolean
}

/**
 * Color categórico del recurso: lo identifica en iniciales y fichas a lo largo
 * de todas las vistas. No significa estado (eso lo dicen los colores de cita).
 */
export type ScheduleTone = 0 | 1 | 2 | 3 | 4

/** Recurso de la agenda: profesional en la línea de tiempo, día en la semana. */
export interface ScheduleColumn {
  id: string
  label: string
  /** Segunda línea: especialidad, sede, número de unidad dental. */
  detail?: string
  /** Aviso del recurso para la fecha consultada, incluso con citas ocultas. */
  warning?: string
  /** Color de identidad del recurso; sin él se usa el primero. */
  tone?: ScheduleTone
}

/**
 * Carril de la rejilla: un recurso en un día. La vista Día pone varios
 * recursos del mismo día; la vista Semana, un recurso en varios días.
 */
export interface ScheduleLane {
  /** Identidad del carril: el recurso en Día, la fecha en Semana. */
  id: string
  /** Recurso al que pertenecen las citas del carril. */
  columnId: string
  /** Día civil del carril («2026-09-21»). */
  date: string
  label: string
  /** Segunda línea de la cabecera: horario de atención del día. */
  detail?: string
  /** Dato que conviene ver de un vistazo («1 h 30 libres»). */
  summary?: string
  /** Iniciales con color solo cuando el carril es un recurso. */
  tone?: ScheduleTone
  kind?: "resource" | "day"
  warning?: string
}

/** Tramo de atención de un recurso: dentro se puede reservar, fuera no. */
export interface ScheduleAvailability {
  columnId: string
  start: string
  end: string
}

/**
 * Punto libre que la persona tocó para reservar. Es una intención: quién
 * valida el hueco y reserva es el servicio.
 */
export interface ScheduleCreateTarget {
  columnId: string
  date: string
  start: string
  end: string
}

/** Cita aún sin reservar que el formulario propone y la rejilla deja ver. */
export interface SchedulePreview {
  columnId: string
  start: string
  end: string
  title: string
  subtitle?: string
}

/** Tramo no disponible de un recurso (almuerzo, feriado, mantenimiento). */
export interface ScheduleBlocked {
  id: string
  columnId: string
  start: string
  end: string
  label?: string
}

/** Hueco libre que devolvió el servicio de reserva; el patrón no calcula ninguno. */
export interface ScheduleSlot {
  columnId: string
  start: string
  end: string
}

/** Ventana visible del eje de tiempo, en minutos del día (0–1440). */
export interface ScheduleWindow {
  startMinutes: number
  endMinutes: number
}

/** Ventana por defecto de la jornada clínica: 08:00–20:00. */
export const SCHEDULE_DEFAULT_WINDOW: ScheduleWindow = {
  startMinutes: 8 * 60,
  endMinutes: 20 * 60,
}

/** Destino de un arrastre sobre el eje: recurso y rango nuevos como instantes. */
export interface ScheduleMove {
  columnId: string
  start: string
  end: string
}

export type ScheduleEntryHandler = (entry: ScheduleEntry) => void
export type ScheduleMoveHandler = (entry: ScheduleEntry, move: ScheduleMove) => void
/** Rango nuevo al redimensionar: cambia solo el borde arrastrado (inicio o fin). */
export interface ScheduleResize {
  start: string
  end: string
}
export type ScheduleResizeHandler = (entry: ScheduleEntry, resize: ScheduleResize) => void
