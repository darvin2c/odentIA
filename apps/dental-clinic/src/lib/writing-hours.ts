/**
 * «Horario para escribir» (decisión 18 v3): cuándo odentIA escribe por su
 * cuenta. Lo entrega `/api/agent/writing-hours` por día de la semana
 * (0 = domingo) con sus tramos en minutos; aquí solo se dice en palabras.
 */
export type WritingWeek = Array<Array<[number, number]>>

export const WRITING_HOURS_KEY = ["agent-writing-hours"] as const

/** La semana se lee de lunes a domingo. */
const ORDER = [1, 2, 3, 4, 5, 6, 0]
const DAY = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]

function hour(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}:${String(m).padStart(2, "0")}`
}

/** «8:00 a 20:00» o «8:00 a 13:00 y 15:00 a 19:00». */
export function rangesWords(ranges: Array<[number, number]>): string {
  return ranges.map(([from, to]) => `${hour(from)} a ${hour(to)}`).join(" y ")
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * Los días seguidos con el mismo horario, juntos: «Lunes a viernes», «Sábado»,
 * «Domingo». Cada grupo dice si ese día se escribe.
 */
export function writingWeekRows(week: WritingWeek): Array<{ days: string; hours: string | null }> {
  const rows: Array<{ first: number; last: number; key: string; ranges: Array<[number, number]> }> = []
  for (const weekday of ORDER) {
    const ranges = week[weekday] ?? []
    const key = JSON.stringify(ranges)
    const previous = rows.at(-1)
    if (previous && previous.key === key) previous.last = weekday
    else rows.push({ first: weekday, last: weekday, key, ranges })
  }
  return rows.map((row) => ({
    days: row.first === row.last ? capital(DAY[row.first] ?? "") : `${capital(DAY[row.first] ?? "")} a ${DAY[row.last]}`,
    hours: row.ranges.length ? rangesWords(row.ranges) : null,
  }))
}
