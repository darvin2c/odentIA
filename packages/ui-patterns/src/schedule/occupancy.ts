/**
 * Aritmética de tramos de la agenda, en minutos del día local. Sirve para
 * pintar: qué parte de la jornada está cerrada, ocupada o libre. No decide qué
 * se puede reservar: esa regla (sillón libre, bloqueos de sede, concurrencia)
 * vive en el servicio y la rejilla solo la refleja.
 */

import { dayBounds } from "./time.js"
import type { ScheduleWindow } from "./types.js"

const MINUTE_MS = 60_000

export interface MinuteRange {
  startMinutes: number
  endMinutes: number
}

/** Une tramos que se tocan o solapan y los devuelve ordenados. */
export function mergeRanges(ranges: readonly MinuteRange[]): MinuteRange[] {
  const sorted = ranges
    .filter((range) => range.endMinutes > range.startMinutes)
    .map((range) => ({ ...range }))
    .sort((a, b) => a.startMinutes - b.startMinutes)
  const merged: MinuteRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.startMinutes <= last.endMinutes) {
      last.endMinutes = Math.max(last.endMinutes, range.endMinutes)
    } else {
      merged.push(range)
    }
  }
  return merged
}

/** Lo que queda de `base` al quitarle `holes`. */
export function subtractRanges(
  base: readonly MinuteRange[],
  holes: readonly MinuteRange[],
): MinuteRange[] {
  const cuts = mergeRanges(holes)
  const result: MinuteRange[] = []
  for (const range of mergeRanges(base)) {
    let cursor = range.startMinutes
    for (const cut of cuts) {
      if (cut.endMinutes <= cursor || cut.startMinutes >= range.endMinutes) continue
      if (cut.startMinutes > cursor) {
        result.push({ startMinutes: cursor, endMinutes: cut.startMinutes })
      }
      cursor = Math.max(cursor, cut.endMinutes)
    }
    if (cursor < range.endMinutes) result.push({ startMinutes: cursor, endMinutes: range.endMinutes })
  }
  return result
}

/** Recorta los tramos a una ventana. */
export function clipRanges(ranges: readonly MinuteRange[], window: ScheduleWindow): MinuteRange[] {
  return ranges
    .map((range) => ({
      startMinutes: Math.max(range.startMinutes, window.startMinutes),
      endMinutes: Math.min(range.endMinutes, window.endMinutes),
    }))
    .filter((range) => range.endMinutes > range.startMinutes)
}

/** ¿El tramo cabe entero dentro de alguno de los tramos dados? */
export function isCovered(range: MinuteRange, within: readonly MinuteRange[]): boolean {
  return mergeRanges(within).some(
    (item) => item.startMinutes <= range.startMinutes && item.endMinutes >= range.endMinutes,
  )
}

/** ¿El tramo pisa alguno de los tramos dados? Los contiguos no se pisan. */
export function overlapsAny(range: MinuteRange, others: readonly MinuteRange[]): boolean {
  return others.some(
    (item) => item.startMinutes < range.endMinutes && item.endMinutes > range.startMinutes,
  )
}

/**
 * Minutos del día local que un intervalo de instantes ocupa en una fecha, o
 * null si no la toca. Un intervalo que cruza medianoche se recorta al día.
 */
export function dayRangeOf(
  startIso: string,
  endIso: string,
  dateISO: string,
  timeZone: string,
): MinuteRange | null {
  const bounds = dayBounds(dateISO, timeZone)
  const start = Math.max(Date.parse(startIso), bounds.start.getTime())
  const end = Math.min(Date.parse(endIso), bounds.end.getTime())
  if (!(end > start)) return null
  return {
    startMinutes: Math.round((start - bounds.start.getTime()) / MINUTE_MS),
    endMinutes: Math.round((end - bounds.start.getTime()) / MINUTE_MS),
  }
}

/**
 * Ventana que cubre la atención y las citas del periodo, redondeada a horas
 * completas. Una cita fuera del horario habitual ensancha la ventana: nunca
 * queda sin dibujar.
 */
export function windowCovering(
  ranges: readonly MinuteRange[],
  fallback: ScheduleWindow,
): ScheduleWindow {
  const valid = ranges.filter((range) => range.endMinutes > range.startMinutes)
  if (valid.length === 0) return fallback
  const start = Math.min(...valid.map((range) => range.startMinutes))
  const end = Math.max(...valid.map((range) => range.endMinutes))
  return {
    startMinutes: Math.max(0, Math.floor(start / 60) * 60),
    endMinutes: Math.min(1440, Math.ceil(end / 60) * 60),
  }
}

export type DaySegmentKind = "free" | "busy" | "closed" | "past"

export interface DaySegment extends MinuteRange {
  kind: DaySegmentKind
}

export interface DaySegmentsInput {
  window: ScheduleWindow
  /** Tramos de atención del recurso ese día. */
  open: readonly MinuteRange[]
  /** Citas que ocupan al recurso. */
  busy: readonly MinuteRange[]
  /** Bloqueos y ausencias. */
  blocked?: readonly MinuteRange[]
  /** Minuto actual si la fecha es hoy: lo libre que ya pasó deja de serlo. */
  nowMinutes?: number
}

/**
 * Reparte la ventana del día en tramos consecutivos: cerrado (sin atención o
 * bloqueado), ocupado, pasado y libre. Es la barra del día en la vista Semana
 * del teléfono y el total de «horas libres».
 */
export function daySegments(input: DaySegmentsInput): DaySegment[] {
  const whole: MinuteRange[] = [
    { startMinutes: input.window.startMinutes, endMinutes: input.window.endMinutes },
  ]
  const open = subtractRanges(clipRanges(input.open, input.window), input.blocked ?? [])
  const closed = subtractRanges(whole, open)
  const busy = clipRanges(mergeRanges(input.busy), input.window)
  const openBusy = open.flatMap((range) => clipRanges(busy, range))
  const idle = subtractRanges(open, openBusy)
  const cutoff = input.nowMinutes
  const past =
    cutoff === undefined
      ? []
      : clipRanges(idle, { startMinutes: input.window.startMinutes, endMinutes: cutoff })
  const free = subtractRanges(idle, past)
  const tagged: DaySegment[] = [
    ...closed.map((range) => ({ ...range, kind: "closed" as const })),
    ...openBusy.map((range) => ({ ...range, kind: "busy" as const })),
    ...past.map((range) => ({ ...range, kind: "past" as const })),
    ...free.map((range) => ({ ...range, kind: "free" as const })),
  ].sort((a, b) => a.startMinutes - b.startMinutes)
  // Tramos vecinos del mismo tipo se leen como uno solo.
  const joined: DaySegment[] = []
  for (const segment of tagged) {
    const last = joined[joined.length - 1]
    if (last && last.kind === segment.kind && last.endMinutes === segment.startMinutes) {
      last.endMinutes = segment.endMinutes
    } else {
      joined.push({ ...segment })
    }
  }
  return joined
}

/** Minutos libres de un reparto. */
export function freeMinutesOf(segments: readonly DaySegment[]): number {
  return segments
    .filter((segment) => segment.kind === "free")
    .reduce((total, segment) => total + (segment.endMinutes - segment.startMinutes), 0)
}

/** «45 min», «3 h», «1 h 30»: la duración como se dice en recepción. */
export function formatSpan(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes))
  if (rounded < 60) return `${rounded} min`
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")}`
}
