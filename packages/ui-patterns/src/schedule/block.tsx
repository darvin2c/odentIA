import { entryStateLabel } from "./status.js"
import { timeRangeLabel } from "./time.js"
import type { ScheduleEntry } from "./types.js"

/** Nombre accesible de una cita: quién, cuándo, qué, su estado en palabras y, si procede, cómo moverla. */
export function entryAccessibleName(
  entry: ScheduleEntry,
  timeZone: string,
  draggable: boolean,
): string {
  const base = `Cita de ${entry.title}, ${timeRangeLabel(entry.start, entry.end, timeZone)}${entry.subtitle ? `, ${entry.subtitle}` : ""}. ${entryStateLabel(entry)}${entry.warning ? `. Atención: ${entry.warning}` : ""}`
  return draggable ? `${base}. Alt+Intro para moverla` : base
}
