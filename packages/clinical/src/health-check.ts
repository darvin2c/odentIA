/**
 * «¿Cambió algo en tu salud o en tus medicinas desde tu última visita?» (mesa de formularios del
 * 13 nov, entrega 10, decisión 5): antes de cada cita, si su última declaración de salud tiene más
 * de un mes. Las guías (ADA, AAPD) piden revisarlo en cada visita; el mes es un supuesto para no
 * preguntarlo en sesiones semanales, por confirmar con una clínica real. Con «No» queda anotado
 * que dijo que nada cambió, con su fecha; con «Sí» vuelve a responder su salud y sus medicinas.
 */

/** Cuántos meses de calendario pasan antes de volver a preguntarle. */
export const HEALTH_CHECK_AFTER_MONTHS = 1

/**
 * El mismo instante un mes de calendario después. Un día que el mes siguiente no tiene (31 de
 * enero) queda en su último día (28 o 29 de febrero): «un mes» nunca se alarga a dos.
 */
export function addCalendarMonths(at: Date, months: number): Date {
  const out = new Date(at.getTime())
  const day = out.getUTCDate()
  out.setUTCDate(1)
  out.setUTCMonth(out.getUTCMonth() + months)
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate()
  out.setUTCDate(Math.min(day, last))
  return out
}

/**
 * Si toca preguntarle: su última declaración (también «nada cambió») tiene más de un mes. Sin
 * ninguna declaración no se le pregunta esto: lo que falta de su salud se le pregunta aparte, dato
 * por dato (entrega 6).
 */
export function healthCheckDue(lastSaidAt: Date | null, now: Date): boolean {
  if (!lastSaidAt) return false
  return now.getTime() > addCalendarMonths(lastSaidAt, HEALTH_CHECK_AFTER_MONTHS).getTime()
}

/** Por qué llega una declaración de salud: lo primero que dijo, que algo cambió, una corrección o que nada cambió. */
export const HEALTH_DECLARATION_REASONS = ["cambio", "correccion", "sin_cambios"] as const
export type HealthDeclarationReason = (typeof HEALTH_DECLARATION_REASONS)[number]
