import { hourLabel } from "@odentia/ui-patterns"
import { upperFirst } from "./product-words"

/**
 * El horario de atención de una sede: la suma de los horarios de su equipo
 * (`getBranchHours` de los servicios, ADR 0117). Es el mismo que dice el
 * agente; aquí solo se dice en pantalla.
 */
export interface BranchHours {
  id: string
  name: string
  /** Por día de la semana (0 = domingo), los tramos en que atiende alguien, en minutos locales. */
  week: Array<{ weekday: number; ranges: Array<[number, number]> }>
  /** Cierres de toda la sede en los próximos días. */
  closures: Array<{ startsAt: string; endsAt: string; reason: string | null }>
}

/** La semana empieza en lunes, como en la Agenda. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]

/**
 * «Lunes a viernes: 09:00 – 13:00 y 15:00 – 19:00»: los días seguidos con los
 * mismos tramos van en una línea; un día sin nadie del equipo, «Cerrado».
 */
export function weekLines(
  week: BranchHours["week"],
): Array<{ days: string; text: string; closed: boolean }> {
  const byDay = new Map(week.map((day) => [day.weekday, day.ranges]))
  const textOf = (weekday: number) => {
    const ranges = byDay.get(weekday) ?? []
    return ranges.length
      ? ranges.map(([start, end]) => `${hourLabel(start)} – ${hourLabel(end)}`).join(" y ")
      : "Cerrado"
  }
  const lines: Array<{ first: number; last: number; text: string }> = []
  for (const weekday of WEEK_ORDER) {
    const text = textOf(weekday)
    const previous = lines[lines.length - 1]
    if (previous && previous.text === text) previous.last = weekday
    else lines.push({ first: weekday, last: weekday, text })
  }
  return lines.map((line) => ({
    days:
      line.first === line.last
        ? upperFirst(DAY_NAMES[line.first] ?? "")
        : `${upperFirst(DAY_NAMES[line.first] ?? "")} a ${DAY_NAMES[line.last]}`,
    text: line.text,
    closed: line.text === "Cerrado",
  }))
}

/** En una sola línea, sin los días cerrados: «lunes a viernes 09:00 – 13:00; sábado 09:00 – 13:00». */
export function weekSummary(week: BranchHours["week"]): string {
  return weekLines(week)
    .filter((line) => !line.closed)
    .map((line) => `${line.days.charAt(0).toLowerCase()}${line.days.slice(1)} ${line.text}`)
    .join("; ")
}
