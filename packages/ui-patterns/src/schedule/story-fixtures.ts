/**
 * Material de las stories de agenda. No sale en el barrel: es para Storybook
 * y pruebas. Determinista (Lima, semana del 21 de setiembre de 2026) y con
 * estado vivo: `useScheduleDemo` y `useDaysDemo` hacen que las stories
 * arrastren, redimensionen y carguen días de verdad, no solo prometan.
 */

import * as React from "react"

import { addDays, minutesToInstant } from "./time.js"
import type {
  ScheduleBlocked,
  ScheduleColumn,
  ScheduleEntry,
  ScheduleMove,
  ScheduleStatus,
} from "./types.js"

export const SCHEDULE_TIME_ZONE = "America/Lima"
/** Lunes: la semana de las stories empieza hoy. */
export const SCHEDULE_DATE = "2026-09-21"

/** Instante del día de las stories; la hora es ya la del muro de Lima. */
export function scheduleInstant(hour: number, minute = 0, date = SCHEDULE_DATE): string {
  return minutesToInstant(date, hour * 60 + minute, SCHEDULE_TIME_ZONE)
}

export const SCHEDULE_COLUMNS: ScheduleColumn[] = [
  { id: "ana", label: "Dra. Ana Quispe", detail: "Odontología general" },
  { id: "luis", label: "Dr. Luis Ramos", detail: "Endodoncia" },
  { id: "elena", label: "Dra. Elena Vargas", detail: "Ortodoncia" },
]

function entry(
  id: string,
  columnId: string,
  startHour: number,
  startMinute: number,
  duration: number,
  title: string,
  subtitle: string,
  status: ScheduleStatus,
  date = SCHEDULE_DATE,
): ScheduleEntry {
  const start = scheduleInstant(startHour, startMinute, date)
  return {
    id,
    columnId,
    start,
    end: minutesToInstant(
      date,
      startHour * 60 + startMinute + duration,
      SCHEDULE_TIME_ZONE,
    ),
    status,
    title,
    subtitle,
  }
}

/**
 * Doce citas del lunes con los cinco estados y DOS SOLAPES (c1/c10 y c6/c12):
 * la doble reserva debe verse lado a lado, no una cita tapando a otra.
 */
export const SCHEDULE_ENTRIES: ScheduleEntry[] = [
  entry("c1", "ana", 8, 0, 60, "Rosa Quispe", "Limpieza", "confirmada"),
  entry("c10", "ana", 8, 30, 45, "Julio Paredes", "Urgencia", "programada"),
  entry("c2", "ana", 9, 15, 45, "Miguel Torres", "Control", "programada"),
  entry("c3", "ana", 11, 0, 90, "Lucía Fernández", "Endodoncia", "confirmada"),
  entry("c11", "ana", 17, 0, 60, "Carmen Silva", "Control", "confirmada"),
  entry("c4", "luis", 8, 30, 90, "Pedro Castillo", "Endodoncia", "atendida"),
  entry("c5", "luis", 10, 30, 45, "María López", "Consulta", "programada"),
  entry("c6", "luis", 14, 0, 60, "Jorge Díaz", "Endodoncia", "confirmada"),
  entry("c12", "luis", 14, 30, 45, "Teresa Luna", "Dolor agudo", "programada"),
  entry("c7", "elena", 9, 0, 45, "Ana Torres", "Ortodoncia", "no_asistio"),
  entry("c8", "elena", 13, 0, 30, "Luis Vega", "Ajuste", "cancelada"),
  entry("c9", "elena", 15, 0, 90, "Sofía Herrera", "Ortodoncia", "confirmada"),
]

/** Tramos no disponibles: el almuerzo se bloquea en el carril, no en el día. */
export const SCHEDULE_BLOCKED: ScheduleBlocked[] = [
  {
    id: "b1",
    columnId: "ana",
    start: scheduleInstant(13, 0),
    end: scheduleInstant(14, 0),
    label: "Almuerzo",
  },
  {
    id: "b2",
    columnId: "elena",
    start: scheduleInstant(12, 0),
    end: scheduleInstant(12, 30),
    label: "Reunión",
  },
]

const WEEK_PATIENTS = ["Rosa Quispe", "Miguel Torres", "Lucía Fernández", "Pedro Castillo", "María López"]
const WEEK_SERVICES = ["Limpieza", "Control", "Endodoncia", "Consulta", "Ortodoncia"]
const WEEK_STATUSES: ScheduleStatus[] = ["confirmada", "programada", "atendida", "programada", "confirmada"]

/**
 * Citas deterministas de cualquier fecha, para el timeline infinito: el hash
 * de la fecha decide cuántas hay, a qué hora y con quién. El fin de semana
 * descansa casi entero, como la clínica real.
 */
export function scheduleDayEntries(date: string): ScheduleEntry[] {
  let hash = 0
  for (const char of date) hash = (hash * 31 + char.charCodeAt(0)) | 0
  const pick = (n: number, mod: number) => Math.abs(hash + n * 7) % mod
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
  if (weekday === 0) return []
  const perResource = weekday === 6 ? 2 : 4 + (Math.abs(hash) % 3)
  return SCHEDULE_COLUMNS.flatMap((column, columnIndex) =>
    Array.from({ length: perResource }, (_, slotIndex) => {
      const seed = Math.abs(hash + columnIndex * 13 + slotIndex * 41)
      const startMinutes = 480 + (seed % 9) * 60 + (seed % 4) * 15
      const duration = 30 + (seed % 3) * 15
      return entry(
        `d-${date}-${column.id}-${slotIndex}`,
        column.id,
        Math.floor(startMinutes / 60),
        startMinutes % 60,
        duration,
        WEEK_PATIENTS[seed % WEEK_PATIENTS.length],
        WEEK_SERVICES[(seed + 1) % WEEK_SERVICES.length],
        WEEK_STATUSES[seed % WEEK_STATUSES.length],
        date,
      )
    }),
  )
}

/**
 * Días infinitos del timeline: `radius` días a cada lado del centro y las
 * sentinelas cargan de a uno con latencia fingida.
 */
export function useDaysDemo(center: string, radius = 3) {
  const [dates, setDates] = React.useState<string[]>(() =>
    Array.from({ length: radius * 2 + 1 }, (_, i) => addDays(center, i - radius)),
  )
  const [extending, setExtending] = React.useState(false)
  const extendDays = React.useCallback((edge: "start" | "end") => {
    setExtending(true)
    window.setTimeout(() => {
      setDates((cur) =>
        edge === "start" ? [addDays(cur[0], -1), ...cur] : [...cur, addDays(cur.at(-1)!, 1)],
      )
      setExtending(false)
    }, 350)
  }, [])
  return { dates, extendDays, extending }
}


/** Estado vivo de las stories del timeline: arrastrar cambia los datos. */
export function useScheduleDemo(initial: ScheduleEntry[]) {
  const [entries, setEntries] = React.useState(initial)

  // El timeline infinito regenera sus citas cuando cargan días nuevos.
  React.useEffect(() => {
    setEntries(initial)
  }, [initial])

  const move = React.useCallback((moved: ScheduleEntry, target: ScheduleMove) => {
    setEntries((prev) =>
      prev.map((item) =>
        item.id === moved.id
          ? { ...item, columnId: target.columnId, start: target.start, end: target.end }
          : item,
      ),
    )
  }, [])

  const resize = React.useCallback((resized: ScheduleEntry, end: string) => {
    setEntries((prev) => prev.map((item) => (item.id === resized.id ? { ...item, end } : item)))
  }, [])

  return { entries, move, resize }
}

