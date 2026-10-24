/**
 * El descanso médico (issue 229, decisión 8): una constancia de reposo con sus
 * días y sus fechas, firmada con el perfil profesional. Es un documento propio,
 * sin el formato oficial de ningún país (el certificado de incapacidad de la
 * seguridad social lo emite su institución). El diagnóstico solo va si la
 * persona lo autoriza: es un dato de su historia que el empleador no necesita.
 */

/** Hasta un año de reposo en una sola constancia. */
export const MEDICAL_LEAVE_MAX_DAYS = 365

/** El último día del reposo (AAAA-MM-DD), contando el primero. */
export function medicalLeaveEnd(startDate: string, days: number): string {
  const date = new Date(`${startDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days - 1)
  return date.toISOString().slice(0, 10)
}

/** «24/10/2026». */
function day(iso: string): string {
  const [year, month, dayOfMonth] = iso.split("-")
  return `${dayOfMonth}/${month}/${year}`
}

/** «3 días de descanso, del 24/10/2026 al 26/10/2026». */
export function medicalLeaveWords(startDate: string, days: number): string {
  const end = medicalLeaveEnd(startDate, days)
  return days === 1
    ? `1 día de descanso, el ${day(startDate)}`
    : `${days} días de descanso, del ${day(startDate)} al ${day(end)}`
}
