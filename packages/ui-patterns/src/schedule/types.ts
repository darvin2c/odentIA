/**
 * Contrato del dominio de agenda. La cita llega resuelta: instantes ISO con
 * zona y un estado del negocio. El patrón la coloca en pantalla, la mueve y
 * anuncia; quién valida el hueco, persiste y confirma es trabajo del servicio
 * (`packages/services`), nunca del componente.
 */

/** Estados de la cita tal como los entiende recepción. */
export type ScheduleStatus = "programada" | "confirmada" | "atendida" | "no_asistio" | "cancelada"

export interface ScheduleEntry {
  id: string
  /** Recurso dueño de la cita (profesional, sillón): la columna donde se pinta. */
  columnId: string
  /** Instant exacto, ISO 8601 con zona («2026-09-21T13:00:00.000Z»). */
  start: string
  end: string
  status: ScheduleStatus
  /** Lo que se lee primero: la persona. */
  title: string
  /** Lo segundo: el motivo («Limpieza»). */
  subtitle?: string
  /** Etiqueta breve de la asignación complementaria a la fila. */
  resourceLabel?: string
  /** Conflicto calculado por el consumidor sobre todas las reservas, antes de filtrar. */
  warning?: string
}

/** Recurso de la agenda: profesional en la línea de tiempo, día en la semana. */
export interface ScheduleColumn {
  id: string
  label: string
  /** Segunda línea: especialidad, sede, número de sillón. */
  detail?: string
  /** Aviso del recurso para la fecha consultada, incluso con citas ocultas. */
  warning?: string
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
/** Extensión de la ventana por scroll infinito, hacia el borde tocado. */
export type ScheduleExtendHandler = (edge: "start" | "end") => void
