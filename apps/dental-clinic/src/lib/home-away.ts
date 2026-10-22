/** Lo que responde `POST /api/workspace/visit` la primera vez del día; null el resto. */
export interface HomeAway {
  since: string
  appointments: number | null
  recovered: number | null
  cases: number | null
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * «Mientras no estabas, tus agentes agendaron 6 citas, trajeron de vuelta a 2
 * pacientes y te dejaron 1 caso.» Solo nombra lo que pasó.
 */
export function awayText(away: HomeAway): string {
  const parts: string[] = []
  if (away.appointments) parts.push(`agendaron ${plural(away.appointments, "cita", "citas")}`)
  if (away.recovered)
    parts.push(`trajeron de vuelta a ${plural(away.recovered, "paciente", "pacientes")}`)
  if (away.cases) parts.push(`te dejaron ${plural(away.cases, "caso", "casos")}`)
  const list =
    parts.length > 1 ? `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)}` : (parts[0] ?? "")
  return `Mientras no estabas, tus agentes ${list}.`
}

/** «Buenos días» de 5 a 12, «Buenas tardes» de 12 a 19 y «Buenas noches» el resto. */
export function greetingAt(now: Date = new Date()): string {
  const h = now.getHours()
  if (h >= 5 && h < 12) return "Buenos días"
  if (h >= 12 && h < 19) return "Buenas tardes"
  return "Buenas noches"
}
